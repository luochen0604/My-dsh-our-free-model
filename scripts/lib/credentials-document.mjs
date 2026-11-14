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
 * 2. **写出前自检**：新文本必须仍能被解析，且段集合、可解析 ref 集合、
 *    「认不出形状的行」三者都不得减少。任一项不满足就抛错、**不落盘**。
 * 3. `refs:` 值按 YAML 单引号规则转义（`'` → `''`），并且**不重新序列化已经
 *    是字符串的值** —— 二次编码正是 2026-11-13 的另一半事故（WB 凭据被
 *    `JSON.stringify` 两次，唤醒时报「凭据缺少 accessToken/uid」）。
 *
 * ## 第三个缺陷（真实事故，2026-11-14：模型页保存的 API Key 重启后全没了）
 *
 * 上面的解析器只认 **单引号** 写法 `  KEY: 'value'`，因为那是插件的
 * `applyCredentialRefs()` 自己写出来的形状。但 `.credentials.yaml` 里还住着
 * 另一半凭据：**用户在模型设置页保存的模型 API Key**（`DEEPSEEK_API_KEY`、
 * `ZAI_CODING_CN_API_KEY` …）。这些是宿主
 * `@deepseek-ai/dsh-credentials-local` 用 `yaml` 包的 `document.setIn()` +
 * `toString()` 写进去的，输出是 **无引号 plain scalar**：
 *
 * ```yaml
 * refs:
 *   DEEPSEEK_API_KEY: sk-xxxxxxxx…
 *   ZAI_CODING_CN_API_KEY: xxxxxxxx…SuffixSuffix
 * ```
 *
 * 旧正则匹配不上 → 这些 ref **从解析结果里消失**，但文件里确实有。后果比
 * 「看不见」严重得多：`assertNoCredentialLoss()`（本模块专门为「绝不丢凭据」
 * 而设的写前自检）拿两份都没看见它们的解析结果相比，**判为无损失**
 * —— 于是任何「按解析结果重建 refs 段」的写法都会把它们静默删掉，而自检
 * 依然打印成功。2026-11-14 用户重启 DSH 后发现模型 API Key（DeepSeek、智谱）
 * 全部消失，就是这条通道。
 *
 * 本模块现在的契约因此再多一条：
 *
 * 4. **ref 的引号形态不参与识别**：plain / 单引号 / 双引号三种 YAML 标量写法
 *    都能读出键与值；改写未点名的 ref 时**逐字节保留原行**（引号形态不变）。
 * 5. **`refs:` 段里认不出形状的行一律 fail closed**：未点名的行必须与输入
 *    逐字节相同，否则拒绝落盘 —— 宁可报错，也不静默丢一枚凭据。
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

/** `refs:` 段内的一条条目：两空格缩进 + POSIX 标识符 + `:` + 任意 YAML 标量。 */
const REF_LINE = /^  ([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/

/** 注释 / 空行：不携带键，原样保留即可。 */
const IGNORABLE_LINE = /^\s*(?:#.*)?$/

/**
 * 把一条 `refs:` 条目的 YAML 标量还原成 JS 字符串。
 *
 * 支持宿主实际会写出的三种形态：plain（无引号）、单引号、双引号。
 * 认不出形状时返回 `undefined`，由调用方 fail closed —— 猜错会写坏一枚凭据。
 *
 * @param {string} body `KEY:` 之后的部分（可能为空）。
 * @returns {{ value: string, spelling: 'plain'|'single'|'double' } | undefined}
 */
export function parseRefScalar(body) {
  const text = (body ?? '').replace(/\s+$/, '')
  if (text === '') return { value: '', spelling: 'plain' }
  if (text.startsWith("'")) {
    // 单引号：唯一的转义是 '' → '
    if (text.length < 2 || !text.endsWith("'")) return undefined
    const inner = text.slice(1, -1)
    if (/(?<!')'(?!')/.test(inner)) return undefined
    return { value: inner.replaceAll("''", "'"), spelling: 'single' }
  }
  if (text.startsWith('"')) {
    // 双引号：只承认 JSON 兼容的那部分转义；其余形状交给调用方 fail closed。
    if (text.length < 2 || !text.endsWith('"')) return undefined
    try {
      const value = JSON.parse(text)
      if (typeof value !== 'string') return undefined
      return { value, spelling: 'double' }
    } catch {
      return undefined
    }
  }
  // block scalar（`>` / `|`）、锚点、标签、flow 集合：值跨行或另有语义，本模块
  // 没有能力安全重写。fail closed —— 猜错会写坏一枚读不懂的凭据。
  if (/^[>|&*!{[]/.test(text)) return undefined
  // plain scalar：值到行尾，` #` 之后是注释。
  const comment = text.search(/[ \t]#/)
  const value = (comment === -1 ? text : text.slice(0, comment)).replace(/\s+$/, '')
  return { value, spelling: 'plain' }
}

/** 单引号标量的写法（本模块改写时用：宿主能读，且不需要猜转义）。 */
export function quoteYamlSingle(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/** 反转义单引号标量（读回用）。 */
export function unquoteYamlSingle(raw) {
  return raw.replaceAll("''", "'")
}

/**
 * 渲染一条 `refs:` 条目行。字符串值原样写成单引号标量；`!`、`#`、前导/尾随
 * 空白等 YAML 会误解的形状一律靠单引号兜住，故不会与宿主写出 plain scalar
 * 的形态冲突（那只是另一种合法写法，读回等价）。
 */
function renderRefLine(name, value) {
  return `  ${name}: ${quoteYamlSingle(value)}`
}

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
 *   refLines: Map<string, { line: string, spelling: string }>,
 *   unparsedRefLines: string[],
 * }}
 *   `header` 是 `version: N\n`；`firstSection` 是紧跟在版本行后的段名
 *   （当前文件是 `refs`，历史文件是 `records`）。`refs` 的 value 是**解转义后
 *   的 JS 字符串**（plain / 单引号 / 双引号三种写法都归一），`refLines` 另存
 *   每条的原始行与标量写法，改写未点名的条目时逐字节复用。
 *   `sections` 的 `start`/`end` 是该段在 `text.split('\n')` 里的行号区间
 *   （含 `start`，不含 `end`），`lines[0]` 是段头本身。
 *   `unparsedRefLines` 是 `refs:` 段里认不出形状的条目行：值读不出来，但
 *   改写时必须原样保留 —— 重新渲染就会改掉别人的凭据。
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
  /** @type {Map<string, { line: string, spelling: string }>} 每条的原始行与标量写法 */
  const refLines = new Map()
  const unparsedRefLines = []
  const refsSection = sections.get('refs')
  if (refsSection !== undefined) {
    for (const line of refsSection.lines) {
      const ref = line.match(REF_LINE)
      if (ref === null) {
        if (!IGNORABLE_LINE.test(line)) unparsedRefLines.push(line)
        continue
      }
      const scalar = parseRefScalar(ref[2])
      if (scalar === undefined) {
        // 认不出形状：计入 unparsed，改写时原样保留，绝不静默丢弃。
        unparsedRefLines.push(line)
        continue
      }
      refs.set(ref[1], scalar.value)
      refLines.set(ref[1], { line, spelling: scalar.spelling })
    }
  }

  return { text, header, firstSection, sections, refs, refLines, unparsedRefLines }
}

/**
 * 把 `refs:` 值还原成 JS 值：能 JSON.parse 就用解析结果，否则当纯文本。
 *
 * ⚠️ 入参是 `readCredentialsDocument().refs` 里的值，**已经解过 YAML 引号**
 * （plain / 单引号 / 双引号三种写法都已归一），这里不再反转义 —— 再反转义
 * 一次正是历史上的二次编码事故。
 * ⚠️ 只解**一层**。历史的双编码缺陷（值本身是一段 JSON 文本，又被
 * `JSON.stringify` 一次）需要调用方自己再解一层 —— 见
 * `scripts/repair-wb-credentials.mjs` 的 `unwrap()`。
 */
export function parseRefValue(value) {
  const text = typeof value === 'string' ? value : String(value)
  try {
    return JSON.parse(text)
  } catch {
    return text
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
      const scalar = parseRefScalar(ref[2])
      if (scalar === undefined) {
        // 认不出标量形状（例如跨行折叠、锚点、标签）：值读不出来，又没被点名改写
        // —— 原样保留原行。绝不因为「解析不了」就把它删掉。
        lines.push(line)
        continue
      }
      seen.add(name)
      if (remove.has(name)) continue
      if (pending.has(name)) {
        lines.push(`  ${name}: ${quoteYamlSingle(pending.get(name))}`)
        continue
      }
      // ⚠️ 未点名的条目**逐字节复用原行**。宿主写进去的 plain scalar
      // （`  DEEPSEEK_API_KEY: sk-...`）就在这里被保住 —— 2026-11-14 事故
      // 正是重渲染时把它们改成了别的形状 / 直接漏掉。
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
 * 结构自检：新文本不得丢段、丢 ref、丢任何一条 `refs:` 行。
 *
 * 三层判据互为兜底，因为它们各自有盲区：
 *
 * - **段**：`records:` 等段消失 —— 2026-11-13 掉登录事故的形态；
 * - **能解析的 ref**：`refs` 里有、`refs` 里没有；
 * - **认不出形状的行**（`unparsedRefLines`）：值读不出来，但只要原行变了
 *   （被删、被重渲染、被合并），就说明有人改了一枚它没能力读的凭据。
 *   这一层是 2026-11-14 事故的补丁：plain scalar 的 ref 当时在**前两层里
 *   根本不存在**，自检于是判为「无损失」并放行了删除。
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
  // 认不出形状的行：一条都不许变（既不许消失，也不许被重渲染）。
  // 被显式 remove 的条目不在此列 —— 调用方已经确认过它们的键名。
  const removableLines = new Set(
    [...allowedRemoved].map((ref) => oldDoc.refLines.get(ref)?.line).filter((line) => line !== undefined),
  )
  const keptUnparsed = new Set(newDoc.unparsedRefLines)
  for (const line of oldDoc.unparsedRefLines) {
    if (removableLines.has(line)) continue
    if (!keptUnparsed.has(line)) {
      throw new Error('拒绝写入：refs: 段里有一行无法解析的凭据会改变或消失（宁可报错也不猜）')
    }
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
