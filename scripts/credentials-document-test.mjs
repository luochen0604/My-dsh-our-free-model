/**
 * 凭据文档读写的回归门（真实事故 2026-11-13：DSH 频繁掉登录）。
 *
 * ## 被锁死的缺陷
 *
 * 几个 WB 脚本各自手写「两空格 `KEY: 'value'`」极简解析器，只能看见 `refs:`，
 * 而 `records:`（DSH 宿主自己的登录会话）是 `  scope/id:` + 嵌套 mapping，
 * 正则匹配不上 → 被静默丢弃 → `serialize()` 整份重写 → **`records:` 段消失**
 * → 宿主 watcher 重读后认为没登录 → 用户被要求重新登录。
 *
 * 本套件用一份结构等价真实文件的 fixture 锁死三件事：
 *
 * 1. 改 `refs:` 时 `records:` 段逐字节保留；
 * 2. 任何会让段/ref 消失的改写都**拒绝落盘**；
 * 3. 值按 JS 类型分派（字符串原样写入），不再制造二次编码。
 *
 * Run: node scripts/credentials-document-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCredentialRefs,
  assertNoCredentialLoss,
  listCredentialRefs,
  parseRefValue,
  readCredentialsDocument,
  rewriteCredentialsFile,
  unquoteYamlSingle,
} from './lib/credentials-document.mjs'

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name} — ${error.message}`)
  }
}

/**
 * 结构等价真实 `~/.dsh/.credentials.yaml` 的最小 fixture：
 * `refs:` 是插件凭据，`records:` 是宿主登录会话（`scope/id` 键 + 嵌套 mapping）。
 */
const FIXTURE = [
  'version: 1',
  'refs:',
  `  WORKBUDDY_ACCOUNT_AAAA1111: '{"uid":"u-1","accessToken":"a1","domain":"www.workbuddy.cn"}'`,
  `  WORKBUDDY_ACCOUNT_BBBB2222: '{"uid":"u-2","accessToken":"a2","domain":"www.workbuddy.cn"}'`,
  `  TRAE_ACCOUNT_CCCC3333: '{"access_token":"t3","refresh_token":"r3"}'`,
  'records:',
  '  deepseek-account-platform/device:',
  '    kind: grant',
  '    payload:',
  '      id: 39ed9a9c-9b10-492a-b04d-195c9c7d411f',
  '  deepseek-account-platform/default:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      token: d3Z9/EIArDyQiCmZuZucFiwPSmj+yJTkYbVXaJA3rLt8BkwGzxMR7GAqfURO4sO/',
  '      issuer: https://platform.deepseek.com',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      token: browser-session-secret',
  '',
].join('\n')

/** 真实文件里 records 段的字节形态（去掉 refs 差异后应逐字节相等）。 */
const RECORDS_BLOCK = FIXTURE.slice(FIXTURE.indexOf('records:'))

check('解析出 3 个 ref，且不把 records 条目误当 ref', () => {
  const refs = listCredentialRefs(FIXTURE)
  assert.deepEqual(refs, ['WORKBUDDY_ACCOUNT_AAAA1111', 'WORKBUDDY_ACCOUNT_BBBB2222', 'TRAE_ACCOUNT_CCCC3333'])
})

check('records: 段被识别为独立段（不是 refs 的一部分）', () => {
  const doc = readCredentialsDocument(FIXTURE)
  assert.ok(doc.sections.has('records'), 'records 段必须被识别')
  assert.equal(doc.sections.has('client-connection/browser-session'), false)
})

check('只改一个 ref：records: 段逐字节保留', () => {
  const next = applyCredentialRefs(FIXTURE, {
    WORKBUDDY_ACCOUNT_AAAA1111: '{"uid":"u-1","accessToken":"rotated"}',
  })
  assert.ok(next.includes('rotated'), '新值必须写入')
  const tail = next.slice(next.indexOf('records:'))
  assert.equal(tail, RECORDS_BLOCK, 'records: 段必须逐字节不变')
  assert.deepEqual(listCredentialRefs(next), listCredentialRefs(FIXTURE), 'ref 集合不得变化')
})

check('新增一个 ref：顺序稳定且 records: 不变', () => {
  const next = applyCredentialRefs(FIXTURE, { WORKBUDDY_ACCOUNT_DDDD4444: '{"uid":"u-4"}' })
  assert.deepEqual(listCredentialRefs(next), [
    'WORKBUDDY_ACCOUNT_AAAA1111',
    'WORKBUDDY_ACCOUNT_BBBB2222',
    'TRAE_ACCOUNT_CCCC3333',
    'WORKBUDDY_ACCOUNT_DDDD4444',
  ])
  assert.equal(next.slice(next.indexOf('records:')), RECORDS_BLOCK)
})

check('字符串值原样写入（不做二次编码）', () => {
  const payload = '{"uid":"u-1","accessToken":"x"}'
  const next = applyCredentialRefs(FIXTURE, { WORKBUDDY_ACCOUNT_AAAA1111: payload })
  const raw = readCredentialsDocument(next).refs.get('WORKBUDDY_ACCOUNT_AAAA1111')
  assert.equal(unquoteYamlSingle(raw), payload, '不得把已是 JSON 文本的值再编码一层')
  assert.equal(parseRefValue(raw).uid, 'u-1')
})

check('对象值被序列化一次', () => {
  const next = applyCredentialRefs(FIXTURE, { WORKBUDDY_ACCOUNT_AAAA1111: { uid: 'u-1', n: 2 } })
  const raw = readCredentialsDocument(next).refs.get('WORKBUDDY_ACCOUNT_AAAA1111')
  assert.deepEqual(parseRefValue(raw), { uid: 'u-1', n: 2 })
})

check("值里含单引号时按 YAML 规则转义并可读回", () => {
  const value = "{\"nickname\":\"O'Brien\"}"
  const next = applyCredentialRefs(FIXTURE, { WORKBUDDY_ACCOUNT_AAAA1111: value })
  const raw = readCredentialsDocument(next).refs.get('WORKBUDDY_ACCOUNT_AAAA1111')
  assert.equal(unquoteYamlSingle(raw), value, '单引号必须转义成两个单引号并能还原')
  assert.equal(parseRefValue(raw).nickname, "O'Brien")
})

check('删除 ref 时其余内容与 records: 不变', () => {
  const next = applyCredentialRefs(FIXTURE, {}, { remove: ['TRAE_ACCOUNT_CCCC3333'] })
  assert.deepEqual(listCredentialRefs(next), ['WORKBUDDY_ACCOUNT_AAAA1111', 'WORKBUDDY_ACCOUNT_BBBB2222'])
  assert.equal(next.slice(next.indexOf('records:')), RECORDS_BLOCK)
})

// ── 负向：自检必须拦下破坏性改写 ───────────────────────────────────────────

check('自检拦下 records: 段消失', () => {
  const broken = applyCredentialRefs(FIXTURE, {}).replace(/^records:\n(?:.*\n)*/m, '')
  assert.throws(() => assertNoCredentialLoss(FIXTURE, broken), /records:/)
})

check('自检拦下 ref 被静默丢弃', () => {
  const broken = applyCredentialRefs(FIXTURE, {}, { remove: ['TRAE_ACCOUNT_CCCC3333'] })
  assert.throws(() => assertNoCredentialLoss(FIXTURE, broken), /TRAE_ACCOUNT_CCCC3333/)
})

check('自检拦下 records: 内容被改写', () => {
  const tampered = FIXTURE.replace('token: browser-session-secret', 'token: CHANGED')
  assert.throws(() => assertNoCredentialLoss(FIXTURE, tampered), /records:/)
})

check('允许显式声明被删除的 ref', () => {
  const broken = applyCredentialRefs(FIXTURE, {}, { remove: ['TRAE_ACCOUNT_CCCC3333'] })
  assertNoCredentialLoss(FIXTURE, broken, { allowedRemovedRefs: ['TRAE_ACCOUNT_CCCC3333'] })
})

// ── 端到端：真实文件路径上的读改写 ────────────────────────────────────────

check('rewriteCredentialsFile 原子写入且保留 records:', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cred-doc-'))
  const file = path.join(dir, '.credentials.yaml')
  try {
    fs.writeFileSync(file, FIXTURE, 'utf8')
    const result = rewriteCredentialsFile(file, (text) => applyCredentialRefs(text, {
      WORKBUDDY_ACCOUNT_AAAA1111: '{"uid":"u-1","accessToken":"fresh"}',
    }))
    assert.equal(result.changed, true)
    const onDisk = fs.readFileSync(file, 'utf8')
    assert.equal(onDisk.slice(onDisk.indexOf('records:')), RECORDS_BLOCK)
    assert.ok(onDisk.includes('fresh'))
    // 幂等：同样的改写再来一次不再变化
    const second = rewriteCredentialsFile(file, (text) => applyCredentialRefs(text, {
      WORKBUDDY_ACCOUNT_AAAA1111: '{"uid":"u-1","accessToken":"fresh"}',
    }))
    assert.equal(second.changed, false)
    // 没有残留临时文件
    assert.deepEqual(fs.readdirSync(dir), ['.credentials.yaml'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('rewriteCredentialsFile 在破坏性改写时不落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cred-doc-'))
  const file = path.join(dir, '.credentials.yaml')
  try {
    fs.writeFileSync(file, FIXTURE, 'utf8')
    assert.throws(
      () => rewriteCredentialsFile(file, (text) => text.replace(/^records:\n(?:.*\n)*/m, '')),
      /records:/,
    )
    assert.equal(fs.readFileSync(file, 'utf8'), FIXTURE, '被拒绝的写入不得改变磁盘文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('结构不符时拒绝解析而不是猜测', () => {
  assert.throws(() => readCredentialsDocument('refs:\n  A: \'x\'\n'), /version:1/)
  assert.throws(() => readCredentialsDocument(''), /version:1/)
})

check('两段共存时保持原段序（不把 refs 强行提到 records 前面）', () => {
  // 历史备份里出现过 `records:` 在前的写法；改写只该动 refs 段，不该重排。
  const recordsFirst = [
    'version: 1',
    'records:',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      token: secret',
    'refs:',
    `  WORKBUDDY_ACCOUNT_AAAA1111: '{"uid":"u-1"}'`,
    '',
  ].join('\n')
  const next = applyCredentialRefs(recordsFirst, { WORKBUDDY_ACCOUNT_BBBB2222: '{"uid":"u-2"}' })
  const order = [...next.matchAll(/^([A-Za-z_][A-Za-z0-9_-]*):$/gm)].map((m) => m[1])
  assert.deepEqual(order, ['records', 'refs'], '段序必须照抄原文件')
  assert.ok(next.includes('token: secret'), '宿主 grant 必须保留')
  assert.deepEqual([...readCredentialsDocument(next).refs.keys()], [
    'WORKBUDDY_ACCOUNT_AAAA1111',
    'WORKBUDDY_ACCOUNT_BBBB2222',
  ])
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\ncredentials-document: all checks passed')
}
