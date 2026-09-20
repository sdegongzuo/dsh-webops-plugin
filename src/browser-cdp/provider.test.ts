import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { BrowserError } from '../browser/types.ts'
import type { BrowserSnapshot } from '../browser/types.ts'
import { METRICS_ENV, StaleRefMetrics } from './metrics.ts'
import { CdpBrowserProvider } from './provider.ts'
import type { BrowserHolder } from './provider.ts'
import { PAGE_DOCUMENT_STATE_KEY } from './state.ts'
import { CdpConnection } from './protocol.ts'
import type { CdpSocket, CdpTarget, CdpTransport, CdpVersion } from './protocol.ts'
import type { AxNode } from './snapshot.ts'

/** 造一个尺寸正确的极小 PNG（只填签名 + IHDR，够 `pngDimensions` 读宽高）。 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** 一个可编程的假 Chrome：按方法名回结果，并记录收到的每一条命令。 */
class FakeChrome {
  readonly calls: { method: string; params: Record<string, unknown> }[] = []
  readonly sockets: FakeSocket[] = []
  readonly closedTargets: string[] = []
  readonly targets: CdpTarget[] = []
  newTabError: BrowserError | undefined
  versionError: BrowserError | undefined
  navigateErrorText: string | undefined
  axeNodes: AxNode[] = []
  page = { url: 'https://example.com/', title: 'Example' }
  /** 当前文档的地址；`Page.navigate` 一被调用就变（模拟导航提交）。 */
  href = 'about:blank'
  png = pngBytes(640, 480)
  readyStateComplete = true
  boxModel: readonly number[] | undefined = [10, 20, 110, 20, 110, 60, 10, 60]
  /** P1：点击是否引发导航（模拟链接点击）。 */
  navigateOnClick = false
  /**
   * P1/P2：点击（或回车）引发导航时，是否同时发 `Page.frameNavigated`。
   *
   * 默认 **true** —— 真导航一定会发这个事件（`scripts/probe-within-document.ts` 实测）。
   * 关掉它只在「只关心地址变化、不关心事件流」的用例里有意义；P2 的去重路径必须开着才测得准。
   */
  navigationEventOnClick = true
  /**
   * P1：设置后，点击的 `mouseReleased` 会「弹出一个新窗口」（模拟 `target=_blank` /
   * `window.open`）。真链路上是宿主 `setWindowOpenHandler` → `openTab` → 通报 → 收编，
   * 这里由测试直接调 `adoptSession` 代替，只弹一次。
   */
  popupOnClick: CdpTarget | undefined
  /** 弹窗发生时的回调；测试用它把新目标收编成会话。 */
  onPopup: ((target: CdpTarget) => void) | undefined
  /**
   * 弹窗「通报」的延迟（毫秒）。**必须大于 0**：真链路上宿主收编是异步的，实测从派发到
   * provider 登记为 min 140 / 中位 152ms。默认 120 就是照着这个量级来的 ——
   * 若同步触发，`click` 的 800ms 轮询与补观测窗口都成了摆设，测试会假绿。
   */
  popupDelayMs = 120
  /**
   * P2：设置后，点击引发一次**同文档软导航**（`history.pushState` / `replaceState` 那一类），
   * 地址换成这个值，并补发 `Page.navigatedWithinDocument`。
   *
   * 这是真机上最常见的一档（Google 结果页每交互一次换一批遥测令牌，§5.1.2 ① 实测 17 次检出里
   * 5 次是纯抖动）。与 `navigateOnClick` 的区别是**文档身份不变** —— 不 replace 文档、
   * `loaderId` 不动，所以走的是 D-19 的「不作废纪元」那一档。
   */
  withinDocumentOnClick: string | undefined
  /** P1：回车是否引发导航（模拟表单提交，报告 S1 的维基搜索）。 */
  navigateOnEnter = false
  /**
   * 前 N 次读页面元信息时把 `title` 报成空串 —— 模拟「文档已提交、`<title>` 还没解析」
   * （报告 S1：press 返回的 title 是空串，调用方据此误判「页没就绪」）。
   */
  titleEmptyReads = 0
  /**
   * 让接下来 N 次 `readPageMeta` **整个读不到**（真实现里空白页 / 已崩溃的页面就是这种情况）：
   * provider 拿到 `undefined`，于是那一次 `publish` 没能为纪元留下粗门依据。
   */
  pageMetaFailReads = 0
  /** P1：wait-hidden 里元素是否还连在文档上。 */
  elementConnected = true
  /** 写前门：元素所在**子文档**的地址（null = 元素在顶层文档）。用于验 iframe 不误伤。 */
  frameHref: string | null = null
  /** 写前门：true = 子 frame 跨源，顶层地址读不到（脚本抛 SecurityError → 门没证据）。 */
  crossOriginFrame = false
  /**
   * `Page.getFrameTree` 里主 frame 的 url。缺省 = 与 `page.url` 一致；设成别的值就是在模拟
   * **浏览器进程镜像比 renderer 慢一拍**（导航在飞 / 重定向 / 特权页）。回填纪元地址若误用
   * 这一份，两条同源用例立刻红。
   */
  frameTreeUrl: string | undefined = undefined
  /** P1：wait-text 里页面文本是否包含目标串。 */
  waitTextFound = true
  /** `until: 'stable'`：每次读 DOM 探针返回的增量（0 = 本窗口安静）。 */
  domMutationDelta = 0
  /**
   * P2：设置后**所有**命令都抛这条消息 —— 模拟 detach 期间 `webContents.debugger` 的
   * 同步失败（`No target available`，`[V16]`）。
   */
  detachError: string | undefined
  /** P2：`Network.getResponseBody` 的返回体。 */
  responseBody = 'pong'
  /** P3：`getBoundingClientRect` 的返回值（locate / click 共用）。 */
  elementRect = { x: 10, y: 20, width: 100, height: 40 }
  /** P3：视口尺寸（locate 的 `in_viewport` 与「不带 ref 的 scroll」都要它）。 */
  viewport = { width: 1280, height: 720 }
  /** P3：设置后 `DOM.resolveNode` 抛这条消息（模拟节点已被销毁）。 */
  resolveNodeError: string | undefined
  /** P2：设置后，含 `throw` 的表达式返回 `exceptionDetails`（异常文本）。 */
  evaluateThrows: string | undefined
  /**
   * B1-d：落点命中校验（`elementFromPoint`）的返回值。
   *
   * 缺省是「命中目标」—— 正常页面上没有浮层盖住目标中心。改成 `other` 就是模拟登录浮层 /
   * fixed 遮罩；设成 `undefined` 模拟**查不出来**（跨源 / CSP 拦下 evaluate），用来验
   * 命中校验失败时**不许把 click 打成失败**。
   */
  hitTest: { hit: 'target' | 'other' | 'none'; href?: string | null; node?: { role: string; name: string; hint: string } | null } | undefined
    = { hit: 'target', href: null, node: null }
  /** B1-e：`Input.dispatchMouseEvent` 的 `mouseWheel` 是否回包（Electron 上实测不回）。 */
  wheelAcks = true
  /**
   * B1-e：transport 报的「前台标签」；`undefined` = 这个 provider 答不出（外部 Chrome）。
   *
   * 缺省**不挂**这两个能力 —— 既有的 tabs 用例正是在验「没有 activate 能力时报
   * `BROWSER_NOT_IMPLEMENTED`」与「答不出前台时清单不带 active」，默认挂上会把它们全打红。
   * 要测 scroll 的前台处理，用例自己显式设。
   */
  activeTargetId: string | undefined = undefined
  /** B1-e：transport 有没有把标签切到前台的能力（缺省没有，理由同上）。 */
  canActivate = false
  /** B1-e：被切到前台的 targetId 流水。 */
  readonly activateCalls: string[] = []
  /** B2-d：视口中心浮层探测的返回值；`null` = 没有浮层。 */
  overlay: { role: string; name: string; hint: string } | null = null
  /**
   * B2-b：`Page.getNavigationHistory` 的返回体。
   * 默认只有一条历史 —— 于是 `back` / `forward` 都落在尽头，测试想验成功路径要自己铺栈。
   */
  history: { currentIndex: number; entries: { id: number; url: string }[] } = {
    currentIndex: 0,
    entries: [{ id: 1, url: 'https://example.com/' }],
  }
  /** B2-b：`Page.reload` 被调用了几次。 */
  reloadCount = 0
  /**
   * `webpage_fill` 的目标是不是 `contenteditable`（模拟 AI 问答页的富文本输入框）。
   * 真实现里由页面内的 `isContentEditable` 判定，provider 据此改走 `Input.insertText`。
   */
  fillEditable = false
  /** 主 frame 文档身份；`Page.getFrameTree` 按需读取。 */
  loaderId = 'loader-1'
  /** `DOM.resolveNode` 对这些 backendNodeId 返回空对象（节点已死）。 */
  missingBackendNodeIds = new Set<number>()
  /**
   * `DOMSnapshot.captureSnapshot` 的布局盒。默认把 PAGE_TREE 里的节点都放进视口，
   * 区域测试会改成「一个在屏内、一个在屏外」。
   */
  layoutBoxes: { backendNodeId: number; bounds: number[] }[] = [
    { backendNodeId: 7, bounds: [0, 0, 200, 40] },
    { backendNodeId: 8, bounds: [0, 50, 200, 30] },
    { backendNodeId: 9, bounds: [0, 90, 200, 30] },
  ]

  /** 记录一条命令并给出它的结果。 */
  handle(socket: FakeSocket, method: string, params: Record<string, unknown>): unknown {
    if (this.detachError !== undefined) throw new Error(this.detachError)
    this.calls.push({ method, params })
    switch (method) {
      case 'Page.enable':
      case 'Runtime.enable':
      case 'Log.enable':
      case 'Network.enable':
        return {}
      case 'Runtime.evaluate': {
        const expression = String(params['expression'])
        // B2-d：视口中心浮层探测。判据串 `elementFromPoint` 只有这条脚本里有；
        // 缺省 `null` = 没有浮层。
        if (expression.includes('elementFromPoint')) {
          return { result: { value: this.overlay } }
        }
        // 表达式抛错 / 被 await 的 Promise reject：CDP 走 `exceptionDetails`，不是协议错误。
        if (this.evaluateThrows !== undefined && expression.includes('throw')) {
          return {
            result: { type: 'object', subtype: 'error' },
            exceptionDetails: { text: 'Uncaught (in promise)', exception: { description: this.evaluateThrows } },
          }
        }
        // 导航判据里带 `ready:`；`readPageMeta` 也读 location.href，但没有这个键。
        if (expression.includes('ready:')) {
          return {
            result: {
              value: JSON.stringify({ ready: this.readyStateComplete, href: this.href }),
            },
          }
        }
        if (expression.includes('innerText')) {
          return { result: { value: this.waitTextFound } }
        }
        if (expression === '1 + 1') {
          return { result: { value: 2 } }
        }
        if (expression.includes('innerWidth')) {
          return { result: { value: { ...this.viewport } } }
        }
        if (expression.includes('readyState')) {
          return { result: { value: this.readyStateComplete } }
        }
        if (expression.includes('__dsh_mut_installed')) {
          return { result: { value: true } }
        }
        if (expression.includes('__dsh_mut_count')) {
          return { result: { value: this.domMutationDelta } }
        }
        // 读页面元信息：先按 `titleEmptyReads` 把标题报成空串，再给真实值。
        // `readPageMeta` 是唯一读 `document.title` 的表达式，所以按它来定点失败。
        if (this.pageMetaFailReads > 0 && expression.includes('document.title')) {
          this.pageMetaFailReads -= 1
          return { result: {} }
        }
        if (this.titleEmptyReads > 0) {
          this.titleEmptyReads -= 1
          return { result: { value: { url: this.page.url, title: '' } } }
        }
        return { result: { value: { url: this.page.url, title: this.page.title } } }
      }
      case 'Runtime.callFunctionOn': {
        const fn = String(params['functionDeclaration'])
        if (fn.includes('getBoundingClientRect')) {
          return { result: { value: { ...this.elementRect, viewportWidth: this.viewport.width, viewportHeight: this.viewport.height } } }
        }
        if (fn.includes('!this.isConnected')) {
          // wait-hidden 的判据：true = 元素已从文档移除。
          return { result: { value: !this.elementConnected } }
        }
        if (fn.includes('connected:')) {
          // 写前门（方案 §5.1）：一次往返读回「顶层文档地址 + 元素还在不在文档里」。
          // 判据用 `connected:`（对象字面量的键，只有门的脚本里有）而不是 `location.href` ——
          // 分支是首个命中即返回，用共用串的话重排一次就会让门拿到 boolean 而静默放行。
          // 地址按脚本**实际读的是哪个 window** 给，三条退路都必须能变红：
          //   · 读 `window.top` 且兜了异常 → 跨源回 null（没证据），同源回顶层地址
          //   · 读 `window.top` 却没兜异常 → 整个调用没有返回值，两道门一起静默
          //   · 只读 `location.href` → 拿到子文档地址，于是「iframe 误杀」一旦复发必然红
          const readsTop = fn.includes('window.top')
          if (this.crossOriginFrame && readsTop && !fn.includes('try')) return { result: {} }
          const url = readsTop
            ? (this.crossOriginFrame ? null : this.page.url)
            : this.frameHref ?? this.page.url
          return { result: { value: { url, connected: this.elementConnected } } }
        }
        if (fn.includes('isConnected')) {
          // locate 的守卫判据：true = 元素还连在文档上。
          return { result: { value: this.elementConnected } }
        }
        if (fn.includes('isContentEditable')) {
          // fill 的分支判定：'editable' = 富文本（调用方随后发 Input.insertText）。
          return { result: { value: this.fillEditable ? 'editable' : 'value' } }
        }
        if (fn.includes('dispatchEvent')) {
          return { result: { value: true } }
        }
        // B1-d：落点命中校验。判据串取 `elementFromPoint` —— 它是这条脚本独有的，
        // 夹在 `getBoundingClientRect`（取 rect）之后、兜底之前，顺序动一下就会掉到兜底分支。
        if (fn.includes('elementFromPoint')) {
          return { result: { value: this.hitTest } }
        }
        // focus() 之类没有返回值。
        return { result: { value: undefined } }
      }
      case 'Accessibility.getFullAXTree':
        return { nodes: this.axeNodes }
      case 'Accessibility.getPartialAXTree': {
        const backend = Number(params['backendNodeId'])
        const start = this.axeNodes.find(node => node.backendDOMNodeId === backend)
        if (start === undefined) return { nodes: [] }
        const byId = new Map(this.axeNodes.map(node => [node.nodeId, node]))
        const collected: AxNode[] = []
        const walk = (node: AxNode): void => {
          collected.push(node)
          for (const childId of node.childIds ?? []) {
            const child = byId.get(childId)
            if (child !== undefined) walk(child)
          }
        }
        walk(start)
        return { nodes: collected }
      }
      case 'Page.getFrameTree':
        return {
          frameTree: {
            frame: { id: 'frame-1', loaderId: this.loaderId, url: this.frameTreeUrl ?? this.page.url },
          },
        }
      case 'Page.getLayoutMetrics':
        return {
          visualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: this.viewport.width,
            clientHeight: this.viewport.height,
            offsetX: 0,
            offsetY: 0,
            scale: 1,
          },
          layoutViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: this.viewport.width,
            clientHeight: this.viewport.height,
          },
        }
      case 'DOMSnapshot.captureSnapshot':
        return {
          documents: [{
            nodes: { backendNodeId: this.layoutBoxes.map(entry => entry.backendNodeId) },
            layout: {
              nodeIndex: this.layoutBoxes.map((_, index) => index),
              bounds: this.layoutBoxes.map(entry => entry.bounds),
            },
          }],
        }
      case 'Network.getResponseBody':
        return { body: this.responseBody, base64Encoded: false }
      case 'Page.navigate':
        this.href = String(params['url'])
        return this.navigateErrorText === undefined ? {} : { errorText: this.navigateErrorText }
      // B2-b：历史栈。`navigateToHistoryEntry` 一被调用就换地址，模拟「回退真的发生了」。
      case 'Page.getNavigationHistory':
        return { currentIndex: this.history.currentIndex, entries: this.history.entries }
      case 'Page.navigateToHistoryEntry': {
        const entry = this.history.entries.find(candidate => candidate.id === Number(params['entryId']))
        if (entry !== undefined) {
          this.href = entry.url
          this.page = { url: entry.url, title: 'Navigated' }
        }
        return {}
      }
      case 'Page.reload':
        this.reloadCount += 1
        return {}
      case 'Page.captureScreenshot':
        return { data: Buffer.from(this.png).toString('base64') }
      case 'DOM.resolveNode':
        if (this.resolveNodeError !== undefined) throw new Error(this.resolveNodeError)
        if (this.missingBackendNodeIds.has(Number(params['backendNodeId']))) return {}
        return params['backendNodeId'] === 0 ? {} : { object: { objectId: 'obj-1' } }
      case 'DOM.getBoxModel':
        return this.boxModel === undefined ? {} : { model: { border: [...this.boxModel] } }
      case 'DOM.releaseObject':
        return {}
      case 'DOM.enable':
        return {}
      case 'Overlay.enable':
        return {}
      case 'Overlay.highlightNode':
        return {}
      case 'Overlay.hideHighlight':
        return {}
      case 'Input.dispatchMouseEvent':
        // 模拟「点在链接上会导航」：点击落点一变，地址跟着变。
        if (this.navigateOnClick && params['type'] === 'mouseReleased') {
          this.href = 'https://example.com/next'
          this.page = { url: 'https://example.com/next', title: 'Next' }
          // 真导航**一定**会发 `Page.frameNavigated`（`scripts/probe-within-document.ts` 实测），
          // 而 provider 的脏累加器搭在这条事件流上 —— 不补这一条，P2 的去重路径就是假绿。
          if (this.navigationEventOnClick) {
            emitCdp(socket, 'Page.frameNavigated', {
              frame: { id: 'frame-1', loaderId: 'loader-2', url: this.page.url },
            })
          }
        }
        // 同文档软导航：地址变了、**文档没换**（`loaderId` 不动），事件走另一条通道。
        if (this.withinDocumentOnClick !== undefined && params['type'] === 'mouseReleased') {
          this.page = { url: this.withinDocumentOnClick, title: this.page.title }
          this.href = this.withinDocumentOnClick
          if (this.navigationEventOnClick) {
            emitCdp(socket, 'Page.navigatedWithinDocument', {
              frameId: 'frame-1',
              url: this.withinDocumentOnClick,
            })
          }
        }
        // 模拟「这点开了一个新窗口」：与导航可以同时发生（脚本里两者并发）。
        if (this.popupOnClick !== undefined && params['type'] === 'mouseReleased') {
          const target = this.popupOnClick
          this.popupOnClick = undefined
          const fire = (): void => { this.onPopup?.(target) }
          if (this.popupDelayMs > 0) setTimeout(fire, this.popupDelayMs)
          else fire()
        }
        return {}
      case 'Input.dispatchKeyEvent':
        if (this.navigateOnEnter && params['type'] === 'keyUp' && params['key'] === 'Enter') {
          this.href = 'https://zh.wikipedia.org/w/index.php?search=Electron'
          this.page = { url: this.href, title: 'Electron (software) - 维基百科，自由的百科全书' }
          if (this.navigationEventOnClick) {
            emitCdp(socket, 'Page.frameNavigated', {
              frame: { id: 'frame-1', loaderId: 'loader-2', url: this.page.url },
            })
          }
        }
        return {}
      case 'Input.insertText':
        return {}
      default:
        throw new Error(`unscripted method ${method}`)
    }
  }

  /** 造一个 transport；`connect` 直接返回一条已建好的连接。 */
  transport(): CdpTransport {
    const chrome = this
    return {
      // B1-e：这两个能力**按需挂上** —— 缺省是「能答前台、也能切」，
      // 测试把它们摘掉就是在模拟「外部 Chrome（答不出前台）」与「切不动前台的 provider」。
      ...chrome.activeTargetId !== undefined
        ? { activeTargetId: (): Promise<string> => Promise.resolve(chrome.activeTargetId as string) }
        : {},
      ...chrome.canActivate
        ? {
          activateTarget: (targetId: string): Promise<void> => {
            chrome.activateCalls.push(targetId)
            return Promise.resolve()
          },
        }
        : {},
      version: (): Promise<CdpVersion> => chrome.versionError !== undefined
        ? Promise.reject(chrome.versionError)
        : Promise.resolve({ browser: 'Chrome/test', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' }),
      list: (): Promise<readonly CdpTarget[]> => Promise.resolve(chrome.targets),
      newTab: (url: string): Promise<CdpTarget> => {
        if (chrome.newTabError !== undefined) return Promise.reject(chrome.newTabError)
        const target: CdpTarget = {
          id: `tab-${chrome.targets.length + 1}`,
          type: 'page',
          url,
          title: '',
          webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/tab-${chrome.targets.length + 1}`,
        }
        chrome.targets.push(target)
        return Promise.resolve(target)
      },
      closeTarget: (targetId: string): Promise<void> => {
        chrome.closedTargets.push(targetId)
        return Promise.resolve()
      },
      connect: (): Promise<CdpConnection> => {
        const socket = new FakeSocket(chrome)
        chrome.sockets.push(socket)
        return Promise.resolve(new CdpConnection(socket))
      },
    }
  }
}

/** 收到命令就排队回一条结果的假 socket。 */
class FakeSocket implements CdpSocket {
  closed = false
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>()

  constructor(private readonly chrome: FakeChrome) {}

  send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
    const params = request.params ?? {}
    // B1-e：`wheelAcks=false` 时在**记下命令之后**故意不回包 —— 模拟 Electron / 后台标签上
    // `mouseWheel` 石沉大海。命令必须照样记进 `calls`（断言「已投递」靠它）。
    if (request.method === 'Input.dispatchMouseEvent' && params['type'] === 'mouseWheel'
      && !this.chrome.wheelAcks) {
      this.chrome.handle(this, request.method, params)
      return
    }
    // 用微任务回消息，保持与真实 WebSocket 一致的「先发后收」时序。
    queueMicrotask(() => {
      if (this.closed) return
      try {
        const result = this.chrome.handle(this, request.method, params)
        this.dispatch('message', { data: JSON.stringify({ id: request.id, result }) })
      } catch (error: unknown) {
        this.dispatch('message', {
          data: JSON.stringify({ id: request.id, error: { code: -32601, message: (error as Error).message } }),
        })
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.dispatch('close', {})
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(listener)
    this.handlers.set(type, list)
  }

  /** 触发一个入站事件。 */
  dispatch(type: string, event: unknown): void {
    for (const listener of [...this.handlers.get(type) ?? []]) listener(event)
  }
}

/**
 * 把 protected 的 `adoptSession` 露出来，模拟宿主「弹窗转标签」链路的最后一跳
 * （`ElectronBrowserProvider.ensureTabOpenedChannel` 收到 `{type:'opened'}` 就是这么调的）。
 */
class AdoptableProvider extends CdpBrowserProvider {
  adopt(target: CdpTarget): Promise<unknown> {
    return this.adoptSession(target)
  }
}

/** 一个刚被页面弹出来的新标签页（`webSocketDebuggerUrl` 在假 transport 里没用途）。 */
function popupTarget(): CdpTarget {
  return {
    id: 'popup-9',
    type: 'page',
    url: 'https://example.com/hot-5',
    title: '热搜第五条',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/popup-9',
  }
}

/** 一页常见的可访问性树：一个标题 + 一个输入框 + 一个按钮。 */
const PAGE_TREE: AxNode[] = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Example' }, childIds: ['2'], ignored: false },
  { nodeId: '2', role: { value: 'heading' }, name: { value: 'Hello' }, ignored: false, backendDOMNodeId: 7 },
  { nodeId: '3', role: { value: 'textbox' }, name: { value: 'Email' }, ignored: false, backendDOMNodeId: 8 },
  { nodeId: '4', role: { value: 'button' }, name: { value: 'Submit' }, ignored: false, backendDOMNodeId: 9 },
]

describe('CdpBrowserProvider', () => {
  let chrome: FakeChrome
  let provider: CdpBrowserProvider

  beforeEach(() => {
    chrome = new FakeChrome()
    chrome.axeNodes = PAGE_TREE
    provider = new CdpBrowserProvider({ navigationTimeoutMs: 200 }, chrome.transport())
  })

  it('opens a blank tab by default and enables the Page domain', async () => {
    const session = await provider.open({})

    expect(session).toEqual({ id: 'tab-1', url: 'https://example.com/', title: 'Example', epoch: 0 })
    expect(chrome.calls.map(call => call.method)).toContain('Page.enable')
    expect(provider.sessionCount).toBe(1)
  })

  it('rejects a blocked URL before creating any tab', async () => {
    await expect(provider.open({ url: 'file:///etc/passwd' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_URL_BLOCKED' }))
    expect(chrome.targets).toHaveLength(0)
  })

  it('does not leave an orphan tab when the websocket cannot be opened', async () => {
    const failing: CdpTransport = {
      ...chrome.transport(),
      connect: () => Promise.reject(new BrowserError('boom', 'BROWSER_ENDPOINT_UNREACHABLE')),
    }
    provider = new CdpBrowserProvider({}, failing)

    await expect(provider.open({})).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_ENDPOINT_UNREACHABLE' }))
    expect(chrome.closedTargets).toEqual(['tab-1'])
    expect(provider.sessionCount).toBe(0)
  })

  it('reports an unreachable endpoint when the tab cannot even be created', async () => {
    chrome.newTabError = new BrowserError('no chrome', 'BROWSER_ENDPOINT_UNREACHABLE')
    await expect(provider.open({})).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_ENDPOINT_UNREACHABLE' }))
    expect(chrome.closedTargets).toEqual([])
  })

  it('reports a clear error when the endpoint refuses to create tabs, instead of hijacking a page', async () => {
    chrome.newTabError = new BrowserError('/json/new responded 500', 'BROWSER_PROTOCOL_ERROR')
    chrome.targets.push({
      id: 'user-tab',
      type: 'page',
      url: 'https://mail.example.com/',
      title: 'Inbox',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/user-tab',
    })

    await expect(provider.open({ url: 'https://example.com/' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'BROWSER_PROTOCOL_ERROR',
        message: expect.stringContaining('refused to create a new tab') as unknown as string,
      }))
    // 用户自己的页面既没被导航、也没被关掉，连接更没建立。
    expect(chrome.calls.map(call => call.method)).not.toContain('Page.navigate')
    expect(chrome.closedTargets).toEqual([])
    expect(chrome.sockets).toHaveLength(0)
    expect(provider.sessionCount).toBe(0)
  })

  it('snapshots into an outline with refs and a fresh epoch', async () => {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })

    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(snapshot.epoch).toBe(1)
    expect(snapshot.refs).toEqual([
      { ref: 'e1', role: 'textbox', name: 'Email' },
      { ref: 'e2', role: 'button', name: 'Submit' },
    ])
    expect(snapshot.outline).toContain('textbox "Email" [ref=e1]')
    expect(snapshot.outline).toContain('button "Submit" [ref=e2]')
    expect(snapshot.url).toBe('https://example.com/')
    expect(snapshot.truncated).toBe(false)
  })

  it('puts an OVERLAY line on top of the outline when something covers the viewport center (B2-d · J1)', async () => {
    await provider.open({})
    // 没有 `role=dialog` 的浮层在 AX 里排在 body 末尾，小 max_lines 会把它整段截掉 ——
    // 于是模型拿到的第一屏看着「可以直接点正文」。这一行就是为了让那种错觉不再可能。
    chrome.overlay = { role: 'div', name: '登录后查看', hint: '#login-modal' }

    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1', maxLines: 60 })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const lines = snapshot.outline.split('\n')
    expect(lines[0]).toContain('OVERLAY at viewport center')
    expect(lines[0]).toContain('登录后查看')
    expect(lines[0]).toContain('#login-modal')
    expect(lines[0]).toContain('Raise max_lines')
    // 提示行**不进** find 的检索底稿：它不是一个可操作元素，混进去就是一条 ref 为空的幻影命中。
    expect(snapshot.fullOutline ?? '').not.toContain('OVERLAY')
  })

  it('omits the OVERLAY line when nothing covers the center (反向验证 · 不误报)', async () => {
    await provider.open({})
    chrome.overlay = null

    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    // 误报会骗模型去关一个根本不存在的浮层，比漏报更糟。
    expect(snapshot.outline).not.toContain('OVERLAY')
  })

  it('does not probe for an overlay on a regional snapshot (区域快照只看那一块)', async () => {
    await provider.open({})
    const full = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (full.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = full.refs[0]?.ref as string
    chrome.overlay = { role: 'div', name: '登录后查看', hint: '#login-modal' }

    const region = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1', region: { ref } })
    if (region.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(region.outline).not.toContain('OVERLAY')
  })

  it('region.ref snapshot adopts into the current epoch so earlier refs stay usable', async () => {
    await provider.open({})
    const full = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (full.kind !== 'snapshot') throw new Error('expected a snapshot')
    const first = full.refs[0]?.ref as string
    const epoch = full.epoch

    const regional = await provider.observe({
      kind: 'snapshot',
      sessionId: 'tab-1',
      region: { ref: first },
    })
    if (regional.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(regional.epoch).toBe(epoch)
    expect(regional.outsideRegion).toBeGreaterThanOrEqual(0)
    const later = await provider.observe({ kind: 'screenshot', sessionId: 'tab-1', ref: first })
    expect(later.kind).toBe('screenshot')
  })

  it('revalidates a stale ref onto the same number when the document and identity still match', async () => {
    await provider.open({})
    const first = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (first.kind !== 'snapshot') throw new Error('expected a snapshot')
    const stale = first.refs[0]?.ref as string
    const second = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (second.kind !== 'snapshot') throw new Error('expected a snapshot')
    await expect(provider.observe({ kind: 'screenshot', sessionId: 'tab-1', ref: stale }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))

    const result = await provider.revalidate({ sessionId: 'tab-1', refs: [stale] })
    expect(result.epoch).toBe(second.epoch)
    expect(result.restored.map(entry => entry.ref)).toEqual([stale])
    expect(result.failed).toEqual([])
    const shot = await provider.observe({ kind: 'screenshot', sessionId: 'tab-1', ref: stale })
    expect(shot.kind).toBe('screenshot')
  })

  it('refuses to bind when the document loaderId changed (反向：跳过文档校验会误绑)', async () => {
    await provider.open({})
    const first = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (first.kind !== 'snapshot') throw new Error('expected a snapshot')
    const stale = first.refs[0]?.ref as string
    chrome.loaderId = 'loader-2'
    await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })

    const result = await provider.revalidate({ sessionId: 'tab-1', refs: [stale] })
    expect(result.restored).toEqual([])
    expect(result.failed).toEqual([{ ref: stale, reason: 'document_changed' }])
    await expect(provider.observe({ kind: 'screenshot', sessionId: 'tab-1', ref: stale }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
    expect(chrome.calls.some(call => call.method === 'DOM.resolveNode' && call.params['backendNodeId'] === 8)).toBe(false)
  })

  it('reports node_gone when resolveNode cannot bind the archived backend id', async () => {
    await provider.open({})
    const first = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (first.kind !== 'snapshot') throw new Error('expected a snapshot')
    const stale = first.refs[0]?.ref as string
    await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    chrome.missingBackendNodeIds.add(8)

    const result = await provider.revalidate({ sessionId: 'tab-1', refs: [stale] })
    expect(result.failed).toEqual([{ ref: stale, reason: 'node_gone' }])
    await expect(provider.observe({ kind: 'screenshot', sessionId: 'tab-1', ref: stale }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('reports identity_mismatch when the live role or name no longer match the archive', async () => {
    await provider.open({})
    const first = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (first.kind !== 'snapshot') throw new Error('expected a snapshot')
    const stale = first.refs.find(entry => entry.role === 'button')?.ref as string
    await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    chrome.axeNodes = chrome.axeNodes.map(node =>
      node.backendDOMNodeId === 9 ? { ...node, name: { value: 'Go' } } : node)

    const result = await provider.revalidate({ sessionId: 'tab-1', refs: [stale] })
    expect(result.failed).toEqual([{ ref: stale, reason: 'identity_mismatch' }])
  })

  it('keeps old refs usable after a viewport region snapshot', async () => {
    await provider.open({})
    const full = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (full.kind !== 'snapshot') throw new Error('expected a snapshot')
    chrome.layoutBoxes = [
      { backendNodeId: 8, bounds: [0, 50, 200, 30] },
      { backendNodeId: 9, bounds: [0, 2000, 200, 30] },
    ]
    const regional = await provider.observe({
      kind: 'snapshot',
      sessionId: 'tab-1',
      region: { viewport: true },
    })
    if (regional.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(regional.epoch).toBe(full.epoch)
    expect(regional.outline).toContain('Email')
    expect(regional.outline).not.toContain('Submit')
    expect(regional.outsideRegion).toBe(1)
    const shot = await provider.observe({ kind: 'screenshot', sessionId: 'tab-1', ref: full.refs[0]?.ref as string })
    expect(shot.kind).toBe('screenshot')
  })

  it('snapshots only elements intersecting region.box', async () => {
    await provider.open({})
    await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    chrome.layoutBoxes = [
      { backendNodeId: 8, bounds: [0, 50, 200, 30] },
      { backendNodeId: 9, bounds: [0, 800, 200, 30] },
    ]
    const regional = await provider.observe({
      kind: 'snapshot',
      sessionId: 'tab-1',
      region: { box: { x: 0, y: 780, width: 400, height: 80 } },
    })
    if (regional.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(regional.refs.some(entry => entry.name === 'Submit')).toBe(true)
    expect(regional.outline).not.toContain('Email')
    expect(regional.outsideRegion).toBe(1)
  })

  it('increments the epoch on every snapshot so earlier refs go stale', async () => {
    const session = await provider.open({})
    await provider.observe({ kind: 'snapshot', sessionId: session.id })
    const second = await provider.observe({ kind: 'snapshot', sessionId: session.id })

    if (second.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(second.epoch).toBe(2)
    // 序号跨 snapshot 连续，因此旧 ref 不可能撞上新元素。
    expect(second.refs.map(ref => ref.ref)).toEqual(['e3', 'e4'])
    await expect(provider.observe({ kind: 'screenshot', sessionId: session.id, ref: 'e1' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('invalidates refs on navigation and fails a stale ref instead of capturing the wrong element', async () => {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = snapshot.refs[0]?.ref as string

    chrome.page = { url: 'https://example.com/next', title: 'Next' }
    const navigated = await provider.navigate({ sessionId: session.id, url: 'https://example.com/next' })
    expect(navigated.epoch).toBe(2)

    const before = chrome.calls.filter(call => call.method === 'Page.captureScreenshot').length
    await expect(provider.observe({ kind: 'screenshot', sessionId: session.id, ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
    // 关键：ref 失效时根本没发截图命令，不可能静默截到别的元素。
    expect(chrome.calls.filter(call => call.method === 'Page.captureScreenshot')).toHaveLength(before)
  })

  it('asks for a snapshot first when a ref is used before any observation', async () => {
    const session = await provider.open({})
    await expect(provider.observe({ kind: 'screenshot', sessionId: session.id, ref: 'e1' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
  })

  it('surfaces a CDP navigation failure', async () => {
    const session = await provider.open({})
    chrome.navigateErrorText = 'net::ERR_NAME_NOT_RESOLVED'

    await expect(provider.navigate({ sessionId: session.id, url: 'https://nope.invalid/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NAVIGATION_FAILED' }))
  })

  it('reports an unknown session id rather than guessing', async () => {
    await expect(provider.observe({ kind: 'snapshot', sessionId: 'nope' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TARGET_NOT_FOUND' }))
    await expect(provider.navigate({ sessionId: 'nope', url: 'https://example.com/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TARGET_NOT_FOUND' }))
    await expect(provider.close('nope')).resolves.toBeUndefined()
  })

  it('captures the viewport and reads its size from the PNG header', async () => {
    const session = await provider.open({})
    chrome.png = pngBytes(1280, 720)
    const shot = await provider.observe({ kind: 'screenshot', sessionId: session.id })

    if (shot.kind !== 'screenshot') throw new Error('expected a screenshot')
    expect(shot.width).toBe(1280)
    expect(shot.height).toBe(720)
    expect(shot.mediaType).toBe('image/png')
    expect(shot.ref).toBeUndefined()
    expect(Buffer.from(shot.data)).toEqual(Buffer.from(chrome.png))
  })

  it('captures the full page when asked to go beyond the viewport', async () => {
    const session = await provider.open({})
    await provider.observe({ kind: 'screenshot', sessionId: session.id, fullPage: true })

    const capture = chrome.calls.filter(call => call.method === 'Page.captureScreenshot').at(-1)
    expect(capture?.params).toEqual({ format: 'png', captureBeyondViewport: true, fromSurface: false })
  })

  it('clips an element screenshot to the ref box and releases the remote handle', async () => {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = snapshot.refs[1]?.ref as string

    const shot = await provider.observe({ kind: 'screenshot', sessionId: session.id, ref })
    if (shot.kind !== 'screenshot') throw new Error('expected a screenshot')

    expect(shot.ref).toBe(ref)
    const capture = chrome.calls.filter(call => call.method === 'Page.captureScreenshot').at(-1)
    expect(capture?.params['clip']).toEqual({ x: 10, y: 20, width: 100, height: 40, scale: 1 })
    expect(chrome.calls.map(call => call.method)).toContain('DOM.releaseObject')
  })

  it('fails an element screenshot whose element has no layout box', async () => {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    chrome.boxModel = [10, 20, 10, 20, 10, 20, 10, 20]

    await expect(provider.observe({ kind: 'screenshot', sessionId: session.id, ref: snapshot.refs[0]?.ref as string }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('reports a detached element as a stale ref', async () => {
    const session = await provider.open({})
    // backendNodeId 0 在假 Chrome 里表示「节点已不在文档里」。
    chrome.axeNodes = [{ nodeId: '1', role: { value: 'button' }, name: { value: 'Gone' }, ignored: false, backendDOMNodeId: 0 }]
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')

    await expect(provider.observe({ kind: 'screenshot', sessionId: session.id, ref: snapshot.refs[0]?.ref as string }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('closes a session once, releasing both the socket and the tab it owns', async () => {
    const session = await provider.open({})
    const socket = chrome.sockets[0] as FakeSocket

    await provider.close(session.id)
    expect(socket.closed).toBe(true)
    expect(chrome.closedTargets).toEqual(['tab-1'])
    expect(provider.sessionCount).toBe(0)

    await expect(provider.close(session.id)).resolves.toBeUndefined()
    expect(chrome.closedTargets).toEqual(['tab-1'])
  })

  it('drops a session whose tab the user closed', async () => {
    const session = await provider.open({})
    expect(provider.sessionCount).toBe(1)

    ;(chrome.sockets[0] as FakeSocket).close()
    await expect(provider.observe({ kind: 'snapshot', sessionId: session.id }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TARGET_NOT_FOUND' }))
  })

  it('releases every remaining session on dispose', async () => {
    await provider.open({})
    await provider.open({})
    expect(provider.sessionCount).toBe(2)

    await provider.dispose()
    expect(provider.sessionCount).toBe(0)
    expect(chrome.closedTargets).toEqual(['tab-1', 'tab-2'])
    expect(chrome.sockets.every(socket => socket.closed)).toBe(true)
  })

  it('reports a provider whose endpoint is gone as unavailable once the probe settles', async () => {
    chrome.versionError = new BrowserError('nope', 'BROWSER_ENDPOINT_UNREACHABLE')
    // 拿不准时乐观为真：让 open() 给出「Chrome 没开调试端口」这种可操作的诊断。
    expect(provider.available()).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(provider.available()).toBe(false)
  })

  it('treats a live session as available without probing', async () => {
    chrome.versionError = new BrowserError('nope', 'BROWSER_ENDPOINT_UNREACHABLE')
    const session = await provider.open({})
    expect(session.id).toBe('tab-1')
    expect(provider.available()).toBe(true)
  })
})

describe('CdpBrowserProvider.tabs (P1)', () => {
  let chrome: FakeChrome
  let provider: CdpBrowserProvider

  beforeEach(() => {
    chrome = new FakeChrome()
    chrome.axeNodes = PAGE_TREE
    provider = new CdpBrowserProvider({ navigationTimeoutMs: 200 }, chrome.transport())
  })

  it('lists only the tabs this provider opened, and marks the active one when the transport can tell', async () => {
    await provider.open({ url: 'https://example.com/a' })
    await provider.open({ url: 'https://example.com/b' })

    const plain = await provider.tabs({ kind: 'list' })
    expect(plain.action).toBe('list')
    expect(plain.tabs.map(tab => tab.sessionId)).toEqual(['tab-1', 'tab-2'])
    expect(plain.tabs.some(tab => tab.active === true)).toBe(false)

    // 换一个能回答「谁在前台」的 transport：Electron 宿主就是这个角色。
    const activeChrome = new FakeChrome()
    activeChrome.axeNodes = PAGE_TREE
    const withActiveTransport = new CdpBrowserProvider({ navigationTimeoutMs: 200 }, {
      ...activeChrome.transport(),
      activeTargetId: () => Promise.resolve('tab-1'),
    })
    await withActiveTransport.open({})
    const marked = await withActiveTransport.tabs({ kind: 'list' })
    expect(marked.tabs).toEqual([
      { sessionId: 'tab-1', url: 'https://example.com/', title: 'Example', active: true },
    ])
  })

  it('activates through the transport when supported', async () => {
    await provider.open({})
    const activations: string[] = []
    const activating: CdpTransport = {
      ...chrome.transport(),
      activateTarget: (targetId: string) => {
        activations.push(targetId)
        return Promise.resolve()
      },
    }
    provider = new CdpBrowserProvider({ navigationTimeoutMs: 200 }, activating)
    const session = await provider.open({})

    const result = await provider.tabs({ kind: 'activate', sessionId: session.id })
    expect(activations).toEqual([session.id])
    expect(result).toMatchObject({ action: 'activate', sessionId: session.id })
  })

  it('reports BROWSER_NOT_IMPLEMENTED when the transport cannot activate', async () => {
    await provider.open({})
    await expect(provider.tabs({ kind: 'activate', sessionId: 'tab-1' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NOT_IMPLEMENTED' }))
  })

  it('closes a controlled tab through tabs(close) and returns the remaining list', async () => {
    await provider.open({ url: 'https://example.com/a' })
    await provider.open({ url: 'https://example.com/b' })

    const result = await provider.tabs({ kind: 'close', sessionId: 'tab-1' })
    expect(result.action).toBe('close')
    expect(result.tabs.map(tab => tab.sessionId)).toEqual(['tab-2'])
    expect(chrome.closedTargets).toEqual(['tab-1'])
    await expect(provider.observe({ kind: 'snapshot', sessionId: 'tab-1' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TARGET_NOT_FOUND' }))
  })

  it('never lists or closes tabs it does not own', async () => {
    chrome.targets.push({
      id: 'user-tab',
      type: 'page',
      url: 'https://mail.example.com/',
      title: 'Inbox',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/user-tab',
    })
    await provider.open({})

    const result = await provider.tabs({ kind: 'list' })
    expect(result.tabs.map(tab => tab.sessionId)).toEqual(['tab-2'])

    // 对不认识的 id 语义上等同「没这个会话」：不动它，也不误伤用户自己的页面。
    const closed = await provider.tabs({ kind: 'close', sessionId: 'user-tab' })
    expect(closed.action).toBe('close')
    expect(closed.tabs.map(tab => tab.sessionId)).toEqual(['tab-2'])
    expect(chrome.closedTargets).toEqual([])
  })
})

describe('CdpBrowserProvider.mutate (P1)', () => {
  let chrome: FakeChrome
  let provider: AdoptableProvider

  beforeEach(() => {
    chrome = new FakeChrome()
    chrome.axeNodes = PAGE_TREE
    provider = new AdoptableProvider({ navigationTimeoutMs: 200 }, chrome.transport())
  })

  /** 开会话并 snapshot，返回第一个 ref。 */
  async function firstRef(): Promise<string> {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    return snapshot.refs[0]?.ref as string
  }

  /** 开会话并 snapshot，返回第一个 ref **以及它的 role/name**（未导航回执要报这两个）。 */
  async function firstRefWithIdentity(): Promise<{ ref: string; role: string; name: string }> {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const first = snapshot.refs[0]
    if (first === undefined) throw new Error('快照里一个 ref 都没有')
    return { ref: first.ref, role: first.role, name: first.name }
  }

  /**
   * 这一条命令**是不是写前门**。必须按脚本内容判，不能只看方法名 ——
   * `Runtime.callFunctionOn` 在 click 路径上还用于 `locate` 的 `isConnected`、取 rect、
   * fill 的分支判定等（`provider.ts:941`、`:1504`、`:1635`、`:1665`），
   * 断 `toContain('Runtime.callFunctionOn')` 等于没断。
   */
  const isGateCall = (call: { method: string; params: Record<string, unknown> }): boolean =>
    call.method === 'Runtime.callFunctionOn'
    && String(call.params['functionDeclaration']).includes('location.href')

  it('clicks the element center with real mouse events', async () => {
    const ref = await firstRef()

    const result = await provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })
    expect(result).toMatchObject({ kind: 'mutation', action: 'click', epoch: 1, navigated: false })

    const presses = chrome.calls.filter(call => call.method === 'Input.dispatchMouseEvent')
    expect(presses.map(call => call.params['type'])).toEqual(['mousePressed', 'mouseReleased'])
    expect(presses[0]?.params).toMatchObject({ x: 60, y: 40, button: 'left', clickCount: 1 })
    // 远端对象句柄用完即还。
    expect(chrome.calls.map(call => call.method)).toContain('DOM.releaseObject')
  })

  it('names what was clicked, so a no-navigation result can say what to try next (B2-a · J5)', async () => {
    const { ref, role, name } = await firstRefWithIdentity()
    chrome.hitTest = { hit: 'target', href: 'https://example.com/go', node: null }

    const result = await provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })
    // 「点了什么」必须跟着回执走：`navigated=false` 时不说目标是谁，模型只能去翻
    // console / network 猜（方案 §6 禁止清单第四条）。
    expect(result.target).toEqual({ role, name, href: 'https://example.com/go' })
  })

  it('reports the element covering the click point instead of a silent "click done" (B1-d · J1)', async () => {
    const ref = await firstRef()
    // 落点上最顶层的是浮层，不是目标 —— 真实场景：登录浮层盖住正文里的外链。
    chrome.hitTest = {
      hit: 'other',
      href: 'https://example.com/go',
      node: { role: 'dialog', name: '登录后查看', hint: '#login-modal' },
    }

    const result = await provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })
    expect(result).toMatchObject({ navigated: false })
    expect(result.occluded_by).toEqual({ role: 'dialog', name: '登录后查看', hint: '#login-modal' })
    // **事件照样派发**：自动 Escape、自动改点遮罩上的按钮都是误触（方案 §5），不做。
    expect(chrome.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.params['type']))
      .toEqual(['mousePressed', 'mouseReleased'])
  })

  it('omits occluded_by when the point really is the target (反向验证 · 不误报)', async () => {
    const ref = await firstRef()
    chrome.hitTest = { hit: 'target', href: null, node: null }

    const result = await provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })
    // 误报遮挡比漏报更糟：模型会去关一个根本不存在的浮层。
    expect(result.occluded_by).toBeUndefined()
  })

  it('still clicks when the hit test itself cannot answer (命中校验是回执增强，不是动作)', async () => {
    const ref = await firstRef()
    // 跨源 iframe / CSP 拦下 evaluate 时查不出来。这时宁可少报一条遮挡，
    // 也不许把 click 打成失败 —— 加了新探针反而让点击不可用是最糟的回归。
    chrome.hitTest = undefined

    const result = await provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })
    expect(result).toMatchObject({ action: 'click', navigated: false })
    expect(result.occluded_by).toBeUndefined()
    expect(chrome.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(2)
  })

  it('fails a stale ref BEFORE any page command is issued (write-then-check is forbidden)', async () => {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = snapshot.refs[0]?.ref as string

    chrome.page = { url: 'https://example.com/next', title: 'Next' }
    await provider.navigate({ sessionId: session.id, url: 'https://example.com/next' })

    for (const kind of ['click', 'fill', 'press', 'scroll'] as const) {
      const before = chrome.calls.length
      const request = kind === 'fill'
        ? { kind, sessionId: session.id, ref, value: 'x' }
        : kind === 'press'
          ? { kind, sessionId: session.id, ref, key: 'Enter' }
          : kind === 'scroll'
            ? { kind, sessionId: session.id, ref, deltaY: 100 }
            : { kind, sessionId: session.id, ref }
      await expect(provider.mutate(request as never))
        .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
      // 关键断言：纪元检查在一切页面命令之前，失败时连一条新命令都没发。
      expect(chrome.calls.slice(before)).toEqual([])
    }

    await expect(provider.mutate({ kind: 'click', sessionId: session.id, ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('blocks the action when a human navigated the page behind our back (写前门 · 粗门)', async () => {
    const ref = await firstRef()
    // 关键前提：这条路由变化**没**经过 provider —— 人工在页面上点了链接，
    // `backendNodeId` 在 SPA 里根本不重编，所以纪元表和 resolveNode 全都是绿的。
    chrome.page = { url: 'https://example.com/next', title: 'Next' }

    const before = chrome.calls.length
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })).rejects.toThrow(
      expect.objectContaining({
        code: 'BROWSER_STALE_REF',
        message: 'ref "e1" points at a stale document: the page moved from https://example.com/ '
          + 'to https://example.com/next since the snapshot; the action was NOT dispatched; '
          + 'run webpage_snapshot again',
      }),
    )
    // 「动作没发出」是这道门存在的全部意义：一条输入事件都没派发。
    expect(chrome.calls.slice(before).map(call => call.method)).not.toContain('Input.dispatchMouseEvent')

    // 整个纪元已作废：同一个 ref 再用，连一条 CDP 都不会发。
    const afterInvalidate = chrome.calls.length
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
    expect(chrome.calls.slice(afterInvalidate)).toEqual([])
  })

  it('blocks the action when the element was detached but the url is unchanged (写前门 · 细门)', async () => {
    const ref = await firstRef()
    chrome.elementConnected = false

    const before = chrome.calls.length
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })).rejects.toThrow(
      expect.objectContaining({
        code: 'BROWSER_STALE_REF',
        message: 'the element for ref "e1" was removed from the document (the page may have '
          + 're-rendered); the action was NOT dispatched; run webpage_snapshot again',
      }),
    )
    expect(chrome.calls.slice(before).map(call => call.method)).not.toContain('Input.dispatchMouseEvent')
    // 「不作废纪元」必须真被验到：地址没变，页面上其余 ref 仍然可用，所以把元素放回去之后
    // 同一个号还能走到门并成功派发。若细门也 invalidate()，这里会是「零命令」的 stale 失败
    // （对照上一条用例），那才是真正的判据。
    chrome.elementConnected = true
    const afterGate = chrome.calls.length
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref }))
      .resolves.toMatchObject({ action: 'click' })
    const retry = chrome.calls.slice(afterGate).map(call => call.method)
    // 精确到「门那一条」：`Runtime.callFunctionOn` 本身在 click 路径上有好几处，断方法名恒真。
    expect(chrome.calls.slice(afterGate).filter(isGateCall)).toHaveLength(1)
    expect(retry).toContain('Input.dispatchMouseEvent')
  })

  it('reports an unacknowledged wheel instead of blocking the tool for 30s (B1-e · J6)', async () => {
    const ref = await firstRef()
    // Electron 上 `Input.dispatchMouseEvent{type:'mouseWheel'}` 实测不回包；
    // 以前它吃的是 `commandTimeoutMs`（30s），一次 scroll 就把 agent 卡满一轮工具超时。
    chrome.wheelAcks = false

    const started = Date.now()
    const result = await provider.mutate({ kind: 'scroll', sessionId: 'tab-1', ref, deltaY: 300 })
    const elapsed = Date.now() - started
    expect(result).toMatchObject({ action: 'scroll', unconfirmed: true })
    // 判据：远小于 30s 的协议超时。上限取 5s（2s 等回包 + settle 那一小段）。
    expect(elapsed).toBeLessThan(5_000)
    // **事件确实投递出去了** —— 「未确认」不等于「没发」。
    expect(chrome.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.params['type']))
      .toEqual(['mouseWheel'])
  })

  it('says nothing about being unconfirmed when the wheel does come back (反向验证 · 不误报)', async () => {
    const ref = await firstRef()

    const result = await provider.mutate({ kind: 'scroll', sessionId: 'tab-1', ref, deltaY: 300 })
    expect(result.unconfirmed).toBeUndefined()
  })

  it('brings a background tab forward before scrolling (B1-e · 后台标签)', async () => {
    // 前台是别的标签：滚轮只送前台，不切前台就是白滚（而且不会报错，只会沉默地没效果）。
    chrome.activeTargetId = 'tab-2'
    chrome.canActivate = true
    // transport 的「有没有这个能力」在 `transport()` 那一步就定下来了，所以改完必须重建 provider。
    provider = new AdoptableProvider({ navigationTimeoutMs: 200 }, chrome.transport())
    const ref = await firstRef()

    const result = await provider.mutate({ kind: 'scroll', sessionId: 'tab-1', ref, deltaY: 300 })
    expect(result).toMatchObject({ action: 'scroll' })
    expect(chrome.activateCalls).toEqual(['tab-1'])
  })

  it('refuses to scroll a background tab when the provider cannot activate (B1-e · 明确拒绝)', async () => {
    chrome.activeTargetId = 'tab-2'
    chrome.canActivate = false
    provider = new AdoptableProvider({ navigationTimeoutMs: 200 }, chrome.transport())
    const ref = await firstRef()

    await expect(provider.mutate({ kind: 'scroll', sessionId: 'tab-1', ref, deltaY: 300 })).rejects.toThrow(
      expect.objectContaining({
        code: 'BROWSER_NOT_IMPLEMENTED',
        message: expect.stringContaining('is in the background; run webpage_tabs(action=activate'),
      }),
    )
    expect(chrome.activateCalls).toEqual([])
  })

  it('does not touch the foreground when the provider cannot tell which tab is active (B1-e · 能力缺口)', async () => {
    const ref = await firstRef()
    // 外部 Chrome 答不出「谁在前台」：那是能力缺口，不是错误 —— 不许因为查不出来就拒绝滚动。
    chrome.activeTargetId = undefined

    await expect(provider.mutate({ kind: 'scroll', sessionId: 'tab-1', ref, deltaY: 300 }))
      .resolves.toMatchObject({ action: 'scroll' })
    expect(chrome.activateCalls).toEqual([])
  })

  it('blocks the action when DOM.resolveNode itself throws for a reused ref (解析失败 · 节点已消失)', async () => {
    const ref = await firstRef()
    // CDP 对**已消失**的节点是抛 -32000 协议错误，不是「成功返回但缺 objectId」。
    // 这条路径以前只有 `locate` 兜住了（它自己写了一份映射），mutate 与元素截图都漏：
    // 模型收到的是裸的 `CDP error: No node with given id found` —— 既不知道页面变了，
    // 也没有「重拍快照」的指引。真机坐实：`scripts/probe-stale-node.ts`
    //（同 URL 整页刷新后再用旧 ref，同一处代码路径）。
    chrome.resolveNodeError = 'No node with given id found'

    const before = chrome.calls.length
    await expect(provider.mutate({ kind: 'fill', sessionId: 'tab-1', ref, value: 'x' })).rejects.toThrow(
      expect.objectContaining({
        code: 'BROWSER_STALE_REF',
        message: 'the element for ref "e1" is gone from the document; run webpage_snapshot again',
      }),
    )
    // 「动作没发出」：一条输入事件都没派发。
    expect(chrome.calls.slice(before).map(call => call.method)).not.toContain('Input.insertText')
  })

  it('keeps a session-level failure distinct from a stale ref on the mutate path too', async () => {
    const ref = await firstRef()
    // detach（[V16]）是会话级状态，不是 ref 失效 —— 让模型「重拍快照」是错的指引。
    // 与 `locate` 同一分寸：这一条不许被上面那个 catch 吞成 BROWSER_STALE_REF。
    chrome.resolveNodeError = 'No target available'

    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_DEBUGGER_DETACHED' }))
  })

  it('reports the same stale ref for an element screenshot whose node is gone (同一口径)', async () => {
    const ref = await firstRef()
    // `elementClip` 以前是**裸调** `DOM.resolveNode` 的第二处 —— 同一个洞的两份拷贝。
    chrome.resolveNodeError = 'Node with given id does not belong to the document'

    await expect(provider.observe({ kind: 'screenshot', sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('lets an untouched page through, costing exactly one extra round-trip (零回归)', async () => {
    const ref = await firstRef()
    const before = chrome.calls.length

    const result = await provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })
    expect(result).toMatchObject({ action: 'click', navigated: false })

    const trace = chrome.calls.slice(before)
    // 门必须在第一个输入事件之前，且整条路径上只此一次（+1 次往返，不是 +2/+3）。
    expect(trace.filter(isGateCall)).toHaveLength(1)
    expect(trace.findIndex(isGateCall)).toBeLessThan(
      trace.findIndex(call => call.method === 'Input.dispatchMouseEvent'),
    )
  })

  it('does not trip the fine gate on wait-hidden — 消失正是它要等的结果 (J2 不误伤)', async () => {
    const ref = await firstRef()
    chrome.elementConnected = false

    const result = await provider.mutate({ kind: 'wait', sessionId: 'tab-1', ref })
    expect(result).toMatchObject({ action: 'wait', satisfied: true })
  })

  it('still runs the coarse gate for wait-hidden — 地址变了就不该接着等', async () => {
    const ref = await firstRef()
    chrome.elementConnected = false
    chrome.page = { url: 'https://example.com/next', title: 'Next' }

    await expect(provider.mutate({ kind: 'wait', sessionId: 'tab-1', ref })).rejects.toThrow(
      expect.objectContaining({
        code: 'BROWSER_STALE_REF',
        message: expect.stringContaining('points at a stale document') as unknown as string,
      }),
    )
  })

  it('compares the top document url, so refs inside an iframe are not false positives (J2 不误伤)', async () => {
    const ref = await firstRef()
    // 元素在 iframe 里：它自己那个文档的地址与纪元里那份完全不同。门若读 `location.href`
    // 就会把一次正常点击判成「页面导航了」并作废整张 ref 表。
    chrome.frameHref = 'https://child.example.com/form'

    const before = chrome.calls.length
    const result = await provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })
    expect(result).toMatchObject({ action: 'click' })
    expect(chrome.calls.slice(before).map(call => call.method)).toContain('Input.dispatchMouseEvent')
  })

  it('lets an iframe ref through when the top document url is unreadable (跨源 · 没证据就放行)', async () => {
    const ref = await firstRef()
    chrome.crossOriginFrame = true
    chrome.frameHref = 'https://child.example.com/form'

    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref }))
      .resolves.toMatchObject({ action: 'click' })
  })

  it('keeps the fine gate alive inside a cross-origin iframe — 兜住异常才有 connected 可读', async () => {
    const ref = await firstRef()
    chrome.crossOriginFrame = true
    chrome.frameHref = 'https://child.example.com/form'
    chrome.elementConnected = false

    // 脚本里那个 try/catch 不是为了让粗门多覆盖一档（跨源本来就读不到，照样放行），而是为了让
    // 同一次往返**仍然带回 `isConnected`**。把 try/catch 摘掉，整次调用就没有返回值，两道门一起
    // 静默 —— 这条用例即红。
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_STALE_REF' }),
    )
  })

  it('re-arms the coarse gate after revalidate refills the epoch url (堵住「拦一次、永久放行」)', async () => {
    const ref = await firstRef()
    // ① 人工在同一个文档里换路由（SPA：`loaderId` 不变，所以归档四道门放得行）。
    chrome.page = { url: 'https://example.com/next', title: 'Next' }
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))

    // ② 模型 revalidate 把同一个号装回来。这一步必须把「恢复当下」的地址补给纪元 ——
    //    `invalidate()` 已经把 `epochUrl` 清空了。
    const result = await provider.revalidate({ sessionId: 'tab-1', refs: [ref] })
    expect(result.restored.map(entry => entry.ref)).toEqual([ref])
    expect(result.failed).toEqual([])

    // ③ 再来一次人工导航：粗门必须**仍然拦得住**。少实参 / 少回填任何一环，纪元地址都是空的，
    //    按「没证据就放行」的纪律这次 click 会直接派发 —— 那正是本用例要消灭的复发形态。
    chrome.page = { url: 'https://example.com/third', title: 'Third' }
    const before = chrome.calls.length
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })).rejects.toThrow(
      expect.objectContaining({
        code: 'BROWSER_STALE_REF',
        message: expect.stringContaining('points at a stale document') as unknown as string,
      }),
    )
    expect(chrome.calls.slice(before).map(call => call.method)).not.toContain('Input.dispatchMouseEvent')
  })

  it('refills the epoch url from the SAME source the gate reads, not the frame-tree mirror (J2 不误伤)', async () => {
    const ref = await firstRef()
    chrome.page = { url: 'https://example.com/next', title: 'Next' }
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))

    // 浏览器进程侧的 frame tree 还停在旧地址（导航在飞 / 重定向 / 特权页读到 about:blank#blocked）。
    // provider 现在根本不读这一份，所以纪元的基线只能来自 renderer：回填之后地址没再动，
    // 点击**必须放行**。若把回填改回 `Page.getFrameTree` 的 url，这里会变红 —— 一次完全正常的
    // 操作被判成「页面导航了」并作废整个纪元。
    chrome.frameTreeUrl = 'https://example.com/'
    await provider.revalidate({ sessionId: 'tab-1', refs: [ref] })

    const before = chrome.calls.length
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref }))
      .resolves.toMatchObject({ action: 'click' })
    expect(chrome.calls.slice(before).map(call => call.method)).toContain('Input.dispatchMouseEvent')
  })

  it('refills the epoch url even when revalidate restores nothing (publish 没读到地址的纪元)', async () => {
    // 开会话与那次 snapshot 的页面地址都读不到（空白页 / 已崩溃）→ 纪元里的 ref 有效，
    // 但从来没有过粗门依据。
    chrome.pageMetaFailReads = 2
    const ref = await firstRef()

    // revalidate 命中的是**当前表**（`pending` 为空），什么也没恢复 —— 但依据必须照样补上。
    // 少这一环，这个纪元从此永久关掉粗门（下面那次导航会变成静默点错）。
    await provider.revalidate({ sessionId: 'tab-1', refs: [ref] })
    chrome.page = { url: 'https://example.com/next', title: 'Next' }
    const before = chrome.calls.length
    await expect(provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })).rejects.toThrow(
      expect.objectContaining({
        code: 'BROWSER_STALE_REF',
        message: expect.stringContaining('points at a stale document') as unknown as string,
      }),
    )
    expect(chrome.calls.slice(before).map(call => call.method)).not.toContain('Input.dispatchMouseEvent')
  })

  it('requires a snapshot before mutating a page the model never observed', async () => {
    const session = await provider.open({})
    const before = chrome.calls.length

    await expect(provider.mutate({ kind: 'click', sessionId: session.id, ref: 'e1' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
    expect(chrome.calls.slice(before)).toEqual([])
  })

  it('counts each stale hit into the bucket of the gate that refused it (P0 取数)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-p0-'))
    const saved = process.env[METRICS_ENV]
    process.env[METRICS_ENV] = directory
    try {
      // 计数在 provider **构造时**读环境变量，所以这条用例必须自己建一个实例，不能借 beforeEach 那个。
      const counted = new AdoptableProvider({ navigationTimeoutMs: 200 }, chrome.transport())
      const session = await counted.open({})
      const snapshot = await counted.observe({ kind: 'snapshot', sessionId: session.id })
      if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
      const ref = snapshot.refs[0]?.ref as string

      // ① 人工在后台换了路由 → 粗门拒，桶是 `stale_document`。
      chrome.page = { url: 'https://example.com/next', title: 'Next' }
      await expect(counted.mutate({ kind: 'click', sessionId: session.id, ref }))
        .rejects.toThrow(expect.objectContaining({ reason: 'stale_document' }))
      // ② 纪元已被作废 → 同一个号再来一次走 `resolve` 那一档，落在**另一只**桶里 ——
      //    「换文档导致的旧号」与「号本身过期」混在一个数里，P0 就白做了。
      await expect(counted.mutate({ kind: 'click', sessionId: session.id, ref }))
        .rejects.toThrow(expect.objectContaining({ reason: 'obsolete_epoch' }))

      await counted.dispose()
      const lines = (await readFile(join(directory, `${session.id}.jsonl`), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        sessionId: session.id,
        // 分母：两次 mutate（`observe` 不算，见 metrics.ts 对 refCalls 的定义）。
        refCalls: 2,
        stale: { stale_document: 1, obsolete_epoch: 1 },
        staleTotal: 2,
      })
    } finally {
      if (saved === undefined) delete process.env[METRICS_ENV]
      else process.env[METRICS_ENV] = saved
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('produces no file at all when DSH_BROWSER_PLUGIN_METRICS is unset (默认关)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-p0-off-'))
    const saved = process.env[METRICS_ENV]
    delete process.env[METRICS_ENV]
    try {
      const quiet = new AdoptableProvider({ navigationTimeoutMs: 200 }, chrome.transport())
      const session = await quiet.open({})
      const snapshot = await quiet.observe({ kind: 'snapshot', sessionId: session.id })
      if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
      chrome.page = { url: 'https://example.com/next', title: 'Next' }
      await expect(quiet.mutate({ kind: 'click', sessionId: session.id, ref: snapshot.refs[0]?.ref as string }))
        .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
      await quiet.dispose()

      // 两半判据缺一不可。
      // ② 目录里**一个条目都没有**，不是「文件是空的」—— 空文件同样是 IO，也是「说好了默认关」的破例。
      expect(await readdir(directory)).toEqual([])
      // ① 但只有 ② 是**装饰性的**：环境变量没设时 sink 本来就不知道该写哪个目录，② 永远绿。
      //    真正钉住「未设置 = 整条 no-op」的是这一条 —— provider 用的是无参构造，
      //    而无参构造在环境变量缺席时必须报告「没在计数」。把构造改成写死一个默认目录，这条即红。
      expect(new StaleRefMetrics().active).toBe(false)
    } finally {
      if (saved === undefined) delete process.env[METRICS_ENV]
      else process.env[METRICS_ENV] = saved
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports navigated=true and invalidates the epoch when a click navigates', async () => {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = snapshot.refs[0]?.ref as string
    chrome.navigateOnClick = true

    const result = await provider.mutate({ kind: 'click', sessionId: session.id, ref })
    expect(result).toMatchObject({
      action: 'click',
      navigated: true,
      url: 'https://example.com/next',
      epoch: 2,
    })
    // 旧 ref 已随导航作废：旧 ref 再来一次点击必须立刻失败。
    await expect(provider.mutate({ kind: 'click', sessionId: session.id, ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('reports a tab the page popped open during the click (openedTabs)', async () => {
    const ref = await firstRef()
    // 闭包必须绑**本用例的实例**：`provider` 是 module 级变量，会被 beforeEach 重指，
    // 若直接引用变量，延迟触发的通报会落进下一个用例的 provider（串台）。
    const instance = provider
    let adopted: Promise<unknown> | undefined
    chrome.popupOnClick = popupTarget()
    // 真链路上是宿主收编；这里直接调 adoptSession 走同一条登记路径。
    chrome.onPopup = target => { adopted = instance.adopt(target) }

    const result = await provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })

    expect(result.navigated).toBe(false)
    // 不导航的点击会跑满 800ms 导航轮询，150ms 级的通报天然被覆盖 —— 无需补窗口。
    expect(result.openedTabs?.map(tab => tab.sessionId)).toEqual(['popup-9'])
    // transport 判不了前台（默认 FakeChrome 没有 activeTargetId）时省略 active 字段。
    expect(result.openedTabs?.[0]).toEqual({ sessionId: 'popup-9', url: expect.any(String), title: expect.any(String) })
    await adopted
  })

  it('marks the popped-open tab as foreground when the transport can tell (openedTabs active)', async () => {
    // 与 listTabs 同一信号（transport.activeTargetId）：新标签被点名时还带 [foreground]。
    const activeChrome = new FakeChrome()
    activeChrome.axeNodes = PAGE_TREE
    const withActive = new AdoptableProvider({ navigationTimeoutMs: 200 }, {
      ...activeChrome.transport(),
      activeTargetId: () => Promise.resolve('popup-9'),
    })
    const session = await withActive.open({})
    const snapshot = await withActive.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = snapshot.refs[0]?.ref as string
    let adopted: Promise<unknown> | undefined
    activeChrome.popupOnClick = popupTarget()
    activeChrome.onPopup = target => { adopted = withActive.adopt(target) }

    const result = await withActive.mutate({ kind: 'click', sessionId: session.id, ref })

    expect(result.openedTabs?.[0]).toMatchObject({ sessionId: 'popup-9', active: true })
    await adopted
  })

  it('reports the popup even when the click also navigated the opener (grace window)', async () => {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = snapshot.refs[0]?.ref as string
    // 脚本里 `location.href = ...` 与 `window.open` 并发：导航首检即命中，
    // 800ms 轮询窗口提前结束 —— 通报还没到。这正是补观测窗口存在的理由。
    chrome.navigateOnClick = true
    const instance = provider
    let adopted: Promise<unknown> | undefined
    chrome.popupOnClick = popupTarget()
    chrome.onPopup = target => { adopted = instance.adopt(target) }

    const result = await provider.mutate({ kind: 'click', sessionId: session.id, ref })

    expect(result.navigated).toBe(true)
    expect(result.openedTabs?.map(tab => tab.sessionId)).toEqual(['popup-9'])
    await adopted
  })

  it('omits openedTabs when the click opened nothing (反向验证)', async () => {
    const ref = await firstRef()

    const result = await provider.mutate({ kind: 'click', sessionId: 'tab-1', ref })

    // 字段本身不出现（不是空数组）：工具层据此决定要不要渲染那一段提示。
    expect(result.openedTabs).toBeUndefined()
    expect('openedTabs' in result).toBe(false)
  })

  it('fills through the native value setter and fires input + change', async () => {
    const ref = await firstRef()

    const result = await provider.mutate({ kind: 'fill', sessionId: 'tab-1', ref, value: 'me@example.com' })
    expect(result).toMatchObject({ action: 'fill', navigated: false })

    // 按脚本内容挑，不按「第一条 callFunctionOn」挑 —— mutate 路径现在第一条是写前门。
    const call = chrome.calls.find(candidate => candidate.method === 'Runtime.callFunctionOn'
      && String(candidate.params['functionDeclaration']).includes('dispatchEvent'))
    expect(call?.params['arguments']).toEqual([{ value: 'me@example.com' }])
    expect(String(call?.params['functionDeclaration'])).toContain('dispatchEvent')
  })

  it('presses a named key after focusing the element, and rejects unknown keys', async () => {
    const ref = await firstRef()

    const result = await provider.mutate({ kind: 'press', sessionId: 'tab-1', ref, key: 'Enter' })
    expect(result).toMatchObject({ action: 'press' })

    const keyEvents = chrome.calls.filter(call => call.method === 'Input.dispatchKeyEvent')
    expect(keyEvents.map(call => call.params['type'])).toEqual(['keyDown', 'keyUp'])
    expect(keyEvents[0]?.params).toMatchObject({ key: 'Enter', windowsVirtualKeyCode: 13 })

    await expect(provider.mutate({ kind: 'press', sessionId: 'tab-1', ref, key: 'Bogus' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('presses a printable character with its text payload', async () => {
    const ref = await firstRef()
    await provider.mutate({ kind: 'press', sessionId: 'tab-1', ref, key: 'a' })

    const down = chrome.calls.find(call =>
      call.method === 'Input.dispatchKeyEvent' && call.params['type'] === 'keyDown')
    expect(down?.params).toMatchObject({ key: 'a', text: 'a' })
  })

  it('accepts both "Space" and " " as the space key ([2026-09-18]: the advertised name was rejected)', async () => {
    const ref = await firstRef()

    // 工具描述与错误文案都把 `Space` 当命名键宣传 —— 它必须真的能用，否则模型照描述写就被拒。
    const named = await provider.mutate({ kind: 'press', sessionId: 'tab-1', ref, key: 'Space' })
    expect(named).toMatchObject({ action: 'press' })
    const down = chrome.calls.find(call =>
      call.method === 'Input.dispatchKeyEvent' && call.params['type'] === 'keyDown')
    // `text` 不能少：CDP 的 keyDown 不带 text 不会合成字符插入（聚焦输入框按空格收不到东西）。
    expect(down?.params).toMatchObject({ key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' })

    // 单字符写法等价（两个名字共用同一份键参数）。
    chrome.calls.length = 0
    await provider.mutate({ kind: 'press', sessionId: 'tab-1', ref, key: ' ' })
    const spaced = chrome.calls.find(call =>
      call.method === 'Input.dispatchKeyEvent' && call.params['type'] === 'keyDown')
    expect(spaced?.params).toMatchObject({ key: ' ', code: 'Space', text: ' ' })

    // 反向验证：不在这张表里、也不是单字符的键名照样拒。
    await expect(provider.mutate({ kind: 'press', sessionId: 'tab-1', ref, key: 'Meta' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('fills a contenteditable through the browser input pipeline so beforeinput fires', async () => {
    const ref = await firstRef()
    chrome.fillEditable = true

    await provider.mutate({ kind: 'fill', sessionId: 'tab-1', ref, value: '帮我写个总结' })

    // 页面内那一步只做「聚焦 + 全选」：`Input.insertText` 是「在选区处插入」，
    // 不先全选就会把新值拼到旧内容后面。
    // 按脚本内容挑，并核对它排在插入之前 —— mutate 路径上现在还有写前门那条 `callFunctionOn`，
    // 「第一条」不再是它。
    const probeIndex = chrome.calls.findIndex(call => call.method === 'Runtime.callFunctionOn'
      && String(call.params['functionDeclaration']).includes('selectNodeContents'))
    const insertIndex = chrome.calls.findIndex(call => call.method === 'Input.insertText')
    expect(probeIndex).toBeGreaterThanOrEqual(0)
    expect(probeIndex).toBeLessThan(insertIndex)
    // 真正的写入走原生输入管线 —— 否则 Lexical / ProseMirror 收不到 beforeinput，状态不更新。
    expect(chrome.calls[insertIndex]?.params).toEqual({ text: '帮我写个总结' })
  })

  it('never calls Input.insertText for a plain input (反向验证)', async () => {
    const ref = await firstRef()

    await provider.mutate({ kind: 'fill', sessionId: 'tab-1', ref, value: 'me@example.com' })

    expect(chrome.calls.some(call => call.method === 'Input.insertText')).toBe(false)
  })

  it('scrolls with a wheel event at the element center and refuses zero deltas', async () => {
    const ref = await firstRef()

    const result = await provider.mutate({ kind: 'scroll', sessionId: 'tab-1', ref, deltaY: 600 })
    expect(result).toMatchObject({ action: 'scroll' })

    const wheel = chrome.calls.find(call => call.method === 'Input.dispatchMouseEvent')
    expect(wheel?.params).toMatchObject({ type: 'mouseWheel', x: 60, y: 40, deltaY: 600 })

    await expect(provider.mutate({ kind: 'scroll', sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('scrolls at the viewport centre when no ref is given, without requiring a snapshot', async () => {
    await provider.open({})
    const before = chrome.calls.length

    const result = await provider.mutate({ kind: 'scroll', sessionId: 'tab-1', deltaY: 800 })
    expect(result).toEqual({
      kind: 'mutation',
      sessionId: 'tab-1',
      action: 'scroll',
      epoch: 0,
      url: 'https://example.com/',
      title: 'Example',
      navigated: false,
    })

    const wheel = chrome.calls.slice(before).find(call => call.method === 'Input.dispatchMouseEvent')
    // 视口 1280×720 ⇒ 落点是正中央。
    expect(wheel?.params).toMatchObject({ type: 'mouseWheel', x: 640, y: 360, deltaY: 800 })
    // 没有任何 ref 参与：既不该 resolveNode，也不该因为「没 snapshot 过」而拒绝 ——
    // 这正是「只有标题的页面」与长文页上唯一能用的滚动方式（报告 S3/S5）。
    expect(chrome.calls.slice(before).some(call => call.method === 'DOM.resolveNode')).toBe(false)
  })

  it('waits for the new document title after a navigating press (report S1)', async () => {
    const ref = await firstRef()
    chrome.navigateOnEnter = true
    // 第一次读元信息时地址已变、标题还没解析出来；此时文档也还没 complete。
    chrome.titleEmptyReads = 1
    chrome.readyStateComplete = false

    const result = await provider.mutate({ kind: 'press', sessionId: 'tab-1', ref, key: 'Enter' })

    expect(result.navigated).toBe(true)
    expect(result.url).toBe('https://zh.wikipedia.org/w/index.php?search=Electron')
    // 关键断言：返回的 title 不再是空串（旧实现会给 ''，调用方据此误判「页没就绪」）。
    expect(result.title).toBe('Electron (software) - 维基百科，自由的百科全书')
  })

  it('waits for a duration, for text to appear, or for an element to disappear', async () => {
    await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = snapshot.refs[0]?.ref as string

    const timed = await provider.mutate({ kind: 'wait', sessionId: 'tab-1', timeMs: 10 })
    expect(timed).toMatchObject({ action: 'wait', satisfied: true })

    chrome.waitTextFound = true
    const text = await provider.mutate({ kind: 'wait', sessionId: 'tab-1', text: 'Hello' })
    expect(text).toMatchObject({ action: 'wait', satisfied: true })

    chrome.elementConnected = false
    const hidden = await provider.mutate({ kind: 'wait', sessionId: 'tab-1', ref })
    expect(hidden).toMatchObject({ action: 'wait', satisfied: true })
  })

  it('reports satisfied=false (not an error) when a wait times out, and rejects ambiguous waits', async () => {
    chrome.waitTextFound = false
    chrome.elementConnected = true
    const timeoutProvider = new CdpBrowserProvider({ waitTimeoutMs: 150 }, chrome.transport())
    await timeoutProvider.open({})
    const snapshot = await timeoutProvider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')

    const timedOut = await timeoutProvider.mutate({ kind: 'wait', sessionId: 'tab-1', text: 'Never' })
    expect(timedOut).toMatchObject({ action: 'wait', satisfied: false })

    await expect(timeoutProvider.mutate({ kind: 'wait', sessionId: 'tab-1' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
    await expect(timeoutProvider.mutate({ kind: 'wait', sessionId: 'tab-1', timeMs: 100, text: 'x' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
    await expect(timeoutProvider.mutate({ kind: 'wait', sessionId: 'tab-1', timeMs: 40_000 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('waits until the page is stable when DOM and network stay quiet', async () => {
    chrome.readyStateComplete = true
    chrome.domMutationDelta = 0
    const stableProvider = new CdpBrowserProvider({
      navigationTimeoutMs: 200,
      stableQuietWindowMs: 20,
      stableNetworkGraceMs: 50,
    }, chrome.transport())
    await stableProvider.open({})

    const result = await stableProvider.mutate({ kind: 'wait', sessionId: 'tab-1', until: 'stable', timeoutMs: 400 })
    expect(result).toMatchObject({
      action: 'wait',
      satisfied: true,
      signals: { readyState: 'complete', dom: 'quiet', network: 'quiet' },
    })
  })

  it('times out on a heartbeat page and reports which signals stayed busy', async () => {
    chrome.readyStateComplete = true
    chrome.domMutationDelta = 3
    const stableProvider = new CdpBrowserProvider({
      navigationTimeoutMs: 200,
      stableQuietWindowMs: 20,
      stableNetworkGraceMs: 50,
    }, chrome.transport())
    await stableProvider.open({})

    const result = await stableProvider.mutate({ kind: 'wait', sessionId: 'tab-1', until: 'stable', timeoutMs: 80 })
    expect(result.satisfied).toBe(false)
    expect(result.signals).toEqual({ readyState: 'complete', dom: 'busy', network: 'quiet' })
  })

  it('rejects mixing until:stable with time_ms / text / ref', async () => {
    await provider.open({})
    await expect(provider.mutate({ kind: 'wait', sessionId: 'tab-1', until: 'stable', timeMs: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })
})

/** 往一条已建立的连接里注入一条 CDP 事件。 */
function emitCdp(socket: FakeSocket, method: string, params: unknown): void {
  socket.dispatch('message', { data: JSON.stringify({ method, params }) })
}

describe('P2: console / network / execute', () => {
  let chrome: FakeChrome
  let provider: CdpBrowserProvider

  beforeEach(() => {
    chrome = new FakeChrome()
    chrome.axeNodes = PAGE_TREE
    provider = new CdpBrowserProvider({ navigationTimeoutMs: 200 }, chrome.transport())
  })

  it('forces returnByValue on Runtime.evaluate and returns the value', async () => {
    await provider.open({})

    const result = await provider.execute({
      sessionId: 'tab-1',
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' },
    })

    expect(result).toMatchObject({ kind: 'execute', method: 'Runtime.evaluate', value: 2, truncated: false })
    const call = chrome.calls.filter(entry => entry.method === 'Runtime.evaluate')
      .find(entry => entry.params['expression'] === '1 + 1')
    expect(call?.params['returnByValue']).toBe(true)
    // 2026-09-14：Promise 必须被 await —— 否则 `fetch(...).then(...)` 只会回一个没有 value
    // 的 Promise，被当成「不可序列化」拒掉（报告 S5，而副作用其实已经发生）。
    expect(call?.params['awaitPromise']).toBe(true)
  })

  it('runs Runtime.evaluate with a user gesture so activation-gated APIs work (2026-09-18)', async () => {
    await provider.open({})

    await provider.execute({
      sessionId: 'tab-1',
      method: 'Runtime.evaluate',
      params: { expression: 'navigator.clipboard.writeText("x")' },
    })

    const call = chrome.calls.filter(entry => entry.method === 'Runtime.evaluate')
      .find(entry => String(entry.params['expression']).includes('clipboard'))
    // 不带 user gesture 时，clipboard / requestFullscreen / window.open / 媒体自动播放一律被
    // 页面拒成 `NotAllowedError: Transient user activation is required` —— 模型看到的就是
    // 「JS 执行不了」。
    expect(call?.params['userGesture']).toBe(true)
  })

  it('reports navigated=true when the evaluated expression changed the URL (2026-09-17)', async () => {
    await provider.open({})
    // 表达式本身照旧返回 2，但页面地址被它改了（`location.href = '/next'` 那类副作用）。
    chrome.page = { url: 'https://example.com/next', title: 'Next' }

    const result = await provider.execute({
      sessionId: 'tab-1',
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' },
    })

    // 以前这里恒 false —— 回执说「refs 仍有效」，模型拿着已废的 ref 继续点，
    // 撞 BROWSER_STALE_REF 时毫无预兆。
    expect(result).toMatchObject({ kind: 'execute', navigated: true, url: 'https://example.com/next', value: 2 })
  })

  it('still reports navigated=false when the expression left the URL alone', async () => {
    await provider.open({})

    const result = await provider.execute({
      sessionId: 'tab-1',
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' },
    })

    expect(result.navigated).toBe(false)
  })

  it('overrides a caller that tries to turn awaitPromise off', async () => {
    await provider.open({})
    await provider.execute({
      sessionId: 'tab-1',
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1', awaitPromise: false },
    })

    const call = chrome.calls.filter(entry => entry.method === 'Runtime.evaluate')
      .find(entry => entry.params['expression'] === '1 + 1')
    expect(call?.params['awaitPromise']).toBe(true)
  })

  it('surfaces the real exception text instead of "unserializable" when the expression throws', async () => {
    await provider.open({})
    chrome.evaluateThrows = 'TypeError: Cannot read properties of null (reading "x")'

    await expect(provider.execute({
      sessionId: 'tab-1',
      method: 'Runtime.evaluate',
      params: { expression: 'throw new Error("boom")' },
    })).rejects.toThrow(expect.objectContaining({
      code: 'BROWSER_PROTOCOL_ERROR',
      message: expect.stringContaining('TypeError: Cannot read properties of null') as unknown as string,
    }))
  })

  it('refuses a non-allow-listed command before anything is sent', async () => {
    await provider.open({})

    await expect(provider.execute({
      sessionId: 'tab-1',
      method: 'Network.emulateNetworkConditions',
      params: { offline: true },
    })).rejects.toThrow(expect.objectContaining({
      code: 'BROWSER_EXECUTE_NOT_ALLOWED',
      message: expect.stringContaining('Network.emulateNetworkConditions') as unknown as string,
    }))

    expect(chrome.calls.some(call => call.method === 'Network.emulateNetworkConditions')).toBe(false)
  })

  it('runs a navigation command through the existing epoch path ([Page.navigate])', async () => {
    await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const epochBefore = snapshot.epoch
    const staleRef = snapshot.refs[0]?.ref as string

    const result = await provider.execute({
      sessionId: 'tab-1',
      method: 'Page.navigate',
      params: { url: 'https://other.example/' },
    })

    // FakeChrome 里 page.url 不变 → detectNavigation 判定「地址没变」，
    // 但导航类命令仍无条件作废旧纪元（Page.reload 语义）。
    expect(result).toMatchObject({ kind: 'execute', method: 'Page.navigate', navigated: true })
    expect(result.epoch).toBeGreaterThan(epochBefore)
    // 旧 ref 已随纪元作废：再用必须立刻报 BROWSER_STALE_REF。
    await expect(provider.observe({ kind: 'screenshot', sessionId: 'tab-1', ref: staleRef }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('re-enables both console domains before reading and propagates the detached error', async () => {
    await provider.open({})
    const socket = chrome.sockets[0]
    if (socket === undefined) throw new Error('no connection was opened')

    // detach 期间读 console：enable 命令同步抛 `No target available` → 可恢复错误上抛。
    chrome.detachError = 'No target available'
    await expect(provider.console({ sessionId: 'tab-1', limit: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_DEBUGGER_DETACHED' }))
    const enablesBefore = chrome.calls.filter(call => call.method === 'Runtime.enable').length

    // re-attach 后恢复：实时事件入缓冲，读取前先补发 enable，重放被高水位吃掉。
    chrome.detachError = undefined
    emitCdp(socket, 'Runtime.consoleAPICalled', {
      type: 'log',
      timestamp: 1000_500,
      executionContextId: 1,
      args: [{ type: 'string', value: 'hello' }],
    })
    const result = await provider.console({ sessionId: 'tab-1', limit: 10 })

    expect(result).toMatchObject({ kind: 'console', replayTruncated: false })
    expect(result.entries.map(entry => entry.text)).toEqual(['hello'])
    expect(chrome.calls.filter(call => call.method === 'Runtime.enable').length).toBeGreaterThan(enablesBefore)
    expect(chrome.calls.filter(call => call.method === 'Log.enable').length).toBeGreaterThan(0)
  })

  it('scopes console / network to the current document and reports what it hid (report S5)', async () => {
    await provider.open({})
    const socket = chrome.sockets[0]
    if (socket === undefined) throw new Error('no connection was opened')

    // 第一个文档（维基）：一条 console + 一次请求。
    emitCdp(socket, 'Runtime.consoleAPICalled', {
      type: 'log', timestamp: 1000_500, executionContextId: 1, args: [{ type: 'string', value: 'from-wikipedia' }],
    })
    emitCdp(socket, 'Network.requestWillBeSent', {
      requestId: 'wiki-1', request: { method: 'GET', url: 'https://wikipedia.org/' },
    })

    // 导航到别的站（走 provider.navigate，它会推进文档序号）。
    await provider.navigate({ sessionId: 'tab-1', url: 'https://httpbin.org/html' })
    emitCdp(socket, 'Runtime.consoleAPICalled', {
      type: 'log', timestamp: 2000_500, executionContextId: 2, args: [{ type: 'string', value: 'from-httpbin' }],
    })
    emitCdp(socket, 'Network.requestWillBeSent', {
      requestId: 'http-1', request: { method: 'GET', url: 'https://httpbin.org/html' },
    })

    const console = await provider.console({ sessionId: 'tab-1', limit: 50 })
    expect(console.entries.map(entry => entry.text)).toEqual(['from-httpbin'])
    expect(console.document).toBe(1)
    expect(console.earlierDocuments).toBe(1)

    const network = await provider.network({ kind: 'list', sessionId: 'tab-1' })
    expect(network.requests.map(entry => entry.requestId)).toEqual(['http-1'])
    expect(network.document).toBe(1)
    expect(network.earlierDocuments).toBe(1)

    // 显式要看全部时能读回来（过滤不等于丢数据）。
    const all = await provider.console({ sessionId: 'tab-1', limit: 50, allDocuments: true })
    expect(all.entries.map(entry => entry.text)).toEqual(['from-httpbin', 'from-wikipedia'])
    const allRequests = await provider.network({ kind: 'list', sessionId: 'tab-1', allDocuments: true })
    expect(allRequests.requests.map(entry => entry.requestId)).toEqual(['http-1', 'wiki-1'])
  })

  it('lists collected requests and fetches a body by the id from the events', async () => {
    await provider.open({})
    const socket = chrome.sockets[0]
    if (socket === undefined) throw new Error('no connection was opened')

    emitCdp(socket, 'Network.requestWillBeSent', {
      requestId: '37668.2',
      request: { method: 'GET', url: 'https://api.example.com/ping' },
    })
    emitCdp(socket, 'Network.responseReceived', {
      requestId: '37668.2',
      response: { url: 'https://api.example.com/ping', status: 200, mimeType: 'application/json' },
    })

    const listed = await provider.network({ kind: 'list', sessionId: 'tab-1' })
    expect(listed).toMatchObject({ kind: 'network', action: 'list' })
    expect(listed.requests).toEqual([
      expect.objectContaining({
        requestId: '37668.2',
        method: 'GET',
        url: 'https://api.example.com/ping',
        status: 200,
        mimeType: 'application/json',
      }),
    ])

    const body = await provider.network({ kind: 'body', sessionId: 'tab-1', requestId: '37668.2' })
    expect(body).toMatchObject({ kind: 'network', action: 'body', requestId: '37668.2', body: 'pong' })
    const call = chrome.calls.filter(entry => entry.method === 'Network.getResponseBody').at(-1)
    expect(call?.params).toEqual({ requestId: '37668.2' })
  })
})

describe('B2-b: webpage_navigate 走历史栈（back / forward / reload）', () => {
  let chrome: FakeChrome
  let provider: CdpBrowserProvider

  beforeEach(() => {
    chrome = new FakeChrome()
    chrome.axeNodes = PAGE_TREE
    provider = new CdpBrowserProvider({ navigationTimeoutMs: 200 }, chrome.transport())
  })

  it('goes back through Page.getNavigationHistory + navigateToHistoryEntry (J4)', async () => {
    await provider.open({})
    // 先真的跳到第二页（否则「回退」前后地址一样，等地址变就永远等不出来）。
    // `page` 是 `readPageMeta` 的返回值源，改它才能让 provider 记住「现在在第二页」。
    chrome.page = { url: 'https://example.com/next', title: 'Next' }
    await provider.navigate({ sessionId: 'tab-1', url: 'https://example.com/next' })
    // 铺一条两节的历史栈，当前停在第二节 —— 回到上一页才有意义。
    chrome.history = {
      currentIndex: 1,
      entries: [{ id: 1, url: 'https://example.com/' }, { id: 2, url: 'https://example.com/next' }],
    }

    const before = chrome.calls.length
    const session = await provider.navigate({ sessionId: 'tab-1', history: 'back' })
    expect(session.url).toBe('https://example.com/')
    // 只看 back 这一段：上面那次 url 跳转自然带着 `Page.navigate`。
    const methods = chrome.calls.slice(before).map(call => call.method)
    expect(methods).toContain('Page.getNavigationHistory')
    expect(methods).toContain('Page.navigateToHistoryEntry')
    expect(methods).not.toContain('Page.navigate')
    // 回退的是**上一节**，不是随便哪一节。
    const entryCall = chrome.calls.find(call => call.method === 'Page.navigateToHistoryEntry')
    expect(entryCall?.params['entryId']).toBe(1)
  })

  it('refuses to go past either end of the history instead of silently no-op-ing (J4)', async () => {
    await provider.open({})
    // 默认只有一条历史：两头都是尽头。
    await expect(provider.navigate({ sessionId: 'tab-1', history: 'back' })).rejects.toThrow(
      expect.objectContaining({
        code: 'BROWSER_NAVIGATION_FAILED',
        message: expect.stringContaining('cannot go back'),
      }),
    )
    await expect(provider.navigate({ sessionId: 'tab-1', history: 'forward' })).rejects.toThrow(
      expect.objectContaining({
        code: 'BROWSER_NAVIGATION_FAILED',
        message: expect.stringContaining('cannot go forward'),
      }),
    )
    // 静默 no-op 才是这里要防的：什么都没做，就不许发出任何跳转命令。
    expect(chrome.calls.map(call => call.method)).not.toContain('Page.navigateToHistoryEntry')
  })

  it('reloads the current document without waiting for a url change', async () => {
    await provider.open({})

    const session = await provider.navigate({ sessionId: 'tab-1', history: 'reload' })
    // reload 地址不变 —— 判据若是「等地址变」就会等到超时。这里必须成功返回。
    expect(session.url).toBe('https://example.com/')
    expect(chrome.reloadCount).toBe(1)
    expect(chrome.calls.map(call => call.method)).not.toContain('Page.getNavigationHistory')
  })

  it('rejects url and history together, and rejects neither (互斥 · 不猜)', async () => {
    await provider.open({})

    await expect(provider.navigate({ sessionId: 'tab-1', url: 'https://example.com/x', history: 'back' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'BROWSER_PROTOCOL_ERROR',
        message: 'webpage_navigate needs exactly one of url or history (back / forward / reload)',
      }))
    await expect(provider.navigate({ sessionId: 'tab-1' })).rejects.toThrow(
      expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }),
    )
    // 被拒的请求一条命令都不许发（与写前门同一分寸）。
    expect(chrome.calls.map(call => call.method)).not.toContain('Page.navigate')
  })

  it('invalidates the refs of the session it navigated (与 url 跳转同口径)', async () => {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = snapshot.refs[0]?.ref as string
    chrome.page = { url: 'https://example.com/next', title: 'Next' }
    await provider.navigate({ sessionId: 'tab-1', url: 'https://example.com/next' })
    chrome.history = {
      currentIndex: 1,
      entries: [{ id: 1, url: 'https://example.com/' }, { id: 2, url: 'https://example.com/next' }],
    }

    await provider.navigate({ sessionId: 'tab-1', history: 'back' })
    // 历史跳转也是「换文档」：旧 ref 必须失效，否则模型会静默点到新页面上的另一个元素。
    await expect(provider.mutate({ kind: 'click', sessionId: session.id, ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })
})

describe('P3: locate', () => {
  let chrome: FakeChrome
  let provider: CdpBrowserProvider

  beforeEach(() => {
    chrome = new FakeChrome()
    chrome.axeNodes = PAGE_TREE
    provider = new CdpBrowserProvider({ navigationTimeoutMs: 200 }, chrome.transport())
  })

  /** 开会话并 snapshot，返回第一个 ref（以及 snapshot 结束时的调用数）。 */
  async function firstRef(): Promise<{ ref: string; before: number }> {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    return { ref: snapshot.refs[0]?.ref as string, before: chrome.calls.length }
  }

  it('resolves the ref, checks isConnected, then measures a fresh rect — in that order', async () => {
    const { ref, before } = await firstRef()

    const result = await provider.locate({ sessionId: 'tab-1', ref })
    expect(result).toEqual({
      kind: 'locate',
      sessionId: 'tab-1',
      epoch: 1,
      ref,
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      centered: false,
      inViewport: true,
    })

    // 链路顺序（[V36]）：resolveNode → isConnected 守卫 → callFunctionOn 现算 rect。
    const trace = chrome.calls.slice(before).map(call => call.method === 'Runtime.callFunctionOn'
      ? String(call.params['functionDeclaration'])
      : call.method)
    expect(trace[0]).toBe('DOM.resolveNode')
    expect(trace[1]).toContain('isConnected')
    expect(trace[2]).toContain('getBoundingClientRect')
    // 2026-09-14 改：默认**不**滚动视口 —— 否则 locate 验证不了上一次 scroll 到底生效没有。
    expect(trace[2]).not.toContain('scrollIntoView')
    // 远端对象句柄用完即还，且没有 DOM.enable / Overlay 之类的多余命令。
    expect(trace).toContain('DOM.releaseObject')
    expect(trace).not.toContain('Overlay.highlightNode')
  })

  it('scrolls the element to the centre only when scroll=true, and then reports centered=true', async () => {
    const { ref } = await firstRef()

    const result = await provider.locate({ sessionId: 'tab-1', ref, scroll: true })
    expect(result.centered).toBe(true)

    const rectCall = chrome.calls.filter(call =>
      call.method === 'Runtime.callFunctionOn'
      && String(call.params['functionDeclaration']).includes('getBoundingClientRect')).at(-1)
    expect(String(rectCall?.params['functionDeclaration'])).toContain('scrollIntoView')
  })

  it('reports in_viewport=false when the element sits outside the current viewport', async () => {
    const { ref } = await firstRef()
    // 视口高 720，元素在 y=900（文档下方、当前没滚到）：不滚视口就应当如实说「不在视口里」。
    chrome.elementRect = { x: 10, y: 900, width: 100, height: 40 }

    const result = await provider.locate({ sessionId: 'tab-1', ref })
    expect(result).toMatchObject({ centered: false, inViewport: false, y: 900 })
  })

  it('reports BROWSER_STALE_REF when resolveNode says the node is gone', async () => {
    const { ref } = await firstRef()
    chrome.resolveNodeError = 'No node with given id found'

    await expect(provider.locate({ sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('keeps BROWSER_DEBUGGER_DETACHED distinct from a stale ref', async () => {
    const { ref } = await firstRef()
    // [V16]：detach 期间的同步失败是会话级状态，不该被守卫吞成 BROWSER_STALE_REF。
    chrome.resolveNodeError = 'No target available'

    await expect(provider.locate({ sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_DEBUGGER_DETACHED' }))
  })

  it('reports BROWSER_STALE_REF when isConnected is false ([V36]: resolveNode alone would miss this)', async () => {
    const { ref } = await firstRef()
    // replaceWith 换掉元素后 resolveNode 仍然成功，只有 isConnected 变 false —— 唯一会漏的场景。
    chrome.elementConnected = false

    await expect(provider.locate({ sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('reports a zero-sized box as not visible instead of returning 0 coordinates', async () => {
    const { ref } = await firstRef()
    chrome.elementRect = { x: 0, y: 0, width: 0, height: 0 }

    await expect(provider.locate({ sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('requires a snapshot first and fails stale refs before any command', async () => {
    await provider.open({})
    await expect(provider.locate({ sessionId: 'tab-1', ref: 'e1' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
    expect(chrome.calls.some(call => call.method === 'DOM.resolveNode')).toBe(false)
  })

  it('highlights through DOM.enable + Overlay.enable + highlightNode, never highlightRect', async () => {
    const { ref, before } = await firstRef()

    await provider.locate({ sessionId: 'tab-1', ref, highlight: true })

    // 两道门的顺序（[V15][V20]）：DOM.enable → Overlay.enable → highlightNode。
    const trace = chrome.calls.slice(before).map(call => call.method)
    const domAt = trace.indexOf('DOM.enable')
    const overlayAt = trace.indexOf('Overlay.enable')
    const highlightAt = trace.indexOf('Overlay.highlightNode')
    expect(domAt).toBeGreaterThanOrEqual(0)
    expect(overlayAt).toBeGreaterThan(domAt)
    expect(highlightAt).toBeGreaterThan(overlayAt)
    // [V32]：highlightRect 会把整个视口染色，绝不允许出现。
    expect(trace).not.toContain('Overlay.highlightRect')
    const highlight = chrome.calls.slice(before).find(call => call.method === 'Overlay.highlightNode')
    expect(highlight?.params['objectId']).toBe('obj-1')
    expect(highlight?.params['highlightConfig']).toMatchObject({
      contentColor: { r: 250, g: 200, b: 60, a: 0.5 },
      borderColor: { r: 220, g: 120, b: 0, a: 1 },
    })
  })

  it('clears its own highlight on a later locate without highlight, and never unprompted', async () => {
    const { ref } = await firstRef()
    await provider.locate({ sessionId: 'tab-1', ref, highlight: true })
    await provider.locate({ sessionId: 'tab-1', ref })
    expect(chrome.calls.some(call => call.method === 'Overlay.hideHighlight')).toBe(true)

    // 没画过的会话不得多手去弹别人的层（[V31]：hideHighlight 只弹自己那层，但没画就该闭嘴）。
    const fresh = new FakeChrome()
    fresh.axeNodes = PAGE_TREE
    const freshProvider = new CdpBrowserProvider({ navigationTimeoutMs: 200 }, fresh.transport())
    await freshProvider.open({})
    const snapshot = await freshProvider.observe({ kind: 'snapshot', sessionId: 'tab-1' })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    await freshProvider.locate({ sessionId: 'tab-1', ref: snapshot.refs[0]?.ref as string })
    expect(fresh.calls.some(call => call.method === 'Overlay.hideHighlight')).toBe(false)
  })
})

describe('§6.5 控制权（人工接管按钮）', () => {
  /**
   * 生产上 `setHolder` 由 `browser-electron` 的 control 通道驱动（人按了标签条上的按钮）；
   * 这里把两个 protected 入口暴露出来，等价于「人按了按钮」与「人开了 DevTools」。
   */
  class HolderProvider extends CdpBrowserProvider {
    setControlHolder(sessionId: string, holder: BrowserHolder): void {
      this.setHolder(sessionId, holder)
    }

    /** 只为断言「两条线不合并」而暴露。 */
    setDevToolsTakeover(sessionId: string, active: boolean): void {
      this.setTakeover(sessionId, active)
    }
  }

  let chrome: FakeChrome
  let provider: HolderProvider

  beforeEach(() => {
    chrome = new FakeChrome()
    chrome.axeNodes = PAGE_TREE
    provider = new HolderProvider({ navigationTimeoutMs: 200 }, chrome.transport())
  })

  /** 开一个会话并 snapshot；返回会话 id 与首个可用 ref。 */
  async function openWithRef(): Promise<{ sessionId: string; ref: string }> {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    return { sessionId: session.id, ref: snapshot.refs[0]?.ref as string }
  }

  it('切到 human 后写族全被拒（BROWSER_HUMAN_HOLDING），且一条 CDP 命令都没派发（J5）', async () => {
    const { sessionId, ref } = await openWithRef()
    provider.setControlHolder(sessionId, 'human')
    const mark = chrome.calls.length

    await expect(provider.mutate({ kind: 'click', sessionId, ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_HUMAN_HOLDING' }))
    await expect(provider.navigate({ sessionId, url: 'https://example.com/other' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_HUMAN_HOLDING' }))
    await expect(provider.execute({ sessionId, method: 'Runtime.evaluate', params: { expression: '1' } }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_HUMAN_HOLDING' }))

    // 这一半才是「零静默」：不是「拒是拒了、但已经点下去了」—— 与写前门同一条纪律。
    expect(chrome.calls.slice(mark)).toEqual([])
  })

  it('human 期间读型操作照常放行 —— 让渡是「停手 + 重新观察」，不是断连', async () => {
    const { sessionId } = await openWithRef()
    provider.setControlHolder(sessionId, 'human')

    const during = await provider.observe({ kind: 'snapshot', sessionId })
    expect(during.kind).toBe('snapshot')
    await expect(provider.tabs({ kind: 'list' })).resolves.toMatchObject({ action: 'list' })
  })

  it('交还后恢复可写，但接管前的 ref 一律失效 —— 必须重拍快照（J6）', async () => {
    const { sessionId, ref } = await openWithRef()

    provider.setControlHolder(sessionId, 'human')
    provider.setControlHolder(sessionId, 'agent')

    // 交还**不**复活旧号 —— 这是 J6 的核心，别期待「像什么都没发生过」。
    await expect(provider.mutate({ kind: 'click', sessionId, ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))

    // 重拍之后才拿得到能用的号。
    const fresh = await provider.observe({ kind: 'snapshot', sessionId })
    if (fresh.kind !== 'snapshot') throw new Error('expected a snapshot')
    await expect(provider.mutate({ kind: 'click', sessionId, ref: fresh.refs[0]?.ref as string }))
      .resolves.toMatchObject({ action: 'click' })
  })

  it('接管只作废本会话 —— 别的会话照常可写（不误伤）', async () => {
    const first = await openWithRef()
    const second = await openWithRef()

    provider.setControlHolder(first.sessionId, 'human')

    await expect(provider.mutate({ kind: 'click', sessionId: second.sessionId, ref: second.ref }))
      .resolves.toMatchObject({ action: 'click' })
    await expect(provider.mutate({ kind: 'click', sessionId: first.sessionId, ref: first.ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_HUMAN_HOLDING' }))
  })

  it('「开着 DevTools」那条（takeover）不拒写 —— 两条线不合并（防回归）', async () => {
    const { sessionId, ref } = await openWithRef()

    // `setTakeover` 是**观测**到的信号：它只让 snapshot 回执带个提示，不该挡住 agent 动手。
    // 哪天有人把 holder 与 takeover 合成一位，这条就会红。
    provider.setDevToolsTakeover(sessionId, true)

    await expect(provider.mutate({ kind: 'click', sessionId, ref }))
      .resolves.toMatchObject({ action: 'click' })
  })

  it('会话关掉后，它的接管窗口与簿记一起清掉（不留悬账）', async () => {
    const { sessionId } = await openWithRef()
    provider.setControlHolder(sessionId, 'human')

    await provider.close(sessionId)

    // 会话没了，再切它的 holder 应当是静默 no-op（而不是抛「未知会话」之类的噪音）。
    expect(() => { provider.setControlHolder(sessionId, 'agent') }).not.toThrow()
  })
})

/**
 * P2（方案 §6.2 ①②③）+ D-5（§5.2）+ D-19（§13）。
 *
 * 三条放在同一个 describe 里，因为它们钉的是**同一条链**：页面在模型之外变过 → 攒着 →
 * 下一次回执夹带 → 顺带写进簿记；而「只改 query 的抖动不算换文档」是这条链的取数口径。
 */
describe('§6.2 决策时通知（P2）+ D-5 + D-19', () => {
  class DirtyProvider extends CdpBrowserProvider {
    /** 等价于「人在标签条上按了接管 / 交还」。 */
    setControlHolder(sessionId: string, holder: BrowserHolder): void {
      this.setHolder(sessionId, holder)
    }

    /** 等价于「人开了 DevTools」。 */
    setDevToolsTakeover(sessionId: string, active: boolean): void {
      this.setTakeover(sessionId, active)
    }

    /** §6.2 ③ 的簿记：页面文档这条伪状态的记录。 */
    documentRecord(sessionId: string): { owner: string; at: number; applied: unknown } | undefined {
      return this.stateRegistry.get(sessionId, PAGE_DOCUMENT_STATE_KEY)
    }
  }

  let chrome: FakeChrome
  let provider: DirtyProvider

  beforeEach(() => {
    chrome = new FakeChrome()
    chrome.axeNodes = PAGE_TREE
    provider = new DirtyProvider({ navigationTimeoutMs: 200 }, chrome.transport())
  })

  /** 已建立的连接；事件注入走它。 */
  function socket(): FakeSocket {
    const found = chrome.sockets[0]
    if (found === undefined) throw new Error('no connection was opened')
    return found
  }

  /**
   * 补发 `open()` 那一次导航的事件。
   *
   * 夹具不模拟浏览器，所以 `open()` 期间不会有 `Page.frameNavigated` 进来 —— 而真实链路上有。
   * 不补这一条，累加器里的 `lastUrl` 会停在 `about:blank`，`route.from` 就成了一个假地址。
   * 它同时被 `open()` 记下的赊账抵掉，所以不会污染计数。
   */
  function emitOpenNavigation(url: string): void {
    emitCdp(socket(), 'Page.frameNavigated', { frame: { id: 'frame-1', loaderId: 'loader-1', url } })
  }

  /** 观察一次并窄化到快照（`observe` 的返回是 snapshot | screenshot 的联合）。 */
  async function fullSnapshot(sessionId: string): Promise<BrowserSnapshot> {
    const observed = await provider.observe({ kind: 'snapshot', sessionId })
    if (observed.kind !== 'snapshot') throw new Error('expected a snapshot')
    return observed
  }

  /** 开一个会话 + 全页快照；返回会话 id 与首个可用 ref。 */
  async function openWithRef(): Promise<{ sessionId: string; ref: string }> {
    const session = await provider.open({})
    emitOpenNavigation(chrome.page.url)
    const snapshot = await fullSnapshot(session.id)
    return { sessionId: session.id, ref: snapshot.refs[0]?.ref as string }
  }

  it('全页快照回执带上「页面在模型之外变过」，并把锚点前移（下一次就干净了）', async () => {
    const session = await provider.open({})
    emitOpenNavigation(chrome.page.url)

    // open 自己引发的那一次导航不算：赊账抵掉 + `reset()`。
    const first = await fullSnapshot(session.id)
    expect(first.pageChanged).toBeUndefined()

    // 人工在两轮之间导航走了（这里靠事件流复现：地址也真的变了）。
    chrome.page = { url: 'https://example.com/report', title: 'Report' }
    emitCdp(socket(), 'Page.frameNavigated', {
      frame: { id: 'frame-1', loaderId: 'loader-2', url: 'https://example.com/report' },
    })

    const second = await fullSnapshot(session.id)
    expect(second.pageChanged).toMatchObject({
      navigated: 1,
      withinDocument: 0,
      route: { from: 'https://example.com/', to: 'https://example.com/report' },
    })
    // 「观察不到这条通道」不等于「观察到 0 次」：没有接管信号时整条不出现。
    expect(second.pageChanged).not.toHaveProperty('takeoverWindow')

    // 全页快照落地 = 锚点前移，同一笔账不会再报第二遍。
    const third = await fullSnapshot(session.id)
    expect(third.pageChanged).toBeUndefined()
  })

  it('mutate 回执也带（人工的操作落在两轮之间时，模型下一轮往往是 click 而不是 snapshot）', async () => {
    const { sessionId, ref } = await openWithRef()

    // 页面自己软导航了一次（pushState 换路由）—— 地址栏没换文档，但模型手里的 ref 已经不再可信。
    emitCdp(socket(), 'Page.navigatedWithinDocument', {
      frameId: 'frame-1',
      url: 'https://example.com/#/inbox',
    })

    const result = await provider.mutate({ kind: 'click', sessionId, ref })
    expect(result.navigated).toBe(false)
    expect(result.pageChanged).toMatchObject({
      navigated: 0,
      withinDocument: 1,
      route: { to: 'https://example.com/#/inbox' },
    })
  })

  it('自己动作引发的导航不报成「页面在模型之外变过」—— 那条已由 navigated 报过（§6.3 去重）', async () => {
    const { sessionId, ref } = await openWithRef()
    chrome.navigateOnClick = true

    const result = await provider.mutate({ kind: 'click', sessionId, ref })

    expect(result.navigated).toBe(true)
    expect(result.pageChanged).toBeUndefined()
  })

  it('③ 文档变化写进 TargetStateRegistry，让「谁 / 何时」真的可报', async () => {
    const { sessionId } = await openWithRef()

    chrome.page = { url: 'https://example.com/other', title: 'Other' }
    emitCdp(socket(), 'Page.frameNavigated', {
      frame: { id: 'frame-1', loaderId: 'loader-2', url: 'https://example.com/other' },
    })

    const record = provider.documentRecord(sessionId)
    expect(record).toBeDefined()
    // owner 是这套词表里「非本会话」的那一侧；插件在事件层分不出「真人」与「页面脚本」，
    // 所以回执文案按「本会话之外」写，不写死「有人」。
    expect(record?.owner).toBe('human')
    expect(record?.at).toBeGreaterThan(0)
    expect(record?.applied).toMatchObject({ navigated: 1 })
  })

  it('D-19：同 host+path 只换了 query（遥测令牌抖动）不作废纪元、不拦动作，只如实标脏', async () => {
    chrome.page = { url: 'https://www.google.com/search?q=cat&sxsrf=AAA', title: 'cat - Google' }
    const session = await provider.open({})
    emitOpenNavigation(chrome.page.url)
    const snapshot = await fullSnapshot(session.id)
    const ref = snapshot.refs[0]?.ref as string

    // 同 host + 同 path，只有遥测参数变了 —— §5.1.2 ① 实测的那种「每次交互都抖一下」。
    chrome.page = { url: 'https://www.google.com/search?q=cat&sxsrf=BBB', title: 'cat - Google' }

    const result = await provider.mutate({ kind: 'click', sessionId: session.id, ref })
    expect(result).toMatchObject({ navigated: false, epoch: snapshot.epoch })
    expect(result.pageChanged?.addressDrift).toBe(1)

    // 关键：纪元没被作废，同一个 ref 还能接着用（旧行为要让模型白重拍一次快照）。
    await expect(provider.mutate({ kind: 'click', sessionId: session.id, ref }))
      .resolves.toMatchObject({ action: 'click' })
  })

  it('自己点击引发的「仅 query 变」软导航归因给这次点击，不报成「页面在本会话之外变过」', async () => {
    chrome.page = { url: 'https://www.google.com/search?q=cat&sxsrf=AAA', title: 'cat - Google' }
    const session = await provider.open({})
    emitOpenNavigation(chrome.page.url)
    const snapshot = await fullSnapshot(session.id)
    const ref = snapshot.refs[0]?.ref as string

    // 这一次不是「页面在外面被人改了」，而是**这次点击自己**触发的软导航：
    // 页面脚本换了一批遥测令牌（`replaceState`），文档身份不变。
    //
    // 事件线看到 `Page.navigatedWithinDocument` → 被点击前记下的赊账抵掉（§6.3 去重）；
    // 轮询线（`detectNavigation`）随后也读到地址变了 —— 它必须**认出这是同一次变化**。
    // 修前它在这里又数了一笔 `addressDrift`，回执于是渲染成「PAGE CHANGED OUTSIDE THIS
    // SESSION … run webpage_snapshot (full)」：既把归因说反了，又让模型为一次遥测抖动
    // 白付一次全量重拍（中位 ≈5500 字符）—— 正是 D-19 要省掉的那笔。
    chrome.withinDocumentOnClick = 'https://www.google.com/search?q=cat&sxsrf=BBB'

    const result = await provider.mutate({ kind: 'click', sessionId: session.id, ref })
    expect(result.navigated).toBe(false)
    expect(result.pageChanged).toBeUndefined()

    // 纪元照旧没被作废：这一次点击的效果模型从回执自己的 `url` 就读得到（D-19 的口径）。
    expect(result.url).toBe('https://www.google.com/search?q=cat&sxsrf=BBB')
    expect(result.epoch).toBe(snapshot.epoch)
  })

  it('反向验证：地址变了但它**没进过事件流**时，轮询路径照旧如实标脏（兜底那一档还在）', async () => {
    chrome.page = { url: 'https://www.google.com/search?q=cat&sxsrf=AAA', title: 'cat - Google' }
    const session = await provider.open({})
    emitOpenNavigation(chrome.page.url)
    const snapshot = await fullSnapshot(session.id)
    const ref = snapshot.refs[0]?.ref as string

    // **故意不发事件**：模拟 `Page.enable` 之前就加载完 / 事件丢失那一档 —— 事件线从头到尾
    // 没见过新地址，所以轮询线是这个变化唯一的观测者，它必须报出来。
    // 与上一条配对：同样的动作、同样的地址变化，**只差事件到没到**，读数必须相反。
    chrome.page = { url: 'https://www.google.com/search?q=cat&sxsrf=BBB', title: 'cat - Google' }

    const result = await provider.mutate({ kind: 'click', sessionId: session.id, ref })
    expect(result.pageChanged).toMatchObject({
      navigated: 0,
      withinDocument: 0,
      addressDrift: 1,
      route: {
        from: 'https://www.google.com/search?q=cat&sxsrf=AAA',
        to: 'https://www.google.com/search?q=cat&sxsrf=BBB',
      },
    })
  })

  it('同一次外部软导航不会在两个桶里各记一笔（事件线报过 → 轮询线不重复记）', async () => {
    const { sessionId, ref } = await openWithRef()

    // 页面自己在外面软导航了一次，**事件到齐**（地址也真的变了，两条线都会看见它）。
    chrome.page = { url: 'https://example.com/#/inbox', title: 'Example' }
    emitCdp(socket(), 'Page.navigatedWithinDocument', {
      frameId: 'frame-1',
      url: 'https://example.com/#/inbox',
    })

    // 下一次点击的门 / 轮询同样读到「地址与纪元不同」—— 但那是**同一次**变化，事件线已经记过。
    const result = await provider.mutate({ kind: 'click', sessionId, ref })
    expect(result.pageChanged?.withinDocument).toBe(1)
    expect(result.pageChanged?.addressDrift).toBeUndefined()
  })

  it('D-19 反向验证：path 真的换了照旧作废 + 抛 stale_document（放宽只针对 query/hash）', async () => {
    const { sessionId, ref } = await openWithRef()
    chrome.page = { url: 'https://example.com/other', title: 'Other' }

    await expect(provider.mutate({ kind: 'click', sessionId, ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF', reason: 'stale_document' }))
  })

  it('takeoverWindow：人按了接管 → 下一次回执报出来；交还本身不记', async () => {
    const { sessionId } = await openWithRef()

    provider.setControlHolder(sessionId, 'human')
    provider.setControlHolder(sessionId, 'agent')

    const snapshot = await fullSnapshot(sessionId)
    expect(snapshot.pageChanged).toMatchObject({ takeoverWindow: 1, navigated: 0, withinDocument: 0 })
  })

  it('takeoverWindow：DevTools 被打开也算一次窗口（两条来源都进同一个桶）', async () => {
    const { sessionId } = await openWithRef()
    provider.setDevToolsTakeover(sessionId, true)

    const snapshot = await fullSnapshot(sessionId)
    expect(snapshot.pageChanged).toMatchObject({ takeoverWindow: 1 })
  })

  it('D-5：区域快照复用旧号换了指针 → 回执带 reboundRefs，且 epoch 不动（只报不作废）', async () => {
    const session = await provider.open({})
    emitOpenNavigation(chrome.page.url)
    const full = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (full.kind !== 'snapshot') throw new Error('expected a snapshot')
    const submit = full.refs.find(entry => entry.name === 'Submit')
    if (submit === undefined) throw new Error('expected a Submit ref')

    // 「提交」被换成了一个**新节点**，role / name / 祖先路径一字不差 —— 于是 adopt 的唯一命中
    // 规则会复用旧号，把指针就地改写（§5.2 七步链的第 5 步）。
    chrome.axeNodes = PAGE_TREE.map(node =>
      node.backendDOMNodeId === 9 ? { ...node, backendDOMNodeId: 99 } : node)
    chrome.layoutBoxes = [
      { backendNodeId: 7, bounds: [0, 0, 200, 40] },
      { backendNodeId: 8, bounds: [0, 50, 200, 30] },
      { backendNodeId: 99, bounds: [0, 90, 200, 30] },
    ]

    const regional = await provider.observe({
      kind: 'snapshot',
      sessionId: session.id,
      region: { viewport: true },
    })
    if (regional.kind !== 'snapshot') throw new Error('expected a snapshot')

    expect(regional.epoch).toBe(full.epoch)
    expect(regional.reboundRefs).toEqual([{ ref: submit.ref, role: 'button', name: 'Submit' }])
    // 区域快照不推进锚点：别的 ref 依然可用（D-5 选 C 的前提）。
    expect(regional.refs.find(entry => entry.name === 'Email')).toBeDefined()
  })

  it('D-5 反向验证：同一个节点被区域快照再次覆盖时**不报** rebound（别把重观察说成改绑）', async () => {
    const session = await provider.open({})
    emitOpenNavigation(chrome.page.url)
    await provider.observe({ kind: 'snapshot', sessionId: session.id })

    const regional = await provider.observe({
      kind: 'snapshot',
      sessionId: session.id,
      region: { viewport: true },
    })
    if (regional.kind !== 'snapshot') throw new Error('expected a snapshot')

    expect(regional.reboundRefs).toBeUndefined()
  })
})
