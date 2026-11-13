#!/usr/bin/env node
/**
 * 把网关中转池里存活的 WorkBuddy（WB）账号导入 OFM 账号池。
 *
 * ## 用法
 *
 * ```
 * node scripts/import-wb-pool.mjs --dry-run   # 只读源池，打印将要写入的内容
 * node scripts/import-wb-pool.mjs             # 真正写入（先备份，幂等可重跑）
 * ```
 *
 * ## 写入目标
 *
 * - 账号条目：`$DSH_HOME/channel-pack/state.json` 的 `accounts`（provider=workbuddy）
 * - 凭据：`$DSH_HOME/.credentials.yaml` 的 `records.WORKBUDDY_ACCOUNT_xxxxxxxx`
 *   （值是按 `WorkbuddyCredential` 字段名逐字复制的 JSON 字符串：
 *   `uid` / `accessToken` / `refreshToken` / `domain` / `nickname`）
 *
 * ## 幂等
 *
 * - 账号 id = `workbuddy-<uid 前 8 位>`；已存在同 id 条目则跳过。
 * - credentialRef 后缀 = sha256(uid) 前 4 字节大写 HEX（确定性，不随机），
 *   重跑生成同一个 ref，凭据按 ref 覆盖更新，不膨胀。
 *
 * ## ⚠️ DSH 运行时与固化
 *
 * DSH 宿主运行时会持有凭据/状态的内存副本，导入后它的一次整体重写可能把
 * 新账号冲掉（脚本会在写入后 3 秒做二次读回并报 `persist-ok` / `persist-lost`）。
 * **若报 `persist-lost`：关闭 DSH 后重跑本脚本即可固化**（重跑无副作用）。
 * 关闭 DSH 时运行是写入的最佳时机。
 *
 * ## 安全
 *
 * - token / refreshToken 只写进 `$DSH_HOME` 的凭据文件，绝不进仓库任何文件。
 * - 所有输出对 token 字段做 redact。
 *
 * ## ⚠️ 凭据文档的读写必须走共享模块
 *
 * 本脚本早期手写了一份「两空格 `  KEY: 'value'`」极简解析器 + 全量重写。
 * `.credentials.yaml` 有两个段：`refs:`（插件凭据）与 `records:`（**DSH 宿主
 * 自己的登录会话**，键形如 `deepseek-account-platform/default` + 嵌套 mapping）。
 * 极简解析器读不到 `records:` 的条目 → 重写时整段删掉 → 宿主以为没登录 →
 * 用户被要求重新登录（真实事故，2026-11-13）。现在统一走
 * `scripts/lib/credentials-document.mjs`：只改点名的 ref，其余逐字节保留，
 * 且落盘前做结构自检。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { applyCredentialRefs, readCredentialsDocument, rewriteCredentialsFile } from './lib/credentials-document.mjs'

const DRY_RUN = process.argv.includes('--dry-run')

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'channel-pack', 'state.json')
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml')
const WB_POOL_DIR = 'E:\\workbuddy\\国产模型中转池\\data\\wb-pool'

const PROVIDER = 'workbuddy'

const redact = (value) => {
  if (typeof value !== 'string') return value
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

/** 读取 WB 池，过滤存活账号；结构异常时停下报错。 */
function loadAliveAccounts() {
  if (!fs.existsSync(WB_POOL_DIR)) {
    throw new Error(`WB 池目录不存在: ${WB_POOL_DIR}`)
  }
  const files = fs.readdirSync(WB_POOL_DIR).filter((name) => name.endsWith('.json'))
  const alive = []
  const dead = []
  for (const name of files) {
    const file = path.join(WB_POOL_DIR, name)
    const account = JSON.parse(fs.readFileSync(file, 'utf8'))
    // 结构哨兵：与 2026-11-13 实测的结构不符就停下来，不要猜。
    const required = ['uid', 'accessToken', 'accessExp', 'domain', 'enabled', 'dead']
    for (const key of required) {
      if (!(key in account)) throw new Error(`${name} 缺少字段 ${key}，池结构可能与预期不符，停止导入`)
    }
    if (account.uid + '.json' !== name) {
      throw new Error(`${name} 的 uid=${account.uid} 与文件名不符，停止导入`)
    }
    if (account.dead === true || account.enabled === false) {
      dead.push(account.uid)
      continue
    }
    alive.push(account)
  }
  return { alive, dead, total: files.length }
}

/** 确定性 credentialRef：WORKBUDDY_ACCOUNT_<sha256(uid) 前 8 位大写 HEX>。 */
function credentialRefFor(uid) {
  const suffix = crypto.createHash('sha256').update(uid, 'utf8').digest('hex')
    .slice(0, 8).toUpperCase()
  return `WORKBUDDY_ACCOUNT_${suffix}`
}

/** 待写入的账号条目（字段名对齐 state.json 现有条目）。 */
function buildAccountEntry(account) {
  const shortUid = account.uid.slice(0, 8)
  return {
    id: `${PROVIDER}-${shortUid}`,
    provider: PROVIDER,
    nickname: `WB-${shortUid}`,
    enabled: true,
    credentialRef: credentialRefFor(account.uid),
    refreshable: true,
    createdAt: Date.now(),
    expiresAt: account.accessExp,
  }
}

/** 待写入的凭据 JSON（字段名严格对齐 WorkbuddyCredential）。 */
function buildCredentialJson(account) {
  return JSON.stringify({
    uid: account.uid,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    domain: account.domain,
    nickname: account.nickname ?? '',
  })
}

/** 带时间戳的备份文件路径。 */
function backupPath(file) {
  const stamp = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 17) // yyyyMMddHHmmssSSS
  return `${file}.bak-wbimport-${stamp}`
}

function backup(file) {
  const target = backupPath(file)
  fs.copyFileSync(file, target)
  return target
}

// ── .credentials.yaml 读写：委托共享模块（逐行保留 records: 宿主登录会话） ──

/**
 * 读凭据文档，返回 `{ header, records }` 以保持调用方不变。
 *
 * ⚠️ 这里曾是一份「只认两空格 `  KEY: 'value'`」的手写解析器，读不到
 * `records:`（宿主登录会话，键含 `/` 且是嵌套 mapping）→ 重写时整段丢失。
 */
function parseCredentialYaml(text) {
  const doc = readCredentialsDocument(text)
  const records = {}
  for (const [ref, raw] of doc.refs) {
    const unquoted = raw.replaceAll("''", "'")
    try {
      records[ref] = JSON.parse(unquoted)
    } catch {
      records[ref] = unquoted // 非 JSON 的纯文本凭据（如 API key）原样保留
    }
  }
  return { header: `${doc.header}refs:\n`, records }
}

/**
 * 只写这些 ref（字符串原样写入、对象序列化一次），其余内容与 `records:` 段
 * 逐字节保留；结构自检不过就抛错、不落盘。
 */
function writeCredentialRefs(file, updates) {
  return rewriteCredentialsFile(file, (text) => applyCredentialRefs(text, updates))
}

function atomicWrite(file, text) {
  const temp = `${file}.wbimport-tmp-${process.pid}`
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

/** 读回校验：N 条账号 + N 条凭据 ref 都在。 */
function verify(alive, refNames) {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  const accounts = (state.accounts ?? []).filter(
    (entry) => entry.provider === PROVIDER && alive.some((a) => a.uid.slice(0, 8) === entry.id.replace(`${PROVIDER}-`, '')),
  )
  const yaml = parseCredentialYaml(fs.readFileSync(CRED_FILE, 'utf8'))
  const creds = refNames.filter((ref) => yaml.records[ref] !== undefined)
  return { accountsFound: accounts.length, credsFound: creds.length }
}

function main() {
  const { alive, dead, total } = loadAliveAccounts()
  console.log(`WB 池共 ${total} 个文件；存活 ${alive.length} 个，跳过 dead/disabled ${dead.length} 个`)

  const planned = alive.map((account) => ({ account, entry: buildAccountEntry(account) }))
  for (const { account, entry } of planned) {
    const credential = JSON.parse(buildCredentialJson(account))
    console.log(`- ${entry.id} provider=${entry.provider} nickname=${entry.nickname} `
      + `expiresAt=${new Date(entry.expiresAt).toISOString()} credentialRef=${entry.credentialRef} `
      + `accessToken=${redact(credential.accessToken)}`)
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
    console.log('dry-run：以上即将要写入的内容，未做任何写盘。')
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
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + '\n')

  // ── 写凭据：只改这些 ref；records:（宿主登录会话）逐字节保留 ──
  const updates = {}
  for (const { account, entry } of planned) {
    updates[entry.credentialRef] = buildCredentialJson(account)
  }
  writeCredentialRefs(CRED_FILE, updates)
  console.log(`已写入账号 ${addedAccounts} 条（跳过 ${planned.length - addedAccounts}），凭据 ${Object.keys(updates).length} 条`)

  // ── 二次读回 + 3 秒存活窗口 ──
  const first = verify(alive, refNames)
  console.log(`写后立即读回: state 账号 ${first.accountsFound}/${alive.length}，凭据 ref ${first.credsFound}/${refNames.length}`)

  const waitMs = 3000
  console.log(`等待 ${waitMs}ms 做存活窗口检查（宿主可能在此期间整体重写）…`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
  const second = verify(alive, refNames)
  console.log(`3 秒后读回: state 账号 ${second.accountsFound}/${alive.length}，凭据 ref ${second.credsFound}/${refNames.length}`)

  const ok = second.accountsFound === alive.length && second.credsFound === refNames.length
  console.log(ok ? 'persist-ok' : 'persist-lost')

  // ── getCredential 等价验证：按 ref 读回凭据并按 WorkbuddyCredential 字段校验 ──
  const yamlAfter = parseCredentialYaml(fs.readFileSync(CRED_FILE, 'utf8'))
  for (const { entry } of planned) {
    const raw = yamlAfter.records[entry.credentialRef]
    if (raw === undefined) {
      console.log(`凭据验证 ${entry.credentialRef}: MISSING`)
      continue
    }
    const credential = typeof raw === 'string' ? JSON.parse(raw) : raw
    const fieldsOk = typeof credential.uid === 'string' && credential.uid.length > 0
      && typeof credential.accessToken === 'string' && credential.accessToken.length > 0
      && typeof credential.domain === 'string' && credential.domain.length > 0
    console.log(`凭据验证 ${entry.credentialRef}: ${fieldsOk ? 'OK' : 'MALFORMED'} `
      + `uid=${credential.uid.slice(0, 8)}… accessToken=${redact(credential.accessToken)} domain=${credential.domain}`)
  }

  if (!ok) {
    console.log('\npersist-lost：DSH 宿主把写入冲掉了。请关闭 DSH 后重跑本脚本（幂等，重跑无副作用）即可固化。')
    process.exitCode = 2
  }
}

main()
