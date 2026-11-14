/**
 * 凭据脚本的端到端回归门（真实事故 2026-11-13：DSH 频繁掉登录）。
 *
 * ## 被锁死的缺陷
 *
 * `scripts/import-wb-pool.mjs` 与 `scripts/repair-wb-credentials.mjs` 曾经
 * 各自手写「两空格 `  KEY: 'value'`」极简解析器 + 全量重写整份
 * `.credentials.yaml`。`records:` 段（**DSH 宿主自己的登录会话**，键形如
 * `deepseek-account-platform/default` + 嵌套 mapping）匹配不上那个正则，
 * 于是被静默丢弃 —— 宿主 watcher 重读后认为没人登录，用户被要求重新登录。
 *
 * 更隐蔽的一点：脚本自己的读回校验只看得到它关心的 WB ref，所以破坏发生时
 * 它照样打印 `persist-ok`。
 *
 * ## 这个套件做什么
 *
 * 在**临时 DSH_HOME** 里放一份结构等价真实文件的凭据文档，然后**真的去跑**
 * 那两个脚本，断言跑完之后 `records:` 段逐字节不变。
 *
 * Run: node scripts/credentials-scripts-test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsDir, '..')

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

/** `records:` 段（宿主登录会话）的字节形态，脚本跑完必须完全不变。 */
const RECORDS_BLOCK = [
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

const header = 'version: 1\nrefs:\n'
const body = [
  `  WORKBUDDY_ACCOUNT_AAAA1111: '{"uid":"aaaa1111-0000-0000-0000-000000000001","accessToken":"a1","refreshToken":"r1","domain":"www.workbuddy.cn"}'`,
  `  WORKBUDDY_ACCOUNT_AAAA1111_DUP: 'placeholder'`,
  `  TRAE_ACCOUNT_CCCC3333: '{"access_token":"t3","refresh_token":"r3"}'`,
  '',
].join('\n')

/**
 * 用户经 DSH 模型设置页保存的模型 API Key。
 *
 * ⚠️ 宿主 `@deepseek-ai/dsh-credentials-local` 用 `yaml` 包的 `document.setIn()`
 * + `toString()` 写它们，落盘形态是**无引号 plain scalar** —— 与插件自己写的
 * 单引号形态不同。2026-11-14 用户重启 DSH 后这些 Key 全丢，就是脚本侧的改写
 * 只认单引号、把它们当「不存在」而重建 refs 段造成的。夹具必须保持宿主那种
 * 真实写法，否则这条回归门挡不住同样的失败。
 */
const HOST_API_KEY_LINES = [
  '  DEEPSEEK_API_KEY: sk-test-fixture-deepseek-key-0000000000',
  '  ZAI_CODING_CN_API_KEY: fixture000000000000000000000000000.zaiTestSuffix0000',
]

const FIXTURE = `${header}${HOST_API_KEY_LINES.join('\n')}\n${body}${RECORDS_BLOCK}`

const CRED_REL = '.credentials.yaml'
const STATE_REL = path.join('channel-pack', 'state.json')

/** 建一个临时 DSH_HOME，写入 fixture 与最小 state.json。 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cred-scripts-'))
  fs.mkdirSync(path.join(home, 'channel-pack'), { recursive: true })
  fs.writeFileSync(path.join(home, CRED_REL), FIXTURE, 'utf8')
  fs.writeFileSync(path.join(home, STATE_REL), JSON.stringify({
    accounts: [],
    disabledModels: {},
    loomyPermanentLocked: false,
    gatewayEnabled: true,
    providerOrder: [],
  }, null, 2), 'utf8')
  return home
}

/** 用临时 DSH_HOME 跑一个脚本，返回 { status, output }。 */
function runScript(script, args, home) {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    // ⚠️ 必须**隔离** DSH_HOME：这个套件绝不能碰真实凭据文件。
    env: { ...process.env, DSH_HOME: home },
    timeout: 120_000,
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** 断言磁盘上的 records: 段与 fixture 完全一致。 */
function assertRecordsIntact(file) {
  const text = fs.readFileSync(file, 'utf8')
  const index = text.indexOf('records:')
  assert.ok(index !== -1, 'records: 段必须仍在文件里')
  assert.equal(text.slice(index), RECORDS_BLOCK, 'records: 段必须逐字节不变')
}

/**
 * 断言模型设置页保存的 API Key 还在，且**写法逐字节未变**。
 *
 * 这条比「contains 一下」严格：宿主认 plain scalar，脚本把它重渲成别的形态
 * （或漏掉）都算回归。
 */
function assertHostApiKeysIntact(file) {
  const text = fs.readFileSync(file, 'utf8')
  for (const line of HOST_API_KEY_LINES) {
    assert.ok(text.includes(`${line}\n`), `模型 API Key 行必须逐字节保留：${line.split(':')[0]}`)
  }
}

// ── repair-wb-credentials.mjs ─────────────────────────────────────────────

check('repair-wb-credentials 干跑不写盘且不动 records:', () => {
  const home = makeHome()
  try {
    const before = fs.readFileSync(path.join(home, CRED_REL), 'utf8')
    const run = runScript('repair-wb-credentials.mjs', ['--dry-run'], home)
    assert.equal(run.status, 0, `脚本失败:\n${run.output}`)
    assert.equal(fs.readFileSync(path.join(home, CRED_REL), 'utf8'), before, '--dry-run 不得写盘')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

check('repair-wb-credentials 实跑保留 records: 段', () => {
  const home = makeHome()
  try {
    const run = runScript('repair-wb-credentials.mjs', [], home)
    assert.equal(run.status, 0, `脚本失败:\n${run.output}`)
    assertRecordsIntact(path.join(home, CRED_REL))
    // 幂等：再跑一次仍不破坏
    const second = runScript('repair-wb-credentials.mjs', [], home)
    assert.equal(second.status, 0, `第二次运行失败:\n${second.output}`)
    assertRecordsIntact(path.join(home, CRED_REL))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

check('repair-wb-credentials 不动模型 API Key（2026-11-14 事故）', () => {
  const home = makeHome()
  try {
    const file = path.join(home, CRED_REL)
    const run = runScript('repair-wb-credentials.mjs', [], home)
    assert.equal(run.status, 0, `脚本失败:\n${run.output}`)
    assertHostApiKeysIntact(file)
    // 幂等路径同样不得动它们
    const second = runScript('repair-wb-credentials.mjs', [], home)
    assert.equal(second.status, 0, `第二次运行失败:\n${second.output}`)
    assertHostApiKeysIntact(file)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

check('repair-wb-credentials 修复双编码且不动 records:', () => {
  const home = makeHome()
  try {
    const file = path.join(home, CRED_REL)
    // 注入历史「双编码」缺陷：值本身是 JSON 文本，又被 stringify 一次。
    const inner = '{"uid":"aaaa1111-0000-0000-0000-000000000001","accessToken":"a1","refreshToken":"r1","domain":"www.workbuddy.cn"}'
    const doubled = JSON.stringify(inner)
    const text = fs.readFileSync(file, 'utf8').replace(
      /^  WORKBUDDY_ACCOUNT_AAAA1111: '.*'$/m,
      `  WORKBUDDY_ACCOUNT_AAAA1111: '${doubled.replaceAll("'", "''")}'`,
    )
    fs.writeFileSync(file, text, 'utf8')
    const run = runScript('repair-wb-credentials.mjs', [], home)
    assert.equal(run.status, 0, `脚本失败:\n${run.output}`)
    assert.match(run.output, /persist-ok/, '修复应当成功')
    assertRecordsIntact(file)
    // 双编码必须真的被修好（解一层即对象）
    const line = fs.readFileSync(file, 'utf8').match(/^  WORKBUDDY_ACCOUNT_AAAA1111: '(.*)'$/m)
    assert.ok(line !== null, 'WB ref 必须仍在')
    const value = JSON.parse(line[1].replaceAll("''", "'"))
    assert.equal(typeof value, 'object', '双编码必须被还原成单层对象')
    assert.equal(value.uid, 'aaaa1111-0000-0000-0000-000000000001')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ── import-wb-pool.mjs ────────────────────────────────────────────────────

check('import-wb-pool 干跑不写盘且不动 records:', () => {
  const home = makeHome()
  try {
    const before = fs.readFileSync(path.join(home, CRED_REL), 'utf8')
    const run = runScript('import-wb-pool.mjs', ['--dry-run'], home)
    assert.equal(run.status, 0, `脚本失败:\n${run.output}`)
    assert.equal(fs.readFileSync(path.join(home, CRED_REL), 'utf8'), before, '--dry-run 不得写盘')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * 实跑写入分支。WB 池在本机存在时才有意义，缺失时脚本会在写入前就停下
 * （`WB_POOL_DIR` 不存在直接抛错），所以这条检查是条件式的。
 */
check('import-wb-pool 实跑保留 records: 段', () => {
  const poolDir = 'E:\\workbuddy\\国产模型中转池\\data\\wb-pool'
  if (!fs.existsSync(poolDir)) {
    console.log('       (跳过：本机没有 WB 池)')
    return
  }
  const home = makeHome()
  try {
    const run = runScript('import-wb-pool.mjs', [], home)
    assert.equal(run.status, 0, `脚本失败:\n${run.output}`)
    assertRecordsIntact(path.join(home, CRED_REL))
    assertHostApiKeysIntact(path.join(home, CRED_REL))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\ncredentials-scripts: all checks passed')
}
