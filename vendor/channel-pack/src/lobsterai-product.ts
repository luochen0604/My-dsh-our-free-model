/**
 * LobsterAI（有道龙虾）产品配置。
 *
 * 因此这里定义**平行**的 `LobsteraiProduct`：共用的是架构**模式**
 * （产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * - API 基址 / 版本号接口：`lobsterai2api/sigin.py:10-11`（实测可用）；
 * - 端点路径与请求头：`lobsterai2api/internal/upstream/client.go`；
 * - 兜底模型表：`lobsterai2api/internal/server/handler.go:94-114`
 *   （注释标明「2026-08-06 从 `GET /api/models/available` 实测拉取」）；
 * - portal 基址 / 登录入口 / 客户端能力 / UA 形态：**桌面端 2026.11.6 的
 *   `dist-electron/main.js` 反编译实证**（详见仓库文档
 *   `登录参数对比与第三方反代判定原因.md`）。
 *
 * ⚠️ 与 Go 参考实现（`lobsterai2api`）刻意不同的三处都是**桌面端实证**压过
 * 「Go 能跑通」：keyfrom 语义、UA、登录入口参数形态。Go 那套会稳定触发
 * 服务端的「第三方反代」归因（见 `lobsterai.ts` 的 keyfrom 说明）。
 */

/**
 * 兜底模型目录中的一个条目。
 */
export interface LobsteraiFallbackModel {
  /** 模型 ID（传给 `POST /api/proxy/v1/chat/completions` 的 `model`）。 */
  id: string
  /** 展示名。 */
  name: string
  /**
   * 上下文窗口（**桥接层的估计值，非远端权威值**）。
   *
   * `handler.go:94-114` 里 19 个模型全部标 `131072`，那是对齐
   * `deepseek-v4` 系的取值后**统一填的**，并非逐个实测。
   * 实测远端多数模型返回 `1000000`，故该估计值偏保守。
   */
  contextWindow: number
}

/**
 * 上游 API 基址。
 *
 * `sigin.py:10` 硬编码 `https://lobsterai-server.youdao.com`；Go 侧被
 * 脱敏成 env `LB2A_UPSTREAM_BASE`（无编译期默认值）。
 * 本插件按文档 §0.2b 的结论固化在常量里 —— 插件面向终端用户，
 * 不应要求用户自行提供域名。
 */
export const LOBSTERAI_API_BASE = 'https://lobsterai-server.youdao.com'

/**
 * 登录 portal 基址。
 *
 * 实测（见文档 §0.2b）：与 `LOBSTERAI_API_BASE` **同一 IP、同一 CNAME 目标**
 * （`pub-g1-gz.alb.ntes53.netease.com`），说明是同一套服务的不同路径；
 * 访问 `{portalBase}/portal` 返回 HTTP 200，页面标题
 * 「LobsterAI - 全场景个人助理 Agent」，与 `cmd/login/main.go:226` 拼出的
 * `{portal}/portal#/login?...` 路径吻合。
 *
 * 之所以仍与 `apiBase` 分成两个字段：Go 侧本就是两个独立 env，
 * 且不排除未来门户与 API 分离部署。
 */
export const LOBSTERAI_PORTAL_BASE = 'https://lobsterai.youdao.com'

/**
 * portal 登录页地址（登录入口的**兜底**值）。
 *
 * 桌面端 `getPortalLoginUrl()` 就是 `PORTAL_BASE_PROD + "/login"`，实测解析结果
 * 为 `https://lobsterai.youdao.com/portal#/login`（`endpoints-CEzH9OMP.js:43/49`，
 * 运行日志 `main-2026-11-13.log:531-537`）。正常路径由 overmind 的
 * `prod/login-url` 下发（见 {@link LOBSTERAI_LOGIN_URL_API}），这里只在取不到时用。
 */
export const LOBSTERAI_PORTAL_LOGIN_URL = `${LOBSTERAI_PORTAL_BASE}/portal#/login`

/**
 * 客户端版本号查询端点（第三方域名）。
 *
 * 注意该响应**不是**统一信封：`code`/`msg` 在**外层**，载荷在 `data.value`。
 * 实测返回日期式版本号（2026-11-13 为 `2026.11.6`，与桌面端安装包一致）。
 *
 * ⚠️ 桌面端请求它时会**带上完整的身份 query**（`uuid` / `version` /
 * `firstKeyfrom` / `latestKeyfrom`，见 `main.js:184766-184777` 的
 * `appendKeyfromQuery`；运行日志 `main-2026-11-13.log:277` 实证）。插件也曾
 * 裸 GET，少了一路归因 —— 现由 `LobsteraiClientVersionResolver` 补齐。
 */
export const LOBSTERAI_CLIENT_VERSION_API
  = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update'

/**
 * 登录入口地址查询端点（overmind 下发的运行时配置）。
 *
 * 桌面端**不硬编码登录页**：`AuthService.fetchLoginUrl()` 先 GET 这个端点
 * （`endpoints-CEzH9OMP.js:41`、`useDesktopCompanionState-dtwKvfpU.js:8946-8974`），
 * 取 `data.value` 再 `openExternal`；运行日志 `main-2026-11-13.log:531-537`
 * 实证它当前返回的就是 `https://lobsterai.youdao.com/portal#/login`。
 *
 * 硬编码该值在「官方改道」的那天会立刻把插件留在旧入口，故同样改为运行时取。
 */
export const LOBSTERAI_LOGIN_URL_API
  = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/login-url'

/**
 * 无法动态取到版本号时的兜底值。
 *
 * `sigin.py:73-76` 在取不到版本号时**整个脚本放弃签到**；本插件比它宽容：
 * 用这个兜底值继续尝试，并在日志里警告。理由是宁可用一个稍旧的版本号试，
 * 也别让用户完全无法签到 —— 后端对 `version` 并不强校验
 * （反证：Go 侧一直发假值 `0.1.0` 也未导致失败）。
 *
 * 取值 = 本机安装包真实版本（`app.getVersion()`，`LobsterAI.exe` ProductVersion
 * `2026.11.6.0`）。桌面端发的永远是**安装包自己的版本**，而不再是插件当年
 * 实测遇到的 `2026.9.4` —— 发一个官方从未发布过的旧版本号本身就是「不是它自称的
 * 那个客户端」的信号。回退发生时 `LobsteraiAuth.resolveClientVersion` 会打日志。
 */
export const LOBSTERAI_FALLBACK_CLIENT_VERSION = '2026.11.6'

/**
 * 客户端能力声明（`X-LobsterAI-Client-Capabilities` 头）。
 *
 * 桌面端在 chat / models 路径上发**四个** token（`main.js:4753-4763`、
 * `163250-163253`）：
 *
 * | token | 作用 |
 * |---|---|
 * | `virtual-models-v1` | 虚拟模型集合 |
 * | `kimi-k3-agentic-v1` | **模型列表的准入条件**：不带时 `/api/models/available` 只回 25 个且没有 `kimi-k3`，带上才 26 个 |
 * | `thinking-level-control-v1` | **思考档位协议的前提**：`reasoning_effort:"off"` 在不带该能力时服务端直接 HTTP 500 |
 * | `upstream-error-details-v1` | 上游错误明细 |
 *
 * 顺序照抄桌面端。声明偏少会让服务端把请求归到「较旧的或非官方构建」，并
 * 顺带解释「kimi-k3 等模型集合被过滤」。
 *
 * ⚠️ 这两个头**只属于 chat / models**（见 `main.js:4753-4763`）：auth 端点
 * （exchange / refresh / logout）**不发**，桌面端在那些路径上没有任何
 * `X-LobsterAI-Client-*`。
 */
export const LOBSTERAI_CLIENT_CAPABILITIES
  = 'virtual-models-v1,kimi-k3-agentic-v1,thinking-level-control-v1,upstream-error-details-v1'

/**
 * User-Agent（桌面形态的 Electron 默认 UA）。
 *
 * ## 为什么不再是 `LobsterAI/0.1.0`
 *
 * 那个值原样照抄 `lobsterai2api/internal/upstream/client.go:21` 的
 * `clientUA = "LobsterAI/0.1.0"`，而它在桌面端 12 MB 的 `main.js` 里**命中 0 次**
 * —— 是第三方 Go 项目自己的标识。
 *
 * 桌面端对龙虾服务端的请求**一处都不设置 UA**：只有 GitHub Copilot、网易云信、
 * Skill 下载器、飞书 SDK、内置浏览器、undici/axios 这些无关子系统有 UA 代码
 * （`main.js` 全量 21 处命中，逐条排除见调查文档 §2.4）。所以线上真实发出去的
 * 就是 **Electron 网络栈生成的默认 UA**，形态含 `Chrome/…` 与 `Electron/…`
 * 且**不含应用名**（桌面端从未调用 `app.setUserAgentFallback`）。
 *
 * Node 侧 `fetch` 的默认 UA 是 `undici`，同样不是官方形态 —— 必须显式设置。
 * 因此这里直接构造一个 Electron 默认形态的串：
 *
 * - Chrome / Electron 版本取**运行进程真实的** `process.versions`（插件跑在
 *   Electron 宿主里时就是真实网络栈版本；纯 Node 环境才用下面的兜底常量）；
 * - 平台段取真实 `process.platform`（桌面端在哪个系统上发就带哪个系统的形态）；
 * - **不带** `LobsterAI/<version>` 应用段：桌面端没有设置过 fallback UA，
 *   加了反而造出一个官方不存在的前缀。
 */
export function lobsteraiUserAgent(): string {
  const chrome = process.versions.chrome ?? FALLBACK_CHROME_VERSION
  const electron = process.versions.electron ?? FALLBACK_ELECTRON_VERSION
  return `Mozilla/5.0 (${platformUserAgentToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Electron/${electron} Safari/537.36`
}

/** UA 的平台段（与 Electron/Chromium 在对应系统上的默认形态一致）。 */
function platformUserAgentToken(): string {
  if (process.platform === 'win32') return 'Windows NT 10.0; Win64; x64'
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7'
  return 'X11; Linux x86_64'
}

/**
 * 非 Electron 环境下的 Chrome/Electron 版本兜底。
 *
 * 只是让 UA **保持 Electron 形态**（含 `Chrome/…`、`Electron/…`），不参与任何
 * 认证判断；跑在 Electron 宿主里时永远不会用到（以 `process.versions` 为准）。
 */
const FALLBACK_CHROME_VERSION = '128.0.6613.186'
const FALLBACK_ELECTRON_VERSION = '32.2.0'

/** 进程级常量：UA 在一次运行内恒定（真实客户端的 UA 也不会逐请求变）。 */
export const LOBSTERAI_USER_AGENT = lobsteraiUserAgent()

/**
 * LobsterAI 产品配置。
 */
export interface LobsteraiProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'lobsterai'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 登录门户基址（不含 `/portal` 路径）。 */
  portalBase: string
  /** 登录页地址的兜底值（overmind 下发失败时用）。 */
  portalLoginUrl: string
  /** 上游 API 基址（不含路径）。 */
  apiBase: string
  /** 客户端版本号查询端点。 */
  clientVersionApi: string
  /** 登录入口地址查询端点（overmind 运行时配置）。 */
  loginUrlApi: string
  /** 版本号动态拉取失败时的兜底值。 */
  fallbackClientVersion: string
  /** `User-Agent` 头取值（桌面形态，见 {@link LOBSTERAI_USER_AGENT}）。 */
  userAgent: string
  /** `X-LobsterAI-Client-Capabilities` 头取值。 */
  clientCapabilities: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * 单张请求图片的像素预算（issue !IKITT9）。
   */
  imagePixelBudget?: number
  /** 单张请求图片的编码字节目标（未配置用 1 MiB，见 `src/image-budget.ts`）。 */
  imageMaxBytes?: number
  /** 远端模型列表不可用时的兜底模型目录。 */
  fallbackModels: readonly LobsteraiFallbackModel[]
}

/**
 * 兜底模型目录（19 个）。
 *
 * 来源：`lobsterai2api/internal/server/handler.go:94-114` 的 `staticModels`，
 * 注释标明「2026-08-06 从 `GET /api/models/available` 实测拉取」。
 *
 * 顺序**照抄原表**，不重排 —— 它是实测时的返回顺序，重排会让「与上游对比」
 * 这类排查工作失去可比性。
 *
 * `contextWindow` 全部为 131072：这是桥接层统一填的值（见
 * {@link LobsteraiFallbackModel.contextWindow} 的说明），**不是**逐个实测结果。
 */
const LOBSTERAI_FALLBACK_MODELS: readonly LobsteraiFallbackModel[] = [
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 131_072 },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 131_072 },
  { id: 'MiniMax-M3', name: 'MiniMax-M3', contextWindow: 131_072 },
  { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', contextWindow: 131_072 },
  { id: 'qwen3.7-max', name: 'qwen3.7-max', contextWindow: 131_072 },
  { id: 'qwen3.7-plus', name: 'qwen3.7-plus', contextWindow: 131_072 },
  { id: 'qwen3.6-plus', name: 'qwen3.6-plus', contextWindow: 131_072 },
  { id: 'qwen3.5-plus-2026-04-20', name: 'qwen3.5-plus-2026-04-20', contextWindow: 131_072 },
  { id: 'kimi-k2.7-code', name: 'kimi-k2.7-code', contextWindow: 131_072 },
  { id: 'kimi-k2.7-code-highspeed', name: 'kimi-k2.7-code-highspeed', contextWindow: 131_072 },
  { id: 'kimi-k2.6', name: 'kimi-k2.6', contextWindow: 131_072 },
  { id: 'kimi-k2.5', name: 'kimi-k2.5', contextWindow: 131_072 },
  { id: 'doubao-seed-2-1-pro-260628', name: 'doubao-seed-2-1-pro-260628', contextWindow: 131_072 },
  { id: 'doubao-seed-2-1-turbo-260628', name: 'doubao-seed-2-1-turbo-260628', contextWindow: 131_072 },
  { id: 'doubao-seed-2-0-code-preview-260215', name: 'doubao-seed-2-0-code-preview-260215', contextWindow: 131_072 },
  { id: 'glm-5.2', name: 'glm-5.2', contextWindow: 131_072 },
  { id: 'glm-5.1', name: 'glm-5.1', contextWindow: 131_072 },
  { id: 'glm-5v-turbo', name: 'glm-5v-turbo', contextWindow: 131_072 },
  { id: 'glm-5', name: 'glm-5', contextWindow: 131_072 },
]

/**
 * LobsterAI provider 配置。
 */
export const LOBSTERAI: LobsteraiProduct = {
  id: 'lobsterai',
  displayName: 'LobsterAI (有道)',
  portalBase: LOBSTERAI_PORTAL_BASE,
  portalLoginUrl: LOBSTERAI_PORTAL_LOGIN_URL,
  apiBase: LOBSTERAI_API_BASE,
  clientVersionApi: LOBSTERAI_CLIENT_VERSION_API,
  loginUrlApi: LOBSTERAI_LOGIN_URL_API,
  fallbackClientVersion: LOBSTERAI_FALLBACK_CLIENT_VERSION,
  userAgent: LOBSTERAI_USER_AGENT,
  clientCapabilities: LOBSTERAI_CLIENT_CAPABILITIES,
  defaultCredentialRef: 'LOBSTERAI_ACCESS_TOKEN',
  fallbackModels: LOBSTERAI_FALLBACK_MODELS,
}

/** 全部 LobsterAI 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_LOBSTERAI_PRODUCTS: readonly LobsteraiProduct[] = [LOBSTERAI]

/**
 * 按 provider id 取 LobsterAI 产品配置；未知 id 返回 undefined。
 */
export function lobsteraiProductById(id: string): LobsteraiProduct | undefined {
  return ALL_LOBSTERAI_PRODUCTS.find((product) => product.id === id)
}
