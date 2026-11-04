## dsh-webops-plugin __TAG__ · 完整便携包与独立插件包

本版把随包的 WorkBuddy 连接插件从 `dsh-workbuddy-connect@0.7.9` 换成 [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 的 **5.18.0**。旧包把 6 个 `@deepseek-ai/dsh-*` peer 钉成精确版 `0.2.1-rc.2`，在 DSH `0.2.2-alpha.3` 上被宿主 `evaluatePluginCompatibility` 判不满足后**整层静默跳过**（不报错，只是 WorkBuddy 模型来源整块消失）；v0.2.24 只能靠出厂 profile 的 `compatibility.json` 精确版本豁免救回来。新包把这批 peer 改成范围 `>=0.1.7-rc.1 <0.3.0-0`，用随包 `dsh-app-boot` 的真判据在 `0.2.2-alpha.3` 上实算为零 issue，**出厂 profile 不再需要任何豁免**，也不会再出现「插件页异常 / 模型列表缺 WorkBuddy」。

另两个随包插件同步升到 npm 当前正式版：`dsh-context` 0.81.0、`dsh-better-sidebar` 0.28.2；依赖按上游声明对齐（`dsh-context@0.81.0` 把 zod 从 `^4.4.3` 收紧成精确 `4.4.3`，vendored zod 随之回退到 4.4.3）。

> **关于新包的来源**：5.18.0 当时未发布到 npm（npm `latest` 为 5.17.0），这份 tgz 由 GitHub `main` 固定 commit `b783a3ba702a6e9599015c92329c62aeee09bb82` 源码经 `pnpm install --frozen-lockfile` + `npm pack` 构建。manifest 里的 sha512 是本地产物自算值、只与仓库里这一份 tgz 自洽，不是 registry 的 `dist.integrity`；源码提交、构建命令与 commit 都记在 `vendor/plugins/manifest.json`。隔离运行时（`pi-ai` 及其传递依赖）沿用既有 `workbuddy-runtime.lock.json`。

下载 `__PLUGIN_ZIP__`，包内包含完整编译插件及 INSTALL.md，无需重新下载 DSH 桌面整包。

首次安装下载 `__PORTABLE_ZIP__`，解压后双击启动.cmd；内置本次插件、dsh-context、dsh-better-sidebar 与 dsh-connect-workbuddy 四个插件。DSH 本体版本为 __DSH_VERSION__，插件版本为 __VERSION__。首次使用请在设置中填写自己的 API Key；不含凭据或会话数据。

### 更新已有插件

1. 完全退出 DSH。
2. 将 ZIP 内的文件合并覆盖到实际加载的 `dsh-webops-plugin` 插件目录。
   便携版默认位置：`home/profiles/desktop/node_modules/dsh-webops-plugin/`。
   本包根目录是插件内容，不能直接解压到便携版根目录。
3. 重新启动，核对插件 package.json 的 version 为 `__VERSION__`，并实际调用网页工具。

### 已安装用户的一次性动作（WorkBuddy 插件换包）

整包**新装**已自带新插件，不需要 `compatibility.json`。本增量包只更新 `dsh-webops-plugin` 自身，**不含也不改动随包插件与你的 profile**；旧 `home` 若仍登记 `dsh-workbuddy-connect`，需要自己迁移一次：把新插件目录放到 `home/profiles/desktop/node_modules/`，并把该 profile `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 中旧名换成 `dsh-connect-workbuddy`；`compatibility.json` 里旧包的豁免记录可以删掉（新包不需要）。最省事的路是用完整便携包重新铺底（会换掉 `home`，先备份自己的数据）。写法也印在增量包的 `更新说明.txt` 里。

保留旧 chunk 和用户 profile 登记。首次安装按包内 INSTALL.md 执行 `dsh plugin add`。
每次发布都提供完整便携包；已有用户也可只更新插件。其他宿主版本的兼容性以实测为准。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| __PLUGIN_ZIP__ | __PLUGIN_KB__ KB | __PLUGIN_SHA__ |
| __PORTABLE_ZIP__ | __PORTABLE_KB__ KB | __PORTABLE_SHA__ |
