## dsh-webops-plugin __TAG__ · 随包第三方插件升到当前最新

本版只换随包的第三方插件，**插件自身代码未改**。DSH 本体仍是 `0.2.3-alpha.2`：2026-11-27 核对，上游 `master` 与最新 tag 都是它，没有更新的版本，因此桌面补丁与 `runtime-lock/pnpm-lock.yaml` 逐字节未动。

### 随包插件

| 插件 | 上一版 | 本版 |
| --- | --- | --- |
| `dsh-context` | 0.86.0 | **0.87.2** |
| `dsh-better-sidebar` | 0.32.1 | **0.33.0** |
| `dsh-connect-workbuddy` | 5.24.17 | **5.32.2** |
| `dsh-coding-subscription-oauth` | 0.8.8 | 0.8.8（未变） |

三个 tgz 的 sha512 与 registry `dist.integrity` 逐字节一致；旧 tgz 继续留在 `vendor/plugins/` 里作为回归夹具。

### 侧边栏不再需要宿主补丁

0.2.30 里 `dsh-better-sidebar` 0.32.1 靠物化期就地补丁活着：DSH 0.2.3 删掉了 `connection.requestRejection`，插件的栅栏每次调用都抛 TypeError，被宿主兜底成 400 空 body。

**0.33.0 上游自己解决了这件事**：栅栏改为依次尝试 `requestRejection` → `connection.authentication` 提供的 `admit` → `connection.admit`，三者都没有才抛错。宿主 0.2.3 两个方法都在，所以本版把 `hostCompatibility`（`connection-fence-cordis42-v1`）从 manifest 里**撤掉**，官方 tgz 原样进包，也不再生成 `dsh-host-compatibility.json`。补丁代码保留在仓库里，因为 0.32.1 那份 tgz 仍作为回归夹具、单测继续跑。

对旧宿主仍按原规则拦：`requestRejection` 存在时照旧校验，语义没有放松。

### 其它两处细节

- **`dsh-context` 0.87.2**：客户端注入新增 `@deepseek-ai/dsh-api-remotes` 与 `@deepseek-ai/dsh-client-connection`，宿主 0.2.3 两个模块都在；`engines.dsh` 仍是 `>=0.2.0-rc.2 || >=0.2.1-rc.2 || >=0.2.2-rc.1`。
- **`dsh-connect-workbuddy` 5.32.2**：`@earendil-works/pi-ai` 的 peer 范围与 5.24.17 相同（`>=0.85.0 <0.88.0 || >=1.0.0-0 <2.0.0`），隔离运行时锁里的 `pi-ai 1.3.0` 继续满足，锁不重建；`@deepseek-ai/schemastery 3.19.0` 这条依赖从 5.24.17 起就有，物化路径不变。
- **依赖**：`ws` 8.22.1 → **8.23.0**（侧边栏 `^8.18.0` 范围内取当前最新）；`zod` 4.6.7、`yaml` 2.9.1 未变。

`dsh-better-sidebar` 0.33.0 的 `engines.dsh` 是 `>=0.2.2-rc.3 <0.3.0`，宿主按 `includePrerelease` 口径判定通过，不需要版本豁免。

### 版本对照

| | 上一版 0.2.30 | 本版 __VERSION__ |
| --- | --- | --- |
| 内置 DSH | 0.2.3-alpha.2 | 0.2.3-alpha.2（未变） |
| 桌面补丁 | 39 文件 | 39 文件（未变） |
| `dsh-webops-plugin` | 0.2.30 | **__VERSION__** |
| `dsh-context` | 0.86.0 | **0.87.2** |
| `dsh-better-sidebar` | 0.32.1（+宿主补丁） | **0.33.0**（无补丁） |
| `dsh-connect-workbuddy` | 5.24.17 | **5.32.2** |
| `dsh-coding-subscription-oauth` | 0.8.8 | 0.8.8（未变） |
| `ws`（随包依赖） | 8.22.1 | **8.23.0** |

随包插件的 peer 在宿主的 `includePrerelease` 口径下均覆盖当前运行时，因此不跟升；实际是否激活以界面为准。`dsh-coding-subscription-oauth` 仍靠 `dsh-0.2.3-compat-v1`（内联 `assertUsableApiKey`、`root` 走 `Symbol.for("cordis.root")`）活着 —— 上游尚未发适配版。

### 登记机制（自 0.2.29 起）

- **出厂 profile 登记**：`home/profiles/desktop/package.json` 里本插件一项是 `"file:../../../vendor/__PLUGIN_TGZ__"`；第三方随包插件仍在 npm 上，保持精确版本登记。
- **包内携带**：便携包根 `vendor\__PLUGIN_TGZ__`（不可变 tarball）。profile 里那条相对路径就是指向它，**这个文件不要删**。
- 为什么不用精确版本号：宿主的「安装插件」就是 profile 目录里的 `pnpm add <spec>`，会全量解析 `dependencies`；本插件从未发布到 npm registry，写精确版本会让任何一次安装其它插件都 404。

### 升级须知

- **只换插件也建议换整包**：本版宿主未变，理论上覆盖插件目录即可；但完整包含全部新插件，省去逐个核对。已有会话、凭据请先备份。
- **tgz 不在独立插件 ZIP 里**：它是 Release 的独立附件，要单独下载。只下 ZIP 的用户请先下载 `__PLUGIN_TGZ__` 放到包根 `vendor\`。
- 完整便携包会替换 `home` 的出厂内容；已有会话、凭据请先备份。

### 更新已有安装

完全退出 DSH，按需选择：

1. **换整包（推荐）**：备份现有 `home\`（会话 / 设置 / 凭据都在里面）→ 下载 `__PORTABLE_ZIP__` 解压到新目录 → 把备份的 `home\`、`data\` 拷进新包根目录（目录契约不变）。
2. **只换插件**：把包里 `home\profiles\desktop\node_modules\` 下的 `dsh-context`、`dsh-better-sidebar`、`dsh-connect-workbuddy` 三个目录覆盖到现有安装的同名位置，同时更新 `home\profiles\desktop\package.json` 里对应的三个版本号；`dsh-better-sidebar` 目录里的 `dsh-host-compatibility.json` 可以删掉（0.33.0 不再需要）。
3. 启动后核对设置页插件版本与本版一致，并实际用一次侧边栏与网页工具。

独立插件 ZIP 仍然提供，但**只适用于宿主已经是 `__DSH_VERSION__` 的安装**：完全退出 DSH，把包内文件覆盖到 `home/profiles/desktop/node_modules/dsh-webops-plugin/`（包根目录是插件内容，不能直接解压到便携版根目录），重启后核对 `package.json` 的 version。它**不能单独完成升级**。

首次安装下载 `__PORTABLE_ZIP__`，解压后双击启动.cmd；内置本次插件、dsh-context、dsh-better-sidebar、dsh-connect-workbuddy 与 dsh-coding-subscription-oauth 五个插件。DSH 本体版本为 __DSH_VERSION__，插件版本为 __VERSION__。公开包不含任何模型 provider 与 API Key，也不含凭据或会话数据。

每次发布都提供完整便携包；插件包只用于 peer 匹配的同宿主更新。其他宿主版本的兼容性以实测为准。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| __PLUGIN_TGZ__ | __PLUGIN_TGZ_KB__ KB | __PLUGIN_TGZ_SHA__ |
| __PLUGIN_ZIP__ | __PLUGIN_KB__ KB | __PLUGIN_SHA__ |
| __PORTABLE_ZIP__ | __PORTABLE_KB__ KB | __PORTABLE_SHA__ |
