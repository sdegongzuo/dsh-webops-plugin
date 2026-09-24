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
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noteLoaded } from '../debug.ts'
import { connectLoopback, loopbackCandidates } from '../loopback.ts'

/**
 * 宿主脚本路径的传递变量（打包应用模式专用）。
 *
 * 便携版没有独立的 `electron.exe`，只能用打包应用自己的主 exe 起第二个实例；
 * 而「`Exe host.cjs`」在打包应用上不成立 —— app 路径固定在 asar 里，argv 里的脚本会被忽略。
 * 所以走环境变量，由 shell 侧的早期分支接管（harness 侧的分支见
 * `docs/harness-desktop-build.patch`）。**本常量与补丁里读的变量名必须一致。**
 */
export const APP_HOST_ENV = 'DSH_BROWSER_ELECTRON_HOST'

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
  /** Electron 可执行文件路径（打包应用模式下就是桌面端主 exe 自己）。 */
  readonly electronPath: string
  /** 窗口宿主脚本（`host.cjs`）的绝对路径。 */
  readonly hostScript: string
  /**
   * 以「打包应用主 exe」的方式起宿主，而不是「`electron.exe` + 脚本路径」。
   *
   * 两者的差别不只是传参：打包应用的 app 路径固定在 asar 里，**不接受**一个脚本路径参数，
   * 所以要改成「环境变量告诉主进程去 require 哪个脚本」，并且必须给第二个实例一个
   * **独立的 `--user-data-dir`** —— 否则它会和主应用抢同一份 userData。
   */
  readonly appMode?: boolean
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

/**
 * 老宿主不宣布主机名时的默认值。
 *
 * 那一版只写 `{ type: 'listening', port }` 且固定监听 `127.0.0.1`，所以按它处理是对的；
 * 新宿主会把自己**实际**监听的名字写进 `host`（回环兜底，见 `host.cjs`）。
 */
const LEGACY_ANNOUNCED_HOST = '127.0.0.1'

/**
 * 打包应用模式下第二个实例的 `--user-data-dir`。
 *
 * 必须和主应用**分开**：共享同一份 userData 会让第二个实例撞上 profile 锁（或污染主应用的
 * 本地状态）。放系统临时目录、用固定名字即可 —— 宿主是惰性创建且单例的，
 * 不需要按 pid 再细分。
 */
function hostUserDataDir(): string {
  return join(tmpdir(), 'dsh-browser-electron-host')
}

/**
 * 组装窗口宿主的 argv 与子进程环境。
 *
 * 抽成纯函数是为了可单测 —— 这两种模式的差别（argv 还是环境变量承载脚本路径）正是
 * 便携版最容易搞错的地方，不该只靠真机试。
 *
 * @param options - 宿主启动参数。
 * @returns 交给 `spawn` 的 `args` 与 `env`。
 */
export function resolveHostLaunch(options: BridgeOptions): {
  args: string[]
  environment: NodeJS.ProcessEnv
} {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  // 宿主必须是**真的 Electron 应用**：带这个变量它会退化成纯 Node，`app` 就不存在了。
  delete environment['ELECTRON_RUN_AS_NODE']

  if (options.appMode === true) {
    // 打包应用的 app 路径固定在 asar 里，argv 里的脚本会被忽略 —— 只能靠环境变量
    // 告诉 shell 去 require 哪个脚本；argv 留给 userData 开关。
    environment[APP_HOST_ENV] = options.hostScript
    return { args: [`--user-data-dir=${hostUserDataDir()}`], environment }
  }
  return { args: [options.hostScript], environment }
}

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

/** 宿主报告的 DevTools 切换结果，见 {@link TabHostChannel.toggleDevTools}。 */
export interface BridgeDevTools {
  /** 这次动作是打开还是关闭。 */
  readonly action: 'opened' | 'closed'
  /**
   * 宿主的**真实**打开状态。
   *
   * `action: 'opened'` 却带 `isOpen: false`，就是「`openDevTools` 静默失败」——
   * 让位没成功（调试器还 attach 着）。这一条把它暴露出来，而不是回一个说谎的 ack。
   */
  readonly isOpen: boolean
  /** 被操作的标签 id；没有活动标签时 `undefined`。 */
  readonly tabId: string | undefined
}

/** 宿主事件监听器集合，按标签 id 归拢。 */
export type EventListener = (method: string, params: unknown) => void

/**
 * 人工接管通知的监听器。
 *
 * `active` 是**幂等状态位**（有人正开着 DevTools），不是计数器 —— agent 自己
 * `toggleDevTools()` 时也会收到同一条，调用方无需去重（方案 4.1.1）。
 */
export type TakeoverListener = (tabId: string, active: boolean) => void

/**
 * 一个标签页的**控制权**归属（方案 §6.5 的人工接管按钮）。
 *
 * ⚠ 与 {@link TakeoverListener} 的 `active` **不是一回事**，别合并：
 * - `takeover` 是**观测**到的信号 —— 「有人开着 DevTools」；
 * - `holder` 是**声明** —— 「人按了按钮，现在明说换我操作」。
 *
 * 宿主的簿记里两者分账、各自独立撤销。合并成一位的后果是「人在接管期间开一次
 * DevTools 又关掉」会把接管一起撤掉，于是人在操作而 agent 被放行。
 */
export type ControlHolder = 'agent' | 'human'

/** 控制权变化的监听器；`tabId` 就是 provider 的会话 id。 */
export type ControlListener = (tabId: string, holder: ControlHolder) => void

/** 宿主回报的控制权切换结果，见 {@link TabHostChannel.setControl}。 */
export interface BridgeControl {
  /** 被切换的标签 id。 */
  readonly tabId: string
  /** 切换后的持有者。 */
  readonly holder: ControlHolder
}

/**
 * 「宿主自己开了个新标签」的通报监听：页面弹窗（setWindowOpenHandler）与标签条
 * 「+」按钮开的标签不走 `open` 命令，父进程的会话注册表看不见它们 —— 宿主在
 * dom-ready 后补发 `{ type: 'opened' }`（无 command id），从这里通知上层收编。
 */
export type TabOpenedListener = (tabId: string, url: string, title: string) => void

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
  /**
   * 切换活动标签的开发者工具。
   *
   * 宿主只在「打开那一瞬」让位，随后立刻把调试器接回，所以调用返回时 CDP 通道应当
   * 仍然可用。`isOpen` 是宿主的真实回报，用来暴露 `openDevTools` 的静默失败。
   */
  toggleDevTools: () => Promise<BridgeDevTools>
  /** 关掉一个标签页。 */
  closeTab: (tabId: string) => Promise<void>
  /** 关掉宿主与它开的所有窗口。 */
  dispose: () => Promise<void>
  /** 订阅某个标签页的 CDP 事件。 */
  onEvent: (tabId: string, listener: EventListener) => () => void
  /**
   * 订阅人工接管通知（方案 4.1.1）。
   *
   * 与 `onEvent` 并列但**故意不混进 CDP 事件流** —— `{ type: 'takeover' }` 是私有编排消息，
   * 不是 CDP 方法；混进去会让「这哪来的 CDP 事件」变成下一个人要查的问题。
   */
  onTakeover: (listener: TakeoverListener) => () => void
  /**
   * 切换某个标签页的控制权（方案 §6.5）。
   *
   * 出向命令存在的主要理由是**可验证**：按钮画在另一个 `WebContentsView` 里，端到端脚本
   * 点不到它 —— 只能靠这条通道把「人按了接管」这个动作重放出来。这与 `toggleDevTools()`
   * 存在的理由同源（菜单里那条也只能靠模拟按键触发，验证不了）。
   *
   * @param tabId - 目标标签；省略时用当前前台标签。
   * @param holder - 切换到的持有者。
   */
  setControl: (tabId: string | undefined, holder: ControlHolder) => Promise<BridgeControl>
  /**
   * 订阅控制权变化（人在标签条上按了「接管」/「交还」）。
   *
   * 与 `onTakeover` 同理，**不混进 CDP 事件流** —— `{ type: 'control' }` 也是私有编排消息。
   */
  onControl: (listener: ControlListener) => () => void
  /** 订阅「宿主自己开的新标签」通报（页面弹窗 / 标签条「+」）。 */
  onTabOpened: (listener: TabOpenedListener) => () => void
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
  private readonly takeoverListeners = new Set<TakeoverListener>()
  private readonly controlListeners = new Set<ControlListener>()
  private readonly tabOpenedListeners = new Set<TabOpenedListener>()
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

    const { args, environment } = resolveHostLaunch(options)
    if (options.appMode === true) {
      noteLoaded('browser-electron', `窗口宿主以打包应用模式启动：${options.electronPath}`)
    }

    const child = spawn(options.electronPath, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    })

    // stdout / stderr 都只保留**尾部**：宿主与页面都可能整生命周期地往这两条管道刷，
    // 无界累积就是慢性内存泄漏。这里只用于启动失败时的诊断，尾部（崩溃现场就在最后）足够。
    //
    // stdout 以前不收（它由 `readAnnouncedAddress` 消费，握手成功就不需要了）。但握手**失败**时
    // 恰恰是 stdout 最有信息量：宿主自己会宣布 `host-loaded` / `host-ready`（见 host.cjs），
    // 这两行能把「卡在 shell 的模块加载」「卡在 app.whenReady()」「只是冷启动慢」分开 ——
    // 2026-09-24 CI 上整 20s 超时、stderr 一个字节都没有，只凭旧回执无从下手。
    const tails = { stdout: '', stderr: '' }
    const collect = (stream: NodeJS.ReadableStream | null, key: 'stdout' | 'stderr'): void => {
      if (stream === null) return
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        const next = tails[key] + chunk
        tails[key] = next.length > STREAM_TAIL_LIMIT ? next.slice(-STREAM_TAIL_LIMIT) : next
      })
    }
    collect(child.stdout, 'stdout')
    collect(child.stderr, 'stderr')

    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS
    const announced = await readAnnouncedAddress(child, handshakeTimeoutMs)
      .catch((error: unknown) => {
        child.kill()
        throw new BridgeError(
          `the Electron window host failed to start within ${String(handshakeTimeoutMs)}ms: `
          + `${error instanceof Error ? error.message : String(error)}${formatHostOutput(tails)}`,
          'BRIDGE_START_FAILED',
        )
      })

    // 连宿主也要有超时：connect 对「宿主进程挂着但 accept 队列满」这类情况会无限挂起。
    // 超时与失败都必须把子进程一起收掉 —— 否则起不来的宿主就成僵尸 Electron。
    //
    // 主机名按宿主宣布的来，并且**带兜底**：有的企业策略只放通 `localhost` 这个名字
    // （或反过来只认字面 IP，而机器上只剩 IPv6 回环），只试一个名字会「本机连本机也连不上」。
    const hosts = loopbackCandidates(announced.host)
    let socket: Socket
    try {
      const connected = await connectLoopback(announced.port, { hosts, timeoutMs: handshakeTimeoutMs })
      socket = connected.socket
      if (connected.host !== announced.host) {
        noteLoaded('browser-electron', `bridge: ${announced.host} 连不上，改用回环兜底 ${connected.host}`)
      }
    } catch (error: unknown) {
      child.kill()
      throw new BridgeError(
        `cannot connect to the Electron window host on port ${String(announced.port)} `
        + `(tried ${hosts.join(', ')}): ${error instanceof Error ? error.message : String(error)}${formatHostOutput(tails)}`,
        'BRIDGE_START_FAILED',
      )
    }

    const bridge = new ElectronWindowBridge(child, socket, options)
    // 宿主自己死了（崩了、被杀了）时，把它当成一次断连，别让调用方永远等下去。
    child.once('exit', () => { bridge.handleClosed() })
    return bridge
  }

  /**
   * @internal 仅供单测：用现成的 socket 造桥，不走 spawn / 握手。
   *
   * 宿主回包的解析（`dispatch`）是真出过 bug 的地方（错误回包被当成功 resolve、
   * 状态告警丢成死信），必须能不依赖真 Electron 就在 socket 级钉住。
   */
  static forTesting(child: ChildProcess, socket: Socket, options: BridgeOptions): ElectronWindowBridge {
    return new ElectronWindowBridge(child, socket, options)
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
   * 订阅人工接管通知（方案 4.1.1）。
   * @param listener - 每次收到 `{ type: 'takeover' }` 调用一次。
   * @returns 退订函数。
   */
  onTakeover(listener: TakeoverListener): () => void {
    this.takeoverListeners.add(listener)
    return () => this.takeoverListeners.delete(listener)
  }

  /**
   * 订阅控制权变化（方案 §6.5）。
   * @param listener - 每次收到 `{ type: 'control' }` 调用一次。
   * @returns 退订函数。
   */
  onControl(listener: ControlListener): () => void {
    this.controlListeners.add(listener)
    return () => this.controlListeners.delete(listener)
  }

  /** @inheritdoc */
  onTabOpened(listener: TabOpenedListener): () => void {
    this.tabOpenedListeners.add(listener)
    return () => this.tabOpenedListeners.delete(listener)
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
   * 切换活动标签的开发者工具，等宿主把状态落定后返回。
   * @returns 这次是开还是关，以及宿主的真实打开状态。
   */
  async toggleDevTools(): Promise<BridgeDevTools> {
    const response = await this.request({ op: 'devtools' })
    const isOpen = response['isOpen'] === true
    const reported = response['action']
    return {
      // 宿主没回 `action` 时**不替它猜「打开」** —— 用权威的 `isOpen` 反推。同一个类的
      // `bar()` 对未知字段一律取保守值，这里保持同一种归一风格。
      action: reported === 'opened' || reported === 'closed' ? reported : (isOpen ? 'opened' : 'closed'),
      isOpen,
      tabId: typeof response['tabId'] === 'string' ? response['tabId'] : undefined,
    }
  }

  /**
   * 切换某个标签页的控制权（方案 §6.5）。
   *
   * 宿主回的是**切换后的真实值**而不是「照单全收」：如果目标标签不存在，宿主回错误，
   * 这里就抛 —— 一个说谎的 ack 会让「我明明按了接管」变成查不出来的悬案。
   *
   * @param tabId - 目标标签；省略时由宿主取当前前台标签。
   * @param holder - 切换到的持有者。
   */
  async setControl(tabId: string | undefined, holder: ControlHolder): Promise<BridgeControl> {
    const response = await this.request({
      op: 'control',
      ...tabId === undefined ? {} : { tabId },
      holder,
    })
    return {
      tabId: typeof response['tabId'] === 'string' ? response['tabId'] : String(tabId ?? ''),
      // 宿主没回 `holder` 时**不替它猜** —— 拿请求值兜底等于把「宿主到底切没切」盖住。
      // 归一成 'agent' 是保守取法：它不谎报「人工正在持有」（与 takeover 缺字段同一种风格）。
      holder: response['holder'] === 'human' ? 'human' : 'agent',
    }
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

    if (type === 'takeover') {
      // 私有编排消息，**不进 CDP 事件流**：它既不是 `{ method, params }` 也不属于
      // 任何 CDP domain。`active` 缺失时按「没在接管」处理（保守：不谎报人工介入）。
      const tabId = String(message['tabId'])
      const active = message['active'] === true
      for (const listener of [...this.takeoverListeners]) listener(tabId, active)
      return
    }

    if (type === 'control') {
      // §6.5 控制权：与 `takeover` 并列的私有编排消息，同样**不进 CDP 事件流**。
      // `holder` 缺失或取值不认识时按 `'agent'` 处理 —— 保守方向是「不谎报人工持有」，
      // 与上面 takeover 缺 `active` 时的取法一致。
      //
      // ⚠ 这条分支靠 `type` 精确匹配，所以 `setControl` 的应答必须用另一个 type
      // （`'control-ack'`）—— 否则应答会被这里截胡，永远落不到 pending 上，命令挂死。
      const tabId = String(message['tabId'])
      const holder: ControlHolder = message['holder'] === 'human' ? 'human' : 'agent'
      for (const listener of [...this.controlListeners]) listener(tabId, holder)
      return
    }

    if (type === 'opened' && typeof id !== 'number') {
      // 宿主自己开的标签（页面弹窗 / 标签条「+」）在 dom-ready 后的通报。
      // 带 command id 的 'opened' 是 open 命令的应答，走下面的 pending 关联，别截胡。
      const tabId = String(message['tabId'])
      const url = typeof message['url'] === 'string' ? message['url'] : ''
      const title = typeof message['title'] === 'string' ? message['title'] : ''
      noteLoaded('browser-electron', `bridge: opened announcement tabId=${tabId} url=${url}`)
      for (const listener of [...this.tabOpenedListeners]) listener(tabId, url, title)
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

    if (type === 'error') {
      // 宿主报的错误（`host.cjs` 统一放在 `message` 字段，不放 `error`）：
      // 带 id 的是某条命令的失败回包，必须 reject —— 否则会落进下面的 pending
      // 成功路径被当成功 resolve（曾经的真实 bug：unknown op 静默成功）；
      // 不带 id 的是宿主状态告警（render-process-gone / debugger.attach 失败），
      // 只能记日志，但绝不能丢成死信。
      const detail = typeof message['message'] === 'string'
        ? message['message']
        : 'window host reported an error'
      if (typeof id === 'number') {
        const entry = this.pending.get(id)
        if (entry !== undefined) {
          this.pending.delete(id)
          clearTimeout(entry.timer)
          entry.reject(new BridgeError(detail, 'BRIDGE_COMMAND_FAILED'))
        }
        return
      }
      noteLoaded('browser-electron', `bridge: host error: ${detail}`)
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
    this.takeoverListeners.clear()
    this.controlListeners.clear()
    this.tabOpenedListeners.clear()
    try {
      this.socket.destroy()
    } catch {
      // 已经断了。
    }
  }
}

/** 启动诊断保留的 stdout / stderr 尾部上限（字符）。两部分各算一份。 */
const STREAM_TAIL_LIMIT = 64 * 1024

/**
 * 把宿主启动失败时的 stdout/stderr 尾部拼成回执后缀。
 *
 * 抽成纯函数是为了可单测：这条回执是「宿主起不来」**唯一**的现场证据，而它最容易
 * 退化成「什么都没说」—— 之前只收 stderr，宿主一个字节都不输出时回执就只剩
 * `never announced a port`，三种完全不同的机制（模块加载卡住 / `whenReady` 没落定 /
 * 冷启动慢）看起来一模一样。
 *
 * @param tails - 已收集的两条管道尾部。
 * @returns 以 `; ` 开头的后缀；两条都空时明说「什么都没打印」（而不是留白）。
 */
export function formatHostOutput(tails: { readonly stdout: string; readonly stderr: string }): string {
  const parts: string[] = []
  if (tails.stdout.trim() !== '') parts.push(`host stdout:\n${tails.stdout.trim()}`)
  if (tails.stderr.trim() !== '') parts.push(`host stderr:\n${tails.stderr.trim()}`)
  if (parts.length === 0) parts.push('the host printed nothing at all on stdout or stderr')
  return `; ${parts.join('; ')}`
}

/** 宿主宣布的监听地址：`{ type: 'listening', port, host? }`。 */
interface AnnouncedAddress {
  readonly port: number
  /** 宿主**实际**监听的主机名；老宿主不宣布时取 {@link LEGACY_ANNOUNCED_HOST}。 */
  readonly host: string
}

/**
 * 解析宿主 stdout 的一行握手消息（可单测：握手格式是跨进程的契约，不该只靠真机试）。
 *
 * `host` 缺失时按 {@link LEGACY_ANNOUNCED_HOST} 处理 —— 老宿主只宣布端口、且固定监听
 * `127.0.0.1`。新宿主会把它**实际**监听的回环名写出来（回环兜底，见 `host.cjs`）。
 *
 * @param line - 一行 stdout（已去掉换行）。
 * @returns 不是 listening 消息时 `undefined`（宿主可能往 stdout 写别的）。
 */
export function parseAnnouncedAddress(line: string): AnnouncedAddress | undefined {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  const port = message['port']
  if (message['type'] !== 'listening' || typeof port !== 'number') return undefined
  return {
    port,
    host: typeof message['host'] === 'string' ? message['host'] : LEGACY_ANNOUNCED_HOST,
  }
}

/** 从宿主 stdout 里读 `{ type: 'listening', port, host? }`。 */
function readAnnouncedAddress(child: ChildProcess, timeoutMs: number): Promise<AnnouncedAddress> {
  return new Promise<AnnouncedAddress>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('the host never announced a port')) }, timeoutMs)
    const finish = (error?: Error, address?: AnnouncedAddress): void => {
      clearTimeout(timer)
      if (error === undefined && address !== undefined) resolve(address)
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
        const announced = parseAnnouncedAddress(trimmed)
        if (announced !== undefined) {
          finish(undefined, announced)
          return
        }
      }
    })
  })
}
