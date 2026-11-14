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
export const SAMANTHA_CHAT_PATH = '/samantha/chat/completion'
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
/** 积分提示/可用任务（**实测 200**：`/commerce/...` 无 `/alice` 前缀）。 */
export const ALICE_CREDIT_TIP_PATH = '/commerce/benefit_supply/credit/get_credit_tip'

/** 会话列表（观察：`/samantha/conversation/list`）。 */
export const SAMANTHA_CONVERSATION_LIST_PATH = '/samantha/conversation/list'
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
 * 未知：`DesktopAskAssistant` 在服务端是"来源枚举"还是"能力开关"。未实测前
 * 一律照发（与官方客户端同形，不会更差），但**不得据此在 UI 上承诺积分可领**。
 */
export const DOUBAO_MESSAGE_FROM_DESKTOP = 'DesktopAskAssistant'

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
const DOUBAO_FALLBACK_MODELS: readonly DoubaoFallbackModel[] = [
  { id: 'doubao-seed-1.6', name: 'Doubao-Seed-1.6', contextWindow: 256_000, maxTokens: 32_000, supportsImage: true },
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
   * 未验证的构建期常量。
   *
   * ⚠️ 这些值**不是取证结果**，是"按形态填的占位"。首次实测后必须校正，
   * 校正前不得声称 provider 可用。
   */
  unverified: {
    /** `aid`（应用 ID）。 */
    aid: string
    /** `real_aid`。 */
    realAid: string
    /** `pkg_type`。 */
    pkgType: string
    /** 对话使用的 bot 标识。 */
    botId: string
  }
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
  // 观察：`desktop` 端的 UA 由 `mH` 常量拼装，本次未取到字面量。
  // 先按版本号拼一个保守形态；UA 只是伪装的次要维度（Raccoon 实测该端不校验 UA）。
  userAgent: 'DoubaoWork/2.36.7 (Windows)',
  clientVersion: '2.36.7',
  defaultCredentialRef: 'DOUBAO_ACCESS_TOKEN',
  fallbackModels: DOUBAO_FALLBACK_MODELS,
  unverified: {
    // 以下是形态占位：取证只拿到变量名（sl/sc/sg/bot_id），没拿到字面量。
    aid: '497858',
    realAid: '497858',
    pkgType: '1',
    botId: '',
  },
}

/** 全部豆包产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_DOUBAO_PRODUCTS: readonly DoubaoProduct[] = [DOUBAO]

/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export function doubaoProductById(id: string): DoubaoProduct | undefined {
  return ALL_DOUBAO_PRODUCTS.find((product) => product.id === id)
}
