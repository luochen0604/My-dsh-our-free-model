# 本项目工作约定（agent 必读）

`E:\workbuddy\MyOurFreeModel`（本机 ASUS）与 `C:\Users\86189\Desktop\MyOurFreeModel`（另一台电脑）都是 `Ebony-Vinyl/dsh-our-free-model` 的本地 fork，用来加自己的功能。
`origin` = `luochen0604/My-dsh-our-free-model`（我的分支），`upstream` = 上游（只读，push 已 `DISABLED`）。

## 硬性规则：所有改动必须经 GitHub 提交到我的分支

1. 任何代码改动都必须在分支上提交，并 `git push` 到 `origin`。不允许只改工作区、不提交、不推送就结束。
2. **默认在当前分支上直接继续提交，不要新开分支。** 当前工作分支是 `my/integrate-checkin`（已合并签到流水 + lobsterai 修复），它是唯一主线。**绝不在 `main` 上提交**；`main` 只跟随上游。
   只有在用户**明确要求**时才新开分支，且必须从**当前最新分支**分出，不要从 `my/feature` 分。
   （踩过的坑：2026-11-13 两条功能分支都从旧的 `my/feature` 14:41 那个点分出去，结果 `my/checkin-wake-log` 和 `my/lobsterai-login-fingerprint` 互相看不见对方的功能，用户以为"提交没叠加"。）
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

## 本机（ASUS / E:\workbuddy）专属规则

本机仓库路径 `E:\workbuddy\MyOurFreeModel`；另一台电脑在 `C:\Users\86189\Desktop\MyOurFreeModel`。
本机 DSH 宿主进程名是 `DeepSeek Harness`（`D:\Programs\DeepSeek Harness\DeepSeek Harness.exe`），主进程 = 启动时间最早的那个实例（有多个子进程，不要把子进程当主进程）。

**规则一：本机所有 OFM 改动必须 commit 并 push 到 `origin`（GitHub）。**
不允许只改工作区就收尾；改动必须进 GitHub，才能在两台电脑间同步。

**规则二：每次改动后必须运行 `node scripts/check-ofm-process-freshness.mjs`**，与正在运行的 DSH 进程比对代码新鲜度。脚本做三方比对：仓库工作区指纹、profile 安装副本指纹（宿主实际加载的是 `C:\Users\ASUS\.dsh\profiles\desktop\node_modules\dsh-our-free-model`，不是仓库目录——硬链接易被"写新文件再替换"断开）、运行中主进程 StartTime。三种状态 `fresh` / `stale` / `unknown`，退出码 0 / 1 / 2；`--json` 输出机器可读结果；`--record` 只在明确 fresh 或用户确认重启后使用（把当前指纹记为已加载）。

**规则三：结果为 `stale` 时，agent 必须主动、明确提醒用户「需要重启 DSH 才能生效」**（必要时在插件管理器里重装），不能默默结束。

**本机推送凭证（已可用）**：ed25519 key 在 `C:\Users\ASUS\.ssh\id_ed25519`（指纹 `SHA256:HbNRBaLgQ1UPy3hVv8/xMDE6pPvSL8YxtRkGvL4H68c`），公钥已加入 GitHub，`ssh -T git@github.com` 返回 `Hi luochen0604!`。
`origin` 的 **fetch 走 HTTPS + 代理 `http://127.0.0.1:7897`**，**push 走 SSH**（`git@github.com:luochen0604/My-dsh-our-free-model.git`）。直接 `git push origin <branch>` 即可。

**规则四：代码更新后，宿主不会自动刷新 `file:` 依赖，必须手动重装。**
pnpm 对 `file:` 依赖走缓存，光跑 `dsh plugin --profile desktop install` **不会**把新代码装进去（踩过：合并后 install 退出码 0，但 profile 副本还是旧 `pack.js`）。可靠做法：

```powershell
Remove-Item "C:\Users\ASUS\.dsh\profiles\desktop\node_modules\dsh-our-free-model" -Recurse -Force
& "D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop install --force
```

装完**必须**逐字节验证 profile 副本与仓库一致（不能只看退出码 0），然后跑规则二的新鲜度检测。只改 `AGENTS.md` / `scripts/` 这类不进 `files` 的文件时，无需重装，重启 DSH 即可。
