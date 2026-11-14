/**
 * Loomy 渠道归因（`channel` / `visitedId`）。
 *
 * ## 为什么需要这个模块
 *
 * 官方客户端的登录请求里会带一个 `channel` 字段（渠道归因），而本插件原先
 * **完全没发** —— 这是登录参数与客户端唯一实质性差异。逐字节对照
 * `electron/xfyun/account-service.js` 后确认：
 *
 * | 端点 | 客户端带的归因字段 |
 * |---|---|
 * | `/login/phone/checkCode` | `channel` |
 * | `/login/thirdAccount/bind/auth` | `channel`（+ 可选 `authconf`） |
 * | `/register/phone/submit` | `channel` |
 * | `/login/phone/sendMsgCode` | **不带** |
 * | `/login/thirdAccount/bind/sendMsg|checkCode|skip` | **不带** |
 * | `/api/v1/points/first-login` | `channel` + `visitedId` |
 *
 * ⚠️ **只在非空时发送**：客户端是 `if (channel) param.channel = channel`，
 * 空串不该写进 body（否则 body 形状与客户端不同，服务端可能按「有该键」处理）。
 *
 * ## 值从哪来（照抄客户端 `electron/channel/`）
 *
 * 客户端的渠道号来自**安装包文件名里的标记** `-CH-<channel>[-VID-<visitedId>]`：
 *
 * - Windows：`%APPDATA%\Loomy\installer-filename`（NSIS customInstall 写入），
 *   兼容历史 per-user 安装；perMachine 安装时落在 `%ProgramData%\Loomy\`。
 * - macOS：扫 `~/Downloads` 下的 `Loomy-CH-*.dmg`，取 **mtime 最新**的一个。
 * - 其它平台：无来源 → 空。
 *
 * 官网正式安装包（如 `Loomy-Setup-0.9.39.exe`）**不含** `-CH-` 标记，
 * 解析结果为空 —— 此时两个客户端发出的 body 完全一致。
 *
 * ## 为什么结果记忆化
 *
 * 客户端把结果「锁定」进 `channel.json`，避免重复读来源（macOS 上读
 * `~/Downloads` 会触发 TCC 权限弹窗）。本插件没有自己的锁定文档，
 * 改用**进程内记忆化**：一次登录流程里最多读一次，跨登录复用，
 * 不会写任何额外状态文件（不改动用户磁盘布局）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 一次解析得到的归因。两者都可能为空串（正常情况）。 */
export interface LoomyChannelAttribution {
  /** 稳定渠道号，仅 `[A-Za-z0-9_]`；空串表示无渠道。 */
  channel: string
  /** 特殊渠道商的动态标识，仅 `[A-Za-z0-9_-]`；仅在 `channel` 非空时有意义。 */
  visitedId: string
}

/** 无归因的常量（避免各处重复写字面量对象）。 */
export const EMPTY_LOOMY_ATTRIBUTION: LoomyChannelAttribution = Object.freeze({
  channel: '',
  visitedId: '',
})

/** 渠道标记：`-CH-<channel>`。渠道号不含连字符。 */
const CHANNEL_PATTERN = /-CH-([A-Za-z0-9_]+)/
/** 访问标识：`-VID-<visitedId>`，允许连字符（常见 UUID 形态）。 */
const VISITED_PATTERN = /-VID-([A-Za-z0-9_-]+)/

/**
 * 从文件名解析渠道号。
 *
 * 与客户端 `channel-filename.js:parseChannelFromFilename` 完全同源。
 *
 * @returns 未命中返回**空串**（不是 undefined：调用方统一按「空 = 不发」处理）。
 */
export function parseLoomyChannelFromFilename(filename: unknown): string {
  if (typeof filename !== 'string' || filename.length === 0) return ''
  const matched = filename.match(CHANNEL_PATTERN)
  return matched === null ? '' : String(matched[1] ?? '')
}

/**
 * 从文件名解析 `visitedId`。
 *
 * 与客户端 `channel-filename.js:parseVisitedIdFromFilename` 完全同源。
 */
export function parseLoomyVisitedIdFromFilename(filename: unknown): string {
  if (typeof filename !== 'string' || filename.length === 0) return ''
  const matched = filename.match(VISITED_PATTERN)
  return matched === null ? '' : String(matched[1] ?? '')
}

/**
 * 读 Windows 安装器写下的文件名记录。
 *
 * ⚠️ 候选顺序与客户端一致：`%APPDATA%` 在前（历史 per-user 安装），
 * `%ProgramData%` 在后（perMachine 安装，NSIS 执行 `SetShellVarContext all`）。
 * 读不到 / 内容为空都继续尝试下一个；全失败返回空串。
 */
export function readLoomyWindowsInstallerName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const bases = [env.APPDATA, env.ProgramData]
  for (const base of bases) {
    if (typeof base !== 'string' || base.length === 0) continue
    try {
      const content = fs.readFileSync(path.join(base, 'Loomy', 'installer-filename'), 'utf8').trim()
      if (content.length > 0) return content
    } catch {
      // 读不到就试下一个候选；这不是错误。
    }
  }
  return ''
}

/**
 * 列出 `~/Downloads` 下的 `Loomy-CH-*.dmg`，按 mtime 由新到旧。
 *
 * ⚠️ 读取 `~/Downloads` 在 macOS 上会触发 TCC 权限弹窗，故本函数**只在登录时**
 * 调用一次（见模块头的记忆化说明），且失败一律静默返回空数组。
 */
export function listLoomyDownloadsDmgsNewestFirst(
  homeDir: string = os.homedir(),
): string[] {
  try {
    const downloads = path.join(homeDir, 'Downloads')
    return fs.readdirSync(downloads)
      .filter((name) => /^Loomy-CH-[A-Za-z0-9_]+.*\.dmg$/i.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(downloads, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 取一个文件名作为归因来源（按平台分派）。 */
function sourceFilename(platform: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return readLoomyWindowsInstallerName(env)
  // macOS 只看最新的那个 dmg：客户端注释明确「仅读一次来源文件名」。
  if (platform === 'darwin') return listLoomyDownloadsDmgsNewestFirst()[0] ?? ''
  return ''
}

/** 进程内记忆化缓存；`undefined` 表示尚未解析。 */
let cachedAttribution: LoomyChannelAttribution | undefined

/**
 * 解析渠道归因（记忆化）。
 *
 * @param options.platform - 平台覆盖（单测用），默认 `process.platform`。
 * @param options.env - 环境覆盖（单测用），默认 `process.env`。
 * @param options.homeDir - 家目录覆盖（单测用），默认 `os.homedir()`。
 */
export function resolveLoomyChannelAttribution(options: {
  platform?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
} = {}): LoomyChannelAttribution {
  if (cachedAttribution !== undefined) return cachedAttribution

  const platform = options.platform ?? process.platform
  let filename = ''
  if (platform === 'win32') {
    filename = readLoomyWindowsInstallerName(options.env ?? process.env)
  } else if (platform === 'darwin') {
    const home = options.homeDir ?? os.homedir()
    filename = listLoomyDownloadsDmgsNewestFirst(home)[0] ?? ''
  }

  const channel = parseLoomyChannelFromFilename(filename)
  // ⚠️ 与客户端一致：没有 channel 就不产出 visitedId —— 它单独发没有意义
  // （客户端 `lockAttributionOnce` 也是「没有 channel 直接 return」）。
  const visitedId = channel.length > 0 ? parseLoomyVisitedIdFromFilename(filename) : ''

  cachedAttribution = { channel, visitedId }
  return cachedAttribution
}

/**
 * 清空记忆化缓存。
 *
 * 仅测试用 —— 生产路径不该调用（同一个进程内归因不会中途变化）。
 */
export function resetLoomyChannelAttributionCache(): void {
  cachedAttribution = undefined
}

/**
 * 把 `channel` 写进登录参数。
 *
 * 客户端语义是 `if (channel) param.channel = channel` —— **空串不写键**。
 * 抽成函数是为了让「哪些端点是这个规则」在代码里显式可见。
 */
export function applyLoomyChannelParam(
  param: Record<string, unknown>,
  attribution: LoomyChannelAttribution | undefined,
): void {
  if (attribution === undefined) return
  const channel = attribution.channel.trim()
  if (channel.length > 0) param.channel = channel
}

/**
 * 构造 `first-login` 的请求体。
 *
 * 客户端 `points-service.js:completeFirstLogin` 的顺序是：
 * `inviteCode` → `deviceId` → `channel` → `visitedId`，且
 * **`visitedId` 仅在 `channel` 存在时发**（`if (channel && visitedId)`）。
 *
 * ⚠️ 无任何归因时返回**空对象** —— 这与客户端、也与本插件改动前的 body 一致。
 */
export function buildLoomyFirstLoginBody(
  attribution: LoomyChannelAttribution | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (attribution === undefined) return body
  const channel = attribution.channel.trim()
  if (channel.length === 0) return body
  body.channel = channel
  const visitedId = attribution.visitedId.trim()
  if (visitedId.length > 0) body.visitedId = visitedId
  return body
}
