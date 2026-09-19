/**
 * target 级状态的归属簿记（方案 2.3 + 2.3.1）。
 *
 * ## 为什么需要它
 *
 * `Emulation.*`（全类）、`Network.emulateNetworkConditions` / `setExtraHTTPHeaders`、
 * `Page.addScriptToEvaluateOnNewDocument`、`Page.bringToFront` 这几条命令实测都是
 * **target 级共享、后写赢**（`[V6][V9][V21][V25][V26][V35]`）—— 人工在 DevTools 里设一次
 * UA override，agent 这边一声不响；agent 设一次视口，人工那边的页面也跟着变。
 * 所以谁「拥有」某条状态必须自己记账，不能指望 CDP 告诉你。
 *
 * **⚠ 同域内也不能类推**：`Network.setBlockedURLs`（`[V12]`）与
 * `Runtime.setAsyncCallStackDepth`（`[V30]`）实测 session 私有，**不进簿记**；
 * `Network.setCacheDisabled` 作用域无法判定（`[V27]`）→ `webpage_execute` 直接拒。
 *
 * ## owner: 'human' 从哪来（2.3.1）
 *
 * CDP **不广播其它 client 的命令**（`[V8][V30]`），所以观测不到对方在改什么。两个来源：
 *
 * 1. **粗粒度让渡**：接管窗口打开期间，该会话的 target 级状态整体视为 `human` 所有。
 *    这是主力手段 —— 由 {@link TargetStateRegistry.markTakeover} 开合。
 * 2. **延迟回读探测**：`[V7]` 实测写入约 170ms 后才可见，所以写入后**延迟 ≥170ms** 再回读；
 *    读回值 ≠ 本次写入 → 判定被外部改写。这是 {@link TargetStateRegistry.reportExternalRewrite}。
 *    只对**有读取面**的 key 成立（`setDeviceMetricsOverride` 读 `innerWidth` / `dpr`、
 *    `setUserAgentOverride` 读 `navigator.userAgent`）；`Network.*` 那两条没有 get 命令，
 *    只能靠来源①。
 *
 * ## 冲突判定（严格按 2.3.1 的三情形表）
 *
 * | 情形 | 处置 |
 * |---|---|
 * | `owner === 'agent'` 且探测到值被外部改写 | 抛 `BROWSER_STATE_CONTENDED` |
 * | 处于接管窗口内 | 抛（整体让渡） |
 * | **从没被 agent 写过** | **允许写**，回执标 `previousUnknown`，旧值留在 `previous` |
 *
 * **别倒过来写成「未观察过的 key 默认 human，据此阻断写入」** —— 那样 agent 第一次设置任何
 * 状态都会被判成争用，寸步难行。「未知归属按人工所有」只体现在语义与展示上，不体现在阻断写入上。
 *
 * ## 现状（阶段 A）
 *
 * `webpage_execute` 在阶段 B 会拒掉全部写 target 级状态的命令，所以 {@link TargetStateRegistry.claim}
 * 这条链仍是**骨架 + 单测**（还没有生产调用者）。
 *
 * 但**接管窗口已经有了第一个真实生产者**（§6.5 的人工接管按钮）：`markTakeover` 由
 * `CdpBrowserProvider.setHolder` 驱动，`isTakeover` 已经在真实的 `claim` 判定里生效。
 * 它的效果是「人在操作页面期间，target 级状态整体算 human 的」—— 那是目标级让渡，
 * 与「按钮把写操作挡在外面」是两件事，别混着宣传。
 *
 * @module dsh-webops-plugin/browser-cdp/state
 */

import { BrowserError } from '../browser/types.ts'

/** 一条 target 级状态记录的持有者。 */
export type StateOwner = 'agent' | 'human'

/**
 * 「页面文档身份」这条伪状态的 key（方案 §6.2 ③）。
 *
 * 页面自己被换文档（人工导航、页面脚本 `location.href=`）不是 `Emulation.*` 那一类**可写**
 * 的 target 级状态，所以它**不参与** {@link TargetStateRegistry.claim} 的争用判定 ——
 * 写死一个 `force` 也没有意义（没人会去 claim 它）。它的用途只有一个：让「谁 / 何时动过这个页面」
 * 真的有条记录可报（`reportExternalRewrite` 写、`get` 读）。
 *
 * ⚠️ 记录里的 `owner: 'human'` 是这套词表里「非本会话」的那一侧，**不等于「一定是个真人」**：
 * 页面自己的脚本换路由同样落在这里，而插件在事件这一层分不出这两者。回执文案按这个口径写。
 */
export const PAGE_DOCUMENT_STATE_KEY = 'page.document'

/**
 * 「谁在让渡」——接管窗口的来源（§6.5 起有两个）。
 *
 * - `devtools`：有人开着 DevTools 操作这个页面（`devtools-opened` / `devtools-closed`）。
 * - `human`：人在标签条上按了「接管」按钮，明确声明「现在换我操作」。
 *
 * 两者可以同时成立，且各自独立撤销：关 DevTools 不会解除按钮的接管，反之亦然。
 */
export type TakeoverReason = 'devtools' | 'human'

/** 一条 target 级状态的记录。 */
export interface StateRecord {
  /**
   * 谁持有着这条状态。
   * - `agent`：我们写的，且至今没探测到被外部改写；
   * - `human`：外部（人工）改写过，或整体让渡期间被判给人工。
   */
  readonly owner: StateOwner
  /** 记录 / 判定时刻（毫秒时间戳）；冲突报错里要回给模型「是谁、什么时候占的」。 */
  readonly at: number
  /** 我们最近一次写入（或外部改写后回读）到的值。 */
  readonly applied: unknown
  /** 我们写入前读到的旧值；没读到过就是 `undefined`（未知）。 */
  readonly previous: unknown
}

/** {@link TargetStateRegistry.claim} 的可选项。 */
export interface StateClaimOptions {
  /**
   * 显式覆盖。这是唯一被允许的「抢」的姿势（方案 2.1.1），**必须显式**，绝不静默覆盖。
   * `force: true` 时把被覆盖的记录写进回执的 `overwritten`。
   */
  readonly force?: boolean
  /** 写入前读到的旧值（只有有读取面的 key 才有）；未知时省略。 */
  readonly previous?: unknown
}

/** {@link TargetStateRegistry.claim} 的回执。 */
export interface StateClaim {
  /** 本次写入的 key。 */
  readonly key: string
  /** 本次写入的值。 */
  readonly applied: unknown
  /** 写入前读到的旧值；未知时 `undefined`。 */
  readonly previous: unknown
  /**
   * 写入前这个 key **没有任何 agent 记录** —— 此前该状态来源未知，可能来自人工。
   * 写入照样成功，只是回执要如实标注（2.3.1 情形三）。
   */
  readonly previousUnknown: boolean
  /** `force: true` 时被覆盖掉的旧记录；没覆盖任何东西时省略。 */
  readonly overwritten?: StateRecord
  /** 本次记录时刻（毫秒时间戳）。 */
  readonly at: number
}

/**
 * 一个会话的 target 级状态归属表。
 *
 * 结构照方案 2.3：`Map<sessionId, Map<stateKey, { owner, at, applied, previous }>>`。
 * `stateKey` 由调用方给（例如 `Emulation.setUserAgentOverride`、
 * `Page.addScriptToEvaluateOnNewDocument:<worldName>:<序>`），本类不理解 key 的语义。
 *
 * **不是并发安全的写者**：与 `RefRegistry` 一样，它由 provider 的会话对象独占，
 * 同一会话的操作在 provider 内部是串行的。
 */
export class TargetStateRegistry {
  private readonly states = new Map<string, Map<string, StateRecord>>()
  /**
   * 接管窗口的**来源分账**：一个会话可以同时被多个来源让渡（人开着 DevTools，
   * 且人还按了「接管」按钮）。
   *
   * 为什么不是 `Set<string>`（一个会话一个布尔）：两条来源的生命周期完全独立 ——
   * 共用一位的话，「人在接管期间开一次 DevTools 又关掉」那条 `devtools-closed`
   * 会把 `human` 的位一起清掉，于是**人在操作，agent 却被放行**。那正是这个功能
   * 存在的意义被抹掉。分账之后「谁撤谁自己的」，`isTakeover` 取并集。
   */
  private readonly takeovers = new Map<string, Set<TakeoverReason>>()

  /**
   * 该会话当前是否处于人工接管窗口（2.3.1 来源① 的粗粒度让渡）。
   *
   * **任一来源在让渡即为真** —— 调用方只关心「现在算不算人工的」，不关心谁让的。
   */
  isTakeover(sessionId: string): boolean {
    return (this.takeovers.get(sessionId)?.size ?? 0) > 0
  }

  /**
   * 开 / 关接管窗口（2.3.1 来源①）。
   *
   * `active` 是**幂等状态位**，不是计数器 —— agent 自己 toggle DevTools 时也会收到同一条
   * 通知，不需要去重（方案 4.1.1）。幂等性由「集合语义」天然保证：重复 add / delete 同值无副作用。
   *
   * @param sessionId - 会话 id。
   * @param active - 该来源是否正在让渡。
   * @param reason - 让渡来源；省略按 `'devtools'`（唯一的既有调用方）。**来源必须传对** ——
   *   传错会让两个来源互相撤销，见 {@link TargetStateRegistry.takeovers} 的注释。
   */
  markTakeover(sessionId: string, active: boolean, reason: TakeoverReason = 'devtools'): void {
    const reasons = this.takeovers.get(sessionId) ?? new Set<TakeoverReason>()
    if (active) reasons.add(reason)
    else reasons.delete(reason)
    if (reasons.size === 0) this.takeovers.delete(sessionId)
    else this.takeovers.set(sessionId, reasons)
  }

  /** 读一条记录（诊断与测试用）。 */
  get(sessionId: string, key: string): StateRecord | undefined {
    return this.states.get(sessionId)?.get(key)
  }

  /**
   * 申请写一条 target 级状态。
   *
   * 冲突时抛 `BROWSER_STATE_CONTENDED`，错误消息正文里带 `stateKey` / `holder` / `at`，
   * 并明确写出「不可重试」与 `force` 这条恢复路径（方案 2.1.1 —— 否则模型会陷入重试循环）。
   *
   * @param sessionId - 会话 id。
   * @param key - 状态 key（调用方定义的稳定标识）。
   * @param applied - 本次要写入的值。
   * @param options - `force`（显式覆盖）与 `previous`（写入前读到的旧值）。
   * @returns 本次写入的回执。
   * @throws `BROWSER_STATE_CONTENDED`：接管窗口内，或该 key 已被判为人工持有。
   */
  claim(sessionId: string, key: string, applied: unknown, options: StateClaimOptions = {}): StateClaim {
    const existing = this.states.get(sessionId)?.get(key)
    const at = Date.now()
    const force = options.force === true

    if (!force) {
      if (this.isTakeover(sessionId)) {
        throw contended(
          sessionId, key, 'human', existing?.at ?? at,
          'this session is inside a human takeover window, so every target-level state counts as human-owned',
        )
      }
      if (existing !== undefined && existing.owner === 'human') {
        throw contended(
          sessionId, key, 'human', existing.at,
          'the value was rewritten outside this agent session (detected by the delayed read-back)',
        )
      }
    }

    const record: StateRecord = { owner: 'agent', at, applied, previous: options.previous }
    const states = this.states.get(sessionId) ?? new Map<string, StateRecord>()
    states.set(key, record)
    this.states.set(sessionId, states)

    return {
      key,
      applied,
      previous: options.previous,
      // 情形三：从没被 agent 写过 —— 允许写，但如实标注来源未知。
      previousUnknown: existing === undefined,
      ...force && existing !== undefined ? { overwritten: existing } : {},
      at,
    }
  }

  /**
   * 记录「延迟回读探测发现值被外部改写」（2.3.1 来源②）。
   *
   * 调用时机：写入后**延迟 ≥170ms**（`[V7]` 的可见延迟）再回读，读回值 ≠ 本次写入。
   * 记录后 `owner` 置 `human`、`applied` 更新为读回值；下一次 `claim` 就会抛
   * `BROWSER_STATE_CONTENDED`（除 `force` 外）。
   *
   * @param sessionId - 会话 id。
   * @param key - 状态 key。
   * @param observed - 延迟回读到的实际值。
   * @returns 更新后的记录。
   */
  reportExternalRewrite(sessionId: string, key: string, observed: unknown): StateRecord {
    const existing = this.states.get(sessionId)?.get(key)
    const record: StateRecord = {
      owner: 'human',
      // 只知道「判定时刻」，不知道人工何时改的 —— 如实记判定时刻。
      at: Date.now(),
      applied: observed,
      previous: existing?.previous,
    }
    const states = this.states.get(sessionId) ?? new Map<string, StateRecord>()
    states.set(key, record)
    this.states.set(sessionId, states)
    return record
  }

  /**
   * 释放一条记录（会话结束、或状态已被显式还原时）。
   *
   * ⚠ **`release` 不是还原手段** —— `[V10]` 实测 `Emulation.clearDeviceMetricsOverride`
   * 是「弹自己那层」且连自己都还原不干净（Electron 特有，纯 Chrome 会完全还原 `[V29]`）。
   * 要还原就显式 set 回真实值；这里只是把簿记摘掉。
   *
   * @param sessionId - 会话 id。
   * @param key - 状态 key。
   * @returns 被摘掉的记录；本来就没有时 `undefined`。
   */
  release(sessionId: string, key: string): StateRecord | undefined {
    const states = this.states.get(sessionId)
    if (states === undefined) return undefined
    const existing = states.get(key)
    states.delete(key)
    if (states.size === 0) this.states.delete(sessionId)
    return existing
  }

  /** 清掉一个会话的全部簿记（会话关闭时用）。 */
  forget(sessionId: string): void {
    this.states.delete(sessionId)
    this.takeovers.delete(sessionId)
  }
}

/**
 * 造一条 `BROWSER_STATE_CONTENDED`。
 *
 * 消息正文必须把三件事说清（方案 2.1.1）：**是谁、什么时候占的**（`holder` / `at`），
 * **不可重试**，以及唯一的「抢」姿势是 `force: true`。
 */
function contended(sessionId: string, key: string, holder: StateOwner, at: number, why: string): BrowserError {
  return new BrowserError(
    `target-level state "${key}" on session "${sessionId}" is contended: currently held by ${holder} `
    + `since ${String(at)} (${new Date(at).toISOString()}); ${why}. `
    + 'This is NOT retryable — resending the same command fails again because the state has not changed. '
    + 'Recover by taking a fresh webpage_snapshot (refs from before a takeover are obsolete), waiting for the '
    + 'takeover to end, or passing force: true to overwrite the current holder explicitly.',
    'BROWSER_STATE_CONTENDED',
  )
}
