/**
 * LobsterAI（有道龙虾）协议常量、凭据结构与纯函数。
 *
 * ## 协议速览（来源：`lobsterai2api`，实证见 docs/lobsterai-integration-plan.md §4）
 *
 * | 用途 | 方法 | 路径 | 认证 |
 * |---|---|---|---|
 * | 换 token | POST | `/api/auth/exchange` | 无 |
 * | 续期 | POST | `/api/auth/refresh` | 无（**不带 Authorization**） |
 * | 对话 | POST | `/api/proxy/v1/chat/completions` | Bearer |
 * | 模型列表 | GET | `/api/models/available` | Bearer |
 * | 积分余额 | GET | `/api/user/profile-summary` | Bearer |
 *
 * **统一信封** `{code, msg, data}`：`code !== 0` 即失败。
 * 唯一例外是 chat 端点 —— 它返回**裸 SSE，不套信封**。
 *
 * ## 身份字段的真实语义（桌面端实证，2026-11-13）
 *
 * `firstKeyfrom` / `latestKeyfrom` / `uuid` / `version` 这组「身份载荷」的语义
 * 曾被 Go 参考实现（`lobsterai2api/auth.go:37-50`）误导，现已按桌面端
 * `dist-electron/main.js:87017-87141`（keyfrom 子系统）、`150789-150798`
 * （安装 UUID）钉正：
 *
 * - `firstKeyfrom` / `latestKeyfrom` 是**分发渠道标签**（本机安装包为
 *   `"official"`），不是时间戳；时间戳只落在本地的 `updatedAt`；
 * - `uuid` 是**安装级** ID：首次 `randomUUID()` 后落盘，登录 / 续期 / 登出 /
 *   所有 GET 复用同一个值（见 `lobsterai-identity.ts`）。
 *
 * 把时间戳当 keyfrom、每次登录新造 uuid，是服务端把请求判成「第三方反代」
 * 权重最高的两条特征（exchange 先发证后打标，所以一次对话都没有也会被标记）。
 */

import { createHash } from 'node:crypto'
import { jwtExpiresAtMs } from './credential-expiry.js'
import { lobsteraiFetch } from './lobsterai-fetch.js'
import type { LobsteraiProduct } from './lobsterai-product.js'

// ── 端点路径 ──

/** 授权码换 token。 */
export const LOBSTERAI_EXCHANGE_PATH = '/api/auth/exchange'
/** 静默续期。 */
export const LOBSTERAI_REFRESH_PATH = '/api/auth/refresh'
/** 退出登录（桌面端 Web 端登出时也会通知服务端，`main.js:187240-187259`）。 */
export const LOBSTERAI_LOGOUT_PATH = '/api/auth/logout'
/** 可用模型列表。 */
export const LOBSTERAI_MODELS_PATH = '/api/models/available'
/**
 * 对话端点（OpenAI 兼容，**仅支持 SSE**）。
 *
 * 积分余额端点（`/api/user/profile-summary`）刻意**不在此处**定义：
 * 唯一使用方是 `src/lobsterai-credits.ts`，常量就近定义在那里。
 * 曾经两处各定义一份同名常量，端点一旦变更只改一处会让语义分叉，
 * 且没有任何测试会失败 —— 单一真相源比「集中放一起」更重要。
 */
export const LOBSTERAI_CHAT_PATH = '/api/proxy/v1/chat/completions'
/** 登录回调路径（对齐 `cmd/login/main.go:35` 的 `callbackPath`）。 */
export const LOBSTERAI_CALLBACK_PATH = '/auth/callback'

/** 控制面请求超时（毫秒）；对话流式请求不适用。 */
export const LOBSTERAI_REQUEST_TIMEOUT_MS = 30_000
/** 登录流程总超时（毫秒）；对齐 `main.go:36` 的 10 分钟回调窗口。 */
export const LOBSTERAI_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 客户端版本号缓存有效期（毫秒，12 小时）。
 *
 * 版本号是**日期式**的（如 `2026.9.4`），变更频率极低（客户端发版节奏），
 * 而签到每次都要带它 —— 不缓存会让每次签到多一次跨域请求。
 */
export const LOBSTERAI_VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1000

// ── 凭据数据结构 ──

/**
 * 持久化的 LobsterAI 凭据。
 *
 * ## 与 `StoredTokenCredential` 的关键结构差异
 *
 * LobsterAI 的 **refresh 请求体不是只带 refreshToken**，还要带
 * `firstKeyfrom` / `latestKeyfrom` / `uuid`（`auth.go:37-50` +
 * `client.go:112-147`）。这三个字段必须随凭据一起持久化 —— 丢了就续期失败、
 * 只能让用户重新登录。这是两边最大的差异，也是最容易漏掉的地方。
 */
export interface LobsteraiCredential {
  /** 访问令牌（`Authorization: Bearer <access_token>`）。 */
  access_token: string
  /** 刷新令牌。
   * 由 exchange/refresh 返回。注意 Go 版把它当作「可缺失」处理
   * （`Parse` 不校验），故这里也保持必填但允许空串，
   * `isRefreshable` 以长度判定。
   */
  refresh_token: string
  /**
   * 过期时间（**毫秒时间戳字符串**）。
   *
   * 统一存毫秒字符串而非秒/ISO：与 `StoredTokenCredential.expires_at` 的存储约定
   * 保持一致，`credentialExpiresAtMs` 一套解析逻辑可通用于两者。
   */
  expires_at?: string
  /** 用户唯一 ID（账号池去重、候选排序的标识）。 */
  uid?: string
  /** 有道 yid（用于 refresh 请求体，与 uid 不一定相同）。 */
  user_id?: string
  /** 昵称（UI 展示）。 */
  nickname?: string
  /**
   * 安装 UUID（exchange/refresh 必带）。
   *
   * **安装级**，不是登录级：首次由客户端生成后落盘（对齐桌面端
   * `getOrCreateInstallationId()`，`main.js:150789-150798` 写入散列表
   * `installation_uuid`），登录 / 续期 / 登出 / 所有 GET 全部复用同一个值。
   * 每次登录重新 `randomUUID()` 会被服务端看成「同一账号下反复出现全新安装」，
   * 是「第三方反代」画像的关键一条。
   *
   * 权威来源是 {@link LobsteraiIdentityFields}（由 `lobsterai-identity.ts`
   * 落盘）；凭据里的这个字段只是**快照**，请求前由 `withLobsteraiIdentity`
   * 用安装身份覆盖 —— 老凭据因此能自愈。
   */
  uuid?: string
  /**
   * 渠道归属的**首次值**（exchange/refresh 必带）。
   *
   * 不是时间戳：桌面端 `DefaultKeyfrom.Official = "official"`，
   * 且首次写入后粘住不变（`initializeKeyfromAttribution`，`main.js:87017-87141`）。
   */
  first_keyfrom?: string
  /** 当前渠道归属（exchange/refresh 必带）。同样是渠道标签，不是时间戳。 */
  latest_keyfrom?: string
}

// ── 手机号脱敏（账号展示名）──

/**
 * 把手机号（完整或已脱敏）统一掩码为**只露末 2 位**的形态。
 *
 * ## 为什么需要它（用户要求 2026-09-27）
 *
 * > lobsterai 的用户名字显示的手机号尾号漏出 4 位，现在也改为只漏出 2 位
 *
 * 故这里做**归一化**而非改某个 `slice(-4)`：两种输入都收敛到同一形态，
 * 因此**幂等**（已归一化的值再跑一次结果不变），老账号也无需重新登录。
 *
 * | 输入 | 输出 |
 * |---|---|
 * | `13011111100`（完整号码） | `130******00` |
 * | `130****1100`（服务端脱敏，露 4 位） | `130******00` |
 * | `130******00`（已归一化） | `130******00`（幂等） |
 * | `测试账号` / `用户26815487395` | 原样返回（非手机号形态） |
 *
 * ⚠️ **只对「像手机号」的输入生效**：判据是 11 位纯数字（`1` 开头），或
 * `3 位数字 + 星号 + 数字` 的脱敏形态。绝不能泛化到任意字符串 ——
 * 那会把真实昵称（如 `用户26815487395`）也掩码掉。
 *
 * 星号个数按**原串总长**推算（`总长 - 3 - 2`），故对非 11 位的号码也自洽。
 *
 * @param visibleTail 保留的末位位数；默认 **2**（用户要求的展示口径）
 */
export function maskLobsteraiPhoneTail(value: string, visibleTail = 2): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return trimmed

  /** 按原串总长保持长度不变地重建掩码。 */
  const rebuild = (prefix: string, totalLength: number, tail: string): string => {
    const starCount = totalLength - prefix.length - tail.length
    // 后缀已经比要保留的还短（异常输入）：不制造负数星号，原样返回。
    return starCount < 0 ? trimmed : `${prefix}${'*'.repeat(starCount)}${tail}`
  }

  // 形态 1：完整手机号（11 位纯数字，1 开头）。
  if (/^1\d{10}$/.test(trimmed)) {
    return rebuild(trimmed.slice(0, 3), trimmed.length, trimmed.slice(-visibleTail))
  }

  // 形态 2：服务端已脱敏 —— 3 位数字 + 星号 + 若干位后缀。
  const masked = /^(\d{3})(\*+)(\d+)$/.exec(trimmed)
  if (masked !== null) {
    const [, prefix, stars, suffix] = masked
    const totalLength = prefix.length + stars.length + suffix.length
    return rebuild(prefix, totalLength, suffix.slice(-visibleTail))
  }

  // 非手机号形态（真实昵称 / 账号 id）：原样返回，绝不误伤。
  return trimmed
}

/**
 * LobsterAI 账号在 Channel Pack 里的**展示名**：昵称经手机号掩码归一化。
 *
 * 服务端把**手机号本身**当昵称下发（见 {@link maskLobsteraiPhoneTail}），
 * 故这里统一收敛到「只露末 2 位」；非手机号形态的昵称原样保留。
 * 昵称为空时退回账号 id（与登录路径既有行为一致）。
 */
export function lobsteraiDisplayNickname(
  credential: Pick<LobsteraiCredential, 'nickname'> | undefined,
  fallbackId: string,
): string {
  const nickname = typeof credential?.nickname === 'string' ? credential.nickname.trim() : ''
  if (nickname.length === 0) return fallbackId
  return maskLobsteraiPhoneTail(nickname)
}

// ── 统一信封 ──

/** 信封解析成功。 */
export interface LobsteraiEnvelopeSuccess {
  ok: true
  data: Record<string, unknown>
}
/** 信封解析失败（业务码非 0，或 data 缺失/非对象）。 */
export interface LobsteraiEnvelopeFailure {
  ok: false
  /** 业务码；无法读出时为 -1。 */
  code: number
  /** 可读原因（优先服务端 msg，缺失时给出本地的结构性说明）。 */
  message: string
}
export type LobsteraiEnvelopeResult = LobsteraiEnvelopeSuccess | LobsteraiEnvelopeFailure

/** 从 JSON 安全读取字符串字段（兼容后端把数字返回成 number）。 */
export function readStringField(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 从 JSON 安全读取数字字段（兼容字符串形态的数字）。 */
export function readNumberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/**
 * 解析 `{code, msg, data}` 信封。
 *
 * 三条判定（对齐 `main.go:143-150` 与 `sigin.py:44-48` 的双重校验）：
 *
 * 1. 响应体必须是对象；
 * 2. `code` 必须为 `0`；
 * 3. `data` 必须是**对象** —— 非对象一律视为失败。
 *
 * 第 3 条尤其重要：`sigin.py:46-47` 用它判定「accessToken 可能已失效」——
 * 上游在凭据失效时倾向于返回 `code:0` 但 `data:null`，
 * 只看 code 会把这种情况当成成功，随后在解引用时崩在更远的地方。
 */
export function parseLobsteraiEnvelope(body: unknown): LobsteraiEnvelopeResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, code: -1, message: '响应不是 JSON 对象' }
  }
  const record = body as Record<string, unknown>
  const code = readNumberField(record, 'code') ?? -1
  const message = readStringField(record, 'msg') || readStringField(record, 'message')
  if (code !== 0) {
    return { ok: false, code, message: message.length > 0 ? message : `code=${code}` }
  }
  const data = record.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return {
      ok: false,
      code,
      message: message.length > 0 ? message : 'data 为空（accessToken 可能已失效）',
    }
  }
  return { ok: true, data: data as Record<string, unknown> }
}

// ── 过期时间与可刷新判定 ──

/**
 * 从凭据的 `expires_at` 解析毫秒时间戳。
 *
 * 后备来源：`expires_at` 为空时回退解析 `access_token` 这个 JWT 的 `exp`。
 * Go 注释（`main.go:317`）说明「实测 HS512 access token 30 天」，
 * 故 access token 是 JWT，`exp` 是权威过期时刻。
 */
export function lobsteraiCredentialExpiresAtMs(credential: LobsteraiCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      return value > 1_000_000_000_000 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return jwtExpiresAtMs(credential.access_token)
}

/** 凭据是否已过期；无法解析过期时间时**不**判定过期（与 Rust/Go 侧一致）。 */
export function isLobsteraiExpired(credential: LobsteraiCredential): boolean {
  const expiresAt = lobsteraiCredentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/** 凭据是否携带可静默续期的 refresh_token。 */
export function isLobsteraiRefreshable(credential: LobsteraiCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

// ── 身份载荷（exchange / refresh / models / GET 共用） ──

/**
 * 渠道归属的默认值，也是本插件（官方安装包之外的另一种分发形态）唯一会发的值。
 *
 * 桌面端 `installer` 把渠道写进 `resources/keyfrom/keyfrom.json`（本机为
 * `{"keyfrom":"official"}`），运行态落 `keyfrom.attribution.v1`，线上请求
 * 实测发的就是字面量 `official`（`main-2026-11-13.log:12-14/277`）。
 */
export const LOBSTERAI_DEFAULT_KEYFROM = 'official'

/** keyfrom 的合法形态（对齐桌面端 `KEYFROM_PATTERN = /^[a-z0-9_-]{1,64}$/`）。 */
export const LOBSTERAI_KEYFROM_PATTERN = /^[a-z0-9_-]{1,64}$/

/**
 * 安装级身份字段（**一次安装一套，跨登录/续期恒定**）。
 *
 * 与桌面端的两个落盘键一一对应：
 *
 * - `uuid` ← `installation_uuid`（`main.js:150789-150798`）；
 * - `firstKeyfrom` / `latestKeyfrom` ← `keyfrom.attribution.v1`
 *   （`initializeKeyfromAttribution`，`main.js:87017-87141`；时间戳在
 *   `updatedAt`，**不**在这两个字段里）。
 */
export interface LobsteraiIdentityFields {
  /** 安装 UUID。 */
  uuid: string
  /** 首次渠道归属（首次写入后粘住）。 */
  firstKeyfrom: string
  /** 当前渠道归属。 */
  latestKeyfrom: string
}

/**
 * 解析 keyfrom：只接受合法渠道标签，其余一律 `undefined`。
 *
 * ⚠️ **纯数字视为非法**：桌面端的渠道枚举全是小写字母/下划线（`official`、
 * `html_share`、`site_deployment`），13 位毫秒串只可能来自本插件旧版本的误读
 * （见模块头注释）。`KEYFROM_PATTERN` 本身允许纯数字，所以客户端不会因此
 * 报错 —— 恰恰是这种「能发出去、但服务端不认识」的组合最危险，故在**构造
 * 请求前**就把它挡掉。
 */
export function parseLobsteraiKeyfrom(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (!LOBSTERAI_KEYFROM_PATTERN.test(value)) return undefined
  if (/^\d+$/.test(value)) return undefined
  return value
}

/** 同 {@link parseLobsteraiKeyfrom}，非法时回落到 {@link LOBSTERAI_DEFAULT_KEYFROM}。 */
export function sanitizeLobsteraiKeyfrom(raw: unknown): string {
  return parseLobsteraiKeyfrom(raw) ?? LOBSTERAI_DEFAULT_KEYFROM
}

/**
 * 解析安装 UUID：只接受 uuid 形态，其余返回 `undefined`（调用方生成新的）。
 *
 * 桌面端 `installation_uuid` 就是 `crypto.randomUUID()` 的产物
 * （本机实测 `b58139cd-b405-4ec5-92f2-d25bbb7d37c2`），故形态校验足够。
 * 不做形态校验的后果：状态文档被手工改坏后，把垃圾串当安装身份发上线。
 */
export function parseLobsteraiInstallationUuid(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return UUID_PATTERN.test(value) ? value : undefined
}

/**
 * 身份载荷的**字段顺序**（与桌面端 `buildKeyfromPayload()` 一致：
 * `firstKeyfrom, latestKeyfrom, uuid, userId, version`）。
 *
 * 用类型别名而不是 `interface`：请求体/query 消费方要把它当
 * `Record<string, unknown>` 用，interface 没有隐式索引签名。
 */
export type LobsteraiKeyfromPayload = {
  firstKeyfrom: string
  latestKeyfrom: string
  uuid?: string
  userId?: string
  version: string
}

/**
 * 构造身份载荷。
 *
 * 三个来源都**先过 sanitizer**：历史凭据里的毫秒 keyfrom、被改坏的 uuid
 * 因此不会继续上线（服务端只会看到合法的渠道标签 + 安装 UUID）。
 * `uuid` / `userId` 缺省时**删除键**而不是写空串（对齐桌面端
 * `buildKeyfromPayload()`：字段为 `undefined` 时被 spread 掉）。
 */
export function lobsteraiKeyfromPayload(
  fields: { firstKeyfrom?: string; latestKeyfrom?: string; uuid?: string; userId?: string },
  clientVersion: string,
): LobsteraiKeyfromPayload {
  const uuid = parseLobsteraiInstallationUuid(fields.uuid)
  const userId = typeof fields.userId === 'string' && fields.userId.length > 0 ? fields.userId : undefined
  return {
    firstKeyfrom: sanitizeLobsteraiKeyfrom(fields.firstKeyfrom),
    latestKeyfrom: sanitizeLobsteraiKeyfrom(fields.latestKeyfrom),
    ...uuid === undefined ? {} : { uuid },
    ...userId === undefined ? {} : { userId },
    version: clientVersion,
  }
}

/**
 * 构造凭据对应的身份载荷。
 *
 * 对应桌面端的 `withKeyfromBody()` / `appendKeyfromQuery()`。纯函数、走
 * sanitizer，所以即使调用方拿到的是**老凭据**，发出去的 keyfrom 也一定是
 * 合法渠道标签（uuid 的权威替换由 `withLobsteraiIdentity` 负责）。
 */
export function lobsteraiKeyfromBody(
  credential: LobsteraiCredential,
  clientVersion: string,
): LobsteraiKeyfromPayload {
  return lobsteraiKeyfromPayload({
    firstKeyfrom: credential.first_keyfrom,
    latestKeyfrom: credential.latest_keyfrom,
    uuid: credential.uuid,
    userId: credential.user_id,
  }, clientVersion)
}

/** 把身份载荷序列化为 query 串（GET 端点用；空值字段不出现）。 */
export function lobsteraiKeyfromQueryString(payload: LobsteraiKeyfromPayload): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && value.length > 0) params.set(key, value)
  }
  return params.toString()
}

/** 构造凭据对应的身份 query 串（GET 端点用）。 */
export function lobsteraiKeyfromQuery(
  credential: LobsteraiCredential,
  clientVersion: string,
): string {
  return lobsteraiKeyfromQueryString(lobsteraiKeyfromBody(credential, clientVersion))
}

/**
 * 构造续期请求体。
 *
 * 字段顺序对齐桌面端 `POST /api/auth/refresh`（`main.js:184802-184817`）：
 * `{refreshToken, firstKeyfrom, latestKeyfrom, uuid, userId, version}`。
 * 与 Go 的 `KeyfromBody()` 内容相同、顺序不同 —— 顺序本身是弱信号，但成本为零。
 *
 * `latestKeyfrom` 用**凭据里的值**（由调用方用安装身份覆盖后再传进来），
 * 不在这里取当前时刻：它是渠道标签，取时刻正是这次要修掉的 bug。
 */
export function lobsteraiRefreshBody(
  credential: LobsteraiCredential,
  clientVersion: string,
): Record<string, unknown> {
  const identity = lobsteraiKeyfromBody(credential, clientVersion)
  return {
    refreshToken: credential.refresh_token,
    firstKeyfrom: identity.firstKeyfrom,
    latestKeyfrom: identity.latestKeyfrom,
    ...identity.uuid === undefined ? {} : { uuid: identity.uuid },
    ...identity.userId === undefined ? {} : { userId: identity.userId },
    version: identity.version,
  }
}

// ── 登录 / 续期响应解析 ──

/** exchange / refresh 响应的令牌部分。 */
export interface LobsteraiTokenPayload {
  accessToken: string
  refreshToken: string
  /** 相对过期秒数；缺失时为 undefined（由 JWT exp 兜底）。 */
  expiresIn?: number
  /** 用户 ID 候选（`user.id`）。 */
  userId?: string
  /** 有道 yid（`user.yid`）。 */
  yid?: string
  /** 账号 userId（`user.userId`）。 */
  accountUserId?: string
  /** 昵称。 */
  nickname?: string
}

/**
 * 解析 exchange / refresh 响应里的令牌与用户信息。
 *
 * `expiresIn` 允许缺失：Go 在缺失时回退解 JWT `exp`（`main.go:313-319`），
 * 本插件在 {@link buildLobsteraiCredential} 里做同样的兜底。
 */
export function parseLobsteraiTokenPayload(data: Record<string, unknown>): LobsteraiTokenPayload {
  const user = typeof data.user === 'object' && data.user !== null
    ? data.user as Record<string, unknown>
    : {}
  const expiresIn = readNumberField(data, 'expiresIn')
  return {
    accessToken: readStringField(data, 'accessToken'),
    refreshToken: readStringField(data, 'refreshToken'),
    ...expiresIn === undefined ? {} : { expiresIn },
    userId: readStringField(user, 'id'),
    yid: readStringField(user, 'yid'),
    accountUserId: readStringField(user, 'userId'),
    nickname: readStringField(user, 'nickname'),
  }
}

/**
 * 解析账号唯一 ID，按**四级**回退（严格对齐 `main.go:297-306`）：
 *
 * `user.id` → `user.userId` → `user.yid` → `sha256(accessToken)` 前 16 位。
 *
 * 前三者是服务端字段，不同账号形态下哪个非空并不固定（个人号与企业号不同）；
 * 末级哈希兜底保证**任何情况下都能得到一个稳定 ID** —— 否则空 uid 会让
 * 账号池里多个账号互相覆盖（`addAccount` 按 id 去重）。
 *
 * 哈希取 hex 前 16 字符，与 Go 的 `fmt.Sprintf("%x", sha256.Sum256(...))[:16]`
 * 完全一致 —— 这是与 `lobsterai2api` 生成的 `auths/lobsterai-{uid}.json`
 * 逐字节对照的前提。
 *
 * ⚠️ **刻意不在 `yid` 与哈希之间插入 JWT `sub` 回退**：Go 没有这一级，
 * 插进去会让「服务端三个 user 字段皆空」的账号在本插件得到 `sub`、
 * 而在 Go 得到 16 位哈希 —— 同一账号两种 uid，破坏上述对照能力。
 * 稀有路径上与参考实现分叉，比多兜一层更糟。
 */
export function resolveLobsteraiUid(payload: LobsteraiTokenPayload): string {
  for (const candidate of [payload.userId, payload.accountUserId, payload.yid]) {
    if (candidate !== undefined && candidate.length > 0) return candidate
  }
  return createHash('sha256').update(payload.accessToken).digest('hex').slice(0, 16)
}

/**
 * 由令牌载荷组装可持久化的凭据。
 *
 * `expires_at` 的取值顺序（**与 Go 一致**，`main.go:313-319`）：
 * 1. `expiresIn`（相对秒数）→ 以**当前时刻**为基准换算；
 * 2. 缺失时用 access token 的 JWT `exp`；
 * 3. 都拿不到则留空（`credentialExpiresAtMs` 会再尝试 JWT，仍失败则
 *    「不判定过期」——见 `isLobsteraiExpired`）。
 *
 * `uuid` / `first_keyfrom` / `latest_keyfrom` 必须由调用方提供（安装级身份，
 * 见 `lobsterai-identity.ts`），**不是**从响应里来。
 */
export function buildLobsteraiCredential(
  payload: LobsteraiTokenPayload,
  identity: LobsteraiIdentityFields,
): LobsteraiCredential {
  const expiresAt = payload.expiresIn !== undefined && payload.expiresIn > 0
    ? String(Date.now() + payload.expiresIn * 1000)
    : (() => {
        const exp = jwtExpiresAtMs(payload.accessToken)
        return exp === undefined ? '' : String(exp)
      })()
  const uid = resolveLobsteraiUid(payload)
  return {
    access_token: payload.accessToken,
    refresh_token: payload.refreshToken,
    expires_at: expiresAt,
    uid,
    user_id: payload.accountUserId !== undefined && payload.accountUserId.length > 0
      ? payload.accountUserId
      : (payload.yid ?? ''),
    nickname: payload.nickname ?? '',
    uuid: identity.uuid,
    first_keyfrom: sanitizeLobsteraiKeyfrom(identity.firstKeyfrom),
    latest_keyfrom: sanitizeLobsteraiKeyfrom(identity.latestKeyfrom),
  }
}

/**
 * 用**安装身份**覆盖凭据里的身份快照。
 *
 * 为什么权威值不在凭据里：桌面端每次请求都现读 `installation_uuid` 与
 * `keyfrom.attribution.v1`，而不是从 token 里反推。本插件同构处理有两个好处：
 *
 * 1. **老凭据自愈**：升级前登录的凭据里存的是「毫秒 keyfrom + 每次登录新造的
 *    uuid」，若继续照发会永远带着坏指纹（续期不会把标记洗掉）。用安装身份覆盖
 *    后，下一次续期 / GET 起发的就都是合法值；
 * 2. **单一口径**：登录、续期、模型列表、余额查询都走同一个来源，
 *    不会出现「某个端点带旧 uuid」的半携带形态。
 *
 * 不改变令牌本身（`access_token` / `refresh_token` / 过期时间原样保留）。
 */
export function withLobsteraiIdentity(
  credential: LobsteraiCredential,
  identity: LobsteraiIdentityFields,
): LobsteraiCredential {
  return {
    ...credential,
    uuid: identity.uuid,
    first_keyfrom: sanitizeLobsteraiKeyfrom(identity.firstKeyfrom),
    latest_keyfrom: sanitizeLobsteraiKeyfrom(identity.latestKeyfrom),
  }
}

/**
 * 用续期结果更新凭据（保留服务端未返回的字段）。
 *
 * **令牌之外的字段一律沿用旧值**（`uuid` / `first_keyfrom` / `latest_keyfrom`
 * / `uid` / `user_id` / `nickname`）：LobsterAI 的 refresh 响应只带令牌，
 * 不含 account 对象。
 *
 * ⚠️ `latest_keyfrom` 在这里**不取当前时刻**：它是渠道标签（`official`），
 * 不是「最近活动时间」。真正的权威值来自安装身份，调用方应在续期前先
 * `withLobsteraiIdentity()`、续期后原样保住它。
 */
export function applyLobsteraiRefresh(
  previous: LobsteraiCredential,
  payload: LobsteraiTokenPayload,
  nowMs: number = Date.now(),
): LobsteraiCredential {
  const expiresAt = payload.expiresIn !== undefined && payload.expiresIn > 0
    ? String(nowMs + payload.expiresIn * 1000)
    : (() => {
        const exp = jwtExpiresAtMs(payload.accessToken)
        return exp === undefined ? (previous.expires_at ?? '') : String(exp)
      })()
  return {
    ...previous,
    access_token: payload.accessToken,
    // refresh 响应可能不返回新 refreshToken（沿用旧的），不能覆盖成空串。
    refresh_token: payload.refreshToken.length > 0 ? payload.refreshToken : previous.refresh_token,
    expires_at: expiresAt,
  }
}

// ── 请求头 ──

/**
 * 构造 **GET** 请求头（Bearer + Accept + 桌面形态 UA）。
 *
 * ⚠️ **不带 `Content-Type`**：桌面端对服务端 GET（models / quota /
 * profile-summary / banner）只设 `Authorization`（`main.js:184945`、`187112`、
 * `163291`），`Content-Type` 只出现在 POST 上。给 GET 加 `Content-Type` 是
 * 典型的「手写 HTTP 客户端」痕迹，也是本轮要消除的差异之一。
 *
 * `User-Agent` 用桌面形态串（见 `LOBSTERAI_USER_AGENT`）——桌面端自己不设置
 * UA、由 Electron 网络栈生成含 `Chrome/…`/`Electron/…` 的真实串；Node 侧
 * 默认的 `undici` 同样不是官方形态，故必须显式设置同一个形态。
 */
export function lobsteraiAuthHeaders(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  accept = 'application/json',
): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: accept,
    'User-Agent': product.userAgent,
  }
}

/**
 * 构造 **POST JSON** 请求头 = GET 头 + `Content-Type: application/json`。
 *
 * 桌面端只在确实带 JSON 体的请求上加该头（chat `send`、logout
 * `main.js:187253-187257`、purchase-offer activate `186821`）。
 */
export function lobsteraiJsonHeaders(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  accept = 'application/json',
): Record<string, string> {
  return {
    ...lobsteraiAuthHeaders(credential, product, accept),
    'Content-Type': 'application/json',
  }
}

/**
 * 构造对话请求头（POST JSON）。
 *
 * 比 {@link lobsteraiAuthHeaders} 多 `Content-Type` 与两个
 * `X-LobsterAI-Client-*` 头，`Accept` 为 SSE。这两个头来自 `client.go:94-101`
 * 的实测实现：`Capabilities` 声明客户端支持的 agentic 协议版本（影响工具调用
 * 行为），`Version` 是客户端版本号（**用动态真值**，见下方说明）。
 *
 * 注意 `X-LobsterAI-Client-Version` 用传入的 `clientVersion` 而非
 * `product.fallbackClientVersion`：Go 侧一直发假值 `0.1.0` 未被拒绝，
 * 说明服务端不强校验，但**没有理由继续发假值**。
 */
export function lobsteraiChatHeaders(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  clientVersion: string,
): Record<string, string> {
  return {
    ...lobsteraiJsonHeaders(credential, product, 'text/event-stream, application/json'),
    'X-LobsterAI-Client-Capabilities': product.clientCapabilities,
    'X-LobsterAI-Client-Version': clientVersion,
  }
}

/**
 * 构造**模型列表**请求头（`GET /api/models/available`）。
 *
 * 与 {@link lobsteraiChatHeaders} 同样带两个 `X-LobsterAI-Client-*` 头，
 * 只是 `Accept` 为 JSON 而非 SSE。
 *
 * **这两个头在本端点是必需的，不是可有可无的元数据**（2026-09-17 实测）：
 * 服务端按 `X-LobsterAI-Client-Capabilities` 声明的能力**过滤模型集合** ——
 * 不带该头时 `kimi-k3` 不会出现在返回里（25 个模型），带上 `kimi-k3-agentic-v1`
 * 才返回 26 个。IDE 侧走的就是 `buildServerModelCapabilityHeaders`，
 * 与本函数同形。
 *
 * 早先的实现用 {@link lobsteraiAuthHeaders}（只有 4 个基础头）请求本端点，
 * 因此即使解析正确也会**永久缺少 kimi-k3**。`X-LobsterAI-Client-Version`
 * 同理用动态真值。
 */
export function lobsteraiModelsHeaders(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  clientVersion: string,
): Record<string, string> {
  return {
    ...lobsteraiAuthHeaders(credential, product, 'application/json'),
    'X-LobsterAI-Client-Capabilities': product.clientCapabilities,
    'X-LobsterAI-Client-Version': clientVersion,
  }
}

/**
 * 构造无认证请求头（exchange / refresh 用）。
 *
 * 这两个端点**不需要** `Authorization` —— 换 token 时还没有 token，
 * 续期时服务端只认请求体里的 `refreshToken`。
 *
 * ## 只发 `Content-Type` + 桌面形态 UA（与桌面端逐字段对齐）
 *
 * 桌面端 `POST /api/auth/exchange` 的头**只有** `Content-Type: application/json`
 * （`main.js:186853-186867`），refresh 同（`34127-34132`，个人账号的企业头
 * `buildEnterpriseAccountRequestHeaders` 直接 `return {}`）。这里刻意不再发
 * `Accept`：不是因为它会惹麻烦，而是「与官方请求完全同形」本身就是要修的东西。
 *
 * UA 必须显式设置：桌面端的 UA 由 Electron 网络栈生成，Node 侧若不发就是
 * `undici`，两者都不是官方形态；发 `LobsterAI/0.1.0` 更是第三方项目的标识
 * （桌面端 `main.js` 命中 0 次，详见 `LOBSTERAI_USER_AGENT` 说明）。
 */
export function lobsteraiAnonymousHeaders(product: LobsteraiProduct): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': product.userAgent,
  }
}

// ── 客户端版本号 ──

/**
 * 校验并解析日期式版本号。
 *
 * 正则对齐 `sigin.py:16-18` 的 `version_key`：
 * `^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$` —— 主干为点分数字，
 * 允许一个可选的预发布后缀（如 `2026.9.4-beta.1`）。
 *
 * 之所以要**校验**而不是直接采信：版本号是签到接口的必填 query 参数，
 * 若上游返回 `null` / 空串 / HTML 错误页，把它拼进 URL 会让签到以一个
 * 更费解的错误失败。提前拒绝能给出「版本格式异常」这种可读原因
 * （对齐 `sigin.py:27-28` 的 `RuntimeError`）。
 *
 * @returns 归一化后的版本字符串；格式非法时返回 undefined。
 */
export function parseClientVersion(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!/^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) return undefined
  return trimmed
}

/**
 * 从更新接口的响应体里取出 `data.value.version`。
 *
 * 该响应的结构与业务接口**不同**（见 `LOBSTERAI_CLIENT_VERSION_API` 说明）：
 * `code`/`msg` 在外层，载荷在 `data.value`。实测形状：
 * `{data:{value:{version:"2026.9.4", date, windowsX64:{url}, ...}}, code:0, msg:"OK"}`。
 */
export function parseClientVersionFromUpdate(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const outer = (body as Record<string, unknown>).data
  if (typeof outer !== 'object' || outer === null) return undefined
  const value = (outer as Record<string, unknown>).value
  if (typeof value !== 'object' || value === null) return undefined
  return parseClientVersion((value as Record<string, unknown>).version)
}

/**
 * 客户端版本号解析器（带进程内缓存与兜底）。
 *
 * 抽取成类而非模块级单例：模块级可变状态会让单元测试互相污染
 * （某个用例写入缓存后，后续用例就再也不会走到真实拉取分支）。
 * 生产侧在 `src/lobsterai-auth.ts` 里持有一个实例即可。
 */
export class LobsteraiClientVersionResolver {
  private cached: string | undefined
  private cachedAt = 0

  constructor(
    private readonly options: {
      /** 缓存有效期；默认 {@link LOBSTERAI_VERSION_CACHE_TTL_MS}。 */
      ttlMs?: number
      /** 注入的 fetch（测试用）。 */
      fetcher?: typeof fetch
      /** 注入的时钟（测试用）。 */
      now?: () => number
    } = {},
  ) {}

  /**
   * 解析当前客户端版本号。
   *
   * 顺序：进程内缓存（未过期）→ 请求上游更新接口 → 兜底常量。
   *
   * `identity` 提供时会把它拼进 query（桌面端 `prod/update` 也走
   * `appendKeyfromQuery`，见 `main.js:184766-184777` 与运行日志 `:277`）：
   * 少这一路归因，同一 uuid/version 就会在不同端点呈现「部分携带」的形态。
   * 此时还不知道当前版本号，`version` 段用 `fallbackClientVersion` —— 这正是
   * 一个「尚未更新到最新版」的客户端会发的东西。
   *
   * **失败不回退到抛错**（与 `sigin.py:73-76` 的「整个脚本放弃签到」不同）：
   * 返回 `fallbackClientVersion` 并在返回值里标出 `source`，
   * 让调用方能决定是否记日志。理由见 `LOBSTERAI_FALLBACK_CLIENT_VERSION` 说明。
   */
  async resolve(
    product: LobsteraiProduct,
    identity?: LobsteraiIdentityFields,
  ): Promise<{ version: string; source: 'cache' | 'remote' | 'fallback' }> {
    const now = this.options.now?.() ?? Date.now()
    const ttl = this.options.ttlMs ?? LOBSTERAI_VERSION_CACHE_TTL_MS
    if (this.cached !== undefined && now - this.cachedAt < ttl) {
      return { version: this.cached, source: 'cache' }
    }
    const fetched = this.options.fetcher ?? lobsteraiFetch
    const query = identity === undefined
      ? ''
      : lobsteraiKeyfromQueryString(lobsteraiKeyfromPayload(identity, product.fallbackClientVersion))
    const url = query.length === 0 ? product.clientVersionApi : `${product.clientVersionApi}?${query}`
    try {
      const response = await fetched(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': product.userAgent },
        signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
      })
      if (response.ok) {
        const version = parseClientVersionFromUpdate(await response.json() as unknown)
        if (version !== undefined) {
          this.cached = version
          this.cachedAt = now
          return { version, source: 'remote' }
        }
      }
    } catch {
      // 网络/解析失败：走兜底。刻意不缓存兜底值 ——
      // 缓存会让一次瞬时故障在 TTL 内持续影响后续请求。
    }
    return { version: product.fallbackClientVersion, source: 'fallback' }
  }

  /** 清空缓存（测试与「强制刷新版本号」场景用）。 */
  clear(): void {
    this.cached = undefined
    this.cachedAt = 0
  }
}
