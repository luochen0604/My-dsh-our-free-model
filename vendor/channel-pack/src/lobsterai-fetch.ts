/**
 * LobsterAI 控制面请求的**传输层选择**：优先 Electron 的 Chromium 网络栈。
 *
 * ## 为什么需要它（2026-11-13 的第二次排查结论）
 *
 * 桌面端对龙虾服务端的请求**全部走 `net.fetch`**（Electron/Chromium 网络栈）：
 * exchange `main.js:186856`、refresh `184811`、models `184944`、quota `163269`、
 * profile-summary `187112`、logout `187251`、banner `187162`。
 *
 * 参数对齐之后仍有无法用请求体/请求头解释的差异：**TLS 指纹（JA3/JA4）、ALPN、
 * HTTP/2 帧序、头部顺序、`Accept-Encoding`/`Accept-Language`** 都由网络栈决定。
 * Node 的 `undici` 是 OpenSSL + HTTP/1.1 的另一套指纹，服务端的风控完全可能只看
 * 这一条就把 exchange 判成「非 Electron 客户端」—— 这与「参数都对了还是秒封」
 * 的现象吻合。
 *
 * 因此这里在 **Electron 宿主**里返回 `net.fetch`（与桌面端同一套网络栈），
 * 在纯 Node（standalone / 单测）里退回全局 `fetch`。`lobsteraiFetch` 是同步签名
 * 的惰性代理，所以所有现有调用点（`typeof fetch`）无需改成 async。
 *
 * ## 可关闭
 *
 * `DSH_LOBSTERAI_TRANSPORT=node` 强制用 Node fetch（排查网络栈差异时用），
 * 默认 `auto`。
 */

/** 实际使用的传输层。 */
export type LobsteraiTransportKind = 'electron-net' | 'node-fetch'

/** 一次解析的结果。 */
export interface LobsteraiTransport {
  /** 与 `fetch` 同签名的实现。 */
  fetch: typeof fetch
  /** 便于日志区分两种路径。 */
  kind: LobsteraiTransportKind
}

let resolved: Promise<LobsteraiTransport> | undefined

/**
 * 解析传输层（进程内只解析一次）。
 *
 * 判定顺序：
 * 1. `DSH_LOBSTERAI_TRANSPORT=node` → 直接用全局 fetch；
 * 2. 运行在 Electron（`process.versions.electron` 存在）且 `electron.net.fetch`
 *    可用 → 用 Chromium 栈；
 * 3. 其余（standalone / 单测 / 权限受限）→ 全局 fetch。
 *
 * ⚠️ `import('electron')` 在**纯 Node** 里会抛 `ERR_MODULE_NOT_FOUND`，在
 * Electron 的**纯渲染进程**里会返回受限模块 —— 两种都静默回退，绝不让登录失败。
 */
export function lobsteraiTransport(): Promise<LobsteraiTransport> {
  if (process.env.DSH_LOBSTERAI_TRANSPORT === 'node') {
    return Promise.resolve({ fetch: globalThis.fetch, kind: 'node-fetch' })
  }
  resolved ??= (async (): Promise<LobsteraiTransport> => {
    if (process.versions.electron !== undefined) {
      try {
        const electron = await import('electron') as { net?: { fetch?: unknown } }
        const netFetch = electron.net?.fetch
        if (typeof netFetch === 'function') {
          // `net.fetch` 是 Chromium 网络栈的 fetch；绑定一下避免 this 丢失。
          return {
            fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
              (netFetch as typeof fetch)(input, init)) as typeof fetch,
            kind: 'electron-net',
          }
        }
      } catch {
        // 非 main/utility 进程、或 DSH 未暴露 electron：回退到 Node fetch。
      }
    }
    return { fetch: globalThis.fetch, kind: 'node-fetch' }
  })()
  return resolved
}

/**
 * 与 `fetch` 同签名的惰性代理：所有 LobsterAI 请求都应经它发出。
 *
 * 惰性解析保证「第一次真正发请求时」才去探测 Electron —— 模块加载阶段
 * （以及单测里替换 `globalThis.fetch`）都不会被提前固化。
 */
export const lobsteraiFetch: typeof fetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => lobsteraiTransport().then((transport) => transport.fetch(input, init))

/** 仅供测试：清空解析缓存（生产代码不需要）。 */
export function resetLobsteraiTransport(): void {
  resolved = undefined
}
