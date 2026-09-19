import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { documentIdentity, sameDocumentIdentity, SELF_NAVIGATION_TTL_MS, SessionDirtyTracker } from './dirty.ts'
import type { BrowserPageChanged } from '../browser/types.ts'
import type { CdpConnection } from './protocol.ts'

/**
 * 一条只实现 `on` 的假连接 —— `SessionDirtyTracker` 一行 CDP 命令都不发，只订阅两个事件。
 * 断言的对象是**事件 → 计数**这条链，所以不需要真的协议栈。
 */
class FakeConnection {
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()

  on(method: string, listener: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set<(params: unknown) => void>()
    set.add(listener)
    this.listeners.set(method, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(method)
    }
  }

  /** 派发一条 CDP 事件。 */
  emit(method: string, params: unknown): void {
    for (const listener of [...this.listeners.get(method) ?? []]) listener(params)
  }

  /** 当前订阅总数（`dispose` 的断言用）。 */
  get subscriptionCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

/** 主 frame 真导航。 */
function hardNavigate(connection: FakeConnection, url: string): void {
  connection.emit('Page.frameNavigated', { frame: { id: 'frame-1', loaderId: 'l-2', url } })
}

/** 主 frame 软导航。 */
function softNavigate(connection: FakeConnection, url: string): void {
  connection.emit('Page.navigatedWithinDocument', { frameId: 'frame-1', url })
}

describe('documentIdentity（D-19 的判据）', () => {
  it('不含 query 与 hash，所以遥测令牌抖动改变不了文档身份', () => {
    expect(documentIdentity('https://www.google.com/search?q=a&sxsrf=AAA'))
      .toBe(documentIdentity('https://www.google.com/search?q=a&sxsrf=BBB'))
    expect(documentIdentity('https://example.com/a#one')).toBe(documentIdentity('https://example.com/a#two'))
  })

  it('path / host / scheme 任一不同就是不同的身份', () => {
    expect(sameDocumentIdentity('https://a.test/x', 'https://a.test/y')).toBe(false)
    expect(sameDocumentIdentity('https://a.test/x', 'https://b.test/x')).toBe(false)
    expect(sameDocumentIdentity('http://a.test/x', 'https://a.test/x')).toBe(false)
  })

  it('解析不出来时判「不是同一份文档」—— 保守方向必须是作废，而不是放行', () => {
    expect(documentIdentity('')).toBeUndefined()
    expect(sameDocumentIdentity('', 'https://a.test/x')).toBe(false)
    expect(sameDocumentIdentity('not a url', 'not a url')).toBe(false)
  })
})

describe('SessionDirtyTracker', () => {
  let connection: FakeConnection
  let tracker: SessionDirtyTracker

  beforeEach(() => {
    connection = new FakeConnection()
    tracker = new SessionDirtyTracker(connection as unknown as CdpConnection, 'https://start.test/')
  })

  it('干净时报告为空 —— 字段「脏时才出现」是 J3 的硬约束', () => {
    expect(tracker.report()).toBeUndefined()
  })

  it('只数主 frame 的真导航：子 frame 换文档不影响模型手上的 ref', () => {
    connection.emit('Page.frameNavigated', {
      frame: { id: 'child-1', parentId: 'frame-1', url: 'https://ad.test/frame' },
    })
    expect(tracker.report()).toBeUndefined()

    hardNavigate(connection, 'https://start.test/next')
    expect(tracker.report()).toMatchObject({ navigated: 1, withinDocument: 0 })
  })

  it('软导航单独一桶，两个桶实测不重叠（§6.3 的探针表）', () => {
    softNavigate(connection, 'https://start.test/a')
    softNavigate(connection, 'https://start.test/b')
    hardNavigate(connection, 'https://other.test/c')

    const report = tracker.report()
    expect(report).toMatchObject({ navigated: 1, withinDocument: 2 })
    // 最近一次是那个真导航，所以 route 是软导航后的地址 → 新文档。
    expect(report?.route).toEqual({ from: 'https://start.test/b', to: 'https://other.test/c' })
  })

  it('拉而不推：连读两次拿到同一份累积态，读不走计数', () => {
    hardNavigate(connection, 'https://start.test/next')
    const first = tracker.report()
    const second = tracker.report()

    expect(first).toEqual(second)
    expect(second?.navigated).toBe(1)
  })

  it('takeoverWindow 在收到过真实信号之前整条缺席 —— 「观察不到」不等于「观察到 0 次」', () => {
    hardNavigate(connection, 'https://start.test/next')
    // 直连外部 Chrome 的 provider 没有这条通道；这一格以前会被印成 0，那是给噪声加喇叭。
    expect(tracker.report()).not.toHaveProperty('takeoverWindow')

    tracker.noteTakeoverWindow()
    expect(tracker.report()).toMatchObject({ takeoverWindow: 1 })
  })

  it('自己引发的导航被赊账抵掉，不会谎报成「页面在模型之外变过」（§6.3 的去重要求）', () => {
    tracker.expectSelfNavigation()
    hardNavigate(connection, 'https://start.test/next')

    expect(tracker.report()).toBeUndefined()
    // 一次动作只抵一次：紧接着的第二次换文档是真·外部变化。
    hardNavigate(connection, 'https://start.test/next-2')
    expect(tracker.report()).toMatchObject({ navigated: 1 })
  })

  it('赊账有有效期：动作没引发导航时不会留到后面去吞一次真变化', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      tracker.expectSelfNavigation()
      vi.setSystemTime(1_000 + SELF_NAVIGATION_TTL_MS + 1)
      hardNavigate(connection, 'https://start.test/next')

      expect(tracker.report()).toMatchObject({ navigated: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reset 清计数但不清赊账 —— 建会话时迟到几毫秒的事件仍要被抵掉', () => {
    tracker.expectSelfNavigation()
    tracker.reset()
    // 这正是 open() / webpage_navigate 的形状：先记赊账、再 reset，事件的到达时刻不确定。
    hardNavigate(connection, 'https://start.test/landed')

    expect(tracker.report()).toBeUndefined()
  })

  it('reset 之后的新变化照常计数（清的是账，不是耳朵）', () => {
    hardNavigate(connection, 'https://start.test/one')
    tracker.reset()
    expect(tracker.report()).toBeUndefined()

    softNavigate(connection, 'https://start.test/two')
    expect(tracker.report()).toMatchObject({ navigated: 0, withinDocument: 1 })
  })

  it('同一个抖动地址只记一笔 —— 写前门每次动作都查，重复计数会变成「模型动了多少次」', () => {
    tracker.noteAddressDrift('https://a.test/p?x=1', 'https://a.test/p?x=2')
    tracker.noteAddressDrift('https://a.test/p?x=1', 'https://a.test/p?x=2')
    expect(tracker.report()?.addressDrift).toBe(1)

    tracker.noteAddressDrift('https://a.test/p?x=1', 'https://a.test/p?x=3')
    expect(tracker.report()?.addressDrift).toBe(2)
  })

  it('事件线报过的地址，轮询线不重复记 —— 同一次变化只进一个桶（§6.3 去重）', () => {
    // 外部软导航：事件线计数并前移游标。
    softNavigate(connection, 'https://a.test/p?x=2')
    expect(tracker.report()).toMatchObject({ withinDocument: 1 })

    // 轮询线（写前门 / `detectNavigation`）随后也读到「地址与纪元不同」——
    // 这是**同一次**变化，不许在两个桶里各记一笔。
    tracker.noteAddressDrift('https://a.test/p?x=1', 'https://a.test/p?x=2')
    expect(tracker.report()?.addressDrift).toBeUndefined()
  })

  it('自己引发的软导航被抵掉之后，轮询线也不许把它算成「外部变化」（2026-09-19 实测的归因反了）', () => {
    // 点击前记的赊账，命中随动作到达的软导航事件 → 事件线静默（§6.3 要求与 `detectNavigation` 去重）。
    tracker.expectSelfNavigation()
    softNavigate(connection, 'https://www.google.com/search?q=cat&sxsrf=BBB')

    // 修前：轮询线在这里又数一笔 `addressDrift`，回执于是宣称「页面在**本会话之外**变过」，
    // 并让模型为一次遥测抖动白付一次全量重拍（中位 ≈5500 字符）——正是 D-19 要省的那笔。
    tracker.noteAddressDrift(
      'https://www.google.com/search?q=cat&sxsrf=AAA',
      'https://www.google.com/search?q=cat&sxsrf=BBB',
    )
    expect(tracker.report()).toBeUndefined()

    // 反向验证：**事件没到**时（游标还停在旧地址），轮询线照旧是这个变化唯一的观测者。
    tracker.noteAddressDrift(
      'https://www.google.com/search?q=cat&sxsrf=AAA',
      'https://www.google.com/search?q=cat&sxsrf=CCC',
    )
    expect(tracker.report()?.addressDrift).toBe(1)
  })

  it('仅地址抖动不写簿记：文档身份没变，写「page.document 被改写」就是错的', () => {
    const seen: BrowserPageChanged[] = []
    const watched = new SessionDirtyTracker(
      connection as unknown as CdpConnection,
      'https://a.test/p',
      { onDocumentChanged: report => seen.push(report) },
    )

    watched.noteAddressDrift('https://a.test/p?x=1', 'https://a.test/p?x=2')
    expect(seen).toEqual([])

    hardNavigate(connection, 'https://a.test/other')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ navigated: 1, route: { from: 'https://a.test/p', to: 'https://a.test/other' } })
  })

  it('dispose 退订两个事件，之后的计数不再增长', () => {
    expect(connection.subscriptionCount).toBe(2)
    tracker.dispose()
    expect(connection.subscriptionCount).toBe(0)

    hardNavigate(connection, 'https://start.test/next')
    expect(tracker.report()).toBeUndefined()
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})
