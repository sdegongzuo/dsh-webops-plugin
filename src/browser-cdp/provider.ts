/**
 * browser-cdp —— 用 Chrome DevTools Protocol 驱动浏览器的 provider。
 *
 * P0 形态：连接**用户自己开着的** Chrome（`--remote-debugging-port=<port>`），
 * 不自己下载 Chromium，也不依赖 Playwright —— 既拿到用户真实登录态，又绕开
 * 浏览器下载与构建脚本授权（pnpm 的 allowBuilds 是默认拒绝的白名单制）。
 *
 * ```text
 *   模型 → webpage_* 工具 → ctx.browser → CdpBrowserProvider
 *                                            ├── HttpCdpTransport  /json/{version,list,new,close}
 *                                            └── CdpConnection（WebSocket 上的 { id, method, params }）
 * ```
 *
 * 一个会话 = 一个标签页 + 一条 WebSocket + 一个 {@link RefRegistry}。
 * 标签页由本 provider 创建，因此也由它负责关闭；用户自己的标签页一概不碰。
 *
 * @module dsh-webops-plugin/browser-cdp
 */

import { BrowserError } from '../browser/types.ts'
import type {
  BrowserConsoleRequest,
  BrowserConsoleResult,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserLocateRequest,
  BrowserLocateResult,
  BrowserMutationRequest,
  BrowserMutationResult,
  BrowserNavigateRequest,
  BrowserNetworkRequest,
  BrowserNetworkResult,
  BrowserObservation,
  BrowserObserveRequest,
  BrowserOpenRequest,
  BrowserProvider,
  BrowserSession,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTabInfo,
  BrowserTabsRequest,
  BrowserTabsResult,
} from '../browser/types.ts'
import { RefRegistry } from './refs.ts'
import type { RefTarget } from './refs.ts'
import { buildOutline, DEFAULT_SNAPSHOT_LIMITS, renderOutline, resolveSnapshotLimits } from './snapshot.ts'
import type { AxNode, SnapshotLimits } from './snapshot.ts'
import { HttpCdpTransport } from './protocol.ts'
import type { CdpConnection, CdpTarget, CdpTransport } from './protocol.ts'
import { ConsoleCollector, CONSOLE_RING_CAPACITY } from './console.ts'
import { NetworkCollector, NETWORK_TABLE_CAPACITY } from './network.ts'
import { assertExecuteAllowed, extractEvaluateException, extractEvaluateValue, translateEvaluateError } from './execute.ts'
import { validateEndpoint, validateTargetUrl } from './url-policy.ts'

/** provider 的 id，也是 `ctx.browser` 配置里 `provider` 字段要填的值。 */
export const CDP_PROVIDER_ID = 'cdp'

/** 本机 Chrome 的默认调试端点。 */
export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222'

/** P0 支持的浏览器操作；能力缝隙的 `observe` 只认这些。 */
export interface CdpProviderConfig {
  /** 调试端点，只允许回环地址。 */
  readonly endpoint?: string
  /** 单条 CDP 命令超时（毫秒）。 */
  readonly commandTimeoutMs?: number
  /** 一次 HTTP 探测/发现的超时（毫秒）。 */
  readonly requestTimeoutMs?: number
  /** 等页面加载完成的上限（毫秒）。 */
  readonly navigationTimeoutMs?: number
  /** `available()` 缓存探测结果的有效期（毫秒）。 */
  readonly probeTtlMs?: number
  /** 大纲规模上限。 */
  readonly snapshotLimits?: SnapshotLimits
  /** `wait` 类操作里 text / hidden 条件的默认超时（毫秒）。 */
  readonly waitTimeoutMs?: number
}

/** 配置补齐默认值之后的样子。 */
interface ResolvedConfig {
  readonly endpoint: string
  readonly commandTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly navigationTimeoutMs: number
  readonly probeTtlMs: number
  readonly snapshotLimits: SnapshotLimits
  readonly waitTimeoutMs: number
}

const DEFAULT_CONFIG: ResolvedConfig = {
  endpoint: DEFAULT_CDP_ENDPOINT,
  commandTimeoutMs: 30_000,
  requestTimeoutMs: 5_000,
  navigationTimeoutMs: 15_000,
  probeTtlMs: 1_000,
  snapshotLimits: DEFAULT_SNAPSHOT_LIMITS,
  waitTimeoutMs: 10_000,
}

/** `wait` 的纯等待上限（毫秒）；再长就是部署配错了。 */
export const MAX_WAIT_TIME_MS = 30_000

/** click / press 落地后探测「地址是否变了」的窗口（毫秒）。 */
export const MUTATION_NAVIGATION_POLL_MS = 800

/**
 * 一次 mutation 里「页面可能开出来的新标签页」必须被观测到的时间点：**动作发起点 + 本值**（毫秒）。
 *
 * 为什么是这个数：宿主的「弹窗转标签」链路（`setWindowOpenHandler` → `openTab` →
 * `{type:'opened'}` 通报 → provider `adoptSession`）是异步的，本机实测（2026-09-17，
 * `D:\Temp\dshhost\measure-opened.mjs`，n=5）从 `window.open` 被派发到父进程收到通报：
 * **min 140ms / 中位 152ms / max 156ms**。取 250ms 是给慢机器留余量 ——
 * 这个窗口只在「来不及观测」的路径上真正付出等待，代价见 {@link collectOpenedTabs}。
 */
export const TAB_OPEN_WATCH_MS = 250

/** 补观测新标签页时的轮询间隔（毫秒）；远小于窗口本身，够细。 */
const TAB_OPEN_WATCH_POLL_MS = 25

/**
 * 探测到导航之后再等新文档「能用」的上限（毫秒）。
 *
 * 为什么需要：地址变了不等于新文档已解析完 —— 报告 S1 实测 `webpage_press` 回车跳维基搜索页时
 * 返回的 `title` 是**空串**（文档已提交，`<title>` 还没解析出来），调用方据此会误判「页没就绪」。
 * 所以检测到导航后额外等一小段：`readyState === 'complete'` 或标题出现即返回，超时也返回
 * （页面是慢，不是错，别把 `press` 拖成失败）。窗口远小于工具超时（60s）。
 */
export const MUTATION_NAVIGATION_SETTLE_MS = 5_000

/** `wait` 轮询 text / hidden 条件的间隔（毫秒）。 */
const WAIT_POLL_INTERVAL_MS = 100

/** `webpage_console` / `webpage_network` 的默认返回条数（从最新往回）。 */
export const DEFAULT_P2_LIMIT = 50

/**
 * `limit` 的硬上限（条）。**从 500 收到 150**（2026-09-17）。
 *
 * 500 那条是照采集环形容量抄的，但它同时是「一次调用能塞进上下文的条数」：
 * console 单条上限 2000 字符 × 500 = 100 万字符，network 长 URL 一行 276 字符 × 500 =
 * 13.8 万字符 —— 都远超一次观察该有的体量。收到 150 之后，配合各自的**总量预算**
 * （`CONSOLE_RESULT_MAX_CHARS` / `NETWORK_LIST_MAX_CHARS`，见各自模块），单次观察的最坏
 * 情况被钉在几万字符量级。要更多就分页/过滤，那本来就比一次拉满更好用。
 */
export const MAX_P2_LIMIT = 150

/** `webpage_execute` 结果的裁剪上限（字符）；逃生舱可能返回极大对象，别撑爆上下文。 */
export const EXECUTE_MAX_RESULT_CHARS = 20_000

/**
 * 命令白名单判定里的「导航类」命令：执行后要走既有的导航检测 / 纪元推进路径。
 * 这两条会替换文档，旧 ref 一律作废 —— `Page.reload` 地址不变，所以必须**无条件**作废。
 */
const NAVIGATION_COMMANDS: ReadonlySet<string> = new Set(['Page.navigate', 'Page.reload'])

/** 一个受控标签页的全部状态。 */
interface SessionState {
  readonly targetId: string
  readonly connection: CdpConnection
  readonly refs: RefRegistry
  /** P2 console 采集器（Runtime + Log 两域，按域分桶去重）。 */
  readonly consoleCollector: ConsoleCollector
  /** P2 network 采集器（requestId 直接用，不做映射）。 */
  readonly networkCollector: NetworkCollector
  url: string
  title: string
  /**
   * P3 人工接管状态位（方案 4.1.1）：有人正开着 DevTools 操作这个页面。
   * **幂等状态位，不是计数器** —— agent 自己 toggle DevTools 时也会被置位，无需去重。
   * 它只影响 snapshot 结果里的提示，**绝不推进 ref 纪元**（`[V31]`）。
   */
  takeover: boolean
  /**
   * P3 locate 高亮状态位：本 session 是否画过一层 `Overlay.highlightNode` 高亮。
   * 用于 `highlight: false` 时决定要不要补发 `Overlay.hideHighlight`（只弹自己那层，`[V31]`）。
   */
  highlightPainted: boolean
}

/** 页面元信息，由一次 `Runtime.evaluate` 取回。 */
interface PageMeta {
  readonly url: string
  readonly title: string
}

/** `Runtime.evaluate` 的返回体（只声明用到的字段）。 */
interface EvaluateResult {
  readonly result?: { readonly value?: unknown }
}

/** `Page.navigate` 的返回体。 */
interface NavigateResult {
  readonly errorText?: string
  readonly isDownload?: boolean
}

/** `Page.captureScreenshot` 的返回体。 */
interface CaptureResult {
  readonly data?: string
}

/** `Accessibility.getFullAXTree` 的返回体。 */
interface AxTreeResult {
  readonly nodes?: readonly AxNode[]
}

/** `DOM.resolveNode` 的返回体。 */
interface ResolveNodeResult {
  readonly object?: { readonly objectId?: string }
}

/** `DOM.getBoxModel` 的返回体。 */
interface BoxModelResult {
  readonly model?: { readonly border?: readonly number[]; readonly content?: readonly number[] }
}

/** 截图裁剪区域（CSS 像素，相对文档）。 */
interface ScreenshotClip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly scale: number
}

/**
 * CDP 直连 provider。
 *
 * 生命周期：`open()` 建会话，`close()` 归还，`dispose()` 在插件卸载时兜底清理所有残留。
 * 连接与标签页的所有权边界很明确 —— **只关自己开的标签页**。
 */
export class CdpBrowserProvider implements BrowserProvider {
  // 类型放宽成 `string`：这个 provider 也是「Electron 窗口」provider 的基类，
  // 子类会用另一个 id 注册（见 `browser-electron/provider.ts`）。
  readonly id: string = CDP_PROVIDER_ID

  private readonly config: ResolvedConfig
  private readonly transport: CdpTransport
  private readonly sessions = new Map<string, SessionState>()
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
    }
    this.transport = transport ?? new HttpCdpTransport(this.config.endpoint, {
      requestTimeoutMs: this.config.requestTimeoutMs,
      commandTimeoutMs: this.config.commandTimeoutMs,
    })
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
      refs: new RefRegistry(),
      // 采集器在构造时就订阅事件，所以必须在下面 `*.enable` 之前建好 —— 否则第一批
      // 重放 / 实时事件会在订阅前溜走。
      consoleCollector: new ConsoleCollector(connection),
      networkCollector: new NetworkCollector(connection),
      url: target.url,
      title: target.title,
      takeover: false,
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
      await this.navigateTo(connection, url, session.url, signal)
      const meta = await this.readPageMeta(connection, signal)
      if (meta !== undefined) {
        session.url = meta.url
        session.title = meta.title
      }
    } catch (error: unknown) {
      connection.close()
      await this.transport.closeTarget(target.id).catch(() => undefined)
      throw error
    }

    this.sessions.set(session.targetId, session)
    // 用户自己关掉标签页时同步摘掉会话，避免留下一个永远连不上的死会话。
    connection.onClose(() => {
      if (this.sessions.get(session.targetId) === session) this.sessions.delete(session.targetId)
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
   * @param signal - 取消信号。
   * @returns 收编好的会话。
   */
  protected async adoptSession(target: CdpTarget, signal?: AbortSignal): Promise<BrowserSession> {
    const connection = await this.transport.connect(target.webSocketDebuggerUrl, signal)
    const session: SessionState = {
      targetId: target.id,
      connection,
      refs: new RefRegistry(),
      // 与 open() 同序：采集器在构造时订阅事件，必须赶在 enable 之前建好。
      consoleCollector: new ConsoleCollector(connection),
      networkCollector: new NetworkCollector(connection),
      url: target.url,
      title: target.title,
      takeover: false,
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
      if (this.sessions.get(session.targetId) === session) this.sessions.delete(session.targetId)
    })
    await this.waitForDocument(connection, signal, this.config.navigationTimeoutMs)
    const meta = await this.readPageMeta(connection, signal)
    if (meta !== undefined && meta.url !== '') {
      session.url = meta.url
      session.title = meta.title
    }
    return this.toSession(session)
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
    const url = validateTargetUrl(request.url)
    // 记住导航前的地址：新文档提交之前，`readyState` 仍是**旧**文档的 complete，
    // 只有「地址真的变了」才说明新页面已经顶上来。
    const previousUrl = session.url
    const loaded = await this.navigateTo(session.connection, url, previousUrl, signal)
    // 导航无论成功与否都作废既有 ref —— 页面已经变了，旧 ref 指向的东西不再可信。
    session.refs.invalidate()
    const meta = await this.readPageMeta(session.connection, signal)
    if (meta !== undefined) {
      session.url = meta.url
      session.title = meta.title
    } else {
      session.url = url
    }
    // 只有真的换过文档才推进采集器的文档序号：等加载超时（`loaded=false`）且地址也没变时
    // 文档可能根本没换，那时把 console / network 的旧记录遮掉反而是错的。
    if (loaded || (meta !== undefined && meta.url !== '' && meta.url !== previousUrl)) {
      this.noteDocumentChange(session)
    }
    if (!loaded) {
      throw new BrowserError(
        `navigation to ${url} did not finish loading within ${this.config.navigationTimeoutMs} ms; the page may still be loading`,
        'BROWSER_NAVIGATION_FAILED',
      )
    }
    // 加载完成即算「新文档能用」：读到空标题说明这页面本来就没有 <title>，不必再等。
    if (session.title.length === 0) await this.settleDocument(session, signal)
    return this.toSession(session)
  }

  /** @inheritdoc */
  async observe(request: BrowserObserveRequest, signal?: AbortSignal): Promise<BrowserObservation> {
    const session = this.require(request.sessionId)
    return request.kind === 'snapshot'
      ? this.snapshot(session, signal, request.maxLines)
      : this.screenshot(session, request.ref, request.fullPage ?? false, signal)
  }

  /** @inheritdoc */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    // 幂等：重复关闭不是错误。
    if (session === undefined) return
    this.sessions.delete(sessionId)
    // 先摘采集器的订阅，再关连接：连接关闭会清掉全部监听，但显式退订让所有权更清楚。
    session.consoleCollector.dispose()
    session.networkCollector.dispose()
    session.connection.close()
    // 标签页可能已经被用户手动关掉了，那正是我们想要的结果，不算失败。
    await this.transport.closeTarget(session.targetId).catch(() => undefined)
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
    // **操作前**先记下已有会话；收尾时取差集就是「本次操作顺带开出来的标签页」。
    // 快照点必须在动作之前：页面可能在动作里就 adopt 出新会话（虽然实测要 150ms 级）。
    const beforeIds = new Set(this.sessions.keys())
    const watchUntil = Date.now() + TAB_OPEN_WATCH_MS
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
        return this.wait(session, request, signal)
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
    await this.pollUntil(
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
    assertExecuteAllowed(request.method)
    const beforeUrl = session.url
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
        timeoutMs: this.config.commandTimeoutMs,
      })
    } catch (error: unknown) {
      // 把「循环引用 / Symbol」这两条序列化错误映射成 BROWSER_EXECUTE_RESULT_UNSERIALIZABLE。
      throw translateEvaluateError(error)
    }
    if (NAVIGATION_COMMANDS.has(request.method)) {
      // 显式导航：地址变了 detectNavigation 会作废；地址没变（reload）这里再作废一次。
      const changed = await this.detectNavigation(session, beforeUrl, true, signal)
      if (!changed) {
        session.refs.invalidate()
        // reload 的地址不变但文档确实换了，采集器的文档序号必须跟着走（否则旧日志会混进来）。
        this.noteDocumentChange(session)
      }
      const capped = capResult(raw)
      return {
        kind: 'execute',
        sessionId: session.targetId,
        method: request.method,
        epoch: session.refs.currentEpoch,
        url: session.url,
        navigated: true,
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
      const navigated = await this.detectNavigation(session, beforeUrl, false, signal)
      if (navigated) await this.settleDocument(session, signal)
      return {
        kind: 'execute',
        sessionId: session.targetId,
        method: request.method,
        epoch: session.refs.currentEpoch,
        url: session.url,
        navigated,
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
      navigated: false,
      result: capped.payload,
      truncated: capped.truncated,
    }
  }

  /**
   * P3：按 ref 现算元素的视口坐标盒（方案 4.3 / 4.4）。
   *
   * 定位链路照 `[V36]` 实测：`refs.resolve(ref)`（纪元校验沿用既有路径，从不绕开）→
   * `backendNodeId` → `DOM.resolveNode`（无需 `DOM.enable`）→ `Runtime.callFunctionOn`
   * 现算 rect。**不用 nodeId**（`[V19]` 实测重复 `getDocument` 后重新分配），**不引
   * selector**（重构后可能静默命中另一个元素；backendNodeId 是「指向」语义，失败可检出）。
   *
   * ## 三道失效守卫（方案 4.4 + `[V36]`，缺一不可）
   *
   * 1. `DOM.resolveNode` 抛错 / 拿不到 objectId → `BROWSER_STALE_REF`（节点彻底没了）；
   * 2. resolve 成功但 `this.isConnected === false` → `BROWSER_STALE_REF` —— **`[V36]` 实测
   *    `replaceWith` 换掉元素后 resolveNode 仍然成功**，只查 resolveNode 会漏这一档；
   * 3. rect 宽高为 0 → `BROWSER_PROTOCOL_ERROR`。理由：节点还在文档里、只是没布局
   *    （`display:none` / 未渲染），ref 并没有失效，所以不报 `BROWSER_STALE_REF`；沿用
   *    click 路径对「元素没有可用布局盒」的既有错误码，并绝不拿 0 坐标假装成功。
   *
   * **每次调用都现算 rect，绝不缓存 snapshot 时的几何**（方案 4.4 的硬要求）：snapshot
   * 之后的几何大概率已变，「现算」是 isConnected 之外唯一的兜底，缓存等于把兜底拆掉。
   * 已知的剩余漏报区间：节点还在且 connected，但被页面复用显示另一条数据 —— 没有廉价
   * 检测手段，坐标对不对要由调用方按业务语义判断（注释别写成「兜底完备」）。
   *
   * **不滚动视口**（`scroll` 默认 false，2026-09-14 改）：默认 `scrollIntoView` 会让 locate
   * 既验证不了「刚才那次 scroll 生效没有」，又悄悄改掉用户看到的画面。要看元素当下的位置就
   * 保持默认；确实需要把它挪到视口中央再量时才传 `scroll: true`。
   */
  async locate(request: BrowserLocateRequest, signal?: AbortSignal): Promise<BrowserLocateResult> {
    const session = this.require(request.sessionId)
    // 纪元校验走既有 resolve 路径：从未观察 → BROWSER_SNAPSHOT_REQUIRED，旧纪元 → BROWSER_STALE_REF。
    const target = session.refs.resolve(request.ref)
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    let objectId: string | undefined
    try {
      objectId = await this.resolveNodeObjectId(session, target.backendNodeId, signal)
    } catch (error: unknown) {
      // detach（[V16]）与连接丢失是会话级状态，不是 ref 失效 —— 保持既有错误码原样上抛。
      if (error instanceof BrowserError
        && (error.code === 'BROWSER_DEBUGGER_DETACHED' || error.code === 'BROWSER_CONNECTION_LOST')) throw error
      throw new BrowserError(
        `the element for ref "${request.ref}" is gone from the document; run webpage_snapshot again`,
        'BROWSER_STALE_REF',
        { cause: error },
      )
    }
    if (objectId === undefined) {
      throw new BrowserError(
        `the element for ref "${request.ref}" is no longer attached to the document; run webpage_snapshot again`,
        'BROWSER_STALE_REF',
      )
    }
    try {
      // 守卫 2（[V36]）：resolveNode 成功 ≠ 节点还连在文档上，量 rect 之前先查 isConnected。
      const connected = await session.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: 'function () { return this.isConnected; }', returnByValue: true },
        options,
      )
      if (connected.result?.value !== true) {
        throw new BrowserError(
          `the element for ref "${request.ref}" was removed from the document (the page may have `
          + 're-rendered); run webpage_snapshot again',
          'BROWSER_STALE_REF',
        )
      }
      const scroll = request.scroll ?? false
      // 守卫 3 落在 elementViewportBox 的零尺寸校验里（见上，选 BROWSER_PROTOCOL_ERROR 的理由）。
      const box = await this.elementViewportBox(session, objectId, signal, scroll)
      if (request.highlight === true) await this.paintHighlight(session, objectId, signal)
      else if (session.highlightPainted) await this.clearHighlight(session, signal)
      const inViewport = box.viewportWidth === undefined || box.viewportHeight === undefined
        ? undefined
        : box.x + box.width > 0 && box.y + box.height > 0
          && box.x < box.viewportWidth && box.y < box.viewportHeight
      return {
        kind: 'locate',
        sessionId: session.targetId,
        epoch: session.refs.currentEpoch,
        ref: request.ref,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        centered: scroll,
        ...inViewport !== undefined ? { inViewport } : {},
      }
    } finally {
      this.releaseObject(session, objectId, signal)
    }
  }

  /** @inheritdoc */
  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    const results = await Promise.allSettled(sessions.map(async (session) => {
      session.consoleCollector.dispose()
      session.networkCollector.dispose()
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
    if (session !== undefined) session.takeover = active
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
   * 观察：可访问性树 → 大纲 → 分配 ref（推进纪元）。
   *
   * `maxLines` 只有调用方显式给时才改限额（见 {@link resolveSnapshotLimits}：行数预算和字符
   * 预算一起抬，否则只抬一半会「我调大了还是截断」。长文页默认 800 行必截，这是报告 S3 的
   * 原始问题 —— 现在模型可以自己要求多看几屏）。
   */
  private async snapshot(session: SessionState, signal?: AbortSignal, maxLines?: number): Promise<BrowserSnapshot> {
    const tree = await session.connection.send<AxTreeResult>(
      'Accessibility.getFullAXTree',
      {},
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const outline = buildOutline(tree.nodes ?? [], resolveSnapshotLimits(this.config.snapshotLimits, maxLines))
    // publish 会把纪元推进一格：上一次 snapshot 的 ref 从此作废。
    const publication = session.refs.publish(outline.rows, outline.truncated)
    const meta = await this.readPageMeta(session.connection, signal)
    if (meta !== undefined) {
      session.url = meta.url
      session.title = meta.title
    }
    return {
      kind: 'snapshot',
      sessionId: session.targetId,
      epoch: publication.epoch,
      url: session.url,
      title: session.title,
      outline: renderOutline(outline, publication.refs),
      // 折叠前的完整大纲：`webpage_find` 的检索底稿。折叠标记承诺「用 find 拿全部实例的 ref」，
      // 前提是 find 手上那份底稿里一个实例都不少（`rows` 本来就是全量的，这里只是把它渲染出来）。
      fullOutline: renderOutline(outline, publication.refs, { unfoldRepeats: true }),
      refs: session.refs.list(),
      truncated: publication.truncated,
      outlineLines: outline.lines.length,
      ...outline.truncated ? { droppedElements: outline.droppedElements } : {},
      ...outline.foldedRepeats > 0 ? { foldedRepeats: outline.foldedRepeats } : {},
      // 人工接管只加提示，**不动 epoch** —— 开合 DevTools 不该作废模型的 ref（[V31]）。
      ...session.takeover ? { takeover: true } : {},
    }
  }

  /** 观察：整页 / 视口 / 元素截图。元素级截图会先解析 ref，旧 ref 直接 `BROWSER_STALE_REF`。 */
  private async screenshot(
    session: SessionState,
    ref: string | undefined,
    fullPage: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserScreenshot> {
    let clip: ScreenshotClip | undefined
    if (ref !== undefined) {
      // 解析放在发命令之前：ref 失效时应当立刻失败，而不是先截一张错的图。
      const target: RefTarget = session.refs.resolve(ref)
      clip = await this.elementClip(session, target.backendNodeId, signal)
    }
    // `fromSurface: false` 从渲染器取帧而不是合成器表面：默认的表面路径在
    // 「看不见的页面」上不出帧会**永久挂起** —— [V33] 的 show:false 窗口、以及
    // 多标签场景里 setVisible(false) 的后台标签（2026-09-13 多会话演示实测，
    // 30s 超时前不返回）。渲染器路径对前台/后台标签都强制出一帧，没有这个坑。
    const params: Record<string, unknown> = { format: 'png', fromSurface: false }
    if (clip !== undefined) {
      params['clip'] = clip
      params['captureBeyondViewport'] = true
    } else if (fullPage) {
      params['captureBeyondViewport'] = true
    }
    const captured = await session.connection.send<CaptureResult>(
      'Page.captureScreenshot',
      params,
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const encoded = captured.data
    if (encoded === undefined || encoded.length === 0) {
      throw new BrowserError('Page.captureScreenshot returned no image data', 'BROWSER_PROTOCOL_ERROR')
    }
    const data = Uint8Array.from(Buffer.from(encoded, 'base64'))
    const size = pngDimensions(data)
    return {
      kind: 'screenshot',
      sessionId: session.targetId,
      epoch: session.refs.currentEpoch,
      data,
      mediaType: 'image/png',
      width: size.width,
      height: size.height,
      ...ref !== undefined ? { ref } : {},
    }
  }

  /** 取一个元素的裁剪区域；元素已经从文档里消失时报 `BROWSER_STALE_REF`。 */
  private async elementClip(session: SessionState, backendNodeId: number, signal?: AbortSignal): Promise<ScreenshotClip> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    const resolved = await session.connection.send<ResolveNodeResult>('DOM.resolveNode', { backendNodeId }, options)
    const objectId = resolved.object?.objectId
    if (objectId === undefined) {
      throw new BrowserError(
        'the observed element is no longer attached to the document; run webpage_snapshot again',
        'BROWSER_STALE_REF',
      )
    }
    try {
      const box = await session.connection.send<BoxModelResult>('DOM.getBoxModel', { objectId }, options)
      const quad = box.model?.border ?? box.model?.content
      if (quad === undefined || quad.length < 8) {
        throw new BrowserError('the element has no layout box to capture', 'BROWSER_PROTOCOL_ERROR')
      }
      const xs = [quad[0], quad[2], quad[4], quad[6]] as number[]
      const ys = [quad[1], quad[3], quad[5], quad[7]] as number[]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const width = Math.max(...xs) - x
      const height = Math.max(...ys) - y
      if (!(width > 0) || !(height > 0)) {
        throw new BrowserError('the element has a zero-sized layout box', 'BROWSER_PROTOCOL_ERROR')
      }
      return { x, y, width, height, scale: 1 }
    } finally {
      // 释放远端对象句柄，别让 V8 侧攒下一堆没人用的对象。
      await session.connection.send('DOM.releaseObject', { objectId }, { signal }).catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------------------
  // P1 mutation：click / fill / press / scroll / wait
  // ---------------------------------------------------------------------------

  /**
   * `DOM.resolveNode({ backendNodeId })` → 远端对象句柄（`[V36]`：无需 `DOM.enable`）。
   *
   * 节点已销毁时 Chrome 回 CDP 错误（原样上抛，由调用方决定映射）；返回体里缺
   * `objectId` 时返回 `undefined` —— 两种「拿不到句柄」的形态要分开处理。
   */
  private async resolveNodeObjectId(
    session: SessionState,
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const resolved = await session.connection.send<ResolveNodeResult>(
      'DOM.resolveNode',
      { backendNodeId },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    return resolved.object?.objectId
  }

  /**
   * 把 ref 解析成远端对象句柄。
   *
   * **第一步**就是查纪元表：ref 失效（或从未 snapshot）时这里直接抛
   * `BROWSER_STALE_REF` / `BROWSER_SNAPSHOT_REQUIRED`，后面的 CDP 命令一条都
   * 不会发 —— 这就是「写前检查纪元」。
   */
  private async resolveObjectId(session: SessionState, ref: string, signal?: AbortSignal): Promise<string> {
    const target = session.refs.resolve(ref)
    const objectId = await this.resolveNodeObjectId(session, target.backendNodeId, signal)
    if (objectId === undefined) {
      throw new BrowserError(
        'the observed element is no longer attached to the document; run webpage_snapshot again',
        'BROWSER_STALE_REF',
      )
    }
    return objectId
  }

  /** 释放远端对象句柄（尽力而为；释放失败不影响主流程）。 */
  private releaseObject(session: SessionState, objectId: string, signal?: AbortSignal): void {
    void session.connection
      .send('DOM.releaseObject', { objectId }, { signal })
      .catch(() => undefined)
  }

  /**
   * 取元素的视口坐标盒（`scroll=true` 时先滚动到视口中央再量）。
   *
   * 用 `Runtime.callFunctionOn` + `getBoundingClientRect` 而不是 `DOM.getBoxModel`：
   * 后者给的是文档坐标，而 `Input.dispatchMouseEvent` 吃的是视口坐标；
   * 元素在视口外时文档坐标直接把事件点到看不见的地方去。
   *
   * `scroll=false` 跳过 `scrollIntoView`（`webpage_locate` 的默认路径）：只读坐标、不动视口。
   * 零尺寸在此统一拒绝 —— click 的落点与 locate 的「不可见」判定都不能建立在 0 宽高的盒子上。
   *
   * 同一次调用顺带把视口尺寸带回来（`webpage_locate` 判 `in_viewport` 用，省一次往返）；
   * 老实现没有这两个字段，所以按可选读，读不到就是 `undefined`。
   */
  private async elementViewportBox(
    session: SessionState,
    objectId: string,
    signal?: AbortSignal,
    scroll = true,
  ): Promise<{ x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }> {
    const measure = ' const rect = this.getBoundingClientRect();'
      + ' return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,'
      + ' viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }; }'
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: scroll
          ? `function () { this.scrollIntoView({ block: "center", inline: "center" });${measure}`
          : `function () {${measure}`,
        returnByValue: true,
      },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const value = evaluated.result?.value
    if (typeof value !== 'object' || value === null) {
      throw new BrowserError('could not read the element box for interaction', 'BROWSER_PROTOCOL_ERROR')
    }
    const box = value as Record<string, unknown>
    const x = box['x']
    const y = box['y']
    const width = box['width']
    const height = box['height']
    if (
      typeof x !== 'number' || typeof y !== 'number'
      || typeof width !== 'number' || typeof height !== 'number'
      || !(width > 0) || !(height > 0)
    ) {
      throw new BrowserError('the element has no usable layout box to interact with', 'BROWSER_PROTOCOL_ERROR')
    }
    const viewportWidth = box['viewportWidth']
    const viewportHeight = box['viewportHeight']
    return {
      x,
      y,
      width,
      height,
      ...typeof viewportWidth === 'number' ? { viewportWidth } : {},
      ...typeof viewportHeight === 'number' ? { viewportHeight } : {},
    }
  }

  /**
   * 读一次视口尺寸（CSS 像素）。`webpage_scroll` 不带 ref 时用它算落点（视口中心）。
   * 读不到时退到 400×300 —— 滚轮事件落在视口内的任意一点都行，只有「落在视口外」才无效。
   */
  private async viewportSize(session: SessionState, signal?: AbortSignal): Promise<{ width: number; height: number }> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      { expression: '({ width: window.innerWidth, height: window.innerHeight })', returnByValue: true },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    ).catch(() => undefined)
    const value = evaluated?.result?.value
    if (typeof value === 'object' && value !== null) {
      const size = value as Record<string, unknown>
      const width = size['width']
      const height = size['height']
      if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) {
        return { width, height }
      }
    }
    return { width: 400, height: 300 }
  }

  /**
   * 在元素上画一层高亮（方案 4.3，`webpage_locate` 的 `highlight: true`）。
   *
   * 两道门缺一不可（`[V15][V20]`）：本 session 必须先 `DOM.enable` 才能成功
   * `Overlay.enable`，必须先 `Overlay.enable` 才能调 `Overlay.highlightNode`。
   * **每次都补发这两条 enable**：re-attach 后 domain enable 状态不保证还在
   * （与 console / network 采集读取前补发 enable 同一条理由）。
   *
   * 只用 `highlightNode` + `highlightConfig`（contentColor 填色 + borderColor 边框），
   * **绝不用 `Overlay.highlightRect`** —— `[V32]` 实测后者会把传入 rect 之外的整个视口
   * 染色。高亮是本 client 自己的一层，与人工 DevTools / 其它 client 的高亮互不取消
   * （`[V31]`），无需协商；它会保持到 `Overlay.hideHighlight` 或页面导航。
   */
  private async paintHighlight(session: SessionState, objectId: string, signal?: AbortSignal): Promise<void> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    await session.connection.send('DOM.enable', {}, options)
    await session.connection.send('Overlay.enable', {}, options)
    await session.connection.send('Overlay.highlightNode', {
      objectId,
      highlightConfig: {
        contentColor: { r: 250, g: 200, b: 60, a: 0.5 },
        borderColor: { r: 220, g: 120, b: 0, a: 1 },
      },
    }, options)
    session.highlightPainted = true
  }

  /**
   * 弹掉本 client 画的那层高亮（`webpage_locate` 的 `highlight: false` 且此前画过时调用）。
   * `hideHighlight` 只弹自己那层（`[V31]`）；enable 门与 paint 相同，防止 re-attach 后
   * Overlay 未 enable 时 hide 直接失败。
   */
  private async clearHighlight(session: SessionState, signal?: AbortSignal): Promise<void> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    await session.connection.send('DOM.enable', {}, options)
    await session.connection.send('Overlay.enable', {}, options)
    await session.connection.send('Overlay.hideHighlight', {}, options)
    session.highlightPainted = false
  }

  /** 点击：解析 ref → 滚到可视区 → 在元素中心派发真实的鼠标按下/抬起。 */
  private async click(session: SessionState, ref: string, signal?: AbortSignal): Promise<BrowserMutationResult> {
    const beforeUrl = session.url
    const objectId = await this.resolveObjectId(session, ref, signal)
    try {
      const box = await this.elementViewportBox(session, objectId, signal)
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      const options = { signal, timeoutMs: this.config.commandTimeoutMs }
      await session.connection.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...point, button: 'left', clickCount: 1,
      }, options)
      await session.connection.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...point, button: 'left', clickCount: 1,
      }, options)
    } finally {
      this.releaseObject(session, objectId, signal)
    }
    return this.settleMutation(session, 'click', beforeUrl, true, signal)
  }

  /** 填写：走原型链上的原生 value setter（React 受控组件也认），再补 input/change 事件。 */
  private async fill(
    session: SessionState,
    ref: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const beforeUrl = session.url
    const objectId = await this.resolveObjectId(session, ref, signal)
    try {
      const outcome = await session.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: FILL_FUNCTION, arguments: [{ value }], returnByValue: true },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      if (outcome.result?.value === 'editable') {
        // 上一步已聚焦 + 全选，这里由浏览器原生输入管线写入（理由见 FILL_FUNCTION 注释）。
        await session.connection.send(
          'Input.insertText',
          { text: value },
          { signal, timeoutMs: this.config.commandTimeoutMs },
        )
      }
    } finally {
      this.releaseObject(session, objectId, signal)
    }
    return this.settleMutation(session, 'fill', beforeUrl, false, signal)
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
    const objectId = await this.resolveObjectId(session, ref, signal)
    try {
      await session.connection.send(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: 'function () { this.focus(); }', returnByValue: true },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
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
      this.releaseObject(session, objectId, signal)
    }
    return this.settleMutation(session, 'press', beforeUrl, true, signal)
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
    const beforeUrl = session.url
    const point = ref === undefined
      ? await this.viewportCenter(session, signal)
      : await (async (): Promise<{ x: number; y: number }> => {
        const objectId = await this.resolveObjectId(session, ref, signal)
        try {
          const box = await this.elementViewportBox(session, objectId, signal)
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        } finally {
          this.releaseObject(session, objectId, signal)
        }
      })()
    await session.connection.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: dx,
      deltaY: dy,
    }, { signal, timeoutMs: this.config.commandTimeoutMs })
    return this.settleMutation(session, 'scroll', beforeUrl, false, signal)
  }

  /** 视口中心（CSS 像素）：不带 ref 的 scroll 的落点。 */
  private async viewportCenter(session: SessionState, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const size = await this.viewportSize(session, signal)
    return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) }
  }

  /** 等待：timeMs（纯等待）/ text（页面出现某文本）/ ref（元素从文档里消失）三选一。 */
  private async wait(
    session: SessionState,
    request: Extract<BrowserMutationRequest, { kind: 'wait' }>,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const wantsTime = request.timeMs !== undefined
    const wantsText = request.text !== undefined && request.text.length > 0
    const wantsRef = request.ref !== undefined
    if ([wantsTime, wantsText, wantsRef].filter(chosen => chosen).length !== 1) {
      throw new BrowserError(
        'webpage_wait needs exactly one of time_ms, text, or ref',
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    const beforeUrl = session.url
    let satisfied = true
    if (request.timeMs !== undefined) {
      if (!(request.timeMs > 0) || request.timeMs > MAX_WAIT_TIME_MS) {
        throw new BrowserError(
          `webpage_wait time_ms must be between 1 and ${String(MAX_WAIT_TIME_MS)}`,
          'BROWSER_PROTOCOL_ERROR',
        )
      }
      await delay(request.timeMs, signal)
    } else if (wantsText) {
      const text = request.text as string
      satisfied = await this.pollUntil(
        async () => {
          const evaluated = await session.connection.send<EvaluateResult>(
            'Runtime.evaluate',
            { expression: `document.body !== null && document.body.innerText.includes(${JSON.stringify(text)})`, returnByValue: true },
            { signal, timeoutMs: this.config.commandTimeoutMs },
          )
          return evaluated.result?.value === true
        },
        // wait 的 probe 会真发命令：失败要当「还没等到」继续等，而不是让整个工具失败。
        { timeoutMs: this.config.waitTimeoutMs, signal, swallowErrors: true },
      )
    } else {
      const ref = request.ref as string
      // hidden 语义也吃 ref 纪元：旧 ref 在这里直接抛，不会傻等一个不存在的元素。
      const objectId = await this.resolveObjectId(session, ref, signal)
      try {
        satisfied = await this.pollUntil(
          async () => {
            const evaluated = await session.connection.send<EvaluateResult>(
              'Runtime.callFunctionOn',
              { objectId, functionDeclaration: 'function () { return !this.isConnected; }', returnByValue: true },
              { signal, timeoutMs: this.config.commandTimeoutMs },
            )
            return evaluated.result?.value === true
          },
          // 同上：hidden 分支的 probe 也是直接发命令，同样不能让工具失败。
          { timeoutMs: this.config.waitTimeoutMs, signal, swallowErrors: true },
        )
      } finally {
        this.releaseObject(session, objectId, signal)
      }
    }
    const result = await this.settleMutation(session, 'wait', beforeUrl, false, signal)
    return { ...result, satisfied }
  }

  /**
   * 统一的轮询骨架：**先探一次，再判超时，最后按间隔等**。
   *
   * 2026-09-17 之前，等待逻辑在本文件里写了六遍（pollUntil / detectNavigation /
   * settleDocument / waitForNavigation / waitForDocument / collectOpenedTabs），
   * 每一遍都是 `for(;;){probe; deadline; delay}` 的复制品，间隔常量还不统一
   * （100 与 `min(100, 剩余)` 两种），而「先探还是先判超时」这个顺序一旦写反，
   * `timeoutMs = 0` 就变成「一次都不探」。所以收敛到这里，六处只留各自的判定条件。
   *
   * 间隔取 `min(intervalMs, 剩余时间)`：正常情况就是 `intervalMs`，窗口快到时不会睡过头。
   *
   * @param probe - 探一次；返回真即停下。
   * @param options - 超时上限、轮询间隔（默认 {@link WAIT_POLL_INTERVAL_MS}）、取消信号；
   *   `swallowErrors` 为真时把 `probe` 的异常当「还没成立」继续等（**默认不吞** ——
   *   多数等待的 probe 自己就有 try/catch，吞掉反而会藏住真错）。
   * @returns `probe` 是否成立过。
   */
  private async pollUntil(
    probe: () => Promise<boolean>,
    options: {
      timeoutMs: number
      intervalMs?: number | undefined
      signal?: AbortSignal | undefined
      swallowErrors?: boolean | undefined
    },
  ): Promise<boolean> {
    const interval = options.intervalMs ?? WAIT_POLL_INTERVAL_MS
    const deadline = Date.now() + options.timeoutMs
    for (;;) {
      // `webpage_wait` 的两处 probe 是直接发 CDP 命令，页面中途导航会让 objectId 失效、
      // 单条命令也可能超时 —— 那不是「等的条件不满足」，但也不该让整个工具失败。
      // 旧骨架在这里是吞异常继续等的，语义必须保住（2026-09-17 收敛时差点丢掉）。
      const ok = options.swallowErrors === true ? await probe().catch(() => false) : await probe()
      if (ok) return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await delay(Math.min(interval, remaining), options.signal)
    }
  }

  /**
   * 操作落地后的收尾：探测「地址是否变了」，变了就作废旧纪元并更新会话元信息。
   *
   * click / press 可能引发导航，但导航是异步的 —— 立刻读一次往往还是旧地址。
   * 所以这两类动作给一个短轮询窗口；fill / scroll / wait 只读一次。
   */
  private async settleMutation(
    session: SessionState,
    action: BrowserMutationResult['action'],
    beforeUrl: string,
    awaitNavigation: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const navigated = await this.detectNavigation(session, beforeUrl, awaitNavigation, signal)
    return {
      kind: 'mutation',
      sessionId: session.targetId,
      action,
      epoch: session.refs.currentEpoch,
      url: session.url,
      title: session.title,
      navigated,
    }
  }

  /**
   * 探测地址是否变了；变了就作废既有 ref、换文档、更新会话元信息。
   *
   * 判据是**地址变化**（`meta.url !== beforeUrl`）而不是 `readyState`：软导航 / 异步提交
   * 都可能让 readyState 先于地址稳定。`awaitNavigation` 为真时给一个短轮询窗口
   * （`MUTATION_NAVIGATION_POLL_MS`），否则只读一次。
   *
   * 一旦判定导航（且 `awaitNavigation`），再等新文档「能用」（见 {@link settleDocument}）：
   * 地址变了但 `<title>` 还没解析时返回空标题，会被当成「页没就绪」（报告 S1）。
   *
   * @returns 是否检测到导航（地址变化）。
   */
  private async detectNavigation(
    session: SessionState,
    beforeUrl: string,
    awaitNavigation: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let navigated = false
    // `timeoutMs = 0` 时骨架仍会先探一次再判超时 —— 这正是「只读一次」的语义。
    await this.pollUntil(
      async () => {
        const meta = await this.readPageMeta(session.connection, signal)
        if (meta !== undefined) {
          if (meta.url !== '' && meta.url !== beforeUrl) {
            // 页面换掉了：旧 ref 全部作废，绝不许旧 ref 静默命中新页面上的元素。
            session.refs.invalidate()
            navigated = true
            this.noteDocumentChange(session)
          }
          session.url = meta.url
          session.title = meta.title
        }
        return navigated
      },
      { timeoutMs: awaitNavigation ? MUTATION_NAVIGATION_POLL_MS : 0, signal },
    )
    if (navigated && awaitNavigation) await this.settleDocument(session, signal)
    return navigated
  }

  /**
   * 等新文档「真的能用」：读到非空标题，或文档已 `complete`（那说明它本来就没有 `<title>`），
   * 或窗口耗尽。
   *
   * 报告 S1 的成因很具体：`webpage_press` 回车跳维基搜索页，`Page.navigate` 已提交（地址变了），
   * 但 `<title>` 还在解析中，于是工具立刻返回 `title: ''`，调用方据此误判「页还没就绪」。
   * 这里只补这一小段等待，**超时不算失败**（页面是慢，不是错），也绝不把 `press` 拖成超时。
   */
  private async settleDocument(session: SessionState, signal?: AbortSignal): Promise<void> {
    await this.pollUntil(
      async () => {
        const meta = await this.readPageMeta(session.connection, signal)
        if (meta !== undefined) {
          session.url = meta.url
          session.title = meta.title
          if (meta.title.length > 0) return true
        }
        // 加载完还读不到标题 ⇒ 这个页面本来就没有 `<title>`，没必要等满窗口。
        return await this.documentComplete(session.connection, signal)
      },
      { timeoutMs: MUTATION_NAVIGATION_SETTLE_MS, signal },
    )
  }

  /**
   * 通报两个采集器「这个会话换文档了」。
   *
   * console / network 的缓冲都是按会话累积的，不区分文档时会把上一个页面的日志与请求
   * 一股脑端给模型（报告 S5）。换文档只推进文档序号、不丢数据：`read` / `list` 默认只给
   * 当前文档的，被遮掉多少条如实报告。
   */
  private noteDocumentChange(session: SessionState): void {
    session.consoleCollector.noteNavigation()
    session.networkCollector.noteNavigation()
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

  /** 读页面 URL 与标题；失败返回 `undefined`（页面可能是空白页或已崩溃）。 */
  private async readPageMeta(connection: CdpConnection, signal?: AbortSignal): Promise<PageMeta | undefined> {
    try {
      const evaluated = await connection.send<EvaluateResult>(
        'Runtime.evaluate',
        { expression: '({ url: location.href, title: document.title })', returnByValue: true },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      const value = evaluated.result?.value
      if (typeof value !== 'object' || value === null) return undefined
      const { url, title } = value as Record<string, unknown>
      return {
        url: typeof url === 'string' ? url : '',
        title: typeof title === 'string' ? title : '',
      }
    } catch {
      return undefined
    }
  }

  /**
   * 跳到目标地址并等**新文档**顶上来。
   *
   * `about:blank` 是「不需要导航」的特例：它本来就是空白页，等 `readyState` 就够。
   *
   * @param connection - 目标页面的连接。
   * @param url - 目标地址（已过地址策略）。
   * @param previousUrl - 导航前的地址；用来判断新文档是否已提交。
   * @param signal - 取消信号。
   * @returns 是否在超时前完成加载（超时不抛错，交给调用方决定）。
   */
  private async navigateTo(
    connection: CdpConnection,
    url: string,
    previousUrl: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (url !== 'about:blank') {
      const result = await connection.send<NavigateResult>(
        'Page.navigate',
        { url },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      if (result.errorText !== undefined && result.errorText.length > 0) {
        throw new BrowserError(`navigation to ${url} failed: ${result.errorText}`, 'BROWSER_NAVIGATION_FAILED')
      }
      return this.waitForNavigation(connection, previousUrl, signal, this.config.navigationTimeoutMs)
    }
    return this.waitForDocument(connection, signal, this.config.navigationTimeoutMs)
  }

  /**
   * 轮询到「地址已经变了，且新文档加载完成」。
   *
   * 判据必须是**地址变化**而不是 `readyState`：新标签页在导航提交前就是一个
   * `readyState === 'complete'` 的空白页，只看 readyState 会立刻判定加载完成，
   * 随后读到的 url / title / 大纲全是空白页的。
   *
   * @param connection - 目标页面的连接。
   * @param previousUrl - 导航前的地址。
   * @param signal - 取消信号。
   * @param timeoutMs - 超时上限。
   * @returns 是否在超时前完成。
   */
  private async waitForNavigation(
    connection: CdpConnection,
    previousUrl: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    return await this.pollUntil(
      () => this.navigationSettled(connection, previousUrl, signal),
      { timeoutMs, signal },
    )
  }

  /** 问一次「地址变了吗 + 加载完了吗」；任何读取失败都当作「还没完成」。 */
  private async navigationSettled(
    connection: CdpConnection,
    previousUrl: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const evaluated = await connection.send<EvaluateResult>(
        'Runtime.evaluate',
        {
          expression: 'JSON.stringify({ ready: document.readyState === "complete", href: String(location.href) })',
          returnByValue: true,
        },
        { signal, timeoutMs: Math.min(this.config.commandTimeoutMs, 5_000) },
      )
      const state = readNavigationState(evaluated.result?.value)
      if (state === undefined || !state.ready) return false
      // 从空白页出发时只要求「不再是空白页」；否则要求「不再是刚才那个地址」。
      return previousUrl === 'about:blank' ? state.href !== 'about:blank' : state.href !== previousUrl
    } catch {
      return false
    }
  }

  /**
   * 轮询 `document.readyState === 'complete'`。
   *
   * 用轮询而不是 `Page.loadEventFired`，是因为后者有两个坑：事件可能在 `Page.enable` 之前
   * 就已经发过（空白页、缓存页），而 SPA 的软导航又可能根本不发。轮询只贵几次本机往返。
   * @returns 是否在超时前完成加载。
   */
  private async waitForDocument(
    connection: CdpConnection,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    return await this.pollUntil(
      () => this.documentComplete(connection, signal),
      { timeoutMs, signal },
    )
  }

  /** 问一次 `document.readyState`；任何读取失败都当作「还没完成」。 */
  private async documentComplete(connection: CdpConnection, signal?: AbortSignal): Promise<boolean> {
    try {
      const evaluated = await connection.send<EvaluateResult>(
        'Runtime.evaluate',
        { expression: "document.readyState === 'complete'", returnByValue: true },
        { signal, timeoutMs: Math.min(this.config.commandTimeoutMs, 5_000) },
      )
      return evaluated.result?.value === true
    } catch {
      return false
    }
  }
}

/**
 * 空格键的键参数。
 *
 * 两个名字共用一份描述：`' '`（单字符写法）与 `Space`（命名键写法，Playwright 风格）。
 * `Space` 这个别名不是可有可无的 —— 错误文案与 `webpage_press` 的工具描述都把 `Space`
 * 当作命名键宣传，表里却只有 `' '`，于是模型照描述写 `key: "Space"` 会被判成
 * 「unsupported key」（2026-09-18 修）。**宣传的名字必须真的能用。**
 *
 * `text: ' '` 也不是装饰：`Input.dispatchKeyEvent` 的 keyDown **只有带 text 才会合成字符
 * 插入**（keypress/input 事件链），不带 text 时聚焦输入框按空格不产生任何字符。
 */
const SPACE_KEY = { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ' }

/**
 * `webpage_fill` 在页面里执行的填值函数；返回值告诉调用方走了哪条分支。
 *
 * - `'value'`：`input` / `textarea` —— 原生 setter + `input`/`change`，本框架听得懂。
 * - `'editable'`：`contenteditable` —— **只聚焦 + 全选**，真正的写入交给调用方随后发的
 *   `Input.insertText`。
 * - `'text'`：其它元素 —— 保持既有的 `textContent` 行为。
 *
 * 为什么 `contenteditable` 不能直接写 `textContent`（2026-09-18 修）：Lexical / ProseMirror /
 * Slate 这类富文本框架（AI 问答页输入框的主流实现）监听的是 `beforeinput`，赋值 `textContent`
 * 不会触发它 —— 框架内部状态不更新、发送按钮不亮，模型以为填好了其实没填进去。
 * `Input.insertText` 走浏览器原生输入管线（与真人键入同一条路），会派发 `beforeinput`/`input`，
 * 框架才认。它的语义是「在选区处插入」而不是「设为」，所以必须先把已有内容全选，否则新值会被
 * 拼接到旧内容后面。
 */
const FILL_FUNCTION = 'function (value) {'
  + ' const element = this;'
  + ' if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {'
  + '   const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;'
  + '   const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");'
  + '   if (descriptor && descriptor.set) { descriptor.set.call(element, value); } else { element.value = value; }'
  + '   element.dispatchEvent(new Event("input", { bubbles: true }));'
  + '   element.dispatchEvent(new Event("change", { bubbles: true }));'
  + '   return "value";'
  + ' }'
  + ' if (element.isContentEditable === true) {'
  + '   element.focus();'
  + '   const selection = window.getSelection();'
  + '   if (selection) {'
  + '     const range = document.createRange();'
  + '     range.selectNodeContents(element);'
  + '     selection.removeAllRanges();'
  + '     selection.addRange(range);'
  + '   }'
  + '   return "editable";'
  + ' }'
  + ' element.textContent = value;'
  + ' element.dispatchEvent(new Event("input", { bubbles: true }));'
  + ' element.dispatchEvent(new Event("change", { bubbles: true }));'
  + ' return "text"; }'

/** `webpage_press` 认得的键：名字 → CDP 键参数。 */
const KNOWN_KEYS: ReadonlyMap<string, { key: string; code: string; virtualKeyCode: number; text?: string }> = new Map([
  ['Enter', { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' }],
  ['Tab', { key: 'Tab', code: 'Tab', virtualKeyCode: 9 }],
  ['Escape', { key: 'Escape', code: 'Escape', virtualKeyCode: 27 }],
  ['Backspace', { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8 }],
  ['Delete', { key: 'Delete', code: 'Delete', virtualKeyCode: 46 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 }],
  ['Home', { key: 'Home', code: 'Home', virtualKeyCode: 36 }],
  ['End', { key: 'End', code: 'End', virtualKeyCode: 35 }],
  ['PageUp', { key: 'PageUp', code: 'PageUp', virtualKeyCode: 33 }],
  ['PageDown', { key: 'PageDown', code: 'PageDown', virtualKeyCode: 34 }],
  [' ', SPACE_KEY],
  // 命名键别名：工具描述与错误文案都写的是 `Space`，必须真的收 —— 否则模型照描述写
  // `key: "Space"` 会被判成 unsupported key，看起来就是「这个插件按不了空格」。
  ['Space', SPACE_KEY],
])

/**
 * 把模型给的键名收窄成 CDP 键参数。
 * @param key - `Enter` / `Tab` / `ArrowDown` … 或单个可打印字符。
 * @throws `BROWSER_PROTOCOL_ERROR`：多字符且不在已知名单里（模型该换个写法重试）。
 */
function describeKey(key: string): { key: string; code: string; virtualKeyCode: number; text?: string } {
  const known = KNOWN_KEYS.get(key)
  if (known !== undefined) return known
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      virtualKeyCode: key.toUpperCase().charCodeAt(0),
      text: key,
    }
  }
  throw new BrowserError(
    `unsupported key "${key}"; use a named key (Enter, Tab, Escape, Backspace, Delete, `
    + 'ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space) or a single character',
    'BROWSER_PROTOCOL_ERROR',
  )
}

/** 收窄 `limit`：缺省 / 非法落到默认值，过大压到 {@link MAX_P2_LIMIT}。 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_P2_LIMIT
  return Math.min(Math.floor(limit), MAX_P2_LIMIT)
}

/**
 * 把过大的结果压成一段截断字符串。
 *
 * 逃生舱可能返回极大的对象（`DOM.getDocument{depth:-1}`、完整 AX 树），直接塞进工具结果会
 * 撑爆模型上下文。这里统一设一个上限：超了就退化成「JSON 文本 + 截断说明」，并在回执里标
 * `truncated`。注意退化后 `value` / `result` 的类型从对象变成字符串 —— schema 声明的是
 * 任意 JSON，两者都合法。
 */
function capResult(value: unknown): { payload: unknown; truncated: boolean } {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = undefined
  }
  if (serialized === undefined || serialized.length <= EXECUTE_MAX_RESULT_CHARS) {
    return { payload: value, truncated: false }
  }
  const overflow = serialized.length - EXECUTE_MAX_RESULT_CHARS
  return {
    payload: `${serialized.slice(0, EXECUTE_MAX_RESULT_CHARS)}\n...[truncated ${overflow} chars]`,
    truncated: true,
  }
}

/** 把 `navigationSettled` 的探测结果从 `unknown` 收窄成结构化状态。 */function readNavigationState(value: unknown): { ready: boolean; href: string } | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record: Record<string, unknown> = { ...parsed }
  const ready = record['ready']
  const href = record['href']
  return typeof ready === 'boolean' && typeof href === 'string' ? { ready, href } : undefined
}

/** 可取消的 sleep。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new BrowserError('the operation was aborted', 'BROWSER_CONNECTION_LOST'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal === undefined) return
    if (signal.aborted) {
      clearTimeout(timer)
      reject(signal.reason ?? new BrowserError('the operation was aborted', 'BROWSER_CONNECTION_LOST'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 从 PNG 的 IHDR 里读宽高。
 *
 * 不额外发一次 `Page.getLayoutMetrics`：真正要落盘的是这张图的像素尺寸，
 * 而 IHDR 就是它的权威来源（`Page.getLayoutMetrics` 给的是 CSS 像素，两者在
 * devicePixelRatio ≠ 1 时并不相等）。
 */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]
  const signatureMatches = PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  if (!signatureMatches || bytes.length < 24) {
    throw new BrowserError('the captured screenshot is not a PNG image', 'BROWSER_PROTOCOL_ERROR')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * 校验 provider 配置里的数值项。端点由构造函数校验（那里也会补齐默认值）。
 * @param config - 原始配置。
 * @throws 端点非法或数值超时非正时抛普通 `Error`（属于部署配置错误，不是模型可恢复的浏览器错误）。
 */
export function validateProviderConfig(config: CdpProviderConfig = {}): void {
  validateEndpoint(config.endpoint ?? DEFAULT_CONFIG.endpoint)
  for (const [name, value] of Object.entries({
    commandTimeoutMs: config.commandTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    navigationTimeoutMs: config.navigationTimeoutMs,
    probeTtlMs: config.probeTtlMs,
    waitTimeoutMs: config.waitTimeoutMs,
  })) {
    if (value === undefined) continue
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`browser-cdp: ${name} must be a positive finite number`)
    }
  }
}
