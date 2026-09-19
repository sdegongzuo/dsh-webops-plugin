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
  BrowserMutationTarget,
  BrowserNavigateRequest,
  BrowserOcclusion,
  BrowserNetworkRequest,
  BrowserNetworkResult,
  BrowserObservation,
  BrowserObserveRequest,
  BrowserOpenRequest,
  BrowserProvider,
  BrowserRevalidateFailure,
  BrowserRevalidateRequest,
  BrowserRevalidateResult,
  BrowserSession,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTabInfo,
  BrowserTabsRequest,
  BrowserTabsResult,
} from '../browser/types.ts'
import { RefRegistry } from './refs.ts'
import { TargetStateRegistry } from './state.ts'
import type { RefTarget } from './refs.ts'
import {
  boundsToBox,
  boxesIntersect,
  buildOutline,
  DEFAULT_SNAPSHOT_LIMITS,
  filterAxTreeByBackendIds,
  renderOutline,
  resolveSnapshotLimits,
} from './snapshot.ts'
import type { AxNode, BoxRect, SnapshotLimits } from './snapshot.ts'
import { renderOverlayNotice } from './snapshot.ts'
import { HttpCdpTransport } from './protocol.ts'
import type { CdpConnection, CdpTarget, CdpTransport } from './protocol.ts'
import { ConsoleCollector, CONSOLE_RING_CAPACITY } from './console.ts'
import { NetworkCollector, NETWORK_TABLE_CAPACITY } from './network.ts'
import { assertExecuteAllowed, extractEvaluateException, extractEvaluateValue, translateEvaluateError } from './execute.ts'
import { validateEndpoint, validateTargetUrl } from './url-policy.ts'
import { StaleRefMetrics } from './metrics.ts'

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
  /** `until: 'stable'` 的 DOM/网络安静窗口（毫秒）。默认 500。 */
  readonly stableQuietWindowMs?: number
  /** `until: 'stable'` 网络忙宽限期（毫秒）。默认 3000。 */
  readonly stableNetworkGraceMs?: number
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
  readonly stableQuietWindowMs: number
  readonly stableNetworkGraceMs: number
}

const DEFAULT_CONFIG: ResolvedConfig = {
  endpoint: DEFAULT_CDP_ENDPOINT,
  commandTimeoutMs: 30_000,
  requestTimeoutMs: 5_000,
  navigationTimeoutMs: 15_000,
  probeTtlMs: 1_000,
  snapshotLimits: DEFAULT_SNAPSHOT_LIMITS,
  waitTimeoutMs: 10_000,
  stableQuietWindowMs: 500,
  stableNetworkGraceMs: 3_000,
}

/** `wait` 的纯等待上限（毫秒）；再长就是部署配错了。`until: 'stable'` 默认也用这个。 */
export const MAX_WAIT_TIME_MS = 30_000

/** `until: 'stable'` 连续安静窗口数（每个窗口 {@link ResolvedConfig.stableQuietWindowMs}）。 */
const STABLE_QUIET_WINDOWS = 2

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

/**
 * `mouseWheel` 单独用的回包等待上限（毫秒）。
 *
 * 为什么与 `commandTimeoutMs`（30s）脱钩：滚轮事件在 Electron / 后台标签上**可能根本不回包**，
 * 而工具的观察超时也是 30s —— 不脱钩时一次 `webpage_scroll` 就把 agent 卡满 30s（J6）。
 * 2s 是「够真浏览器回一次包」与「不至于让模型干等」之间的折中。
 *
 * **超时不是失败**：事件已经投递出去了，只是不知道页面有没有滚。回执照给，位置让模型自己去
 * 确认（snapshot / locate），总比「工具超时、模型什么都不知道」强。
 */
export const WHEEL_ACK_TIMEOUT_MS = 2_000

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

/**
 * 一个会话的**控制权**归属（方案 §6.5 的人工接管按钮）。
 *
 * 与 `SessionState.takeover` 是两个独立的信号，**别合并**：
 * - `holder` 是**声明** —— 人按了按钮，明说「现在换我操作」，它决定 agent 能不能动手；
 * - `takeover` 是**观测** —— 有人开着 DevTools，只影响 snapshot 回执里的提示。
 *
 * 合并的后果是真实的：「人在接管期间开一次 DevTools 又关掉」会把他自己的接管一起撤掉。
 */
export type BrowserHolder = 'agent' | 'human'

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
   * §6.5 控制权：谁在操作这个页面。
   *
   * `'agent'`（默认）时本会话的写操作全放行；`'human'` 时（人在标签条上按了「接管」）
   * 写操作一律拒（`BROWSER_HUMAN_HOLDING`），且 ref 纪元在**切换那一刻**就已作废 ——
   * 所以交还之后也不能复用接管前的号，必须重拍快照（判据 J5/J6）。
   */
  holder: BrowserHolder
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

/** `Page.getNavigationHistory` 的返回体（`back` / `forward` 要用）。 */
interface NavigationHistoryResult {
  readonly currentIndex?: number
  readonly entries?: readonly { readonly id: number; readonly url?: string }[]
}

/** `Page.captureScreenshot` 的返回体。 */
interface CaptureResult {
  readonly data?: string
}

/** `Accessibility.getFullAXTree` 的返回体。 */
interface AxTreeResult {
  readonly nodes?: readonly AxNode[]
}

/** `Page.getFrameTree` 的返回体；只取主 frame 的 `loaderId`（url 不同源，见 `readMainLoaderId`）。 */
interface FrameTreeResult {
  readonly frameTree?: { readonly frame?: { readonly loaderId?: string } }
}

/** `Page.getLayoutMetrics` 的视口矩形。 */
interface LayoutViewportMetrics {
  readonly pageX?: number
  readonly pageY?: number
  readonly clientWidth?: number
  readonly clientHeight?: number
}

interface LayoutMetricsResult {
  readonly visualViewport?: LayoutViewportMetrics
  readonly cssVisualViewport?: LayoutViewportMetrics
  readonly layoutViewport?: LayoutViewportMetrics
  readonly cssLayoutViewport?: LayoutViewportMetrics
}

/** `DOMSnapshot.captureSnapshot` 的布局树。 */
interface CaptureSnapshotResult {
  readonly documents?: readonly {
    readonly nodes?: { readonly backendNodeId?: readonly number[] }
    readonly layout?: {
      readonly nodeIndex?: readonly number[]
      readonly bounds?: readonly (readonly number[])[]
    }
  }[]
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
   * @param signal - 取消信号。
   * @returns 收编好的会话。
   */
  protected async adoptSession(target: CdpTarget, signal?: AbortSignal): Promise<BrowserSession> {
    const connection = await this.transport.connect(target.webSocketDebuggerUrl, signal)
    const session: SessionState = {
      targetId: target.id,
      connection,
      refs: new RefRegistry({ onStale: reason => { this.metrics.noteStale(target.id, reason) } }),
      // 与 open() 同序：采集器在构造时订阅事件，必须赶在 enable 之前建好。
      consoleCollector: new ConsoleCollector(connection),
      networkCollector: new NetworkCollector(connection),
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
    const target = wantsUrl ? validateTargetUrl(request.url as string) : request.history as string
    const loaded = wantsHistory
      ? await this.navigateHistory(session, request.history as 'back' | 'forward' | 'reload', previousUrl, signal)
      : await this.navigateTo(session.connection, target, previousUrl, signal)
    // 导航无论成功与否都作废既有 ref —— 页面已经变了，旧 ref 指向的东西不再可信。
    session.refs.invalidate()
    const meta = await this.readPageMeta(session.connection, signal)
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
      this.noteDocumentChange(session)
    }
    if (!loaded) {
      throw new BrowserError(
        `navigation to ${target} did not finish loading within ${this.config.navigationTimeoutMs} ms; the page may still be loading`,
        'BROWSER_NAVIGATION_FAILED',
      )
    }
    // 加载完成即算「新文档能用」：读到空标题说明这页面本来就没有 <title>，不必再等。
    if (session.title.length === 0) await this.settleDocument(session, signal)
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
      return this.waitForDocument(session.connection, signal, this.config.navigationTimeoutMs)
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
    return this.waitForNavigation(session.connection, previousUrl, signal, this.config.navigationTimeoutMs)
  }

  /** @inheritdoc */
  async observe(request: BrowserObserveRequest, signal?: AbortSignal): Promise<BrowserObservation> {
    const session = this.require(request.sessionId)
    return request.kind === 'snapshot'
      ? this.snapshot(session, signal, request.maxLines, request.region)
      : this.screenshot(session, request.ref, request.fullPage ?? false, signal)
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
    const loaderId = await this.readMainLoaderId(session, signal)
    const restored: { ref: string; role: string; name: string }[] = []
    const failed: BrowserRevalidateFailure[] = []
    const pending: RefTarget[] = []
    for (const ref of request.refs) {
      const outcome = await this.revalidateOne(session, ref, loaderId, signal)
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
      const meta = missingEpochUrl ? await this.readPageMeta(session.connection, signal) : undefined
      session.refs.restore(pending, meta?.url)
    }
    return {
      kind: 'revalidate',
      sessionId: session.targetId,
      epoch: session.refs.currentEpoch,
      restored,
      failed,
    }
  }

  /** @inheritdoc */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    // 幂等：重复关闭不是错误。
    if (session === undefined) return
    this.sessions.delete(sessionId)
    // §6.5：会话没了，它的控制权簿记也一并清掉，别把接管窗口留在表里。
    this.stateRegistry.forget(sessionId)
    // P0：会话结束就是这一份计数的收口点（「每会话一份 JSONL」，见 metrics.ts）。
    await this.metrics.flush(sessionId, session.refs.currentEpoch)
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
    this.assertWritable(session)
    this.metrics.noteRefCall(session.targetId)
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
    this.assertWritable(session)
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
    this.metrics.noteRefCall(session.targetId)
    // 纪元校验走既有 resolve 路径：从未观察 → BROWSER_SNAPSHOT_REQUIRED，旧纪元 → BROWSER_STALE_REF。
    const target = session.refs.resolve(request.ref)
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    // 映射统一走 `resolveBackendNodeId`（detach / 连接丢失照原码上抛，其余算 ref 失效）——
    // 这里原本自己写了一份，抽出去之后 mutate 与 elementClip 才用得上同一个口径。
    const objectId = await this.resolveBackendNodeId(session, request.ref, target.backendNodeId, signal)
    if (objectId === undefined) {
      this.metrics.noteStale(session.targetId, 'node_gone')
      throw new BrowserError(
        `the element for ref "${request.ref}" is no longer attached to the document; run webpage_snapshot again`,
        'BROWSER_STALE_REF',
        { reason: 'node_gone' },
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
        this.metrics.noteStale(session.targetId, 'detached')
        throw new BrowserError(
          `the element for ref "${request.ref}" was removed from the document (the page may have `
          + 're-rendered); run webpage_snapshot again',
          'BROWSER_STALE_REF',
          { reason: 'detached' },
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
    // P0：`close()` 之外还有这条路会结束会话（卸载），计数同样要收口。
    await Promise.all(sessions.map(session =>
      this.metrics.flush(session.targetId, session.refs.currentEpoch)))
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
    if (session === undefined) return
    session.takeover = active
    // 目标级状态的粗粒度让渡（方案 2.3.1 来源①）：人在 DevTools 里操作期间，这个会话的
    // target 级状态整体算 human 所有。与下一条按钮的账**分开记**（reason 不同），各自撤销、
    // 互不覆盖 —— 为什么不能合成一个布尔，见 `state.ts` 里 `takeovers` 的注释。
    this.stateRegistry.markTakeover(sessionId, active, 'devtools')
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
   * 观察：可访问性树 → 大纲 → 分配 ref（推进纪元）。
   *
   * `maxLines` 只有调用方显式给时才改限额（见 {@link resolveSnapshotLimits}：行数预算和字符
   * 预算一起抬，否则只抬一半会「我调大了还是截断」。长文页默认 800 行必截，这是报告 S3 的
   * 原始问题 —— 现在模型可以自己要求多看几屏）。
   */
  private async snapshot(
    session: SessionState,
    signal?: AbortSignal,
    maxLines?: number,
    region?: Extract<BrowserObserveRequest, { kind: 'snapshot' }>['region'],
  ): Promise<BrowserSnapshot> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    const regionKinds = [
      region?.ref !== undefined,
      region?.viewport === true,
      region?.box !== undefined,
    ].filter(Boolean).length
    if (regionKinds > 1) {
      throw new BrowserError(
        'region.ref, region.viewport and region.box are mutually exclusive; pass exactly one',
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    const regional = regionKinds === 1
    let nodes: readonly AxNode[]
    let outsideRegion: number | undefined
    if (region?.ref !== undefined) {
      const target = session.refs.resolve(region.ref)
      const partial = await session.connection.send<AxTreeResult>(
        'Accessibility.getPartialAXTree',
        { backendNodeId: target.backendNodeId },
        options,
      )
      nodes = partial.nodes ?? []
      const full = await session.connection.send<AxTreeResult>('Accessibility.getFullAXTree', {}, options)
      const fullRows = buildOutline(full.nodes ?? [], resolveSnapshotLimits(this.config.snapshotLimits, maxLines)).rows.length
      const partRows = buildOutline(nodes, resolveSnapshotLimits(this.config.snapshotLimits, maxLines)).rows.length
      outsideRegion = Math.max(0, fullRows - partRows)
    } else if (region?.viewport === true || region?.box !== undefined) {
      const full = await session.connection.send<AxTreeResult>('Accessibility.getFullAXTree', {}, options)
      const keep = await this.backendIdsInRegion(session, region, signal)
      nodes = filterAxTreeByBackendIds(full.nodes ?? [], keep)
      const limits = resolveSnapshotLimits(this.config.snapshotLimits, maxLines)
      const fullRows = buildOutline(full.nodes ?? [], limits).rows.length
      const partRows = buildOutline(nodes, limits).rows.length
      outsideRegion = Math.max(0, fullRows - partRows)
    } else {
      const tree = await session.connection.send<AxTreeResult>('Accessibility.getFullAXTree', {}, options)
      nodes = tree.nodes ?? []
    }
    const outline = buildOutline(nodes, resolveSnapshotLimits(this.config.snapshotLimits, maxLines))
    // 全页快照才查浮层：区域快照本来就是「只看这一块」，中心被别的块盖住不算异常。
    const overlay = regional ? undefined : await this.detectOverlay(session, signal)
    // 地址与 `loaderId` 必须**随这一份 ref 表一起落地**、不能延后再读（粗门比的就是「发布那一刻的地址」，
    // 晚一步会把人工之间的导航记成快照状态，方案 §5.1.1）。「一起」不是「同一瞬间」：粗门是启发式不是事务。
    const meta = await this.readPageMeta(session.connection, signal)
    const loaderId = regional ? undefined : await this.readMainLoaderId(session, signal)
    const publication = regional
      ? session.refs.adopt(outline.rows)
      : session.refs.publish(outline.rows, outline.truncated, loaderId, meta?.url)
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
      outline: overlay === undefined
        ? renderOutline(outline, publication.refs)
        : `${renderOverlayNotice(overlay)}\n${renderOutline(outline, publication.refs)}`,
      // 折叠前的完整大纲：`webpage_find` 的检索底稿。折叠标记承诺「用 find 拿全部实例的 ref」，
      // 前提是 find 手上那份底稿里一个实例都不少（`rows` 本来就是全量的，这里只是把它渲染出来）。
      fullOutline: renderOutline(outline, publication.refs, { unfoldRepeats: true }),
      refs: session.refs.list(),
      truncated: publication.truncated,
      outlineLines: outline.lines.length,
      ...outline.truncated ? { droppedElements: outline.droppedElements } : {},
      ...outline.foldedRepeats > 0 ? { foldedRepeats: outline.foldedRepeats } : {},
      ...outline.dedupedLines > 0 ? { dedupedLines: outline.dedupedLines } : {},
      ...outsideRegion !== undefined ? { outsideRegion } : {},
      // 人工接管只加提示，**不动 epoch** —— 开合 DevTools 不该作废模型的 ref（[V31]）。
      ...session.takeover ? { takeover: true } : {},
    }
  }

  /**
   * 查「视口中心是不是被一层浮层盖着」（B2-d）。
   *
   * 为什么需要它：没有 `role=dialog` 的浮层在 AX 里排在 `<body>` **末尾**，而小 `max_lines`
   * 会把它整段截掉 —— 于是模型拿到的第一屏看起来「页面可以直接点正文」，一点才发现点在遮罩上。
   *
   * 判定用「命中链上有没有一个 fixed/absolute 且盖住视口 60% 以上的祖先」而不是方案原文写的
   * 「命中行是否在前 30 行」：后者要靠 `DOM.requestNode` + `DOM.describeNode` 把命中元素换成
   * `backendNodeId` 再查 ref 表（多两条命令），且对**已截断**的大纲仍只能靠文本猜行号 ——
   * 花三倍代价换一个更脆的信号，不值。定位覆盖判据是纯 CSS 事实，与大纲怎么切无关。
   *
   * 失败/查不出来一律当「没有浮层」：这是回执增强，不许把快照打成失败。
   */
  private async detectOverlay(session: SessionState, signal?: AbortSignal): Promise<OverlayProbe | undefined> {
    try {
      const evaluated = await session.connection.send<EvaluateResult>(
        'Runtime.evaluate',
        { expression: OVERLAY_PROBE_EXPRESSION, returnByValue: true },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      const value = evaluated.result?.value as Partial<OverlayProbe> | null | undefined
      if (value === null || typeof value !== 'object') return undefined
      // 页面里那份脚本的返回体是**不可信数据**（页面可以改写 `elementFromPoint` 之类的东西），
      // 字段一律按字符串收下；三项全空就当没查到。
      const role = typeof value.role === 'string' ? value.role : ''
      const name = typeof value.name === 'string' ? value.name : ''
      const hint = typeof value.hint === 'string' ? value.hint : ''
      if (role.length === 0 && name.length === 0 && hint.length === 0) return undefined
      return { role, name, hint }
    } catch {
      return undefined
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
      clip = await this.elementClip(session, ref, target.backendNodeId, signal)
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
  private async elementClip(
    session: SessionState,
    ref: string,
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<ScreenshotClip> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    // 与 mutate 同一口径：`DOM.resolveNode` 对已消失的节点是**抛错**，
    // 这里以前只兜「返回体缺 objectId」，同样会漏成裸协议错误。
    const objectId = await this.resolveBackendNodeId(session, ref, backendNodeId, signal)
    if (objectId === undefined) {
      this.metrics.noteStale(session.targetId, 'node_gone')
      throw new BrowserError(
        'the observed element is no longer attached to the document; run webpage_snapshot again',
        'BROWSER_STALE_REF',
        { reason: 'node_gone' },
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
   * 读主 frame 的文档身份（`loaderId`）。读不到当身份未知：`revalidate` 会拒绝而不是误绑。
   *
   * 这里**不**顺带返回 `frame.url`（第 3 批曾合并成一次读，第 4 批撤回）：`Page.getFrameTree`
   * 的 url 是浏览器进程侧的镜像，而写前门比的是 renderer 的 `window.top.location.href`，
   * 两者在导航在飞 / 重定向 / 特权页上会差一档。需要纪元地址时一律走
   * {@link readPageMeta}，宁多一次往返也不要不同源的基线。
   */
  private async readMainLoaderId(
    session: SessionState,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const tree = await session.connection.send<FrameTreeResult>(
        'Page.getFrameTree',
        {},
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      const loaderId = tree.frameTree?.frame?.loaderId
      return typeof loaderId === 'string' && loaderId.length > 0 ? loaderId : undefined
    } catch (error: unknown) {
      if (error instanceof BrowserError
        && (error.code === 'BROWSER_DEBUGGER_DETACHED' || error.code === 'BROWSER_CONNECTION_LOST')) {
        throw error
      }
      return undefined
    }
  }

  /**
   * 恢复一条 ref。当前表命中直接算成功；归档命中才走 loaderId → resolveNode → role/name。
   */
  private async revalidateOne(
    session: SessionState,
    ref: string,
    loaderId: string | undefined,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; target: RefTarget; restore: boolean }
    | { ok: false; reason: BrowserRevalidateFailure['reason'] }
  > {
    try {
      const current = session.refs.resolve(ref)
      return { ok: true, target: current, restore: false }
    } catch (error: unknown) {
      if (error instanceof BrowserError && error.code === 'BROWSER_SNAPSHOT_REQUIRED') throw error
      if (!(error instanceof BrowserError) || error.code !== 'BROWSER_STALE_REF') throw error
    }
    const archived = session.refs.archived(ref)
    if (archived === undefined) return { ok: false, reason: 'not_archived' }
    // 文档身份是第一道门：对不上就停，不看 backendNodeId。
    if (archived.loaderId === undefined || loaderId === undefined || archived.loaderId !== loaderId) {
      return { ok: false, reason: 'document_changed' }
    }
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    let objectId: string | undefined
    try {
      objectId = await this.resolveNodeObjectId(session, archived.target.backendNodeId, signal)
    } catch (error: unknown) {
      if (error instanceof BrowserError
        && (error.code === 'BROWSER_DEBUGGER_DETACHED' || error.code === 'BROWSER_CONNECTION_LOST')) {
        throw error
      }
      this.metrics.noteStale(session.targetId, 'node_gone')
      return { ok: false, reason: 'node_gone' }
    }
    if (objectId === undefined) {
      this.metrics.noteStale(session.targetId, 'node_gone')
      return { ok: false, reason: 'node_gone' }
    }
    try {
      const connected = await session.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: 'function () { return this.isConnected; }', returnByValue: true },
        options,
      )
      if (connected.result?.value !== true) {
        this.metrics.noteStale(session.targetId, 'detached')
        return { ok: false, reason: 'node_gone' }
      }
    } finally {
      this.releaseObject(session, objectId, signal)
    }
    const partial = await session.connection.send<AxTreeResult>(
      'Accessibility.getPartialAXTree',
      { backendNodeId: archived.target.backendNodeId },
      options,
    )
    const live = axIdentity(partial.nodes ?? [], archived.target.backendNodeId)
    if (live === undefined
      || live.role !== archived.target.role
      || live.name !== archived.target.name) {
      this.metrics.noteStale(session.targetId, 'identity_mismatch')
      return { ok: false, reason: 'identity_mismatch' }
    }
    return { ok: true, target: archived.target, restore: true }
  }

  /** 视口 / 几何矩形：用一次 captureSnapshot 的布局盒与区域求交，得到 backendNodeId 集合。 */
  private async backendIdsInRegion(
    session: SessionState,
    region: { readonly viewport?: boolean; readonly box?: BoxRect },
    signal?: AbortSignal,
  ): Promise<Set<number>> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    let area: BoxRect | undefined = region.box
    if (area === undefined) {
      const metrics = await session.connection.send<LayoutMetricsResult>('Page.getLayoutMetrics', {}, options)
      area = viewportBoxFromMetrics(metrics)
    }
    if (area === undefined) return new Set()
    const captured = await session.connection.send<CaptureSnapshotResult>(
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [] },
      options,
    )
    const keep = new Set<number>()
    for (const document of captured.documents ?? []) {
      const ids = document.nodes?.backendNodeId ?? []
      const indexes = document.layout?.nodeIndex ?? []
      const bounds = document.layout?.bounds ?? []
      for (let index = 0; index < indexes.length; index += 1) {
        const nodeIndex = indexes[index]
        const raw = bounds[index]
        const box = raw === undefined ? undefined : boundsToBox(raw)
        if (nodeIndex === undefined || box === undefined) continue
        if (!boxesIntersect(area, box)) continue
        const backend = ids[nodeIndex]
        if (typeof backend === 'number') keep.add(backend)
      }
    }
    return keep
  }

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
   * 按 `backendNodeId` 取句柄，并**把「节点没了」统一映射成 `BROWSER_STALE_REF`**。
   *
   * 为什么需要这一步（`resolveNodeObjectId` 的契约把映射留给调用方，而三个调用方里
   * 只有 `locate` 做了 —— 另两个漏了，于是模型收到的是一个**没有恢复指引的裸协议错误**）：
   *
   * - CDP 对不存在的节点走的是**抛错**，不是「成功返回但没带 `object`」。实测两种话术：
   *   `No node with given id found`（会话 f6b89609 的 `[4.1]`）与
   *   `Node with given id does not belong to the document`（`scripts/probe-stale-node.ts` 重放，
   *   同 URL 整页刷新后再用旧 ref）。两条都是 `-32000`，都带 `BROWSER_PROTOCOL_ERROR`。
   * - 所以 `resolveNodeObjectId` 里那个 `objectId === undefined` 分支**兜不住它们**，
   *   异常直接穿透到工具层 → 模型看到 `CDP error: …`，既不知道页面变了、也不知道该重拍。
   *   这正是 §5.1 注释里「地址不变的整页刷新已由 resolveNode 兜成 BROWSER_STALE_REF」
   *   那句话的**反面**：当初 22/22 量的是「解析失败与否」，没量「失败翻成什么码」。
   *
   * **会话级失败照原码上抛**：detach（`[V16]`）与连接丢失不是 ref 失效，
   * 让模型「重拍快照」是错的指引（`locate` 早已按这个分寸写，这里保持一致）。
   */
  private async resolveBackendNodeId(
    session: SessionState,
    ref: string,
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return await this.resolveNodeObjectId(session, backendNodeId, signal)
    } catch (error: unknown) {
      if (error instanceof BrowserError
        && (error.code === 'BROWSER_DEBUGGER_DETACHED' || error.code === 'BROWSER_CONNECTION_LOST')) throw error
      this.metrics.noteStale(session.targetId, 'node_gone')
      throw new BrowserError(
        `the element for ref "${ref}" is gone from the document; run webpage_snapshot again`,
        'BROWSER_STALE_REF',
        { cause: error, reason: 'node_gone' },
      )
    }
  }

  /**
   * 把 ref 解析成远端对象句柄。
   *
   * **第一步**就是查纪元表：ref 失效（或从未 snapshot）时这里直接抛
   * `BROWSER_STALE_REF` / `BROWSER_SNAPSHOT_REQUIRED`，后面的 CDP 命令一条都
   * 不会发 —— 这就是「写前检查纪元」。
   *
   * `allowDetached`：`webpage_wait` 的 hidden 分支**以「元素消失」为成功条件**，
   * 细门在这里不能拦（否则永远等不到 satisfied）。粗门照查。
   */
  private async resolveObjectId(
    session: SessionState,
    ref: string,
    signal?: AbortSignal,
    options?: { allowDetached?: boolean },
  ): Promise<string> {
    const target = session.refs.resolve(ref)
    // 走 `resolveBackendNodeId` 而不是裸调 `resolveNodeObjectId`：后者把「节点没了」的
    // 两种形态分开处理，映射交给调用方 —— 这一处以前漏了，裸协议错误会一路穿透到模型。
    const objectId = await this.resolveBackendNodeId(session, ref, target.backendNodeId, signal)
    if (objectId === undefined) {
      this.metrics.noteStale(session.targetId, 'node_gone')
      throw new BrowserError(
        'the observed element is no longer attached to the document; run webpage_snapshot again',
        'BROWSER_STALE_REF',
        { reason: 'node_gone' },
      )
    }
    await this.assertPreActionGate(session, ref, objectId, signal, options?.allowDetached === true)
    return objectId
  }

  /**
   * **写前门**（方案 §5.1）：动作派发之前，拿手上的句柄核一次「页面还是不是我拍快照那一刻」。
   *
   * 为什么必须有它：`refs.resolve` 只保证「ref 属于当前纪元」，而当前纪元可能在模型
   * 决策期间就被人工换成了另一份文档 —— 同文档 SPA 路由连 `backendNodeId` 都不重编
   * （方案 §1.4），于是旧 ref 会静默命中新页面上的另一个元素。这里是**唯一还来得及拦**的时刻。
   *
   * 三档的实际落点（都比 D-3 批的「+1 次往返」不多花）：
   * - **粗门 `url`**：与 `refs.publishedUrl` 比对（D-6=B，按纪元存一条）。
   * - **细门 `isConnected`**：`[V36]` 实测「resolveNode 成功 ≠ 节点还在文档里」，
   *   这一档此前只有 `locate` 查，mutate 路径是漏的。
   * - **中门 `loaderId` 不单独花一次往返**，因为它能抓到而粗门抓不到的只有一类
   *   （地址不变的整页刷新），而那一类新文档会让旧 `backendNodeId` 解析失败 ——
   *   上面 `resolveNodeObjectId` 已经把它兜成 `BROWSER_STALE_REF`（实测 22/22 失败，方案 §10.4）。
   *   **它兜不住的是同文档重排**：role/name 档才管得到，那是已知剩余漏报区间，
   *   与 `locate` 的口径一致（见该方法的注释），不在本轮补。
   *
   * 读不到值（页面上下文异常、evaluate 抛错）时**放行**：门只负责「证据确凿就拦」，
   * 拿不到证据不该把一次正常操作变成失败 —— 交给既有守卫和动作后的 `detectNavigation`。
   *
   * @throws `BROWSER_STALE_REF` —— 此时**一个输入事件都还没派发**。
   */
  private async assertPreActionGate(
    session: SessionState,
    ref: string,
    objectId: string,
    signal?: AbortSignal,
    allowDetached = false,
  ): Promise<void> {
    const publishedUrl = session.refs.publishedUrl
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.callFunctionOn',
      {
        objectId,
        // 比对的是「纪元记录的地址 vs 当下**顶层文档**的地址」：纪元地址出自顶层的
        // `readPageMeta`，而 `location.href` 取的是元素自己那个文档 —— 直接比它会让 iframe 里的元素
        // 必然「地址变了」。读 `window.top.location.href` 对同文档子 frame 仍然有效。
        // 那个 try 不是为了让粗门多覆盖一档（跨源读不到照样放行），而是为了**同一次往返仍带回
        // `isConnected`**：不兜住异常，跨源 frame 里连细门都会一起静默。
        functionDeclaration: 'function () { let top = null; try { top = window.top.location.href; } catch (e) { top = null; } return { url: top, connected: this.isConnected }; }',
        returnByValue: true,
      },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    ).catch(() => undefined)
    const value = evaluated?.result?.value
    if (typeof value !== 'object' || value === null) return
    const { url, connected } = value as Record<string, unknown>
    if (
      publishedUrl !== undefined
      && typeof url === 'string' && url !== '' && url !== publishedUrl
    ) {
      // 文档已经换掉：整个纪元的 ref 都不该再用，作废它并让模型重拍。
      session.refs.invalidate()
      this.noteDocumentChange(session)
      // 句柄是自己拿的，抛错前必须还 —— 调用方还没拿到 objectId，它的 finally 释放不到。
      this.metrics.noteStale(session.targetId, 'stale_document')
      this.releaseObject(session, objectId, signal)
      throw new BrowserError(
        `ref "${ref}" points at a stale document: the page moved from ${publishedUrl} to ${url} `
        + 'since the snapshot; the action was NOT dispatched; run webpage_snapshot again',
        'BROWSER_STALE_REF',
        { reason: 'stale_document' },
      )
    }
    if (connected === false && !allowDetached) {
      this.metrics.noteStale(session.targetId, 'detached')
      this.releaseObject(session, objectId, signal)
      throw new BrowserError(
        `the element for ref "${ref}" was removed from the document (the page may have re-rendered); `
        + 'the action was NOT dispatched; run webpage_snapshot again',
        'BROWSER_STALE_REF',
        { reason: 'detached' },
      )
    }
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

  /**
   * 点击：解析 ref → 滚到可视区 → **问一句落点上是谁** → 在元素中心派发真实的鼠标按下/抬起。
   *
   * 落点校验（B1-d）见 {@link hitTest}：浮层盖住中心时事件打在遮罩上，而旧的回执只会说
   * `click done` + `navigated=false`，模型据此去翻 console / network 猜原因。**事件照发**，
   * 只是回执里如实写上 `occluded_by`。
   */
  private async click(session: SessionState, ref: string, signal?: AbortSignal): Promise<BrowserMutationResult> {
    const beforeUrl = session.url
    const target = session.refs.resolve(ref)
    const objectId = await this.resolveObjectId(session, ref, signal)
    let hit: HitTestOutcome | undefined
    try {
      const box = await this.elementViewportBox(session, objectId, signal)
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      hit = await this.hitTest(session, objectId, point, signal)
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
    const result = await this.settleMutation(session, 'click', beforeUrl, true, signal)
    return this.describeClick(result, target, hit)
  }

  /**
   * 落点命中校验：这个点上最顶层的元素是不是目标（或其子孙）。
   *
   * 判据用 `document.elementFromPoint` —— 它就是浏览器自己派发鼠标事件时用的那套命中测试，
   * 比「比较 rect 有没有重叠」更贴近真实（重叠不等于遮挡：祖先、负 z-index、`pointer-events:none`
   * 都会让重叠但**打得中**）。
   *
   * **失败不影响动作**：这是回执增强，不是动作本身 —— 页面在极端情况下（跨源 iframe 里的
   * 元素、evaluate 被 CSP 拦）查不出来时，宁可少报一条遮挡，也不许把 click 打成失败。
   */
  private async hitTest(
    session: SessionState,
    objectId: string,
    point: { x: number; y: number },
    signal?: AbortSignal,
  ): Promise<HitTestOutcome | undefined> {
    try {
      const outcome = await session.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: HIT_TEST_FUNCTION,
          arguments: [{ value: { x: point.x, y: point.y } }],
          returnByValue: true,
        },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      const value = outcome.result?.value as HitTestOutcome | undefined
      return value?.hit === undefined ? undefined : value
    } catch {
      return undefined
    }
  }

  /** 把「点的是谁」和「被谁挡了」并进回执。两者都只在 click 上出现。 */
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
    const node = hit?.node
    const occluded: BrowserOcclusion | undefined = node === undefined || node === null
      ? undefined
      : {
        ...node.role.length > 0 ? { role: node.role } : {},
        ...node.name.length > 0 ? { name: node.name } : {},
        ...node.hint.length > 0 ? { hint: node.hint } : {},
      }
    return {
      ...result,
      target: identity,
      ...occluded !== undefined ? { occluded_by: occluded } : {},
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
    // 后台标签收不到滚轮（真实鼠标事件只送前台），先切前台；切不动就**明确拒绝**，
    // 绝不让它干等到超时 —— 那条路径以前表现为「工具超时 30s」（J6）。
    await this.ensureForeground(session, signal)
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
    const acked = await this.dispatchWheel(session, point, dx, dy, signal)
    const result = await this.settleMutation(session, 'scroll', beforeUrl, false, signal)
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

  /** 视口中心（CSS 像素）：不带 ref 的 scroll 的落点。 */
  private async viewportCenter(session: SessionState, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const size = await this.viewportSize(session, signal)
    return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) }
  }

  /** 等待：timeMs / text / ref / until:stable 四选一。 */
  private async wait(
    session: SessionState,
    request: Extract<BrowserMutationRequest, { kind: 'wait' }>,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const wantsTime = request.timeMs !== undefined
    const wantsText = request.text !== undefined && request.text.length > 0
    const wantsRef = request.ref !== undefined
    const wantsStable = request.until === 'stable'
    if ([wantsTime, wantsText, wantsRef, wantsStable].filter(chosen => chosen).length !== 1) {
      throw new BrowserError(
        'webpage_wait needs exactly one of time_ms, text, ref, or until',
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    const beforeUrl = session.url
    let satisfied = true
    let signals: BrowserMutationResult['signals']
    if (wantsStable) {
      const outcome = await this.waitUntilStable(session, request.timeoutMs, signal)
      satisfied = outcome.satisfied
      signals = outcome.signals
    } else if (request.timeMs !== undefined) {
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
      // 但「元素已脱离文档」正是本分支要等的结果，细门对它放行（allowDetached）。
      const objectId = await this.resolveObjectId(session, ref, signal, { allowDetached: true })
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
    return { ...result, satisfied, ...signals !== undefined ? { signals } : {} }
  }

  /**
   * `until: 'stable'`：readyState complete 是前置，DOM 连续两个安静窗口，
   * 网络 inflight==0 或已忙过宽限期。超时如实报 signals，不把慢页谎成稳定。
   */
  private async waitUntilStable(
    session: SessionState,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ satisfied: boolean; signals: NonNullable<BrowserMutationResult['signals']> }> {
    const deadlineMs = timeoutMs ?? MAX_WAIT_TIME_MS
    if (!(deadlineMs > 0) || deadlineMs > MAX_WAIT_TIME_MS) {
      throw new BrowserError(
        `webpage_wait timeout_ms must be between 1 and ${String(MAX_WAIT_TIME_MS)}`,
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    const windowMs = this.config.stableQuietWindowMs
    const graceMs = this.config.stableNetworkGraceMs
    await this.evaluateDomQuietInstall(session, signal)
    let quietStreak = 0
    let networkBusySince: number | undefined
    let signals: NonNullable<BrowserMutationResult['signals']> = {
      readyState: 'loading',
      dom: 'busy',
      network: 'busy',
    }
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const ready = await this.evaluateReadyComplete(session, signal)
      const mutations = await this.evaluateDomQuietRead(session, signal)
      if (mutations === 0) quietStreak += 1
      else quietStreak = 0
      const inflight = session.networkCollector.inflight
      if (inflight > 0) networkBusySince ??= Date.now()
      else networkBusySince = undefined
      const networkQuiet = inflight === 0
      const networkOk = networkQuiet
        || (networkBusySince !== undefined && Date.now() - networkBusySince >= graceMs)
      signals = {
        readyState: ready ? 'complete' : 'loading',
        dom: quietStreak >= STABLE_QUIET_WINDOWS ? 'quiet' : 'busy',
        network: networkQuiet ? 'quiet' : 'busy',
      }
      if (ready && quietStreak >= STABLE_QUIET_WINDOWS && networkOk) {
        return { satisfied: true, signals }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { satisfied: false, signals }
      await delay(Math.min(windowMs, remaining), signal)
    }
  }

  private async evaluateReadyComplete(session: SessionState, signal?: AbortSignal): Promise<boolean> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      { expression: 'document.readyState === "complete"', returnByValue: true },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    return evaluated.result?.value === true
  }

  private async evaluateDomQuietInstall(session: SessionState, signal?: AbortSignal): Promise<void> {
    await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      {
        expression: '(() => { const g = globalThis; if (g.__dsh_mut_installed === true) return true; try { g.__dsh_mut_count = 0; new MutationObserver(() => { g.__dsh_mut_count = (g.__dsh_mut_count ?? 0) + 1 }).observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true }); g.__dsh_mut_installed = true; return true } catch { return false } })()',
        returnByValue: true,
      },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
  }

  private async evaluateDomQuietRead(session: SessionState, signal?: AbortSignal): Promise<number> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      {
        expression: '(() => { const g = globalThis; const n = Number(g.__dsh_mut_count ?? 0); g.__dsh_mut_count = 0; return n })()',
        returnByValue: true,
      },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const value = evaluated.result?.value
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
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

/** 落点命中校验的结果（页面里算完带回来的一小坨描述，`hitTest` 的返回体）。 */
interface HitTestOutcome {
  /** 目标自身（或其祖先链上最近的可链接者）的绝对 href；不是链接时为 `null`。 */
  href?: string | null
  /** `target` = 落点上就是目标（或其子孙）；`other` = 被别人盖着；`none` = 落点不在视口内。 */
  hit?: 'target' | 'other' | 'none'
  /** 只在 `hit === 'other'` 时带：盖住落点的那个元素的描述。 */
  node?: { role: string; name: string; hint: string } | null
}

/**
 * 落点命中校验：问一句「这个视口坐标上最顶层的元素是谁」。
 *
 * 为什么是 `elementFromPoint` 而不是比 rect：它就是浏览器派发鼠标事件时用的那一套命中测试，
 * 「两个盒子重叠」在 CSS 里根本不等于「挡住」（祖先、`pointer-events: none`、负 z-index
 * 都是重叠但打得中）。用真实命中测试才不会把能点中的目标误报成被遮挡。
 */
const HIT_TEST_FUNCTION = 'function (point) {'
  + ' const element = this;'
  + ' const top = document.elementFromPoint(Math.round(point.x), Math.round(point.y));'
  + ' let href = null;'
  + ' try { href = (element.href && String(element.href).length > 0) ? String(element.href) : element.getAttribute("href"); } catch (e) { href = null; }'
  // 命中判定只认「就是它」与「它的子孙」；命中**祖先**算 other —— 那时鼠标事件打不到它身上。
  + ' const hit = top === null ? "none" : (top === element || element.contains(top) ? "target" : "other");'
  + ' let node = null;'
  + ' if (hit === "other" && top !== null) {'
  + '   const role = top.getAttribute("role") || String(top.tagName || "").toLowerCase();'
  + '   let name = top.getAttribute("aria-label") || top.getAttribute("alt") || "";'
  + '   if (name.length === 0) name = String(top.textContent || "").trim().slice(0, 60);'
  + '   const hint = top.id ? "#" + top.id'
  + '     : (typeof top.className === "string" && top.className.trim().length > 0'
  + '       ? "." + top.className.trim().split(/\\s+/)[0] : "");'
  + '   node = { role: role, name: name, hint: hint };'
  + ' }'
  + ' return { href: typeof href === "string" && href.length > 0 ? href : null, hit: hit, node: node };'
  + ' }'

/** 视口中心那层浮层的描述（{@link OVERLAY_PROBE_EXPRESSION} 的返回体）。 */
interface OverlayProbe {
  role: string
  name: string
  hint: string
}

/**
 * 视口中心浮层探测（B2-d）。
 *
 * 从 `elementFromPoint` 命中的那个元素往上走，找第一个「定位在浮层里」的祖先：
 *
 * - `position: fixed`，或
 * - `position: absolute` **且 `z-index` 不是 auto**
 *
 * 并且它在视口内的可见面积 ≥ 视口的 60%。三条一起才判浮层：单看「定位」会把 SPA 里
 * `position:absolute; inset:0` 的根容器（没有 z-index）算成遮罩，单看面积会把长页面里的
 * 大块正文算成浮层。
 *
 * 命中 `role=dialog` / `aria-modal` / `<dialog>` 时用**它**的名字 —— 那才是模型能认出来的东西。
 */
const OVERLAY_PROBE_EXPRESSION = '(() => {'
  + ' const vw = window.innerWidth, vh = window.innerHeight;'
  + ' if (!vw || !vh) return null;'
  + ' const top = document.elementFromPoint(Math.round(vw / 2), Math.round(vh / 2));'
  + ' if (!top) return null;'
  + ' const visible = (el) => { const r = el.getBoundingClientRect();'
  + '   const w = Math.min(r.right, vw) - Math.max(r.left, 0);'
  + '   const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);'
  + '   return w > 0 && h > 0 ? w * h : 0; };'
  + ' let node = top;'
  + ' while (node && node.nodeType === 1 && node !== document.body) {'
  + '   const style = getComputedStyle(node);'
  + '   const layered = style.position === "fixed" || (style.position === "absolute" && style.zIndex !== "auto");'
  + '   if (layered && visible(node) >= 0.6 * vw * vh) break;'
  + '   node = node.parentElement;'
  + ' }'
  + ' if (!node || node.nodeType !== 1 || node === document.body || node === document.documentElement) return null;'
  + ' const dialog = node.closest(\'[role="dialog"], [aria-modal="true"], dialog\');'
  + ' const target = dialog || node;'
  + ' const role = target.getAttribute("role") || String(target.tagName || "").toLowerCase();'
  + ' let name = target.getAttribute("aria-label") || "";'
  + ' if (name.length === 0 && dialog) name = String(target.textContent || "").trim().slice(0, 60);'
  + ' const hint = target.id ? "#" + target.id'
  + '   : (typeof target.className === "string" && target.className.trim().length > 0'
  + '     ? "." + target.className.trim().split(/\\s+/)[0] : "");'
  + ' return { role: role, name: name, hint: hint };'
  + ' })()'

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

/** 从 AX 节点读出与 snapshot 同一口径的 role/name，供 revalidate 核对。 */
function axIdentity(nodes: readonly AxNode[], backendNodeId: number): { role: string; name: string } | undefined {
  const node = nodes.find(item => item.backendDOMNodeId === backendNodeId) ?? nodes[0]
  if (node === undefined) return undefined
  const roleRaw = node.role?.value
  const role = (typeof roleRaw === 'string' ? roleRaw : 'generic').toLowerCase()
  const nameRaw = node.name?.value
  const name = typeof nameRaw === 'string' ? clipObservedName(nameRaw) : ''
  return { role, name }
}

function clipObservedName(raw: string): string {
  const text = raw.replace(/\s+/gu, ' ').trim()
  const max = DEFAULT_SNAPSHOT_LIMITS.maxTextLength
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function viewportBoxFromMetrics(metrics: LayoutMetricsResult): BoxRect | undefined {
  const view = metrics.cssVisualViewport
    ?? metrics.visualViewport
    ?? metrics.cssLayoutViewport
    ?? metrics.layoutViewport
  if (view === undefined) return undefined
  const width = view.clientWidth
  const height = view.clientHeight
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  return { x: view.pageX ?? 0, y: view.pageY ?? 0, width, height }
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
