/**
 * LobsterAI（有道龙虾）登录：本地回调服务器 + `authCode` 换 token。
 *
 * ## 与桌面端（2026.11.6）对齐的部分
 *
 * 登录入口与参数形态**逐项照桌面端**实现（`main.js:186750-186787` 的
 * `auth:login` 处理器 + `useDesktopCompanionState-dtwKvfpU.js:8926-8974`）：
 *
 * 1. 登录页地址**运行时**从 overmind 的 `prod/login-url` 取（取不到才回退
 *    `https://lobsterai.youdao.com/portal#/login`）——与桌面端同一个入口，
 *    且在官方改道时不会停在旧地址；
 * 2. `redirect_uri` 里**再嵌一层** `return_to={urlencode(登录页#/login?source=electron&electronLogin=success)}`
 *    （桌面端 `appendCallbackReturnTo`，`main.js:88464-88468`）；
 * 3. `state = base64url(24 随机字节)`（桌面端 `crypto.randomBytes(24).toString("base64url")`，
 *    `main.js:88483`），不是 `randomUUID()` 的 36 字符带连字符形态；
 * 4. 参数写进 **hash query**（登录页带 `#`；桌面端 `appendLoginParams` 是 hash-aware）。
 *
 * ## 与 `lobsterai2api` 的实现差异（有意为之）
 *
 * Go 侧是**两个进程 + 一个 `/tmp` 状态文件**：
 * `login.exe url` 起回调服务器后把 `{port,state,uuid,firstKeyfrom}` 落盘到
 * `/tmp/lb2api-login-state.json`，阻塞等待 `.result` 文件出现；
 * `login.exe poll` 再读那个文件取结果（由 `login.sh` 顺序驱动，
 * 中间还夹一个 `read -rp "按 y 继续"` 的人在环确认）。
 *
 * 本模块把这套编排**收进单个进程内的 Promise**：
 * 回调服务器收到 `code` 后**立即在本进程完成 exchange**，
 * 直接 `resolve` 结果。这样就没有跨进程状态文件、没有残留文件误判、
 * 没有 shell 与 python3 依赖 —— 而这三样正是 Go 侧最脆弱的环节
 * （`main.go:162-164` 专门写了清理上一轮残留的代码，就说明它踩过坑）。
 *
 * 身份字段（`uuid` / `firstKeyfrom` / `latestKeyfrom`）**不在这里生成**：
 * 它们来自安装级身份（`lobsterai-identity.ts`），由 `LobsteraiAuth` 传入，
 * 因此重登不会换 uuid。
 */

import { createServer, type Server } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  LOBSTERAI_CALLBACK_PATH,
  LOBSTERAI_DEFAULT_KEYFROM,
  LOBSTERAI_EXCHANGE_PATH,
  LOBSTERAI_LOGIN_TIMEOUT_MS,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  isLobsteraiRefreshable,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiAnonymousHeaders,
  parseLobsteraiEnvelope,
  parseLobsteraiTokenPayload,
  parseLobsteraiInstallationUuid,
  sanitizeLobsteraiKeyfrom,
  buildLobsteraiCredential,
  type LobsteraiCredential,
  type LobsteraiIdentityFields,
} from './lobsterai.js'
import { lobsteraiFetch } from './lobsterai-fetch.js'
import type { LobsteraiProduct } from './lobsterai-product.js'

/** 在浏览器中打开登录 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>

/** 一次登录流程的结果。 */
export interface LobsteraiLoginFlowResult {
  /** 已序列化的 `LobsteraiCredential` JSON 字符串（直接存入 ctx.credentials）。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** `runLobsteraiLoginFlow` 接受的选项。 */
export interface LobsteraiLoginFlowOptions {
  /** 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 打开登录 URL 的方式；默认用平台打开器。 */
  openBrowser?: OpenBrowser
  /** 回调等待总超时（毫秒）；默认 10 分钟。 */
  timeoutMs?: number
  /** 外部取消信号。 */
  signal?: AbortSignal
  /** 产品配置；默认 LOBSTERAI。 */
  product?: LobsteraiProduct
  /**
   * 安装身份（`uuid` + keyfrom）。
   *
   * 正常路径由 `LobsteraiAuth.resolveIdentity()` 传入（落盘的安装级身份）；
   * 缺省时退化为一套一次性身份（uuid 现造），**仅**为兼容直接调用本模块的
   * 脚本/测试 —— 那正是修复前「每次登录 = 新设备」的行为，生产路径不应走到。
   */
  identity?: LobsteraiIdentityFields
}

/** 没有注入安装身份时的兜底；生产路径不应命中（见 `identity` 的说明）。 */
export function fallbackLobsteraiIdentity(): LobsteraiIdentityFields {
  return {
    uuid: randomUUID(),
    firstKeyfrom: LOBSTERAI_DEFAULT_KEYFROM,
    latestKeyfrom: LOBSTERAI_DEFAULT_KEYFROM,
  }
}

/**
 * 在登录页 URL 上追加参数（**hash-aware**，对齐桌面端 `appendLoginParams`，
 * `main.js:88444-88463`）。
 *
 * 登录页形态是 `…/portal#/login`：参数必须写进 **hash query**，写进 `search`
 * 服务端登录页读不到。没有 `#` 时退回普通 `searchParams`。
 *
 * 已知参数会被覆盖（`set`），不产生重复键。
 */
export function appendLobsteraiLoginParams(
  baseUrl: string,
  params: Record<string, string>,
): string {
  const hashIndex = baseUrl.indexOf('#')
  if (hashIndex < 0) {
    const url = new URL(baseUrl)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return url.toString()
  }
  const beforeHash = baseUrl.slice(0, hashIndex)
  const fragment = baseUrl.slice(hashIndex + 1)
  const queryIndex = fragment.indexOf('?')
  const route = queryIndex < 0 ? fragment : fragment.slice(0, queryIndex)
  const search = new URLSearchParams(queryIndex < 0 ? '' : fragment.slice(queryIndex + 1))
  for (const [key, value] of Object.entries(params)) search.set(key, value)
  const query = search.toString()
  return query.length === 0 ? `${beforeHash}#${route}` : `${beforeHash}#${route}?${query}`
}

/**
 * 构造 portal 登录 URL（参数形态逐项对齐桌面端，见模块头注释）。
 *
 * 实际形态（桌面端 `main.js:186762-186773` 换算后）：
 *
 * ```text
 * {loginPage}?source=electron
 *   &redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fauth%2Fcallback%3Freturn_to%3D{…}
 *   &state={base64url(24B)}
 * ```
 *
 * 其中 `redirect_uri` 内嵌的 `return_to` 是**登录成功后的落地页**：
 * `{loginPage}?source=electron&electronLogin=success`。少了它，服务端就不知道
 * 登录完成后该回哪个页面，落地页也不会带 `electronLogin=success` 标记
 * （这是桌面端与插件最容易被忽略的一处差异）。
 *
 * ⚠️ 用 `URLSearchParams` 而非手工拼字符串：`redirect_uri` 含 `://` 与 `:`
 * 必须被百分号编码，手工拼极易漏编码导致登录页校验失败。
 */
export function buildLobsteraiLoginUrl(
  port: number,
  state: string,
  product: LobsteraiProduct,
  loginPageUrl: string = product.portalLoginUrl,
): string {
  const page = loginPageUrl.trim().length > 0 ? loginPageUrl.trim() : product.portalLoginUrl
  const callback = `http://127.0.0.1:${port}${LOBSTERAI_CALLBACK_PATH}`
  // ① 登录成功后的落地页（桌面端 `returnTo`）。
  const returnTo = appendLobsteraiLoginParams(page, {
    source: 'electron',
    electronLogin: 'success',
  })
  // ② 回调地址，把落地页嵌进它的 `return_to`（桌面端 `appendCallbackReturnTo`）。
  const redirectUri = appendLobsteraiLoginParams(callback, { return_to: returnTo })
  // ③ 最终打开的登录页。
  return appendLobsteraiLoginParams(page, {
    source: 'electron',
    redirect_uri: redirectUri,
    state,
  })
}

/** 从 overmind 的 `{data:{value}}` 信封里取登录页地址；形状不对返回 undefined。 */
export function loginPageUrlFromOvermind(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return undefined
  const value = (data as Record<string, unknown>).value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  // 只接受绝对 http(s) 地址：配置端点被劫持/改坏时不能把用户导向任意 scheme。
  if (!/^https?:\/\//i.test(trimmed)) return undefined
  try {
    new URL(trimmed)
  } catch {
    return undefined
  }
  return trimmed
}

/**
 * 运行时解析登录页地址（桌面端 `fetchLoginUrl()` 的等价物）。
 *
 * 失败（网络/形状/超时）一律回退 {@link LobsteraiProduct.portalLoginUrl}，
 * **绝不因为配置端点不可达而让用户无法登录**。
 */
export async function resolveLobsteraiLoginPageUrl(
  product: LobsteraiProduct,
  fetcher: typeof fetch = lobsteraiFetch,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const response = await fetcher(product.loginUrlApi, {
      method: 'GET',
      // 桌面端对 overmind 的请求头只有 `Accept: application/json`
      //（运行日志 `main-2026-11-13.log:531`），不带 UA。
      headers: { Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return product.portalLoginUrl
    const page = loginPageUrlFromOvermind(await response.json() as unknown)
    return page ?? product.portalLoginUrl
  } catch {
    return product.portalLoginUrl
  }
}

/**
 * 用授权码换取凭据。
 *
 * 请求体**必须**含 5 个字段（对齐桌面端 `main.js:186853-186867` 的
 * `withKeyfromBody({authCode})`）：
 * `authCode` / `firstKeyfrom` / `latestKeyfrom` / `uuid` / `version`。
 * 其中 `uuid` / `firstKeyfrom` / `latestKeyfrom` 来自**安装级身份**
 * （{@link LobsteraiIdentityFields}），`version` 用动态拉取的真值。
 *
 * 该端点**不需要** `Authorization` 头（换 token 时还没有 token）。
 *
 * @throws 当网络失败、信封 code 非 0、或响应缺 accessToken 时。
 */
export async function exchangeLobsteraiAuthCode(
  code: string,
  identity: LobsteraiIdentityFields,
  clientVersion: string,
  product: LobsteraiProduct,
  fetcher: typeof fetch = lobsteraiFetch,
  signal?: AbortSignal,
): Promise<LobsteraiCredential> {
  const body = {
    authCode: code,
    firstKeyfrom: sanitizeLobsteraiKeyfrom(identity.firstKeyfrom),
    latestKeyfrom: sanitizeLobsteraiKeyfrom(identity.latestKeyfrom),
    // uuid 必须是安装 UUID：形态非法时退回现造的值而不是发垃圾串。
    uuid: parseLobsteraiInstallationUuid(identity.uuid) ?? fallbackLobsteraiIdentity().uuid,
    version: clientVersion,
  }
  const signalToUse = signal === undefined
    ? AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS)
    : AbortSignal.any([AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS), signal])

  let response: Response
  try {
    response = await fetcher(`${product.apiBase}${LOBSTERAI_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: lobsteraiAnonymousHeaders(product),
      body: JSON.stringify(body),
      signal: signalToUse,
    })
  } catch (error) {
    throw new Error(`LobsterAI exchange 网络失败：${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`LobsterAI exchange 响应不是 JSON（HTTP ${response.status}）`)
  }

  const envelope = parseLobsteraiEnvelope(parsed)
  if (!envelope.ok) {
    throw new Error(`LobsterAI exchange 失败：${envelope.message}`)
  }

  const payload = parseLobsteraiTokenPayload(envelope.data)
  if (payload.accessToken.length === 0) {
    // 与 Go 的 `refresh_failed: no accessToken` 同理：没有令牌就没有可用的凭据，
    // 不能把半成品存进凭据库。
    throw new Error('LobsterAI exchange 响应缺少 accessToken')
  }

  return buildLobsteraiCredential(payload, {
    uuid: body.uuid,
    firstKeyfrom: body.firstKeyfrom,
    latestKeyfrom: body.latestKeyfrom,
  })
}

/** 把凭据包成一次登录流程的结果。 */
function toLoginFlowResult(
  credential: LobsteraiCredential,
  loginUrl: string,
): LobsteraiLoginFlowResult {
  return {
    access: JSON.stringify(credential),

    // 凭据本身可用（只是有效期未知），不该因为展示层的缺失而登录失败。
    expires: lobsteraiCredentialExpiresAtMs(credential) ?? 0,
    loginUrl,
    refreshable: isLobsteraiRefreshable(credential),
  }
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const { openBrowser } = await import('./open-browser.js')
  openBrowser(url)
}

/**
 * 已启动但尚未完成的登录流程（两步式登录用）。
 */
export interface StartedLobsteraiLoginFlow {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<LobsteraiLoginFlowResult>
  /** 关闭回调服务器；**幂等**，可重复调用。 */
  close: () => Promise<void>
}

/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * `result` 已内置超时：两步式路径没有外层 try/finally 兜底，
 * 若超时不在此处生效，回调服务器会一直挂着。
 * 结果一旦落定就自动关闭服务器，避免两步式路径泄漏监听端口。
 */
export async function startLobsteraiLoginFlow(
  options: LobsteraiLoginFlowOptions & { product: LobsteraiProduct; clientVersion: string },
): Promise<StartedLobsteraiLoginFlow> {
  const fetcher = options.fetcher ?? lobsteraiFetch
  const { product, clientVersion } = options
  // 安装级身份由调用方（`LobsteraiAuth`）提供；缺省才退化为一套一次性身份。
  const identity = options.identity ?? fallbackLobsteraiIdentity()
  // 桌面端 `state = crypto.randomBytes(24).toString("base64url")`（32 字符，
  // 只含 A-Za-z0-9_-），不是 randomUUID() 的 36 字符带连字符形态。
  const state = randomBytes(24).toString('base64url')
  // 登录页地址运行时从 overmind 取（失败回退 portal），与桌面端 `fetchLoginUrl()` 一致。
  const loginPageUrl = await resolveLobsteraiLoginPageUrl(product, fetcher, options.signal)

  let resolveResult!: (value: LobsteraiLoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LobsteraiLoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 这个 Promise 是手工创建的、要过一会儿才交给 `Promise.race` 消费，
  // 而回调处理器可能在「构造完成」与「被 await」之间就把它 reject 掉
  // （典型：用户浏览器回调极快，或 exchange 立刻失败）。那一段窗口里
  // Node 会把它视为**未处理的拒绝**并打印
  // `PromiseRejectionHandledWarning` / 触发 vitest 的 unhandled error。
  //
  // 先挂一个空处理器把「已处理」标记打上，可消除该告警；
  // 这不影响后续消费者 —— `Promise.race` 仍能拿到同一个拒绝原因。
  result.catch(() => {})

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (!url.pathname.startsWith(LOBSTERAI_CALLBACK_PATH)) {
      response.writeHead(404).end('Not found')
      return
    }
    const code = url.searchParams.get('code')
    const gotState = url.searchParams.get('state')
    if (code === null || code.length === 0 || gotState !== state) {
      // state 不匹配说明回调不是本次登录发起的（或为伪造），按 Go 的做法直接拒绝。
      // 这里用 400 而不是静默忽略：让用户在浏览器里看到明确的失败反馈。
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调参数无效')
      return
    }
    // 立即在本进程完成 exchange，成功/失败都先把浏览器页面对付了，
    // 否则用户会看到一个一直转圈的页面。
    //
    // 结果里的 loginUrl 用**回调请求实际落到的端口**（`socket.localPort`）
    // 现算，而不是捕获外层变量：回调服务器端口是在 `listen` 之后才知道的，
    // 先声明后赋值会让这个闭包引用一个尚未初始化的 const。
    void exchangeLobsteraiAuthCode(code, identity, clientVersion, product, fetcher, options.signal)
      .then((credential) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>')
        const port = request.socket.localPort ?? 0
        resolveResult(toLoginFlowResult(credential, buildLobsteraiLoginUrl(port, state, product, loginPageUrl)))
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录换取凭据失败')
        rejectResult(error)
      })
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = buildLobsteraiLoginUrl(port, state, product, loginPageUrl)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const resultWithTimeout = Promise.race([
    result,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`LobsterAI 登录超时（${Math.round((options.timeoutMs ?? LOBSTERAI_LOGIN_TIMEOUT_MS) / 1000)} 秒内未完成）`)),
        options.timeoutMs ?? LOBSTERAI_LOGIN_TIMEOUT_MS,
      )
      timer.unref?.()
    }),
  ])
  // 结果落定即关闭服务器（含超时与失败路径）——两步式没有外层 finally。
  resultWithTimeout.catch(() => {}).finally(() => { void close() })

  return { loginUrl, result: resultWithTimeout, close }
}

/**
 * 运行完整登录流程：起本地回调服务器 → 打开 portal → 等 `code` → exchange。
 *
 * 单进程内闭环，不落状态文件（见模块头注释）。
 *
 * `timeoutMs` 覆盖「浏览器打开 + 用户操作」整个窗口，超时抛错；
 * 无论成功失败都关闭本地服务器（`finally`）。
 *
 * 阻塞语义：打开浏览器并等用户完成授权后才返回。需要「立即拿到 URL」的
 * 场景（Channel Pack 两步式登录）请用 {@link startLobsteraiLoginFlow}。
 */
export async function runLobsteraiLoginFlow(
  options: LobsteraiLoginFlowOptions & { product: LobsteraiProduct; clientVersion: string },
): Promise<LobsteraiLoginFlowResult> {
  const open: OpenBrowser = options.openBrowser ?? defaultOpenBrowser
  const started = await startLobsteraiLoginFlow(options)
  try {
    await open(started.loginUrl)
    return await started.result
  } finally {
    await started.close()
  }
}

/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器，返回实际端口。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：回调只可能来自本机浏览器，
 * 不对外暴露监听面。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('LobsterAI 登录回调服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}
