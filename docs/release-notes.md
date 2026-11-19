## dsh-webops-plugin __TAG__ · 完整便携包与独立插件包

本版**不改 DSH 本体、不改桌面补丁**（仍是 `0.2.2-rc.5` 与 `2dcbc7c1…`），只动随包第三方插件：`dsh-context` 0.85.1 → **0.86.0**、`dsh-connect-workbuddy` 5.24.14 → **5.24.17**；并把上一版已做完真机验收、但尚未出厂的 **Grok 订阅插件 `dsh-llm-xai-oauth@0.3.1`** 一并纳入出厂 bundle。随包的启动脚本与出厂补丁同步补上系统代理透传和可选的出厂默认模型。

| | 上一版 | 本版 |
| --- | --- | --- |
| 内置 DSH | 0.2.2-rc.5 | 0.2.2-rc.5（未变） |
| 桌面补丁 | `2dcbc7c1…`（43 文件） | `2dcbc7c1…`（逐字节复用） |
| `dsh-webops-plugin` | 0.2.27 | **__VERSION__** |
| `dsh-context` | 0.85.1 | **0.86.0** |
| `dsh-connect-workbuddy` | 5.24.14 | **5.24.17** |
| `dsh-better-sidebar` | 0.32.1 | 0.32.1（未变） |
| `dsh-llm-xai-oauth` | — | **0.3.1（新增）** |

### 随包插件变化

- **`dsh-context` 0.86.0**：`dependencies.zod` 仍是 `^4.6.6`，随包 `zod` 4.6.7 继续满足；peer 声明逐项未变。tgz 取自 npm 官方包，sha512 与 registry `dist.integrity` 逐字节一致。
- **`dsh-connect-workbuddy` 5.24.17**：`dependencies` 仍是 `@deepseek-ai/schemastery 3.19.0`，peer 全为范围 `>=0.1.7-rc.1 <0.3.0-0`，覆盖 rc.5，仍不需要 `compatibility.json` 精确版本豁免；隔离运行时锁 `workbuddy-runtime.lock.json` 不用重建。tgz 同样取自 npm 官方包。
- **新增 `dsh-llm-xai-oauth` 0.3.1**：Grok 订阅接入，设备码 OAuth 复用本机 `~/.grok-bridge` / `~/.grok` 登录态，走 cli-chat-proxy 订阅池，无需填 API Key；依赖随包物化 `undici` 7.30.2 与 `eventsource-parser` 3.1.1。出厂 patch 固定 `clientVersion: "1.0.13"`（服务端 426 要求 1.0.13+），用户无需手改配置。首次使用需在插件页完成设备码登录，凭据只落在用户目录、不进包。
- 旧 tgz 全部保留作兼容夹具；升级只换 `vendor/plugins/manifest.json` 的版本与校验值。

### 启动脚本与出厂配置

- **`启动.cmd` 自动透传 Windows 系统代理**：读取注册表的 `ProxyEnable` / `ProxyServer`（仅取简单的 `host:port`，带 `per-protocol` 的值忽略），写入 `HTTPS_PROXY` / `HTTP_PROXY` 再启动 DSH（Node 本身不读 WinINET 代理）。也可在包根新建 `proxy.txt`，第一行写一个完整代理地址（如 `http://127.0.0.1:7890`）覆盖。直接双击 `app` 下的 exe 不会带代理，请优先用 `启动.cmd`。
- **出厂默认模型改为可选**：打包时只有设置 `DSH_FACTORY_DEFAULT_MODEL` 才会在出厂 patch 追加默认模型 provider；公开包默认**不预置**任何模型 provider / API Key，继续保持「设置 → 模型」自选的出厂策略。`verify-settings` 的反向断言不变。
- **`使用说明.txt` 随出厂默认模型分支变化**：未设置时提示到设置页自选提供商；派生构建设置了默认模型时，写明模型名、首次登录方式与「没有订阅可切回 WorkBuddy 等自带模型」。

### 升级须知

- DSH 本体仍是 rc.5、三个 DSH peer 与本仓声明一致，因此**本版可以用独立插件包增量更新**（完全退出 DSH，把包内文件覆盖到 `home/profiles/desktop/node_modules/dsh-webops-plugin/`，重启后核对版本）。新增的 Grok 插件及其依赖由完整包物化；用独立插件包更新时，Grok 插件需要在插件页自行安装或改用完整包。
- 完整便携包会替换 `home` 的出厂内容；已有会话、凭据请先备份。本机验收走的是「备份 home → 重铺 → 回填 `.credentials.yaml` 与 WorkBuddy 目录」路径。
- 新增 Grok 插件后，插件页会多出一项；没有 SuperGrok / X Premium 订阅的用户不必登录，切回 WorkBuddy 等自带模型即可。

### 更新已有安装

1. 完全退出 DSH，备份现有 `home\`（会话 / 设置 / 凭据都在里面）。
2. 下载 `__PORTABLE_ZIP__` 解压到新目录，把备份的 `home\`、`data\` 拷进新包根目录（目录契约不变）。
3. 启动后核对设置页版本为 `__DSH_VERSION__`、插件版本为 `__VERSION__`，并实际调一次网页工具。

独立插件 ZIP 仍然提供，但**只适用于宿主已经是 `__DSH_VERSION__` 的安装**：完全退出 DSH，把包内文件覆盖到 `home/profiles/desktop/node_modules/dsh-webops-plugin/`（包根目录是插件内容，不能直接解压到便携版根目录），重启后核对 `package.json` 的 version。

首次安装下载 `__PORTABLE_ZIP__`，解压后双击启动.cmd；内置本次插件、dsh-context、dsh-better-sidebar、dsh-connect-workbuddy 与 dsh-llm-xai-oauth 五个插件。DSH 本体版本为 __DSH_VERSION__，插件版本为 __VERSION__。公开包不含任何模型 provider 与 API Key，首次使用请在「设置 → 模型」添加自己的提供商；也不含凭据或会话数据。

保留旧 chunk 和用户 profile 登记。首次安装按包内 INSTALL.md 执行 `dsh plugin add`。
每次发布都提供完整便携包；插件包只用于 peer 匹配的同宿主更新。其他宿主版本的兼容性以实测为准。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| __PLUGIN_ZIP__ | __PLUGIN_KB__ KB | __PLUGIN_SHA__ |
| __PORTABLE_ZIP__ | __PORTABLE_KB__ KB | __PORTABLE_SHA__ |
