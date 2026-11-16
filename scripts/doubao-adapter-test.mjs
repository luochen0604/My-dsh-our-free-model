/**
 * 豆包适配器（`DoubaoAdapter`）行为测试 —— 用假的 fetch 驱动真实适配器代码。
 *
 * ## 与 `doubao-protocol-test.mjs` 的分工
 *
 * 那个文件测 `doubao.ts` 的**纯函数**（单帧语义）；
 * 这个文件测**适配器把它们接起来之后的可观察行为**——也就是用户真正会遇到的三件事：
 *
 * 1. **多轮续会话**：第二轮请求必须带上一轮的 `conversation_id`，
 *    并且**不再**把历史压平重发（历史在服务端）。旧实现每轮都开新会话，
 *    模型看不到前文，多轮对话直接失效。
 * 2. **思考过程**：`block_type=10040` 必须变成 `reasoning-delta`。
 *    旧实现静默丢弃，用户永远看不到思考。
 * 3. **反问闭环**：豆包反问后**不发结束帧**（只发心跳，可长达数十分钟）。
 *    适配器必须把问题作为正文流出并**立即收尾**。旧实现会一直读，
 *    直到 `DOUBAO_CHUNK_TIMEOUT_MS`（120s）超时抛错，用户既看不到问题、
 *    也只能拿到一个 timeout。
 *
 * 这些断言锁定的是**行为**，不是实现细节，所以重写内部结构不该让它们变红。
 */
import assert from 'node:assert/strict'

/** 构造 SSE 帧。 */
function frame(event, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return `id: 0\nevent: ${event}\ndata: ${data}\n\n`
}

/** 一个正文增量帧（`CHUNK_DELTA`，最简形态）。 */
function delta(text) {
  return frame('CHUNK_DELTA', { text })
}

/** 思考块帧。 */
function thinking(title) {
  return frame('STREAM_CHUNK', {
    patch_op: [{ patch_value: { content_block: [{ block_type: 10040, content: { thinking_block: { streaming_title: title } } }] } }],
  })
}

/** 反问块帧。 */
function ask(questions) {
  return frame('STREAM_CHUNK', {
    patch_op: [{
      patch_value: {
        content_block: [{
          block_type: 10082,
          content: { interaction_ask_block: { questions: questions.map((title) => ({ title })) } },
        }],
      },
    }],
  })
}

/** 会话 ack 帧。 */
function ack(conversationId) {
  return frame('SSE_ACK', { ack_client_meta: { conversation_id: conversationId, section_id: 'sec-1' } })
}

/** 结束帧。 */
function end() {
  return frame('SSE_REPLY_END', { end_type: 1, msg_finish_attr: { brief: '' } })
}

/**
 * 构造一个真实 `DoubaoAdapter`，其中 `fetch` 被替换成按调用序号返回预置流的假实现。
 *
 * ⚠️ 用真实适配器（而不是 mock 掉它）是刻意的：要测的正是适配器自己的
 * 组包/解析/收尾逻辑，mock 掉它等于什么都没测。
 */
async function makeAdapter(streams) {
  const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
  const dshLlm = await import('@deepseek-ai/dsh-llm')
  const { DoubaoAdapter } = await import(new URL('doubao-adapter.ts', sourceRoot).href)
  const { DOUBAO } = await import(new URL('doubao-product.ts', sourceRoot).href)

  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) })
    const index = requests.length - 1
    const body = streams[Math.min(index, streams.length - 1)]
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const adapter = new DoubaoAdapter({
    // 适配器只把 ctx 传给 settingsNamespaceFor，假对象足够。
    ctx: { fiber: undefined },
    credentialRef: 'DOUBAO_ACCESS_TOKEN',
    resolveCredential: async () => ({
      cookie: 'sessionid=fixture-session',
      uid: 'uid-fixture',
      nickname: '',
      lastVerifiedAt: Date.now(),
      deviceId: '7708229694936942121',
      desktop: true,
    }),
    refresh: async () => undefined,
    product: DOUBAO,
    fetchImpl,
  })

  /** 把一次 stream() 的 chunk 全收下来。 */
  const run = async (options = {}) => {
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'doubao',
      model: '9',
      messages: [{ role: 'user', content: '你好' }],
      ...options,
    })) {
      chunks.push(chunk)
    }
    return chunks
  }

  return { adapter, requests, run, dshLlm }
}

/** 把 chunk 列表拼成可读的块序列。 */
function summarize(chunks) {
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const starts = chunks.filter((c) => c.type === 'block-start').map((c) => `${c.blockType}#${c.index}`)
  const ends = chunks.filter((c) => c.type === 'block-end').map((c) => `#${c.index}`)
  return { text, reasoning, starts, ends }
}

export async function verifyDoubaoAdapter() {
  // ── 1. 基本正文流 + 会话 id 被记住 ───────────────────────────────────
  {
    const { requests, run } = await makeAdapter([
      ack('conv-A') + delta('你') + delta('好') + end(),
    ])
    const chunks = await run()
    const summary = summarize(chunks)
    assert.equal(summary.text, '你好')
    assert.deepEqual(summary.starts, ['text#0'], '正文块从 index 0 开始')
    assert.deepEqual(summary.ends, ['#0'], '正文块必须收尾')

    // 首轮不应带会话 id（请求体里的 conversation_id 是空串）。
    assert.equal(requests[0].body.client_meta.conversation_id, '')
    assert.equal(requests[0].body.option.need_create_conversation, true, '首轮必须新建会话')
    console.log('ok  adapter: first turn creates a conversation and streams text')
  }

  // ── 2. 多轮续会话：第二轮复用 conversation_id 且不重发历史 ───────────
  {
    const { requests, run } = await makeAdapter([
      ack('conv-B') + delta('第一轮回答') + end(),
      delta('第二轮回答') + end(),
    ])
    // 两轮共用同一个 DSH 会话 id —— 这是宿主的契约。
    const sessionId = 'session-fixture-1'
    await run({ sessionId, messages: [{ role: 'user', content: '第一个问题' }] })
    await run({
      sessionId,
      messages: [
        { role: 'user', content: '第一个问题' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'user', content: '第二个问题' },
      ],
    })

    assert.equal(requests.length, 2)
    // 第二轮必须带上一轮的会话 id。
    assert.equal(requests[1].body.client_meta.conversation_id, 'conv-B',
      '第二轮必须复用上一轮 SSE_ACK 下发的 conversation_id')
    assert.equal(requests[1].body.option.need_create_conversation, false,
      '已有会话时不得再要求新建（否则每轮都开新记录、上下文断开）')

    // 第二轮只发本轮输入，不把历史压平重发（历史在服务端）。
    const secondText = requests[1].body.messages[0].content_block[0].content.text_block.text
    assert.equal(secondText, '第二个问题',
      '续会话时只应发送本轮 user 文本：重发历史会与服务端历史重复')
    assert.doesNotMatch(secondText, /第一个问题/, '续会话不得重复发送前文')

    // 对照组：首轮**只发本轮输入**（那时候还没有历史，自然不必压平）。
    assert.equal(
      requests[0].body.messages[0].content_block[0].content.text_block.text,
      '第一个问题',
      '首轮只发本轮 user 文本',
    )
    console.log('ok  adapter: later turns reuse conversation_id and stop resending history')
  }

  // ── 3. 首轮压平历史（豆包侧无上下文时不能丢前文） ───────────────────
  {
    const { requests, run } = await makeAdapter([delta('ok') + end()])
    await run({
      sessionId: 'session-fixture-fresh',
      messages: [
        { role: 'user', content: '早期问题' },
        { role: 'assistant', content: '早期回答' },
        { role: 'user', content: '当前问题' },
      ],
    })
    const text = requests[0].body.messages[0].content_block[0].content.text_block.text
    assert.match(text, /用户：早期问题/, '首轮必须把历史压平成一段')
    assert.match(text, /助手：早期回答/)
    assert.match(text, /当前问题/)
    console.log('ok  adapter: first turn flattens prior history')
  }

  // ── 4. 思考过程变成 reasoning 块（且排在正文前） ─────────────────────
  {
    const { run } = await makeAdapter([thinking('正在分析') + delta('答案') + end()])
    const chunks = await run()
    const summary = summarize(chunks)
    assert.equal(summary.reasoning, '正在分析', '思考内容必须保留为 reasoning')
    assert.equal(summary.text, '答案')
    // 思考先到 → 它的块序号应为 0，正文为 1。
    assert.deepEqual(summary.starts, ['reasoning#0', 'text#1'], '思考块在前、正文块在后')
    console.log('ok  adapter: thinking block becomes a reasoning block before text')
  }

  // ── 5. 反问：转成正文 + 立即收尾（不等那个不会来的结束帧） ───────────
  {
    /**
     * 关键：这个流**故意不包含 `SSE_REPLY_END`**，只跟一个心跳——
     * 这正是豆包反问后的真实行为。适配器必须自己停下来。
     *
     * 若实现退化成"一直读到读完为止"，本用例仍然会结束（因为假流有限长），
     * 但 `text` 里必须出现问题正文，`ends` 必须非空——两者缺一即失败。
     */
    const { requests, run } = await makeAdapter([
      ack('conv-C') + ask(['请提供项目路径', '用哪个分支？']) + frame('SSE_HEARTBEAT', {}),
    ])
    const chunks = await run({ sessionId: 'session-ask' })
    const summary = summarize(chunks)
    assert.match(summary.text, /❓ 请提供项目路径/, '反问问题必须作为正文流给用户')
    assert.match(summary.text, /❓ 用哪个分支？/)
    assert.ok(summary.ends.length > 0, '反问后必须主动收尾（关闭块），否则调用方挂到超时')

    // 反问的会话 id 仍要记住：用户的回答要走下一轮同一会话。
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.client_meta.conversation_id, '')
    console.log('ok  adapter: interaction-ask surfaces as text and ends the turn immediately')
  }

  // ── 6. 反问后的下一轮复用同一会话（闭环） ───────────────────────────
  {
    const { requests, run } = await makeAdapter([
      ack('conv-D') + ask(['需要确认目录']) + frame('SSE_HEARTBEAT', {}),
      delta('继续执行') + end(),
    ])
    const sessionId = 'session-clarify-loop'
    await run({ sessionId })
    await run({ sessionId, messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '❓ 需要确认目录' },
      { role: 'user', content: '目录是 E:\\workbuddy' },
    ] })
    assert.equal(requests[1].body.client_meta.conversation_id, 'conv-D',
      '反问轮之后的回答必须送回同一豆包会话，否则 agent 接不上原任务')
    assert.equal(requests[1].body.option.need_create_conversation, false)
    console.log('ok  adapter: the answer after a clarification returns to the same conversation')
  }

  // ── 7. 语义风控必须报成可读错误，且不伪装成限流 ─────────────────────
  {
    const semantic = JSON.stringify({
      error_code: 710022004,
      error_msg: 'rate limited',
      extra: {
        decision: JSON.stringify({
          code: '10000', from: 'shark_admin', type: 'verify',
          subtype: 'semantic_reasoning', verify_scene: 'doubao_message_web',
        }),
        ack: '1',
      },
    })
    const { run } = await makeAdapter([frame('STREAM_ERROR', semantic) + end()])
    await assert.rejects(
      () => run(),
      (error) => {
        assert.match(error.message, /语义风控/, '必须点名语义风控而不是笼统限流')
        assert.doesNotMatch(error.message, /请稍等片刻/, '对语义风控不建议"稍等"（重试无用）')
        return true
      },
    )
    console.log('ok  adapter: semantic risk is reported readably, not as a rate limit')
  }

  // ── 8. 没有正文也没有思考时要报错，而不是静默成功 ────────────────────
  {
    const { run } = await makeAdapter([ack('conv-E') + end()])
    await assert.rejects(
      () => run(),
      (error) => {
        assert.match(error.message, /without any text content/)
        return true
      },
      '空响应必须抛错：静默返回空流会让 UI 表现为"干净地停止、无任何报错"',
    )
    console.log('ok  adapter: an empty stream fails loudly')
  }

  // ── 9. `SSE_REPLY_END.brief` 兜底（正文块缺失时） ───────────────────
  {
    const { run } = await makeAdapter([
      ack('conv-F')
      + frame('SSE_REPLY_END', { end_type: 1, msg_finish_attr: { brief: '只存在于 brief 的答案' } }),
    ])
    const chunks = await run()
    const summary = summarize(chunks)
    assert.equal(summary.text, '只存在于 brief 的答案',
      '正文块为空时必须回退到 msg_finish_attr.brief，否则误报空流')
    console.log('ok  adapter: msg_finish_attr.brief backs up a text-less stream')
  }

  // ── 10. `CHUNK_DELTA` 与 `STREAM_CHUNK` 正文是互补增量，都要输出 ──────
  {
    /**
     * ⚠️ **2026-11-16 实测纠正**：参考实现的规则是「先收到 `CHUNK_DELTA` 就
     * 不再用 `STREAM_CHUNK` 正文」，理由是后者是全量快照。但实测真实流的帧序是
     * 正文先走 `STREAM_CHUNK`（4 段增量），`CHUNK_DELTA` 只在最后带了一个句号。
     * 两者是**互补的增量流**，不是同一段内容的双重表达。
     *
     * 这里断言：两者都作为增量输出。若退化成抑制，`CHUNK_DELTA` 先到时
     * 后续所有 `STREAM_CHUNK` 正文都会被丢掉 —— 用户只会收到一个句号。
     */
    const streamText = frame('STREAM_CHUNK', {
      patch_op: [{ patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: '正文增量' } } }] } }],
    })
    const { run } = await makeAdapter([ack('conv-G') + delta('正文') + delta('增量') + streamText + end()])
    const summary = summarize(await run())
    // STREAM_CHUNK 正文仍然被输出（不被抑制），与 CHUNK_DELTA 的增量拼接。
    assert.equal(summary.text, '正文增量正文增量',
      'CHUNK_DELTA 与 STREAM_CHUNK 正文都必须作为增量输出（两者互补，不互相抑制）')
    console.log('ok  adapter: CHUNK_DELTA and STREAM_CHUNK text are both emitted as deltas')
  }

  // ── 11. 会话缓存按 DSH 会话隔离（不同会话不串） ──────────────────────
  {
    const { requests, run } = await makeAdapter([
      ack('conv-alpha') + delta('a') + end(),
      ack('conv-beta') + delta('b') + end(),
    ])
    await run({ sessionId: 'session-A' })
    await run({ sessionId: 'session-B' })
    assert.equal(requests[0].body.client_meta.conversation_id, '')
    assert.equal(requests[1].body.client_meta.conversation_id, '',
      '不同 DSH 会话之间不得串用豆包会话')
    console.log('ok  adapter: conversation cache is isolated per DSH session')
  }

  console.log('doubao-adapter: all assertions passed')
}
