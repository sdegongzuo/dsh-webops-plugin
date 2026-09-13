/**
 * 窗口宿主的父侧桥：spawn Electron、握手、请求/响应、事件分发。
 *
 * 桥只做「传输」，不理解 CDP 语义 —— 命令转发与事件转发的契约写在
 * [`host.cjs`](./host.cjs) 的模块注释里。CDP 语义由 {@link ElectronWindowTransport}
 * 翻译成 `CdpTransport`，于是整个 `CdpBrowserProvider` 可以原样复用。
 *
 * 宿主是**一个窗口、多个标签页**：`open` 开的是标签（复用同一个壳窗口），
 * `activate` 决定哪个标签在前台，用户点标签条上的叉会自己关（`closed` 事件没有 `id`）。
 *
 * @module dsh-webops-plugin/browser-electron/bridge
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect, type Socket } from 'node:net'

/** 一个标签页的摘要。 */
export interface BridgeTab {
  readonly id: string
  readonly url: string
  readonly title: string
  /** 是否在前台。 */
  readonly active: boolean
}

/** 宿主启动参数。 */
export interface BridgeOptions {
  /** Electron 可执行文件路径。 */
  readonly electronPath: string
  /** 窗口宿主脚本（`host.cjs`）的绝对路径。 */
  readonly hostScript: string
  /** 首次开窗的尺寸。 */
  readonly windowSize?: { readonly width: number; readonly height: number }
  /** 单条命令的超时（毫秒）。默认 30000。 */
  readonly commandTimeoutMs?: number
  /** 等宿主宣布端口的上限（毫秒）。默认 20000。 */
  readonly handshakeTimeoutMs?: number
  /**
   * 父进程断连后是否仍把窗口留在屏幕上（默认 `false`）。
   *
   * 演示与人工接管时用：宿主不再「一断连就自杀」，而是等用户关窗口才退出。
   */
  readonly keepAlive?: boolean
}

/** 宿主给的失败。 */
export class BridgeError extends Error {
  readonly code: string

  /**
   * @param message - 诊断信息。
   * @param code - 机器可读的失败码。
   */
  constructor(message: string, code: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/** 默认命令超时。 */
export const DEFAULT_BRIDGE_COMMAND_TIMEOUT_MS = 30_000

/** 默认握手超时。 */
export const DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS = 20_000

/** 一条在途命令。 */
interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** 宿主报告的「标签条状态」：可观测性用，见 {@link TabHostChannel.bar}。 */
export interface BridgeTabBar {
  /** 宿主当前持有的标签数。 */
  readonly tabs: number
  /**
   * 标签条里实际渲染出来的 `.tab` 节点数。
   * `-1` 表示壳窗口不在（或脚本执行失败）—— 也就是「没有标签条」。
   */
  readonly rendered: number
  /** 当前前台标签 id。 */
  readonly active: string | undefined
}

/** 宿主事件监听器集合，按标签 id 归拢。 */
export type EventListener = (method: string, params: unknown) => void

/**
 * 窗口宿主通道的公共面。
 *
 * 抽出这个接口是为了让上层（socket / transport）**不依赖一个活着的 Electron 进程**：
 * 单测喂一个假通道就够，不必真的 spawn 一个窗口 —— 真机行为由 `smoke:window` 负责。
 */
export interface TabHostChannel {
  /** 通道是否已断开。 */
  readonly isClosed: boolean
  /** 让宿主开一个标签页。 */
  open: (url: string, options?: { readonly keepAlive?: boolean }) => Promise<BridgeTab>
  /** 列出现有标签页。 */
  list: () => Promise<readonly BridgeTab[]>
  /**
   * 报告标签条状态。
   *
   * 宿主是自己画的标签条（Electron 没有原生标签页），而它跑在没有 stdout 之外的
   * 旁观者的进程里。这一条让「标签条真的渲染了 N 个标签」变成可断言的事实，
   * 不必靠人眼看屏幕。
   */
  bar: () => Promise<BridgeTabBar>
  /** 发一条 CDP 命令。 */
  command: (tabId: string, method: string, params: Record<string, unknown>) => Promise<unknown>
  /** 把某个标签页切到前台。 */
  activate: (tabId: string) => Promise<void>
  /** 关掉一个标签页。 */
  closeTab: (tabId: string) => Promise<void>
  /** 关掉宿主与它开的所有窗口。 */
  dispose: () => Promise<void>
  /** 订阅某个标签页的 CDP 事件。 */
  onEvent: (tabId: string, listener: EventListener) => () => void
  /** 订阅通道断开。 */
  onClose: (listener: () => void) => () => void
}

/**
 * 一个活着的窗口宿主。
 *
 * 生命周期：{@link ElectronWindowBridge.start} 启动并握手 → 若干 `open` / `command`
 * → {@link ElectronWindowBridge.dispose} 收摊。宿主进程默认随父进程退出而退出
 * （它监听的那条 TCP 连接一断就自杀）；`keepAlive` 时窗口留给用户。
 */
export class ElectronWindowBridge implements TabHostChannel {
  private readonly child: ChildProcess
  private readonly socket: Socket
  private readonly commandTimeoutMs: number
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<EventListener>>()
  private readonly closeListeners = new Set<() => void>()
  private readonly windowSize: { readonly width: number; readonly height: number } | undefined
  private readonly keepAlive: boolean
  private nextId = 1
  private closed = false

  /**
   * @param child - 已 spawn 的 Electron 进程。
   * @param socket - 已连上的命令通道。
   * @param options - 超时与窗口尺寸。
   */
  private constructor(
    child: ChildProcess,
    socket: Socket,
    options: BridgeOptions,
  ) {
    this.child = child
    this.socket = socket
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_BRIDGE_COMMAND_TIMEOUT_MS
    this.windowSize = options.windowSize
    this.keepAlive = options.keepAlive === true
    this.wire()
  }

  /**
   * 启动宿主并完成握手。
   *
   * @param options - Electron 路径、宿主脚本与超时。
   * @returns 一条可用通道。
   * @throws `BRIDGE_ELECTRON_MISSING`（可执行文件不存在）或 `BRIDGE_START_FAILED`（起来又死）。
   */
  static async start(options: BridgeOptions): Promise<ElectronWindowBridge> {
    if (!existsSync(options.electronPath)) {
      throw new BridgeError(
        `Electron executable not found at ${options.electronPath}; point DSH_BROWSER_ELECTRON_PATH `
        + 'at an Electron binary (the desktop app ships one under node_modules/electron/dist)',
        'BRIDGE_ELECTRON_MISSING',
      )
    }
    if (!existsSync(options.hostScript)) {
      throw new BridgeError(`window host script not found at ${options.hostScript}`, 'BRIDGE_HOST_MISSING')
    }

    const environment: NodeJS.ProcessEnv = { ...process.env }
    // 宿主必须是**真的 Electron 应用**：带这个变量它会退化成纯 Node，`app` 就不存在了。
    delete environment['ELECTRON_RUN_AS_NODE']

    const child = spawn(options.electronPath, [options.hostScript], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    })

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })

    const port = await readAnnouncedPort(child, options.handshakeTimeoutMs ?? DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS)
      .catch((error: unknown) => {
        child.kill()
        const detail = stderr.trim() === '' ? '' : `; host stderr:\n${stderr.trim()}`
        throw new BridgeError(
          `the Electron window host failed to start: ${error instanceof Error ? error.message : String(error)}${detail}`,
          'BRIDGE_START_FAILED',
        )
      })

    const socket = connect({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', (error: Error) => reject(new BridgeError(
        `cannot connect to the Electron window host on 127.0.0.1:${String(port)}: ${error.message}`,
        'BRIDGE_START_FAILED',
      )))
    })

    const bridge = new ElectronWindowBridge(child, socket, options)
    // 宿主自己死了（崩了、被杀了）时，把它当成一次断连，别让调用方永远等下去。
    child.once('exit', () => { bridge.handleClosed() })
    return bridge
  }

  /** 通道是否已经断开。 */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * 订阅某个标签页的 CDP 事件。
   * @param tabId - 标签 id。
   * @param listener - 每收到一条事件调用一次。
   * @returns 退订函数。
   */
  onEvent(tabId: string, listener: EventListener): () => void {
    const set = this.listeners.get(tabId) ?? new Set<EventListener>()
    set.add(listener)
    this.listeners.set(tabId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(tabId)
    }
  }

  /**
   * 订阅「通道已断开」。
   * @param listener - 断开时调用一次。
   * @returns 退订函数。
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
   * 让宿主开一个标签页（同一个壳窗口里）。
   *
   * @param url - 初始地址。
   * @param options - `keepAlive`：父进程断连后窗口仍然留在屏幕上。
   * @returns 新标签摘要。
   */
  async open(url: string, options: { readonly keepAlive?: boolean } = {}): Promise<BridgeTab> {
    const response = await this.request({
      op: 'open',
      url,
      ...this.windowSize === undefined ? {} : { size: this.windowSize },
      ...this.keepAlive || options.keepAlive === true ? { keepAlive: true } : {},
    })
    return {
      id: String(response['tabId']),
      url: typeof response['url'] === 'string' ? response['url'] : url,
      title: typeof response['title'] === 'string' ? response['title'] : '',
      active: true,
    }
  }

  /**
   * 列出现有标签页。
   * @returns 标签摘要列表。
   */
  async list(): Promise<readonly BridgeTab[]> {
    const response = await this.request({ op: 'list' })
    const entries = response['tabs']
    if (!Array.isArray(entries)) return []
    return entries.map((entry) => {
      const record = entry as Record<string, unknown>
      return {
        id: String(record['id']),
        url: typeof record['url'] === 'string' ? record['url'] : '',
        title: typeof record['title'] === 'string' ? record['title'] : '',
        active: record['active'] === true,
      }
    })
  }

  /**
   * 报告标签条状态：宿主持有几个标签、标签条画出了几个、谁在前台。
   * @returns 标签条状态。
   */
  async bar(): Promise<BridgeTabBar> {
    const response = await this.request({ op: 'bar' })
    return {
      tabs: typeof response['tabs'] === 'number' ? response['tabs'] : 0,
      rendered: typeof response['rendered'] === 'number' ? response['rendered'] : -1,
      active: typeof response['active'] === 'string' ? response['active'] : undefined,
    }
  }

  /**
   * 发一条 CDP 命令给某个标签页。
   * @param tabId - 标签 id。
   * @param method - CDP 方法名。
   * @param params - 方法参数。
   * @returns 该方法的 `result`。
   */
  async command(tabId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await this.request({ op: 'cdp', tabId, method, params })
    return response['result']
  }

  /**
   * 把某个标签页切到前台。
   * @param tabId - 标签 id。
   */
  async activate(tabId: string): Promise<void> {
    await this.request({ op: 'activate', tabId })
  }

  /**
   * 关掉一个标签页。
   * @param tabId - 标签 id。
   */
  async closeTab(tabId: string): Promise<void> {
    try {
      await this.request({ op: 'close', tabId })
    } catch {
      // 标签早就没了 —— 那正是我们想要的。
    }
  }

  /** 关掉所有窗口并退出宿主进程。 */
  async dispose(): Promise<void> {
    if (this.closed) return
    try {
      await this.request({ op: 'dispose' })
    } catch {
      // 宿主可能在响应之前就退了；下面的 kill 兜底。
    }
    this.handleClosed()
    this.child.kill()
  }

  /** 发一条命令并等它的响应。 */
  private request(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new BridgeError('the window host channel is closed', 'BRIDGE_CLOSED'))
    const id = this.nextId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError(`window host did not answer "${String(fields['op'])}" in time`, 'BRIDGE_TIMEOUT'))
      }, this.commandTimeoutMs)
      this.pending.set(id, { resolve: value => resolve(value as Record<string, unknown>), reject, timer })
      this.socket.write(`${JSON.stringify({ ...fields, id })}\n`)
    })
  }

  /** 接上 socket 的解析与生命周期。 */
  private wire(): void {
    this.socket.setEncoding('utf8')
    let buffer = ''
    this.socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() === '') continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        this.dispatch(message)
      }
    })
    this.socket.on('error', () => { this.handleClosed() })
    this.socket.on('close', () => { this.handleClosed() })
  }

  /** 分发一条宿主消息。 */
  private dispatch(message: Record<string, unknown>): void {
    const type = message['type']
    const id = message['id']

    if (type === 'event') {
      const tabId = String(message['tabId'])
      const method = String(message['method'])
      for (const listener of [...this.listeners.get(tabId) ?? []]) listener(method, message['params'])
      return
    }

    if (type === 'closed' && typeof id !== 'number') {
      // 用户自己在标签条上点了叉：当成一条 CDP 断连事件，让上层摘掉会话。
      const tabId = String(message['tabId'])
      for (const listener of [...this.listeners.get(tabId) ?? []]) {
        listener('Inspector.detached', { reason: 'tab closed by the user' })
      }
      return
    }

    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    clearTimeout(entry.timer)

    const error = message['error']
    if (error !== undefined) {
      const detail = (error as { message?: unknown }).message
      entry.reject(new BridgeError(typeof detail === 'string' ? detail : 'window host reported an error', 'BRIDGE_COMMAND_FAILED'))
      return
    }
    entry.resolve(message)
  }

  /** 收摊：在途命令全部以断连结束，监听器各叫一次。 */
  private handleClosed(): void {
    if (this.closed) return
    this.closed = true
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new BridgeError('the window host channel closed', 'BRIDGE_CLOSED'))
    }
    this.pending.clear()
    for (const listener of [...this.closeListeners]) listener()
    this.closeListeners.clear()
    this.listeners.clear()
    try {
      this.socket.destroy()
    } catch {
      // 已经断了。
    }
  }
}

/** 从宿主 stdout 里读 `{ type: 'listening', port }`。 */
function readAnnouncedPort(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('the host never announced a port')) }, timeoutMs)
    const finish = (error?: Error, port?: number): void => {
      clearTimeout(timer)
      if (error === undefined && port !== undefined) resolve(port)
      else reject(error ?? new Error('unknown handshake failure'))
    }
    child.once('exit', (code) => { finish(new Error(`the host exited early with code ${String(code)}`)) })
    child.stdout?.setEncoding('utf8')
    let buffer = ''
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const message = JSON.parse(trimmed) as Record<string, unknown>
          if (message['type'] === 'listening' && typeof message['port'] === 'number') {
            finish(undefined, message['port'])
            return
          }
        } catch {
          // 宿主往 stdout 写了别的（理论上不该有）；忽略，继续等端口。
        }
      }
    })
  })
}
