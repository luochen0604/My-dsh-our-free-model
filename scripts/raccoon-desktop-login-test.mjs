import assert from 'node:assert/strict'
import http from 'node:http'

/**
 * raccoon「桌面端授权」的端到端（本地回环 + 替身上游，零真实网络）。
 *
 * ## 它钉住什么
 *
 * 1. `buildRaccoonDesktopAuthorizeUrl` 逐参数满足**官方页面**的白名单与校验
 *    （`authorizationContext` 只接受固定 8 个键；`desktop_callback=loopback`
 *    必须同时满足 `login_source=desktop`、空 `ide`、redirect 命中
 *    `^http://127\.0\.0\.1:[1-9][0-9]{3,4}/auth/callback$` 且 state 是 64 位 hex），
 *    拼错任意一条 ⇒ 官方页面显示「invalid」，用户只会看到一句「授权未完成」。
 * 2. 回调路由：`state` 不匹配 ⇒ 拒绝（不换 token）；匹配 ⇒ 用 code 换桌面端
 *    会话并写 `sessionSource:'desktop'`。
 * 3. 身份核对：授权页登录的可能是**另一个**账号，`persistDesktopSession`
 *    必须拒绝覆盖（否则 A 的凭据静默变成 B 的会话，只有积分归属出错、极难归因）。
 * 4. RPC `account.desktopLogin` / `account.desktopLoginPoll`：两段式契约，且
 *    「仍在等用户」必须是 `done:false` —— 不能因为账号原本就有可解析的凭据
 *    就谎报成功。
 */
export async function verifyRaccoonDesktopLogin({ ctx, call, creds }) {
  const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
  const url = new URL('raccoon-desktop-login.ts', sourceRoot).href
  const mod = await import(url)
  const { buildRaccoonDesktopAuthorizeUrl, startRaccoonDesktopLogin, RACCOON_DESKTOP_CALLBACK_PATH } = mod
  assert.equal(RACCOON_DESKTOP_CALLBACK_PATH, '/auth/callback', '回调路径由官方正则写死')

  // ① 官方校验规则的复刻（与逆向到的 `N()` / `C()` 逐条对应）
  const REDIRECT_RE = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/auth\/callback$/
  const STATE_RE = /^[a-f0-9]{64}$/
  const ALLOWED = new Set(['login_source', 'appname', 'state', 'redirect', 'ide', 'org', 'lang', 'desktop_callback'])
  const state = mod.generateRaccoonDesktopState()
  assert.match(state, STATE_RE, 'state 必须是 64 位小写 hex')
  const built = buildRaccoonDesktopAuthorizeUrl({ port: 53123, state })
  const parsed = new URL(built)
  assert.equal(parsed.origin, 'https://xiaohuanxiong.com')
  assert.equal(parsed.pathname, '/authorize')
  const params = parsed.searchParams
  assert.equal(params.get('login_source'), 'desktop')
  assert.equal(params.get('desktop_callback'), 'loopback')
  assert.equal(params.get('appname'), '办公小浣熊客户端', '官方桌面端的固定 appname')
  assert.equal(params.get('redirect'), 'http://127.0.0.1:53123/auth/callback')
  assert.match(params.get('redirect'), REDIRECT_RE, 'redirect 必须命中官方回环正则')
  assert.equal(params.get('state'), state)
  assert.ok(STATE_RE.test(String(params.get('state'))), 'state 必须命中官方 hex 正则')
  assert.equal(params.get('ide'), null, 'desktop_callback=loopback 要求 ide 缺席')
  for (const key of params.keys()) {
    assert.ok(ALLOWED.has(key), `官方白名单外的查询键会让页面判 invalid：${key}`)
  }
  const portValue = String(params.get('redirect')?.match(/127\.0\.0\.1:(\d+)/)?.[1])
  assert.match(portValue, /^[1-9][0-9]{3,4}$/, '端口必须是 4–5 位且首位非 0')

  // ①b 用**官方页面自己的校验函数**复验我们拼的 URL。
  //
  // 这段是逆向到的 `/authorize` 渲染层（模块 23904 的 `C()`/`N()`/`v()`）逐行复刻。
  // 它值这个钱：我们发的每个键都必须在官方白名单里、且 `desktop_callback=loopback`
  // 要同时满足四条硬校验 —— 任一条不符，页面只渲染一句「invalid」，用户完全
  // 看不出是我们拼错了 URL 还是账号本身有问题（且没有可读的错误回传）。
  const officialValidate = (search) => {
    const q = new URLSearchParams(search)
    if ([...q.keys()].some((k) => !ALLOWED.has(k) || q.getAll(k).length !== 1)) return { ok: false, why: 'keys' }
    if ([...q.values()].some((v) => v.length > 2048 || [...v].some((ch) => ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127))) {
      return { ok: false, why: 'chars' }
    }
    const loginSource = q.get('login_source')
    const desktop = loginSource === 'desktop'
    if (loginSource !== null && !desktop) return { ok: false, why: 'login_source' }
    const redirect = q.get('redirect') || ''
    const ide = (q.get('ide') || '').toLowerCase()
    if (!desktop && !REDIRECT_RE.test(redirect) && !v51cto(redirect)) return { ok: false, why: 'redirect' }
    if (!desktop && ide === 'idea' && !redirect.startsWith('http:')) return { ok: false, why: 'idea-redirect' }
    const appName = q.get('appname') || ''
    const stateValue = q.get('state') || ''
    if (!desktop && v51cto(redirect) && stateValue.trim() === '') return { ok: false, why: '51cto-state' }
    const desktopCallback = q.get('desktop_callback')
    if (q.has('desktop_callback')) {
      const loopbackRedirect = REDIRECT_RE.test(redirect)
        && /^[a-f0-9]{64}$/.test(stateValue)
        && Number(new URL(redirect).port) >= 1024
        && Number(new URL(redirect).port) <= 65535
      if (desktopCallback !== 'loopback' || !desktop || ide !== '' || !loopbackRedirect) {
        return { ok: false, why: 'desktop_callback' }
      }
    }
    const org = q.get('org') || ''
    if (appName.length > 100 || stateValue.length > 512) return { ok: false, why: 'length' }
    if (org !== '' && !/^[a-zA-Z0-9_-]{1,128}$/.test(org)) return { ok: false, why: 'org' }
    return { ok: true, desktop, loopback: desktopCallback === 'loopback' }
  }
  const v51cto = (value) => {
    try {
      const u = new URL(value)
      return ['https://test-home.51cto.com', 'https://home.51cto.com'].includes(u.origin)
        && u.pathname === '/raccoon-auth/callback'
    } catch { return false }
  }
  const verdict = officialValidate(parsed.search.slice(1))
  assert.deepEqual(verdict, { ok: true, desktop: true, loopback: true }, `官方页面会拒绝这个 URL（${verdict.why ?? '?'}）`)
  // 反向守护：少一个键 / 多一个键都必须被拒（否则上面的校验等于没跑）
  assert.equal(officialValidate(parsed.searchParams.toString().replace('desktop_callback=loopback', 'desktop_callback=other')).ok, false)
  assert.equal(officialValidate(`${parsed.search.slice(1)}&utm_source=x`).ok, false, '白名单外的键会让页面判 invalid')
  assert.equal(officialValidate(parsed.searchParams.toString().replace(/state=[0-9a-f]{64}/, 'state=short')).ok, false)

  // ② 真实起一个回环服务器，模拟官方页面投递 code（含错 state 与正确 state 两次）
  const savedFetch = globalThis.fetch
  let exchangeCalls = []
  globalThis.fetch = async (input, init) => {
    const target = String(input)
    exchangeCalls.push({ url: target, body: init?.body })
    if (target.endsWith('/login_with_authorization_code')) {
      return Response.json({
        code: 0, message: 'success',
        data: { access_token: jwt({ sub: 'pu-desktop-1', user_id: 555 }), refresh_token: 'rt-desktop-1' },
      })
    }
    if (target.endsWith('/user_info')) {
      return Response.json({ code: 0, message: 'success', data: { id: '555', name: 'RaccoonDesk', phone: '13800000000' } })
    }
    throw new Error(`未预期的桌面端授权端点：${new URL(target).pathname}`)
  }
  const provider = 'raccoon'
  const accountId = 'fixture-desktop-raccoon'
  const ref = 'FIXTURE_DESKTOP_RACCOON'
  try {
    const started = await startRaccoonDesktopLogin({})
    const callbackBase = new URL(started.loginUrl).searchParams.get('redirect')
    assert.ok(callbackBase.startsWith('http://127.0.0.1:'), '回调指向回环地址')
    const flowState = String(new URL(started.loginUrl).searchParams.get('state'))
    const deliver = (query) => new Promise((resolve, reject) => {
      const target = new URL(`${callbackBase}?${query}`)
      const req = http.get({
        hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
    })

    const wrong = await deliver(`code=whatever&state=${'0'.repeat(64)}`)
    assert.equal(wrong.status, 400, 'state 不匹配的回调必须拒绝')
    assert.equal(exchangeCalls.length, 0, '被拒绝的回调不得换 token')

    const ok = await deliver(`code=one-time-code&state=${flowState}`)
    assert.equal(ok.status, 200, `合法回调应成功：${ok.text.slice(0, 200)}`)
    const session = await started.result
    assert.equal(exchangeCalls.length, 1, '授权码只换一次')
    assert.equal(JSON.parse(String(exchangeCalls[0]?.body)).authorization_code, 'one-time-code')
    assert.equal(session.sessionSource, 'desktop', '桌面端会话必须打来源标记（每日积分的文案靠它）')

    // ③ 身份核对：同人放行、异人拒绝、无标识拒绝。
    const { raccoonDesktopIdentityMismatch } = await import(new URL('raccoon-auth.ts', sourceRoot).href)
    const desktopToken = jwt({ sub: 'pu-desktop-1', user_id: 555 })
    assert.equal(raccoonDesktopIdentityMismatch(
      { access_token: desktopToken, user_id: '555', phone: '13800000000' },
      { access_token: desktopToken, user_id: '555', phone: '13800000000' },
    ), undefined, '同一账号（sub/user_id/phone 对得上）应放行')
    assert.equal(raccoonDesktopIdentityMismatch(
      // sub 相同即同人，即使 user_id 一侧缺失
      { access_token: desktopToken },
      { access_token: desktopToken, user_id: '555' },
    ), undefined, 'sub 对上就放行')
    const mismatch = raccoonDesktopIdentityMismatch(
      { access_token: jwt({ sub: 'pu-web-9' }), user_id: '999', phone: '13900000000' },
      { access_token: desktopToken, user_id: '555', phone: '13800000000' },
    )
    assert.ok(typeof mismatch === 'string' && mismatch.length > 0, '不同账号必须给出拒绝原因')
    const unverifiable = raccoonDesktopIdentityMismatch(
      { access_token: '' },
      { access_token: '' },
    )
    assert.ok(typeof unverifiable === 'string' && unverifiable.length > 0, '取不到任何可比对标识时必须拒绝（不得静默覆盖）')
  } finally {
    globalThis.fetch = savedFetch
  }
  // ④ RPC 两段式契约
  const savedFetch2 = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('本步不该发上游请求') }
  try {
    creds.set(ref, { value: JSON.stringify({ access_token: jwt({ sub: 'pu-web-1' }), refresh_token: 'rt-web-1', user_id: '777' }) })
    await ctx.accountPool.addAccount({
      id: accountId, provider, nickname: 'RaccoonWeb', credentialRef: ref,
      enabled: true, refreshable: true, createdAt: 1,
    })
    const rejected = await call('account.desktopLogin', { accountId: 'no-such-account' })
    assert.equal(rejected.ok, false, '账号不存在必须报错')

    const launched = await call('account.desktopLogin', { accountId })
    assert.equal(launched.ok, true, JSON.stringify(launched))
    const loginUrl = launched.value?.loginUrl
    assert.ok(typeof loginUrl === 'string' && loginUrl.includes('/authorize'), '返回官方授权页地址')
    assert.equal(new URL(loginUrl).searchParams.get('desktop_callback'), 'loopback')

    const pending = await call('account.desktopLoginPoll', { accountId })
    assert.equal(pending.ok, true)
    assert.equal(pending.value.done, false, '用户还没完成授权 ⇒ 不得谎报成功')
    // 账号原有凭据本来就能解析：拿它当成功判据会立刻返回 done:true。
    assert.notEqual(await call('account.desktopLoginPoll', { accountId }).then(v => v.value.done), true)

    const aborted = await call('account.desktopLogin', { accountId })
    assert.equal(aborted.value.loginUrl, loginUrl, '重复点击复用同一轮，不再起第二个回环端口')

    const wrongProvider = await call('account.desktopLogin', { accountId: 'ops-fixture-loomy' })
    assert.equal(wrongProvider.ok, false, '非 raccoon 账号必须拒绝')
  } finally {
    globalThis.fetch = savedFetch2
    await ctx.accountPool.removeAccount(accountId)
    creds.delete(ref)
  }
  console.log('ok  raccoon desktop login: 官方回环参数校验、state 门槛、身份核对、两段式 RPC')
}

/** 造一个只带 claims 的假 JWT（本模块只解 payload，不验签）。 */
function jwt(claims) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  return `${head}.${payload}.signature`
}
