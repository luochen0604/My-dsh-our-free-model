/**
 * 设置页「签到与唤醒流水」：渲染、筛选与一键按钮的 UI 回归。
 *
 * 直接挂载真实 `ActivityPage`，RPC 用替身 —— 不碰真实渠道，也不需要浏览器。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { ActivityPage,')

const settle = () => new Promise(resolve => setImmediate(resolve))

/** 极简 React：每次 render 重置 hook 游标，effect 由测试手动执行。 */
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
  /** 执行当前 render 的「读取流水」effect（第二个 hook：useChannelRpc 的 effect 在前）。 */
  const load = async () => { effects[1]?.(); await settle(); await settle() }
  return {
    calls, errors,
    render,
    load,
    text() { return textOf(render()) },
    control(label) { return findControl(render(), label) },
    button(label) { return findControl(render(), label, true) },
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

let checks = 0
const check = async (name, run) => { await run(); checks++; console.log(`ok   ${name}`) }

await check('流水按账号、平台、结局、来源与详情展示', async () => {
  let payload
  const app = mount(async (method, body) => {
    payload = body
    if (method === 'ops.journal') return sample
    throw new Error(`意外 RPC ${method}`)
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
  assert.equal(app.calls[0].method, 'ops.journal')
  assert.deepEqual(payload, { limit: 500 }, '未筛选时只带 limit')
})

await check('日期与平台筛选会发送给服务端', async () => {
  let payload
  const app = mount(async (method, body) => {
    if (method === 'ops.journal') { payload = body; return sample }
    throw new Error(`意外 RPC ${method}`)
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
  const app = mount(async (method, body) => {
    if (method === 'ops.journal') return sample
    if (method === 'ops.run') { runs.push(body); return reply }
    throw new Error(`意外 RPC ${method}`)
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
  const app = mount(async method => {
    if (method === 'ops.journal') return running
    throw new Error(`意外 RPC ${method}`)
  })
  app.render(); await app.load()
  const text = app.text()
  assert.ok(text.includes('进行中 1/4'), '总进度')
  assert.ok(text.includes('LobsterAI 1/2'), '逐平台进度')
  assert.equal(app.button('一键签到').props.disabled, true)
  assert.equal(app.button('一键唤醒').props.disabled, true)
})

await check('读取失败显示原因而不是空表', async () => {
  const app = mount(async method => {
    if (method === 'ops.journal') throw new Error('rpc-failed')
    throw new Error(`意外 RPC ${method}`)
  })
  app.render(); await app.load()
  assert.ok(app.text().includes('读取流水失败'), '失败提示')
  assert.ok(app.text().includes('rpc-failed'), '失败原因')
})

console.log(`\n${checks} 项签到/唤醒流水 UI 检查通过`)
