/**
 * WPS（灵犀 / 福利中心 / 任务中心）签到 —— 数据层。
 *
 * ## ⚠️⚠️ 一个 `wps_sid`，三处独立签到，合成**一个** provider
 *
 * 三处签到**同用一个 `wps_sid`**（Cookie 唯一认证方式，无设备号校验），
 * 但接口完全独立：
 *
 * | 目标 | 域名 | 协议 |
 * |------|------|------|
 * | 灵犀算力点 | `lingxi.kdocs.cn` | 明文 JSON |
 * | 福利中心打卡 | `personal-act.wps.cn`（rubik2 组件 `fragment_collect`） | 明文 JSON |
 * | 任务中心签到 | `personal-bus.wps.cn/sign_in/v1` | **RSA+AES 加密** |
 *
 * 凭据相同 ⇒ 挂在 `lingxi` 这**一个** provider 下（与网关中转池一致），
 * 同一套多账号池一次签完 —— 用户不为每个活动各维护一份凭据。
 *
 * ## ⚠️⚠️ `result:'ok'` 不等于入账（本模块最重要的一条纪律）
 *
 * 源码（`国产模型中转池/src/providers/lingxi.js` 文件头 ★★）实测：
 * **已签到时灵犀 claim 仍然返回 `result:'ok'`、HTTP 200，且 `trade_no` 不变**。
 * 若信返回值，每天都会记一条假「签到成功」流水 —— 与本仓库
 * `cce5662` / `116a343`（raccoon `granted:false` 谎报"今天已领"）是**同一类
 * 教训**。故本实现每处签到都做**二次复核**，复核不过一律记失败：
 *
 * - **灵犀**：claim 前后各读一次 `credits/balance` 的 `total_bonus`（奖励积分），
 *   **余额真的涨了**（delta > 0）才记 `claimed`；不变 ⇒ `already-claimed`。
 *   这是唯一与「积分有没有真的多」等价的判据（钉住成功量，不是存在性）。
 * - **任务中心**：POST `/sign_in` 返回 ok 后**再读一次 `user_stat`**，
 *   `has_signed === true` 才记 verified。
 * - **福利中心**：POST `component_action` 返回 ok 后**再读一次 `page_info`**，
 *   `sign_records` 里今天那条 `sign_status === 'signed'` 才记 verified。
 *
 * ## 错误语义（任务中心，逆向自组件 sign-in-panel-pc）
 *
 * - `"has sign"` → 今天已签到（幂等，`already`）
 * - `"decrypt error"` → RSA 公钥或加密方式变了（**协议变更信号**）
 * - `"invalid character ..."` → AES key/iv/padding 变了（同上）
 * - 协议变更类错误必须原样透出 message —— 排障时是唯一线索。
 *
 * ## ⚠️ 为什么「唤醒」是探活不是续期
 *
 * `wps_sid` **无 set-cookie 轮换、稳定不失效**（源码注释明确）。没有续期端点，
 * 故 `account.refresh` = 用 `auth/check` 验证 sid 仍有效 + 读一次余额刷新额度
 * 读数 —— 与 ZCode / WorkBuddy 的探活策略同型，**不是** token 续期。
 */

import { publicEncrypt, constants, createCipheriv, randomBytes } from 'node:crypto'

/** provider 标识（与网关中转池的 provider 名一致，沿用 `lingxi`）。 */
export const LINGXI_ID = 'lingxi'

/** 业务请求超时（毫秒）。 */
export const WPS_REQUEST_TIMEOUT_MS = 30_000

/** 桌面 Chrome UA。 */
export const WPS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 灵犀 API 基址。 */
export const LINGXI_API_BASE = 'https://lingxi.kdocs.cn'
/** kdocs 登录校验基址。 */
export const KDOCS_AUTH_BASE = 'https://account.kdocs.cn'
/** 福利中心基址。 */
export const WPS_FULI_BASE = 'https://personal-act.wps.cn'
/** 任务中心基址。 */
export const WPS_TASK_BASE = 'https://personal-bus.wps.cn'

/**
 * rubik2 活动组件坐标（来源：dsh-credit-models/index.js DEFAULTS.wps，
 * 2026-10 与 2026-11-14 两轮实测有效）。
 *
 * ⚠️ 活动换期时这里会失效，表现为 `page_info` 里找不到 `fragment_collect` ——
 * 错误文案会如实说明「活动可能已换期」，届时更新这组常量即可。
 */
export const WPS_FULI_DEFAULTS = {
  activity: 'HD2025031721339450',
  page: 'YM2025031721331326',
  component: 'ZJ2025061815363325',
  node: 'FN1750234948dBVL',
  filter: {
    cs_from: 'pc_1new_vipcenter',
    position: 'pc_nvc_activity_fuli',
    mk_key: '1iphwJyq6olVsnquNhrdZoRShyf44RlZ8MDtNy0W5g',
  },
} as const

/**
 * WPS 凭据（存 `ctx.credentials` 的 JSON 形状）。字段名对齐灵犀池文件
 * （`lingxi-pool/<uid>.json`），导入时逐字复制，避免一层翻译。
 */
export interface LingxiCredential {
  /** 账号 uid（任务中心加密载荷里的数字 `user_id` 来源）。 */
  uid: string
  /** 50 字符 `wps_sid`。 */
  wpsSid: string
  /** 完整 Cookie（可选；缺失时由 wpsSid 构造）。 */
  cookie?: string
  /** 展示名（可选）。 */
  nickname?: string
}

/** 本地时区 `YYYY-MM-DD`（sign_records / check_in_days 用的日期形态）。 */
export function wpsTodayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 组装 Cookie 头（sid 为主，池文件里有完整 cookie 时优先用）。 */
function cookieOf(credential: LingxiCredential): string {
  if (credential.cookie !== undefined && credential.cookie.length > 0) return credential.cookie
  return `wps_sid=${credential.wpsSid}; wpsclient=true`
}

/** 通用请求头（Cookie + UA + Accept；与参考实现逐字段一致）。 */
function baseHeaders(credential: LingxiCredential): Headers {
  const headers = new Headers()
  headers.set('User-Agent', WPS_USER_AGENT)
  headers.set('Cookie', cookieOf(credential))
  headers.set('Accept', 'application/json, text/plain, */*')
  return headers
}

/** 灵犀业务请求头（带 Origin/Referer，照 lingxi.js 的 headersOf）。 */
function lingxiHeaders(credential: LingxiCredential): Headers {
  const headers = baseHeaders(credential)
  headers.set('Origin', LINGXI_API_BASE)
  headers.set('Referer', `${LINGXI_API_BASE}/`)
  return headers
}

/** 福利中心请求头。 */
function fuliHeaders(credential: LingxiCredential): Headers {
  const headers = baseHeaders(credential)
  headers.set('Content-Type', 'application/json')
  headers.set('Origin', WPS_FULI_BASE)
  headers.set('Referer', `${WPS_FULI_BASE}/rubik2/portal/${WPS_FULI_DEFAULTS.activity}/${WPS_FULI_DEFAULTS.page}`)
  return headers
}

/** 任务中心请求头（★ Origin/Referer 带福利中心的，与参考实现一致）。 */
function taskHeaders(credential: LingxiCredential, extraToken?: string): Headers {
  const headers = baseHeaders(credential)
  headers.set('Origin', WPS_FULI_BASE)
  headers.set('Referer', `${WPS_FULI_BASE}/`)
  if (extraToken !== undefined) headers.set('token', extraToken)
  return headers
}

/** 一次请求的原始结果（含 HTTP 状态、解析后的 JSON、原文摘要）。 */
type RawResult =
  | { ok: true; status: number; body: Record<string, unknown> | null }
  | { ok: false; status: number; message: string }

/**
 * 发一次请求并解析 JSON。**不抛错**（单账号失败不中断批量）。
 *
 * ⚠️ 不用 `response.json()`：凭据失效/风控时服务端可能回 HTML，先取文本再解析。
 */
async function requestJson(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Headers; body?: string },
): Promise<RawResult> {
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(WPS_REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let parsed: unknown = null
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
      return { ok: true, status: response.status, body: null }
    }
    return { ok: true, status: response.status, body: parsed as Record<string, unknown> }
  } catch (error) {
    return {
      ok: false,
      status: -1,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 读 WPS 风格信封的 `result`（'ok' | 其它）。 */
function resultOf(body: Record<string, unknown> | null): string {
  if (body === null) return ''
  return typeof body.result === 'string' ? body.result : ''
}

/** 读 WPS 风格信封的 `msg`。 */
function msgOf(body: Record<string, unknown> | null): string {
  if (body === null) return ''
  return typeof body.msg === 'string' ? body.msg : (typeof body.ext_msg === 'string' ? body.ext_msg : '')
}

/** 读有限数字。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// ══════════════════ A. 灵犀算力点（lingxi.kdocs.cn）══════════════════

/** 灵犀余额（`total_bonus` 是奖励积分，签到入账的**观察量**）。 */
export interface LingxiBalance {
  totalBalance: number
  bonus: number
  purchased: number
}

/** 查灵犀余额；失败返回 null（不抛错）。 */
export async function fetchLingxiBalance(
  credential: LingxiCredential,
): Promise<LingxiBalance | null> {
  const result = await requestJson(
    `${LINGXI_API_BASE}/api/public/v1/credits/balance`,
    { method: 'GET', headers: lingxiHeaders(credential) },
  )
  if (!result.ok || result.body === null) return null
  if (resultOf(result.body) !== 'ok') return null
  const data = typeof result.body.data === 'object' && result.body.data !== null
    ? result.body.data as Record<string, unknown>
    : {}
  const bonus = finiteNumber(data.total_bonus)
  if (bonus === undefined) return null
  return {
    totalBalance: finiteNumber(data.total_balance) ?? 0,
    bonus,
    purchased: finiteNumber(data.total_purchased) ?? 0,
  }
}

/**
 * 执行灵犀签到。**判定 signed 的唯一依据是余额真的涨了**（见文件头）。
 *
 * 灵犀没有独立 status 端点（`daily_check_in/status` 实测 404），
 * 已签时 claim 也是 `result:'ok'` 且幂等 ⇒ 状态查询直接走 claim + 余额差值。
 */
export async function claimLingxiDailyCheckin(
  credential: LingxiCredential,
): Promise<import('./credits.js').ClaimOutcome> {
  const before = await fetchLingxiBalance(credential)
  const beforeBonus = before?.bonus ?? null

  const result = await requestJson(
    `${LINGXI_API_BASE}/api/public/v1/tasks/daily_check_in/claim`,
    { method: 'POST', headers: lingxiHeaders(credential), body: '{}' },
  )
  if (!result.ok) {
    return { kind: 'failed', code: result.status, message: result.message }
  }
  if (result.status === 429) {
    return { kind: 'failed', code: 429, message: '请求过于频繁（HTTP 429），请稍后再试' }
  }
  const body = result.body
  if (result.status !== 200 || body === null) {
    return { kind: 'failed', code: result.status, message: `签到失败（HTTP ${result.status}）` }
  }
  const msg = msgOf(body)
  if (resultOf(body) !== 'ok') {
    // 兼容手册所述「已签 → result≠ok 且 msg 匹配」形态（实测已签仍是 ok，但保留）。
    if (/已签到|already|claimed|has sign/i.test(msg)) {
      return { kind: 'already-claimed', message: '今日已签到' }
    }
    return { kind: 'failed', code: -1, message: `签到失败：result=${resultOf(body)} msg=${msg}` }
  }
  const data = typeof body.data === 'object' && body.data !== null
    ? body.data as Record<string, unknown>
    : {}
  const reward = finiteNumber(data.reward_amount) ?? 0

  // ★ 决定性复核：余额差值。
  const after = await fetchLingxiBalance(credential)
  const afterBonus = after?.bonus ?? null
  if (beforeBonus !== null && afterBonus !== null) {
    const delta = Math.round((afterBonus - beforeBonus) * 100) / 100
    if (delta > 0) {
      return { kind: 'claimed', credit: delta, streakDays: 0, isStreakDay: false }
    }
    // 余额没涨 = 没有新入账 ⇒ 幂等（今天已签），**不记** claimed。
    return { kind: 'already-claimed', message: '今日已签到（余额无变化）' }
  }
  // 余额读不到的降级：看 check_in_days 里今天那格 status（比 result 可靠，
  // 但不如差值 —— 授予额取响应的 reward，且**只有 reward>0 且 claimed 才算已签**）。
  const extra = typeof data.extra === 'object' && data.extra !== null
    ? data.extra as Record<string, unknown>
    : {}
  const days = Array.isArray(extra.check_in_days) ? extra.check_in_days as unknown[] : []
  const today = wpsTodayStr()
  const row = days.find((x) => typeof x === 'object' && x !== null
    && (x as Record<string, unknown>).date === today) as Record<string, unknown> | undefined
  if (row?.status === 'claimed') {
    return { kind: 'already-claimed', message: '今日已签到' }
  }
  if (reward > 0) {
    return { kind: 'claimed', credit: reward, streakDays: finiteNumber(extra.consecutive_days) ?? 0, isStreakDay: false }
  }
  return {
    kind: 'failed', code: -1,
    message: '复核未通过：余额读取失败且响应无今日入账证据，不记签到成功',
  }
}

// ══════════════════ B. 福利中心（fragment_collect，明文）══════════════════

/** 在任意嵌套 JSON 里找 `fragment_collect` 组件（含 `sign_series_id` 才算数）。 */
export function findWpsFragmentCollect(source: unknown): Record<string, unknown> | null {
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>
    const fc = record.fragment_collect
    if (fc !== null && typeof fc === 'object' && !Array.isArray(fc)
      && 'sign_series_id' in (fc as Record<string, unknown>)) {
      return fc as Record<string, unknown>
    }
    for (const value of Object.values(record)) {
      const found = findWpsFragmentCollect(value)
      if (found !== null) return found
    }
  }
  return null
}

/** 读福利中心 page_info 并抽出 fragment_collect 组件；失败返回 null。 */
async function readFuliComponent(
  credential: LingxiCredential,
): Promise<{ ok: true; component: Record<string, unknown> } | { ok: false; message: string }> {
  const filter = encodeURIComponent(JSON.stringify(WPS_FULI_DEFAULTS.filter))
  const result = await requestJson(
    `${WPS_FULI_BASE}/activity-rubik/activity/page_info?activity_number=${WPS_FULI_DEFAULTS.activity}`
    + `&page_number=${WPS_FULI_DEFAULTS.page}&filter_params=${filter}`,
    { method: 'GET', headers: fuliHeaders(credential) },
  )
  if (!result.ok) return { ok: false, message: result.message }
  if (result.body === null || resultOf(result.body) !== 'ok') {
    return { ok: false, message: `page_info: ${msgOf(result.body) || `HTTP ${result.status}`}` }
  }
  const fc = findWpsFragmentCollect(result.body)
  if (fc === null) {
    return { ok: false, message: 'page_info 中未找到 fragment_collect 打卡组件（活动可能已换期）' }
  }
  return { ok: true, component: fc }
}

/**
 * 福利中心打卡（含**二次复核**）。
 *
 * 流程：读组件 → 今天已有记录且 `signed` ⇒ already；
 * 否则 POST `component_action` → 组件层 success → **再读一次 page_info**，
 * `sign_records` 今天那条 `=== 'signed'` 才记 claimed。
 */
export async function claimWpsFuliCheckin(
  credential: LingxiCredential,
): Promise<import('./credits.js').ClaimOutcome> {
  const state = await readFuliComponent(credential)
  if (!state.ok) {
    return { kind: 'failed', code: -1, message: state.message }
  }
  const today = wpsTodayStr()
  const records = Array.isArray(state.component.sign_records)
    ? state.component.sign_records as unknown[]
    : []
  const todayRecord = records.find((x) => typeof x === 'object' && x !== null
    && (x as Record<string, unknown>).sign_date === today) as Record<string, unknown> | undefined
  // 没有今天的记录说明签到周期切换了，盲发 sign_in 可能打进旧周期 —— 直接拒绝。
  if (todayRecord === undefined) {
    return {
      kind: 'failed', code: -1,
      message: `sign_records 中没有今天(${today})的记录，签到周期可能已切换`,
    }
  }
  if (todayRecord.sign_status === 'signed') {
    return { kind: 'already-claimed', message: '今日已打卡' }
  }
  const series = typeof state.component.sign_series_id === 'string'
    ? state.component.sign_series_id
    : ''
  const result = await requestJson(
    `${WPS_FULI_BASE}/activity-rubik/activity/component_action`,
    {
      method: 'POST',
      headers: fuliHeaders(credential),
      body: JSON.stringify({
        component_uniq_number: {
          activity_number: WPS_FULI_DEFAULTS.activity,
          page_number: WPS_FULI_DEFAULTS.page,
          component_number: WPS_FULI_DEFAULTS.component,
          component_node_id: WPS_FULI_DEFAULTS.node,
          filter_params: WPS_FULI_DEFAULTS.filter,
        },
        component_action: 'fragment_collect.sign_in',
        fragment_collect: { sign_date: today, series_id: series, is_new_sign_series: series.length === 0 },
      }),
    },
  )
  if (!result.ok) {
    return { kind: 'failed', code: result.status, message: result.message }
  }
  if (result.body === null || resultOf(result.body) !== 'ok') {
    return { kind: 'failed', code: -1, message: `sign_in: ${msgOf(result.body) || `HTTP ${result.status}`}` }
  }
  // ★ 复核第一步：组件返回里 success 才算组件层成功。
  const data = typeof result.body.data === 'object' && result.body.data !== null
    ? result.body.data as Record<string, unknown>
    : {}
  const rfc = typeof data.fragment_collect === 'object' && data.fragment_collect !== null
    ? data.fragment_collect as Record<string, unknown>
    : {}
  if (rfc.success !== true) {
    return {
      kind: 'failed', code: -1,
      message: `签到未成功: ${JSON.stringify(rfc).slice(0, 160)}`,
    }
  }
  // ★ 复核第二步：再读一次 page_info，钉住「真的记为 signed」。
  const verify = await readFuliComponent(credential)
  if (!verify.ok) {
    return { kind: 'failed', code: -1, message: `复核未通过：page_info 读取失败（${verify.message}）` }
  }
  const verifyRecords = Array.isArray(verify.component.sign_records)
    ? verify.component.sign_records as unknown[]
    : []
  const verifyRecord = verifyRecords.find((x) => typeof x === 'object' && x !== null
    && (x as Record<string, unknown>).sign_date === today) as Record<string, unknown> | undefined
  if (verifyRecord?.sign_status !== 'signed') {
    return {
      kind: 'failed', code: -1,
      message: `复核未通过：sign_records 里今天仍是 ${String(verifyRecord?.sign_status ?? '缺失')}`,
    }
  }
  const reward = typeof verifyRecord.reward_title === 'string' ? verifyRecord.reward_title : ''
  return {
    kind: 'claimed', credit: 0, streakDays: 0, isStreakDay: false,
    ...(reward.length > 0 ? { delayedMessage: `福利中心打卡：${reward}` } : {}),
  }
}

// ══════════════════ C. 任务中心（sign_in/v1，RSA+AES）══════════════════

/** AES key = 22 个随机字母数字 + 10 位秒级时间戳（共 32 字节）。 */
function makeTaskAesKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let chars = ''
  for (let i = 0; i < 22; i += 1) chars += alphabet[randomBytes(1)[0] % alphabet.length]
  return chars + String(Math.floor(Date.now() / 1000))
}

/**
 * RSA+AES 加密签到载荷。
 *
 * ⚠️ `user_id` 必须是**数字**：字符串形态实测服务端回 `result:error / "失败"`
 * （wps-checkin.js 2026-10-16 实测，同账号同 sid 只改类型即复现）。
 */
function encryptTaskPayload(pem: string, userId: string, platform = 8): { token: string; extra: string } {
  const uid = Number(userId)
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error(`user_id 非法（需要数字）：${userId.slice(0, 32)}`)
  }
  const aesKey = Buffer.from(makeTaskAesKey(), 'utf8')
  const token = publicEncrypt(
    { key: pem, padding: constants.RSA_PKCS1_PADDING },
    aesKey,
  ).toString('base64')
  const plain = Buffer.from(JSON.stringify({ user_id: uid, platform }), 'utf8')
  const cipher = createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16))
  const extra = Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
  return { token, extra }
}

/** 任务中心签到状态（`user_stat`）。 */
export interface WpsTaskStatusResult {
  checkedIn: boolean
  todayReward: string
  continuousDays: number | null
}

/** 查任务中心状态；失败返回 null。 */
export async function fetchWpsTaskStatus(
  credential: LingxiCredential,
): Promise<WpsTaskStatusResult | null> {
  const result = await requestJson(
    `${WPS_TASK_BASE}/sign_in/v1/user_stat`,
    { method: 'GET', headers: taskHeaders(credential) },
  )
  if (!result.ok || result.body === null) return null
  if (resultOf(result.body) !== 'ok') return null
  const data = typeof result.body.data === 'object' && result.body.data !== null
    ? result.body.data as Record<string, unknown>
    : {}
  const rewards = Array.isArray(data.today_reward)
    ? data.today_reward as unknown[]
    : (typeof data.today_reward === 'object' && data.today_reward !== null
      ? ((data.today_reward as Record<string, unknown>).reward_name as unknown[] | undefined) ?? []
      : [])
  const rewardNames = rewards
    .map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x !== null
      && typeof (x as Record<string, unknown>).reward_name === 'string'
      ? (x as Record<string, unknown>).reward_name as string
      : ''))
    .filter((x) => x.length > 0)
  return {
    checkedIn: data.has_signed === true,
    todayReward: rewardNames.join(' + ') || '积分+1',
    continuousDays: finiteNumber(data.month_continuous_days) ?? null,
  }
}

/**
 * 任务中心签到（含**二次复核**）。
 *
 * 流程：先查 `user_stat`（已签直接幂等返回，省一次加密调用）→
 * 取 RSA 公钥 → RSA+AES 加密载荷 → POST `/sign_in` → ok 后
 * **再读一次 `user_stat`**，`has_signed === true` 才记 claimed。
 */
export async function claimWpsTaskCheckin(
  credential: LingxiCredential,
): Promise<import('./credits.js').ClaimOutcome> {
  // 先查状态：已签直接幂等返回。
  const before = await fetchWpsTaskStatus(credential)
  if (before !== null && before.checkedIn) {
    return { kind: 'already-claimed', message: `今日已签到（${before.todayReward}）` }
  }

  const keyResult = await requestJson(
    `${WPS_TASK_BASE}/sign_in/v1/encrypt/key`,
    { method: 'GET', headers: taskHeaders(credential) },
  )
  if (!keyResult.ok || keyResult.body === null || keyResult.status !== 200) {
    const detail = keyResult.ok && keyResult.body !== null ? JSON.stringify(keyResult.body).slice(0, 160) : keyResult.message
    return { kind: 'failed', code: keyResult.status, message: `获取加密公钥失败: ${detail}` }
  }
  const pemRaw = keyResult.body.data
  if (typeof pemRaw !== 'string' || pemRaw.length === 0) {
    return { kind: 'failed', code: -1, message: '获取加密公钥失败: 响应缺少 data' }
  }
  let payload: { token: string; extra: string }
  try {
    payload = encryptTaskPayload(Buffer.from(pemRaw, 'base64').toString('utf8'), credential.uid)
  } catch (error) {
    return {
      kind: 'failed', code: -1,
      message: `构造加密载荷失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const result = await requestJson(
    `${WPS_TASK_BASE}/sign_in/v1/sign_in`,
    {
      method: 'POST',
      headers: taskHeaders(credential, payload.token),
      body: JSON.stringify({ encrypt: true, extra: payload.extra, pay_origin: '' }),
    },
  )
  if (!result.ok) {
    return { kind: 'failed', code: result.status, message: result.message }
  }
  const body = result.body
  const msg = msgOf(body)
  if (resultOf(body) === 'ok') {
    // ★ 二次复核：接口说 ok 不算数，user_stat 真的翻成 has_signed 才记 claimed。
    const verify = await fetchWpsTaskStatus(credential)
    if (verify === null || !verify.checkedIn) {
      return {
        kind: 'failed', code: -1,
        message: `复核未通过：user_stat 仍显示未签到（${verify === null ? '状态读取失败' : 'has_signed=false'}）`,
      }
    }
    const data = typeof body.data === 'object' && body.data !== null
      ? body.data as Record<string, unknown>
      : {}
    const rewards = Array.isArray(data.rewards) ? data.rewards as unknown[] : []
    const rewardText = rewards
      .map((x) => typeof x === 'object' && x !== null
        ? (typeof (x as Record<string, unknown>).reward_name === 'string'
          ? (x as Record<string, unknown>).reward_name as string
          : (typeof (x as Record<string, unknown>).name === 'string'
            ? (x as Record<string, unknown>).name as string
            : ''))
        : '')
      .filter((x) => x.length > 0)
      .join(' + ') || '积分+1'
    return {
      kind: 'claimed', credit: 0, streakDays: verify.continuousDays ?? 0, isStreakDay: false,
      ...(rewardText !== '积分+1' ? { delayedMessage: `任务中心签到：${rewardText}` } : {}),
    }
  }
  if (msg === 'has sign') {
    // 服务端说已签：以状态接口为准。
    if (before !== null && before.checkedIn) {
      return { kind: 'already-claimed', message: `今日已签到（${before.todayReward}）` }
    }
    return { kind: 'already-claimed', message: '今日已签到' }
  }
  if (msg === 'decrypt error' || msg.includes('invalid character')) {
    // 协议变更信号：RSA 公钥 / AES key/iv/padding 变了。原样透出，这是唯一排障线索。
    return { kind: 'failed', code: -1, message: `加密协议可能已变更: ${msg}` }
  }
  return { kind: 'failed', code: -1, message: msg.length > 0 ? msg : `签到失败（HTTP ${result.status}）` }
}

// ══════════════════ D. 状态查询 / 探活 ══════════════════

/**
 * 查询签到状态（映射成共用 `CheckinStatus`）。
 *
 * 灵犀没有独立 status 端点，这里读**福利中心 + 任务中心**两个只读状态端点
 * （都不产生入账），映射成一个汇总：
 * - `active` 恒 true（三处活动长期在，读不到再说）
 * - `todayCheckedIn` = 两处**都**已签（「都签完」才是这个渠道的「今日完成」）
 * - 失败返回 null（不抛错）。
 */
export async function fetchLingxiCheckinStatus(
  credential: LingxiCredential,
): Promise<import('./credits.js').CheckinStatus | null> {
  const fuliState = await readFuliComponent(credential)
  let fuliSigned = false
  if (fuliState.ok) {
    const today = wpsTodayStr()
    const records = Array.isArray(fuliState.component.sign_records)
      ? fuliState.component.sign_records as unknown[]
      : []
    const record = records.find((x) => typeof x === 'object' && x !== null
      && (x as Record<string, unknown>).sign_date === today) as Record<string, unknown> | undefined
    fuliSigned = record?.sign_status === 'signed'
  }
  const task = await fetchWpsTaskStatus(credential)
  // 两处都读不到 ⇒ 真失败（null）；只挂一处 ⇒ 用活着的那处，另一处按未签算。
  if (!fuliState.ok && task === null) return null
  return {
    active: true,
    todayCheckedIn: fuliSigned && (task?.checkedIn === true),
    streakDays: task?.continuousDays ?? 0,
    dailyCredit: 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
  }
}

/**
 * 登录探活（`auth/check`）：返回 userid / nickname / isPlus；失败返回 null。
 *
 * 供 `account.refresh`（唤醒）与账号导入用 —— sid 无效必须当场能看出来。
 */
export async function wpsAuthCheck(
  credential: LingxiCredential,
): Promise<{ userId: string; nickname: string | null; isPlus: boolean } | null> {
  const headers = baseHeaders(credential)
  headers.set('Content-Type', 'application/json')
  const result = await requestJson(
    `${KDOCS_AUTH_BASE}/p/auth/check`,
    { method: 'POST', headers, body: '{}' },
  )
  if (!result.ok || result.body === null) return null
  if (resultOf(result.body) !== 'ok') return null
  const userid = result.body.userid
  const userId = typeof userid === 'number' && Number.isFinite(userid)
    ? String(userid)
    : (typeof userid === 'string' && userid.length > 0 ? userid : '')
  if (userId.length === 0) return null
  return {
    userId,
    nickname: typeof result.body.nickname === 'string' ? result.body.nickname : null,
    isPlus: result.body.is_plus === true,
  }
}
