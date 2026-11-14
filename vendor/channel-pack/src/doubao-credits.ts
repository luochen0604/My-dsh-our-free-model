/**
 * 豆包工作（DoubaoWork）积分：余额查询 + 签到状态 + 领取。
 *
 * ## 端点（全部为静态观察，见 `docs/research/doubaowork/README.md` §5.1）
 *
 * | 用途 | 端点 | 证据等级 |
 * |---|---|---|
 * | 签到状态 | `POST /alice/ug/campaign/landing/get` | **推断**（与 checkin 同族） |
 * | 签到领取 | `POST /alice/ug/campaign/landing/checkin` | **观察**（`DailyCheckIn` 调用点） |
 * | 任务领取 | `POST /alice/ug/campaign/item/reward/claim/` | **观察**（`ClaimCampaignReward`） |
 * | 积分提示 | `POST /commerce/benefit_supply/credit/get_credit_tip` | **观察** |
 * | 积分用量 | `POST /commerce/benefit_supply/credit/get_credit_usage_history` | **观察** |
 *
 * ## ⚠️ 三条必须随代码一起读的纪律
 *
 * 1. **只读优先**：面板打开这类高频路径**绝不**触碰写端点（`checkin` / `claim`）。
 * 2. **不谎报**：`granted !== true` 时**绝不**返回 `kind:'claimed'`。必须回查
 *    「今天有没有领取记录」才能区分 `already-claimed` 与 `inactive`。
 *    这正是 `raccoon-credits.ts` 模块头记录的真实缺陷（`granted:false` 却谎报今天已领）。
 * 3. **不臆造数值**：余额取不到就返回 `undefined`，不填 0。
 *
 * ## ⚠️ 本模块的端点全部是「形态正确、字段名待实测」
 *
 * 豆包的积分接口响应体**没有**被取证到真实样本（本机 cookie 被 Chromium 独占锁，
 * 无法用真实账号跑一次）。因此所有字段读取都走「候选键 + 安全降级」：
 * 读不到就是 `0` / 空数组 / `undefined`，**绝不猜一个像样的数字**。
 * 首次实测后应回填确切键名并删除多余候选。
 */

import {
  ALICE_CAMPAIGN_LANDING_PATH,
  ALICE_CHECKIN_PATH,
  ALICE_CLAIM_PATH,
  ALICE_CREDIT_TIP_PATH,
  ALICE_CREDIT_USAGE_PATH,
  DOUBAO,
  type DoubaoProduct,
} from './doubao-product.js'
import {
  DOUBAO_REQUEST_TIMEOUT_MS,
  doubaoHeaders,
  isDoubaoAuthError,
  withCommonParams,
  type DoubaoCredential,
} from './doubao.js'
import type { CheckinStatus, ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

/** 一次 POST 的结果。 */
interface PostResult {
  ok: boolean
  status: number
  /** 解析后的 JSON（解析失败为 undefined）。 */
  payload: unknown
  /** 原始文本（截断前），用于错误诊断。 */
  raw: string
}

/** 发一次 JSON POST（带 cookie + 公共 query）。 */
async function post(
  credential: DoubaoCredential,
  path: string,
  body: unknown,
  product: DoubaoProduct,
  fetchImpl: typeof fetch,
): Promise<PostResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOUBAO_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${product.apiBase}${withCommonParams(path, product)}`, {
      method: 'POST',
      headers: doubaoHeaders(credential, product),
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
    const raw = await response.text().catch(() => '')
    let payload: unknown
    try {
      payload = raw.length === 0 ? undefined : JSON.parse(raw)
    } catch {
      payload = undefined
    }
    if (isDoubaoAuthError(response.status, raw)) {
      throw new Error(`豆包凭据已失效（HTTP ${response.status}），请重新登录`)
    }
    return { ok: response.ok, status: response.status, payload, raw }
  } finally {
    clearTimeout(timer)
  }
}

/** 取 `data`（若存在），否则返回信封本身。 */
function unwrapData(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload
  const record = payload as Record<string, unknown>
  return record['data'] !== undefined ? record['data'] : payload
}

/** 业务是否成功（`code` 缺失或为 0）。 */
function businessOk(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return true
  const code = (payload as Record<string, unknown>)['code']
  if (code === undefined) return true
  return code === 0 || code === '0'
}

/** 业务错误消息。 */
function businessMessage(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  return String(record['message'] ?? record['msg'] ?? '')
}

/** 安全读 number。 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 安全读 boolean。 */
function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return undefined
}

/** 按候选键读值。 */
function pick(source: unknown, keys: readonly string[]): unknown {
  if (source === null || typeof source !== 'object') return undefined
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** 按候选键读字符串（缺省空串）。 */
function pickString(source: unknown, keys: readonly string[]): string {
  const value = pick(source, keys)
  return typeof value === 'string' ? value : ''
}

/** 归一成 `YYYY-MM-DD`；无法识别返回空串。 */
function toDateKey(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    // >1e12 视为毫秒，否则视为秒。
    const ms = value > 1e12 ? value : value * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  }
  return ''
}

/** 今天（UTC+8）的 `YYYY-MM-DD`。豆包是国内服务，业务日按 UTC+8 切。 */
function todayKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 查询签到状态（**只读**）。
 *
 * 端点 `landing/get` 是**推断**。若实测 404 / 参数不匹配，返回 `undefined`
 * 让上层降级（而不是抛错把整次签到判死）。
 */
export async function fetchDoubaoCheckinStatus(
  credential: DoubaoCredential,
  product: DoubaoProduct = DOUBAO,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckinStatus | undefined> {
  let result: PostResult
  try {
    result = await post(credential, ALICE_CAMPAIGN_LANDING_PATH, {}, product, fetchImpl)
  } catch {
    return undefined
  }
  if (!result.ok || !businessOk(result.payload)) return undefined

  const data = unwrapData(result.payload)
  if (data === null || typeof data !== 'object') return undefined

  const rawDates = pick(data, ['checkin_dates', 'checked_dates', 'signed_dates'])
  const checkinDates: string[] = Array.isArray(rawDates)
    ? rawDates.map(toDateKey).filter((value) => value.length > 0)
    : []

  const today = todayKey()
  // 显式字段优先；没有就从日期列表推断。
  const explicitToday = asBoolean(pick(data, ['today_checked_in', 'today_signed', 'signed_today']))
  const todayCheckedIn = explicitToday ?? checkinDates.includes(today)

  return {
    active: asBoolean(pick(data, ['active', 'campaign_active', 'is_active'])) ?? false,
    todayCheckedIn,
    streakDays: asNumber(pick(data, ['streak_days', 'continuous_days'])) ?? 0,
    dailyCredit: asNumber(pick(data, ['daily_credit', 'daily_points', 'daily_amount'])) ?? 0,
    todayCredit: asNumber(pick(data, ['today_credit', 'today_points'])) ?? 0,
    isStreakDay: asBoolean(pick(data, ['is_streak_day'])) ?? false,
    totalCredits: asNumber(pick(data, ['total_credits', 'total_points'])) ?? 0,
    checkinDates,
    activityName: pickString(data, ['activity_name', 'campaign_name', 'title']),
    // 契约必填但豆包侧未必下发 —— 缺省空串，UI 会自然不显示。
    themeName: pickString(data, ['theme_name', 'theme']),
    endTime: (() => {
      const raw = pick(data, ['end_time', 'endTime', 'activity_end_time'])
      if (typeof raw === 'string') return raw
      const numeric = asNumber(raw)
      return numeric === undefined ? '' : String(numeric)
    })(),
  }
}

/**
 * 领取每日签到（**写端点**，只在用户明确点击时调用）。
 *
 * ## 返回值严格对齐 `ClaimOutcome` 的四个分支
 *
 * | 服务端事实 | 返回 |
 * |---|---|
 * | 明确 `granted:true` | `claimed` + credit |
 * | `granted:false`，但今天确有领取记录 | `already-claimed` |
 * | `granted:false`，今天无记录 | `inactive`（附可读原因，**不谎报成功**） |
 * | 网络/HTTP/业务失败 | `failed` + code |
 */
export async function claimDoubaoDailyPoints(
  credential: DoubaoCredential,
  product: DoubaoProduct = DOUBAO,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  // 观察：body 形状 `{ scene, biz_params, AgwCommonParam }`。
  // `scene` 的具体字面量未取证；空串让服务端走默认场景。
  const body = { scene: '', biz_params: '', AgwCommonParam: {} }

  let result: PostResult
  try {
    result = await post(credential, ALICE_CHECKIN_PATH, body, product, fetchImpl)
  } catch (error) {
    return {
      kind: 'failed',
      code: 0,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  if (!result.ok) {
    return { kind: 'failed', code: result.status, message: `HTTP ${result.status}: ${result.raw.slice(0, 200)}` }
  }
  if (!businessOk(result.payload)) {
    const message = businessMessage(result.payload)
    return {
      kind: 'failed',
      code: asNumber((result.payload as Record<string, unknown>)['code']) ?? 0,
      message: message.length > 0 ? message : '业务返回失败',
    }
  }

  const data = unwrapData(result.payload)
  const granted = asBoolean(pick(data, ['granted', 'success', 'claimed']))
  const credit = asNumber(pick(data, ['credit', 'points', 'amount', 'reward'])) ?? 0

  if (granted === true) {
    return {
      kind: 'claimed',
      credit,
      streakDays: asNumber(pick(data, ['streak_days', 'continuous_days'])) ?? 0,
      isStreakDay: asBoolean(pick(data, ['is_streak_day'])) ?? false,
      // 豆包积分单位是「积分」，与契约缺省一致，故不显式传 unit。
    }
  }

  // ⚠️ 关键纪律：granted !== true 时不得说"今天已领成功"。
  // 必须回查今天的领取记录才能下结论。
  const status = await fetchDoubaoCheckinStatus(credential, product, fetchImpl)
  if (status !== undefined && status.todayCheckedIn) {
    return { kind: 'already-claimed', message: '今天已领取过' }
  }

  // 未发放且今天无记录 —— 归为 inactive 并给出**可读、可行动**的原因。
  //
  // ⚠️ 三个可能原因并列，因为静态分析无法区分它们：
  //   (a) 今天不是活动日；
  //   (b) 该会话不是桌面端来源（Raccoon 的 known failure mode）；
  //   (c) 活动已结束。
  // 置 actionRequired:true 让 UI 醒目展示（契约明确要求单独展示）。
  return {
    kind: 'inactive',
    message: '豆包未发放今日积分。可能原因：今日非活动日 / 该账号凭据非桌面端会话（需在豆包工作中登录一次）/ 活动已结束。',
    actionRequired: true,
  }
}

/**
 * 查询积分余额（**只读**）。
 *
 * 先试轻量的 `get_credit_tip`，再试 `get_credit_usage_history`。
 * 两次都拿不到 → `undefined`（不填 0）。
 */
export async function fetchDoubaoCreditBalance(
  credential: DoubaoCredential,
  product: DoubaoProduct = DOUBAO,
  fetchImpl: typeof fetch = fetch,
): Promise<CreditBalance | undefined> {
  for (const path of [ALICE_CREDIT_TIP_PATH, ALICE_CREDIT_USAGE_PATH]) {
    let result: PostResult
    try {
      result = await post(credential, path, {}, product, fetchImpl)
    } catch {
      continue
    }
    if (!result.ok || !businessOk(result.payload)) continue

    const data = unwrapData(result.payload)
    if (data === null || typeof data !== 'object') continue

    // 情况 1：直接给总余额。
    const directTotal = asNumber(pick(data, [
      'total', 'balance', 'credit', 'remaining', 'available', 'total_credit',
    ]))
    if (directTotal !== undefined) {
      return {
        total: directTotal,
        packages: [
          {
            name: '豆包积分',
            unit: 'credit',
            remaining: directTotal,
            total: directTotal,
            used: 0,
            active: true,
            cycleStartTime: '',
            cycleEndTime: '',
            expiredTime: '',
          },
        ],
        expiredTotal: 0,
      }
    }

    // 情况 2：给明细包列表。
    const rawPackages = pick(data, ['packages', 'credits', 'items', 'list', 'accounts'])
    if (Array.isArray(rawPackages)) {
      const packages: CreditPackage[] = []
      let total = 0
      let expiredTotal = 0
      for (const raw of rawPackages) {
        const remaining = asNumber(pick(raw, ['remaining', 'amount', 'credit', 'left', 'capacity_remain']))
        if (remaining === undefined) continue
        const active = asBoolean(pick(raw, ['active', 'valid', 'enabled', 'status_active'])) ?? true
        const packageTotal = asNumber(pick(raw, ['total', 'capacity', 'total_amount'])) ?? remaining
        const used = asNumber(pick(raw, ['used', 'consumed'])) ?? Math.max(0, packageTotal - remaining)
        packages.push({
          name: pickString(raw, ['name', 'title', 'package_name']) || '豆包积分',
          unit: pickString(raw, ['unit', 'capacity_unit']) || 'credit',
          remaining,
          total: packageTotal,
          used,
          active,
          cycleStartTime: pickString(raw, ['cycle_start_time', 'start_time']),
          cycleEndTime: pickString(raw, ['cycle_end_time', 'end_time']),
          expiredTime: pickString(raw, ['expired_time', 'expire_time']),
        })
        if (active) total += remaining
        else expiredTotal += remaining
      }
      if (packages.length > 0) {
        return { total, packages, expiredTotal }
      }
    }
  }
  return undefined
}

/**
 * 探活：确认 cookie 仍有效（**只读**）。
 *
 * 返回语义（与其它 provider 的 probe 一致）：
 * - `true`  → 确认有效
 * - `false` → 确认失效（401/403）
 * - `undefined` → 无法判定（网络异常）。**不把网络问题误报成凭据失效**。
 */
export async function probeDoubaoCredential(
  credential: DoubaoCredential,
  product: DoubaoProduct = DOUBAO,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | undefined> {
  try {
    const result = await post(credential, ALICE_CREDIT_TIP_PATH, {}, product, fetchImpl)
    if (result.status === 401 || result.status === 403) return false
    if (result.ok) return true
    return undefined
  } catch {
    return undefined
  }
}

/** 领取任务奖励（观察端点，暂未接入 UI；保留给后续扩展）。 */
export async function claimDoubaoCampaignReward(
  credential: DoubaoCredential,
  input: { taskId: string; campaignGroupCode: string; campaignItemCode: string },
  product: DoubaoProduct = DOUBAO,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  // 观察：body 键名严格是 snake_case + AgwCommonParam。
  const body = {
    task_id: input.taskId,
    campaign_group_code: input.campaignGroupCode,
    campaign_item_code: input.campaignItemCode,
    AgwCommonParam: {},
  }
  try {
    const result = await post(credential, ALICE_CLAIM_PATH, body, product, fetchImpl)
    if (!result.ok) return { ok: false, message: `HTTP ${result.status}` }
    if (!businessOk(result.payload)) {
      const message = businessMessage(result.payload)
      return { ok: false, message: message.length > 0 ? message : '业务返回失败' }
    }
    return { ok: true, message: '' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
