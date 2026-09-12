/**
 * 把「一条桥上的窗口」包装成 `CdpSocket`，好让现成的 {@link CdpConnection} 直接用它。
 *
 * `CdpSocket` 是 DOM 风格（`send` / `close` / `addEventListener`），
 * 所以这里做的事就是双向搬运：socket 的 `send` 拆成一次桥命令，
 * 桥回来的结果与事件重新拼成 `{ data }` 事件派发出去。
 *
 * @module dsh-browser-plugin/browser-electron/socket
 */

import type { CdpSocket } from '../browser-cdp/protocol.ts'
import type { TabHostChannel } from './bridge.ts'

/** 支持的事件名。 */
type SocketEvent = 'open' | 'message' | 'close' | 'error'

/**
 * 一条通往受控标签页的 CDP 通道。
 *
 * 断开来源有两个，都归到 `close` 上：桥本身断了，或宿主报告该标签页被关掉。
 */
export class WindowCdpSocket implements CdpSocket {
  private readonly listeners = new Map<SocketEvent, Set<(event: unknown) => void>>()
  private readonly detachEvents: () => void
  private readonly detachClose: () => void
  private closed = false

  /**
   * @param bridge - 活着的窗口宿主通道。
   * @param tabId - 这个 socket 负责的标签页。
   */
  constructor(
    private readonly bridge: TabHostChannel,
    private readonly tabId: string,
  ) {
    this.detachEvents = bridge.onEvent(tabId, (method, params) => {
      this.emit('message', { data: JSON.stringify({ method, params }) })
    })
    this.detachClose = bridge.onClose(() => { this.shutdown() })
    // `CdpConnection` 的构造是同步的，而 `openSocket()` 会先注册监听再等 `open`；
    // 所以这里推迟到下一个微任务派发，保证「先注册、后收到」。
    queueMicrotask(() => { this.emit('open', {}) })
  }

  /** @inheritdoc */
  send(data: string): void {
    if (this.closed) return
    let message: { id?: unknown; method?: unknown; params?: unknown }
    try {
      message = JSON.parse(data) as typeof message
    } catch {
      // 解析不了的消息没法归属到任何命令；丢掉，不要因此炸掉整条连接。
      return
    }
    const { id, method } = message
    if (typeof id !== 'number' || typeof method !== 'string') return
    const params = message.params === undefined || message.params === null
      ? {}
      : message.params as Record<string, unknown>
    void this.bridge.command(this.tabId, method, params).then(
      (result) => {
        this.emit('message', { data: JSON.stringify({ id, result: result ?? {} }) })
      },
      (error: unknown) => {
        this.emit('message', {
          data: JSON.stringify({
            id,
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        })
      },
    )
  }

  /** @inheritdoc */
  close(): void {
    this.shutdown()
  }

  /** @inheritdoc */
  addEventListener(type: SocketEvent, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  /** 派发一次事件。 */
  private emit(type: SocketEvent, event: unknown): void {
    for (const listener of [...this.listeners.get(type) ?? []]) listener(event)
  }

  /** 收摊：退订桥，派发一次 `close`。 */
  private shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.detachEvents()
    this.detachClose()
    this.emit('close', {})
    this.listeners.clear()
  }
}
