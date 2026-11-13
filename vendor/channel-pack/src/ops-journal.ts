/**
 * 签到与唤醒流水（持久化）。
 *
 * ## 为什么单独一份文档
 *
 * 与 `auto-checkin.json` 同因：`state.json` 是整体替换语义，同机另一条工作区里
 * 的旧版本代码重写它时不认识本文件的字段；流水是只增不改的观测数据，旧版本
 * 碰不到它才不会静默清空。文件名 `ops-journal.json`，与账号池同目录。
 *
 * ## 为什么**不参与控制流**
 *
 * 流水是观测面：写盘失败最多让面板少一条记录，绝不能让签到/唤醒本身失败。
 * 故 `append()` 自己吞掉异常（只告警），调用方无需 try/catch。
 *
 * ## 容量与保留
 *
 * 每次签到/唤醒都写一条，渠道多、账号多时增长很快。保留最近
 * {@link OPS_JOURNAL_MAX_ENTRIES} 条，且只保留最近 {@link OPS_JOURNAL_MAX_DAYS}
 * 天（UTC+8 日界）—— 与 Token 账本的历史窗口同量级，页面也只需要这段时间。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChannelPackHome } from './channel-pack-store.js'
import { utc8DateString } from './auto-checkin.js'
import { claimUnitOf, formatUnitAmount, type ClaimOutcome } from './credits.js'
import type {
  RpcCreditsClaimAccountResult,
  RpcOpsJournalEntry,
  RpcOpsKind,
  RpcOpsOrigin,
} from './types.js'

/** 独立文档文件名（与 state.json / auto-checkin.json 同目录）。 */
export const OPS_JOURNAL_FILE = 'ops-journal.json'

const SCHEMA = 'channel-pack/ops-journal/v1'

/** 最多保留多少条流水。2000 条足够覆盖两周的重度使用，文档也仍在百 KB 量级。 */
export const OPS_JOURNAL_MAX_ENTRIES = 2_000

/** 最多保留多少天（UTC+8）。 */
export const OPS_JOURNAL_MAX_DAYS = 90

const DAY_MS = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const KINDS = new Set<RpcOpsKind>(['checkin', 'wake'])
const OUTCOMES = new Set(['ok', 'already', 'inactive', 'failed'])
const ORIGINS = new Set<RpcOpsOrigin>(['auto', 'manual'])

/** 一个模块级的自增序号：id 只需在页面列表内唯一，不承担业务语义。 */
let idSequence = 0

function nextId(at: number, provider: string, accountId: string): string {
  idSequence += 1
  return `${at}-${provider}-${accountId}-${idSequence}`
}

/** 归一化磁盘上的一条流水；非法项返回 null（不抛错）。 */
function sanitizeEntry(raw: unknown): RpcOpsJournalEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const accountId = typeof record.accountId === 'string' ? record.accountId.trim() : ''
  const kind = record.kind as RpcOpsKind
  const outcome = record.outcome as RpcOpsJournalEntry['outcome']
  const origin = (record.origin === 'auto' ? 'auto' : 'manual') as RpcOpsOrigin
  if (provider === '' || accountId === '' || !KINDS.has(kind) || !OUTCOMES.has(outcome) || !ORIGINS.has(origin)) return null
  const at = typeof record.at === 'number' && Number.isFinite(record.at) && record.at > 0 ? record.at : 0
  const day = typeof record.day === 'string' && DATE_RE.test(record.day) ? record.day : at > 0 ? utc8DateString(at) : ''
  if (day === '') return null
  const credit = typeof record.credit === 'number' && Number.isFinite(record.credit) && record.credit >= 0 ? record.credit : undefined
  const unit = record.unit === 'token' ? 'token' as const : record.unit === 'credit' ? 'credit' as const : undefined
  return {
    id: typeof record.id === 'string' && record.id !== '' ? record.id : nextId(at, provider, accountId),
    at,
    day,
    kind,
    provider,
    accountId,
    nickname: typeof record.nickname === 'string' && record.nickname !== '' ? record.nickname : accountId,
    outcome,
    message: typeof record.message === 'string' ? record.message.slice(0, 500) : '',
    ...credit === undefined ? {} : { credit },
    ...unit === undefined ? {} : { unit },
    ...typeof record.coversToday === 'boolean' ? { coversToday: record.coversToday } : {},
    origin,
  }
}

/** 去掉超过保留窗口的条目，再按时间排序、裁到条数上限。 */
function trimEntries(entries: RpcOpsJournalEntry[]): RpcOpsJournalEntry[] {
  const cutoff = utc8DateString(Date.now() - (OPS_JOURNAL_MAX_DAYS - 1) * DAY_MS)
  const kept = entries.filter((entry) => entry.day >= cutoff)
  kept.sort((left, right) => left.at - right.at)
  return kept.length > OPS_JOURNAL_MAX_ENTRIES ? kept.slice(kept.length - OPS_JOURNAL_MAX_ENTRIES) : kept
}

/** 把一次领取结果转成逐账号流水（供 `credits.claimAll` 落账）。 */
export function claimJournalEntries(
  provider: string,
  results: readonly RpcCreditsClaimAccountResult[],
  origin: RpcOpsOrigin,
  now: number = Date.now(),
): RpcOpsJournalEntry[] {
  return results.map((row, index) => {
    // 同一批结果共用一个时刻；+index 毫秒只保证页面顺序稳定。
    const at = now + index
    const base: RpcOpsJournalEntry = {
      id: nextId(at, provider, row.accountId),
      at,
      day: utc8DateString(at),
      kind: 'checkin',
      provider,
      accountId: row.accountId,
      nickname: row.nickname === '' ? row.accountId : row.nickname,
      outcome: 'failed',
      message: '',
      origin,
    }
    return { ...base, ...describeOutcome(row.outcome) }
  })
}

/** 把一条 `ClaimOutcome` 映射成流水结局与文案。 */
function describeOutcome(outcome: ClaimOutcome): Pick<RpcOpsJournalEntry, 'outcome' | 'message' | 'credit' | 'unit' | 'coversToday'> {
  switch (outcome.kind) {
    case 'claimed': {
      const unit = claimUnitOf(outcome.unit)
      return {
        outcome: 'ok',
        // `credit` 为 0 也可能是「领取成功但本次 +0」：如实写出来，别伪装成已领。
        message: outcome.credit > 0 ? `+${formatUnitAmount(outcome.credit, unit)}` : '领取成功（+0）',
        credit: outcome.credit,
        unit,
        coversToday: outcome.coversToday !== false,
      }
    }
    case 'already-claimed':
      return {
        outcome: 'already',
        message: outcome.message === '' ? '今天已签到' : outcome.message,
        coversToday: outcome.coversToday !== false,
      }
    case 'inactive':
      return {
        outcome: 'inactive',
        message: outcome.message === '' ? '活动未开启' : outcome.message,
        coversToday: outcome.coversToday !== false,
      }
    case 'failed':
      return {
        outcome: 'failed',
        message: outcome.message === '' ? '领取失败' : outcome.message,
        coversToday: outcome.coversToday !== false,
      }
    default: {
      // 穷尽性兜底：服务端与客户端版本不一致时，未知结局宁可记失败，也不要丢条目。
      const exhaustive: never = outcome
      void exhaustive
      return { outcome: 'failed', message: '未知领取结果', coversToday: false }
    }
  }
}

/** 一条唤醒流水。 */
export function wakeJournalEntry(params: {
  provider: string
  accountId: string
  nickname: string
  ok: boolean
  message?: string
  origin: RpcOpsOrigin
  now?: number
}): RpcOpsJournalEntry {
  const at = params.now ?? Date.now()
  return {
    id: nextId(at, params.provider, params.accountId),
    at,
    day: utc8DateString(at),
    kind: 'wake',
    provider: params.provider,
    accountId: params.accountId,
    nickname: params.nickname === '' ? params.accountId : params.nickname,
    outcome: params.ok ? 'ok' : 'failed',
    message: params.message === undefined || params.message === ''
      ? params.ok ? '凭据已刷新' : '唤醒失败'
      : params.message.slice(0, 500),
    origin: params.origin,
  }
}

/** 流水读写接口。 */
export interface OpsJournalStore {
  readonly kind: 'file' | 'memory'
  /** 当前全部流水（按时间升序；返回副本，调用方改不到内部状态）。 */
  read(): RpcOpsJournalEntry[]
  /** 追加若干条（原子写；失败只告警，不向调用方抛错）。 */
  append(entries: readonly RpcOpsJournalEntry[]): Promise<void>
}

class MemoryOpsJournalStore implements OpsJournalStore {
  readonly kind = 'memory' as const
  private entries: RpcOpsJournalEntry[] = []

  read(): RpcOpsJournalEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  async append(entries: readonly RpcOpsJournalEntry[]): Promise<void> {
    if (entries.length === 0) return
    this.entries = trimEntries([...this.entries, ...entries.map((entry) => ({ ...entry }))])
  }
}

class FileOpsJournalStore implements OpsJournalStore {
  readonly kind = 'file' as const
  private entries: RpcOpsJournalEntry[]
  /** 串行化写入：并发 append 不能各自基于旧快照覆盖对方的条目。 */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {
    this.entries = this.load()
  }

  private load(): RpcOpsJournalEntry[] {
    try {
      if (!existsSync(this.path)) return []
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      const raw = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).entries
        : undefined
      if (!Array.isArray(raw)) return []
      const entries: RpcOpsJournalEntry[] = []
      for (const item of raw) {
        const entry = sanitizeEntry(item)
        if (entry !== null) entries.push(entry)
      }
      return trimEntries(entries)
    } catch (error) {
      // 读不到历史不该让功能不可用：回落空流水，下一次写入会重建文档。
      this.logger?.warn?.(`[channel-pack] 读取 ${this.path} 失败，签到/唤醒流水从空开始: ${String(error)}`)
      return []
    }
  }

  read(): RpcOpsJournalEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  append(entries: readonly RpcOpsJournalEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve()
    const task = async (): Promise<void> => {
      this.entries = trimEntries([...this.entries, ...entries.map((entry) => ({ ...entry }))])
      try {
        mkdirSync(join(this.path, '..'), { recursive: true })
        const tmp = `${this.path}.tmp`
        writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, entries: this.entries }, null, 2), 'utf-8')
        renameSync(tmp, this.path)
      } catch (error) {
        // 观测数据写失败不能反噬签到/唤醒本身；只告警，内存里仍保留这一批。
        this.logger?.warn?.(`[channel-pack] 写入 ${this.path} 失败（本次流水仅存在于内存）: ${String(error)}`)
      }
    }
    this.queue = this.queue.then(task, task)
    return this.queue
  }
}

/** 创建流水后端（home 与账号池 / 自动签到用同一个 `resolveChannelPackHome`）。 */
export function createOpsJournalStore(ctx: Context): OpsJournalStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，签到/唤醒流水仅存在于内存中')
    return new MemoryOpsJournalStore()
  }
  return new FileOpsJournalStore(join(home, 'channel-pack', OPS_JOURNAL_FILE), ctx.logger)
}
