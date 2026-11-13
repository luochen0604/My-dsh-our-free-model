/**
 * 「每日自动唤醒」—— 开关、当日记录与执行体。
 *
 * ## 与自动签到同一骨架
 *
 * 结构照 `auto-checkin.ts`：独立文档 + 默认延迟 + 跨天巡检 + `runIfDue()` 判据。
 * **执行体完全共用**（`createAutoSchedule`）：触发时机归本模块，真正的唤醒由
 * `ops-runner` 的 `kind: 'wake'` 路径执行（逐账号、同渠道 5 秒间隔、按流水幂等、
 * `origin: 'auto'` 落流水）—— 自动唤醒与手动「一键唤醒」因此天然一致。
 *
 * ## ⚠️ 开关**默认关闭**
 *
 * 与自动签到（默认打开）相反：唤醒是对每账号刷新/探活凭据的**写操作**，而用户
 * 从未表达过「每天自动唤醒」的需求（那是 2026-11 新增的对称能力）。默认打开等于
 * 用户什么都没点就每天批量刷凭据；故判据是「**只有显式 `true` 才算打开**」，
 * 用户需要在「签到与唤醒」页手动打开这个开关。
 *
 * ## 为什么单独一份文档
 *
 * 与 `auto-checkin.json` / `ops-journal.json` 同因（详见前者的文件头）：写盘是
 * **整体替换**语义，同机另一条工作区跑着没有本功能的旧版本插件时，旧代码重写
 * 它认识的文档会把这里的字段静默抹掉 —— 后果是「开关自己关了」或「今天又跑一次」。
 * 独立文档的读写者只有本文件，旧版本代码碰不到它。**不要**把本开关塞进
 * `auto-checkin.json`：两份文档的生命周期（默认值、判据口径）已经分叉。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChannelPackHome } from './channel-pack-store.js'
import {
  AUTO_CHECKIN_RETRY_MS,
  AUTO_CHECKIN_TICK_MS,
  createAutoSchedule,
  utc8DateString,
  type AutoCheckin,
  type AutoCheckinStoreKind,
  type AutoScheduleDeps,
  type AutoScheduleEntry,
  type AutoTriggerReply,
  type RunTotals,
} from './auto-checkin.js'

/**
 * 「每日自动唤醒」的实时状态。
 *
 * 字段与 `RpcUsageAutoCheckinState` 同形（骨架共用）——刻意定义在本文件而不是
 * `types.ts`：类型清单只被本模块与 channel-pack-rpc 的接线用到，就近定义让
 * 「开关默认值相反」这一语义差异留在同一处可见。
 */
export interface RpcUsageAutoWakeState {
  /** 开关是否打开。默认**关闭**（`DEFAULT_AUTO_WAKE`：用户须显式启用）。 */
  enabled: boolean
  /** 上次**完成**自动唤醒的 UTC+8 日期；空串 = 从未跑过。 */
  lastDate: string
  /** 今天是否已经自动唤醒过（`lastDate` 等于今天）。 */
  ranToday: boolean
  /** 正在执行中（刚打开开关会立刻跑一轮，此时为 true）。 */
  running: boolean
  /** 上次结果摘要。 */
  lastResult: string
  /** 上次跑完的时刻（毫秒）；0 = 从未跑过。 */
  lastAt: number
  /** 逐渠道结果（`2 个已唤醒` / `1 个失败` …）。 */
  channels: Array<{ provider: string; text: string }>
  /** 用户是否已手动关闭那行常驻状态文字（关闭的是当前这一轮）。 */
  dismissed: boolean
}

/** RPC: 读写自动唤醒开关（`enabled` / `dismiss` 省略 = 只读；非法值拒绝）。 */
export interface RpcUsageAutoWakeRequest {
  enabled?: boolean
  dismiss?: boolean
}

/** RPC: 自动唤醒开关响应（回显写入后的生效状态）。 */
export interface RpcUsageAutoWakeResponse {
  autoWake: RpcUsageAutoWakeState
}

/** 独立文档的文件名（与 state.json / auto-checkin.json 同目录）。 */
export const AUTO_WAKE_FILE = 'auto-wake.json'

const SCHEMA = 'channel-pack/auto-wake/v1'

/**
 * 文档内容。字段与 `AutoCheckinDoc` 同形（骨架共用），仅开关默认值相反。
 */
export interface AutoWakeDoc {
  /** 自动唤醒开关。**默认关闭** —— 只有显式 `true` 才算打开（见文件头）。 */
  enabled: boolean
  /** 上次**完成**自动唤醒的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 从未跑过。 */
  lastDate: string
  /** 上次结果摘要（中文短句）。 */
  lastResult: string
  /** 上次跑完的时刻（毫秒）；0 = 从未跑过。 */
  lastAt: number
  /** 逐渠道结果；空数组 = 没有可展示的逐渠道信息。 */
  channels: Array<{ provider: string; text: string }>
  /** 用户点过「关闭」的那一轮（存那一刻的 `lastAt`）；0 = 未曾关闭过。 */
  dismissedRunAt: number
}

/** 默认：**关闭** + 无记录（见文件头「默认关闭」的理由）。 */
export const DEFAULT_AUTO_WAKE: AutoWakeDoc = {
  enabled: false,
  lastDate: '',
  lastResult: '',
  lastAt: 0,
  channels: [],
  dismissedRunAt: 0,
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 逐渠道条目上限（与 auto-checkin 同口径：渠道就十来个，脏数据不该撑大文档）。 */
const MAX_CHANNEL_ENTRIES = 24

function sanitizeChannels(raw: unknown): Array<{ provider: string; text: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ provider: string; text: string }> = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.provider !== 'string' || record.provider.length === 0) continue
    if (typeof record.text !== 'string') continue
    out.push({ provider: record.provider, text: record.text.slice(0, 120) })
    if (out.length >= MAX_CHANNEL_ENTRIES) break
  }
  return out
}

/**
 * 归一化文档：非法值一律回落默认值（**不抛错**）。
 *
 * ⚠️ 与 RPC 写入路径的严格校验不冲突：那条路径面对用户输入要拒绝，这条路径面对
 * 磁盘脏数据要回落。⚠️ 开关默认值是**关**，故缺失字段按**关闭**处理 —— 与
 * `sanitizeAutoCheckin`（缺失按打开）**故意相反**，别「顺手统一」。
 */
export function sanitizeAutoWake(raw: unknown): AutoWakeDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_AUTO_WAKE }
  const record = raw as Record<string, unknown>
  const ms = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    enabled: record.enabled === true,
    lastDate: typeof record.lastDate === 'string' && DATE_RE.test(record.lastDate) ? record.lastDate : '',
    lastResult: typeof record.lastResult === 'string' ? record.lastResult : '',
    lastAt: ms(record.lastAt),
    channels: sanitizeChannels(record.channels),
    dismissedRunAt: ms(record.dismissedRunAt),
  }
}

/** 环境变量：启动后延迟多久再尝试自动唤醒（毫秒）。 */
export const DSH_CHANNEL_PACK_AUTO_WAKE_DELAY_MS = 'DSH_CHANNEL_PACK_AUTO_WAKE_DELAY_MS'

/** 默认延迟（毫秒）。与自动签到的 30 秒同理由（不抢启动资源、等凭据续期先跑）。 */
export const AUTO_WAKE_DELAY_MS = 30_000

/**
 * 读延迟配置。⚠️ `0` 是合法值（立刻跑），不能写成 `Number(x) || 默认`（falsy 坑，
 * 与 `autoCheckinDelayMs` 记过的是同一条）。
 */
export function autoWakeDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DSH_CHANNEL_PACK_AUTO_WAKE_DELAY_MS]
  if (typeof raw !== 'string' || raw.trim().length === 0) return AUTO_WAKE_DELAY_MS
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : AUTO_WAKE_DELAY_MS
}

/** 文档后端类型（复用 auto-checkin 的 store 接口形状；文档内容各是各的）。 */
export type AutoWakeStoreKind = AutoCheckinStoreKind

/** 文档读写接口（与 `AutoCheckinStore` 同款约定）。 */
export interface AutoWakeStore {
  readonly kind: AutoWakeStoreKind
  load(): AutoWakeDoc
  save(doc: AutoWakeDoc): Promise<void>
}

class MemoryAutoWakeStore implements AutoWakeStore {
  readonly kind = 'memory' as const
  private doc: AutoWakeDoc = { ...DEFAULT_AUTO_WAKE }

  load(): AutoWakeDoc {
    return { ...this.doc }
  }

  async save(doc: AutoWakeDoc): Promise<void> {
    this.doc = { ...doc }
  }
}

class FileAutoWakeStore implements AutoWakeStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): AutoWakeDoc {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_AUTO_WAKE }
      return sanitizeAutoWake(JSON.parse(readFileSync(this.path, 'utf-8')) as unknown)
    } catch (error) {
      // ⚠️ 默认值是「**关闭**」：脏数据回落的后果是「今天不自动唤醒」，不是
      // 「替用户刷一轮凭据」。宁可少做一次，不做用户没要的写操作。
      this.logger?.warn(`[channel-pack] 读取 ${this.path} 失败，自动唤醒按默认设置（关闭）处理: ${String(error)}`)
      return { ...DEFAULT_AUTO_WAKE }
    }
  }

  async save(doc: AutoWakeDoc): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({
      schema: SCHEMA,
      enabled: doc.enabled,
      lastDate: doc.lastDate,
      lastResult: doc.lastResult,
      lastAt: doc.lastAt,
      channels: doc.channels,
      dismissedRunAt: doc.dismissedRunAt,
    }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

/** 创建文档后端（home 与账号池 / 自动签到用同一个 `resolveChannelPackHome`）。 */
export function createAutoWakeStore(ctx: Context): AutoWakeStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，自动唤醒开关仅存在于内存中')
    return new MemoryAutoWakeStore()
  }
  return new FileAutoWakeStore(join(home, 'channel-pack', AUTO_WAKE_FILE), ctx.logger)
}

/** 唤醒版总体摘要（签到版的 `describeRun` 是「领取」措辞，不能直接复用）。 */
export function describeWakeRun(totals: RunTotals): string {
  const parts: string[] = []
  if (totals.claimed > 0) parts.push(`${totals.claimed} 个账号唤醒成功`)
  if (totals.failed > 0) parts.push(`${totals.failed} 个失败`)
  if (totals.skipped > 0) parts.push(`${totals.skipped} 个渠道需手动处理`)
  if (parts.length === 0) return `${totals.providers} 个渠道：没有需要唤醒的账号`
  return `${totals.providers} 个渠道：${parts.join('，')}`
}

/**
 * 唤醒版逐渠道短句。唤醒没有「额度」与「今日已领」概念，只有成功 / 失败。
 * 必须短（与 `describeChannel` 同理由：九个渠道挤在面板一行一个片段）。
 */
export function describeWakeChannel(tally: { claimed: number; failed: number }): string {
  const parts: string[] = []
  if (tally.claimed > 0) parts.push(`${tally.claimed} 个已唤醒`)
  if (tally.failed > 0) parts.push(`${tally.failed} 个失败`)
  if (parts.length === 0) return '无需唤醒'
  return parts.join('，')
}

/** 唤醒版文档存取适配：`createAutoSchedule` 的 store 形状（load/save 同签名）。 */
function wakeStoreAdapter(store: AutoWakeStore): { load(): AutoWakeDoc; save(doc: AutoWakeDoc): Promise<void> } {
  return { load: () => store.load(), save: (doc) => store.save(doc) }
}

/** 装配层注入的依赖（除文案外与 `AutoScheduleDeps` 相同）。 */
export interface AutoWakeDeps {
  store: AutoWakeStore
  trigger(): Promise<AutoTriggerReply>
  whenIdle(): Promise<void>
  entries(): readonly AutoScheduleEntry[]
  now?(): number
  delayMs?: number
  schedule?(fn: () => void, ms: number): { cancel(): void }
  tickMs?: number
  scheduleTick?(fn: () => void, ms: number): { cancel(): void }
  warn?(message: string): void
}

/** 创建自动唤醒执行体（骨架与自动签到共用，见 `createAutoSchedule`）。 */
export function createAutoWake(deps: AutoWakeDeps): AutoCheckin {
  const schedule: AutoScheduleDeps = {
    ...deps,
    store: wakeStoreAdapter(deps.store),
    kind: 'wake',
    describeTotals: describeWakeRun,
    describeChannel: (tally) => describeWakeChannel(tally),
    // `nothing` = 流水已证明今天全部账号都唤醒成功：如实记一句，别让用户以为没跑。
    emptyResultText: '今天所有账号都已唤醒成功',
    runLabel: '自动唤醒',
    // 唤醒无排除表：唤醒覆盖除 OpenCode 外的全部已接入平台（见 ops-runner）。
  }
  return createAutoSchedule(schedule)
}

/** 「今天」（UTC+8）—— 转发自 auto-checkin（同一日界口径，不另立常量）。 */
export { utc8DateString }
export { AUTO_CHECKIN_TICK_MS as AUTO_WAKE_TICK_MS, AUTO_CHECKIN_RETRY_MS as AUTO_WAKE_RETRY_MS }
export type { AutoCheckin as AutoWake }
