#!/usr/bin/env node
/**
 * 验证 WorkBuddy 唤醒的**临期续期分支**在真实端点上真的工作（一次性取证）。
 *
 * 做法：把 scratch 副本里某个账号的 `accessToken` 换成一个**人造的、已临近
 * 过期**的 JWT（续期请求**只**发 `X-Refresh-Token`，不发 `Authorization`，
 * 故 accessToken 的内容不参与续期），`refreshToken` 保持真实值。于是
 * `shouldRefreshNow()` 判为「需要续期」，走真实 `POST /v2/plugin/auth/token/refresh`。
 *
 * 成功后把轮换结果**回写指定的真实凭据文件**（因为 refresh_token 轮换是成对的，
 * 不写回会让原账号的 refresh_token 作废）。
 *
 * ```
 * node scripts/wb-wake-renew-live-verify.mjs --home <scratch> --ref WORKBUDDY_ACCOUNT_XXXX \
 *      [--persist-to <real .credentials.yaml>]
 * ```
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const scratch = path.resolve(arg('home', ''))
const ref = arg('ref', '')
const persistTo = arg('persist-to', '')
if (scratch === '' || ref === '') throw new Error('用法: --home <scratch> --ref <WORKBUDDY_ACCOUNT_…> [--persist-to …]')

const redact = (value) => (typeof value === 'string' ? value.replace(/eyJ[A-Za-z0-9_.-]{20,}/g, '<jwt>') : value)

function readCredentials(file) {
  const text = fs.readFileSync(file, 'utf8')
  const match = text.match(/^(version: \d+\n(?:refs|records):\n)/)
  if (!match) throw new Error(`凭据文件结构不是 version:1 refs/records: ${file}`)
  return { header: match[0], records: text.slice(match[0].length) }
}
const parseLines = (body) => {
  const records = new Map()
  for (const line of body.split('\n')) {
    const m = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*): '(.*)'$/)
    if (!m) continue
    records.set(m[1], m[2].replaceAll("''", "'"))
  }
  return records
}
const serialize = (header, records) => {
  const lines = [header.trimEnd()]
  for (const [name, raw] of records) lines.push(`  ${name}: '${raw.replaceAll("'", "''")}'`)
  return lines.join('\n') + '\n'
}

const credFile = path.join(scratch, '.credentials.yaml')
const parsed = readCredentials(credFile)
const records = parseLines(parsed.records)
const originalRaw = records.get(ref)
assert.ok(originalRaw, `scratch 副本里没有 ${ref}`)
const unimplemented = JSON.parse(originalRaw)
const original = typeof unimplemented === 'string' ? JSON.parse(unimplemented) : unimplemented
assert.ok(typeof original.refreshToken === 'string' && original.refreshToken.length > 0, `${ref} 没有 real refreshToken`)

/** 人造「5 分钟后过期」的 accessToken（payload 无需真实签名：续期请求不带它）。 */
const expiringAccessToken = [
  Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    sub: original.uid, exp: Math.floor(Date.now() / 1000) + 300, jti: 'artificial-expiring',
  })).toString('base64url'),
  'artificial',
].join('.')
records.set(ref, JSON.stringify({ ...original, accessToken: expiringAccessToken }))
fs.writeFileSync(credFile, serialize(parsed.header, records), 'utf8')
console.log(`已将 ${ref} 的 accessToken 替换为「5 分钟后过期」的人造 JWT（refreshToken 保持真实值）`)

// ── 挂载 pack，走真实 RPC ──
const services = {
  profileContext: { home: scratch },
  credentials: {
    resolve: async (name) => {
      const raw = records.get(name)
      return raw === undefined ? undefined : { value: raw }
    },
    describe: async () => undefined,
    set: async (name, value) => {
      records.set(name, value)
      fs.writeFileSync(credFile, serialize(parsed.header, records), 'utf8')
    },
    unset: async (name) => { records.delete(name); fs.writeFileSync(credFile, serialize(parsed.header, records), 'utf8') },
  },
  llm: { registerAdapter() {}, listProviders: () => [] },
  connection: { fetch: { register() {} } },
}
const routes = []
services.connection.fetch.register = (route) => routes.push(route)
const provided = new Map()
const ctx = {
  ...services,
  logger: {
    info: (m) => console.log('  [info]', redact(m)),
    warn: (m) => console.log('  [warn]', redact(m)),
    error: (m) => console.log('  [error]', redact(m)),
  },
  get: (name) => services[name],
  provide(name, service) { services[name] = service; this[name] = service },
  effect(callback) { callback() },
  inject(names, callback) { if (names.every((name) => services[name] !== undefined)) callback(this) },
  emit() {},
  reflect: {
    provide(name, instance) { provided.set(name, instance); services[name] = instance },
    get(name) { return provided.get(name) },
  },
}

const pack = await import('../vendor/channel-pack/pack.js')
pack.apply(ctx, { disableOpencode: true })
await new Promise((resolve) => setImmediate(resolve))
const route = routes.find((row) => row.path === '/api/channel-pack')
assert.ok(route, 'RPC 路由未注册')
const call = async (method, payload) => {
  const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'renew', method: 'channel-pack', payload: { method, payload } }),
  }))
  return (await response.json()).result
}

const accounts = (await call('account.list', { provider: 'workbuddy' })).value.accounts
const account = accounts.find((row) => row.credentialRef === ref)
assert.ok(account, `账号池里没有 credentialRef=${ref} 的条目`)

const beforeExpiry = JSON.parse(Buffer.from(expiringAccessToken.split('.')[1], 'base64url').toString('utf8')).exp * 1000
console.log(`\n唤醒前：${account.id} expiresAt=${new Date(beforeExpiry).toISOString()}（5 分钟后过期 → 应触发真实续期）`)

const result = await call('account.refresh', { accountId: account.id, origin: 'manual' })
assert.equal(result.ok, true, `唤醒失败：${redact(result.error?.message ?? '')}`)

const afterRaw = records.get(ref)
const after = JSON.parse(afterRaw)
assert.equal(typeof after, 'object', '唤醒后凭据必须是单层 JSON 对象')
assert.notEqual(after.accessToken, expiringAccessToken, '临期账号必须真的换了 accessToken')
const afterPayload = JSON.parse(Buffer.from(after.accessToken.split('.')[1], 'base64url').toString('utf8'))
const afterExpiry = afterPayload.exp * 1000
assert.ok(afterExpiry > beforeExpiry + 24 * 3600_000, '续期后有效期必须显著前进（>1 天）')
assert.notEqual(after.refreshToken, original.refreshToken, 'refresh_token 应随续期轮换')
assert.equal(after.uid, original.uid, '续期不得丢失 uid')

const poolAfter = (await call('account.list', { provider: 'workbuddy' })).value.accounts.find((row) => row.id === account.id)
assert.ok(poolAfter?.expiresAt !== undefined, '账号池必须回写 expiresAt')
assert.ok(Math.abs(poolAfter.expiresAt - afterExpiry) <= 1000, `账号池有效期未对齐：${poolAfter.expiresAt} vs ${afterExpiry}`)

console.log(`唤醒后：expiresAt=${new Date(afterExpiry).toISOString()}（前进 ${((afterExpiry - beforeExpiry) / 86400000).toFixed(1)} 天）`)
console.log(`         accessToken 已轮换=${after.accessToken !== expiringAccessToken}`
  + ` refreshToken 已轮换=${after.refreshToken !== original.refreshToken}`
  + ` 账号池已对齐=true`)

const status = await call('credits.status', { provider: 'workbuddy' })
const row = status.value.accounts.find((item) => item.accountId === account.id)
assert.ok(row?.status !== null, '续期后探活必须成功（新 token 可用）')
console.log(`         探活成功：streak=${row.status.streakDays} today=${row.status.todayCheckedIn}`)

if (persistTo !== '') {
  const real = readCredentials(persistTo)
  const realRecords = parseLines(real.records)
  assert.ok(realRecords.has(ref), `真实凭据文件里没有 ${ref}`)
  fs.copyFileSync(persistTo, `${persistTo}.bak-wbrenew-${Date.now()}`)
  realRecords.set(ref, JSON.stringify(after))
  const temp = `${persistTo}.wbrenew-tmp-${process.pid}`
  fs.writeFileSync(temp, serialize(real.header, realRecords), 'utf8')
  fs.renameSync(temp, persistTo)
  const verify = parseLines(readCredentials(persistTo).records).get(ref)
  const verifyParsed = JSON.parse(verify)
  assert.equal(verifyParsed.accessToken, after.accessToken, '回写校验：accessToken 不一致')
  assert.equal(verifyParsed.refreshToken, after.refreshToken, '回写校验：refreshToken 不一致')
  console.log(`\n已把轮换结果回写真实凭据文件（${ref}），读回校验通过。`)
}

console.log('\n真实端点续期验证通过。')
