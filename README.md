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

侧边栏的「项目目录」是一个**文件夹列表**，每个文件夹下可以查看它包含的版本实例：

- **QUTC 下载实例**：本启动器下载的所有版本实例；每个版本有独立游戏目录
- **用户导入的文件夹**：每个外部游戏目录单独一项；同一个文件夹下可放多个版本，共享该文件夹的 `mods / saves / config`

点目录卡片上的「管理版本」查看该文件夹下的所有版本，可以启动、设置每个实例：

- QUTC 下载实例文件夹可以「新建版本」，继续下载新版本
- 外部文件夹可以「添加版本到此目录」，把另一个已安装版本加到同一份游戏数据上

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

## 外观与皮肤

- 设置页可自定义主题颜色，并上传本地图片作为启动背景（图片复制到 `QUTCData/cache`，通过 `qutc-asset://` 协议加载）。
- 账户页与左下角账户卡片会显示当前正版/外置账户的皮肤；离线账户显示名字首字母。

## 樱花内网穿透

设置页内置 Sakura Frp：输入樱花账号和访问密钥，选择隧道后点「开启」即可运行 frpc，无需单独打开樱花客户端。

- 访问密钥用系统加密（safeStorage/DPAPI）保存，不出现在日志和进程命令行里
- frpc 首次使用时自动下载到 `QUTCData/frp/`
- 该功能依赖 Sakura Frp 官方服务与 frpc，首次连真实账号前请自行确认隧道可用

## 数据

程序目录下的 `QUTCData/` 存放配置、账号、版本、资源、Java、实例和日志。复制该目录即可备份或迁移。

自动安装 Java 只覆盖 Windows。整合包目前支持 Modrinth `.mrpack`。启动器没有自动更新，重新运行 `node scripts/setup.js` 会覆盖安装程序文件。

## 许可

MIT，见 [LICENSE](LICENSE)。Minecraft 是 Mojang Studios 的商标。
