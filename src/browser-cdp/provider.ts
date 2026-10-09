/** CDP provider 入口：受控会话生命周期、控制权门禁、输入派发与操作编排。 */

import { type CdpTransport, HttpCdpTransport, type CdpConnection, type CdpTarget } from './protocol.ts'
import { StaleRefMetrics } from './metrics.ts'
import { TargetStateRegistry, PAGE_DOCUMENT_STATE_KEY } from './state.ts'
import { validateEndpoint, validateTargetUrl } from './url-policy.ts'
import {
  type BrowserOpenRequest,
  type BrowserSession,
  BrowserError,
  type BrowserNavigateRequest,
  type BrowserObserveRequest,
  type BrowserObservation,
  type BrowserRevalidateRequest,
  type BrowserRevalidateResult,
  type BrowserRevalidateFailure,
  type BrowserTabsRequest,
  type BrowserTabsResult,
  type BrowserMutationRequest,
  type BrowserMutationResult,
  type BrowserTabInfo,
  type BrowserConsoleRequest,
  type BrowserConsoleResult,
  type BrowserNetworkRequest,
  type BrowserNetworkResult,
  type BrowserExecuteRequest,
  type BrowserExecuteResult,
  type BrowserPageChanged,
  type BrowserMutationTarget,
  type BrowserProvider,
  type BrowserLocateRequest,
  type BrowserLocateResult,
} from '../browser/types.ts'
import { RefRegistry, type RefTarget } from './refs.ts'
import { ConsoleCollector } from './console.ts'
import { NetworkCollector } from './network.ts'
import { SessionDirtyTracker } from './dirty.ts'
import {
  assertExecuteAllowed,
  translateEvaluateError,
  extractEvaluateException,
  extractEvaluateValue,
} from './execute.ts'
import {
  CDP_PROVIDER_ID,
  type ResolvedConfig,
  type CdpProviderConfig,
  DEFAULT_CONFIG,
  TAB_OPEN_WATCH_MS,
  TAB_OPEN_WATCH_POLL_MS,
  NAVIGATION_COMMANDS,
  WHEEL_ACK_TIMEOUT_MS,
} from './provider-config.ts'
import {
  type SessionState,
  noteDocumentChange,
  type NavigationHistoryResult,
  type BrowserHolder,
  type HitTestOutcome,
  type EvaluateResult,
} from './provider-session.ts'
import { PageNavigation } from './page-navigation.ts'
import { PageObservation } from './page-observation.ts'
import { PageNodes } from './page-nodes.ts'
import { PageWait } from './page-wait.ts'
import { pollUntil, delay } from './polling.ts'
import { normalizeLimit, capResult, describeKey } from './provider-helpers.ts'
import { FILL_FUNCTION } from './page-scripts.ts'

export {
  CDP_PROVIDER_ID,
  DEFAULT_CDP_ENDPOINT,
  type CdpProviderConfig,
  MAX_WAIT_TIME_MS,
  MUTATION_NAVIGATION_POLL_MS,
  TAB_OPEN_WATCH_MS,
  MUTATION_NAVIGATION_SETTLE_MS,
  WHEEL_ACK_TIMEOUT_MS,
  DEFAULT_P2_LIMIT,
  MAX_P2_LIMIT,
  EXECUTE_MAX_RESULT_CHARS,
  validateProviderConfig,
} from './provider-config.ts'

export {
  type BrowserHolder,
} from './provider-session.ts'

export {
  HIT_TEST_FUNCTION,
  OVERLAY_PROBE_EXPRESSION,
} from './page-scripts.ts'

/** 生命周期与状态仍由 provider 统一持有，内部模块不持有会话注册表。 */
export class CdpBrowserProvider implements BrowserProvider {
  private readonly nodes: PageNodes
  private readonly observation: PageObservation
  private readonly navigation: PageNavigation
  private readonly waiting: PageWait

  // 类型放宽成 `string`：这个 provider 也是「Electron 窗口」provider 的基类，
  // 子类会用另一个 id 注册（见 `browser-electron/provider.ts`）。
  readonly id: string = CDP_PROVIDER_ID

  private readonly config: ResolvedConfig

  private readonly transport: CdpTransport

  private readonly sessions = new Map<string, SessionState>()

  /**
   * P0 计数（方案 §4，D-7=B）：只有设了 `DSH_BROWSER_PLUGIN_METRICS` 才活着，
   * 否则整条路径是空的（见 {@link StaleRefMetrics}）。落盘走会话级 flush，不在事件上写。
   */
  private readonly metrics = new StaleRefMetrics()

  /**
   * §6.5：target 级状态的归属簿记（方案 2.3）。这个人接管按钮是它**第一个真实的生产者**
   * —— 在此之前 `markTakeover` 只有单测调用（见 `state.ts` 的文件头）。
   */
  protected readonly stateRegistry = new TargetStateRegistry()

  /**
   * 「收编了一个非 open 创建的标签」的订阅者。能力缝隙据此把**标签占用**从父标签继承到
   * 子标签（实施方案 §5.2）—— 租约表住在能力缝隙那一层，provider 看不见它，只能通报事实。
   */
  private readonly adoptListeners = new Set<(targetId: string, openerTargetId: string | undefined) => void>()

  private probe: { readonly at: number; readonly ok: boolean } | undefined

  private probing: Promise<boolean> | undefined

  /**
   * @param config - 端点与各类超时；全部有默认值。
   * @param transport - 传输层；省略时用 {@link HttpCdpTransport}（测试会替换掉它）。
   */
  constructor(config: CdpProviderConfig = {}, transport?: CdpTransport) {
    this.config = {
      // 端点在这里就校验：配错了立刻炸，不要等到模型第一次调用才报一句难懂的错误。
      endpoint: validateEndpoint(config.endpoint ?? DEFAULT_CONFIG.endpoint),
      commandTimeoutMs: config.commandTimeoutMs ?? DEFAULT_CONFIG.commandTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_CONFIG.requestTimeoutMs,
      navigationTimeoutMs: config.navigationTimeoutMs ?? DEFAULT_CONFIG.navigationTimeoutMs,
      probeTtlMs: config.probeTtlMs ?? DEFAULT_CONFIG.probeTtlMs,
      snapshotLimits: config.snapshotLimits ?? DEFAULT_CONFIG.snapshotLimits,
      waitTimeoutMs: config.waitTimeoutMs ?? DEFAULT_CONFIG.waitTimeoutMs,
      stableQuietWindowMs: config.stableQuietWindowMs ?? DEFAULT_CONFIG.stableQuietWindowMs,
      stableNetworkGraceMs: config.stableNetworkGraceMs ?? DEFAULT_CONFIG.stableNetworkGraceMs,
    }
    this.transport = transport ?? new HttpCdpTransport(this.config.endpoint, {
      requestTimeoutMs: this.config.requestTimeoutMs,
      commandTimeoutMs: this.config.commandTimeoutMs,
    })
    this.navigation = new PageNavigation(this.config)
    this.nodes = new PageNodes(this.config, this.metrics)
    this.observation = new PageObservation(this.config, this.nodes, this.navigation)
    this.waiting = new PageWait(this.config, this.nodes, this.navigation)
  }

  /**
   * 探测调试端口是否在监听。
   *
   * 语义上的取舍：**拿不准时返回 true**。原因有两个 ——
   * ① 这个方法是同步的，真正探测是异步的，首次调用时手里只有「还没探测过」这一信息；
   * ② 谎报「不可用」会让能力缝隙抛出 `BROWSER_PROVIDER_UNAVAILABLE`，模型看到的是一句
   * 无从下手的通用错误，而真实原因（Chrome 没开调试端口）是可以在 `open()` 里被精确描述的。
   * 已有会话存活时直接为真，不必探测。
   */
  available(): boolean {
    if (this.sessions.size > 0) return true
    const cached = this.probe
    if (cached !== undefined && Date.now() - cached.at < this.config.probeTtlMs) return cached.ok
    // 结果过期或还不存在：后台刷新，本次先乐观返回，把精确诊断留给 open()。
    void this.refreshProbe()
    return true
  }

  /** @inheritdoc */
  async open(request: BrowserOpenRequest, signal?: AbortSignal): Promise<BrowserSession> {
    const url = request.url === undefined ? 'about:blank' : validateTargetUrl(request.url)
    // 先建一个空白页，再显式 `Page.navigate` 到目标地址。
    //
    // 为什么不直接把 url 交给 `/json/new`：那样标签页建好后导航是**异步**开始的，
    // 此刻 `document.readyState` 已经是 `complete`（空白页本来就 complete），
    // 「等加载完成」会立刻返回，于是 url / title / 大纲全在空白页上读了一遍 ——
    // 实测表现是 `open` 成功、返回的 url 却是 `about:blank`、snapshot 零字符。
    // 显式 navigate 之后，「等加载」等到的才是目标文档。
    const target = await this.createTarget('about:blank', signal)
    this.probe = { at: Date.now(), ok: true }

    let connection: CdpConnection
    try {
      connection = await this.transport.connect(target.webSocketDebuggerUrl, signal)
    } catch (error: unknown) {
      // 连不上就立刻回收刚开的标签页，不给用户留一个孤儿标签。
      await this.transport.closeTarget(target.id).catch(() => undefined)
      throw error
    }

    const session: SessionState = {
      targetId: target.id,
      connection,
      refs: new RefRegistry({ onStale: reason => { this.metrics.noteStale(target.id, reason) } }),
      // 采集器在构造时就订阅事件，所以必须在下面 `*.enable` 之前建好 —— 否则第一批
      // 重放 / 实时事件会在订阅前溜走。
      consoleCollector: new ConsoleCollector(connection),
      networkCollector: new NetworkCollector(connection),
      // 与采集器同序：构造函数里就订阅 `Page.*` 两个导航事件，必须赶在下面 `Page.enable` 之前建好。
      // ③ 的簿记写入走这个回调（谁的页面、什么时候被换掉的）—— 见 `state.ts` 的 key 注释。
      dirty: new SessionDirtyTracker(connection, target.url, {
        onDocumentChanged: report => {
          this.stateRegistry.reportExternalRewrite(target.id, PAGE_DOCUMENT_STATE_KEY, report)
        },
      }),
      url: target.url,
      title: target.title,
      takeover: false,
      holder: 'agent',
      highlightPainted: false,
    }
    try {
      await connection.send('Page.enable', {}, { signal, timeoutMs: this.config.commandTimeoutMs })
      // 立刻打开 console / network 两路采集，让「实时落缓冲」从这一刻起生效，而不是等到第一次
      // read —— `Network` 不做重放（`[V38]`），不早开就会整段丢失。
      //
      // 这里是**尽力而为**：这几条 enable 的失败不该让整个 open 失败（会话本体已经建好，P0/P1
      // 工具照常可用）。真正的权威补发在每次 read 前（见 provider.console / provider.network），
      // 那里失败会按可恢复错误上抛。
      for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable']) {
        await connection.send(domain, {}, { signal, timeoutMs: this.config.commandTimeoutMs }).catch(() => undefined)
      }
      // 等加载完成。超时**不**抛错：此时标签页已经建好，抛错会让调用方拿不到 session id，
      // 反而留下一个谁也管不着的孤儿标签。加载慢的页面交给模型自己再 snapshot。
      //
      // 赊账先记：这一次 open 自己引发的导航（含重定向链）到达时不该被算成「页面在模型之外变过」。
      // 下面的 `reset()` 把已经数进去的清掉，而赊账**不会被它清掉** —— 那正好接住迟到几毫秒的事件。
      session.dirty.expectSelfNavigation()
      await this.navigation.navigateTo(connection, url, session.url, signal)
      const meta = await this.navigation.readPageMeta(connection, signal)
      if (meta !== undefined) {
        session.url = meta.url
        session.title = meta.title
      }
      // **建会话这一刻把脏累加器清零**：`about:blank` → 目标地址（可能还带一串重定向）全是
      // 我们这一次 open 自己造成的，而「上一次快照」在此时根本不存在。不清的话第一条快照回执
      // 就会报一句无中生有的「页面变过」。迟到几毫秒的事件由上面那笔赊账接住。
      session.dirty.reset()
    } catch (error: unknown) {
      connection.close()
      await this.transport.closeTarget(target.id).catch(() => undefined)
      throw error
    }

    this.sessions.set(session.targetId, session)
    // 用户自己关掉标签页时同步摘掉会话，避免留下一个永远连不上的死会话。
    connection.onClose(() => {
      if (this.sessions.get(session.targetId) !== session) return
      this.sessions.delete(session.targetId)
      // §6.5：连接断了（用户自己关了标签页）时，控制权簿记同样要清。
      this.stateRegistry.forget(session.targetId)
    })
    return this.toSession(session)
  }

  /**
   * 收编一个**已经存在**的标签页为受控会话（不导航、不新建）。
   *
   * 场景：窗口宿主里页面弹窗转的新标签、标签条「+」开的标签 —— 它们没走 `open()`
   * （没有 `newTab` 应答），会话注册表天然看不见；宿主在 dom-ready 后通报
   * `{ type: 'opened' }`，provider 据此调用这里把它们收编进来，`webpage_tabs(list)`
   * 与后续工具才可操作。通知到达时调试器已接上、文档已提交，所以：
   *
   * - `Page.enable` 等全部**尽力而为**：收编失败不该炸掉通报链路（标签顶多继续不可见，
   *   与修复前一致）；
   * - 等 `readyState === 'complete'` 用 `waitForDocument`（通报时文档已提交，不存在
   *   open() 里「空白页提前 complete」的坑），超时**不**抛错 —— 会话照样登记，
   *   页面慢就交给模型自己再 snapshot。
   *
   * @param target - 已存在目标的摘要（id / url / title / 句柄）。
   * @param openerTargetId - 弹出它的受控父标签（页面弹窗才有；省略 = 无父，人工新建）。
   * @param signal - 取消信号。
   * @returns 收编好的会话。
   */
  protected async adoptSession(
    target: CdpTarget,
    openerTargetId: string | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserSession> {
    const connection = await this.transport.connect(target.webSocketDebuggerUrl, signal)
    const session: SessionState = {
      targetId: target.id,
      connection,
      refs: new RefRegistry({ onStale: reason => { this.metrics.noteStale(target.id, reason) } }),
      // 与 open() 同序：采集器在构造时订阅事件，必须赶在 enable 之前建好。
      consoleCollector: new ConsoleCollector(connection),
      networkCollector: new NetworkCollector(connection),
      dirty: new SessionDirtyTracker(connection, target.url, {
        onDocumentChanged: report => {
          this.stateRegistry.reportExternalRewrite(target.id, PAGE_DOCUMENT_STATE_KEY, report)
        },
      }),
      url: target.url,
      title: target.title,
      takeover: false,
      holder: 'agent',
      highlightPainted: false,
    }
    await connection.send('Page.enable', {}, { signal, timeoutMs: this.config.commandTimeoutMs })
      .catch(() => undefined)
    for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable']) {
      await connection.send(domain, {}, { signal, timeoutMs: this.config.commandTimeoutMs }).catch(() => undefined)
    }
    // **先登记、后等加载**：通报链路存在的意义就是「让 tabs(list) 尽早看见弹窗标签」；
    // 若等加载完成才登记，`click` 后立刻 `tabs(list)` 会重新引入竞态（2026-09-13 keyless
    // 实测）。url/title 先用通报值顶着，页面加载完再刷成页面真实值。
    this.sessions.set(session.targetId, session)
    connection.onClose(() => {
      if (this.sessions.get(session.targetId) !== session) return
      this.sessions.delete(session.targetId)
      // §6.5：连接断了（用户自己关了标签页）时，控制权簿记同样要清。
      this.stateRegistry.forget(session.targetId)
    })
    // 收编时这个标签页可能还在加载：那一段的换文档事件不是「模型之外有人动过」，记笔赊账，
    // 下面的 `reset()` 清掉已经数进去的、赊账接住迟到的。
    session.dirty.expectSelfNavigation()
    await this.navigation.waitForDocument(connection, signal, this.config.navigationTimeoutMs)
    const meta = await this.navigation.readPageMeta(connection, signal)
    if (meta !== undefined && meta.url !== '') {
      session.url = meta.url
      session.title = meta.title
    }
    // 与 `open()` 同理：收编发生在这个页面加载的尾巴上，那些换文档事件不是「模型之外有人动过」——
    // 模型这时还没见过这个页面。
    session.dirty.reset()
    // 会话**先登记在 provider 里**（上面 `sessions.set`），再通报收编 —— 通报的订阅方
    // （能力缝隙）需要立刻能对同一个 id 记账，顺序反了会让「刚收编就被操作」落空。
    for (const listener of [...this.adoptListeners]) listener(session.targetId, openerTargetId)
    return this.toSession(session)
  }

  /**
   * 订阅「收编了一个非 `open()` 创建的标签」（页面弹窗 / 标签条「+」）。
   *
   * 通报的只有**事实**（谁被收编了、它是谁弹的），归属裁决在能力缝隙那一层。
   */
  onSessionAdopted(listener: (targetId: string, openerTargetId: string | undefined) => void): () => void {
    this.adoptListeners.add(listener)
    return () => this.adoptListeners.delete(listener)
  }

  /**
   * 占用归属变了（释放 / 移交 / 空闲超时回收 → 见实施方案 §3.2）：作废该会话的 ref 纪元。
   *
   * **同步**是有意的：作废只是把 provider 侧的纪元表清掉，不发页面命令 —— 它必须能在
   * 「另一个对话已经领走了」那一瞬立刻生效，否则新主人会拿到一个「表面可用、实际属于
   * 上一个对话」的 ref。
   */
  invalidateSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.refs.invalidate()
  }

  /**
   * 新建一个标签页。**只新建，绝不接管既有标签页。**
   *
   * 为什么不退回「拿 `/json/list` 的第一个页面顶上」：那里的页面可能是用户的邮箱、后台或 IDE，
   * 悄悄接管并导航它，等于把用户正在看的东西弄没 —— 这个代价远大于「open 失败」。
   * 而嵌入式的 Chromium（Electron 系，**包括 dsh 桌面端自己**）的 DevTools 端点根本不实现
   * `PUT /json/new`，那是一个应该被明确报告的部署问题，不是一次顺手接管的机会。
   */
  private async createTarget(url: string, signal?: AbortSignal): Promise<CdpTarget> {
    try {
      return await this.transport.newTab(url, signal)
    } catch (error: unknown) {
      if (!(error instanceof BrowserError) || error.code !== 'BROWSER_PROTOCOL_ERROR') throw error
      const pages = await this.transport.list(signal)
        .then(targets => targets.filter(target => target.type === 'page').length)
        .catch(() => 0)
      throw new BrowserError(
        `the DevTools endpoint at ${this.config.endpoint} refused to create a new tab (${error.message}); `
        + `it currently exposes ${pages} page target(s). Embedded Chromium builds (Electron-based apps) do not `
        + 'implement PUT /json/new — point the endpoint at a real Chrome started with --remote-debugging-port.',
        'BROWSER_PROTOCOL_ERROR',
        { cause: error },
      )
    }
  }

  /** @inheritdoc */
  async navigate(request: BrowserNavigateRequest, signal?: AbortSignal): Promise<BrowserSession> {
    const session = this.require(request.sessionId)
    this.assertWritable(session)
    // `url` 与 `history` 恰好一个：两个都给 = 矛盾（到底跳地址还是走历史），
    // 一个都不给 = 没法猜。**静默挑一个是这里最容易犯的错**，所以一律报错。
    const wantsUrl = typeof request.url === 'string' && request.url.length > 0
    const wantsHistory = request.history !== undefined
    if (wantsUrl === wantsHistory) {
      throw new BrowserError(
        'webpage_navigate needs exactly one of url or history (back / forward / reload)',
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    // 记住导航前的地址：新文档提交之前，`readyState` 仍是**旧**文档的 complete，
    // 只有「地址真的变了」才说明新页面已经顶上来。
    const previousUrl = session.url
    // 这次导航是我们自己发的 —— 记一笔赊账，别让它进脏累加器（回执里本来也不带这个字段）。
    // 记在分支**之前**：`url` 与 `history` 两个入口都算自己发的，漏一边就会让 back/forward
    // 被脏累加器报成「旁边有人动过页面」。
    session.dirty.expectSelfNavigation()
    const target = wantsUrl ? validateTargetUrl(request.url as string) : request.history as string
    const loaded = wantsHistory
      ? await this.navigateHistory(session, request.history as 'back' | 'forward' | 'reload', previousUrl, signal)
      : await this.navigation.navigateTo(session.connection, target, previousUrl, signal)
    // 导航无论成功与否都作废既有 ref —— 页面已经变了，旧 ref 指向的东西不再可信。
    session.refs.invalidate()
    const meta = await this.navigation.readPageMeta(session.connection, signal)
    if (meta !== undefined) {
      session.url = meta.url
      session.title = meta.title
    } else {
      // 读不到元信息时（空白页 / 崩溃页）至少把「目标」写进会话地址，别让下一次判定拿到空串。
      session.url = wantsUrl ? target : previousUrl
    }
    // 只有真的换过文档才推进采集器的文档序号：等加载超时（`loaded=false`）且地址也没变时
    // 文档可能根本没换，那时把 console / network 的旧记录遮掉反而是错的。
    if (loaded || (meta !== undefined && meta.url !== '' && meta.url !== previousUrl)) {
      noteDocumentChange(session)
    }
    if (!loaded) {
      throw new BrowserError(
        `navigation to ${target} did not finish loading within ${this.config.navigationTimeoutMs} ms; the page may still be loading`,
        'BROWSER_NAVIGATION_FAILED',
      )
    }
    // 加载完成即算「新文档能用」：读到空标题说明这页面本来就没有 <title>，不必再等。
    if (session.title.length === 0) await this.navigation.settleDocument(session, signal)
    // 换了文档 ⇒ 之前攒的「页面在模型之外变过」全部失去意义（模型本来就得重拍快照），
    // 而这一次导航是我们自己发的、不该记进去。清零比让它带着旧账进下一轮更诚实。
    session.dirty.reset()
    return this.toSession(session)
  }

  /**
   * 走浏览器自己的历史栈：`back` / `forward` / `reload`（B2-b）。
   *
   * 为什么单独做一条路：模型要「回到上一页」时，此前唯一的手段是
   * `webpage_execute("history.back()")` —— 逃生舱只为这个动作敞开，而它明明是个常规动作。
   * 走 `Page.getNavigationHistory` + `Page.navigateToHistoryEntry` 同时也是**唯一能知道
   * 历史有没有尽头**的做法：尽头时必须明确报错，绝不能静默 no-op（那样模型会以为自己已经回退了）。
   *
   * @returns 是否在超时前完成加载。
   */
  private async navigateHistory(
    session: SessionState,
    direction: 'back' | 'forward' | 'reload',
    previousUrl: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    if (direction === 'reload') {
      await session.connection.send('Page.reload', {}, options)
      // 刷新**地址不变**，所以「等地址变」的判据用不上，只等文档重新 complete。
      return this.navigation.waitForDocument(session.connection, signal, this.config.navigationTimeoutMs)
    }
    const history = await session.connection.send<NavigationHistoryResult>(
      'Page.getNavigationHistory',
      {},
      options,
    )
    const entries = history.entries ?? []
    const currentIndex = history.currentIndex ?? -1
    const targetIndex = direction === 'back' ? currentIndex - 1 : currentIndex + 1
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= entries.length) {
      throw new BrowserError(
        `cannot go ${direction}: the session is at history entry ${currentIndex + 1} of ${entries.length}`
        + ` (session_id=${session.targetId}); there is nothing ${direction === 'back' ? 'behind' : 'ahead'} it. `
        + 'Take a webpage_snapshot and act on the page instead of retrying.',
        'BROWSER_NAVIGATION_FAILED',
      )
    }
    const entry = entries[targetIndex]
    if (entry === undefined) {
      throw new BrowserError(`cannot go ${direction}: history entry ${targetIndex} is unreadable`, 'BROWSER_NAVIGATION_FAILED')
    }
    await session.connection.send('Page.navigateToHistoryEntry', { entryId: entry.id }, options)
    return this.navigation.waitForNavigation(session.connection, previousUrl, signal, this.config.navigationTimeoutMs)
  }

  /** @inheritdoc */
  async observe(request: BrowserObserveRequest, signal?: AbortSignal): Promise<BrowserObservation> {
    const session = this.require(request.sessionId)
    return request.kind === 'snapshot'
      ? this.observation.snapshot(session, signal, request.maxLines, request.region)
      : this.observation.screenshot(session, request.ref, request.fullPage ?? false, signal)
  }

  /**
   * 把旧纪元的 ref 精确装回当前纪元。
   *
   * 顺序不能乱：先比对归档 `loaderId` 与当前主 frame `loaderId`，对不上直接拒绝、
   * **不**发 `DOM.resolveNode` —— 导航后 backendNodeId 会重新编号，对上号再核对
   * role/name 仍可能静默命中新文档里的另一个「下一页」按钮。
   */
  async revalidate(request: BrowserRevalidateRequest, signal?: AbortSignal): Promise<BrowserRevalidateResult> {
    const session = this.require(request.sessionId)
    this.metrics.noteRefCall(session.targetId)
    if (!session.refs.observed) {
      throw new BrowserError(
        'this session has never been observed; run webpage_snapshot first',
        'BROWSER_SNAPSHOT_REQUIRED',
      )
    }
    // `loaderId` 出自浏览器进程侧的 `Page.getFrameTree`；下面可能要回填的纪元地址**不能**用同一
    // 次读的返回值 —— 它必须与写前门同源，理由写在那一段。
    const loaderId = await this.navigation.readMainLoaderId(session, signal)
    const restored: { ref: string; role: string; name: string }[] = []
    const failed: BrowserRevalidateFailure[] = []
    const pending: RefTarget[] = []
    for (const ref of request.refs) {
      const outcome = await this.nodes.revalidateOne(session, ref, loaderId, signal)
      if (outcome.ok) {
        restored.push({ ref: outcome.target.ref, role: outcome.target.role, name: outcome.target.name })
        if (outcome.restore) pending.push(outcome.target)
      } else {
        failed.push({ ref, reason: outcome.reason })
      }
    }
    // 纪元缺粗门依据时（被写前门作废过，或那次 `publish` 根本没读到地址），补一份当下的地址。
    // **必须与门同源**：门比的是 renderer 侧 `window.top.location.href`，而 `Page.getFrameTree`
    // 的主 frame url 是浏览器进程的镜像 —— 导航在飞、重定向、特权页上两者会差一档，拿镜像值
    // 当基线会把一次正常操作判成「页面导航了」并作废整个纪元（违 J2）。所以单独发一次
    // `Runtime.evaluate`，只在缺依据时花这一趟。空 `pending` 也要补：不补就是永久关掉粗门。
    const missingEpochUrl = session.refs.publishedUrl === undefined
    if (missingEpochUrl || pending.length > 0) {
      const meta = missingEpochUrl ? await this.navigation.readPageMeta(session.connection, signal) : undefined
      session.refs.restore(pending, meta?.url)
    }
    return {
      kind: 'revalidate',
      sessionId: session.targetId,
      epoch: session.refs.currentEpoch,
      restored,
      failed,
      // 恢复成功的判据只是「归档 loaderId 对得上 + role/name 一致」，同文档里的重排
      // （列表换序、控件被替换）它一个字都看不出来。所以「页面自己变过」这条线索必须带上：
      // 否则模型看到一片 restored，会以为手里的号全都干净。
      ...this.dirtyField(session),
    }
  }

  /** @inheritdoc */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    // 幂等：重复关闭不是错误。
    if (session === undefined) return
    this.assertWritable(session)
    // 宿主最后一次裁决通过并实际关闭后才摘账，接管拒绝不能被吞掉。
    await this.transport.closeTarget(session.targetId)
    this.sessions.delete(sessionId)
    // §6.5：会话没了，它的控制权簿记也一并清掉，别把接管窗口留在表里。
    this.stateRegistry.forget(sessionId)
    // P0：会话结束就是这一份计数的收口点（「每会话一份 JSONL」，见 metrics.ts）。
    await this.metrics.flush(sessionId, session.refs.currentEpoch)
    // 先摘采集器的订阅，再关连接：连接关闭会清掉全部监听，但显式退订让所有权更清楚。
    session.consoleCollector.dispose()
    session.networkCollector.dispose()
    session.dirty.dispose()
    session.connection.close()
    // 标签页可能已经被用户手动关掉了，那正是我们想要的结果，不算失败。
  }

  /**
   * P1：标签页管理。**只管本 provider 自己开的受控标签页** —— 用户自己的标签页
   * 一概不出现在清单里，更不会被关掉（这是 P0 就定下的所有权边界）。
   */
  async tabs(request: BrowserTabsRequest, signal?: AbortSignal): Promise<BrowserTabsResult> {
    if (request.kind === 'list') {
      return { action: 'list', tabs: await this.listTabs(signal) }
    }
    if (request.kind === 'activate') {
      const session = this.require(request.sessionId)
      this.assertWritable(session)
      const activate = this.transport.activateTarget
      if (activate === undefined) {
        throw new BrowserError(
          'this browser provider cannot bring tabs to the foreground; activation needs a provider that controls a real window',
          'BROWSER_NOT_IMPLEMENTED',
        )
      }
      await activate.call(this.transport, session.targetId, signal)
      return { action: 'activate', sessionId: session.targetId, tabs: await this.listTabs(signal) }
    }
    // close：与 close() 同一语义（幂等），只是把剩余清单一并带回去。
    if (this.sessions.has(request.sessionId)) await this.close(request.sessionId)
    return { action: 'close', sessionId: request.sessionId, tabs: await this.listTabs(signal) }
  }

  /**
   * P1：按 ref 定位的页面操作。
   *
   * **写前检查纪元**是这里的铁律：每个分支的第一步都是 `refs.resolve(ref)`
   * （经 `resolveObjectId`），旧 ref 在任何页面命令发出之前就失败 ——
   * 不存在「先点了一下才发现 ref 错了」的中间态。
   *
   * 本方法只做「动作前后各包一层」：前取会话台账快照、后补新标签页差集（见
   * {@link collectOpenedTabs}）；动作本体在 {@link dispatchMutation}。
   */
  async mutate(request: BrowserMutationRequest, signal?: AbortSignal): Promise<BrowserMutationResult> {
    const session = this.require(request.sessionId)
    this.assertWritable(session)
    this.metrics.noteRefCall(session.targetId)
    // **操作前**先记下已有会话；收尾时取差集就是「本次操作顺带开出来的标签页」。
    // 快照点必须在动作之前：页面可能在动作里就 adopt 出新会话（虽然实测要 150ms 级）。
    const beforeIds = new Set(this.sessions.keys())
    const watchUntil = Date.now() + TAB_OPEN_WATCH_MS
    // click / press 可能引发导航（就是 `dispatchMutation` 下那两个 `awaitNavigation: true` 的分支）。
    // 在**派发之前**记一笔赊账，让那一刻的 `Page.frameNavigated` / `navigatedWithinDocument`
    // 到达时不进脏累加器 —— 那一次换文档是本次动作自己造成的，回执里的 `navigated: true`
    // 已经报过，重复报会让模型以为「有人在旁边动过页面」（§6.3 要求与 `detectNavigation` 去重）。
    if (request.kind === 'click' || request.kind === 'press') session.dirty.expectSelfNavigation()
    const result = await this.dispatchMutation(session, request, signal)
    // fill / scroll 不监视弹窗：输入与滚动不触发 window.open，等在这里纯属白付
    // TAB_OPEN_WATCH_MS（250ms）—— 每次操作都付。真有怪页面在 input/scroll 里开窗，
    // 通报链路（electron 侧 adoptSession）照常收编，代价只是这次结果不带 opened_tabs。
    // click / press / wait 保留监视：它们才可能真的开窗（或与开窗的定时器赛跑）。
    if (request.kind === 'fill' || request.kind === 'scroll') return result
    const openedTabs = await this.collectOpenedTabs(beforeIds, watchUntil, signal)
    return openedTabs.length === 0 ? result : { ...result, openedTabs }
  }

  /** 按请求类型分发到具体动作；`mutate` 只负责「前后各包一层」（见上）。 */
  private async dispatchMutation(
    session: SessionState,
    request: BrowserMutationRequest,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    switch (request.kind) {
      case 'click':
        return this.click(session, request.ref, signal)
      case 'fill':
        return this.fill(session, request.ref, request.value, signal)
      case 'press':
        return this.press(session, request.ref, request.key, signal)
      case 'scroll':
        return this.scroll(session, request.ref, request.deltaX, request.deltaY, signal)
      case 'wait':
        return this.waiting.wait(session, request, signal)
    }
  }

  /**
   * 取「本次操作新接管的标签页」：动作前会话 id 的集合与此刻台账的差集。
   *
   * ⚠ 只对 electron provider 生效：差集依赖「宿主弹窗 → `{type:'opened'}` 通报 →
   * provider `adoptSession`」这条链路，而 cdp provider 没有通报源（会话只在 `open()`
   * 里登记），页面自己 `window.open` 的弹窗对差集不可见 —— `opened_tabs` 在 cdp
   * provider 下恒为空，这是**静默的能力缺口**而非 bug。要补上需要 watch `/json/list`
   * 的目标差集，目前没做。
   *
   * 通报延迟（中位 152ms）在两条路径上的待遇不同，所以才需要 `watchUntil` 这个截止点：
   *
   * - **不导航的弹窗点击**（报告里的真实场景）：click 自己的导航轮询要跑满
   *   `MUTATION_NAVIGATION_POLL_MS`（首检不是导航后就一直轮询），800ms 天然盖住 152ms，
   *   回到这里时差集已经就绪，**一次读取即返回，零额外等待**。
   * - **导航且弹窗**（页面脚本里 `location.href = ...` 与 `window.open` 并发）：导航首检即命中，
   *   `detectNavigation` 立刻返回，800ms 窗口提前结束，150ms 后才到的通报就会被漏掉。
   *   这时按截止点补等一小段 —— 只在**已经过了截止点**才补，所以慢路径不付代价（`Date.now()
   *   >= watchUntil` 直接返回）。
   *
   * `wait` 也可能命中：等待期间页面自己弹窗，差集照样算得出来。
   */
  private async collectOpenedTabs(
    beforeIds: ReadonlySet<string>,
    watchUntil: number,
    signal?: AbortSignal,
  ): Promise<readonly BrowserTabInfo[]> {
    // 前台判定与 listTabs 同一信号：transport 能回答就给新标签补 active，
    // 让 `opened_tabs` 能标出 [foreground]（判不了时省略，与 tabs 清单同口径）。
    const withActive = async (opened: readonly BrowserTabInfo[]): Promise<readonly BrowserTabInfo[]> => {
      if (opened.length === 0) return opened
      const activeId = this.transport.activeTargetId === undefined
        ? undefined
        : await this.transport.activeTargetId().catch(() => undefined)
      return opened.map((tab) =>
        activeId !== undefined && activeId === tab.sessionId ? { ...tab, active: true } : tab,
      )
    }
    let opened: readonly BrowserTabInfo[] = []
    await pollUntil(
      async () => {
        opened = [...this.sessions.values()].filter((session) => !beforeIds.has(session.targetId))
          .map((session) => ({ sessionId: session.targetId, url: session.url, title: session.title }))
        // 不等 `url` 非空：`adoptSession` 是「先登记、后等加载」，通报值本身就是这个弹窗的
        // 真实地址（页面加载完还会刷一次），先给模型一个能用的 session_id 比等标题更重要。
        return opened.length > 0
      },
      { timeoutMs: Math.max(0, watchUntil - Date.now()), intervalMs: TAB_OPEN_WATCH_POLL_MS, signal },
    )
    return await withActive(opened)
  }

  /**
   * P2：读取 console 缓冲。
   *
   * **每次 read 前先补发 `Runtime.enable` + `Log.enable` 再读缓冲**：host 侧 re-attach 之后
   * 不保证 enable 状态还在，而 provider 看不到 re-attach 的确切时刻；enable 触发的全量重放
   * 正好被采集器的高水位吃掉（见 `console.ts` 文件头）。命令失败（例如 detach 期间抛
   * `No target available` → `BROWSER_DEBUGGER_DETACHED`）原样上抛，模型据此重新采集。
   */
  async console(request: BrowserConsoleRequest, signal?: AbortSignal): Promise<BrowserConsoleResult> {
    const session = this.require(request.sessionId)
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    await session.consoleCollector.refresh(options)
    const limit = normalizeLimit(request.limit)
    const result = session.consoleCollector.read({
      limit,
      level: request.level,
      text: request.text,
      allDocuments: request.allDocuments === true,
    })
    return {
      kind: 'console',
      sessionId: session.targetId,
      entries: result.entries,
      buffered: result.buffered,
      truncated: result.truncated,
      replayTruncated: session.consoleCollector.truncatedReplay,
      document: result.document,
      earlierDocuments: result.earlierDocuments,
      truncatedByBudget: result.truncatedByBudget,
    }
  }

  /**
   * P2：网络采集读取。
   *
   * `list` 直接从采集器读表（`requestId` 是事件里原样的值，`[V18]`，不做映射）；
   * `body` 直接用给定的 `requestId` 调 `Network.getResponseBody`（裁剪超大响应体）。
   * 读取前补发 `Network.enable` 以覆盖 re-attach 后 enable 状态丢失的情况 —— 注意
   * `Network` **不重放历史**（`[V38]`），补发只保证此后的请求不再丢，过渡窗口内的请求
   * 可能缺失，这一点在工具描述与结果里都要说清。
   */
  async network(request: BrowserNetworkRequest, signal?: AbortSignal): Promise<BrowserNetworkResult> {
    const session = this.require(request.sessionId)
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    await session.networkCollector.refresh(options)
    if (request.kind === 'body') {
      const body = await session.networkCollector.body(request.requestId, options)
      return {
        kind: 'network',
        sessionId: session.targetId,
        action: 'body',
        requests: [],
        requestId: request.requestId,
        body: body.body,
        base64Encoded: body.base64Encoded,
        truncated: body.truncated,
      }
    }
    const listed = session.networkCollector.list(
      normalizeLimit(request.limit),
      request.url,
      request.allDocuments === true,
    )
    return {
      kind: 'network',
      sessionId: session.targetId,
      action: 'list',
      requests: listed.requests,
      document: listed.document,
      earlierDocuments: listed.earlierDocuments,
      truncated: listed.truncated,
      truncatedByBudget: listed.truncatedByBudget,
    }
  }

  /**
   * P2：白名单制的逃生舱（方案 3.3）。
   *
   * 顺序是**先过白名单再发命令**（默认拒，`assertExecuteAllowed`）；`Runtime.evaluate` 强制
   * `returnByValue: true` 并按三态处理返回值；导航类命令（`Page.navigate` / `Page.reload`）
   * 走既有的导航检测 / 纪元推进路径，`Page.reload` 即使地址不变也**无条件**作废旧 ref。
   *
   * ⚠ `expression` 会被**页面直接执行** —— 这是全插件最高危的入口，工具描述里已写明只执行
   * 可信代码；页面内容永远是数据不是代码。
   */
  async execute(request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> {
    const session = this.require(request.sessionId)
    this.assertWritable(session)
    assertExecuteAllowed(request.method)
    const beforeUrl = session.url
    // 逃生舱跑的是页面真代码，`Page.navigate` / `location.href=` / `form.submit()` 都能换文档。
    // 派发前记一笔赊账，让那一刻的文档变化事件算在**本次动作**头上（回执里 navigated 已报过），
    // 不进脏累加器 —— 否则模型会以为旁边有人在动页面（§6.3 的去重要求）。
    session.dirty.expectSelfNavigation()
    const params: Record<string, unknown> = { ...request.params }
    if (request.method === 'Runtime.evaluate') {
      // 强制按值返回（`[V22]`）：返回引用的话拿到的 objectId 会随会话泄漏。
      params['returnByValue'] = true
      // 强制 await Promise（2026-09-14 修）：不 await 时 `fetch(...).then(r => r.status)` 这种
      // 表达式只会回一个没有 value 的 Promise 对象，被当成「不可序列化」拒掉 —— 可它其实
      // **已经跑完并产生了副作用**（报告 S5：network 里那条 GET 明明已经 200）。等它落定，
      // 返回兑现值才是调用方要的东西。
      params['awaitPromise'] = true
      // 强制带 user gesture（2026-09-18 修）：不带的话，需要 transient activation 的 API
      // 一律被页面拒 —— `navigator.clipboard.writeText`、`requestFullscreen`、`window.open`、
      // 媒体自动播放都报 `NotAllowedError: Transient user activation is required`，模型看到的
      // 就是「JS 执行不了」。这个逃生舱的契约本来就是「在页面里跑真代码」，而 click 本身也会
      // 授予激活，两者保持一致。
      params['userGesture'] = true
    }
    let raw: unknown
    try {
      raw = await session.connection.send(request.method, params, {
        signal,
        // B5-d：逃生舱允许调用方把**这一条命令**的等待压短。取 `min` 而不是直接用 ——
        // 传一个比 `commandTimeoutMs` 更大的值不该放大内层超时（那只会让「挂住」更贵），
        // 而配置里把 `commandTimeoutMs` 调小时也只有 `min` 才尊重配置。
        timeoutMs: request.timeoutMs === undefined
          ? this.config.commandTimeoutMs
          : Math.min(request.timeoutMs, this.config.commandTimeoutMs),
      })
    } catch (error: unknown) {
      // 把「循环引用 / Symbol」这两条序列化错误映射成 BROWSER_EXECUTE_RESULT_UNSERIALIZABLE。
      throw translateEvaluateError(error)
    }
    if (NAVIGATION_COMMANDS.has(request.method)) {
      // 显式导航：地址变了 detectNavigation 会作废；地址没变（reload）这里再作废一次。
      const changed = await this.navigation.detectNavigation(session, beforeUrl, true, signal)
      if (!changed) {
        session.refs.invalidate()
        // reload 的地址不变但文档确实换了，采集器的文档序号必须跟着走（否则旧日志会混进来）。
        noteDocumentChange(session)
      }
      const capped = capResult(raw)
      return {
        kind: 'execute',
        sessionId: session.targetId,
        method: request.method,
        epoch: session.refs.currentEpoch,
        url: session.url,
        title: session.title,
        navigated: true,
        ...this.dirtyField(session),
        result: capped.payload,
        truncated: capped.truncated,
      }
    }
    if (request.method === 'Runtime.evaluate') {
      // 表达式抛错 / 被 await 的 Promise reject：`exceptionDetails` 里才有真话，
      // 直接说「表达式抛了」比「返回值不可序列化」有用得多（后者会把调用方引向改写法）。
      const exception = extractEvaluateException(raw)
      if (exception !== undefined) {
        throw new BrowserError(
          `the evaluated expression threw in the page: ${exception}. The expression has already run, `
          + 'so any side effect it had is NOT rolled back.',
          'BROWSER_PROTOCOL_ERROR',
        )
      }
      const value = extractEvaluateValue(raw)
      const capped = capResult(value)
      // 表达式能改地址（`location.href = '/x'` 这类同步改址，evaluate 返回时地址已变）。
      // 以前这里恒报 `navigated:false`，于是工具回执一边说「refs 仍有效」、一边页面已经换了，
      // 模型下一次 click / find 撞 BROWSER_STALE_REF 却毫无预兆。
      // `awaitNavigation=false`：没导航时只读一次地址，不跑轮询窗口（evaluate 是逃生舱，
      // 不能为「可能导航」给每次调用都加等待）；真导航了再补一次 settle，让新文档落地。
      // **覆盖不到异步导航**：`form.submit()` 或「点了某个按钮」在 evaluate 返回时往往还没换页，
      // 这种仍会报 false。要覆盖就得给每次 evaluate 加一个轮询窗口，代价是每次调用都变慢 ——
      // 逃生舱不值当。模型侧的兜底不变：navigated=false 时用 ref 失败仍会拿到 BROWSER_STALE_REF。
      const navigated = await this.navigation.detectNavigation(session, beforeUrl, false, signal)
      if (navigated) await this.navigation.settleDocument(session, signal)
      return {
        kind: 'execute',
        sessionId: session.targetId,
        method: request.method,
        epoch: session.refs.currentEpoch,
        url: session.url,
        title: session.title,
        navigated,
        ...this.dirtyField(session),
        value: capped.payload,
        truncated: capped.truncated,
      }
    }
    const capped = capResult(raw)
    return {
      kind: 'execute',
      sessionId: session.targetId,
      method: request.method,
      epoch: session.refs.currentEpoch,
      url: session.url,
      title: session.title,
      navigated: false,
      ...this.dirtyField(session),
      result: capped.payload,
      truncated: capped.truncated,
    }
  }

  /** @inheritdoc */
  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    // P0：`close()` 之外还有这条路会结束会话（卸载），计数同样要收口。
    await Promise.all(sessions.map(session =>
      this.metrics.flush(session.targetId, session.refs.currentEpoch)))
    this.sessions.clear()
    const results = await Promise.allSettled(sessions.map(async (session) => {
      session.consoleCollector.dispose()
      session.networkCollector.dispose()
      session.dirty.dispose()
      session.connection.close()
      await this.transport.closeTarget(session.targetId)
    }))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) {
      throw new BrowserError(
        `${failures.length} browser session(s) failed to close cleanly`,
        'BROWSER_DISPOSE_FAILED',
        { cause: (failures[0] as PromiseRejectedResult).reason },
      )
    }
  }

  /** 当前存活会话数（测试与诊断用）。 */
  get sessionCount(): number {
    return this.sessions.size
  }

  /**
   * 设置某个会话的人工接管状态位（P3，方案 4.1.1）。
   *
   * 由 `browser-electron` 的 takeover 通道驱动；直连外部 Chrome 的 provider 没有这条通道，
   * 状态位恒为 `false`。**是幂等状态位，不是计数器** —— agent 自己 toggle DevTools 时同样
   * 会收到通知，不需要去重。会话不存在时静默忽略（通知可能晚于会话关闭）。
   *
   * @param sessionId - 会话 id（即 target id）。
   * @param active - 人工是否正在操作（DevTools 开 / 关）。
   */
  protected setTakeover(sessionId: string, active: boolean): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.takeover = active
    // 目标级状态的粗粒度让渡（方案 2.3.1 来源①）：人在 DevTools 里操作期间，这个会话的
    // target 级状态整体算 human 所有。与下一条按钮的账**分开记**（reason 不同），各自撤销、
    // 互不覆盖 —— 为什么不能合成一个布尔，见 `state.ts` 里 `takeovers` 的注释。
    this.stateRegistry.markTakeover(sessionId, active, 'devtools')
    // P2 ③：这条通道**存在**的第一次真实信号 —— 顺手把「上一次快照之后有过一次接管窗口」
    // 记进脏累加器。只在 `active` 方向记：关掉 DevTools 不是模型需要知道的事。
    if (active) session.dirty.noteTakeoverWindow()
  }

  /**
   * 设置某个会话的**控制权**归属（§6.5）。
   *
   * 由 `browser-electron` 的 control 通道驱动（人在标签条上按了「接管」/「交还」）；
   * 直连外部 Chrome 的 provider 没有这条通道，`holder` 恒为 `'agent'`。
   *
   * 两个方向做的事**故意不对称**：
   * - → `'human'`：立刻作废该会话的 ref 纪元（J5 —— agent 手上的号全部失效），并把
   *   接管窗口记进簿记（reason `'human'`，与 DevTools 那条互不干扰）；
   * - → `'agent'`：只解除封锁，**不恢复任何 ref**（J6 —— agent 恢复可写，但必须重拍快照
   *   才拿得到号）。「接管期间不碰别的会话」「交还不复活旧号」是这套语义的核心。
   *
   * 幂等：同值重复设置直接返回。宿主侧已经判过一次等，这里再判是因为通道可能重放
   * （`invalidate()` 会推进纪元，重复调用会让 ref 表平白再翻一代）。
   * 会话不存在时静默忽略（通知可能晚于会话关闭）。
   *
   * @param sessionId - 会话 id（即 target id）。
   * @param holder - 切换到的持有者。
   */
  protected setHolder(sessionId: string, holder: BrowserHolder): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.holder === holder) return
    session.holder = holder
    if (holder === 'human') {
      session.refs.invalidate()
      this.stateRegistry.markTakeover(sessionId, true, 'human')
      // P2 ③：人按了「接管」—— 「上一次快照之后有人动过」里**最实**的一条信号
      // （比 DevTools 启发式可靠：这是人按出来的声明）。交还（→ 'agent'）不记。
      session.dirty.noteTakeoverWindow()
      return
    }
    this.stateRegistry.markTakeover(sessionId, false, 'human')
  }

  /**
   * 写操作的闸门（§6.5）：会话在人工手里时，一切「动页面」的操作直接拒。
   *
   * 与写前门同一条纪律 —— 检查排在 `require()` 之后、**任何 CDP 命令之前**，
   * 不允许出现「先点了一下才发现不该点」的中间态。
   *
   * 读型操作（snapshot / screenshot / find / read）**不**走这里：人工持有期间照常放行
   * （方案 §6.5 —— 让渡指 agent 停手 + 重新观察，不是断开连接）。
   *
   * 消息必须自带恢复路径：模型拿到 `BROWSER_HUMAN_HOLDING` 时唯一能做的是**等人**，
   * 所以要写清「谁在操作、你被挡在哪、要等到什么」，而不是一句「被拒绝」。
   *
   * @param session - 已经 `require()` 出来的会话。
   * @throws `BROWSER_HUMAN_HOLDING`：该会话当前由人工持有。
   */
  private assertWritable(session: SessionState): void {
    if (session.holder !== 'human') return
    throw new BrowserError(
      `session "${session.targetId}" is under human control right now: a person pressed the `
      + '"take over" button on the dsh tab bar and is operating this page themselves. '
      + 'This is NOT retryable — resending the same command changes nothing while the page is theirs. '
      + 'Wait for them to press "hand back", then take a fresh webpage_snapshot before acting again: '
      + 'the takeover invalidated the ref epoch, so no ref you held before it is valid again.',
      'BROWSER_HUMAN_HOLDING',
    )
  }

  /** 后台刷新一次端点探测结果。 */
  private refreshProbe(): Promise<boolean> {
    if (this.probing !== undefined) return this.probing
    const attempt = this.transport.version(AbortSignal.timeout(this.config.requestTimeoutMs))
      .then(() => true)
      .catch(() => false)
      .then((ok) => {
        this.probe = { at: Date.now(), ok }
        this.probing = undefined
        return ok
      })
    this.probing = attempt
    return attempt
  }

  /** 取一个会话，不存在就是模型用错了 id。 */
  private require(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      throw new BrowserError(
        `unknown browser session "${sessionId}"; open one with webpage_open and reuse the session id it returns`,
        'BROWSER_TARGET_NOT_FOUND',
      )
    }
    return session
  }

  /** 会话的可回显形态。 */
  private toSession(session: SessionState): BrowserSession {
    return {
      id: session.targetId,
      url: session.url,
      title: session.title,
      epoch: session.refs.currentEpoch,
    }
  }

  /**
   * P2 回执字段：**脏时才出现**（§6.2 的硬约束，见 `dirty.ts` 的 `report()`）。
   *
   * 单独抽一个是为了让「一条回执要不要带它」在每一处都是同一句话 —— 顺带兑现 J3：
   * 干净时它连一个字段都不占，回执体积不变（实测基数中位 5516 字符）。
   */
  private dirtyField(session: SessionState): { pageChanged?: BrowserPageChanged } {
    const changed = session.dirty.report()
    return changed === undefined ? {} : { pageChanged: changed }
  }

  /**
   * 点击：解析 ref → 滚到可视区 → **问一句落点上是谁** → 在元素中心派发真实的鼠标按下/抬起。
   *
   * 落点校验（B1-d）见 {@link hitTest}。命中测试证实落点被别的元素盖住时（`hit === 'other'`）
   * **在派发前拒绝**（2026-10-07 独立验收，`BROWSER_TARGET_OCCLUDED`）：旧实现「事件照发、
   * 回执如实写 occluded_by」会把鼠标事件实际打到遮罩上 —— 真实对话复验里连续三次被盖点击
   * 全部 DISPATCHED，页面可能被误触，这不是零副作用。命中测试**查不出来**（跨源 / CSP 拦下
   * evaluate）时不拒绝：无证据不误拒，宁可放过一次遮挡，也不许把 click 打成失败。
   */
  private async click(session: SessionState, ref: string, signal?: AbortSignal): Promise<BrowserMutationResult> {
    const beforeUrl = session.url
    const target = session.refs.resolve(ref)
    this.assertInteractive(target, 'webpage_click')
    const objectId = await this.nodes.resolveObjectId(session, ref, signal)
    let hit: HitTestOutcome | undefined
    try {
      // 后台页面的 smooth 滚动可能暂停；先准备可见标签，再滚动和量落点。
      // 否则激活后布局已经改变，却仍把之前的视口外坐标用于真实输入。
      await this.ensureInputDispatchable(session, signal)
      const box = await this.nodes.elementViewportBox(session, objectId, signal)
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      if ((box.viewportWidth !== undefined && (point.x < 0 || point.x >= box.viewportWidth))
        || (box.viewportHeight !== undefined && (point.y < 0 || point.y >= box.viewportHeight))) {
        throw new BrowserError(
          'the target centre is still outside the viewport after scrolling; no mouse event was dispatched. '
            + 'Use webpage_locate to verify its position or take a fresh snapshot before retrying.',
          'BROWSER_PROTOCOL_ERROR',
        )
      }
      hit = await this.nodes.hitTest(session, objectId, point, signal)
      // 命中测试证实落点被别的元素盖住 → **派发前拒绝**（2026-10-07 独立验收：零页面
      // 副作用）。旧实现「事件照发、回执如实」会把鼠标事件实际打到遮罩上 —— 真实对话
      // 复验里连续三次被盖点击全部 DISPATCHED，页面可能被误触。命中测试查不出来
      // （`undefined`）不拒绝：无证据不误拒，宁可放过一次遮挡。
      if (hit?.hit === 'other') {
        throw new BrowserError(this.occludedMessage(hit), 'BROWSER_TARGET_OCCLUDED')
      }
      // L2（2026-10-08 独立验收）：后台 reload 后的标签 `visibilityState=hidden` —— 布局、
      // elementFromPoint 全都正常，但真实鼠标事件派给一个不可见页面后**页面收不到**：
      // 回执 done、页面计数不动（submits=0）。innerWidth>0 与命中测试都判不出这个坑，
      // 所以派发前把本标签切到前台并确认页面真的可见；
      // 激活后仍不可见就在派发前拒绝，零副作用。
      this.assertWritable(session)
      // 量点后若被另一会话切到后台，拒绝而不再次激活，避免恢复滚动后复用旧坐标。
      await this.ensureInputDispatchable(session, signal, false)
      const options = { signal, timeoutMs: this.config.commandTimeoutMs }
      await session.connection.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...point, button: 'left', clickCount: 1,
      }, options)
      await session.connection.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...point, button: 'left', clickCount: 1,
      }, options)    } finally {
      this.nodes.releaseObject(session, objectId, signal)
    }
    const result = await this.navigation.settleMutation(session, 'click', beforeUrl, true, signal)
    return this.describeClick(result, target, hit)
  }

  /** 被盖点击的拒绝理由：点名遮罩、说明为什么拒绝、给可执行的恢复路径（方案 §3.1）。 */
  private occludedMessage(hit: HitTestOutcome): string {
    const node = hit.node
    const who = node === undefined || node === null
      ? 'another element'
      : [
        node.role.length > 0 ? `role=${node.role}` : '',
        node.name.length > 0 ? `name="${node.name}"` : '',
        node.hint.length > 0 ? `hint=${node.hint}` : '',
      ].filter(part => part.length > 0).join(' ') || 'another element'
    return `the click was NOT dispatched: the target's centre is covered by ${who}. The mouse event would `
      + 'have gone to that element instead of your target, and dispatching it anyway would change the '
      + 'page without clicking what you asked for. Close the overlay or act on the element on top first '
      + '(it is usually not in the ref table, so take a webpage_snapshot to find it), then re-snapshot '
      + 'and click the target again. No mouse click was dispatched by this call (a scrollIntoView before '
      + 'the occlusion check may have scrolled the page — that is the only possible side effect).'
  }

  /**
   * 锚点只授予**读**权限（项 3 补正，2026-10-08）：click / fill / press 需要可操作元素，
   * 拿只读锚点（heading 等文本定位锚）就地拒绝 —— 零副作用，也不给「点了但没点在东西上」的
   * 模糊失败。读取路径（region_ref / locate / 截图 / revalidate / wait）不受影响。
   */
  private assertInteractive(target: RefTarget, action: string): void {
    if (target.anchor !== true) return
    throw new BrowserError(
      `${action} needs an actionable element; ref=${target.ref} (${target.role} "${target.name}") is a `
        + 'read-only text anchor for locating content. Use it with webpage_snapshot(region_ref=...), '
        + 'webpage_locate or a screenshot; to interact, take a webpage_snapshot and use a '
        + 'link/button/textbox ref instead. Nothing was dispatched.',
      'BROWSER_READ_ONLY_ANCHOR',
    )
  }

  /**
   * 把「点的是谁」并进回执（被盖的点击在派发前就已被拒，这里只会见到命中目标或探测失败）。
   */
  private describeClick(
    result: BrowserMutationResult,
    target: RefTarget,
    hit: HitTestOutcome | undefined,
  ): BrowserMutationResult {
    const href = hit?.href
    const usable = typeof href === 'string' && /^https?:/i.test(href) ? href : undefined
    const identity: BrowserMutationTarget = {
      role: target.role,
      name: target.name,
      ...usable !== undefined ? { href: usable } : {},
    }
    return {
      ...result,
      target: identity,
    }
  }

  /** 填写：走原型链上的原生 value setter（React 受控组件也认），再补 input/change 事件。 */
  private async fill(
    session: SessionState,
    ref: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const beforeUrl = session.url
    this.assertInteractive(session.refs.resolve(ref), 'webpage_fill')
    const objectId = await this.nodes.resolveObjectId(session, ref, signal)
    try {
      const outcome = await session.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: FILL_FUNCTION, arguments: [{ value }], returnByValue: true },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      await this.transport.projectTyping?.(session.targetId, objectId).catch(() => undefined)
      this.assertWritable(session)
      if (outcome.result?.value === 'editable') {
        // 上一步已聚焦 + 全选，这里由浏览器原生输入管线写入（理由见 FILL_FUNCTION 注释）。
        await session.connection.send(
          'Input.insertText',
          { text: value },
          { signal, timeoutMs: this.config.commandTimeoutMs },
        )
      }
    } finally {
      this.nodes.releaseObject(session, objectId, signal)
    }
    return this.navigation.settleMutation(session, 'fill', beforeUrl, false, signal)
  }

  /** 按键：先聚焦元素，再用 `Input.dispatchKeyEvent` 派发 keyDown/keyUp。 */
  private async press(
    session: SessionState,
    ref: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const beforeUrl = session.url
    const keyInfo = describeKey(key)
    this.assertInteractive(session.refs.resolve(ref), 'webpage_press')
    const objectId = await this.nodes.resolveObjectId(session, ref, signal)
    try {
      await session.connection.send(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: 'function () { this.focus(); }', returnByValue: true },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      await this.transport.projectTyping?.(session.targetId, objectId).catch(() => undefined)
      this.assertWritable(session)
      // L2（2026-10-08）：press 与 click 同一条真实输入路径 —— 后台 reload 后的键盘事件
      // 同样落不进不可见页面（MDN 第二轮六次 press/click 回执成功都不导航）。同样先准备。
      await this.ensureInputDispatchable(session, signal)
      const options = { signal, timeoutMs: this.config.commandTimeoutMs }
      await session.connection.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: keyInfo.key,
        code: keyInfo.code,
        windowsVirtualKeyCode: keyInfo.virtualKeyCode,
        nativeVirtualKeyCode: keyInfo.virtualKeyCode,
        ...keyInfo.text !== undefined ? { text: keyInfo.text } : {},
      }, options)
      await session.connection.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: keyInfo.key,
        code: keyInfo.code,
        windowsVirtualKeyCode: keyInfo.virtualKeyCode,
        nativeVirtualKeyCode: keyInfo.virtualKeyCode,
      }, options)
    } finally {
      this.nodes.releaseObject(session, objectId, signal)
    }
    return this.navigation.settleMutation(session, 'press', beforeUrl, true, signal)
  }

  /**
   * 滚动：在元素中心派发真实的滚轮事件（滚的是元素所在的可滚动容器）。
   *
   * `ref` 省略时落在**视口中心**（等价于整页滚动）—— 报告 S3/S5 的能力边界就在这：
   * 长文页与「只有标题、零可操作元素」的页面上根本没有 ref 可给，要求必须带 ref 等于
   * 让 scroll 在那些页面上不可用。不带 ref 的路径不查 ref 纪元（没有任何 ref 参与）。
   */
  private async scroll(
    session: SessionState,
    ref: string | undefined,
    deltaX: number | undefined,
    deltaY: number | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const dx = typeof deltaX === 'number' && Number.isFinite(deltaX) ? deltaX : 0
    const dy = typeof deltaY === 'number' && Number.isFinite(deltaY) ? deltaY : 0
    if (dx === 0 && dy === 0) {
      throw new BrowserError('webpage_scroll needs a non-zero deltaX or deltaY', 'BROWSER_PROTOCOL_ERROR')
    }
    // 后台标签收不到滚轮（真实鼠标事件只送前台），先切前台；切不动就**明确拒绝**，
    // 绝不让它干等到超时 —— 那条路径以前表现为「工具超时 30s」（J6）。
    await this.ensureForeground(session, signal)
    const beforeUrl = session.url
    const point = ref === undefined
      ? await this.nodes.viewportCenter(session, signal)
      : await (async (): Promise<{ x: number; y: number }> => {
        const objectId = await this.nodes.resolveObjectId(session, ref, signal)
        try {
          const box = await this.nodes.elementViewportBox(session, objectId, signal)
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        } finally {
          this.nodes.releaseObject(session, objectId, signal)
        }
      })()
    const acked = await this.dispatchWheel(session, point, dx, dy, signal)
    const result = await this.navigation.settleMutation(session, 'scroll', beforeUrl, false, signal)
    return acked ? result : { ...result, unconfirmed: true }
  }

  /**
   * 后台标签：能切就切前台，切不动就**明确拒绝**（B1-e）。
   *
   * 滚轮事件只送给前台标签，后台标签上它既不会滚、也不报错 —— 沉默地等到超时是这个场景里
   * 最坏的结局。transport 答不出「谁在前台」时（外部 Chrome）不折腾：那是能力缺口，不是错误。
   */
  private async ensureForeground(session: SessionState, signal?: AbortSignal): Promise<void> {
    const activeTargetId = this.transport.activeTargetId
    if (activeTargetId === undefined) return
    const activeId = await activeTargetId.call(this.transport).catch(() => undefined)
    if (activeId === undefined || activeId === session.targetId) return
    const activate = this.transport.activateTarget
    if (activate === undefined) {
      throw new BrowserError(
        `session_id=${session.targetId} is in the background; `
        + 'run webpage_tabs(action=activate, session_id=...) first, then scroll again',
        'BROWSER_NOT_IMPLEMENTED',
      )
    }
    await activate.call(this.transport, session.targetId, signal)
  }

  /** 读页面级可见性（L2）；读不到（evaluate 失败）返回 `undefined`，不做无证据的拒绝。 */
  private async readVisibilityState(session: SessionState, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const evaluated = await session.connection.send<EvaluateResult>(
        'Runtime.evaluate',
        { expression: 'document.visibilityState', returnByValue: true },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      return typeof evaluated.result?.value === 'string' ? evaluated.result.value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 真实输入（click / press）的可见性准备（L2，2026-10-08）。
   *
   * 判据**只认页面级** `document.visibilityState`，不认 transport 的「前台标签」书签：
   * 未经重载的后台标签输入本就落地（第 1 项 A/B 后台通过，不该被打扰）；弹窗书签也可能
   * 与现实不符；而后台 reload 之后布局、命中测试、JS 全都正常，`visibilityState` 却是
   * `hidden` —— 真实鼠标/键盘事件被 Chromium 丢进一个不可见页面后页面收不到（证据
   * session-409fd63d：click/press 均 done，`window.ev.submits=0`，服务端无 /event；
   * `webpage_tabs(action=activate)` 之后再点才生效）。hidden 时激活本标签、短窗重读，
   * 仍不可见就在派发前拒绝 —— 零副作用，也不给「done 但没效果」的假回执。
   *
   * 边界：不能抢人工持有的标签（hold 门在更早的写入前检查里已拒）；不跨模型调用锁前台
   * （这里只为本一次派发准备，之后的可见性由下一次动作自己重新确认）。
   */
  private async ensureInputDispatchable(session: SessionState, signal?: AbortSignal, allowActivation = true): Promise<void> {
    const state = await this.readVisibilityState(session, signal)
    if (state === undefined || state === 'visible') return
    if (!allowActivation) {
      throw new BrowserError(
        `session_id=${session.targetId} became visibilityState=${state} after the click position was measured. `
          + 'No mouse event was dispatched; activate the tab and retry once so scrolling and hit testing '
          + 'start from the current visible layout.',
        'BROWSER_TAB_NOT_VISIBLE',
      )
    }
    const activate = this.transport.activateTarget
    if (activate === undefined) {
      throw new BrowserError(
        `session_id=${session.targetId} is not visible (visibilityState=${state}); real input only lands on a `
          + `visible tab — run webpage_tabs(action=activate, session_id=${session.targetId}) first, then retry`,
        'BROWSER_TAB_NOT_VISIBLE',
      )
    }
    // 激活拒绝（包括准备期间人工接管）必须原码上抛，不能吞掉后误报不可见。
    await activate.call(this.transport, session.targetId, signal)
    let last = state
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const probe = await this.readVisibilityState(session, signal)
      if (probe === 'visible') return
      if (probe !== undefined) last = probe
      await delay(40, signal)
    }
    throw new BrowserError(
      `session_id=${session.targetId} stayed visibilityState=${last} after activation — the browser window is `
        + 'probably minimized or not shown. No input event was dispatched; show the window, activate the tab, '
        + 'then retry.',
      'BROWSER_TAB_NOT_VISIBLE',
    )
  }

  /**
   * 派发一次滚轮，并告诉调用方**有没有拿到回包**（B1-e）。
   *
   * 超时（{@link WHEEL_ACK_TIMEOUT_MS}）与真错误分得很清：
   *
   * - 超时 = 事件已投递、页面没回话 —— 返回 `false`，回执标 `unconfirmed`，动作不算失败。
   * - detach / 连接丢失等真错误照原样抛 —— 它们有各自的恢复路径，不能被这条兜底吞掉。
   */
  private async dispatchWheel(
    session: SessionState,
    point: { x: number; y: number },
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(resolve, WHEEL_ACK_TIMEOUT_MS, 'timeout')
    })
    // 不给 `timeoutMs`：这条命令的 pending 由下面那把定时器接管，
    // 再叠一个 30s 的协议超时只会让「已投递未确认」变成「工具超时」。
    const sent = session.connection.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX,
      deltaY,
    }, { signal }).then((): 'acked' => 'acked').catch((error: unknown) => ({ failed: error }))
    try {
      const outcome = await Promise.race([sent, timeout])
      if (outcome === 'acked') return true
      if (outcome === 'timeout') return false
      throw outcome.failed
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 标签页清单：只含受控会话；transport 能回答「谁在前台」时补上 active。 */
  private async listTabs(signal?: AbortSignal): Promise<readonly BrowserTabInfo[]> {
    const activeId = this.transport.activeTargetId === undefined
      ? undefined
      : await this.transport.activeTargetId().catch(() => undefined)
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.targetId,
      url: session.url,
      title: session.title,
      ...(activeId !== undefined && activeId === session.targetId ? { active: true } : {}),
    }))
  }

  /** 按 ref 定位；会话查询仍由入口负责。 */
  async locate(request: BrowserLocateRequest, signal?: AbortSignal): Promise<BrowserLocateResult> {
    return this.nodes.locate(this.require(request.sessionId), request, signal)
  }

}
