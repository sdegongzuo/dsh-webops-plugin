# dsh-webops-plugin

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加**客户端网页操作与调试**能力的插件：
多会话、新窗口、多标签页地调试和操作网页。能力形态对齐 [Minke](https://github.com/lencx/minke) 的 Agent Browser：
模型可以打开页面、读取页面大纲、按 ref 定位并操作元素、采集控制台与网络活动，并支持人工接管。

这是一个 **out-of-tree bundle**：不修改 deepseek-harness 仓库的任何文件，靠自己的 `cordis.patch.yml`
把插件行插进目标 profile。

![桌面端里的浏览器面板](docs/desktop-dock.png)

---

## 能力

共 15 个工具（`read` 级只读不改页面，`mutate` 级会动页面或标签）：

| 工具 | 能力级 | 一句话 |
|---|---|---|
| `browser_open` / `browser_navigate` | read | 开**新**标签页 / 当前页跳转（永不接管用户已有标签） |
| `browser_snapshot` | read | 可访问性大纲 + ref；ref 在会话内单调不复用，旧 ref 必然失效 |
| `browser_screenshot` | read | 截图存成 attachment（可选 `ref` 只截单个元素） |
| `browser_tabs` | mutate | `list` / `activate` / `close`，只列、只碰本会话自己开的标签页 |
| `browser_click` / `fill` / `press` / `scroll` | mutate | 按 ref 操作；**写前**先查纪元，失效返回可重试的 `BROWSER_STALE_REF` |
| `browser_wait` | read | 等时间 / 等文本出现 / 等 ref 元素消失（不改页面） |
| `browser_find` | read | 在最近一次 snapshot 的大纲上做零状态文本检索，不发任何 CDP 命令 |
| `browser_locate` | read | 按 ref 现算视口坐标盒 + `in_viewport`（默认不滚视口） |
| `browser_console` | read | console 环形缓冲（Runtime + Log 合流、按高水位去重、默认只给当前文档） |
| `browser_network` | read | 请求表 + 按 `requestId` 取响应体（断开窗口期的请求按「会丢」处理） |
| `browser_execute` | mutate | 白名单制 CDP 逃生舱：一次一条允许列表内的命令，其余一律 `BROWSER_EXECUTE_NOT_ALLOWED` |

两个 provider，用 `DSH_BROWSER_PROVIDER` 选（桌面端默认 `electron`）：

| provider | id | 开的是什么 | 谁用 |
|---|---|---|---|
| `browser-cdp` | `cdp` | 外部 Chrome 的标签页 | CLI / 想接自己日常浏览器时 |
| `browser-electron` | `electron` | 桌面端自己真正的 `BrowserWindow` | 桌面端（默认） |

页面上的一切按**不可信数据**处理 —— 这条写进了每个工具的描述与系统提示分段。

---

## 快速开始

### 桌面端（推荐）

```bash
pnpm run build          # 产出 lib/（桌面端只吃构建产物）
pnpm run dev:desktop    # 装配进开发态 profile 并拉起 Electron
pnpm run check:desktop  # 从外部用 CDP 断言「host 认了 / 客户端跑了 / 面板渲染了 / 卡片注册了」
```

开发态**装插件是被 dsh 硬禁的**，且 `dev.ts` 每次启动都会整目录重建 `project/`，所以
`scripts/dev-desktop.mjs` 复刻了它的启动序列、只在中间插一步装配（真实目录复制，不是链接），
并且从 dsh 源码直接 import 所需函数，**不改动 deepseek-harness 里任何文件**。

### CLI + 外部 Chrome

```bash
# 1) 起一个带调试端口的 Chrome。必须用**全新的 user-data-dir**，
#    否则 Chrome 会附着到你日常那个实例上并悄悄丢掉调试端口。
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --remote-debugging-port=9333 --user-data-dir="%TEMP%\dsh-cdp-profile"

# 2) 启动 dsh（profile 里 link 了本仓，改完源码不必重新 add）
cd /d/dev/cli/deepseek-harness && pnpm dsh --profile browserp0

# 3) 让模型做事：
#    browser_open { "url": "https://example.com" }  → session_id
#    browser_snapshot { "session_id": "…" }         → 大纲 + ref
#    browser_screenshot { "session_id": "…" }       → attachment
```

> **端口别用 9222**：本机 9222 通常是 dsh 桌面端 Electron renderer 的调试端口，此时插件连上的是
> 那个 Electron 而不是 Chrome，`/json/new` 必然失败。换一个端口（如 9333）。

---

## 开发

```bash
pnpm install       # 工具链 + link 本地 dsh 包（不查 registry）
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest：289 passed / 3 skipped
pnpm build         # 产出 lib/（host 半边多入口 + 包根 + 客户端 bundle + host.cjs）
```

`pnpm test` 的 3 个 live 用例需要 `DSH_CDP_ENDPOINT` 指向**真 Chrome**（端点是 Electron 时整组带原因跳过）。

常用脚本：

| 命令 | 作用 |
|---|---|
| `pnpm run dev:desktop` / `check:desktop` / `shot:desktop` | 桌面端：装配启动 / CDP 断言 / 截图 |
| `pnpm run smoke:window` / `window:desktop` / `smoke:devtools` / `smoke:p2p3` | 窗口、DevTools 共存、P2/P3 的真机冒烟 |
| `pnpm run verify:card` | keyless 端到端：假模型驱动真工具链，断言卡片真渲染 |
| `pnpm run verify:portable` | **发版前自检**：验打包产物能不能起来（见「发版」） |
| `pnpm run package:portable` | 本地打插件便携版 zip |

**keyless 验证**（`src/fake-llm`）不需要 `DEEPSEEK_API_KEY`：它拦下 `llm/stream` 按脚本回放，
驱动真 agent loop 走完整条工具链。它**只在开发态挂载、且需要 `DSH_FAKE_LLM=1`**
（`pnpm run dev:desktop` 会自动拼上）。步骤见 [`docs/keyless-测试交接.md`](docs/keyless-测试交接.md)。

---

## 结构

```
cordis.patch.yml            出货 patch：把五行插进 profile
cordis.fake-llm.patch.yml   仅开发态的 overlay（fake-llm 行在这里，绝不出货）
package.json                 dsh.bundle.patch + dsh.client（双面）+ 多入口导出
tsdown.config.ts             两条独立产物：host 半边（ESM）/ 客户端 bundle（CJS）
src/index.ts                 包根 host 半边（**故意是空的**，只为让客户端半边被发现）
src/debug.ts                 加载诊断（写 stdout —— 桌面端会吞掉 stderr）
src/browser/                 Service Definition：ctx.browser、provider 选择、错误类型
src/browser-cdp/             provider（外部 Chrome）
  provider.ts                  会话生命周期、观察、按 ref 操作、截图裁剪
  protocol.ts                  CDP 传输层：/json/* HTTP + WebSocket 命令通道
  refs.ts                      ref 纪元状态机（核心语义）
  snapshot.ts                  可访问性树 → 紧凑大纲 + ref 候选
  console.ts / network.ts      console / network 采集器（环形缓冲、去重、分文档）
  execute.ts                   CDP 白名单与返回值三态收口
  state.ts                     target 状态簿记骨架
  url-policy.ts                地址策略：只许 HTTP(S)、禁内嵌凭据、端点回环
src/browser-electron/        provider（桌面端自己的 Electron 窗口）
  bridge.ts                    spawn 宿主 + TCP JSON Lines 通道
  host.cjs                     被 spawn 的 Electron 应用入口（BrowserWindow + debugger）
  socket.ts / transport.ts     把「桥上的一个窗口」包成 CdpSocket
  tabbar.html                  多标签页的标签条 UI
src/tool-browser/            工具层：browser_* 工具 + 能力分级 + 系统提示分段
src/client/                  客户端半边（dsh.client）：input dock 状态条 + 工具卡片
src/fake-llm/                keyless 验证夹具（脚本回放 llm/stream，有闸门默认哑）
scripts/                     开发 / 验证 / 打包脚本（见上表）
docs/                        二级文档（见下）
```

为什么不分三个包：官方把能力拆成 `<capability>` / provider / `tool-<cap>` 三包，是为「能力可组合」。
个人插件不需要这份弹性，单包多入口即可。

---

## 发版

两条链路各吃一种 tag，互不干扰：

| 链路 | tag | workflow | 产物 | CI 耗时 |
|---|---|---|---|---|
| 插件便携版 | `v*` | `release.yml` | 几 MB 的插件目录 zip（免构建） | ~3 分钟 |
| 桌面端便携版 | `desktop-v*` | `release-desktop.yml` | ~226 MB 整包（含 dsh 本体） | 首次 ~16 分钟，**缓存命中 ~6.5 分钟** |

```bash
git tag v0.2.0 && git push origin v0.2.0              # 插件便携版
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0   # 桌面端便携版
```

桌面端那条链路的耗时几乎全在 IO 上，不是编译：**不需要 MSVC**（node-pty / koffi / sharp 都是预编译）。
631s 花在 electron-builder 把 226MB / 14071 个文件解包组装成 app 目录，294s 花在压缩。
所以做了两件事：用 `actions/cache` 缓存 `win-unpacked`（key 含 `HARNESS_REF` + 两处补丁的 hash，
命中则跳过构建步骤），以及把压缩级别从 `Optimal` 降到 `Fastest`（app 里多是已压过的二进制）。

| 步骤 | 改动前 | 首次（缓存 miss） | 缓存命中 |
|---|---|---|---|
| 构建桌面端应用目录 | 631s | 596s | **0s（跳过）** |
| 物化 profile + 打 zip | 294s | 235s | 248s |
| **总计** | **17m12s** | **16m03s** | **6m28s** |

### 发版前必做：`pnpm run verify:portable`

`typecheck` / `test` / CI 构建**都拦不住**「包能构建但起不来」—— v0.1.0 和 v0.2.0 两次发版都栽在这
（插件登记被静默抹掉、出货 patch 误带 fake-llm）。所以发桌面端便携版前必须真把**打包产物**起一次：

```bash
pnpm run verify:portable -- --dir /path/to/解压后的目录
pnpm run verify:portable -- --dir /path/to/解压后的目录 \
    --browser "C:/Program Files/Google/Chrome/Application/chrome.exe"   # 可选：再验客户端注册
```

它先用 harness 真代码（`apps/desktop/src/*.ts`，`--harness` 可指路径）走一遍桌面端启动准备
（全量 sha256 完整性、`state.runtimeId` / `nodeVersion` / `platform` / `arch` 对齐、建 241 条宿主链接 +
依赖图校验），再真起宿主读 `__DSH_BOOT__`。CI 里也内置了这一步，跑在「发布 Release」之前。

三个必读的坑（profile 状态文件 / fake-llm 随包出货 / 解压产物损坏的误判）连同完整断言清单，见
[`docs/desktop-portable-release-notes.md`](docs/desktop-portable-release-notes.md)。

> 公开仓的 Actions **完全免费**，优化 CI 时长省的是等待时间，不是额度。

---

## 二级文档

| 文档 | 内容 |
|---|---|
| [`docs/keyless-测试交接.md`](docs/keyless-测试交接.md) | keyless 端到端测试怎么跑、判定标准、时序与闸门坑 |
| [`docs/实现与踩坑.md`](docs/实现与踩坑.md) | 接进 dsh 的两条路线、桌面端硬约束与接入手法、CDP 与 ref 纪元、接线为什么在 host 平面、实测踩坑 |
| [`docs/desktop-portable-release-notes.md`](docs/desktop-portable-release-notes.md) | 便携版发版存档 + 发版必读的三个坑 + `verify:portable` 断言清单 |
| [`docs/交付记录.md`](docs/交付记录.md) | P1 / P2 / P3 各期交付内容、实测证据与当时的环境死角（历史归档） |
| [`docs/P2-P3-开发方案.md`](docs/P2-P3-开发方案.md) | P2/P3 的设计方案与实施顺序 |
| [`docs/P2-P3-状态归属与接入规范.md`](docs/P2-P3-状态归属与接入规范.md) | 新增 CDP 命令时的状态归属实测方法与规范 |
| [`docs/browser-tools-five-scenarios.md`](docs/browser-tools-five-scenarios.md) | 五个典型场景的真机实测报告（9 条问题的来源） |
| [`docs/portable-install.md`](docs/portable-install.md) | 插件便携版的用户安装说明（随包发出） |

---

## License

MIT
