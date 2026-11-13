/**
 * 设置页「签到与唤醒流水」：渲染、筛选与一键按钮的 UI 回归。
 *
 * 直接挂载真实 `ActivityPage`，RPC 用替身 —— 不碰真实渠道，也不需要浏览器。
 * 本页现在还承载「每日自动签到 / 自动唤醒」的开关（自动与手动同页，2026-11
 * 需求），故 `usage.autoCheckin` / `usage.autoWake` 也要在这里替身。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { ActivityPage,')

const settle = () => new Promise(resolve => setImmediate(resolve))

/** 极简 React：每次 render 重置 hook 游标，effect 由测试手动执行（全部执行）。 */
function mount(rpcImpl) {
  let bundle
  let cursor = 0
  let effects = []
  const cells = []
  const calls = []
  const errors = []
  const window = { __ModuleLoader__: { load: value => { bundle = value } } }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
    useRef(initial) { return cells[cursor++] ??= { current: initial } },
    useEffect(fn) { effects.push(fn) },
    useMemo: factory => factory(),
    useCallback: fn => fn,
  }
  new Function('window', source)(window)
  const { ActivityPage, DICT } = bundle.factory(() => react).__test
  const t = key => {
    const value = DICT.zh[key]
    if (value === undefined) errors.push(`missing copy key ${key}`)
    return value ?? key
  }
  const ctx = {
    connection: {
      rpc: {
        call: async (_api, _pack, request) => {
          calls.push(request)
          try { return { ok: true, value: await rpcImpl(request.method, request.payload) } }
          catch (error) { throw error }
        },
      },
    },
  }
  const props = { t, ctx }
  const render = () => { cursor = 0; effects = []; return ActivityPage(props) }
  /**
   * 执行当前 render 注册的全部 effect（useChannelRpc 的轮询、读流水、自动开关
   * 读取、进行中轮询……顺序无关紧要，替身都是幂等读）。别再依赖固定下标：
   * 页面新增 hook 时下标会漂移。
   */
  const load = async () => {
    const queued = [...effects]
    effects = []
    for (const fn of queued) {
      const cleanup = fn()
      // 轮询类 effect 返回清理函数；替身环境里 interval 不会触发，无需清理，
      // 但 render 前残留的 interval 必须能被下次 render 的卸载逻辑忽略。
      void cleanup
    }
    await settle(); await settle()
  }
  return {
    calls, errors,
    render,
    load,
    text() { return textOf(render()) },
    control(label) { return findControl(render(), label) },
    button(label) { return findControl(render(), label, true) },
    /** 找带 onChange 的开关（自动签到 / 自动唤醒用 label 定位）。 */
    switch(label) { return findSwitch(render(), label) },
  }
}

function textOf(node) {
  const parts = []
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value.children)) value.children.forEach(visit)
  }
  visit(node)
  return parts.join(' ')
}

function findControl(node, label, buttonOnly = false) {
  const all = []
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    if (buttonOnly ? value.props?.onClick : value.props?.onChange) all.push(value)
    if (Array.isArray(value.children)) value.children.forEach(visit)
  }
  visit(node)
  return all.find(value => value.props?.['aria-label'] === label || textOf(value).includes(label))
}

function findSwitch(node, label) {
  const all = []
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    // Switch 组件在测试桩里不展开：元素 props 直接带 `label`（组件内部才映射成
    // aria-label），按 label + onChange 匹配。
    if (value.props?.onChange && value.props?.label === label) all.push(value)
    if (Array.isArray(value.children)) value.children.forEach(visit)
  }
  visit(node)
  return all[0] ?? null
}

const now = Date.now()
const baseStatus = {
  running: false, kind: null, startedAt: 0, finishedAt: 0, total: 0, done: 0,
  ok: 0, skipped: 0, failed: 0, providers: [], message: '',
}
const sample = {
  entries: [
    { id: 'e1', at: now, day: '2026-11-13', kind: 'checkin', provider: 'lobsterai', accountId: 'a1', nickname: '账号一', outcome: 'ok', message: '+100积分', credit: 100, unit: 'credit', origin: 'auto' },
    { id: 'e2', at: now - 1000, day: '2026-11-13', kind: 'wake', provider: 'qoder', accountId: 'a2', nickname: '账号二', outcome: 'failed', message: '凭据过期', origin: 'manual' },
  ],
  days: ['2026-11-13'], providers: ['lobsterai', 'qoder'], total: 2, today: '2026-11-13',
  status: baseStatus,
}
const autoOn = {
  enabled: true, lastDate: '2026-11-13', ranToday: true, running: false,
  lastResult: '4 个渠道：2 个账号领取成功（+200积分）', lastAt: now,
  channels: [
    { provider: 'lobsterai', text: '1 个 +100积分' },
    { provider: 'qoder', text: '1 个 +100积分' },
  ],
  dismissed: false,
}
const autoWakeOff = {
  enabled: false, lastDate: '', ranToday: false, running: false,
  lastResult: '', lastAt: 0, channels: [], dismissed: false,
}
const autoState = (patch = {}) => ({ ...autoOn, ...patch })
const autoWakeState = (patch = {}) => ({ ...autoWakeOff, ...patch })

/** 自动开关的替身：默认签到已启用已跑、唤醒未启用；写入后状态随之变化。 */
function withAuto(autoPatch = {}, wakePatch = {}) {
  const state = { auto: { ...autoState(autoPatch) }, wake: { ...autoWakeState(wakePatch) } }
  return {
    impl(method, body) {
      if (method === 'ops.journal') return sample
      if (method === 'usage.autoCheckin') {
        if (body?.enabled !== undefined) state.auto = { ...state.auto, enabled: body.enabled }
        return { autoCheckin: { ...state.auto } }
      }
      if (method === 'usage.autoWake') {
        if (body?.enabled !== undefined) state.wake = { ...state.wake, enabled: body.enabled }
        return { autoWake: { ...state.wake } }
      }
      throw new Error(`意外 RPC ${method}`)
    },
    state,
  }
}

let checks = 0
const check = async (name, run) => { await run(); checks++; console.log(`ok   ${name}`) }

await check('流水按账号、平台、结局、来源与详情展示', async () => {
  let payload
  const auto = withAuto()
  const app = mount(async (method, body) => {
    payload = body
    return auto.impl(method, body)
  })
  app.render(); await app.load()
  const text = app.text()
  assert.ok(text.includes('LobsterAI'), '平台显示名')
  assert.ok(text.includes('账号一'), '账号昵称')
  assert.ok(text.includes('成功') && text.includes('失败'), '结局')
  assert.ok(text.includes('+100积分') || text.includes('100'), '领取额度')
  assert.ok(text.includes('自动') && text.includes('手动'), '来源')
  assert.ok(text.includes('凭据过期'), '失败详情')
  assert.ok(text.includes('签到') && text.includes('唤醒'), '类型')
  assert.deepEqual(app.errors, [])
  const journalCalls = app.calls.filter(call => call.method === 'ops.journal')
  assert.equal(journalCalls.length, 1, 'journal 只读一次（自动开关读各自的 RPC）')
  assert.deepEqual(journalCalls[0].payload, { limit: 500 }, '未筛选时只带 limit')
})

await check('自动签到 / 自动唤醒开关与状态行渲染在本页', async () => {
  const auto = withAuto()
  const app = mount(auto.impl)
  app.render(); await app.load()
  const text = app.text()
  assert.ok(text.includes('今日已自动签到'), '签到状态')
  assert.ok(text.includes('未启用'), '唤醒默认关闭要如实显示（不写「今日尚未唤醒」）')
  assert.ok(text.includes('上次结果'), '上次结果行')
  assert.ok(text.includes('LobsterAI：1 个 +100积分'), '逐渠道明细')
  const autoSwitch = app.switch('每日自动签到')
  assert.ok(autoSwitch, '自动签到开关必须渲染')
  assert.equal(autoSwitch.props.checked, true, '签到开关随替身状态')
  const wakeSwitch = app.switch('每日自动唤醒')
  assert.ok(wakeSwitch, '自动唤醒开关必须渲染')
  assert.equal(wakeSwitch.props.checked, false, '唤醒开关默认关闭')
})

await check('切换自动唤醒开关会发送 usage.autoWake', async () => {
  const auto = withAuto()
  const app = mount(auto.impl)
  app.render(); await app.load()
  const wakeSwitch = app.switch('每日自动唤醒')
  wakeSwitch.props.onChange()
  await settle(); await settle()
  app.render(); await app.load()
  // 只读轮询（payload={}）与写入（{enabled:…}）混在同一方法里；断言写入那次。
  const write = app.calls.filter(call => call.method === 'usage.autoWake' && call.payload?.enabled !== undefined)
  assert.deepEqual(write.at(-1)?.payload, { enabled: true }, '打开开关 → enabled:true')
  assert.equal(app.switch('每日自动唤醒').props.checked, true, '开关随回执更新')
})

await check('日期与平台筛选会发送给服务端', async () => {
  let payload
  const auto = withAuto()
  const app = mount(async (method, body) => {
    if (method === 'ops.journal') { payload = body; return sample }
    return auto.impl(method, body)
  })
  app.render(); await app.load()
  const providerSelect = app.control('网关平台')
  providerSelect.props.onChange({ target: { value: 'qoder' } })
  app.render(); await app.load()
  assert.equal(payload.provider, 'qoder')
  const dateInput = app.control('日期')
  dateInput.props.onChange({ target: { value: '2026-11-12' } })
  app.render(); await app.load()
  assert.equal(payload.date, '2026-11-12')
  assert.equal(payload.provider, 'qoder')
  const kindSelect = app.control('类型')
  kindSelect.props.onChange({ target: { value: 'wake' } })
  app.render(); await app.load()
  assert.equal(payload.kind, 'wake')
})

await check('一键签到 / 一键唤醒调用 ops.run 并给出结果提示', async () => {
  const runs = []
  let reply = { started: true, reason: 'started', status: { ...baseStatus, running: true, kind: 'checkin', total: 3 } }
  const auto = withAuto()
  const app = mount(async (method, body) => {
    if (method === 'ops.journal') return sample
    if (method === 'ops.run') { runs.push(body); return reply }
    return auto.impl(method, body)
  })
  app.render(); await app.load()
  app.button('一键签到').props.onClick()
  await settle(); await settle()
  assert.deepEqual(runs.at(-1), { kind: 'checkin' })
  app.render()
  assert.ok(app.text().includes('已开始一键签到'), '启动提示')
  reply = { started: false, reason: 'nothing', status: baseStatus }
  app.button('一键唤醒').props.onClick()
  await settle(); await settle()
  assert.deepEqual(runs.at(-1), { kind: 'wake' })
  app.render()
  assert.ok(app.text().includes('今天所有账号都已唤醒成功'), '无账号可唤醒时的提示')
})

await check('进行中的任务显示总数、进度与逐平台明细，且禁用一键按钮', async () => {
  const running = {
    ...sample,
    status: {
      ...baseStatus, running: true, kind: 'checkin', total: 4, done: 1,
      providers: [{ provider: 'lobsterai', total: 2, done: 1, ok: 1, skipped: 0, failed: 0, running: true }],
    },
  }
  const auto = withAuto()
  const app = mount(async (method, body) => {
    if (method === 'ops.journal') return running
    return auto.impl(method, body)
  })
  app.render(); await app.load()
  const text = app.text()
  assert.ok(text.includes('进行中 1/4'), '总进度')
  assert.ok(text.includes('LobsterAI 1/2'), '逐平台进度')
  assert.equal(app.button('一键签到').props.disabled, true)
  assert.equal(app.button('一键唤醒').props.disabled, true)
})

await check('读取失败显示原因而不是空表', async () => {
  const auto = withAuto()
  const app = mount(async (method, body) => {
    if (method === 'ops.journal') throw new Error('rpc-failed')
    return auto.impl(method, body)
  })
  app.render(); await app.load()
  assert.ok(app.text().includes('读取流水失败'), '失败提示')
  assert.ok(app.text().includes('rpc-failed'), '失败原因')
})

console.log(`\n${checks} 项签到/唤醒流水 UI 检查通过`)
// 「自动任务进行中」的 5 秒轮询 interval 在替身环境里没有组件卸载路径，会拖住
// 进程不退出（真实浏览器里随组件卸载清理，无此问题）；断言全过后显式退出。
process.exit(0)
