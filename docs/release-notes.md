## dsh-webops-plugin __TAG__ · 完整便携包与独立插件包

本版把内置的 DSH 本体从 `dsh-v0.2.2-alpha.3` 升到 **`dsh-v0.2.2-rc.3`**（上游 2026-11-17 发布，跨 1578 个提交）。插件自身代码本版无功能变更，版本号随新宿主出货。

**随包宿主的变化（与用户直接相关的一项）**：rc 系列修过一起启动失败事故 —— 欢迎页用 `credentials: 'include'` 做回环认证，每次启动往会话 cookie jar 里留下一个 30 天的 `dsh-auth-*` cookie（cookie 不分端口），累计约 70 次启动后 Cookie 头超过 16 KiB，宿主回 431、**再也起不来**。上游改成「显式 Cookie 头、不走 jar」。本包的桌面补丁保留了自己的跨栈回环兜底（Node 栈与 Chromium 栈都要点头才认这个回环名），但**探测后立刻把这次写进 jar 的 cookie 删掉**，认证结论与 cookie 全部显式传值，因此不会再重现上面的累积问题。如果你此前用 alpha 版遇到过「某次启动后一直卡在欢迎页 / API 431」，这条就是它的修复。

另外上游在 rc.3 退役了 `@deepseek-ai/dsh-experimental-agent-team-profile`（Team 能力改由 `dsh-agent-team` 系列承载），出厂实验 bundle 因此从 5 项减为 4 项：auto-review、tool-worktree、terminal-bundle、session-search。旧 profile 里若还登记着已退役的包，宿主会静默忽略，不需要手工清理。

随包第三方插件版本与 v0.2.24 相同（`dsh-context` 0.81.0、`dsh-better-sidebar` 0.28.2、`dsh-connect-workbuddy` 5.18.0），但插件 peer 已抬到 `^0.2.2-rc.3`，且在 rc.3 上用随包 `dsh-app-boot` 的真判据实算为零 issue —— 不需要 `compatibility.json` 豁免。

下载 `__PLUGIN_ZIP__`，包内包含完整编译插件及 INSTALL.md，无需重新下载 DSH 桌面整包。

首次安装下载 `__PORTABLE_ZIP__`，解压后双击启动.cmd；内置本次插件、dsh-context、dsh-better-sidebar 与 dsh-connect-workbuddy 四个插件。DSH 本体版本为 __DSH_VERSION__，插件版本为 __VERSION__。首次使用请在设置中填写自己的 API Key；不含凭据或会话数据。

### 更新已有插件

1. 完全退出 DSH。
2. 将 ZIP 内的文件合并覆盖到实际加载的 `dsh-webops-plugin` 插件目录。
   便携版默认位置：`home/profiles/desktop/node_modules/dsh-webops-plugin/`。
   本包根目录是插件内容，不能直接解压到便携版根目录。
3. 重新启动，核对插件 package.json 的 version 为 `__VERSION__`，并实际调用网页工具。

### 升级说明

- 只更新插件（覆盖插件目录）**不会**换掉 DSH 本体，仍是原来的 alpha.3；要拿到 rc.3 的宿主修复，需要下载完整的 `__PORTABLE_ZIP__`（会换掉 `home` 的出厂内容，先备份自己的数据）。
- 从 v0.2.23 及更早版本升级的用户，若还没做过 WorkBuddy 连接插件换包（`dsh-workbuddy-connect` → `dsh-connect-workbuddy`），按 v0.2.24 发版说明里的「一次性动作」处理；v0.2.24 用户不需要再做什么。

保留旧 chunk 和用户 profile 登记。首次安装按包内 INSTALL.md 执行 `dsh plugin add`。
每次发布都提供完整便携包；已有用户也可只更新插件。其他宿主版本的兼容性以实测为准。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| __PLUGIN_ZIP__ | __PLUGIN_KB__ KB | __PLUGIN_SHA__ |
| __PORTABLE_ZIP__ | __PORTABLE_KB__ KB | __PORTABLE_SHA__ |
