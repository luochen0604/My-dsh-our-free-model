/**
 * 豆包工作（DoubaoWork）认证服务。
 *
 * ## 与其它 provider 的关键差异
 *
 * | 维度 | Raccoon | TRAE | **豆包** |
 * |---|---|---|---|
 * | 鉴权 | Bearer JWT | Cloud-IDE-JWT | **纯 cookie（`sessionid`）** |
 * | 续期 | `refresh_token` 轮换 | `ExchangeToken` | **无（滚动 cookie，服务端自动续）** |
 * | 过期判定 | 解 JWT `exp` | 解 JWT `exp` | **不可解 → 探活** |
 * | 登录取凭据 | 本地承载登录页 | 手机号 + OAuth | **见下** |
 *
 * ## 为什么登录取「cookie 导入」而不是自动化登录页
 *
 * 豆包/字节的登录链路是 passport 全套（扫码 / 短信 / 第三方），其中：
 *
 * 1. **二维码轮询端点未取证**：`/passport/mobile/get_qrcode` 等路径在 bundle 里
 *    出现了（见报告 §3.1），但请求/响应体形状、`aid` 与 `sso` 路径的绑定关系
 *    **都没有实测样本**。照猜测实现一个登录页，等于把一个必然失败的东西交付给用户。
 * 2. **短信登录要过阿里云滑块**：`ai-views` 里存在 `captcha` 相关依赖，
 *    且 Raccoon 的经验表明滑块 `sceneId` 与页面 origin 强绑定
 *    （见 `raccoon-login-page.ts` 模块头）——复刻必然漂移。
 * 3. **已有更可靠的等价路径**：用户本机就装着豆包工作，登录一次即可。
 *    我们只需要**读取它的 cookie** 并导入。
 *
 * 故本 provider 采用与「WPS 灵犀」同型的**凭据导入**模型：
 * 用户粘贴一段 cookie（或从本地 profile 读取），我们验证后持久化。
 *
 * ## ⚠️ 为什么不自动读本地 Cookies 数据库
 *
 * `%LOCALAPPDATA%\DoubaoWork\User Data\Default\Network\Cookies` 是 Chromium 的
 * SQLite，且**被运行中的进程独占加锁**（本次实测 `IOException`：另一进程正在使用）。
 * 绕过它需要调用系统备份权限（`SeBackupPrivilege`），普通进程没有。
 * 因此**不做自动读取**——让用户粘贴，是唯一不依赖提权的路径。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import type { CheckinStatus, ClaimOutcome, CreditBalance } from './credits.js'
import { DOUBAO, type DoubaoProduct } from './doubao-product.js'
import {
  isDoubaoStale,
  isDoubaoUsable,
  parseCookieString,
  type DoubaoCredential,
} from './doubao.js'
import {
  claimDoubaoDailyPoints,
  fetchDoubaoCheckinStatus,
  fetchDoubaoCreditBalance,
  probeDoubaoCredential,
} from './doubao-credits.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 豆包的认证服务实例（服务名由 product.id 派生）。 */
    doubaoAuth: DoubaoAuth
  }
}

/** 服务选项。 */
export interface DoubaoAuthOptions {
  /** 产品配置覆盖（测试用）。 */
  product?: DoubaoProduct
  /** 服务名覆盖（多实例场景）。 */
  serviceName?: string
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 注入的账号池（可选）。 */
  pool?: AccountPool
}

/** 凭据有效期：超过这个时长且未被探活确认，就视为"需要重新验证"。 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000

/** 一次登录/导入的结果。 */
export interface DoubaoLoginResult {
  /** 序列化后的凭据（写入 credentials store 的值）。 */
  access: string
  /** 过期时间戳（毫秒）。豆包无固定过期，返回 0 表示"不适用"。 */
  expires: number
  /** 凭据 ref。 */
  ref: CredentialRef
  /** 是否可续期。豆包恒为 `false`（没有 refresh 端点）。 */
  refreshable: false
}

/**
 * 豆包认证服务。
 *
 * ## 两条硬约束（源自其它 provider 的真实缺陷）
 *
 * 1. **`refreshAll` 只按"需要探活"过滤，绝不看 `enabled`** ——
 *    禁用只影响账号池自动选号，与"凭据是否需要保持新鲜"无关。
 *    （Raccoon 早期按 `enabled` 过滤，导致两个禁用账号的 refresh 被放到失效。）
 * 2. **`refreshAccountCredential(refName)` 只读写传入的 ref** ——
 *    账号卡片要刷的是 `DOUBAO_ACCOUNT_XXX`，而 `refresh()` 读写默认单凭据 ref。
 *    错配的后果是"刷了另一个凭据"。
 */
export class DoubaoAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: DoubaoProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string
  /** 最近一次刷新/探活失败信息（供 UI 展示）。 */
  lastRefreshError: string | undefined

  constructor(ctx: Context, private readonly options: DoubaoAuthOptions = {}) {
    const product = options.product ?? DOUBAO
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  // ── 凭据解析 ───────────────────────────────────────────────────────────

  /** 把存储值解析成凭据；损坏时返回 `undefined` 而不是抛错。 */
  private parse(raw: string | undefined): DoubaoCredential | undefined {
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    try {
      const parsed = JSON.parse(raw) as Partial<DoubaoCredential>
      if (typeof parsed.cookie !== 'string' || !isDoubaoUsable(parsed as DoubaoCredential)) return undefined
      return {
        cookie: parsed.cookie,
        uid: typeof parsed.uid === 'string' ? parsed.uid : '',
        nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
        lastVerifiedAt: typeof parsed.lastVerifiedAt === 'number' ? parsed.lastVerifiedAt : 0,
        desktop: parsed.desktop === true,
      }
    } catch {
      return undefined
    }
  }

  /** 读一个 ref 的凭据。 */
  async readCredential(refName?: string): Promise<DoubaoCredential | undefined> {
    const ref = credentialRef(refName ?? this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    return this.parse(resolved?.value)
  }

  // ── 导入 / 登录 ─────────────────────────────────────────────────────────

  /**
   * 从粘贴的 cookie 串导入凭据。
   *
   * ## 为什么必须先探活
   *
   * 豆包的凭据没有可解析的过期时间，**唯一能确认"这段 cookie 有效"的方法
   * 就是发一次请求**。不验证就落盘，用户会在几小时后遇到莫名其妙的失败，
   * 而不知道该重新登录。
   *
   * 因此：探活失败 → 不落盘、抛错；探活无法判定（网络问题）→ 落盘但标记
   * `lastVerifiedAt = 0`，让后续流程知道"这个凭据还没被证实"。
   *
   * @param cookieInput 用户粘贴的 cookie（`k=v; k2=v2`），或仅 `sessionid=...`
   * @param options.nickname 展示名
   * @param options.refName 目标 ref（多账号时用 `DOUBAO_ACCOUNT_xxx`）
   */
  async importCookie(
    cookieInput: string,
    options: { nickname?: string; refName?: string; desktop?: boolean } = {},
  ): Promise<DoubaoLoginResult> {
    const cookie = normalizeCookieInput(cookieInput)
    if (!cookie.includes('sessionid=')) {
      throw new Error('豆包凭据缺少 sessionid。请粘贴完整 cookie（至少包含 sessionid=...）。')
    }

    const parsed = parseCookieString(cookie)
    const credential: DoubaoCredential = {
      cookie,
      // 字节 cookie 里常见的 uid 载体；取不到就留空（仅影响显示）。
      uid: parsed['uid_tt'] ?? parsed['uid_tt_ss'] ?? '',
      nickname: options.nickname ?? '',
      lastVerifiedAt: 0,
      desktop: options.desktop === true,
    }

    // 探活：唯一能确认凭据有效的手段。
    const alive = await probeDoubaoCredential(credential, this.product, this.fetchImpl)
    if (alive === false) {
      throw new Error('豆包凭据验证失败（服务端返回 401/403），请重新从豆包工作复制 cookie。')
    }
    if (alive === true) {
      credential.lastVerifiedAt = Date.now()
      this.lastRefreshError = undefined
    } else {
      // 网络问题：无法判定。照常落盘，但明确标记"未证实"。
      this.lastRefreshError = '凭据已保存，但本次未能验证（网络异常）。'
    }

    const refName = options.refName ?? this.credentialRefName
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(credential))

    // 登录成功后尽力初始化积分读数（与官方客户端登录后行为一致）。
    // 失败不影响登录本身。
    try {
      await fetchDoubaoCreditBalance(credential, this.product, this.fetchImpl)
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[doubao] 登录后初始化积分读数失败（不影响登录）：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return {
      access: JSON.stringify(credential),
      // 豆包无固定过期 → 0 表示"不适用"，而不是"已过期"。
      expires: 0,
      ref,
      refreshable: false,
    }
  }

  // ── 刷新（探活式） ──────────────────────────────────────────────────────

  /**
   * 刷新默认单凭据的"新鲜度"。
   *
   * 豆包**没有续期端点**，所以"刷新"= 探活 + 更新时间戳。
   * 与 ZCode / Lingxi 同策略：探活失败就抛错，让 UI 提示用户重新导入。
   */
  async refresh(): Promise<DoubaoCredential | void> {
    return this.refreshOwn((refName) => this.refreshAccountCredential(refName))
  }

  /**
   * 刷新指定账号的凭据。
   *
   * ⚠️ **只读写传入的 ref**（见类注释的硬约束 2）。
   */
  async refreshAccountCredential(refName: string): Promise<DoubaoCredential | void> {
    const credential = await this.readCredential(refName)
    if (credential === undefined) {
      throw new Error('豆包凭据不存在或已损坏，请重新导入。')
    }

    const alive = await probeDoubaoCredential(credential, this.product, this.fetchImpl)
    if (alive === false) {
      this.lastRefreshError = '豆包凭据已失效，请重新导入。'
      throw new Error(this.lastRefreshError)
    }
    if (alive === undefined) {
      // 网络异常：不谎报成功，也不删凭据。
      this.lastRefreshError = '豆包探活失败（网络异常），稍后重试。'
      throw new Error(this.lastRefreshError)
    }

    const next: DoubaoCredential = { ...credential, lastVerifiedAt: Date.now() }
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(next))
    this.lastRefreshError = undefined
    return next
  }

  /** 批量刷新：**只按"需要探活"过滤，不看 `enabled`**（见类注释的硬约束 1）。 */
  async refreshAll(): Promise<{ refreshed: number; failed: number }> {
    const accounts = await this.options.pool?.listAccounts(this.product.id) ?? []
    let refreshed = 0
    let failed = 0
    for (const account of accounts) {
      const credential = await this.readCredential(account.credentialRef)
      if (credential === undefined) {
        failed += 1
        continue
      }
      // 只看"是否够久没验证"，不看 enabled。
      if (!isDoubaoStale(credential, STALE_AFTER_MS)) continue
      try {
        await this.refreshAccountCredential(account.credentialRef)
        refreshed += 1
      } catch {
        failed += 1
      }
    }
    return { refreshed, failed }
  }

  /** 内部辅助：把 ref 的操作套到默认 ref 上（避免两条路径重复实现）。 */
  private async refreshOwn(
    run: (refName: string) => Promise<DoubaoCredential | void>,
  ): Promise<DoubaoCredential | void> {
    return run(this.credentialRefName)
  }

  // ── 积分 ───────────────────────────────────────────────────────────────

  /** 查余额（只读）。 */
  async readBalance(refName?: string): Promise<CreditBalance | undefined> {
    const credential = await this.readCredential(refName)
    if (credential === undefined) return undefined
    return fetchDoubaoCreditBalance(credential, this.product, this.fetchImpl)
  }

  /** 查签到状态（只读）。 */
  async readCheckinStatus(refName?: string): Promise<CheckinStatus | undefined> {
    const credential = await this.readCredential(refName)
    if (credential === undefined) return undefined
    return fetchDoubaoCheckinStatus(credential, this.product, this.fetchImpl)
  }

  /** 领取每日积分（写端点，只在用户明确操作时调用）。 */
  async claimDaily(refName?: string): Promise<ClaimOutcome> {
    const credential = await this.readCredential(refName)
    if (credential === undefined) {
      return { kind: 'failed', code: 0, message: '豆包凭据不存在，请先导入。' }
    }
    return claimDoubaoDailyPoints(credential, this.product, this.fetchImpl)
  }
}

/**
 * 归一化用户粘贴的 cookie 输入。
 *
 * 用户可能粘贴的形式：
 * - 完整 cookie 串：`a=1; b=2; sessionid=xxx`
 * - 仅一项：`sessionid=xxx`
 * - 带前缀 `Cookie: `（从 devtools 复制常见）
 * - 带换行（多行粘贴）
 */
export function normalizeCookieInput(raw: string): string {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  // 去掉常见的复制前缀。
  text = text.replace(/^cookie\s*:\s*/i, '')
  // 换行/制表符归一成空格（cookie 分隔符只能是 `;`，但粘贴常带换行）。
  text = text.replace(/[\r\n\t]+/g, ' ')
  // 压缩多余空白。
  text = text.replace(/\s{2,}/g, ' ')
  // 若用户只粘了值（没有 `=`），当作 sessionid 处理。
  if (!text.includes('=')) return `sessionid=${text}`
  return text
}
