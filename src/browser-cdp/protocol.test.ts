import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CdpConnection, HttpCdpTransport } from './protocol.ts'
import type { CdpSocket, CdpSocketFactory } from './protocol.ts'

/** 一条可编程的假 WebSocket：测试驱动入站消息，生产代码只管发。 */
class FakeSocket implements CdpSocket {
  readonly written: string[] = []
  closed = false
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>()

  send(data: string): void {
    this.written.push(data)
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

  /** 模拟连接建立。 */
  open(): void {
    this.dispatch('open', {})
  }

  /** 模拟一条协议消息。 */
  respond(message: unknown): void {
    this.dispatch('message', { data: JSON.stringify(message) })
  }

  /** 最后一条出站消息。 */
  last(): { id: number; method: string; params?: Record<string, unknown> } {
    return JSON.parse(this.written[this.written.length - 1] as string)
  }
}

/** 让微任务队列跑完，等 pending 命令被结算。 */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('CdpConnection', () => {
  let socket: FakeSocket

  beforeEach(() => {
    socket = new FakeSocket()
  })

  it('correlates a response back to its command by id', async () => {
    const connection = new CdpConnection(socket)
    const pending = connection.send<{ nodes: unknown[] }>('Accessibility.getFullAXTree', { depth: -1 })

    expect(socket.last()).toEqual({ id: 1, method: 'Accessibility.getFullAXTree', params: { depth: -1 } })
    socket.respond({ id: 1, result: { nodes: [] } })

    await expect(pending).resolves.toEqual({ nodes: [] })
  })

  it('omits params when the command takes none', async () => {
    const connection = new CdpConnection(socket)
    const pending = connection.send('Page.enable')
    expect(socket.last()).toEqual({ id: 1, method: 'Page.enable' })
    socket.respond({ id: 1, result: {} })
    await pending
  })

  it('maps a CDP error payload onto BROWSER_PROTOCOL_ERROR', async () => {
    const connection = new CdpConnection(socket)
    const pending = connection.send('DOM.getBoxModel', { objectId: 'x' })
    socket.respond({ id: 1, error: { code: -32000, message: 'Node is detached from document' } })

    await expect(pending).rejects.toThrow(expect.objectContaining({
      code: 'BROWSER_PROTOCOL_ERROR',
      message: expect.stringContaining('Node is detached from document') as unknown as string,
    }))
  })

  it('maps "No target available" onto the recoverable BROWSER_DEBUGGER_DETACHED', async () => {
    const connection = new CdpConnection(socket)
    const pending = connection.send('Runtime.evaluate', { expression: '1' })
    socket.respond({ id: 1, error: { message: 'No target available' } })

    // [V16]：detach 期间命令同步抛这条消息，re-attach 后恢复 —— 所以它是可恢复错误，
    // 不是协议错误。
    await expect(pending).rejects.toThrow(expect.objectContaining({
      code: 'BROWSER_DEBUGGER_DETACHED',
      message: expect.stringContaining('No target available') as unknown as string,
    }))
  })

  it('rejects every in-flight command when the socket closes, instead of hanging', async () => {
    const connection = new CdpConnection(socket)
    const pending = connection.send('Page.captureScreenshot')
    socket.close()

    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_CONNECTION_LOST' }))
    expect(connection.isClosed).toBe(true)
  })

  it('refuses to send on a closed connection and notifies onClose listeners', async () => {
    const connection = new CdpConnection(socket)
    let closedCalls = 0
    connection.onClose(() => { closedCalls += 1 })
    connection.close()

    expect(closedCalls).toBe(1)
    await expect(connection.send('Page.enable'))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_CONNECTION_LOST' }))
  })

  it('honours an abort signal', async () => {
    const connection = new CdpConnection(socket)
    const controller = new AbortController()
    const pending = connection.send('Page.navigate', { url: 'https://example.com' }, { signal: controller.signal })
    controller.abort(new Error('cancelled by the caller'))

    await expect(pending).rejects.toThrow('cancelled by the caller')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const connection = new CdpConnection(socket)
    const controller = new AbortController()
    controller.abort(new Error('already gone'))

    await expect(connection.send('Page.enable', undefined, { signal: controller.signal })).rejects.toThrow('already gone')
    expect(socket.written).toHaveLength(0)
  })

  it('times a command out rather than waiting forever', async () => {
    const connection = new CdpConnection(socket)
    await expect(connection.send('Page.enable', undefined, { timeoutMs: 5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('unhooks its abort listener when the command times out (2026-09-17)', async () => {
    const connection = new CdpConnection(socket)
    const controller = new AbortController()
    const signal = controller.signal
    // 计数 abort 监听的挂上 / 摘下：超时路径以前只 `pending.delete`，不摘监听。
    let added = 0
    let removed = 0
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      added += 1
      return add(...args)
    }) as typeof add
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      removed += 1
      return remove(...args)
    }) as typeof remove

    await expect(connection.send('Page.enable', undefined, { signal, timeoutMs: 5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))

    // 工具的 exec.signal 是长生命周期的：一次工具调用里发好几条命令，
    // 每条超时都漏一个监听就会一直攒下去。
    expect(added).toBe(1)
    expect(removed).toBe(1)
  })

  it('dispatches events to subscribers and stops after unsubscribe', () => {
    const connection = new CdpConnection(socket)
    const seen: unknown[] = []
    const off = connection.on('Page.loadEventFired', params => seen.push(params))

    socket.respond({ method: 'Page.loadEventFired', params: { timestamp: 1 } })
    off()
    socket.respond({ method: 'Page.loadEventFired', params: { timestamp: 2 } })

    expect(seen).toEqual([{ timestamp: 1 }])
  })

  it('ignores unparseable and non-string frames without dropping the connection', async () => {
    const connection = new CdpConnection(socket)
    socket.dispatch('message', { data: 'not json' })
    socket.dispatch('message', { data: 42 })

    expect(connection.isClosed).toBe(false)
    const pending = connection.send('Page.enable')
    socket.respond({ id: 1, result: {} })
    await expect(pending).resolves.toEqual({})
  })

  it('survives a listener that throws', () => {
    const connection = new CdpConnection(socket)
    const seen: unknown[] = []
    connection.on('Page.loadEventFired', () => { throw new Error('listener bug') })
    connection.on('Page.loadEventFired', params => seen.push(params))

    socket.respond({ method: 'Page.loadEventFired', params: {} })
    expect(seen).toHaveLength(1)
  })

  it('rejects when the underlying socket refuses the write', async () => {
    const broken: CdpSocket = {
      send: () => { throw new Error('socket already closed') },
      close: () => undefined,
      addEventListener: () => undefined,
    }
    const connection = new CdpConnection(broken)
    await expect(connection.send('Page.enable'))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_CONNECTION_LOST' }))
  })
})

describe('HttpCdpTransport', () => {
  let server: Server
  let base: string
  let handler: (req: IncomingMessage, res: ServerResponse) => void

  beforeEach(async () => {
    handler = (_req, res) => { res.writeHead(404); res.end() }
    server = createServer((req, res) => { handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })

  /** 用一个固定 JSON 体应答。 */
  function respondJson(body: unknown, status = 200): void {
    handler = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
  }

  /**
   * 用**纯文本**应答 —— `/json/close` 与 `/json/activate` 在真 Chrome 上成功时就是这个形态
   * （实测 Chrome 153：`Target is closing` / `Target activated`）。用 JSON 体测不出这个坑。
   */
  function respondText(body: string, status = 200): void {
    handler = (_req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(body)
    }
  }

  it('reads the browser version and its websocket url', async () => {
    respondJson({ Browser: 'Chrome/141.0.0.0', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
    const version = await new HttpCdpTransport(base).version()

    expect(version).toEqual({
      browser: 'Chrome/141.0.0.0',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    })
  })

  it('rejects a version payload with no websocket url', async () => {
    respondJson({ Browser: 'Chrome/141.0.0.0' })
    await expect(new HttpCdpTransport(base).version())
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('lists page targets and derives the missing websocket url from the endpoint', async () => {
    respondJson([
      { id: 'p1', type: 'page', url: 'about:blank', title: '' },
      { id: 'w1', type: 'worker', url: '', title: '', webSocketDebuggerUrl: 'ws://x/devtools/page/w1' },
      { garbage: true },
    ])
    const targets = await new HttpCdpTransport(base).list()

    expect(targets.map(target => target.id)).toEqual(['p1', 'w1'])
    expect(targets[0]?.webSocketDebuggerUrl).toBe(`ws://${base.replace('http://', '')}/devtools/page/p1`)
  })

  it('creates a tab with PUT and a percent-encoded url', async () => {
    let seen = { method: '', url: '' }
    handler = (req, res) => {
      seen = { method: req.method ?? '', url: req.url ?? '' }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'new1', type: 'page', url: 'https://example.com/a b', title: 'Example' }))
    }
    const target = await new HttpCdpTransport(base).newTab('https://example.com/a b')

    expect(seen.method).toBe('PUT')
    expect(seen.url).toBe(`/json/new?${encodeURIComponent('https://example.com/a b')}`)
    expect(target.title).toBe('Example')
  })

  it('refuses a tab payload that is not a target description', async () => {
    respondJson({ nonsense: true })
    await expect(new HttpCdpTransport(base).newTab('about:blank'))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('treats a missing target as a successful close', async () => {
    respondJson({ message: 'Not found' }, 404)
    await expect(new HttpCdpTransport(base).closeTarget('gone')).resolves.toBeUndefined()
  })

  it('close 对 404 之外的错误状态码照抛（403 不被吞成「target 已没了」）', async () => {
    respondJson({ message: 'Forbidden' }, 403)
    await expect(new HttpCdpTransport(base).closeTarget('locked'))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR', status: 403 }))
  })

  // 真 Chrome 上这两个端点成功时回的是纯文本，早先按 JSON 解析会把成功报成失败：
  // `close()` 用 .catch 吞掉了它，`dispose()` 不吞 → 卸载路径恒一条假红。
  it('close 认「200 + 纯文本 Target is closing」为成功', async () => {
    respondText('Target is closing')
    await expect(new HttpCdpTransport(base).closeTarget('t1')).resolves.toBeUndefined()
  })

  it('activate 认「200 + 纯文本 Target activated」为成功', async () => {
    respondText('Target activated')
    await expect(new HttpCdpTransport(base).activateTarget('t1')).resolves.toBeUndefined()
  })

  it('404 的幂等判定只看状态码，文本体 "No such target id" 也算成功关掉', async () => {
    respondText('No such target id: t1', 404)
    await expect(new HttpCdpTransport(base).closeTarget('t1')).resolves.toBeUndefined()
  })

  it('activate 同样只吞 404（500 照抛）', async () => {
    respondJson({ message: 'Internal error' }, 500)
    await expect(new HttpCdpTransport(base).activateTarget('broken'))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR', status: 500 }))
  })

  it('reports an unreachable endpoint as BROWSER_ENDPOINT_UNREACHABLE', async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await expect(new HttpCdpTransport(base).version())
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_ENDPOINT_UNREACHABLE' }))
  })

  it('reports malformed JSON as BROWSER_PROTOCOL_ERROR', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('{oops') }
    await expect(new HttpCdpTransport(base).version())
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL_ERROR' }))
  })

  it('connects only once the socket reports open', async () => {
    const socket = new FakeSocket()
    const factory: CdpSocketFactory = () => socket
    const transport = new HttpCdpTransport(base, { socketFactory: factory })

    const connecting = transport.connect('ws://127.0.0.1:1/devtools/page/x')
    let settled = false
    void connecting.then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)

    socket.open()
    await expect(connecting).resolves.toBeInstanceOf(CdpConnection)
  })

  it('fails the connection when the socket errors before opening', async () => {
    const socket = new FakeSocket()
    const transport = new HttpCdpTransport(base, { socketFactory: () => socket })
    const connecting = transport.connect('ws://127.0.0.1:1/devtools/page/x')
    socket.dispatch('error', { message: 'connect ECONNREFUSED' })

    await expect(connecting).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_ENDPOINT_UNREACHABLE' }))
    expect(socket.closed).toBe(true)
  })

  it('fails the connection when the socket closes before opening', async () => {
    const socket = new FakeSocket()
    const transport = new HttpCdpTransport(base, { socketFactory: () => socket })
    const connecting = transport.connect('ws://127.0.0.1:1/devtools/page/x')
    socket.close()

    await expect(connecting).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_CONNECTION_LOST' }))
  })
})

/**
 * 回环兜底：有的企业策略只放通 `localhost` 这个名字（或反过来只认字面 IP），
 * 写死 `127.0.0.1` 就会「本机连本机也连不上」。这一组用 stub 掉的 `fetch` 钉住换名重试
 * —— 真机上「一个名字通、另一个不通」取决于机器策略，测不稳，只在这层钉行为。
 */
describe('HttpCdpTransport 的回环兜底', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('127.0.0.1 连不上时改用 localhost 重试并成功', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      if (url.includes('127.0.0.1')) throw new Error('connect ECONNREFUSED 127.0.0.1:9222')
      return new Response(JSON.stringify({
        Browser: 'Chrome/141.0.0.0',
        webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc',
      }))
    })

    const version = await new HttpCdpTransport('http://127.0.0.1:9222').version()

    expect(version.browser).toBe('Chrome/141.0.0.0')
    expect(urls).toEqual(['http://127.0.0.1:9222/json/version', 'http://localhost:9222/json/version'])
  })

  it('兜底生效后，命令通道地址跟着换到同一个主机名', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('127.0.0.1')) throw new Error('blocked by enterprise policy')
      return new Response(JSON.stringify({
        Browser: 'Chrome/141.0.0.0',
        // 服务端自己写的地址仍是 127.0.0.1 —— 它不知道我们靠哪个名字连上来的。
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
      }))
    })
    const seen: string[] = []
    let socket: FakeSocket | undefined
    const transport = new HttpCdpTransport('http://127.0.0.1:9222', {
      socketFactory: (url) => {
        seen.push(url)
        socket = new FakeSocket()
        return socket
      },
    })

    await transport.version()
    const connecting = transport.connect('ws://127.0.0.1:9222/devtools/page/p1')
    socket?.open()

    await expect(connecting).resolves.toBeInstanceOf(CdpConnection)
    expect(seen[0]).toBe('ws://localhost:9222/devtools/page/p1')
  })

  it('两个回环名都连不上时只各试一次，然后报端点不可达', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      throw new Error('blocked')
    })

    await expect(new HttpCdpTransport('http://127.0.0.1:9222').version())
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_ENDPOINT_UNREACHABLE' }))
    expect(urls).toEqual(['http://127.0.0.1:9222/json/version', 'http://localhost:9222/json/version'])
  })

  it('非回环端点不换主机名 —— 兜底只在本机范围内成立', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      throw new Error('blocked')
    })

    await expect(new HttpCdpTransport('http://example.com:9222').version())
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_ENDPOINT_UNREACHABLE' }))
    expect(urls).toEqual(['http://example.com:9222/json/version'])
  })
})
