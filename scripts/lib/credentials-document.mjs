/**
 * 安全读写 `$DSH_HOME/.credentials.yaml` 的唯一入口。
 *
 * ## 为什么需要这个模块（真实事故，2026-11-13）
 *
 * 这份凭据文档有**两个互不相干的段**：
 *
 * ```yaml
 * version: 1
 * refs:                                  # ← 插件（OFM / channel-pack）自己的渠道凭据
 *   WORKBUDDY_ACCOUNT_XXXX: '{...}'
 * records:                               # ← DSH 宿主自己的登录会话
 *   deepseek-account-platform/device:     #   {kind: grant, payload: {id: ...}}
 *   deepseek-account-platform/default:    #   {kind: grant, payload: {version, token, issuer}}
 *   client-connection/browser-session:    #   同构的 grant 记录
 * ```
 *
 * `records:` 里放的就是「你在 DSH 里登录了没有」。宿主
 * `@deepseek-ai/dsh-credentials-local` 启动时读它、并且**只要 watcher 发现
 * 文件变了就整体重读**；`records:` 一旦消失，宿主就认为没人登录 —— 用户看到
 * 的表现就是「频繁掉登录，要我重新登录」。
 *
 * 2026-11-13 那批 WB 脚本各自手写了一份「只认 `  KEY: 'value'` 两空格行」的
 * 极简解析器：它能读 `refs:`，但 `records:` 下的条目是
 * `  scope/id:`（键里有 `/`）+ 嵌套 mapping，正则匹配不上，于是被**静默丢弃**；
 * 紧接着 `serialize()` 只按自己那份 map 重写整个文件 —— `records:` 整段消失。
 * 更糟的是脚本的读回校验只看得到自己关心的 WB ref（`persist-ok` 照样通过），
 * 所以破坏发生时没有任何告警。
 *
 * ## 本模块的契约
 *
 * 1. **保留一切不认识的字节**：只替换调用方点名的那几个 `refs:` 条目，其余行
 *    （包括 `records:` 的每一个字节、注释、空行、行序、行尾）原样写回。
 * 2. **写出前自检**：新文本必须仍能被解析，且 `records:` 段与全部 `refs:` 键
 *    集合不得少于输入。任一项不满足就抛错、**不落盘**。
 * 3. `refs:` 值按 YAML 单引号规则转义（`'` → `''`），并且**不重新序列化已经
 *    是字符串的值** —— 二次编码正是 2026-11-13 的另一半事故（WB 凭据被
 *    `JSON.stringify` 两次，唤醒时报「凭据缺少 accessToken/uid」）。
 *
 * 用法：
 *
 * ```js
 * import { readCredentialsDocument, writeCredentialRefs } from './lib/credentials-document.mjs'
 * const doc = readCredentialsDocument(file)
 * writeCredentialRefs(file, doc, { WORKBUDDY_ACCOUNT_ABC: JSON.stringify(credential) })
 * ```
 */

import fs from 'node:fs'

/** 段头：`version: 1` 之后紧跟 `refs:` 或历史写法 `records:`。 */
const HEADER = /^(version: \d+\n)(refs|records):\n/

/** 顶层段名（顶层 = 顶格，后面紧跟冒号）。 */
const SECTION = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/

/** `refs:` 段内的一条条目：两空格缩进 + POSIX 标识符 + 单引号字符串。 */
const REF_LINE = /^  ([A-Za-z_][A-Za-z0-9_]*): '(.*)'\s*$/

/**
 * 解析整份文档，**按行**保留原始文本。
 *
 * @param {string} text 文件全文。
 * @returns {{
 *   text: string,
 *   header: string,
 *   firstSection: string,
 *   sections: Map<string, { start: number, end: number, lines: string[] }>,
 *   refs: Map<string, string>,
 * }}
 *   `header` 是 `version: N\n`；`firstSection` 是紧跟在版本行后的段名
 *   （当前文件是 `refs`，历史文件是 `records`）。`refs` 的 value 是**单引号内
 *   的原始文本**（未反转义），写出时原样复用。
 *   `sections` 的 `start`/`end` 是该段在 `text.split('\n')` 里的行号区间
 *   （含 `start`，不含 `end`），`lines[0]` 是段头本身。
 */
export function readCredentialsDocument(text) {
  const match = text.match(HEADER)
  if (match === null) {
    throw new Error('凭据文档不是 version:1 + refs/records 结构，拒绝改写（不要猜）')
  }
  const header = match[1]
  const firstSection = match[2]
  const rest = `${firstSection}:\n${text.slice(match[0].length)}`
  const lines = rest.split('\n')

  const sections = new Map()
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const section = line.match(SECTION)
    if (section !== null && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (current !== null) current.end = index
      current = { start: index, end: lines.length, lines: [] }
      sections.set(section[1], current)
      continue
    }
    if (current !== null) current.lines.push(line)
  }

  const refs = new Map()
  const refsSection = sections.get('refs')
  if (refsSection !== undefined) {
    for (const line of refsSection.lines) {
      const ref = line.match(REF_LINE)
      if (ref !== null) refs.set(ref[1], ref[2])
    }
  }

  return { text, header, firstSection, sections, refs }
}

/** YAML 单引号标量：内部 `'` 写成 `''`，其余原样。 */
export function quoteYamlSingle(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/** 反转义单引号标量（读回用）。 */
export function unquoteYamlSingle(raw) {
  return raw.replaceAll("''", "'")
}

/**
 * 把 `refs:` 值还原成 JS 值：能 JSON.parse 就用解析结果，否则当纯文本。
 *
 * ⚠️ 只解**一层**。历史的双编码缺陷（值本身是一段 JSON 文本，又被
 * `JSON.stringify` 一次）需要调用方自己再解一层 —— 见
 * `scripts/repair-wb-credentials.mjs` 的 `unwrap()`。
 */
export function parseRefValue(raw) {
  try {
    return JSON.parse(unquoteYamlSingle(raw))
  } catch {
    return unquoteYamlSingle(raw)
  }
}

/** 文档里所有 `refs:` 键名。 */
export function listCredentialRefs(text) {
  return [...readCredentialsDocument(text).refs.keys()]
}

/**
 * 生成「只改这些 ref」的新文档全文。
 *
 * @param {string} text 原始全文。
 * @param {Record<string, string>} updates ref → 已经序列化好的字符串值
 *   （字符串原样写入；对象 `JSON.stringify`）。
 * @param {{ remove?: string[] }} [options] 需要删除的 ref。
 * @returns {string} 新全文。
 */
export function applyCredentialRefs(text, updates, options = {}) {
  const doc = readCredentialsDocument(text)
  const remove = new Set(options.remove ?? [])
  const pending = new Map()
  for (const [ref, value] of Object.entries(updates)) {
    if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) {
      throw new TypeError(`凭据 ${ref} 的值必须是字符串或对象`)
    }
    // ⚠️ 字符串原样写入。判据是 **JS 类型**，不是「以 { 开头」—— 后者会把
    // 已经是 JSON 文本的值再编码一次，正是 2026-11-13 的二次编码事故。
    pending.set(ref, typeof value === 'string' ? value : JSON.stringify(value))
  }

  const lines = []
  lines.push(doc.header.trimEnd())
  /** 渲染 `refs:` 段（原地更新 + 追加新 ref）。 */
  const renderRefs = () => {
    lines.push('refs:')
    const refsSection = doc.sections.get('refs')
    if (refsSection === undefined) {
      for (const [ref, raw] of pending) lines.push(`  ${ref}: ${quoteYamlSingle(raw)}`)
      return
    }
    const seen = new Set()
    for (const line of refsSection.lines) {
      const ref = line.match(REF_LINE)
      if (ref === null) {
        // 空行 / 注释 / 非常规条目：原样保留。
        lines.push(line)
        continue
      }
      const name = ref[1]
      seen.add(name)
      if (remove.has(name)) continue
      if (pending.has(name)) {
        lines.push(`  ${name}: ${quoteYamlSingle(pending.get(name))}`)
        continue
      }
      lines.push(line)
    }
    for (const [ref, raw] of pending) {
      if (seen.has(ref)) continue
      lines.push(`  ${ref}: ${quoteYamlSingle(raw)}`)
    }
  }

  // 段序必须照抄原文件：历史文档里 `records:` 可能排在 `refs:` 之前，
  // 强行把 refs 提前会改变踩坑者的文件形态（也让 diff 变得难以比对）。
  if (doc.firstSection === 'refs') renderRefs()
  for (const [name, section] of doc.sections) {
    if (name === 'refs') continue
    lines.push(`${name}:`)
    for (let index = 0; index < section.end - section.start - 1; index += 1) {
      lines.push(section.lines[index] ?? '')
    }
  }
  if (doc.firstSection !== 'refs') renderRefs()

  const joined = lines.join('\n')
  return joined.endsWith('\n') ? joined : `${joined}\n`
}

/**
 * 结构自检：新文本不得丢段、丢 ref。
 *
 * @param {string} before 旧全文。
 * @param {string} after 新全文。
 * @param {{ allowedRemovedRefs?: string[] }} [options]
 */
export function assertNoCredentialLoss(before, after, options = {}) {
  const allowedRemoved = new Set(options.allowedRemovedRefs ?? [])
  const oldDoc = readCredentialsDocument(before)
  const newDoc = readCredentialsDocument(after)

  for (const name of oldDoc.sections.keys()) {
    if (!newDoc.sections.has(name)) {
      throw new Error(`拒绝写入：段 "${name}:" 会消失（旧文档有、新文档没有）`)
    }
  }
  for (const ref of oldDoc.refs.keys()) {
    if (allowedRemoved.has(ref)) continue
    if (!newDoc.refs.has(ref)) throw new Error(`拒绝写入：ref "${ref}" 会消失`)
  }
  // records: 段必须逐字节保留 —— 宿主登录会话就在这里。
  const oldRecords = oldDoc.sections.get('records')
  const newRecords = newDoc.sections.get('records')
  if (oldRecords !== undefined) {
    const shape = (section) => section.lines.slice(0, section.end - section.start - 1).join('\n')
    if (newRecords === undefined || shape(oldRecords) !== shape(newRecords)) {
      throw new Error('拒绝写入：records: 段（DSH 宿主登录会话）内容会改变或消失')
    }
  }
}

/**
 * 读 → 改 → 结构自检 → 原子落盘。
 *
 * @param {string} file 凭据文件绝对路径。
 * @param {(text: string) => string} mutate 接收旧全文、返回新全文。
 * @returns {{ changed: boolean, before: string, after: string }}
 */
export function rewriteCredentialsFile(file, mutate) {
  const before = fs.readFileSync(file, 'utf8')
  const after = mutate(before)
  if (after === before) return { changed: false, before, after }
  assertNoCredentialLoss(before, after)
  const temp = `${file}.ofmcred-tmp-${process.pid}`
  fs.writeFileSync(temp, after, 'utf8')
  try {
    fs.renameSync(temp, file)
  } catch (error) {
    try { fs.rmSync(temp, { force: true }) } catch { /* best effort */ }
    throw error
  }
  return { changed: true, before, after }
}
