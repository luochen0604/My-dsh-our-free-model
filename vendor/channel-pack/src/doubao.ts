/**
 * 豆包工作（DoubaoWork）协议常量与纯函数。
 *
 * 本文件只放**无 I/O 的纯逻辑**：header 组装、公共参数组装、SSE 行解析。
 * 网络调用在 `doubao-oauth.ts` / `doubao-adapter.ts`，凭据持久化在 `doubao-auth.ts`。
 *
 * ## 取证依据（全部静态，见 `docs/research/doubaowork/README.md`）
 *
 * | 事实 | 来源 |
 * |---|---|
 * | `POST /samantha/chat/completion` | `async-infra-message-samantha.js` byte 49235 |
 * | `Agw-Js-Conv: str` | 同文件 `headers:[["content-type","application/json"],["Agw-Js-Conv","str"]]` |
 * | `credentials: "same-origin"` | 同文件（纯 cookie 鉴权） |
 * | 公共参数 `di()` | `ai-views` 的 `di=()=>{...}` |
 * | cookie 名 | `sessionid` / `passport_csrf_token` / `s_v_web_id` / `ttwid` |
 * | SSE 事件种类 | `case"pb"` / `case"json"` / `case"done"` / `case"err"`（alice 同构文件） |
 *
 * ## ⚠️ 三个必须诚实标出的未知
 *
 * 1. **SSE 可能是 `pb` 事件**（protobuf）。官方客户端里 `event: pb` 走 protobuf 解码，
 *    `event: json` 才走 JSON。**客户端不能选**——服务端决定。若实际下发 `pb`，
 *    本 provider 需要 `pb.desc` 里对应的 message schema 才能解；
 *    而本次在 `pb.desc`(6010 消息) / `pb_server.desc`(7770 消息) 里**未找到**
 *    与 samantha 对话流对应的 message（两者都是 Lark/IM 协议）。
 *    → 这意味着 **`json` 分支能否命中是能否工作的前提**。
 * 2. **`aid` / `pkg_type` / `doubao_pc_version` 的真实字面量未取到**（只有变量名）。
 * 3. **是否需要 `X-Bogus` / `msToken` 未证明**：`bdms-sdk.js` 的待签白名单含
 *    `/passport/`，而**所有 chat 调用链文件对 `bdms` 的引用数为 0**（见报告 §3.2）。
 *    按"证据不支持"处理：默认不发签名，但保留可选注入点。
 */

import { DOUBAO, type DoubaoProduct } from './doubao-product.js'

/** 一次性请求超时（毫秒）。 */
export const DOUBAO_REQUEST_TIMEOUT_MS = 30_000
/** 流式首 token 超时（毫秒）。 */
export const DOUBAO_FIRST_TOKEN_TIMEOUT_MS = 120_000
/** 流式 chunk 间隔超时（毫秒）。 */
export const DOUBAO_CHUNK_TIMEOUT_MS = 120_000

/**
 * 豆包凭据。
 *
 * ⚠️ 与 Raccoon（JWT + refresh_token）/ TRAE（Cloud-IDE-JWT）不同，豆包是
 * **纯 cookie 鉴权**：服务端认的是 `sessionid`，没有独立的 bearer token，
 * 也没有观察到 `refresh_token` 轮换端点。
 *
 * 因此凭据的"过期"含义也不同：没有可解 `exp` 的 JWT。判断有效性只能靠
 * **探活**（调一个轻量 GET，看是否 401）。见 `doubao-auth.ts`。
 */
export interface DoubaoCredential {
  /**
   * 原始 cookie 串（`k=v; k2=v2`）。
   *
   * 这是唯一权威字段：`sessionid` 等全部在里面。
   * 单独拆字段只为了在 header 里拼 `Cookie`，不为了单独存取。
   */
  cookie: string
  /** 用于显示/去重的用户标识（可从 cookie 里的 `uid_tt` 或探活接口取；未知时为 ''）。 */
  uid: string
  /** 展示名（昵称；未知时为 ''）。 */
  nickname: string
  /**
   * 最近一次探活成功的时间戳（毫秒）。
   *
   * ⚠️ 没有 `expiresAt`：豆包的 sessionid 是滚动续期的 cookie，
   * 客户端看不到固定过期时刻。用 `lastVerifiedAt` + 探活代替。
   */
  lastVerifiedAt: number
  /**
   * 是否判定为桌面端来源会话。
   *
   * `false` 表示这是网页扫码得来的 cookie（`message_from` 不会带桌面标记），
   * 积分可能领不到——与 Raccoon 的 `desktop` 语义一致。
   */
  desktop: boolean
}

/** 判断凭据是否是"久了没验证"。 */
export function isDoubaoStale(credential: DoubaoCredential, maxAgeMs = 6 * 60 * 60 * 1000): boolean {
  return Date.now() - credential.lastVerifiedAt > maxAgeMs
}

/** 凭据是否可用（至少有 sessionid）。 */
export function isDoubaoUsable(credential: DoubaoCredential | undefined): credential is DoubaoCredential {
  if (credential === undefined) return false
  return typeof credential.cookie === 'string' && credential.cookie.includes('sessionid=')
}

/**
 * 从 cookie 串里解析出键值对。
 *
 * 容错：允许多余的 `;`、空格、`=` 之后的空格。
 */
export function parseCookieString(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof raw !== 'string' || raw.length === 0) return out
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key.length === 0) continue
    out[key] = value
  }
  return out
}

/** 从 cookie 串里读一个键。 */
export function cookieValue(cookie: string, name: string): string {
  return parseCookieString(cookie)[name] ?? ''
}

/**
 * 组装请求头。
 *
 * 依据：`ai-views` 里 chat 请求固定带 `content-type: application/json` 与
 * `Agw-Js-Conv: str`，且 `credentials: "same-origin"`（即 cookie 自动附带）。
 *
 * ⚠️ 因为是 Node 侧复刻，`same-origin` 不会自动带 cookie —— 必须显式拼
 * `Cookie` 头。这一点与浏览器行为等价，不是额外发明。
 */
export function doubaoHeaders(credential: DoubaoCredential | undefined, product: DoubaoProduct = DOUBAO): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // 字节 AGW 网关的"JS 约定"头（观察：所有 samantha/alice 请求都带）。
    'Agw-Js-Conv': 'str',
    Accept: 'text/event-stream',
    'User-Agent': product.userAgent,
    // 观察：桌面端每个业务请求都带 Cookie；node 侧需显式拼。
    ...credential === undefined || credential.cookie.length === 0 ? {} : { Cookie: credential.cookie },
  }
  return headers
}

/**
 * 组装公共 query 参数。
 *
 * 严格照抄 `di()` 的形状。**顺序与键名都必须一致**——字节网关会按
 * 参数集合做签名/风控判定，少一个平台声明就可能被判成非预期客户端。
 *
 * ⚠️ 三个未验证值（`aid` / `real_aid` / `pkg_type`）来自 `product.unverified`，
 * 已在 `doubao-product.ts` 里标注为占位。
 */
export function doubaoCommonParams(product: DoubaoProduct = DOUBAO): Record<string, string> {
  return {
    // 观察 `di()`：平台声明是 "web"（不是 desktop-*）。
    device_platform: 'web',
    doubao_device_platform: 'web',
    aid: product.unverified.aid,
    real_aid: product.unverified.realAid,
    pkg_type: product.unverified.pkgType,
    // 观察：`samantha_web: "1"`、`use-olympus-account: 1` 是固定值。
    samantha_web: '1',
    'use-olympus-account': '1',
    // 观察：`is_new_user: "0"` 固定。
    is_new_user: '0',
    // 观察：`doubao_pc_version` 由产品版本注入。
    doubao_pc_version: product.clientVersion,
  }
}

/** 把参数对象拼成 query string（跳过空值，与 `di()` 之后的行为一致）。 */
export function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    const text = String(value)
    if (text.length === 0) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`)
  }
  return parts.join('&')
}

/** 给一个路径加上公共 query。 */
export function withCommonParams(path: string, product: DoubaoProduct = DOUBAO): string {
  const query = toQueryString(doubaoCommonParams(product))
  if (query.length === 0) return path
  return path.includes('?') ? `${path}&${query}` : `${path}?${query}`
}

/**
 * 一条 SSE 事件。
 *
 * 观察：官方解析器 `switch(event)` 有四种分支 —— `pb`（protobuf）、`json`、
 * `done`、`err`。这里把 `pb` 单独建模，因为**它需要完全不同的解码路径**。
 */
export interface DoubaoSseFrame {
  /** 事件名（`event:` 字段）。空串表示默认 message 事件。 */
  event: string
  /** 数据（`data:` 字段，多行已按 SSE 规范用 `\n` 拼接）。 */
  data: string
}

/**
 * 解析一个 SSE 块（已按空行切开）。
 *
 * 只做字段切分，不做语义解释——语义在 adapter 里按 `event` 分发。
 */
export function parseSseBlock(block: string): DoubaoSseFrame | undefined {
  let event = ''
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) continue
    // SSE 注释行（以 ':' 开头）忽略。
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // 规范：冒号后若紧跟一个空格则去掉一个。
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (event.length === 0 && dataLines.length === 0) return undefined
  return { event, data: dataLines.join('\n') }
}

/**
 * 从一段可能含多个事件的文本里切出完整块。
 *
 * 返回 `{ frames, rest }`：`rest` 是尚未收到结尾空行的残留，调用方需继续累积。
 */
export function splitSseBlocks(buffer: string): { frames: DoubaoSseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  const frames: DoubaoSseFrame[] = []
  for (const part of parts) {
    const frame = parseSseBlock(part)
    if (frame !== undefined) frames.push(frame)
  }
  return { frames, rest }
}

/** 已知的 SSE 事件名。 */
export const DOUBAO_SSE = Object.freeze({
  /** protobuf 事件 —— 需要 message schema 才能解。 */
  pb: 'pb',
  /** JSON 事件 —— 可直接 `JSON.parse`。 */
  json: 'json',
  /** 流结束。 */
  done: 'done',
  /** 服务端错误。 */
  err: 'err',
})

/** 凭据失效/需要重新登录的错误特征。 */
export function isDoubaoAuthError(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true
  const text = String(body ?? '')
  return /not[_\s-]?login|sessionid|登录|未登录|no[_\s-]?auth/i.test(text)
}

/**
 * 判断响应体是否表示"额度/频次用尽"。
 *
 * ⚠️ 具体文案未取证；这里只匹配通用族，命中后由调用方决定是否 bench 账号
 * （避免把"参数错"误判成"额度尽"）。
 */
export function isDoubaoQuotaError(status: number, body: string): boolean {
  if (status === 429) return true
  const text = String(body ?? '')
  return /quota|limit[_\s-]?exceed|频繁|次数|额度不足|积分不足/i.test(text)
}
