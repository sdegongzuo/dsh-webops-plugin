/**
 * 标签租约（tab lease）—— 多宿主对话对同一个受控标签页的互斥占用。
 *
 * ## 它治的是哪个缺陷
 *
 * `webpage_open` 每开一个标签页就得到一个新的 `sessionId`，而 `sessionId` 是**全局可见**的
 * （`sessions: Map` 在 provider 实例上）。于是同一个宿主进程里的两个宿主对话只要拿到彼此的
 * session id，就能读写对方的页面：清单互相串台、快照读到别人的页面、`close` 关掉别人的标签。
 * 2026-09-30 实测：两个独立对话分别开了 t2 和 t3，`list` 与 `close` 回执里都出现了对方的标签。
 *
 * 这一层给每个标签**记一个主人**：只有主人能操作，别人要先领取（空闲时）或凭一次性移交码
 * 接管（移交时）。租约是**内存态**，重启即清空（见实施方案 §3.2：不从历史回执恢复权限）。
 *
 * ## 三条状态与一条隐含状态
 *
 * | 状态 | 谁能看见 | 谁能操作 |
 * |---|---|---|
 * | `held` | 只有 owner 的默认清单 | 只有 owner |
 * | `available` | 空闲清单（只给标签 id） | 先 claim 再读写 |
 * | `handoff` | 不入普通清单 | 凭一次性移交码 claim |
 * | （无记录） | 谁都看不见 | 谁都操作不了 |
 *
 * 最后那条「无记录」是故意的：宿主标签条「+」开出来的标签、以及**没有受控父标签**的收编
 * 页面，都不猜主人 —— 猜错等于把别人的页面塞给某个对话（实施方案 §5.2）。它们既不在空闲
 * 清单里、也不能被 claim，只能由它自己的创建者重新 `open`。
 *
 * ## 时间
 *
 * 全部用**单调时钟**（`performance.now()`），不是墙钟：系统时间被改（NTP、手动校时、
 * 跨时区）不该让租约凭空提前过期或永不过期。时钟与定时器都可注入，单测据此跳过真实等待。
 *
 * 过期有两条路，缺一不可：
 * - **惰性**：每一次查询与操作先 `expire()`，保证读到的状态永远不是过期的；
 * - **定时**：一个全局定时器（不是每标签一个，避免长会话的定时器风暴）把「到期」变成
 *   真事件 —— 空闲回收要同时作废 ref 纪元与快照缓存，那件事没有任何调用方来触发。
 *
 * @module dsh-webops-plugin/browser/lease
 */

import { randomBytes, createHash } from 'node:crypto'
import { BrowserError } from './types.ts'
import type { BrowserTabLeaseState } from './types.ts'

/** 空闲租期默认值：30 分钟。首版按真实工具调用间隔调整（实施方案 §3）。 */
export const DEFAULT_TAB_LEASE_IDLE_MS = 1_800_000

/** 移交码默认有效期：5 分钟。 */
export const DEFAULT_TAB_HANDOFF_TTL_MS = 300_000

/** 占用表的主键。provider 之间不共享号空间（`cdp` 与 `electron` 各有一批标签）。 */
export function leaseKey(providerId: string, targetId: string): string {
  return `${providerId}\u0000${targetId}`
}

/** 把一个主键拆回 provider 与标签。 */
export function splitLeaseKey(key: string): { providerId: string; targetId: string } {
  const at = key.indexOf('\u0000')
  return at < 0
    ? { providerId: '', targetId: key }
    : { providerId: key.slice(0, at), targetId: key.slice(at + 1) }
}

/** 时钟与定时器。测试注入假实现，生产用单调时钟。 */
export interface TabLeaseClock {
  /** 单调毫秒（只用于比较差值，绝对值无意义）。 */
  now(): number
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
}

/**
 * 默认时钟：`performance.now()` + 一个 **unref 过**的定时器。
 *
 * unref 是必须的：定时器若把事件循环钉住，宿主进程退出会被拖到租期结束（30 分钟）。
 */
const SYSTEM_CLOCK: TabLeaseClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs)
    // Node 的 Timeout 有 unref；浏览器/Electron 渲染侧没有，故按可选调用。
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface TabLeaseConfig {
  /** 空闲多久后自动释放占用（毫秒）。 */
  readonly idleMs: number
  /** 移交码有效期（毫秒）。 */
  readonly handoffTtlMs: number
}

/** 释放原因：空闲超时 / 移交码过期。两者都要作废 ref 纪元，但回执文案不同。 */
export type TabLeaseReleaseReason = 'idle' | 'handoff-expired'

/** 占用被自动释放时的通知（宿主据此作废 ref 纪元与快照缓存）。 */
export type TabLeaseReleaseListener = (
  providerId: string,
  targetId: string,
  reason: TabLeaseReleaseReason,
) => void

/** 清单里的一项。 */
export interface TabLeaseView {
  readonly targetId: string
  readonly state: BrowserTabLeaseState
  /** 距释放 / 码过期还有多少毫秒；`available` 无期限，故缺席。 */
  readonly remainingMs?: number
}

/** 一条占用记录。 */
interface LeaseEntry {
  state: BrowserTabLeaseState
  ownerId: string | undefined
  /** 归属代次：每次换主 / 释放都 +1。旧代次的回调据此失效。 */
  generation: number
  /** 执行中的调用数。非零时禁止释放 / 移交 / 关闭，也禁止超时回收。 */
  activeCalls: number
  /** 单调时钟上的期限：`held` 是空闲截止，`handoff` 是码截止，`available` 无意义。 */
  deadline: number
  /** 移交码的 sha256（十六进制）。**明文永不落表**。 */
  handoffHash: string | undefined
  /** 弹窗父标签的完整主键；无父（不是弹窗）时缺席。 */
  parentKey: string | undefined
}

/** 校验一个租期配置项：必须是正整数。`0` 不是「关掉门禁」的写法。 */
function requirePositiveMs(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BrowserError(
      `browser config "${field}" must be a positive integer number of milliseconds, got ${String(value)}; `
      + 'a zero or negative lease would disable the guard instead of tuning it — remove the option to keep the default',
      'BROWSER_PROTOCOL_ERROR',
    )
  }
  return value
}

/** 哈希一个移交码。 */
function hashHandoffCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/** 造一个 128 位密码学随机的移交码（22 字符的 base64url）。 */
export function mintHandoffCode(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * 标签占用注册表。
 *
 * 全部裁决都走这里，**不锁整个浏览器**：每个标签独立记账，不同标签可以并行操作。
 */
export class TabLeaseRegistry {
  private readonly config: TabLeaseConfig
  private readonly clock: TabLeaseClock
  private readonly entries = new Map<string, LeaseEntry>()
  private readonly releaseListeners = new Set<TabLeaseReleaseListener>()
  private timer: unknown
  /**
   * 归属代次的发号器，**全局单调**。
   *
   * 为什么不是「每条记录自增」：记录会被 `forget` 掉（标签关闭），同一个 targetId 之后再
   * 登记时自增会从 0 重来 —— 于是「旧代次」与「新代次」可能撞号，一个跨越两次登记的旧
   * 回调就能核销掉新租期的计数。全局发号让任何一次归属变化都拿到一个从未出现过的号。
   */
  private generationSequence = 0

  constructor(options: { idleMs?: number; handoffTtlMs?: number; clock?: TabLeaseClock } = {}) {
    this.config = {
      idleMs: requirePositiveMs(options.idleMs ?? DEFAULT_TAB_LEASE_IDLE_MS, 'tabLeaseIdleMs'),
      handoffTtlMs: requirePositiveMs(options.handoffTtlMs ?? DEFAULT_TAB_HANDOFF_TTL_MS, 'tabHandoffTtlMs'),
    }
    this.clock = options.clock ?? SYSTEM_CLOCK
  }

  /** 生效的配置（回执与诊断用）。 */
  get configValues(): TabLeaseConfig {
    return this.config
  }

  /**
   * 订阅「占用被自动释放」。返回退订函数。
   *
   * 只有到期回收需要它 —— 显式 release / handoff / close 都在调用栈里，调用方自己就顺手
   * 作了废；空闲超时是唯一「没有调用方」的状态迁移。
   */
  onRelease(listener: TabLeaseReleaseListener): () => void {
    this.releaseListeners.add(listener)
    return () => this.releaseListeners.delete(listener)
  }

  /** 登记一个**新开的**标签，归 `ownerId` 独占。 */
  register(providerId: string, targetId: string, ownerId: string): void {
    const key = leaseKey(providerId, targetId)
    const now = this.clock.now()
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.state === 'held' && existing.ownerId === ownerId) return
    this.entries.set(key, {
      state: 'held',
      ownerId,
      generation: this.allocateGeneration(),
      activeCalls: 0,
      deadline: now + this.config.idleMs,
      handoffHash: undefined,
      parentKey: undefined,
    })
    this.armTimer()
  }

  /**
   * 收编一个页面自己开出来的标签，归属**跟着受控父标签走**。
   *
   * - 父有记录（`held` / `available` / `handoff`）→ 子继承同一状态；`handoff` 时父子共享
   *   同一个码哈希与截止时间，于是「领取时一并迁移」不需要第二套机制。
   * - 父没有记录（人工开的标签、或父本身就是收编来的）→ **不登记**，返回 `false`。
   *   不猜主人：猜错就是把别人的页面交出去。
   *
   * @returns 是否登记成功。
   */
  adoptChild(providerId: string, childTargetId: string, parentTargetId: string): boolean {
    const parentKey = leaseKey(providerId, parentTargetId)
    const parent = this.entries.get(parentKey)
    if (parent === undefined) return false
    // 父自己没有主人时（available）也不留空子：子照样是空闲的，但必须**留记录**，
    // 否则它连空闲清单都进不去，成了谁也拿不到的僵尸标签。
    const key = leaseKey(providerId, childTargetId)
    this.entries.set(key, {
      state: parent.state,
      ownerId: parent.ownerId,
      generation: this.allocateGeneration(),
      activeCalls: 0,
      deadline: parent.deadline,
      handoffHash: parent.handoffHash,
      parentKey,
    })
    this.armTimer()
    return true
  }

  /** 摘掉一条记录（标签关闭、连接断开）。幂等。 */
  forget(providerId: string, targetId: string): void {
    this.entries.delete(leaseKey(providerId, targetId))
  }

  /** 是否在受控台账里（含空闲与移交）。 */
  has(providerId: string, targetId: string): boolean {
    this.expire()
    return this.entries.has(leaseKey(providerId, targetId))
  }

  /**
   * 操作前的门禁：这个标签必须正被 `ownerId` 持有。
   *
   * @throws `BROWSER_TAB_NOT_HELD`：不是自己的（空闲、别人占着、移交待领、或根本没有记录）。
   * @throws `BROWSER_CALLER_REQUIRED`：调用方没有身份。
   */
  assertHeld(providerId: string, targetId: string, ownerId: string): void {
    this.expire()
    const entry = this.entries.get(leaseKey(providerId, targetId))
    if (entry === undefined) {
      throw new BrowserError(
        `session "${targetId}" is not held by this conversation and is not in the controlled `
        + 'tab ledger at all — it was closed, or it belongs to a window this plugin did not open. '
        + 'Open your own tab with webpage_open; a tab that is not in the ledger can never be claimed.',
        'BROWSER_TAB_NOT_HELD',
      )
    }
    if (entry.state === 'held' && entry.ownerId === ownerId) return
    throw new BrowserError(
      `session "${targetId}" is not held by this conversation (state: ${entry.state}). `
      + (entry.state === 'available'
        ? 'It is idle: claim it with webpage_tabs(action=claim, session_id=...) and take a fresh '
        : entry.state === 'handoff'
          ? 'It is being handed over: claim it with webpage_tabs(action=claim, session_id=..., handoff_code=...) '
            + 'using the one-time code the previous owner received, and take a fresh '
          : 'It is held by another conversation; it cannot be taken over, only waited for or handed over. '
            + 'Use a different idle tab, or take a fresh ')
      + 'webpage_snapshot before acting: the lease change invalidated every ref from earlier snapshots.',
      'BROWSER_TAB_NOT_HELD',
    )
  }

  /**
   * 开始一次受授权的调用：`activeCalls` +1，返回**本次归属代次**。
   *
   * 代次必须沿调用链传下去，收尾时按期核销 —— 否则一次跨越了释放 / 移交的长调用，
   * 会在新 owner 的租期上把 `activeCalls` 减出负数，或者给别人的租期续期。
   */
  beginCall(providerId: string, targetId: string, ownerId: string): number {
    this.assertHeld(providerId, targetId, ownerId)
    const entry = this.entries.get(leaseKey(providerId, targetId)) as LeaseEntry
    entry.activeCalls += 1
    return entry.generation
  }

  /**
   * 结束一次调用。最后一个执行中的调用结束时**重置空闲截止**（网站或 CDP 失败也算 ——
   * 「还活着」这件事与调用成不成功无关）。
   *
   * 代次对不上（期间换过主人）时整条忽略：既不动别人租期的计数，也不给它续期。
   */
  endCall(providerId: string, targetId: string, generation: number): void {
    const entry = this.entries.get(leaseKey(providerId, targetId))
    if (entry === undefined || entry.generation !== generation) return
    entry.activeCalls = Math.max(0, entry.activeCalls - 1)
    if (entry.activeCalls === 0 && entry.state === 'held') {
      entry.deadline = this.clock.now() + this.config.idleMs
    }
    this.armTimer()
  }

  /**
   * 释放占用，**保留页面**。释放后标签进入空闲清单，等着谁领取。
   *
   * @throws `BROWSER_TAB_BUSY`：还有执行中的调用 —— 让人把操作做完再说。
   */
  release(providerId: string, targetId: string, ownerId: string): void {
    this.expire()
    const key = leaseKey(providerId, targetId)
    const entry = this.requireHeld(key, targetId, ownerId, 'release')
    this.assertIdle(entry, targetId, 'release')
    this.setAvailable(key, entry)
    this.armTimer()
  }

  /**
   * 发起移交：立即交出操作权，返回**一次性**明文移交码。
   *
   * 明文只在这一刻存在，表里只有它的哈希；发起方自己也不该留着它。
   *
   * @returns 明文移交码。
   * @throws `BROWSER_TAB_BUSY`：还有执行中的调用（实施方案 §5.1）。
   */
  handoff(providerId: string, targetId: string, ownerId: string): string {
    this.expire()
    const key = leaseKey(providerId, targetId)
    const entry = this.requireHeld(key, targetId, ownerId, 'handoff')
    this.assertIdle(entry, targetId, 'handoff')
    const code = mintHandoffCode()
    const now = this.clock.now()
    // 同族的标签（弹窗父子）跟着一起移交：父子共用一个码、一个截止时间。
    for (const memberKey of this.familyOf(key)) {
      const member = this.entries.get(memberKey)
      if (member === undefined) continue
      member.state = 'handoff'
      member.ownerId = undefined
      member.handoffHash = hashHandoffCode(code)
      member.deadline = now + this.config.handoffTtlMs
      member.generation = this.allocateGeneration()
    }
    this.armTimer()
    return code
  }

  /**
   * 关闭前的检查：必须是主人，且没有执行中的调用（§5.1「release、handoff、close 遇到
   * activeCalls 非零直接报忙」）。
   *
   * 与 `release` 分开是因为**记录的去向不同**：释放是转空闲（页面留着），关闭是摘记录
   * （页面没了）。但两者的前置条件一样，所以共用同一段校验。
   */
  assertClosable(providerId: string, targetId: string, ownerId: string): void {
    this.expire()
    const entry = this.requireHeld(leaseKey(providerId, targetId), targetId, ownerId, 'close')
    this.assertIdle(entry, targetId, 'close')
  }

  /**
   * 领取一个空闲 / 移交待领的标签。
   *
   * 幂等：重复领取自己仍持有的标签**成功且不推进代次**（实施方案 §3.2）。
   *
   * @returns 归属是否真的变了。调用方据此决定要不要作废 ref 纪元 —— 幂等领取若也作废，
   *   就会凭空把模型手上的 ref 全废掉，那是「同号装回」这条路走不通的直接原因。
   * @throws `BROWSER_TAB_OCCUPIED`：另一个对话正持有它。
   * @throws `BROWSER_HANDOFF_INVALID`：码错、过期或已消费。
   */
  claim(providerId: string, targetId: string, ownerId: string, handoffCode?: string): boolean {
    this.expire()
    const key = leaseKey(providerId, targetId)
    const entry = this.entries.get(key)
    if (entry === undefined) {
      throw new BrowserError(
        `session "${targetId}" is not in the controlled tab ledger, so it cannot be claimed — `
        + 'it was closed, or this plugin never owned it. Open your own tab with webpage_open.',
        'BROWSER_TAB_NOT_HELD',
      )
    }
    if (entry.state === 'held') {
      if (entry.ownerId === ownerId) return false
      throw new BrowserError(
        `session "${targetId}" is already claimed by another conversation; it cannot be taken over. `
        + 'Wait for its owner to release or hand it over, or use a different idle tab '
        + '(webpage_tabs(action=list, scope=available)).',
        'BROWSER_TAB_OCCUPIED',
      )
    }
    if (entry.state === 'handoff') {
      if (handoffCode === undefined || handoffCode.length === 0) {
        throw new BrowserError(
          `session "${targetId}" is being handed over: it needs the one-time handoff code from the `
          + 'previous owner (webpage_tabs(action=claim, session_id=..., handoff_code=...)). '
          + 'A handoff code expires and can be used exactly once, so it cannot be replayed.',
          'BROWSER_HANDOFF_INVALID',
        )
      }
      if (entry.handoffHash !== hashHandoffCode(handoffCode)) {
        throw new BrowserError(
          `the handoff code for session "${targetId}" is wrong, expired, or was already used. `
          + 'Codes are single-use and short-lived — ask the previous owner for a NEW one instead of '
          + 'retrying this code.',
          'BROWSER_HANDOFF_INVALID',
        )
      }
    }
    const now = this.clock.now()
    for (const memberKey of this.familyOf(key)) {
      const member = this.entries.get(memberKey)
      if (member === undefined) continue
      // 同族里已经在别人手上的那些不动（正常情况下不会出现：同族状态总是一起迁移）。
      if (member.state === 'held' && member.ownerId !== ownerId) continue
      member.state = 'held'
      member.ownerId = ownerId
      member.handoffHash = undefined
      member.deadline = now + this.config.idleMs
      member.generation = this.allocateGeneration()
    }
    this.armTimer()
    return true
  }

  /** 本对话占用的标签（默认清单）。 */
  listHeld(providerId: string, ownerId: string): TabLeaseView[] {
    this.expire()
    const views: TabLeaseView[] = []
    for (const [key, entry] of this.entries) {
      const { providerId: owner, targetId } = splitLeaseKey(key)
      if (owner !== providerId) continue
      if (entry.state !== 'held' || entry.ownerId !== ownerId) continue
      views.push(this.viewOf(targetId, entry))
    }
    return views
  }

  /** 本运行实例里空闲待领的标签 id（只给 id —— 领取前不披露页面内容）。 */
  listAvailable(providerId: string): string[] {
    this.expire()
    const ids: string[] = []
    for (const [key, entry] of this.entries) {
      const { providerId: owner, targetId } = splitLeaseKey(key)
      if (owner !== providerId) continue
      if (entry.state === 'available') ids.push(targetId)
    }
    return ids
  }

  /** 一条记录的状态视图；不在表里时返回 `undefined`。 */
  view(providerId: string, targetId: string): TabLeaseView | undefined {
    this.expire()
    const entry = this.entries.get(leaseKey(providerId, targetId))
    return entry === undefined ? undefined : this.viewOf(targetId, entry)
  }

  /**
   * 表里存的**哈希**（诊断 / 断言用）。
   *
   * 存在的意义只有一条：把「表里只有哈希、没有明文」变成可断言的事实。它永远不回明文 ——
   * 明文在 `handoff()` 返回之后就不存在于本模块的任何状态里。
   */
  storedHandoffHash(providerId: string, targetId: string): string | undefined {
    return this.entries.get(leaseKey(providerId, targetId))?.handoffHash
  }

  /** 卸载：清空表与定时器。 */
  dispose(): void {
    this.entries.clear()
    this.releaseListeners.clear()
    if (this.timer !== undefined) {
      this.clock.clearTimer(this.timer)
      this.timer = undefined
    }
  }

  /** 发一个新代次。只有真正换了归属（登记 / 领取 / 移交 / 释放 / 回收）才调用。 */
  private allocateGeneration(): number {
    this.generationSequence += 1
    return this.generationSequence
  }

  /** 取一条 `held` 记录，并核对主人。 */
  private requireHeld(key: string, targetId: string, ownerId: string, action: string): LeaseEntry {
    const entry = this.entries.get(key)
    if (entry === undefined || entry.state !== 'held' || entry.ownerId !== ownerId) {
      // 复用门禁的三种文案，避免「release 失败」与「操作失败」讲两套话。
      this.assertHeld(...this.partsOf(key), ownerId)
      // assertHeld 不抛 = 状态在它跑完之后又变了（不可能，除非未来引入并发）；兜一个。
      throw new BrowserError(
        `session "${targetId}" is no longer held by this conversation, so it cannot be ${action}ed`,
        'BROWSER_TAB_NOT_HELD',
      )
    }
    return entry
  }

  /**
   * 执行中的调用非零时拒绝释放 / 移交 / 关闭。
   *
   * 为什么不排队等：等待会把「一次工具调用」变成「不确定时长」的阻塞（对方可能正在跑
   * 30 秒的 wait），而模型需要的恰恰是一个能立刻决策的答案 —— 报忙、让它下轮再来。
   */
  private assertIdle(entry: LeaseEntry, targetId: string, action: string): void {
    if (entry.activeCalls === 0) return
    throw new BrowserError(
      `session "${targetId}" has ${String(entry.activeCalls)} call(s) still running, so it cannot be `
      + `${action}ed right now. This IS retryable: wait for those calls to finish and send the same `
      + 'request again — the plugin will not interrupt an operation in flight.',
      'BROWSER_TAB_BUSY',
    )
  }

  /** 转空闲（释放占用，保留页面）。 */
  private setAvailable(key: string, entry: LeaseEntry): void {
    // 同族一起转：弹窗父子共用状态，留一个 held 会造出「半个主人」。
    for (const memberKey of this.familyOf(key)) {
      const member = this.entries.get(memberKey)
      if (member === undefined) continue
      member.state = 'available'
      member.ownerId = undefined
      member.handoffHash = undefined
      member.generation = this.allocateGeneration()
      member.deadline = Number.POSITIVE_INFINITY
    }
  }

  private viewOf(targetId: string, entry: LeaseEntry): TabLeaseView {
    if (entry.state === 'available' || !Number.isFinite(entry.deadline)) {
      return { targetId, state: entry.state }
    }
    return {
      targetId,
      state: entry.state,
      remainingMs: Math.max(0, Math.round(entry.deadline - this.clock.now())),
    }
  }

  private partsOf(key: string): [string, string] {
    const { providerId, targetId } = splitLeaseKey(key)
    return [providerId, targetId]
  }

  /**
   * 同族标签：沿父链向上找到根，再把根的所有后代并进来。
   *
   * 弹窗只有一层，但迭代到不动点更稳妥（未来若出现「弹窗里再弹窗」不必改这里）。
   */
  private familyOf(key: string): string[] {
    const family = new Set<string>([key])
    let cursor = key
    for (let guard = 0; guard < 64; guard++) {
      const entry = this.entries.get(cursor)
      const parentKey = entry?.parentKey
      if (parentKey === undefined || family.has(parentKey)) break
      family.add(parentKey)
      cursor = parentKey
    }
    for (let guard = 0; guard < this.entries.size; guard++) {
      let grew = false
      for (const [candidateKey, candidate] of this.entries) {
        if (candidate.parentKey !== undefined && family.has(candidate.parentKey) && !family.has(candidateKey)) {
          family.add(candidateKey)
          grew = true
        }
      }
      if (!grew) break
    }
    return [...family]
  }

  /**
   * 惰性过期：每次查询 / 操作前跑一遍。
   *
   * 定时器可能因为宿主卡顿、事件循环阻塞而迟到很久，所以**不能**只信定时器：
   * 判据永远是「当下这一刻有没有过 deadline」。
   */
  private expire(): void {
    const now = this.clock.now()
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key)
      if (entry === undefined) continue
      if (entry.state === 'held') {
        // activeCalls 非零时**不得**超时释放（§3.1.4）：一次跨越截止时间的长调用不能被截断。
        if (entry.activeCalls > 0 || !Number.isFinite(entry.deadline) || entry.deadline > now) continue
        this.retire(key, entry, 'idle')
        continue
      }
      if (entry.state === 'handoff' && Number.isFinite(entry.deadline) && entry.deadline <= now) {
        this.retire(key, entry, 'handoff-expired')
      }
    }
    this.armTimer()
  }

  /**
   * 到期回收一条记录。**只释放占用，保留页面**（实施方案 §3.1.6）—— 原主人必须重新领取；
   * 别人已经领走时明确拒绝，不等待、不抢占。
   */
  private retire(key: string, entry: LeaseEntry, reason: TabLeaseReleaseReason): void {
    for (const memberKey of this.familyOf(key)) {
      const member = this.entries.get(memberKey)
      if (member === undefined) continue
      const wasHeld = member.state === 'held'
      member.state = 'available'
      member.ownerId = undefined
      member.handoffHash = undefined
      member.generation = this.allocateGeneration()
      member.deadline = Number.POSITIVE_INFINITY
      // 通知按**标签**粒度发：宿主需要逐个作废 ref 纪元。
      const { providerId, targetId } = splitLeaseKey(memberKey)
      if (wasHeld || reason === 'handoff-expired') {
        for (const listener of [...this.releaseListeners]) listener(providerId, targetId, reason)
      }
    }
  }

  /**
   * 重排全局定时器：取全表**最近的一个期限**。
   *
   * 一个定时器管全表（而不是每标签一个）：长会话动辄几十个标签，每标签一个定时器就是
   * 定时器风暴，而这里真正需要的只是「下一次该醒来的时刻」。
   */
  private armTimer(): void {
    let next = Number.POSITIVE_INFINITY
    for (const entry of this.entries.values()) {
      if (!Number.isFinite(entry.deadline)) continue
      if (entry.state === 'held' && entry.activeCalls > 0) continue
      if (entry.deadline < next) next = entry.deadline
    }
    if (this.timer !== undefined) {
      this.clock.clearTimer(this.timer)
      this.timer = undefined
    }
    if (!Number.isFinite(next)) return
    const delay = Math.max(1, next - this.clock.now())
    this.timer = this.clock.setTimer(() => {
      this.timer = undefined
      this.expire()
    }, delay)
  }
}
