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
 * `Network.setCacheDisabled` 作用域无法判定（`[V27]`）→ `browser_execute` 直接拒。
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
 * 当前没有任何工具真的写 target 级状态（`browser_execute` 在阶段 B 会拒掉全部这类命令），
 * 所以这里只是**骨架 + 单测**，尚未接进运行时调用链。导出保持干净，阶段 B/C 直接复用。
 *
 * @module dsh-webops-plugin/browser-cdp/state
 */

import { BrowserError } from '../browser/types.ts'

/** 一条 target 级状态记录的持有者。 */
export type StateOwner = 'agent' | 'human'

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
  private readonly takeovers = new Set<string>()

  /** 该会话当前是否处于人工接管窗口（2.3.1 来源① 的粗粒度让渡）。 */
  isTakeover(sessionId: string): boolean {
    return this.takeovers.has(sessionId)
  }

  /**
   * 开 / 关接管窗口（2.3.1 来源①）。
   *
   * `active` 是**幂等状态位**，不是计数器 —— agent 自己 toggle DevTools 时也会收到同一条
   * 通知，不需要去重（方案 4.1.1）。
   *
   * @param sessionId - 会话 id。
   * @param active - 人工是否正在操作（DevTools 开 / 关）。
   */
  markTakeover(sessionId: string, active: boolean): void {
    if (active) this.takeovers.add(sessionId)
    else this.takeovers.delete(sessionId)
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
      if (this.takeovers.has(sessionId)) {
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
    + 'Recover by taking a fresh browser_snapshot (refs from before a takeover are obsolete), waiting for the '
    + 'takeover to end, or passing force: true to overwrite the current holder explicitly.',
    'BROWSER_STATE_CONTENDED',
  )
}
