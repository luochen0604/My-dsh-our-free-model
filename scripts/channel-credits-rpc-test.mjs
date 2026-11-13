import assert from 'node:assert/strict'

/** 使用实际已打包 RPC，只提供账号池 ref，禁止真实网络与旧单凭据回退。 */
export async function verifyChannelCreditsRpc({ ctx, call, creds, adapters }) {
  const originalFetch = globalThis.fetch
  const providers = ['qoder', 'qodercn', 'loomy', 'minimax', 'lobsterai', 'zcode', 'gemini']
  let quotaRequests = 0, quotaFailed = true
  const originalResolve = ctx.credentials.resolve
  const resolvedRefs = []
  ctx.credentials.resolve = async ref => { resolvedRefs.push(ref); return originalResolve(ref) }
  try {
    for (const provider of providers) {
      const ref = `FIXTURE_CREDITS_${provider.toUpperCase()}`
      creds.set(ref, { value: JSON.stringify({
        access_token: 'fixture-credits-token', token_type: 'Bearer', user_id: 'fixture-user',
        zcode_jwt: 'fixture-credits-jwt', device_mid: 'fixture-device', account_label: '隔离账号',
      }) })
      await ctx.accountPool.addAccount({
        id: `fixture-credits-${provider}`, provider, nickname: '隔离账号',
        credentialRef: ref, enabled: true, refreshable: false, createdAt: 1,
      })
    }
    globalThis.fetch = async input => {
      const pathname = new URL(String(input)).pathname
      let body
      if (pathname.includes('get-user-resource')) {
        body = { code: 0, data: { Response: { Data: { Accounts: [{
          PackageName: 'fixture', CycleCapacityRemain: 123, Status: 1,
        }] } } } }
      } else if (pathname.includes('/me/usage')) {
        body = { qoderUsage: { userQuota: { total: 123, remaining: 123, used: 0, unit: 'credits' } } }
      } else if (pathname.includes('/points/records')) {
        body = { code: '000000', data: { balance: 123, dailyBalance: 0, availableBalance: 123 } }
      } else if (pathname.includes('/credit/details')) {
        body = { base_resp: { status_code: 0 }, total_count: 1, details: [{ remaining_amount: '123.00' }] }
      } else if (pathname.includes('/profile-summary')) {
        body = { code: 0, success: true, data: { totalCreditsRemaining: 123, creditItems: [] } }
      } else if (pathname.endsWith(':retrieveUserQuotaSummary')) {
        quotaRequests++
        if (quotaFailed) return new Response('本机配额查询失败', { status: 502 })
        body = { groups: [{ buckets: [
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: new Date(Date.now() + 3600000).toISOString() },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: new Date(Date.now() + 86400000).toISOString() },
        ] }] }
      } else throw new Error(`未预期的替身端点：${pathname}`)
      return Response.json(body)
    }
    for (const provider of providers.filter(id => id !== 'zcode' && id !== 'gemini')) {
      resolvedRefs.length = 0
      const result = await call('credits.balances', { provider })
      assert.equal(result.ok, true)
      assert.equal(result.value.accounts[0].balance?.total, 123, `${provider} 的账号池凭据应能查询余额`)
      assert.ok(resolvedRefs.includes(`FIXTURE_CREDITS_${provider.toUpperCase()}`))
    }
    assert.equal((await ctx.zcodeAuth.current()).zcode_jwt, 'fixture-credits-jwt')
    assert.equal((await ctx.zcodeAuth.status()).configured, true)
    creds.delete('FIXTURE_CREDITS_QODER')
    const missing = await call('credits.balances', { provider: 'qoder' })
    assert.equal(missing.value.accounts[0].balance, null)
    assert.equal(missing.value.accounts[0].error, '凭据未配置', '缺失凭据必须返回原因，不能伪造零余额')
    const unavailableQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(unavailableQuota.value.accounts[0].balance, null)
    quotaFailed = false
    const cachedQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(cachedQuota.value.accounts[0].balance, null)
    assert.equal(quotaRequests, 1, '自动查询保留原有缓存')
    const freshQuota = await call('credits.balances', { provider: 'gemini', force: true })
    assert.equal(quotaRequests, 2, '手动重试必须真正查询上游替身')
    assert.equal(freshQuota.value.accounts[0].balance.total, 60)
    await verifyRefreshDispatch({ ctx, call })
    for (const provider of ['qoder', 'qodercn']) {
      const service = ctx[`${provider}Auth`], saved = service.refreshAccountCredential, calls = []
      const ref = `FIXTURE_CREDITS_${provider.toUpperCase()}`
      // 默认账号之外的 B 必须由实际注册接线按 id 刷新，不能重新选默认 ref。
      const otherId = `fixture-auth-${provider}-b`, otherRef = `FIXTURE_AUTH_${provider.toUpperCase()}_B`
      try {
        creds.set(otherRef, { value: '{"access_token":"fixture-b"}' })
        await ctx.accountPool.addAccount({ id: otherId, provider, nickname: 'B', credentialRef: otherRef, enabled: true, refreshable: true, createdAt: 1 })
        // qoder 的缺凭据测试刚删除了默认 ref，这里恢复为有效 A，确保错误实现会选中它。
        creds.set(ref, { value: '{"access_token":"fixture-a"}' })
        service.refreshAccountCredential = async (...args) => { calls.push(args) }
        await adapters.get(provider).options.refresh(otherId)
        assert.deepEqual(calls, [[otherRef, ctx.accountPool, otherId]], `${provider}: 实际认证续期绑定 B`)
        const lookup = ctx.accountPool.findAccountIdByCredential
        try {
          assert.equal(await adapters.get(provider).options.queueAccountIdForCredential({ access_token: 'fixture-b' }), otherId)
          ctx.accountPool.findAccountIdByCredential = async () => { throw new Error('fixture strict lookup failed') }
          await assert.rejects(adapters.get(provider).options.queueAccountIdForCredential({ access_token: 'fixture-b' }), /strict lookup failed/)
        } finally { ctx.accountPool.findAccountIdByCredential = lookup }
        await assert.rejects(adapters.get(provider).options.refresh('missing-account'), /当前请求的账号已移除/)
        assert.equal(calls.length, 1, '账号删除后不得退回 A 续期')
      } finally {
        service.refreshAccountCredential = saved
        await ctx.accountPool.removeAccount(otherId)
        creds.delete(otherRef)
      }
    }
    await verifyWorkbuddyWake({ ctx, call, creds })
  } finally {
    ctx.credentials.resolve = originalResolve
    globalThis.fetch = originalFetch
    for (const provider of providers) {
      await ctx.accountPool.removeAccount(`fixture-credits-${provider}`)
      creds.delete(`FIXTURE_CREDITS_${provider.toUpperCase()}`)
    }
  }
}

async function verifyRefreshDispatch({ ctx, call }) {
  const providers = [
    'lobsterai', 'qoder', 'qodercn', 'trae',
    'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
  ]
  for (const provider of providers) {
    const service = ctx[`${provider}Auth`]
    assert.ok(service, `${provider} auth service is mounted`)
    const saved = service.refreshAccountCredential
    const accountId = `fixture-refresh-${provider}`, ref = `FIXTURE_REFRESH_${provider.toUpperCase()}`
    const calls = []
    try {
      await ctx.accountPool.addAccount({
        id: accountId, provider, nickname: 'offline-refresh', credentialRef: ref,
        enabled: false, refreshable: true, createdAt: 1,
      })
      service.refreshAccountCredential = async (...args) => { calls.push(args) }
      const result = await call('account.refresh', { accountId })
      assert.deepEqual(result, { ok: true, value: { success: true } }, provider)
      assert.equal(calls.length, 1, provider)
      assert.deepEqual(calls[0], [ref, ctx.accountPool, accountId], `${provider}: exact ref, pool and id`)
      service.refreshAccountCredential = async () => { throw new Error('offline refresh rejected') }
      const rejected = await call('account.refresh', { accountId })
      assert.equal(rejected.ok, false, `${provider}: refresh failure is not success`)
      assert.match(rejected.error.message, /offline refresh rejected/)
    } finally {
      service.refreshAccountCredential = saved
      await ctx.accountPool.removeAccount(accountId)
    }
  }
  console.log('ok  refresh RPC: all 10 providers pass exact ref/pool/id; disabled accounts refresh; failures return ok:false')
}

/**
 * WorkBuddy 唤醒的**行为级**守护（用户报障：三个 WB 账号唤醒全失败）。
 *
 * 覆盖三层真实缺陷/契约：
 * 1. 历史导入脚本把凭据写成**双层 JSON**，旧实现只 `JSON.parse` 一次 →
 *    `accessToken` undefined → 抛「凭据缺少 accessToken/uid」。这里断言
 *    双编码凭据能唤醒成功**且被回写成单层规范 JSON**（存量账号自愈）。
 * 2. 桌面端（5.9.3）**存在**续期端点：`POST /v2/plugin/auth/token/refresh`
 *    + `X-Refresh-Token` / `X-Auth-Refresh-Source: plugin` / `X-Domain`。
 *    这里断言临期账号真的走续期、把轮换后的两个令牌落盘、并把新有效期写回账号池。
 * 3. 续期被 401 拒绝必须报「请重新导入」；无 refreshToken 时退化为只探活。
 */
export async function verifyWorkbuddyWake({ ctx, call, creds }) {
  const originalFetch = globalThis.fetch
  const accountId = 'fixture-wb-wake'
  const ref = 'WORKBUDDY_ACCOUNT_FIXTURE'
  const uid = '7b7d9fa7-0000-4000-8000-000000000001'
  const now = Date.now()
  const seconds = ms => Math.floor(ms / 1000)
  const farExpSec = seconds(now + 20 * 24 * 3600_000)
  const nearExpSec = seconds(now + 60_000)
  const rotatedAccessExpSec = seconds(now + 28 * 24 * 3600_000)
  const rotatedRefreshExpSec = seconds(now + 30 * 24 * 3600_000)
  const jwt = payload => [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.')
  const credential = (overrides = {}) => ({
    uid,
    accessToken: jwt({ sub: uid, exp: farExpSec, jti: 'original-access' }),
    refreshToken: jwt({ sub: uid, exp: farExpSec + 24 * 3600, jti: 'original-refresh' }),
    domain: 'www.workbuddy.cn',
    nickname: 'WB fixture',
    ...overrides,
  })
  const probeEnvelope = { code: 0, msg: 'OK', data: { active: true, today_checked_in: false, streak_days: 1, daily_credit: 100, total_credits: 100 } }
  const requests = []
  let probeFails = false
  const fetchStub = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    requests.push({ url, method: init?.method ?? 'GET', headers, body: init?.body })
    if (url.endsWith('/v2/plugin/auth/token/refresh')) {
      if (headers.get('X-Refresh-Token') === 'revoked-refresh') {
        return Response.json({ code: 401, msg: 'invalid refresh token' }, { status: 401 })
      }
      return Response.json({
        code: 0,
        msg: 'OK',
        data: {
          accessToken: jwt({ sub: uid, exp: rotatedAccessExpSec, jti: 'rotated-access' }),
          refreshToken: jwt({ sub: uid, exp: rotatedRefreshExpSec, jti: 'rotated-refresh' }),
          expiresIn: 2419200,
          refreshExpiresIn: 2591999,
          tokenType: 'Bearer',
          sessionState: 'fixture-session',
          domain: 'www.workbuddy.cn',
        },
      })
    }
    if (url.endsWith('/billing/meter/checkin-activity-status')) {
      if (probeFails) return Response.json({ code: 401, msg: 'invalid token' }, { status: 401 })
      return Response.json(probeEnvelope)
    }
    throw new Error(`未预期的替身端点：${url}`)
  }
  const byAccount = () => ctx.accountPool.findAccount(accountId)
  try {
    globalThis.fetch = fetchStub

    // ── 1. 双层编码凭据：唤醒成功 + 回写单层规范 JSON ──
    const canonical = credential()
    // import-wb-pool 历史缺陷的落盘形态：JSON 文本被 stringify 了两次。
    creds.set(ref, { value: JSON.stringify(JSON.stringify(canonical)) })
    await ctx.accountPool.addAccount({
      id: accountId, provider: 'workbuddy', nickname: 'WB fixture',
      credentialRef: ref, enabled: true, refreshable: true, createdAt: 1, expiresAt: 1,
    })
    requests.length = 0
    const healed = await call('account.refresh', { accountId })
    assert.deepEqual(healed, { ok: true, value: { success: true } }, '双编码凭据必须能唤醒（旧实现抛「缺少 accessToken/uid」）')
    assert.equal(
      requests.some(row => row.url.endsWith('/v2/plugin/auth/token/refresh')), false,
      '距过期 20 天时不应轮换令牌（避免每次唤醒都换 refresh_token）',
    )
    const probeRequest = requests.find(row => row.url.endsWith('/billing/meter/checkin-activity-status'))
    assert.ok(probeRequest, '唤醒必须真的探活')
    assert.equal(probeRequest.headers.get('Authorization'), `Bearer ${canonical.accessToken}`)
    assert.equal(probeRequest.headers.get('X-User-Id'), uid)
    assert.equal(probeRequest.headers.get('X-Domain'), 'www.workbuddy.cn')
    const storedHealed = JSON.parse(creds.get(ref).value)
    assert.equal(typeof storedHealed, 'object', '唤醒后必须把凭据回写成单层 JSON 对象')
    assert.equal(storedHealed.uid, uid)
    assert.equal(storedHealed.accessToken, canonical.accessToken)
    assert.equal(storedHealed.refreshToken, canonical.refreshToken)
    assert.equal(byAccount().expiresAt, farExpSec * 1000, '账号池 expiresAt 必须与 JWT exp 对齐')
    assert.equal(byAccount().refreshable, true)

    // ── 2. 临期凭据：真续期（桌面端契约），轮换令牌落盘 ──
    const expiring = credential({
      accessToken: jwt({ sub: uid, exp: nearExpSec, jti: 'expiring-access' }),
      refreshToken: jwt({ sub: uid, exp: farExpSec, jti: 'expiring-refresh' }),
    })
    creds.set(ref, { value: JSON.stringify(expiring) })
    requests.length = 0
    const refreshed = await call('account.refresh', { accountId })
    assert.deepEqual(refreshed, { ok: true, value: { success: true } }, '临期凭据必须续期成功')
    const refreshRequest = requests.find(row => row.url.endsWith('/v2/plugin/auth/token/refresh'))
    assert.ok(refreshRequest, '临期账号必须命中 /v2/plugin/auth/token/refresh')
    assert.equal(refreshRequest.url, 'https://www.workbuddy.cn/v2/plugin/auth/token/refresh')
    assert.equal(refreshRequest.method, 'POST')
    assert.equal(refreshRequest.headers.get('X-Refresh-Token'), expiring.refreshToken)
    assert.equal(refreshRequest.headers.get('X-Auth-Refresh-Source'), 'plugin')
    assert.equal(refreshRequest.headers.get('X-Domain'), 'www.workbuddy.cn')
    assert.equal(refreshRequest.headers.get('Authorization'), null, '续期请求不带旧的 Authorization')
    assert.equal(refreshRequest.body, '{}')
    const storedRefreshed = JSON.parse(creds.get(ref).value)
    assert.equal(storedRefreshed.uid, uid, '续期不得丢失账号 uid')
    assert.equal(
      Buffer.from(storedRefreshed.accessToken.split('.')[1], 'base64url').toString('utf8').includes('rotated-access'),
      true, '续期后的新 accessToken 必须落盘（轮换是成对的，旧 refresh_token 已不可用）',
    )
    assert.equal(
      Buffer.from(storedRefreshed.refreshToken.split('.')[1], 'base64url').toString('utf8').includes('rotated-refresh'),
      true, '续期后的新 refreshToken 必须落盘',
    )
    assert.equal(byAccount().expiresAt, rotatedAccessExpSec * 1000, '续期后账号池有效期必须前进')

    // ── 3. refresh_token 被 401 拒绝：明确要求重新导入，不谎报成功 ──
    creds.set(ref, { value: JSON.stringify(credential({
      accessToken: jwt({ sub: uid, exp: nearExpSec, jti: 'dead-access' }),
      refreshToken: 'revoked-refresh',
    })) })
    const revoked = await call('account.refresh', { accountId })
    assert.equal(revoked.ok, false, '续期被拒时唤醒必须失败（不得 ok:true）')
    assert.match(revoked.error.message, /refresh_token 已失效|重新导入/)

    // ── 4. 无 refresh_token：退化为只探活，并把 refreshable 标 false ──
    const probeOnly = credential({ refreshToken: undefined })
    delete probeOnly.refreshToken
    creds.set(ref, { value: JSON.stringify(probeOnly) })
    requests.length = 0
    const probeOk = await call('account.refresh', { accountId })
    assert.deepEqual(probeOk, { ok: true, value: { success: true } }, '无 refresh_token 时探活通过即算唤醒成功')
    assert.equal(requests.some(row => row.url.endsWith('/v2/plugin/auth/token/refresh')), false)
    assert.equal(byAccount().refreshable, false, '没有 refresh_token 的账号必须如实标记为不可续期')

    // ── 5. 探活失败：唤醒失败并带原因 ──
    probeFails = true
    const dead = await call('account.refresh', { accountId })
    assert.equal(dead.ok, false)
    assert.match(dead.error.message, /探活失败/)
    probeFails = false

    // ── 6. 签到状态也必须容忍双层编码（同一缺陷的另一条路径） ──
    creds.set(ref, { value: JSON.stringify(JSON.stringify(credential())) })
    const status = await call('credits.status', { provider: 'workbuddy' })
    assert.equal(status.ok, true)
    const row = status.value.accounts.find(item => item.accountId === accountId)
    assert.ok(row?.status, '双编码凭据下签到状态不得静默为 null')
    assert.equal(row.status.active, true)
    assert.equal(row.status.streakDays, 1)

    console.log('ok  WorkBuddy wake: 双编码自愈、桌面端续期契约（/v2/plugin/auth/token/refresh）轮换落盘、401 与探活失败如实报错')
  } finally {
    globalThis.fetch = originalFetch
    await ctx.accountPool.removeAccount(accountId)
    creds.delete(ref)
  }
}
