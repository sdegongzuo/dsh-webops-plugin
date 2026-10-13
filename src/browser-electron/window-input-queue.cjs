/**
 * 窗口输入权调度器 —— 并发网页操作实施方案 §4 的宿主侧核心。
 *
 * 一个窗口（BaseWindow 实例）同时最多有一个有效输入权（ticket）。所有 agent 引起的
 * 前台变更（激活、`Input.*` 派发、open 展示、关闭替补）都经过这里；普通读命令
 * （`Runtime` / `DOM` / `Accessibility` …）与后台加载不申请输入权。
 *
 * 状态机：`queued → preparing → dispatching → finishing → released`；
 * 前置阶段取消 → `cancelled`；人工接管 / 窗口销毁 / 控制代次变化 → `revoked`；
 * 底层执行无法确认终止 → `blocked`（只有显式恢复命令能解除，重连 / 换票不算）。
 *
 * 三条不变量（方案 §2）：
 * 1. 一个窗口最多一个有效 ticket；不同窗口各自 new 一个队列实例。
 * 2. 输入权不跨模型轮次；取得后由 provider 重新验证 ref / 文档 / holder。
 * 3. 人工接管立即撤销；已派发或状态未知的动作不自动重放。
 *
 * 本文件**不 import electron** —— 单测直接 require 它；宿主在 `host.cjs` 里实例化。
 *
 * @module dsh-webops-plugin/browser-electron/window-input-queue
 */

const QUEUED = 'queued'
const PREPARING = 'preparing'
const DISPATCHING = 'dispatching'
const FINISHING = 'finishing'
const RELEASED = 'released'
const CANCELLED = 'cancelled'
const REVOKED = 'revoked'
const BLOCKED = 'blocked'
const ACQUIRED = 'acquired'

/**
 * 窗口写队列任务的三种性质：
 * - `agent`：自动展示（open / 弹窗 / 关闭替补）。执行前若当前前台标签归人工，
 *   暂缓执行（方案 §2.7：窗口前台保留给人工）。
 * - `read`：后台读路径的共享窗口写入（截图临时可见性 / DevTools 切换）。只与
 *   输入权互斥，**不受**人工前台保护限制 —— 后台读取在人工接管期间继续
 *   （方案 §6.5）。常量名 `WRITE_BG_READ`：它是「为后台读服务的窗口写」，
 *   不是业务写入。
 * - `human`：人工自己的选择（标签条点击）。不受人工前台保护限制。
 */
const WRITE_AGENT = 'agent'
const WRITE_BG_READ = 'read'
const WRITE_HUMAN = 'human'

/**
 * 造一个候补 / 持有条目。
 *
 * `view` 是 ticket 的不可变快照（epoch / controlEpoch / selectEpoch 在**取得的
 * 一刻**定住）；`ticketIdOf` 做身份比对。两者都在构造时绑定，不随状态推移改变。
 */
function makeEntry(request, queue) {
  const requestedAt = queue.now()
  const view = {
    ticketId: `${request.requestId}:${requestedAt}`,
    requestId: request.requestId,
    tabId: request.tabId,
    epoch: queue.epoch,
    controlEpoch: queue.controlEpoch,
    selectEpoch: queue.selectEpoch,
    acquiredAt: requestedAt,
  }
  return {
    requestId: request.requestId,
    tabId: request.tabId,
    stage: QUEUED,
    dispatched: false,
    settled: false,
    requestedAt,
    inFlight: 0,
    writes: 0,
    pressed: new Map(),
    view,
    resolve: undefined,
    timer: undefined,
    ticketIdOf: (ticketId) => view.ticketId === ticketId,
  }
}

class WindowInputQueue {
  /**
   * @param options - `now` 时间源（单测注入）；`onRevoke` 撤销通知（宿主据此
   *   向父进程发 `input-revoked`）；`humanForegroundAllows` 当前前台标签是否归人工。
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now())
    this.onRevoke = options.onRevoke
    this.onStateChange = options.onStateChange
    this.humanForegroundAllows = options.humanForegroundAllows ?? (() => false)
    /** 宿主启动代次：壳窗口每次重建 +1。旧票跨窗口重建一律失效。 */
    this.epoch = 0
    /** 内部控制代次：holder 每次变化 +1（方案 §4 的「内部控制代次」）。 */
    this.controlEpoch = 0
    /** 人工选择代次：每次人工切标签 +1；自动展示前比对，旧代次取消展示。 */
    this.selectEpoch = 0
    /** 当前持有的 ticket（含 blocked 占位）；undefined = 窗口空闲。 */
    this.current = undefined
    /** 候补队列（FIFO）。 */
    this.pending = []
    /** 已取消 preparing ticket 的迟到写入集合。 */
    this.cancelledWrites = new Set()
    /** 无票窗口写的串行尾巴。 */
    this.writeTail = Promise.resolve()
    this.windowWrites = []
    this.activeWrite = false
    this.ticketWriteTail = Promise.resolve()
    this.ticketSequence = 0
    /** 等 current 释放的写任务。 */
    this.releaseWaiters = new Set()
    /** 诊断：最近一次 blocked 的 ticket 视图。 */
    this.lastBlocked = undefined
  }

  /** 壳窗口重建：旧票全部失效，窗口级代次 +1。 */
  bumpWindowEpoch() {
    this.epoch += 1
    this.revokeAll('window-recreated')
    this.confirmEndpointDestroyed()
  }

  /** holder 变化：控制代次 +1，并撤销当前票（人工接管立即生效）。 */
  bumpControlEpoch() {
    this.controlEpoch += 1
    this.revokeAll('control-changed')
  }

  /** 人工切了一次标签：选择代次 +1。 */
  noteHumanSelect() {
    this.selectEpoch += 1
  }

  /** 自动展示代次检查：创建时记下的代次与当前一致才允许展示。 */
  autoDisplayEpochAllowed(capturedSelectEpoch) {
    return capturedSelectEpoch === this.selectEpoch
  }

  /**
   * 申请窗口输入权。
   *
   * 空闲立即返回 ticket（`preparing`）；否则进入候补队列，等待至 `budgetMs`
   * 到期。取消（父进程 `cancel-input`）与超时都明确返回，绝不挂起。
   *
   * @returns `{ status: 'acquired', ticket }` / `{ status: 'timeout' }`。
   */
  acquire(request) {
    const entry = makeEntry(request, this)
    return new Promise((resolve) => {
      entry.resolve = resolve
      entry.timer = setTimeout(() => {
        this.removePending(entry)
        entry.stage = CANCELLED
        resolve({ status: this.humanForegroundAllows() ? 'human-foreground' : 'timeout' })
      }, Math.max(0, request.budgetMs))
      this.pending.push(entry)
      this.startNext()
    })
  }

  /**
   * 释放输入权。幂等；迟到旧票明确拒绝（`stale-ticket`）。
   * 释放只表示共享资源可交给下一动作，不表示业务动作成功（方案 §2.6）。
   */
  release(ticketId) {
    const current = this.current
    if (current === undefined) return { ok: false, reason: 'idle' }
    if (!current.ticketIdOf(ticketId)) return { ok: false, reason: 'stale-ticket' }
    if (current.stage === BLOCKED) return { ok: false, reason: 'blocked' }
    if (current.inFlight > 0 || current.writes > 0 || current.pressed.size > 0) {
      this.blockCurrent()
      return { ok: false, reason: 'blocked', stage: BLOCKED }
    }
    const stage = current.stage
    current.stage = RELEASED
    this.current = undefined
    this.cancelledWrites.delete(ticketId)
    this.notifyRelease()
    this.startNext()
    return { ok: true, stage }
  }

  /**
   * 取消一个候补（按 requestId）或当前票（按 ticketId）。
   *
   * - `queued`：移除候补即结束；确认没有迟到授权后回 `cancelled`。
   * - `preparing`：标记取消、等窗口写队列排空（迟到写入被代次栅栏拒绝），
   *   确认无业务输入后才回 `cancelled`。只确认「没发 Input」不算数。
   * - `dispatching`：底层执行无法确认终止 → 转 `blocked`，不自动恢复。
   * - `finishing`：派发已回包，等价于释放。
   */
  async cancel(ticketIdOrRequestId) {
    // 先找候补（按 requestId）—— 候补没有 ticketId，只有 requestId。
    const index = this.pending.findIndex(entry => entry.requestId === ticketIdOrRequestId)
    if (index >= 0) {
      const [entry] = this.pending.splice(index, 1)
      clearTimeout(entry.timer)
      entry.stage = CANCELLED
      entry.resolve({ status: 'cancelled' })
      return { status: 'cancelled', stage: QUEUED }
    }
    const current = this.current
    if (current === undefined || (!current.ticketIdOf(ticketIdOrRequestId) && current.requestId !== ticketIdOrRequestId)) {
      return { status: 'stale-ticket', stage: current === undefined ? 'idle' : current.stage }
    }
    if (current.inFlight > 0 || current.pressed.size > 0) {
      this.blockCurrent()
      return { status: 'blocked', stage: DISPATCHING }
    }
    if (current.stage === PREPARING || current.stage === FINISHING) {
      const ticketId = current.view.ticketId
      this.cancelledWrites.add(ticketId)
      // 等窗口写队列排空：准备阶段的激活 / 布局 / 截图恢复可能还在队列里，
      // 必须等它们执行完或被代次栅栏拒绝，才算「没有迟到写入」（方案 §4）。
      // 只等本票的准备写；无票截图可能正在等本票释放，等它会构成反向死锁。
      await this.ticketWriteTail.catch(() => undefined)
      const still = this.current
      if (still === undefined || !still.ticketIdOf(ticketId)) {
        return { status: 'stale-ticket', stage: RELEASED }
      }
      if (still.stage !== PREPARING && still.stage !== FINISHING) {
        return { status: 'stale-ticket', stage: still.stage }
      }
      still.stage = CANCELLED
      this.current = undefined
      this.cancelledWrites.delete(ticketId)
      this.notifyRelease()
      this.startNext()
      return { status: 'cancelled', stage: PREPARING }
    }
    return { status: 'stale-ticket', stage: current.stage }
  }

  /**
   * 撤销当前票（人工接管 / 控制代次变化 / 窗口销毁）。
   *
   * 候补**不**撤销：它们还没拿到权，由父进程在 acquire 成功后自行过 holder 门
   * （方案 §6）。已派发或状态未知的撤销会带上阶段信息，父进程不得自动重放。
   *
   * blocked 中的票也发撤销通报 —— 但**保持 blocked**：底层执行无法确认终止，
   * 旧输入可能还会落到人工接管的页面上，不能把窗口交给下一动作（方案 §6：
   * 保持 blocked 并报告状态未知）。解除只能靠 `resolveBlocked` 的证据。
   *
   * @returns 被撤销票的快照列表（宿主据此通知父进程）。
   */
  revokeAll(reason) {
    const current = this.current
    if (current === undefined || current.stage === RELEASED) return []
    // blocked = 已派发、结果未知（底层执行无法确认终止）—— 撤销通报照发，
    // dispatched 记 true，让父进程的回执说「结果未知」而不是「零副作用」。
    const snapshot = {
      ticketId: current.view.ticketId,
      requestId: current.requestId,
      tabId: current.tabId,
      stage: current.stage,
      dispatched: current.dispatched || current.stage === BLOCKED,
      reason,
    }
    if (current.stage === BLOCKED) {
      if (this.onRevoke !== undefined) this.onRevoke(snapshot)
      return [snapshot]
    }
    if (current.inFlight > 0 || current.writes > 0 || current.pressed.size > 0) {
      this.cancelledWrites.add(current.view.ticketId)
      this.blockCurrent()
      if (this.onRevoke !== undefined) this.onRevoke(snapshot)
      return [snapshot]
    }
    current.stage = REVOKED
    this.current = undefined
    this.notifyRelease()
    this.startNext()
    if (this.onRevoke !== undefined) this.onRevoke(snapshot)
    return [snapshot]
  }

  /**
   * 解除 blocked：必须带证据 —— `settled`（所有旧输入调用已实际 settle 且收尾
   * 完成）或 `endpoint-destroyed`（承载旧输入的 WebContents / 窗口端点已销毁，
   * 旧输入不可能再落地）。仅重连、重新 attach 或更换票代次不足以解除（方案 §4）。
   */
  resolveBlocked(ticketId, evidence) {
    const current = this.current
    if (current === undefined || current.stage !== BLOCKED) return false
    if (!current.ticketIdOf(ticketId)) return false
    if (evidence !== 'settled' && evidence !== 'endpoint-destroyed') return false
    // 恢复事实由宿主记账；调用方传的词只是请求，不能当成终止证明。
    if (evidence === 'endpoint-destroyed' && !current.endpointDestroyed) return false
    if (!current.endpointDestroyed && (current.inFlight > 0 || current.writes > 0 || current.pressed.size > 0)) return false
    current.stage = RELEASED
    this.current = undefined
    this.lastBlocked = undefined
    this.cancelledWrites.delete(ticketId)
    this.notifyRelease()
    this.startNext()
    this.onStateChange?.()
    return true
  }

  /** 宿主收到了带票的 `Input.*` 命令：推进到 dispatching。 */
  noteDispatched(ticketId, method, params = {}) {
    const current = this.current
    if (current === undefined || !current.ticketIdOf(ticketId)) return false
    current.dispatched = true
    current.inFlight += 1
    current.settled = false
    current.stage = DISPATCHING
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') current.pressed.set(`mouse:${params.button}`, { method, params })
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') current.pressed.set(`key:${params.code ?? params.key}`, { method, params })
    return true
  }

  /** 带票的 `Input.*` 命令回包：推进到 finishing（等父进程 finally 释放）。 */
  noteSettled(ticketId, method, params = {}) {
    const current = this.current
    if (current === undefined || !current.ticketIdOf(ticketId)) return false
    current.inFlight = Math.max(0, current.inFlight - 1)
    current.settled = current.inFlight === 0
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') current.pressed.delete(`mouse:${params.button}`)
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') current.pressed.delete(`key:${params.code ?? params.key}`)
    if (current.settled && current.stage === DISPATCHING) current.stage = FINISHING
    return true
  }

  /**
   * 最终投递门的票校验（方案 §4）：派发 `Input.*` / 激活前必须调用。
   *
   * 代次栅栏校验**窗口重建代次（epoch）与内部控制代次（controlEpoch）**：两者
   * 任一变化即废票。**刻意不校验人工选择代次（selectEpoch）**：普通人工切标签
   * 不是接管，按方案 §6 在短临界区结束后才应用（宿主的写队列把人工选择排到
   * 当前输入权释放之后）；selectEpoch 只栅「自动展示」（宿主 open / 弹窗展示
   * 前的 autoDisplayEpochAllowed），不栅输入派发。
   *
   * @returns `'ok'` 或拒绝原因（`missing-ticket` / `stale-ticket` /
   *   `tab-mismatch` / `blocked`）。
   */
  verifyTicket(ticket, tabId) {
    if (ticket === undefined || ticket === null || typeof ticket['ticketId'] !== 'string') {
      return 'missing-ticket'
    }
    const current = this.current
    if (current === undefined) return 'stale-ticket'
    if (!current.ticketIdOf(ticket['ticketId'])) return 'stale-ticket'
    if (current.stage === BLOCKED) return 'blocked'
    if (this.cancelledWrites.has(ticket.ticketId)) return 'stale-ticket'
    if (current.stage !== PREPARING && current.stage !== DISPATCHING && current.stage !== FINISHING) {
      return 'stale-ticket'
    }
    if (ticket['epoch'] !== current.view.epoch || ticket['controlEpoch'] !== current.view.controlEpoch) {
      return 'stale-ticket'
    }
    if (tabId !== undefined && tabId !== current.tabId) return 'tab-mismatch'
    return 'ok'
  }

  /**
   * 把一个窗口写入排进串行队列。
   *
   * - **带票写**（`options.ticket` 完整票视图）：票本身就是独占凭证，不等待；
   *   执行时重新验票（代次 / 阶段 / 取消集合），不合格即迟到写入，拒绝。
   *   用于「open 的展示段」这类输入权覆盖的宿主写入（方案 §3）。
   * - **无票写**（tabbar 人工选择 / 关闭替补 / 截图可见性恢复）：执行前若有人
   *   持输入权 → 等其释放（人工切换在短临界区结束后应用）；`kind: 'agent'` 的
   *   自动展示执行前再查一次人工前台保护。
   */
  enqueueWindowWrite(task, options = {}) {
    if (options.ticket !== undefined) {
      const run = this.ticketWriteTail.then(() => this.runWindowWrite(task, options))
      this.ticketWriteTail = run.then(() => undefined, () => undefined)
      return run
    }
    return new Promise((resolve, reject) => {
      this.windowWrites.push({ task, options, resolve, reject })
      // 延迟至微任务，保证当前同步段能记下撤销与最新人工选择。
      queueMicrotask(() => this.startNext())
    })
  }

  async runWindowWrite(task, options) {
    const { kind = WRITE_AGENT, ticket } = options
    // 自动展示的人工前台保护：活动标签归人工时，agent 的展示暂缓（方案 §2.7）。
    // `read`（截图等后台读）不受此限 —— 后台读取在人工接管期间继续。
    const agentPaused = kind === WRITE_AGENT && this.humanForegroundAllows()
    if (ticket !== undefined) {
      if (this.cancelledWrites.has(ticket.ticketId)) return
      // 迟到写入拒绝：票必须仍是当前票（代次 / 阶段未变）—— 旧操作不得在
      // 下一动作测量之后改变前台（方案 §4）。
      if (this.verifyTicket(ticket, undefined) !== 'ok') return
      if (agentPaused) return
      const current = this.current
      current.writes += 1
      try { return await task() } finally { current.writes -= 1 }
    }
    // 无票写入等当前输入权释放（有界由调用方的命令超时兜底）。
    if (kind === WRITE_AGENT && this.humanForegroundAllows()) return
    return await task()
  }

  waitRelease() {
    return new Promise((resolve) => { this.releaseWaiters.add(resolve) })
  }

  notifyRelease() {
    const waiters = [...this.releaseWaiters]
    this.releaseWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  startNext() {
    if (this.current !== undefined || this.activeWrite) return
    if (this.windowWrites.length > 0) {
      // 临界区结束后最新人工选择先应用；自动展示自行检查选择代次。
      const human = this.windowWrites.findLastIndex(write => write.options.kind === WRITE_HUMAN)
      if (human >= 0) {
        for (let i = human - 1; i >= 0; i -= 1) {
          if (this.windowWrites[i].options.kind === WRITE_HUMAN) this.windowWrites.splice(i, 1)[0].resolve()
        }
      }
      const index = this.windowWrites.findLastIndex(write => write.options.kind === WRITE_HUMAN)
      const write = this.windowWrites.splice(index < 0 ? 0 : index, 1)[0]
      this.activeWrite = true
      const run = this.runWindowWrite(write.task, write.options)
      this.writeTail = Promise.resolve(run).then(write.resolve, write.reject).finally(() => {
        this.activeWrite = false
        this.startNext()
      })
      return
    }
    if (this.humanForegroundAllows()) return
    while (this.current === undefined && this.pending.length > 0) {
      const entry = this.pending.shift()
      clearTimeout(entry.timer)
      if (entry.stage !== QUEUED) continue
      entry.stage = PREPARING
      // 候补**被唤醒的一刻**才真正取得输入权：代次字段刷新为当前值。
      // 沿用入队时的旧代次会让「代次变化后到手的票」带着过期代次却自洽，
      // verifyTicket 将放行一张本该失效的票（方案 §4：票绑定取得时刻）。
      entry.view = {
        ticketId: `${entry.requestId}:${++this.ticketSequence}:${entry.requestedAt}`,
        requestId: entry.requestId,
        tabId: entry.tabId,
        epoch: this.epoch,
        controlEpoch: this.controlEpoch,
        selectEpoch: this.selectEpoch,
        acquiredAt: this.now(),
      }
      entry.ticketIdOf = (ticketId) => entry.view.ticketId === ticketId
      this.current = entry
      entry.resolve({ status: ACQUIRED, ticket: { ...entry.view } })
      return
    }
  }

  removePending(entry) {
    const index = this.pending.indexOf(entry)
    if (index >= 0) this.pending.splice(index, 1)
  }

  /** 状态变化后重新检查人工前台与候补；宿主激活、交还时调用。 */
  foregroundChanged() { this.startNext() }

  blockCurrent() {
    this.current.stage = BLOCKED
    this.lastBlocked = { ...this.current.view }
    this.onStateChange?.()
  }

  /** 已派发输入的安全收尾只允许作用于原 agent 页面，由宿主调用。 */
  pendingReleases(ticketId) {
    const current = this.current
    if (!current?.ticketIdOf(ticketId) || current.inFlight > 0 || current.writes > 0) return undefined
    return [...current.pressed.values()]
  }

  /** 宿主观察到真正的 WebContents 销毁，才允许 endpoint-destroyed 恢复。 */
  confirmEndpointDestroyed(tabId) {
    const current = this.current
    if (!current || (tabId !== undefined && current.tabId !== tabId)) return
    current.endpointDestroyed = true
    this.blockCurrent()
    this.resolveBlocked(current.view.ticketId, 'endpoint-destroyed')
  }

  /** 诊断快照（测试与排障用）。 */
  status() {
    return {
      epoch: this.epoch,
      controlEpoch: this.controlEpoch,
      selectEpoch: this.selectEpoch,
      current: this.current === undefined ? null : {
        requestId: this.current.requestId,
        tabId: this.current.tabId,
        stage: this.current.stage,
        dispatched: this.current.dispatched,
        settled: this.current.settled,
        inFlight: this.current.inFlight,
        writes: this.current.writes,
        pressed: this.current.pressed.size,
      },
      queued: this.pending.length,
      blocked: this.lastBlocked !== undefined,
      activeWrite: this.activeWrite,
    }
  }
}

module.exports = {
  WindowInputQueue,
  QUEUED,
  PREPARING,
  DISPATCHING,
  FINISHING,
  RELEASED,
  CANCELLED,
  REVOKED,
  BLOCKED,
  ACQUIRED,
  WRITE_AGENT,
  WRITE_BG_READ,
  WRITE_HUMAN,
}
