/**
 * LobsterAI（有道龙虾）认证服务。
 *
 * 1. **续期的终态判定更精确**。Go 版只判「响应里有没有 accessToken」，
 *    会把网络抖动也当成终态而停止续期；本实现按 HTTP 状态码 +
 *    `classifyLobsteraiError` 的 `session-dead` 判定，其余错误交给
 *    `RefreshScheduler` 走可重试路径。
 * 2. **凭据里必须回写 `latest_keyfrom`**（LobsterAI 的续期请求体不是只带
 *    refreshToken，还要带身份字段；见 `lobsteraiRefreshBody`）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  LobsteraiClientVersionResolver,
  applyLobsteraiRefresh,
  isLobsteraiExpired,
  isLobsteraiRefreshable,
  lobsteraiAnonymousHeaders,
  lobsteraiAuthHeaders,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiDisplayNickname,
  lobsteraiJsonHeaders,
  lobsteraiKeyfromBody,
  lobsteraiKeyfromQuery,
  lobsteraiModelsHeaders,
  lobsteraiRefreshBody,
  parseLobsteraiEnvelope,
  parseLobsteraiInstallationUuid,
  parseLobsteraiTokenPayload,
  sanitizeLobsteraiKeyfrom,
  withLobsteraiIdentity,
  type LobsteraiCredential,
  type LobsteraiIdentityFields,
} from './lobsterai.js'
import { LOBSTERAI_LOGOUT_PATH, LOBSTERAI_REFRESH_PATH } from './lobsterai.js'
import { lobsteraiFetch, lobsteraiTransport } from './lobsterai-fetch.js'
import { LOBSTERAI_PROFILE_SUMMARY_PATH } from './lobsterai-credits.js'
import { createLobsteraiIdentityStore, type LobsteraiIdentity, type LobsteraiIdentityStore } from './lobsterai-identity.js'
import { buildLobsteraiModelsUrl, parseLobsteraiModels, type LobsteraiRemoteModel } from './lobsterai-adapter.js'
import { LOBSTERAI, type LobsteraiProduct } from './lobsterai-product.js'
import { classifyLobsteraiError, isLobsteraiTerminalError } from './lobsterai-errors.js'
import {
  exchangeLobsteraiAuthCode,
  runLobsteraiLoginFlow,
  startLobsteraiLoginFlow,
  type LobsteraiLoginFlowOptions,
  type LobsteraiLoginFlowResult,
} from './lobsterai-oauth.js'
import { RefreshScheduler } from './refresh.js'
import { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'

/**
 * LobsterAI 凭据 → 账号池有效期所需的提取器（`refreshAll` 与按需续期共用一份）。
 */
const LOBSTERAI_EXPIRY_ACCESSORS: ExpiryAccessors<LobsteraiCredential> = {
  expiresAtOf: lobsteraiCredentialExpiresAtMs,
  refreshableOf: isLobsteraiRefreshable,
  identityOf: (credential) => credential.access_token ?? '',
}

/**
 * 「登录后请求组」的单次超时（毫秒）。
 *
 * 比控制面默认的 30 秒短：这组请求是**补齐行为**，`login()` 会等它们，
 * 任一端点卡住都不该让用户以为登录没反应。桌面端同样把它们当作可失败的
 * 附加请求（`main.js:186817-186831` 与 `163255-163305` 全部 catch）。
 */
const LOBSTERAI_POST_LOGIN_TIMEOUT_MS = 10_000

/** 启动 warmup 的单次超时（毫秒）；对齐桌面端 `WARMUP_TIMEOUT = 5e3`。 */
const LOBSTERAI_WARMUP_TIMEOUT_MS = 5_000

/**
 * LobsterAI 的默认凭据 ref。
 *
 * 等价于 `LOBSTERAI.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请用 `LobsterAI.defaultCredentialRef`。
 */
export const LOBSTERAI_CREDENTIAL_REF = 'LOBSTERAI_ACCESS_TOKEN'

/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次成功登录的结果。 */
export interface LobsteraiLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 打开的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** 用于配置界面的只读登录状态。 */
export interface LobsteraiLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  /** 存储的凭据是否可通过刷新令牌静默续期。 */
  refreshable: boolean
  /** 最近一次刷新失败的原因（如有）。 */
  refreshError?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * LobsterAI 的认证服务实例。
     */
    lobsteraiAuth: LobsteraiAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value: string): LobsteraiCredential | undefined {
  try {
    const parsed = JSON.parse(value) as LobsteraiCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** `LobsteraiAuth` 的构造选项。 */
export interface LobsteraiAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link LOBSTERAI}。 */
  product?: LobsteraiProduct
  /** 服务名覆盖（默认由产品 id 派生为 `lobsteraiAuth`）。 */
  serviceName?: string
  /** 客户端版本号解析器；默认为内部新建的实例。 */
  versionResolver?: LobsteraiClientVersionResolver
  /** 安装身份后端（测试用）；默认为 `$DSH_HOME/channel-pack/lobsterai-installation.json`。 */
  identityStore?: LobsteraiIdentityStore
}

/**
 * LobsterAI 认证服务：本地回调登录 + refresh_token 静默续期。
 */
export class LobsteraiAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: LobsteraiProduct

  /**
   * 本实例默认读写的凭据 ref 名称（`LOBSTERAI_ACCESS_TOKEN`）。
   */
  readonly credentialRefName: string

  private readonly scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        // 失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。
        this.markRefreshTokenInvalid()
        return
      }
      this.lastRefreshError = error instanceof Error ? error.message : String(error)
    },
  )
  /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
  private refreshTokenInvalid = false
  private lastRefreshError: string | undefined
  /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
  private active = true
  /** 客户端版本号解析器（带缓存与兜底）。 */
  private readonly versionResolver: LobsteraiClientVersionResolver
  /** 安装身份后端（uuid + keyfrom 的权威来源）。 */
  private readonly identityStore: LobsteraiIdentityStore
  /** 进程内缓存的安装身份（一次运行内恒定，避免每次请求都读盘）。 */
  private identityState: LobsteraiIdentity | undefined
  /** 已经就「版本号回退」告警过一次（避免每次调用刷屏）。 */
  private fallbackVersionWarned = false
  /** 启动 warmup 只跑一次（桌面端同样只在应用启动时预热）。 */
  private warmupStarted = false

  constructor(ctx: Context, private readonly options: LobsteraiAuthOptions = {}) {
    const product = options.product ?? LOBSTERAI
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
    this.versionResolver = options.versionResolver ?? new LobsteraiClientVersionResolver({
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
    })
    this.identityStore = options.identityStore ?? createLobsteraiIdentityStore(ctx)
    // 记一条传输层事实：事后能把「参数问题」与「网络栈指纹问题」分开排查。
    // 失败（纯 Node / 权限受限）由 lobsteraiTransport 自己回退，这里只报事实。
    void lobsteraiTransport()
      .then((transport) => this.ctx.logger?.info?.(`[lobsterai] 控制面请求传输层: ${transport.kind}`))
      .catch(() => {})
  }

  /**
   * 控制面请求的 fetch。
   *
   * 默认是 {@link lobsteraiFetch}：Electron 宿主里走 Chromium `net.fetch`
   * （与桌面端同一套 TLS/ALPN/HTTP2/头部指纹），纯 Node 里回退全局 fetch。
   * 测试可用 `options.fetcher` 注入。
   */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? lobsteraiFetch
  }

  /**
   * 解析本机的**安装身份**（安装 UUID + keyfrom 渠道归属）。
   *
   * 这是登录 / 续期 / 模型列表 / 余额查询的**唯一**身份来源：桌面端每次请求
   * 都现读落盘的 `installation_uuid` 与 `keyfrom.attribution.v1`，而不是从
   * token 里反推。缓存到进程内后不再读盘（同一运行内不会变）。
   */
  async resolveIdentity(): Promise<LobsteraiIdentity> {
    if (this.identityState === undefined) this.identityState = this.identityStore.resolve()
    return this.identityState
  }

  /**
   * 解析客户端版本号（带缓存与兜底）。
   *
   * 三个消费点都需要它：登录 exchange 的 `version` 字段、续期请求体的
   * `version`、以及签到接口的必填 query 参数。集中在此避免三处各自拉取。
   *
   * 同时把安装身份拼进更新接口的 query（对齐桌面端 `appendKeyfromQuery`：
   * 连配置类 GET 也带 `uuid`/`version`/`firstKeyfrom`/`latestKeyfrom`）。
   * 回退到兜底版本时**必须留日志** —— 「发了个过期的版本号」正是需要能自查的
   * 特征（见 `LOBSTERAI_FALLBACK_CLIENT_VERSION`）。
   */
  async resolveClientVersion(): Promise<string> {
    const resolved = await this.versionResolver.resolve(this.product, await this.resolveIdentity())
    if (resolved.source === 'fallback' && !this.fallbackVersionWarned) {
      this.fallbackVersionWarned = true
      this.ctx.logger?.warn?.(
        `[lobsterai] 无法从远端取到客户端版本号，回退 ${resolved.version}`
        + '（与官方安装包版本不一致会增加「非官方客户端」特征）',
      )
    }
    return resolved.version
  }

  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
  private markRefreshTokenInvalid(): void {
    this.refreshTokenInvalid = true
    this.lastRefreshError = 'refresh_token 已失效，请重新登录'
  }

  /**
   * 运行完整登录流程并持久化凭据。
   *
   * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池
   * （Channel Pack 的「+ 新建账号」路径）。
   */
  async login(
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & Partial<LobsteraiLoginFlowOptions> = {},
  ): Promise<LobsteraiLoginResult> {
    this.active = true
    // 版本号是 exchange 的必需字段，登录前先解析（带缓存，通常无网络开销）。
    const clientVersion = await this.resolveClientVersion()
    const flow = await runLobsteraiLoginFlow({
      product: this.product,
      clientVersion,
      fetcher: this.fetchImpl,
      ...flowOptions,
      // 安装身份**必须**来自落盘文档：这是「重登不换设备」的唯一保证，
      // 故放在 flowOptions 之后，调用方无法用一次性身份覆盖它。
      identity: await this.resolveIdentity(),
    })
    return this.persistLogin(flow, flowOptions)
  }

  /**
   * **两步式登录**：起回调服务器并立即返回登录 URL，由调用方先打开窗口。
   *
   * 调用方拿到 `loginUrl` 后应当**立即** `window.open`，再 await `result`。
   */
  async startLogin(
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & Partial<LobsteraiLoginFlowOptions> = {},
  ): Promise<{ loginUrl: string; result: Promise<LobsteraiLoginResult>; close: () => Promise<void> }> {
    this.active = true
    const clientVersion = await this.resolveClientVersion()
    const started = await startLobsteraiLoginFlow({
      product: this.product,
      clientVersion,
      fetcher: this.fetchImpl,
      ...flowOptions,
      // 同 `login`：安装身份来自落盘文档，不允许调用方覆盖。
      identity: await this.resolveIdentity(),
    })
    const result = started.result.then((flow) => this.persistLogin(flow, flowOptions))
    // 与 startLobsteraiLoginFlow 同理：结果可能早于调用方 await 而落定，
    // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
    result.catch(() => {})
    return { loginUrl: started.loginUrl, result, close: started.close }
  }

  /**
   * 持久化一次登录结果：写凭据、重置失效状态、武装续期、按需登记账号池。
   *
   * 抽成独立方法供 {@link login} 与 {@link startLogin} 共用 ——
   * 两条路径的差别只在「何时返回 loginUrl」，落库逻辑必须完全一致。
   */
  private async persistLogin(
    flow: LobsteraiLoginFlowResult,
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<LobsteraiLoginResult> {
    const ref = flowOptions.refName ? credentialRef(flowOptions.refName) : credentialRef(this.credentialRefName)
    await this.ctx.credentials.set(ref, flow.access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    // 登录路径自己会补齐「登录后请求」（见 runPostLoginRequests），
    // 故不必再跑启动 warmup —— 否则模型列表会被连拉两次。
    this.warmupStarted = true
    this.scheduleRefresh()
    const credential = parseCredential(flow.access)
    // 多账号：accountId 提供时自动注册到 pool
    if (flowOptions.accountId !== undefined && flowOptions.pool !== undefined) {
      await flowOptions.pool.addAccount({
        id: flowOptions.accountId,
        provider: this.product.id,
        // ⚠️ 用 `lobsteraiDisplayNickname`：服务端把**手机号本身**当昵称下发，
        // 且只脱敏到「露末 4 位」，需归一化为末 2 位（用户要求 2026-09-27）。
        nickname: lobsteraiDisplayNickname(credential, flowOptions.accountId),
        enabled: true,
        credentialRef: flowOptions.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        expiresAt: credential ? lobsteraiCredentialExpiresAtMs(credential) : undefined,
        refreshable: credential !== undefined && isLobsteraiRefreshable(credential),
      })
    }
    // 与桌面端一致的**登录后请求组**（少这一组就是「只换 token、不装客户端」）。
    if (credential !== undefined) await this.runPostLoginRequests(credential)
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: flow.refreshable,
    }
  }

  /**
   * 登录成功后补齐桌面端会立刻发出的请求（2026-11-13 第二轮排查）。
   *
   * ## 为什么要补（实证）
   *
   * 桌面端在 exchange 成功后会**连续**发这四条（`main.js` + 渲染进程
   * `useDesktopCompanionState-dtwKvfpU.js:8981-8994`）：
   *
   * 1. `POST /api/purchase-offers/low-credit/activate`（`main.js:186903` 内 await，
   *    无 body，Bearer + Content-Type）；
   * 2. `GET /api/models/available?…keyfrom…`（`loadServerModels`，带能力头）；
   * 3. `GET /api/user/quota`（`refreshQuota` → `getQuota`，**不带 keyfrom**）；
   * 4. `GET /api/user/profile-summary?…keyfrom…`（`fetchProfileSummary`）。
   *
   * 只做 exchange 的客户端在服务端看来是「拿到 token 就消失」——真实客户端
   * 永远会带这组请求。全部失败都只记 warn：补齐请求不该让登录失败。
   */
  private async runPostLoginRequests(credential: LobsteraiCredential): Promise<void> {
    try {
      const clientVersion = await this.resolveClientVersion()
      // ① 桌面端在 exchange 返回前就 await 这一步（`main.js:186903`）。
      await this.activateLowCreditPurchaseOffer(credential)
      // ② 渲染进程随后立刻做这三件（`:8993-8994`）。
      await this.warmModels(credential, clientVersion)
      // `getQuota` 内部还会再激活一次优惠（`main.js:187090`），照做。
      await this.refreshQuota(credential)
      await this.fetchProfileSummary(credential, clientVersion)
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[lobsterai] 登录后补齐请求失败（不影响凭据）: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * `POST /api/purchase-offers/low-credit/activate`。
   *
   * 桌面端 `main.js:186817-186831`：Bearer + `Content-Type`，**无 body**，
   * 只看 `ok` 与信封 `code`，失败仅 warn —— 这里同样不把失败当登录失败。
   */
  private async activateLowCreditPurchaseOffer(credential: LobsteraiCredential): Promise<void> {
    const response = await this.fetchImpl(`${this.product.apiBase}/api/purchase-offers/low-credit/activate`, {
      method: 'POST',
      headers: lobsteraiJsonHeaders(credential, this.product),
      signal: AbortSignal.timeout(LOBSTERAI_POST_LOGIN_TIMEOUT_MS),
    })
    // 消费掉响应体（避免连接悬挂）；内容本身对凭据没有影响。
    await response.json().catch(() => undefined)
  }

  /**
   * `GET /api/models/available` 预热（`loadServerModels` / 启动 warmup 同款）。
   *
   * 身份 query 与能力头都必须与桌面端一致：`appendKeyfromQuery` + 四个能力
   * token（`main.js:184942-184946`、`163290-163293`）。
   */
  private async warmModels(
    credential: LobsteraiCredential,
    clientVersion: string,
    timeoutMs: number = LOBSTERAI_POST_LOGIN_TIMEOUT_MS,
  ): Promise<void> {
    const url = buildLobsteraiModelsUrl(
      this.product,
      withLobsteraiIdentity(credential, await this.resolveIdentity()),
      clientVersion,
    )
    const response = await this.fetchImpl(url, {
      headers: lobsteraiModelsHeaders(credential, this.product, clientVersion),
      signal: AbortSignal.timeout(timeoutMs),
    })
    await response.json().catch(() => undefined)
  }

  /**
   * `GET /api/user/quota` + 再激活一次低积分优惠（桌面端 `getQuota` 的两步）。
   *
   * ⚠️ 桌面端这个端点**不带** keyfrom query（`main.js:163269`、`187011`）：
   * 它是账号级快照，归因字段只在 `profile-summary` 一类端点出现。
   */
  private async refreshQuota(credential: LobsteraiCredential): Promise<void> {
    const response = await this.fetchImpl(`${this.product.apiBase}/api/user/quota`, {
      headers: lobsteraiAuthHeaders(credential, this.product),
      signal: AbortSignal.timeout(LOBSTERAI_POST_LOGIN_TIMEOUT_MS),
    })
    await response.json().catch(() => undefined)
    await this.activateLowCreditPurchaseOffer(credential)
  }

  /** `GET /api/user/profile-summary?…keyfrom…`（`main.js:187110-187112`）。 */
  private async fetchProfileSummary(
    credential: LobsteraiCredential,
    clientVersion: string,
  ): Promise<void> {
    const query = lobsteraiKeyfromQuery(
      withLobsteraiIdentity(credential, await this.resolveIdentity()),
      clientVersion,
    )
    const base = `${this.product.apiBase}${LOBSTERAI_PROFILE_SUMMARY_PATH}`
    const response = await this.fetchImpl(query.length === 0 ? base : `${base}?${query}`, {
      headers: lobsteraiAuthHeaders(credential, this.product),
      signal: AbortSignal.timeout(LOBSTERAI_POST_LOGIN_TIMEOUT_MS),
    })
    await response.json().catch(() => undefined)
  }

  /**
   * 启动 warmup：已有凭据时预热 `quota` 与 `models`（桌面端
   * `runStartupCacheWarmup`，`main.js:163255-163305`）。
   *
   * 只跑一次；登录路径会自己跑完整的一组登录后请求，故 `persistLogin` 会先
   * 把标记置上，避免模型列表被连拉两次。
   */
  private scheduleWarmupOnce(): void {
    if (this.warmupStarted) return
    this.warmupStarted = true
    void (async () => {
      try {
        const credential = await this.resolveStoredCredential()
        if (credential === undefined || credential.access_token.length === 0) return
        // 桌面端 warmup 只做 quota + models（不含 activate-offer）。
        await this.refreshQuotaWithoutOffer(credential)
        await this.warmModels(credential, await this.resolveClientVersion(), LOBSTERAI_WARMUP_TIMEOUT_MS)
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[lobsterai] 启动预热失败（不影响使用）: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })()
  }

  /** `GET /api/user/quota`（不带 activate-offer，供启动 warmup 用）。 */
  private async refreshQuotaWithoutOffer(credential: LobsteraiCredential): Promise<void> {
    const response = await this.fetchImpl(`${this.product.apiBase}/api/user/quota`, {
      headers: lobsteraiAuthHeaders(credential, this.product),
      signal: AbortSignal.timeout(LOBSTERAI_WARMUP_TIMEOUT_MS),
    })
    await response.json().catch(() => undefined)
  }

  /**
   * 用**已有的授权码**完成登录（供需要自行起回调的场景使用）。
   *
   * 与 {@link login} 的区别：不走本地服务器，直接拿 code 换凭据。
   * 保留这个入口是为了让 e2e 探针能在不打开浏览器的情况下验证 exchange。
   *
   * `session` 可省略（省略即用安装身份）；即便显式传入，`uuid` / keyfrom
   * 也会先过 sanitizer 再合并进安装身份 —— 传进来的毫秒 keyfrom 不会上线。
   */
  async loginWithCode(
    code: string,
    session?: Partial<LobsteraiIdentityFields>,
    options: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<LobsteraiLoginResult> {
    this.active = true
    const ref = options.refName ? credentialRef(options.refName) : credentialRef(this.credentialRefName)
    const clientVersion = await this.resolveClientVersion()
    const identity = await this.resolveIdentity()
    const fields: LobsteraiIdentityFields = {
      uuid: parseLobsteraiInstallationUuid(session?.uuid) ?? identity.uuid,
      firstKeyfrom: session?.firstKeyfrom === undefined
        ? identity.firstKeyfrom
        : sanitizeLobsteraiKeyfrom(session.firstKeyfrom),
      latestKeyfrom: session?.latestKeyfrom === undefined
        ? identity.latestKeyfrom
        : sanitizeLobsteraiKeyfrom(session.latestKeyfrom),
    }
    const credential = await exchangeLobsteraiAuthCode(
      code, fields, clientVersion, this.product, this.fetchImpl,
    )
    const access = JSON.stringify(credential)
    await this.ctx.credentials.set(ref, access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    this.warmupStarted = true
    this.scheduleRefresh()
    if (options.accountId !== undefined && options.pool !== undefined) {
      await options.pool.addAccount({
        id: options.accountId,
        provider: this.product.id,
        // 同 `persistLogin`：手机号归一化为只露末 2 位。
        nickname: lobsteraiDisplayNickname(credential, options.accountId),
        enabled: true,
        credentialRef: options.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        expiresAt: lobsteraiCredentialExpiresAtMs(credential),
        refreshable: isLobsteraiRefreshable(credential),
      })
    }
    // 与 `persistLogin` 同款：登录成功必须补齐桌面端的「登录后请求组」。
    await this.runPostLoginRequests(credential)
    return {
      access,
      expires: lobsteraiCredentialExpiresAtMs(credential) ?? 0,
      ref,
      loginUrl: '',
      refreshable: isLobsteraiRefreshable(credential),
    }
  }

  /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
  async status(): Promise<LobsteraiLoginStatus> {
    const ref = credentialRef(this.credentialRefName)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let expiresAt: number | undefined
    let refreshable = false
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      const credential = parseCredential(resolved.value)
      if (credential) {
        expiresAt = lobsteraiCredentialExpiresAtMs(credential)
        refreshable = isLobsteraiRefreshable(credential) && !this.refreshTokenInvalid
      }
    }
    return {
      configured: true,
      source: info.source,
      expiresAt,
      refreshable,
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /**
   * 静默续期：`refresh_token` + keyfrom 身份载荷换取新令牌。
   *
   * 终态判定（**比 Go 版精确**，见模块头注释）：
   * - HTTP 401/403、或响应体命中 `session-dead` 标记 → 抛
   *   {@link RefreshTokenExpiredError}，让调度器停止续期；
   * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走调度器的可重试路径。
   */
  async refresh(): Promise<void> {
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('未配置凭据，请先登录')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isLobsteraiRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    try {
      const refreshed = await this.refreshCredential(credential)
      // 登出竞态保护：在途刷新期间已 logout()/stop() 时，跳过凭据回写与调度武装，
      // 避免已登出的凭据被在途刷新复活。
      if (!this.active) return
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
      this.refreshTokenInvalid = false
      this.lastRefreshError = undefined
      this.scheduleRefresh()
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError) this.markRefreshTokenInvalid()
      throw error
    }
  }

  /**
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
   * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
   *
   * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT 的真实缺陷）：
   * UI 账号卡片的「有效期」读的正是池里的值，而不是凭据里 access_token 的真实
   * `exp`。早期这里只 `credentials.set`，于是调用 `account.refresh` 后凭据确实续好了、
   * 界面却**一直显示「已过期」**，且没有任何自救手段（「重测」按钮的 refresh
   * 是刻意的 no-op）。
   *
   * @param pool 账号池；提供时会把新 `expiresAt` / `refreshable` 写回。
   * @param accountId 账号 id。**调用方已知时请显式传入** ——
   *   否则只能按凭据内容反查（代价高，且反查会跳过已停用账号）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isLobsteraiRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    const refreshed = await this.refreshCredential(credential)
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential: refreshed,
      accessors: LOBSTERAI_EXPIRY_ACCESSORS,
      accountId,
      tag: '[lobsterai]',
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 一次性修复**老账号**的展示名：把手机号掩码归一化为「只露末 2 位」。
   *
   * ## 为什么需要它（用户要求 2026-09-27）
   *
   * > lobsterai 的用户名字显示的手机号尾号漏出 4 位，现在也改为只漏出 2 位
   *
   * ⚠️ 那个 `130****1100` 是**服务端下发的 `user.nickname` 原值**，不是本插件
   * 截取的（实测四个账号登录响应即为此形态）。故只改代码只影响新登录账号，
   * 已登录的老账号昵称仍是露 4 位 —— 启动时主动补一次。
   *
   * 与 `RaccoonAuth.repairAccountNicknames` / `TraeAuth.repairAccountNicknames`
   * 同一模式（都是「服务端下发的名字不适合直接展示」）。
   *
   * ## 契约
   *
   * - **幂等**：`lobsteraiDisplayNickname` 对已归一化的值算出同一结果，
   *   故不触发写入（只在**确实变化**时落盘）。
   * - **失败不阻塞**：逐账号 catch，异常只记 warn。
   * - **纯本地**：不发任何网络请求（掩码只依赖凭据里的昵称）。
   * - **不误伤真实昵称**：非手机号形态（如 `用户26815487395`）原样保留。
   *
   * @returns 被修复的账号 id 列表（供日志）
   */
  async repairAccountNicknames(pool: AccountPool): Promise<string[]> {
    const repaired: string[] = []
    let entries: Awaited<ReturnType<AccountPool['listAccounts']>>
    try {
      entries = await pool.listAccounts(this.product.id)
    } catch {
      return repaired
    }

    for (const entry of entries) {
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        if (!resolved) continue
        const credential = parseCredential(resolved.value)
        if (credential === undefined) continue

        const target = lobsteraiDisplayNickname(credential, entry.id)
        // ⚠️ 只在**确实变化**时写账号池：`updateAccount` 是整体 replace，
        // 每次启动都写会平白落盘一次。
        if (target !== entry.nickname) {
          await pool.updateAccount(entry.id, { nickname: target })
          repaired.push(entry.id)
        }
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[lobsterai] 修复账号 ${entry.id} 的显示名失败（不影响使用）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return repaired
  }

  /**
   * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
   *
   * 抽出来供 `refresh()` 与 `refreshAll()` 共用，避免两处各写一遍
   * 「发请求 → 判终态 → 合并字段」的逻辑而逐渐分叉。
   */
  private async refreshCredential(credential: LobsteraiCredential): Promise<LobsteraiCredential> {
    const clientVersion = await this.resolveClientVersion()
    // 身份字段取**安装身份**而不是凭据里的旧快照：升级前登录的老凭据会从
    // 下一次续期起自愈（不再发毫秒 keyfrom / 每次登录新造的 uuid）。
    // 这也是桌面端的行为 —— 它每次都现读 installation_uuid 与 keyfrom。
    const hydrated = withLobsteraiIdentity(credential, await this.resolveIdentity())
    const body = lobsteraiRefreshBody(hydrated, clientVersion)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.product.apiBase}${LOBSTERAI_REFRESH_PATH}`, {
        method: 'POST',
        headers: lobsteraiAnonymousHeaders(this.product),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      // 传输层失败：**不能**判为终态 —— 网络抖动不该让用户重新登录。
      // 用普通 Error 让 RefreshScheduler 安排重试。
      throw new Error(`LobsterAI 续期网络失败：${error instanceof Error ? error.message : String(error)}`)
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      throw new Error(`LobsterAI 续期响应不是 JSON（HTTP ${response.status}）`)
    }

    const rawText = JSON.stringify(parsed)
    const envelope = parseLobsteraiEnvelope(parsed)
    if (!envelope.ok) {
      // 分类后决定「终态」还是「可重试」：40100/40101 等会话死亡标记
      // 才是终态；业务码里的其他失败（如瞬时 5xx 被包成 code!=0）应可重试。
      const kind = classifyLobsteraiError(response.status, rawText)
      if (response.status === 401 || response.status === 403 || isLobsteraiTerminalError(kind)) {
        throw new RefreshTokenExpiredError(envelope.message)
      }
      throw new Error(`LobsterAI 续期失败：${envelope.message}`)
    }

    const payload = parseLobsteraiTokenPayload(envelope.data)
    if (payload.accessToken.length === 0) {
      // 拿到 code:0 却没有 accessToken：与 Go 的 `refresh_failed` 同理，
      // 视为无法续期（需重新登录），而不是当成可重试的瞬时故障。
      throw new RefreshTokenExpiredError('续期响应缺少 accessToken，请重新登录')
    }
    return applyLobsteraiRefresh(hydrated, payload)
  }

  /**
   * 批量续期本产品的所有账号。
   *
   * ⚠️ **lead-time 过滤**（issue !IKIRTT）：早先这里是**无条件全量续期** ——
   * 定时器每 30 分钟就把每个账号的 refresh_token 轮换一次，与「凭据还剩多久」
   * 无关。现复用单凭据时代 `REFRESH_LEAD_MS` 的语义：**距过期不足 1 小时才刷**。
   * 跳过的账号仍会做一次**有效期对账**（见 `refreshAccountWithReconcile`），
   * 因为「不刷」与「不回写池值」正是 UI 假过期的两个来源，必须分开处理。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseCredential(resolved.value)
        if (!credential || !isLobsteraiRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        await refreshAccountWithReconcile({
          pool,
          provider: this.product.id,
          tag: '[lobsterai]',
          accountId: entry.id,
          credential,
          accessors: LOBSTERAI_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredential(c),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch {
            // 忽略 updateAccount 本身的错误
          }
          this.ctx.logger?.warn?.(
            `[lobsterai] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`,
          )
        } else {
          // 非终态失败（网络抖动、5xx、429…）：**必须留下日志**。
          //
          // 曾经这里完全静默 —— 账号在 UI 上仍显示「可续期」，续期却永远

          // 有同样的静默问题（属既有实现，本次不改动其行为），
          // 但新代码没有理由重复这个可诊断性缺陷。
          this.ctx.logger?.warn?.(
            `[lobsterai] 账号 ${entry.id} 续期失败（将按调度器策略重试）: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // 单账号失败不中断循环
      }
    }
  }

  /**
   * 移除已存储的凭据并停止任何待处理的刷新。
   *
   * 还要**通知服务端**（桌面端 `AuthIpcChannel.Logout`，`main.js:187237-187265`）：
   * 只清本地会让服务端一直认为该会话仍在线 —— 下次登录时「同一账号的两条会话
   * 时间线」本身就是异常信号。远程登出失败不影响本地结果。
   */
  async logout(): Promise<void> {
    // 先置 inactive，再清凭据：在途刷新完成后不得回写/重新武装调度。
    this.active = false
    this.scheduler.stop()
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    await this.ctx.credentials.unset(ref)
    if (resolved === null || resolved === undefined) return
    const credential = parseCredential(resolved.value)
    if (credential === undefined) return
    try {
      const clientVersion = await this.resolveClientVersion()
      const body = lobsteraiKeyfromBody(
        withLobsteraiIdentity(credential, await this.resolveIdentity()),
        clientVersion,
      )
      await this.fetchImpl(`${this.product.apiBase}${LOBSTERAI_LOGOUT_PATH}`, {
        method: 'POST',
        headers: lobsteraiJsonHeaders(credential, this.product),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[lobsterai] 远程登出失败（本地凭据已清除）: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 停止刷新调度（不清理凭据）。 */
  stop(): void {
    this.active = false
    this.scheduler.stop()
  }

  /** 启动时若已有可刷新凭据则安排续期，并做一次桌面端同款启动预热（由 apply 调用）。 */
  scheduleRefresh(): void {
    void this.ctx.credentials.resolve(credentialRef(this.credentialRefName)).then((resolved) => {
      if (!resolved) return
      const credential = parseCredential(resolved.value)
      if (!credential || !isLobsteraiRefreshable(credential)) return
      const expiresAt = lobsteraiCredentialExpiresAtMs(credential)
      if (expiresAt !== undefined) this.scheduler.arm(expiresAt)
      this.scheduleWarmupOnce()
    })
  }

  /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
  async checkExpired(): Promise<boolean> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return true
    const credential = parseCredential(resolved.value)
    return credential === undefined ? true : isLobsteraiExpired(credential)
  }

  /**
   * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
   *
   * 供 e2e 探针与 `account-probe` 使用（后者实际走 `resolveCredentialForAccount`，
   * 按账号 id 解析，不受 `enabled` 限制）。
   */
  async resolveStoredCredential(): Promise<LobsteraiCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseCredential(resolved.value)
  }

  /**
   * `GET /api/models/available` → 远端模型列表。
   *
   * 优先使用账号池中的可用账号；无账号池或池为空时回退到固定凭据 ref。
   * 两处都必须带上 `this.product` 与真实版本号 —— 该端点的 query 是
   * **身份载荷**（keyfrom），发错身份会让服务端返回错误的模型集合。
   */
  async fetchModels(pool?: AccountPool): Promise<LobsteraiRemoteModel[]> {
    let credential: LobsteraiCredential | undefined
    if (pool) {
      const available = await pool.getAvailableAccount(this.product.id, '')
      if (available) credential = available.credential as LobsteraiCredential
    }
    if (credential === undefined) credential = await this.resolveStoredCredential()
    if (credential === undefined || credential.access_token.length === 0) return []

    const clientVersion = await this.resolveClientVersion()
    // query 是**身份载荷**（桌面端 `appendKeyfromQuery`）：必须用安装身份覆盖
    // 凭据里的旧快照，否则老账号会继续把毫秒 keyfrom / 旧 uuid 发给服务端。
    const url = buildLobsteraiModelsUrl(
      this.product,
      withLobsteraiIdentity(credential, await this.resolveIdentity()),
      clientVersion,
    )
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        // 必须带 `X-LobsterAI-Client-Capabilities`：服务端按该头声明的能力
        // 过滤模型集合，不带时 `kimi-k3` 不会返回（实测 25 vs 26 个）。
        headers: lobsteraiModelsHeaders(credential, this.product, clientVersion),
        signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return []
      return parseLobsteraiModels(await response.json() as unknown)
    } catch {

      return []
    }
  }
}
