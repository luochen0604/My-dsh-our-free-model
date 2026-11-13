/**
 * 「一键签到 / 一键唤醒」的后台执行体。
 *
 * ## 规则（用户 2026-11 明确要求）
 *
 * - **不同平台并发**：各平台各跑各的，互不等待；
 * - **同一平台账号强制间隔 5 秒**：防集中请求触发风控。间隔按「上一账号动作开始」
 *   到「下一账号动作开始」计算 —— 动作本身超过 5 秒时不再额外等待；
 * - **只重试今天没成功的账号**：判据是流水（`ops-journal`）里今天是否已有成功记录。
 *   手动操作与自动签到写的是同一份流水，所以「今天自动签到过」的账号不会被
 *   一键签到重复打一遍；
 * - **无需签到的平台不参与签到**：Cline / Raccoon / Gemini 没有签到接口，直接排除；
 *   唤醒则覆盖除 OpenCode 外的全部已接入平台（OpenCode 在本宿主被禁用）。
 *
 * ## 为什么签到按「单账号」调 `credits.claimAll`
 *
 * 供应商级接口一次处理该平台全部账号，无法在中途插入 5 秒间隔、也无法逐账号
 * 落流水。这里给 `credits.claimAll` 传 `accountIds: [id]`，逐个账号调用：
 * 间隔与进度都由本执行体控制，流水由 `credits.claimAll` 自己写。
 */

import { utc8DateString } from './auto-checkin.js'
import type {
  RpcOpsJournalEntry,
  RpcOpsKind,
  RpcOpsOutcome,
  RpcOpsProviderProgress,
  RpcOpsRunResponse,
  RpcOpsStatus,
} from './types.js'

/** 同一平台两个账号之间的最小间隔（毫秒）。 */
export const OPS_ACCOUNT_SPACING_MS = 5_000

/** 执行体看到的账号（从账号池派生，不依赖具体 provider 实例）。 */
export interface OpsRunnerAccount {
  id: string
  nickname: string
  provider: string
  enabled: boolean
}

/** 单个账号动作的归一化结果。 */
export interface OpsActionResult {
  outcome: RpcOpsOutcome
  message: string
}

/** 可替换依赖（单测零网络、零真实等待）。 */
export interface OpsRunnerDeps {
  /** 账号池全量账号（含停用账号：手动操作与一键领取同口径）。 */
  accounts(): Promise<readonly OpsRunnerAccount[]>
  /** 给单个账号签到。必须复用 `credits.claimAll` 的 `accountIds` 过滤。 */
  checkin(provider: string, accountId: string): Promise<OpsActionResult>
  /** 唤醒（刷新凭据）单个账号。必须复用 `account.refresh`。 */
  wake(accountId: string): Promise<OpsActionResult>
  /** 当前流水（用于「今天是否已成功」）。 */
  journal(): readonly RpcOpsJournalEntry[]
  /** 该平台是否有签到能力（无签到能力的平台直接跳过，不产生失败流水）。 */
  isCheckinProvider(provider: string): boolean
  /** 该平台是否支持唤醒。 */
  isWakeProvider(provider: string): boolean
  now?(): number
  sleep?(ms: number): Promise<void>
  spacingMs?: number
  warn?(message: string): void
}

/** 后台执行体。 */
export interface OpsRunner {
  /** 实时状态（深拷贝，调用方改不到内部对象）。 */
  status(): RpcOpsStatus
  /** 启动一轮；`total === 0` 时直接回 `nothing`，不产生空任务。 */
  run(kind: RpcOpsKind): Promise<RpcOpsRunResponse>
  /** 等当前任务结束（供单测与卸载路径用）。 */
  whenIdle(): Promise<void>
}

const IDLE_STATUS: RpcOpsStatus = {
  running: false,
  kind: null,
  startedAt: 0,
  finishedAt: 0,
  total: 0,
  done: 0,
  ok: 0,
  skipped: 0,
  failed: 0,
  providers: [],
  message: '',
}

function cloneStatus(status: RpcOpsStatus): RpcOpsStatus {
  return { ...status, providers: status.providers.map((provider) => ({ ...provider })) }
}

interface PlanGroup {
  provider: string
  accounts: OpsRunnerAccount[]
}

interface RunPlan {
  kind: RpcOpsKind
  groups: PlanGroup[]
  total: number
}

/**
 * 今天是否已有成功流水。
 *
 * `coversToday === false`（Qoder 10:00 刷新前看到的「今天已领」其实是昨天的）
 * 不算成功 —— 否则一键签到会跳过当天还没真正领取的账号。
 */
function succeededToday(
  entries: readonly RpcOpsJournalEntry[],
  kind: RpcOpsKind,
  provider: string,
  accountId: string,
  today: string,
): boolean {
  return entries.some((entry) => {
    if (entry.kind !== kind || entry.provider !== provider || entry.accountId !== accountId || entry.day !== today) return false
    if (entry.coversToday === false) return false
    if (entry.outcome === 'ok') return true
    return kind === 'checkin' && entry.outcome === 'already'
  })
}

function finishedMessage(kind: RpcOpsKind, status: RpcOpsStatus): string {
  if (status.total === 0) return kind === 'checkin' ? '今天没有需要签到的账号' : '今天没有需要唤醒的账号'
  const name = kind === 'checkin' ? '签到' : '唤醒'
  const skipped = status.skipped > 0 ? `，${status.skipped} 个跳过` : ''
  return `${name}完成：${status.ok} 个成功，${status.failed} 个失败${skipped}`
}

/** 创建执行体。 */
export function createOpsRunner(deps: OpsRunnerDeps): OpsRunner {
  const now = deps.now ?? (() => Date.now())
  const spacingMs = deps.spacingMs === undefined ? OPS_ACCOUNT_SPACING_MS : Math.max(0, deps.spacingMs)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let status: RpcOpsStatus = cloneStatus(IDLE_STATUS)
  let starting = false
  let inflight: Promise<void> | null = null

  function snapshot(): RpcOpsStatus {
    return cloneStatus(status)
  }

  async function buildPlan(kind: RpcOpsKind): Promise<RunPlan> {
    const today = utc8DateString(now())
    const entries = deps.journal()
    const all = await deps.accounts()
    const providers = [...new Set(all
      .filter((account) => kind === 'checkin' ? deps.isCheckinProvider(account.provider) : deps.isWakeProvider(account.provider))
      .map((account) => account.provider))].sort()
    const groups: PlanGroup[] = []
    for (const provider of providers) {
      const accounts = all.filter((account) => account.provider === provider
        && !succeededToday(entries, kind, provider, account.id, today))
      if (accounts.length > 0) groups.push({ provider, accounts })
    }
    return { kind, groups, total: groups.reduce((sum, group) => sum + group.accounts.length, 0) }
  }

  function publishPlan(plan: RunPlan): void {
    const providers: RpcOpsProviderProgress[] = plan.groups.map((group) => ({
      provider: group.provider,
      total: group.accounts.length,
      done: 0,
      ok: 0,
      skipped: 0,
      failed: 0,
      running: false,
    }))
    status = {
      ...status,
      total: plan.total,
      providers,
      message: plan.kind === 'checkin' ? '签到进行中…' : '唤醒进行中…',
    }
  }

  async function runProvider(group: PlanGroup, kind: RpcOpsKind): Promise<void> {
    const progress = status.providers.find((row) => row.provider === group.provider)
    if (progress === undefined) return
    progress.running = true
    for (let index = 0; index < group.accounts.length; index += 1) {
      const account = group.accounts[index]
      const startedAt = now()
      let result: OpsActionResult
      try {
        result = kind === 'checkin'
          ? await deps.checkin(group.provider, account.id)
          : await deps.wake(account.id)
      } catch (error) {
        result = { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
      progress.done += 1
      status.done += 1
      if (result.outcome === 'ok' || result.outcome === 'already') {
        progress.ok += 1
        status.ok += 1
      } else if (result.outcome === 'inactive') {
        progress.skipped += 1
        status.skipped += 1
      } else {
        progress.failed += 1
        status.failed += 1
      }
      // 间隔按动作**开始**时刻计算：动作本身超过 5 秒时不再补等。
      if (index < group.accounts.length - 1) {
        const remaining = spacingMs - (now() - startedAt)
        if (remaining > 0) await sleep(remaining)
      }
    }
    progress.running = false
  }

  function finish(kind: RpcOpsKind, message?: string): void {
    status = {
      ...status,
      running: false,
      finishedAt: now(),
      done: status.total,
      message: message === undefined ? finishedMessage(kind, status) : message,
      providers: status.providers.map((provider) => ({ ...provider, running: false })),
    }
  }

  async function execute(plan: RunPlan): Promise<void> {
    try {
      await Promise.all(plan.groups.map((group) => runProvider(group, plan.kind)))
      finish(plan.kind)
    } catch (error) {
      deps.warn?.(`[channel-pack] ${plan.kind === 'checkin' ? '签到' : '唤醒'}任务异常: ${String(error)}`)
      finish(plan.kind, `${plan.kind === 'checkin' ? '签到' : '唤醒'}任务异常：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    status: snapshot,
    async run(kind) {
      if (starting || inflight !== null) {
        return { started: false, reason: 'running', status: snapshot() }
      }
      starting = true
      try {
        status = {
          ...cloneStatus(IDLE_STATUS),
          running: true,
          kind,
          startedAt: now(),
          message: '准备账号…',
        }
        let plan: RunPlan
        try {
          plan = await buildPlan(kind)
        } catch (error) {
          finish(kind, `读取账号池失败：${error instanceof Error ? error.message : String(error)}`)
          starting = false
          return { started: false, reason: 'nothing', status: snapshot() }
        }
        publishPlan(plan)
        if (plan.total === 0) {
          finish(kind)
          starting = false
          return { started: false, reason: 'nothing', status: snapshot() }
        }
        inflight = execute(plan).finally(() => { inflight = null })
        starting = false
        return { started: true, reason: 'started', status: snapshot() }
      } finally {
        starting = false
      }
    },
    whenIdle() {
      return inflight ?? Promise.resolve()
    },
  }
}
