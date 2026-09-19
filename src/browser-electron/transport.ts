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
import { ElectronWindowBridge, type BridgeControl, type BridgeDevTools, type BridgeOptions, type BridgeTabBar, type TabHostChannel } from './bridge.ts'
import type { ControlHolder, ControlListener, TakeoverListener, TabOpenedListener } from './bridge.ts'
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
   * 切换活动标签的开发者工具，等宿主把状态落定后返回。
   *
   * 宿主只在打开那一瞬让位、随后立刻把调试器接回，所以这里返回之后 agent 的 CDP
   * 通道应当仍然可用（见 `host.cjs` 的 `toggleDevTools`）。
   * @returns 这次是开还是关，以及宿主的真实打开状态。
   */
  async toggleDevTools(): Promise<BridgeDevTools> {
    const bridge = await this.requireBridge()
    return bridge.toggleDevTools()
  }

  /**
   * 订阅人工接管通知（方案 4.1.1）。
   *
   * 与其它动作一样是**按需启动**宿主的：订阅意味着「我要用这个窗口」，没必要单独造一条
   * 不需要宿主的路。`active` 是幂等状态位，`devtools-opened` / `devtools-closed` 各来一条 —
   * 人工走菜单 / 快捷键、agent 走 `toggleDevTools()`，两种来源都走这条通道。
   *
   * @param listener - 每次接管状态变化调用一次 `(tabId, active)`。
   * @returns 退订函数。
   */
  async onTakeover(listener: TakeoverListener): Promise<() => void> {
    const bridge = await this.requireBridge()
    return bridge.onTakeover(listener)
  }

  /**
   * 切换某个标签页的控制权（§6.5 人工接管按钮）。
   *
   * 与 `toggleDevTools()` 一样，这条通道存在的一半理由是**可验证**：按钮画在另一个
   * `WebContentsView` 里，端到端脚本点不到它，只能靠这里把「人按了接管」重放出来。
   *
   * @param tabId - 目标标签；省略时用宿主当前的前台标签。
   * @param holder - 切换到的持有者。
   * @returns 宿主回报的、切换**之后**的真实归属。
   */
  async setControl(tabId: string | undefined, holder: ControlHolder): Promise<BridgeControl> {
    const bridge = await this.requireBridge()
    return bridge.setControl(tabId, holder)
  }

  /**
   * 订阅控制权变化（§6.5）。与 `onTakeover` 同模式：按需启动宿主，退订函数同步返回。
   *
   * @param listener - 每次变化调用一次 `(tabId, holder)`。
   * @returns 退订函数。
   */
  async onControl(listener: ControlListener): Promise<() => void> {
    const bridge = await this.requireBridge()
    return bridge.onControl(listener)
  }

  /**
   * 订阅「宿主自己开的新标签」通报（页面弹窗 / 标签条「+」）。
   *
   * 这些标签不走 `newTab()`（没有 open 命令应答），上层会话注册表天然看不见它们；
   * 上层收到通报后收编会话，`webpage_tabs(list)` 才能列出弹窗标签。
   * 与 `onTakeover` 一样按需启动宿主。
   *
   * @param listener - 每个新标签在 dom-ready 后调用一次 `(tabId, url, title)`。
   * @returns 退订函数。
   */
  async onTabOpened(listener: TabOpenedListener): Promise<() => void> {
    const bridge = await this.requireBridge()
    return bridge.onTabOpened(listener)
  }

  /**
   * 当前前台标签 id。宿主的标签条自己维护「谁在前台」，问它要就行；
   * 这也是 electron provider 的 `webpage_tabs(list)` 能标出 `active` 的原因。
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

  /**
   * 拿桥；没起来就起来，起来了但失败了就把缓存清掉好让下次重试。
   *
   * 缓存失效有两条路：① 订阅 `onClose` —— 宿主进程死了立刻清，让下一次调用重新起桥；
   * ② 取桥时查 `isClosed` 兜底。只靠 ① 的话，「死了但订阅没赶上」的死桥会被缓存到
   * 天荒地老，之后所有动作永远 `BRIDGE_CLOSED`（曾经的真实 bug）。
   */
  private requireBridge(): Promise<TabHostChannel> {
    const cached = this.bridge
    if (cached !== undefined) {
      return cached.then(async (bridge) => {
        if (!bridge.isClosed) return bridge
        if (this.bridge === cached) this.bridge = undefined
        return this.requireBridge()
      })
    }
    const started = this.startBridge().then((bridge) => {
      bridge.onClose(() => {
        if (this.bridge === started) this.bridge = undefined
      })
      return bridge
    }, (error: unknown) => {
      if (this.bridge === started) this.bridge = undefined
      throw error
    })
    this.bridge = started
    return started
  }
}
