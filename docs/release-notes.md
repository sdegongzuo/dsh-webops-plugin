## dsh-webops-plugin __TAG__ · DSH 本体升到 0.2.3-alpha.2（宿主协议 v5）

本版只升本体与桌面补丁，**插件自身代码未改**。DSH 从 `0.2.2-rc.5` 跨 minor 升到 `0.2.3-alpha.2`（相隔 2348 个提交），桌面补丁在新基线上重做，从 43 文件缩到 39。

### 本体升级带来的变化

- **宿主协议 v4 → v5**：桌面端与宿主之间新增 `parent-authentication` 通道，认证凭据改由父进程经 IPC 下发（`dsh-desktop-session`，32 字节 secret），**取消了原来的 `303 + set-cookie` 交换流程**。
- **回环地址硬固定 `127.0.0.1`**：上游 `isOwnedHostUrl` 不再接受 `localhost` / `[::1]`。这一改动的代价是：若系统代理或终端策略只放通 `localhost` 而不放通 `127.0.0.1`，界面会停在「重新连接中…」。本版按上游实现，不再自行兜底 —— 遇到请反馈。
- **跨栈回环兜底整套退役**（补丁少掉的 4 个文件）：`web-document.ts` 里的 `WebHostProbe` / `exchangeProbe` / `jarProbe`、`main.ts` 里的候选名轮换与探测 cookie 清理，以及三处对应测试。它们探测的正是上游已删除的交换流程，留着只会对着新协议假失败。
- **便携临时目录保留逻辑重接**：`packages/spill`、`packages/subprocess` 跟着上游重构改写法 —— `DSH_TEMP_DIR` 存在时保留目录，退出不 `rmdir` 包内验证与恢复文件。
- 依赖线：`cordis` 4.1.0 → **4.2.0-alpha.1**，`schemastery` 3.19.0 → **3.20.0-alpha.1**。
- 构建宿主 Node 下限抬到 `^24.22.3 || >=26.13.1`（上游全部 CI 工作流钉 `^24.22.3`）。

### 插件侧

- 三个 DSH peer 精确对齐新运行时：`@deepseek-ai/dsh-attachment`、`dsh-system-prompt`、`dsh-tools` 均为 `^0.2.3-alpha.2`；`cordis ^4.2.0-alpha.1`、`schemastery ^3.20.0-alpha.1`。
- 0.2.29 → **0.2.30** 仅为对齐新宿主，功能与上一版一致（网页审计、使用中回看、`open` 复用本对话标签等照旧）。

### 随包插件的两处宿主适配（物化阶段，官方 tgz 不改）

0.2.3 删掉了两个第三方插件正在用的宿主 API。两者都是**静默失效**：宿主照常启动、界面照常打开，只是功能不见了。官方包不改，物化阶段就地补，判据是精确文本必须恰好命中一次，插件换了写法直接拒绝打包。

- **`dsh-coding-subscription-oauth` 0.8.8（Grok 订阅）**：`dsh-llm` 删除了 `assertUsableApiKey` / `normalizeApiKey` 导出，插件的静态 import 让整层导入失败（设置页少「账户与模型」卡片）。补丁把 import 改指仍在导出的 `LlmError` 与 `INVALID_CREDENTIAL_CODE`，并在文件内联等价实现（trim 后非空、只含可打印 ASCII，否则抛同码 `LlmError`）；调用点一个不动。另：cordis 4.2 拦截未声明 inject 的 `ctx.root`，插件取应用根上下文处改按 `Symbol.for("cordis.root")`（cordis 的自有属性）读取。
- **`dsh-better-sidebar` 0.32.1**：`connection.requestRejection` 被删除，准入搬进了 webserver 的 admission，于是插件的栅栏每次调用都抛 TypeError，被宿主兜底成 **400 空 body** —— 侧边栏接口全废而界面看着正常。补丁把栅栏改成「该方法存在就照旧校验，不存在就交给宿主」；宿主对未声明 `auth` 的路由默认 `required`，认证准入没有放松。

这两处都是**跟着上游临时补**：插件发布新版后补丁会因判据失配而拒绝打包（不是静默跳过），届时核对新写法再决定是否保留。

### 版本对照

| | 上一版 0.2.29 | 本版 __VERSION__ |
| --- | --- | --- |
| 内置 DSH | 0.2.2-rc.5 | **0.2.3-alpha.2** |
| 宿主协议 | v4 | **v5** |
| 桌面补丁 | 43 文件 | **39 文件**（4 个回环文件退役） |
| `cordis` | 4.1.0 | **4.2.0-alpha.1** |
| `schemastery` | 3.19.0 | **3.20.0-alpha.1** |
| 构建宿主 Node | 24.9+ | **^24.22.3 \|\| >=26.13.1** |
| `dsh-webops-plugin` | 0.2.29 | **__VERSION__** |
| `dsh-context` | 0.86.0 | 0.86.0（未变） |
| `dsh-better-sidebar` | 0.32.1 | 0.32.1（未变） |
| `dsh-connect-workbuddy` | 5.24.17 | 5.24.17（未变） |
| `dsh-coding-subscription-oauth` | 0.8.8 | 0.8.8（未变） |

随包四个第三方插件的 peer 在宿主的 `includePrerelease` 口径下均覆盖新版本，因此不跟升；实际是否激活以界面为准。

### 登记机制（自 0.2.29 起）

- **出厂 profile 登记**：`home/profiles/desktop/package.json` 里本插件一项是 `"file:../../../vendor/__PLUGIN_TGZ__"`；第三方随包插件仍在 npm 上，保持精确版本登记。
- **包内携带**：便携包根 `vendor\__PLUGIN_TGZ__`（不可变 tarball）。profile 里那条相对路径就是指向它，**这个文件不要删**。
- 为什么不用精确版本号：宿主的「安装插件」就是 profile 目录里的 `pnpm add <spec>`，会全量解析 `dependencies`；本插件从未发布到 npm registry，写精确版本会让任何一次安装其它插件都 404。

### 升级须知

- **跨 minor 升级，必须换整包**：只覆盖插件目录会让新插件对着旧宿主（协议 v4）跑，peer 也不匹配。请下载完整便携包。
- **tgz 不在独立插件 ZIP 里**：它是 Release 的独立附件，要单独下载。只下 ZIP 的用户请先下载 `__PLUGIN_TGZ__` 放到包根 `vendor\`。
- 完整便携包会替换 `home` 的出厂内容；已有会话、凭据请先备份。

### 更新已有安装

1. 完全退出 DSH，备份现有 `home\`（会话 / 设置 / 凭据都在里面）。
2. 下载 `__PORTABLE_ZIP__` 解压到新目录。
3. 把备份的 `home\`、`data\` 拷进新包根目录（目录契约不变）。注意这会把旧 `home` 里的插件目录一起带回来（版本仍是旧的），下一步补。
4. 补齐本版插件与登记：
   - 把 `__PLUGIN_TGZ__` 放进包根 `vendor\`（完整包已自带），并**删掉旧的插件目录** `vendor\dsh-webops-plugin\`（若曾以目录形式登记，与 tgz 并存会冲突）；
   - 用新包自带的 `home\profiles\desktop\node_modules\dsh-webops-plugin\` 覆盖回去（或解压 `__PLUGIN_ZIP__` 覆盖）；
   - 把 `home\profiles\desktop\package.json` 里 `dependencies.dsh-webops-plugin` **这一个键**改成 `"file:../../../vendor/__PLUGIN_TGZ__"`。不要整块替换 `dependencies` —— 那会抹掉你自己装过的其它插件；
   - 删掉 `home\profiles\desktop\pnpm-lock.yaml`（可能还记着旧的本地路径），下次安装时按新登记重生成。
5. 启动后核对设置页版本为 `__DSH_VERSION__`、插件版本为 `__VERSION__`，并实际调一次网页工具。

独立插件 ZIP 仍然提供，但**只适用于宿主已经是 `__DSH_VERSION__` 的安装**：完全退出 DSH，把包内文件覆盖到 `home/profiles/desktop/node_modules/dsh-webops-plugin/`（包根目录是插件内容，不能直接解压到便携版根目录），重启后核对 `package.json` 的 version。它**不能单独完成升级**。

首次安装下载 `__PORTABLE_ZIP__`，解压后双击启动.cmd；内置本次插件、dsh-context、dsh-better-sidebar、dsh-connect-workbuddy 与 dsh-coding-subscription-oauth 五个插件。DSH 本体版本为 __DSH_VERSION__，插件版本为 __VERSION__。公开包不含任何模型 provider 与 API Key，也不含凭据或会话数据。

每次发布都提供完整便携包；插件包只用于 peer 匹配的同宿主更新。其他宿主版本的兼容性以实测为准。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| __PLUGIN_TGZ__ | __PLUGIN_TGZ_KB__ KB | __PLUGIN_TGZ_SHA__ |
| __PLUGIN_ZIP__ | __PLUGIN_KB__ KB | __PLUGIN_SHA__ |
| __PORTABLE_ZIP__ | __PORTABLE_KB__ KB | __PORTABLE_SHA__ |
