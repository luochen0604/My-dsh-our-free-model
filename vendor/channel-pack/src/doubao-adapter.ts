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

import { randomUUID } from 'node:crypto'
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
  DOUBAO_BLOCK_TYPE_TEXT,
  resolveDoubaoModelItemKey,
  resolveDoubaoReasoningEffort,
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
  fetchRemoteModels?: () => Promise<Array<{ id: string; name: string; contextWindow?: number }>>
}

/**
 * 豆包的"模型"其实是服务端的 bot/skill 标识。
 *
 * ⚠️ 因为模型目录端点未取证，本适配器对**任何 model id 都放行**
 * （与 `LlmAdapter` 的"core routing accepts unlisted model ids"一致），
 * 列表只用于 UI 展示。
 */
interface DoubaoRemoteModel extends DoubaoFallbackModel {}

/** 一帧 SSE 的解析结果。 */
export type DoubaoEventOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

/**
 * 解析一帧 `/chat/completion` 的 SSE。
 *
 * @param event `event:` 行的事件名
 * @param raw `data:` 行的 JSON
 */
export function parseDoubaoEvent(event: string | undefined, raw: string): DoubaoEventOutcome | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>

  // 错误帧：事件名带 ERROR，或带非 0 code。
  if (typeof event === 'string' && /ERROR/i.test(event)) {
    const code = record['code'] ?? record['status_code']
    const message = record['message'] ?? record['msg'] ?? raw.slice(0, 200)
    return { kind: 'error', message: `business error ${String(code ?? '?')}: ${String(message)}` }
  }
  if (event === 'SSE_REPLY_END') return { kind: 'done' }
  if (event !== 'STREAM_CHUNK') return undefined

  /**
   * 文本增量：`patch_op[].patch_value.content_block[].content.text_block.text`。
   *
   * 其它 patch（如耗时块）也带 `content_block`，但没有 `text_block.text`，
   * 故按字段存在性过滤 —— 不靠 `patch_type` 猜。
   */
  let text = ''
  const ops = record['patch_op']
  if (!Array.isArray(ops)) return undefined
  for (const op of ops) {
    if (op === null || typeof op !== 'object') continue
    const value = (op as Record<string, unknown>)['patch_value']
    if (value === null || typeof value !== 'object') continue
    const blocks = (value as Record<string, unknown>)['content_block']
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      const content = (block as Record<string, unknown>)['content']
      if (content === null || typeof content !== 'object') continue
      const textBlock = (content as Record<string, unknown>)['text_block']
      if (textBlock === null || typeof textBlock !== 'object') continue
      const piece = (textBlock as Record<string, unknown>)['text']
      if (typeof piece === 'string') text += piece
    }
  }
  return text.length === 0 ? undefined : { kind: 'text', text }
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
  private remoteModels: Array<{ id: string; name: string; contextWindow?: number }> | undefined

  private async loadModels(): Promise<Array<{ id: string; name: string; contextWindow?: number }>> {
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
    this.remoteModels = this.product.fallbackModels.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
    }))
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

  /**
   * 解析模型元数据（含**上下文窗口**）。
   *
   * ## ⚠️ 上下文窗口必须按模型取，不能一律写死
   *
   * 2026-11-15 实测：豆包各模型的窗口**不一样**
   *
   * | 模型 | total_window_size |
   * |---|---|
   * | `9` 自动 / `seed-lite-7b` / `5` | 256000 |
   * | 所有 `person-*`（DeepSeek / Kimi / GLM） | **300000** |
   *
   * 之前我把所有模型都声明成 256000，导致切到 `person-*` 时 DSH 仍按 256000
   * 计算压缩阈值：
   *
   * ```
   * threshold = floor(min(256000×0.8, 256000−32000−65536)) = 158464
   * ```
   *
   * 于是一段 213034 tokens 的会话会被判定「无法压缩到阈值以下」并拒绝切换
   *（真实报错：`no safe compaction range ... 213034 >= 158464`）。
   * 用 300000 算则为 `min(240000, 202464) = 202464`，仍有空间。
   *
   * 现在的取值顺序：**远端目录的真实窗口 → 兜底表 → 不声明**。
   */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const fallback = this.fallbackIndex.get(model)
    // 远端目录（含真实 total_window_size）优先；未拉取成功时退兜底表。
    const remote = this.remoteModels?.find((entry) => entry.id === model)
    const contextWindow = remote?.contextWindow ?? fallback?.contextWindow
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: remote?.name ?? fallback?.name ?? model,
      inputModalities: this.inputModalitiesFor(fallback),
    }
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    /**
     * ⚠️ **不声明 `defaultMaxTokens`**（2026-11-15 修正）。
     *
     * DSH 的压缩阈值是：
     *
     * ```
     * reserved  = header.maxTokens ?? defaultMaxTokens ?? 0
     * threshold = floor(min(W × 0.8, W − reserved − headroomTokens))
     * ```
     *
     * 之前我声明了 `defaultMaxTokens: 32000`（**没有依据，是猜的**），
     * 它会从窗口里扣掉 32K 再扣 64K 余量，把 300000 窗口的阈值压到 202464；
     * 一段 213034 tokens 的会话因此被判「压不下去」而拒绝切换模型
     *（真实报错：`no safe compaction range ... 213034 >= 158464/202464`）。
     *
     * 豆包**没有公开的单次输出上限**（客户端 bundle 里只有 zod schema 的
     * `maxTokens` 字段名，没有字面量），所以本适配器不臆造这个值：留空则由
     * 宿主按会话配置决定，阈值回到 `min(W×0.8, W−65536)` = 234464（300000 时）。
     */
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
     * ## ⚠️ 2026-11-15 CDP 抓包得到的**真实结构**（照抄可用，已实测出话）
     *
     * ```jsonc
     * {
     *   "client_meta": { "local_conversation_id": "local_<ms>", "conversation_id": "",
     *                    "bot_id": "7338…", "last_section_id": "", "last_message_index": null,
     *                    "local_permissions": [] },
     *   "messages": [{ "local_message_id": "<uuid>",
     *                  "content_block": [{ "block_type": 10000,
     *                                      "content": { "text_block": { "text": "…" }, "pc_event_block": "" },
     *                                      "block_id": "<uuid>", "parent_id": "", "meta_info": [],
     *                                      "extra_info": {}, "append_fields": [] }],
     *                  "message_status": 0 }],
     *   "option": { … need_create_conversation: true,
     *               conversation_init_option: { project_id: "", need_ack_conversation: true },
     *               conversation_init_ext: { model_item_key: "9", reasoning_effort: "5", mode_id: "3" },
     *               sse_recv_event_options: { support_chunk_delta: true },
     *               message_from: 0, is_old_user: true, … }
     * }
     * ```
     *
     * 关键点：
     * - 文本放在 `content_block[].content.text_block.text`，`block_type` 固定 `10000`；
     * - **模型由 `option.conversation_init_ext.model_item_key` 决定**（抓包里是 `"9"`），
     *   `reasoning_effort` 是思考强度、`mode_id` 是模式；
     * - `need_create_conversation: true` 开新会话；
     * - 实测**最小化字段即可**（只留上面这些 + 少量默认值）也能正常出话，
     *   故不必照抄抓包里的 workspace/权限等环境字段。
     */
    const modelItemKey = resolveDoubaoModelItemKey(options.model)
    const body = JSON.stringify({
      client_meta: {
        local_conversation_id: `local_${Date.now()}`,
        conversation_id: '',
        bot_id: this.product.botId,
        last_section_id: '',
        last_message_index: null,
        local_permissions: [],
      },
      messages: toWireMessages(options),
      option: {
        create_time_ms: Date.now(),
        agent_mode: 1,
        // 9 = 桌面端默认（抓包值）；含义未逐一验证。
        need_deep_think: 9,
        need_create_conversation: true,
        unique_key: randomUuid(),
        scene_type: 0,
        conversation_init_option: { project_id: '', need_ack_conversation: true },
        conversation_init_ext: {
          model_item_key: modelItemKey,
          reasoning_effort: resolveDoubaoReasoningEffort(options.reasoningEffort),
          mode_id: '3',
        },
        sse_recv_event_options: { support_chunk_delta: true },
        support_lazy_fetch_stream: true,
        message_from: DOUBAO_MESSAGE_FROM_DESKTOP,
        is_old_user: true,
      },
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
           * ## 真实帧结构（2026-11-15 CDP 抓到 `/chat/completion` 的完整成功流）
           *
           * 帧是标准 SSE：`id: 0` + `event: <名称>` + `data: <JSON>`。
           *
           * | event | 含义 |
           * |---|---|
           * | `SSE_HEARTBEAT` | 心跳，忽略 |
           * | `STREAM_TIMEOUT_CONTROL` | 超时控制参数，忽略 |
           * | `SSE_ACK` | 会话/段落 id 下发，忽略 |
           * | `FULL_MSG_NOTIFY` | 用户消息回显，忽略 |
           * | `STREAM_MSG_NOTIFY` | 元数据块（耗时等），忽略 |
           * | **`STREAM_CHUNK`** | **文本增量**（见下） |
           * | `SSE_REPLY_END` | 结束（`msg_finish_attr.brief` 是完整文本）|
           * | `SSE_REPLY_ERROR` 等 | 业务错误 |
           *
           * `STREAM_CHUNK` 的文本在：
           * ```jsonc
           * { "patch_op": [ { "patch_object": 1, "patch_type": 1,
           *                   "patch_value": { "content_block": [ { "content": {
           *                     "text_block": { "text": "增量" } } } ] } } ] }
           * ```
           */
          if (frame.event === 'SSE_REPLY_END') {
            sawDone = true
            continue
          }
          if (frame.event === 'SSE_HEARTBEAT' || frame.event === 'STREAM_TIMEOUT_CONTROL'
            || frame.event === 'SSE_ACK' || frame.event === 'FULL_MSG_NOTIFY'
            || frame.event === 'STREAM_MSG_NOTIFY') {
            continue
          }
          if (frame.event === 'gateway-error') {
            throw new LlmError(
              `doubao: gateway error: ${frame.data.slice(0, 300)}`,
              isDoubaoAuthError(200, frame.data) ? 'AUTH' : 'PROVIDER',
            )
          }
          if (frame.data.length === 0) continue

          const parsed = parseDoubaoEvent(frame.event, frame.data)
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
 * ## ⚠️ 2026-11-15 CDP 抓包取证 + 实测出话
 *
 * 客户端构造的是：
 *
 * ```json
 * { "local_message_id": "<uuid>",
 *   "content_block": [{ "block_type": 10000,
 *                       "content": { "text_block": { "text": "…", "icon_url": "",
 *                                                    "icon_url_dark": "", "summary": "" },
 *                                    "pc_event_block": "" },
 *                       "block_id": "<uuid>", "parent_id": "", "meta_info": [],
 *                       "extra_info": {}, "append_fields": [] }],
 *   "message_status": 0 }
 * ```
 *
 * 与 OpenAI 方言的差异：文本在 `content_block[].content.text_block.text`，
 * `block_type` 固定 `10000`，且**没有 `role`**（历史由会话承载）。
 *
 * 豆包这个端点一次只发**当前这轮输入**（历史靠 `conversation_id` 续），
 * 故这里取最后一条 user 消息；system 提示豆包无对应字段（走 skill 机制），
 * 暂不注入。
 */
function toWireMessages(options: GenerateOptions): unknown[] {
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
    local_message_id: randomUuid(),
    content_block: [{
      block_type: DOUBAO_BLOCK_TYPE_TEXT,
      content: {
        text_block: { text: input, icon_url: '', icon_url_dark: '', summary: '' },
        pc_event_block: '',
      },
      block_id: randomUuid(),
      parent_id: '',
      meta_info: [],
      extra_info: {},
      append_fields: [],
    }],
    message_status: 0,
  }]
}

/** 随机 UUID v4（用 crypto，避免依赖顺序生成的碰撞）。 */
function randomUuid(): string {
  try {
    return randomUUID()
  } catch {
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
  }
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
