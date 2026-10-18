# dsh-webops-plugin 独立插件包 · 安装说明

便携版 = **已经编译好的插件目录**。解压即可用，不需要 Node 工具链，也不需要
DeepSeek Harness 的源码 checkout。

## 一、更新已有插件（DSH 本体不变时）

下载 `dsh-webops-plugin-v<版本>.zip`，完全退出 DSH 后，将包内文件合并覆盖到**已安装的插件目录**，再重新启动 DSH。这个 ZIP 根目录就是插件内容，不要直接解压到便携版根目录。

便携版默认插件目录为 `<便携目录>\home\profiles\desktop\node_modules\dsh-webops-plugin`；自定义 DSH_HOME 或 profile 时，以实际加载的插件目录为准。通过 `dsh plugin add` 安装的用户覆盖当初登记的源目录。

覆盖后核对插件目录 `package.json` 的 version，再启动检查网页工具是否能实际调用。保留旧 chunk，无需清理；用户会话、设置及 profile 的 `package.json` 不在覆盖范围内。

本包包含完整插件运行时，不依赖上一版插件文件。DSH 与插件分别发版；DSH 本体不变且接口兼容时，只需更新插件。需要新宿主接口的版本应在 Release 说明列出兼容要求，旧 DSH 不自动获得新接口。

## 二、首次安装：解压

解压到任意位置，路径里**不要有中文或空格**（Windows 上 dsh 的 profile 依赖解析对
非 ASCII 路径不友好）。例如：

```
D:\tools\dsh-webops-plugin\
```

目录结构：

```
dsh-webops-plugin/
  lib/                 编译产物（host 四面 + 客户端 bundle + Electron 窗口宿主）
  cordis.patch.yml     bundle 配置层：把五行插进目标 profile
  package.json         声明 exports / dsh.bundle.patch / dsh.client
  INSTALL.md           本文件
  README.md
  LICENSE
```

## 三、装进 profile

```bat
dsh plugin --profile <你的 profile 名> add D:\tools\dsh-webops-plugin
```

`<profile>` 不存在时 dsh 会自动初始化。

> **注意**：`add` 之后不要再移动或删除这个目录 —— dsh 是把它 link 进 profile 的。

## 四、验证

```bat
dsh --profile <你的 profile 名> --dump-config
```

在输出里找到这一段，五行齐全即为装好：

```
# == dsh-webops-plugin
- dsh-webops-plugin/browser
- dsh-webops-plugin/browser-cdp
- dsh-webops-plugin/browser-electron
- dsh-webops-plugin/tool-browser
- dsh-webops-plugin
```

打开 `DSH_BROWSER_PLUGIN_DEBUG=1` 启动，能看到加载诊断：

```
[dsh-webops-plugin] root: client row registered
[dsh-webops-plugin] browser-cdp: endpoint=http://127.0.0.1:9333
[dsh-webops-plugin] browser-electron: enabled=true
[dsh-webops-plugin] webpage-tools: registered webpage_open, webpage_navigate, webpage_snapshot, webpage_screenshot, ...（共 16 个，前缀统一 `webpage_`）
```

## 五、选 provider

| provider | 环境变量 | 开的是什么 |
|---|---|---|
| `electron` | `DSH_BROWSER_PROVIDER=electron` | 桌面端自己的 `BrowserWindow` |
| `cdp` | `DSH_CDP_ENDPOINT=http://127.0.0.1:9333` | 你**自己开的**外部 Chrome 的标签页。⚠️ **出货默认关闭**（`cordis.patch.yml` 里 `browser-cdp: disabled: true`）：桌面端用 `electron` 就够，不装它。要连外部 Chrome，在插件页把 `browser-cdp` 那行开关打开（profile 层覆盖默认值） |

用 `cdp` 前必须先起一个带调试端口的 Chrome，**且必须用独立的 user-data-dir**，
否则它会复用你日常那个实例，而那个实例不会开调试端口：

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9333 --user-data-dir="%TEMP%\dsh-cdp-profile"
```

端口**别用 9222**：dsh 桌面端开发态的 Electron renderer 调试端口占着它，插件会连上
那个 Electron 而不是 Chrome，`/json/new` 必然失败。

### 网页登录态与数据保留

使用默认 `electron` provider 时，在 DSH 网页窗口中登录一次，后续访问同一网站通常可以复用登录态。各标签使用浏览器宿主的默认 session，没有按对话分隔 Cookie；换对话不等于切换网站账号，标签的操作归属仍按占用规则控制。关闭标签本身不会主动清除已保存的登录数据。

当前便携桌面壳将浏览器数据保存到 `<便携包根目录>\data\browser`。切换到使用该目录的新版本后，旧目录 `<便携包根目录>\data\temp\dsh-browser-electron-host` 不会自动导入，旧登录态不会自动带入，需在新网页窗口重新登录。旧目录保留原样，不会复制、清空或删除；若需回看或自行迁移，两个目录都包含敏感登录数据，不要当作普通缓存清理。

网页宿主通过独立 Electron `userData` 保存 Cookie、localStorage 与站点数据。关闭标签不会清除它们；便携实例内所有标签和对话共享同一浏览器 profile，切换对话不会切换账号。不同便携包各自使用包内目录，彼此不共享，也不会自动导入日常 Chrome、Edge 或 DSH 主界面的登录信息。运行时目录规则见[便携数据归属](打包机制参考.md#便携数据归属)。

升级便携桌面壳时保留原有 `home` 和 `data`。开发态 script 模式默认把浏览器数据放在当前 `DSH_HOME\data\browser`；显式设置 `DSH_BROWSER_USER_DATA_DIR` 时使用该位置。开发态旧版本曾回退到系统 temp，新目录不会自动带入旧 profile 的登录态。实现区别见[架构与实现](架构与实现.md#开发态-vs-便携版app-模式)。

登录数据保留不代表账号永久在线：网站可以让 Cookie 到期、撤销会话，或因退出账号、改密码、风控要求重新登录。清理或更换浏览器数据目录也会影响复用。数据目录包含敏感登录凭据，备份时应限制访问，不要当作普通测试产物公开分享，也不要承诺跨机器复制后仍可登录。

使用外部 `cdp` provider 时，登录态取决于连接的 Chrome profile；沿用同一 profile 才有机会复用，保留期限同样由网站和浏览器决定。

2026-10-16 已用真实 Electron 宿主和 localhost 页面验证关标签后 localStorage、持久 Cookie 与 session Cookie 保留，并验证正常退出、重启后 localStorage 和持久 Cookie 读回；session Cookie 是否跨重启保留由 Chromium 策略决定。真实网站账号、验证码、多因素登录和已安装版升级续用尚未验收，不能据此保证网站会话不会到期或要求重新登录。

## 六、卸载

```bat
dsh plugin --profile <你的 profile 名> remove dsh-webops-plugin
```
