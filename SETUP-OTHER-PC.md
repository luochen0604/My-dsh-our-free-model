# 换一台电脑继续改这个插件：完整配置指南

这份文档把本机（`DESKTOP-5B0QK6E`，2026-11-13）已经验证过的配置步骤写下来，
在另一台 Windows 机器上照着做即可。全部命令是 PowerShell。

## 0. 结构先说清楚

```
DSH 桌面版
  └─ profile(%DSH_HOME%\profiles\desktop\package.json)
       └─ "dsh-our-free-model": "file:C:/.../MyOurFreeModel"   ← 指向本地 fork
            └─ fork 仓库（origin = luochen0604/My-dsh-our-free-model）
                 └─ upstream = Ebony-Vinyl/dsh-our-free-model（只读）
```

改代码 → 本地 fork → commit → push 到 `origin`；上游发版 → `upstream` rebase 进来。
DSH 不会从 npm 或 GitHub 自动拉这个包，它只读你 profile 里写的那条路径。

## 1. 前提

- Windows 10/11；DSH 桌面版已安装并能启动（内置 Node 运行时，跑插件够用）。
- 命令行开发需要自己装 **Node `^22.19.0 || >=24.0.0`** 和 **Git**。
- 有一个已登录 GitHub 的浏览器窗口（要加 SSH key、确认 fork 存在）。

## 2. 克隆 fork 并接好两个远端

```powershell
git clone git@github.com:luochen0604/My-dsh-our-free-model.git "$env:USERPROFILE\Desktop\MyOurFreeModel"
cd "$env:USERPROFILE\Desktop\MyOurFreeModel"

git remote add upstream https://github.com/Ebony-Vinyl/dsh-our-free-model.git
git remote set-url --push upstream DISABLED     # 防误推上游
git config remote.pushDefault origin
git fetch upstream --tags
git switch my/feature                            # 我们已有的提交都在这条分支上
git branch -u origin/my/feature                  # 若 clone 后追踪丢失
```

常用 git 配置（只对本仓库生效，建议照抄）：

```powershell
git config pull.rebase true
git config rebase.autoStash true
git config rerere.enabled true
```

## 3. SSH key

```powershell
ssh-keygen -t ed25519 -C "$env:USERNAME@$env:COMPUTERNAME"
# 一路回车；已有 key 就跳过生成
```

**Windows 专属坑**：从别的机器拷来 / 从备份恢复的私钥，`.ssh` 下常残留陌生 SID 的 ACE，
ssh 会直接报 `Bad owner or permissions` 或 `UNPROTECTED PRIVATE KEY FILE`，修法是：

```powershell
foreach ($f in @("config","known_hosts","id_ed25519","id_rsa")) {
  $p = "$env:USERPROFILE\.ssh\$f"
  if (Test-Path $p) {
    icacls $p /inheritance:r /grant:r "$env:USERNAME:F" /grant:r "NT AUTHORITY\SYSTEM:F"
  }
}
```

把公钥内容（`id_ed25519.pub` 或 `id_rsa.pub`）加到 https://github.com/settings/ssh/new ，
然后验证：

```powershell
ssh -T git@github.com    # 期望：Hi luochen0604! You've successfully authenticated...
```

## 4. 网络（代理 / 镜像）

GitHub 直连不稳时给本仓库单独配代理（Clash Verge 默认 `7897`，按本机实际端口改）：

```powershell
git config --local http.proxy http://127.0.0.1:7897
git ls-remote --heads origin    # 能秒回即通
```

npm 用国内镜像（可选）：

```powershell
npm config set registry https://registry.npmmirror.com
```

别把 `http.proxy` 配成全局的 `git config --global`，否则换机器/换端口会到处连不上
（本机就踩过：全局写着 4780，实际上只有 7897 在监听）。

## 5. 装依赖并自检

```powershell
cd "$env:USERPROFILE\Desktop\MyOurFreeModel"
npm ci
npm run typecheck
node scripts/catalog-test.mjs
node scripts/build-legacy-payload.mjs --check
```

期望：

- `typecheck`：无输出，退出码 0
- `catalog-test`：最后一行 `catalog: the record, the bytes and the seam agree`
- payload 检查：`旧版兼容资源一致：省 Token 单文件，7 个引擎分片，o2a/core 发布 bundle`
- 出现 `EBADENGINE` 只是 Node 版本提示，不影响开发套件

## 6. 让 DSH 用这份代码

编辑 `%DSH_HOME%\profiles\desktop\package.json`（默认 `C:\Users\<你>\.dsh\profiles\desktop\package.json`），
把依赖换成新克隆的路径：

```json
"dsh-our-free-model": "file:C:/Users/<你>/Desktop/MyOurFreeModel",
```

- 改之前先备份：`Copy-Item package.json package.json.bak-<日期>`
- `dsh.profile.bundles` 里已有 `dsh-our-free-model` 就**不要动**（重复注册会报
  `duplicate loader entry id: our-free-model`），也不要往 `cordis.patch.yml` 再加条目
- 桌面端（Electron）的 profile 由应用独占管理，命令行 `dsh plugin add` 写不进去，只能改文件 / 用插件管理器
- 改完重启 DSH。没生效就去插件管理器里对 `dsh-our-free-model` 重装一次
- 验证：重启后模型列表里仍有 OFM 的模型，设置页能打开
- 回退：把路径改回原目录（或删掉这条依赖）后重启

## 7. 日常

写功能、提交、rebase 上游的全部流程见仓库里的 `FORK-WORKFLOW.md`。
硬性规则见 `AGENTS.md`：**所有改动必须在分支上提交并 push 到 `origin`**。

## 8. 故障对照表

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `Bad owner or permissions on .ssh/config` / `UNPROTECTED PRIVATE KEY FILE` | ACL 里有陌生 SID | 第 3 节的 `icacls` 循环 |
| `Permission denied (publickey)` | key 没加到 GitHub，或 ssh 用了别的 key | `ssh -T` 验证；检查 `~/.ssh/config` 是否强制了 IdentityFile |
| `git ls-remote` 卡住 / `Could not connect ... port 443` | 代理端口变了或没起 | `git config --local http.proxy ...` 指向实际端口 |
| `npm warn EBADENGINE` | Node 低于 22.19 | 装 Node 24 LTS；只在跑全量套件时才可能真出问题 |
| `legacy-payload: 生成资源不一致` | 改了 `src/o2a/` 或 `src/token-saver/` 没重建 | `node scripts/build-legacy-payload.mjs` |
| 改了代码行为没变 | 硬链接断开 → `node_modules` 还是旧代码 | 重启 DSH；必要时插件管理器重装 |
| `PROFILE_UPGRADE_REQUIRED` | 宿主 profile 闸门拒绝符号链接/junction | 用插件管理器或本地 tarball 安装，别用 `link:` |
| 装了 npm 裸名 `dsh-our-free-model` | 那是第三方改过的包 | 卸载，改用本 fork 或 `@ebony-vinyl/dsh-our-free-model` |

## 9. 可选：把用户数据带过去

插件数据在 `%DSH_HOME%\our-free-model\`（`settings.json`、账号池、统计、`catalog.json`），
可以整目录拷到新机器；其中可能含账号凭据，**不要提交进任何 git 仓库**。
独立本地服务用的是另一套 `~\.our-free-model`，两者不通用。
