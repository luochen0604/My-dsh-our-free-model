/**
 * 跨天巡检：常驻进程过了零点也要补一轮自动签到。
 *
 * 只测「什么时候该叫 runIfDue」，不碰真实渠道 —— 执行已委派给 ops-runner（见
 * auto-checkin.ts 的文件头），这里用替身 `trigger()` 计数，断言可观测的调用次数。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-checkin-tick-'))
process.env.DSH_CHANNEL_PACK_HOME = scratch

// 用 typescript 的 transpileModule 而不是 Node 内置 strip：后者不支持构造函数参数
// 属性（依赖链里的 channel-pack-store 就用了），会直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
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

const { createAutoSchedule, AUTO_CHECKIN_TICK_MS, AUTO_CHECKIN_RETRY_MS } =
  await import('../vendor/channel-pack/src/auto-checkin.ts')

let checks = 0
const check = async (name, run) => {
  await run()
  checks++
  console.log(`ok   ${name}`)
}

const EMPTY_DOC = () => ({
  enabled: true, lastDate: '', lastResult: '', lastAt: 0,
  channels: [], dismissedRunAt: 0,
})

/** UTC+8 的某个时刻 → 毫秒时间戳（避免手算时区）。 */
const utc8 = (date, hour = 12) => Date.parse(`${date}T00:00:00+08:00`) + hour * 3_600_000

/**
 * 替身执行链：`trigger()` 模拟 opsRunner.run —— 排定任务（startedAt=当前时钟），
 * `whenIdle()` 之后把本轮流水（coversToday 可控）放进 entries。
 */
function harness({ doc = {}, clock = utc8('2026-10-27', 16), coversToday = false, nothing = false } = {}) {
  const state = { clock, triggers: [], providers: ['fixture'], listCalls: 0, listFailure: false, journal: [] }
  const stored = { ...EMPTY_DOC(), ...doc }
  const timers = { start: null, tick: null }
  let runStartedAt = 0
  const checkin = createAutoSchedule({
    store: { load: () => stored, save: value => Object.assign(stored, value) },
    kind: 'checkin',
    now: () => state.clock,
    trigger: async () => {
      state.triggers.push(state.clock)
      if (nothing) return { started: false, reason: 'nothing', startedAt: 0 }
      runStartedAt = state.clock
      return { started: true, reason: 'started', startedAt: runStartedAt }
    },
    whenIdle: async () => {
      // 任务结束时把本轮条目落进流水（时间 = startedAt + 1，保证落进时间窗）。
      if (runStartedAt > 0 && state.journal.length === 0) {
        state.journal.push({
          at: runStartedAt + 1, kind: 'checkin', provider: 'fixture',
          outcome: coversToday ? 'ok' : 'already', message: 'fixture',
          coversToday,
        })
      }
    },
    entries: () => state.journal,
    describeTotals: () => 'fixture 总计',
    describeChannel: () => 'fixture 渠道',
    emptyResultText: 'fixture nothing',
    runLabel: '自动签到',
    listProviderIds: async () => {
      state.listCalls++
      if (state.listFailure) throw new Error('fixture enumeration failed')
      return state.providers
    },
    isExcluded: provider => provider === 'excluded',
    excludedText: '需手动签到',
    delayMs: 0,
    tickMs: 1_000,
    schedule: fn => { timers.start = fn; return { cancel() {} } },
    scheduleTick: (fn, ms) => { timers.tick = { fn, ms, cancelled: false }; return { cancel() { timers.tick.cancelled = true; timers.tick = null } } },
    warn() {},
  })
  return { checkin, stored, timers, state }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

await check('start() 挂上跨天巡检，间隔取自 tickMs', async () => {
  const { checkin, timers } = harness()
  checkin.start()
  assert.ok(timers.tick !== null, 'start() 必须排定巡检')
  assert.equal(timers.tick.ms, 1_000)
  checkin.stop()
})

await check('stop() 取消巡检，不留下悬挂定时器', async () => {
  const { checkin, timers } = harness()
  checkin.start()
  const scheduled = timers.tick
  checkin.stop()
  assert.equal(scheduled.cancelled, true, 'stop() 必须真的取消巡检')
  assert.equal(timers.tick, null)
})

await check('tickMs=0 时不排巡检（宿主不需要常驻）', async () => {
  let scheduled = null
  const checkin = createAutoSchedule({
    store: { load: EMPTY_DOC, save() {} },
    kind: 'checkin',
    now: () => utc8('2026-10-27'),
    trigger: async () => ({ started: false, reason: 'nothing', startedAt: 0 }),
    whenIdle: async () => {},
    entries: () => [],
    describeTotals: () => '', describeChannel: () => '',
    emptyResultText: '', runLabel: '自动签到',
    delayMs: 0, tickMs: 0,
    schedule: () => ({ cancel() {} }),
    scheduleTick: fn => { scheduled = fn; return { cancel() {} } },
    warn() {},
  })
  checkin.start()
  assert.equal(scheduled, null, 'tickMs=0 表示关闭巡检')
  checkin.stop()
})

await check('今天已经跑成过 → 巡检不重复触发', async () => {
  const { checkin, timers, state } = harness({
    doc: { lastDate: '2026-10-27', lastAt: utc8('2026-10-27', 9) },
    clock: utc8('2026-10-27', 16),
  })
  checkin.start()
  state.clock = utc8('2026-10-27', 20)
  timers.tick.fn()
  await settle()
  assert.deepEqual(state.triggers, [], '当天已成功，巡检不得再触发')
  checkin.stop()
})

await check('跨天后巡检补跑一轮', async () => {
  const { checkin, timers, state } = harness({
    doc: { lastDate: '2026-10-26', lastAt: utc8('2026-10-26', 9) },
    clock: utc8('2026-10-27', 1),
  })
  checkin.start()
  state.clock = utc8('2026-10-28', 1)
  timers.tick.fn()
  await settle()
  assert.equal(state.triggers.length, 1, '进入新的一天后必须补跑')
  checkin.stop()
})

await check('今天试过但本轮没证明「今天已处理」→ 退避期内不再触发', async () => {
  const start = utc8('2026-10-27', 9)
  const { checkin, timers, state } = harness({ clock: start, coversToday: false })
  checkin.start()
  await settle()
  // start() 的 delayMs=0 立刻跑了一轮；coversToday=false ⇒ 不记 lastDate，
  // lastAt 停在 09:00 —— 正是「今天试过但失败」的形态。
  assert.equal(state.triggers.length, 1, '前提：已经试过一轮')
  state.clock = start + 10 * 60_000
  timers.tick.fn()
  await settle()
  assert.equal(state.triggers.length, 1, '退避期内（<1h）不应重试')
  checkin.stop()
})

await check('过了退避下限 → 巡检允许重试', async () => {
  const start = utc8('2026-10-27', 9)
  const { checkin, timers, state } = harness({ clock: start, coversToday: false })
  checkin.start()
  await settle()
  const tried = state.triggers.length
  state.clock = start + AUTO_CHECKIN_RETRY_MS + 60_000
  timers.tick.fn()
  await settle()
  assert.equal(state.triggers.length, tried + 1, '超过 1 小时后应允许重试')
  checkin.stop()
})

await check('关闭自动签到时巡检不触发，重新启用后正常执行', async () => {
  const { checkin, timers, state } = harness({ doc: { enabled: false } })
  checkin.start()
  timers.tick.fn()
  await settle()
  assert.equal(state.listCalls, 0)
  await checkin.setEnabled(true)
  assert.equal(state.triggers.length, 1)
  checkin.stop()
})

await check('本轮流水证明「今天已处理」→ 记日期 + 逐渠道状态', async () => {
  const { checkin, stored } = harness({ coversToday: true })
  checkin.start()
  await settle()
  await checkin.runIfDue()
  await settle()
  assert.equal(stored.lastDate, '2026-10-27', 'coversToday=true 的轮次要记日期')
  assert.equal(stored.channels.length, 1)
  assert.equal(stored.channels[0].provider, 'fixture')
})

await check('nothing 回执（流水已证明全部完成）→ 记日期，不再空跑', async () => {
  const { checkin, stored, state } = harness({ nothing: true })
  checkin.start()
  await settle()
  await checkin.runIfDue()
  await settle()
  assert.equal(state.triggers.length, 1, 'nothing 仍然发起了一次 trigger（由 ops-runner 判定无事可做）')
  assert.equal(stored.lastDate, '2026-10-27', '必须记日期，否则每天反复空跑')
  assert.equal(stored.lastResult, 'fixture nothing')
  assert.deepEqual(stored.channels, [])
})

await check('渠道枚举异常也受退避保护，不因未落盘结果而反复重试', async () => {
  const start = utc8('2026-10-27', 9)
  const { checkin, timers, state } = harness({ clock: start, coversToday: false })
  state.listFailure = true
  checkin.start()
  await settle()
  assert.equal(state.listCalls, 1)
  state.clock = start + 10 * 60_000
  timers.tick.fn()
  await settle()
  assert.equal(state.listCalls, 1, '退避期内不重试（枚举只在收账提示行用，失败不影响记账）')
  state.clock = start + AUTO_CHECKIN_RETRY_MS
  timers.tick.fn()
  await settle()
  assert.equal(state.triggers.length, 2)
  checkin.stop()
})

await check('排除渠道只出提示行，不进入记账', async () => {
  const start = utc8('2026-10-27', 9)
  const { checkin, stored, state } = harness({ clock: start, coversToday: true })
  state.providers = ['fixture', 'excluded']
  checkin.start()
  await settle()
  await checkin.runIfDue()
  await settle()
  assert.equal(stored.lastDate, '2026-10-27')
  const excludedRow = stored.channels.find(row => row.provider === 'excluded')
  assert.ok(excludedRow, '排除渠道必须有一行提示')
  assert.equal(excludedRow.text, '需手动签到')
})

await check('默认常量符合设计（巡检 2.5h、退避 1h）', async () => {
  assert.equal(AUTO_CHECKIN_TICK_MS, 150 * 60 * 1000)
  assert.equal(AUTO_CHECKIN_RETRY_MS, 60 * 60 * 1000)
})

console.log(`\n${checks} 项跨天巡检检查通过`)
fs.rmSync(scratch, { recursive: true, force: true })
