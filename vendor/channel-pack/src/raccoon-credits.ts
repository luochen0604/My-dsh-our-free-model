/**
 * Raccoon Work 积分（余额 + 每日积分领取）。
 *
 * ## ⚠️ 三个来源的语义（关键）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/login/points/grant` 首次 | ✅ `claimRaccoonLoginReward` |
 * | 每日积分发放 | 300 | **同一个端点**，服务端按「当天首次」发放 | ✅ `claimRaccoonDailyPoints` |
 *
 * ⚠️ **每日 300 的领取动作就是桌面端的 `login/points/grant`**（2026-11-14 实测，
 * 推翻了本文件早期「每日积分无端点、只能等服务端自动发」的结论）：
 * 官方桌面端**每次启动**都会 POST 该端点；服务端对「当天首次」返回
 * `granted:true` 并新增一条 `daily_grant` 账单（`grant_at` 归到当天 00:00），
 * 当天再次调用则 `granted:false`。本机实测证据：
 * - 11-12 22:26:22、11-13 23:34:39、11-14 00:04 各有一次 `daily_grant`（+300），
 *   前两次与桌面端启动时刻对齐，第三次是本次抓包启动桌面端时到账；
 * - 同一账号在同一分钟里手动 POST 该端点返回 `{"granted":false,"popup":null}`；
 * - 账单与余额 `daily_points` 在领取后 +300。
 *
 * ⚠️ **登录奖励仍是幂等一次性的**：已领过时同一个端点回 `granted:false`。
 * 故两个函数打同一处端点，语义差异只在「这次 granted 代表哪一种」——
 * `onboarding` 侧按一次性奖励解读，`dailyCheckin` 侧按每日积分解读。
 *
 * ⚠️ **不是每个账号都能领每日积分**：实测只有「在官方桌面端登录过」的账号
 * （账号存在桌面端会话）会拿到 `granted:true`；纯网页/扫码登录的账号该端点
 * 只发一次性登录奖励。此时本模块返回 `already-claimed` 并给出可读原因，
 * 而不是谎报领取成功。
 *
 * ⚠️ **资格判据在 token 里（会话来源），不在请求头里**（2026-11-14 实测，逐条对齐）：
 *
 * | 观测 | 结论 |
 * |---|---|
 * | 把官方桌面端头集补齐（`X-Client-Name: raccoon-work`、`X-Client-Page: local-agent`、`X-Client-Version`、含中文的桌面端 UA、`Origin: raccoon-desktop://shell`、`Sec-Fetch-*`）再用**网页扫码会话**的 token 调用 | 仍全部 `granted:false`、余额不动 ⇒ 头不是判据 |
 * | 桌面端每次启动后 4–5 秒，**该会话**必然出现一条 `daily_grant`（本机两账号共 6 条，与 `~/.office-raccoon/logs/raccoon.log` 的 `[desktop-client] startup` 时刻一一对齐，含跨零点的 00:04:44→00:04:49） | 每日一份，按桌面会话发放 |
 * | 网页会话做过桌面登录的那次（11-12 21:14:18 / 22:26:22，其中 22:26:22 与桌面 token 的 `iat` 22:26:21 相差 1 秒） | 发放在**桌面会话**身上 |
 * | 同一账号的**网页** token 此后每天调用（本机 7991226：它的桌面会话 11-12/11-13/11-14 连日拿到 `daily_grant`，而它的网页 token 同期调用**恒** `granted:false`） | **资格挂在会话上，不在账号上** —— 与「该账号历史上有没有用过客户端」无关，也与「今天有没有开过客户端」无关 |
 *
 * ⇒ 要让「不开客户端」也能领，唯一办法是把该账号的凭据换成一次**桌面端会话**
 * （`login_with_authorization_code`）—— 见 `raccoon-desktop-login.ts`。
 *
 * ⚠️ 另一处易混：一次性的 `桌面端登录奖励`（3000，`biz_type=reward_grant`）**不**受
 * 此限制 —— 本插件用网页 token 加 `X-Client-Platform` 就能领到（本机两号各 3000
 * 都是 OFM 领的）。只有 `daily_grant` 这条要求桌面会话。
 *
 * ## 只读优先
 *
 * 余额查询用 `GET /points/v1/balance`（**只读**）。在「打开面板」这类
 * 高频路径上**绝不**触碰写端点（Loomy 的 `first-login` 就踩过这个坑：
 * 打开面板即意外触发签到）。
 */

import {
  RACCOON_POINTS_PREFIX,
  RACCOON_POINTS_V2_PREFIX,
  RACCOON_DESKTOP_PREFIX,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonDesktopUserAgent,
  raccoonHeaders,
  type RaccoonCredential,
} from './raccoon.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'
import { utc8DateString } from './auto-checkin.js'
import type { CheckinStatus, ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

/** 登录奖励的默认额度（服务端未在 popup 里给出时兜底）。 */
export const RACCOON_LOGIN_REWARD_POINTS = 3000

/** 每日积分的默认额度（`granted` 为真但 popup 未给数值时兜底）。 */
export const RACCOON_DAILY_GRANT_POINTS = 300

/** 登录奖励在账单里的 `event_name`（用于判定是否已领）。 */
export const RACCOON_LOGIN_REWARD_EVENT_NAME = '桌面端登录奖励'

/** 业务响应信封。 */
interface Envelope {
  ok: boolean
  code: number
  message: string
  data: Record<string, unknown> | undefined
}

/** 解析信封；`code === 0` 为成功。 */
function parseEnvelope(payload: unknown, status: number): Envelope {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const code = typeof record.code === 'number' ? record.code : (status >= 400 ? status : 0)
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : (typeof record.details === 'string' ? record.details : '')
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  return { ok: code === 0, code, message, data }
}

/** 读成有限数字；非法返回 undefined（**不编造 0**）。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 发一次业务请求并拆信封。
 *
 * ⚠️ 不抛错 —— 调用方按 `ok` 分支处理。积分查询/领取属「尽力而为」，
 * 批量操作时单个账号失败不应中断其余账号。
 *
 * `init.headers` 在标准头之后合并（用于给 `login/points/grant` 补桌面端标识）。
 */
async function requestJson(
  url: string,
  credential: RaccoonCredential,
  product: RaccoonProduct,
  init: { method: string; body?: string; headers?: Record<string, string> },
  fetcher: typeof fetch,
): Promise<Envelope> {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: {
        ...raccoonHeaders(credential, {
          platform: product.clientPlatform,
          version: product.clientVersion,
        }),
        ...init.headers,
      },
      ...init.body === undefined ? {} : { body: init.body },
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
    const parsed: unknown = await response.json()
    return parseEnvelope(parsed, response.status)
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
      data: undefined,
    }
  }
}

/**
 * 「桌面端登录积分」端点的请求头：在标准业务头上补 `X-Client-Name` /
 * `X-Client-Page` 与官方桌面端 UA。
 *
 * ⚠️ UA 是 latin1 字节串（见 `raccoonDesktopUserAgent`），某些 fetch 实现
 * （含 Node 的 undici 在收到**非 latin1** 字符时）会直接拒绝带该头的请求；
 * 调用方因此保留「去掉 UA 重试一次」的退化路径。
 */
function desktopGrantHeaders(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  withUserAgent: boolean,
): Record<string, string> {
  return raccoonHeaders(credential, {
    platform: product.clientPlatform,
    version: product.clientVersion,
    desktopClient: true,
    ...withUserAgent ? { userAgent: raccoonDesktopUserAgent(product.clientVersion) } : {},
  })
}

/** UA 被 fetch 实现拒绝时的错误签名（undici 的 ByteString 校验）。 */
function isHeaderRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ByteString|invalid header|header.*invalid|Invalid character/i.test(message)
}

/** 构造一个资源包条目。 */
function makePackage(name: string, remaining: number): CreditPackage {
  return {
    name,
    unit: '积分',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 查询「今天是否已领到每日积分」（供 `credits.status` / 一键签到的状态预检）。
 *
 * ## 判据只能看账单，不能看余额
 *
 * 每日积分进的是**同一个积分池**（`available_points` 是奖励/每日/充值的合计），
 * 余额无法回答「今天这一笔到没到」；只有账单能：`GET /points/v2/bills?type=income`
 * 只返回发放类条目，其中 `biz_type === 'daily_grant'` 且 `grant_at` 的日期
 * （服务端已带 `+08:00`，取前 10 位即是 UTC+8 的日界）等于今天 ⇒ 今天已领。
 *
 * ⚠️ 用 `type=income` 而不是 `all`：`all` 按时间倒序混着消费流水，重度使用
 * 的账号当天可能翻十几页都翻不到那条发放记录。
 *
 * ⚠️ 查询失败返回 `null`（= 未知），调用方据此**仍然尝试领取** ——
 * 无法确认不等于不能领。
 */
export async function fetchRaccoonDailyCheckinStatus(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<CheckinStatus | null> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_V2_PREFIX}/bills?paging.limit=20&type=income`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) return null
  const items = Array.isArray(envelope.data.items) ? envelope.data.items : []
  const today = utc8DateString(nowMs)
  let grantedToday = false
  let todayCredit = 0
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (item.biz_type !== 'daily_grant') continue
    const grantAt = typeof item.grant_at === 'string' ? item.grant_at : ''
    if (grantAt.length < 10) continue
    if (grantAt.slice(0, 10) !== today) continue
    grantedToday = true
    todayCredit = readNumber(item.points) ?? RACCOON_DAILY_GRANT_POINTS
    break
  }
  return {
    active: true,
    todayCheckedIn: grantedToday,
    streakDays: 0,
    dailyCredit: RACCOON_DAILY_GRANT_POINTS,
    todayCredit: todayCredit > 0 ? todayCredit : RACCOON_DAILY_GRANT_POINTS,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: grantedToday ? [today] : [],
    activityName: '每日积分',
    themeName: '',
    endTime: '',
  }
}

/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状）。
 *
 * ⚠️ 各池**分开作 package**，让用户看出「注册礼包 / 每日 / 充值」是独立来源
 * —— 它们的有效期与回补规则都不同（每日积分每日刷新、充值积分长期有效）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export async function fetchRaccoonCreditBalance(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/balance`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) return null

  const available = readNumber(envelope.data.available_points)
  // `available_points` 是核心字段：没有它就说明响应形状不对，不编造数字。
  if (available === undefined) return null

  const packages: CreditPackage[] = []
  const reward = readNumber(envelope.data.reward_points)
  const daily = readNumber(envelope.data.daily_points)
  const topup = readNumber(envelope.data.topup_points)
  const monthly = readNumber(envelope.data.monthly_points)
  if (reward !== undefined) packages.push(makePackage('奖励积分', reward))
  if (daily !== undefined) packages.push(makePackage('每日积分', daily))
  if (monthly !== undefined && monthly > 0) packages.push(makePackage('会员积分', monthly))
  if (topup !== undefined) packages.push(makePackage('充值积分', topup))

  return {
    total: available,
    // 极端情形（服务端只给 total 不给分项）也要有至少一个包，否则 UI 空列表
    packages: packages.length > 0 ? packages : [makePackage('可用积分', available)],
    expiredTotal: 0,
  }
}

/**
 * POST 一次「桌面端登录积分」端点并拆信封（登录奖励与每日积分共用同一个端点）。
 *
 * 先带官方桌面端 UA 请求；若 fetch 实现以 header 校验为由拒绝（undici 对
 * 非 latin1 的 ByteString 校验，见 `raccoonDesktopUserAgent`），退化为
 * **不带 UA** 的同一请求重试一次 —— UA 只是「像官方客户端」的附加信号，
 * 不值得为它放弃领取（实测服务端的日常发放判定与 UA 无关）。
 */
async function postDesktopLoginGrant(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch,
): Promise<Envelope> {
  const url = `${product.apiBase}${RACCOON_DESKTOP_PREFIX}/login/points/grant`
  const attempt = (withUserAgent: boolean) => requestJson(url, credential, product, {
    method: 'POST',
    headers: desktopGrantHeaders(product, credential, withUserAgent),
  }, fetcher)
  const envelope = await attempt(true)
  if (envelope.ok || !isHeaderRejection(envelope.message)) return envelope
  return attempt(false)
}

/** `granted` 响应里 popup 的积分值（缺失时不编造数字）。 */
function grantedPopupPoints(data: Record<string, unknown> | undefined): number | undefined {
  const popup = typeof data?.popup === 'object' && data.popup !== null
    ? data.popup as Record<string, unknown>
    : undefined
  return readNumber(popup?.points)
}

/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ 与 {@link claimRaccoonDailyPoints} **打同一个端点**：该端点对「登录奖励
 * 未领」优先发 3000，否则尝试发每日 300，两者都已领则 `granted:false`。
 * 这里按「一次性奖励」解读，登记为 `onboardingTasks` 能力。
 *
 * ⚠️ 需要 `X-Client-Platform` 头（值见 `product.clientPlatform`）——
 * 它标识「来自桌面端」，缺了会被拒。见 `raccoonHeaders`。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export async function claimRaccoonLoginReward(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const envelope = await postDesktopLoginGrant(product, credential, fetcher)

  if (!envelope.ok) {
    return {
      kind: 'failed',
      code: envelope.code,
      message: envelope.message.length > 0 ? envelope.message : '领取登录奖励失败',
    }
  }

  // ⚠️ 幂等判据是 `granted`（重复领取同样返回 HTTP 200 + `granted:false`），
  // 故映射成 `already-claimed` 而**不是** `claimed` ——
  // 后者会让用户以为每天都真的加了额度。
  if (envelope.data?.granted !== true) {
    return {
      kind: 'already-claimed',
      message: '该账号已领取过桌面端登录奖励（每号一次）',
    }
  }

  const points = grantedPopupPoints(envelope.data) ?? RACCOON_LOGIN_REWARD_POINTS
  return { kind: 'claimed', credit: points, streakDays: 0, isStreakDay: false }
}

/**
 * 领取「每日积分」（每次调用都幂等：当天首次 `granted:true`，之后 `false`）。
 *
 * ## 这就是官方桌面端的签到动作
 *
 * 桌面端**每次启动**都会 POST 这个端点（渲染层的 `useEffect` 在登录态就绪后
 * 触发一次，见 `raccoon.ts` 模块头第 3 条），服务端对「当天首次」返回
 * `granted:true` + 一条 `daily_grant` 账单（+300）。本插件把同一动作做成
 * `dailyCheckin` 能力：自动签到每天替用户「点一次桌面端」。
 *
 * ## 判据与文案
 *
 * - `granted:true` ⇒ `claimed`，额度取 popup（缺失按 300）；
 * - `granted:false` ⇒ `already-claimed`。**两种成因**（端点本身分不出）：
 *   ① 今天确实已发过；② 该账号的会话**不是桌面端来源**（本插件以前只有
 *   微信扫码 = 网页会话，实测网页会话调用该端点**永远** false）。
 *   文案必须把第 ② 种的说辞与解法讲出来（账号行的「桌面端授权」按钮），
 *   否则用户只能看到一句误导性的「今天已领」。
 * - 网络/信封失败 ⇒ `failed`（自动签到据此不记今日，下一轮会重试）。
 *
 * 本函数**不抛错**，保证批量领取不会因单个账号中断。
 */
export async function claimRaccoonDailyPoints(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const envelope = await postDesktopLoginGrant(product, credential, fetcher)

  if (!envelope.ok) {
    return {
      kind: 'failed',
      code: envelope.code,
      message: envelope.message.length > 0 ? `领取每日积分失败：${envelope.message}` : '领取每日积分失败',
    }
  }

  if (envelope.data?.granted !== true) {
    // 两种成因端点分不出（都回 `granted:false`），用「本插件自己标的会话来源」
    // 消歧（见 `RaccoonCredential.sessionSource`）：
    //
    // ⚠️ **每日积分发放的对象是「桌面端授权码登录换来的那个会话」**，判据在
    // 服务端记录里，不在请求头 —— 实测把官方桌面端的头集（`X-Client-Name` /
    // `X-Client-Page` / `X-Client-Version` / 中文 UA / `Origin: raccoon-desktop://shell`）
    // 逐条补齐，用网页扫码会话的 token 调用仍然全部 `granted:false`；而同一个
    // 账号在桌面端启动的那一秒（21:14:18 / 22:26:22 / 23:34:39 / 00:04:49）必然
    // 出现一条 `daily_grant`。⇒ 差异只在 token 本身（会话来源）。
    // 故网页会话是**永远**领不到每日积分的，此时那句「今天已领」会把用户
    // 引到完全错误的方向。
    if (credential.sessionSource === 'desktop') {
      return { kind: 'already-claimed', message: '今天已领过每日积分' }
    }
    return {
      kind: 'already-claimed',
      message: credential.sessionSource === 'web'
        ? '本次未发放：该账号的凭据是网页扫码会话，商汤的每日积分只发给桌面端会话 —— 请在账号行点一次「桌面端授权」切换会话来源'
        : '本次未发放：该凭据不是桌面端授权码换来的会话（多半是微信扫码），每日积分只发给桌面端会话 —— 请在账号行点一次「桌面端授权」',
    }
  }

  const points = grantedPopupPoints(envelope.data) ?? RACCOON_DAILY_GRANT_POINTS
  return { kind: 'claimed', credit: points, unit: 'credit', streakDays: 0, isStreakDay: false }
}

/**
 * 查询「桌面端登录奖励」是否已领（供 `onboarding.status` 用）。
 *
 * 判据：`GET /points/v1/bills` 里是否已有
 * `biz_type === 'reward_grant'` 且 `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️ **不能靠 `balance` 推断** —— 余额是多个来源（注册礼包/每日/充值）的
 * 合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」
 * 也是 `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed: false` —— 宁可让用户多点一次
 * （服务端幂等，无害），也不要误报「已领」而让他真的错过。
 */
export async function fetchRaccoonOnboardingStatus(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ claimed: boolean; points: number }> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/bills?paging.limit=50&paging.offset=0`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) {
    return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS }
  }

  const items = Array.isArray(envelope.data.items) ? envelope.data.items : []
  let claimed = false
  let points = RACCOON_LOGIN_REWARD_POINTS
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (item.biz_type !== 'reward_grant') continue
    if (item.event_name !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue
    claimed = true
    const billPoints = readNumber(item.points)
    if (billPoints !== undefined && billPoints > 0) points = billPoints
    break
  }
  return { claimed, points }
}

/** 默认产品配置下的便捷包装（供 `RaccoonAuth` 调用）。 */
export const raccoonCreditsForDefaultProduct = {
  fetchBalance: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonCreditBalance(RACCOON, credential, fetcher),
  claimLoginReward: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    claimRaccoonLoginReward(RACCOON, credential, fetcher),
  fetchOnboardingStatus: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonOnboardingStatus(RACCOON, credential, fetcher),
}
