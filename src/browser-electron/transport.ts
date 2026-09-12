/**
 * 把窗口宿主桥翻译成 `CdpTransport` —— 于是整个 `CdpBrowserProvider` 可以原样复用。
 *
 * 五个动作的映射：
 *
 * | `CdpTransport` | 窗口宿主 |
 * |---|---|
 * | `version()` | 启动宿主（顺带证明 Electron 存在） |
 * | `list()` | `{ op: 'list' }` |
 * | `newTab(url)` | `{ op: 'open', url }` |
 * | `closeTarget(id)` | `{ op: 'close', windowId }` |
 * | `connect(url)` | 该窗口的 `webContents.debugger` 通道 |
 *
 * `target.webSocketDebuggerUrl` 用自定义 scheme `electron-window://<id>`：
 * 它不是网页，也不需要端口，但它得是个稳定的「句柄」，上层拿它去 `connect()`。
 *
 * @module dsh-browser-plugin/browser-electron/transport
 */

import { CdpConnection, type CdpTarget, type CdpTransport, type CdpVersion } from '../browser-cdp/protocol.ts'
import { ElectronWindowBridge, type BridgeOptions, type WindowHostChannel } from './bridge.ts'
import { DEFAULT_BRIDGE_COMMAND_TIMEOUT_MS } from './bridge.ts'
import { WindowCdpSocket } from './socket.ts'

/** 受控窗口的句柄 scheme。 */
export const ELECTRON_WINDOW_SCHEME = 'electron-window:'

/** 由窗口 id 造一个句柄。 */
export function windowHandle(windowId: string): string {
  return `${ELECTRON_WINDOW_SCHEME}//${encodeURIComponent(windowId)}`
}

/**
 * 从句柄里取回窗口 id。
 * @param handle - `webSocketDebuggerUrl`。
 * @returns 窗口 id；句柄不合法时 `undefined`。
 */
export function windowIdFromHandle(handle: string): string | undefined {
  if (!handle.startsWith(ELECTRON_WINDOW_SCHEME)) return undefined
  const rest = handle.slice(ELECTRON_WINDOW_SCHEME.length).replace(/^\/\//u, '')
  return rest === '' ? undefined : decodeURIComponent(rest)
}

/**
 * 基于窗口宿主的传输层。
 *
 * 宿主是**按需启动**的：第一次真正用到（探测或开窗口）时才 spawn 一个 Electron，
 * 之后所有窗口共用这一个进程。启动失败会清掉缓存，允许下次重试 ——
 * 否则「第一次探测时 Electron 还没装好」会把整个 provider 永久钉死。
 */
export class ElectronWindowTransport implements CdpTransport {
  private bridge: Promise<WindowHostChannel> | undefined
  private readonly commandTimeoutMs: number
  private readonly startBridge: () => Promise<WindowHostChannel>

  /**
   * @param options - Electron 路径、宿主脚本、窗口尺寸与超时。
   * @param startBridge - 起桥的方式；默认真的 spawn Electron（单测替换掉它）。
   */
  constructor(
    options: BridgeOptions,
    startBridge?: () => Promise<WindowHostChannel>,
  ) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_BRIDGE_COMMAND_TIMEOUT_MS
    this.startBridge = startBridge ?? (() => ElectronWindowBridge.start(options))
  }

  /** @inheritdoc */
  async version(): Promise<CdpVersion> {
    await this.requireBridge()
    return {
      browser: `Electron/${process.versions['electron'] ?? 'unknown'}`,
      webSocketDebuggerUrl: windowHandle('host'),
    }
  }

  /** @inheritdoc */
  async list(): Promise<readonly CdpTarget[]> {
    const bridge = await this.requireBridge()
    const windows = await bridge.list()
    return windows.map(window => ({
      id: window.id,
      type: 'page',
      url: window.url,
      title: window.title,
      webSocketDebuggerUrl: windowHandle(window.id),
    }))
  }

  /** @inheritdoc */
  async newTab(url: string): Promise<CdpTarget> {
    const bridge = await this.requireBridge()
    const window = await bridge.open(url)
    return {
      id: window.id,
      type: 'page',
      url: window.url,
      title: window.title,
      webSocketDebuggerUrl: windowHandle(window.id),
    }
  }

  /** @inheritdoc */
  async closeTarget(targetId: string): Promise<void> {
    const bridge = await this.requireBridge()
    await bridge.closeWindow(targetId)
  }

  /** @inheritdoc */
  async connect(webSocketDebuggerUrl: string): Promise<CdpConnection> {
    const windowId = windowIdFromHandle(webSocketDebuggerUrl)
    if (windowId === undefined) {
      throw new Error(`not an Electron window handle: ${webSocketDebuggerUrl}`)
    }
    const bridge = await this.requireBridge()
    return new CdpConnection(new WindowCdpSocket(bridge, windowId), this.commandTimeoutMs)
  }

  /** 关掉宿主进程与它开的所有窗口。 */
  async dispose(): Promise<void> {
    const pending = this.bridge
    this.bridge = undefined
    if (pending === undefined) return
    const bridge = await pending.catch(() => undefined)
    await bridge?.dispose()
  }

  /** 拿桥；没起来就起来，起来了但失败了就把缓存清掉好让下次重试。 */
  private requireBridge(): Promise<WindowHostChannel> {
    this.bridge ??= this.startBridge().catch((error: unknown) => {
      this.bridge = undefined
      throw error
    })
    return this.bridge
  }
}
