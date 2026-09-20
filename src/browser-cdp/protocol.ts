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
import { noteLoaded } from '../debug.ts'
import { isLoopbackHost, loopbackCandidates, withHost } from '../loopback.ts'

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
  /**
   * 把一个 target 切到前台（可选能力）。外部 Chrome 走 `/json/activate`；
   * Electron 窗口宿主走 `{ op: 'activate' }`。没有实现时标签页管理会报
   * `BROWSER_NOT_IMPLEMENTED`。
   */
  activateTarget?(targetId: string, signal?: AbortSignal): Promise<void>
  /**
   * 当前前台 target 的 id（可选能力）。Electron 宿主自己知道；外部 Chrome
   * 没有可靠信号，默认不实现。
   */
  activeTargetId?(): Promise<string | undefined>
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
   * @throws `BROWSER_CONNECTION_LOST` / `BROWSER_PROTOCOL_ERROR` / `BROWSER_DEBUGGER_DETACHED`。
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
        const entry = this.pending.get(id)
        this.pending.delete(id)
        // 超时这条路径以前只 `pending.delete`，**没摘 abort 监听**。工具的 `exec.signal`
        // 是长生命周期的（一次工具调用里要发好几条命令），每超时一条就多挂一个
        // `{ once: true }` 监听却永不触发 —— 会话活得越久攒得越多。
        entry?.detachAbort()
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
          entry.reject(mapCdpError(error))
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
        } catch (error: unknown) {
          // 订阅者自己的异常不该影响其它订阅者 —— 但**也不能静默**：
          // 采集器（console / network）里的逻辑 bug 只会在处理事件时炸，以前这里全吞，
          // 症状是「采集器悄悄不干活了」而日志一条没有。
          // 走 `noteLoaded` 而不是 `console.error`：本插件默认不往 stdout/stderr 写东西，
          // 而且桌面端把子进程的 stderr 攒在内存里、只在失败时才抛 —— 写 stderr 等于没写
          // （见 debug.ts 文件头）。需要看时开 `DSH_BROWSER_PLUGIN_DEBUG=1`。
          noteLoaded('browser-cdp', `${message.method} 的订阅者抛错，该条事件已跳过：${error instanceof Error ? error.message : String(error)}`)
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

/**
 * 把一条 CDP 错误负载翻译成能力错误。
 *
 * 只特判一种消息：`No target available`（`[V16]` 实测）。它只在「调试器被 detach」时出现 ——
 * 例如宿主为了让位给 DevTools 而 detach 的那一瞬（detach 期间命令**同步**抛错、不挂起，
 * re-attach 后自动恢复）。所以它映射成**可恢复**的 `BROWSER_DEBUGGER_DETACHED`，让模型知道
 * 「重新观察 / 稍后重试」是对的，而不是把它当成协议错误。
 *
 * 其余一律保持原有的 `BROWSER_PROTOCOL_ERROR` 语义 —— 这条映射**只加一个分支**。
 */
function mapCdpError(error: CdpErrorPayload): BrowserError {
  const detail = error.message ?? 'unknown error'
  if (detail.includes('No target available')) {
    return new BrowserError(
      `the CDP debugger is detached from this target (${detail}); it re-attaches by itself once DevTools `
      + 'finishes opening — retry the same call or take a fresh webpage_snapshot',
      'BROWSER_DEBUGGER_DETACHED',
    )
  }
  return new BrowserError(
    `CDP error: ${detail}${error.code === undefined ? '' : ` (code ${error.code})`}`,
    'BROWSER_PROTOCOL_ERROR',
  )
}

/**
 * 判断一个错误是不是「target 已经不存在」（DevTools 端点回 404）。
 * 只有 404 配得上幂等成功；403 / 500 之类是真错，必须照抛。
 */
function isTargetGone(error: unknown): boolean {
  return error instanceof BrowserError
    && error.code === 'BROWSER_PROTOCOL_ERROR'
    && error.status === 404
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

/**
 * 端点的回环候选主机名（端口与路径不变，只换名字）。
 *
 * 端点不是合法 URL 时给空数组 —— 那时照原样连一次，错由 `fetch` 自己报，
 * 别在这里提前抛一个与真实原因无关的错误。
 */
function endpointHosts(endpoint: string): readonly string[] {
  try {
    return loopbackCandidates(new URL(endpoint).hostname)
  } catch {
    return []
  }
}

/** {@link CdpTransport} 的默认实现：DevTools HTTP 端点 + 全局 WebSocket。 */
export class HttpCdpTransport implements CdpTransport {
  /** 配置里给出的原始端点；候选主机名都是从它派生出来的。 */
  private readonly baseEndpoint: string
  /** 回环候选主机名，顺序即尝试顺序。 */
  private readonly hosts: readonly string[]
  /** 当前生效的候选下标。 */
  private hostIndex = 0
  /**
   * 是否已经有过一次成功请求。
   *
   * 成了就**锁定**当前主机名：之后的失败只是「这次请求没成」，换个名字重试只会把
   * 一个能用的端点换来换去，把真正的错误（端口上没服务）盖成「名字不对」。
   */
  private settled = false
  private endpoint: string
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
    this.baseEndpoint = endpoint
    this.hosts = endpointHosts(endpoint)
    this.endpoint = this.hosts.length === 0 ? endpoint : withHost(endpoint, this.hosts[0] as string)
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
      // Chrome 成功时回纯文本（见 requestText），所以这里不解析响应体，只看状态码。
      await this.requestText(`/json/close/${encodeURIComponent(targetId)}`, signal, 'PUT')
    } catch (error: unknown) {
      // target 已经不存在时 Chrome 会回 404 —— 那正是我们想要的结果（幂等成功）。
      // 其它状态码（403 / 500…）是真错，必须照抛 —— 只看错误 code 一刀切的话会把它们一起吞掉。
      if (isTargetGone(error)) return
      throw error
    }
  }

  /** @inheritdoc */
  async activateTarget(targetId: string, signal?: AbortSignal): Promise<void> {
    try {
      // 与 close 同一族端点：成功回纯文本 `Target activated`（实测 Chrome 153），不解析体。
      await this.requestText(`/json/activate/${encodeURIComponent(targetId)}`, signal, 'GET')
    } catch (error: unknown) {
      // target 已经不存在时 Chrome 会回 404 —— 幂等成功。同上，只吞 404。
      if (isTargetGone(error)) return
      throw error
    }
  }

  /**
   * 把命令通道地址的主机名归一到当前生效的那个。
   *
   * `/json/version` 回的是**服务端自己**写下的地址，常见形态是 `ws://127.0.0.1:9222/...`；
   * 若 HTTP 是靠 `localhost` 才连上的，那条地址同样会被同一条策略拦掉。
   * 只在两边都是回环且不一致时替换 —— 外部主机一个字都不动。
   */
  private rewriteWsHost(webSocketDebuggerUrl: string): string {
    const host = this.hosts[this.hostIndex]
    if (host === undefined) return webSocketDebuggerUrl
    try {
      const parsed = new URL(webSocketDebuggerUrl)
      if (!isLoopbackHost(parsed.hostname) || parsed.hostname.replace(/^\[|\]$/gu, '') === host) {
        return webSocketDebuggerUrl
      }
      return withHost(webSocketDebuggerUrl, host)
    } catch {
      return webSocketDebuggerUrl
    }
  }

  /** @inheritdoc */
  async connect(webSocketDebuggerUrl: string, signal?: AbortSignal): Promise<CdpConnection> {
    const url = this.rewriteWsHost(webSocketDebuggerUrl)
    let rawSocket: CdpSocket
    try {
      rawSocket = this.socketFactory(url)
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
    const text = await this.requestText(path, signal, method)
    if (text.length === 0) return {}
    try {
      return JSON.parse(text)
    } catch (error: unknown) {
      throw new BrowserError(`DevTools endpoint ${path} returned malformed JSON`, 'BROWSER_PROTOCOL_ERROR', { cause: error })
    }
  }

  /**
   * 发一个 DevTools HTTP 请求，只关心「状态码过不过」，把响应体原样当文本返回、**不解析**。
   * 给 `/json/close` 与 `/json/activate` 这类端点用：Chrome 成功时回的是纯文本
   * （实测 Chrome 153：`Target is closing` / `Target activated`），走 JSON 解析会把成功报成失败。
   */
  private async requestText(path: string, signal: AbortSignal | undefined, method: string): Promise<string> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    for (;;) {
      let response: Response
      try {
        response = await fetch(`${this.endpoint}${path}`, { method, signal: combined })
      } catch (error: unknown) {
        // 只有「连不上」才值得换名字重试；超时（signal 已 abort）换了也一样超时，直接抛。
        if (combined.aborted || !this.fallback()) throw transportErrorHttp(path, error)
        continue
      }
      if (!response.ok) {
        throw new BrowserError(
          `DevTools endpoint ${path} responded ${response.status}`,
          'BROWSER_PROTOCOL_ERROR',
          { status: response.status },
        )
      }
      // 成了就锁定：后续请求不再换主机名。
      this.settled = true
      return await response.text()
    }
  }

  /**
   * 换到下一个回环主机名。
   *
   * @returns 换了就 `true`；没有下一个候选、或已经有主机成功过就 `false`。
   */
  private fallback(): boolean {
    if (this.settled) return false
    const next = this.hostIndex + 1
    const host = this.hosts[next]
    if (host === undefined) return false
    const from = this.hosts[this.hostIndex]
    this.hostIndex = next
    this.endpoint = withHost(this.baseEndpoint, host)
    noteLoaded('browser-cdp', `端点 ${String(from)} 连不上，改用回环兜底 ${host}`)
    return true
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
