# QUTC Launcher

QUTC Minecraft 社团的 Windows 启动器（Electron，原生 JavaScript）。支持原版下载、微软设备码登录、Yggdrasil 外置登录、离线模式、Fabric / Quilt / Forge / NeoForge，以及 Modrinth 整合包和 MOD。支持把已有游戏文件夹原地注册为实例。界面截图在 `docs/`。仓库不包含 Minecraft 游戏文件。

## 部署

需要 Windows 10+ 和 [Node.js 18+](https://nodejs.org/)。在仓库目录执行：

```powershell
node scripts/setup.js
```

这条命令会：

1. 下载 Electron 31.7.7 到 `vendor/electron/`，并按官方 SHA-256 校验
2. 用 Windows 自带的 C# 编译器，从 `build/launcher-bootstrap.cs` 编译引导器
3. 安装到 `%LOCALAPPDATA%\QUTC-Launcher`
4. 在桌面创建「QUTC Launcher」快捷方式

再次运行会更新程序，并保留同目录下的 `QUTCData/`（账号、实例、游戏文件）。

```powershell
node scripts/setup.js --portable        # 只生成 dist/QUTC-Launcher
node scripts/setup.js --portable --zip  # 再打成 zip
node scripts/setup.js --runtime-only    # 只下载 Electron，供开发启动
```

开发时加载本仓库源码：

```powershell
npm start
```

也可以双击 `run.cmd`。第一次会自动准备 Electron 运行时。测试用 `npm test`。

## 外部文件夹实例

主页的「添加已有文件夹」可以把已有的游戏目录原地加入 QUTC：

1. 选择已有的 `.minecraft` 游戏目录（不是它的上一级目录）
2. 输入实例名称
3. 选择一个已经安装的 QUTC 版本 / 加载器
4. 添加后直接使用原目录中的 `mods`、`config`、`saves`

不会复制文件；删除这个外部实例只会移除 QUTC 的注册信息，不会删除原文件夹。版本库、资源、Java 仍由 QUTC 管理，所以需要先安装对应版本。

### 项目目录

同一个游戏文件夹可以添加多个版本实例，它们会自动归到主页的「项目目录」：

- 点目录卡片上的「管理版本」查看该目录下的所有版本
- 可以启动、设置或打开每个实例
- 「添加版本到此目录」可以把另一个已安装版本加到同一份 `mods / saves / config` 上
- 同一个目录下的实例共享原目录的游戏数据

### 实例设置

实例卡片上的「设置」可以单独配置：

- 内存
- 分辨率
- 额外 JVM 参数
- 额外游戏参数
- 备注

并可以快捷打开：

- 版本文件夹
- 存档文件夹
- 资源包文件夹
- MOD 文件夹
- 实例目录

测试：

```powershell
node scripts/smoke-external.js
```

## 正版登录

在「账户」页点击「登录微软账号」，在弹出的窗口里登录即可。启动器使用 Minecraft 官方公开客户端完成授权，不需要注册 Azure 应用，也不需要填写设备码。密码只输入在微软页面上。

未购买正版时可以用离线模式，或在账户页填写 HTTPS 的 Yggdrasil / authlib-injector 地址（含 LittleSkin）。外置登录不能进入正版服务器。安全边界见 [SECURITY.md](SECURITY.md)。

## 数据

程序目录下的 `QUTCData/` 存放配置、账号、版本、资源、Java、实例和日志。复制该目录即可备份或迁移。

自动安装 Java 只覆盖 Windows。整合包目前支持 Modrinth `.mrpack`。启动器没有自动更新，重新运行 `node scripts/setup.js` 会覆盖安装程序文件。

## 许可

MIT，见 [LICENSE](LICENSE)。Minecraft 是 Mojang Studios 的商标。
