#!/usr/bin/env node
/**
 * 修复 `$DSH_HOME/.credentials.yaml` 里**历史双编码**的 WorkBuddy 凭据。
 *
 * ## 为什么要这个脚本（真实事故）
 *
 * 早期 `scripts/import-wb-pool.mjs` 的 `serializeCredentialYaml()` 会把
 * 「已经是 JSON 字符串」的值**再** `JSON.stringify` 一次，落盘成：
 *
 * ```yaml
 * WORKBUDDY_ACCOUNT_XXXX: '"{""uid"":""…"",""accessToken"":""…""}"'
 * ```
 *
 * 读回时 `JSON.parse` **只解一层**，得到的是 `string` 而不是对象 ——
 * OFM 的 `account.refresh`（唤醒）因此报
 * 「WorkBuddy 凭据缺少 accessToken/uid，请重新导入该账号」，
 * 签到 / 签到状态也带着空 `Authorization` 静默失败。
 *
 * 代码侧已经做了双保险（`normalizeWorkbuddyCredential` 多解一层 +
 * 唤醒成功时回写规范值），本脚本是**离线/批量**修复：不必逐个点「唤醒」
 * 就能把存量凭据与账号池的有效期一次性对齐。
 *
 * ## 用法
 *
 * ```
 * node scripts/repair-wb-credentials.mjs --dry-run   # 只读，打印将要改什么
 * node scripts/repair-wb-credentials.mjs             # 真正写入（先备份，幂等）
 * ```
 *
 * ## 安全
 *
 * - 只改 `provider=workbuddy` 对应 ref 的**编码形态**与 `expiresAt`，
 *   令牌值原样保留（轮换只发生在 OFM 唤醒时）。
 * - ⚠️ 改写走 `scripts/lib/credentials-document.mjs`：它逐行保留 `records:`
 *   段（DSH 宿主自己的登录会话）。本脚本早期手写的「两空格 KEY: 'value'」
 *   解析器读不到 `records:` 的 `scope/id` 条目，重写会把整段删掉 —— 那会让
 *   DSH 掉登录（真实事故，2026-11-13）。现在结构自检会在落盘前拦下这种改写。
 * - 所有输出对 token 做 redact；令牌绝不进仓库任何文件。
 * - 写前备份、写后读回校验；`persist-lost` 表示 DSH 宿主覆盖了写入，
 *   关闭 DSH 后重跑即可固化（幂等，重跑无副作用）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  applyCredentialRefs,
  readCredentialsDocument,
  rewriteCredentialsFile,
  unquoteYamlSingle,
} from './lib/credentials-document.mjs'

const DRY_RUN = process.argv.includes('--dry-run')

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'channel-pack', 'state.json')
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml')
const PROVIDER = 'workbuddy'
const REF_PATTERN = /^WORKBUDDY_ACCOUNT_[0-9A-F]+$/

const redact = (value) => {
  if (typeof value !== 'string') return value
  return value.length <= 8 ? '<redacted>' : `${value.slice(0, 4)}…<redacted len=${value.length}>`
}

/**
 * `.credentials.yaml` 的读取 —— 委托给共享模块。
 *
 * ⚠️ 这里曾经有一份「只认两空格 `  KEY: 'value'`」的手写解析器 + 全量重写。
 * `records:` 段（DSH 宿主自己的登录会话）的键形如
 * `deepseek-account-platform/default`，正则匹配不上 → 被静默丢弃 →
 * 重写后整段消失 → 宿主认为没登录 → **用户被要求重新登录**。
 * 共享模块逐行保留该段，并在落盘前做结构自检。
 *
 * 返回 `{ header, records, rawByName }` 以保持调用方不变：
 * - `records[ref]`：`JSON.parse` 后的值（失败则原样字符串）
 * - `rawByName[ref]`：单引号内的原始文本（用于识别二次编码）
 */
function parseCredentialYaml(text) {
  const doc = readCredentialsDocument(text)
  const records = {}
  const rawByName = {}
  for (const [ref, raw] of doc.refs) {
    const unquoted = unquoteYamlSingle(raw)
    rawByName[ref] = unquoted
    try {
      records[ref] = JSON.parse(unquoted)
    } catch {
      records[ref] = unquoted // 非 JSON 的纯文本凭据（如 API key）原样保留
    }
  }
  return { header: `${doc.header}refs:\n`, records, rawByName }
}

/** 原子落盘（仅 state.json 用；凭据走共享模块的 rewriteCredentialsFile）。 */
function atomicWrite(file, text) {
  const temp = `${file}.wbrepair-tmp-${process.pid}`
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

/** 原子落盘：走共享模块，带 `records:` 结构自检。 */
function writeCredentialRefs(file, updates) {
  return rewriteCredentialsFile(file, (text) => applyCredentialRefs(text, updates))
}

function backup(file) {
  const stamp = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 17)
  const target = `${file}.bak-wbrepair-${stamp}`
  fs.copyFileSync(file, target)
  return target
}

/** JWT payload 解码（不验签，只读 exp/sub）。 */
function jwtPayload(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 解开任意层级的编码：返回 `{ value, depth }`。
 * depth ≥ 2 表示命中了历史上的双编码，需要修复。
 */
function unwrap(jsonText) {
  let value = JSON.parse(jsonText)
  let depth = 1
  while (typeof value === 'string' && depth < 4) {
    try {
      value = JSON.parse(value)
      depth += 1
    } catch {
      break
    }
  }
  return { value, depth }
}

function dshRunning() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      '(Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Measure-Object).Count',
    ], { encoding: 'utf8', timeout: 20000 })
    return Number.parseInt(out.trim(), 10) > 0
  } catch {
    return null
  }
}

function main() {
  if (!fs.existsSync(CRED_FILE)) throw new Error(`凭据文件不存在: ${CRED_FILE}`)
  const yaml = parseCredentialYaml(fs.readFileSync(CRED_FILE, 'utf8'))
  const refs = Object.keys(yaml.records).filter((name) => REF_PATTERN.test(name))
  if (refs.length === 0) {
    console.log('没有 WORKBUDDY_ACCOUNT_* 记录，无需修复。')
    return
  }

  const plan = []
  for (const ref of refs) {
    const raw = yaml.rawByName[ref]
    let parsed
    try {
      parsed = unwrap(raw)
    } catch (error) {
      console.log(`- ${ref}: 原始文本不是 JSON（${error instanceof Error ? error.message : String(error)}），跳过`)
      continue
    }
    const value = parsed.value
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      console.log(`- ${ref}: 解 ${parsed.depth} 层后仍不是对象，跳过（不猜）`)
      continue
    }
    const accessToken = typeof value.accessToken === 'string' ? value.accessToken.trim() : ''
    const payload = jwtPayload(accessToken)
    const uid = typeof value.uid === 'string' && value.uid.trim().length > 0
      ? value.uid.trim()
      : (typeof payload?.sub === 'string' ? payload.sub.trim() : '')
    if (accessToken.length === 0 || uid.length === 0) {
      console.log(`- ${ref}: accessToken/uid 缺失（无法从 JWT sub 补全），跳过 —— 需重新导入`)
      continue
    }
    const normalized = {
      uid,
      accessToken,
      ...typeof value.refreshToken === 'string' && value.refreshToken.trim().length > 0
        ? { refreshToken: value.refreshToken.trim() }
        : {},
      domain: typeof value.domain === 'string' && value.domain.trim().length > 0
        ? value.domain.trim()
        : 'www.workbuddy.cn',
      ...typeof value.nickname === 'string' ? { nickname: value.nickname } : {},
    }
    const serialized = JSON.stringify(normalized)
    const expiresAt = typeof payload?.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined
    plan.push({ ref, depth: parsed.depth, needsRewrite: serialized !== raw, serialized, expiresAt })
    console.log(`- ${ref}: 原始解 ${parsed.depth} 层，${serialized === raw ? '已是规范单层编码' : '需改写为单层编码'}`
      + ` uid=${uid.slice(0, 8)}… accessToken=${redact(accessToken)}`
      + ` expiresAt=${expiresAt === undefined ? '未知' : new Date(expiresAt).toISOString()}`)
  }

  const rewrites = plan.filter((entry) => entry.needsRewrite)
  if (rewrites.length === 0) {
    console.log('凭据编码全部规范，无需改写。')
  }

  // 账号池有效期对账（只改 workbuddy 且能对上 ref 的条目）。
  const stateFix = []
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    const byRef = new Map(plan.map((entry) => [entry.ref, entry]))
    for (const account of state.accounts ?? []) {
      if (account.provider !== PROVIDER) continue
      const entry = byRef.get(account.credentialRef)
      if (entry === undefined || entry.expiresAt === undefined) continue
      // 1 秒容差：JWT 的 exp 是秒级，换算毫秒后可能舍入。
      if (typeof account.expiresAt === 'number' && Math.abs(account.expiresAt - entry.expiresAt) <= 1000) continue
      stateFix.push({ account, expiresAt: entry.expiresAt })
    }
    for (const { account, expiresAt } of stateFix) {
      console.log(`- state: ${account.id} expiresAt ${account.expiresAt === undefined ? '无' : new Date(account.expiresAt).toISOString()}`
        + ` → ${new Date(expiresAt).toISOString()}`)
    }
  }

  if (DRY_RUN) {
    console.log(`\ndry-run：将改写 ${rewrites.length} 条凭据编码、${stateFix.length} 条账号池有效期；未做任何写盘。`)
    return
  }

  const running = dshRunning()
  if (running === true) console.log('\n注意：DSH 正在运行，写入可能被宿主的整体重写冲掉（见下方 persist 校验）')

  if (rewrites.length > 0) {
    console.log(`已备份: ${backup(CRED_FILE)}`)
    const updates = Object.fromEntries(rewrites.map((entry) => [entry.ref, entry.serialized]))
    // ⚠️ 只改这些 ref；records:（宿主登录会话）逐字节保留，结构自检不过就抛错不落盘。
    writeCredentialRefs(CRED_FILE, updates)
  }
  if (stateFix.length > 0) {
    console.log(`已备份: ${backup(STATE_FILE)}`)
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    for (const { account, expiresAt } of stateFix) {
      const target = (state.accounts ?? []).find((row) => row.id === account.id)
      if (target !== undefined) target.expiresAt = expiresAt
    }
    atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
  }

  // 读回校验：编码必须是单层（解一层即对象）。
  const after = parseCredentialYaml(fs.readFileSync(CRED_FILE, 'utf8'))
  let pending = 0
  for (const ref of refs) {
    const raw = after.rawByName[ref]
    if (raw === undefined) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      pending += 1
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) pending += 1
  }
  let statePending = 0
  if (stateFix.length > 0 && fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    for (const { account, expiresAt } of stateFix) {
      const target = (state.accounts ?? []).find((row) => row.id === account.id)
      if (target === undefined || Math.abs((target.expiresAt ?? 0) - expiresAt) > 1000) statePending += 1
    }
  }

  const ok = pending === 0 && statePending === 0
  console.log(`\n读回校验：仍为双层编码 ${pending} 条，有效期未对齐 ${statePending} 条`)
  console.log(ok ? 'persist-ok' : 'persist-lost')
  if (!ok) {
    console.log('persist-lost：DSH 宿主把写入冲掉了。请关闭 DSH 后重跑本脚本（幂等，重跑无副作用）即可固化。')
    process.exitCode = 2
  }
}

main()
