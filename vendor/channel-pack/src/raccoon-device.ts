/**
 * 商汤小浣熊「可信设备」绑定与心跳 —— 官方客户端启动时必做的两步。
 *
 * ## 为什么需要它（2026-11-15 实证）
 *
 * 逆向会话记录接口 `/api/web/auth/v1/sessions` 后发现，账号的会话有两种形态：
 *
 * | 字段 | 形态 A（我们的授权码登录产出的） | 形态 B（官方客户端登录产出的） |
 * |---|---|---|
 * | `client_platform` | `web` | **`desktop-windows`** |
 * | `trusted_device` | `false` | **`true`** |
 * | `device_id` | 无 | 有（绑定了设备） |
 *
 * 实测 7990525 同时存在两种形态，而 7991226（插件授权码登录）只有形态 A。
 *
 * ## 关键发现：`devices_current_bind` 会把会话**原地升级**成形态 B
 *
 * 对 7991226 调用一次 `POST /api/web/auth/v1/devices_current_bind` 之后，
 * 它那条 `platform=web / trusted=false / device=-` 的会话立即变成
 * `platform=desktop-windows / trusted=true / device=dev6601518…`，
 * 且 `session_id` 与 `login_at` 都不变 —— 是完全同一条会话被升级，不是新建。
 *
 * 这说明「信任设备」不是登录的副产物，而是一个**独立的、可显式调用的动作**。
 * 官方的 `desktopTrustedDeviceManager` 正是在登录后立刻 bind + heartbeat。
 *
 * ## ⚠️ 它**不是**充分条件
 *
 * 已实测：把 7991226 升级为形态 B 之后再调 `points/grant`、再补 3 次 heartbeat，
 * 仍然 `granted:false`、当天账单没有任何 `daily_grant`。所以：
 *
 * - 发放的触发点在**服务端的登录处理**里，不是「会话现在是否可信」这一状态位；
 * - 但形态 B 是官方客户端的必然结果，补齐它至少让我们的会话与官方同构，
 *   避免因「会话不可信」被排除在发放范围外（这是目前唯一能确定的结构性差异）。
 *
 * 因此本模块的定位是：**把会话补齐到与官方一致**，而不是「调了就发分」。
 * 是否发分仍以账单为唯一判据（见 `claimRaccoonDailyPoints`）。
 */

import {
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonHeaders,
  type RaccoonCredential,
} from './raccoon.js'
import type { RaccoonProduct } from './raccoon-product.js'

/** 官方客户端在 Windows 上声明的平台标识。 */
export const RACCOON_DESKTOP_PLATFORM = 'desktop-windows'

/** 绑定请求里 `client_device_id_source` 的取值（官方传的就是这个字面量）。 */
const DEVICE_ID_SOURCE = 'unknown'

/** 绑定/心跳结果；失败不抛错，交给调用方决定是否继续。 */
export interface RaccoonDeviceBindResult {
  /** 服务端分配/确认的设备 id。 */
  deviceId: string | undefined
  /** 这次绑定是否把当前会话升级为可信桌面会话。 */
  trusted: boolean
  /** 绑定失败原因（未失败为 undefined）。 */
  failure?: string
}

/** 组装与官方 `buildDesktopDeviceMetadata` 一致的设备元数据。 */
function deviceMetadata(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  hostname: string,
  osRelease: string,
): Record<string, unknown> {
  return {
    client_device_id_source: DEVICE_ID_SOURCE,
    client_device_id: credential.device_id ?? '',
    client_platform: RACCOON_DESKTOP_PLATFORM,
    // 版本号与 `product.clientVersion` 同源：官方这里传的是不带 `v` 的 `1.2.1`。
    client_version: product.clientVersion.replace(/^v/, ''),
    device_name: hostname.slice(0, 120),
    os: 'windows',
    os_version: osRelease,
    application: 'desktop',
    push_permission: 'unknown',
  }
}

/** 发一次设备接口请求（POST 空对象或指定 body）。 */
async function postDevice(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  path: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | undefined; message: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RACCOON_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetcher(`${product.apiBase}${product.authApiPrefix}${path}`, {
      method: 'POST',
      headers: raccoonHeaders(credential, {
        platform: RACCOON_DESKTOP_PLATFORM,
        version: product.clientVersion,
        desktopClient: true,
      }),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const payload: unknown = await response.json().catch(() => undefined)
    const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {}
    const code = typeof record.code === 'number' ? record.code : (response.ok ? 0 : response.status)
    const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : undefined
    const message = typeof record.message === 'string' ? record.message : ''
    return { ok: code === 0 && response.ok, status: response.status, data, message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把当前会话绑定为可信桌面设备（等价于官方客户端的 `bindCurrentDevice`）。
 *
 * 副作用：服务端会把**当前这条会话**原地升级为
 * `client_platform=desktop-windows` + `trusted_device=true` + 绑定 `device_id`。
 * `session_id` 与 `login_at` 不变。
 *
 * @param hostname 设备名（官方取 `os.hostname()`，过长会截断到 120 字符）。
 * @param osRelease 系统版本（官方取 `os.release()`）。
 */
export async function bindRaccoonTrustedDevice(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  options: { hostname: string; osRelease: string },
  fetcher: typeof fetch = fetch,
): Promise<RaccoonDeviceBindResult> {
  const result = await postDevice(
    product,
    credential,
    '/devices_current_bind',
    deviceMetadata(product, credential, options.hostname, options.osRelease),
    fetcher,
  )
  if (!result.ok) {
    return { deviceId: undefined, trusted: false, failure: result.message.length > 0 ? result.message : `HTTP ${String(result.status)}` }
  }
  const deviceId = typeof result.data?.device_id === 'string' ? result.data.device_id : undefined
  const trusted = result.data?.trusted_device === true
  return { deviceId, trusted }
}

/** 设备在线心跳（官方客户端定时调用，维持 `online`/`last_seen_at`）。 */
export async function heartbeatRaccoonTrustedDevice(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const result = await postDevice(product, credential, '/devices_current_heartbeat', {}, fetcher)
  return result.ok
}
