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
  doubaoHeaders,
  isDoubaoAuthError,
  isDoubaoRateLimitError,
  isDoubaoSlideChallenge,
  isDoubaoSemanticRisk,
  describeDoubaoFailure,
  isDoubaoQuotaError,
  isDoubaoUsable,
  splitSseBlocks,
  parseDoubaoSseFrame,
  type DoubaoSseOutcome,
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

/**
 * 一帧 SSE 的解析结果。
 *
 * @deprecated 语义解析已统一收敛到 `doubao.ts` 的 `parseDoubaoSseFrame`。
 * 保留此别名只为兼容既有导入路径；新代码请直接用 `DoubaoSseOutcome`。
 */
export type DoubaoEventOutcome = DoubaoSseOutcome

/**
 * 解析一帧 `/chat/completion` 的 SSE。
 *
 * @deprecated 请改用 `doubao.ts` 的 `parseDoubaoSseFrame` —— 它按实测事件名
 * （`CHUNK_DELTA` / `STREAM_CHUNK` / `SSE_ACK` / `SSE_REPLY_END` / `STREAM_ERROR`）
 * 做完整分类，并正确处理思考块与反问块。本函数只保留旧的三分支形状，
 * 会漏掉会话 ack、思考过程与反问（真实缺陷：反问时调用方挂到超时）。
 */
export function parseDoubaoEvent(event: string | undefined, raw: string): DoubaoEventOutcome | undefined {
  const frame = { event: typeof event === 'string' ? event : '', data: raw }
  const outcome = parseDoubaoSseFrame(frame)
  if (outcome === undefined) return undefined
  if (outcome.kind === 'end') return { kind: 'end', endType: outcome.endType, brief: outcome.brief }
  return outcome
}

/** 豆包适配器。 */
export class DoubaoAdapter extends LlmAdapter {
  private readonly product: DoubaoProduct
  private readonly fetchImpl: typeof fetch
  private readonly fallbackIndex: ReadonlyMap<string, DoubaoFallbackModel>
  /** 设置页命名空间（沿用 channel-pack 的 legacy 兼容取值）。 */
  private readonly settingsNamespace: string

  /**
   * 会话复用缓存：DSH 会话键 → 豆包侧 `conversation_id`。
   *
   * ## 为什么必须复用（而不是每轮都开新会话）
   *
   * 豆包这个端点的请求体**只带当前这一轮的输入**（`messages` 里只有一条
   * `content_block`），历史上下文完全靠服务端的 `conversation_id` 承载。
   * 每轮都发 `need_create_conversation: true` + 空 `conversation_id`，
   * 等于每轮都从零开始：模型看不到前文，多轮对话直接失效。
   *
   * 参考实现（`dsh-connect-doubaowork` 的 `shim.js`）用的是
   * 「显式 metadata 优先，否则按『模型 + 首条消息』哈希」的键；这里用
   * DSH 提供的 `options.sessionId`（宿主盖章的会话标识）作为键，
   * 它比消息哈希稳定：同一会话里首条消息变化（压缩、编辑）不会散成多条豆包会话。
   *
   * 键缺省时（一次性调用 / 测试）退化为**不复用**，保持原语义。
   *
   * ⚠️ 有界：只保留最近 `MAX_REMEMBERED_CONVERSATIONS` 条，避免长驻进程
   * 无限增长（与 shim.js 的 `MAX_CONVERSATIONS` 同思路）。
   */
  private readonly conversations = new Map<string, { conversationId: string; sectionId: string }>()

  constructor(private readonly options: DoubaoAdapterOptions) {
    super()
    this.product = options.product ?? DOUBAO
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
    this.settingsNamespace = settingsNamespaceFor(options.ctx, this.product.id)
  }

  /** 会话缓存容量上限。 */
  private static readonly MAX_REMEMBERED_CONVERSATIONS = 512

  /** 取某 DSH 会话对应的豆包会话（无则 undefined）。 */
  private resumeFor(sessionKey: string | undefined): { conversationId: string; sectionId: string } | undefined {
    if (sessionKey === undefined || sessionKey.length === 0) return undefined
    return this.conversations.get(sessionKey)
  }

  /** 记住某 DSH 会话对应的豆包会话（LRU 式淘汰最旧）。 */
  private rememberConversation(sessionKey: string | undefined, conversationId: string, sectionId: string): void {
    if (sessionKey === undefined || sessionKey.length === 0 || conversationId.length === 0) return
    // 先删再插 —— Map 保序，这样最旧的总在头部。
    this.conversations.delete(sessionKey)
    this.conversations.set(sessionKey, { conversationId, sectionId })
    while (this.conversations.size > DoubaoAdapter.MAX_REMEMBERED_CONVERSATIONS) {
      const oldest = this.conversations.keys().next().value
      if (oldest === undefined) break
      this.conversations.delete(oldest)
    }
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

    /**
     * 会话复用：同一 DSH 会话的第二轮起接着原豆包会话走。
     *
     * `sessionKey` 用宿主的 `sessionId`（见 `conversations` 字段注释）。
     * 拿不到就退化为单轮语义，行为与改动前一致。
     */
    const sessionKey = typeof options.sessionId === 'string' ? options.sessionId : undefined
    const resume = this.resumeFor(sessionKey)
    const conversationId = resume?.conversationId ?? ''

    const body = JSON.stringify({
      client_meta: {
        local_conversation_id: `local_${Date.now()}`,
        // 有会话就带上，服务端据此续上下文；空串 = 开新会话。
        conversation_id: conversationId,
        bot_id: this.product.botId,
        last_section_id: resume?.sectionId ?? '',
        last_message_index: null,
        /**
         * ⚠️ 客户端真实发的是**三条本地权限声明**（不是空数组）。
         *
         * 实测：发 `[]` 时更容易被语义风控判为可疑请求；客户端始终发下面这三条
         *（`status: 2` = 未授予/声明未请求），照抄即可。
         */
        local_permissions: [
          { permission_name: 'ACCESS_COARSE_LOCATION', status: 2 },
          { permission_name: 'ACCESS_FINE_LOCATION', status: 2 },
          { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 2 },
        ],
      },
      // 续会话时只发本轮输入（历史在服务端）；新会话时把历史压平成一段。
      messages: toWireMessages(options, conversationId !== '' ),
      option: {
        // 客户端会把这批布尔/字符串默认值**全部显式发出**（共 42 个键），
        // 缺一大半会让请求看起来不像真客户端。这里补齐关键默认值。
        send_message_scene: '',
        collect_id: '',
        is_audio: false,
        answer_with_suggest: false,
        agent_mode: 1,
        tts_switch: false,
        // 9 = 桌面端默认（抓包值）；含义未逐一验证。
        need_deep_think: 9,
        click_clear_context: false,
        from_suggest: false,
        is_regen: false,
        is_replace: false,
        is_from_click_option: false,
        is_from_click_softlink: false,
        disable_sse_cache: false,
        select_text_action: '',
        is_select_text: false,
        resend_for_regen: false,
        scene_type: 0,
        unique_key: randomUuid(),
        start_seq: 0,
        // 有会话就不新建；否则服务端每次都会开一条新记录。
        need_create_conversation: conversationId === '',
        conversation_init_option: { project_id: '', need_ack_conversation: true },
        conversation_init_ext: {
          /**
           * ⚠️ 客户端在这里带 `agent_task_param`（一段被转义的 JSON），
           * 声明本地设备与环境：`runtime_type` / `sandbox_auth_type` /
           * `device_name` / `local_app_id` / **`local_device_id`** / `workspace`。
           *
           * 我们不发 workspace（那是客户端本地路径，OFM 没有也不该伪造），
           * 但**发 device_name 与 local_device_id** —— 让请求带上"这台机器"的
           * 一致身份。缺它时服务端只看得到一个无设备信息的请求。
           */
          agent_task_param: buildAgentTaskParam(this.product, credential),
          model_item_key: modelItemKey,
          reasoning_effort: resolveDoubaoReasoningEffort(options.reasoningEffort),
          mode_id: '3',
        },
        regen_query_id: [],
        edit_query_id: [],
        regen_instruction: '',
        no_replace_for_regen: false,
        message_from: DOUBAO_MESSAGE_FROM_DESKTOP,
        shared_app_name: '',
        shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true },
        support_lazy_fetch_stream: true,
        is_ai_playground: false,
        is_old_user: true,
      },
      // 客户端固定发这两个顶层字段；缺了会让请求结构偏离。
      user_context: [],
      ext: {},
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
        if (isDoubaoSlideChallenge(text)) {
          throw new LlmError(`doubao: ${describeDoubaoFailure(text)}`, 'PROVIDER')
        }
        if (isDoubaoQuotaError(response.status, text)) {
          throw new LlmError(`doubao: quota/limit (HTTP ${response.status})`, 'QUOTA_EXCEEDED')
        }
        throw new LlmError(`doubao: ${describeDoubaoFailure(text)}`, 'PROVIDER')
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

      yield* this.consumeStream(
        response.body,
        options.signal ?? controller.signal,
        resume,
        (nextConversationId, nextSectionId) => {
          this.rememberConversation(sessionKey, nextConversationId, nextSectionId)
        },
      )
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 消费 SSE 流并产出 `StreamChunk`。
   *
   * ## 与旧实现的差异（2026-11-15 按参考实现 + 实测帧重写）
   *
   * | 能力 | 旧实现 | 现在 |
   * |---|---|---|
   * | `CHUNK_DELTA` 纯文本增量 | 不处理 | 优先消费，并抑制 `STREAM_CHUNK` 全文 |
   * | 思考过程 `block_type=10040` | 丢弃 | 产出 `reasoning` 块 |
   * | `SSE_ACK` 会话 id | 忽略 | **回填会话缓存，下一轮复用** |
   * | 反问 `block_type=10082` | 丢弃 → 挂到超时 | 转成正文 + **立即收尾** |
   * | `SSE_REPLY_END.brief` | 忽略 | 无正文时的兜底全文 |
   *
   * @returns 本轮的会话 id（`SSE_ACK` 下发的 `conversation_id`；没有则为 `''`）
   */
  private async *consumeStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    resume: { conversationId: string; sectionId: string } | undefined,
    onConversation: (conversationId: string, sectionId: string) => void,
  ): AsyncIterable<StreamChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    /** 下一个可用的块序号（reasoning 与 text 共用，避免撞号）。 */
    let nextIndex = 0
    let textIndex = 0
    let reasoningIndex = 0
    let sawText = false
    let sawReasoning = false
    let sawDone = false
    let sawClarify = false
    let finishedBrief = ''
    let clarifiedQuestions: string[] = []
    let conversationId = resume?.conversationId ?? ''
    let sectionId = resume?.sectionId ?? ''
    let firstFrameAt = 0
    let lastFrameAt = 0

    /**
     * 用量（`StreamChunk` 的 `usage` 块）。
     *
     * ⚠️ **2026-11-19 补发**：此前适配器从不发出 `usage` 块。网关的
     * `consumeChunk` 把 `usage` 存入 `state.usage`，收流结束后用它生成
     * OpenAI 的 `usage` 字段。缺它 → 下游拿到的每次调用都没有用量统计。
     *
     * 数据源：`patch_object=50` 的 `ext.context_window_usage`（实测帧）。
     */
    let usage: { inputTokens: number; totalWindowSize: number } | undefined

    /**
     * 终止原因（`StreamChunk` 的 `finish` 块）。
     *
     * ⚠️ **2026-11-19 补发（最关键）**：此前适配器从不发出 `finish` 块。
     * 网关在收流结束后检查 `state.finishReason === undefined`，是的话
     * 直接抛 `incomplete_stream` 502 —— **意味着通过网关的每一次豆包调用
     * 都会失败**，无论上游是否成功返回了正文。
     *
     * 数据源：`patch_object=50` 的 `ext.finish_reason_chat`（实测帧）。
     * 服务端没给时回退 `'stop'`（豆包正常说完就是 stop）。
     */
    let finishReason: 'stop' | 'max-tokens' | undefined

    /** 收尾：把还开着的块关掉（先 reasoning 后 text，与开启顺序相反）。 */
    const closeBlocks = function* closeBlocks(): Generator<StreamChunk> {
      if (sawReasoning) {
        yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: '' } }
      }
      if (sawText) {
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: '' } }
      }
    }

    try {
      while (true) {
        if (signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        const now = Date.now()
        if (firstFrameAt === 0) firstFrameAt = now
        lastFrameAt = now
        // 首帧用更宽的首 token 超时；之后按 chunk 间隔判活。
        const budget = sawText || sawReasoning ? DOUBAO_CHUNK_TIMEOUT_MS : DOUBAO_FIRST_TOKEN_TIMEOUT_MS
        if (now - firstFrameAt > budget) {
          throw new LlmError('doubao: stream chunk timeout', 'TIMEOUT')
        }

        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = splitSseBlocks(buffer)
        buffer = rest

        for (const frame of frames) {
          // ⚠️ `CHUNK_DELTA` 与 `STREAM_CHUNK` 正文是**互补的增量流**，
          // 不是同一段内容的双重表达（见 `doubao.ts` 的 `collectStreamChunk`
          // 注释，含 2026-11-16 实测帧序）。两者都按增量消费，不做抑制。
          const parsed = parseDoubaoSseFrame(frame)
          if (parsed === undefined) continue

          if (parsed.kind === 'error') {
            /**
             * 错误文案必须**可读**：服务端 `extra.decision` 是一层转义 JSON，
             * 原样抛出会让用户看到大段乱码（实际反馈过）。
             *
             * ⚠️ 分类顺序（语义风控 → 滑块 → 限流）与 `describeDoubaoFailure`
             * 保持一致：三者共用 `710022004 rate limited`，把限流判在前面
             * 会把「重试无用」的风控误报成「稍等再试」。
             */
            const readable = describeDoubaoFailure(frame.data)
            throw new LlmError(
              `doubao: ${readable}`,
              isDoubaoAuthError(200, frame.data) ? 'AUTH'
                : isDoubaoSemanticRisk(frame.data) ? 'PROVIDER'
                  : isDoubaoSlideChallenge(frame.data) ? 'PROVIDER'
                    : isDoubaoRateLimitError(200, frame.data) ? 'QUOTA_EXCEEDED'
                      : 'PROVIDER',
            )
          }

          if (parsed.kind === 'end') {
            sawDone = true
            if (parsed.brief.length > 0) finishedBrief = parsed.brief
            continue
          }

          if (parsed.kind === 'conversation') {
            // 会话 id 是本轮唯一的"可复用句柄"：下一轮带上它，
            // 豆包侧就能接着原会话走（历史在服务端，不用重发）。
            //
            // ⚠️ 必须**当场登记**，不能等流结束再登记：
            // 流可能在中途抛错（风控/超时），而 ack 早已到达——
            // 那时服务端已经建好了会话，我们若没记住，下一轮就会重复新建，
            // 在豆包客户端里留下一条孤立记录。
            if (parsed.conversationId.length > 0) {
              conversationId = parsed.conversationId
              onConversation(conversationId, parsed.sectionId)
            }
            if (parsed.sectionId.length > 0) sectionId = parsed.sectionId
            continue
          }

          if (parsed.kind === 'clarify') {
            /**
             * 工作模式反问：豆包已暂停执行等用户回答，**不发结束帧**。
             *
             * 服务端此后只发心跳，可达数十分钟。若我们不主动收尾，
             * 调用方会一直挂到超时，且用户根本看不到问题。
             *
             * 处理：把问题作为正文流出去（`❓` 前缀让它在界面上一眼可辨），
             * 然后标记 `sawClarify` 让外层立即结束本轮。
             * 用户的回答走**下一轮请求**（复用同一 `conversation_id`），
             * 豆包 agent 拿到补充信息后继续原任务。
             */
            if (sawClarify) continue
            sawClarify = true
            clarifiedQuestions = parsed.questions
            const formatted = parsed.questions.map((title) => `❓ ${title}`).join('\n\n')
            if (!sawText) {
              sawText = true
              yield { type: 'block-start', index: textIndex, blockType: 'text' }
            }
            yield { type: 'text-delta', index: textIndex, text: formatted }
            continue
          }

          if (parsed.kind === 'reasoning') {
            if (!sawReasoning) {
              sawReasoning = true
              /**
               * ⚠️ index 必须从同一个递增计数器分配，不能写死。
               *
               * 绝大多数模型先出思考块再出正文（此时 reasoning=0、text=1，
               * 正好是 UI 期望的顺序）；但也有模型**先出正文再补思考**。
               * 若把 reasoning 的 index 固定成 `textIndex`，在后者情况下会与
               * 已经发出的正文块**撞同一个 index**，assembler 会把两段内容
               * 拼进同一个块，界面表现为思考与正文串台。
               */
              reasoningIndex = nextIndex
              nextIndex += 1
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
            }
            yield { type: 'reasoning-delta', index: reasoningIndex, text: parsed.text }
            continue
          }

          // parsed.kind === 'usage'：记录用量，收流时统一发出。
          // 不在此 yield，因为 `usage` 必须排在所有内容块之后、`finish` 之前。
          if (parsed.kind === 'usage') {
            usage = { inputTokens: parsed.inputTokens, totalWindowSize: parsed.totalWindowSize }
            continue
          }

          // parsed.kind === 'finish'：记录终止原因，收流时统一发出。
          if (parsed.kind === 'finish') {
            finishReason = parsed.reason
            continue
          }

          // parsed.kind === 'text'
          if (parsed.text.length === 0) continue
          if (!sawText) {
            sawText = true
            textIndex = nextIndex
            nextIndex += 1
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          yield { type: 'text-delta', index: textIndex, text: parsed.text }
        }

        // 反问已收到：立刻停读上游，不再等那个永远不会来的结束帧。
        if (sawClarify) break
      }

      /**
       * 兜底：没有任何正文时，用 `SSE_REPLY_END.msg_finish_attr.brief`。
       *
       * 实测：某些分支（直接命中缓存 / 极短回答）正文块为空，
       * 完整答案只在 `brief` 里。不看它就会误报「stream finished without text」。
       */
      if (!sawText && finishedBrief.length > 0 && !sawClarify) {
        sawText = true
        yield { type: 'block-start', index: textIndex, blockType: 'text' }
        yield { type: 'text-delta', index: textIndex, text: finishedBrief }
      }

      if (!sawText && !sawReasoning) {
        throw new LlmError(
          sawDone
            ? 'doubao: stream finished without any text content'
            : 'doubao: stream ended without text and without a completion frame',
          'PROVIDER',
        )
      }

      /**
       * 先关内容块，再发 `usage` 与 `finish`。
       *
       * ⚠️ 顺序必须严格：`StreamChunk` 契约要求「`usage` 在终止 `finish`
       * 之前，且 `finish` 之后不得再有内容块」。网关的 `consumeChunk` 也按
       * 这个顺序处理：`block-end` → `usage` → `finish`。
       *
       * 终止原因**必须发**：网关在收流结束后检查 `state.finishReason`，
       * 缺失就抛 `incomplete_stream` 502。服务端没给 `finish_reason_chat`
       * 时回退 `'stop'`（豆包正常说完就是 stop）。
       *
       * 用量**有就发**：服务端给了 `context_window_usage` 就发，没给就不发
       * （网关只是跳过 `usage` 字段，不报错）。
       */
      yield* closeBlocks()

      if (usage !== undefined) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: 0,
            totalTokens: usage.inputTokens,
          },
        }
      }
      yield { type: 'finish', reason: { kind: finishReason ?? 'stop' } }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // 取消失败不影响已产出的内容。
      }
    }

    // 生成器无法把值 return 给 `yield*` 的调用方，故会话登记走上面的
    // `onConversation` 回调（在 ack 帧处即时触发）。
    void lastFrameAt
    void clarifiedQuestions
    void sectionId
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
 * ## 续会话 vs 新会话（2026-11-15 补齐）
 *
 * 豆包这个端点一次只发**当前这轮输入**，历史靠 `conversation_id` 续：
 *
 * - `continuing = true`（已有会话）：**只发本轮 user 文本**。
 *   把历史再发一遍反而会和服务端历史重复，模型看到两套前文。
 * - `continuing = false`（首轮）：DSH 可能带着压缩后的历史，而豆包侧还没有
 *   任何上下文。此时把历史压平成一段（`用户：… / 助手：…`）一起发出，
 *   否则首轮就丢上下文——这正是参考实现 `flattenHistory` 的作用。
 *
 * system 提示豆包无对应字段（走 skill 机制），暂不注入。
 */
function toWireMessages(options: GenerateOptions, continuing: boolean): unknown[] {
  let input = ''
  for (let i = options.messages.length - 1; i >= 0; i -= 1) {
    const message = options.messages[i] as unknown as Record<string, unknown>
    if (message['role'] === 'user') {
      input = contentToText(message['content'])
      break
    }
  }
  if (input.length === 0 && options.system !== undefined) input = options.system

  // 首轮把历史压平：豆包侧没有会话上下文，不压平就等于丢掉全部前文。
  if (!continuing && input.length > 0) {
    const lastIndex = options.messages.length - 1
    let prefix = ''
    for (let i = 0; i < options.messages.length; i += 1) {
      if (i === lastIndex) break
      const message = options.messages[i] as unknown as Record<string, unknown>
      const text = contentToText(message['content']).trim()
      if (text.length === 0) continue
      const role = String(message['role'] ?? 'unknown')
      const label = role === 'user' ? '用户' : role === 'assistant' ? '助手' : role
      prefix += `${label}：${text}\n`
    }
    if (prefix.length > 0) input = `${prefix}用户：${input}`
  }

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
/**
 * 构造 `option.conversation_init_ext.agent_task_param`。
 *
 * 客户端发出的是**被转义的 JSON 字符串**，内容声明本地运行环境：
 *
 * ```jsonc
 * { "runtime_type": 2, "sandbox_auth_type": 1,
 *   "device_name": "DESKTOP-XXXX", "folder_name": "",
 *   "local_app_id": "1044603", "local_device_id": "2029…",
 *   "workspace": "C:\\Users\\…\\chats\\…" }
 * ```
 *
 * ⚠️ 我们**不伪造 `workspace` / `sandbox_id`**：那是客户端本地沙箱路径，
 * OFM 没有对应的真实目录，编一个只会制造矛盾。
 * 只发真实可得的 `local_app_id` 与 `local_device_id`（来自 scanned credential），
 * 让请求带上"这台机器"的一致身份。
 */
function buildAgentTaskParam(
  product: DoubaoProduct,
  credential: DoubaoCredential | undefined,
): string {
  const payload: Record<string, unknown> = {
    runtime_type: 2,
    sandbox_auth_type: 1,
    folder_name: '',
    local_app_id: product.aid,
  }
  if (credential?.deviceId !== undefined && credential.deviceId.length > 0) {
    payload['local_device_id'] = credential.deviceId
  }
  return JSON.stringify(payload)
}

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
