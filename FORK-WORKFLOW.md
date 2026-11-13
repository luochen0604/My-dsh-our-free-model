# 本地 fork 工作流（rebase 接上游）

这份文档只描述**本机这份 fork**怎么用，不是上游的贡献指南。上游贡献见 `docs/RELEASING.md`
与 `.github/workflows/test.yml`。

- 上游：`upstream` → https://github.com/Ebony-Vinyl/dsh-our-free-model.git
- 基准提交：`v2.8.3`（与切换前安装的版本逐字节一致，已核对）
- 功能分支：`my/feature`（从这里开新分支，别在 `main` 上改）

## 0. 远端（已配好）

- `origin` → `git@github.com:luochen0604/My-dsh-our-free-model.git`
  （fork 时改过名，仓库名是 `My-dsh-our-free-model`；分支 `my/feature` 已推送并设好追踪）
- `upstream` → `https://github.com/Ebony-Vinyl/dsh-our-free-model.git`（只读；push URL 已设为
  `DISABLED`，防止误推上游）

本机 `~/.ssh/id_rsa` 已注册到 GitHub 账号，`ssh -T git@github.com` 应回
`Hi luochen0604! You've successfully authenticated`。这个仓库局部固定了
`http.proxy=127.0.0.1:7897`（全局那个 `4780` 已失效），代理变了要同步改。

## 1. 日常改功能

```powershell
git switch -c my/<功能名> my/feature   # 一个功能一个分支
# 改代码，一个 commit 只做一件事
git add -p
git commit -m "feat: ..."
```

改完必须过的检查（本仓库有 100+ 套件，全量很慢，开发时按需跑）：

```powershell
npm run typecheck
node scripts/catalog-test.mjs        # 入口/装配冒烟
npm run test:contributor            # 提交前尽量跑一次全量
```

**改到 `src/token-saver/` 或 `src/o2a/` 时必须重新生成发布 bundle**，否则
`legacy-payload` 套件会红（它会逐字节比对源码与 `src/token-saver.js`、`src/o2a.js`、
`src/core.js`）：

```powershell
node scripts/build-legacy-payload.mjs
```

## 2. 上游发新版后把改动接上去

```powershell
git fetch upstream --tags
git switch my/<功能名>
git rebase v2.9.0          # 或 v3.0.0；不要 git pull，也不要 merge 进功能分支
```

- 冲突：`git status` 看文件 → 改 → `git add` → `git rebase --continue`。
- 已开启 `rerere`，同一冲突第二次会自动套用上次的解法。
- 中断想放弃：`git rebase --abort`。
- 已推送到 origin 的分支 rebase 后要 `git push --force-with-lease`。

rebase 完再跑一次第 1 节的检查。基准变了就更新本文件顶部的"基准提交"。

## 3. 让 DSH 用这份 fork

`~/.dsh/profiles/desktop/package.json` 的依赖项指向本目录：

```json
"dsh-our-free-model": "file:C:/Users/86189/Desktop/MyOurFreeModel"
```

- 改完代码 → **重启应用**。宿主装依赖时会把这里的文件硬链接进 profile 的
  `node_modules`，所以重启是"让新字节生效"的必要动作。
- 如果重启后还是旧行为：在桌面端插件管理器里对 `dsh-our-free-model` 重装一次。
  注意 git checkout / 编辑器保存常用"写新文件再替换"，会断开硬链接，此时
  `node_modules` 里仍是旧 inode 的旧代码。
- 桌面端（Electron）的 profile 由应用独占管理，命令行 `dsh plugin add` 写不进去。

## 4. 不要做

- 不要 `git pull upstream main` 到功能分支（merge 提交会把下次 rebase 搅乱）。
- 不要装 npm 上裸名的 `dsh-our-free-model`（README 明确说那是第三方改过的包）。
- 不要指望插件内的"一键升级"：`file:` 目录被 pnpm 硬链接后，插件会把自己判成
  `distribution: managed`，应用内升级/热重载是停用的——这正是我们要的，否则它会覆盖
  你 fork 的字节。想显式锁定，可在 `~/.dsh/our-free-model/settings.json` 写
  `"distribution": "managed"`（改前先关掉 dsh）。
- 不要动发布清单预算：80 文件 / 4 MiB。加文件时用
  `node scripts/build-manifest.mjs --check` 自查。

## 5. 回退

- 代码回退：`git switch main`（干净上游）或 `git reset --hard v2.8.3`。
- 安装回退：把 profile 的依赖路径改回
  `file:C:/Users/86189/Documents/dsh-plugins/dsh-our-free-model`，重启。
