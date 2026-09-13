import { beforeEach, describe, expect, it } from 'vitest'
import { BrowserError } from '../browser/types.ts'
import { CdpBrowserProvider } from './provider.ts'
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
  /** P1：wait-hidden 里元素是否还连在文档上。 */
  elementConnected = true
  /** P1：wait-text 里页面文本是否包含目标串。 */
  waitTextFound = true
  /**
   * P2：设置后**所有**命令都抛这条消息 —— 模拟 detach 期间 `webContents.debugger` 的
   * 同步失败（`No target available`，`[V16]`）。
   */
  detachError: string | undefined
  /** P2：`Network.getResponseBody` 的返回体。 */
  responseBody = 'pong'
  /** P3：`getBoundingClientRect` 的返回值（locate / click 共用）。 */
  elementRect = { x: 10, y: 20, width: 100, height: 40 }
  /** P3：设置后 `DOM.resolveNode` 抛这条消息（模拟节点已被销毁）。 */
  resolveNodeError: string | undefined

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
        return expression.includes('readyState')
          ? { result: { value: this.readyStateComplete } }
          : { result: { value: { url: this.page.url, title: this.page.title } } }
      }
      case 'Runtime.callFunctionOn': {
        const fn = String(params['functionDeclaration'])
        if (fn.includes('getBoundingClientRect')) {
          return { result: { value: { ...this.elementRect } } }
        }
        if (fn.includes('!this.isConnected')) {
          // wait-hidden 的判据：true = 元素已从文档移除。
          return { result: { value: !this.elementConnected } }
        }
        if (fn.includes('isConnected')) {
          // locate 的守卫判据：true = 元素还连在文档上。
          return { result: { value: this.elementConnected } }
        }
        if (fn.includes('dispatchEvent')) {
          return { result: { value: true } }
        }
        // focus() 之类没有返回值。
        return { result: { value: undefined } }
      }
      case 'Accessibility.getFullAXTree':
        return { nodes: this.axeNodes }
      case 'Network.getResponseBody':
        return { body: this.responseBody, base64Encoded: false }
      case 'Page.navigate':
        this.href = String(params['url'])
        return this.navigateErrorText === undefined ? {} : { errorText: this.navigateErrorText }
      case 'Page.captureScreenshot':
        return { data: Buffer.from(this.png).toString('base64') }
      case 'DOM.resolveNode':
        if (this.resolveNodeError !== undefined) throw new Error(this.resolveNodeError)
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
        }
        return {}
      case 'Input.dispatchKeyEvent':
        return {}
      default:
        throw new Error(`unscripted method ${method}`)
    }
  }

  /** 造一个 transport；`connect` 直接返回一条已建好的连接。 */
  transport(): CdpTransport {
    const chrome = this
    return {
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
  let provider: CdpBrowserProvider

  beforeEach(() => {
    chrome = new FakeChrome()
    chrome.axeNodes = PAGE_TREE
    provider = new CdpBrowserProvider({ navigationTimeoutMs: 200 }, chrome.transport())
  })

  /** 开会话并 snapshot，返回第一个 ref。 */
  async function firstRef(): Promise<string> {
    const session = await provider.open({})
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    return snapshot.refs[0]?.ref as string
  }

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

  it('requires a snapshot before mutating a page the model never observed', async () => {
    const session = await provider.open({})
    const before = chrome.calls.length

    await expect(provider.mutate({ kind: 'click', sessionId: session.id, ref: 'e1' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
    expect(chrome.calls.slice(before)).toEqual([])
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

  it('fills through the native value setter and fires input + change', async () => {
    const ref = await firstRef()

    const result = await provider.mutate({ kind: 'fill', sessionId: 'tab-1', ref, value: 'me@example.com' })
    expect(result).toMatchObject({ action: 'fill', navigated: false })

    const call = chrome.calls.find(candidate => candidate.method === 'Runtime.callFunctionOn')
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

  it('scrolls with a wheel event at the element center and refuses zero deltas', async () => {
    const ref = await firstRef()

    const result = await provider.mutate({ kind: 'scroll', sessionId: 'tab-1', ref, deltaY: 600 })
    expect(result).toMatchObject({ action: 'scroll' })

    const wheel = chrome.calls.find(call => call.method === 'Input.dispatchMouseEvent')
    expect(wheel?.params).toMatchObject({ type: 'mouseWheel', x: 60, y: 40, deltaY: 600 })

    await expect(provider.mutate({ kind: 'scroll', sessionId: 'tab-1', ref }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
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
      centered: true,
    })

    // 链路顺序（[V36]）：resolveNode → isConnected 守卫 → callFunctionOn 现算 rect。
    const trace = chrome.calls.slice(before).map(call => call.method === 'Runtime.callFunctionOn'
      ? String(call.params['functionDeclaration'])
      : call.method)
    expect(trace[0]).toBe('DOM.resolveNode')
    expect(trace[1]).toContain('isConnected')
    expect(trace[2]).toContain('getBoundingClientRect')
    // 居中语义与 click 落点一致：量之前先 scrollIntoView。
    expect(trace[2]).toContain('scrollIntoView')
    // 远端对象句柄用完即还，且没有 DOM.enable / Overlay 之类的多余命令。
    expect(trace).toContain('DOM.releaseObject')
    expect(trace).not.toContain('Overlay.highlightNode')
  })

  it('skips scrollIntoView when scroll=false and reports centered=false', async () => {
    const { ref } = await firstRef()

    const result = await provider.locate({ sessionId: 'tab-1', ref, scroll: false })
    expect(result.centered).toBe(false)

    const rectCall = chrome.calls.filter(call =>
      call.method === 'Runtime.callFunctionOn'
      && String(call.params['functionDeclaration']).includes('getBoundingClientRect')).at(-1)
    expect(String(rectCall?.params['functionDeclaration'])).not.toContain('scrollIntoView')
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
