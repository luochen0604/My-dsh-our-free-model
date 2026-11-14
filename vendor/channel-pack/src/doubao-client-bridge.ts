/**
 * 从运行中的「豆包工作」客户端读取登录 cookie。
 *
 * ## 为什么必须这么做（而不是读数据库 / 让用户粘贴）
 *
 * 1. **登录态只在 Chromium 的 `Network/Cookies` 里**，而那个 SQLite 被运行中的
 *    进程**硬锁**：实测 `FileShare` 的 `Read` / `ReadWrite` / `ReadWrite|Delete`
 *    三种模式全部 `IOException`。本机不是管理员，无法用卷影复制绕过。
 * 2. **客户端自有存储里没有 session**：`samantha` 的 LevelDB（2.4 MB）可读，
 *    但搜不到 `sessionid`/`sid_guard`/`uid_tt` 等任何会话键。
 * 3. **让用户手抄 cookie 体验差且易错**（用户明确要求不要这么做）。
 *
 * 剩下的可行路径：客户端**接受 `--remote-debugging-port`**（实测：Chrome 147
 * 带该参数启动后 `/json/version` 返回 200），于是：
 *
 * ```
 * 关闭客户端 → 带调试端口重启 → CDP Network.getCookies → 关闭 → 正常重启
 * ```
 *
 * ## 安全性
 *
 * - 调试端口由 Chromium 默认绑定在 `127.0.0.1`，且端口号随机选取；
 * - 读完立刻关掉调试实例，并**用正常参数重新拉起**，不把调试端口留在用户机器上；
 * - cookie 值**只在进程内流转**，本模块任何日志都不打印值（只用长度/名称）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'

/** 目标 cookie 域（豆包 web）。 */
export const DOUBAO_COOKIE_URL = 'https://www.doubao.com'

/**
 * 客户端可执行文件。
 *
 * ⚠️ 用「安装目录里的 app\DoubaoWork.exe」而不是外层的 launcher：
 * 后者只是个引导器，真正跑 Chromium 的是它。
 */
export const DEFAULT_DOUBAO_EXE = 'D:\\Program Files\\DoubaoWork\\app\\DoubaoWork.exe'

/** Windows 专用（本模块依赖 taskkill/tasklist）。 */
export function isDoubaoClientBridgeSupported(): boolean {
  return process.platform === 'win32'
}

/** 一条 cookie（只保留导入所需字段）。 */
export interface DoubaoClientCookie {
  name: string
  value: string
  domain: string
  path: string
}

/** 读取结果。 */
export interface DoubaoClientCookieReadResult {
  cookies: DoubaoClientCookie[]
  /** 读取前客户端是否在运行（收尾时要还原）。 */
  wasRunning: boolean
  /** 本次用的调试端口（仅诊断用）。 */
  port: number
  /** 浏览器标识（诊断用）。 */
  browser: string
}

/** 进度回调。 */
export type DoubaoClientProgress = (message: string) => void

/** 取一个空闲本机端口。 */
export async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => {
        if (typeof port === 'number') resolve(port)
        else reject(new Error('无法分配空闲端口'))
      })
    })
  })
}

/** 跑一个命令并收集 stdout。 */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (chunk: unknown) => { out += String(chunk) })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(out))
  })
}

/** 等待（避免 `setTimeout(resolve, ms)` 的 void 类型摩擦）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 列出 DoubaoWork 主进程 PID（排除 `--type=` 子进程）。 */
export async function listDoubaoMainPids(): Promise<number[]> {
  const out = await run('powershell', [
    '-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='DoubaoWork.exe'\" | "
    + "Where-Object { $_.CommandLine -notmatch '--type=' } | "
    + "Select-Object -ExpandProperty ProcessId",
  ])
  return out.split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
}

/** 进程是否还活着。 */
async function pidAlive(pid: number): Promise<boolean> {
  const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH'])
  return out.includes(String(pid))
}

/** 优雅关闭（等价点窗口 X），超时后强杀。 */
async function closePid(pid: number, timeoutMs = 15_000): Promise<boolean> {
  await run('taskkill', ['/PID', String(pid)])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await pidAlive(pid)) return true
    await sleep(300)
  }
  await run('taskkill', ['/PID', String(pid), '/F'])
  const hardDeadline = Date.now() + 8_000
  while (Date.now() < hardDeadline) {
    if (!await pidAlive(pid)) return true
    await sleep(300)
  }
  return !await pidAlive(pid)
}

/** HTTP GET JSON（短超时，用于轮询 CDP）。 */
async function getJson(url: string, timeoutMs = 2500): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 等 CDP 就绪。 */
async function waitForCdp(port: number, timeoutMs: number): Promise<{ browser?: string } | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`) as
      { Browser?: string } | undefined
    if (version !== undefined) return { browser: version.Browser }
    await sleep(400)
  }
  return undefined
}

/**
 * 极简 CDP 客户端。
 *
 * Node 22+ 自带全局 `WebSocket`，故不引入 `ws` 依赖（发布清单对文件数敏感）。
 */
class CdpClient {
  #ws: WebSocket
  #nextId = 1
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(ws: WebSocket) {
    this.#ws = ws
    ws.addEventListener('message', (event: { data: unknown }) => {
      let frame: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        frame = JSON.parse(String(event.data)) as typeof frame
      } catch {
        return
      }
      if (typeof frame.id !== 'number') return
      const pending = this.#pending.get(frame.id)
      if (pending === undefined) return
      this.#pending.delete(frame.id)
      if (frame.error !== undefined) pending.reject(new Error(String(frame.error.message ?? 'cdp error')))
      else pending.resolve(frame.result)
    })
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10_000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')) })
    })
    return new CdpClient(ws)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP ${method} 超时`))
      }, 15_000)
    })
  }

  close(): void {
    try { this.#ws.close() } catch { /* best effort */ }
  }
}

/** 在已就绪的调试端口上读 doubao.com cookie。 */
async function readCookiesOverCdp(port: number): Promise<DoubaoClientCookie[]> {
  const listing = await getJson(`http://127.0.0.1:${port}/json/list`)
  const targets = Array.isArray(listing) ? listing as Array<Record<string, unknown>> : []
  if (targets.length === 0) throw new Error('CDP 没有可用 target')

  const page = targets.find((row) => typeof row['url'] === 'string'
      && String(row['url']).includes('doubao.com'))
    ?? targets.find((row) => row['type'] === 'page')
    ?? targets[0]
  const wsUrl = page?.['webSocketDebuggerUrl']
  if (typeof wsUrl !== 'string') throw new Error('CDP target 缺少 webSocketDebuggerUrl')

  const cdp = await CdpClient.connect(wsUrl)
  try {
    await cdp.send('Network.enable')
    const result = await cdp.send('Network.getCookies', { urls: [DOUBAO_COOKIE_URL] }) as
      { cookies?: Array<Record<string, unknown>> } | undefined
    const raw = Array.isArray(result?.cookies) ? result.cookies : []
    return raw
      .map((row) => ({
        name: typeof row['name'] === 'string' ? row['name'] : '',
        value: typeof row['value'] === 'string' ? row['value'] : '',
        domain: typeof row['domain'] === 'string' ? row['domain'] : '',
        path: typeof row['path'] === 'string' ? row['path'] : '',
      }))
      .filter((row) => row.name.length > 0)
  } finally {
    cdp.close()
  }
}

/**
 * 读取客户端当前登录 cookie。
 *
 * @throws 客户端不存在 / 未开放调试端口 / 未读到 cookie
 */
export async function readCookiesFromDoubaoClient(
  options: { exePath?: string; onProgress?: DoubaoClientProgress; timeoutMs?: number } = {},
): Promise<DoubaoClientCookieReadResult> {
  if (!isDoubaoClientBridgeSupported()) {
    throw new Error('从客户端导入仅支持 Windows')
  }
  const exePath = options.exePath ?? DEFAULT_DOUBAO_EXE
  const onProgress = options.onProgress ?? ((): void => {})
  if (!fs.existsSync(exePath)) {
    throw new Error(`找不到豆包工作客户端：${exePath}（可在设置里改路径）`)
  }

  const mainPids = await listDoubaoMainPids()
  const wasRunning = mainPids.length > 0
  onProgress(wasRunning
    ? `发现运行中的客户端（${mainPids.length} 个主进程），需重启一次以读取登录态…`
    : '客户端未运行，将启动以读取登录态…')

  // 1) 关掉现有实例（它持有 profile 锁，不关无法带调试端口重启）。
  for (const pid of mainPids) {
    onProgress(`正在关闭客户端（PID ${pid}）…`)
    await closePid(pid)
  }

  const port = await pickFreePort()
  let result: DoubaoClientCookieReadResult | undefined
  let failure: Error | undefined

  try {
    // 2) 带调试端口启动，使用**默认 profile**（登录态就在那）。
    onProgress(`正在以调试模式启动客户端（端口 ${port}）…`)
    const child = spawn(exePath, [`--remote-debugging-port=${port}`], {
      detached: true, stdio: 'ignore', windowsHide: false,
    })
    child.unref()

    const version = await waitForCdp(port, 30_000)
    if (version === undefined) {
      throw new Error('客户端未开放调试端口（可能被企业策略禁用）')
    }
    onProgress(`调试端口已就绪（${version.browser ?? 'Chromium'}），正在读取 cookie…`)

    const cookies = await readCookiesOverCdp(port)
    if (cookies.length === 0) {
      throw new Error('未读到任何 cookie —— 客户端可能尚未登录豆包')
    }
    result = { cookies, wasRunning, port, browser: version.browser ?? '' }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    // 3) 关掉调试实例（无论成败），避免把调试端口留在用户机器上。
    for (const pid of await listDoubaoMainPids()) {
      await closePid(pid, 12_000)
    }
    // 4) 还原：原来在跑就重新以正常参数拉起。
    if (wasRunning) {
      try {
        const restored = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false })
        restored.unref()
        onProgress('已重新启动客户端（正常模式）')
      } catch { /* 还原失败不影响已读到的结果 */ }
    }
  }

  if (failure !== undefined) throw failure
  if (result === undefined) throw new Error('读取客户端 cookie 失败（未知原因）')
  return result
}

/** 把 cookie 数组拼成 `Cookie` 头。 */
export function cookiesToHeader(cookies: readonly DoubaoClientCookie[]): string {
  return cookies.map((row) => `${row.name}=${row.value}`).join('; ')
}

/**
 * 从 cookie 里取稳定的账号标识，用于**去重**（同一账号不重复导入）。
 *
 * 字节系常见的用户标识 cookie，按可靠性排序。拿不到时返回 `undefined`，
 * 调用方应退化为「按 cookie 内容哈希去重」而不是盲目新增。
 */
export function identityFromCookies(
  cookies: readonly DoubaoClientCookie[],
): { key: string; value: string } | undefined {
  const map = new Map<string, string>()
  for (const row of cookies) map.set(row.name, row.value)
  for (const key of ['uid_tt', 'uid_tt_ss', 'sid_tt', 'uid', 'user_id']) {
    const value = map.get(key)
    if (typeof value === 'string' && value.length > 0) return { key, value }
  }
  return undefined
}
