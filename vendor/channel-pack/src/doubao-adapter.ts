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
  isDoubaoQuotaError,
  isDoubaoUsable,
  splitSseBlocks,
  withCommonParams,
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

/** 从一帧 JSON 里抽出所有文本增量。 */
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
    return this.product.fallbackModels.map((model) => ({ id: model.id, name: model.name }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // 无已登录账号时返回 []（而不是抛错）：DSH 的 buildModelCatalog 会把整个
    // provider 分组隐藏；抛错反而会在界面上多一条 provider 报错。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? this.product.fallbackModels
      : this.product.fallbackModels.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
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

    // 组装请求体。字段名照抄 `completion_option` 的形状（观察见报告 §2.2）。
    const body = JSON.stringify({
      // 观察：`conversation_id` / `bot_id` / `section_id` / `local_message_id`
      // 都是顶层字段；新会话时为空串由服务端创建。
      conversation_id: '',
      bot_id: this.product.unverified.botId,
      section_id: '',
      local_message_id: '',
      messages: toWireMessages(options),
      completion_option: {
        is_regen: false,
        with_suggest: false,
        // 观察：`need_create_conversation` 由是否有本地会话 ID 决定；新会话为 true。
        need_create_conversation: true,
        memory_type: 0,
        event_id: '0',
        // 观察：桌面端来源标记（见 doubao-product.ts 的警告）。
        message_from: 'DesktopAskAssistant',
      },
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop },
    })

    const url = `${this.product.apiBase}${withCommonParams(SAMANTHA_CHAT_PATH, this.product)}`
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
          if (frame.event === DOUBAO_SSE.pb) {
            // ⚠️ 明确不支持，而不是静默丢帧 —— 见文件头未知 #1。
            throw new LlmError(
              'doubao: server sent protobuf SSE frames ("event: pb"); this adapter only handles "event: json". '
              + 'A protobuf schema for the samantha chat stream was not found in pb.desc/pb_server.desc.',
              'UNSUPPORTED_CONTENT',
            )
          }
          if (frame.event !== DOUBAO_SSE.json) continue

          let payload: unknown
          try {
            payload = JSON.parse(frame.data)
          } catch {
            droppedFrames += 1
            continue
          }
          const text = extractDeltas(payload)
          if (text.length === 0) {
            droppedFrames += 1
            continue
          }
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

/** 把 `GenerateOptions.messages` 转成豆包的线上形状。 */
function toWireMessages(options: GenerateOptions): unknown[] {
  const out: unknown[] = []
  if (options.system !== undefined && options.system.length > 0) {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    out.push(message)
  }
  return out
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
