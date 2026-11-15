/**
 * raccoon「可信设备」绑定模块的单测（零真实网络）。
 *
 * 锁死 2026-11-15 逆向出的关键事实：
 *  - 绑定请求体的字段与官方 `buildDesktopDeviceMetadata` 一致（`client_version` 不带 `v`）；
 *  - `X-Client-Device-ID` 会带上，`X-Client-Platform` 固定 `desktop-windows`；
 *  - 成功时返回服务端给的 `device_id` 与 `trusted_device`；
 *  - 失败**不抛错**，只返回 `failure`（登录后绑定失败不能把用户卡在回调页）。
 */
import assert from 'node:assert/strict'

export async function verifyRaccoonDevice({ ctx, call, creds }) {
  const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
  const mod = await import(new URL('raccoon-device.ts', sourceRoot).href)
  const { bindRaccoonTrustedDevice, heartbeatRaccoonTrustedDevice, RACCOON_DESKTOP_PLATFORM } = mod

  assert.equal(RACCOON_DESKTOP_PLATFORM, 'desktop-windows', '平台标识必须与官方一致')

  const product = { apiBase: 'https://xiaohuanxiong.com', authApiPrefix: '/api/web/auth/v1', clientVersion: 'v1.2.1' }
  const credential = { access_token: 'fixture-device-token', device_id: 'dev-fixture-1', sessionSource: 'desktop' }

  const saved = globalThis.fetch
  const seen = []
  try {
    // ① 成功路径：校验请求形状 + 返回值解析
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      seen.push({ url: url.toString(), method: init?.method, headers: { ...(init?.headers ?? {}) }, body: init?.body })
      if (url.pathname.endsWith('/devices_current_bind')) {
        return Response.json({ code: 0, message: 'success', data: { device_id: 'dev-bound-42', trusted_device: true } })
      }
      if (url.pathname.endsWith('/devices_current_heartbeat')) {
        return Response.json({ code: 0, message: 'success', data: { device_id: 'dev-bound-42', trusted_device: true } })
      }
      throw new Error(`未预期端点：${url.pathname}`)
    }

    const bind = await bindRaccoonTrustedDevice(product, credential, { hostname: 'DESKTOP-TEST', osRelease: '10.0.19045' })
    assert.equal(bind.deviceId, 'dev-bound-42')
    assert.equal(bind.trusted, true)
    assert.equal(bind.failure, undefined)

    const bindCall = seen.find((s) => s.url.endsWith('/devices_current_bind'))
    assert.ok(bindCall, '必须调用 devices_current_bind')
    assert.equal(bindCall.method, 'POST')
    assert.equal(bindCall.headers['X-Client-Platform'], 'desktop-windows')
    assert.equal(bindCall.headers['X-Client-Device-ID'], 'dev-fixture-1', '要带设备指纹')
    assert.equal(bindCall.headers.Authorization, 'Bearer fixture-device-token')

    const body = JSON.parse(bindCall.body)
    assert.equal(body.client_platform, 'desktop-windows')
    assert.equal(body.client_version, '1.2.1', '版本号不带 v 前缀（官方就是传 1.2.1）')
    assert.equal(body.application, 'desktop')
    assert.equal(body.device_name, 'DESKTOP-TEST')
    assert.equal(body.os, 'windows')
    assert.equal(body.os_version, '10.0.19045')
    assert.equal(body.client_device_id, 'dev-fixture-1')
    assert.equal(body.client_device_id_source, 'unknown', '官方这个字段传的就是 unknown')

    const hb = await heartbeatRaccoonTrustedDevice(product, credential)
    assert.equal(hb, true, '心跳成功应返回 true')

    // ② 失败路径：服务端业务错误码 ⇒ 不抛错，返回 failure
    seen.length = 0
    globalThis.fetch = async () => Response.json({ code: 100002, message: 'params_invalid_error', details: 'param device_session_mismatch invalid' })
    const failed = await bindRaccoonTrustedDevice(product, credential, { hostname: 'x', osRelease: '1' })
    assert.equal(failed.trusted, false)
    assert.equal(failed.deviceId, undefined)
    assert.match(String(failed.failure), /device_session_mismatch|params_invalid_error/, '要把服务端原因透出')

    // ③ 心跳失败也不抛错
    const hbFail = await heartbeatRaccoonTrustedDevice(product, credential)
    assert.equal(hbFail, false)

    // ④ 网络异常同样不抛错
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    let threw = false
    try {
      await bindRaccoonTrustedDevice(product, credential, { hostname: 'x', osRelease: '1' })
    } catch {
      threw = true
    }
    // 网络异常允许抛出（调用方 upgradeToTrustedDesktopSession 会兜住），但绝不能静默成功
    assert.equal(threw, true, '网络异常必须抛出，由调用方决定是否忽略 —— 不能伪装成成功')

    console.log('ok  raccoon device: 绑定请求形状对齐官方、版本号无 v、失败不伪装成功')
  } finally {
    globalThis.fetch = saved
  }
}
