/**
 * WorkBuddy（WB）每日签到 —— 数据层。
 *
 * ## ⚠️⚠️ WB 的积分是「活动制」，**不是**消费余额
 *
 * `checkin-activity-status` 返回的 `total_credits` 是**活动累计奖励计数**
 * （活动发了多少分），**不是**可用于推理扣费的余额。它不能映射成
 * `CreditBalance.total` —— 映射了会让用户以为账户里有那么多消费额度。
 *
 * ## 为什么**没有**余额实现
 *
 * `/billing/meter/balance` 实测（2026-11-13，3 个存活账号）恒 **404**，
 * 该端点不存在。WB 侧没有公开的消费余额查询端点，故 `credits.balances`
 * 分支如实说明「无余额接口」，不编造数字。
 *
 * ## 协议（全部 POST，body `{}`，2026-11-13 实测通过）
 *
 * ```
 * base = https://{domain || www.workbuddy.cn}
 * headers:
 *   Content-Type: application/json
 *   Accept: application/json
 *   X-Domain: {domain}
 *   User-Agent: <桌面 Chrome UA>
 *   Authorization: Bearer {accessToken}
 *   X-User-Id: {uid}
 * POST /billing/meter/checkin-activity-status → {code:0, data:{active,
 *   today_checked_in, streak_days, daily_credit, total_credits, …}}
 * POST /billing/meter/daily-checkin            → {code:0|非0, msg, data?}
 * ```
 *
 * ## 错误分类表（与 `ClaimOutcome` 的映射）
 *
 * | 情形                       | Outcome                       | 说明 |
 * |----------------------------|-------------------------------|------|
 * | HTTP 200 且 `code === 0`   | `claimed`                     | credit 取 `daily_credit`，取不到按 0 |
 * | msg 含「已签/已领取」或 `today_checked_in === true` | `already-claimed` | 幂等：不重复报错 |
 * | HTTP 401（或非 JSON 401）  | `failed` code=-1「凭据已失效」 | 引导重新登录 |
 * | HTTP 403 且 `code = 11140` | `failed` code=11140「签到冷却中」 | 活动冷却，供面板显示 |
 * | HTTP 429 且 `code = 6004`  | `failed` code=6004「请求过于频繁」 | 频率限制，稍后重试 |
 * | 其它非 0 code              | `failed` code=<业务码>，message=`msg` | 保留原文不吞 |
 */

import { jwtExpiresAtMs } from './credential-expiry.js'
import type { ExpiryAccessors } from './expiry-sync.js'

/** provider 标识（注册到账号池 / 客户端渠道清单的 id）。 */
export const WORKBUDDY_ID = 'workbuddy'

/**
 * WorkBuddy **真实续期端点**（2026-11-13 从桌面端 5.9.3 逆向取证，实测通过）。
 *
 * ## 证据链（全部来自本机安装的官方桌面端，非猜测）
 *
 * 1. `D:\Program Files (x86)\WorkBuddy\resources\app.asar.unpacked\cli\product.json`
 *    的 `authentication` 段：
 *    ```
 *    { "id": "workbuddy-desktop",
 *      "type": "account-scoped-external-link",
 *      "attributes": { "prefixPath": "/plugin", "platform": "workbuddy", ... } }
 *    endpoint = "https://www.workbuddy.cn"
 *    ```
 * 2. `app.asar` 的 `main/common2.js`
 *    （`AccountScopedExternalLinkAuthenticationProvider.refreshSession`）：
 *    ```
 *    this.restOperations.post(`/v2${this.prefixPath}/auth/token/refresh`, {}, {
 *      headers: { ...this.enterpriseHeaders(e.auth),          // { 'X-Domain': domain }
 *                 'X-Refresh-Token': e.auth.refreshToken,
 *                 'X-Auth-Refresh-Source': 'plugin', ... } })
 *    ```
 *    `enterpriseHeaders()` 只回 `{'X-Domain': account.domain || endpoint authority}`；
 *    随后 `calculateExpiresAt()` 用响应的 `expiresIn` 换算 `expiresAt`。
 * 3. `app.asar` 的 `main/auth-liveness.js` 把
 *    `POST /v2/*\/auth/token/refresh` 登记为 `login.session.refresh`
 *    （`replayClass: forbidden`）—— 即这是桌面端唯一的会话续期路由。
 * 4. **实测（2026-11-13）**：对本机 3 个存活账号之一发上述请求，
 *    `HTTP 200 → {code:0,msg:"OK",data:{accessToken,refreshToken,tokenType:"Bearer",
 *    expiresIn:2419200,refreshExpiresIn:2591999,sessionState,domain:"www.workbuddy.cn"}}`；
 *    access/refresh **两个令牌都会轮换**（新 JWT 的 `jti`/`iat`/`exp` 均变），
 *    新 accessToken 立即通过 `checkin-activity-status` 探活（code 0）。
 *
 * 故此前的「WorkBuddy 没有续期端点」是**错误结论**：端点存在，只是不在
 * `/v2/auth/...`（那是 CodeBuddy 系产品的无 prefixPath 形态），而在
 * `/v2/plugin/auth/...`。
 */
export const WORKBUDDY_TOKEN_REFRESH_PATH = '/v2/plugin/auth/token/refresh'

/**
 * 续期请求的来源标记（桌面端同一常量）。
 *
 * 桌面端在**插件/CLI 形态**下固定发 `plugin`（见上面的 `refreshSession`），
 * 服务端据此区分「客户端续期」与「网页续期」。删掉它实测仍能续期，但保持
 * 与官方客户端逐字段一致可降低风控误判概率 —— 与 UA 伪装同思路。
 */
export const WORKBUDDY_AUTH_REFRESH_SOURCE = 'plugin'

/** refresh_token 缺失或已被服务端拒绝（401/403）：只能重新导入/登录。 */
export class WorkbuddyRefreshTokenExpiredError extends Error {
  constructor(message = 'WorkBuddy refresh_token 已失效，请重新导入该账号') {
    super(message)
    this.name = 'WorkbuddyRefreshTokenExpiredError'
  }
}


/** 缺省域名（账号池条目未填 `domain` 时使用）。 */
export const WORKBUDDY_DEFAULT_DOMAIN = 'www.workbuddy.cn'

/** 业务请求超时（毫秒）。 */
export const WORKBUDDY_REQUEST_TIMEOUT_MS = 30_000

/**
 * 桌面 Chrome UA。
 *
 * WB 服务端未见对 UA 的强校验，但请求形态对齐桌面端能降低被风控按
 * 「非常见客户端」拦下的概率（与 LobsterAI 伪装 win32 同思路）。
 */
export const WORKBUDDY_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** WB 官方业务端点路径。 */
export const WORKBUDDY_CHECKIN_STATUS_PATH = '/billing/meter/checkin-activity-status'
export const WORKBUDDY_DAILY_CHECKIN_PATH = '/billing/meter/daily-checkin'

/**
 * WB 凭据（存 `ctx.credentials` 的 JSON 形状）。
 *
 * 字段名对齐 WB 账号池文件（`<uid>.json`）的 `accessToken` / `refreshToken` /
 * `domain` —— 导入账号时逐字复制，避免一层翻译。
 */
export interface WorkbuddyCredential {
  /** 账号 uid（同时进 `X-User-Id` 头）。 */
  uid: string
  /** Bearer access token。 */
  accessToken: string
  /**
   * 刷新令牌。
   *
   * ⚠️ 它**能真的续期**（见 {@link WORKBUDDY_TOKEN_REFRESH_PATH} 的证据链）；
   * 旧注释写的「本轮未实现续期端点」已作废 —— 端点存在，只是路径带 `/plugin`
   * 前缀。缺失时唤醒退化为「只探活」，并把账号池的 `refreshable` 标成 false。
   */
  refreshToken?: string
  /** 站点域名（不带协议；缺省 {@link WORKBUDDY_DEFAULT_DOMAIN}）。 */
  domain?: string
  /** 展示名（可选）。 */
  nickname?: string
}

/**
 * 续期请求头（与桌面端 `refreshSession` 逐字段一致）。
 *
 * ⚠️ **不**带 `Authorization` / `X-User-Id`：桌面端续期请求只带三者
 * （`X-Domain`、`X-Refresh-Token`、`X-Auth-Refresh-Source`），且此时旧
 * accessToken 往往已过期 —— 带上它反而让服务端在两份凭据不一致时拒绝。
 */
export function workbuddyRefreshHeaders(credential: WorkbuddyCredential): Headers {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json')
  headers.set('X-Domain', credential.domain ?? WORKBUDDY_DEFAULT_DOMAIN)
  headers.set('User-Agent', WORKBUDDY_USER_AGENT)
  headers.set('X-Refresh-Token', credential.refreshToken ?? '')
  headers.set('X-Auth-Refresh-Source', WORKBUDDY_AUTH_REFRESH_SOURCE)
  return headers
}

/** 组装认证 + 身份请求头（与实测抓包逐字段一致）。 */
export function workbuddyHeaders(credential: WorkbuddyCredential): Headers {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json')
  headers.set('X-Domain', credential.domain ?? WORKBUDDY_DEFAULT_DOMAIN)
  headers.set('User-Agent', WORKBUDDY_USER_AGENT)
  headers.set('Authorization', `Bearer ${credential.accessToken}`)
  headers.set('X-User-Id', credential.uid)
  return headers
}

/** WB 业务信封（`{code, msg, data}`）。 */
export interface WorkbuddyEnvelope {
  code: number
  msg?: string
  data?: unknown
}

/** 一次请求的解析结果。 */
type EnvelopeResult =
  | { ok: true; status: number; envelope: WorkbuddyEnvelope }
  | { ok: false; status: number; message: string }

/**
 * 发一次 POST `{}` 并拆信封。
 *
 * ⚠️ 与 `credits.ts` 系的既有做法一致：**不用 `response.json()`** ——
 * 凭据失效时服务端可能回 HTML 错误页，先取文本再解析，非 JSON 给可读原因。
 *
 * ⚠️ **不抛错**：批量领取时单账号失败不应中断其余账号。
 */
async function requestEnvelope(
  credential: WorkbuddyCredential,
  path: string,
  fetcher: typeof fetch,
): Promise<EnvelopeResult> {
  const base = `https://${credential.domain?.length ? credential.domain : WORKBUDDY_DEFAULT_DOMAIN}`
  try {
    const response = await fetcher(`${base}${path}`, {
      method: 'POST',
      headers: workbuddyHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(WORKBUDDY_REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ok: false,
        status: response.status,
        message: response.status === 401 || response.status === 403
          ? `凭据已失效（HTTP ${response.status}），请重新登录该账号`
          : `服务端返回了非 JSON 响应（HTTP ${response.status}）`,
      }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, status: response.status, message: '响应无法解析' }
    }
    const record = parsed as Record<string, unknown>
    return {
      ok: true,
      status: response.status,
      envelope: {
        code: typeof record.code === 'number' && Number.isFinite(record.code) ? record.code : -1,
        msg: typeof record.msg === 'string' ? record.msg : undefined,
        data: record.data,
      },
    }
  } catch (error) {
    return {
      ok: false,
      status: -1,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 从信封 data 安全读对象。 */
function dataOf(envelope: WorkbuddyEnvelope): Record<string, unknown> {
  return typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : {}
}

/** 读有限数字；非法返回 undefined（不编造 0）。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 「今天已签」判据：中文 msg 或 `data.today_checked_in === true`。
 *
 * ⚠️ 幂等口径放这里而不是调用方，保证 status 预检与 claim 两条路径的
 * 判据同源、不会漂移。
 */
export function isWorkbuddyAlreadyChecked(envelope: WorkbuddyEnvelope): boolean {
  const msg = typeof envelope.msg === 'string' ? envelope.msg : ''
  if (/已签|已领取|already/i.test(msg)) return true
  return dataOf(envelope).today_checked_in === true
}

/**
 * 查询签到活动状态（映射成共用 {@link CheckinStatus}）。
 *
 * 失败返回 `null`（不抛错），与「活动未开启」严格区分 ——
 * 失败时 UI 应显示原因而不是 0。
 *
 * ⚠️ `active` 取 `data.active === true`：不要按「拿到响应」判 true，
 * WB 的活动有开关，关掉时 `active:false`，此时不应尝试领取。
 * ⚠️ `isStreakDay` 语义未知（响应无对应字段），恒 false 不猜测。
 * ⚠️ 入参是 `unknown`：共享收集器（`collectCreditsStatus`）只做一次
 * `JSON.parse`，历史**双编码**凭据会解出字符串 —— 必须经
 * {@link normalizeWorkbuddyCredential} 归一化，否则 `credential.accessToken`
 * 是 `undefined`、请求带着 `Bearer undefined` 静默失败（真实缺陷，见该函数）。
 */
export async function fetchWorkbuddyCheckinStatus(
  credentialInput: unknown,
  fetcher: typeof fetch = fetch,
): Promise<import('./credits.js').CheckinStatus | null> {
  const credential = normalizeWorkbuddyCredential(credentialInput)
  if (credential === undefined) return null
  const result = await requestEnvelope(credential, WORKBUDDY_CHECKIN_STATUS_PATH, fetcher)
  if (!result.ok) return null
  if (result.status !== 200 || result.envelope.code !== 0) return null
  const data = dataOf(result.envelope)
  const readNumber = (key: string): number => finiteNumber(data[key]) ?? 0
  return {
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: readNumber('streak_days'),
    dailyCredit: readNumber('daily_credit'),
    todayCredit: data.today_checked_in === true ? readNumber('daily_credit') : 0,
    isStreakDay: false,
    // ⚠️ 活动制积分：如实放进 totalCredits（该字段语义就是「活动累计」），
    // 但**不得**映射成 CreditBalance.total（见文件头）。
    totalCredits: readNumber('total_credits'),
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
  }
}

/**
 * 执行每日签到。完整分类见文件头的错误分类表。
 *
 * ⚠️ 本函数**不抛错**（失败也返回 `failed`），保证批量领取不因单账号中断。
 * ⚠️ 入参归一化理由同 {@link fetchWorkbuddyCheckinStatus}：双编码凭据必须
 * 先还原成对象，否则会带着空 accessToken 去请求。
 */
export async function claimWorkbuddyDailyCheckin(
  credentialInput: unknown,
  fetcher: typeof fetch = fetch,
): Promise<import('./credits.js').ClaimOutcome> {
  const credential = normalizeWorkbuddyCredential(credentialInput)
  if (credential === undefined) {
    return { kind: 'failed', code: -1, message: 'WorkBuddy 凭据缺少 accessToken/uid，请重新导入该账号' }
  }
  const result = await requestEnvelope(credential, WORKBUDDY_DAILY_CHECKIN_PATH, fetcher)
  if (!result.ok) {
    return { kind: 'failed', code: result.status === -1 ? -1 : result.status, message: result.message }
  }
  const envelope = result.envelope
  // 幂等先行：已签类的业务响应按 already 处理，不报错。
  if (isWorkbuddyAlreadyChecked(envelope)) {
    return { kind: 'already-claimed', message: '今日已签到' }
  }
  if (result.status === 401) {
    return { kind: 'failed', code: -1, message: '凭据已失效（HTTP 401），请重新登录该账号' }
  }
  if (result.status === 403 && envelope.code === 11140) {
    return { kind: 'failed', code: 11140, message: '签到冷却中（11140），请稍后再试' }
  }
  if (result.status === 429 && envelope.code === 6004) {
    return { kind: 'failed', code: 6004, message: '请求过于频繁（6004），请稍后再试' }
  }
  if (result.status !== 200 || envelope.code !== 0) {
    const message = envelope.msg?.length ? envelope.msg : `签到失败（HTTP ${result.status}，code=${envelope.code}）`
    return { kind: 'failed', code: envelope.code, message }
  }
  const data = dataOf(envelope)
  const credit = finiteNumber(data.daily_credit) ?? finiteNumber(data.credit) ?? 0
  return {
    kind: 'claimed',
    credit,
    streakDays: finiteNumber(data.streak_days) ?? 0,
    isStreakDay: false,
  }
}

// ───────────────────────── 凭据归一化与真实续期 ─────────────────────────

/**
 * 解出 JWT 的 payload（**不验签**，只读 `sub`/`exp` 这类自描述字段）。
 *
 * 与 `credential-expiry.ts` 的 `jwtExpiresAtMs` 同源做法：仅 base64url 解码
 * 第二段，失败一律 `undefined`，绝不因凭据格式异常抛错。
 */
function workbuddyJwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** 去掉协议与路径，只留 host（`X-Domain` 与 base 都只要 host）。 */
function workbuddyDomainOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return WORKBUDDY_DEFAULT_DOMAIN
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '')
  try {
    return new URL(trimmed).host
  } catch {
    return WORKBUDDY_DEFAULT_DOMAIN
  }
}

/**
 * 把**任何历史形状**的 WorkBuddy 凭据还原成规范对象；无法还原时返回 `undefined`。
 *
 * ## 为什么需要它（真实缺陷：唤醒全失败）
 *
 * `scripts/import-wb-pool.mjs` 早期的 `serializeCredentialYaml` 会把
 * 「已经是 JSON 字符串」的值**再** `JSON.stringify` 一次（判据是
 * `value.startsWith('{')` 就当成对象再序列化），于是落盘成：
 *
 * ```yaml
 * WORKBUDDY_ACCOUNT_XXXX: '"{""uid"":""...""}"'   # 字符串里套了一段 JSON 文本
 * ```
 *
 * 读回时 `JSON.parse` **只解一层**，得到的是 `string` 而不是对象，
 * 于是 `credential.accessToken` 为 `undefined` →
 * `account.refresh` 直接抛「WorkBuddy 凭据缺少 accessToken/uid」，
 * 签到/签到状态同样带着空 token 静默失败（用户报障「唤醒失败」）。
 *
 * 归一化本身即修复：**多解一层**即可自愈存量凭据，无需用户重新导入。
 * 同时兼容三种输入：规范对象 / 单层 JSON 文本 / 双层 JSON 文本。
 *
 * ⚠️ `uid` 缺失时用 accessToken 的 JWT `sub` 兜底（WB 的 `sub` 就是账号
 * uid；桌面端 `account.uid` 与 `sub` 实测同值），仍取不到才返回 `undefined`。
 */
export function normalizeWorkbuddyCredential(input: unknown): WorkbuddyCredential | undefined {
  let candidate: unknown = input
  // 最多解两层：单层 = 正常存储；双层 = import 脚本历史缺陷。
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof candidate !== 'string') break
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return undefined
    }
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined

  const record = candidate as Record<string, unknown>
  const accessToken = typeof record.accessToken === 'string' ? record.accessToken.trim() : ''
  if (accessToken.length === 0) return undefined

  const payload = workbuddyJwtPayload(accessToken)
  const uidFromToken = typeof payload?.sub === 'string' ? payload.sub.trim() : ''
  const uid = typeof record.uid === 'string' && record.uid.trim().length > 0
    ? record.uid.trim()
    : uidFromToken
  if (uid.length === 0) return undefined

  const refreshToken = typeof record.refreshToken === 'string' && record.refreshToken.trim().length > 0
    ? record.refreshToken.trim()
    : undefined
  const nickname = typeof record.nickname === 'string' ? record.nickname : undefined

  return {
    uid,
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    domain: workbuddyDomainOf(record.domain),
    ...nickname === undefined ? {} : { nickname },
  }
}

/** access_token 的过期时刻（毫秒）；读不到返回 `undefined`（不猜）。 */
export function workbuddyCredentialExpiresAtMs(credential: WorkbuddyCredential): number | undefined {
  return jwtExpiresAtMs(credential.accessToken)
}

/**
 * 存储里的凭据是否已是「规范对象形态」（单层 JSON 对象且带 `uid`）。
 *
 * 用于唤醒时判断「是否需要归一化回写」：`false` 即历史双编码/缺 uid，
 * 唤醒成功后写回一份规范值，**让存量账号自愈**。
 */
export function isCanonicalWorkbuddyCredentialJson(value: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const uid = (parsed as Record<string, unknown>).uid
  return typeof uid === 'string' && uid.trim().length > 0
}

/** 凭据是否具备续期能力（有 refresh_token 才算）。 */
export function isWorkbuddyRefreshable(credential: WorkbuddyCredential): boolean {
  return typeof credential.refreshToken === 'string' && credential.refreshToken.length > 0
}

/** 账号池「有效期 / 可续期」回写所需的提取器（与其余 provider 共用 `syncAccountExpiry`）。 */
export const WORKBUDDY_EXPIRY_ACCESSORS: ExpiryAccessors<WorkbuddyCredential> = {
  expiresAtOf: workbuddyCredentialExpiresAtMs,
  refreshableOf: isWorkbuddyRefreshable,
  // ⚠️ `identityOf` 的语义是**凭据内容**（access token），不是 ref 名 ——
  // 传 ref 名会恒匹配失败且静默无报错（`expiry-sync.ts` 已记录该坑）。
  identityOf: (credential) => credential.accessToken,
}

/**
 * 真续期：`POST /v2/plugin/auth/token/refresh`（见 {@link WORKBUDDY_TOKEN_REFRESH_PATH}）。
 *
 * 成功返回**合并后**的凭据：响应里的新 `accessToken` / `refreshToken` /
 * `domain` 覆盖旧值，其余字段（`uid` / `nickname`）保留。
 *
 * ⚠️ **两个令牌都会被轮换**（实测），故调用方**必须**把返回值立刻落盘：
 * 拿着旧 refresh_token 再续期会被拒，账号只能重新导入。
 * ⚠️ 401/403 归类为 {@link WorkbuddyRefreshTokenExpiredError}（只能重新导入）；
 * 其余失败（网络、5xx、非 JSON、信封 code!==0）如实抛错，由调用方决定是否
 * 退化为「只探活」。
 */
export async function refreshWorkbuddyCredential(
  credential: WorkbuddyCredential,
  fetcher: typeof fetch = fetch,
): Promise<WorkbuddyCredential> {
  const refreshToken = credential.refreshToken
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new WorkbuddyRefreshTokenExpiredError('WorkBuddy 凭据缺少 refreshToken，无法续期，请重新导入该账号')
  }
  const base = `https://${credential.domain ?? WORKBUDDY_DEFAULT_DOMAIN}`
  let response: Response
  try {
    response = await fetcher(`${base}${WORKBUDDY_TOKEN_REFRESH_PATH}`, {
      method: 'POST',
      headers: workbuddyRefreshHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(WORKBUDDY_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `WorkBuddy 续期请求失败（网络异常）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const text = await response.text()
  if (response.status === 401 || response.status === 403) {
    throw new WorkbuddyRefreshTokenExpiredError(
      `WorkBuddy refresh_token 已失效（HTTP ${response.status}），请重新导入该账号`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`WorkBuddy 续期响应非 JSON（HTTP ${response.status}）`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`WorkBuddy 续期响应无法解析（HTTP ${response.status}）`)
  }
  const envelope = parsed as Record<string, unknown>
  if (envelope.code !== 0) {
    const message = typeof envelope.msg === 'string' && envelope.msg.length > 0
      ? envelope.msg
      : `HTTP ${response.status}，code=${String(envelope.code)}`
    throw new Error(`WorkBuddy 续期被拒绝：${message}`)
  }
  const data = typeof envelope.data === 'object' && envelope.data !== null
    ? envelope.data as Record<string, unknown>
    : {}
  const nextAccessToken = typeof data.accessToken === 'string' ? data.accessToken.trim() : ''
  if (nextAccessToken.length === 0) {
    // ⚠️ 缺访问令牌时**绝不**返回不完整凭据：那会把好凭据覆盖成空值。
    throw new Error('WorkBuddy 续期响应缺少 accessToken，凭据未更新')
  }
  const nextRefreshToken = typeof data.refreshToken === 'string' && data.refreshToken.trim().length > 0
    ? data.refreshToken.trim()
    : refreshToken
  return {
    ...credential,
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    domain: workbuddyDomainOf(typeof data.domain === 'string' ? data.domain : credential.domain),
  }
}
