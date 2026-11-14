import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Loomy 登录参数与官方客户端的一致性（源码级，零网络）。
 *
 * ## 它钉住什么
 *
 * 逐参数对照逆向得到的
 * `D:\Program Files\Loomy\resources\app.asar.unpacked\electron\xfyun\account-service.js`
 * （v0.9.39）。发出去的 body 形状一旦与客户端不同，**服务端不一定报错** ——
 * 归因静默丢失、渠道统计漏记，出了事没有任何症状可查。所以这里把
 * 「发的每个键」都断言死。
 *
 * 覆盖三处非对称（照抄客户端，不是我们的发明）：
 *
 * 1. `sendMsgCode` **不带** `channel`，而 `checkCode` **带**（有值时）。
 * 2. `bind/auth` 带 `channel`（+ 可选 `authconf`），后续 bind 步骤都不带。
 * 3. `first-login` 带 `channel`，且 **`visitedId` 仅在 `channel` 存在时才发**。
 *
 * 反面同样重要：无渠道号时 body 必须与改动前**逐字节一致**（不含该键），
 * 否则官网安装包用户的请求体反而偏离了客户端。
 */
export async function verifyLoomyChannelParity() {
  const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
  const channelMod = await import(new URL('loomy-channel.ts', sourceRoot).href)
  const oauthMod = await import(new URL('loomy-oauth.ts', sourceRoot).href)
  const creditsMod = await import(new URL('loomy-credits.ts', sourceRoot).href)
  const { LOOMY } = await import(new URL('loomy-product.ts', sourceRoot).href)

  const {
    parseLoomyChannelFromFilename,
    parseLoomyVisitedIdFromFilename,
    readLoomyWindowsInstallerName,
    applyLoomyChannelParam,
    buildLoomyFirstLoginBody,
    resolveLoomyChannelAttribution,
    resetLoomyChannelAttributionCache,
  } = channelMod

  // ① 文件名解析：与客户端 `channel-filename.js` 同源。
  assert.equal(parseLoomyChannelFromFilename('Loomy-Setup-0.9.39.exe'), '', '官网包无渠道标记')
  assert.equal(parseLoomyChannelFromFilename('Loomy-CH-cg-Setup-0.9.39.exe'), 'cg')
  assert.equal(parseLoomyChannelFromFilename('Loomy-CH-campus_2026-Setup.exe'), 'campus_2026')
  assert.equal(parseLoomyChannelFromFilename(undefined), '')
  assert.equal(parseLoomyChannelFromFilename(123), '')
  // 渠道号只允许 [A-Za-z0-9_]：带连字符时截断到第一段（与客户端正则一致）。
  assert.equal(parseLoomyChannelFromFilename('x-CH-ab-cd.exe'), 'ab')
  assert.equal(parseLoomyVisitedIdFromFilename('Loomy-CH-cg-VID-visitor-abc-123.dmg'), 'visitor-abc-123')
  assert.equal(parseLoomyVisitedIdFromFilename('Loomy-CH-cg.dmg'), '')
  // ⚠️ `[A-Za-z0-9_-]+` 是**贪婪**的：扩展名之前的内容全吃进去。
  // 这与客户端正则逐字符相同，是**保真**而不是我们的缺陷 ——
  // 真实渠道包名把 VID 放在扩展名之前（`…-VID-<uuid>.dmg`），故不会出问题。
  assert.equal(parseLoomyVisitedIdFromFilename('Loomy-CH-cg-VID-abc-Setup.exe'), 'abc-Setup',
    '贪婪匹配与客户端一致（不是缺陷，是保真）')
  // 大小写敏感：`-CH-` 是固定标记。
  assert.equal(parseLoomyChannelFromFilename('loomy-ch-cg.exe'), '')

  // ② 空归因绝不给 body 加键（这是「与改动前一致」的硬保证）。
  const emptyParam = {}
  applyLoomyChannelParam(emptyParam, { channel: '', visitedId: '' })
  assert.deepEqual(emptyParam, {}, '空渠道号不得写 channel 键')
  applyLoomyChannelParam(emptyParam, { channel: '   ', visitedId: 'v' })
  assert.deepEqual(emptyParam, {}, '纯空白渠道号同样不得写键')
  assert.deepEqual(buildLoomyFirstLoginBody(undefined), {}, '无归因时 first-login body 必须是空对象')
  assert.deepEqual(buildLoomyFirstLoginBody({ channel: '', visitedId: 'orphan' }), {},
    'visitedId 不得单独发送（客户端 if (channel && visitedId)）')

  // ③ 有归因时的形状。
  const withChannel = {}
  applyLoomyChannelParam(withChannel, { channel: 'cg', visitedId: 'v1' })
  assert.deepEqual(withChannel, { channel: 'cg' }, '登录参数只带 channel，不带 visitedId')
  assert.deepEqual(buildLoomyFirstLoginBody({ channel: 'cg', visitedId: 'v1' }), { channel: 'cg', visitedId: 'v1' })
  assert.deepEqual(buildLoomyFirstLoginBody({ channel: 'campus', visitedId: '' }), { channel: 'campus' })

  // ④ 记忆化：同一进程只解析一次（macOS 上避免反复触发 TCC 弹窗）。
  resetLoomyChannelAttributionCache()
  const first = resolveLoomyChannelAttribution({ platform: 'linux' })
  assert.deepEqual(first, { channel: '', visitedId: '' }, '未知平台无来源')
  assert.equal(resolveLoomyChannelAttribution({ platform: 'win32' }), first, '结果被记忆化')

  // ⑤ 真实请求体：替身 fetch 抓 `sendMsgCode` / `checkCode` / `bind/auth`。
  const savedFetch = globalThis.fetch
  const savedAppData = process.env.APPDATA
  const savedProgramData = process.env.ProgramData
  const calls = []
  const fakeFetch = async (input, init) => {
    const target = new URL(String(input)).pathname
    calls.push({ path: target, body: JSON.parse(String(init?.body ?? '{}')) })
    if (target.endsWith('/sendMsgCode')) return Response.json({ code: '000000', data: { msgid: 'mid-1' } })
    if (target.endsWith('/checkCode')) return Response.json({ code: '000000', data: { session: 's'.repeat(32), userid: '1'.repeat(18) } })
    if (target.endsWith('/bind/auth')) return Response.json({ code: '000000', data: { bind: 1, rcode: 'rc-1' } })
    if (target.endsWith('/first-login')) return Response.json({ code: '000000', data: { dailyQuota: 5000, dailyConsumed: 0 } })
    throw new Error(`未预期端点：${target}`)
  }
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ofm-loomy-ch-'))
  globalThis.fetch = fakeFetch
  try {
    // ① 无归因（本机官网包的真实状态）→ 三个 body 都不得含 channel。
    await fs.promises.mkdir(path.join(scratch, 'Loomy'), { recursive: true })
    await fs.promises.writeFile(
      path.join(scratch, 'Loomy', 'installer-filename'), 'Loomy-Setup-0.9.39.exe\n', 'utf8',
    )
    process.env.APPDATA = scratch
    delete process.env.ProgramData
    resetLoomyChannelAttributionCache()
    calls.length = 0
    await oauthMod.sendLoomySmsCode('13800138000', LOOMY, fakeFetch)
    await oauthMod.loginLoomyBySmsCode('13800138000', '123456', 'mid-1', LOOMY, fakeFetch)
    await oauthMod.bindLoomyThirdAccount('wx-code', LOOMY, fakeFetch)
    assert.equal(calls.length, 3)
    for (const call of calls) {
      assert.equal('channel' in call.body.param, false, `${call.path} 无归因时不得带 channel`)
      assert.equal('authconf' in call.body.param, false, '生产包无 authconf，不得带该键')
    }
    // base 信封逐字段与客户端 `_makeBase()` 一致。
    const base = calls[0].body.base
    assert.deepEqual(Object.keys(base).sort(), ['appid', 'devid', 'modelid', 'traceid', 'ua', 'version'])
    assert.equal(base.appid, 'GM3LOOMY')
    assert.equal(base.modelid, 'Web')
    assert.equal(base.version, '1.0.0')
    assert.equal(base.devid, 'web')
    assert.equal(base.ua, 'Loomy|Desktop|Electron|macOS', 'Windows 上客户端也发 macOS')
    assert.match(base.traceid, /^[0-9a-f]{32}$/, 'traceid 是无连字符的 uuid')

    // ② 有归因 → 只有 checkCode 与 bind/auth 带 channel；sendMsgCode 不带。
    await fs.promises.writeFile(
      path.join(scratch, 'Loomy', 'installer-filename'),
      'Loomy-CH-cg-VID-visitor-abc.dmg',
      'utf8',
    )
    resetLoomyChannelAttributionCache()
    calls.length = 0
    await oauthMod.sendLoomySmsCode('13800138000', LOOMY, fakeFetch)
    await oauthMod.loginLoomyBySmsCode('13800138000', '123456', 'mid-1', LOOMY, fakeFetch)
    await oauthMod.bindLoomyThirdAccount('wx-code', LOOMY, fakeFetch)
    const byPath = (suffix) => calls.find((c) => c.path.endsWith(suffix))
    assert.equal('channel' in byPath('/sendMsgCode').body.param, false,
      'sendMsgCode 不带 channel —— 客户端 sendSmsCode 没有这段，对称化会偏离')
    assert.equal(byPath('/checkCode').body.param.channel, 'cg', 'checkCode 必须带 channel')
    assert.equal('visitedId' in byPath('/checkCode').body.param, false, '登录端点不发 visitedId')
    assert.equal(byPath('/bind/auth').body.param.channel, 'cg', 'bind/auth 必须带 channel')

    // ③ %ProgramData% 回落（perMachine 安装）。
    process.env.APPDATA = path.join(scratch, 'nope')
    assert.equal(
      readLoomyWindowsInstallerName({ ProgramData: scratch }),
      'Loomy-CH-cg-VID-visitor-abc.dmg',
      '%APPDATA% 缺失时回落 %ProgramData%',
    )
    assert.equal(readLoomyWindowsInstallerName({}), '', '两个候选都没有时返回空串而不是抛错')

    // ④ first-login：`visitedId` 只在 channel 存在时一起发。
    process.env.APPDATA = scratch
    resetLoomyChannelAttributionCache()
    calls.length = 0
    await creditsMod.claimLoomyDailyQuota(
      { access_token: 's'.repeat(32), userid: '1'.repeat(18), phone: '13800138000' },
      LOOMY,
      fakeFetch,
    )
    const firstLogin = calls.find((c) => c.path.endsWith('/first-login'))
    assert.ok(firstLogin !== undefined, 'first-login 必须被调用')
    assert.deepEqual(firstLogin.body, { channel: 'cg', visitedId: 'visitor-abc' },
      'first-login 同时带 channel 与 visitedId（客户端 completeFirstLogin）')

    // ⑤ 无归因时 first-login body 必须仍是空对象（改动前行为）。
    await fs.promises.writeFile(
      path.join(scratch, 'Loomy', 'installer-filename'), 'Loomy-Setup-0.9.39.exe\n', 'utf8',
    )
    resetLoomyChannelAttributionCache()
    calls.length = 0
    await creditsMod.claimLoomyDailyQuota(
      { access_token: 's'.repeat(32), userid: '1'.repeat(18), phone: '13800138000' },
      LOOMY,
      fakeFetch,
    )
    assert.deepEqual(calls.find((c) => c.path.endsWith('/first-login')).body, {},
      '官网包用户 first-login body 必须与改动前逐字节一致')
  } finally {
    globalThis.fetch = savedFetch
    if (savedAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = savedAppData
    if (savedProgramData === undefined) delete process.env.ProgramData
    else process.env.ProgramData = savedProgramData
    resetLoomyChannelAttributionCache()
    await fs.promises.rm(scratch, { recursive: true, force: true })
  }

  console.log('ok  loomy login parity: channel/authconf 参数形状与官方客户端逐键一致（空归因时逐字节不变）')
}
