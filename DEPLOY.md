# Paseo 插件同步：部署与使用说明

这份说明发给另一台主机（或那台主机上的 AI 代理）。照着做完，这台机器就会加入插件同步网络。

- 同步插件（公开，无需 token 即可安装）：`https://github.com/repairer7/paseo-plugin-sync`
- 插件清单仓库（私有，需要用户提供的 GitHub token）：`https://github.com/repairer7/paseo-plugin-store`
- 必用反代：`https://gh.imtsui.com`（部分机器无法直连 GitHub）

---

## 0. 它是什么

每台主机上装一个 `plugin-sync` 插件。它做两件事：

1. 把自己这台机器的插件清单（装了什么、什么版本、启停状态、要同步给谁）发布到私有仓库里一个以 **hostname** 命名的文件夹。
2. 读取其他主机的文件夹，把“目标包含本机”的插件安装或更新到本机。

```
GitHub 私有仓库 paseo-plugin-store
├── CUI/                 ← 主机 A（hostname）
│   ├── host.json        ← serverId、平台、Paseo 版本、心跳
│   ├── plugins.json     ← 本机插件清单 + 同步目标 targets
│   └── plugins/<id>/    ← 该主机上目录型插件的内容快照
├── fnOS/                ← 主机 B
└── HomeWindows/         ← 主机 C（自动创建）
```

每台主机**只写自己的文件夹**，不会互相覆盖。A 从 B 拉到插件后，A 下一轮也会把内容发布到自己文件夹（三份副本是预期行为）。

---

## 1. 前置检查（部署代理先做）

```bash
paseo --version          # 需要 >= 0.15.0
git --version
npm --version            # 可选；有运行时依赖的插件需要
```

检查插件总开关（必须为 true）：

```bash
paseo daemon status --json
# 读取 <home>/config.json 里的 pluginsEnabled；<home> 通常是 ~/.paseo
```

- 如果 `pluginsEnabled` 不是 `true`：**先停下来问用户**，不要擅自开启。插件是无需沙箱的受信任代码。得到明确同意后再改 `config.json` 并 `paseo reload --json`。

找到 CLI（如果 `paseo` 不在 PATH）：

- Windows：`%USERPROFILE%\bin\paseo.exe`、`%USERPROFILE%\.local\bin\paseo.exe`、`C:\Program Files\Paseo\resources\bin\paseo.cmd`
- Linux/macOS：`/usr/local/bin/paseo`、`~/.local/bin/paseo`

下文命令里的 `paseo` 都指这个可执行文件。

---

## 2. 安装同步插件（每台只做一次）

```bash
paseo plugin install "git:https://gh.imtsui.com/https://github.com/repairer7/paseo-plugin-sync.git" --json
```

安装成功会返回 JSON，包含 `"status": "running"`。验证：

```bash
paseo plugin ls plugin-sync --json
paseo plugin logs plugin-sync
```

- 必须是 `running`，否则看 `paseo plugin logs plugin-sync` 的报错。
- 这一步不需要 GitHub token，因为插件仓库是公开的。

> 不要尝试从私有仓库安装同步插件，也不要把同步插件本身同步到别的机器（它已从发布清单里排除）。

---

## 3. 配置 token（每台一次）

token 由用户单独提供，**不要写进仓库、不要提交、不要打印到日志**。

方式 A（推荐，桌面有 token.txt）：

1. 把 token 放到这台机器的桌面：`~/Desktop/token.txt`（Windows 是 `%USERPROFILE%\Desktop\token.txt`），一行，无引号。
2. 打开 Paseo → 侧边栏「插件同步」→ 设置 → 点「从桌面 token.txt 导入」。
3. 状态里应显示 `GitHub 身份：repairer7`。

方式 B（界面粘贴）：同一页面，把 token 粘进「GitHub token」输入框 → 保存设置。

方式 C（代理无人值守）：直接把 token 写入文件（权限 600）：

```bash
mkdir -p ~/.paseo/plugin-sync
printf '%s' 'TOKEN_HERE' > ~/.paseo/plugin-sync/token.txt
chmod 600 ~/.paseo/plugin-sync/token.txt
```

配置默认值（不需要改，除非用户要求）：

| 配置 | 默认 |
|---|---|
| 仓库 | `repairer7/paseo-plugin-store` |
| 分支 | `main` |
| 反代 | `https://gh.imtsui.com` |
| 轮询 | 60 秒 |
| 自动应用 | 开 |
| 安装运行时依赖 | 开 |
| 发布 node_modules | 关 |

配置保存在 `<home>/plugin-sync/config.json`，token 保存在 `<home>/plugin-sync/token.txt`。

---

## 4. 首次同步与验证

装好并在界面点一次「立即同步并应用」，或者等 60 秒。然后在 Paseo 里检查：

1. 「插件同步」→ 状态：`GitHub 身份` 有值，`上次同步` 有时间，“本机插件 → 同步目标”列出本机插件。
2. 私有仓库里出现以本机 hostname 命名的文件夹（例如 `fnOS/`）。
3. `paseo plugin logs plugin-sync` 出现：`GitHub 身份：…`、`开始同步…`、`已推送到 GitHub…`。

也可以命令行确认仓库里已有本机文件夹（需要 token，用户可代查）：

```bash
git clone "https://gh.imtsui.com/https://github.com/repairer7/paseo-plugin-store.git"
ls paseo-plugin-store
```

### 文件夹命名规则

- 默认 = 本机 hostname，原样保留大小写。
- 空格和特殊字符替换为 `-`。
- 如果同名文件夹已被另一台机器占用（serverId 不同），自动改为 `<hostname>-<serverId 后 4 位>`。
- 想改名：在「插件同步」设置里填 `hostLabel`（当前版本 UI 未暴露时，改 `<home>/plugin-sync/config.json` 的 `hostLabel` 后重载插件）。

---

## 5. 日常使用

在任意一台的「插件同步」界面：

```
本机插件 → 同步目标
token-pill    ☑ fnOS    ☐ HomeWindows
recycle-bin   ☑ fnOS    ☑ HomeWindows
[保存目标并同步]
```

- 勾选写的是**源主机**自己的 `plugins.json` 里的 `targets`。
- 目标主机在下一轮轮询（默认 60 秒）自动安装或更新。
- 取消勾选默认只是 `disable`（保留插件和设置）；要彻底删除，需要用户手动 `paseo plugin remove <id>`。

---

## 6. 同步规则（重要）

| 目标机现状 | 行为 | 设置是否保留 |
|---|---|---|
| 没装 | 从源主机内容安装到 `<home>/plugin-sync/staging/<id>`，或按 npm/git 源安装 | — |
| 已装，目录源 | 先备份到 `<home>/plugin-sync/backups/<id>-<时间>`，原地覆盖内容，`plugin reload` | **保留** |
| 已装，npm 源 | `paseo plugin update <id> --version <版本> --yes` | **保留** |
| 已装，git 源 | `paseo plugin update <id> --ref <ref> --yes` | **保留** |
| 来源类型不同（目录 ↔ npm/git） | 标记 `conflict`，不自动处理；需要用户确认后手动 `remove` + `install` | 会丢 |
| 插件 `requirements.paseo` 不满足 | 安装/加载失败，日志报错 | — |

明确**不同步**的东西：插件自身 settings、登录态、数据目录、绝对路径配置。这些是 host 级的，每台自己维护。

有运行时依赖（`package.json` 的 `dependencies` 非空）的插件，默认不发布 `node_modules`，目标机用 `npm ci --omit=dev --ignore-scripts` 安装依赖。目标机必须有 npm；否则在「插件同步」设置里关掉「安装运行时依赖」并让用户改用 git/npm 源。

---

## 7. 故障排查

| 现象 | 检查 |
|---|---|
| `插件同步` 一直显示未配置 token | token 文件路径/权限；界面重新导入；看 `token 错误` |
| `GitHub 401 / Bad credentials` | token 失效或没有该私有仓库权限；换 token |
| `git clone/fetch/push failed` | 反代是否可用：`curl -I https://gh.imtsui.com/https://raw.githubusercontent.com/git/git/master/README.md`；把 `proxyBase` 留空试直连 |
| 推送冲突 | 插件会自动 fetch + reset + 重试一次；持续失败看日志里的 git stderr |
| 本机文件夹没出现 | 看日志是否 `已推送到 GitHub`；确认 `pluginsEnabled=true` |
| 目标机没收到 | 目标机是否在线、轮询是否开启、源主机 `targets` 是否包含目标文件夹名、目标机日志 |
| `conflict` | 来源类型不同，或目标机路径受管；让用户确认是否 `remove` 后重装 |
| `npm ci` 失败 | 目标机没有 npm、或网络不通；改用 git/npm 源 |
| `Could not resolve type dependency "@getpaseo/client"` | 0.1.1 起会自动补装类型依赖；先 `paseo plugin update plugin-sync --yes` 再等一轮同步 |
| 插件加载失败 | `paseo plugin ls <id> --json` 看 error，`paseo plugin logs <id>` 看输出 |
| 想回滚 | 从 `<home>/plugin-sync/backups/<id>-<时间>` 拷回原目录后 `paseo plugin reload <id>` |

常用命令：

```bash
paseo plugin ls --json
paseo plugin logs plugin-sync
paseo plugin reload plugin-sync
paseo plugin update plugin-sync --yes
paseo plugin remove plugin-sync
```

---

## 8. 安全

- 同步插件是受信任的、无沙箱代码；**私有仓库 = 三台机器的代码执行通道**，拿到 token 的人可以在所有主机安装任意插件。
- token 建议用经典 PAT（`repo` 权限）或只授权这一个仓库的 fine-grained token；泄露后立即撤销。
- token 只保存在本机 `<home>/plugin-sync/token.txt`，界面不回显，不写入仓库，不写日志。
- 私有仓库不要设为公开；公开仓库只放同步插件源码（无 token）。
- 覆盖已有插件前会自动备份，保留最近 3 份。

---

## 9. 升级同步插件本身

同步插件从公开仓库安装，可以直接升级：

```bash
paseo plugin update plugin-sync --yes --json
paseo plugin reload plugin-sync
```

升级后 `paseo plugin ls plugin-sync` 应为 `running`。其他主机各自执行一次即可；同步插件不通过私有仓库分发。

---

## 10. 给 AI 代理的最短执行清单

1. 读第 1 节，确认 `paseo` 可用、`pluginsEnabled=true`（若否，先征求用户同意）。
2. 执行安装命令（第 2 节），确认 `status=running`。
3. 让用户提供 token，按第 3 节写入或导入；确认日志出现 `GitHub 身份：repairer7`。
4. 打开「插件同步」点一次「立即同步并应用」，确认本机 hostname 文件夹出现在私有仓库。
5. 把本机 hostname、`paseo plugin logs plugin-sync` 最近 10 行回报给用户。
6. 不要修改私有仓库里其他主机的文件夹；不要打印 token。
