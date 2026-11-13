/**
 * 「一键签到 / 一键唤醒」执行体：并发、5 秒间隔、只重试今天未成功的账号。
 *
 * 时间断言用**真实短间隔**（注入 40ms）而不是 5 秒：被测的是「间隔逻辑」，
 * 不是常量本身；常量另有断言。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ops-runner-'))
process.env.DSH_CHANNEL_PACK_HOME = scratch

const ts = (await import('typescript')).default
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: fileURLToPath(url),
      }).outputText,
    }
    return nextLoad(url, context)
  },
})

const { createOpsRunner, OPS_ACCOUNT_SPACING_MS } = await import('../vendor/channel-pack/src/ops-runner.ts')
const { claimJournalEntries, createOpsJournalStore, wakeJournalEntry } =
  await import('../vendor/channel-pack/src/ops-journal.ts')

let checks = 0
const check = async (name, run) => { await run(); checks++; console.log(`ok   ${name}`) }
const settle = () => new Promise(resolve => setImmediate(resolve))
const SPACING = 40
const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)

/** 构造一个有账号池、流水与动作记录的替身执行体。 */
function harness({ accounts, journal = [], spacingMs = SPACING, actionDelay = 0 } = {}) {
  const state = { calls: [], journal }
  const runner = createOpsRunner({
    accounts: async () => accounts,
    checkin: async (provider, accountId) => {
      state.calls.push({ kind: 'checkin', provider, accountId, at: performance.now() })
      if (actionDelay > 0) await new Promise(resolve => setTimeout(resolve, actionDelay))
      return { outcome: 'ok', message: 'fixture' }
    },
    wake: async (accountId) => {
      const account = accounts.find(row => row.id === accountId)
      state.calls.push({ kind: 'wake', provider: account?.provider ?? '', accountId, at: performance.now() })
      if (actionDelay > 0) await new Promise(resolve => setTimeout(resolve, actionDelay))
      return { outcome: 'ok', message: 'fixture' }
    },
    journal: () => state.journal,
    isCheckinProvider: provider => provider === 'alpha' || provider === 'beta',
    isWakeProvider: provider => provider !== 'opencode',
    spacingMs,
    warn() {},
  })
  return { runner, state }
}

const accounts = [
  { id: 'alpha-1', nickname: 'Alpha 1', provider: 'alpha', enabled: true },
  { id: 'alpha-2', nickname: 'Alpha 2', provider: 'alpha', enabled: true },
  { id: 'alpha-3', nickname: 'Alpha 3', provider: 'alpha', enabled: true },
  { id: 'beta-1', nickname: 'Beta 1', provider: 'beta', enabled: true },
  { id: 'beta-2', nickname: 'Beta 2', provider: 'beta', enabled: true },
  // 无签到能力的平台：不得进入签到计划。
  { id: 'cline-1', nickname: 'Cline 1', provider: 'cline', enabled: true },
  // 唤醒应包含无签到能力的平台，但排除 OpenCode。
  { id: 'opencode-1', nickname: 'OC 1', provider: 'opencode', enabled: true },
]

await check('默认间隔常量为 5 秒', async () => {
  assert.equal(OPS_ACCOUNT_SPACING_MS, 5_000)
})

await check('不同平台并发、同一平台账号间隔 >= 5 秒（注入 40ms 验证逻辑）', async () => {
  const { runner, state } = harness({ accounts, spacingMs: SPACING })
  const reply = await runner.run('checkin')
  assert.equal(reply.started, true)
  assert.equal(reply.status.total, 5, '只有 alpha / beta 的 5 个账号参与签到')
  await runner.whenIdle()
  assert.equal(state.calls.length, 5)
  assert.equal(state.calls.every(call => call.kind === 'checkin'), true, '签到任务必须调签到动作，不能落到唤醒')
  assert.equal(state.calls.some(call => call.provider === 'cline'), false, '无签到能力的平台不参与')
  for (const provider of ['alpha', 'beta']) {
    const times = state.calls.filter(call => call.provider === provider).map(call => call.at)
    assert.equal(times.length, provider === 'alpha' ? 3 : 2)
    for (let index = 1; index < times.length; index += 1) {
      assert.ok(times[index] - times[index - 1] >= SPACING - 5, `${provider} 账号间隔不足：${times[index] - times[index - 1]}ms`)
    }
  }
  const firstAlpha = state.calls.find(call => call.provider === 'alpha').at
  const firstBeta = state.calls.find(call => call.provider === 'beta').at
  assert.ok(Math.abs(firstAlpha - firstBeta) < SPACING, '不同平台的首个账号应并发开始')
  assert.equal(runner.status().running, false)
  assert.equal(runner.status().done, 5)
  assert.equal(runner.status().ok, 5)
})

await check('只重试今天没有成功流水的账号；already 算今天已完成', async () => {
  const day = today()
  const journal = [
    { id: 'j1', at: Date.now(), day, kind: 'checkin', provider: 'alpha', accountId: 'alpha-1', nickname: 'Alpha 1', outcome: 'ok', message: '+1', origin: 'manual' },
    { id: 'j2', at: Date.now(), day, kind: 'checkin', provider: 'alpha', accountId: 'alpha-2', nickname: 'Alpha 2', outcome: 'failed', message: '凭据过期', origin: 'manual' },
    // 「今天已领」但 coversToday=false（Qoder 10:00 刷新前看到的是昨天）：
    // 不算今天成功，必须重试。
    { id: 'j4', at: Date.now(), day, kind: 'checkin', provider: 'beta', accountId: 'beta-1', nickname: 'Beta 1', outcome: 'already', message: '今天已签到', coversToday: false, origin: 'auto' },
  ]
  const { runner, state } = harness({ accounts, journal, spacingMs: 5 })
  const reply = await runner.run('checkin')
  assert.equal(reply.started, true)
  await runner.whenIdle()
  assert.equal(state.calls.every(call => call.kind === 'checkin'), true, '一键签到不得调用唤醒动作')
  assert.deepEqual(state.calls.map(call => call.accountId).sort(), ['alpha-2', 'alpha-3', 'beta-1', 'beta-2'].sort(),
    '失败的 alpha-2 重试；alpha-1 已成功则跳过；coversToday=false 的 beta-1 记录不算成功')
})

await check('唤醒覆盖无需签到的平台并跳过今天已唤醒的账号', async () => {
  const day = today()
  const journal = [
    { id: 'w1', at: Date.now(), day, kind: 'wake', provider: 'alpha', accountId: 'alpha-1', nickname: 'Alpha 1', outcome: 'ok', message: '凭据已刷新', origin: 'manual' },
  ]
  const { runner, state } = harness({ accounts, journal, spacingMs: 5 })
  const reply = await runner.run('wake')
  assert.equal(reply.started, true)
  await runner.whenIdle()
  const ids = state.calls.map(call => call.accountId)
  assert.equal(ids.includes('alpha-1'), false, '今天已唤醒的账号不重复')
  assert.ok(ids.includes('cline-1'), '无签到能力的平台仍应被唤醒')
  assert.equal(ids.includes('opencode-1'), false, 'OpenCode 唤醒没有实现，必须排除')
  assert.equal(state.calls.every(call => call.kind === 'wake'), true)
})

await check('全部已成功时返回 nothing，不产生空任务', async () => {
  const day = today()
  const journal = accounts.filter(row => row.provider !== 'opencode').map((row, index) => ({
    id: `done-${index}`, at: Date.now(), day, kind: 'checkin', provider: row.provider, accountId: row.id,
    nickname: row.nickname, outcome: 'ok', message: '+1', origin: 'manual',
  }))
  const { runner, state } = harness({ accounts, journal })
  const reply = await runner.run('checkin')
  assert.equal(reply.started, false)
  assert.equal(reply.reason, 'nothing')
  assert.equal(state.calls.length, 0)
  assert.equal(reply.status.running, false)
})

await check('已有任务在跑时第二次启动被拒绝（不并发两轮）', async () => {
  const { runner, state } = harness({ accounts, spacingMs: 5, actionDelay: 20 })
  const first = await runner.run('checkin')
  assert.equal(first.started, true)
  const second = await runner.run('checkin')
  assert.equal(second.started, false)
  assert.equal(second.reason, 'running')
  await runner.whenIdle()
  assert.equal(state.calls.length, 5)
})

await check('流水落账：单位、结局、来源与非今日轮次，且可跨实例读回', async () => {
  const ctx = {
    profileContext: { home: scratch },
    logger: { warn() {} },
    get(name) { return name === 'profileContext' ? this.profileContext : undefined },
  }
  const store = createOpsJournalStore(ctx)
  assert.equal(store.read().length, 0, '测试必须写到独立临时目录，不能污染真实 DSH home')
  const entries = claimJournalEntries('qoder', [
    { accountId: 'a1', nickname: 'A1', outcome: { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false } },
    { accountId: 'a2', nickname: 'A2', outcome: { kind: 'already-claimed', message: '今天已签到', coversToday: false } },
    { accountId: 'a3', nickname: 'A3', outcome: { kind: 'failed', code: 1, message: '网络失败' } },
  ], 'manual', Date.now())
  assert.equal(entries[0].outcome, 'ok')
  assert.equal(entries[0].unit, 'credit')
  assert.equal(entries[0].message, '+100积分')
  assert.equal(entries[1].outcome, 'already')
  assert.equal(entries[1].coversToday, false)
  assert.equal(entries[2].outcome, 'failed')
  assert.equal(entries[2].message, '网络失败')
  await store.append([
    ...entries,
    wakeJournalEntry({ provider: 'qoder', accountId: 'a1', nickname: 'A1', ok: true, origin: 'manual' }),
  ])
  assert.equal(store.read().length, 4)
  const reopened = createOpsJournalStore(ctx)
  const back = reopened.read()
  assert.equal(back.length, 4)
  assert.deepEqual(back.map(entry => entry.accountId).sort(), ['a1', 'a1', 'a2', 'a3'])
  const wake = back.find(entry => entry.kind === 'wake')
  assert.equal(wake.accountId, 'a1')
  assert.equal(wake.message, '凭据已刷新')
})

console.log(`\n${checks} 项一键签到/唤醒执行体检查通过`)
fs.rmSync(scratch, { recursive: true, force: true })
