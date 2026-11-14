# 豆包工作（DoubaoWork）逆向研究：能否作为一个新网关接入 OFM

> **研究日期**：2026-11-14
> **目标**：`D:\Program Files\DoubaoWork\DoubaoWork.exe`（v2.36.7）
> **目的**：判断它是否具备成为 OFM「渠道/provider」并暴露为 OpenAI 兼容网关的条件；若可行，进一步给出登录、凭证刷新、积分余额显示、积分领取的落点。
> **范围**：只做静态研究与可行性判断，**不改 OFM 代码**。
> **方法**：静态字符串/路径取证（ripgrep on JS bundles + PE）、protobuf 描述符解析、进程与端口枚举、PE 资源。
> **证据分级**：`观察` = 直接从产物读到；`推断` = 由观察组合得出、未直接验证；`未知` = 未取得证据。

---

## 0. 结论先行

### 0.1 一句话

**技术上"能接"，但不是"接一个新 provider"那么轻——它卡在三道硬门槛上，其中两道在豆包侧、一道在 OFM 侧。**

### 0.2 三个必须先纠正的前提

| # | 前提 | 事实 | 依据 |
|---|---|---|---|
| 1 | 用户说的「RAC router」 | **仓库里不存在 `RAC` 这个词**（全仓 `\bRAC\b` 零命中）。真实对象是 **`EAC router`** —— OFM 渠道目录页的标题 | `packages/standalone/web/channels-CgtV-0FB.js`、`client.js`（`'nav.tab.channels': 'EAC router'`） |
| 2 | 「RAC」最可能指什么 | **`Raccoon`（商汤小浣熊）**。`Raccoon` 是当前 10 个渠道之一，`Raccoon` 与 `RAC` 同前缀；用户很可能把 Raccoon 简称成 RAC | `client.js:4812` 的 `CHANNEL_PROVIDERS` 含 `{ name: 'Raccoon', org: '商汤' }` |
| 3 | 两种解读是否影响结论 | **不影响**。两种解读的落地动作是同一件事：**在 `vendor/channel-pack/src/` 里新增一个 provider** | 见 §4 |

> ⚠️ **本文按两种解读都成立的方式组织**：既说明「EAC router = 渠道承载页」，也说明「Raccoon = 已存在的同族 provider 范例」。

### 0.3 可行性裁决

| 维度 | 结论 | 置信度 |
|---|---|---|
| 模型调用链路是否可离线复刻 | **大概率可以**（HTTP + JSON + cookie，非 gRPC） | 中高 |
| 是否被字节风控签名卡死 | **有可能，但尚未证明是硬门槛**（`X-Bogus`/`msToken` 存在，但未观察到施加在 chat 调用上） | 中 |
| 账号体系能否接入 | **可以**（字节 passport，OFM 已有 TRAE 同族先例） | 高 |
| 积分余额 / 领取能否接入 | **可以，且已有几乎同构的模板**（TRAE 的 checkin_credits + ent_usage） | 高 |
| 是否值得做 | **有条件值得**：需先花 1 次抓包验证 §7 的 P1/P2 两条 | — |

---

## 1. 目标身份与产物布局

### 1.1 版本与身份（观察）

`app\manifest.json`：

```json
{ "version": "2.36.7", "channel": "1001", "productName": "DoubaoWork",
  "commitId": "2eff6f4db77e2a77bee2dbd7d44565ed90d19f78",
  "updateChannel": "release", "whatsNewVersion": "1.57.0" }
```

引擎基线：`app\147.0.7727.149.manifest`（Chromium/Electron 37 线）。

### 1.2 关键事实：**没有 `app.asar`**

这是本次逆向最重要的一条观察。全目录 `*.asar` 搜索**零命中**。代码分三处：

```
app\
├─ DoubaoWork.dll            330.0 MB  主进程主体（MZ, PE）
├─ agent_infra.dll            10.7 MB  本地 Agent 工具执行器
├─ mcp_helper.dll             16.3 MB  MCP 客户端
├─ aha_net.dll                 2.0 MB  网络层
├─ pb.desc                     1.7 MB  protobuf 消息库（254 files / 6010 messages / 407 enums，**0 services**）
├─ pb_server.desc              2.3 MB  protobuf 服务库（249 files / **15 services / 40 methods** / 7770 messages）
├─ local_webcontents\                    ← 前端代码在这里，不是 asar
│   ├─ apps\entry-main\main.js        677 KB
│   ├─ apps\entry-moa\main.js        2.86 MB
│   ├─ apps\doubao-office\main.js    1.30 MB
│   ├─ apps\doubao-office\doubao_office.pak  118 MB（自定义 pack，未解）
│   ├─ biz\biz.pak                   193 MB（自定义 pack，未解）
│   └─ extensions\
│       ├─ ai-views\              ← **真正的 AI 聊天引擎（MV3 扩展）**
│       └─ rpa-component-extension\background.js  350 KB
└─ sbox\, sdks\, task-mode-resource\
```

> **`.pak` 说明**：`biz.pak` / `doubao_office.pak` 头部为 `05 00 00 00 00 00 00 00` + 长度字段，**不是**标准 MZ/PK/SQLite，是本家自定义容器。本次**未解开**（见 §8 未解项）。但 AI 主链路不依赖它们。

### 1.3 进程形态（观察，`Get-CimInstance` + `Win32_Process`）

主进程 PID 44980，由它派生 19 个子进程。**注意 `--utility-sub-type` 清单**——这是判断架构的关键：

| utility-sub-type | 含义 |
|---|---|
| `agent_infra.mojom.AgentInfraProcess` | **本地 Agent 工具执行器** |
| `jsrt.mojom.Service` | JS 运行时服务 |
| `backend.mojom.Service` | 后端服务 |
| `bdmssdk.mojom.BdmssdkService` | **风控签名 SDK（bdms = X-Bogus/msToken 的宿主）** |
| `saman.push.mojom.PushServerService` | 推送 |
| `privilege.mojom.PrivilegedAssistantBroker` | 特权助手 |
| `network.mojom.NetworkService` | Chromium 网络栈 |
| `storage.mojom.StorageService` | 存储 |

另有多路 `--type=renderer`，其中两路带 `--extension-process`。

**关键读数**：`bdmssdk` 是**独立 utility 进程**，说明签名运算被刻意隔离出主进程。

### 1.4 本地端口（观察）

`Get-NetTCPConnection -State Listen`，主进程 PID 44980 及其子进程监听：

```
127.0.0.1:49853   127.0.0.1:61132   127.0.0.1:62286   127.0.0.1:64710
```

探测 `/json/version`：两个返回 404、两个直接断连 → **不是 CDP 调试端口**，是内部 IPC/HTTP 端点（未识别协议）。
**没有任何 `--remote-debugging-port` 参数**（`CommandLine` 全量匹配零命中）→ 无法用 CDP 直接挂上去做运行时观测。

---

## 2. 模型调用链路（核心）

### 2.1 端点（观察）

真正的对话端点在 **`extensions\ai-views\static\js\async\async-infra-message-samantha.js`**（62,296 字节，SHA-256 `F70DE02A…D0F270E`）：

```
POST https://www.doubao.com/samantha/chat/completion
  headers: content-type: application/json
           Agw-Js-Conv: str
           <common headers>
  credentials: same-origin
```

后续分片走：

```
POST /chat/async/chunk_stream
  body: { seq_st: <chunkSeq+1>, reply_id, binary_type }
```

> `Agw-Js-Conv: str` 是字节 AGW 网关的"JS 约定"头，表示 `query` 会被序列化为字符串。这是同族字节客户端的通用特征。

### 2.2 请求体形状（观察）

```js
body = {
  ...sentEvent,
  completion_option: {
    ...sentEvent.completion_option,
    event_id: <eventId>,
    is_regen: (ext.regen === '1'),
    with_suggest: (ext.answer_with_suggest === '1'),
    need_create_conversation: !!local_conversation_id,
    is_replace: (replace === '1'),
    is_delete: (delete === '1'),
    memory_type: ToolMemory,
    launch_stage: <stage>,
    origin: location.origin,
    is_old_user: <bool>,
    message_from: DesktopAskAssistant,      // 桌面端来源标记
    thread_source: JSON.stringify({ source_type: WebLink, web_link: {...} }),
  },
  reply_id,
  conversation_id,
  bot_id,
  section_id,
  local_message_id,
  use_deep_think,
}
```

**要点**：`bot_id` + `conversation_id` + `completion_option.message_from=DesktopAskAssistant` 三者构成本次请求的"身份指纹"。`message_from` 是客户端来源枚举，**服务端可能据此判定是否桌面端会话** —— 这与 Raccoon 案例里"每日积分只发给桌面端来源会话"的坑高度同形（见 OFM `raccoon-credits.ts` 模块头）。

### 2.3 强制公共参数（观察，函数 `di()`）

这是**最有价值的一段**——它决定了复刻请求时的必填项：

```js
di = () => ({
  language, browser_language: navigator.language,
  device_platform: "web",
  doubao_device_platform: "web",
  aid: sl,            // 应用 ID
  real_aid: sc,
  pkg_type: sg,
  device_id: dn(),    // 设备 ID（持久化）
  tea_uuid: de(),
  web_id: teaWebId ?? tea_uuid ?? webId ?? "0",
  is_new_user: "0",
  region, sys_region,
  "use-olympus-account": 1,
  samantha_web: "1",
  ...u7(),            // 平台相关
  doubao_pc_version: <pc 版本>,
  ...u6(),
})
```

> `samantha_web: "1"` + `use-olympus-account: 1` + `device_platform: "web"` 是**平台声明**。注意这里是 `"web"` 而非 `desktop-windows` —— 与 Raccoon 那套 `X-Client-Platform: desktop-windows` 是不同设计。**这意味着豆包的桌面端在服务端眼里可能仍被标记为 web 来源**。

### 2.4 响应格式：自定义 SSE（观察）

```js
onOpen: (e) => {
  const ct = e.headers.get('content-type')
  if (!ct?.startsWith(<EXPECTED_PREFIX>)) throw Error(JSON.stringify(await e.json()))
  if (!e.ok || !e.body) throw Error(...)
}
```

`content-type` 前缀不匹配即当错误抛。这是**非标准** SSE（不是 `text/event-stream`），需独立解析器。OFM 里 TRAE 也是自定义 SSE（`parseTraeSSELine` / `traeStreamToOpenAI`），**已有同类适配范式可抄**。

### 2.5 端点全量测绘

`entry-main/main.js` 与 `doubao-office/main.js` 共 **295 条 `/samantha/` 路径**；`entry-moa/main.js` 另有大量 `/alice/` 路径。按子域归类（节选，完整清单见附录 A）：

| 子域 | 条数量级 | 代表端点 |
|---|---|---|
| `/samantha/chat/*` | 少数 | `completion` |
| `/samantha/thread/*` | 12 | `create_or_get`、`get`、`list`、`share/*` |
| `/samantha/conversation/list` | 1 | 会话列表 |
| `/samantha/code/*` | 24 | `run`、`run/v2`、`compile`、`file_content/get`、`directory/get` |
| `/samantha/deep_research/terminal` | 2 | 深度研究 |
| `/samantha/supertask/*` | 9 | `apply`、`terminate`、`ppt_export`、`reactivate` |
| `/samantha/plugin/stream_call_bot` | 3 | 流式 bot 调用 |
| `/samantha/skill/*` | 12 | 技能包 |
| `/samantha/fission/*` | 8 | **裂变拉新（积分来源之一）** |
| `/samantha/guidance/*` | 3 | `get_task`、`draw`、`get_reward_preview` |
| `/samantha/audio/*` | 10 | `asr`、`tts`、`sign` |
| `/samantha/pdf/*`、`/image/*`、`/pages/*` | 20+ | 文档与图像 |
| `/alice/bot/*` | 30+ | bot 管理（`get_bot`、`get_bot_list_v2`、`get_bot_create_quota`） |
| `/alice/ug/*` | 13 | **签到/活动奖励（见 §5）** |
| `/alice/commerce/*` | 60+ | **订阅/额度/权益** |

---

## 3. 鉴权与风控（决定可行性的一节）

### 3.1 鉴权载体（观察）

`ai-views` 扩展里命中的 cookie / 参数名：

| 载体 | 命中 | 说明 |
|---|---|---|
| `sessionid` | ✅ | 字节 passport 主会话 cookie |
| `passport_csrf_token` | ✅ | CSRF |
| `s_v_web_id` | ✅ | 设备指纹 cookie |
| `ttwid` | ✅ | 字节设备 ID |
| `device_id` | ✅ | 显式 query 参数 |
| `web_id` / `tea_uuid` | ✅ | 埋点身份 |
| `sessionId`（camelCase） | ✅ | TS 侧字段 |
| `a_bogus` | ❌ **0 命中** | 新版权签未出现 |
| `X-Bogus` | ✅ | 老版签，见 §3.2 |
| `msToken` | ✅ | 见 §3.2 |

调用方式是 `credentials: 'same-origin'` → **纯 cookie 鉴权，不额外塞 token 头**。

### 3.2 签名体系（观察 + 推断）

存在 `extensions\ai-views\static\js\async\bdms-sdk.js`（**163,518 字节**），内含：

- `X-Bogus` 生成器：函数 `tw(e)` →
  ```js
  function tw(e){
    let r=null, n="X-MS-STUB", o="X-MS-PAYLOAD";
    return function(e,r,n){ return {"X-Bogus": tx(tm.kWebsocket, !1, 0, null, n)} }(
      0, 0, r = e[n] ? e[n] : e[o] ? tS(e[o]) : "00000000000000000000000000000000"
    )
  }
  tm.kHttp = 0; tm.kWebsocket = 1;
  ```
- `msToken`：`$ = { bogusIndex:0, msNewTokenList:[], ..., msToken:"", msStatus:_.init, ttwid:"", tt_webid:"", tt_webid_v2:"" }`
- `byted_acrawler` / `_SdkGlueInit` / `bdms.init({aid, isSDK:true, boe})`
- 注册的**待签路径白名单**：
  ```js
  n = [].concat(Object.values($), Object.values(G), Object.values(j), ["/passport/"])
  t._SdkGlueInit({ bdms: { paths: n, boe: isBoe } })
  ```

**→ 推断（中置信度）**：签名白名单**明确包含 `/passport/`**（登录相关），但**没有证据显示包含 `/samantha/`**。`bdms-sdk.js` 被 `side_panel.js` 及若干 async chunk 引用，而 chat 调用发生在 `async-infra-message-samantha.js` 里、其 `_getCommonHttpHeaders` 由外部注入，**我未观察到该注入点会附加 X-Bogus**。

**→ 这是全份报告最关键的一个"未知"**：`/samantha/chat/completion` 是否需要 `X-Bogus`/`msToken`。见 §7 P1。

### 3.3 风控相关原生件（观察）

| 文件 | 大小 | 角色（推断） |
|---|---|---|
| `bdmssdk.mojom.BdmssdkService`（进程） | — | 签名运算宿主，独立进程 |
| `bdticket.dll` | 1.6 MB | 票据（ticket） |
| `metasecml.dll` | 5.6 MB | 元安全（ML 风控） |
| `deviceregister_shared.dll` | 0.3 MB | **设备注册** |
| `ttdaemon.exe` | 0.3 MB | 守护 |
| `ttwinrt.dll` | 0.08 MB | WinRT 桥 |

> 搜索 `a_bogus|X-Bogus|x-argus|x-secsdk|msToken|libjsv|signSamantha` 于 `aha_net.dll` / `agent_infra.dll` / `mcp_helper.dll` / `deviceregister_shared.dll` / `bdticket.dll` / `metasecml.dll` —— **全部零命中**。说明签名逻辑**不在这几个 DLL 里**，而在主进程 `DoubaoWork.dll`（330 MB，未做全量 strings）或 JS 侧 `bdms-sdk.js`。

---

## 4. OFM 侧：接入面到底是什么

### 4.1 「RAC router」= `EAC router` = 渠道目录页（观察）

```js
// packages/standalone/web/channels-CgtV-0FB.js
'nav.tab.channels': 'EAC router',
h('h1', null, 'EAC router'),
h('p',  null, '连接你的账号，把各家的免费额度汇集到一个 API。')
```

页面能力（观察）：渠道列表 / 搜索 / 筛选（全部·已接入·未连接）/ 每渠道账号数与模型数 / **每日自动签到开关** / 渠道详情。

### 4.2 现有 10 个渠道（观察，`client.js:4812` `CHANNEL_PROVIDERS`）

| id | name | org | note（源码原文） |
|---|---|---|---|
| `lobsterai` | LobsterAI | 有道 | 龙虾 · 每日签到积分 |
| `qoder` | Qoder | 阿里系 | 每日 100 Credits，加密推理端点 |
| `qodercn` | Qoder 中国版 | 阿里系 | 中国版端点与模型池 |
| `trae` | TRAE | **字节** | 手机号登录 |
| `cline` | Cline | Cline | Cline 账号免费额度 |
| `loomy` | Loomy | 讯飞 | 微信扫码，或短信验证码备用 |
| `raccoon` | Raccoon | **商汤** | 手机号登录 · 每日积分 |
| `minimax` | MiniMax Code | MiniMax | 设备码 + PKCE，每日签到 |
| `zcode` | ZCode | 智谱 | 浏览器登录（需本机可开浏览器） |
| `gemini` | Gemini | Google Code Assist | 本地回调 OAuth 免费线 |

> **`trae` 是字节系**，且 OFM 已完整实现（登录/额度/签到）。这是豆包接入**最强的可行性旁证**——同族 passport + 同族 ug/checkin 接口形状。

### 4.2.1 额度能力表（观察，`client.js:4826` `CHANNEL_CREDITS`）

**这是"积分余额显示 / 积分领取"真正的开关表**，新增 provider 必须在这里登记，否则 UI 不显示对应按钮：

```js
const CHANNEL_CREDITS = {
  lobsterai: { claim: true },
  qoder:     { claim: true },
  qodercn:   { claim: true },
  trae:      { claim: true },
  cline:     { unit: 'dollars' },
  loomy:     { claim: true },
  raccoon:   { claim: true, status: true, desktop: true },
  minimax:   { claim: true, status: true },
  zcode:     { claim: true, unit: 'tokens' },
  gemini:    { unit: 'quota', quota: true },
}
```

字段语义（源码注释与用法推论）：

| 字段 | 含义 |
|---|---|
| `claim` | 显示「领取」按钮 |
| `status` | 显示独立签到状态（今日是否已签） |
| `desktop` | **显示「桌面端授权」按钮** —— 该端点只认桌面端来源会话 |
| `unit` | 额度单位：`dollars` / `tokens` / `quota` |
| `quota` | 走配额口径 |

> **★ 直接命中 §7 P2**：`raccoon: { ..., desktop: true }` 的注释原文写着——
> 「`desktop: true` ⇒ 账号行给出『桌面端授权』按钮：该端点只认桌面端来源的会话，
> 而本渠道账号来自微信扫码（网页会话），不先升级会话就领不到。」
>
> **→ 如果豆包的每日积分也绑桌面端会话（P2 为真），OFM 已有现成机制：加 `desktop: true` + 实现 `account.desktopLogin` / `account.desktopLoginPoll` 两个 RPC。** 这条把 P2 从"可能推翻整个计划"降级为"多接一个已有模式的登录链路"。

### 4.3 新增一个 provider 的落地清单（观察，以 `raccoon` 为模板）

`vendor/channel-pack/src/raccoon*.ts` 共 **9 个文件 / 3,535 行**：

| 文件 | 行数量级 | 职责 |
|---|---|---|
| `raccoon.ts` | ~15 KB | 协议常量 + 纯函数（header 组装、JWT 解析、手机号加密） |
| `raccoon-product.ts` | ~16 KB | product 配置：`apiBase`、各 prefix、UA、clientVersion、fallback 模型表、effort 档位 |
| `raccoon-oauth.ts` | ~14 KB | 纯 API 层：二维码轮询 / 短信登录 / 换 token |
| `raccoon-auth.ts` | ~34 KB | 凭据服务（持久化、刷新、过期判定） |
| `raccoon-adapter.ts` | ~25 KB | **LLM 适配器**：请求转换 + SSE 解析 → OpenAI 格式 |
| `raccoon-credits.ts` | ~24 KB | 余额查询 / 每日签到 / 领取 |
| `raccoon-login-page.ts` | ~22 KB | 本地 `127.0.0.1` 承载登录页 |
| `raccoon-desktop-login.ts` | ~14 KB | 桌面端授权码登录 |
| `raccoon-qr.ts` | ~19 KB | 二维码 |

**接线点（必须改的文件）**：

1. `vendor/channel-pack/src/index.ts` —— `registerXLlm(ctx, ...)` + `new XAuth(...)`（10 个 provider 各一处，`index.ts:344/414/489/552/606/700/840/908/1001/1165/1505`）
2. `vendor/channel-pack/src/channel-pack-rpc.ts:818` `registerChannelPackRpc(...)` —— **位置传参**，新 provider **必须追加在 `gemini` 之后、`modelAdapters` 之前**（源码注释明确写了"历史上已因少传/插队错位复发 6 次"）
3. `client.js:4812` `CHANNEL_PROVIDERS` —— UI 目录行（`{id, name, org, accent, note, login}`）
4. `client.js:4826` `CHANNEL_CREDITS` —— **额度能力开关表**（`claim` / `status` / `desktop` / `unit` / `quota`）。**不登记就没有积分按钮**
5. `catalog/dsh-plugin.json` / `catalog/provenance.json` —— 装配与来源清单

> ⚠️ **`package.json` 的 `files` 字段**：仓库约定"新增源码文件必须加进 `files`，否则运行时看不到"。
> 但 `vendor/channel-pack/` 只打 `pack.js`（`"vendor/channel-pack/pack.js"`），
> 说明 channel-pack 是**构建产物**——新 provider 的 TS 源码要先经 `npm run channel-pack`
> 打包进 `pack.js`，才需要（也才应该）提交。这条会改变实施顺序，需在动工前确认。

### 4.4 额度契约（观察，`credits.ts`）

```ts
// credits.ts:4
export interface CheckinStatus {
  active: boolean            // 活动是否进行中
  todayCheckedIn: boolean    // 今日是否已签到 —— 领取判定的权威依据
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  totalCredits: number
  checkinDates: string[]
  activityName: string
}

// credits.ts:171
export interface CreditBalance {
  total: number              // 当前可用总余额（各有效包剩余之和）
  packages: CreditPackage[]
  expiredTotal: number       // 已失效包剩余（单独给，不并入 total）
}

// credits.ts:88
export type ClaimOutcome =
  | { kind: 'claimed'; credit: number; streakDays: number; isStreakDay: boolean; ... }
  | { kind: ... }            // 其余分支（already-claimed / not-eligible / failed ...）
```

**RPC 方法（观察，`channel-pack-rpc.ts`）**：

```
'credits.balances'   / 'credits.status'    / 'credits.claimAll'
'credits.permanentLock'
'account.list' / 'create' / 'update' / 'delete' / 'reorder'
'account.refresh' / 'retest' / 'retestAll' / 'test' / 'reset' / 'resetAll'
'account.desktopLogin' / 'account.desktopLoginPoll'
'provider.status' / 'setEnabled' / 'getOrder' / 'setOrder'
'usage.autoCheckin'
```

**→ 结论**：豆包只要能把「余额 / 今日是否已签 / 领取结果」映射到这三个类型，UI 侧**零改动**即可显示与领取。

### 4.5 网关暴露面（观察，`openai-gateway/server.ts`）

```
/v1/models            /v1/models/
/v1/chat/completions
/v1/responses         /v1/responses/
/v1/reasoning-efforts
```

- 网关**不按 provider 分流**——它直接转发到 `ctx.llm`（`mountOpenAiGateway` 的 `llm: ctx.llm`），provider 分流发生在 `ctx.llm` 里（即各 adapter 的 `registerXLlm`）。
- 模型列表由 `llm.listModels(provider)` 提供（`models.ts:82`）。
- 档位由 `llm.resolveModelInfo(provider, model)` 提供（`models.ts:50`）。

**→ 结论**：**豆包成为"一个新网关"不需要动 `openai-gateway`**。只要 `registerDoubao...Llm` 正确实现 `listModels` + `stream`，网关自动可用。这是 OFM 架构的关键红利。

---

## 5. 积分 / 余额 / 领取（豆包侧落点）

### 5.1 端点清单（观察，`ai-views` 扩展）

**余额与用量**（前缀 `/commerce/benefit_supply/`）：

```
POST /commerce/benefit_supply/credit/get_credit_usage_history
POST /commerce/benefit_supply/credit/get_credit_tip
POST /commerce/benefit_supply/credit/get_credit_num_optional_tasks
POST /commerce/benefit_supply/credit/user_activity
POST /commerce/benefit_supply/ping
```

**每日签到**（观察，调用点已定位）：

```js
DailyCheckIn(e, t) {
  const r = this.genBaseURL("/alice/ug/campaign/landing/checkin"),
        i = { scene: n.scene, biz_params: n.biz_params, AgwCommonParam: n.AgwCommonParam }
  return this.request({ url: r, method: "POST", data: i }, t)
}
```

**任务奖励领取**（观察，调用点已定位）：

```js
ClaimCampaignReward(e, t) {
  const n = this.genBaseURL("/alice/ug/campaign/item/reward/claim/"),
        r = { task_id: e.task_id,
              campaign_group_code: e.campaign_group_code,
              campaign_item_code: e.campaign_item_code,
              AgwCommonParam: e.AgwCommonParam }
  return this.request({ url: n, method: "POST", data: r }, t)
}
```

**活动与额度**：

```
/alice/ug/campaign/landing/get           /alice/ug/campaign/list/
/alice/ug/campaign/v3/detail/            /alice/ug/campaign/quota/records/
/alice/ug/campaign/school/season/detail/ /alice/ug/campaign/student/verify_info/
/alice/ug/campaign/verify/               /alice/ug/event/report
/alice/auth/grant                        ← "grant"，语义待定
```

**订阅权益**：

```
/alice/commerce/sale/subscription/quota/summary/
/alice/commerce/sale/subscription/benefit_package/
/alice/commerce/sale/subscription/activity_reward_quota/
/alice/commerce/intake/entitlement/query
/alice/commerce/sale/entitlement/usage_detail/
/alice/commerce/sale/campaign/fixed_subscription/claim/
```

### 5.2 与 TRAE 的同构性（观察 + 推断）

| 能力 | TRAE（OFM 已实现） | 豆包工作（本次观察） |
|---|---|---|
| 签到状态 | `POST /trae/api/v2/ug/checkin_credits/status` | `POST /alice/ug/campaign/landing/get`（推断，campaign landing） |
| 签到领取 | `POST /trae/api/v2/ug/checkin_credits/claim` | `POST /alice/ug/campaign/landing/checkin` |
| 积分余额 | `POST /trae/api/v2/pay/ide_user_ent_usage` | `POST /commerce/benefit_supply/credit/get_credit_usage_history`（推断） |
| 路径族 | `/ug/`、`/pay/` | `/ug/`、`/commerce/` |
| 鉴权 | Cloud-IDE-JWT | passport cookie |

**→ 强推断**：两者是同一套字节"UG 增长中台"的两副前端。路径语义（`/ug/campaign/`、`checkin`、`claim`、`quota`）几乎一一对应。**TRAE provider 的三函数实现（status / claim / balance）可以直接当结构模板改。**

### 5.3 与 Raccoon 的关键差异（重要风险）

Raccoon 踩过的坑（`raccoon-credits.ts` 模块头记录）：**每日积分只发给「桌面端来源会话」**，纯网页/扫码 token 永远 `granted:false`。

豆包是否会同样"按会话来源发放"？**未知**。但观察到一个相关信号：

```js
completion_option.message_from = mH.DesktopAskAssistant   // 桌面端来源标记
device_platform: "web"                                     // 却声明 web
```

**→ 推断（低置信度）**：豆包可能同时接受 `message_from=DesktopAskAssistant` 作为桌面端标记，而 `device_platform` 只是平台枚举。若积分发放也绑定这类来源标记，则"纯 API 复刻"会拿到 `false`。**这是 §7 P2 要验证的项。**

---

## 6. 架构定位：豆包属于哪一类

把豆包放进已有对比框架（Trae / 灵犀 / Raccoon）里：

| 维度 | Trae | WPS 灵犀 | Raccoon | **豆包工作** |
|---|---|---|---|---|
| Agent 循环位置 | **本地**（Rust DLL） | 云端（WSS） | 云端 | **云端**（`/samantha/chat/completion`） |
| 本地是否跑工具 | 是（toolhost） | 是（lingxi-sandbox Go） | 否 | **是**（`agent_infra` 进程） |
| 工具执行进程 | `toolhost` | `lingxi-sandbox` | — | **`agent_infra.mojom.AgentInfraProcess`** |
| MCP 支持 | 是 | 是（stdio MCP） | — | **是**（`mcp_helper.dll`） |
| 客户端角色 | 完整 Agent OS | 哑终端 + 工具执行器 | 哑终端 | **哑终端 + 工具执行器** |
| 主通道 | Aha IPC | WSS | HTTP | **HTTP + 自定义 SSE** |
| 鉴权 | JWT | Cookie + wps_sid | Bearer JWT | **Cookie（passport）** |
| 签名 | — | — | 弱（已摸清） | **X-Bogus/msToken（待验证是否强依赖）** |

**→ 豆包的架构位置 = 「灵犀 + MCP + 更强的字家风控签名」**。它不像 Trae 那样把大脑放本地，所以复刻的只是**传输层**，不是**推理逻辑**——这对 OFM 反而是好事（Raccoon 同型）。

### 6.1 本地工具执行器证据（观察）

`agent_infra.dll` 字符串命中一组工具名与内部标记：

```
bash / bash_run / bash_run_done / bash_run_failed / bash_task_output / bash_task_stop
bash_count_per_instance / bash_output_limit_bytes
powershell / powershell_command_builder_win / powershell_json /
  powershell_marker_json / powershell_profile_env_collect /
  powershell_result_file_json / powershell_script_missing / powershell_security
glob / GlobAsync / GlobSamanAsync
grep / GrepAsync / GrepSamanAsync
finish / finished / finished_at_ms / FinishHash
browser_no_profile
__agent_infra_init / __agent_infra_cmd / __agent_infra_conpty_ready__ /
  __AGENT_INFRA_CONPTY_READY__ / __agent_infra_allowed_env_names
```

**→ 观察**：豆包有本地 shell 执行能力（bash + powershell + ConPTY）、文件检索（glob/grep）、浏览器控制。工具名风格接近 Claude Code 兼容族（与 Trae 的 `Bash`/`Glob`/`Grep`/`Read`/`Write` 别名同源）。

### 6.2 MCP 客户端证据（观察）

`mcp_helper.dll` 字符串：

```
MCP_INITIALIZE / INITIAL_TOOLS_LIST / MCP_DISCOVER
STREAMABLE_HTTP / LEGACY_HTTP_SSE
TOOLS_LIST_ / TOOLS_LIST
resources/read
MCP_INITIALIZEOAuth / MCP_PROTOCOL / MCP_ROUNDTRIP / MCP_TIMEOUT
mcp_roundtrip_duration_ms / mcp_helper_abi_version / mcp_helper_run
MCP_APPS_UNAVAILABLE / MCP_CAPABILITY_UNAVAILABLE / MCP_CAPABILITY_UAGINATION_FAILED
```

**→ 观察**：完整 MCP 客户端，支持 Streamable HTTP + Legacy SSE + OAuth。**这一点对 OFM 极重要**（见 §7 P3）。

---

## 7. 必须先证明的三件事（可行性闸门）

按「不做就无法判断」排序。

### P1 — `/samantha/chat/completion` 是否需要 `X-Bogus` / `msToken`？（阻塞级）

- **已观察**：`bdms-sdk.js` 存在、含 X-Bogus/msToken 生成器、待签路径白名单含 `/passport/`。
- **未观察**：chat 调用点附加签名。
- **验证方法**（1 次即可）：用已登录 cookie 直接 `POST /samantha/chat/completion`（带 §2.3 全套 `di()` 参数、不带 X-Bogus）。
  - 若返回流式 → **签名不是硬门槛**，可行性大幅提升。
  - 若返回 4xx 且 body 提示签名 → 需从 `bdms-sdk.js` 抠出算法（163 KB 纯 JS，**理论上可移植**，但工作量大）。
- **影响**：这一条决定是「加一个 provider」（≈3,500 行）还是「加一个 provider + 移植风控算法」（工期翻倍且易碎）。

### P2 — 积分发放是否绑定「桌面端来源会话」？（决定积分功能是否成立）

- **参照 Raccoon 的教训**：每日积分只发给桌面端来源会话，纯扫码 token 永远 `false`。
- **豆包侧观察**：`completion_option.message_from = DesktopAskAssistant`，而 `device_platform: "web"`。
- **验证方法**：同一账号，分别用「网页扫码得到的 cookie」与「桌面端真实 cookie」调用 `/alice/ug/campaign/landing/checkin`，比对返回。
- **影响**：若绑桌面端，则**必须**在 OFM 里复刻桌面端登录链路。
- **⭐ 缓解因素（重要）**：OFM **已经解决过同一个问题**。`client.js:4837` 的
  `raccoon: { claim: true, status: true, desktop: true }` 里 `desktop: true` 就是为
  「该端点只认桌面端来源会话」设的开关，配套 RPC 是 `account.desktopLogin` /
  `account.desktopLoginPoll`，实现范例在 `raccoon-desktop-login.ts`（14 KB）。
  **→ P2 即使为真，也只是"照抄一条已有链路"，不是新发明。**

### P3 — 本地 MCP 通道能否作为备选路径？（非阻塞）

- **已观察**：豆包内置完整 MCP 客户端（`mcp_helper.dll`），支持 Streamable HTTP + OAuth。
- **含义**：如果 P1 判定签名不可绕，理论上可考虑用 MCP 承载推理。但这会改变架构方向
  （让豆包调 OFM，而不是 OFM 用豆包），**不符合用户目标**。
- **结论**：仅作记录，不纳入实施路径。

---

## 8. 未解与限制（必须随结论一起读）

1. **`biz.pak`（193 MB）/ `doubao_office.pak`（118 MB）未解**。自定义容器格式（`05 00 00 00 00 00 00 00` + 长度）。可能有更多前端代码/资源在内。本次 AI 主链路不依赖它们，但**不能排除**有额外端点。
2. **`DoubaoWork.dll`（330 MB）未做全量 strings / 未反编译**。本机 Ghidra 12.1.4 可用，但 330 MB PE 导入成本极高。签名算法、设备注册逻辑可能在此。
3. **`/alice/auth/grant` 语义未知**：是登录奖励、还是通用授权授予？未定位调用点。
4. **零运行时观测**：无 CDP 端口、未抓包。全部结论为静态证据，**不证明请求真的能被服务端接受**。
5. **`pb_server.desc` 的 15 个 service 全部是 Lark/IM**（`PacketGreeter` / `ChatGreeter` / `MessageGreeter` / `BotGreeter` / `SearchGreeter` / `ContactGreeter` …）。**→ AI 推理不走 protobuf gRPC，走的是 `www.doubao.com` 的 HTTP JSON**。这条反而是好消息（复刻成本低）。
6. **`local_webcontents` 为 webview 应用包**，`entry-main` / `entry-moa` / `doubao-office` 三者共享大量端点；本次未逐一确认哪一个是"主聊天窗口"。
7. **未验证账号可用性**：不知道本机是否已登录豆包工作，也未读取任何凭据。

---

## 9. 建议的下一步（按性价比排序）

| 优先级 | 动作 | 成本 | 收益 |
|---|---|---|---|
| **P0** | 抓一次 `POST /samantha/chat/completion`（Fiddler / mitmproxy，或从本机已登录状态直接 curl） | 30 min | 定 §7 P1，决定整个项目成不成立 |
| **P0** | 抓一次 `/alice/ug/campaign/landing/checkin` | 5 min | 定 §7 P2，决定积分功能成不成立 |
| P1 | 若 P1 通过：照 `raccoon-*.ts` 9 文件模板起 `doubao-*.ts` 骨架（先只做 `product` + `adapter` + `auth` 三件） | 1–2 天 | 打通最小推理 |
| P2 | 若 P2 通过：照 `trae.ts` 的 checkin 三函数实现积分 | 0.5 天 | 补全 UI 三契约 |
| P3 | 解 `biz.pak` / 对 `DoubaoWork.dll` 做定向 strings（只搜签名/设备注册关键词） | 1 天 | 补未知 |

---

## 附录 A：`/samantha/` 端点全量（295 条，按字母序）

```
aippt/{bind_account,get_auth_token,get_binding_status,get_template_list,login,receive_event,sync_result}
aireader/{document_info/get,resource_content/{create,exists,reference_card},ultra_long_text/check_quota}
aispace/{attachment_latest_used,attachment_search,code_search,delete_node,event_report,
         get_download_info,get_file_url,homepage,latest_used_tab,message_node_info,move_node,
         node_info,node_lastest_used,otter/{get_or_init_onboarding_doc,root_node_info},
         otter_latest_used,pages_search,rename_node,
         share/{create,delete,dump,history,node_info,overview,report_access},
         system_directory,upload_node,upload_pre_check}
artifact/{create_code_conversation,create_or_get_code_block_artifact,create_pages,delete,
          restore,rollback,search,share/{create_or_get,get,get_content,list,report,
          review_content,update_permission}}
audio/{asr,conf,report_record_start_failure,sign,simultaneous_interpretation,tts,
       update_call_context,upload_call_screenshots}
banner/{pack,pack_notice,sidebar}
bing/web_search
bookmark{,/delete,/dir/share/{conversation/get,create,delete,detail,meta,report},
         /heartbeat,/op_list,/update}
code/{check_executable,compile,context_status/get,directory/get,download_artifact,
      file_content/get,get_artifact,get_artifact_meta,get_compile_status,
      get_compiled_artifact/,get_resource_download_url,get_template_config,
      get_template_directory,get_template_file,image_review,interrupt_async_ask,
      pre_handle,run,run/v2,search_images,update,update_requirement,upload,upload_image}
collection/{child_collections,create,delete,fingerprint/get/,get/,list,memo/update,
            onboarding_message,selected_create,share/,share/create,tag/list,
            thread/messages,thread/share,update}
conversation/list
cozeplugin/{academic_search,txt2img}
deep_research/{resource/get,terminal}
desktop/{ai_website/recommend,get_conflict_app_blocklist,get_latest_version,
         get_stable_version,get_utm,homepage,save_utm,search_sug,
         share/{create,get,review}}
desktop_push/event
evaluate/get_ab_params
feed{,/tourist_get}
feedback/tool_message
fission/{approve,check,draw,entrance,home_page,report,reward_info,share_info}
guidance/{draw,draw_result,get_reward_preview,get_task}
image/{banner_query,image_get_background_mask,ocr,translate}
inhouse/{get_application,submit_apply}
media/{get_mind_map,get_play_info,get_summary,get_upload_token,mget_play_status}
meeting/summary{,/audio_download,/migrate_info,/pack,/status}
notice/{get_list,info,mark_read,strong_notice_mark_read,ultra_long_text/mark_read}
olympic/{homepage,subscribe_daily_report,subscribe_status,summary/}
open/get_openid_by_userid
pages/{add_reference,get,get_meta,get_outline_meta,placeholder_image,
       query_reference_content,search_image,search_outline_reference,
       search_reference_by_paragraph,terminal_gen_pages,update,update_meta,
       update_outline,update_outline_meta,upload_image,view}
pdf/{download,ocr,preview,sniff}
plugin/{change_log,change_log_v2,cookie_sync/do,detect_lang,dict/word,
        get_youtube_share,jwt,latest_crx_info,podcast/{should_upload,transcript},
        prompt_skill/{add,delete,list_by_user,list_discover_skills,save_setting,update},
        recommend/webtodesktop,revise,search/card_recommend,stream_article_translate,
        stream_call_bot,stream_plantuml_generate,translate,
        translation/language_list,user_settings/{get,save},
        validate_jwt,web_meta_upload,youtube_share}
preview/{get_info,get_template,mget_meta}
resource/{link/sniff,linkcontent/get}
search/{global_search,highlight,paper_reference,video}
shared_app/{review/url,secret/{create,get}}
skill/{check_page_upgrade_status,create_page_artifact,disable_recommend,
       exec_page_upgrade,get_writing_input_template,guidance,input_guidance,
       latest_reading_list,latest_reading_list_v2,list,pack,recommend,
       simple_guidance,update_order}
supertask/{apply,html_preview,mark_read_moa_switch,moa_switch_pop_up,ppt_export,
           reactivate,recommend,setting,terminate}
thread/{create,create_or_get,delete,get,list,list/weblink,main/create_or_get,
        share/{delete,gen_name,info,report,save,snapshot/get},update}
tool_message/put_chat_record
toolbox/skills
toutiao/stream_call_bot
user/{ab/get,check_cn,lark_user_info/get,news_tag/save,preference/{get,set},
      setting/{get,update},think_need_reset,tips_setting/{get,update},
      web_hit_status/{get,update}}
video/{get_play_info,query_video_gen_info}
word_notes/{delete,export,get,save}
```

## 附录 B：证据坐标

| 证据 | 位置 | 取值 |
|---|---|---|
| 版本 | `app\manifest.json` | `2.36.7` / commit `2eff6f4d…` |
| chat 端点 | `extensions\ai-views\static\js\async\async-infra-message-samantha.js` | `/samantha/chat/completion` @ byte 49235 |
| 该文件摘要 | 同上 | 62,296 B，SHA-256 `F70DE02A1BF6FD6502D21EA530F6DE6BC1D573A94FE48274013453373D0F270E` |
| 公共参数 | `ai-views/static/js/**` | 函数 `di()` |
| X-Bogus | `ai-views/static/js/async/bdms-sdk.js` | 163,518 B；`tw()` / `tx()` |
| 签到调用 | `ai-views` | `DailyCheckIn` → `/alice/ug/campaign/landing/checkin` |
| 领取调用 | `ai-views` | `ClaimCampaignReward` → `/alice/ug/campaign/item/reward/claim/` |
| protobuf 服务 | `app\pb_server.desc` | 15 services / 40 methods（全 Lark/IM） |
| Chromium 基线 | `app\147.0.7727.149.manifest` | 147.0.7727.149 |
| EAC router | `packages/standalone/web/channels-CgtV-0FB.js` | `'nav.tab.channels': 'EAC router'` |
| 渠道清单 | `client.js:4812` | `CHANNEL_PROVIDERS`（10 项） |
| 额度契约 | `vendor/channel-pack/src/credits.ts` | `CheckinStatus:4` / `ClaimOutcome:88` / `CreditBalance:171` |
| RPC 方法 | `vendor/channel-pack/src/channel-pack-rpc.ts` | `credits.*` / `account.*` / `provider.*` |
| 网关路由 | `vendor/channel-pack/src/openai-gateway/server.ts` | `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/reasoning-efforts` |
| provider 注册 | `vendor/channel-pack/src/index.ts:344–1505` | 10 处 `registerXLlm` |
| RPC 位置传参警告 | `vendor/channel-pack/src/channel-pack-rpc.ts:818` | 注释「已因插队错位复发 6 次」 |
