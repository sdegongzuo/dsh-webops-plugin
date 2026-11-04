## dsh-webops-plugin __TAG__ · 完整便携包与独立插件包

本版修复**随包 `dsh-workbuddy-connect` 被宿主静默跳过**。该插件把 6 个 `@deepseek-ai/dsh-*` peer 依赖钉成精确版 `0.2.1-rc.2`（不带 `^`），dsh 按 peer 判兼容性时判不满足，于是把这个 bundle 整层跳过 —— 不报错、不中断启动，只是它注册的 WorkBuddy 模型来源整块消失。现在随包在出厂 profile 里写入一条精确版本豁免（`home/profiles/desktop/compatibility.json`），由随包 `dsh-app-boot` 现算需要的条目，只写真正不满足的那些。

同时修掉发布门禁的一处盲点：验收脚本现在用宿主自己的兼容性判定逐个 bundle 核对，不兼容且无豁免会直接点名插件与要求范围，而不是等到「首页少一个名字」才暴露。

打包态自检另修一处与生产路径不一致：自检起宿主时没注入 `DSH_CLIENT_VERSION`（真桌面壳会注），导致 `product-telemetry` 配置校验失败、`product-analytics` 一直 pending，stderr 稳定多两条 `entries did not activate`。补齐后归零 —— 那两条从来不是包的问题。

下载 `__PLUGIN_ZIP__`，包内包含完整编译插件及 INSTALL.md，无需重新下载 DSH 桌面整包。

首次安装下载 `__PORTABLE_ZIP__`，解压后双击启动.cmd；内置本次插件、dsh-context、dsh-better-sidebar 与 dsh-workbuddy-connect 四个插件。DSH 本体版本为 __DSH_VERSION__，插件版本为 __VERSION__。首次使用请在设置中填写自己的 API Key；不含凭据或会话数据。

### 更新已有插件

1. 完全退出 DSH。
2. 将 ZIP 内的文件合并覆盖到实际加载的 `dsh-webops-plugin` 插件目录。
   便携版默认位置：`home/profiles/desktop/node_modules/dsh-webops-plugin/`。
   本包根目录是插件内容，不能直接解压到便携版根目录。
3. 重新启动，核对插件 package.json 的 version 为 `__VERSION__`，并实际调用网页工具。

### 已有安装要做的一次性动作（WorkBuddy 模型）

整包**新装**已经自带豁免。用增量包升级的旧 `home` 里没有这个文件，`dsh-workbuddy-connect` 仍会被跳过（与它随包以来的状态一致，不是本版回退）。补法是新建 `home/profiles/desktop/compatibility.json`：

```json
{ "dsh-workbuddy-connect@0.7.9": ["__DSH_VERSION__"] }
```

或用 CLI：`dsh plugin allow-version dsh-workbuddy-connect@0.7.9 --dsh-version __DSH_VERSION__ --accept-risk`。重启生效。注意这是**承认风险**的显式豁免，不是兼容性证明：bundle 加载、补丁合并、客户端入口都已实测正常，但它作为 LLM provider 的真实取模型与对话未验（需要 WorkBuddy 桌面端登录态与额度）。

保留旧 chunk 和用户 profile 登记。首次安装按包内 INSTALL.md 执行 `dsh plugin add`。
每次发布都提供完整便携包；已有用户也可只更新插件。其他宿主版本的兼容性以实测为准。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| __PLUGIN_ZIP__ | __PLUGIN_KB__ KB | __PLUGIN_SHA__ |
| __PORTABLE_ZIP__ | __PORTABLE_KB__ KB | __PORTABLE_SHA__ |
