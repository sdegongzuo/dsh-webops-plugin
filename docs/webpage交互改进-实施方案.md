# webpage 交互改进

加任务必须能填进 §2 的某一条 J；填不出就不做。
与 `docs/多会话防冲突-实施方案.md` 的边界：那份管「静默点错」，本份管「动作没按意图落地 / 工具把 agent 卡住 / 回执不够模型决定下一步」。

## 1. 目标

让 agent 用 webpage 工具跑完「搜索 → 打开结果 → 返回 → 再打开」时：每一次动作要么按意图生效，要么用本插件自己的错误码和回执告诉它下一步做什么。

## 2. 验收

| # | 判据 | 达标 |
|---|---|---|
| **J1** | 无遮挡时，直链 / 重定向链 / `target=_blank` 一次 `webpage_click` 能跳或开新标签。有遮挡时，不得报「click done、页面没变」而不提遮挡 | 夹具：fixed 遮罩盖住链接（必须报遮挡）→ 拿掉遮罩再点（必须导航或 `opened_tabs`）。真机：知乎登录浮层盖住外链同样两条 |
| **J2** | `webpage_fill` 写入的值就是随后提交的值 | 夹具（可信 input + 假联想）+ 真机谷歌首页 fill 后提交，URL `q=` 等于填入词 |
| **J3** | 节点已毁、文档已换，mutate 报 `BROWSER_STALE_REF`，禁止 `CDP error: No node with given id found` | 单测 mock `resolveNode` 抛错；真机对已导航走的旧 ref 再 fill |
| **J4** | 回到上一页走 `webpage_navigate`，禁止 `webpage_execute("history.back()")` | 单测 back 成功 / 尽头失败；真机打开结果 → back → 再打开另一条 |
| **J5** | 回执足够决定下一步：遮挡、截断、导航后不要 find、stable 超时改等文本 | §6「禁止再出现」清单为空 |
| **J6** | `webpage_scroll` 3s 内返回；后台标签先 activate 或明确拒绝。禁止 30s 工具超时 | 前台长文、前台另一站点、后台标签 各一次 |
| **J7** | `webpage_execute` 的返回值边界与实测一致：拿不到真值的形态一律报 `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`，**禁止静默回 `{}`**，且文案给出可执行写法 | 单测用**实测形态**夹具（`{type:'function', value:{}}`、CBOR 报文）钉住；打包态真跑 `() => 1` 与 300 层对象，都必须报错且带写法 |
| **J8** | `webpage_execute` 不得让模型白等满 30s 才知道「没有结果」：挂起的表达式要在调用方可控的期限内收场，且回执照实说明副作用未回滚 | 打包态 `new Promise(()=>{})` 带 `timeout_ms: 2000` → ≤3s 返回失败回执 |

## 3. 施工顺序

必做（不依赖夹具，可并行 B1-a / B1-d / B1-e）：

1. B1-a  `No node with given id` → `BROWSER_STALE_REF`
2. B1-e  scroll 短超时；非前台先 activate
3. B1-d  click `elementFromPoint` 报遮挡
4. B2-d  snapshot 顶部 OVERLAY
5. B2-e  find 在截断缓存上 0 命中要说明加大 `max_lines`
6. B2-b  `webpage_navigate` 的 `back` / `forward` / `reload`
7. B2-a / B2-c  未导航回执 + 提示词
8. `tsc --noEmit` 与 `vitest run` 全绿
9. `pnpm portable:refresh`，**重启** portable-test，跑 §6
10. §6 通过后再考虑 B3（有门禁）

夹具门（B0 之后才动代码）：

| 夹具结果 | 做 | 不做 |
|---|---|---|
| B0-1：mousedown 改 href 后 click 到不了 `/dest` | B1-b | — |
| B0-1：已经到 `/dest` | — | 删 B1-b |
| B0-2：fill 后 `isTrusted===false` 且提交值被联想覆盖 | B1-c，然后才允许 B3-a | — |
| B0-2：setter 已够用 | 只做提示词里的 fill+Enter | 不做 insertText |

## 4. 任务

每条：改什么 → 文件 → 单测 → 完成标准。动代码前按符号名核对，别按过期行号。
`ElectronBrowserProvider` 继承 `CdpBrowserProvider`，改 `src/browser-cdp/provider.ts` 两边一起生效。

### B0 夹具

**B0-1** 本地页：

```html
<a id="rewriter" href="/goto?url=placeholder"
   onmousedown="this.href='/dest'">rewrite-on-mousedown</a>
```

`webpage_click` 后 URL 不是 `/dest` → 做 B1-b；已经是 `/dest` → 删 B1-b。

**B0-2**

1. `<input>` 监听 `input`，记 `event.isTrusted`。fill 后若只有不可信 input → 做 B1-c。
2. 输入框 + 假下拉（focus 高亮一项；submit 时若下拉开着就提交高亮项）。

结论写在本条下面一行（成立 / 不成立）。未写之前 B1-b / B1-c 不得标完成。

**夹具**：`scripts/probe-b0-gate.ts`（真 Chrome + `DSH_CDP_ENDPOINT`，跑法见文件头）。

#### B0 结论（2026-09-19 实测，Chrome 153 headless）

- **B0-1：不成立** —— click 之后 `location=/dest`，`navigated=true`（mousedown 改写的 href 生效）。
  → **删除 B1-b**，click 序列保持 `mousePressed` + `mouseReleased`，不改。
- **B0-2：半成立** —— fill 只产生 1 条 `input` 事件且 `isTrusted=false`（不可信，成立），
  但**提交出去的 `q=` 等于填入词**，没被联想覆盖（不成立）。
  反向验证过夹具是活的：手动 `focus()` 之后再提交，`q` 确实被改写成「联想项一」。
  → 覆盖没发生的原因不是「站点不覆盖」，而是**我们的 fill 压根不 focus，联想就没开**。
  → **B1-c 降级：不做 `Input.insertText`**，只做提示词里的「fill 后对同一 ref 按 Enter」。
  → B3-a（`submit: true`）前置 B1-c 不成立，**不做**。

一个反直觉的实测细节（写下来免得后人误判）：`focus()` 之后 `document.activeElement` 立刻是目标元素，
但旁路 `Runtime.evaluate` 读出来的 `window.__suggestOpen` 一直是 `false`（等 200ms 也是），
而提交时页面脚本自己看到的是 `true`。所以 B0-2 的判据只认**提交结果**，不认旁路读出的布尔。

### B1-a  mutate 与 locate 共用「节点没了」（J3）

`locate` 已把 `DOM.resolveNode` 抛错收成 `BROWSER_STALE_REF` `node_gone`。`resolveObjectId`（click/fill/press）只处理返回体缺 `objectId`，Chrome 抛 `No node with given id found` 时变成 `BROWSER_PROTOCOL_ERROR`。

抽出私有方法给 locate / resolveObjectId / screenshot / revalidate 共用：

- `BROWSER_DEBUGGER_DETACHED` / `BROWSER_CONNECTION_LOST` 原样上抛
- 其它 `resolveNode` 失败以及缺 `objectId` → `BROWSER_STALE_REF` `reason: node_gone`，文案与 locate 对齐
- `noteStale(..., 'node_gone')`

文件：`src/browser-cdp/provider.ts`，`src/browser-cdp/provider.test.ts`（mutate 路径 mock `resolveNodeError = 'No node with given id found'` → `BROWSER_STALE_REF`，不是 `BROWSER_PROTOCOL_ERROR`）。

完成：该文件 vitest 绿；工具层看不到 `CDP error:` 前缀。

### B1-b  click 鼠标序列 —— **已删除**（B0-1 不成立）

B0-1 实测：mousedown 改写 href 的链接，现有 `mousePressed` + `mouseReleased` 已经能到 `/dest`。
不做，click 序列保持原样。若将来出现「hover 才生效」的站点，重跑 `scripts/probe-b0-gate.ts --only=b0-1`
确认后再议。

（原条目：补 `mouseMoved` + `buttons`。）

```
mouseMoved    { x, y, button: 'left', buttons: 0 }
mousePressed  { x, y, button: 'left', buttons: 1, clickCount: 1 }
mouseReleased { x, y, button: 'left', buttons: 0, clickCount: 1 }
```

落点仍是元素视口盒中心，先 `scrollIntoView`。

文件：`src/browser-cdp/provider.ts` `click`；`src/browser-cdp/provider.test.ts` 现期望 `['mousePressed', 'mouseReleased']` 的用例改成新序列并断言 `buttons`。

完成：B0-1 夹具到 `/dest`。B0-1 不成立则本条删除，不改 click 序列。

### B1-c  fill 聚焦 + 可信输入 —— **降级为提示词**（B0-2 半成立）

`FILL_FUNCTION` 对 input/textarea 走原型 setter + 不可信 `input`/`change`，不 focus。contenteditable 才 focus + 全选 + `Input.insertText`。

1. 所有分支先 `focus()`。
2. input/textarea：保留原生 setter（React 受控），再 `select()`，provider 发 `Input.insertText`。若插入后值打两遍，改为「全选 + insertText，setter 仅当 `element.value !== 期望` 时回退」。
3. 不要默认 Escape。收起联想只放在 B3-a 的 `submit: true`。

文件：`src/browser-cdp/provider.ts` `FILL_FUNCTION` + `fill`；`src/browser-cdp/provider.test.ts` 现有 fill 用例仍绿，并断言 input 路径会 focus + insertText。

完成：夹具提交值等于填入值。真机谷歌首页 fill 后 `q=` 等于填入词（点搜索按钮若仍失败，算 B3-a / 提示词，不判 B1-c 失败）。

**降级后的范围（2026-09-19）**：不改 `FILL_FUNCTION`、不发 `Input.insertText`。
理由见上面 B0 结论 —— 不可信输入确实是现状，但「不 focus」反而让联想压根不开，
提交值因此没被覆盖；改成可信输入会把联想打开，反而更容易被覆盖。
只做 B2-c 提示词第 1 条：「带联想的搜索框：fill 后对同一 ref 按 Enter，不要点提交按钮」。

### B1-d  click 命中校验（J1）

click 滚到元素中心再发鼠标事件。浮层盖住中心时事件打在遮罩上，回执仍是 `click done`、`navigated=false`、无 `opened_tabs`。

`scrollIntoView` 之后、派发之前，对落点 `document.elementFromPoint(x, y)`，用 `backendNodeId` 或 `contains` 判断是否属于目标子树。

- 命中目标或其子孙：照常 click
- 命中其它节点：事件仍发出，回执必须带 `occluded_by: { role?, name?, ref? }`，文案「目标被浮层/其它元素盖住；先关遮罩或对遮罩上的控件操作」
- `navigated===false` 且无新标签且被遮挡：遮挡文案优先于 B2-a 的 href/Enter

不做：自动 Escape；自动改点遮罩上的按钮。

文件：`src/browser-cdp/provider.ts` `click`；`src/browser/types.ts`；`src/tool-browser/index.ts` `formatMutationOutput`；fixed 遮罩夹具 + `provider.test.ts`。

完成：夹具盖住链接 → 回执含遮挡、无 `opened_tabs`；拿掉遮罩 → 导航或 `opened_tabs`。真机知乎登录浮层同样两条。

### B1-e  scroll 短超时（J6）

`scroll` 发 `Input.dispatchMouseEvent({ type: 'mouseWheel' })`，超时用 `commandTimeoutMs`（默认 30s），与工具 `BROWSER_OBSERVE_TIMEOUT_MS=30_000` 对齐。命令不回包时 agent 卡 30s。后台标签收不到 wheel。

1. wheel 专用短超时（2s），与 `commandTimeoutMs` 脱钩。超时不当工具失败：返回 `action=scroll`，标明已投递未确认，让模型 `webpage_locate` 或再 snapshot。
2. 目标不是前台时先 `activate` 再动手（优先），或拒绝并写 `session_id=… is in the background; webpage_tabs(action=activate) first`。
3. 若确认 Electron 上 `mouseWheel` 不回包，记 `docs/CDP实测事实.md` 一条。本条不堵死在根因。

文件：`src/browser-cdp/provider.ts` `scroll`；mutate 复用 tabs 的 activate；`src/tool-browser/index.ts` 回执文案。单测：mock mouseWheel 超过 2s 不回 → 返回 mutation，不抛 tool timeout。

完成：§6 场景 F 三次调用都在 3s 内返回。允许「已投递未确认」。禁止 `tool call timed out after 30000ms`。`window.scrollTo` 不是本条产品路径。

### B2-a  click 未导航回执（J1 / J5）

`BrowserMutationResult` 增加 `target?: { role, name, href? }` 和 B1-d 的 `occluded_by`。`navigated===false` 且没有新标签时，按顺序：

1. 有 `occluded_by` → 遮挡
2. 否则有 http(s) href → role/name/href，下一步 `webpage_press Enter` 或 `webpage_navigate`
3. 否则 → 可能是 JS 按钮，建议 snapshot 看是否出现对话框

不做：自动按 Enter。

文件：`src/browser/types.ts`、`src/browser-cdp/provider.ts`、`src/tool-browser/index.ts`（`MutationOutput` + `formatMutationOutput`）及对应测试。

完成：单测钉「未导航 + 有 href」和「未导航 + 被遮挡」两套文案。

### B2-b  `webpage_navigate` 的 history（J4）

`BrowserNavigateRequest` 现只有 `sessionId` + `url`。地址栏后退在 `host.cjs`，agent 看不见。

```ts
export interface BrowserNavigateRequest {
  readonly sessionId: string
  readonly url?: string
  readonly history?: 'back' | 'forward' | 'reload'
}
```

恰好一个。CDP（因而 Electron）：

- `back` / `forward`：`Page.getNavigationHistory` → `Page.navigateToHistoryEntry`
- 历史尽头：`BROWSER_NAVIGATION_FAILED`，消息写明 `cannot go back` / `cannot go forward`，禁止静默 no-op
- `reload`：`Page.reload`
- 成功后与现 `navigate(url)` 一样：作废 ref、清 find cache、`settleDocument`

工具层：`url` 不再 required；增加 `history`。描述写明互斥、作废 ref。不必把 `Page.getNavigationHistory` 放进 `webpage_execute` 白名单。不改 `host.cjs` 地址栏 IPC。

文件：`src/browser/types.ts`、`src/browser-cdp/provider.ts` `navigate`、`src/browser-cdp/provider.test.ts`、`src/browser/index.test.ts`、`src/tool-browser/index.ts` + `index.test.ts`。

完成：单测 back 成功、尽头失败、与 url 同时传被拒；§6 场景 C 步骤 3 走新参数。

### B2-c  回执与提示词（J5）

不新增工具。

1. `navigated=true`：NAVIGATION DETECTED 后追加「下一步是 `webpage_snapshot`，不是 `webpage_find`」
2. `webpage_find` 的 `BROWSER_SNAPSHOT_REQUIRED`：含「上次大纲已因导航或全页 snapshot 作废」
3. `until=stable` 且未满足且 `network=busy` 或 `readyState=loading`：改用 `webpage_wait(text=…)`，不要加长 stable
4. `tool:browser` 系统提示加五条（保持短）：
   - 带联想的搜索框：fill 后对同一 ref 按 Enter，不要点提交按钮
   - 长页：第一次全页 snapshot 之后用 find + `region_ref`；不要把 `max_lines` 加到默认 800 以上，除非 `truncated=true`
   - 等生成或等结果区：优先 `wait(text=…)`
   - 点击无导航、无新标签：先看回执是否报遮挡，不要先查 console/network
   - 找弹窗：不要把 `max_lines` 压到默认以下；`truncated=true` 时加大再找，浮层经常排在大纲末尾

文件：`src/tool-browser/index.ts` + `index.test.ts`。

完成：单测锁文案；§6 禁止清单为空或每条有挂 J 的残留说明。

### B2-d  snapshot 顶部标记浮层（J1 / J5）

无 `role=dialog` 的浮层在 AX 里排在 `<body>` 末尾。小 `max_lines` 把它截掉，看起来页面可直接点正文。

全页 snapshot 发出大纲前，对视口中心 `elementFromPoint`。命中节点对应的大纲行不在已发出的前 30 行（或根本没 emit）时，大纲最顶部加一行：

`OVERLAY at viewport center: <role/name/ref or class> — this covers the page; actionable controls may be at the end of the outline. Raise max_lines if truncated.`

一次 evaluate。有 `role=dialog` / `aria-modal` 时优先用那个名字。

不做：自动关弹窗；为浮层改 AX 折叠规则。

文件：`src/browser-cdp/provider.ts` snapshot 路径；`src/browser-cdp/snapshot.ts` 把该行插到 render 最前；fixed 遮罩夹具。

完成：浮层在时，即使 `max_lines=60`，回执第一屏有 OVERLAY；关掉后该行消失。

### B2-e  截断大纲上的 find（J5）

`webpage_find` 搜已发出的大纲文本，不是完整 ref 表。`truncated=true` 时 0 命中经常是截掉的那截。

find 0 命中且缓存标记了 truncated：文案必须含「上次 snapshot 被截断；加大 max_lines 再拍再 find」。缓存要留下 `truncated` 标志。

不做：自动重拍全量。

完成：单测截断缓存 + 0 命中 → 文案含 truncated / max_lines；不发 CDP。

### B3-a  `webpage_fill({ submit: true })` —— **不做**（前置 B1-c 已降级）

`submit: true`：fill → Escape（失败忽略）→ 同一 ref Enter。`settleMutation` 按 press（可能导航）。

完成：单测序列；真机谷歌首页一条 fill+submit，`q=` 不被改写。

### B3-b  快照降噪（有门禁）

无门禁、先做：全页 snapshot 末尾一行「N refs。要对已知控件动手：`webpage_find` 再 `region_ref`。默认 max_lines 已是 800。」

| 门 | 不达就停 |
|---|---|
| B2-c 落地后模型仍每次 `max_lines>=1500` 或仍全页重拍 | 才做 compact |
| compact 的 AX 角色过滤会藏掉至少一个可操作主路径控件 | 整条 compact 删除 |
| navigated 回执夹带 `max_lines=80` 大纲，体积达到当前全页 snapshot | 不做夹带 |

增量 diff 本方案不做，见多会话方案 P4。

### B3-c  scroll 降级 `window.scrollBy`（前置 B1-e，有门禁）

B1-e 落地后场景 F 仍「前台标签 scroll 后位置完全没变」才做。「已投递且位置变了」不算。

短超时未确认且 `window.scrollY` 未变：再 `Runtime.evaluate('window.scrollBy(0, dy)')` 一次，回执标明 JS 兜底。

### B4 真机回归

见 §6。`pnpm portable:refresh` 后必须重启实例。

## 5. 不做

| 不做 | 原因 |
|---|---|
| `webpage_find` 自动补 snapshot | 没观察过的页面没有 ref；导航后的动作是 snapshot |
| 改 `detectNavigation`：query 变化不当导航 | 软导航必须作废 ref |
| click 失败自动 Enter 或自动 Escape | 误触菜单 / 误关对话框 |
| fill 默认 Escape | 误关 combobox；只放 `submit: true` |
| agent 走 `host.cjs` 地址栏 IPC 后退 | 与 CDP provider 分叉；走 `Page.getNavigationHistory` |
| 默认用 `window.scrollTo` 替代滚轮 | 嵌套滚动容器会错；先 B1-e，B3-c 才是门禁兜底 |
| 聊天页适配器 / 增量 snapshot diff | 不服务本方案的 J；diff 归多会话 P4 |
| 为纯文本模型禁止 screenshot | 用户侧仍要存档 |
| 站点特殊规则 | 夹具能表达的通用问题才改代码 |

## 6. 真机回归

### 6.0 本轮实际跑了什么（2026-09-19）

| 层 | 怎么跑的 | 结果 |
|---|---|---|
| 单测 | `pnpm typecheck` + `pnpm test` | **478 通过 / 5 skipped**（基线 458 → +20），tsc 干净 |
| 真浏览器判据 | `scripts/probe-webpage-j.ts`（真 Chrome 153 + `DSH_CDP_ENDPOINT`） | **7/7**：J1-a 遮挡回执、J1-b 拿掉遮罩后真跳 `/dest`、B2-d OVERLAY 出现、B2-d 反向消失、J6 长文 scroll 8ms、J6 另一站点 9ms、J4 `history=back` 回 `/p1` |
| B0 决策夹具 | `scripts/probe-b0-gate.ts`（真 Chrome） | B0-1 不成立（删 B1-b）、B0-2 半成立（B1-c 降级） |
| 打包态冒烟 | `pnpm portable:refresh` → 杀旧实例 → `portable:launch --cdp 9333` | 19387 宿主起来了、GUI 无 `did not activate` / 无「重新连接中」；`home/.../dsh-webops-plugin/lib/provider-*.js` 里能 grep 到 `OVERLAY at viewport center` / `elementFromPoint` / `navigateToHistoryEntry` —— 打进去的确实是新代码 |

**没跑**：§6 场景 A/B/C 里「模型会不会照回执走」那一层 —— 那要 GUI 会话 + 真实 LLM 逐轮对话，
本轮用真浏览器探针 + 单测把**判据**钉住了，模型行为待下一轮真机会话验。

---

目录：`DSH_PORTABLE_TEST_DIR`。每批：`pnpm portable:refresh` → 重启 → **新建会话**。

### A 搜索框对话

打开 Google → snapshot → 点「AI 模式」→ fill 中文 + Enter → `webpage_wait(text=…)` → 再一轮 fill+Enter。

通过：两次命中输入框；不用 `until=stable` 在 `network=busy` 时加长空等。

### B 联想覆盖

首页 fill「2026年大语言模型发展趋势」→ 点「Google 搜索」。`q=` 必须等于填入词（B1-c / B3-a 完成后）。未做 B1-c 时允许步骤失败，但 fill+Enter 必须成功，且导航后不得立刻 find。

### C 打开 / 返回 / 再打开

结果页再搜一个词 → 点直链（`navigated=true`）→ `webpage_navigate(history=back)` → 再点一条重定向链。禁止 `webpage_execute`。click 未导航时回执必须带遮挡或 href/下一步。

### D 旧 ref

上一轮结束后不新 snapshot，对旧 ref fill。必须 `BROWSER_STALE_REF`，全文没有 `CDP error: No node with given id found`。

### E 浮层

打开会弹出登录浮层的知乎专栏（或 fixed 遮罩夹具）。

1. `webpage_snapshot(max_lines=60)`：第一屏有 OVERLAY
2. 点浮层下的外链：回执报遮挡
3. 关掉浮层再点：`opened_tabs` 或导航
4. 小快照 find 弹窗文案：0 命中提到 truncated；加大 `max_lines` 后能命中

### F 滚动

1. 前台长文 `webpage_scroll(delta_y=300)`：3s 内返回
2. 切到另一标签，再对后台那页 scroll：自动 activate 或明确拒绝，禁止干等 30s
3. 前台另一站点同样一条：3s 内返回

允许「已投递未确认」。位置完全没变且反复如此才触发 B3-c。

### 禁止再出现

- `Error: CDP error: No node with given id found`
- `webpage_execute` 且表达式含 `history.back`
- 导航后、snapshot 前的 `webpage_find`
- click 无跳转之后去 tabs / console / network 猜原因
- `Error: tool call timed out after 30000ms` 来自 `webpage_scroll`
- 有浮层时 snapshot 第一屏不提 overlay

## 7. 完成

### 7.0 逐条对照（2026-09-19）

| 条目 | 状态 | 说明 |
|---|---|---|
| B0 夹具 | ✅ | 结论已写在 §4.B0 下 |
| B1-a `No node with given id` → `BROWSER_STALE_REF` | ✅ | `resolveBackendNodeId` 给 locate / mutate / 元素截图 / revalidate 共用一套口径 |
| B1-b click 鼠标序列 | ⛔ 删除 | B0-1 不成立 |
| B1-c fill 聚焦 + 可信输入 | ⤵️ 降级 | 只做提示词（B3-a 随之不做） |
| B1-d click 命中校验 | ✅ | 真机 J1-a / J1-b 绿 |
| B1-e scroll 短超时 + 前台 | ✅ | 真机 J6 8ms / 9ms |
| B2-a 未导航回执 | ✅ | 遮挡 → href → JS 控件，三套文案单测钉住 |
| B2-b `navigate` history | ✅ | 真机 J4 绿；尽头报 `BROWSER_NAVIGATION_FAILED` |
| B2-c 回执与提示词 | ✅ | 四条回执 + 系统提示五条 |
| B2-d snapshot OVERLAY | ✅ | 真机绿（含反向） |
| B2-e 截断 find 文案 | ✅ | 缓存留 `truncated`，0 命中时才提示 |
| B3-a `submit: true` | ⛔ 不做 | 前置 B1-c 已降级 |
| B3-b 快照降噪 | ✅ 只做「无门禁」那半 | 末尾一行 N refs + 默认 max_lines |
| B3-c scroll 降级 `window.scrollBy` | ⤵️ 未触发 | B1-e 落地后位置有变，门禁未达 |
| B4 真机回归 | 🟡 部分 | 见 §6.0：判据全绿，模型侧端到端未跑 |

1. B1-a、B1-d、B1-e、B2-a、B2-b、B2-c、B2-d、B2-e、B4 全绿
2. B0 结论已写在 §4.B0 下；成立的 B1-b / B1-c 已落地，不成立的标明删除
3. §6 场景 A–F 跑过一轮，禁止清单为空或每条残留挂 J 编号
4. B3 可以没做；做了必须过门禁

未满足第 1 条就发版，等于没做本方案。

B1/B2 落地后再回写 `docs/架构与实现.md`（click 命中校验、scroll 短超时、navigate history、snapshot OVERLAY）。没落地之前不要改架构文档。

---

## 8. 第二批（待定 · 2026-09-20 复核新增）

来源：一份对 `webpage_execute` 的批评（7 条）+ 一轮对照实测。原始事实与实测编号在
`docs/CDP实测事实.md` 的 **V41–V45**，这里只写「改什么」。**7 条批评里只有下面这些进了清单**，
其余（副作用不可回滚、暴露 contextId、execute 聚合 console/network）见本节的「不做」表。

### 8.1 任务

> 状态见 **§8.4**：B5-a～B5-d 已落地（2026-09-20），只剩打包态回归待跑。下面的描述保留当时的原始判据。

**B5-a 函数返回值静默 `{}`（必修 · 对应 J7）**

- 病灶：`src/browser-cdp/execute.ts` 的 `extractEvaluateValue`，`isEmptyObject` 判定写在
  `type === 'object'` 分支**内**。实测 `() => 1` → CDP 回 `{type:'function', value:{}}`，
  落到 `else if (value === undefined && type !== 'undefined')` 直接放行 → 模型拿到一个
  看着有值、其实是垃圾的 `{}`。**这正是那条守卫想防的形态，只是漏了函数这条分支。**
- 改：把「空值/不可序列化」判定提到类型分支之外（`isEmptyObject(value)` 对所有类型生效），
  并显式拒绝 `type === 'function'`；`type === 'undefined'` 仍放行。
- **夹具必须照实测改**：现有 `src/browser-cdp/execute.test.ts:121` 用的是 `{type:'function'}`
  （**没有 `value` 字段**）—— 实测不会出现这个形态，所以它绿着而生产漏着。换成
  `{type:'function', value:{}}`，旧形态作为额外一例保留。
- 完成标准：新单测先红后绿；打包态 J7 第一条真跑过。

**B5-b CBOR 深度错误没翻译（必修 · 对应 J7）**

- 病灶：同文件 `translateEvaluateError` 只映射 `Object reference chain is too long` 与
  `Object couldn't be returned by value`。实测**250 层正常、300 层起**报
  `Failed to convert response to JSON: CBOR: stack limit exceeded at position 3040` →
  模型拿到裸 `BROWSER_PROTOCOL_ERROR`，看不出这是深度问题。
- 改：加一条 `CBOR: stack limit exceeded` pattern → `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`，
  文案指向「分片 `JSON.stringify` 取需要的字段」。
- 完成标准：单测断言 code + 文案；打包态 300 层对象真跑过。

**B5-c execute 描述补三句（低成本，但决定模型用不用得对）**

- 位置：`src/tool-browser/index.ts` 的 `webpage_execute` description。
- 三句：① 顶层 `let`/`const`/`var` **在同一个文档内跨调用存活**（V41），**不必挂 `window`**，
  但**重复声明会 `SyntaxError: Identifier has already been declared`**，换变量名；
  ② 深对象（>250 层）会被 CDP 拒，取字段用分片 `JSON.stringify`（V42）；
  ③ 改受控组件（React/Vue）走 `webpage_click` / `webpage_fill` / `webpage_press` 这条
  `Input.*` 真输入路径 —— evaluate 直接改 DOM 会被下一次渲染覆盖，而**隔离世界也读不到**
  框架挂在 DOM 上的 expando（V45），所以那不是出路。
- 完成标准：三句都在；`pnpm test` 不因描述变长而炸别的断言。

**B5-d `webpage_execute` 可选 `timeout_ms`（P2，有取舍，先想清楚再动）**

- 语义：`min(工具 60s deadline, 传入值)`，只覆盖 provider 传给 CDP 的 `commandTimeoutMs`
  （`provider.ts` 的 `execute()`）。**不改** `Runtime.evaluate` 的 `timeout` 参数 ——
  V44 实测它只杀同步死循环，对挂住的 Promise 无效（可顺带透传当第二道保险，但别当解药）。
- 必须写进描述的代价：对挂住的 Promise 仍只是「白等 N 秒后失败」，**拿不到值**；
  不写清楚，模型会以为它能救回结果。
- 完成标准：单测断言传 2000 时 provider 收到 2000、不传时仍是 30000。

### 8.2 不做

| 不做 | 原因 |
|---|---|
| 执行前自动快照 DOM/全局 + 回滚 | CDP 侧能用的只有 `DOMSnapshot.captureSnapshot` / `Page.captureSnapshot`，两者都不在 execute 白名单；更关键的是改 DOM、改全局、挂监听、换事件处理器**无法一致还原**，做了只会给模型「已回滚」的错觉。真要回到原状只有导航一条路，而它同时清掉调试变量（V41） |
| 暴露 contextId、让 evaluate 走 isolated world | 实测隔离世界读不到主世界 globals，**也读不到 DOM 元素上的 expando**（V45）—— React 的 fiber 正挂在 expando 上，这条路恰好断掉「走框架内部机制改」。隔离世界的用途是反向的：注入不污染页面的探针 |
| 让 execute 一次带回 console/network | 记录**不会**因导航消失（环形缓冲 + `all_documents` 能读回，被遮住多少条会报数），缺的是聚合不是数据；三次调用 + 自己对齐时间窗的成本，小于一次大回执撑爆上下文 |

### 8.3 真机回归（第二批）

1. `pnpm portable:refresh` → 杀旧实例 → `portable:launch --cdp 9333`（`refresh` 后**必须重启**才生效）。
2. 在**打包态**（Electron，不是 Chrome）跑三条：`() => 1` 报 `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`（J7）、
   嵌套 300 层对象报错且带分片写法（J7）、`new Promise(()=>{})` 带 `timeout_ms` 在 ≤3s 内返回失败回执（J8）。
3. **为什么必须在打包态跑**：本清单所有数字都是本机 **Chrome 153 + node 22** 测出来的
   （`D:/tmp/cdp-exec-probe{,2,3}.mjs`），而 Electron 的集成补丁历史上改过 CDP 行为
   （`CDP实测事实.md` V29 就是 `clearDeviceMetricsOverride` 的 Electron 特例）。

**实测记录（2026-09-20 23:43，打包态，✅ 五条全绿）**

环境：`D:/dsh-build/portable-test`；插件层是 23:28 那次 `portable:refresh` 的产物（进包前逐条 grep 过：
`type === "function"` 拦截、`CBOR: stack limit exceeded` 映射、`timeout_ms` 参数与
`typeof args.timeout_ms === "number" ? { timeoutMs: args.timeout_ms }` 转发都在 bundle 里）；
`portable:launch --cdp 9333`，夹具页 `http://127.0.0.1:9788/`。
驱动方式：`cdp-act.mjs click --text 新会话` 新开一个会话 → `cdp-act.mjs type --text "<验收指令>" --submit`
（都是真实鼠标/键盘事件，不是 `element.click()`）。证据：会话轨迹
`home/sessions/--D-dev-cli-dsh-webops-plugin--/session-e87e19d0…/session.v3.jsonl.zstd`。

| 判据 | 表达式 / 参数 | 实测回执（原文） | 耗时 |
|---|---|---|---|
| J7-a 函数不再静默 `{}` | `() => 1` | `Error: the expression's value could not be serialized by CDP: the expression returned a function, which CDP hands back as an empty object. … Return a primitive value or a JSON string (for example JSON.stringify(...)) instead of a DOM node, a cyclic object, a function, a Symbol, or an unawaited Promise.` | 8ms |
| J7-b 深度超限给可执行写法 | 300 层嵌套对象 | `Error: the expression's value could not be serialized by CDP: CDP error: Failed to convert response to JSON: CBOR: stack limit exceeded at position 3040 (the object graph is too deep for CDP to serialize; return the few fields you need as a JSON string of primitives, or walk the object in slices, instead of the whole deep object). …` | 8ms |
| J8 挂住的 Promise 由调用方定期限 | `new Promise(() => {})` + `timeout_ms: 2000` | `Error: CDP command "Runtime.evaluate" did not complete within 2000 ms` | **2019ms** |
| B5-c/V41 变量跨调用持久 | `let __b5 = 41` → `__b5` | 第一条 `(no value returned)`；第二条 `41` | 13ms / 8ms |
| B5-d 参数确实送到 provider | 上面第 3 行的 `timeout_ms` 出现在 tool/call 的 `arguments` 里 | 见上 | — |

- **打包态读数与 Chrome 侧逐字一致**（含 `position 3040`）→ V29 那种 Electron 特例在这批事实里不成立，
  两处读数可以互相当证据用。
- 附一条**非本批**的观察（P2，待议）：失败回执**文本里只有散文、没有错误码** —— 跨 8 份会话轨迹
  grep `Error: … BROWSER_*` **零命中**，码只存在于结构化的 `.code` 里；而工具描述对模型写的是
  「fails with `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`」。描述与回执口径不一致，模型只能靠散文辨识。
  要收口就是把码写进 message 文本（`BROWSER_STALE_REF` 那类老路径同样如此，得一起看）。
  **这一条是跑完让模型自己回读回执时被抓出来的** —— 它的结论表三行都写着「回执原文未出现 error code 字段」。
- 附第二条（P2，待议，**J8 只做了一半**）：超时回执
  `CDP command "Runtime.evaluate" did not complete within 2000 ms` **没有可执行写法、也没说副作用未回滚**，
  而 J8 的原话是「回执照实说明副作用未回滚」。挂住的表达式**还在页面里跑**，说清这点比说清超时更有用；
  文案该落在 `src/browser-cdp/protocol.ts:165`（⚠️ 那个文件目前有并行会话未提交的 loopback 改动，
  动它之前先知会）。建议文案：`… did not complete within N ms; the expression is still running in the page,
  so any side effect it has or will have is NOT rolled back — raise timeout_ms or wrap it in Promise.race([...]).`
- 现场备注：模型写到第 7 步（结论表）时，实例与 9788 夹具**一起消失**了（9333 / 19387 / 9788 同时不再监听）、
  轨迹停在 `step/start`；五条回执在这之前已经落盘，不影响判据。事后确认是**被并行会话杀掉**的
  （不是崩溃），23:49 重启实例 + 夹具后会话仍在，让它「接着补第 6 步」即拿到结论表 ——
  **中断的对话可以续，回执与判据都不依赖它**。

### 8.4 落地记录（2026-09-20）

| 条目 | 状态 | 说明 |
|---|---|---|
| B5-a 函数静默 `{}` | ✅ | `extractEvaluateValue` 新增 `type === 'function'` 分支先拦；`else if` 那条也改成类型无关的空值判定（`type !== 'undefined' && (value === undefined \|\| isEmptyObject(value))`），将来 CDP 加新类型不会再漏。**夹具改成实测形态** `{type:'function', value:{}}`，旧那条 `{type:'function'}`（没有 `value`，实测不出现）保留作对照 |
| B5-b CBOR 深度错误 | ✅ | `translateEvaluateError` 加 `CBOR: stack limit exceeded` 一条，文案指向分片取；夹具带 `(code -32000)` 后缀，与 `mapCdpError` 的真实包装一致 |
| B5-c execute 描述 | ✅ **缩到两句** | 只留「变量跨调用持久 + 重复声明会炸」与「受控组件走真实输入」。**深对象那条没进描述** —— B5-b 的错误文案已经逐字告诉模型「return the fields you need as a JSON string」，描述里再说一遍是重复计费（该文件正被 T-C2 瘦身，见下） |
| B5-d 可选 `timeout_ms` | ✅ | 语义定为**只允许缩短**：schema `1-30000`，provider 取 `min(请求值, commandTimeoutMs)`；不传时行为与从前逐字一致。描述里写明「只缩短等待、不会让永不落定的 Promise 变成有值」 |
| §8.3 打包态回归 | ✅ 2026-09-20 23:43 | 打包态（23:28 那次 `refresh` 的包，Electron）真跑一轮对话，五条判据全绿 —— 逐条回执原文与耗时见 §8.3 的「实测记录」 |

判据先红后绿（反向验证）：两条新用例在旧代码下分别红在「函数根本没抛错」与「CBOR 仍是 `BROWSER_PROTOCOL_ERROR`」，
改完转绿（`execute.test.ts` 14 passed）；provider 侧两条新用例用**行为**断言 override 生效
（`hangEvaluate` 夹具模拟永不回包，断言错误里出现 `within 150 ms` / `within 300 ms`），`provider.test.ts` 130 passed。
全量：`tsc` 干净、**550 passed / 5 skipped / 1 failed** —— 唯一的红是并行会话当天新增的
`T-C 前缀成本守卫`（schema 合计 21,329 > 18,000），那是 T-C2 描述瘦身的目标；
**去掉本轮新增（约 615 字符）仍是 ~20,714，所以那个红不是本批引入的。**

**双运行时复核**：V41–V45 在 Chrome 153 与 Electron 44（Chromium 152）上读数逐字一致
（含 `position 3040`），所以 8.3 第 3 条的顾虑对这批事实不成立 —— 打包态回归要验的只剩
「新代码确实进了包」。探针在 `D:/tmp/electron-probe/`（隐藏窗口 + 独立端口，不碰在跑的实例）。
**这两条收官于 2026-09-20 23:43 的打包态对话实测（见 §8.3「实测记录」）：进包确认 ✅、五条判据 ✅。**
第二批 B5-a～B5-d 至此全部落地，无待跑项。
