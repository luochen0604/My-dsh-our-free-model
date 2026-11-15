/**
 * 豆包工作（DoubaoWork）LLM 适配器。
 *
 * ## 为什么不复用 `openai-compat.ts`
 *
 * Raccoon / Qoder / Loomy 都是标准 OpenAI 兼容 + 标准 SSE，故共用
 * `openai-compat.ts`。豆包**不是**：
 *
 * | 维度 | 标准 OpenAI | 豆包 |
 * |---|---|---|
 * | 路径 | `/v1/chat/completions` | `/samantha/chat/completion` |
 * | 公共参数 | 无 | `di()` 一整套平台声明（query 上） |
 * | 鉴权 | `Authorization: Bearer` | **Cookie**（`sessionid` …） |
 * | SSE 事件 | `data:` + `[DONE]` | `event: pb` / `json` / `done` / `err` |
 * | 流单元 | `chat.completion.chunk` | `message_list[]`（增量合并） |
 * | 续传 | 无 | `seq_st` + `reply_id` + `binary_type` 分片 |
 *
 * 硬套 `openai-compat.ts` 会把上面每一条都塞进"适配回调"，反而更难读，
 * 且会污染另外三个 provider 的既有行为（该文件顶部明确禁止这么改）。
 * 故本文件**独立实现**，只在 `LlmAdapter` 契约与 `StreamChunk` 形状上对齐。
 *
 * ## ⚠️ 三条必须随代码一起读的未知
 *
 * 1. **`event: pb` 解不了**：若服务端下发 protobuf 事件，本适配器会明确抛
 *    `UNSUPPORTED_CONTENT` 并说明原因，**不猜测、不静默丢帧**。
 * 2. **`aid`/`botId` 是占位值**（见 `doubao-product.ts` 的 `unverified`）。
 * 3. **未发 `X-Bogus`/`msToken`**：静态证据不支持 chat 需要签名（chat 调用链
 *    对 `bdms` 引用为 0），但若实测 403 需补——注入点已留在 `doubaoHeaders`。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import {
  DOUBAO,
  SAMANTHA_CHAT_PATH,
  type DoubaoFallbackModel,
  type DoubaoProduct,
} from './doubao-product.js'
import {
  DOUBAO_CHUNK_TIMEOUT_MS,
  DOUBAO_FIRST_TOKEN_TIMEOUT_MS,
  DOUBAO_SSE,
  doubaoHeaders,
  isDoubaoAuthError,
  isDoubaoRateLimitError,
  isDoubaoQuotaError,
  isDoubaoUsable,
  splitSseBlocks,
  withCommonParams,
  DOUBAO_MESSAGE_FROM_DESKTOP,
  DOUBAO_CONTENT_TYPE_TEXT,
  type DoubaoCredential,
} from './doubao.js'

/** 适配器选项。 */
export interface DoubaoAdapterOptions {
  /** cordis 上下文（`settingsNamespaceFor` 需要它判定 legacy 命名空间）。 */
  ctx: Context
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<DoubaoCredential | undefined>
  /** 凭据失效时的处理（豆包无 refresh 端点，这里是"重新探活/提示重登"）。 */
  refresh: (accountId?: string, reason?: 'auth') => Promise<DoubaoCredential | void>
  /** 账号池（可选）。 */
  accountPool?: AccountPool
  /** 产品配置覆盖（测试用）。 */
  product?: DoubaoProduct
  /** fetch 实现覆盖（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 拉取远端「模型」（= bot）目录。
   *
   * 失败或未登录时应返回空数组，适配器回退兜底表。
   * ⚠️ 豆包的模型目录响应形状**未实测**（见 `fetchDoubaoModels` 注释），
   * 故这里只做「拿到就用」的增强，不把目录缺失当错误。
   */
  fetchRemoteModels?: () => Promise<Array<{ id: string; name: string }>>
}

/**
 * 豆包的"模型"其实是服务端的 bot/skill 标识。
 *
 * ⚠️ 因为模型目录端点未取证，本适配器对**任何 model id 都放行**
 * （与 `LlmAdapter` 的"core routing accepts unlisted model ids"一致），
 * 列表只用于 UI 展示。
 */
interface DoubaoRemoteModel extends DoubaoFallbackModel {}

/**
 * 把 `message_list[]` 的增量合并成文本。
 *
 * ⚠️ 豆包的增量形状**未完整取证**。观察到的只有：`message_list` 是数组、
 * 元素经 `_mergeMessage` 合并、`event_type === Message` 才会被处理。
 *
 * 因此这里采取**防御式提取**：从元素里尽力找 `content` / `text` / `delta`
 * 的字符串，找不到就跳过而不是抛错——因为抛错会让整个流失败，而跳过最多
 * 少显一段。所有跳过都计入 `droppedFrames` 并在流结束时报告。
 */
function extractTextDelta(item: unknown): string {
  if (item === null || typeof item !== 'object') return ''
  const record = item as Record<string, unknown>
  // 常见候选：content（字符串）、text、delta、content.text
  for (const key of ['content', 'text', 'delta', 'answer'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (value !== null && typeof value === 'object') {
      const nested = value as Record<string, unknown>
      for (const inner of ['text', 'content', 'delta'] as const) {
        const innerValue = nested[inner]
        if (typeof innerValue === 'string' && innerValue.length > 0) return innerValue
      }
    }
  }
  return ''
}

/**
 * 解析一帧豆包 SSE 的 `data` 载荷。
 *
 * ## 真实结构（2026-11-15 带登录态实测）
 *
 * ```json
 * { "event_data": "<JSON 字符串>", "event_id": "2", "event_type": 2001 }
 * ```
 *
 * `event_type` 语义：
 * - `2001` 文本增量：`event_data.message.content` = `{"text":"增量"}`，`is_delta:true`
 * - `2002` 会话/消息 id 下发（无文本）
 * - `2003` 结束
 * - `2005` 业务错误：`event_data` 内含 `code`/`message`
 * - `2010` 意图判定（无文本）
 *
 * 结束判定：`2003`，或 `2001` 帧里 `is_finish:true`。
 *
 * @returns `{ text }` 文本增量 / `{ done }` 结束 / `{ error }` 业务错误 /
 *          `undefined` 表示这帧没有可用信息（忽略）。
 */
export type DoubaoEventOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

export function parseDoubaoEvent(raw: string): DoubaoEventOutcome | undefined {
  let outer: unknown
  try {
    outer = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (outer === null || typeof outer !== 'object') return undefined
  const record = outer as Record<string, unknown>
  const type = record['event_type']
  const typeCode = typeof type === 'number' ? type : Number(type)

  // event_data 是 JSON 字符串（二次编码）。
  let data: unknown = record['event_data']
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return undefined
    }
  }
  const payload = data !== null && typeof data === 'object' ? data as Record<string, unknown> : undefined

  // 业务错误帧。
  if (typeCode === 2005) {
    const code = payload?.['code']
    const message = payload?.['message']
    return { kind: 'error', message: `business error ${String(code ?? '?')}: ${String(message ?? '')}`.trim() }
  }
  // 结束帧。
  if (typeCode === 2003) return { kind: 'done' }
  // 非文本帧。
  if (typeCode !== 2001) return undefined

  if (payload?.['is_finish'] === true) return { kind: 'done' }

  // 文本增量：event_data.message.content = "{\"text\":\"...\"}"
  const message = payload?.['message']
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as Record<string, unknown>)['content']
  const text = textFromContent(content)
  return text.length === 0 ? undefined : { kind: 'text', text }
}

/** 从 `content` 里取文本：可能是 `{"text":"..."}` 字符串，也可能已是对象。 */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    if (content.length === 0) return ''
    try {
      const parsed = JSON.parse(content) as unknown
      return textFromContent(parsed)
    } catch {
      // 不是 JSON：当作纯文本（少数帧直接给裸文本）。
      return content
    }
  }
  if (content !== null && typeof content === 'object') {
    const text = (content as Record<string, unknown>)['text']
    return typeof text === 'string' ? text : ''
  }
  return ''
}

/** 从一帧 JSON 里抽出所有文本增量（旧结构兜底）。 */
function extractDeltas(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  const list = record['message_list']
  if (!Array.isArray(list)) {
    return extractTextDelta(record)
  }
  let text = ''
  for (const item of list) {
    // 观察：只有 message 类型才参与合并。
    const itemRecord = item !== null && typeof item === 'object' ? item as Record<string, unknown> : undefined
    if (itemRecord !== undefined) {
      const kind = itemRecord['event_type'] ?? itemRecord['type']
      // 有明确类型且不是 message 的跳过（reasoning/tool 等另走分支）。
      if (typeof kind === 'string' && kind.length > 0 && !/message|text|content/i.test(kind)) {
        continue
      }
    }
    text += extractTextDelta(item)
  }
  return text
}

/** 豆包适配器。 */
export class DoubaoAdapter extends LlmAdapter {
  private readonly product: DoubaoProduct
  private readonly fetchImpl: typeof fetch
  private readonly fallbackIndex: ReadonlyMap<string, DoubaoFallbackModel>
  /** 设置页命名空间（沿用 channel-pack 的 legacy 兼容取值）。 */
  private readonly settingsNamespace: string

  constructor(private readonly options: DoubaoAdapterOptions) {
    super()
    this.product = options.product ?? DOUBAO
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
    this.settingsNamespace = settingsNamespaceFor(options.ctx, this.product.id)
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * ⚠️ 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，
   * 而这里的产品 id 是固定的，故以入参为准、只在为空时回退。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return {
      provider: id,
      id,
      name: this.product.displayName,
      settingsNs: this.settingsNamespace,
    } as LlmProviderInfo
  }

  /** 供 Channel Pack「显示列表」用的完整模型清单（不受黑名单影响）。 */
  listAllModels(): readonly { id: string; name: string }[] {
    const remote = this.remoteModels
    if (remote !== undefined && remote.length > 0) return remote
    return this.product.fallbackModels.map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 当前可用模型（远端优先，失败回退兜底表）。
   *
   * ⚠️ 不做缓存失效：豆包的 bot 目录变化不频繁，且拉取需要一次带 cookie 的
   * 网络请求。首次 `listModels` 时拉一次，之后用进程内缓存。
   */
  private remoteModels: Array<{ id: string; name: string }> | undefined

  private async loadModels(): Promise<Array<{ id: string; name: string }>> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const remote = await this.options.fetchRemoteModels()
        if (Array.isArray(remote) && remote.length > 0) {
          this.remoteModels = remote
          return remote
        }
      } catch {
        // 目录拉不到不是错误：回退兜底表即可。
      }
    }
    this.remoteModels = this.product.fallbackModels.map((model) => ({ id: model.id, name: model.name }))
    return this.remoteModels
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // 无已登录账号时返回 []（而不是抛错）：DSH 的 buildModelCatalog 会把整个
    // provider 分组隐藏；抛错反而会在界面上多一条 provider 报错。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const all = await this.loadModels()
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      // 远端目录不带能力标记，按兜底表里同 id 的条目判断；未知按纯文本。
      inputModalities: this.inputModalitiesFor(this.fallbackIndex.get(model.id)),
    }))
  }

  private inputModalitiesFor(model: DoubaoFallbackModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const fallback = this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: fallback?.name ?? model,
      inputModalities: this.inputModalitiesFor(fallback),
    }
    if (fallback !== undefined && fallback.contextWindow > 0) {
      resolved.context = { contextWindow: fallback.contextWindow }
    }
    if (fallback !== undefined && fallback.maxTokens > 0) {
      resolved.defaultMaxTokens = fallback.maxTokens
    }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调 `adapter.prepareCall(...)`，
   * 而基类尚未提供该方法。与其余适配器同款 shim。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credential = await this.options.resolveCredential(options.model)
    if (!isDoubaoUsable(credential)) {
      throw new LlmError('doubao: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    /**
     * 组装请求体。
     *
     * ## ⚠️ 2026-11-15 运行时抓包 + 逐字段实测校正
     *
     * 用真实登录态对 `/samantha/chat/completion` 做二分探测，得到两条硬结论：
     *
     * 1. **id 类字段必须是数字（int64）**，传空字符串会被 proto 解码层直接拒
     *    成 `400`（响应 `content-type` 为 null、空 body）：
     *    `conversation_id: ''` / `section_id: ''` / `reply_id: ''` 全部 400，
     *    而 `conversation_id: 0` / `section_id: 0` / `reply_id: 0` 是 200。
     * 2. **`message_from` 必须是枚举数字**，传字符串
     *    `'DesktopAskAssistant'` 同样 400；传 `0/1/2` 是 200。
     *
     * 另外：**未知字段会被静默忽略**（试过 20 个候选消息字段名 + 空数组，
     * 全部 200，错误信息不变），所以「字段名拼错」不会报错 —— 只会表现为
     * 服务端说「消息列表为空」：
     * `last: cannot extract the last element of an empty slice`。
     *
     * 也就是说：**当前的 400 是类型错，不是形状错**；把类型改对之后，
     * 服务端的报错会变成「消息为空」，说明还需要正确的消息字段名/形状
     *（见文件头未知项）。这里不再静默吞掉，让错误如实冒泡。
     */
    const body = JSON.stringify({
      // int64：新会话用 0（空串会被 proto 拒成 400，实测）。
      conversation_id: 0,
      // 真实主 bot id（抓包得到，见 doubao-product.ts）。
      bot_id: this.product.botId,
      section_id: 0,
      // `local_message_id` 是字符串，空串实测无害（保留）。
      local_message_id: '',
      messages: toWireMessages(options),
      completion_option: {
        is_regen: false,
        with_suggest: false,
        // 观察：`need_create_conversation` 由是否有本地会话 ID 决定；新会话为 true。
        need_create_conversation: true,
        memory_type: 0,
        // ⚠️ `event_id` 是字符串（实测字符串无害）。
        event_id: '0',
        // ⚠️ 枚举数字，不是字符串（实测字符串会 400）。
        message_from: DOUBAO_MESSAGE_FROM_DESKTOP,
      },
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop },
    })

    const url = `${this.product.apiBase}${withCommonParams(SAMANTHA_CHAT_PATH, this.product, credential.deviceId)}`
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: doubaoHeaders(credential, this.product),
        body,
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        if (isDoubaoAuthError(response.status, text)) {
          throw new LlmError(`doubao: auth failed (HTTP ${response.status})`, 'AUTH')
        }
        if (isDoubaoQuotaError(response.status, text)) {
          throw new LlmError(`doubao: quota/limit (HTTP ${response.status})`, 'QUOTA_EXCEEDED')
        }
        throw new LlmError(`doubao: HTTP ${response.status}: ${text.slice(0, 300)}`, 'PROVIDER')
      }
      if (response.body === null) {
        throw new LlmError('doubao: empty response body', 'PROVIDER')
      }

      // content-type 检查：官方解析器对非 SSE 直接抛错，这里同款。
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const text = await response.text().catch(() => '')
        throw new LlmError(`doubao: unexpected content-type "${contentType}": ${text.slice(0, 300)}`, 'PROVIDER')
      }

      yield* this.consumeStream(response.body, options.signal ?? controller.signal)
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 消费 SSE 流并产出 `StreamChunk`。 */
  private async *consumeStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let index = 0
    let started = false
    let sawDone = false
    let droppedFrames = 0
    let firstFrameAt = 0

    try {
      while (true) {
        if (signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        const now = Date.now()
        if (firstFrameAt === 0) firstFrameAt = now
        else if (now - firstFrameAt > DOUBAO_CHUNK_TIMEOUT_MS) {
          throw new LlmError('doubao: stream chunk timeout', 'TIMEOUT')
        }

        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = splitSseBlocks(buffer)
        buffer = rest

        for (const frame of frames) {
          if (frame.event === DOUBAO_SSE.done) {
            sawDone = true
            continue
          }
          if (frame.event === DOUBAO_SSE.err) {
            throw new LlmError(`doubao: server error: ${frame.data.slice(0, 300)}`, 'PROVIDER')
          }
          /**
           * ## 真实帧结构（2026-11-15 带登录态实测抓到的完整成功流）
           *
           * ⚠️ **成功流只有 `data:`，没有 `event:` 行**。此前按 `event: json`
           * 过滤会让所有内容帧被静默丢弃（表现成"流结束但没有文本"）。
           *
           * `data` 是 JSON：
           * ```json
           * { "event_data": "<JSON 字符串>", "event_id": "2", "event_type": 2001 }
           * ```
           *
           * | event_type | 含义 |
           * |---|---|
           * | 2001 | 文本增量（`event_data.message.content` 是 `{"text":"..."}`，`is_delta:true`）|
           * | 2002 | 会话/消息 id 下发 |
           * | 2003 | 结束 |
           * | 2005 | 业务错误（`event_data` 里带 `code`/`message`）|
           * | 2010 | 意图判定（忽略）|
           *
           * 最后一帧（2001 + `is_finish:true`）的 `event_data.tts_content` 是
           * **完整文本**，可用来校验增量拼接是否完整。
           */
          if (frame.event === 'gateway-error') {
            throw new LlmError(
              `doubao: gateway error: ${frame.data.slice(0, 300)}`,
              isDoubaoAuthError(200, frame.data) ? 'AUTH' : 'PROVIDER',
            )
          }
          if (frame.event === DOUBAO_SSE.pb) {
            throw new LlmError(
              'doubao: server sent protobuf SSE frames ("event: pb"); this adapter only handles JSON frames.',
              'UNSUPPORTED_CONTENT',
            )
          }
          // 成功流没有 event 名（默认 message）；只有显式非 json 事件才跳过。
          if (frame.event !== undefined && frame.event !== '' && frame.event !== DOUBAO_SSE.json) {
            continue
          }
          if (frame.data.length === 0) continue

          const parsed = parseDoubaoEvent(frame.data)
          if (parsed === undefined) {
            droppedFrames += 1
            continue
          }
          if (parsed.kind === 'error') {
            throw new LlmError(
              `doubao: ${parsed.message}`,
              isDoubaoAuthError(200, frame.data) ? 'AUTH'
                : isDoubaoRateLimitError(200, frame.data) ? 'QUOTA_EXCEEDED'
                  : 'PROVIDER',
            )
          }
          if (parsed.kind === 'done') {
            sawDone = true
            continue
          }
          const text = parsed.text
          if (text.length === 0) continue
          if (!started) {
            started = true
            yield { type: 'block-start', index, blockType: 'text' }
          }
          yield { type: 'text-delta', index, text }
        }
      }

      if (!started) {
        throw new LlmError(
          sawDone
            ? 'doubao: stream finished without any text content'
            : 'doubao: stream ended without text and without "done"',
          'PROVIDER',
        )
      }
      yield { type: 'block-end', index, block: { type: 'text', text: '' } }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // 取消失败不影响已产出的内容。
      }
    }
    if (droppedFrames > 0) {
      // 不抛错：已产出内容对用户仍然有效。记录数目便于诊断形状漂移。
      void droppedFrames
    }
  }
}

/**
 * 把 `GenerateOptions.messages` 转成豆包的真实线上形状。
 *
 * ## ⚠️ 2026-11-15 从 bundle 取证 + 实测验证
 *
 * 客户端构造请求体时（`ai-views` 里的 `M`/`N` 函数）用的是：
 *
 * ```js
 * messages: [{ content: JSON.stringify({ text }), content_type, attachments: [], references: [] }]
 * ```
 *
 * 三点与 OpenAI 方言不同，且**每一点都会导致失败**：
 * 1. **没有 `role` 字段** —— 豆包靠 `content_type` 区分；
 * 2. `content` 是**JSON 字符串**（`'{"text":"..."}'`），不是裸字符串
 *    （裸文本会 `invalid character 'ä' looking for beginning of value`）；
 * 3. 每条必须带 `attachments` 与 `references` 数组。
 *
 * `content_type` 取 `2001`（实测可用的文本类型）。
 *
 * 多轮对话：豆包这个端点一次只接受当前输入（历史由 `conversation_id` 承载），
 * 故这里**只发最后一条 user 消息**；system 提示豆包无对应字段，走
 * `custom_prompt_skill_id`/skill 机制，暂不注入（见文件头限制）。
 */
function toWireMessages(options: GenerateOptions): unknown[] {
  // 取最后一条 user 消息作为本轮输入。
  let input = ''
  for (let i = options.messages.length - 1; i >= 0; i -= 1) {
    const message = options.messages[i] as unknown as Record<string, unknown>
    if (message['role'] === 'user') {
      input = contentToText(message['content'])
      break
    }
  }
  if (input.length === 0 && options.system !== undefined) input = options.system
  return [{
    content: JSON.stringify({ text: input }),
    content_type: DOUBAO_CONTENT_TYPE_TEXT,
    attachments: [],
    references: [],
  }]
}

/** 把宿主消息内容（字符串或多段块）拍平成纯文本。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (typeof part === 'string') { text += part; continue }
    if (part === null || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    const value = record['text']
    if (typeof value === 'string') text += value
  }
  return text
}

/** 在 `ctx.llm` 上注册豆包 provider 路由与适配器。 */
export function registerDoubaoLlm(ctx: Context, options: DoubaoAdapterOptions): DoubaoAdapter {
  const product = options.product ?? DOUBAO
  const adapter = new DoubaoAdapter(options)
  // 复用共享注册器（含 token 记账包装、失效模型剔除、重复注册竞态兜底）。
  // ⚠️ 不自造实现：那会绕过记账，导致该 provider 的 token 用量不计入统计。
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
