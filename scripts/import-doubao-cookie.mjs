#!/usr/bin/env node
/**
 * 导入一个「豆包工作（DoubaoWork）」账号。
 *
 * ## 为什么需要这个脚本
 *
 * 豆包是本插件里第一个**纯 cookie 鉴权**且**没有浏览器登录流**的渠道：
 *
 * - 字节 passport 的扫码/短信链路没有实测样本，短信要过阿里云滑块
 *   （sceneId 与页面 origin 强绑定，复刻必然漂移）→ 不做自动登录页；
 * - 本地 Cookies 库被运行中的 Chromium **独占加锁**（实测 IOException），
 *   绕过需要 SeBackupPrivilege → 不做自动读取。
 *
 * 所以凭据只能由用户显式提供。UI 侧目前也**没有** cookie 输入框
 *（`workbuddy` 同样是这个情况，靠 `scripts/import-wb-pool.mjs` 注入），
 * 因此本脚本就是豆包账号的**唯一入口**。
 *
 * ## 怎么拿到 cookie
 *
 * 1. 打开豆包工作（DoubaoWork）并确认已登录；
 * 2. 用任意能看 Chromium cookie 的手段导出 `www.doubao.com` 的 cookie
 *    （关键项：`sessionid`；其余 `ttwid` / `s_d_v_web_id` / `passport_csrf_token`
 *    一并带上更稳）；
 * 3. 把整串粘给本脚本（`--cookie "k=v; k2=v2"` 或 `--cookie-file path`）。
 *
 * ⚠️ **不需要手动构造**：脚本会做格式归一（去 `Cookie:` 前缀、压空白、
 * 只给了值就补 `sessionid=`）。
 *
 * ## 用法
 *
 * ```bash
 * # 先干跑：只验证 cookie 是否有效，不写任何文件
 * node scripts/import-doubao-cookie.mjs --cookie "sessionid=..." --dry-run
 *
 * # 真正写入（含探活；探活失败不落盘）
 * node scripts/import-doubao-cookie.mjs --cookie "sessionid=..." --nickname "我的豆包"
 *
 * # 从文件读（避免 shell 历史留痕）
 * node scripts/import-doubao-cookie.mjs --cookie-file ./doubao.cookie
 * ```
 *
 * ## 安全
 *
 * - cookie **绝不**打印全文，日志统一 redact；
 * - `--dry-run` 不写任何文件；
 * - 写入前备份 `.credentials.yaml` 与 `state.json`，写后回读校验；
 * - 探活失败**不落盘**（避免留下一个永远连不上的空卡片）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  applyCredentialRefs,
  rewriteCredentialsFile,
} from './lib/credentials-document.mjs'

const DRY_RUN = process.argv.includes('--dry-run')

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'channel-pack', 'state.json')
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml')

/** provider 标识（必须与 `doubao-product.ts` 的 `DOUBAO.id` 一致）。 */
const PROVIDER = 'doubao'
/** 凭据 ref 前缀（必须与 `channel-pack-store.ts` 的 `REF_PREFIX_TO_PROVIDER` 一致）。 */
const REF_PREFIX = 'DOUBAO_ACCOUNT_'
const REF_PATTERN = /^DOUBAO_ACCOUNT_[0-9A-F]+$/

/** 豆包 API 基址（与 doubao-product.ts 一致）。 */
const API_BASE = 'https://www.doubao.com'
/** 探活端点：最轻的只读请求（`get_credit_tip`）。 */
const PROBE_PATH = '/alice/commerce/benefit_supply/credit/get_credit_tip'
/** 公共 query（与 doubao.ts 的 `doubaoCommonParams` 保持同形）。 */
const COMMON_QUERY = {
  device_platform: 'web',
  doubao_device_platform: 'web',
  samantha_web: '1',
  'use-olympus-account': '1',
  is_new_user: '0',
}

/** 对敏感值做 redact（绝不打印全文）。 */
const redact = (value) => {
  if (typeof value !== 'string') return value
  return value.length <= 8 ? '<redacted>' : `<redacted len=${value.length}>`
}

/** 解析 `--key value` / `--key=value`。 */
function argOf(name) {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}`) return argv[i + 1]
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3)
  }
  return undefined
}

/**
 * 归一化 cookie 输入。
 *
 * 与 `doubao-auth.ts` 的 `normalizeCookieInput` **必须等价** ——
 * 两边不一致会导致「脚本验证通过、插件侧拒绝」这种最难查的偏差。
 */
function normalizeCookieInput(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  text = text.replace(/^cookie\s*:\s*/i, '')
  text = text.replace(/[\r\n\t]+/g, ' ')
  text = text.replace(/\s{2,}/g, ' ')
  if (!text.includes('=')) return `sessionid=${text}`
  return text
}

/** 读 state.json（不存在则返回空骨架）。 */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { accounts: [], disabledModels: {} }
  }
}

/** 生成一个不与现有账号冲突的 ref。 */
function freshRef(state) {
  const used = new Set((state.accounts ?? []).map((entry) => entry.credentialRef))
  for (;;) {
    const suffix = Array.from({ length: 8 }, () =>
      '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('')
    const ref = `${REF_PREFIX}${suffix}`
    // 形状自检 + 唯一性：两者都过才采用。
    if (REF_PATTERN.test(ref) && !used.has(ref)) return ref
  }
}

/** 探活：返回 true / false / undefined（无法判定）。 */
async function probe(cookie) {
  const url = new URL(PROBE_PATH, API_BASE)
  for (const [key, value] of Object.entries(COMMON_QUERY)) {
    url.searchParams.set(key, value)
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Agw-Js-Conv': 'str',
        Accept: 'application/json',
        Cookie: cookie,
      },
      body: '{}',
    })
    if (response.status === 401 || response.status === 403) return false
    return response.ok
  } catch {
    return undefined
  }
}

const cookieArg = argOf('cookie')
const cookieFile = argOf('cookie-file')
const nicknameArg = argOf('nickname')

let rawCookie = cookieArg
if (rawCookie === undefined && typeof cookieFile === 'string') {
  if (!fs.existsSync(cookieFile)) {
    console.error(`cookie 文件不存在：${cookieFile}`)
    process.exit(2)
  }
  rawCookie = fs.readFileSync(cookieFile, 'utf8')
}
if (typeof rawCookie !== 'string' || rawCookie.trim().length === 0) {
  console.error('缺少 cookie。用 --cookie "sessionid=..." 或 --cookie-file <path>。')
  console.error('（拿 cookie 的方法见本文件顶部注释）')
  process.exit(2)
}

const cookie = normalizeCookieInput(rawCookie)
if (!cookie.includes('sessionid=')) {
  console.error('cookie 里没有 sessionid=。豆包鉴权靠 sessionid，请确认复制完整。')
  process.exit(2)
}
console.log(`cookie 已归一化：${redact(cookie)}，含 sessionid=${cookie.includes('sessionid=')}`)

console.log('正在探活……')
const alive = await probe(cookie)
if (alive === false) {
  console.error('探活失败：服务端返回 401/403。cookie 无效或已过期，请重新从豆包工作复制。')
  process.exit(1)
}
if (alive === undefined) {
  console.warn('探活未能判定（网络异常）。')
  if (!DRY_RUN) {
    console.warn('为避免写入一个未验证的凭据，已中止。确认网络后重跑；')
    console.warn('若确定要强制写入，请加 --force-unverified（不推荐）。')
    if (!process.argv.includes('--force-unverified')) process.exit(1)
  }
} else {
  console.log('探活通过 ✅')
}

if (DRY_RUN) {
  console.log('--dry-run：不写任何文件。')
  process.exit(0)
}

// ── 落盘 ──────────────────────────────────────────────────────────────
const state = readState()
const ref = freshRef(state)
const nickname = (typeof nicknameArg === 'string' && nicknameArg.trim().length > 0)
  ? nicknameArg.trim()
  : `豆包 ${ref.slice(-6)}`

const credential = {
  cookie,
  uid: '',
  nickname,
  // 探活通过才有 lastVerifiedAt；未判定时留 0 让后续流程知道"未被证实"。
  lastVerifiedAt: alive === true ? Date.now() : 0,
  desktop: false,
}

const accountEntry = {
  id: `${PROVIDER}-${ref.slice(-8).toLowerCase()}`,
  provider: PROVIDER,
  nickname,
  enabled: true,
  credentialRef: ref,
  // 豆包无续期端点 ⇒ 恒 false。
  refreshable: false,
  createdAt: Date.now(),
}

// 备份
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
for (const file of [CRED_FILE, STATE_FILE]) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak-${stamp}`)
    console.log(`已备份：${path.basename(file)}.bak-${stamp}`)
  }
}

// 写凭据（复用共享文档读写器，逐行保留 records: 段 —— 那是宿主自己的登录会话）
const before = fs.existsSync(CRED_FILE) ? fs.readFileSync(CRED_FILE, 'utf8') : 'refs:\n'
if (!fs.existsSync(CRED_FILE)) {
  console.error(`找不到凭据文件：${CRED_FILE}`)
  console.error('请先让 DSH 至少登录/初始化一次，或先导入任一渠道账号。')
  process.exit(1)
}
const result = rewriteCredentialsFile(CRED_FILE, (text) =>
  applyCredentialRefs(text, { [ref]: JSON.stringify(credential) }))
if (result.changed !== true) {
  console.error('凭据文件未发生变更 —— rewrite 被跳过，请检查 ref 是否已存在。')
  process.exit(1)
}
console.log(`凭据已写入：${ref}`)

// 写 state
state.accounts = [...(state.accounts ?? []), accountEntry]
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
console.log(`账号已登记：${accountEntry.id}（${nickname}）`)

// 回读校验
const rereadCred = fs.readFileSync(CRED_FILE, 'utf8')
if (!rereadCred.includes(ref)) {
  console.error('回读校验失败：凭据文件里找不到新 ref。可能被宿主覆盖（persist-lost）。')
  process.exit(1)
}
const rereadState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
if (!(rereadState.accounts ?? []).some((entry) => entry.credentialRef === ref)) {
  console.error('回读校验失败：state.json 里找不到新账号。')
  process.exit(1)
}

console.log('')
console.log('完成。下一步：')
console.log('  1) 重启 DSH（宿主不会热加载 file: 依赖）')
console.log('  2) EAC router → 豆包工作 → 应看到该账号')
console.log('  3) 模型选择器里应出现 doubao 的模型')
console.log('')
console.log('⚠️ 已知未解（见 docs/research/doubaowork/README.md §7）：')
console.log('   - 若服务端下发 protobuf SSE（event: pb），对话会报 UNSUPPORTED_CONTENT；')
console.log('   - aid / botId 为占位值，可能需按实测校正。')
