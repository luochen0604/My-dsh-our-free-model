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

/** provider 标识（注册到账号池 / 客户端渠道清单的 id）。 */
export const WORKBUDDY_ID = 'workbuddy'

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
  /** 刷新令牌（本轮未实现续期端点，仅透传保存）。 */
  refreshToken?: string
  /** 站点域名（不带协议；缺省 {@link WORKBUDDY_DEFAULT_DOMAIN}）。 */
  domain?: string
  /** 展示名（可选）。 */
  nickname?: string
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
 */
export async function fetchWorkbuddyCheckinStatus(
  credential: WorkbuddyCredential,
  fetcher: typeof fetch = fetch,
): Promise<import('./credits.js').CheckinStatus | null> {
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
 */
export async function claimWorkbuddyDailyCheckin(
  credential: WorkbuddyCredential,
  fetcher: typeof fetch = fetch,
): Promise<import('./credits.js').ClaimOutcome> {
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
