import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, { BrowserError } from './index.ts'
import type {
  BrowserCaller,
  BrowserConsoleRequest,
  BrowserExecuteRequest,
  BrowserLocateRequest,
  BrowserMutationRequest,
  BrowserNavigateRequest,
  BrowserNetworkRequest,
  BrowserObserveRequest,
  BrowserOpenRequest,
  BrowserProvider,
  BrowserRevalidateRequest,
  BrowserTabInfo,
  BrowserTabsRequest,
} from './index.ts'

const SESSION = { url: 'https://example.com/', title: 'Example', epoch: 3 }

/** 两个宿主对话 —— 多会话用例里它们共用同一个浏览器实例。 */
const ALICE: BrowserCaller = { ownerId: 'alice' }
const BOB: BrowserCaller = { ownerId: 'bob' }

/**
 * 一个会记账的 provider 桩。
 *
 * `calls` 是这套测试最要紧的一件东西：`BROWSER_TAB_NOT_HELD` 的验收判据不只是「报错」，
 * 而是「**报错之前一个页面命令都没发**」—— 拒绝必须发生在派发之前。
 */
interface StubProvider extends BrowserProvider {
  readonly calls: string[]
  readonly invalidated: string[]
  readonly sessions: Map<string, BrowserTabInfo>
}

function makeProvider(id: string, available: boolean): StubProvider {
  const calls: string[] = []
  const invalidated: string[] = []
  const sessions = new Map<string, BrowserTabInfo>()
  let sequence = 0
  const listTabs = (): readonly BrowserTabInfo[] => [...sessions.values()]
  return {
    id,
    calls,
    invalidated,
    sessions,
    available: () => available,
    open: (request: BrowserOpenRequest) => {
      const sessionId = `s${String(++sequence)}`
      const url = request.url ?? SESSION.url
      sessions.set(sessionId, { sessionId, url, title: SESSION.title })
      calls.push(`open:${sessionId}`)
      return Promise.resolve({ id: sessionId, url, title: SESSION.title, epoch: SESSION.epoch })
    },
    // `url` 现在是可选的（B2-b 起还有 `history` 这条路）；桩里回退到默认地址，
    // 好让「history 导航」这类请求也能过 `BrowserSession` 的类型。
    navigate: (request: BrowserNavigateRequest) => {
      calls.push(`navigate:${request.sessionId}`)
      const url = request.url ?? SESSION.url
      const existing = sessions.get(request.sessionId)
      if (existing !== undefined) sessions.set(request.sessionId, { ...existing, url })
      return Promise.resolve({ id: request.sessionId, url, title: SESSION.title, epoch: SESSION.epoch })
    },
    observe: (request: BrowserObserveRequest) => {
      calls.push(`observe:${request.sessionId}`)
      return Promise.resolve({
        kind: 'snapshot' as const,
        sessionId: request.sessionId,
        epoch: SESSION.epoch,
        url: SESSION.url,
        title: SESSION.title,
        outline: '',
        refs: [],
        truncated: false,
        outlineLines: 0,
      })
    },
    tabs: (request: BrowserTabsRequest) => {
      calls.push(`tabs:${request.kind}`)
      if (request.kind === 'list') return Promise.resolve({ action: 'list' as const, tabs: listTabs() })
      if (request.kind === 'close') {
        sessions.delete(request.sessionId)
        return Promise.resolve({ action: 'close' as const, sessionId: request.sessionId, tabs: listTabs() })
      }
      return Promise.resolve({ action: 'activate' as const, sessionId: request.sessionId, tabs: listTabs() })
    },
    mutate: (request: BrowserMutationRequest) => {
      calls.push(`mutate:${request.sessionId}`)
      return Promise.resolve({
        kind: 'mutation' as const,
        sessionId: 'sessionId' in request ? request.sessionId : 's1',
        action: request.kind,
        epoch: SESSION.epoch,
        url: SESSION.url,
        title: SESSION.title,
        navigated: false,
      })
    },
    invalidateSession: (sessionId: string) => {
      invalidated.push(sessionId)
    },
    close: (sessionId: string) => {
      sessions.delete(sessionId)
      return Promise.resolve()
    },
    console: (request: BrowserConsoleRequest) => {
      calls.push(`console:${request.sessionId}`)
      return Promise.resolve({
        kind: 'console' as const,
        sessionId: request.sessionId,
        entries: [],
        buffered: 0,
        truncated: false,
        replayTruncated: false,
        document: 0,
        earlierDocuments: 0,
        truncatedByBudget: false,
      })
    },
    network: (request: BrowserNetworkRequest) => {
      calls.push(`network:${request.sessionId}`)
      return Promise.resolve({
        kind: 'network' as const,
        sessionId: request.sessionId,
        action: request.kind,
        requests: [],
      })
    },
    execute: (request: BrowserExecuteRequest) => {
      calls.push(`execute:${request.sessionId}`)
      return Promise.resolve({
        kind: 'execute' as const,
        sessionId: request.sessionId,
        method: request.method,
        epoch: SESSION.epoch,
        url: SESSION.url,
        navigated: false,
        truncated: false,
      })
    },
    locate: (request: BrowserLocateRequest) => {
      calls.push(`locate:${request.sessionId}`)
      return Promise.resolve({
        kind: 'locate' as const,
        sessionId: request.sessionId,
        epoch: SESSION.epoch,
        ref: request.ref,
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        centered: request.scroll ?? false,
        scrollRequested: request.scroll ?? false,
        inViewport: true,
      })
    },
    revalidate: (request: BrowserRevalidateRequest) => {
      calls.push(`revalidate:${request.sessionId}`)
      return Promise.resolve({
        kind: 'revalidate' as const,
        sessionId: request.sessionId,
        epoch: SESSION.epoch,
        restored: request.refs.map(ref => ({ ref, role: 'button', name: 'Save' })),
        failed: [],
      })
    },
  }
}

/** 挂一个 BrowserRuntime 到全新根上下文。 */
async function mountBrowser(config: ConstructorParameters<typeof BrowserRuntime>[1] = {}): Promise<BrowserRuntime> {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntime, config)
  return ctx.browser
}

/** 挂一个 Runtime + 一个可用 provider，返回两者。 */
async function mountWithProvider(
  config: ConstructorParameters<typeof BrowserRuntime>[1] = {},
): Promise<{ browser: BrowserRuntime; provider: StubProvider }> {
  const browser = await mountBrowser(config)
  const provider = makeProvider('cdp', true)
  browser.registerProvider(provider)
  return { browser, provider }
}

/**
 * 挂一个 Runtime + provider，并拿到「收编一个弹窗」的通报口。
 *
 * 家族用例要造真实的父子关系，而 `adoptChild` 住在租约表里（私有）；唯一公开的入口就是
 * provider 的 `onSessionAdopted` 通报 —— 走它，测试才是在验接线而不是绕过接线。
 */
async function mountWithAdoptingProvider(): Promise<{
  browser: BrowserRuntime
  provider: StubProvider
  adopt: (child: string, opener: string | undefined) => void
}> {
  const browser = await mountBrowser()
  const provider = makeProvider('cdp', true)
  let notify: ((targetId: string, openerTargetId: string | undefined) => void) | undefined
  provider.onSessionAdopted = (listener) => {
    notify = listener
    return () => { notify = undefined }
  }
  browser.registerProvider(provider)
  return { browser, provider, adopt: (child, opener) => { notify?.(child, opener) } }
}

describe('BrowserRuntime provider selection', () => {
  it('复用快照失败退还占用，下一次调用仍可领取原标签', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: SESSION.url }, ALICE)
    await browser.tabs({ kind: 'release', sessionId: first.id }, ALICE)
    const observe = provider.observe
    provider.observe = async () => { throw new Error('快照失败') }
    await expect(browser.open({ url: SESSION.url }, BOB)).rejects.toThrow('快照失败')
    expect((await browser.tabs({ kind: 'list', scope: 'available' }, ALICE)).tabs).toHaveLength(1)
    provider.observe = observe
    expect((await browser.open({ url: SESSION.url }, ALICE)).id).toBe(first.id)
    await browser.dispose()
  })
  it('同网址的空闲受控标签领取复用，保留页面且不再 open 或 navigate', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({url:'https://example.com/'}, ALICE)
    await browser.tabs({kind:'release',sessionId:first.id}, ALICE)
    provider.calls.length = 0
    const reused = await browser.open({url:'https://EXAMPLE.com:443'}, BOB)
    expect(reused.id).toBe(first.id)
    expect(provider.sessions.size).toBe(1)
    expect(provider.calls).toEqual(['tabs:list','tabs:activate',`observe:${first.id}`])
    expect(() => browser.assertHeld(first.id, ALICE)).toThrow(expect.objectContaining({code:'BROWSER_TAB_NOT_HELD'}))
    expect(() => browser.assertHeld(first.id, BOB)).not.toThrow()
    await browser.dispose()
  })
  it('占用中、移交中、未登记以及网址不同的标签不复用', async () => {
    const { browser, provider } = await mountWithProvider()
    const held = await browser.open({url:SESSION.url}, ALICE)
    const second = await browser.open({url:SESSION.url}, BOB)
    expect(second.id).not.toBe(held.id)
    await browser.tabs({kind:'handoff',sessionId:held.id}, ALICE)
    await browser.tabs({kind:'release',sessionId:second.id}, BOB)
    provider.sessions.set('human',{sessionId:'human',url:'https://different.example/'})
    const different = await browser.open({url:'https://different.example/'}, ALICE)
    expect(different.id).not.toBe('human')
    expect(different.id).not.toBe(second.id)
    await browser.dispose()
  })
  it('两个会话同时打开同网址时，只有一个领取现有空闲标签', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({url:SESSION.url}, ALICE)
    await browser.tabs({kind:'release',sessionId:first.id}, ALICE)
    const opened = await Promise.all([browser.open({url:SESSION.url}, ALICE),browser.open({url:SESSION.url}, BOB)])
    expect(new Set(opened.map(tab => tab.id)).size).toBe(2)
    expect(opened.map(tab => tab.id)).toContain(first.id)
    expect(provider.sessions.size).toBe(2)
    await browser.dispose()
  })
  it('auto-selects the only usable provider and unregisters it through the returned disposer', async () => {
    const browser = await mountBrowser()
    const dispose = browser.registerProvider(makeProvider('cdp', true))

    await expect(browser.open({ url: 'https://example.com/' }, ALICE))
      .resolves.toEqual({ id: 's1', ...SESSION, url: 'https://example.com/' })

    dispose()
    await expect(browser.open({}, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
  })

  it('rejects a duplicate id', async () => {
    const browser = await mountBrowser()
    browser.registerProvider(makeProvider('cdp', true))
    expect(() => browser.registerProvider(makeProvider('cdp', true)))
      .toThrow(expect.objectContaining({ code: 'BROWSER_DUPLICATE_PROVIDER' }))
  })

  it('reports BROWSER_PROVIDER_CONFIGURED_MISSING when the pinned id is not registered', async () => {
    const browser = await mountBrowser({ provider: 'nope' })
    browser.registerProvider(makeProvider('cdp', true))
    await expect(browser.open({}, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('reports BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE when the pinned provider is down', async () => {
    const browser = await mountBrowser({ provider: 'cdp' })
    browser.registerProvider(makeProvider('cdp', false))
    await expect(browser.open({}, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('ignores unusable providers when auto-selecting', async () => {
    const browser = await mountBrowser()
    browser.registerProvider(makeProvider('down', false))
    browser.registerProvider(makeProvider('up', true))
    await expect(browser.open({}, ALICE)).resolves.toMatchObject({ id: 's1' })
  })

  it('refuses to guess when several providers are usable', async () => {
    const browser = await mountBrowser()
    browser.registerProvider(makeProvider('one', true))
    browser.registerProvider(makeProvider('two', true))
    await expect(browser.open({}, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_AMBIGUOUS' }))
  })

  it('reports BROWSER_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const browser = await mountBrowser()
    await expect(browser.open({}, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
  })

  it('resolves the provider at call time, never from registration order', async () => {
    const browser = await mountBrowser({ provider: 'two' })
    browser.registerProvider(makeProvider('one', true))
    browser.registerProvider(makeProvider('two', true))
    await expect(browser.open({}, ALICE)).resolves.toMatchObject({ id: 's1' })
  })
})

describe('BrowserRuntime forwarding', () => {
  it('forwards navigate to the selected provider', async () => {
    const { browser } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    await expect(browser.navigate({ sessionId: session.id, url: 'https://example.com/next' }, ALICE))
      .resolves.toMatchObject({ url: 'https://example.com/next' })
  })

  it('forwards tabs and mutate to the selected provider (P1)', async () => {
    const { browser } = await mountWithProvider()
    const session = await browser.open({}, ALICE)

    await expect(browser.tabs({ kind: 'list' }, ALICE)).resolves.toMatchObject({
      action: 'list',
      tabs: [expect.objectContaining({ sessionId: session.id })],
    })
    await expect(browser.mutate({ kind: 'click', sessionId: session.id, ref: 'e1' }, ALICE))
      .resolves.toMatchObject({ kind: 'mutation', action: 'click', sessionId: session.id })
    await expect(browser.tabs({ kind: 'close', sessionId: session.id }, ALICE))
      .resolves.toMatchObject({ action: 'close', sessionId: session.id, tabs: [] })
  })

  it('forwards console, network and execute to the selected provider (P2)', async () => {
    const { browser } = await mountWithProvider()
    const session = await browser.open({}, ALICE)

    await expect(browser.console({ sessionId: session.id }, ALICE))
      .resolves.toMatchObject({ kind: 'console', sessionId: session.id })
    await expect(browser.network({ kind: 'list', sessionId: session.id }, ALICE))
      .resolves.toMatchObject({ kind: 'network', action: 'list' })
    await expect(browser.execute({ sessionId: session.id, method: 'Runtime.evaluate' }, ALICE))
      .resolves.toMatchObject({ kind: 'execute', method: 'Runtime.evaluate' })
  })

  it('forwards locate to the selected provider (P3)', async () => {
    const { browser } = await mountWithProvider()
    const session = await browser.open({}, ALICE)

    await expect(browser.locate({ sessionId: session.id, ref: 'e1' }, ALICE))
      .resolves.toMatchObject({ kind: 'locate', sessionId: session.id, ref: 'e1', centered: false })
  })

  it('forwards revalidate to the selected provider', async () => {
    const { browser } = await mountWithProvider()
    const session = await browser.open({}, ALICE)

    await expect(browser.revalidate({ sessionId: session.id, refs: ['e1'] }, ALICE))
      .resolves.toMatchObject({ kind: 'revalidate', sessionId: session.id, restored: [{ ref: 'e1' }] })
  })

  it('ignores providers without a dispose hook and reports the ones that fail', async () => {
    const browser = await mountBrowser()
    browser.registerProvider(makeProvider('plain', true))
    await expect(browser.dispose()).resolves.toBeUndefined()

    browser.registerProvider({
      ...makeProvider('failing', true),
      dispose: () => Promise.reject(new Error('socket stuck')),
    })
    await expect(browser.dispose())
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_DISPOSE_FAILED' }))
  })
})

describe('BrowserRuntime tab ownership', () => {
  it('refuses a call that carries no caller identity, and never reaches the provider', async () => {
    const { browser, provider } = await mountWithProvider()
    await expect(browser.open({}, undefined))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_CALLER_REQUIRED' }))
    // 身份是硬前置：provider 一次都不该被碰到 —— 否则「没身份」这条路径会变成放行。
    expect(provider.calls).toEqual([])
  })

  it('hides another conversation\'s tab from the list and refuses every read/write on it', async () => {
    const { browser, provider } = await mountWithProvider()
    const alice = await browser.open({}, ALICE)
    await browser.open({}, BOB)

    // A 自带 t1，B 自带 t2：各自的清单里只有自己那一个。
    await expect(browser.tabs({ kind: 'list' }, ALICE)).resolves.toMatchObject({
      tabs: [expect.objectContaining({ sessionId: alice.id })],
    })
    await expect(browser.tabs({ kind: 'list' }, BOB)).resolves.toMatchObject({
      tabs: [expect.objectContaining({ sessionId: 's2' })],
    })
    // 空闲清单里什么都没有：两个标签都有主人。
    await expect(browser.tabs({ kind: 'list', scope: 'available' }, ALICE))
      .resolves.toMatchObject({ tabs: [] })

    const before = provider.calls.length
    const refused = expect.objectContaining({ code: 'BROWSER_TAB_NOT_HELD' })
    await expect(browser.observe({ kind: 'snapshot', sessionId: alice.id }, BOB)).rejects.toThrow(refused)
    await expect(browser.mutate({ kind: 'click', sessionId: alice.id, ref: 'e1' }, BOB)).rejects.toThrow(refused)
    await expect(browser.navigate({ sessionId: alice.id, url: 'https://example.com/x' }, BOB)).rejects.toThrow(refused)
    await expect(browser.console({ sessionId: alice.id }, BOB)).rejects.toThrow(refused)
    await expect(browser.execute({ sessionId: alice.id, method: 'Runtime.evaluate' }, BOB)).rejects.toThrow(refused)
    await expect(browser.locate({ sessionId: alice.id, ref: 'e1' }, BOB)).rejects.toThrow(refused)
    await expect(browser.revalidate({ sessionId: alice.id, refs: ['e1'] }, BOB)).rejects.toThrow(refused)
    await expect(browser.tabs({ kind: 'activate', sessionId: alice.id }, BOB)).rejects.toThrow(refused)
    await expect(browser.tabs({ kind: 'close', sessionId: alice.id }, BOB)).rejects.toThrow(refused)
    // 越权必须**在派发之前**被拒：provider 侧一个页面命令都没收到。
    expect(provider.calls.slice(before)).toEqual([])
  })

  it('releases a tab to idle, lets exactly one other conversation claim it, and kills the old refs', async () => {
    const { browser, provider } = await mountWithProvider()
    const alice = await browser.open({}, ALICE)

    await browser.tabs({ kind: 'release', sessionId: alice.id }, ALICE)
    // 释放要作废 ref 纪元：新主人不可能沿用上一任的 ref。
    expect(provider.invalidated).toContain(alice.id)

    await expect(browser.tabs({ kind: 'list', scope: 'available' }, BOB)).resolves.toMatchObject({
      tabs: [{ sessionId: alice.id, lease: { state: 'available' } }],
    })
    // 空闲清单**只给 id**，不泄露标题与地址。
    const idle = await browser.tabs({ kind: 'list', scope: 'available' }, BOB)
    expect(idle.tabs[0]?.url).toBeUndefined()
    expect(idle.tabs[0]?.title).toBeUndefined()

    await expect(browser.tabs({ kind: 'claim', sessionId: alice.id }, BOB)).resolves.toMatchObject({
      action: 'claim',
      sessionId: alice.id,
    })
    // 领取之后：原主人被拒，新主人可以动手。
    await expect(browser.tabs({ kind: 'list' }, ALICE)).resolves.toMatchObject({ tabs: [] })
    await expect(browser.observe({ kind: 'snapshot', sessionId: alice.id }, BOB))
      .resolves.toMatchObject({ kind: 'snapshot' })
  })

  it('refuses to claim a tab that another conversation still holds', async () => {
    const { browser } = await mountWithProvider()
    const alice = await browser.open({}, ALICE)
    await expect(browser.tabs({ kind: 'claim', sessionId: alice.id }, BOB))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TAB_OCCUPIED' }))
  })

  it('treats re-claiming your own tab as an idempotent success', async () => {
    const { browser, provider } = await mountWithProvider()
    const alice = await browser.open({}, ALICE)
    const before = provider.invalidated.length
    await expect(browser.tabs({ kind: 'claim', sessionId: alice.id }, ALICE)).resolves.toMatchObject({
      action: 'claim',
    })
    // 幂等：没有换主人，就不该再作废一次 ref 纪元。
    expect(provider.invalidated.length).toBe(before)
  })

  it('hands a tab over with a single-use code, and refuses wrong or replayed codes', async () => {
    const { browser, provider } = await mountWithProvider()
    const alice = await browser.open({}, ALICE)

    const handed = await browser.tabs({ kind: 'handoff', sessionId: alice.id }, ALICE)
    expect(typeof handed.handoffCode).toBe('string')
    const code = handed.handoffCode as string
    // 移交的那一刻发起方就失去操作权，ref 纪元当场作废。
    expect(provider.invalidated).toContain(alice.id)
    await expect(browser.observe({ kind: 'snapshot', sessionId: alice.id }, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TAB_NOT_HELD' }))

    // 错码不得消费掉这个标签。
    await expect(browser.tabs({ kind: 'claim', sessionId: alice.id, handoffCode: 'not-the-code' }, BOB))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_HANDOFF_INVALID' }))
    // 不带码也不行：移交中的标签必须凭码领取。
    await expect(browser.tabs({ kind: 'claim', sessionId: alice.id }, BOB))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_HANDOFF_INVALID' }))

    await expect(browser.tabs({ kind: 'claim', sessionId: alice.id, handoffCode: code }, BOB))
      .resolves.toMatchObject({ action: 'claim', sessionId: alice.id })
    // 领走之后这个标签归 B：A 拿着已经用掉的码也再进不来。
    // （「码只能用一次」本身在 lease.test.ts 里直接对注册表断言，这里只验端到端的主路径。）
    await expect(browser.tabs({ kind: 'claim', sessionId: alice.id, handoffCode: code }, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_HANDOFF_INVALID' }))
  })

  it('refuses to release, hand over or close a tab that still has a call in flight', async () => {
    // 用一个永不落定的 provider 调用把标签钉在「执行中」（`release` 就是这个 promise 的出口）。
    let release: (() => void) | undefined
    const stuck = new Promise<void>((resolve) => { release = resolve })
    const base = makeProvider('cdp', true)
    const browser = await mountBrowser()
    browser.registerProvider({
      ...base,
      observe: async (request) => {
        await stuck
        return base.observe(request)
      },
    })
    const held = await browser.open({}, ALICE)
    const inFlight = browser.observe({ kind: 'snapshot', sessionId: held.id }, ALICE)
    // 让出一次微任务，确保那条调用已经进到 provider 里（`activeCalls` 记上了）。
    await Promise.resolve()

    const busy = expect.objectContaining({ code: 'BROWSER_TAB_BUSY' })
    await expect(browser.tabs({ kind: 'release', sessionId: held.id }, ALICE)).rejects.toThrow(busy)
    await expect(browser.tabs({ kind: 'handoff', sessionId: held.id }, ALICE)).rejects.toThrow(busy)
    await expect(browser.tabs({ kind: 'close', sessionId: held.id }, ALICE)).rejects.toThrow(busy)

    release?.()
    await expect(inFlight).resolves.toMatchObject({ kind: 'snapshot' })
    // 执行结束之后立刻可释放 —— 「忙」是暂时的，不是坏掉的状态。
    await expect(browser.tabs({ kind: 'release', sessionId: held.id }, ALICE)).resolves.toMatchObject({
      action: 'release',
    })
  })

  it('recycles an expired lease: the page is kept, the epoch is dropped, the owner must re-claim', async () => {
    // 控制单调时钟，避免全套并行测试中「领取后隔了 1ms 就再次到期」的偶发失败。
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const { browser, provider } = await mountWithProvider({ tabLeaseIdleMs: 1_000 })
      const expired: string[] = []
      browser.onLeaseRelease((_providerId, targetId) => { expired.push(targetId) })

      const session = await browser.open({}, ALICE)
      now = 1_001
      await browser.tabs({ kind: 'list' }, ALICE)

      expect(expired).toEqual([session.id])
      // 纪元当场作废：新主人（甚至原主人自己）都不可能沿用旧 ref。
      expect(provider.invalidated).toContain(session.id)
      // 页面保留 —— 回收的是占用，不是标签。
      expect(provider.sessions.has(session.id)).toBe(true)
      await expect(browser.tabs({ kind: 'list', scope: 'available' }, ALICE))
        .resolves.toMatchObject({ tabs: [{ sessionId: session.id, lease: { state: 'available' } }] })
      await expect(browser.observe({ kind: 'snapshot', sessionId: session.id }, ALICE))
        .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TAB_NOT_HELD' }))
      // 重新领取之后又能用了（「先领取、再重拍快照」这条恢复路径）。
      await expect(browser.tabs({ kind: 'claim', sessionId: session.id }, ALICE)).resolves.toMatchObject({
        action: 'claim',
      })
      await expect(browser.observe({ kind: 'snapshot', sessionId: session.id }, ALICE))
        .resolves.toMatchObject({ kind: 'snapshot' })
      await browser.dispose()
    } finally {
      clock.mockRestore()
    }
  })

  it('activate reports only this conversation\'s tabs, not the whole controlled list', async () => {
    const { browser, provider } = await mountWithProvider()
    const alice = await browser.open({}, ALICE)
    const bob = await browser.open({}, BOB)

    // provider 的 activate 回执带的是全量受控标签（这是它的正常行为）。
    const raw = await provider.tabs({ kind: 'activate', sessionId: alice.id })
    expect(raw.tabs.map(tab => tab.sessionId).sort()).toEqual([alice.id, bob.id].sort())

    // 受控入口必须按归属过滤：A 激活自己的标签，不能顺回 B 的 id / 标题 / 地址。
    const result = await browser.tabs({ kind: 'activate', sessionId: alice.id }, ALICE)
    expect(result.action).toBe('activate')
    expect(result.sessionId).toBe(alice.id)
    expect(result.tabs.map(tab => tab.sessionId)).toEqual([alice.id])
    // 命令确实发出去了 —— 过滤不能变成「什么都不做」。
    expect(provider.calls).toContain('tabs:activate')
    // 清单复用 provider 这次回执里已经取到的全量清单，不多付一次 `list` 往返。
    expect(provider.calls.filter(call => call === 'tabs:list')).toEqual([])
  })

  it('keeps only this conversation\'s tabs in the opened_tabs receipt', async () => {
    const { browser, provider } = await mountWithProvider()
    const alice = await browser.open({}, ALICE)
    const bob = await browser.open({}, BOB)
    // provider 侧按「全局会话差集」给清单，它不认识调用方：B 的标签与人工新建的都进来了。
    provider.mutate = () => Promise.resolve({
      kind: 'mutation' as const,
      sessionId: alice.id,
      action: 'wait' as const,
      epoch: SESSION.epoch,
      url: SESSION.url,
      title: SESSION.title,
      navigated: false,
      openedTabs: [
        { sessionId: bob.id, url: 'https://bob.example/', title: 'B 的页面' },
        { sessionId: 'human-made', url: 'https://user.example/', title: '用户自己开的' },
      ],
    })

    const result = await browser.mutate({ kind: 'wait', sessionId: alice.id, timeMs: 1 }, ALICE)
    // 别人的标签、以及没有受控父（不猜 owner）的标签，都不该出现在 A 的回执里。
    expect(result.openedTabs).toBeUndefined()
  })

  it('keeps a popup of its own in the opened_tabs receipt (no over-filtering)', async () => {
    const { browser, provider, adopt } = await mountWithAdoptingProvider()
    const alice = await browser.open({}, ALICE)
    // 弹窗继承归属：这个新标签归 A，回执里必须留着（过滤不能矫枉过正）。
    provider.sessions.set('popup', { sessionId: 'popup', url: 'https://pop.example/', title: '弹窗' })
    adopt('popup', alice.id)
    provider.mutate = () => Promise.resolve({
      kind: 'mutation' as const,
      sessionId: alice.id,
      action: 'click' as const,
      epoch: SESSION.epoch,
      url: SESSION.url,
      title: SESSION.title,
      navigated: false,
      openedTabs: [{ sessionId: 'popup', url: 'https://pop.example/', title: '弹窗' }],
    })

    const result = await browser.mutate({ kind: 'click', sessionId: alice.id, ref: 'e1' }, ALICE)
    expect(result.openedTabs?.map(tab => tab.sessionId)).toEqual(['popup'])
  })

  it('invalidates every migrated tab, not just the requested one (§3.2)', async () => {
    const { browser, provider, adopt } = await mountWithAdoptingProvider()
    const parent = await browser.open({}, ALICE)
    // 挂一张弹窗子标签（走真实的收编通报，不直接摸租约表）。
    provider.sessions.set('popup', { sessionId: 'popup', url: 'https://pop.example/', title: '弹窗' })
    adopt('popup', parent.id)

    const released = await browser.tabs({ kind: 'release', sessionId: parent.id }, ALICE)
    // 释放是整族一起的，ref 作废也必须是整族：只作废父，子标签会带着 A 的旧 ref 落到 B 手里。
    expect(released.affectedSessionIds?.slice().sort()).toEqual(['popup', parent.id].sort())
    expect(provider.invalidated.slice().sort()).toEqual(['popup', parent.id].sort())

    provider.invalidated.length = 0
    const claimed = await browser.tabs({ kind: 'claim', sessionId: parent.id }, BOB)
    // 领取同样带走整个家族。
    expect(claimed.affectedSessionIds?.slice().sort()).toEqual(['popup', parent.id].sort())
    expect(provider.invalidated.slice().sort()).toEqual(['popup', parent.id].sort())
    // 子标签确实跟着换了主人。
    await expect(browser.observe({ kind: 'snapshot', sessionId: 'popup' }, BOB))
      .resolves.toMatchObject({ kind: 'snapshot' })
    await expect(browser.observe({ kind: 'snapshot', sessionId: 'popup' }, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TAB_NOT_HELD' }))
  })

  it('leaves the popup cache alone when re-claiming your own tab (idempotent)', async () => {
    const { browser, provider, adopt } = await mountWithAdoptingProvider()
    const parent = await browser.open({}, ALICE)
    provider.sessions.set('popup', { sessionId: 'popup', url: 'https://pop.example/', title: '弹窗' })
    adopt('popup', parent.id)

    const before = provider.invalidated.length
    const again = await browser.tabs({ kind: 'claim', sessionId: parent.id }, ALICE)
    // 幂等领取没有换主人 ⇒ 一个 ref 都不作废，也没有要清理的缓存。
    expect(provider.invalidated.length).toBe(before)
    expect(again.affectedSessionIds).toEqual([])
  })
})

describe('BrowserError', () => {
  it('carries the machine-readable code and keeps the cause', () => {
    const cause = new Error('underlying')
    const error = new BrowserError('something broke', 'BROWSER_PROTOCOL_ERROR', { cause })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('BrowserError')
    expect(error.code).toBe('BROWSER_PROTOCOL_ERROR')
    expect(error.cause).toBe(cause)
  })
})
