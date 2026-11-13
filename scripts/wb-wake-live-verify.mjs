#!/usr/bin/env node
/**
 * WorkBuddy 唤醒的**真网络**端到端验证（一次性的取证脚本，不进发布套件）。
 *
 * 与 `scripts/channel-pack-test.mjs` 的区别：那个用替身 fetch 验证契约；
 * 这个用**真实凭据 + 真实端点**验证「用户点一键唤醒会发生什么」。
 *
 * 用法（必须先准备好一份 DSH_HOME 副本，避免污染现网凭据）：
 *
 * ```
 * node scripts/wb-wake-live-verify.mjs --home <scratchDir>
 * ```
 *
 * 只对 `provider=workbuddy` 的账号动作，输出全程对令牌 redact。
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const homeFlag = process.argv.indexOf('--home')
if (homeFlag === -1) throw new Error('用法: node scripts/wb-wake-live-verify.mjs --home <scratchDir>')
const scratch = path.resolve(process.argv[homeFlag + 1])
const CRED_FILE = path.join(scratch, '.credentials.yaml')
if (!fs.existsSync(CRED_FILE)) throw new Error(`缺少凭据副本: ${CRED_FILE}`)

const redact = (value) => (typeof value === 'string'
  ? value.replace(/eyJ[A-Za-z0-9_.-]{20,}/g, '<jwt>')
  : value)

/** `.credentials.yaml` 的最小实现（version:1 refs/records）。 */
function readCredentials() {
  const text = fs.readFileSync(CRED_FILE, 'utf8')
  const match = text.match(/^(version: \d+\n(?:refs|records):\n)/)
  if (!match) throw new Error('凭据文件结构不是 version:1 refs/records')
  const header = match[0]
  const records = new Map()
  for (const line of text.slice(header.length).split('\n')) {
    const m = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*): '(.*)'$/)
    if (!m) continue
    records.set(m[1], m[2].replaceAll("''", "'"))
  }
  return { header, records }
}

const store = readCredentials()
function writeCredentials() {
  const lines = [store.header.trimEnd()]
  for (const [ref, raw] of store.records) lines.push(`  ${ref}: '${raw.replaceAll("'", "''")}'`)
  fs.writeFileSync(CRED_FILE, lines.join('\n') + '\n', 'utf8')
}

const services = {
  profileContext: { home: scratch },
  credentials: {
    resolve: async (ref) => {
      const raw = store.records.get(ref)
      return raw === undefined ? undefined : { value: raw }
    },
    describe: async () => undefined,
    set: async (ref, value) => {
      store.records.set(ref, value)
      writeCredentials()
    },
    unset: async (ref) => {
      store.records.delete(ref)
      writeCredentials()
    },
  },
  llm: { registerAdapter() {}, listProviders: () => [] },
  connection: { fetch: { register(route) { this.route = route } } },
}
const routes = []
services.connection.fetch.register = (route) => routes.push(route)
const provided = new Map()
const ctx = {
  ...services,
  logger: { info: (m) => console.log('  [info]', redact(m)), warn: (m) => console.log('  [warn]', redact(m)), error: (m) => console.log('  [error]', redact(m)) },
  get: (name) => services[name],
  provide(name, service) { services[name] = service; this[name] = service },
  effect(callback) { callback() },
  inject(names, callback) { if (names.every((name) => services[name] !== undefined)) callback(this) },
  emit() {},
  /**
   * cordis `Service` 构造时会调 `ctx.reflect.provide(...)` 自动注册自己。
   * 真实宿主由 cordis 提供该反射层；这里给一个最小替身，让 pack 的 10 个
   * Auth service 能正常构造（与 `scripts/channel-pack-test.mjs` 的假 ctx 同思路，
   * 只是那个走 `provide()` 路径、不直接 new Service）。
   */
  reflect: {
    provide(name, instance) { provided.set(name, instance); services[name] = instance },
    get(name) { return provided.get(name) },
  },
}

const pack = await import('../vendor/channel-pack/pack.js')
pack.apply(ctx, { disableOpencode: true })
await new Promise((resolve) => setImmediate(resolve))

const route = routes.find((row) => row.path === '/api/channel-pack')
assert.ok(route, 'channel-pack RPC 路由未注册')
const call = async (method, payload) => {
  const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'live', method: 'channel-pack', payload: { method, payload } }),
  }))
  return (await response.json()).result
}

const accounts = (await call('account.list', { provider: 'workbuddy' })).value.accounts
console.log(`\nWorkBuddy 账号 ${accounts.length} 个（真实端点验证开始）`)
let ok = 0
let failed = 0
for (const account of accounts) {
  const before = JSON.parse(store.records.get(account.credentialRef))
  const beforeToken = typeof before === 'string' ? JSON.parse(before).accessToken : before.accessToken
  const result = await call('account.refresh', { accountId: account.id, origin: 'manual' })
  if (result.ok !== true) {
    failed += 1
    console.log(`- ${account.id} 唤醒失败: ${redact(result.error?.message ?? '')}`)
    continue
  }
  ok += 1
  const afterRaw = store.records.get(account.credentialRef)
  const after = JSON.parse(afterRaw)
  assert.equal(typeof after, 'object', `${account.id}: 唤醒后凭据必须是单层 JSON 对象`)
  const afterToken = after.accessToken
  const desiredNickname = account.nickname
  // 账号池有效期必须与凭据 JWT exp 对齐（容差 1 秒）
  const payloadJson = JSON.parse(Buffer.from(afterToken.split('.')[1], 'base64url').toString('utf8'))
  const expiry = payloadJson.exp * 1000
  console.log(`- ${account.id} (${desiredNickname}) 唤醒成功`
    + ` 凭据${afterToken === beforeToken ? '未轮换（未临期）' : '已轮换'}`
    + ` expiresAt=${new Date(expiry).toISOString()}`)
  const pool = (await call('account.list', { provider: 'workbuddy' })).value.accounts.find((row) => row.id === account.id)
  if (pool?.expiresAt !== undefined && Math.abs(pool.expiresAt - expiry) > 1000) {
    console.log(`  ⚠ 账号池有效期未对齐：${new Date(pool.expiresAt).toISOString()} vs 凭据 ${new Date(expiry).toISOString()}`)
  }
}

// 二次读回：状态端点必须真的返回数据（证明 token 可用）。
const status = await call('credits.status', { provider: 'workbuddy' })
const withStatus = status.value.accounts.filter((row) => row.status !== null)
console.log(`\n签到状态：${withStatus.length}/${status.value.accounts.length} 个账号取到真实状态`)
for (const row of status.value.accounts) {
  console.log(`- ${row.accountId}: ${row.status === null ? '取不到（凭据/网络）' : `streak=${row.status.streakDays} today=${row.status.todayCheckedIn}`}`)
}

const wakeJournal = JSON.parse(fs.readFileSync(path.join(scratch, 'channel-pack', 'ops-journal.json'), 'utf8'))
const wakeRows = (wakeJournal.entries ?? []).filter((row) => row.kind === 'wake' && row.provider === 'workbuddy')
console.log(`\n唤醒流水 ${wakeRows.length} 条：`)
for (const row of wakeRows) console.log(`- ${row.accountId} ${row.outcome} ${redact(row.message)}`)

console.log(`\n结果：成功 ${ok} / 失败 ${failed}`)
if (failed > 0) process.exitCode = 1
