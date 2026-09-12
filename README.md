# dsh-browser-plugin

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加**浏览器调试与操作**能力的插件。
能力形态对齐 [Minke](https://github.com/lencx/minke) 的 Agent Browser：模型可以打开页面、读取页面大纲、
按 ref 定位并操作元素、采集控制台与网络活动，并支持人工接管。

这是一个 **out-of-tree bundle**：不修改 deepseek-harness 仓库的任何文件，靠自己的 `cordis.patch.yml`
把插件行插进目标 profile。

> 完整设计（Minke 能力基线、dsh 插件机制、分阶段落地、风险与备选方案）见
> `D:\dev\cli\deepseek-harness\.workbuddy\design-browser-plugin.md`。

---

## 状态

**P0（只读）已实现并通过验收。** 模型现在能「看」页面：开标签页、跳转、读可访问性大纲（带 ref）、截图。
四个工具已在真实 profile 上确认进入 agent 的工具视图，不只是配置上插上了（见「接线」一节的实跑验证）。

**桌面端已接入并跑通。** 在**开发态桌面端**（Electron）里实跑通过：host 半边四个面全部加载、客户端半边加载并执行、
观察面板渲染在输入框上方（输入框上方那行「浏览器 · 已就绪」）。见「桌面端接入」一节。

**桌面端里的浏览器窗口是桌面端自己的 Electron 窗口。** 第二个 provider `browser-electron` 让 host 进程
spawn 一个窗口宿主，开真正的 `BrowserWindow`，用它的 `webContents.debugger` 走同一套 CDP 命令。
实测：在**正在运行的桌面端 host 进程里**开出了窗口、跳转、27 个 ref 的大纲、207 KB 截图
（`pnpm run window:desktop`）。见「桌面端：开 Electron 窗口」一节。

![桌面端里的浏览器面板](docs/desktop-dock.png)

| 阶段 | 内容 |
|---|---|
| **P0 只读** ← 已完成 | `ctx.browser` + `browser-cdp` 的 connect / open / navigate / snapshot / screenshot + 4 个只读工具 + ref 纪元 |
| **UI 观察面板** ← 已完成 | `conversation.input.dock` 常驻状态条（含无活动时的「已就绪」态）+ `tool.call.toolview` 四个专属卡片（地址 / 大纲 / 截图） |
| **Electron 窗口 provider** ← 已完成 | `browser-electron`：spawn 窗口宿主 → 真 `BrowserWindow` → `webContents.debugger` 驱动；桌面端默认用它 |
| P1 操作 | click / fill / press / scroll / wait + 能力分级 + `stale_ref` 恢复 |
| P2 调试 | console / network 采集 + 受限 `browser_execute` + 进度策略 |
| P3 协作 | 人工接管 / 回收 + `browser_find` / `browser_locate` |

### 用法（三步）

```bash
# 1) 起一个带调试端口的 Chrome。必须用**独立的 user-data-dir**，
#    否则会复用你日常那个 Chrome 实例，而它不会开调试端口。
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --remote-debugging-port=9333 --user-data-dir="%TEMP%\dsh-cdp-profile"

# 2) 启动 dsh（探针 profile 里已经 link 了本仓，改完源码不必重新 add）
cd /d/dev/cli/deepseek-harness
pnpm dsh --profile browserp0

# 3) 让模型做事，例如：
#    browser_open { "url": "https://example.com" }  → 返回 session_id
#    browser_snapshot { "session_id": "…" }         → 大纲 + ref
#    browser_screenshot { "session_id": "…" }       → 存成 attachment
```

> **端口别用 9222。** 本机 9222 被 dsh 桌面端开发态的 Electron renderer 调试端口占着
> （见「踩过的坑」第 3 条），此时插件会连上那个 Electron 而不是 Chrome，`/json/new` 直接 500。
> 换一个端口（上例用 9333）即可。

## 结构

```
cordis.patch.yml        bundle 的配置层：把五行插进 profile（见下）
package.json            声明 dsh.bundle.patch、dsh.client（客户端双面）、多入口导出
tsdown.config.ts        两条独立产物：host 四面 + 包根（ESM）/ 客户端 bundle（CJS，外裹 __ModuleLoader__）
src/index.ts            包根的 host 半边：**故意是空的**，只为让客户端半边被发现（见「桌面端接入」的坑）
src/debug.ts            加载诊断（写 stdout，桌面端才看得见）
src/browser/            Service Definition —— ctx.browser 服务、provider 选择语义、错误类型
  index.ts                BrowserRuntime（Service）+ DSH_BROWSER_PROVIDER 兜底
  types.ts                会话 / 观察请求 / 错误码
src/browser-cdp/        provider —— 通过 CDP 驱动**外部 Chrome**
  index.ts                插件入口：注册 provider + 卸载时释放资源
  provider.ts             CdpBrowserProvider：会话生命周期、四条操作、截图裁剪
  protocol.ts             CDP 传输层：/json/* HTTP 端点 + WebSocket 命令通道
  refs.ts                 ref 纪元状态机（P0 的核心语义）
  snapshot.ts             可访问性树 → 紧凑大纲 + ref 候选（纯函数）
  url-policy.ts           地址策略：只许 HTTP(S)、禁内嵌凭据、端点是回环
  live.test.ts            对着真实 Chrome 跑的验收测试（没有调试端口时自动跳过）
src/browser-electron/   provider —— 开**桌面端自己的 Electron 窗口**
  index.ts                插件入口：注册 provider（`electron`）+ 启用闸
  provider.ts             ElectronBrowserProvider：复用 CdpBrowserProvider，只换传输层
  bridge.ts               spawn Electron 宿主 + TCP JSON Lines 通道（可注入，单测替换）
  socket.ts               把「桥上的一个窗口」包成 CdpSocket，喂给现成的 CdpConnection
  transport.ts            桥 ↔ CdpTransport 的翻译；句柄 scheme `electron-window://`
  host.cjs                **被 spawn 的 Electron 应用入口**：BrowserWindow + webContents.debugger
  index.test.ts           假通道下的单测（真机行为归 smoke:window）
src/tool-browser/       工具消费者 —— 把能力暴露成 browser_* 工具给模型
  index.ts                browser_open / navigate / snapshot / screenshot + 系统提示分段
src/client/             浏览器半边（dsh.client）
  index.ts                注册两个 slot 面：conversation.input.dock 与 tool.call.toolview
  BrowserDock.tsx         常驻状态条（无活动时显示「已就绪」）
  BrowserToolRow.tsx      四个工具的专属卡片（地址 / 大纲 / 截图）
  observation.ts          从对话快照派生面板状态（纯函数，不 import dsh 客户端类型）
  locales.ts              中英文案
scripts/dev-desktop.mjs   开发态装配进桌面端 profile 并拉起 Electron
scripts/check-desktop.mjs 用 CDP 断言桌面端接入的五项事实
scripts/shot-desktop.mjs  截一张真实桌面端的 PNG
```

为什么不分三个包：官方把能力拆成 `<capability>` / provider / `tool-<cap>` 三包，是为「能力可组合」
（换 provider 不用换工具层）。个人插件不需要这份弹性，单包多入口即可。


## 接进 dsh

### 为什么做成独立仓

| 证据 | 内容 |
|---|---|
| `CONTRIBUTING.md` | 「we cannot accept external pull requests at the moment」——官方现阶段**不收外部 PR** |
| GitHub API | 当前账号对 `deepseek-ai/deepseek-harness` 的权限是 `push: false` |
| `CONTRIBUTING.md` | 官方明确鼓励社区插件：独立建仓 + 给项目打 **`dsh-plugin`** topic 供他人发现 |

往官方仓库 `packages/` 里加代码，只会沉淀成一份永远无法提交的本地工作区——而
`packages/bundle/*/cordis.patch.yml` 与 preset 恰恰是上游每次 release 都会改动的文件，下轮拉取必冲突。

### 开发期

两个方向要通，方向不同、手段不同。

**① 插件仓 → 依赖 dsh 的包**（已配好，`pnpm install` 即可）。

`package.json` 用 pnpm 的 `link:` 协议直接指向本地 checkout，不查 registry：

```json
"@deepseek-ai/cordis": "link:../deepseek-harness/vendor/cordis",
"@deepseek-ai/dsh-tools": "link:../deepseek-harness/packages/core/tools",
"@deepseek-ai/dsh-subprocess": "link:../deepseek-harness/packages/subprocess/subprocess",
"@deepseek-ai/schemastery": "link:../deepseek-harness/vendor/schemastery"
```

这既是绕开 npm 旧版的唯一可行手段（见下节），也让 `pnpm typecheck` 开箱可用。
`link:` 写死了本地相对路径，**发布前要换回 peerDependencies + npm 版本号**。

**② dsh → 加载本插件**（已实测通过）。

一行命令，用官方的 `dsh plugin` 把 checkout link 进 profile：

```bash
cd /d/dev/cli/deepseek-harness
pnpm dsh plugin --profile browserp0 add D:/dev/cli/dsh-browser-plugin
```

它初始化 profile（不存在时）、pnpm link 本目录、并把 `dsh-browser-plugin` 追加进 profile 的
`dsh.profile.bundles`。实测 5 秒完成：

```
dsh: initialized profile browserp0 at C:\Users\yemaf\.dsh\profiles\browserp0
+ dsh-browser-plugin link:D:/dev/cli/dsh-browser-plugin
```

验证层序（应出现 `# == dsh-browser-plugin` 层与五行）：

```bash
pnpm dsh --profile browserp0 --dump-config | grep -A4 "== dsh-browser-plugin"
```

**不需要 junction，也不需要改 dsh 的 `pnpm-workspace.yaml`**——`dsh plugin add` 自己完成了包名解析
所需的那一步。本仓的 `link:` 依赖只负责反方向（插件仓 import 得到 dsh 的包）。

> 已实测：三个入口都能被 dsh 的 tsx 模式加载（`browser` / `browser-cdp` / `tool-browser`），
> 所以 `exports` 指向 `src/*.ts` 源码是可行的。

### 生产期

```sh
dsh plugin --profile <name> add D:\dev\cli\dsh-browser-plugin   # 本地目录
dsh plugin --profile <name> add github:sdegongzuo/dsh-browser-plugin#<sha>  # git（需 prepare + allowBuilds）
```

> git 安装需要本仓提供 self-contained 的 `prepare` 脚本，且用户要在 profile 的 `pnpm-workspace.yaml`
> 里 `allowBuilds: { dsh-browser-plugin: true }`。详见官方 `publish.md`。**待 P0 期间实测**。

### 桌面端另有硬约束（重要，别把两件事混在一起做）

桌面端启动前会跑 `apps/desktop/src/profile-packages.ts` 的 `validateDesktopPluginGraph`，它对
profile 里的插件做四类断言，**每一条都与开发期的 `link:` 路线冲突**：

| 断言（源码位置） | 含义 | 对本仓的影响 |
|---|---|---|
| `linked private package` | profile 的 `node_modules` 下出现 symlink 即拒 | `dsh plugin add` 产生的正是 symlink → **桌面端不吃这条路** |
| `package resolves outside profile` | 依赖闭包必须物理位于 profile 目录内 | 本仓在 `D:\dev\cli\dsh-browser-plugin` → 必须 vendor 一份副本进去 |
| `must declare <host 包> as a peer dependency` | dsh 的共享包只能出现在 `peerDependencies`，出现在 `dependencies` 直接报错 | 本仓现在把 dsh 包放在 `devDependencies` + `link:` → 桌面端会拒 |
| `requires <name>@<range>, found <version>` | peer 版本必须满足范围 | 要跟桌面端 runtime 里的版本对齐 |

结论：桌面端要的是**另一套形态**（真实文件副本 + `peerDependencies` 声明 + 版本对齐）。本仓已经出好这一套，
接入方式见下面的「桌面端接入」小节。桌面端开发态的 `$DSH_HOME` 是
`apps/desktop/.desktop-build/development/home`，profile 是 `apps/desktop/.desktop-build/development/project`。

### 桌面端接入（已打通，三条命令）

```bash
pnpm run build          # 产出 lib/（桌面端只吃构建产物，src/ 不进去）
pnpm run dev:desktop    # 装配进开发态 profile 并拉起 Electron（含 --build 可先跑 dsh 的构建）
pnpm run check:desktop  # 从外部用 CDP 断言「host 认了 / 客户端跑了 / 面板渲染了 / 卡片注册了」
pnpm run shot:desktop   # 截一张真实桌面端的 PNG（docs/desktop-dock.png）
pnpm run window:desktop # 让桌面端 host 进程自己开一个 Electron 窗口（端到端证据）
```

开发态**装插件是被硬禁的**（`apps/desktop/src/main.ts` 里 `plugin package changes require a packaged
application`，且 `plugin-add` 只收 npm registry 形态的 spec），而且 `apps/desktop/scripts/dev.ts` 每次启动都会用
`prepareDevelopmentProject` **整目录重建** `project/`。所以 `scripts/dev-desktop.mjs` 复刻了 dev.ts 的启动序列，
只在中间插一步装配（真实目录复制，不是链接），并且从 dsh 源码直接 import 它的
`prepareDevelopmentProject` / `DESKTOP_HOST_PROTOCOL_VERSION`，**不改动 deepseek-harness 里任何文件**。

#### 这里踩到的坑：客户端行必须是**裸包名**

四个 patch 行里，前三个（`dsh-browser-plugin/browser` 等）负责能力，第四个是**裸包名** `dsh-browser-plugin`，
它的 host 半边是空实现（`src/index.ts`）。原因在 dsh 的
`packages/client/modules/src/index.ts#locatePkgJson()`：它先调 `exactPackageSpecifier(name)` 取包名，而该函数对
**非 scoped 且带 `/`** 的 specifier 直接返回 `undefined`，于是整行被判为「永久不是客户端行」，永远不会去读
`dsh.client` 与 `exports["./client"]`。

也就是说：**带子路径的 host 行不可能带上客户端半边**，客户端两面必须挂在一个裸包名行上。
dsh 自己的纯客户端包（如 `dsh-client-ui-brand-official`）就是这个形态——注释里写得很直白：
「The empty apply gives Loader a host-side row while the browser half ships through exports["./client"]」。

#### 另一个坑：桌面端把 host 的 stderr 吞了

`apps/desktop/src/host-process.ts` 把子进程 stderr 攒在内存里，只在失败时随错误抛出；stdout 才 `pipe` 到
Electron 的 stdout。所以 `src/debug.ts` 的加载诊断**必须写 stdout**——写 stderr 等于什么都没写。
`DSH_BROWSER_PLUGIN_DEBUG=1`（`dev-desktop.mjs` 默认打开）时能看到：

```
[dsh-browser-plugin] root: client row registered
[dsh-browser-plugin] browser-cdp: endpoint=http://127.0.0.1:9333
[dsh-browser-plugin] browser-electron: enabled=true electron=…/electron/dist/electron.exe
[dsh-browser-plugin] tool-browser: registered open, navigate, snapshot, screenshot
```

---

## 桌面端：开 Electron 窗口（`browser-electron`）

![桌面端 host 进程开出的 Electron 窗口](docs/window-electron.png)

### 为什么还需要第二个 provider

`browser-cdp` 连的是**外部** Chrome 的调试端口。桌面端里这条路是死的：

- 桌面端自己的 `--remote-debugging-port`（开发态 9222）就是**它自己的渲染进程**；
- 内置 Chromium 不实现 `PUT /json/new`，实测回一句 `Could not create new page`；
- 桌面端 host 又跑在**纯 Node** 子进程里（`node.exe … dsh-desktop-host/lib/index.js`，不是 Electron），
  所以插件连 `BrowserWindow` 都拿不到，没法自己开窗口。

于是换一条路：host 进程 **spawn 一个 Electron 窗口宿主**（`src/browser-electron/host.cjs`），
窗口由它创建，插件继续用同一套 CDP 命令驱动 —— `Page.navigate` / `Runtime.evaluate` /
`Accessibility.getFullAXTree` / `Page.captureScreenshot` 一个都不用改。
`CdpBrowserProvider` 原样复用，只换传输层（`ElectronWindowTransport`）。

两个 provider 并列注册，用 `DSH_BROWSER_PROVIDER` 选（`dev:desktop` 默认 `electron`）：

| provider | id | 开的是什么 | 谁用 |
|---|---|---|---|
| `browser-cdp` | `cdp` | 外部 Chrome 的标签页 | CLI / 想接自己日常浏览器时 |
| `browser-electron` | `electron` | 真正的 `BrowserWindow` | 桌面端（默认） |

`browser-electron` **默认不参与 provider 选择**（`available()` 有一道启用闸）：不这样做，
`cdp`（端点活着）与 `electron`（二进制找得到）会同时「可用」，`browser` 服务就会
`BROWSER_PROVIDER_AMBIGUOUS`。

### 验证

```bash
pnpm run smoke:window    # 纯 Node 侧：直接驱动 provider 开窗口 → 大纲 → 截图
pnpm run window:desktop  # 端到端：让**正在运行的桌面端 host 进程**自己开窗口
```

`window:desktop` 的实测输出（host 进程就在桌面端里）：

```json
{
  "providerId": "electron",
  "enabled": true,
  "session": { "id": "w1", "url": "https://www.baidu.com/", "title": "百度一下，你就知道" },
  "snapshot": { "epoch": 1, "refs": 27, "chars": 3891 },
  "screenshotBytes": 207285
}
```

它靠桌面端 host 的 inspector（开发态 9230）注入：`Runtime.evaluate` 走
`process.getBuiltinModule('module').createRequire(...)` 把插件产物 require 进来
（inspector 里的 `import()` 会报 *A dynamic import callback was not specified*，
而 Node 22 的 `require()` 认 ESM）。

### 三个必须踩准的时机（全是实测，且都表现为「命令发出去永远不回」）

1. **通道用 TCP，不要用 stdio。** Electron（Windows）主进程的 `process.stdin` 会**立刻 EOF**，
   `on('end')` 一收尾就把 app 关了 —— 症状是「窗口刚建好就自己没了」。
   stdout 是通的，所以反向：宿主监听 `127.0.0.1:0`，把端口从 stdout 宣布。
2. **`debugger.attach()` 要等 `dom-ready`。** 窗口刚 `new` 出来就 attach，`Page.enable` 直接挂住。
3. **建窗口后必须显式 `loadURL()`。** 哪怕加载 `about:blank`：不加载就没有导航，
   `dom-ready` 永远不来，第 2 步就永远等不到。

另外 `CdpSocket` 的 `open` 事件必须是「下一个微任务」派发：`CdpConnection` 的构造是同步的，
`openSocket()` 要先把监听器挂上，派发早了它就错过了。

---
## 依赖版本约束（重要，实测）

| 包 | npm 上 | 本地 checkout | 用途 |
|---|---|---|---|
| `@deepseek-ai/cordis` | 4.0.2 | 4.0.2 | Service / 插件机制 |
| `@deepseek-ai/schemastery` | 3.18.2 | 3.18.2 | `Config` 校验 |
| `@deepseek-ai/dsh-tools` | **0.0.1-rc.1** | 0.1.5-rc.2 | `defineTool`、类型化参数/输出 |
| `@deepseek-ai/dsh-system-prompt` | **0.0.1-rc.1** | 0.1.5-rc.2 | 系统提示分段 |
| `@deepseek-ai/dsh-attachment` | **0.0.1-rc.1** | 0.1.5-rc.2 | 截图落盘（`ImageAttachmentRef`） |
| `@deepseek-ai/dsh-attachment-local` | **0.0.1-rc.1** | 0.1.5-rc.2 | 只在 live 测试里用真实存储 |
| `@deepseek-ai/dsh-subprocess` | **0.0.1-rc.1** | 0.1.5-rc.2 | **P0 未使用**，P1 起用来自动拉起浏览器 |

`@deepseek-ai/dsh-subprocess` 在 P0 里是**刻意留着不用的**：P0 的 provider 只连接用户自己开着的
Chrome，从不启动进程，所以「进程树回收」这一条在 P0 里没有对象可回收（见「验收」第 5 条）。

**dsh 自己的包不要从 registry 装。** 两条实测证据：

1. 版本落后 5 个 minor（`0.0.1-rc.1` vs `0.1.5-rc.2`），类型与接口都对不上。
2. npm 上的 dsh 生态**不完整**：直接 `pnpm install` 会因 `@deepseek-ai/dsh-type-meta` 404 而失败——
   这个包根本没发布。`.npmrc` 里的 `auto-install-peers=false` 挡不住这条链路。

所以 dsh 相关的包一律走 `link:` 指向本地 checkout。**不要**把它们改成 npm 版本号。

## 接线：全部落在 host 平面

`cordis.patch.yml` 的 `insert` 里有五行（前四条 host 行 + 一条裸包名客户端行），都在 host 平面：

| 行 | 说明 |
|---|---|
| `browser` | `ctx.browser` 能力服务，跨会话共享，不能按 preset 分叉 |
| `browser-cdp` | provider（外部 Chrome），注册进 `ctx.browser` |
| `browser-electron` | provider（桌面端自己的 Electron 窗口），默认不参与选择 |
| `tool-browser` | 模型可见的工具 |
| `dsh-browser-plugin`（裸包名） | host 半边是空实现，只为让浏览器那半边被客户端模块表发现；见「桌面端接入」里的坑 |

依据：host 平面的行在**所有** surface（TUI / headless / web / 桌面端）都会生效，除非该 surface 的 overlay
显式 `disabled: true`——这正是 `dsh-web-app` 必须写下 `disabled: true` 才能压掉 `tool-web` 的原因。

**已在源码层核实（不再是推断）**：agent 的 `tools` 视图按 scope 链解析——未加入 preset 的 agent
解析到「空的 global 层」而拿不到任何工具，已加入 preset 的 agent 则同时看到 global 层与 preset 层
（见 `.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md`）。
这正是 `dsh-web-app` 必须把 base 里**全部 16 个**工具行逐个 `disabled: true` 的原因：不压掉，
host 平面那份就会与 preset 那份一起进入 agent 的工具视图。

所以 host 平面 insert 对四种 surface 都成立：

| surface | base 的工具行 | 本插件的三行 |
|---|---|---|
| headless | 全部 enabled（该 bundle 不禁任何工具行） | enabled → agent 可见 |
| web / 桌面 | 被 `dsh-web-app` 逐个禁用，工具改由 preset 提供 | **不在禁用名单里** → enabled → agent 可见 |
| acp / sdk | 各自的 overlay 只禁 1 行，不涉及工具 | enabled → agent 可见 |

> 若将来上游把工具行整体搬进 preset 并同时禁用 host 平面的一切 `tool-*`，本节结论失效——
> 届时的退路是把该行搬进 `$DSH_HOME/.agent-presets/<preset>/agent.cordis.yml`（preset 是用户资产，可写）。

**已实跑验证（2026-09-12）**：`pnpm dsh --profile browserp0` 真起一次会话后，从会话日志
（`~/.dsh/sessions/<cwd 编码>/<session-id>/session.v3.jsonl.zstd`）里读出来的事实：

- `request/header.tools` 共 **29** 项，其中前四项就是 `browser_navigate` / `browser_open` /
  `browser_screenshot` / `browser_snapshot` —— 工具确实进了发给模型的请求体。
- `request/header.tools[].description` 里，四个工具各自都带着 ref 语义与失效条件
  （`BROWSER_STALE_REF`）以及 untrusted 声明。
- `system/message` 里本插件那个分段文本完整在列（含 `[ref=e12]`、纪元失效、attachment 与
  untrusted 三段）。

即：**host 平面 insert 对 agent 可见这件事，在真实 profile 上已闭环**，上面那张表不再是推断。
会话日志的 `zstd` 需要 `zstd -d -c` 解开；`last` 一条是 `turn/end`。

**patch 语义**：命中某一行时是**整块替换 config**（非深合并），所以覆盖时要重述该行的所有 config 键。

## 实现说明（P0）

### ref 纪元：唯一一件不做就会出错的状态机

一次 snapshot 给页面上每个可操作元素编号。若下一次 snapshot 从 1 重新编号，模型拿着上一次的 `e3`
很可能**命中一个完全不同的元素** —— 这是静默的、最难排查的事故。`src/browser-cdp/refs.ts` 用两条规则
把这个可能性从根上删掉：

1. **序号在会话内单调递增，绝不重置。** 新 snapshot 从上一个纪元的最大值之后继续编号，
   所以「同号不同元素」不可能出现。
2. **解析前先比纪元。** 持有 ref 表的永远只是「当前纪元」那一份；导航与下一次 snapshot 都把整张表换掉。

于是旧 ref 只会落到「表里没有」，报 `BROWSER_STALE_REF`（观察过页面）或 `BROWSER_SNAPSHOT_REQUIRED`
（从未观察过）。两者都是模型该用「重新观察」恢复的错误。P0 里唯一消费 ref 的工具是
`browser_screenshot`（可选的 `ref` 参数，截单个元素）—— 它是只读的，因此**没有**越过 P0 的边界，
却让「旧 ref 必须失败」这条语义有了真实的调用路径，而不是只活在单元测试里。

### 为什么是自己写 CDP 而不是上 Playwright

`src/browser-cdp/protocol.ts` 只做两件事：DevTools 的 `/json/{version,list,new,close}` HTTP 端点，
以及 WebSocket 上的 `{ id, method, params }` 命令通道（约 400 行，含超时、取消、断线结算）。
换来的是零浏览器下载、零 `allowBuilds` 授权、零 Chromium 体积，以及**用户自己的登录态**。
`snapshot.ts` 走可访问性树而不是视觉树 —— 浏览器已经算好了角色与名称，比从布局反推少一个数量级
的代码，对模型也更友好。

### 一次性环境约束

- **`SECTION_ORDERS` 是中央封闭注册表**，外部插件加不了键，只能给 `section({ order: <number> })`
  传显式数字。本插件用 `2050`（紧挨 `TOOL_WEB_SEARCH: 2000` / `TOOL_WEB_FETCH: 2100`）。
- **注册即 effect**：所有贡献走 `ctx.effect()` / `ctx.on()`，`register()` 返回 disposer。
- **插件入口模块不能有 `export default`**（见「踩过的坑」第 1 条）。
- 页面上的一切按**不可信数据**处理，这条同时写进四个工具描述与系统提示分段 —— 只写一处等于没写。

## 验收（P0）

| # | 验收项 | 状态 | 怎么验 |
|---|---|---|---|
| 1 | `--dump-config` 五行在、层序对 | ✅ | `pnpm dsh --profile browserp0 --dump-config \| grep -A5 "== dsh-browser-plugin"` |
| 2 | 真 Chrome 上跑通 open → snapshot → screenshot | ✅ | live 测试（下） |
| 3 | 截图以 attachment 引用出现 | ⚠️ 见下 | live 测试用真实 `LocalAttachmentStore` 存盘；工具层的「图片块」由单测覆盖 |
| 4 | 导航后用旧 ref 拿到 `stale_ref` | ✅ | live 测试 + `provider.test.ts`（并断言**没有**发出截图命令） |
| 5 | 会话关闭后连接释放、无残留 | ✅ | live 测试断言 `close()` 后 `/json/list` 里不再有那个 target |

**第 3 条的边界要说清楚**：`browser_screenshot` 的图确实会以 `ImageAttachmentRef` 形式作为
`{ type: 'image' }` 内容块进入工具结果（单测断言了内容块形状与「base64 不进消息」），
CDP 产出的 PNG 也确实能被真实的 `LocalAttachmentStore` 接受并原样读回（live 测试断言了字节相等）。
**没有**验到的是「在一个真实会话的 UI 里看到这张图」——那需要 `DEEPSEEK_API_KEY` 跑一次真实模型回合，
本机未配置。

**第 5 条的边界**：P0 从不启动浏览器进程（只连接用户已开的 Chrome），所以没有进程树可回收；
「无残留」在这里的准确含义是：WebSocket 全部关闭、由本插件创建的标签页全部关闭。
自动拉起浏览器是 P1 的事，届时才需要 `ctx.subprocess` 的进程树回收语义。

### 手工验收（复制粘贴即可）

```bash
# 0) 起 Chrome（换一个没被占用的端口，本机 9222 被桌面端占着）
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --remote-debugging-port=9333 --user-data-dir="%TEMP%\dsh-cdp-profile"

# 1) 对着这个 Chrome 跑全套测试
#    这组只在端点是「真 Chrome」时才跑：9222 上那个 Electron 会被认出来并带原因跳过
cd D:/dev/cli/dsh-browser-plugin
DSH_CDP_ENDPOINT=http://127.0.0.1:9333 pnpm test

# 2) 层序
cd /d/dev/cli/deepseek-harness
pnpm dsh --profile browserp0 --dump-config | grep -A4 "== dsh-browser-plugin"

# 3) 真实会话（需要一个 API key；见下）
#    在容器根建 .env 写入 DEEPSEEK_API_KEY=...（绝不提交），然后：
pnpm dsh --profile browserp0
#    让模型依次调用 browser_open / browser_snapshot / browser_screenshot，
#    即可看到大纲、ref、以及会话里的图片附件。
```

## 开发

```bash
pnpm install       # 工具链 + link 本地 dsh 包；不查 registry
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest；147 个用例通过（另有 3 个 live，端点不是真 Chrome 时整组跳过）
pnpm build         # tsdown 加 copy-assets；产出 lib/（host 四面 + 包根 + 客户端 bundle + host.cjs）
```

测试全部就近放在 `src/**/*.test.ts`（`vitest.config.ts` 的 include 就是这一条）。覆盖：

| 文件 | 覆盖什么 |
|---|---|
| `browser/index.test.ts` | provider 选择语义（7 个错误码）、navigate 转发、dispose 聚合 |
| `browser-cdp/protocol.test.ts` | 命令相关性、CDP 错误映射、断线结算、超时/取消、真 HTTP 端点 |
| `browser-cdp/refs.test.ts` | 纪元推进、序号单调、`stale_ref` / `snapshot_required` |
| `browser-cdp/snapshot.test.ts` | 大纲裁剪、透明层、ref 只给可操作角色、截断、环状树 |
| `browser-cdp/provider.test.ts` | 全链路（含「旧 ref 不发截图命令」与「拒绝新建标签页时不劫持用户页面」） |
| `browser-cdp/url-policy.test.ts` | 地址策略与端点回环约束 |
| `tool-browser/index.test.ts` | 四个工具的 schema 编译、参数校验、输出过 schema、图片块 |
| `browser-cdp/live.test.ts` | 真实 Chrome 上的 open → snapshot → screenshot → navigate → stale_ref → close + 真实 attachment 存储（端点非真 Chrome 时整组带原因跳过） |

`pnpm-workspace.yaml` 里的 `allowBuilds: { esbuild: true }` 是必需的：pnpm 默认挂起依赖的构建脚本，
vitest 启动前的 deps-status 检查会因此直接失败（`ERR_PNPM_IGNORED_BUILDS`）。

profile 里装的是 **symlink**，所以改完源码不必重新 `add`，直接重跑 `dsh --profile browserp0` 即可。

## 踩过的坑（都是实测）

### 1. 插件入口模块加 `export default` 会静默丢掉 `name` / `inject` / `Config`

`vendor/loader/src/index.ts:194` 是 `exports = exports.default ?? exports`。只要有默认导出，
加载器就用默认导出**替换整个模块命名空间**，于是 `inject` 消失，症状是启动时报
`cannot get property "systemPrompt" without inject` —— 和配置八竿子打不着，很难从错误信息反推。

**规则：插件入口（有 `apply` 的那个模块）不要写 `export default`。**
`src/browser/index.ts` 是例外，它的默认导出就是 `BrowserRuntime` 服务类本身，本来就该是默认导出。
（`pnpm typecheck` 与 `pnpm test` 都发现不了这个问题 —— 只有真的 `dsh --profile` 启动一次才会暴露。）

### 2. patch 行不带 `config:` 时，`apply` 收到的是 `undefined`，不是 schemastery 的默认值

上游 `web-fetch-http` 直接 `config as ResolvedConfig`，是因为它的 patch 行里写了 `config:`。
本插件的行不写 config，所以 `apply` 必须自己 `config: Config = {}` 且每一格都用 `??` 兜底。

### 3. `PUT /json/new` 不是所有 Chromium 都实现

Electron 系的 DevTools 端点（**包括 dsh 桌面端自己**）对 `/json/new` 直接回
`500 Could not create new page`。所以：

- `browser_open` 明确定位为**新建**标签页，不实现「接管既有标签页」的降级 ——
  `/json/list` 里的页面可能是用户的邮箱或 IDE，悄悄接管并导航它比「open 失败」糟得多。
  端点拒绝新建时抛一条带诊断的错误（含当前 page target 数量），指向「换一个真正的 Chrome」。
- **本机 9222 不是空的**：它被 dsh 桌面端开发态的 Electron renderer 调试端口占着
  （`netstat` 显示属主是 `electron.exe`）。此时插件连上的是那个 Electron，`/json/new` 必然失败。
  手工验证请换端口（如 9333）。这也是一个真实的教训：**先确认端口属于谁**，
  别假定 `127.0.0.1:9222` 就是 Chrome。

  这个坑还咬了测试本身：`live.test.ts` 最初只判断 `/json/version` 是否 200，于是 9222 上的
  Electron 让整组「以为」有 Chrome，带着假前提跑完，以两条与实现无关的失败收场。
  现在判定改成读 `User-Agent`：**含 `Electron/` 即视为嵌入式并跳过**——它内部包着的 Chrome
  版本号看不出区别，只认 `Chrome/` 是不够的；跳过时会打印原因（`[live] skipping …`），
  日志里不会只剩一个沉默的 skip。

### 4. 用 `--user-data-dir` 起 Chrome 必须用**新目录**，否则复用已有实例

Chrome 发现同名 user-data-dir 已在运行时，会把 `--remote-debugging-port` 丢掉、直接附着到那个实例。
表现是「端口起不来但不报错」。

## License

MIT
