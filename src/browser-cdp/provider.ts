/**
 * browser-cdp —— 用 Chrome DevTools Protocol 驱动浏览器的 provider。
 *
 * P0 形态：连接**用户自己开着的** Chrome（`--remote-debugging-port=<port>`），
 * 不自己下载 Chromium，也不依赖 Playwright —— 既拿到用户真实登录态，又绕开
 * 浏览器下载与构建脚本授权（pnpm 的 allowBuilds 是默认拒绝的白名单制）。
 *
 * ```text
 *   模型 → browser_* 工具 → ctx.browser → CdpBrowserProvider
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
  BrowserMutationRequest,
  BrowserMutationResult,
  BrowserNavigateRequest,
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
import { buildOutline, DEFAULT_SNAPSHOT_LIMITS, renderOutline } from './snapshot.ts'
import type { AxNode, SnapshotLimits } from './snapshot.ts'
import { HttpCdpTransport } from './protocol.ts'
import type { CdpConnection, CdpTarget, CdpTransport } from './protocol.ts'
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

/** `wait` 轮询 text / hidden 条件的间隔（毫秒）。 */
const WAIT_POLL_INTERVAL_MS = 100

/** 一个受控标签页的全部状态。 */
interface SessionState {
  readonly targetId: string
  readonly connection: CdpConnection
  readonly refs: RefRegistry
  url: string
  title: string
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
      url: target.url,
      title: target.title,
    }
    try {
      await connection.send('Page.enable', {}, { signal, timeoutMs: this.config.commandTimeoutMs })
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
    if (!loaded) {
      throw new BrowserError(
        `navigation to ${url} did not finish loading within ${this.config.navigationTimeoutMs} ms; the page may still be loading`,
        'BROWSER_NAVIGATION_FAILED',
      )
    }
    return this.toSession(session)
  }

  /** @inheritdoc */
  async observe(request: BrowserObserveRequest, signal?: AbortSignal): Promise<BrowserObservation> {
    const session = this.require(request.sessionId)
    return request.kind === 'snapshot'
      ? this.snapshot(session, signal)
      : this.screenshot(session, request.ref, request.fullPage ?? false, signal)
  }

  /** @inheritdoc */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    // 幂等：重复关闭不是错误。
    if (session === undefined) return
    this.sessions.delete(sessionId)
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
   */
  async mutate(request: BrowserMutationRequest, signal?: AbortSignal): Promise<BrowserMutationResult> {
    const session = this.require(request.sessionId)
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

  /** @inheritdoc */
  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    const results = await Promise.allSettled(sessions.map(async (session) => {
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
        `unknown browser session "${sessionId}"; open one with browser_open and reuse the session id it returns`,
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

  /** 观察：可访问性树 → 大纲 → 分配 ref（推进纪元）。 */
  private async snapshot(session: SessionState, signal?: AbortSignal): Promise<BrowserSnapshot> {
    const tree = await session.connection.send<AxTreeResult>(
      'Accessibility.getFullAXTree',
      {},
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const outline = buildOutline(tree.nodes ?? [], this.config.snapshotLimits)
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
      refs: session.refs.list(),
      truncated: publication.truncated,
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
    const params: Record<string, unknown> = { format: 'png' }
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
        'the observed element is no longer attached to the document; run browser_snapshot again',
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
   * 把 ref 解析成远端对象句柄。
   *
   * **第一步**就是查纪元表：ref 失效（或从未 snapshot）时这里直接抛
   * `BROWSER_STALE_REF` / `BROWSER_SNAPSHOT_REQUIRED`，后面的 CDP 命令一条都
   * 不会发 —— 这就是「写前检查纪元」。
   */
  private async resolveObjectId(session: SessionState, ref: string, signal?: AbortSignal): Promise<string> {
    const target = session.refs.resolve(ref)
    const resolved = await session.connection.send<ResolveNodeResult>(
      'DOM.resolveNode',
      { backendNodeId: target.backendNodeId },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const objectId = resolved.object?.objectId
    if (objectId === undefined) {
      throw new BrowserError(
        'the observed element is no longer attached to the document; run browser_snapshot again',
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
   * 取元素的视口坐标盒（先滚动到视口中央再量）。
   *
   * 用 `Runtime.callFunctionOn` + `getBoundingClientRect` 而不是 `DOM.getBoxModel`：
   * 后者给的是文档坐标，而 `Input.dispatchMouseEvent` 吃的是视口坐标；
   * 元素在视口外时文档坐标直接把事件点到看不见的地方去。
   */
  private async elementViewportBox(
    session: SessionState,
    objectId: string,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          'function () { this.scrollIntoView({ block: "center", inline: "center" });'
          + ' const rect = this.getBoundingClientRect();'
          + ' return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }',
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
    return { x, y, width, height }
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
      await session.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration:
            'function (value) {'
            + ' const element = this;'
            + ' if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {'
            + '   const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;'
            + '   const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");'
            + '   if (descriptor && descriptor.set) { descriptor.set.call(element, value); } else { element.value = value; }'
            + ' } else { element.textContent = value; }'
            + ' element.dispatchEvent(new Event("input", { bubbles: true }));'
            + ' element.dispatchEvent(new Event("change", { bubbles: true }));'
            + ' return true; }',
          arguments: [{ value }],
          returnByValue: true,
        },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
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

  /** 滚动：在元素中心派发真实的滚轮事件（滚的是元素所在的可滚动容器）。 */
  private async scroll(
    session: SessionState,
    ref: string,
    deltaX: number | undefined,
    deltaY: number | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const dx = typeof deltaX === 'number' && Number.isFinite(deltaX) ? deltaX : 0
    const dy = typeof deltaY === 'number' && Number.isFinite(deltaY) ? deltaY : 0
    if (dx === 0 && dy === 0) {
      throw new BrowserError('browser_scroll needs a non-zero deltaX or deltaY', 'BROWSER_PROTOCOL_ERROR')
    }
    const beforeUrl = session.url
    const objectId = await this.resolveObjectId(session, ref, signal)
    try {
      const box = await this.elementViewportBox(session, objectId, signal)
      await session.connection.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        deltaX: dx,
        deltaY: dy,
      }, { signal, timeoutMs: this.config.commandTimeoutMs })
    } finally {
      this.releaseObject(session, objectId, signal)
    }
    return this.settleMutation(session, 'scroll', beforeUrl, false, signal)
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
        'browser_wait needs exactly one of time_ms, text, or ref',
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    const beforeUrl = session.url
    let satisfied = true
    if (request.timeMs !== undefined) {
      if (!(request.timeMs > 0) || request.timeMs > MAX_WAIT_TIME_MS) {
        throw new BrowserError(
          `browser_wait time_ms must be between 1 and ${String(MAX_WAIT_TIME_MS)}`,
          'BROWSER_PROTOCOL_ERROR',
        )
      }
      await delay(request.timeMs, signal)
    } else if (wantsText) {
      const text = request.text as string
      satisfied = await this.pollUntil(
        signal,
        async () => {
          const evaluated = await session.connection.send<EvaluateResult>(
            'Runtime.evaluate',
            { expression: `document.body !== null && document.body.innerText.includes(${JSON.stringify(text)})`, returnByValue: true },
            { signal, timeoutMs: this.config.commandTimeoutMs },
          )
          return evaluated.result?.value === true
        },
        this.config.waitTimeoutMs,
      )
    } else {
      const ref = request.ref as string
      // hidden 语义也吃 ref 纪元：旧 ref 在这里直接抛，不会傻等一个不存在的元素。
      const objectId = await this.resolveObjectId(session, ref, signal)
      try {
        satisfied = await this.pollUntil(
          signal,
          async () => {
            const evaluated = await session.connection.send<EvaluateResult>(
              'Runtime.callFunctionOn',
              { objectId, functionDeclaration: 'function () { return !this.isConnected; }', returnByValue: true },
              { signal, timeoutMs: this.config.commandTimeoutMs },
            )
            return evaluated.result?.value === true
          },
          this.config.waitTimeoutMs,
        )
      } finally {
        this.releaseObject(session, objectId, signal)
      }
    }
    const result = await this.settleMutation(session, 'wait', beforeUrl, false, signal)
    return { ...result, satisfied }
  }

  /** 轮询一个条件直到成立或超时；返回是否成立。 */
  private async pollUntil(
    signal: AbortSignal | undefined,
    condition: () => Promise<boolean>,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await condition().catch(() => false)) return true
      if (Date.now() >= deadline) return false
      await delay(WAIT_POLL_INTERVAL_MS, signal)
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
    let navigated = false
    const deadline = awaitNavigation ? Date.now() + MUTATION_NAVIGATION_POLL_MS : 0
    for (;;) {
      const meta = await this.readPageMeta(session.connection, signal)
      if (meta !== undefined) {
        if (meta.url !== '' && meta.url !== beforeUrl) {
          // 页面换掉了：旧 ref 全部作废，绝不许旧 ref 静默命中新页面上的元素。
          session.refs.invalidate()
          navigated = true
        }
        session.url = meta.url
        session.title = meta.title
      }
      if (navigated || Date.now() >= deadline) break
      await delay(WAIT_POLL_INTERVAL_MS, signal)
    }
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
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await this.navigationSettled(connection, previousUrl, signal)) return true
      if (Date.now() >= deadline) return false
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), signal)
    }
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
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await this.documentComplete(connection, signal)) return true
      if (Date.now() >= deadline) return false
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), signal)
    }
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

/** `browser_press` 认得的键：名字 → CDP 键参数。 */
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
  [' ', { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ' }],
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

/** 把 `navigationSettled` 的探测结果从 `unknown` 收窄成结构化状态。 */
function readNavigationState(value: unknown): { ready: boolean; href: string } | undefined {
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
