/**
 * 把窗口宿主桥翻译成 `CdpTransport` —— 于是整个 `CdpBrowserProvider` 可以原样复用。
 *
 * 五个动作的映射：
 *
 * | `CdpTransport` | 窗口宿主 |
 * |---|---|
 * | `version()` | 启动宿主（顺带证明 Electron 存在） |
 * | `list()` | `{ op: 'list' }` |
 * | `newTab(url)` | `{ op: 'open', url }`（**开的是标签页**，复用同一个壳窗口） |
 * | `closeTarget(id)` | `{ op: 'close', tabId }` |
 * | `connect(url)` | 该标签页的 `webContents.debugger` 通道 |
 *
 * `target.webSocketDebuggerUrl` 用自定义 scheme `electron-tab://<id>`：
 * 它不是网页，也不需要端口，但它得是个稳定的「句柄」，上层拿它去 `connect()`。
 *
 * @module dsh-webops-plugin/browser-electron/transport
 */

import { CdpConnection, type CdpTarget, type CdpTransport, type CdpVersion } from '../browser-cdp/protocol.ts'
import { ElectronWindowBridge, type BridgeOptions, type BridgeTabBar, type TabHostChannel } from './bridge.ts'
import { DEFAULT_BRIDGE_COMMAND_TIMEOUT_MS } from './bridge.ts'
import { WindowCdpSocket } from './socket.ts'

/** 受控标签页的句柄 scheme。 */
export const ELECTRON_TAB_SCHEME = 'electron-tab:'

/** 由标签 id 造一个句柄。 */
export function tabHandle(tabId: string): string {
  return `${ELECTRON_TAB_SCHEME}//${encodeURIComponent(tabId)}`
}

/**
 * 从句柄里取回标签 id。
 * @param handle - `webSocketDebuggerUrl`。
 * @returns 标签 id；句柄不合法时 `undefined`。
 */
export function tabIdFromHandle(handle: string): string | undefined {
  if (!handle.startsWith(ELECTRON_TAB_SCHEME)) return undefined
  const rest = handle.slice(ELECTRON_TAB_SCHEME.length).replace(/^\/\//u, '')
  return rest === '' ? undefined : decodeURIComponent(rest)
}

/**
 * 基于窗口宿主的传输层。
 *
 * 宿主是**按需启动**的：第一次真正用到（探测或开标签页）时才 spawn 一个 Electron，
 * 之后所有标签页共用这一个进程、同一个窗口。启动失败会清掉缓存，允许下次重试 ——
 * 否则「第一次探测时 Electron 还没装好」会把整个 provider 永久钉死。
 */
export class ElectronWindowTransport implements CdpTransport {
  private bridge: Promise<TabHostChannel> | undefined
  private readonly commandTimeoutMs: number
  private readonly keepAlive: boolean
  private readonly startBridge: () => Promise<TabHostChannel>

  /**
   * @param options - Electron 路径、宿主脚本、窗口尺寸与超时。
   * @param startBridge - 起桥的方式；默认真的 spawn Electron（单测替换掉它）。
   */
  constructor(
    options: BridgeOptions,
    startBridge?: () => Promise<TabHostChannel>,
  ) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_BRIDGE_COMMAND_TIMEOUT_MS
    this.keepAlive = options.keepAlive === true
    this.startBridge = startBridge ?? (() => ElectronWindowBridge.start(options))
  }

  /** @inheritdoc */
  async version(): Promise<CdpVersion> {
    await this.requireBridge()
    return {
      browser: `Electron/${process.versions['electron'] ?? 'unknown'}`,
      webSocketDebuggerUrl: tabHandle('host'),
    }
  }

  /** @inheritdoc */
  async list(): Promise<readonly CdpTarget[]> {
    const bridge = await this.requireBridge()
    const tabs = await bridge.list()
    return tabs.map(tab => ({
      id: tab.id,
      type: 'page',
      url: tab.url,
      title: tab.title,
      webSocketDebuggerUrl: tabHandle(tab.id),
    }))
  }

  /** @inheritdoc */
  async newTab(url: string): Promise<CdpTarget> {
    const bridge = await this.requireBridge()
    const tab = await bridge.open(url, { keepAlive: this.keepAlive })
    return {
      id: tab.id,
      type: 'page',
      url: tab.url,
      title: tab.title,
      webSocketDebuggerUrl: tabHandle(tab.id),
    }
  }

  /** @inheritdoc */
  async closeTarget(targetId: string): Promise<void> {
    const bridge = await this.requireBridge()
    await bridge.closeTab(targetId)
  }

  /**
   * 报告标签条状态（宿主自己画的那条），用于自检与诊断。
   * @returns 标签条状态。
   */
  async barState(): Promise<BridgeTabBar> {
    const bridge = await this.requireBridge()
    return bridge.bar()
  }

  /**
   * 把某个标签页切到前台。
   * @param targetId - 标签 id。
   */
  async activateTarget(targetId: string): Promise<void> {
    const bridge = await this.requireBridge()
    await bridge.activate(targetId)
  }

  /**
   * 当前前台标签 id。宿主的标签条自己维护「谁在前台」，问它要就行；
   * 这也是 electron provider 的 `browser_tabs(list)` 能标出 `active` 的原因。
   */
  async activeTargetId(): Promise<string | undefined> {
    const bridge = await this.requireBridge()
    const bar = await bridge.bar().catch(() => undefined)
    return bar?.active
  }

  /** @inheritdoc */
  async connect(webSocketDebuggerUrl: string): Promise<CdpConnection> {
    const tabId = tabIdFromHandle(webSocketDebuggerUrl)
    if (tabId === undefined) {
      throw new Error(`not an Electron tab handle: ${webSocketDebuggerUrl}`)
    }
    const bridge = await this.requireBridge()
    return new CdpConnection(new WindowCdpSocket(bridge, tabId), this.commandTimeoutMs)
  }

  /** 关掉宿主进程与它开的窗口。 */
  async dispose(): Promise<void> {
    const pending = this.bridge
    this.bridge = undefined
    if (pending === undefined) return
    const bridge = await pending.catch(() => undefined)
    await bridge?.dispose()
  }

  /** 拿桥；没起来就起来，起来了但失败了就把缓存清掉好让下次重试。 */
  private requireBridge(): Promise<TabHostChannel> {
    this.bridge ??= this.startBridge().catch((error: unknown) => {
      this.bridge = undefined
      throw error
    })
    return this.bridge
  }
}
