# QUTC Launcher 安全说明与代码审计

本文件面向社团管理员与愿意审查代码的成员，说明启动器的安全边界、第三方代码来源、已经实施的防护，以及审查时应该重点检查的位置。

## 1. 设计原则

1. **不运行来源不明的代码**。启动器自身不下载、不加载、不 `eval` 任何远程脚本。唯一会执行的第三方程序是 Forge/NeoForge 官方安装器，且必须由用户勾选同意，并优先校验官方 Maven 发布的 SHA-1。
2. **游戏文件必须可验证**。Mojang 原版客户端、依赖库、资源、日志配置、Java 运行时全部使用官方 SHA-1；Modrinth 文件使用其 API 返回的 SHA-1。
3. **最小权限**。渲染进程运行在 Electron sandbox 中，没有 Node/文件系统/网络权限；所有能力通过 `preload.js` 暴露的固定 IPC 方法调用。
4. **不信任压缩包**。`.qutc` 与 `.mrpack` 都是 ZIP，解压前检查路径穿越、绝对路径、符号链接、加密条目、压缩炸弹；包内脚本不会被执行。
5. **不收集数据**。没有遥测、统计、广告、自动更新请求；账号令牌只保存在本机。
6. **MOD 是第三方游戏代码**。MOD 文件只写入版本的 `mods/`，文件名会清理路径字符，SHA-1 只证明文件与 Modrinth 登记一致，不代表 MOD 行为安全；请只安装社团信任的 MOD，启动器不会执行 MOD 安装脚本。
7. **引导器透明**。便携版的 `QUTC Launcher.exe` 由 `node scripts/setup.js` 从 `build/launcher-bootstrap.cs` 编译，仓库不提交这个 exe。它只启动同目录下的 Electron 运行时；不联网、不下载、不写注册表。

## 2. 代码来源与“借鉴”审查

本项目没有直接复制 PCL、HMCL 或其他启动器的源代码。实现依据的是公开协议与文档：

- Mojang 版本清单 / 版本 JSON / 资源索引格式（公开 JSON 结构）；
- Microsoft OAuth 2.0 设备码流程、Xbox Live / XSTS / Minecraft Services 公开接口；
- Fabric / Quilt 官方 meta API 与 profile JSON；
- Forge / NeoForge 官方安装器 CLI（`--installClient`）与 Maven 布局；
- Modrinth API v2 与 `.mrpack` 格式（`modrinth.index.json`）；
- ZIP 文件格式（PKWARE APPNOTE）。

因为参考的是**格式与协议**而不是实现代码，不存在把第三方启动器中的后门、混淆代码、遥测逻辑带入的问题。所有 JavaScript 均为本仓库内明文源码，可直接阅读与搜索。

审查时可以执行以下命令，结果应为空或仅出现在文档/注释中：

```powershell
# 动态执行 / 远程代码加载
rg -n "eval\(|new Function|vm\.run|require\(.*http|import\(" src
# 可疑网络地址
rg -n "http://" src
# 子进程调用（应只有 Java / 官方安装器 / 打包脚本）
rg -n "child_process|spawn\(|execFile" src
# 混淆特征
rg -n "atob\(|Buffer\.from\([^,]+,\s*['\"]base64" src
```

当前代码中的 `child_process` 使用点：

- `src/core/java.js`：执行 `java -version` 检测版本；
- `src/core/launch.js`：启动 Minecraft Java 进程；
- `src/core/loaders.js`：运行 Forge/NeoForge 官方安装器（需用户同意）；
- `src/main/main.js`：无；
- `scripts/`：开发/打包脚本，不随游戏运行。

## 3. 威胁模型与防护

| 威胁 | 防护 | 代码位置 |
| --- | --- | --- |
| 恶意下载地址 / SSRF | 只允许 HTTPS；拒绝内网、环回、链路本地、带凭据 URL | `src/core/security.js` |
| 下载被篡改 | 下载到 `.part`，校验 SHA-1/SHA-256 后原子替换；已有文件重新校验 | `src/core/http.js`、`src/core/hash.js` |
| 镜像投毒 | 镜像只改变主机名，哈希仍以 Mojang 官方 JSON 为准；镜像失败回退官方 | `src/core/http.js` |
| 版本 JSON 注入 | 只读取固定字段；库地址必须是 HTTPS；加载器 profile 校验 `inheritsFrom`/`mainClass` | `src/core/versions.js`、`src/core/loaders.js` |
| 路径穿越 | 所有 ZIP 条目、版本相对路径使用 `assertSafeRelative` + `safeJoin` | `src/core/util.js`、`src/core/zip.js` |
| 符号链接 / 压缩炸弹 | 拒绝 symlink、加密 ZIP、不支持算法；限制条目数、总解压体积、单文件压缩比 | `src/core/zip.js` |
| 渲染进程 XSS → RCE | sandbox、contextIsolation、无 nodeIntegration、CSP、无 `innerHTML` 写入远程数据 | `src/main/main.js`、`src/renderer/index.html`、`src/renderer/app.js` |
| 任意 IPC 调用 | preload 只暴露固定方法；主进程逐参数校验（类型、长度、版本 ID 正则） | `src/main/preload.js`、`src/main/ipc.js` |
| 任意文件读写 | 文件路径只来自主进程 `dialog`；版本/版本 ID 正则限制；导出/导入不接收渲染进程路径 | `src/main/ipc.js`、`src/core/instances.js` |
| 令牌泄露 | `refresh_token` 用 `safeStorage`（Windows DPAPI）加密；渲染进程拿不到令牌；日志不打印 access token | `src/core/auth/accounts.js`、`src/main/ipc.js` |
| 外链钓鱼 | `shell.openExternal` 只允许白名单域名（微软、Mojang、Modrinth、Fabric 等） | `src/core/security.js`、`src/main/main.js` |
| 第三方安装器 | 必须显式同意；优先校验官方 `.sha1`；运行目录限制在 QUTCData；日志公开 | `src/core/loaders.js` |

## 4. 账号与隐私

- 微软登录使用授权码流程：账户页打开一个独立窗口加载微软登录页。该窗口没有启动器 preload，也没有 Node 权限。用户在微软页面输入密码；窗口跳转到 `https://login.live.com/oauth20_desktop.srf` 时，启动器只取走授权码并立刻关闭窗口，不记录这个地址。客户端 ID 是 Minecraft 启动器的公开 ID `00000000402b5328`，没有 client secret。之前用设备码保存的刷新令牌需要重新登录一次。
- `refresh_token` 通过 Electron `safeStorage.encryptString` 加密后写入 `accounts.json`；在 Windows 上由 DPAPI 绑定当前用户。
- 渲染进程只能看到昵称、UUID、账号类型；`getRefreshToken` 只在主进程调用。
- 游戏启动日志会隐藏 access token（`redactToken`），调试命令中不包含令牌。
- 离线账号只保存用户名与派生 UUID。
- 外置登录的密码只在 `accounts:yggdrasil-login` 请求中使用，不写入磁盘、不写日志、不进入渲染进程之外的持久存储；accessToken 与微软 refreshToken 一样使用 `safeStorage` 加密。
- 外置登录支持任意 HTTPS Yggdrasil API 地址；启动器会按 authlib-injector 规范解析 ALI 与元数据，拒绝 HTTP 和私有地址。密码只会发送给用户当前填写的验证服务器，因此只应使用信任的服务器。
- 登录成功后调用 Yggdrasil 的 validate/refresh 接口；clientToken 作为普通字段保存（不是 bearer 凭据）。
- 支持拖拽 `authlib-injector:yggdrasil-server:<API 地址>` 数据；拖入后只填入服务器并校验元数据，不会自动提交密码。
- authlib-injector 下载校验官方 SHA-256。

## 5. 已知风险与边界

1. **Forge/NeoForge 安装器是黑盒**。官方安装器本身会下载依赖、执行处理器，启动器无法逐行审计其行为。缓解措施：来源限定官方 Maven / 明确镜像、SHA-1 校验、用户显式同意、日志可见。若社团要求零第三方执行，可只使用 Fabric/Quilt 或原版。
2. **Electron 运行时体积大且未做代码签名**。便携版直接使用官方 Electron 二进制；分发时建议社团自行签名 exe，并核对 Electron 下载包的 SHA-256。
3. **未启用 Electron fuses / ASAR 完整性校验**。当前以明文 `resources/app` 分发，便于审查；若需要更强防篡改，可在发布流程中启用 asar 与 fuses。
4. **镜像可用性**。BMCLAPI、QLU 等镜像属于第三方基础设施；启动器只把它们当下载加速，哈希仍来自官方/Modrinth。
5. **离线模式不提供正版验证**。仅用于社团内部服务器；请勿用于盗版公共服务器。
6. **MOD 内容不可审计**。MOD 本质上是会进入游戏进程执行的第三方代码，启动器只能保证下载来源与哈希，不能保证 MOD 没有恶意行为。建议社团建立 MOD 白名单，只允许成员从 Modrinth 安装经过审核的 MOD。
7. **第三方 Yggdrasil 服务器是外部账号服务**。启动器只负责把密码通过 HTTPS 发送到用户填写的地址，本地不保存密码；但账号安全、角色数据、服务可用性由该服务器负责。只应使用社团信任的验证服务器，并建议开启其二次验证。外置登录不能进入正版服务器。
8. **MINEBBS / MC百科不做抓取**。两者没有公开稳定的 MOD 下载 API，启动器只提供搜索外链；从这些站点下载的 jar 由用户通过「导入本地 MOD」加入，启动器无法审计其内容。
9. **authlib-injector 是第三方 javaagent**。启动器从官方地址下载并校验 SHA-256，但它会修改游戏网络鉴权行为；如社团要求零第三方 agent，可只使用微软/离线登录。
10. **外部文件夹版本拥有原目录写权限**。添加后启动器会在该目录读写 `mods`、`config`、`saves`；删除版本只移除注册，不删除原目录。路径来自主进程文件夹选择框并做绝对路径/真实路径校验，但仍应只选择信任的游戏目录，不要指向系统目录或重要资料目录。
11. **樱花内网穿透是第三方隧道服务**。启动器会下载并运行 Sakura Frp 的 frpc 二进制、以访问密钥连接其 API 与服务器。访问密钥用系统加密保存、经环境变量传入、不落日志；但 frpc 与 Sakura Frp 服务本身属于第三方黑盒，实际连通性需真实账号验证。建议社团对穿透流量做审计。

## 6. 审查清单（建议逐项勾选）

- [ ] `src/renderer/index.html` 的 CSP 未被放宽（无 `unsafe-eval`、无远程 script）。
- [ ] `src/main/main.js` 中 `webPreferences` 保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
- [ ] `preload.js` 没有暴露 `ipcRenderer`、`require`、`fs` 或任意 channel 调用。
- [ ] `ipc.js` 每个 handler 都校验了参数；新增文件操作没有直接使用渲染进程传来的路径。
- [ ] `http.js` 的 `assertSafeRemoteUrl` 仍然拒绝 HTTP 与内网地址。
- [ ] `zip.js` 仍拒绝 `..`、绝对路径、符号链接、加密 ZIP 与超限压缩比。
- [ ] `loaders.js` 的安装器调用仍要求 `ctx.consent === true`。
- [ ] 日志、错误信息、`displayCommand` 不包含 access token / refresh token。
- [ ] 新增依赖前确认其许可证与代码来源；本项目核心不依赖 npm 包。

## 7. 漏洞报告

社团内部发现问题时，请附上：复现步骤、涉及文件与行号、日志（先删除账号信息）、以及是否使用第三方镜像。管理员应在合并修复前运行 `node scripts/test.js` 并人工复核 `git diff`。

## 8. 自动化审计结果（2026-10）

`node scripts/audit.js` 会扫描 `src/` 全部 JavaScript，检查动态执行、明文 HTTP、HTML 注入 sink、未授权的 `child_process` 调用，以及 Electron 的 `sandbox`/`contextIsolation`/`nodeIntegration`/CSP 基线。当前结果：

- 扫描 31 个 JS 文件，0 个安全问题；
- 唯一提示是 `src/core/paths.js` 读取 `QUTC_DATA`（便携数据目录，预期行为）；
- `src/core/auth/microsoft.js` 中唯一的 `http://` 是 XSTS 的 `RelyingParty: http://auth.xboxlive.com`，它是协议字段而不是请求地址，审计脚本已单独允许。

已经实际跑通的测试（2026-10）：

| 测试 | 结果 |
| --- | --- |
| `scripts/test.js` | 28 项通过 |
| `scripts/audit.js` | 通过（29 个 JS 文件） |
| `scripts/smoke-ipc.js` | 通过（含 Mojang/Fabric/Modrinth 实时请求） |
| `scripts/smoke-auth.js` | 通过（12 次 mock 请求，设备码→XBL→XSTS→MC→档案→刷新） |
| `scripts/smoke-yggdrasil.js` | 通过（authlib-injector ALI/认证/刷新/拖拽 URI/协议限制 mock） |
| `scripts/smoke-instance.js` | 通过（导出/导入、路径穿越拦截） |
| `scripts/smoke-external.js` | 通过（外部文件夹原地注册、禁止复制、删除不碰原目录） |
| `scripts/smoke-frp.js` | 通过（樱花隧道解析、Bearer 不落日志、start/stop 状态机） |
| `scripts/smoke-mod.js` | 通过（真实 MOD 搜索、Iris→Sodium 依赖、SHA-1、本地导入） |
| `scripts/smoke-ui-mods.js` | 通过（真实 Electron 窗口：中文“钠”搜索 + 安装 + 外置登录表单 + 拖拽 URI） |
| authlib-injector 1.2.8 | 通过（真实下载 + SHA-256 校验） |
| 1.20.1 原版完整安装 | 通过（client 23MB、64 库、3575 资源、621MB） |
| 1.8.9 原版 + Java 8 自动下载 | 通过（jre-legacy 1.8.0_51） |
| Forge 1.20.1-47.4.28 | 通过（官方安装器，主类 `cpw.mods.bootstraplauncher.BootstrapLauncher`） |
| Fabric 0.19.5 | 通过（主类 `net.fabricmc.loader.impl.launch.knot.KnotClient`） |
| 真实 `.mrpack`（Sodium） | 通过（SHA-1 校验、overrides 应用） |

尚未自动化验证：真实微软账号在登录窗口中的完整交互（冒烟测试只覆盖离线协议字段）、真实外置账号登录（需要账号；当前仅验证错误响应与 mock 成功链）、真实游戏启动后的画面（需要显卡/桌面环境）、NeoForge 在部分网络的安装器下载。
