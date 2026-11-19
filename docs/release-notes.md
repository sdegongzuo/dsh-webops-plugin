## dsh-webops-plugin __TAG__ · 完整便携包与独立插件包

本版把随包的 DSH 本体从 **`0.2.2-rc.3`** 升到 **`0.2.2-rc.5`**（上游 2026-11-18 发布，13 个提交）。插件自身代码与桌面补丁都没有变化：`apps/desktop` 在 rc.3→rc.5 之间只改了 `package.json` 的版本号，补丁 43 个目标文件全部原样复用（`git apply --check` 与反向检查均 0 失败）。随包第三方插件版本也与上一版相同。

| | 上一版 | 本版 |
| --- | --- | --- |
| 内置 DSH | 0.2.2-rc.3 | **0.2.2-rc.5** |
| 桌面补丁 | `2dcbc7c1…`（43 文件） | `2dcbc7c1…`（逐字节复用） |
| `dsh-webops-plugin` | 0.2.26 | **__VERSION__** |
| 三个随包插件 | 0.85.1 / 0.32.1 / 5.24.14 | 同左，未变 |

### 宿主变化：0.2.2-rc.3 → 0.2.2-rc.5

- **网页搜索的默认提供方改为按模型路由**（上游 `web-search-deepseek-model-default` 升级指南）。共享基座不再写死 `web.searchProvider: deepseek-search-api`：在 DeepSeek 模型路由（`deepseek-official` / `deepseek-account`）上的搜索改用旧版 Messages 搜索——它向 `web-search-deepseek` 端点发一次辅助 Messages 请求，**不按次收费、按模型 token 计费**，并在会话日志里追加一条 `web/deepseek-search-llm-request` 事件；其余路由仍用 DeepSeek Search API。设置页「网页搜索提供方」新增**自动选择**（新装默认选中）。想恢复旧行为：在该菜单里改选 DeepSeek Search API，或在 `@deepseek-ai/dsh-web` 的 config 里把 `searchProvider: deepseek-search-api` 与 `fetchProvider: http` 一起写回。注意 Messages 搜索的端点不跟随模型 base URL——用网关部署的用户需要把 `web-search-deepseek.baseURL` 指到网关（到 `/messages` 之前为止）。
- **内容拒答的错误码变了**（`deepseek-refusal-code` 指南）：DeepSeek 以 `stop_reason: "refusal"` 结束流时，错误终止块与失败轮次的 `turn/end` 现在报 `CONTENT_REFUSED`，此前是 `MALFORMED_RESPONSE`。如果外部脚本按旧码分类，需要跟着改。
- **LiveShare 隧道 worker 改为在宿主的 Electron Node 模式下启动**（#8634），并修正了 owner 凭据的时间基准（#8638）。
- **DeepSeek 官方路由改为每次都请求内容安全检查**（`feat(llm-deepseek): always request the content safety check`）：删掉 `safetyCheck` 开关后，每个官方 DeepSeek 请求都会带 `safety_check { level: high }`，拒答在报告计费用量之后失败。表现为官方路由上的拒答率可能上升，且拒答轮次仍计入用量。
- 其余为版本号同步与文档 / catalog 更新。上游本区间**没有删除任何包**，随包清单无需调整。

### 出厂配置：不再预置模型 provider

便携包 `home/profiles/desktop/cordis.patch.yml` 从本版起**只保留权限配置**（三个 preset + `defaultPreset: auto`），不再写 `llm-pi-ai` / `unisound` / `agent-default-model`：

- 便携版的 `home` 是全新的，预置 provider 也没有凭据，反而要在每个上游版本跟着维护 `compat.supportsDeveloperRole` 这类兼容细节。
- 首次打开请到「设置 → 模型」自行添加提供商（OpenAI 兼容网关 / xAI / DeepSeek 等）并填 API Key，落到 `home/.credentials.yaml`。
- 随包 `dsh-connect-workbuddy` 仍会复用 WorkBuddy 桌面端登录态提供模型，装了它的用户不配 provider 也能直接对话。
- 判别脚本 `scripts/verify-settings.mjs` 同步改成反向断言（出厂 patch 不得出现 provider / 默认模型 / 凭据引用），并在真宿主里确认权限配置生效。

### 升级须知

- **本版必须用完整包更新**：宿主版本变了，插件的三个 DSH peer 已改为精确等于 `^0.2.2-rc.5`（装包门禁就是按这个判的），把 __VERSION__ 的插件目录覆盖到 rc.3 宿主上会被判 peer 不满足。
- 完整便携包会替换 `home` 的出厂内容；已有会话、凭据请先备份。本机验收走的是「备份 home → 重铺 → 回填 `.credentials.yaml` 与 WorkBuddy 目录」路径，实测登录态与工具调用可用。
- 运行时锁按 rc.5 重解析，除 `@deepseek-ai/dsh*` 外还带升了两个传递依赖（`@smithy/core` 3.40.0 → 3.41.0、`standardwebhooks` 1.1.1 → 1.3.0），属于锁重解析漂移，已知并记录在 [遗留问题 §2](遗留问题.md)。
- 随包依赖未变：`dsh-context` 0.85.1 + `zod` 4.6.7、`dsh-better-sidebar` 0.32.1 + `ws` 8.22.1 / `yaml` 2.9.1、`dsh-connect-workbuddy` 5.24.14（peer 全为范围 `>=0.1.7-rc.1 <0.3.0-0`，覆盖 rc.5，仍然不需要 `compatibility.json` 豁免）。

### 更新已有安装

1. 完全退出 DSH，备份现有 `home\`（会话 / 设置 / 凭据都在里面）。
2. 下载 `__PORTABLE_ZIP__` 解压到新目录，把备份的 `home\`、`data\` 拷进新包根目录（目录契约不变）。
3. 启动后核对设置页版本为 `__DSH_VERSION__`、插件版本为 `__VERSION__`，并实际调一次网页工具。

独立插件 ZIP 仍然提供，但**只适用于宿主已经是 `__DSH_VERSION__` 的安装**：完全退出 DSH，把包内文件覆盖到 `home/profiles/desktop/node_modules/dsh-webops-plugin/`（包根目录是插件内容，不能直接解压到便携版根目录），重启后核对 `package.json` 的 version。从 rc.3 宿主升上来请直接用整包。

首次安装下载 `__PORTABLE_ZIP__`，解压后双击启动.cmd；内置本次插件、dsh-context、dsh-better-sidebar 与 dsh-connect-workbuddy 四个插件。DSH 本体版本为 __DSH_VERSION__，插件版本为 __VERSION__。出厂不含任何模型 provider 与 API Key，首次使用请在「设置 → 模型」添加自己的提供商；也不含凭据或会话数据。

保留旧 chunk 和用户 profile 登记。首次安装按包内 INSTALL.md 执行 `dsh plugin add`。
每次发布都提供完整便携包；插件包只用于 peer 匹配的同宿主更新。其他宿主版本的兼容性以实测为准。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| __PLUGIN_ZIP__ | __PLUGIN_KB__ KB | __PLUGIN_SHA__ |
| __PORTABLE_ZIP__ | __PORTABLE_KB__ KB | __PORTABLE_SHA__ |
