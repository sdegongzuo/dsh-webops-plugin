# 浏览器操作 / 调试工具：五个典型场景实测报告

日期：2026-09-14  
驱动：shipped `ElectronBrowserProvider`（`scripts/agent-drive.mjs` → `lib/browser-electron`），真 Electron 窗口，无 fake-llm、无 API key。  
原始 JSON / 截图：会话 scratch（`s1/`…`s5/`）。  
不含此前「百度热搜第五条」路径。

> **状态：9 条问题已于 2026-09-14 逐条修复**，修法与回归测试见文末「剩余问题」表与「修复后的行为对照」。
> 下面各场景保留**修复前**的原始观测，作为问题来源的记录。

## 覆盖

| 能力 | 场景 |
|---|---|
| fill + press + wait | S1 |
| click | S2、S4、S5 |
| scroll + screenshot + locate | S3 |
| tabs list / activate / close + 弹窗收编 | S4 |
| snapshot | 全部 |
| execute + console + network + stale-ref | S5 |

## 场景

### S1 Wikipedia 门户搜索（fill / press / wait / snapshot）

`open https://www.wikipedia.org/` → snapshot → fill 搜索框 `e11`「Electron (software)」→ press Enter → waitfor 文本 Electron → snapshot。

- fill 成功。
- press 已导航到中文维基搜索 URL，但 **`title` 为空串**；等 waitfor 之后才出现「“Electron (software)”的搜索结果」。
- 门户语言 combobox 停在「ZH」，英文 query 落到 `zh.wikipedia.org`。工具本身没点错框。

**问题（已修 #1）：** 导航型 press 的即时结果里 title 可能仍是空的，不能当「页已就绪」。
改后 provider 会等新文档可用（标题出现或 `readyState=complete`，上限 5s）再返回。

### S2 example.com 点击跳转（click / wait / snapshot）

`navigate https://example.com/` → 点「Learn more」（`e216`）→ 等待 → snapshot。

- click `navigated: true`，落地 `https://www.iana.org/help/example-domains`，标题 `Example Domains`。
- 后续 snapshot 31 个 ref，结构正常。

**本场景无问题。**

### S3 长文滚动 + 截图（scroll / locate / screenshot）

`navigate https://en.wikipedia.org/wiki/Web_browser` → snapshot → locate 目录「History」→ 截图 → scroll dy=1200 → 再 locate / 截图。

- snapshot **`truncated: true`**（800 行、220 refs）。
- locate 默认把元素滚到视口中心（`centered: true`），所以不能用 locate 验证 scroll。
- scroll 成功；截图从文首变成 History 节。
- 截图分辨率 2374×1498。

**问题（已修 #2/#3/#4）：** 长页大纲截断；locate 默认改视口；scroll 必须有 ref。
改后：`webpage_snapshot` 支持 `max_lines` 且截断可解释；locate 默认不动视口并回 `in_viewport`；scroll 的 `ref` 可省（落在视口中心）。

### S4 新窗口收编（click / tabs）

`https://the-internet.herokuapp.com/windows` 点「Click Here」。

- 当前页不导航；约 2.5s 后 `t2` 出现，`url=…/windows/new`，`title=New Window`，`active: true`。
- activate t1 / close t2 都成功。
- t2 snapshot：`refs: 0`（页上几乎只有 heading，不分配可操作 ref）。

**收编主路径无问题。** heading-only 页没有 click/scroll 入手点，是能力边界 —— 现在 snapshot 会明说「没有任何可操作元素」，且 scroll 不带 ref 也能用（#4）。

### S5 调试：execute / console / network + stale-ref

httpbin.org/html 上 `console.log` + `fetch('/get')`，再故意用过期 ref 点击。

- execute 同步表达式成功；`document.title` 为空。
- console 收到 `dsh-probe-s5` / `dsh-probe-warn`。
- **Runtime 时间戳约 `1789316252`（秒），Log 时间戳约 `1789316204273`（毫秒）**——`console.ts` 把 Runtime timestamp `/1000`，按微秒折算，当前 Chromium 已是毫秒。
- `fetch('/get').then(r => r.status)` 抛 `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`，但 network 里已有 `GET https://httpbin.org/get` **status 200**。
- console/network 缓冲跨 Wikipedia、the-internet、httpbin 累积，没有「当前文档」过滤。
- 导航到 example.org 后点旧 ref `e471` / `e216`：正确抛 `BROWSER_STALE_REF`（epoch 17）。

**stale-ref 无问题。** 时间戳单位、Promise evaluate、跨页缓冲是实问题 —— 三条均已修（见下）。

## 剩余问题（**2026-09-14 已逐条修复**）

| # | 严重度 | 问题 | 复现 | 修复 | 回归测试 |
|---|---|---|---|---|---|
| 1 | 中 | 导航型 press 立刻返回的 title 可能为空 | Wikipedia 搜索 Enter | 检测到导航后 `settleDocument()`：等标题出现或文档 `complete`（上限 `MUTATION_NAVIGATION_SETTLE_MS=5s`），超时不算失败 | `provider.test.ts`「waits for the new document title after a navigating press」 |
| 2 | 中 | 长页 snapshot 截断 | en.wikipedia.org/wiki/Web_browser | 新增 `max_lines`（1-5000，字符预算按 `行数×60` 同步放大）；`buildOutline` 记 `droppedElements`，结果里报「截到第几行 + 少给多少元素 + 怎么拿更多」 | `snapshot.test.ts`（`droppedElements` / `resolveSnapshotLimits`）、`tool-browser`「#2 long-page truncation is explainable」 |
| 3 | 中 | locate 默认 scrollIntoView | 先 scroll 再 locate | `scroll` 默认改 **false**（只读、不动视口），并回 `in_viewport` —— 这样 locate 才能验证 scroll 生效没有 | `provider.test.ts`（默认不滚动 / `scroll=true` 才居中 / `in_viewport:false`）、`tool-browser`「#3」 |
| 4 | 低 | scroll 必须带 ref | 与 0-ref 页叠加 | `ref` 变可选：不给就落在视口中心（`viewportCenter()`），不再要求先 snapshot | `provider.test.ts`「scrolls at the viewport centre when no ref is given」、`tool-browser`「#4」 |
| 5 | 低 | heading-only 新标签 0 refs | the-internet /windows/new | snapshot 结果显式说明「没有任何可操作元素」并给出替代动作（不带 ref 的 scroll / navigate / execute） | `tool-browser`「#5/#9」 |
| 6 | 高 | console Runtime/Log 时间戳差 1000× | execute console.log 后读 console | `normalizeTimestamp()` 按量级判单位（秒/毫秒/微秒 → 毫秒），不再硬编码微秒 | `console.test.ts`（`normalizeTimestamp` 三条 + 「两个域同一把尺子」） |
| 7 | 高 | evaluate Promise 报错但副作用已发生 | `fetch('/get').then(...)` | `Runtime.evaluate` 强制 `awaitPromise`；`exceptionDetails` 取真实异常文本；`UNSERIALIZABLE` 消息里写明「表达式已执行，副作用不回滚」 | `provider.test.ts`（`awaitPromise` 强制 + 异常文本）、`execute.test.ts`（promise 子类型 / `extractEvaluateException`） |
| 8 | 中 | console/network 跨导航不清空 | 多页之后读 network | 条目带文档序号，导航时 `noteDocumentChange()`；`read`/`list` 默认只给当前文档并报 `earlierDocuments`，`all_documents=true` 可读全部（过滤，不丢） | `console.test.ts` / `network.test.ts` / `provider.test.ts`（跨文档作用域） |
| 9 | 低 | 空 title / 0 ref 缺少「无结构」提示 | httpbin.org/html | 空标题渲染成 `title: (empty — …)`；零 ref 单独一条提示；mutation 导航后标题为空也会说明「可能还在加载」 | `tool-browser`「#9」「#5/#9」 |

S2 点击跳转、S4 弹窗收编、S5 stale-ref 按设计工作，未改动。

### 修复后的行为对照（摘要）

| 场景 | 改前 | 改后 |
|---|---|---|
| `webpage_press` Enter 跳转 | 立刻返回 `title: ""` | 等新文档可用，返回真实标题（上限 5s，超时不失败） |
| 长文页 `webpage_snapshot` | `truncated: true`，无下文 | `truncated` + `outline_lines` + `dropped_elements` + `max_lines` 参数可按需放大 |
| `webpage_locate` | 默认把元素滚到视口中央（`centered: true`） | 默认不动视口，回 `centered: false` + `in_viewport`；要居中传 `scroll: true` |
| `webpage_scroll` | `ref` 必填 | `ref` 可省，落在视口中心（长页 / 零 ref 页可用） |
| `webpage_console` | Runtime 时间戳比 Log 小 1000 倍 | 两域同一把尺子（毫秒） |
| `webpage_execute` `fetch(...).then(...)` | `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`（但请求已发出） | 等 Promise 落定返回值；抛错时给真实异常文本 |
| 导航后读 console/network | 上一个页面的条目混在里面 | 默认只给当前文档 + `earlier_documents` 计数；`all_documents` 可读旧文档 |

