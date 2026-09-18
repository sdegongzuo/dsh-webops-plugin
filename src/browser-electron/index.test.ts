/**
 * `browser-electron` 的单测：不 spawn 真的 Electron，用一个假通道顶上。
 *
 * 真机行为（窗口真的弹出来、CDP 命令真的通）由 `pnpm run smoke:window` 负责 ——
 * 单测要钉住的是「把桥翻译成 CdpTransport / CdpSocket」这一步的语义：
 * 句柄解析、事件搬运、命令往返、断连传播、以及 `available()` 的那道启用闸门。
 */

import { describe, expect, it, vi } from 'vitest'
import Module from 'node:module'
import { createRequire } from 'node:module'
import type { ChildProcess } from 'node:child_process'
import { connect, createServer, type Socket as NetSocket } from 'node:net'
import { CdpConnection } from '../browser-cdp/protocol.ts'
import { ElectronWindowBridge } from './bridge.ts'
import type { BridgeDevTools, BridgeTab, BridgeTabBar, EventListener, TabHostChannel, TakeoverListener, TabOpenedListener } from './bridge.ts'
import { resolveHostLaunch } from './bridge.ts'
import { ElectronBrowserProvider } from './provider.ts'
import { WindowCdpSocket } from './socket.ts'
import { ElectronWindowTransport, tabHandle, tabIdFromHandle } from './transport.ts'
import { resolveConfig } from './index.ts'

// host.cjs 是纯 CommonJS（在 tsc / vite 转换范围之外）且顶层依赖 electron 运行时；
// electron 包未安装也不能在纯 Node 里跑，所以用 Module._load 钩子顶掉 require('electron')，
// 只测它可独立运行的部分（地址规范化、导航指令的空态忽略）。
const fakeElectron = {
  app: { on: () => {}, whenReady: () => ({ then: () => {} }) },
  BaseWindow: class {},
  WebContentsView: class {},
  ipcMain: { on: () => {} },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
}
const nodeRequire = createRequire(import.meta.url)
const moduleWithLoad = Module as unknown as {
  _load: (request: string, parent?: unknown, isMain?: boolean) => unknown
}
const nativeLoad = moduleWithLoad._load
moduleWithLoad._load = (request, parent, isMain) =>
  request === 'electron' ? fakeElectron : nativeLoad(request, parent, isMain)
const hostModule = nodeRequire('./host.cjs') as {
  normalizeAddress: (input: unknown) => string
  handleNav: (action: string, url?: string) => void
}
moduleWithLoad._load = nativeLoad
const { normalizeAddress, handleNav } = hostModule

/** 一个可编程的假窗口宿主（一个壳窗口、多个标签页）。 */
class FakeHost implements TabHostChannel {
  readonly commands: { tabId: string; method: string; params: Record<string, unknown> }[] = []
  readonly closedTabs: string[] = []
  readonly opened: string[] = []
  readonly activated: string[] = []
  disposed = false
  isClosed = false
  /** 命令的固定结果；设成 Error 表示这条命令失败。 */
  respond: (tabId: string, method: string, params: Record<string, unknown>) => unknown = () => ({})
  private readonly eventListeners = new Map<string, Set<EventListener>>()
  private readonly takeoverListeners = new Set<TakeoverListener>()
  private readonly tabOpenedListeners = new Set<TabOpenedListener>()
  private readonly closeListeners = new Set<() => void>()

  open(url: string): Promise<BridgeTab> {
    if (this.isClosed) return Promise.reject(new Error('the window host channel closed'))
    const id = `t${String(this.opened.length + 1)}`
    this.opened.push(url)
    return Promise.resolve({ id, url, title: '', active: true })
  }

  list(): Promise<readonly BridgeTab[]> {
    if (this.isClosed) return Promise.reject(new Error('the window host channel closed'))
    const last = this.opened.length
    return Promise.resolve(this.opened.map((url, index) => ({
      id: `t${String(index + 1)}`,
      url,
      title: '',
      active: index + 1 === last,
    })))
  }

  command(tabId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ tabId, method, params })
    const result = this.respond(tabId, method, params)
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }

  /** 标签条渲染出来的 `.tab` 节点数；`-1` 表示「没有标签条」。 */
  barRendered = -1

  bar(): Promise<BridgeTabBar> {
    return Promise.resolve({
      tabs: this.opened.length,
      rendered: this.barRendered < 0 ? this.opened.length : this.barRendered,
      active: this.opened.length === 0 ? undefined : `t${String(this.opened.length)}`,
    })
  }

  activate(tabId: string): Promise<void> {
    this.activated.push(tabId)
    return Promise.resolve()
  }

  /** 每次 DevTools 切换的动作序列，供断言。 */
  readonly devToolsToggles: string[] = []
  /** 宿主回报的打开状态；`toggleDevTools` 每次翻转它。 */
  devToolsIsOpen = false

  toggleDevTools(): Promise<BridgeDevTools> {
    this.devToolsIsOpen = !this.devToolsIsOpen
    this.devToolsToggles.push(this.devToolsIsOpen ? 'opened' : 'closed')
    return Promise.resolve({
      action: this.devToolsIsOpen ? 'opened' : 'closed',
      isOpen: this.devToolsIsOpen,
      tabId: undefined,
    })
  }

  closeTab(tabId: string): Promise<void> {
    this.closedTabs.push(tabId)
    // 宿主关标签会上报 closed；桥把它翻成一次「断连」事件。
    this.emit(tabId, 'Inspector.detached', { reason: 'tab closed' })
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    this.disposed = true
    return Promise.resolve()
  }

  onEvent(tabId: string, listener: EventListener): () => void {
    const set = this.eventListeners.get(tabId) ?? new Set<EventListener>()
    set.add(listener)
    this.eventListeners.set(tabId, set)
    return () => { set.delete(listener) }
  }

  onTakeover(listener: TakeoverListener): () => void {
    this.takeoverListeners.add(listener)
    return () => { this.takeoverListeners.delete(listener) }
  }

  onTabOpened(listener: TabOpenedListener): () => void {
    this.tabOpenedListeners.add(listener)
    return () => { this.tabOpenedListeners.delete(listener) }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /** 推一条 CDP 事件给某个窗口的订阅者。 */
  emit(tabId: string, method: string, params: unknown): void {
    for (const listener of [...this.eventListeners.get(tabId) ?? []]) listener(method, params)
  }

  /** 推一条人工接管通知（宿主发的是 `{ type: 'takeover', tabId, active }`）。 */
  emitTakeover(tabId: string, active: boolean): void {
    for (const listener of [...this.takeoverListeners]) listener(tabId, active)
  }

  /** 推一条「宿主自己开的新标签」通报（宿主发的是无 command id 的 `{ type: 'opened' }`）。 */
  emitTabOpened(tabId: string, url: string, title = ''): void {
    for (const listener of [...this.tabOpenedListeners]) listener(tabId, url, title)
  }

  /** 模拟整条通道断开。 */
  breakChannel(): void {
    this.isClosed = true
    for (const listener of [...this.closeListeners]) listener()
  }
}

/** 造一个把假宿主接进来的 transport。 */
function transportFor(host: FakeHost): ElectronWindowTransport {
  return new ElectronWindowTransport(
    { electronPath: 'ignored', hostScript: 'ignored' },
    () => Promise.resolve(host),
  )
}

/** 让假宿主的 CDP 命令够 `provider.open` + `observe` 跑完：空白页 + 空 AX 树。 */
/** 编程假页面的 CDP 应答：readyState 恒 complete；每个标签的元信息按 tabId 自定义。 */
function wireFakePage(host: FakeHost, metaByTab: Record<string, { readonly url: string; readonly title: string }> = {}): void {
  host.respond = (tabId, method, params) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
    if (method === 'Runtime.evaluate') {
      const expression = String(params['expression'] ?? '')
      if (expression.includes('readyState')) return { result: { value: true } }
      const meta = metaByTab[tabId] ?? { url: 'about:blank', title: '' }
      return { result: { value: { url: meta.url, title: meta.title } } }
    }
    return {}
  }
}

describe('窗口句柄', () => {
  it('往返一致，并且带上 scheme 前缀', () => {
    expect(tabHandle('t7')).toBe('electron-tab://t7')
    expect(tabIdFromHandle('electron-tab://t7')).toBe('t7')
  })

  it('对不是本 scheme 或空的句柄返回 undefined', () => {
    expect(tabIdFromHandle('ws://127.0.0.1:9222/devtools/page/x')).toBeUndefined()
    expect(tabIdFromHandle('electron-tab://')).toBeUndefined()
  })
})

describe('ElectronWindowTransport', () => {
  it('newTab 让宿主开窗口，并把句柄写成 electron-tab:// 形式', async () => {
    const host = new FakeHost()
    const target = await transportFor(host).newTab('https://example.com/')

    expect(host.opened).toEqual(['https://example.com/'])
    expect(target).toEqual({
      id: 't1',
      type: 'page',
      url: 'https://example.com/',
      title: '',
      webSocketDebuggerUrl: 'electron-tab://t1',
    })
  })

  it('list 把宿主的窗口映射成 page target', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    await transport.newTab('https://example.com/a')
    const targets = await transport.list()

    expect(targets.map(target => target.id)).toEqual(['t1'])
    expect(targets[0]?.webSocketDebuggerUrl).toBe('electron-tab://t1')
  })

  it('宿主死后缓存失效，下一次调用重新起桥', async () => {
    const first = new FakeHost()
    const second = new FakeHost()
    let count = 0
    const transport = new ElectronWindowTransport(
      { electronPath: 'ignored', hostScript: 'ignored' },
      () => { count += 1; return Promise.resolve(count === 1 ? first : second) },
    )
    await transport.newTab('https://example.com/1')
    expect(count).toBe(1)

    first.breakChannel()
    await transport.newTab('https://example.com/2')
    expect(count).toBe(2)
    expect(second.opened).toEqual(['https://example.com/2'])
  })

  it('桥死了但 onClose 没触发时，isClosed 兜底也让下一次调用重新起桥', async () => {
    const first = new FakeHost()
    const second = new FakeHost()
    let count = 0
    const transport = new ElectronWindowTransport(
      { electronPath: 'ignored', hostScript: 'ignored' },
      () => { count += 1; return Promise.resolve(count === 1 ? first : second) },
    )
    await transport.newTab('https://example.com/1')
    // 只翻状态位、不走 breakChannel：模拟「断开发生了但订阅没赶上」。
    first.isClosed = true
    await transport.newTab('https://example.com/2')
    expect(count).toBe(2)
    expect(second.opened).toEqual(['https://example.com/2'])
  })

  describe('ElectronWindowBridge（socket 级回包解析）', () => {
    /**
     * 造一对本机 socket：server 侧可编程回包，client 侧交给真桥。
     * 回包 handler 必须在连接发生**之前**就位（传给 createServer）——
     * Node 的 'connection' 事件不排队，事后挂监听会静默丢连接。
     */
    async function socketPair(
      onConnection: (socket: NetSocket) => void,
    ): Promise<{ server: ReturnType<typeof createServer>; client: NetSocket }> {
      const server = createServer(onConnection)
      await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
      const address = server.address() as { port: number }
      const client = connect({ port: address.port, host: '127.0.0.1' })
      client.setEncoding('utf8')
      await new Promise<void>(resolve => { client.once('connect', resolve) })
      return { server, client }
    }

    /** 只会 kill 的假子进程：构造桥够用。 */
    function fakeChild(): ChildProcess {
      return { kill: () => {}, once: () => {} } as unknown as ChildProcess
    }

    async function teardown(client: NetSocket, server: ReturnType<typeof createServer>): Promise<void> {
      client.destroy()
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }

    it('宿主按命令回错误（unknown op）时命令 reject，而不是被当成功 resolve', async () => {
      const { server, client } = await socketPair((socket) => {
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) {
            if (line.trim() === '') continue
            const command = JSON.parse(line) as { id: number; op: string }
            // host.cjs 对未知 op 的真实回包形状：错误放在 message 字段，不放 error。
            socket.write(`${JSON.stringify({ type: 'error', id: command.id, message: `unknown op ${command.op}` })}\n`)
          }
        })
      })
      const bridge = ElectronWindowBridge.forTesting(fakeChild(), client, { electronPath: 'x', hostScript: 'y' })
      await expect(bridge.list()).rejects.toThrow(expect.objectContaining({
        name: 'BridgeError',
        code: 'BRIDGE_COMMAND_FAILED',
        message: expect.stringContaining('unknown op list'),
      }))
      await teardown(client, server)
    })

    it('不带 id 的宿主状态告警既不炸桥也不污染在途命令', async () => {
      const { server, client } = await socketPair((socket) => {
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) {
            if (line.trim() === '') continue
            const command = JSON.parse(line) as { id: number }
            // 先推一条无 id 的告警（render-process-gone 的真实形状），再回正常应答。
            socket.write(`${JSON.stringify({ type: 'error', tabId: 't1', message: 'renderer gone: {}' })}\n`)
            socket.write(`${JSON.stringify({ type: 'list', id: command.id, tabs: [] })}\n`)
          }
        })
      })
      const bridge = ElectronWindowBridge.forTesting(fakeChild(), client, { electronPath: 'x', hostScript: 'y' })
      await expect(bridge.list()).resolves.toEqual([])
      expect(bridge.isClosed).toBe(false)
      await teardown(client, server)
    })
  })

  it('version 报告 Electron 版本，用来证明宿主起得来', async () => {
    const host = new FakeHost()
    const version = await transportFor(host).version()

    expect(version.browser).toMatch(/^Electron\//u)
  })

  it('closeTarget 透传到宿主的关标签', async () => {
    const host = new FakeHost()
    await transportFor(host).closeTarget('t3')

    expect(host.closedTabs).toEqual(['t3'])
  })

  it('activateTarget 透传到宿主的切前台（多标签页的关键动作）', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    await transport.newTab('https://example.com/a')
    await transport.newTab('https://example.com/b')
    await transport.activateTarget('t1')

    expect(host.activated).toEqual(['t1'])
  })

  it('toggleDevTools 透传到宿主，并回报宿主的真实状态', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)

    await expect(transport.toggleDevTools()).resolves.toEqual({ action: 'opened', isOpen: true, tabId: undefined })
    await expect(transport.toggleDevTools()).resolves.toEqual({ action: 'closed', isOpen: false, tabId: undefined })
    expect(host.devToolsToggles).toEqual(['opened', 'closed'])
  })

  it('不掩盖「openDevTools 静默失败」：action 说开了、真实状态说没开', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    host.toggleDevTools = () => Promise.resolve({ action: 'opened', isOpen: false, tabId: undefined })

    // 宿主回什么就传什么 —— 抹平成「成功」就等于把静默失败这个坑盖住了。
    await expect(transport.toggleDevTools()).resolves.toEqual({ action: 'opened', isOpen: false, tabId: undefined })
  })

  it('activeTargetId 从宿主的标签条状态里取前台 id', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    await transport.newTab('https://example.com/a')
    await transport.newTab('https://example.com/b')

    await expect(transport.activeTargetId()).resolves.toBe('t2')
  })

  it('barState 透传宿主的标签条状态：持有数、渲染数、前台 id', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    await transport.newTab('https://example.com/a')
    await transport.newTab('https://example.com/b')
    const bar = await transport.barState()

    expect(bar).toEqual({ tabs: 2, rendered: 2, active: 't2' })
  })

  it('barState 能暴露「标签条没画出来」（rendered 与持有数脱钩）', async () => {
    const host = new FakeHost()
    host.barRendered = 0
    const transport = transportFor(host)
    await transport.newTab('https://example.com/a')
    const bar = await transport.barState()

    expect(bar).toEqual({ tabs: 1, rendered: 0, active: 't1' })
  })

  it('连续 newTab 开的是同一个宿主的多个标签，句柄各不相同', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    const first = await transport.newTab('https://example.com/a')
    const second = await transport.newTab('https://example.com/b')
    const targets = await transport.list()

    expect([first.id, second.id]).toEqual(['t1', 't2'])
    expect(second.webSocketDebuggerUrl).toBe('electron-tab://t2')
    expect(targets.map(target => target.id)).toEqual(['t1', 't2'])
  })

  it('connect 拒绝不是本 scheme 的句柄', async () => {
    const host = new FakeHost()
    await expect(transportFor(host).connect('ws://127.0.0.1:9222/devtools/page/x'))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('not an Electron tab handle') as unknown as string }))
  })

  it('桥起不来时不缓存失败，下一次会重试', async () => {
    let attempts = 0
    const host = new FakeHost()
    const transport = new ElectronWindowTransport(
      { electronPath: 'ignored', hostScript: 'ignored' },
      () => {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(host)
      },
    )

    await expect(transport.version()).rejects.toThrow('boom')
    await expect(transport.version()).resolves.toMatchObject({ webSocketDebuggerUrl: 'electron-tab://host' })
    expect(attempts).toBe(2)
  })

  it('dispose 会把宿主一起收掉', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    await transport.version()
    await transport.dispose()

    expect(host.disposed).toBe(true)
  })

  it('没起过桥时 dispose 是空操作', async () => {
    const host = new FakeHost()
    await expect(transportFor(host).dispose()).resolves.toBeUndefined()
    expect(host.disposed).toBe(false)
  })
})

describe('人工接管（takeover）通知通道', () => {
  it('transport 把宿主的 takeover 通知分发给订阅者，退订后不再收到', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    const seen: { tabId: string; active: boolean }[] = []
    const unsubscribe = await transport.onTakeover((tabId, active) => { seen.push({ tabId, active }) })

    host.emitTakeover('t1', true)
    host.emitTakeover('t1', false)
    unsubscribe()
    host.emitTakeover('t1', true)

    expect(seen).toEqual([{ tabId: 't1', active: true }, { tabId: 't1', active: false }])
  })

  it('provider 在 DevTools 打开时给 snapshot 带 takeover=true，且不推进 ref 纪元', async () => {
    const host = new FakeHost()
    wireFakePage(host)
    const provider = new ElectronBrowserProvider({}, transportFor(host), true)
    const session = await provider.open({})
    // 订阅是异步挂上的（transport → bridge）；等一轮宏任务，别让测试靠时序侥幸。
    await new Promise(resolve => setTimeout(resolve, 0))

    const baseline = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (baseline.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(baseline.takeover).toBeUndefined()
    expect(baseline.epoch).toBe(1)

    host.emitTakeover(session.id, true)
    const during = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (during.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(during.takeover).toBe(true)
    // 接管只加提示：纪元照常「每次 snapshot +1」，没有额外跳跃（[V31]）。
    expect(during.epoch).toBe(2)

    host.emitTakeover(session.id, false)
    const after = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (after.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(after.takeover).toBeUndefined()
    expect(after.epoch).toBe(3)
  })

  it('连开/关 DevTools 5 次，ref 纪元一次都没有被额外推进（防回归）', async () => {
    const host = new FakeHost()
    wireFakePage(host)
    const provider = new ElectronBrowserProvider({}, transportFor(host), true)
    const session = await provider.open({})
    await new Promise(resolve => setTimeout(resolve, 0))

    const epochs: number[] = []
    for (let round = 1; round <= 5; round += 1) {
      host.emitTakeover(session.id, true)
      const opened = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (opened.kind !== 'snapshot') throw new Error('expected a snapshot')
      expect(opened.takeover).toBe(true)
      epochs.push(opened.epoch)

      host.emitTakeover(session.id, false)
      const closed = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (closed.kind !== 'snapshot') throw new Error('expected a snapshot')
      expect(closed.takeover).toBeUndefined()
      epochs.push(closed.epoch)
    }

    // 10 次 snapshot → 纪元就是 1..10：人工开/关 DevTools 一次都没让它多跳。
    // 这条现在必然通过（refs.invalidate() 只由地址变化触发，与 detach 无关），
    // 它拦的是 P3 接入「观察失效」时顺手拿 Inspector.detached 推纪元的改法。
    expect(epochs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('takeover 通知不进 CDP 事件流（不会被 WindowCdpSocket 当成事件收下）', async () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 't1')
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push((event as { data: string }).data) })

    host.emitTakeover('t1', true)

    expect(messages).toHaveLength(0)
  })
})

describe('弹窗标签收编（tab opened 通报）', () => {
  it('transport 把宿主的 opened 通报分发给订阅者，退订后不再收到', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    const seen: { tabId: string; url: string; title: string }[] = []
    const unsubscribe = await transport.onTabOpened((tabId, url, title) => { seen.push({ tabId, url, title }) })

    host.emitTabOpened('t2', 'https://news.ycombinator.com/', 'Hacker News')
    unsubscribe()
    host.emitTabOpened('t3', 'https://example.com/', '')

    expect(seen).toEqual([{ tabId: 't2', url: 'https://news.ycombinator.com/', title: 'Hacker News' }])
  })

  it('provider 收编通报的新标签：tabs(list) 能列出它，url 用页面真实值', async () => {
    const host = new FakeHost()
    wireFakePage(host, { t9: { url: 'https://news.ycombinator.com/', title: 'Hacker News' } })
    const provider = new ElectronBrowserProvider({}, transportFor(host), true)
    await provider.open({})
    // 订阅是异步挂上的（transport → bridge）；等一轮宏任务，别让测试靠时序侥幸。
    await new Promise(resolve => setTimeout(resolve, 0))

    host.emitTabOpened('t9', 'https://news.ycombinator.com/', 'Hacker News')
    // 收编是异步的（连接 → enable → 等加载 → 读元信息）；轮询到出现为止。
    let listed: { sessionId: string; url: string }[] = []
    for (let i = 0; i < 50; i++) {
      const result = await provider.tabs({ kind: 'list' })
      listed = result.tabs.map(t => ({ sessionId: t.sessionId, url: t.url }))
      if (listed.some(t => t.sessionId === 't9')) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(listed).toEqual([
      { sessionId: 't1', url: 'about:blank' },
      { sessionId: 't9', url: 'https://news.ycombinator.com/' },
    ])
  })

  it('收编的会话可以直接执行工具（execute 走真实 CDP 命令）', async () => {
    const host = new FakeHost()
    wireFakePage(host)
    const provider = new ElectronBrowserProvider({}, transportFor(host), true)
    await provider.open({})
    await new Promise(resolve => setTimeout(resolve, 0))

    host.emitTabOpened('t9', 'https://news.ycombinator.com/', 'Hacker News')
    for (let i = 0; i < 50; i++) {
      const result = await provider.tabs({ kind: 'list' })
      if (result.tabs.some(t => t.sessionId === 't9')) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    // 收编后 execute 不应报「会话不存在」；命令应转发到 t9 的标签。
    const before = host.commands.filter(c => c.tabId === 't9').length
    await provider.execute({ sessionId: 't9', method: 'Runtime.evaluate', params: { expression: '1 + 1', returnByValue: true } })
    // +1 是 evaluate 本身；再 +1 是 2026-09-17 补的导航检测 —— 表达式能改地址
    // （`location.href = …`），不探一次就会报 navigated=false，让模型拿着已废的 ref 继续点。
    expect(host.commands.filter(c => c.tabId === 't9').length).toBe(before + 2)
  })
})

describe('WindowCdpSocket', () => {
  it('把 CDP 命令经桥发出去，并把结果拼成 message 事件', async () => {
    const host = new FakeHost()
    host.respond = (_tabId, method) => ({ echo: method })
    const socket = new WindowCdpSocket(host, 't1')
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push((event as { data: string }).data) })

    socket.send(JSON.stringify({ id: 1, method: 'Page.enable', params: { a: 1 } }))
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })

    expect(host.commands).toEqual([{ tabId: 't1', method: 'Page.enable', params: { a: 1 } }])
    expect(JSON.parse(messages[0] ?? '{}')).toEqual({ id: 1, result: { echo: 'Page.enable' } })
  })

  it('命令失败时回一条带 error 的响应，而不是把异常抛到别处', async () => {
    const host = new FakeHost()
    host.respond = () => new Error('no such node')
    const socket = new WindowCdpSocket(host, 't1')
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push((event as { data: string }).data) })

    socket.send(JSON.stringify({ id: 2, method: 'DOM.getBoxModel', params: {} }))
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })

    expect(JSON.parse(messages[0] ?? '{}')).toEqual({ id: 2, error: { message: 'no such node' } })
  })

  it('把宿主的 CDP 事件原样搬成 message 事件', () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 't1')
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push((event as { data: string }).data) })

    host.emit('t1', 'Page.loadEventFired', { timestamp: 1 })

    expect(JSON.parse(messages[0] ?? '{}')).toEqual({
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
    })
  })

  it('忽略解析不了或不成形的消息（不能因此炸掉整条连接）', async () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 't1')

    socket.send('{not json')
    socket.send(JSON.stringify({ method: 'Page.enable' }))
    await Promise.resolve()

    expect(host.commands).toHaveLength(0)
  })

  it('构造后异步派发 open，保证监听方先注册再收到', async () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 't1')
    const seen: string[] = []
    socket.addEventListener('open', () => { seen.push('open') })

    await vi.waitFor(() => { expect(seen).toEqual(['open']) })
  })

  it('桥断开时派发 close，并且之后不再发命令', async () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 't1')
    const seen: string[] = []
    socket.addEventListener('close', () => { seen.push('close') })

    host.breakChannel()
    socket.send(JSON.stringify({ id: 9, method: 'Page.enable', params: {} }))

    expect(seen).toEqual(['close'])
    expect(host.commands).toHaveLength(0)
  })

  it('close() 之后再派发一次是幂等的', () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 't1')
    const seen: string[] = []
    socket.addEventListener('close', () => { seen.push('close') })

    socket.close()
    socket.close()

    expect(seen).toEqual(['close'])
  })

  it('能被 CdpConnection 直接使用（这才是它存在的理由）', async () => {
    const host = new FakeHost()
    host.respond = (_tabId, method) => (method === 'Browser.getVersion' ? { product: 'Electron/44' } : {})
    const connection = new CdpConnection(new WindowCdpSocket(host, 't1'), 5_000)

    await expect(connection.send('Browser.getVersion')).resolves.toEqual({ product: 'Electron/44' })
    expect(connection.isClosed).toBe(false)

    host.breakChannel()
    expect(connection.isClosed).toBe(true)
  })
})

describe('ElectronBrowserProvider', () => {
  it('未启用时 available() 恒为 false（否则会和 cdp provider 撞车）', () => {
    const provider = new ElectronBrowserProvider({}, transportFor(new FakeHost()), false)

    expect(provider.id).toBe('electron')
    expect(provider.isEnabled).toBe(false)
    expect(provider.available()).toBe(false)
  })

  it('启用且宿主可用时 available() 为 true', () => {
    const provider = new ElectronBrowserProvider({}, transportFor(new FakeHost()), true)

    expect(provider.isEnabled).toBe(true)
    expect(provider.available()).toBe(true)
  })

  it('dispose 连宿主一起收掉（基类只关会话，宿主是本插件 spawn 的）', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    const provider = new ElectronBrowserProvider({}, transport, true)
    // 先把桥起起来：没起过桥时 `transport.dispose()` 是空操作，测不到东西。
    await transport.version()

    await provider.dispose()

    // 只关会话的话，桥上的 TCP socket 会一直活着 —— 脚本和桌面端就都退不掉。
    expect(host.disposed).toBe(true)
    expect(provider.sessionCount).toBe(0)
  })
})

describe('resolveConfig', () => {
  it('配置优先于环境变量', () => {
    const settings = resolveConfig({ enabled: true, electronPath: '/from/config' })

    expect(settings.enabled).toBe(true)
    expect(settings.electronPath).toBe('/from/config')
  })

  it('没有配置时看环境变量', () => {
    vi.stubEnv('DSH_BROWSER_PROVIDER', 'electron')
    vi.stubEnv('DSH_BROWSER_ELECTRON_PATH', '/from/env')
    try {
      const settings = resolveConfig({})
      expect(settings.enabled).toBe(true)
      expect(settings.electronPath).toBe('/from/env')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('环境变量指向别的 provider 时不启用', () => {
    vi.stubEnv('DSH_BROWSER_PROVIDER', 'cdp')
    vi.stubEnv('DSH_BROWSER_ELECTRON_PATH', '')
    try {
      const settings = resolveConfig({})
      expect(settings.enabled).toBe(false)
      expect(settings.electronPath).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('窗口尺寸有默认值', () => {
    expect(resolveConfig({}).windowSize).toEqual({ width: 1100, height: 820 })
  })

  it('打包态：没有 DSH_BROWSER_ELECTRON_PATH 时退到 shell 注入的 DSH_APP_EXECUTABLE', () => {
    vi.stubEnv('DSH_BROWSER_ELECTRON_PATH', '')
    vi.stubEnv('DSH_APP_EXECUTABLE', 'D:/pkg/app/DeepSeek Harness.exe')
    try {
      expect(resolveConfig({}).electronPath).toBe('D:/pkg/app/DeepSeek Harness.exe')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('开发态的 DSH_BROWSER_ELECTRON_PATH 优先于 DSH_APP_EXECUTABLE', () => {
    vi.stubEnv('DSH_BROWSER_ELECTRON_PATH', '/dev/electron.exe')
    vi.stubEnv('DSH_APP_EXECUTABLE', 'D:/pkg/app/DeepSeek Harness.exe')
    try {
      expect(resolveConfig({}).electronPath).toBe('/dev/electron.exe')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('appMode 默认关，可由 config 或环境变量打开，且 config 优先', () => {
    expect(resolveConfig({}).appMode).toBe(false)
    expect(resolveConfig({ appMode: true }).appMode).toBe(true)
    vi.stubEnv('DSH_BROWSER_ELECTRON_APP_MODE', '1')
    try {
      expect(resolveConfig({}).appMode).toBe(true)
      expect(resolveConfig({ appMode: false }).appMode).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('resolveHostLaunch（宿主启动参数）', () => {
  const base = { electronPath: '/electron.exe', hostScript: '/plugin/lib/browser-electron/host.cjs' }

  it('脚本模式：argv 直接带脚本路径，不设宿主变量', () => {
    const { args, environment } = resolveHostLaunch(base)

    expect(args).toEqual(['/plugin/lib/browser-electron/host.cjs'])
    expect(environment.DSH_BROWSER_ELECTRON_HOST).toBeUndefined()
  })

  it('打包应用模式：脚本路径改走环境变量，argv 只带独立 userData', () => {
    const { args, environment } = resolveHostLaunch({ ...base, appMode: true })

    expect(environment.DSH_BROWSER_ELECTRON_HOST).toBe('/plugin/lib/browser-electron/host.cjs')
    expect(args).toHaveLength(1)
    expect(args[0]).toMatch(/^--user-data-dir=/u)
  })

  it('两种模式都摘掉 ELECTRON_RUN_AS_NODE（否则宿主退化成纯 Node，开不了窗口）', () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    try {
      expect(resolveHostLaunch(base).environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(resolveHostLaunch({ ...base, appMode: true }).environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('地址栏（host.cjs 内联逻辑）', () => {
  it('navigate 规范化：trim 后不含 :// 就补 https:// 前缀，空串原样返回', () => {
    expect(normalizeAddress(' example.com ')).toBe('https://example.com')
    expect(normalizeAddress('localhost:3000/x')).toBe('https://localhost:3000/x')
    expect(normalizeAddress('https://a.b/c')).toBe('https://a.b/c')
    expect(normalizeAddress('   ')).toBe('')
  })

  it('没有活动标签时忽略导航指令', () => {
    expect(() => handleNav('navigate', 'example.com')).not.toThrow()
    expect(() => handleNav('back')).not.toThrow()
    expect(() => handleNav('forward')).not.toThrow()
    expect(() => handleNav('reload')).not.toThrow()
    expect(() => handleNav('unknown')).not.toThrow()
  })
})
