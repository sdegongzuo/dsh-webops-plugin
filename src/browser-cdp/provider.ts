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
 * @module dsh-browser-plugin/browser-cdp
 */

import { BrowserError } from '../browser/types.ts'
import type {
  BrowserNavigateRequest,
  BrowserObservation,
  BrowserObserveRequest,
  BrowserOpenRequest,
  BrowserProvider,
  BrowserSession,
  BrowserScreenshot,
  BrowserSnapshot,
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
}

/** 配置补齐默认值之后的样子。 */
interface ResolvedConfig {
  readonly endpoint: string
  readonly commandTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly navigationTimeoutMs: number
  readonly probeTtlMs: number
  readonly snapshotLimits: SnapshotLimits
}

const DEFAULT_CONFIG: ResolvedConfig = {
  endpoint: DEFAULT_CDP_ENDPOINT,
  commandTimeoutMs: 30_000,
  requestTimeoutMs: 5_000,
  navigationTimeoutMs: 15_000,
  probeTtlMs: 1_000,
  snapshotLimits: DEFAULT_SNAPSHOT_LIMITS,
}

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
  readonly id = CDP_PROVIDER_ID

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
    const target = await this.createTarget(url, signal)
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
      await this.waitForDocument(connection, signal, this.config.navigationTimeoutMs)
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
    const result = await session.connection.send<NavigateResult>(
      'Page.navigate',
      { url },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    if (result.errorText !== undefined && result.errorText.length > 0) {
      throw new BrowserError(`navigation to ${url} failed: ${result.errorText}`, 'BROWSER_NAVIGATION_FAILED')
    }
    const loaded = await this.waitForDocument(session.connection, signal, this.config.navigationTimeoutMs)
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
  })) {
    if (value === undefined) continue
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`browser-cdp: ${name} must be a positive finite number`)
    }
  }
}
