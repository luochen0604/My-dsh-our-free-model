/**
 * Raccoon Work「桌面端授权」= 官方 `/authorize` 页 + 回环回调（宿主侧收 code）。
 *
 * ## 为什么必须做这一步（每日积分的门槛）
 *
 * 商汤的**每日积分**（`POST /api/web/desktop/v1/login/points/grant`）只对
 * **桌面端来源的会话**发放。会话来源由登录端点决定：
 *
 * | 登录路径 | 端点 | 来源 | 每日积分 |
 * |---|---|---|---|
 * | 微信扫码（本插件原有唯一路径） | `login_with_qrcode_code` | 网页 | ❌ 恒 `granted:false` |
 * | 短信 | `login_with_sms` | 网页 | ❌ |
 * | **桌面端授权码**（本文件） | `login_with_authorization_code` | **桌面端** | ✅ 当天首次 `granted:true` +300 |
 *
 * 2026-11-14 实测（本机两个账号）：桌面端账号连日 +300 与每次启动时刻对齐；
 * 纯扫码账号同一时刻打同一端点回 `granted:false`、余额不动。
 *
 * ## 为什么用官方页面而不是自己复刻滑块
 *
 * 逆向官方 `/authorize` 渲染层（chunk `app/(identity)/authorize/page-*.js`）时发现
 * 它**原生支持回环回调**，不必依赖收不到的 `office-raccoon://` 自定义协议：
 *
 * ```js
 * // 只允许这几个查询键；desktop_callback 必须是 'loopback'
 * const E = ['login_source','appname','state','redirect','ide','org','lang','desktop_callback']
 * // 回环回调的硬校验（函数 N）：
 * /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/auth\/callback$/.test(redirect)
 *   && /^[a-f0-9]{64}$/.test(state) && 1024 <= port <= 65535
 * // 交付方式（函数 y/A）：desktop ⇒ window.location.assign(redirect?code=…&state=…)
 * ```
 *
 * ⇒ 直接打开官方页面（阿里云滑块在**它自己的域名**下跑，风控与域绑定都不用我们
 * 操心），用户过一次滑块，页面把一次性 code 投递到我们的 127.0.0.1 端口。
 * 本插件自己复刻滑块页（`raccoon-login-page.ts` 的短信 Tab）之所以可行，是因为
 * 那条链路早年被实测验证过；而授权码这条链路有官方页面可用 —— 复刻反而是
 * 多养一份会漂移的实现，且要自己承担「SceneId 与本插件页面 origin 不匹配」的风险。
 *
 * ## ⚠️ 身份必须核对
 *
 * 官方页面授权的是**那个浏览器里登录着的账号**，与本插件持有的凭据可能不是同一个
 * （多账号、或浏览器登录了别的号）。授权码换来的新会话会**覆盖**该账号的凭据，
 * 认错的后果是「A 账号的凭据被换成了 B 账号的会话」——推理会继续工作（B 也是有效
 * 账号），只在积分归属上出错，极难排查。故 `persistDesktopSession` 必须比对
 * 新旧凭据的 `user_id` / `phone`，不一致就拒绝落盘。
 *
 * ## 安全边界
 *
 * 本地服务器只监听 `127.0.0.1`，只有 `/auth/callback` 一条路由，且**必须**带上
 * 与发起时一致的 `state`（64 位 hex，随机生成，一次性）才接受 code —— 否则本机
 * 任意进程/页面都能撞这个端口把别人的 code 塞进来。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { RACCOON_LOGIN_TIMEOUT_MS } from './raccoon.js'
import { exchangeRaccoonAuthorizationCode } from './raccoon-oauth.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'
import type { RaccoonCredential } from './raccoon.js'
import { listenOnRandomPort } from './raccoon-login-page.js'

/** 回调路径（官方页面的 `N()` 正则写死了这一条，不能改）。 */
export const RACCOON_DESKTOP_CALLBACK_PATH = '/auth/callback'

/** 官方桌面端登录页的固定参数（主进程 `desktopLogin.js` 的 `DESKTOP_AUTH_PARAMS`）。 */
export const RACCOON_DESKTOP_APP_NAME = '办公小浣熊客户端'

/** 组装 `/authorize` 页的完整 URL（导出给单测逐参数钉死官方校验规则）。 */
export function buildRaccoonDesktopAuthorizeUrl(options: {
  /** 站点 origin（默认生产 `https://xiaohuanxiong.com`）。 */
  siteOrigin?: string
  /** 回环端口：官方要求 4–5 位、1024–65535。 */
  port: number
  /** 一次性 state（64 位小写 hex）。 */
  state: string
  /** 语言（可选，官方白名单里有 `lang`）。 */
  lang?: string
}): string {
  const origin = options.siteOrigin ?? RACCOON.apiBase
  const params = new URLSearchParams({
    login_source: 'desktop',
    appname: RACCOON_DESKTOP_APP_NAME,
    desktop_callback: 'loopback',
    redirect: `http://127.0.0.1:${String(options.port)}${RACCOON_DESKTOP_CALLBACK_PATH}`,
    state: options.state,
  })
  if (options.lang !== undefined && options.lang.length > 0) params.set('lang', options.lang)
  return `${origin}/authorize?${params.toString()}`
}

/**
 * state 的形态必须同时满足官方页面的两条校验：64 位小写 hex，且端口在
 * `[1-9][0-9]{3,4}`（1000–99999）与 1024–65535 的交集里。
 */
export function isRaccoonDesktopCallbackPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && /^[1-9][0-9]{3,4}$/.test(String(port))
}

/** 一次性 state（随机 32 字节 → 64 位小写 hex）。 */
export function generateRaccoonDesktopState(): string {
  return randomBytes(32).toString('hex')
}

/** 一次「桌面端授权」流程的句柄。 */
export interface StartedRaccoonDesktopLoginFlow {
  /**
   * 要在系统浏览器里打开的**商汤官方** `/authorize` 页地址。
   *
   * 字段名沿用 `account.create` 的 `loginUrl`：客户端那段「打开登录页 + 轮询」
   * 的逻辑两边共用，换名字只会多一次映射。
   */
  loginUrl: string
  /** 换到的桌面端会话凭据（未补全用户信息，由调用方 persist）。 */
  result: Promise<RaccoonCredential>
  /** 关闭本地回调服务器（未收到 code 时视作放弃）。 */
  close: () => Promise<void>
}

export interface RaccoonDesktopLoginOptions {
  product?: RaccoonProduct
  fetcher?: typeof fetch
  /** 整体超时（毫秒）；默认与其余登录流程一致（5 分钟）。 */
  timeoutMs?: number
  /** 站点 origin 覆盖（单测/灰度环境用）。 */
  siteOrigin?: string
  /** 语言（透传给官方页面）。 */
  lang?: string
}

/** 回调页的极简 HTML（不带任何脚本：这一步之后没什么可交互的）。 */
function callbackPageHtml(ok: boolean, message: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">
<title>${ok ? '授权完成' : '授权未完成'}</title>
<body style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f6f8;color:#1f2329;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="background:#fff;border-radius:12px;padding:22px 26px;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)">
<h1 style="font-size:16px;margin:0 0 8px">${ok ? '桌面端授权完成' : '桌面端授权未完成'}</h1>
<p style="font-size:13px;line-height:1.6;margin:0;color:#4e5969">${message}</p>
</div></body></html>`
}

/**
 * 启动「桌面端授权」：起回环回调服务器并给出官方授权页地址。
 *
 * 与 `startRaccoonLoginFlow` 的关键差别：本流程**不需要**用户先在本插件里登录
 * —— 用户在官方页面上用他浏览器里已有的会话授权即可。宿主侧只负责收 code 与
 * 换 token。
 */
export async function startRaccoonDesktopLogin(
  options: RaccoonDesktopLoginOptions = {},
): Promise<StartedRaccoonDesktopLoginFlow> {
  const product = options.product ?? RACCOON
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? RACCOON_LOGIN_TIMEOUT_MS

  let resolveResult!: (value: RaccoonCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<RaccoonCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 用户可能立刻关掉窗口/超时，这段窗口里 Node 会报 unhandled rejection。
  result.catch(() => {})

  let settled = false
  let timer: NodeJS.Timeout | undefined
  const settleOk = (value: RaccoonCredential): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    rejectResult(error)
  }

  // 先验 state 与端口：官方对二者都有硬校验，端口不合法（如系统给了 6 位数）
  // 就直接失败而不是打开一个必然被页面判为 `invalid` 的地址。
  const state = generateRaccoonDesktopState()

  const server: Server = createServer((request, response) => {
    void handleCallback(request, response, { product, fetcher, state, settleOk, settleErr }).catch(
      (error: unknown) => {
        try {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end(`内部错误：${error instanceof Error ? error.message : String(error)}`)
        } catch {
          // 响应可能已发出
        }
      },
    )
  })

  const port = await listenOnRandomPort(server)
  if (!isRaccoonDesktopCallbackPort(port)) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    throw new Error(`raccoon: 回环端口 ${String(port)} 不符合官方回调校验（需 1024–65535 且 4–5 位）`)
  }
  const authorizeUrl = buildRaccoonDesktopAuthorizeUrl({
    port,
    state,
    ...options.siteOrigin === undefined ? {} : { siteOrigin: options.siteOrigin },
    ...options.lang === undefined ? {} : { lang: options.lang },
  })

  const close = async (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer)
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      // 有挂起连接时 close 不会立即回调。
      server.closeAllConnections?.()
    })
  }

  timer = setTimeout(() => {
    settleErr(new Error('raccoon: 桌面端授权超时（未完成滑块或未回到本页）'))
    void close()
  }, timeoutMs)
  timer.unref?.()
  result.then(() => { void close() }, () => { void close() })

  return { loginUrl: authorizeUrl, result, close }
}

interface CallbackDeps {
  product: RaccoonProduct
  fetcher: typeof fetch
  state: string
  settleOk: (value: RaccoonCredential) => void
  settleErr: (error: unknown) => void
}

/** 处理回调：校验 state → 换桌面端 token → 回一页极简 HTML。 */
async function handleCallback(
  request: IncomingMessage,
  response: ServerResponse,
  deps: CallbackDeps,
): Promise<void> {
  const localPort = request.socket.localPort ?? 0
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${localPort}`)
  if (url.pathname !== RACCOON_DESKTOP_CALLBACK_PATH) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
    return
  }
  const state = url.searchParams.get('state') ?? ''
  // ⚠️ `state` 是这条路由**唯一**的准入门槛（官方也是这么设计的：`N()` 校验
  // redirect + state 才允许 desktop_callback=loopback）。不匹配 ⇒ 不是我们发起的
  // 那一轮，直接忽略，不换 token、不告知原因（避免给本机其它进程 oracle）。
  if (state.length === 0 || state !== deps.state) {
    response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(callbackPageHtml(false, '回调的 state 与本次授权不匹配，请重新发起桌面端授权。'))
    return
  }
  const code = (url.searchParams.get('code') ?? url.searchParams.get('authorization_code') ?? '').trim()
  if (code.length === 0 || code.length > 4096) {
    response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(callbackPageHtml(false, '回调里没有授权码，请在授权页重新确认一次。'))
    return
  }
  try {
    const credential = await exchangeRaccoonAuthorizationCode(deps.product, code, deps.fetcher)
    deps.settleOk(credential)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(callbackPageHtml(true, '已切换到桌面端会话，可以关闭这个标签页回到 OFM。'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.settleErr(error)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(callbackPageHtml(false, `换取桌面端会话失败：${message}`))
  }
}
