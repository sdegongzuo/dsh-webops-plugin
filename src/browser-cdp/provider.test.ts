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

  /** 记录一条命令并给出它的结果。 */
  handle(socket: FakeSocket, method: string, params: Record<string, unknown>): unknown {
    this.calls.push({ method, params })
    switch (method) {
      case 'Page.enable':
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
        return expression.includes('readyState')
          ? { result: { value: this.readyStateComplete } }
          : { result: { value: { url: this.page.url, title: this.page.title } } }
      }
      case 'Accessibility.getFullAXTree':
        return { nodes: this.axeNodes }
      case 'Page.navigate':
        this.href = String(params['url'])
        return this.navigateErrorText === undefined ? {} : { errorText: this.navigateErrorText }
      case 'Page.captureScreenshot':
        return { data: Buffer.from(this.png).toString('base64') }
      case 'DOM.resolveNode':
        return params['backendNodeId'] === 0 ? {} : { object: { objectId: 'obj-1' } }
      case 'DOM.getBoxModel':
        return this.boxModel === undefined ? {} : { model: { border: [...this.boxModel] } }
      case 'DOM.releaseObject':
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
    expect(capture?.params).toEqual({ format: 'png', captureBeyondViewport: true })
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
