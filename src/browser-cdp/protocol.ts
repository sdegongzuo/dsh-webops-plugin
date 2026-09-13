/**
 * CDP 传输层：DevTools 的 HTTP 端点（发现/开/关 target）+ WebSocket 上的命令通道。
 *
 * 不引入 Playwright / Puppeteer：那两者都会拖来自带 Chromium 的下载与构建脚本授权，
 * 而这里要的只是「连上用户自己开着的 Chrome」—— 一条 HTTP 请求加一个 WebSocket 就够了。
 *
 * 传输层与业务层之间隔了 {@link CdpTransport} 这层接口，测试可以整段替换掉，
 * 不必真的起浏览器。
 *
 * @module dsh-webops-plugin/browser-cdp/protocol
 */

import { BrowserError } from '../browser/types.ts'
import type { BrowserErrorCode } from '../browser/types.ts'

/** Chrome DevTools HTTP 端点描述的一个 target。 */
export interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly url: string
  readonly title: string
  /** 该 target 的命令通道地址；`/json/list` 一定给，`/json/new` 不给时按端点补出来。 */
  readonly webSocketDebuggerUrl: string
}

/** `/json/version` 的响应。 */
export interface CdpVersion {
  readonly browser: string
  readonly webSocketDebuggerUrl: string
}

/** 一个 CDP 命令的返回体。 */
export interface CdpCommandOptions {
  readonly timeoutMs?: number
  /**
   * 调用方的取消信号。显式允许 `undefined`：调用链上到处都有「可选信号」，
   * 让这里跟着可选，比在每个调用点写条件展开干净得多。
   */
  readonly signal?: AbortSignal | undefined
}

/**
 * WebSocket 的最小抽象。生产实现直接用 Node 的全局 `WebSocket`；
 * 测试注入假实现即可在无浏览器的情况下驱动整套命令相关性逻辑。
 */
export interface CdpSocket {
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void
}

/** 按 `webSocketDebuggerUrl` 建连接。 */
export type CdpSocketFactory = (url: string) => CdpSocket

/** 传输层契约：只有这五个动作。 */
export interface CdpTransport {
  /** 探测调试端点，返回浏览器版本信息。失败即「端点不可达」。 */
  version(signal?: AbortSignal): Promise<CdpVersion>
  /** 列出当前所有 target。 */
  list(signal?: AbortSignal): Promise<readonly CdpTarget[]>
  /** 新开一个标签页并返回它的 target。 */
  newTab(url: string, signal?: AbortSignal): Promise<CdpTarget>
  /** 关闭一个 target。target 已消失视为成功。 */
  closeTarget(targetId: string, signal?: AbortSignal): Promise<void>
  /** 建立命令通道。 */
  connect(webSocketDebuggerUrl: string, signal?: AbortSignal): Promise<CdpConnection>
}

/** 默认的单条 CDP 命令超时。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

/** 一次 pending 命令的簿记。 */
interface PendingCommand {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly detachAbort: () => void
}

/** 命令返回体里的错误对象（CDP 的 `{ code, message }`）。 */
interface CdpErrorPayload {
  readonly code?: number
  readonly message?: string
}

/**
 * 一条 CDP 连接上的命令/事件多路复用。
 *
 * 协议形态：`{ id, method, params }` 出，`{ id, result | error }` 或 `{ method, params }` 回。
 * 断开时所有在途命令以 `BROWSER_CONNECTION_LOST` 拒绝 —— 静默挂起比报错更糟。
 */
export class CdpConnection {
  private readonly socket: CdpSocket
  private readonly commandTimeoutMs: number
  private readonly pending = new Map<number, PendingCommand>()
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly closeListeners = new Set<() => void>()
  private nextId = 1
  private closed = false

  constructor(socket: CdpSocket, commandTimeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS) {
    this.socket = socket
    this.commandTimeoutMs = commandTimeoutMs
    socket.addEventListener('message', event => this.handleMessage(event))
    socket.addEventListener('close', () => this.handleClosed())
    socket.addEventListener('error', () => this.handleClosed())
  }

  /** 连接是否已断开。 */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * 订阅「连接已断开」。用于让上层摘掉已经死掉的会话。
   * @param listener - 断开时调用一次。
   * @returns 退订函数；连接已经断开时立即调用并返回空退订。
   */
  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener()
      return () => undefined
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  /**
   * 发一条命令并等它的结果。
   * @param method - CDP 方法名，例如 `Page.captureScreenshot`。
   * @param params - 方法参数。
   * @param options - 单次调用的超时与取消信号。
   * @returns 该方法的 `result`。
   * @throws `BROWSER_CONNECTION_LOST` / `BROWSER_PROTOCOL_ERROR`。
   */
  send<T>(method: string, params?: Record<string, unknown>, options?: CdpCommandOptions): Promise<T> {
    if (this.closed) {
      return Promise.reject(connectionLost(`cannot send "${method}": the CDP connection is closed`))
    }
    const id = this.nextId
    this.nextId += 1
    const timeoutMs = options?.timeoutMs ?? this.commandTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserError(
          `CDP command "${method}" did not complete within ${timeoutMs} ms`,
          'BROWSER_PROTOCOL_ERROR',
        ))
      }, timeoutMs)
      const signal = options?.signal
      const onAbort = (): void => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(signal?.reason ?? new BrowserError(`CDP command "${method}" was aborted`, 'BROWSER_CONNECTION_LOST'))
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(timer)
          reject(signal.reason ?? new BrowserError(`CDP command "${method}" was aborted`, 'BROWSER_CONNECTION_LOST'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
        detachAbort: () => signal?.removeEventListener('abort', onAbort),
      })
      try {
        this.socket.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }))
      } catch (error: unknown) {
        this.settle(id, () => reject(new BrowserError(
          `failed to write CDP command "${method}"`,
          'BROWSER_CONNECTION_LOST',
          { cause: error },
        )))
      }
    })
  }

  /**
   * 订阅一个 CDP 事件（例如 `Page.loadEventFired`）。
   * @param method - 事件名。
   * @param listener - 收到该事件时调用。
   * @returns 退订函数。
   */
  on(method: string, listener: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set<(params: unknown) => void>()
    set.add(listener)
    this.listeners.set(method, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(method)
    }
  }

  /** 关闭连接；在途命令以 `BROWSER_CONNECTION_LOST` 结束。 */
  close(): void {
    if (this.closed) return
    try {
      this.socket.close()
    } catch {
      // 已经不存在了就没什么可关的。
    }
    this.handleClosed()
  }

  /** 把一个在途命令从表里摘掉再执行收尾，避免重复结算。 */
  private settle(id: number, settle: (entry: PendingCommand) => void): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.detachAbort()
    settle(entry)
  }

  /** 处理一条入站消息：有 `id` 的结算命令，有 `method` 的分发给订阅者。 */
  private handleMessage(event: unknown): void {
    const raw = (event as { data?: unknown }).data
    if (typeof raw !== 'string') return
    let message: { id?: unknown; method?: unknown; result?: unknown; error?: CdpErrorPayload; params?: unknown }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      // 无法解析也没法归属到任何命令；丢掉，不要因此炸掉整条连接。
      return
    }
    if (typeof message.id === 'number') {
      const error = message.error
      this.settle(message.id, (entry) => {
        if (error !== undefined) {
          entry.reject(new BrowserError(
            `CDP error: ${error.message ?? 'unknown error'}${error.code === undefined ? '' : ` (code ${error.code})`}`,
            'BROWSER_PROTOCOL_ERROR',
          ))
          return
        }
        entry.resolve(message.result)
      })
      return
    }
    if (typeof message.method === 'string') {
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params)
        } catch {
          // 订阅者自己的异常不该影响其它订阅者。
        }
      }
    }
  }

  /** 连接断开：所有在途命令一律失败，绝不静默挂起。 */
  private handleClosed(): void {
    if (this.closed) return
    this.closed = true
    for (const [id, entry] of [...this.pending]) this.settle(id, entry => entry.reject(
      connectionLost('the CDP connection closed before the command completed'),
    ))
    this.listeners.clear()
    for (const listener of [...this.closeListeners]) {
      try {
        listener()
      } catch {
        // 订阅者的异常不该影响断开流程本身。
      }
    }
    this.closeListeners.clear()
  }
}

/** 统一的「连接没了」错误。 */
function connectionLost(message: string): BrowserError {
  return new BrowserError(message, 'BROWSER_CONNECTION_LOST')
}

/** 把 fetch 的网络层失败翻译成能力错误码。 */
function transportError(what: string, error: unknown): BrowserError {
  return new BrowserError(
    `cannot reach the Chrome DevTools endpoint (${what}); start Chrome with --remote-debugging-port=<port>`,
    'BROWSER_ENDPOINT_UNREACHABLE',
    { cause: error },
  )
}

/** 判断一个未知值是不是 Chrome 返回的 target 描述。 */
function isCdpTarget(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const { id, type, url, title } = value as Record<string, unknown>
  return typeof id === 'string' && typeof type === 'string' && typeof url === 'string' && typeof title === 'string'
}

/** 从任意 JSON 值里读一个字符串字段。 */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/** 用 Node 的全局 `WebSocket` 建连接。 */
function defaultSocketFactory(url: string): CdpSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => CdpSocket }).WebSocket
  if (Ctor === undefined) {
    throw new BrowserError(
      'the runtime exposes no global WebSocket; Node 22 or newer is required',
      'BROWSER_ENDPOINT_UNREACHABLE',
    )
  }
  return new Ctor(url)
}

/** {@link CdpTransport} 的默认实现：DevTools HTTP 端点 + 全局 WebSocket。 */
export class HttpCdpTransport implements CdpTransport {
  private readonly endpoint: string
  private readonly requestTimeoutMs: number
  private readonly commandTimeoutMs: number
  private readonly socketFactory: CdpSocketFactory

  /**
   * @param endpoint - 形如 `http://127.0.0.1:9222`（已去掉尾斜杠）。
   * @param options - 超时与 socket 工厂（测试注入假实现）。
   */
  constructor(
    endpoint: string,
    options: { requestTimeoutMs?: number; commandTimeoutMs?: number; socketFactory?: CdpSocketFactory } = {},
  ) {
    this.endpoint = endpoint
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
  }

  /** @inheritdoc */
  async version(signal?: AbortSignal): Promise<CdpVersion> {
    const body = await this.request('/json/version', signal)
    const webSocketDebuggerUrl = readString(body, 'webSocketDebuggerUrl')
    if (webSocketDebuggerUrl === undefined) {
      throw new BrowserError('/json/version returned no webSocketDebuggerUrl', 'BROWSER_PROTOCOL_ERROR')
    }
    return { browser: readString(body, 'Browser') ?? 'unknown', webSocketDebuggerUrl }
  }

  /** @inheritdoc */
  async list(signal?: AbortSignal): Promise<readonly CdpTarget[]> {
    const body = await this.requestRaw('/json/list', signal, 'GET')
    if (!Array.isArray(body)) {
      throw new BrowserError('/json/list did not return an array', 'BROWSER_PROTOCOL_ERROR')
    }
    return body.filter(isCdpTarget).map(entry => this.toTarget(entry))
  }

  /** @inheritdoc */
  async newTab(url: string, signal?: AbortSignal): Promise<CdpTarget> {
    const body = await this.request(`/json/new?${encodeURIComponent(url)}`, signal, 'PUT')
    if (!isCdpTarget(body)) {
      throw new BrowserError('/json/new did not return a target description', 'BROWSER_PROTOCOL_ERROR')
    }
    return this.toTarget(body)
  }

  /** @inheritdoc */
  async closeTarget(targetId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.request(`/json/close/${encodeURIComponent(targetId)}`, signal, 'PUT')
    } catch (error: unknown) {
      // target 已经不存在时 Chrome 会回 404 —— 那正是我们想要的结果。
      if (error instanceof BrowserError && error.code === 'BROWSER_PROTOCOL_ERROR') return
      throw error
    }
  }

  /** @inheritdoc */
  async connect(webSocketDebuggerUrl: string, signal?: AbortSignal): Promise<CdpConnection> {
    let rawSocket: CdpSocket
    try {
      rawSocket = this.socketFactory(webSocketDebuggerUrl)
    } catch (error: unknown) {
      throw transportError('websocket', error)
    }
    try {
      await openSocket(rawSocket, signal)
    } catch (error: unknown) {
      try {
        rawSocket.close()
      } catch {
        // 打开失败时关闭也可能失败，忽略。
      }
      throw error
    }
    return new CdpConnection(rawSocket, this.commandTimeoutMs)
  }

  /** 解析 target 描述；`/json/new` 可能不给 `webSocketDebuggerUrl`，按端点补出来。 */
  private toTarget(entry: Record<string, unknown>): CdpTarget {
    const id = entry['id'] as string
    const webSocketDebuggerUrl = readString(entry, 'webSocketDebuggerUrl')
      ?? `${this.endpoint.replace(/^http/u, 'ws')}/devtools/page/${encodeURIComponent(id)}`
    return {
      id,
      type: readString(entry, 'type') ?? 'page',
      url: readString(entry, 'url') ?? '',
      title: readString(entry, 'title') ?? '',
      webSocketDebuggerUrl,
    }
  }

  /**
   * 发一个 DevTools HTTP 请求并解析 JSON 对象。
   * @param path - 以 `/` 开头的路径（含查询串）。
   * @param signal - 调用方取消信号。
   * @param method - HTTP 方法；`/json/new` 与 `/json/close` 在 Chrome 111+ 只接受 PUT。
   * @returns 解析后的 JSON 体。
   */
  private async request(path: string, signal?: AbortSignal, method = 'GET'): Promise<Record<string, unknown>> {
    const body = await this.requestRaw(path, signal, method)
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
    throw new BrowserError(`${path} did not return a JSON object`, 'BROWSER_PROTOCOL_ERROR')
  }

  private async requestRaw(path: string, signal: AbortSignal | undefined, method: string): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(`${this.endpoint}${path}`, { method, signal: combined })
    } catch (error: unknown) {
      throw transportErrorHttp(path, error)
    }
    if (!response.ok) {
      throw new BrowserError(
        `DevTools endpoint ${path} responded ${response.status}`,
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    const text = await response.text()
    if (text.length === 0) return {}
    try {
      return JSON.parse(text)
    } catch (error: unknown) {
      throw new BrowserError(`DevTools endpoint ${path} returned malformed JSON`, 'BROWSER_PROTOCOL_ERROR', { cause: error })
    }
  }
}

/** HTTP 层的失败：回环地址拒绝连接 / 超时都算端点不可达。 */
function transportErrorHttp(path: string, error: unknown): BrowserError {
  const code: BrowserErrorCode = 'BROWSER_ENDPOINT_UNREACHABLE'
  return new BrowserError(
    `cannot reach the Chrome DevTools endpoint at ${path}; start Chrome with --remote-debugging-port=<port> and a distinct --user-data-dir`,
    code,
    { cause: error },
  )
}

/** 等 WebSocket 打开；打开前出错或提前关闭都算失败。 */
function openSocket(socket: CdpSocket, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: BrowserError): void => {
      if (settled) return
      settled = true
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = (): void => finish(connectionLost('the CDP connection attempt was aborted'))
    if (signal !== undefined) {
      if (signal.aborted) {
        finish(connectionLost('the CDP connection attempt was aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    socket.addEventListener('open', () => finish())
    socket.addEventListener('error', event => finish(new BrowserError(
      `failed to open the CDP websocket: ${describeEvent(event)}`,
      'BROWSER_ENDPOINT_UNREACHABLE',
    )))
    socket.addEventListener('close', () => finish(connectionLost(
      'the CDP websocket closed before it opened',
    )))
  })
}

/** 把事件对象压成一句可读诊断。 */
function describeEvent(event: unknown): string {
  if (typeof event === 'object' && event !== null) {
    const message = (event as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return 'no detail reported'
}
