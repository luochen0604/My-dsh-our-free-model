/**
 * 豆包工作（DoubaoWork）SSE 协议层的单元测试（**零真实网络**）。
 *
 * ## 为什么这个文件必须存在
 *
 * 2026-11-15 用真实登录态抓 `/chat/completion`，发现旧实现按静态分析猜的事件名
 * （`pb` / `json` / `done` / `err`）**和实际流完全不同**。真实事件是
 * `CHUNK_DELTA` / `STREAM_CHUNK` / `SSE_ACK` / `SSE_REPLY_END` / `STREAM_ERROR`。
 *
 * 旧解析器的后果是可以复现的：
 *  - 不收 `CHUNK_DELTA` → 收到的是全量快照，正文会重复叠加；
 *  - 丢弃 `block_type=10040` → 思考过程整段丢失；
 *  - 丢弃 `block_type=10082` → 豆包反问时服务端**不发结束帧**，
 *    调用方一直挂到超时，且用户看不到问题；
 *  - 忽略 `SSE_ACK` → 拿不到 `conversation_id`，多轮对话每轮从零开始。
 *
 * 这些都不是"风格问题"，而是用户可直接感知的功能缺失，所以逐条锁死。
 *
 * 帧样本取自参考实现 `dsh-connect-doubaowork`（`doubao-protocol.js` 的 `pumpSse`）
 * 所对应的实测流形状，字段名与层级逐字对齐。
 */
import assert from 'node:assert/strict'

/** 构造一帧 SSE（对齐真实响应的 `id:` / `event:` / `data:` 三段）。 */
function frame(event, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return `id: 0\nevent: ${event}\ndata: ${data}\n\n`
}

/** 把多帧拼成一个响应体。 */
function stream(...frames) {
  return frames.join('')
}

/** `STREAM_CHUNK` 的正文块。 */
function textChunk(text) {
  return frame('STREAM_CHUNK', {
    patch_op: [{
      patch_object: 1,
      patch_type: 1,
      patch_value: {
        content_block: [{
          block_type: 10000,
          block_id: 'block-text',
          content: {
            text_block: { text, icon_url: '', icon_url_dark: '', summary: '' },
            pc_event_block: '',
          },
        }],
      },
    }],
  })
}

/** `STREAM_CHUNK` 的思考块。 */
function thinkingChunk(title) {
  return frame('STREAM_CHUNK', {
    patch_op: [{
      patch_value: {
        content_block: [{
          block_type: 10040,
          block_id: 'block-think',
          content: { thinking_block: { streaming_title: title } },
        }],
      },
    }],
  })
}

/** `STREAM_CHUNK` 的工作模式反问块。 */
function askChunk(questions) {
  return frame('STREAM_CHUNK', {
    patch_op: [{
      patch_value: {
        content_block: [{
          block_type: 10082,
          block_id: 'block-ask',
          content: {
            interaction_ask_block: {
              questions: questions.map((title) => ({ title })),
            },
          },
        }],
      },
    }],
  })
}

export async function verifyDoubaoProtocol() {
  const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
  const doubao = await import(new URL('doubao.ts', sourceRoot).href)
  const {
    DOUBAO_SSE,
    DOUBAO_BLOCK,
    parseSseBlock,
    splitSseBlocks,
    parseDoubaoSseFrame,
    isDoubaoSemanticRisk,
    isDoubaoSlideChallenge,
    isDoubaoRateLimitError,
    describeDoubaoFailure,
    extractDeviceIdFromCookie,
  } = doubao

  // ── 1. 事件名常量必须覆盖实测的全部事件 ──────────────────────────────
  {
    // 这些名字必须与真实流逐字一致；写错一个就会静默丢帧。
    assert.equal(DOUBAO_SSE.chunkDelta, 'CHUNK_DELTA')
    assert.equal(DOUBAO_SSE.streamChunk, 'STREAM_CHUNK')
    assert.equal(DOUBAO_SSE.ack, 'SSE_ACK')
    assert.equal(DOUBAO_SSE.replyEnd, 'SSE_REPLY_END')
    assert.equal(DOUBAO_SSE.streamError, 'STREAM_ERROR')
    assert.equal(DOUBAO_SSE.heartbeat, 'SSE_HEARTBEAT')
    assert.equal(DOUBAO_BLOCK.text, 10000)
    assert.equal(DOUBAO_BLOCK.thinking, 10040)
    assert.equal(DOUBAO_BLOCK.interactionAsk, 10082)
    console.log('ok  protocol: event names and block types match the measured stream')
  }

  // ── 2. 空行切帧 + 多行 data 拼接 ────────────────────────────────────
  {
    const raw = frame('SSE_ACK', { a: 1 }) + frame('SSE_HEARTBEAT', {})
    const { frames, rest } = splitSseBlocks(raw)
    assert.equal(frames.length, 2, '两个空行分隔的块都要成为一帧')
    assert.equal(frames[0].event, 'SSE_ACK')
    assert.equal(rest, '', '完整块之间不应留残留')
    // 半帧必须留作 rest，不能当成完整帧解析（否则会丢正文）。
    const partial = splitSseBlocks(frame('SSE_ACK', { a: 1 }) + 'event: STREAM_CHUNK\ndata: {"x"')
    assert.equal(partial.frames.length, 1)
    assert.match(partial.rest, /STREAM_CHUNK/, '未闭合的帧必须留在 rest 里等待后续字节')
    console.log('ok  protocol: splitSseBlocks keeps partial frames in rest')
  }

  // ── 3. `CHUNK_DELTA` 是增量文本 ─────────────────────────────────────
  {
    const outcome = parseDoubaoSseFrame(parseSseBlock(frame('CHUNK_DELTA', { text: '你' })))
    assert.deepEqual(outcome, { kind: 'text', text: '你' })
    // 空 text 不应产出正文（否则会发空 delta）。
    assert.equal(parseDoubaoSseFrame(parseSseBlock(frame('CHUNK_DELTA', { text: '' }))), undefined)
    console.log('ok  protocol: CHUNK_DELTA yields incremental text')
  }

  // ── 4. `STREAM_CHUNK` 正文 / 思考 / 反问三路分派 ─────────────────────
  {
    const text = parseDoubaoSseFrame(parseSseBlock(textChunk('hello')))
    assert.deepEqual(text, { kind: 'text', text: 'hello' })

    const reasoning = parseDoubaoSseFrame(parseSseBlock(thinkingChunk('正在分析')))
    assert.deepEqual(reasoning, { kind: 'reasoning', text: '正在分析' })

    const clarify = parseDoubaoSseFrame(parseSseBlock(askChunk(['请提供项目路径', '用哪个分支？'])))
    assert.equal(clarify.kind, 'clarify')
    assert.deepEqual(clarify.questions, ['请提供项目路径', '用哪个分支？'])
    console.log('ok  protocol: STREAM_CHUNK dispatches text / thinking / interaction-ask blocks')
  }

  // ── 5. 思考块收尾用 finish_title 兜底 ───────────────────────────────
  {
    const finished = frame('STREAM_CHUNK', {
      patch_op: [{
        patch_value: {
          content_block: [{
            block_type: 10040,
            content: { thinking_block: { finish_title: '已完成思考' } },
          }],
        },
      }],
    })
    assert.deepEqual(parseDoubaoSseFrame(parseSseBlock(finished)), { kind: 'reasoning', text: '已完成思考' })
    console.log('ok  protocol: thinking block falls back to finish_title')
  }

  // ── 6. `CHUNK_DELTA` 出现后必须抑制 `STREAM_CHUNK` 全文 ──────────────
  {
    // 服务端在 support_chunk_delta=true 时同时下发两者：
    // CHUNK_DELTA 是增量、STREAM_CHUNK 的 text_block.text 是**全量快照**。
    // 两个都收 = 同一段话被播放两遍（真实缺陷形状）。
    const suppressed = parseDoubaoSseFrame(parseSseBlock(textChunk('完整一句话')), true)
    assert.equal(suppressed, undefined, 'seenChunkDelta=true 时 STREAM_CHUNK 正文必须被忽略')
    // 但思考块不受影响（它没有增量替代路径）。
    assert.deepEqual(
      parseDoubaoSseFrame(parseSseBlock(thinkingChunk('思考')), true),
      { kind: 'reasoning', text: '思考' },
    )
    console.log('ok  protocol: STREAM_CHUNK text is suppressed once CHUNK_DELTA is in use')
  }

  // ── 7. `SSE_ACK` 给出可复用的会话 id ────────────────────────────────
  {
    const outcome = parseDoubaoSseFrame(parseSseBlock(frame('SSE_ACK', {
      ack_client_meta: { conversation_id: 'conv-42', section_id: 'sec-7' },
    })))
    assert.deepEqual(outcome, { kind: 'conversation', conversationId: 'conv-42', sectionId: 'sec-7' })
    // 缺 meta 时不应崩（防御式）。
    assert.equal(parseDoubaoSseFrame(parseSseBlock(frame('SSE_ACK', {}))), undefined)
    console.log('ok  protocol: SSE_ACK exposes conversation_id for reuse')
  }

  // ── 8. `SSE_REPLY_END` 的 end_type 与 brief ─────────────────────────
  {
    const outcome = parseDoubaoSseFrame(parseSseBlock(frame('SSE_REPLY_END', {
      end_type: 1,
      msg_finish_attr: { brief: '完整答案' },
    })))
    assert.deepEqual(outcome, { kind: 'end', endType: 1, brief: '完整答案' })
    console.log('ok  protocol: SSE_REPLY_END carries end_type and brief')
  }

  // ── 9. 心跳 / 元数据帧必须被忽略（不算内容） ─────────────────────────
  {
    for (const event of ['SSE_HEARTBEAT', 'STREAM_TIMEOUT_CONTROL', 'FULL_MSG_NOTIFY', 'STREAM_MSG_NOTIFY']) {
      assert.equal(
        parseDoubaoSseFrame(parseSseBlock(frame(event, {}))),
        undefined,
        `${event} 不应产出内容`,
      )
    }
    console.log('ok  protocol: heartbeat and metadata frames are ignored')
  }

  // ── 10. `STREAM_ERROR` 分类：语义风控 ≠ 限流 ────────────────────────
  {
    /**
     * 真实的语义风控帧（2026-11-15 实测，字段逐字保留）。
     *
     * 注意 `error_msg` 就写着 "rate limited"，所以**任何只看外层文案的判定
     * 都会把它当限流**——这正是旧实现的缺陷。
     */
    const semantic = JSON.stringify({
      error_code: 710022004,
      error_msg: 'rate limited',
      extra: {
        decision: JSON.stringify({
          code: '10000',
          from: 'shark_admin',
          type: 'verify',
          region: 'cn',
          subtype: 'semantic_reasoning',
          verify_scene: 'doubao_message_web',
        }),
        ack: '1',
      },
    })
    assert.equal(isDoubaoSemanticRisk(semantic), true, '必须识别出 semantic_reasoning')
    assert.equal(isDoubaoRateLimitError(0, semantic), true, '外层确实也是 710022004（所以单看它不够）')

    const outcome = parseDoubaoSseFrame(parseSseBlock(frame('STREAM_ERROR', semantic)))
    assert.equal(outcome.kind, 'error')
    assert.equal(outcome.code, 710022004)
    assert.equal(outcome.message, 'rate limited')

    // 文案必须指向上游真实成因，且**不能**建议用户"稍等再试"（重试无用）。
    const described = describeDoubaoFailure(semantic)
    assert.match(described, /语义风控/, '文案必须点名语义风控')
    assert.doesNotMatch(described, /请稍等片刻/, '对语义风控给出"稍等"是错误建议')

    // 滑块分支保持原语义。
    const slide = JSON.stringify({
      error_code: 710022004,
      error_msg: 'rate limited',
      extra: { decision: JSON.stringify({ type: 'verify', subtype: 'slide' }) },
    })
    assert.equal(isDoubaoSlideChallenge(slide), true)
    assert.match(describeDoubaoFailure(slide), /人机验证|滑块/)

    // 真限流（无 decision）才该建议等待。
    const plain = JSON.stringify({ error_code: 710022004, error_msg: 'rate limited' })
    assert.equal(isDoubaoSemanticRisk(plain), false)
    assert.equal(isDoubaoSlideChallenge(plain), false)
    assert.match(describeDoubaoFailure(plain), /过于频繁/)

    // 顺序回归：语义风控帧不能被判成滑块。
    assert.equal(isDoubaoSlideChallenge(semantic), false)
    console.log('ok  protocol: STREAM_ERROR separates semantic risk / slide / real rate limit')
  }

  // ── 11. 从 cookie 里的 JWT 解设备号（真实字段名是 web_device_id） ────
  {
    /** 造一个结构真实、无需签名的 JWT（只解 payload）。 */
    const jwt = (payload) => {
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
      return `${encode({ alg: 'ES256' })}.${encode(payload)}.signature`
    }

    // 实测形态：session_extra.web_device_id（**没有** device_id）。
    const cookie = `sessionid=abc; LARK_SUITE_ACCESS_TOKEN=${jwt({
      aid: '7563886387755663361',
      uid: '7668607196749483219',
      session_extra: { web_device_id: '7708229694936942121', terminal_typ: '1' },
    })}; ttwid=xyz`
    assert.equal(extractDeviceIdFromCookie(cookie), '7708229694936942121',
      '必须能从 web_device_id 取出设备号（否则请求缺 device_id/fp/tea_uuid）')

    // 向后兼容旧的 session_extra.device_id。
    const legacy = `LARK_SUITE_ACCESS_TOKEN=${jwt({ session_extra: { device_id: 'dev-legacy' } })}`
    assert.equal(extractDeviceIdFromCookie(legacy), 'dev-legacy')
    // 顶层 device_id 也认。
    assert.equal(extractDeviceIdFromCookie(`LARK_SUITE_ACCESS_TOKEN=${jwt({ device_id: 'dev-top' })}`), 'dev-top')

    // 坏输入不抛错，返回 undefined。
    assert.equal(extractDeviceIdFromCookie('LARK_SUITE_ACCESS_TOKEN=not-a-jwt'), undefined)
    assert.equal(extractDeviceIdFromCookie(''), undefined)
    assert.equal(extractDeviceIdFromCookie('sessionid=abc'), undefined)
    console.log('ok  protocol: device id resolves from web_device_id, device_id and degrades safely')
  }

  // ── 12. 凭据 round-trip 必须保住 deviceId（真实缺陷回归） ────────────
  {
    /**
     * `DoubaoAuth.parse()` 是「落盘 JSON → `DoubaoCredential`」的唯一入口。
     * 它此前只映射五个字段，把 `deviceId` 丢了 —— 于是凭据一旦从 store 读回，
     * `device_id` / `fp` / `tea_uuid` 三项就从所有请求里消失。
     *
     * 用真实的 `DoubaoAuth` 实例 + 假 credentials store 验证 round-trip，
     * 不 mock 掉 parse（要测的正是它）。
     */
    const { DoubaoAuth } = await import(new URL('doubao-auth.ts', sourceRoot).href)
    // `DoubaoAuth` 继承 cordis 的 `Service`，必须拿真实的 Context 构造
    // （假对象会在 `Service` 构造函数里因 `ctx.reflect` 缺失而崩）。
    const { Context } = await import('@deepseek-ai/cordis')

    /** 造一个最小可用的 ctx：真实 Context + 假 credentials store。 */
    const makeCtx = (initial) => {
      const values = new Map(Object.entries(initial))
      const ctx = new Context()
      ctx.credentials = {
        async resolve(ref) {
          const key = String(ref)
          return values.has(key) ? { value: values.get(key) } : undefined
        },
        async set(ref, value) { values.set(String(ref), value) },
      }
      return ctx
    }

    const withDevice = JSON.stringify({
      cookie: 'sessionid=abc',
      uid: 'u1',
      nickname: 'n',
      lastVerifiedAt: 1,
      desktop: true,
      deviceId: '7708229694936942121',
    })
    const auth = new DoubaoAuth(makeCtx({ DOUBAO_ACCESS_TOKEN: withDevice }), { serviceName: 'doubaoAuthFixture' })
    const read = await auth.readCredential()
    assert.equal(read.deviceId, '7708229694936942121',
      'parse() 必须保住 deviceId：丢了就等于所有请求都没有设备指纹')

    // 缺省时不臆造（undefined，不是空串）。
    const withoutDevice = JSON.stringify({ cookie: 'sessionid=abc', uid: '', nickname: '', lastVerifiedAt: 0, desktop: false })
    const auth2 = new DoubaoAuth(makeCtx({ DOUBAO_ACCESS_TOKEN: withoutDevice }), { serviceName: 'doubaoAuthFixture2' })
    const read2 = await auth2.readCredential()
    assert.equal(read2.deviceId, undefined, '没有设备号时不得写成空串')
    assert.equal('deviceId' in read2, false, '没有设备号时不得凭空造出该字段')

    // 坏数据不抛错。
    const auth3 = new DoubaoAuth(makeCtx({ DOUBAO_ACCESS_TOKEN: '{not json' }), { serviceName: 'doubaoAuthFixture3' })
    assert.equal(await auth3.readCredential(), undefined)
    const auth4 = new DoubaoAuth(
      makeCtx({ DOUBAO_ACCESS_TOKEN: JSON.stringify({ cookie: 'no-session-here' }) }),
      { serviceName: 'doubaoAuthFixture4' },
    )
    assert.equal(await auth4.readCredential(), undefined, '缺 sessionid 的凭据视为不可用')
    console.log('ok  protocol: credential round-trip preserves deviceId')
  }

  // ── 13. 完整成功流端到端：按真实顺序拼一遍 ──────────────────────────
  {
    const raw = stream(
      frame('SSE_HEARTBEAT', {}),
      frame('STREAM_TIMEOUT_CONTROL', { timeout: 300 }),
      frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-1', section_id: 'sec-1' } }),
      frame('FULL_MSG_NOTIFY', { message: {} }),
      thinkingChunk('先想一想'),
      frame('CHUNK_DELTA', { text: '回答' }),
      frame('CHUNK_DELTA', { text: '完毕' }),
      textChunk('回答完毕'),
      frame('SSE_REPLY_END', { end_type: 1, msg_finish_attr: { brief: '' } }),
    )
    const { frames } = splitSseBlocks(raw)
    let sawChunkDelta = false
    const texts = []
    const reasonings = []
    let conversation
    let ended = false
    for (const item of frames) {
      if (item.event === DOUBAO_SSE.chunkDelta) sawChunkDelta = true
      const outcome = parseDoubaoSseFrame(item, sawChunkDelta)
      if (outcome === undefined) continue
      if (outcome.kind === 'text') texts.push(outcome.text)
      else if (outcome.kind === 'reasoning') reasonings.push(outcome.text)
      else if (outcome.kind === 'conversation') conversation = outcome.conversationId
      else if (outcome.kind === 'end') ended = true
    }
    assert.deepEqual(texts, ['回答', '完毕'], '正文只能来自 CHUNK_DELTA，且不得被全量快照重复')
    assert.deepEqual(reasonings, ['先想一想'], '思考过程必须保留')
    assert.equal(conversation, 'conv-1', '会话 id 必须取出')
    assert.equal(ended, true)
    console.log('ok  protocol: a full measured stream parses into text + reasoning + conversation')
  }

  // ── 13. 反问流：没有结束帧也必须能收尾 ──────────────────────────────
  {
    // 真实行为：反问后服务端只发心跳，`SSE_REPLY_END` 永远不会来。
    const raw = stream(
      frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-2', section_id: '' } }),
      askChunk(['需要你确认目录']),
      frame('SSE_HEARTBEAT', {}),
    )
    const { frames } = splitSseBlocks(raw)
    let clarify
    let ended = false
    for (const item of frames) {
      const outcome = parseDoubaoSseFrame(item)
      if (outcome?.kind === 'clarify') clarify = outcome.questions
      if (outcome?.kind === 'end') ended = true
    }
    assert.deepEqual(clarify, ['需要你确认目录'], '反问问题必须被识别')
    assert.equal(ended, false, '反问流确实没有结束帧 —— 所以调用方必须自己收尾')
    console.log('ok  protocol: interaction-ask arrives without a completion frame')
  }

  console.log('doubao-protocol: all assertions passed')
}
