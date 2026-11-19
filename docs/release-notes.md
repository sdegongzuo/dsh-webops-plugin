## dsh-webops-plugin __TAG__ · 网页访问审计、open 复用本对话标签、Grok 插件换包

本版改插件功能与随包插件；**DSH 本体与桌面补丁未变**（仍是 `0.2.2-rc.5` 与 `2dcbc7c1…`，43 文件逐字节复用）。同时沿用上一版起的登记机制：本插件以不可变 tarball 出厂，profile 用 `file:` 相对路径指向它。

### 插件新功能

- **网页访问事后审计**（`pnpm audit:webpage`）：读 `home/sessions` 下的会话日志（多帧拼接 zstd，按帧扫描后逐帧解压），抽出 `webpage_*` 调用，生成自包含 HTML + JSON。「确认访问」只认成功回执头部自报的地址，失败调用的参数 `url` 单独标「目标」，两者不合并计数 —— 一个地址被尝试过不等于被访问过。真实日志实跑：21 会话 / 70 次调用 / 12 个确认地址 / 8 次失败。崩溃写断的末帧用 `ZSTD_e_flush` 救回前缀完整行，不吐半截 JSON。
- **使用中回看**：网页面板新增「访问过 N 个页面」区块，按 URL 去重，失败行标红并注明「目标 / 未确认到达」。数据全部从对话快照派生，零新增 RPC；头部改成与对话里「任务 N 已完成」同构的单行 disclosure。
- **`open` 复用本对话已有标签**：按「空闲同址领取 → 复用本对话自有标签 → 新建」三档决定落点。档 2 返回同一个 `session_id`，只认同一 `ownerId`，人工接管与弹窗家族成员一律回落新建。`reuseOwnTabOnOpen` 默认 `true`，留了一条关掉即回到旧行为的路。

### 顺带修掉的既有缺陷

- `open` 成功后不清 snapshot / find 缓存：复用标签时会留着上一纪元的旧大纲，新 owner 可越过「先快照」直接检索别人的页面内容。
- 占位文案 `(empty — the document sets no <title>…)` 被当成页面标题 —— 真实会话 9 次确认访问里 8 次中招。
- `collectSessionFiles` 跳过裸 uuid 目录，漏掉子 agent 会话。

### 随包 Grok 插件换包

`dsh-llm-xai-oauth@0.3.1` → `dsh-coding-subscription-oauth@0.8.8`：注册 `grok-build` 路由，不与原生 xai 抢路由（可并存），客户端含「账户与模型」设置卡片，`engines.dsh` 覆盖 `0.2.2-rc.5`。

换包带出两处必须一起处理的问题：

- 插件自带 bundle patch 写死 `agent-default-model: grok-build / grok-4.6`，而 bundle patch 组合顺序在 profile patch 之前 —— 出厂 patch 即使不写模型也会带上，违反「出厂不预置 provider」策略。物化阶段按 `strip-preset-default-model-v1` 剥除该段、保留挂载行；判据是精确文本出现且仅出现一次，上游换写法直接拒绝。剥除改为 **fail-closed**：命中 0 次但检测到 `- id: agent-default-model` 或 `provider: grok-build` 时抛错，不再"什么都没改"就放行。
- 插件把 `GROK_CLIENT_VERSION` 写死 `0.1.220`，上游已要求 `1.0.13+`，不覆盖则真实对话返回 426。启动器已注入 `GROK_BUILD_CLIENT_VERSION=1.0.13`。

### 打包与启动器

- **出厂代理**：设置 `DSH_FACTORY_PROXY` 时才在包根写 `proxy.txt`（第一行一个完整代理 URL），未设置不产生文件；只接受 `http/https` + `host:port`，拒绝 query / hash / 路径，**带账号密码直接报错**（否则凭据会明文落盘、随 zip 分发）。启动器启动前回显 `[dsh] proxy: <地址>`，换机换端口时看得出实际用的是哪个代理。
- **出厂默认模型注入**收紧了构建期校验：`DSH_FACTORY_DEFAULT_MODEL=xai`（缺 model 段）或 `xai/grok-4.7/`（尾随斜杠）原本会写出字面量 `undefined` / 空 `reasoningEffort`，要到运行时请求失败才暴露，现在构建期直接报错。门禁也改成正向断言：设置变量时逐项核对注入块字段，不只做"没有预置模型"的反向检查。
- **公开包两者都不设**：不含任何模型 provider 与 API Key，首次使用请在「设置 → 模型」添加自己的提供商。

### 版本对照

| | 上一版 0.2.28 | 本版 __VERSION__ |
| --- | --- | --- |
| 内置 DSH | 0.2.2-rc.5 | 0.2.2-rc.5（未变） |
| 桌面补丁 | `2dcbc7c1…`（43 文件） | `2dcbc7c1…`（逐字节复用） |
| `dsh-webops-plugin` | 0.2.28 | **__VERSION__** |
| `dsh-context` | 0.86.0 | 0.86.0（未变） |
| `dsh-better-sidebar` | 0.32.1 | 0.32.1（未变） |
| `dsh-connect-workbuddy` | 5.24.17 | 5.24.17（未变） |
| Grok 插件 | `dsh-llm-xai-oauth@0.3.1` | **`dsh-coding-subscription-oauth@0.8.8`** |

### 登记机制（自 0.2.29 起）

- **出厂 profile 登记**：`home/profiles/desktop/package.json` 里本插件一项是 `"file:../../../vendor/__PLUGIN_TGZ__"`；第三方随包插件仍在 npm 上，保持精确版本登记。
- **包内携带**：便携包根 `vendor\__PLUGIN_TGZ__`（不可变 tarball）。profile 里那条相对路径就是指向它，**这个文件不要删**。
- 为什么不用精确版本号：宿主的「安装插件」就是 profile 目录里的 `pnpm add <spec>`，会全量解析 `dependencies`；本插件从未发布到 npm registry，写精确版本会让任何一次安装其它插件都 404。
- 打包门禁已断言「包内有这份 tarball」且「登记必须是那条 `file:` 相对路径」，写错版本或漏带 tgz 直接出不了包。

### 升级须知

- **从 0.2.28 及更早升级（重要）**：只覆盖 `node_modules\dsh-webops-plugin\` 能让当前版本正常启动（宿主启动时不跑包管理），但 profile 里那条精确版本登记还在 —— 下次在桌面端安装其它插件时仍会 404。必须同时放 tgz 并改登记（见下方第 4 步）。
- **Grok 插件换了包名**：`dsh-llm-xai-oauth` 已不再随包。继续用旧插件不影响本插件功能，但拿不到新路由与「账户与模型」卡片；要换就把 `dependencies` 里那一个键改成 `"dsh-coding-subscription-oauth": "0.8.8"`，并把 `dsh.profile.bundles` 里的同名条目一起换掉。
- **tgz 不在独立插件 ZIP 里**：它是 Release 的独立附件，要单独下载。只下 ZIP 的用户请先下载 `__PLUGIN_TGZ__` 放到包根 `vendor\`，否则登记指向的文件不存在，比原来的 404 更糟。
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

做完这一轮，后续在桌面端安装其它插件不会再因本插件 404；下次 `install_bundle` 也会按新 tgz 重新解析，不会把插件回滚成旧版。

独立插件 ZIP 仍然提供，但**只适用于宿主已经是 `__DSH_VERSION__` 的安装**：完全退出 DSH，把包内文件覆盖到 `home/profiles/desktop/node_modules/dsh-webops-plugin/`（包根目录是插件内容，不能直接解压到便携版根目录），重启后核对 `package.json` 的 version。它**不能单独完成升级** —— 同步 tgz 与登记这一步同样要做。

首次安装下载 `__PORTABLE_ZIP__`，解压后双击启动.cmd；内置本次插件、dsh-context、dsh-better-sidebar、dsh-connect-workbuddy 与 dsh-coding-subscription-oauth 五个插件。DSH 本体版本为 __DSH_VERSION__，插件版本为 __VERSION__。公开包不含任何模型 provider 与 API Key，也不含凭据或会话数据。

每次发布都提供完整便携包；插件包只用于 peer 匹配的同宿主更新。其他宿主版本的兼容性以实测为准。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| __PLUGIN_TGZ__ | __PLUGIN_TGZ_KB__ KB | __PLUGIN_TGZ_SHA__ |
| __PLUGIN_ZIP__ | __PLUGIN_KB__ KB | __PLUGIN_SHA__ |
| __PORTABLE_ZIP__ | __PORTABLE_KB__ KB | __PORTABLE_SHA__ |
