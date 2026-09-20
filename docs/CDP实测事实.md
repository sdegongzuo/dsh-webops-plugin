# CDP 实测事实

> 接入任何新的 CDP 命令之前查这份。**全部结论来自本机实测**，不是协议文档推断。
> 环境：Electron **44.0.0** / Chromium 152.0.7977.54 / Windows。
> V37–V40 在 Electron 43.2.0 上复跑过，逐项一致；U4 的对照在纯 Chrome 153.0.8010.36 上做。
>
> 原始日志在 `.workbuddy/tmp/`（`probe.jsonl` / `st.jsonl` / `gl.jsonl` / `u6.jsonl` / `u8.jsonl` …）。
> 复现模板见 `cdp-behavior-probe` skill。
>
> 运行器路径：`deepseek-harness/node_modules/.pnpm/electron@44.0.0_*/node_modules/electron/dist/electron.exe`
> —— **根 `node_modules/electron/dist` 不存在**（pnpm 不 hoist），按老路径找会误判成「本机没有 44」。

## 0. 一句话

**CDP 的状态作用域是逐 domain、甚至逐命令不同的，不能一概而论。**
判据不是「哪个 domain」，而是「**这条命令写的是不是 target 级行为状态**」。

- `Emulation` 全类跨 client 覆盖、后写赢；`Network` 域里 `emulateNetworkConditions` / `setExtraHTTPHeaders`
  同样共享，而**同域的 `setBlockedURLs` 却是 session 私有** —— **连同一个 domain 内都不能类推**。
- `Page.addScriptToEvaluateOnNewDocument` 也是 target 级共享，且副作用要到**下一次导航**才显形。

---

## 1. 事实表

| # | 事实 | 日志 |
|---|---|---|
| V1 | 外部 CDP client 能与 `webContents.debugger` 共存同一 target，交替发命令互不阻塞 | `probe.jsonl` |
| V2 | 人工断点暂停 10s 期间，agent 的 `Runtime.evaluate` / `Accessibility.getFullAXTree` / `Page.captureScreenshot` 全部正常返回（1~65ms） | `probe.jsonl` |
| V3 | **`attach` 期间调 `openDevTools` 静默失败**（`isDevToolsOpened()`=false，不抛错），但 `/json/list` 会多一个 target | `dt.jsonl` |
| V4 | `detach()` 后 `openDevTools` 成功（`isDevToolsOpened()`=true） | `dt.jsonl` |
| V5 | **DevTools 已打开时 `debugger.attach` 成功**，`Runtime.evaluate` 返回正常 | `dt.jsonl` |
| V34 | `devtools-opened` 回调内**同步** attach 即可（回调内 / tick0 / 延迟 1s / 延迟 2s 四档全部 ok），无需延迟 | `dt2.jsonl` |
| V16 | **detach 期间命令同步抛 `Error: No target available`**（**立即失败，不会挂起**），re-attach 后恢复 | `g4.jsonl` |
| V23 | `detach` 事件 reason **恒为 `target closed`**（**主动 detach 也是**），不能用它区分「人为让位」与「页面真的没了」 | `g4.jsonl` |
| V6 | `Emulation.setUserAgentOverride` 跨 client 可见、后写赢 | `st.jsonl` |
| V7 | **写入异步可见**：设完立刻回读仍是旧值，约 **170ms** 后才正确 | `st.jsonl` |
| V8 | 只有 enable 过某 domain 的 session 才收该域事件（B 未 enable 时收到 0 个） | `st.jsonl` |
| V9 | `Emulation.setDeviceMetricsOverride` 跨 client 覆盖、后写赢（A=400 → B=600 → A 读到 600） | `gl.jsonl` |
| V10 | `clearDeviceMetricsOverride` **只还原 dpr，视口尺寸永久残留**：900 → set 400 → clear 后读 400；再 set 800 → clear 后又读 400 | `cl.jsonl` |
| V11 | `clearDeviceMetricsOverride` 是 per-session **弹自己那层**（B 从未 set 时 clear，A 的值不受影响） | `gl2.jsonl` |
| V29 | V10 的残留是 **Electron 特有**：纯 Chrome 153 上 `clear` 完全还原（754→400→**754**） | `ch.jsonl` |
| V12 | `Network.setBlockedURLs` **session 私有**，互不影响；**空数组是有效清除** | `gl2.jsonl` |
| V30 | `Runtime.setAsyncCallStackDepth` **session 私有** | `sc2.jsonl` |
| V25 | `Network.emulateNetworkConditions` **跨 client 共享、后写赢**（A 置离线 → B 置 `offline:false` → A 立刻恢复联网） | `sc.jsonl` |
| V26 | `Network.setExtraHTTPHeaders` **跨 client 共享、后写赢**（A 设 `x-probe:A` → B 设 `B` → A 读到 `B`） | `sc.jsonl` |
| V27 | `Network.setCacheDisabled` **作用域无法判定** —— 见 §5，不是「未测」 | `sc2.jsonl` `ca.jsonl` `c4.jsonl` |
| V28 | 本机 `fetch()` 响应**不进 http 缓存**（无 CDP / 有 CDP / 显式 `cacheDisabled=false` 三种条件下同 URL 三次请求全部打到服务端）；`<img>` 子资源第二次**命中缓存**，但该命中走渲染进程 MemoryCache，`cacheDisabled` 管不到 | `c2.jsonl` `c3.jsonl` `c4.jsonl` |
| V35 | **`Page.addScriptToEvaluateOnNewDocument` 是 target 级共享**：A 注册后**不导航**，由 B 触发导航 → 新文档里脚本照样被注入（B 和 A 都读到 `window.__U6 === "A"`）。但注册项**绑在 A 的 session 上**：A detach 后再导航则不再注入，旧 identifier 报 `Script not found` | `u6.jsonl` `u6b2.jsonl` |
| V13 | `Runtime.enable` **全量重放** console 历史，**每次 enable 都重放一遍**（3 次 attach 收到 `M1M2` → `M1M2M3` → `M1M2M3M4`） | `rp2.jsonl` |
| V14 | 重放**覆盖 detach 窗口**：detach 期间页面自己产生的消息，re-attach 后照样能收到 | `rp3.jsonl` |
| V24 | console **重放上限 1000 条**（实时 1500/1500，重放只回 1000） | `lm.jsonl` |
| V17 | `Runtime.consoleAPICalled` 带 `executionContextId` + 微秒精度 `timestamp`，可作去重键（实测三条各异：`…445.069` / `…445.167` / `…445.198`） | `g4.jsonl` |
| V37 | **`Log.entryAdded` 也会重放**（含 detach 窗口），但字段口径与 `Runtime` 不同：`timestamp` 是 **number**（`1789289442861.96`）、**没有 `executionContextId`**、有 `source`（`javascript` / `network` / `other`） | `u8.jsonl` |
| V39 | **`Log` 的重放上限也是 1000**，且**超限会显式发一条截断提示条目**：`{source:'other', text:'2010 log entries are not shown.', timestamp:0}`（3010−1000=2010，精确对上）。`Runtime` **没有**等价提示，它的截断是无声的 | `u9.jsonl` |
| V38 | **`Network` 事件不做历史重放**：detach 窗口内**已完成**的请求，re-enable 后一条都不补 —— **永久丢失** | `u8.jsonl` |
| V40 | **跨 detach 的「进行中」请求**：attach 期发起、re-attach 后才完成的 → 收尾链完整（四条齐）；**detach 期间发起**的 → 能收到响应侧事件，但 **`requestWillBeSent` 不补发** | `u9b.jsonl` |
| V18 | **`requestId` 跨 session 完全一致**（A、B 收到同一个 `37668.2`）；A 用自己收到的 id 调 `getResponseBody` 成功 —— 省掉了原本以为要做的 per-session 映射表 | `g4.jsonl` |
| V19 | **重复 `DOM.getDocument` 会导致 nodeId 重新分配**（同一元素 6 → 13）；各 session 独立编号 → nodeId **既不稳定也不跨 session 通用** | `g4.jsonl` |
| V36 | **`backendNodeId` 是稳定定位句柄**：连续三次 `getDocument` 后同一 `#box` 的 nodeId 为 6→15→24，而 backendNodeId **恒为 6**；`DOM.resolveNode({backendNodeId})` 在**从未调 `DOM.enable`** 的情况下成功拿到 objectId，配 `Runtime.callFunctionOn` 取到 rect。元素被 `replaceWith` 换掉后，旧 backendNodeId 的 `resolveNode` **仍然成功**，但 `this.isConnected` 变 `false`（**只查 resolveNode 会漏**） | `u7.jsonl` |
| V15 | `Overlay.enable` 依赖 `DOM.enable`，否则报 `DOM should be enabled first` | `gl.jsonl` |
| V20 | `Overlay.highlightNode` 需本 session 先 `Overlay.enable`，否则 `-32600 Overlay must be enabled before a tool can use it` | `g4.jsonl` |
| V31 | **`Overlay.highlightNode` 多 client 各自独立、互不取消**（红 719900 + 蓝 239971 同时存在；A 的 `hideHighlight` 不影响 B）—— 推翻了「高亮是单例、会与人工 Elements 面板互相取消」的假设 | `hn.jsonl` `hn-*.png` |
| V32 | **`Overlay.highlightRect` 的 `color` 会把整个视口染色**：rect 内深色填充，**rect 之外整个视口叠同色浅色遮罩**（红像素 ≈ 视口面积 82%）；`highlightNode` + `highlightConfig` 只有目标元素被覆盖 | `ov.jsonl` `shot-*.png` |
| V21 | `Page.bringToFront` 双方都能成功，无互斥 —— 它不是「锁」，是 target 级操作（最后调用者赢） | `g4.jsonl` |
| V22 | `Runtime.evaluate` 返回值边界，见 §4 | `g4.jsonl` |
| V33 | **`Page.captureScreenshot` 在 `show:false` 的窗口上永久挂起**（不报错、不返回）；`show:true` 立刻正常 | 本轮探针 |
| V41 | **`Runtime.evaluate` 的顶层 `let`/`const`/`var` 跨调用持久**（全局词法环境是 realm 级共享）：`let x = 41` → 下一次 evaluate 读 `x` 得 `41`。真正的坑是**重复声明**：再写一次 `let x = …` 抛 `SyntaxError: Identifier 'x' has already been declared`。**不必往 `window` 上挂**（那才引入污染）；只有导航/换文档才清空 | `2026-09-20` Chrome 153 + **Electron 44（Chromium 152）** 双跑一致 |
| V42 | **返回值深度上限在 250～300 层之间**（对象 250 ok / 300 起报 `Failed to convert response to JSON: CBOR: stack limit exceeded at position 3040`；数组 200 ok / 500 挂；2000 层换成 `Object reference chain is too long`）。**是报错，不是静默 `{}`**。⚠️ `CBOR: stack limit exceeded` 这条**没被 `translateEvaluateError` 映射**（只映射了 chain / `couldn't be returned` 两条）→ 模型拿到裸 `BROWSER_PROTOCOL_ERROR` | 同上 |
| V43 | ★ **函数返回值静默变 `{}` 且不报错**：`() => 1` → `{type:'function', value:{}}`，而 `isEmptyObject` 守卫**只在 `type === 'object'` 分支里**，所以这条漏网。（`new Map` / `new Error` / `{}` 字面量都落在 `type:'object'` 分支，被守卫拦下 → 真想要空对象得回 `JSON.stringify({})`） | 同上 |
| V44 | **`Runtime.evaluate` 的 `timeout` 参数只杀同步执行**：`while(true){}` + `timeout:1500` → 1517ms 回 CDP 错误 `Internal error`；`new Promise(()=>{})` + `timeout:1500` → **照样 8s 无回包**。→ 挂住的 Promise 只有 `Promise.race` 能救。另：一条挂住的 evaluate **不毒化连接**，同连接后续命令照常回包 | 同上 |
| V45 | **隔离世界不共享 JS 状态**：`Page.createIsolatedWorld` 拿到的 contextId 里，主世界设的 `window.__p_mw` 与 `el.__expando` 都读不到（`undefined`）。→ 「走框架内部机制改 React 状态」**不能**用隔离世界（fiber 就挂在 DOM 元素的 expando 上） | 同上 |

**V41–V45 双运行时复核（2026-09-20）**：五条在本机 **Chrome 153** 与 **Electron 44（Chromium 152）** 上各跑一遍，
连报错文案都逐字一致（含 `CBOR: stack limit exceeded at position 3040` 里那个位置号）。
→ 这批读数不是 Chrome 特有的，**V29 那种 Electron 特例在这里不成立**，可以当作 Chromium 层事实用。
探针：`D:/tmp/cdp-exec-probe{,2,3}.mjs`（Chrome）、`D:/tmp/electron-probe/`（Electron：隐藏窗口 + 独立 CDP 端口，
**不必碰正在跑的那个实例**）。⚠️ 本机 shell 带 `ELECTRON_RUN_AS_NODE=1`，起 Electron 前必须 `env -u`；
而且后台进程会随工具调用结束被回收 → 必须**在同一条命令里**起、跑、收（`taskkill /T /F` 收按端口查到的 PID）。

---

## 2. 逐工具接入表与硬规则

| 工具 | 新引入 domain | 写状态？ | 作用域（实测） | 应对 |
|---|---|---|---|---|
| `webpage_console` | `Runtime` / `Log` | 只 enable | enable 后事件各 session 一份（V8），但**两域都会全量重放**（V13/V14/V37），**上限都是 1000 条**（V24/V39） | 每次 attach 后重新 `Runtime.enable` **和** `Log.enable`；去重**按域分桶**的高水位，见 §3 |
| `webpage_network` | `Network`（只 enable + 读事件） | 只 enable | 事件各 session 一份；**无历史重放**（V38） | 用 `Network.enable` 读事件；**禁止**用 `Fetch.enable` 做拦截；半截记录必须显式处理，见 §3 |
| 网络条件模拟（若做） | `Network.emulateNetworkConditions` | 写 | **跨 client 共享、后写赢**（V25） | **必须走 targetState 簿记**（见 `架构与实现.md` §11） |
| `webpage_execute` | 任意 | 任意 | 取决于内部命令 | **高**。见 §4 |
| 人工接管 / 回收 | 无（编排逻辑） | — | — | 语义 = agent 停操作 + 重新观察，**不是断开连接**（V5 实测 DevTools 开着也能 re-attach）；接管**不推 ref 纪元** |
| `webpage_find` | 无（本地文本检索） | 否 | — | **零风险** |
| `webpage_locate` | `DOM` / `Overlay` | 视觉状态 | `Overlay.highlightNode` 多 client 各自独立、互不取消（V31） | 定位走 `backendNodeId` → `resolveNode` → `callFunctionOn`（V36）；高亮用 `highlightNode`（**别用 `highlightRect`**，V32） |

---

### 硬规则①：永远不要用 `clear*` 做还原

V10 已证明 `Emulation.clearDeviceMetricsOverride` **连自己都还原不干净**（只还原 dpr，视口宽度永久残留）。
「设了 → 用完 clear 还原」这个写法是错的。

- 要还原就**显式 set 回真实尺寸**。
- `clear` 是 per-session **弹自己那层**（V11）—— 所以并发写入时不会互相清掉，
  但也意味着**你不能靠 clear 收回别人的状态**。
- 适用范围要记住：V10 的残留是 **Electron 特有**（V29，纯 Chrome 153 上完全还原）。
  约束照旧写（插件跑在 Electron 里），但注释里要标明边界，以便将来 Electron 修掉后能安全放宽 ——
  那时只需重跑一次探针就能判定。

### 硬规则②：按顺序，能用前一条就别用后一条

1. **校验写入结果时不能立即回读断言**：写入异步可见（V7），设完立刻回读会读到旧值，约 170ms 后才正确。
   要么延迟、要么重试。
2. **不产生 > session 私有 > 记账**：能用「只 enable 读事件」或纯计算就别写状态；
   需要设置行为时优先选 session 私有的命令（如 `Network.setBlockedURLs`，V12），它们是天然隔离；
   必须写 target 级状态时才走簿记（见 `架构与实现.md` §11）。
3. **`Network` 的 enable 有个已知缺口**：跨 detach 的请求会产出「无请求头的半截记录」（V40），
   采集器必须显式处理，见 §3。

---

## 3. 两条采集器的实现约束

### console 去重：按域分桶的高水位

**去重键必须按域设计**。`(executionContextId, source, timestamp)` 这个三元组对 `Log` 域**根本不成立**
（`executionContextId` 缺席），两域的时间戳类型也不同（微秒小数 vs number），跨域比大小是错的。

| 域 | 桶键 | 依据 |
|---|---|---|
| `Runtime.consoleAPICalled` | `('rt', contextId, type)` | V17 |
| `Log.entryAdded` | `('log', source)` | V37 —— 只剩 `source` 可分桶 |

- 重放是**按序**的（V13），所以只需记住「该流已处理到的最新 timestamp」，比它旧的一律丢。
  内存 O(上下文数) 而非 O(消息数)，长时间运行不涨。
- **`timestamp <= 0` 的条目必须绕过高水位**：`Log` 的截断提示条目 `timestamp` 恒为 **0**（V39），
  任何高水位都会把它当旧消息丢掉 —— 而它是「内容被截断」的**唯一信号**，`Runtime` 侧没有等价提示。
- 副作用要认：**同一桶内**时间戳相同（或早于高水位）的消息会被丢掉一条。两域实测精度都在亚毫秒级，
  同桶撞车概率低 —— 但要在注释里写明，别让人以为是 bug。

**环形缓冲 ≥1000 不是去重的正确性前提，而是窗口一致性要求**：实时采集能留存的历史，
不应短于 re-attach 能补齐的量（两域都是 1000，V24/V39），否则补齐时反而要丢掉大部分重放消息、兜底白做。
（若改用 seen-set 查重，1000 就变成**硬约束**：容量不足则重放回来的旧消息查不到、被当新消息重复入账。
本仓选的是高水位方案，注释里要写清是哪一条理由，别留下「因为要去重所以要 1000」这种似是而非的话。）

### network：跨 detach 是「半截」不是「全丢」

| 情形 | `requestWillBeSent` | 响应侧事件 |
|---|---|---|
| 发起与完成**都在 attach 期间** | ✅ | ✅ |
| attach 期发起，**detach 期间完成** | ✅ | ❌ **永久丢失**（V38） |
| attach 期发起，**re-attach 之后才完成** | ✅ | ✅ **完整补上**（四条齐） |
| **detach 期间发起**，re-attach 后完成 | ❌ **不补发** | ✅ 收到 —— **但缺请求头** |

最后一行是要害：`requestWillBeSent` 带着 method / URL / 请求头 / postData，是**建档的唯一来源**；
它缺席之后那几个响应事件就是无头孤儿。而「只在 `requestWillBeSent` 时建 entry、后续按 `requestId` 更新」
恰恰是最自然的写法 —— 那样这批事件会被**静默丢弃**。

→ 收到找不到对应 entry 的 `responseReceived` 时**不要直接丢**：建一条降级 entry，
标 `partial: true` + `reason: 'request-headers-missing'`；URL 可从 `response.url` 取（实测有值），
但 method / 请求头 / postData **明确标为未知**。
与「detach 期间已完成」那一档区分开 —— 那档是真丢，属已知且接受的能力边界，统计里如实反映。

---

## 4. `webpage_execute` 的允许 / 拒绝列表

**用允许列表（默认拒）。** 拒绝列表的理由（「新命令会不断加入」）恰恰是反的：
命令不断加入意味着黑名单永远追不上，任何未列出的新命令默认**放行**。

**允许**（只读 / session 私有 / 只导航）：
`Runtime.evaluate`、`Runtime.getProperties`、`DOM.getDocument`、`DOM.querySelector`、
`Page.navigate`、`Page.reload`、`Page.captureScreenshot`、`Accessibility.getFullAXTree`、
`Network.enable`、`Network.getResponseBody`、`Log.enable`。

**必须拒绝的**：

| 命令 | 理由 |
|---|---|
| `Target.*` | `attachToTarget` 能拿**其它标签页**的 session，越出本会话边界 |
| `Browser.*` | `Browser.close` 直接关掉整个浏览器 |
| `Emulation.*` | 跨 client 污染（V6/V9） |
| `Fetch.*` | 跨 client 污染，还能**拦截、改写请求** |
| `Overlay.*` | **理由不是「跨 client」**（V31 实测高亮互不干扰），而是它是**给眼睛看的副作用** —— 会污染截图、干扰人工在 Elements 里的高亮，而 `highlightRect` 还会把整个视口染色（V32）。agent 的高亮走 `webpage_locate` 这条受控通道 |
| `Input.*` | 绕过 `BROWSER_TOOL_CAPABILITIES` 的 `read`/`mutate` 分级，架空它 |
| `Network.emulateNetworkConditions` / `setExtraHTTPHeaders` | V25/V26 实测**跨 client 覆盖、后写赢**。早先版本把整个 `Network` 域列进「允许」是漏的 |
| `Network.setCacheDisabled` | 作用域无法判定（V27），按最坏假设拒 |
| `Page.addScriptToEvaluateOnNewDocument` / `removeScriptToEvaluateOnNewDocument` | V35 实测跨 client 共享，**别人触发的导航也吃注入**。副作用要到「下一次导航」才显形，尤其危险 |
| `Page.setBypassCSP`、`Debugger.*`、`Security.*` 等其它写状态 / 改行为的命令 | 先实测，**默认先拒** |

**返回值边界（V22，全部实测）**：

| 表达式 | 结果 |
|---|---|
| `document.body` + `returnByValue` | **静默返回 `{}`** —— 不报错，最危险 |
| 循环引用对象 | 抛 `Object reference chain is too long` |
| `window` | 抛 `Object reference chain is too long` |
| `Symbol('s')` | 抛 `Object couldn't be returned by value` |
| `new Array(100000).fill(1).length` | 正常返回 `100000` |
| `() => 1`（2026-09-20 补测） | **静默返回 `{}`，且连守卫都没进**（`type:'function'` 落到 `extractEvaluateValue` 的 `else if` 分支，而 `isEmptyObject` 只在 `type === 'object'` 里判）—— V43 |
| 嵌套 300 层的对象（2026-09-20 补测） | 抛 `Failed to convert response to JSON: CBOR: stack limit exceeded` —— **未映射**，V42 |
| `new Map` / `new Error` / `{}` 字面量 | `type:'object'` + `value:{}` → 被 `isEmptyObject` 拒掉（想真返回空对象得写 `JSON.stringify({})`） |

→ 强制 `returnByValue`；**不能只判断 `result.value === undefined`**（DOM 节点那种情况 `value` 是个 `{}`，
看着「有值」其实是垃圾），要**同时检查 `result.type` / `result.subtype`**。
**已知缺口**：`type === 'function'` 那条（V43）静默给 `{}`，以及 CBOR 深度错误没进
`translateEvaluateError`（V42）—— 两处都在 `src/browser-cdp/execute.ts`，改前先看 §6 方法论。
自己实现超时 —— V2 证明页面被断点暂停时命令仍能正常返回，但挂起风险不能因此排除。
**工具侧其实有三层超时**（2026-09-20 核）：工具声明的 `timeoutMs`（`tool-browser/index.ts`，
导航族 60s / 观察族 30s，由上游 `@deepseek-ai/dsh-tool-call-timeout-policy` 强制 → `TOOL_TIMEOUT`）、
provider 的 `commandTimeoutMs`（30s，`provider.ts:1010` → `BrowserError('BROWSER_PROTOCOL_ERROR')`）、
以及 `navigationTimeoutMs`(15s) / `waitTimeoutMs`(10s) / `WHEEL_ACK_TIMEOUT_MS`(2s) 这几个专用上限。
**默认生效的是最内层**：挂住的 `Runtime.evaluate` 是 30s 后由 `commandTimeoutMs` 收掉，不是 60s。

---

## 5. U1c 为什么是「无法判定」而不是「未测」

`Network.setCacheDisabled` 试了四种观测路径，全部不成立：

| 观测路径 | 结果 |
|---|---|
| 跨源 data URL 页面 `fetch()` 同 URL ×3 | `hit=1,2,3` —— 每次都到服务端 |
| 同源 http 页面 `fetch()` + `Network.responseReceived.fromDiskCache` | `fromDiskCache=false` ×3 |
| **完全不用 CDP** 的对照组 | `srv=1,2,3` —— **所以不是 CDP 的问题** |
| `<img>` 子资源（走 MemoryCache） | 命中缓存 ✓，但**显式设 `cacheDisabled=true` 也照样命中** → 该缓存不受此设置管辖，**没有分辨力** |

→ 本机 http 缓存对 `fetch()` 响应不生效，唯一可命中的 `<img>` 走的是 `cacheDisabled` 管不到的 MemoryCache。
**没有观测面，就判不了作用域。**

**处置：按最坏假设处理** —— 要么不使用 `setCacheDisabled`，要么与 `Emulation` 同等对待（纳入簿记）。

---

## 6. 方法论

**同一 domain 内的不同命令，作用域也可以不同。** 所以**每接入一个写状态的 CDP 命令都要单独实测，
默认按「共享」处理**。复现模板见 `cdp-behavior-probe` skill。

三条曾推翻自己结论的教训：

1. **V35 为什么必须单独测**：副作用**在「下一次导航」才显形**，不在写入那一刻 ——
   它躲得过所有「写完立刻回读」的检查，也躲得过黑名单（它不在 `Emulation.*` 里，字面看像 `Page` 域的普通导航辅助命令）。
   测法：注册者 **A 不导航**，让 **B 触发导航**，再看新文档里有没有 A 的脚本。
   顺带一条判据细节：**「共享」与「持久」是两件事** —— 它不跨 session 存活，但只要注册者活着，
   任何 client 的导航都吃它的脚本，这才是「跨 client 污染」的判据。
2. **V36 纠正过一次错误判断**：曾写「`RefTarget` 没有 selector，所以定位必须先加字段」——
   那是把 selector 路线当成了唯一路线。实测 `backendNodeId` 本来就是稳定句柄，而且更安全：
   selector 是「**匹配**」语义（重构后可能匹配到另一个元素 → 静默点错）；
   `backendNodeId` 是「**指向**」语义（节点没了只能失败 → 可检出）。
3. **写下「必须先改造 X」之前，先确认现有句柄是不是已经够用了。**

---

## 7. 回归用例的边界（这几条才是「不漏也不重」真正的边界）

新增采集 / 定位 / execute 相关改动时，回归必须覆盖：

1. **console**：① 人工接管窗口内页面产生 console，接管结束后采集器**既不漏也不重**；
   ② 3000 条 Log 后 detach → re-enable，验上限截断**不会变成重复**，且那条 `timestamp=0` 的提示没被高水位吃掉；
   ③ `Runtime` 与 `Log` 各按自己的桶去重、互不串扰。
2. **network**：① 都在 attach 期间 → 完整；② re-attach 之后才完成 → 完整补上（V40）；
   ③ detach 期间发起 → 收到响应事件且被**显式标为 `partial`**（不得静默丢弃）；
   ④ detach 期间**已完成**的 → 断言「确实没来」，不是等它出现。
3. **execute**：① `document.body` 必须被识别为不可序列化，而不是返回 `{}`；
   ② `Network.emulateNetworkConditions` / `setExtraHTTPHeaders` / `setCacheDisabled` /
   `Page.addScriptToEvaluateOnNewDocument` 逐条断言被拒；③ 被拒时错误消息带上 method 全文。
4. **locate**：① 窗口保持可见（V33）；② agent 高亮与人工在 DevTools 里选元素同时进行，互不干扰；
   ③ **元素被 `replaceWith` 换掉后 locate 必须报 `BROWSER_STALE_REF`** —— 专验 `isConnected` 守卫，
   这是 V36 里唯一「只查 resolveNode 会漏」的场景。
5. **DevTools**：连开 / 关 5 次，**ref 纪元一次都不该被推进**。这条现在必然通过
   （`invalidate()` 只由地址变化触发），它的价值是**防回归** —— 接入「观察失效」时最容易顺手拿
   `Inspector.detached` 推纪元。
