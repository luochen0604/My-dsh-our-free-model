/**
 * LobsterAI 的**安装身份**：安装 UUID + keyfrom 渠道归属。
 *
 * ## 为什么需要它（2026-11-13，真实缺陷：刚登录、零对话就被判「第三方反代」）
 *
 * 桌面端把两样东西**落盘复用**，而插件当年每次登录都重新现造：
 *
 * | 字段 | 桌面端行为 | 插件旧行为 |
 * |---|---|---|
 * | `uuid` | `installation_uuid`，首次 `randomUUID()` 后落盘，登录/续期/登出/所有 GET 复用 | 每次登录 `randomUUID()` |
 * | `firstKeyfrom` / `latestKeyfrom` | 渠道标签（本机 `"official"`），首次粘住、每次启动刷新 `latest` | 13 位毫秒时间戳（把字段误读成「时间」） |
 *
 * 服务端在**换 token 这一步**看到的组合是「未知渠道 + 每次都是新装设备 +
 * 版本号却完全正常」——这正是「换客户端壳 / 中转服务」的画像，且标记发生在
 * 登录链路（账号侧 `cowork_sessions` / `cowork_messages` 都是 0 行也照样命中）。
 *
 * 因此本模块按桌面端语义维护**一套安装身份**：
 *
 * - `uuid`：首次生成即落盘，之后任何路径都不换（重登、凭据重建、升级都不换）；
 * - `firstKeyfrom`：首次写入后**粘住**（桌面端 `firstKeyfrom: existing?.firstKeyfrom || current`）；
 * - `latestKeyfrom`：每次解析刷新为当前渠道（桌面端 `initializeKeyfromAttribution`）；
 * - `updatedAt`：**时间戳只住这里**，永远不上线。
 *
 * ## 存储位置与一致性
 *
 * `$DSH_HOME/channel-pack/lobsterai-installation.json`（与 `state.json`、
 * `permanent-locks.json`、`ui-preferences.json` 同目录同惯例：同步读 + 原子写）。
 * home 解析复用 `resolveChannelPackHome`，避免出现「账号池在 A、身份文档在 B」
 * 的分裂。
 *
 * 读不到 home（headless / 单测替身缺服务）时退化为**进程内内存**身份并告警：
 * 本次运行仍能登录，只是重启后安装 UUID 会变（等同于一条新装记录）。
 *
 * ## 与凭据的关系
 *
 * 权威值是这里的文档；凭据里的 `uuid` / `first_keyfrom` / `latest_keyfrom`
 * 只是**快照**。请求前一律用 `withLobsteraiIdentity()` 覆盖，所以升级前
 * 登录的老凭据会从下一次续期/GET 起自愈（不再发毫秒 keyfrom）。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChannelPackHome } from './channel-pack-store.js'
import {
  LOBSTERAI_DEFAULT_KEYFROM,
  parseLobsteraiInstallationUuid,
  parseLobsteraiKeyfrom,
  sanitizeLobsteraiKeyfrom,
  type LobsteraiIdentityFields,
} from './lobsterai.js'

/** 身份文档文件名（与 `state.json` 同目录）。 */
export const LOBSTERAI_INSTALLATION_FILE = 'lobsterai-installation.json'

/** 文档 schema 标记（与本仓库其它状态文档同惯例）。 */
const LOBSTERAI_INSTALLATION_SCHEMA = 'channel-pack/lobsterai-installation/v1'

/** 落盘/内存中的安装身份。 */
export interface LobsteraiIdentity extends LobsteraiIdentityFields {
  /** 最近一次解析时间（毫秒）。**不上线**，只做本地诊断。 */
  updatedAt: number
}

/** 安装身份的读写接口（同步读，与 `ChannelPackStore` 同款约定）。 */
export interface LobsteraiIdentityStore {
  readonly kind: 'file' | 'memory'
  /**
   * 取安装身份；首次调用生成并落盘，之后沿用。
   *
   * @param channel 当前渠道标签（默认 {@link LOBSTERAI_DEFAULT_KEYFROM}）。
   *   合法值会写进 `latestKeyfrom`；非法值回落 `official`。
   */
  resolve(channel?: string): LobsteraiIdentity
}

/**
 * 把一份（可能损坏/空/旧版）文档合并成当前的安装身份。
 *
 * 纯函数：不碰磁盘，便于单测锁住「时间戳 keyfrom 会被替换」「uuid 跨次不变」
 * 这两条最关键的性质。
 *
 * @param document 已解析的文档（任意 JSON；非法形状按空处理）。
 * @param options.channel 当前渠道；默认 `official`。
 * @param options.now 当前毫秒时间戳（测试注入）。
 * @param options.generateUuid 生成安装 UUID 的方式（测试注入）。
 */
export function mergeLobsteraiIdentity(
  document: unknown,
  options: { channel?: string; now?: number; generateUuid?: () => string } = {},
): LobsteraiIdentity {
  const now = options.now ?? Date.now()
  const channel = sanitizeLobsteraiKeyfrom(options.channel ?? LOBSTERAI_DEFAULT_KEYFROM)
  const record = typeof document === 'object' && document !== null && !Array.isArray(document)
    ? document as Record<string, unknown>
    : {}
  const keyfrom = typeof record.keyfrom === 'object' && record.keyfrom !== null && !Array.isArray(record.keyfrom)
    ? record.keyfrom as Record<string, unknown>
    : {}

  // 安装 UUID：形态合法就沿用（跨登录/续期/重启恒定），否则现造一个。
  const uuid = parseLobsteraiInstallationUuid(record.installationUuid)
    ?? (options.generateUuid ?? randomUUID)()

  // 首次渠道粘住：文档里有合法值就保留，只有缺失/非法时才取当前渠道。
  // ⚠️ 旧版本写进去的 13 位毫秒串在这里被判为非法（纯数字），自动替换。
  const storedFirst = parseLobsteraiKeyfrom(keyfrom.firstKeyfrom)
  return {
    uuid,
    firstKeyfrom: storedFirst ?? channel,
    // `latestKeyfrom` 每次都刷成当前渠道（桌面端 `initializeKeyfromAttribution`）。
    latestKeyfrom: channel,
    updatedAt: now,
  }
}

/** 文档形状（写盘用；与 {@link mergeLobsteraiIdentity} 的读入形状对应）。 */
function toDocument(identity: LobsteraiIdentity): string {
  return JSON.stringify({
    schema: LOBSTERAI_INSTALLATION_SCHEMA,
    installationUuid: identity.uuid,
    keyfrom: {
      firstKeyfrom: identity.firstKeyfrom,
      latestKeyfrom: identity.latestKeyfrom,
      updatedAt: identity.updatedAt,
    },
  }, null, 2)
}

/** 文件后端：`$DSH_HOME/channel-pack/lobsterai-installation.json`（原子写）。 */
class FileIdentityStore implements LobsteraiIdentityStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  resolve(channel: string = LOBSTERAI_DEFAULT_KEYFROM): LobsteraiIdentity {
    const identity = mergeLobsteraiIdentity(this.read(), { channel })
    this.write(identity)
    return identity
  }

  private read(): unknown {
    try {
      if (!existsSync(this.path)) return undefined
      return JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
    } catch (error) {
      // 文档损坏：按「没有安装身份」处理（生成新的并落盘覆盖），
      // 而不是让登录直接失败。代价只是服务端多看到一次「新装」。
      this.logger?.warn(`[lobsterai] 读取 ${this.path} 失败，将重新生成安装身份: ${String(error)}`)
      return undefined
    }
  }

  private write(identity: LobsteraiIdentity): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, toDocument(identity), 'utf-8')
      renameSync(tmp, this.path)
    } catch (error) {
      // 写不进去不该阻断登录：本次运行用内存里的身份，重启后会变（退化为一条新装）。
      this.logger?.warn(`[lobsterai] 写入 ${this.path} 失败，安装身份仅在本次运行有效: ${String(error)}`)
    }
  }
}

/** 内存后端：无法定位 dsh home 时的显式降级（与其它状态文档同策）。 */
class MemoryIdentityStore implements LobsteraiIdentityStore {
  readonly kind = 'memory' as const
  private document: unknown

  resolve(channel: string = LOBSTERAI_DEFAULT_KEYFROM): LobsteraiIdentity {
    const identity = mergeLobsteraiIdentity(this.document, { channel })
    // 只保留可复用的字段（`updatedAt` 每次重算），下一次 resolve 仍拿到同一 uuid。
    this.document = { installationUuid: identity.uuid, keyfrom: identity }
    return identity
  }
}

/**
 * 创建安装身份后端。
 *
 * home 的解析与账号池 / 锁定表 / 偏好文档**同一个函数**（`resolveChannelPackHome`），
 * 保证四份文档永远落在同一目录。
 */
export function createLobsteraiIdentityStore(ctx: Context): LobsteraiIdentityStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[lobsterai] 无法定位 DSH home，安装身份仅存在于内存中（重启后会变成新装）')
    return new MemoryIdentityStore()
  }
  return new FileIdentityStore(join(home, 'channel-pack', LOBSTERAI_INSTALLATION_FILE), ctx.logger)
}
