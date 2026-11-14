#!/usr/bin/env node
/**
 * 把网关中转池里存活的 WPS（灵犀 / lingxi）账号导入 OFM 账号池。
 *
 * ## 用法
 *
 * ```
 * node scripts/import-wps-pool.mjs --dry-run   # 只读源池 + 网络探活，不写盘
 * node scripts/import-wps-pool.mjs             # 真正写入（先备份，幂等可重跑）
 * ```
 *
 * ## 写入目标
 *
 * - 账号条目：`$DSH_HOME/channel-pack/state.json` 的 `accounts`（provider=lingxi，
 *   与 `vendor/channel-pack/src/channel-pack-store.ts` 的
 *   `REF_PREFIX_TO_PROVIDER` 里 `['LINGXI','lingxi']` 一致）
 * - 凭据：`$DSH_HOME/.credentials.yaml` 的 `refs.LINGXI_ACCOUNT_xxxxxxxx`
 *   （值是按 `LingxiCredential` 字段名逐字复制的 JSON 字符串：
 *   `uid` / `wpsSid` / `cookie` / `nickname`，见 `vendor/channel-pack/src/wps-credits.ts`）
 *
 * ## 导入第一步：wpsAuthCheck 探活
 *
 * 与 `wps-credits.ts` 的 `wpsAuthCheck()` 同一请求（POST
 * `https://account.kdocs.cn/p/auth/check`，Cookie 走 wpsSid）：sid 无效的账号
 * 当场拒绝，绝不写入凭据已死的条目。
 *
 * ## 幂等
 *
 * - 账号 id = `lingxi-<uid>`（uid 是数字串，直接全量可读）；已存在同 id 条目则跳过。
 * - credentialRef 后缀 = sha256(uid) 前 8 位大写 HEX（确定性，不随机），
 *   重跑生成同一个 ref，凭据按 ref 覆盖更新，不膨胀。
 * - `expiresAt` 刻意**不写**：`wps_sid` 无 set-cookie 轮换、稳定不失效
 *   （wps-credits.ts 文件头），没有可信的过期时刻 —— 与 zcode 静态凭据同型。
 * - `refreshable: true`：`account.refresh` 对 lingxi 有探活式唤醒分支
 *   （channel-pack-rpc.ts 的 `case LINGXI_ID`），参与一键/自动唤醒。
 *
 * ## ⚠️ DSH 运行时与固化
 *
 * DSH 宿主运行时会持有凭据/状态的内存副本，导入后它的一次整体重写可能把
 * 新账号冲掉（脚本会在写入后 3 秒做二次读回并报 `persist-ok` / `persist-lost`）。
 * **若报 `persist-lost`：关闭 DSH 后重跑本脚本即可固化**（重跑无副作用）。
 * 关闭 DSH 时运行是写入的最佳时机。
 *
 * ## ⚠️ 凭据文档读写只走共享模块（真实事故 2026-11-13 / 2026-11-14）
 *
 * `.credentials.yaml` 的 `records:` 段是 **DSH 宿主自己的登录会话**；任何
 * 「按自己解析结果重建整份文件」的写法都会把它（或宿主写的 plain scalar
 * 模型 API Key）静默删掉。本脚本**只**通过
 * `scripts/lib/credentials-document.mjs` 改写点名的 ref：其余内容逐字节保留，
 * 落盘前 `assertNoCredentialLoss()` 强制自检（段集合 / ref 集合 / 无法解析行 /
 * records: 逐字节），不过就抛错不落盘。脚本自身再补一层 records: 段字节比对，
 * 双保险。
 *
 * ## 安全
 *
 * - wpsSid / cookie 只写进 `$DSH_HOME` 的凭据文件，绝不进仓库任何文件。
 * - 所有输出对 wpsSid / cookie 做 redact。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  applyCredentialRefs,
  readCredentialsDocument,
  rewriteCredentialsFile,
} from './lib/credentials-document.mjs'

const DRY_RUN = process.argv.includes('--dry-run')

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'channel-pack', 'state.json')
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml')
const WPS_POOL_DIR = 'E:\\workbuddy\\国产模型中转池\\data\\lingxi-pool'

const PROVIDER = 'lingxi'
const LINGXI_BALANCE_URL = 'https://lingxi.kdocs.cn/api/public/v1/credits/balance'
const WPS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const redact = (value) => {
  if (typeof value !== 'string' || value.length === 0) return '<empty>'
  return value.length <= 8 ? '<redacted>' : `${value.slice(0, 4)}…<redacted len=${value.length}>`
}

/** DSH 宿主是否正在运行（进程名 DeepSeek Harness）。 */
function dshRunning() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      '(Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Measure-Object).Count',
    ], { encoding: 'utf8', timeout: 20000 })
    return Number.parseInt(out.trim(), 10) > 0
  } catch {
    return null // 探测失败：按「未知」处理，不阻塞导入
  }
}

/** 读取 WPS 池，过滤存活账号；结构异常时停下报错。 */
function loadAliveAccounts() {
  if (!fs.existsSync(WPS_POOL_DIR)) {
    throw new Error(`WPS 池目录不存在: ${WPS_POOL_DIR}`)
  }
  const files = fs.readdirSync(WPS_POOL_DIR).filter((name) => name.endsWith('.json'))
  const alive = []
  const dead = []
  for (const name of files) {
    const file = path.join(WPS_POOL_DIR, name)
    const account = JSON.parse(fs.readFileSync(file, 'utf8'))
    // 结构哨兵：与 2026-11-14 实测的结构不符就停下来，不要猜。
    const required = ['uid', 'wpsSid', 'cookie', 'nickname', 'enabled', 'dead']
    for (const key of required) {
      if (!(key in account)) throw new Error(`${name} 缺少字段 ${key}，池结构可能与预期不符，停止导入`)
    }
    if (String(account.uid) + '.json' !== name) {
      throw new Error(`${name} 的 uid=${account.uid} 与文件名不符，停止导入`)
    }
    if (typeof account.wpsSid !== 'string' || account.wpsSid.length === 0) {
      throw new Error(`${name} 的 wpsSid 为空，停止导入`)
    }
    if (account.dead === true || account.enabled === false) {
      dead.push(account.uid)
      continue
    }
    alive.push(account)
  }
  return { alive, dead, total: files.length }
}

/**
 * 导入第一步探活：GET `lingxi.kdocs.cn/api/public/v1/credits/balance`。
 *
 * ⚠️ 为什么不用 `wpsAuthCheck()`（`account.kdocs.cn/p/auth/check`）：
 * 2026-11-14 实测，该端点带**有效** cookie 也回 403 `csrfRequire`（0x00018，
 * 「非法访问」）—— 它是浏览器侧端点，需要脚本无法复制的 CSRF 上下文，把它当
 * 探活会把所有好账号全部拒掉（task-9 计划原本写它，dry-run 实测后换掉）。
 *
 * 改用唤醒流程的另一半：`account.refresh` 的 `case LINGXI_ID`
 * （channel-pack-rpc.ts）本来就是「探活 = auth/check **或读一次 balance**」，
 * 余额接口是纯 GET、无 CSRF 要求、与 `fetchLingxiBalance()` 同一请求形状
 * （lingxiHeaders：Cookie + Origin + Referer）。返回 200 且 body 可解析即视为
 * sid 活着；401/403 或网络失败一律拒绝导入。
 */
async function wpsAuthCheck(account) {
  const cookie = account.cookie?.length ? account.cookie : `wps_sid=${account.wpsSid}; wpsclient=true`
  try {
    const response = await fetch(LINGXI_BALANCE_URL, {
      method: 'GET',
      headers: {
        'User-Agent': WPS_USER_AGENT,
        Cookie: cookie,
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://lingxi.kdocs.cn',
        Referer: 'https://lingxi.kdocs.cn/',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return null
    const text = await response.text()
    try {
      const body = JSON.parse(text)
      return typeof body === 'object' && body !== null ? { userId: String(account.uid) } : null
    } catch {
      return null // 非 JSON（HTML 错误页）＝风控或失效
    }
  } catch {
    return null
  }
}

/** 确定性 credentialRef：LINGXI_ACCOUNT_<sha256(uid) 前 8 位大写 HEX>。 */
function credentialRefFor(uid) {
  const suffix = crypto.createHash('sha256').update(uid, 'utf8').digest('hex')
    .slice(0, 8).toUpperCase()
  return `LINGXI_ACCOUNT_${suffix}`
}

/** 待写入的账号条目（字段名对齐 state.json 现有条目）。 */
function buildAccountEntry(account) {
  const nickname = typeof account.nickname === 'string' && account.nickname.length > 0
    ? account.nickname
    : `lingxi-${account.uid}`
  return {
    id: `${PROVIDER}-${account.uid}`,
    provider: PROVIDER,
    nickname: `WPS-${nickname}`,
    enabled: true,
    credentialRef: credentialRefFor(account.uid),
    refreshable: true,
    createdAt: Date.now(),
    // 刻意不带 expiresAt：wps_sid 稳定不失效，没有可信的过期时刻（见文件头）。
  }
}

/** 待写入的凭据 JSON（字段名严格对齐 LingxiCredential）。 */
function buildCredentialJson(account) {
  return JSON.stringify({
    uid: String(account.uid),
    wpsSid: account.wpsSid,
    cookie: account.cookie,
    nickname: account.nickname ?? '',
  })
}

/** 带时间戳的备份文件路径。 */
function backupPath(file) {
  const stamp = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 17) // yyyyMMddHHmmssSSS
  return `${file}.bak-wpsimport-${stamp}`
}

function backup(file) {
  const target = backupPath(file)
  fs.copyFileSync(file, target)
  return target
}

/**
 * 抽取 `records:` 段的逐字节形态（含段头到文件尾）。宿主登录会话就在这里，
 * 写入前后必须完全一致 —— 共享模块的 `assertNoCredentialLoss` 已有同一判据，
 * 这里再显式比一次作为第二道保险。
 */
function recordsBlockOf(text) {
  const index = text.indexOf('records:')
  if (index === -1) return undefined
  return text.slice(index)
}

/** records: 段的 sha256（写入前后各打一次，留事故证据）。 */
function recordsHashOf(text) {
  const block = recordsBlockOf(text)
  if (block === undefined) return '<records: 段不存在>'
  return crypto.createHash('sha256').update(block, 'utf8').digest('hex')
}

/** 只改点名的 ref；records: 与其余内容逐字节保留，落盘前双重自检。 */
function writeCredentialRefs(file, updates) {
  const before = fs.readFileSync(file, 'utf8')
  const recordsBefore = recordsBlockOf(before)
  const result = rewriteCredentialsFile(file, (text) => applyCredentialRefs(text, updates))
  const recordsAfter = recordsBlockOf(result.after)
  if (recordsBefore !== recordsAfter) {
    throw new Error('拒绝写入：records: 段（DSH 宿主登录会话）字节形态发生了变化（第二道自检）')
  }
  return result
}

/** 读回校验：N 条账号 + N 条凭据 ref 都在。 */
function verify(alive, refNames) {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const accounts = (state.accounts ?? []).filter(
    (entry) => entry.provider === PROVIDER && alive.some((a) => String(a.uid) === entry.id.replace(`${PROVIDER}-`, '')),
  )
  const doc = readCredentialsDocument(fs.readFileSync(CRED_FILE, 'utf8'))
  const creds = refNames.filter((ref) => doc.refs.has(ref))
  return { accountsFound: accounts.length, credsFound: creds.length }
}

async function main() {
  const { alive, dead, total } = loadAliveAccounts()
  console.log(`WPS 池共 ${total} 个文件；存活 ${alive.length} 个，跳过 dead/disabled ${dead.length} 个`)

  // ── 导入第一步：逐账号 wpsAuthCheck 探活，sid 无效立即拒绝 ──
  const checked = []
  for (const account of alive) {
    const probe = await wpsAuthCheck(account)
    if (probe === null) {
      throw new Error(`uid=${account.uid}（${account.nickname}）auth/check 探活失败：sid 无效或网络异常，拒绝导入（宁可少导也不写死凭据）`)
    }
    checked.push(account)
  }
  console.log(`探活通过 ${checked.length}/${alive.length} 个账号`)

  const planned = checked.map((account) => ({ account, entry: buildAccountEntry(account) }))
  for (const { account, entry } of planned) {
    const credential = JSON.parse(buildCredentialJson(account))
    console.log(`- ${entry.id} provider=${entry.provider} nickname=${entry.nickname} `
      + `credentialRef=${entry.credentialRef} wpsSid=${redact(credential.wpsSid)} `
      + `cookie=${redact(credential.cookie)}（expiresAt 不写：wps_sid 稳定不失效）`)
  }

  const running = dshRunning()
  if (running === true) {
    console.log('注意：DSH 正在运行，导入后需重启 DSH 才会加载新账号')
  } else if (running === false) {
    console.log('DSH 未运行，这是写入的最佳时机')
  } else {
    console.log('DSH 进程探测失败（不影响导入，但固化状态请以写后校验为准）')
  }

  if (DRY_RUN) {
    console.log('dry-run：凭据写入计划 = 走 scripts/lib/credentials-document.mjs 的 '
      + 'rewriteCredentialsFile(applyCredentialRefs) 只改上面这些 LINGXI_ACCOUNT_* ref；'
      + '落盘前 assertNoCredentialLoss() + records: 段逐字节比对双重自检；'
      + 'state.json 读→改→整体写回（保留全部其它键）+ 原子替换。未做任何写盘。')
    return
  }

  if (!fs.existsSync(STATE_FILE)) throw new Error(`state.json 不存在: ${STATE_FILE}`)
  if (!fs.existsSync(CRED_FILE)) throw new Error(`凭据文件不存在: ${CRED_FILE}`)

  const stateBackup = backup(STATE_FILE)
  const credBackup = backup(CRED_FILE)
  console.log(`已备份: ${stateBackup}`)
  console.log(`已备份: ${credBackup}`)

  const refNames = planned.map(({ entry }) => entry.credentialRef)

  // ── 写 state.json（读→改→整体写回，保留全部其它键） ──
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const accounts = state.accounts ?? []
  const existing = new Set(accounts.map((entry) => entry.id))
  let addedAccounts = 0
  for (const { entry } of planned) {
    if (existing.has(entry.id)) {
      console.log(`跳过已有账号 ${entry.id}（幂等）`)
      continue
    }
    accounts.push(entry)
    addedAccounts++
  }
  state.accounts = accounts
  {
    const temp = `${STATE_FILE}.wpsimport-tmp-${process.pid}`
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    fs.renameSync(temp, STATE_FILE)
  }

  // ── 写凭据：只改这些 ref；records:（宿主登录会话）逐字节保留 ──
  const updates = {}
  for (const { account, entry } of planned) {
    updates[entry.credentialRef] = buildCredentialJson(account)
  }
  const beforeText = fs.readFileSync(CRED_FILE, 'utf8')
  const recordsHashBefore = recordsHashOf(beforeText)
  console.log(`records: 段 sha256（写入前）= ${recordsHashBefore}`)
  writeCredentialRefs(CRED_FILE, updates)
  const afterText = fs.readFileSync(CRED_FILE, 'utf8')
  const recordsHashAfter = recordsHashOf(afterText)
  console.log(`records: 段 sha256（写入后）= ${recordsHashAfter}`)
  console.log(`已写入账号 ${addedAccounts} 条（跳过 ${planned.length - addedAccounts}），凭据 ${Object.keys(updates).length} 条`)

  // ── 二次读回 + 3 秒存活窗口 ──
  const first = verify(checked, refNames)
  console.log(`写后立即读回: state 账号 ${first.accountsFound}/${checked.length}，凭据 ref ${first.credsFound}/${refNames.length}`)

  const waitMs = 3000
  console.log(`等待 ${waitMs}ms 做存活窗口检查（宿主可能在此期间整体重写）…`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
  const second = verify(checked, refNames)
  console.log(`3 秒后读回: state 账号 ${second.accountsFound}/${checked.length}，凭据 ref ${second.credsFound}/${refNames.length}`)

  const ok = second.accountsFound === checked.length && second.credsFound === refNames.length
  console.log(ok ? 'persist-ok' : 'persist-lost')

  // ── getCredential 等价验证：按 ref 读回凭据并按 LingxiCredential 字段校验 ──
  const docAfter = readCredentialsDocument(fs.readFileSync(CRED_FILE, 'utf8'))
  for (const { entry } of planned) {
    const raw = docAfter.refs.get(entry.credentialRef)
    if (raw === undefined) {
      console.log(`凭据验证 ${entry.credentialRef}: MISSING`)
      continue
    }
    // doc.refs 的值已解过 YAML 引号，这里只解一层 JSON（与 parseRefValue 同款）。
    let credential
    try {
      credential = JSON.parse(raw)
    } catch {
      credential = undefined
    }
    const fieldsOk = credential !== undefined
      && typeof credential.uid === 'string' && credential.uid.length > 0
      && typeof credential.wpsSid === 'string' && credential.wpsSid.length > 0
    console.log(`凭据验证 ${entry.credentialRef}: ${fieldsOk ? 'OK' : 'MALFORMED'} `
      + `uid=${credential?.uid} wpsSid=${redact(credential?.wpsSid)}`)
  }

  // ── 反向验证：readCredentialsDocument 重新解析整份文件，打印三个数字 ──
  {
    const docReparse = readCredentialsDocument(afterText)
    const lingxiRefs = [...docReparse.refs.keys()].filter((ref) => ref.startsWith('LINGXI_ACCOUNT_'))
    const recordsEntryCount = docReparse.sections.get('records')?.lines
      .filter((line) => /^  [A-Za-z][^:]*:/.test(line)).length ?? 0
    const refsTotal = docReparse.refs.size
    console.log(`反向验证: LINGXI_ACCOUNT_* refs = ${lingxiRefs.length}/${refNames.length}，`
      + `records: 条目数 = ${recordsEntryCount}，refs 总数 = ${refsTotal}（写入前 ${readCredentialsDocument(beforeText).refs.size}）`)
    if (lingxiRefs.length !== refNames.length) {
      console.error('严重：重新解析后 LINGXI_ACCOUNT_* ref 数量不符，请立即检查。')
      process.exitCode = 3
      return
    }
  }

  // ── 事后审计：按 ref 前缀统计（下一次事故的基线） ──
  {
    const docAudit = readCredentialsDocument(afterText)
    const byPrefix = new Map()
    for (const ref of docAudit.refs.keys()) {
      const prefix = ref.slice(0, ref.indexOf('_ACCOUNT_')) || ref
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1)
    }
    const sorted = [...byPrefix.entries()].sort(([a], [b]) => a.localeCompare(b))
    console.log('凭据前缀审计（事后基线）:')
    for (const [prefix, count] of sorted) {
      console.log(`  ${prefix}${prefix.endsWith('_ACCOUNT_') ? '' : ''} × ${count}`)
    }
  }

  // ── records: 段最终校验：与写入前完全一致 ──
  const recordsIntact = recordsHashBefore === recordsHashAfter
  console.log(`records: 段（DSH 登录会话）逐字节未变: ${recordsIntact ? 'YES' : 'NO'}`)
  if (!recordsIntact) {
    console.error('严重：records: 段被改变 —— 共享模块自检与第二道比对都应拦下这种情况，请立即把备份还原并报告。')
    process.exitCode = 3
    return
  }

  if (!ok) {
    console.log('\npersist-lost：DSH 宿主把写入冲掉了。请关闭 DSH 后重跑本脚本（幂等，重跑无副作用）即可固化。')
    process.exitCode = 2
  }
}

main().catch((error) => {
  console.error(`导入失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
