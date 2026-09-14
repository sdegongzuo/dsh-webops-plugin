import { describe, expect, it } from 'vitest'
import { NETWORK_TABLE_CAPACITY, NetworkCollector } from './network.ts'
import { CdpConnection } from './protocol.ts'
import type { CdpSocket } from './protocol.ts'

/**
 * 可注入 CDP 事件的假 socket：命令按脚本回复（默认空 result），
 * `Network.getResponseBody` 的返回体由 `body` 字段决定。
 */
class EventSocket implements CdpSocket {
  closed = false
  readonly sent: { method: string; params: Record<string, unknown> }[] = []
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>()

  /**
   * detach 模拟：置 true 后 `emit` 的事件**不会**送达采集器。
   * CDP 会话不在线时就是这个效果 —— 事件不是迟到，是永久不到。
   */
  muted = false

  constructor(private readonly body = 'pong') {}

  send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
    const params = request.params ?? {}
    this.sent.push({ method: request.method, params })
    queueMicrotask(() => {
      const result = request.method === 'Network.getResponseBody'
        ? { body: this.body, base64Encoded: false }
        : {}
      this.dispatch('message', { data: JSON.stringify({ id: request.id, result }) })
    })
  }

  close(): void {
    this.closed = true
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(listener)
    this.handlers.set(type, list)
  }

  /** 注入一条 CDP 事件。 */
  emit(method: string, params: unknown): void {
    if (this.muted) return
    this.dispatch('message', { data: JSON.stringify({ method, params }) })
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...this.handlers.get(type) ?? []]) listener(event)
  }
}

/** 发起一个请求（建档的唯一来源）。 */
function requestEvent(requestId: string, method: string, url: string): Record<string, unknown> {
  return { requestId, request: { method, url } }
}

/** 补一个响应（更新 status / mimeType / fromDiskCache）。 */
function responseEvent(requestId: string, url: string, status: number, mimeType?: string, fromDiskCache = false): Record<string, unknown> {
  return { requestId, response: { url, status, mimeType, fromDiskCache } }
}

describe('NetworkCollector', () => {
  it('collects request, response and failure events into a newest-first table', () => {
    const socket = new EventSocket()
    const collector = new NetworkCollector(new CdpConnection(socket))

    socket.emit('Network.requestWillBeSent', requestEvent('1', 'GET', 'https://api.example.com/x'))
    socket.emit('Network.responseReceived', responseEvent('1', 'https://api.example.com/x', 200, 'application/json'))
    socket.emit('Network.requestWillBeSent', requestEvent('2', 'POST', 'https://api.example.com/y'))
    socket.emit('Network.loadingFailed', { requestId: '2', errorText: 'net::ERR_FAILED' })
    socket.emit('Network.requestWillBeSent', requestEvent('3', 'GET', 'https://static.example.com/logo.png'))
    socket.emit('Network.responseReceived', responseEvent('3', 'https://static.example.com/logo.png', 200, 'image/png', true))

    const { requests: entries } = collector.list(50)
    expect(entries.map(entry => entry.requestId)).toEqual(['3', '2', '1'])
    expect(entries[0]).toMatchObject({ method: 'GET', mimeType: 'image/png', fromDiskCache: true })
    expect(entries[1]).toMatchObject({ method: 'POST', errorText: 'net::ERR_FAILED' })
    expect(entries[2]).toMatchObject({ method: 'GET', status: 200, mimeType: 'application/json' })
  })

  it('fetches a body with the requestId taken verbatim from the events ([V18])', async () => {
    const socket = new EventSocket('pong')
    const collector = new NetworkCollector(new CdpConnection(socket))

    socket.emit('Network.requestWillBeSent', requestEvent('37668.2', 'GET', 'https://api.example.com/ping'))

    const result = await collector.body('37668.2', { timeoutMs: 100 })
    expect(result).toEqual({ body: 'pong', base64Encoded: false, truncated: false })
    // 发出的就是事件里原样的 id —— 不存在任何映射表。
    const call = socket.sent.find(entry => entry.method === 'Network.getResponseBody')
    expect(call?.params).toEqual({ requestId: '37668.2' })
  })

  it('truncates an oversized response body and marks it truncated', async () => {
    const socket = new EventSocket('x'.repeat(25_000))
    const collector = new NetworkCollector(new CdpConnection(socket))

    const result = await collector.body('big', { timeoutMs: 100 })
    expect(result.truncated).toBe(true)
    expect(result.body.length).toBeLessThan(25_000)
    expect(result.body).toContain('truncated')
  })

  it('filters by a case-insensitive URL substring', () => {
    const socket = new EventSocket()
    const collector = new NetworkCollector(new CdpConnection(socket))

    socket.emit('Network.requestWillBeSent', requestEvent('1', 'GET', 'https://api.example.com/users'))
    socket.emit('Network.requestWillBeSent', requestEvent('2', 'GET', 'https://static.example.com/app.js'))

    const { requests: matched } = collector.list(50, 'API.Example')
    expect(matched.map(entry => entry.requestId)).toEqual(['1'])
  })

  it('keeps an orphan response as a partial entry instead of dropping it ([V40])', () => {
    const socket = new EventSocket()
    const collector = new NetworkCollector(new CdpConnection(socket))

    // detach 期间发起、re-attach 后完成的请求：`requestWillBeSent` 不会补发。
    socket.emit('Network.responseReceived', responseEvent('orph-1', 'https://api.example.com/late', 200, 'text/html'))
    socket.emit('Network.loadingFailed', { requestId: 'orph-2', errorText: 'net::ERR_ABORTED' })

    const { requests: entries } = collector.list(50)
    expect(entries.map(entry => entry.requestId)).toEqual(['orph-2', 'orph-1'])
    expect(entries[1]).toMatchObject({
      url: 'https://api.example.com/late',
      status: 200,
      partial: true,
      reason: 'request-headers-missing',
    })
    expect(entries[1]?.method).toBeUndefined()
    expect(entries[0]).toMatchObject({ partial: true, reason: 'request-headers-missing', errorText: 'net::ERR_ABORTED' })
  })

  it('completes an entry whose response only arrives after re-attach (request started before detach)', () => {
    const socket = new EventSocket()
    const collector = new NetworkCollector(new CdpConnection(socket))

    socket.emit('Network.requestWillBeSent', requestEvent('r1', 'GET', 'https://api.example.com/slow'))
    // detach：这段窗口里什么都没发生（请求是在 detach **之前**发起的）。
    socket.muted = true
    socket.muted = false
    // re-attach 之后才完成：收尾链完整，不该被标成半截记录。
    socket.emit('Network.responseReceived', responseEvent('r1', 'https://api.example.com/slow', 200, 'text/html'))

    const entry = collector.get('r1')
    expect(entry).toMatchObject({ method: 'GET', status: 200, mimeType: 'text/html' })
    expect(entry?.partial).toBeUndefined()
    expect(entry?.reason).toBeUndefined()
  })

  it('loses a request that both started and finished during detach — permanently ([V38])', () => {
    const socket = new EventSocket()
    const collector = new NetworkCollector(new CdpConnection(socket))

    socket.emit('Network.requestWillBeSent', requestEvent('kept', 'GET', 'https://api.example.com/kept'))
    // detach：这期间发生的一切事件一条都到不了采集器（不是迟到，是永久不到）。
    socket.muted = true
    socket.emit('Network.requestWillBeSent', requestEvent('lost', 'GET', 'https://api.example.com/lost'))
    socket.emit('Network.responseReceived', responseEvent('lost', 'https://api.example.com/lost', 200, 'text/html'))
    socket.muted = false
    socket.emit('Network.requestWillBeSent', requestEvent('kept-2', 'GET', 'https://api.example.com/kept-2'))

    const { requests } = collector.list(50)
    expect(requests.map(entry => entry.requestId)).toEqual(['kept-2', 'kept'])
    // 这条断言的是「它确实没来」——[V38] 是已知且接受的能力边界，将来谁想加
    // 「detach 期间的事件回填」，得先证明 CDP 真有这个能力，而不是把这条删掉。
    expect(collector.get('lost')).toBeUndefined()
  })

  it('updates an existing entry without marking it partial', () => {
    const socket = new EventSocket()
    const collector = new NetworkCollector(new CdpConnection(socket))

    socket.emit('Network.requestWillBeSent', requestEvent('1', 'GET', 'https://api.example.com/x'))
    socket.emit('Network.responseReceived', responseEvent('1', 'https://api.example.com/x', 304, 'text/html'))

    const entry = collector.get('1')
    expect(entry).toMatchObject({ method: 'GET', status: 304 })
    expect(entry?.partial).toBeUndefined()
    expect(entry?.reason).toBeUndefined()
  })

  it('caps the request table at its ring capacity, evicting the oldest requestId', () => {
    const socket = new EventSocket()
    const collector = new NetworkCollector(new CdpConnection(socket))

    for (let index = 1; index <= NETWORK_TABLE_CAPACITY + 5; index += 1) {
      socket.emit('Network.requestWillBeSent', requestEvent(`r-${index}`, 'GET', `https://example.com/${index}`))
    }

    expect(collector.size).toBe(NETWORK_TABLE_CAPACITY)
    expect(collector.get('r-1')).toBeUndefined()
    expect(collector.get('r-6')).toBeDefined()
    expect(collector.get(`r-${NETWORK_TABLE_CAPACITY + 5}`)).toBeDefined()
  })

  it('hides earlier-document requests by default and reports how many are hidden (2026-09-14)', () => {
    const socket = new EventSocket()
    const collector = new NetworkCollector(new CdpConnection(socket))

    // 第一个文档：两次请求。
    socket.emit('Network.requestWillBeSent', requestEvent('a-1', 'GET', 'https://wikipedia.org/'))
    socket.emit('Network.requestWillBeSent', requestEvent('a-2', 'GET', 'https://wikipedia.org/logo.png'))
    collector.noteNavigation()
    // 第二个文档（导航之后）：一次请求。
    socket.emit('Network.requestWillBeSent', requestEvent('b-1', 'GET', 'https://httpbin.org/html'))

    const current = collector.list(50)
    expect(current.document).toBe(1)
    expect(current.requests.map(entry => entry.requestId)).toEqual(['b-1'])
    expect(current.earlierDocuments).toBe(2)

    // 不是丢弃：allDocuments 能读回来，body 也照样按 requestId 取。
    const all = collector.list(50, undefined, true)
    expect(all.requests.map(entry => entry.requestId)).toEqual(['b-1', 'a-2', 'a-1'])
    expect(collector.get('a-1')).toBeDefined()
  })

  it('keeps a request in the document it started in, even if it is updated after a navigation', () => {
    const socket = new EventSocket()
    const collector = new NetworkCollector(new CdpConnection(socket))

    socket.emit('Network.requestWillBeSent', requestEvent('slow', 'GET', 'https://example.com/slow'))
    collector.noteNavigation()
    // 导航后迟到的响应：这条请求属于**上一个**文档。
    socket.emit('Network.responseReceived', responseEvent('slow', 'https://example.com/slow', 200, 'text/html'))

    expect(collector.get('slow')).toMatchObject({ document: 0, status: 200 })
    expect(collector.list(50).requests).toEqual([])
    expect(collector.list(50).earlierDocuments).toBe(1)
  })
})
