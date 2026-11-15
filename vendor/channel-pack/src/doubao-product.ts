/**
 * 豆包工作（DoubaoWork）产品配置。
 *
 * ## 数据来源（全部为静态取证，见 `docs/research/doubaowork/README.md`）
 *
 * - 端点前缀：`app\local_webcontents\extensions\ai-views\static\js\async\async-infra-message-samantha.js`
 *   的 `/samantha/chat/completion`（byte 49235）；`entry-main/main.js` 的 295 条 `/samantha/` 路径。
 * - 公共参数：`ai-views` 的 `di()` 函数（`device_platform` / `samantha_web` / `aid` / `web_id` …）。
 * - 积分端点：`/alice/ug/campaign/*`、`/commerce/benefit_supply/credit/*`。
 * - 版本：`app\manifest.json` 的 `2.36.7`。
 *
 * ## ⚠️ 本文件里每一个"魔法值"都必须能回溯到证据
 *
 * 与 Raccoon/Loomy 不同，豆包的公共参数（`aid` / `pkg_type` / `doubao_pc_version`）是
 * **构建期常量**，取证只能拿到变量名（`sl` / `sc` / `sg`），拿不到运行期字面量。
 * 因此下面把它们做成**可覆盖配置**，并明确标注哪些是"已知形态"、哪些是"待实测"。
 * 任何硬编码猜测都写进 `unverified` 字段，便于日后一次性校正。
 */

/** 豆包 web 网关基址（观察：`ai-views` 里 `"https://".concat("www.doubao.com")`）。 */
export const DOUBAO_API_BASE = 'https://www.doubao.com'

/** 对话端点前缀（观察：295 条 `/samantha/` 路径的共同前缀）。 */
export const SAMANTHA_PREFIX = '/samantha'
/** 字节 alice 端点前缀（观察：`entry-moa` 的 104 条 `/alice/` 路径）。 */
export const ALICE_PREFIX = '/alice'

/** 对话端点（观察：`async-infra-message-samantha.js` byte 49235）。 */
/**
 * 对话端点。
 *
 * ## ⚠️ 2026-11-15 CDP 抓包校正（关键）
 *
 * **不是** `/samantha/chat/completion` —— 那是旧接口，实测现在只会回
 * `710022004 rate limited`（看起来像限流，实际是打错的端点）。
 *
 * 桌面端 v2.36.7 真正用的是 **`/chat/completion`**（无 `/samantha` 前缀），
 * 且**不需要 `a_bogus` / `msToken` 签名**（实测：去掉这两个参数仍返回
 * 200 SSE 并给出完整回答）。
 */
export const SAMANTHA_CHAT_PATH = '/chat/completion'
/** 分片续传端点（观察：同文件的 `reply_id` / `seq_st` / `binary_type` body）。 */
export const SAMANTHA_CHUNK_PATH = '/chat/async/chunk_stream'

/** 签到（观察：`DailyCheckIn` 调用点，body `{scene, biz_params, AgwCommonParam}`）。 */
export const ALICE_CHECKIN_PATH = '/alice/ug/campaign/landing/checkin'
/** 签到态（推断：`/alice/ug/campaign/landing/get`，与 checkin 同族）。 */
export const ALICE_CAMPAIGN_LANDING_PATH = '/alice/ug/campaign/landing/get'
/** 任务奖励领取（观察：`ClaimCampaignReward`，body 含 `campaign_item_code` 等）。 */
export const ALICE_CLAIM_PATH = '/alice/ug/campaign/item/reward/claim/'
/** 积分用量历史（**实测 200**：`/commerce/...`，无 `/alice` 前缀）。 */
export const ALICE_CREDIT_USAGE_PATH = '/commerce/benefit_supply/credit/get_credit_usage_history'

/**
 * 订阅 / 额度总览（**实测 `code: 0`**，带真实登录态）。
 *
 * body 需要 `{ product_line: "membership" }`（缺省等价 membership）。
 * 返回 `incentive_quota_entitlements[]`（活动赠送额度，含 `total_used_percent`）
 * 与 `current_subscription.display`（如「免费体验」）。
 *
 * ⚠️ 只有百分比，没有绝对额度值 —— 详见 `fetchDoubaoCreditBalance` 注释。
 */
export const SUBSCRIPTION_OVERVIEW_PATH = '/alice/commerce/sale/subscription/overview/'

/**
 * 额度汇总（**实测 `code: 0`**）。
 *
 * 与 overview 同为百分比口径（`window_limits[].used_percent`）。
 * 保留给需要「按 feature_group 分组」的展示，当前余额只用 overview。
 */
export const SUBSCRIPTION_QUOTA_SUMMARY_PATH = '/alice/commerce/sale/subscription/quota/summary/'

/**
 * 产品线。
 *
 * ⚠️ 实测：`membership`（或空串）返回会员额度数据；`office` / `workspace`
 * 之类返回空结构。豆包工作的额度挂在**同一个字节账号的会员体系**下。
 */
export const DOUBAO_PRODUCT_LINE = 'membership'
/** 积分提示/可用任务（**实测 200**：`/commerce/...` 无 `/alice` 前缀）。 */
export const ALICE_CREDIT_TIP_PATH = '/commerce/benefit_supply/credit/get_credit_tip'

/** 会话列表（观察：`/samantha/conversation/list`）。 */
export const SAMANTHA_CONVERSATION_LIST_PATH = '/samantha/conversation/list'

/**
 * bot（= 模型）目录。
 *
 * ⚠️ **实测 200，但无鉴权时只返回 `710012001 登录已过期`** ——
 * 说明路由存在、形状未知。故 `fetchDoubaoModels` 用候选键防御式解析。
 */
export const BOT_LIST_PATH = '/alice/bot/get_bot_list_v2'
/** bot 目录（旧版，作为备用）。 */
export const BOT_LIST_LEGACY_PATH = '/alice/bot/get_bot_list'

/**
 * 模型选择器配置端点（**2026-11-15 CDP 抓包确认**）。
 *
 * 返回 `data.entry_list[].active_switch_conf.menu_conf_v2.model_list.item_list[]`，
 * 每项 `{ item_id, model_item_key, name }` —— 就是客户端「模型」下拉里的那一列。
 *
 * ⚠️ 这是**唯一**能拿到完整模型列表的地方：`bot/get_bot`、`slot/input/list`、
 * `get_bot_list_v2` 都没有；点开下拉也不发新请求（冷启动就加载了）。
 */
export const ACTION_BAR_BRIEF_PATH = '/alice/slot/action_bar_v3/brief_list'
/** 线程创建（观察：`/samantha/thread/create_or_get`）。 */
export const SAMANTHA_THREAD_PATH = '/samantha/thread/create_or_get'

/**
 * 桌面端来源标记。
 *
 * ⚠️ **这是本 provider 最关键、也最未验证的一个字段。**
 *
 * 观察：`completion_option.message_from = mH.DesktopAskAssistant`。
 * 观察：同处 `device_platform: "web"`、`doubao_device_platform: "web"`。
 *
 * 为什么重要：Raccoon 的每日积分**只发给桌面端来源会话**（见 `raccoon-credits.ts`
 * 模块头与 `client.js` 的 `CHANNEL_CREDITS.raccoon.desktop`），纯网页 token 永远
 * `granted:false`。豆包若同构，则必须让请求带上桌面端标记。
 *
 * 未知：服务端把这个字段当"来源枚举"还是"能力开关"。**已实测：必须是数字
 * 枚举**，传字符串会让 `/samantha/chat/completion` 直接 400（proto 解码层拒绝）。
 * 数值定义见 `doubao.ts` 的 `DOUBAO_MESSAGE_FROM_DESKTOP`。
 */

/** 一个兜底模型条目。 */
export interface DoubaoFallbackModel {
  /** 模型 ID（传给 `chat/completion` 的 bot/model 标识）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限。 */
  maxTokens: number
  /** 是否支持图片输入。 */
  supportsImage: boolean
}

/**
 * 兜底模型表。
 *
 * ⚠️ **这是"占位"，不是取证结果。** 豆包的模型目录走
 * `GET /samantha/...`（未定位到确切的模型列表端点），本次静态取证**没有**
 * 拿到真实的 bot/model 清单。
 *
 * 因此策略与其它 provider 一致：**优先远端目录，失败才回退本表**；
 * 而本表只放"已知存在"的豆包模型家族名，绝不编造型号。
 */
/**
 * 兜底模型表。
 *
 * ## 来源：2026-11-15 CDP 抓包取到的真实目录
 *
 * 这是客户端「模型」下拉里的那一列（`action_bar_v3/brief_list` 的
 * `menu_conf_v2.model_list.item_list`）。真实值，**不是编造**。
 *
 * `fallback` 的含义：正常路径下适配器会**动态**从 `fetchRemoteModels()` 拉最新
 * 列表；这份表只在拉取失败时兜底（未登录/网络异常/形状变化），
 * 保证模型选择器不会因为一次抖动而整个消失。
 *
 * | id | 显示名 |
 * |---|---|
 * | `9` | 自动 |
 * | `seed-lite-7b` | 豆包 2.1 Lite |
 * | `5` | 豆包 2.1 Pro |
 * | `person-deepseek-v4-1-flash-261017` | DeepSeek V4.1 Flash |
 * | `person-kimi-k3-1-pro-261111` | Kimi K3.1 Pro |
 * | `person-kimi-k3-1-pro-highspeed-261111` | Kimi K3.1 Pro 高速 |
 * | `person-kimi-k3-261111` | Kimi K3 |
 * | `person-glm-5-3-261111` | GLM 5.3 |
 * | `person-glm-5-3-flash-261111` | GLM 5.3 Flash |
 * | `person-deepseek-v4-pro-ga-260813` | DeepSeek V4 Pro |
 */
const DOUBAO_FALLBACK_MODELS: readonly DoubaoFallbackModel[] = [
  { id: '9', name: '自动', contextWindow: 256_000, maxTokens: 32_000, supportsImage: true },
  { id: 'seed-lite-7b', name: '豆包 2.1 Lite', contextWindow: 256_000, maxTokens: 32_000, supportsImage: true },
  { id: '5', name: '豆包 2.1 Pro', contextWindow: 256_000, maxTokens: 32_000, supportsImage: true },
  { id: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', contextWindow: 256_000, maxTokens: 32_000, supportsImage: false },
  { id: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', contextWindow: 256_000, maxTokens: 32_000, supportsImage: false },
  { id: 'person-kimi-k3-1-pro-highspeed-261111', name: 'Kimi K3.1 Pro 高速', contextWindow: 256_000, maxTokens: 32_000, supportsImage: false },
  { id: 'person-kimi-k3-261111', name: 'Kimi K3', contextWindow: 256_000, maxTokens: 32_000, supportsImage: false },
  { id: 'person-glm-5-3-261111', name: 'GLM 5.3', contextWindow: 256_000, maxTokens: 32_000, supportsImage: false },
  { id: 'person-glm-5-3-flash-261111', name: 'GLM 5.3 Flash', contextWindow: 256_000, maxTokens: 32_000, supportsImage: false },
  { id: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', contextWindow: 256_000, maxTokens: 32_000, supportsImage: false },
]

/** 豆包工作产品配置。 */
export interface DoubaoProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'doubao'
  /** 设置项 / 模型选择器展示名。 */
  displayName: string
  /** API 基址。 */
  apiBase: string
  /** 对话前缀。 */
  chatPrefix: string
  /** 积分（alice）前缀。 */
  pointsPrefix: string
  /** User-Agent。 */
  userAgent: string
  /** 客户端版本（`doubao_pc_version` 的来源）。 */
  clientVersion: string
  /** 默认凭据 ref。 */
  defaultCredentialRef: string
  /** 兜底模型表。 */
  fallbackModels: readonly DoubaoFallbackModel[]
  /**
   * 应用 ID（`aid` / `real_aid`）。
   *
   * ✅ **2026-11-15 运行时抓包取证**：真实请求里是 `aid=1044603`。
   *（此前占位值 `497858` 是错的。）
   */
  aid: string
  /** `version_code`（真实请求里是 `20800`）。 */
  versionCode: string
  /** `runtime_version`（真实请求里是 `3.45.1`）。 */
  runtimeVersion: string
  /** `chromium_version`（真实请求里是宿主 Chromium 版本）。 */
  chromiumVersion: string
  /**
   * 对话使用的 bot 标识。
   *
   * ✅ **2026-11-15 运行时抓包取证**：真实请求里是 `7338286299411103781`
   *（此前占位空串，必然导致失败）。
   */
  botId: string
}

/** 豆包工作 provider 配置。 */
export const DOUBAO: DoubaoProduct = {
  id: 'doubao',
  // 用「豆包工作」而非「豆包」：前者才是这个 target 的名字（`productName: DoubaoWork`），
  // 后者是消费端 App，两者账号体系相通但客户端不同。
  displayName: '豆包工作',
  apiBase: DOUBAO_API_BASE,
  chatPrefix: SAMANTHA_PREFIX,
  pointsPrefix: ALICE_PREFIX,
  // ⚠️ UA 仍未取到字面量（`mH` 常量在混淆代码里拼装）。UA 是伪装的次要维度。
  userAgent: 'DoubaoWork/2.36.7 (Windows)',
  clientVersion: '2.36.7',
  defaultCredentialRef: 'DOUBAO_ACCESS_TOKEN',
  fallbackModels: DOUBAO_FALLBACK_MODELS,
  // 以下全部来自 2026-11-15 的 CDP 抓包（见 doubao.ts 的 doubaoCommonParams 注释）。
  aid: '1044603',
  versionCode: '20800',
  runtimeVersion: '3.45.1',
  chromiumVersion: '147.0.7727.149',
  botId: '7338286299411103781',
}

/** 全部豆包产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_DOUBAO_PRODUCTS: readonly DoubaoProduct[] = [DOUBAO]

/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export function doubaoProductById(id: string): DoubaoProduct | undefined {
  return ALL_DOUBAO_PRODUCTS.find((product) => product.id === id)
}
