# 本项目工作约定（agent 必读）

`C:\Users\86189\Desktop\MyOurFreeModel` 是 `Ebony-Vinyl/dsh-our-free-model` 的本地 fork，用来加自己的功能。
`origin` = `luochen0604/My-dsh-our-free-model`（我的分支），`upstream` = 上游（只读，push 已 `DISABLED`）。

## 硬性规则：所有改动必须经 GitHub 提交到我的分支

1. 任何代码改动都必须在分支上提交，并 `git push` 到 `origin`。不允许只改工作区、不提交、不推送就结束。
2. 从 `my/feature` 开功能分支（`my/<功能>`），**绝不在 `main` 上提交**；`main` 只跟随上游。
3. 绝不推 `upstream`；绝不改 `upstream` 的 push URL。
4. 收尾时工作区必须干净（`git status --short` 无输出），并报告：分支名、commit sha、push 结果。
5. 一个 commit 只做一件事；提交信息写清楚"改了什么、为什么"。

## 关键命令

- 类型检查：`npm run typecheck`
- 装配冒烟：`node scripts/catalog-test.mjs`
- 改了 `src/token-saver/` 或 `src/o2a/` 之后**必须**跑 `node scripts/build-legacy-payload.mjs`，
  否则 `legacy-payload` 套件会红（它逐字节比对源码与 `src/token-saver.js`、`src/o2a.js`、`src/core.js`）
- 全量：`npm run test:contributor`（慢，提交前尽量跑）
- 跟上游：`git fetch upstream --tags && git rebase <tag>`，冲突细节见 `FORK-WORKFLOW.md`

## 仓库陷阱（踩过的）

- pnpm 只把 `package.json` 的 `files` 字段打进安装副本（当前 81 个文件）。**新增源码文件必须加进 `files`**，
  否则运行时看不到它。
- 宿主用硬链接装载 `file:` 依赖。git / 编辑器多为"写新文件再替换"，会断开硬链接 →
  `node_modules` 里仍是旧 inode 的旧代码。改完要重启应用，必要时在插件管理器里重装。
- `file:` 安装下插件自动判为 `distribution: managed`，应用内"一键升级 / 热重载"停用。不要启用——
  它会覆盖 fork 的字节。
- 不要安装 npm 上裸名的 `dsh-our-free-model`（README 明确说那是第三方改过的包）。
- 发布清单预算 80 文件 / 4 MiB：`node scripts/build-manifest.mjs --check` 自查。
- Node 要求 `^22.19.0 || >=24.0.0`；22.13 只是 `EBADENGINE` 警告，能跑开发套件。

## 相关文档

- `FORK-WORKFLOW.md`：rebase 日常流程、回退办法
- `SETUP-OTHER-PC.md`：换到另一台电脑时的完整配置步骤
