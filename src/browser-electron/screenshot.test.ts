/** 在宿主 seam 验证原生 capturer 与 CDP 生命周期，不用假 PNG 代替裁剪实测。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./host.cjs', import.meta.url), 'utf8')
// 截图链路由两个函数组成：入口（含后台可见性调度）与捕获本体。改动任一函数的签名 /
// 依赖时，这里的正则与注入面都要跟着改 —— 它钉的正是「宿主侧截图生命周期」。
const functionSource = source.match(
  /async function captureScreenshot\(entry, params, timeout\) \{[\s\S]*?\n\}\n\n\/\*\* 前台 \/ 已临时置可见的后台标签共用的捕获本体[\s\S]*?\n\}/u,
)?.[0]
if (functionSource === undefined) throw Error('缺少宿主截图入口')
const makeCapture = new Function(
  'shell',
  'state',
  'nativeImage',
  'inputQueue',
  'tabs',
  'WRITE_BG_READ',
  `let activeTabId = state.activeTabId; ${functionSource}; return { capture: captureScreenshot, select: id => { activeTabId = id } }`,
) as (
  shell: unknown,
  state: unknown,
  nativeImage: unknown,
  inputQueue: unknown,
  tabs: Map<string, unknown>,
  WRITE_BG_READ: string,
) => { capture: (entry: unknown, params: unknown, timeout: Promise<never>) => Promise<unknown>; select: (id: string) => void }
const noTimeout = () => new Promise<never>(() => {})

describe('隐藏页面截图出帧', () => {
  it('后台页面放到最底层出帧，截图完成按用户最新选择恢复', async () => {
    let finish!: (value: unknown) => void
    const setVisible = vi.fn()
    const addChildView = vi.fn()
    const view = { setVisible, webContents: { isDestroyed: () => false, capturePage: vi.fn(async () => ({})) } }
    const sendCommand = vi.fn((method: string) => method === 'Runtime.evaluate'
      ? Promise.resolve({ result: { value: 2 } }) : new Promise(resolve => { finish = resolve }))
    const crop = vi.fn(() => ({ toPNG: () => Buffer.from('正确裁剪') }))
    const nativeImage = { createFromBuffer: vi.fn(() => ({ getSize: () => ({ width: 2000, height: 4000 }), crop })) }
    const tabs = new Map<string, unknown>()
    const { capture, select } = makeCapture(
      { contentView: { addChildView } },
      { activeTabId: '前台' },
      nativeImage,
      // 单测里没有并发：窗口写队列立即执行（真实宿主下它等输入权释放）。
      { enqueueWindowWrite: (task: () => unknown) => task() },
      tabs,
      'read',
    )
    const entry = { id: '后台', view, debugger: { sendCommand } }
    tabs.set('后台', entry)
    const pending = capture(entry, { fromSurface: true, clip: { x: 10, y: 20, width: 20, height: 10 } }, noTimeout())
    expect(addChildView).toHaveBeenCalledWith(view, 0)
    expect(setVisible).toHaveBeenCalledWith(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', { fromSurface: true, captureBeyondViewport: true })
    select('后台')
    finish({ data: Buffer.from('整页图片').toString('base64') })
    await expect(pending).resolves.toEqual({ data: Buffer.from('正确裁剪').toString('base64') })
    expect(crop).toHaveBeenCalledWith({ x: 20, y: 40, width: 40, height: 20 })
    expect(setVisible).toHaveBeenLastCalledWith(true)
  })

  it('renderer 不改可见性；surface 失败恢复后台状态并如实保留', async () => {
    const setVisible = vi.fn()
    const addChildView = vi.fn()
    const sendCommand = vi.fn(async () => { throw Error('截图失败') })
    const tabs = new Map<string, unknown>()
    const { capture } = makeCapture(
      { contentView: { addChildView } },
      { activeTabId: '前台' },
      undefined,
      { enqueueWindowWrite: (task: () => unknown) => task() },
      tabs,
      'read',
    )
    const entry = { id: '后台', view: { setVisible, webContents: { isDestroyed: () => false, capturePage: vi.fn(async () => ({})) } }, debugger: { sendCommand } }
    tabs.set('后台', entry)
    await expect(capture(entry, { fromSurface: false }, noTimeout())).rejects.toThrow('截图失败')
    expect(setVisible).not.toHaveBeenCalled()
    await expect(capture(entry, { fromSurface: true }, noTimeout())).rejects.toThrow('截图失败')
    expect(setVisible).toHaveBeenLastCalledWith(false)
  })

  it('原生命令永久挂起时仍按共同期限恢复后台可见性', async () => {
    const setVisible = vi.fn()
    const tabs = new Map<string, unknown>()
    const { capture } = makeCapture(
      { contentView: { addChildView: vi.fn() } },
      { activeTabId: '前台' },
      undefined,
      { enqueueWindowWrite: (task: () => unknown) => task() },
      tabs,
      'read',
    )
    const entry = { id: '后台', view: { setVisible, webContents: { isDestroyed: () => false, capturePage: () => new Promise(() => {}) } }, debugger: { sendCommand: vi.fn() } }
    tabs.set('后台', entry)
    let fail!: (error: Error) => void
    const timeout = new Promise<never>((_resolve, reject) => { fail = reject })
    const pending = capture(entry, { fromSurface: true }, timeout)
    fail(Error('截图超时'))
    await expect(pending).rejects.toThrow('截图超时')
    expect(setVisible).toHaveBeenLastCalledWith(false)
    expect(entry.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('排队期间标签被关掉：不动视图，直接失败', async () => {
    const setVisible = vi.fn()
    const tabs = new Map<string, unknown>()
    const { capture } = makeCapture(
      { contentView: { addChildView: vi.fn() } },
      { activeTabId: '前台' },
      undefined,
      { enqueueWindowWrite: (task: () => unknown) => task() },
      tabs,
      'read',
    )
    const entry = { id: '后台', view: { setVisible, webContents: { isDestroyed: () => false, capturePage: vi.fn(async () => ({})) } }, debugger: { sendCommand: vi.fn(async () => ({})) } }
    // 不 put：模拟「排队期间标签已关闭」。
    await expect(capture(entry, { fromSurface: true }, noTimeout())).rejects.toThrow('元素截图目标标签已关闭')
    expect(setVisible).not.toHaveBeenCalled()
  })
})
