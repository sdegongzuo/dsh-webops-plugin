## dsh-webops-plugin __TAG__ · 完整便携包与独立插件包

本版**不改插件功能、不改 DSH 本体、不改桌面补丁**（仍是 `0.2.2-rc.5` 与 `2dcbc7c1…`），只改打包与登记机制：本插件不再以「精确版本号」登记到出厂 profile，而是**随包携带一份不可变 tarball，profile 用 `file:` 相对路径指向它**。

### 为什么改

宿主的「安装插件」动作（`install_bundle`）实际就是在 profile 目录里跑 `pnpm add <spec>`，它会**全量解析** profile 的 `dependencies`。本插件是本地构建产物、从未发布到 npm registry，所以登记写 `"dsh-webops-plugin": "0.2.28"` 时，任何一次在桌面端安装其它插件都会去 registry 拉这个包并 404，安装因此失败。改成 `file:` 相对路径后，解析永远有本地事实来源，任何时刻安装其它插件都不再被本插件拖累；整个便携目录搬走后登记也不会失链。

| | 上一版 | 本版 |
| --- | --- | --- |
| 内置 DSH | 0.2.2-rc.5 | 0.2.2-rc.5（未变） |
| 桌面补丁 | `2dcbc7c1…`（43 文件） | `2dcbc7c1…`（逐字节复用） |
| `dsh-webops-plugin` | 0.2.28 | **__VERSION__**（代码同 0.2.28） |
| `dsh-context` | 0.86.0 | 0.86.0（未变） |
| `dsh-connect-workbuddy` | 5.24.17 | 5.24.17（未变） |
| `dsh-better-sidebar` | 0.32.1 | 0.32.1（未变） |
| `dsh-llm-xai-oauth` | 0.3.1 | 0.3.1（未变） |

### 登记机制变化

- **出厂 profile 登记**：`home/profiles/desktop/package.json` 里本插件一项从 `"0.2.28"` 改为 `"file:../../../vendor/__PLUGIN_TGZ__"`；第三方随包插件仍在 npm 上，保持精确版本登记。
- **包内新增**：便携包根 `vendor\__PLUGIN_TGZ__`（不可变 tarball）。profile 里那条相对路径就是指向它，**这个文件不要删**。
- **发布产物**：本版 Release 多一个 tarball 附件，与插件 ZIP 同源同内容（npm `files` 白名单自动剔除 `INSTALL.md`，属 npm pack 标准语义）。
- 打包门禁同步收紧：`verify-release-portable` 现在会断言「包内有这份 tarball」且「profile 登记必须是那条 `file:` 相对路径」，写错版本或漏带 tgz 直接出不了包。

### 升级须知

- **从 0.2.28 及更早升级（重要）**：只覆盖 `node_modules\dsh-webops-plugin\` 仍能正常启动，但 profile 里那条精确版本登记还在。请顺手把它改成 `file:` 写法（见下方「更新已有安装」第 4 步），否则在桌面端安装其它插件时仍会 404 —— 这不是本版新引入的问题，但只有改了登记才算真正修掉。
- 完整便携包会替换 `home` 的出厂内容；已有会话、凭据请先备份。
- 独立插件 ZIP 仍只适用于宿主已是 `0.2.2-rc.5` 的安装；插件功能与 0.2.28 完全一致，从 0.2.28 升级可以只换插件目录。

### 更新已有安装

1. 完全退出 DSH，备份现有 `home\`（会话 / 设置 / 凭据都在里面）。
2. 下载 `__PORTABLE_ZIP__` 解压到新目录，把备份的 `home\`、`data\` 拷进新包根目录（目录契约不变）。
3. 启动后核对设置页版本为 `__DSH_VERSION__`、插件版本为 `__VERSION__`，并实际调一次网页工具。
4. 若沿用旧 `home`：确认包根有 `vendor\__PLUGIN_TGZ__`，把 `home\profiles\desktop\package.json` 里 `dependencies.dsh-webops-plugin` 一项改成 `"file:../../../vendor/__PLUGIN_TGZ__"`（只改这一个键），再重启。旧 tarball 可以留着，不影响使用。

独立插件 ZIP 仍然提供，但**只适用于宿主已经是 `__DSH_VERSION__` 的安装**：完全退出 DSH，把包内文件覆盖到 `home/profiles/desktop/node_modules/dsh-webops-plugin/`（包根目录是插件内容，不能直接解压到便携版根目录），重启后核对 `package.json` 的 version。

首次安装下载 `__PORTABLE_ZIP__`，解压后双击启动.cmd；内置本次插件、dsh-context、dsh-better-sidebar、dsh-connect-workbuddy 与 dsh-llm-xai-oauth 五个插件。DSH 本体版本为 __DSH_VERSION__，插件版本为 __VERSION__。公开包不含任何模型 provider 与 API Key，首次使用请在「设置 → 模型」添加自己的提供商；也不含凭据或会话数据。

每次发布都提供完整便携包；插件包只用于 peer 匹配的同宿主更新。其他宿主版本的兼容性以实测为准。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| __PLUGIN_TGZ__ | __PLUGIN_TGZ_KB__ KB | __PLUGIN_TGZ_SHA__ |
| __PLUGIN_ZIP__ | __PLUGIN_KB__ KB | __PLUGIN_SHA__ |
| __PORTABLE_ZIP__ | __PORTABLE_KB__ KB | __PORTABLE_SHA__ |
