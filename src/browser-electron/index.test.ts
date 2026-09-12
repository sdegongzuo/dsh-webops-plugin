/**
 * `browser-electron` 的单测：不 spawn 真的 Electron，用一个假通道顶上。
 *
 * 真机行为（窗口真的弹出来、CDP 命令真的通）由 `pnpm run smoke:window` 负责 ——
 * 单测要钉住的是「把桥翻译成 CdpTransport / CdpSocket」这一步的语义：
 * 句柄解析、事件搬运、命令往返、断连传播、以及 `available()` 的那道启用闸门。
 */

import { describe, expect, it, vi } from 'vitest'
import { CdpConnection } from '../browser-cdp/protocol.ts'
import type { BridgeWindow, EventListener, WindowHostChannel } from './bridge.ts'
import { ElectronBrowserProvider } from './provider.ts'
import { WindowCdpSocket } from './socket.ts'
import { ElectronWindowTransport, windowHandle, windowIdFromHandle } from './transport.ts'
import { resolveConfig } from './index.ts'

/** 一个可编程的假窗口宿主。 */
class FakeHost implements WindowHostChannel {
  readonly commands: { windowId: string; method: string; params: Record<string, unknown> }[] = []
  readonly closedWindows: string[] = []
  readonly opened: string[] = []
  disposed = false
  isClosed = false
  /** 命令的固定结果；设成 Error 表示这条命令失败。 */
  respond: (method: string) => unknown = () => ({})
  private readonly eventListeners = new Map<string, Set<EventListener>>()
  private readonly closeListeners = new Set<() => void>()

  open(url: string): Promise<BridgeWindow> {
    const id = `w${String(this.opened.length + 1)}`
    this.opened.push(url)
    return Promise.resolve({ id, url, title: '' })
  }

  list(): Promise<readonly BridgeWindow[]> {
    return Promise.resolve(this.opened.map((url, index) => ({ id: `w${String(index + 1)}`, url, title: '' })))
  }

  command(windowId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ windowId, method, params })
    const result = this.respond(method)
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }

  closeWindow(windowId: string): Promise<void> {
    this.closedWindows.push(windowId)
    // 宿主关窗会上报 closed；桥把它翻成一次「断连」事件。
    this.emit(windowId, 'Inspector.detached', { reason: 'window closed' })
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    this.disposed = true
    return Promise.resolve()
  }

  onEvent(windowId: string, listener: EventListener): () => void {
    const set = this.eventListeners.get(windowId) ?? new Set<EventListener>()
    set.add(listener)
    this.eventListeners.set(windowId, set)
    return () => { set.delete(listener) }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /** 推一条 CDP 事件给某个窗口的订阅者。 */
  emit(windowId: string, method: string, params: unknown): void {
    for (const listener of [...this.eventListeners.get(windowId) ?? []]) listener(method, params)
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

describe('窗口句柄', () => {
  it('往返一致，并且带上 scheme 前缀', () => {
    expect(windowHandle('w7')).toBe('electron-window://w7')
    expect(windowIdFromHandle('electron-window://w7')).toBe('w7')
  })

  it('对不是本 scheme 或空的句柄返回 undefined', () => {
    expect(windowIdFromHandle('ws://127.0.0.1:9222/devtools/page/x')).toBeUndefined()
    expect(windowIdFromHandle('electron-window://')).toBeUndefined()
  })
})

describe('ElectronWindowTransport', () => {
  it('newTab 让宿主开窗口，并把句柄写成 electron-window:// 形式', async () => {
    const host = new FakeHost()
    const target = await transportFor(host).newTab('https://example.com/')

    expect(host.opened).toEqual(['https://example.com/'])
    expect(target).toEqual({
      id: 'w1',
      type: 'page',
      url: 'https://example.com/',
      title: '',
      webSocketDebuggerUrl: 'electron-window://w1',
    })
  })

  it('list 把宿主的窗口映射成 page target', async () => {
    const host = new FakeHost()
    const transport = transportFor(host)
    await transport.newTab('https://example.com/a')
    const targets = await transport.list()

    expect(targets.map(target => target.id)).toEqual(['w1'])
    expect(targets[0]?.webSocketDebuggerUrl).toBe('electron-window://w1')
  })

  it('version 报告 Electron 版本，用来证明宿主起得来', async () => {
    const host = new FakeHost()
    const version = await transportFor(host).version()

    expect(version.browser).toMatch(/^Electron\//u)
  })

  it('closeTarget 透传到宿主的关窗', async () => {
    const host = new FakeHost()
    await transportFor(host).closeTarget('w3')

    expect(host.closedWindows).toEqual(['w3'])
  })

  it('connect 拒绝不是本 scheme 的句柄', async () => {
    const host = new FakeHost()
    await expect(transportFor(host).connect('ws://127.0.0.1:9222/devtools/page/x'))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('not an Electron window handle') as unknown as string }))
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
    await expect(transport.version()).resolves.toMatchObject({ webSocketDebuggerUrl: 'electron-window://host' })
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

describe('WindowCdpSocket', () => {
  it('把 CDP 命令经桥发出去，并把结果拼成 message 事件', async () => {
    const host = new FakeHost()
    host.respond = method => ({ echo: method })
    const socket = new WindowCdpSocket(host, 'w1')
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push((event as { data: string }).data) })

    socket.send(JSON.stringify({ id: 1, method: 'Page.enable', params: { a: 1 } }))
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })

    expect(host.commands).toEqual([{ windowId: 'w1', method: 'Page.enable', params: { a: 1 } }])
    expect(JSON.parse(messages[0] ?? '{}')).toEqual({ id: 1, result: { echo: 'Page.enable' } })
  })

  it('命令失败时回一条带 error 的响应，而不是把异常抛到别处', async () => {
    const host = new FakeHost()
    host.respond = () => new Error('no such node')
    const socket = new WindowCdpSocket(host, 'w1')
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push((event as { data: string }).data) })

    socket.send(JSON.stringify({ id: 2, method: 'DOM.getBoxModel', params: {} }))
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })

    expect(JSON.parse(messages[0] ?? '{}')).toEqual({ id: 2, error: { message: 'no such node' } })
  })

  it('把宿主的 CDP 事件原样搬成 message 事件', () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 'w1')
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push((event as { data: string }).data) })

    host.emit('w1', 'Page.loadEventFired', { timestamp: 1 })

    expect(JSON.parse(messages[0] ?? '{}')).toEqual({
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
    })
  })

  it('忽略解析不了或不成形的消息（不能因此炸掉整条连接）', async () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 'w1')

    socket.send('{not json')
    socket.send(JSON.stringify({ method: 'Page.enable' }))
    await Promise.resolve()

    expect(host.commands).toHaveLength(0)
  })

  it('构造后异步派发 open，保证监听方先注册再收到', async () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 'w1')
    const seen: string[] = []
    socket.addEventListener('open', () => { seen.push('open') })

    await vi.waitFor(() => { expect(seen).toEqual(['open']) })
  })

  it('桥断开时派发 close，并且之后不再发命令', async () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 'w1')
    const seen: string[] = []
    socket.addEventListener('close', () => { seen.push('close') })

    host.breakChannel()
    socket.send(JSON.stringify({ id: 9, method: 'Page.enable', params: {} }))

    expect(seen).toEqual(['close'])
    expect(host.commands).toHaveLength(0)
  })

  it('close() 之后再派发一次是幂等的', () => {
    const host = new FakeHost()
    const socket = new WindowCdpSocket(host, 'w1')
    const seen: string[] = []
    socket.addEventListener('close', () => { seen.push('close') })

    socket.close()
    socket.close()

    expect(seen).toEqual(['close'])
  })

  it('能被 CdpConnection 直接使用（这才是它存在的理由）', async () => {
    const host = new FakeHost()
    host.respond = method => (method === 'Browser.getVersion' ? { product: 'Electron/44' } : {})
    const connection = new CdpConnection(new WindowCdpSocket(host, 'w1'), 5_000)

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
})
