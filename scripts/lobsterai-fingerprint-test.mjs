/**
 * LobsterAI 登录请求参数的离线「指纹自检」。
 *
 *     node scripts/lobsterai-fingerprint-test.mjs
 *
 * 锁死的是 2026-11-13 那次修复里**每一条都可能悄悄回归**的性质 ——
 * 它们都属于「客户端看起来能用、服务端却把账号记成第三方反代」的那类缺陷，
 * 出问题时没有任何本地报错，只能靠这里断言：
 *
 * 1. `firstKeyfrom` / `latestKeyfrom` 是**渠道标签**（`official`）而不是毫秒时间戳；
 * 2. `uuid` 是**安装级**的：两次登录流程之间不变（模拟 store 落盘）；
 * 3. auth 端点不发 `LobsterAI/0.1.0`（第三方标识），UA 必须是 Electron 形态
 *    （含 `Chrome/…`、`Electron/…`）；
 * 4. 登录页 URL 的形态：参数写进 **hash query**、`redirect_uri` 内嵌
 *    `return_to=…electronLogin=success`、`state` 是 base64url 32 字符；
 * 5. GET 端点的身份 query 齐全（models / profile-summary / overmind 更新接口）；
 * 6. refresh 请求体字段顺序与桌面端一致。
 *
 * 全部离线：fetch 是注入的假实现，不访问任何真实端点。
 *
 * ## 为什么自带一个「转译到临时目录」的装载器
 *
 * `channel-pack-test.mjs` 用 `module.registerHooks` 直接装载 `.ts`，但那是
 * Node **≥22.15** 的 API；仓库允许的 22.19 没问题，而本机 22.13 上连套件都
 * 起不来。这里改为把 `vendor/channel-pack/src` 转译成一份临时 `.mjs` 目录再
 * 普通 `import`：不依赖较新的 loader API，也不需要 esbuild。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ts = (await import('typescript')).default
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-lobsterai-fingerprint-'))
const sourceDir = path.resolve(fileURLToPath(new URL('../vendor/channel-pack/src/', import.meta.url)))
// 与 `channel-pack-test.mjs` 同款的最小宿主契约（Service / LlmAdapter /
// schemastery proxy …）；装载后这些模块与真实宿主共享同一份替身。
const kernelUrl = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const buildDir = path.join(scratch, 'build')

/**
 * 把 `@deepseek-ai/*` 指到宿主替身、把相对 import 指到转译后的 `.mjs`（或仓库里
 * 真实存在的 `.js`，例如 `llm-register-compat.ts` 反向引用 `src/image-pricing.js`）。
 * 只改 import 说明符：正则要求前面是 `from`/`import(`。
 */
function rewriteSpecifiers(code, sourceFile) {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"]+)\2/g, (match, prefix, quote, specifier) => {
    if (specifier.startsWith('@deepseek-ai/')) return `${prefix}${quote}${kernelUrl}${quote}`
    if (!specifier.startsWith('.')) return match
    const absolute = path.resolve(path.dirname(sourceFile), specifier)
    if (specifier.endsWith('.js')) {
      const tsFile = absolute.replace(/\.js$/, '.ts')
      if (tsFile.startsWith(sourceDir + path.sep) && fs.existsSync(tsFile)) {
        const built = path.join(buildDir, path.relative(sourceDir, tsFile).replace(/\.ts$/, '.mjs'))
        return `${prefix}${quote}${pathToFileURL(built).href}${quote}`
      }
      if (fs.existsSync(absolute)) return `${prefix}${quote}${pathToFileURL(absolute).href}${quote}`
    }
    return match
  })
}

/** 递归转译整棵 `src`：`.ts` → `.mjs`；非 TS 资源（wasm 等）本套件用不到，跳过。 */
function transpileInto(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    if (entry.isDirectory()) {
      transpileInto(source, path.join(to, entry.name))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: source,
    }).outputText
    fs.writeFileSync(
      path.join(to, entry.name.replace(/\.ts$/, '.mjs')),
      rewriteSpecifiers(code, source),
    )
  }
}

transpileInto(sourceDir, buildDir)
const load = name => import(pathToFileURL(path.join(buildDir, `${name}.mjs`)).href)

// 身份文档写到临时目录（与本仓库其它状态文档测试同惯例）。
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch

/** 记录假 fetch 收到的请求，供断言 URL / 请求头 / body。 */
function recordingFetch(handler) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, fetchImpl }
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

try {
  const productModule = await load('lobsterai-product')
  const lobsterai = await load('lobsterai')
  const oauth = await load('lobsterai-oauth')
  const identityModule = await load('lobsterai-identity')
  const credits = await load('lobsterai-credits')
  const product = productModule.LOBSTERAI

  // ── 1. keyfrom 的语义：渠道标签，不是时间戳 ────────────────────────────
  {
    const timestamp = String(Date.now())
    assert.equal(lobsterai.LOBSTERAI_DEFAULT_KEYFROM, 'official')
    assert.equal(lobsterai.sanitizeLobsteraiKeyfrom(timestamp), 'official', '毫秒时间戳必须被替换')
    assert.equal(lobsterai.sanitizeLobsteraiKeyfrom('official'), 'official', '合法渠道标签原样保留')
    assert.equal(lobsterai.sanitizeLobsteraiKeyfrom('html_share'), 'html_share')
    assert.equal(lobsterai.sanitizeLobsteraiKeyfrom('Bad Value'), 'official', '非法形态回落 official')
    assert.equal(lobsterai.parseLobsteraiKeyfrom(1794545156821), undefined, '数字类型同样非法')
    for (const value of [timestamp, 'official', 'site_deployment']) {
      const sanitized = lobsterai.sanitizeLobsteraiKeyfrom(value)
      assert.match(sanitized, lobsterai.LOBSTERAI_KEYFROM_PATTERN)
      assert.equal(/^\d+$/.test(sanitized), false, '不得是纯数字时间戳形态')
    }

    // 老凭据（毫秒 keyfrom）构造出来的载荷也必须已经洗过。
    const legacyCredential = {
      access_token: 'a', refresh_token: 'r',
      uuid: 'b58139cd-b405-4ec5-92f2-d25bbb7d37c2',
      first_keyfrom: timestamp, latest_keyfrom: timestamp, user_id: 'yid-1',
    }
    const body = lobsterai.lobsteraiKeyfromBody(legacyCredential, '2026.11.6')
    assert.equal(body.firstKeyfrom, 'official')
    assert.equal(body.latestKeyfrom, 'official')
    assert.equal(body.uuid, legacyCredential.uuid)
    assert.deepEqual(Object.keys(body), ['firstKeyfrom', 'latestKeyfrom', 'uuid', 'userId', 'version'])
    console.log('ok  keyfrom 是渠道标签：毫秒时间戳/非法值一律回落 official，且不再是纯数字')
  }

  // ── 2. 安装身份：落盘、跨次恒定、首次渠道粘住 ──────────────────────────
  {
    const legacyDoc = {
      installationUuid: 'b58139cd-b405-4ec5-92f2-d25bbb7d37c2',
      keyfrom: { firstKeyfrom: '1794545156821', latestKeyfrom: '1794545156821', updatedAt: 1 },
    }
    const merged = identityModule.mergeLobsteraiIdentity(legacyDoc, { now: 42 })
    assert.equal(merged.uuid, 'b58139cd-b405-4ec5-92f2-d25bbb7d37c2', '合法安装 UUID 必须沿用')
    assert.equal(merged.firstKeyfrom, 'official', '旧文档里的毫秒 keyfrom 必须被替换')
    assert.equal(merged.latestKeyfrom, 'official')
    assert.equal(merged.updatedAt, 42)

    const generated = identityModule.mergeLobsteraiIdentity({ installationUuid: 'not-a-uuid' }, { now: 1 })
    assert.match(generated.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    // 文件后端：两次「安装」解析到同一个 uuid（等价于重启应用/重新登录）。
    const emptyCtx = { logger: { warn() {} } }
    const storeA = identityModule.createLobsteraiIdentityStore(emptyCtx)
    const first = storeA.resolve()
    const second = identityModule.createLobsteraiIdentityStore(emptyCtx).resolve()
    assert.equal(second.uuid, first.uuid, '安装 UUID 跨进程/跨登录必须恒定')
    assert.equal(second.firstKeyfrom, 'official', 'firstKeyfrom 首次写入后粘住')
    assert.equal(second.latestKeyfrom, 'official')
    const docPath = path.join(scratch, 'channel-pack', identityModule.LOBSTERAI_INSTALLATION_FILE)
    assert.equal(fs.existsSync(docPath), true, '安装身份必须落盘')
    const onDisk = JSON.parse(fs.readFileSync(docPath, 'utf8'))
    assert.equal(onDisk.installationUuid, first.uuid)
    assert.equal(onDisk.schema, 'channel-pack/lobsterai-installation/v1')
    assert.equal(onDisk.keyfrom.firstKeyfrom, 'official')
    console.log(`ok  安装身份落盘：${path.basename(docPath)} 里的 uuid 跨次恒定，keyfrom 是 official`)
  }

  // ── 3. UA：桌面形态，绝不发第三方标识 ────────────────────────────────
  {
    const ua = product.userAgent
    assert.match(ua, /Chrome\/\d/, 'UA 必须含真实网络栈的 Chrome 标记')
    assert.match(ua, /Electron\/\d/, 'UA 必须含 Electron 标记')
    assert.equal(ua.includes('LobsterAI/0.1.0'), false, '不得再发第三方项目标识')
    assert.equal(ua.includes('undici'), false)
    assert.equal(product.clientCapabilities,
      'virtual-models-v1,kimi-k3-agentic-v1,thinking-level-control-v1,upstream-error-details-v1')
    assert.equal(product.fallbackClientVersion, '2026.11.6', '兜底版本号 = 安装包真实版本')

    const anonymous = lobsterai.lobsteraiAnonymousHeaders(product)
    assert.equal(anonymous['User-Agent'], ua)
    assert.deepEqual(Object.keys(anonymous).sort(), ['Content-Type', 'User-Agent'],
      'auth 端点只发 Content-Type + UA（与桌面端同形）')
    const models = lobsterai.lobsteraiModelsHeaders(
      { access_token: 't', refresh_token: 'r' }, product, '2026.11.6',
    )
    assert.equal(models['User-Agent'], ua, '业务请求与 auth 用同一个 UA')
    assert.match(models['X-LobsterAI-Client-Capabilities'], /virtual-models-v1/)
    assert.match(models['X-LobsterAI-Client-Capabilities'], /upstream-error-details-v1/)
    console.log('ok  UA 是 Electron 形态（Chrome/… + Electron/…），不再出现 LobsterAI/0.1.0')
  }

  // ── 4. exchange：请求体与登录 URL 的形态 ─────────────────────────────
  {
    const identity = {
      uuid: 'b58139cd-b405-4ec5-92f2-d25bbb7d37c2',
      firstKeyfrom: 'official',
      latestKeyfrom: 'official',
    }
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({
      code: 0,
      data: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, user: { id: 'u1', yid: 'y1' } },
    }))
    const credential = await oauth.exchangeLobsteraiAuthCode(
      'code-1', identity, '2026.11.6', product, fetchImpl,
    )
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call.url, `${product.apiBase}/api/auth/exchange`)
    const body = JSON.parse(call.init.body)
    assert.deepEqual(Object.keys(body), ['authCode', 'firstKeyfrom', 'latestKeyfrom', 'uuid', 'version'])
    assert.equal(body.firstKeyfrom, 'official')
    assert.equal(body.latestKeyfrom, 'official')
    assert.equal(body.uuid, identity.uuid, 'exchange 必须发安装 UUID')
    assert.equal(body.version, '2026.11.6')
    assert.equal(call.init.headers['User-Agent'], product.userAgent)
    assert.equal(call.init.headers.Accept, undefined, 'auth 端点不再发 Accept（桌面端只发 Content-Type）')
    assert.equal(credential.first_keyfrom, 'official')
    assert.equal(credential.latest_keyfrom, 'official')
    assert.equal(credential.uuid, identity.uuid)
  }
  {
    // 登录页地址运行时下发失败 → 回退 portal；成功后参数全部落在 hash query 里。
    const identity = { uuid: 'b58139cd-b405-4ec5-92f2-d25bbb7d37c2', firstKeyfrom: 'official', latestKeyfrom: 'official' }
    const { calls, fetchImpl } = recordingFetch(() => { throw new Error('offline') })
    const started = await oauth.startLobsteraiLoginFlow({
      product, clientVersion: '2026.11.6', identity, fetcher: fetchImpl, timeoutMs: 50,
    })
    try {
      assert.equal(calls[0].url, product.loginUrlApi, '登录页地址必须运行时从 overmind 取')
      const url = new URL(started.loginUrl)
      assert.equal(url.origin + url.pathname, 'https://lobsterai.youdao.com/portal')
      assert.equal(url.search, '', '参数不能写进 search（登录页读的是 hash query）')
      assert.equal(url.hash.startsWith('#/login?'), true)
      const hashQuery = new URLSearchParams(url.hash.slice('#/login?'.length))
      assert.equal(hashQuery.get('source'), 'electron')
      const state = hashQuery.get('state')
      assert.match(state, /^[A-Za-z0-9_-]{32}$/, 'state = base64url(24 字节)，与桌面端同形')
      const redirectUri = new URL(hashQuery.get('redirect_uri'))
      assert.equal(redirectUri.protocol, 'http:')
      assert.equal(redirectUri.hostname, '127.0.0.1')
      assert.equal(/^\d+$/.test(redirectUri.port), true, 'redirect_uri 必须指回本地回调端口')
      assert.equal(redirectUri.pathname, '/auth/callback')
      const returnTo = redirectUri.searchParams.get('return_to')
      assert.ok(returnTo !== null, 'redirect_uri 必须内嵌 return_to（桌面端 appendCallbackReturnTo）')
      const returnQuery = new URLSearchParams(returnTo.slice(returnTo.indexOf('#/login?') + '#/login?'.length))
      assert.equal(returnQuery.get('source'), 'electron')
      assert.equal(returnQuery.get('electronLogin'), 'success')
    } finally {
      await started.close()
    }
  }
  {
    // 下发成功时必须用 overmind 给的入口（而不是硬编码值）。
    const identity = { uuid: 'b58139cd-b405-4ec5-92f2-d25bbb7d37c2', firstKeyfrom: 'official', latestKeyfrom: 'official' }
    const { fetchImpl } = recordingFetch(() => jsonResponse({
      data: { value: 'https://lobsterai.youdao.com/portal-new#/login' }, code: 0, msg: 'OK',
    }))
    const started = await oauth.startLobsteraiLoginFlow({
      product, clientVersion: '2026.11.6', identity, fetcher: fetchImpl, timeoutMs: 50,
    })
    try {
      assert.equal(started.loginUrl.startsWith('https://lobsterai.youdao.com/portal-new#/login?'), true)
      assert.equal(oauth.loginPageUrlFromOvermind({ data: { value: 'javascript:alert(1)' } }), undefined,
        '非 http(s) 的入口必须被拒绝')
      assert.equal(oauth.loginPageUrlFromOvermind({ data: { value: 1 } }), undefined)
    } finally {
      await started.close()
    }
  }
  console.log('ok  登录 URL：hash query + 内嵌 return_to(electronLogin=success) + base64url(24B) state')
  {
    const identity = { uuid: 'b58139cd-b405-4ec5-92f2-d25bbb7d37c2', firstKeyfrom: 'official', latestKeyfrom: 'official' }
    const body = lobsterai.lobsteraiRefreshBody({
      access_token: 'a', refresh_token: 'r', uuid: identity.uuid,
      first_keyfrom: 'official', latest_keyfrom: 'official', user_id: 'y1',
    }, '2026.11.6')
    assert.deepEqual(Object.keys(body),
      ['refreshToken', 'firstKeyfrom', 'latestKeyfrom', 'uuid', 'userId', 'version'],
      'refresh 字段顺序对齐桌面端')
    assert.equal(body.firstKeyfrom, 'official')
    assert.equal(body.latestKeyfrom, 'official')
    console.log('ok  refresh 请求体字段顺序与桌面端一致（refreshToken 打头）')
  }

  // ── 5. GET 端点的身份 query ─────────────────────────────────────────
  {
    const identity = { uuid: 'b58139cd-b405-4ec5-92f2-d25bbb7d37c2', firstKeyfrom: 'official', latestKeyfrom: 'official' }
    const legacyCredential = {
      access_token: 'access', refresh_token: 'refresh',
      uuid: '11111111-2222-3333-4444-555555555555',
      first_keyfrom: String(Date.now()), latest_keyfrom: String(Date.now()), user_id: 'y1',
    }
    const hydrated = lobsterai.withLobsteraiIdentity(legacyCredential, identity)
    assert.equal(hydrated.uuid, identity.uuid, 'request-time 身份必须来自安装身份')
    assert.equal(hydrated.first_keyfrom, 'official')
    const query = new URLSearchParams(lobsterai.lobsteraiKeyfromQuery(hydrated, '2026.11.6'))
    assert.equal(query.get('firstKeyfrom'), 'official')
    assert.equal(query.get('latestKeyfrom'), 'official')
    assert.equal(query.get('uuid'), identity.uuid)
    assert.equal(query.get('version'), '2026.11.6')
    assert.equal(/^\d+$/.test(query.get('firstKeyfrom')), false)

    // profile-summary：请求 URL 必须带同一份身份 query。
    const creditsFetch = recordingFetch(() => jsonResponse({
      code: 0, data: { totalCreditsRemaining: 12, creditItems: [] },
    }))
    const balance = await credits.fetchLobsteraiCreditBalance(
      legacyCredential, product, creditsFetch.fetchImpl,
      { identity, clientVersion: '2026.11.6' },
    )
    assert.equal(balance?.total, 12)
    const profileUrl = new URL(creditsFetch.calls[0].url)
    assert.equal(profileUrl.pathname, '/api/user/profile-summary')
    assert.equal(profileUrl.searchParams.get('uuid'), identity.uuid)
    assert.equal(profileUrl.searchParams.get('firstKeyfrom'), 'official')
    assert.equal(profileUrl.searchParams.get('latestKeyfrom'), 'official')
    assert.equal(profileUrl.searchParams.get('version'), '2026.11.6')

    // 版本号接口（桌面端连配置类 GET 都带身份 query）。
    const versionFetch = recordingFetch(() => jsonResponse({
      code: 0, msg: 'OK', data: { value: { version: '2026.11.6' } },
    }))
    const resolver = new lobsterai.LobsteraiClientVersionResolver({ fetcher: versionFetch.fetchImpl })
    const resolved = await resolver.resolve(product, identity)
    assert.equal(resolved.version, '2026.11.6')
    const versionUrl = new URL(versionFetch.calls[0].url)
    assert.equal(versionUrl.searchParams.get('uuid'), identity.uuid)
    assert.equal(versionUrl.searchParams.get('firstKeyfrom'), 'official')
    assert.equal(versionUrl.searchParams.get('latestKeyfrom'), 'official')
    assert.equal(versionUrl.searchParams.get('version'), '2026.11.6')
    console.log('ok  GET 身份 query：models / profile-summary / overmind 更新接口都带 uuid+official keyfrom')
  }

  // ── 6. Auth 服务接线：身份来自落盘文档而不是凭据 ──────────────────────
  {
    const { LobsteraiAuth } = await load('lobsterai-auth')
    const services = {}
    const warnLog = []
    const makeContext = () => ({
      logger: { warn: (message) => warnLog.push(message) },
      get: (name) => services[name],
      provide: (name, value) => { services[name] = value },
    })
    const ctx = makeContext()
    const auth = new LobsteraiAuth(ctx, {})
    const first = await auth.resolveIdentity()
    const again = await auth.resolveIdentity()
    assert.equal(again.uuid, first.uuid)

    // 换一个实例（等价于重启）仍拿到同一安装 UUID。
    const restarted = new LobsteraiAuth(makeContext(), {})
    assert.equal((await restarted.resolveIdentity()).uuid, first.uuid)

    // 版本号解析失败 → 回退值 + 一条日志（回退值本身必须是安装包版本）。
    const offlineFetch = async () => { throw new Error('offline') }
    const offlineAuth = new LobsteraiAuth(makeContext(), {
      fetcher: offlineFetch,
      identityStore: identityModule.createLobsteraiIdentityStore(makeContext()),
    })
    assert.equal(await offlineAuth.resolveClientVersion(), product.fallbackClientVersion)
    assert.equal(warnLog.some(line => line.includes('回退')), true, '版本号回退必须留日志')
    console.log('ok  Auth 服务：安装 UUID 落盘复用，版本号回退时有日志')
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
