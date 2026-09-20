# Minke 人工接管机制对照与落地评估

> **本文性质**：对**参考实现**（`D:\dev\cli\Minke`）的解剖 + 移植评估，2026-09-20 调研。
> **本项目的接管方案仍是 `docs/多会话防冲突-实施方案.md` §6.5 唯一真相源**，本文不替代它，
> 也不改判 A 档语义；只回答「Minke 怎么做的、哪些能拿来、怎么拿」。
> 所有行号均于 2026-09-20 回源码核对过。

---

## 0. 结论先行

1. **Minke 的接管不是「一个按钮 + 一个布尔位」，是一条跨进程的时序协议**：单调修订号 + 准入闸门 +
   控制权变更事件 + 轮次取消 + 自动认领记账。当前项目 A 档落地的是它的**静态骨架**（holder 布尔 +
   拒写 + 作废纪元 + 吞键盘），**动态那半边（竞态防护、轮次取消、焦点记账）没接**。
2. **最值得落地的一条是 `agent.cancel({kind:'user'})`**：人按下接管的**当下**就停掉 agent 正在跑的轮次。
   当前项目要等 agent 下一次调写工具才撞墙 —— 中间它可能还在推理、还在别的会话上动手。
3. **原料在本仓已全部具备**（0.1.6-alpha.2 实测，见 §4 三行硬证据），**不需要补丁 harness、不需要重编桌面端**，
   纯插件层 + 增量包就能带。
4. **一条有语义冲突、必须主上拍**：Minke 的「人在 agent 空闲时接管 → agent 下一轮自动认领」
   是 B 档语义，与 §6.5「不做排队等自动交还」的立意相反。见 §5。

---

## 1. Minke 接管机制的完整解剖

分四层。以下文件路径均相对 `D:\dev\cli\Minke\`。

### 1.1 设备层（Electron 主进程）· `desktop/main/agent-browser/runtime.ts`（3230 行）

会话状态新增三个字段（L175-177）：

```ts
controlTail: Promise<void>;      // 控制权迁移串行队列
controlRevision: number;         // 单调修订号，每会话一个
humanTakeoverPending: boolean;   // 准入闸门：已同步关闭
```

两个公开方法：

| 方法 | 行 | 职责 |
|---|---|---|
| `claimControl(ownerSessionId, sessionId, expectedControlRevision, signal)` | L1420 | agent 自动认领。带期望修订号，对不上就 `control_superseded` |
| `setControl(sessionId, owner, expectedControlRevision?)` | L1524 | 控制权迁移本体 |

`setControl` 的关键动作，按顺序：

1. **修订号先涨**：`state.controlRevision + 1`（L1546），溢出报 `control_revision_exhausted`（L1547-1552，`Number.MAX_SAFE_INTEGER` 才触发，实际不可达）。
2. **`owner === 'human'` 时同步关闸门**（L1554-1568）：置 `humanTakeoverPending = true` → `cdp.interruptNavigationForHumanTakeover()` → 清光标 → 向所有 process channel 广播 `publishControlChanged(...)`。**注意这些是同步做的**，注释原话是 "Close the admission gate synchronously"。
3. **迁移本体排进 `controlTail` 串行队列**（L1569-1650）：`human` 方向还要先 `await state.operationTail`（等已准入的在飞操作到终态）。
4. **纪元切换**（L1590-1626）：`invalidateReferences()` → `generation++` → `snapshotRequired = (owner === 'agent')` → `status` 转 `paused`/`ready`/`pending` → 清光标 → `#publish()`。
5. **`human` 方向在迁移末尾才清 `humanTakeoverPending`**（L1646-1648）。

竞态拒绝的判据（L1445-1458）值得抄，它区分了「旧修订」与「合法的同修订」：

```ts
state.controlRevision !== expectedControlRevision &&
( state.controlRevision <= expectedControlRevision ||   // 旧号，真过期
  state.owner !== "agent" ||                            // 已经不是 agent 了
  state.humanTakeoverPending ||                         // 闸门关着
  !state.snapshotRequired )                             // 不是「需要重拍」的状态
→ throw control_superseded
```

**`claimControl` 的 abort 补偿**（L1460-1484）是一条容易漏的设计：认领过程中若被中断，
会自动 `setControl(sessionId, 'human')` 把人放回来 —— 但**排除 `owner_released` / `channel_closed`**
（会话正在销毁，补偿会publish一条幽灵控制事件）。

### 1.2 协议层 · `packages/harness-overlay/src/agent-browser-contract.ts`

```ts
// L206-212
interface AgentBrowserSessionResult {
  sessionId; generation; owner: AgentBrowserOwner;
  status: AgentBrowserSessionStatus; snapshotRequired; url?; title?
}
// L213-218
interface AgentBrowserClaimControlResult extends AgentBrowserSessionResult {
  owner: "agent"; snapshotRequired: true; controlRevision: number;
}
// L505-516
interface AgentBrowserControlChangedEvent {
  channel; protocolVersion; type: "control-changed";
  ownerSessionId; sessionId; owner: AgentBrowserOwner;
  controlRevision: number;   // Monotonic per-session control intent revision.
}
```

**当前项目已经有这条事件的通道**（`{type:'control', tabId, holder}`），**只缺 `controlRevision` 字段**。

### 1.3 host 侧（harness 内）· `packages/harness-overlay/src/host/agent-browser-tools.ts`（4283 行）

五本账（L2879-2901）：

| 账 | 类型 | 用途 |
|---|---|---|
| `humanControlledSessions` | `Map<ownerId, Set<sessionId>>` | 当前在人手里的会话 |
| `reclaimableHumanSessions` | `Map<ownerId, Set<sessionId>>` | 人已 idle、下轮可自动认领的 |
| `controlRevisions` | `Map<ownerId, Map<sessionId, number>>` | 单调修订号（`recordControlRevision` L3003 拒绝旧号） |
| `controlOwners` | `Map<ownerId, Map<sessionId, owner>>` | 当前 owner |
| `pendingControlClaims` | `Map<ownerId, Map<sessionId, Promise>>` | 认领去重（单飞） |

注释 L2883-2885 把语义说透了，值得原样保留：

> A takeover remains terminal for the active run. It becomes reclaimable only after that run reaches
> idle, and is claimed lazily by the first browser operation of a later run so non-browser turns never steal focus.

**控制权变更监听**（L3317-3379，`client.onControlChanged`）：

- `owner === 'human'`：记账 → **抢焦点**（`state.focusedSessionId = event.sessionId`，注释原话
  "Human interaction is the strongest focus signal, including while the agent is idle"）→
  agent `idle` 则标 `reclaimable`，**非 idle 则 `state.agent.cancel({ kind: "user" })`**（L3354-3361）。
- `owner === 'agent'`：清两本 human 账 + 清 `actionUnlockPending`；但若该会话的认领还在飞
  （`pendingControlClaims` 命中）则**直接 return，不清理**（L3364-3370）—— 防「认领中」被自己的事件打断。

**工具执行前拦截**（L3530-3582）：会话在人手里时，分两种命运 ——

```
canClaimControl = agent.activeTurn !== undefined && 会话在 reclaimable 里
├─ 是 → claimControl(...) 成功后 definition.execute(...)   // 偷偷把控制权拿回来干活
└─ 否 → session_paused + agent.cancel({kind:'user'})      // 「This browser turn has stopped」
```

**轮次生命周期**（L4239-4264）：`agent/status` 转 `idle` → 把所有 human 会话标 reclaimable +
每个会话 `requireObservation` + catalog 回 `bootstrap`。

**工具目录降级**（L2902-2926 `syncCatalogRestriction`）：catalog 为 `bootstrap` 时
`restrict({deny: AGENT_BROWSER_MUTATION_TOOL_NAMES})`（L1409-1417，由 `ELEMENT_MUTATION_OPERATIONS` 过滤）。

> ⚠ **一处容易误读的地方（我最初也读错了）**：这个 `restrict` 是 **catalog/「观察先行」驱动的**，
> **不是人工接管驱动的**。人工接管的手段是「执行时拦截 + 取消轮次」，接管期间**没有**隐藏工具。
> 移植时别把两者混成一件事。

### 1.4 客户端 · `packages/harness-overlay/src/client/tabs/agent-browser/controller.ts`

`#controlPending: Set<string>` / `#controlErrors: Map<string, string>`（L160-161）。
`takeControl` 路径（L648-672）**刻意不做乐观更新**：先 `#controlPending.add`，等主进程结果回来才改 UI，
失败落到 `#controlErrors`。

> 与当前项目 §6.5 落地记录里「按钮不做乐观更新」的取舍**完全一致** —— 这一条我们做对了。
> **缺的是错误面**：Minke 有 `#controlErrors`，当前项目失败了没有可见呈现。

---

## 2. 逐项对照

| 机制 | Minke | 当前项目 A 档 | 缺口性质 |
|---|---|---|---|
| 控制权载体 | `owner: 'agent'\|'human'` + 单调 `controlRevision` | `holder: 'agent'\|'human'` 布尔 | 缺修订号 |
| 准入闸门 | `humanTakeoverPending` 同步关闭 + `operationTail` 等待 | 无 | **缺** |
| 竞态拒绝 | `control_superseded`（比修订号 + 四条件） | 靠宿主侧 + provider 侧**幂等判等**缓解 | 弱化版 |
| 控制权变更广播 | `publishControlChanged` → `control-changed` 事件（含 revision） | `{type:'control', tabId, holder}`（**无 revision**） | 缺字段 |
| 轮次取消 | `agent.cancel({kind:'user'})` 立刻停整轮 | 无 | **缺（最高价值）** |
| 自动认领 | `reclaimable` + `claimControl`（B 档语义） | 无（且 A 档明说不做） | **语义冲突，需拍板** |
| 焦点记账 | `focusedSessionId`（人工交互是最强焦点信号） | 无 | 缺 |
| 工具目录降级 | `restrict({deny: MUTATION})`，catalog 驱动 | 无 | 独立项 |
| 客户端错误面 | `#controlErrors` | 无（只等真实状态推回） | 缺 |
| 纪元作废 | `invalidateReferences()` + `snapshotRequired` | `refs.invalidate()` + 纪元（已等效） | 已覆盖 |
| 记账分账 | 五本账各管一摊 | `takeovers: Map<string, Set<TakeoverReason>>`（已分账） | 已覆盖 |
| 吞人工输入 | 无（B 档不吞） | `before-input-event` 吞 keyDown/char（唯键盘） | **我们更强** |

---

## 3. 落地优先级

### P0 · 立刻可做（价值最高、风险最低）

**P0-1 人按下接管时立刻取消 agent 轮次**

当前行为：人按接管 → 作废纪元 + 拒写 → **agent 要等下一次调写工具才撞 `BROWSER_HUMAN_HOLDING`**。
中间它可能继续推理、继续在**别的会话**上动手，用户看到的是「按了接管，但 agent 还在忙」。

目标行为：通知到达时，若该会话属于当前 agent 且 agent 非 idle → `agent.cancel({kind:'user'})`。

落点（需要设计一处贯通）：通知链现在是
`host.cjs` → `bridge.ts(offControl)` → `transport.ts` → `browser-electron/provider.ts:126` → 基类 `setHolder`。
**provider 层拿不到 agent**（纯 CDP 层）。所以要在这条链上再接一个「控制权变更」的**插件层订阅口**，
由 `src/tool-browser/index.ts`（inject 含 `tools`，能拿到 `exec.agent` / `ctx`）订阅并调 `cancel`。

⚠ 纪律：这把「停 agent」的权力交给了插件层，必须在**会话级**判定（只停持有该会话的 agent），
不许出现「一个人接管就把整机 agent 全停」。

**P0-2 控制权变更事件补 `controlRevision`**

服务两件事：① 防通道重放/晚到消息导致的「平白再翻一代纪元」（当前项目靠幂等判等兜，不彻底）；
② 是未来任何认领逻辑的前提。

落点：`src/browser-cdp/provider.ts`（`SessionState` 加 `controlRevision`）、
`src/browser-electron/host.cjs`（每标签维护并随通知带上）、`bridge.ts`（消息形状）、
`transport.ts`、`src/browser-electron/provider.ts`。

**P0-3 客户端接管失败的错误面**

落点：`src/browser-electron/tabbar.html` + `tabbar-preload.cjs`（现已有状态文字 + 按钮）。
Minke 的形状可直接照搬：`controlPending` 期间禁用按钮，失败写一条可见文案。

### P1 · 价值高，需要设计

**P1-4 `humanTakeoverPending` 准入闸门**：解决「agent 的在飞操作」与「人按下接管」之间那个窗口。
Minke 的做法是**同步关闸门**（同步置位 + 广播）+ **异步等 `operationTail`**。
当前项目 A 档的窗口是敞开的：`assertWritable` 在 CDP 命令前检查，但**已派发出去的命令不会撤回**。

**P1-5 `focusedSessionId` 焦点记账**：多会话场景下「人最后碰的是哪个标签」。
Minke 的判据是「人工交互是最强焦点信号，哪怕 agent 空闲」。当前项目多会话防冲突正缺这个。

**P1-6 工具目录降级（观察先行）**：**与接管无关**，是独立策略 ——
每轮开始只给观察类工具，snapshot 之后才放写工具。要单独立项评估，别混进接管里。

### P2 · 需主上拍板

**P2-7 自动认领**（见 §4）。
**P2-8 导航中断**（Minke `interruptNavigationForHumanTakeover()`）：当前项目是否有长导航需要被接管打断，未评估。

### 不建议移植

- `snapshotRequired` —— 当前项目 `refs` 纪元已等效覆盖，引入是第二套真相。
- `control_revision_exhausted` —— `MAX_SAFE_INTEGER` 才触发，实际不可达，属防御性冗余。
- Minke 的 `reclaimable` 记账**整套**（若 P2-7 不拍板，则连带不做）。

---

## 4. 可行性硬证据（0.1.6-alpha.2 实测）

三行核对结果，决定「能不能纯插件层落地」：

| 需要的能力 | 在本仓哪儿 | 结论 |
|---|---|---|
| `agent.cancel(cause, options?)` | `packages/core/agent/src/runtime-types.ts:183` | ✅ 存在 |
| `{kind:'user'}` 合法 | `packages/core/session/src/types.ts:189` | ✅ 是 `AgentCancelCause` 成员 |
| `ctx.tools.restrict({allow?,deny?}) → disposer` | `packages/core/tools/src/index.ts:1077` | ✅ 存在，**要求 scoped ctx**（`agent.ctx`），插件根 ctx 调会抛错 |
| 工具 execute 里能拿到 agent | `packages/core/tools/src/index.ts:322,358`（`ToolExecutionInput.agent?: Agent`） | ✅ 可及 |

→ **全部落在插件层，不需要补丁 harness、不需要重编桌面端，增量包就能带。**
（`restrict` 的 scoped 约束意味着：若走 P1-6，必须在拿到 `agent.ctx` 的地方调用并保存 disposer，
不能像 Minke 那样在工具 execute 里临时调 —— 它那边 `state.agent.ctx` 是常驻的。）

---

## 5. 需要主上拍板的一点

**A 档要不要引入 Minke 的「自动认领」（reclaimable）？**

| | Minke（B 档语义） | 当前项目 A 档（§6.5 已定） |
|---|---|---|
| 人在 agent **空闲**时按接管 | 标记 `reclaimable`；agent 下一轮首次浏览器操作**自动** `claimControl` 拿回来 | 无此机制，必须人按「交还」 |
| 人在 agent **忙碌**时按接管 | `agent.cancel({kind:'user'})` 停整轮，之后同上 | 拒写，等 agent 自己收手 |

冲突点：§6.5「不做」清单第 2 条写的是
「不做排队等 agent 做完自动交还：那是把控制权做成了 agent 的财产」——
但 Minke 的 reclaimable 是**反方向**的（人不用再点一次「交还」，agent 自己拿回去），
严格说**不违反**那条（那条禁止的是「agent 做完自动还给人」，不是「人放手的自动被 agent 拿回」）。

所以这是一个**新选择点**，不是既有决策的违反：

- **选项 A（保持现语义）**：不做自动认领。人按了接管就必须再按「交还」，归属完全由人声明。简单、可预测。
- **选项 B（引入 reclaimable）**：人在 agent 空闲时接管 → agent 下一轮自动拿回。
  少一次点击，但「现在归谁」会出现 agent 单方面变更，与 A 档「让人自己声明」的立意有张力。
- **选项 C（折中）**：只移植 `agent.cancel`（P0-1），不做认领 —— 拿到「人一按就真停手」这个最大收益，
  归属仍完全由人控制。

> 我的建议：**先做 P0-1，认领（P2-7）押后**。P0-1 是纯增益、零语义冲突；
> 认领引入的是「谁在什么时候能单方面改变归属」，值得单独一轮讨论，也正好落在 §13 D-11 的待决区里
> （与 D-11a 超时 T、D-11b 地址栏并列）。

---

## 6. 落地顺序建议（一步一验）

1. **P0-1 + P0-2 + P0-3 一起做**（一次通知链改动）：取消轮次 + 修订号 + 错误面。
   - 验证：`provider.test.ts`（拒写零 CDP 派发仍绿）、`browser-electron/index.test.ts`（端到端通道）、
     真机 `scripts/probe-input-swallow.mjs` 8/8 不回归。
   - **新断言必须反向验证**：故意让 `cancel` 不调用，确认对应用例转红，再改回。
2. **P1-4 闸门 + P1-5 焦点**：独立一轮，改 provider 状态机，回归面同上。
3. **P1-6 目录降级**：单独立项，与接管解耦。
4. **P2-7 认领**：等主上拍板后再说。

每一步都要回答同一个问题：**「本轮新增的断言，反向验证过没有？」** —— 装饰性的断言等于没有。
