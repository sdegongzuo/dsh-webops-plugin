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
  readonly pendingReobserve: Set<string>
}

function makeProvider(id: string, available: boolean): StubProvider {
  const calls: string[] = []
  const invalidated: string[] = []
  const sessions = new Map<string, BrowserTabInfo>()
  const pendingReobserve = new Set<string>()
  let sequence = 0
  const listTabs = (): readonly BrowserTabInfo[] => [...sessions.values()]
  return {
    id,
    calls,
    invalidated,
    sessions,
    pendingReobserve,
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
      // 与真实 provider 一致：导航**无论成功与否**都作废既有 ref（provider.ts `navigate()`
      // 里 `session.refs.invalidate()`）。桩若省略这一步，「导航后旧 ref 失效」就没有证据。
      invalidated.push(request.sessionId)
      const url = request.url ?? SESSION.url
      const existing = sessions.get(request.sessionId)
      if (existing !== undefined) sessions.set(request.sessionId, { ...existing, url })
      return Promise.resolve({ id: request.sessionId, url, title: SESSION.title, epoch: SESSION.epoch })
    },
    observe: (request: BrowserObserveRequest) => {
      calls.push(`observe:${request.sessionId}`)
      // 地址 / 标题取自**这个会话当前的状态**，不是常量：`open` 复用路径的回执要求
      // 「url/title 是本次真的观察到的值」，桩若一律回常量，那条要求就没法被证伪。
      const known = sessions.get(request.sessionId)
      return Promise.resolve({
        kind: 'snapshot' as const,
        sessionId: request.sessionId,
        epoch: SESSION.epoch,
        url: known?.url ?? SESSION.url,
        title: known?.title ?? SESSION.title,
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
    needsReobserve: (sessionId: string) => pendingReobserve.has(sessionId),
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
  it('交还提示只包含当前 owner 持有且待重观察的 session', async () => {
    const { browser, provider } = await mountWithProvider()
    const alice = await browser.open({}, ALICE)
    const bob = await browser.open({}, BOB)
    provider.pendingReobserve.add(alice.id)
    provider.pendingReobserve.add(bob.id)

    expect(browser.reobserveRequired('alice')).toEqual([alice.id])
    expect(browser.reobserveRequired('bob')).toEqual([bob.id])
    expect(browser.reobserveRequired('unknown')).toEqual([])
  })

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
  it('open 创建后、加载取消前登记归属；取消保留页面且不把归属交给其他对话', async () => {
    const { browser, provider } = await mountWithProvider()
    const controller = new AbortController()
    provider.open = async request => {
      provider.sessions.set('early', { sessionId: 'early', ...SESSION })
      request.onCreated?.('early')
      browser.assertHeld('early', ALICE)
      controller.abort()
      throw controller.signal.reason
    }
    await expect(browser.open({}, ALICE, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    browser.assertHeld('early', ALICE)
    expect(() => browser.assertHeld('early', BOB)).toThrow(expect.objectContaining({ code: 'BROWSER_TAB_NOT_HELD' }))
    expect(provider.sessions.has('early')).toBe(true)
  })

  it('早期 created 只登记有效父的家族，不给无主弹窗猜归属', async () => {
    const browser = await mountBrowser()
    const provider = makeProvider('cdp', true)
    let created!: (target: string, opener: string) => boolean
    provider.onSessionCreated = listener => { created = listener; return () => {} }
    browser.registerProvider(provider)
    const parent = await browser.open({}, ALICE)
    expect(created('child', parent.id)).toBe(true)
    browser.assertHeld('child', ALICE)
    expect(created('orphan', 'missing')).toBe(false)
    expect(() => browser.assertHeld('orphan', ALICE)).toThrow(expect.objectContaining({ code: 'BROWSER_TAB_NOT_HELD' }))
  })
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

  it('wait performs its final snapshot through the owner-checked observe path', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    const result = await browser.mutate({ kind: 'wait', sessionId: session.id, timeMs: 1 }, ALICE)
    expect(result.snapshot).toMatchObject({ kind: 'snapshot', sessionId: session.id })
    expect(result.epoch).toBe(result.snapshot?.epoch)
    expect(provider.calls).toContain(`mutate:${session.id}`)
    expect(provider.calls).toContain(`observe:${session.id}`)

    const before = provider.calls.length
    await expect(browser.mutate({ kind: 'wait', sessionId: session.id, timeMs: 1 }, BOB))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TAB_NOT_HELD' }))
    expect(provider.calls).toHaveLength(before)
    await browser.dispose()
  })

  it('已完整观察时wait可附局部快照，保留租约并启用区域外浮层检查', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    Object.assign(provider, { hasFullObservation: () => true })
    const original = provider.observe.bind(provider)
    let received: unknown
    provider.observe = async request => { received = request; return original(request) }
    await browser.mutate({ kind: 'wait', sessionId: session.id, text: '完成', observeRef: 'e1' }, ALICE)
    expect(received).toMatchObject({ kind: 'snapshot', region: { ref: 'e1' }, guardGlobal: true })
    await browser.dispose()
  })

  it('click 附观察时默认落在被操作元素所在区块，显式区域仍然优先，首次观察仍全页', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    const original = provider.observe.bind(provider)
    const received: unknown[] = []
    provider.observe = async request => { received.push(request); return original(request) }

    // ① 纪元还不是「完整观察过」：区块观察不能替代首次全页（否则模型连页面上有什么都不知道）。
    await browser.mutate({ kind: 'click', sessionId: session.id, ref: 'e7', observe: true }, ALICE)
    expect(received[0]).toEqual({ kind: 'snapshot', sessionId: session.id })

    Object.assign(provider, { hasFullObservation: () => true })
    // ② 已完整观察过：默认落点是被操作元素所在区块。
    await browser.mutate({ kind: 'click', sessionId: session.id, ref: 'e7', observe: true }, ALICE)
    expect(received[1]).toMatchObject({ kind: 'snapshot', region: { enclosing: 'e7' }, guardGlobal: true })

    // ③ 模型点名的区域比默认区块权威。
    await browser.mutate({ kind: 'click', sessionId: session.id, ref: 'e7', observe: true, observeRef: 'e9' }, ALICE)
    expect(received[2]).toMatchObject({ kind: 'snapshot', region: { ref: 'e9' }, guardGlobal: true })

    // ④ wait 交由 provider 按可继承区域重算；无有效回复区时由 provider 默认读文档尾部。
    await browser.mutate({ kind: 'wait', sessionId: session.id, timeMs: 1 }, ALICE)
    expect(received[3]).toEqual({ kind: 'snapshot', sessionId: session.id, region: { previous: true }, guardGlobal: true })
    await browser.dispose()
  })

  it('wait 的 region_tail 显式请求映射成 tail 区域，不用动作区块冒充回复区', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    Object.assign(provider, { hasFullObservation: () => true })
    const original = provider.observe.bind(provider)
    let received: unknown
    provider.observe = async request => { received = request; return original(request) }
    await browser.mutate({
      kind: 'wait', sessionId: session.id, text: '本轮完成', observeRegion: { tail: true, tailLines: 60 },
    }, ALICE)
    expect(received).toMatchObject({
      kind: 'snapshot', region: { tail: true, tailLines: 60 }, guardGlobal: true,
    })
    await browser.dispose()
  })

  it('completion 的范围与完整性取附观察的**实际**结果，不拿请求参数冒充', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    Object.assign(provider, { hasFullObservation: () => true })
    provider.mutate = async request => ({
      kind: 'mutation', sessionId: session.id, action: 'wait', epoch: 4,
      url: SESSION.url, title: SESSION.title, navigated: false, satisfied: true,
      waitEvidence: {
        condition: 'text', conditionMet: true, completion: 'verified',
        basis: 'exclusive_text_marker', newContent: 'observed',
      },
    })
    // 请求 tail，但 provider 因新浮层强制回退成全页且截断：completion 必须如实跟随。
    const original = provider.observe.bind(provider)
    provider.observe = async request => ({
      ...await original(request), scope: 'full', truncated: true,
    })
    const result = await browser.mutate({
      kind: 'wait', sessionId: session.id, text: '本轮完成', observeRegion: { tail: true },
    }, ALICE)
    expect(result.completion).toMatchObject({
      completion: 'verified', basis: 'exclusive_text_marker',
      scope: 'full', truncated: true, outlineComplete: false, textComplete: false,
    })
    await browser.dispose()
  })

  it.each(['first', 'handback', 'navigation'] as const)('%s等待必须返回全页，不能以局部观察绕过完整门禁', async mode => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    Object.assign(provider, { hasFullObservation: () => mode !== 'first', needsReobserve: () => mode === 'handback' })
    const mutate = provider.mutate.bind(provider)
    provider.mutate = async request => ({ ...await mutate(request), navigated: mode === 'navigation' })
    const observe = provider.observe.bind(provider)
    let received: unknown
    provider.observe = async request => { received = request; return observe(request) }
    await browser.mutate({ kind: 'wait', sessionId: session.id, text: '完成', observeRef: 'e1' }, ALICE)
    expect(received).toEqual({ kind: 'snapshot', sessionId: session.id })
    await browser.mutate({ kind: 'wait', sessionId: session.id, text: '完成' }, ALICE)
    expect(received).toEqual({ kind: 'snapshot', sessionId: session.id })
    await browser.dispose()
  })

  it('click wait_text reuses the same lease and queue, then returns one current snapshot', async () => {
    const { browser, provider, adopt } = await mountWithAdoptingProvider()
    const session = await browser.open({}, ALICE)
    provider.sessions.set('popup', { sessionId: 'popup', url: 'https://pop.example/', title: '弹窗' })
    adopt('popup', session.id)

    const calls: string[] = []
    const originalObserve = provider.observe
    const signalForAction = new AbortController().signal
    let finishWait!: () => void
    let startedWait!: () => void
    const waitStarted = new Promise<void>(resolve => { startedWait = resolve })
    const waitPending = new Promise<void>(resolve => { finishWait = resolve })
    provider.mutate = async (request, signal) => {
      calls.push(request.kind)
      if (request.kind === 'wait') {
        expect(request.text).toBe('Saved')
        expect(signal).toBe(signalForAction)
        startedWait()
        await waitPending
        return {
          kind: 'mutation', sessionId: session.id, action: 'wait', epoch: 4,
          url: SESSION.url, title: SESSION.title, navigated: false, satisfied: false,
          pageChanged: { navigated: 0, withinDocument: 0, addressDrift: 1 },
          openedTabs: [{ sessionId: 'popup', url: 'https://pop.example/', title: '弹窗' }],
        }
      }
      return {
        kind: 'mutation', sessionId: session.id, action: 'click', epoch: 4,
        url: SESSION.url, title: SESSION.title, navigated: false,
        pageChanged: { navigated: 0, withinDocument: 1 },
        openedTabs: [{ sessionId: 'popup', url: 'https://pop.example/', title: '弹窗' }],
      }
    }
    provider.observe = async request => {
      calls.push(`observe:${request.kind}`)
      return { ...await originalObserve(request), epoch: 10 }
    }
    const action = browser.mutate({ kind: 'click', sessionId: session.id, ref: 'e1', waitText: 'Saved' }, ALICE, signalForAction)
    await waitStarted
    const queued = browser.observe({ kind: 'snapshot', sessionId: session.id }, ALICE)
    await Promise.resolve()
    expect(calls).toEqual(['click', 'wait'])
    finishWait()
    const result = await action
    await queued

    expect(calls).toEqual(['click', 'wait', 'observe:snapshot', 'observe:snapshot'])
    expect(result).toMatchObject({ action: 'click', satisfied: false, epoch: 10, snapshot: { epoch: 10 } })
    expect(result.openedTabs?.map(tab => tab.sessionId)).toEqual(['popup'])
    expect(result.pageChanged).toMatchObject({ withinDocument: 1, addressDrift: 1 })
    await browser.dispose()
  })

  it('does not append a snapshot or recovery when the post-action text wait fails', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    let calls = 0
    provider.mutate = async request => {
      calls += 1
      if (request.kind === 'wait') throw new BrowserError('human took over', 'BROWSER_HUMAN_HOLDING')
      return { kind: 'mutation', sessionId: session.id, action: 'press', epoch: 4, url: SESSION.url, title: SESSION.title, navigated: false }
    }
    provider.observe = vi.fn(async () => { throw new Error('must not observe after wait failure') })

    const result = await browser.mutate({ kind: 'press', sessionId: session.id, ref: 'e1', key: 'Enter', waitText: 'Saved' }, ALICE)
    expect(calls).toBe(2)
    expect(provider.observe).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      action: 'press', actionDispatched: true,
      observationError: { code: 'BROWSER_HUMAN_HOLDING', message: 'human took over' },
    })
    expect(result.snapshot).toBeUndefined()
    // 等待失败同样是「证据不足」：必须显式报 completion=unverified，不能让字段缺席。
    expect(result.completion).toMatchObject({
      condition: 'text', conditionMet: false, completion: 'unverified', basis: 'wait_failed',
      newContent: 'unknown', outlineComplete: false, textComplete: false,
      scope: 'unobserved', truncated: true,
    })
    await browser.dispose()
  })

  it('keeps the wait result URL when navigation succeeds but its snapshot fails', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    provider.mutate = async request => request.kind === 'wait'
      ? {
          kind: 'mutation', sessionId: session.id, action: 'wait', epoch: 8,
          url: 'https://example.com/after-submit', title: 'Submitted', navigated: true,
          satisfied: false,
        }
      : {
          kind: 'mutation', sessionId: session.id, action: 'click', epoch: 4,
          url: SESSION.url, title: SESSION.title, navigated: false,
        }
    provider.observe = vi.fn(async () => { throw new BrowserError('CDP disconnected', 'BROWSER_CONNECTION_LOST') })

    const result = await browser.mutate({ kind: 'click', sessionId: session.id, ref: 'e1', waitText: 'Submitted' }, ALICE)
    expect(result).toMatchObject({
      action: 'click', epoch: 8, url: 'https://example.com/after-submit', title: 'Submitted',
      navigated: true, satisfied: false, actionDispatched: true,
      observationError: { code: 'BROWSER_CONNECTION_LOST', message: 'CDP disconnected' },
    })
    expect(provider.observe).toHaveBeenCalledTimes(1)
    await browser.dispose()
  })

  it('显式 observe 返回新观察，且只派发一次点击而不额外等待', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    const result = await browser.mutate({ kind: 'click', sessionId: session.id, ref: 'e1', observe: true }, ALICE)
    expect(result.snapshot).toMatchObject({ kind: 'snapshot', sessionId: session.id })
    expect(result.epoch).toBe(result.snapshot?.epoch)
    expect(provider.calls.filter(call => call === `mutate:${session.id}`)).toHaveLength(1)
    expect(provider.calls.filter(call => call === `observe:${session.id}`)).toHaveLength(1)
    await browser.dispose()
  })

  it('observe=true 配 timeout_ms 时先等页面安静（until=stable）再观察，仍然只派发一次点击', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    let mutations = 0
    provider.mutate = async request => {
      mutations += 1
      return request.kind === 'wait'
        ? { kind: 'mutation', sessionId: session.id, action: 'wait', epoch: 6, url: SESSION.url, title: SESSION.title, navigated: false, satisfied: true,
          signals: { readyState: 'complete', dom: 'quiet', network: 'quiet' } }
        : { kind: 'mutation', sessionId: session.id, action: 'click', epoch: 4, url: SESSION.url, title: SESSION.title, navigated: false }
    }
    const result = await browser.mutate({ kind: 'click', sessionId: session.id, ref: 'e1', observe: true, timeoutMs: 200 }, ALICE)
    expect(mutations).toBe(2)
    expect(result).toMatchObject({ action: 'click', satisfied: true, epoch: result.snapshot?.epoch })
    expect(result.signals).toEqual({ readyState: 'complete', dom: 'quiet', network: 'quiet' })
    expect(result.snapshot).toMatchObject({ kind: 'snapshot', sessionId: session.id })
    expect(provider.calls.filter(call => call === `observe:${session.id}`)).toHaveLength(1)
    await browser.dispose()
  })

  it('keeps default click behavior free of post-action observations', async () => {
    const { browser, provider } = await mountWithProvider()
    const session = await browser.open({}, ALICE)
    const result = await browser.mutate({ kind: 'click', sessionId: session.id, ref: 'e1' }, ALICE)
    expect(result.snapshot).toBeUndefined()
    expect(provider.calls.filter(call => call === `mutate:${session.id}`)).toHaveLength(1)
    expect(provider.calls.filter(call => call === `observe:${session.id}`)).toHaveLength(0)
    await browser.dispose()
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

describe('失败恢复与同标签互斥', () => {
  it('旧 ref 失败仍抛原错误，附带新快照且不重新派发动作', async () => {
    const browser = await mountBrowser()
    const provider = makeProvider('cdp', true)
    const error = new BrowserError('旧 ref', 'BROWSER_STALE_REF', { dispatchState: 'not_dispatched' })
    provider.refRecoveryState = () => 1
    provider.mutate = vi.fn(async () => { throw error })
    browser.registerProvider(provider)
    const session = await browser.open({}, ALICE)
    await expect(browser.mutate({ kind: 'click', sessionId: session.id, ref: 'old' }, ALICE))
      .rejects.toBe(error)
    expect(error.recoverySnapshot).toMatchObject({ kind: 'snapshot', sessionId: session.id })
    expect(provider.mutate).toHaveBeenCalledTimes(1)
    expect(provider.calls.filter(call => call.startsWith('observe:'))).toHaveLength(1)
  })

  it('恢复观察期间同标签排队，完成后执行候补读取', async () => {
    const browser = await mountBrowser()
    const provider = makeProvider('cdp', true)
    provider.refRecoveryState = () => 1
    provider.mutate = async () => { throw new BrowserError('旧 ref', 'BROWSER_STALE_REF', { dispatchState: 'not_dispatched' }) }
    const observe = provider.observe
    let finish!: () => void
    let started!: () => void
    const observing = new Promise<void>(resolve => { started = resolve })
    const waiting = new Promise<void>(resolve => { finish = resolve })
    provider.observe = vi.fn(async (request) => { started(); await waiting; return observe(request) })
    browser.registerProvider(provider)
    const session = await browser.open({}, ALICE)
    const failed = browser.mutate({ kind: 'click', sessionId: session.id, ref: 'old' }, ALICE)
    const assertion = expect(failed).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
    await observing
    const queued = browser.observe({ kind: 'snapshot', sessionId: session.id }, ALICE)
    await Promise.resolve()
    expect(provider.observe).toHaveBeenCalledTimes(1)
    finish()
    await assertion
    await expect(queued).resolves.toMatchObject({ kind: 'snapshot' })
  })
})

/**
 * 档 2「复用本对话已有标签」的用例组。
 *
 * 这一组反复断言的是**同一件事的三个侧面**：落点是不是同一个 session_id、标签数有没有
 * 增加、ref 纪元有没有真的被作废。只断言第一个会让「复用」与「新建一张恰好同 id 的标签」
 * 混在一起；只断言第二个会漏掉「页面被导航走了但模型手里的 ref 还能用」。
 */
describe('open 复用本对话已有标签（档 2）', () => {
  it('已持有 A 时 open(B)：同一个 session_id、不新建标签、旧 ref 作废', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    provider.invalidated.length = 0
    provider.calls.length = 0

    const second = await browser.open({ url: 'https://example.com/b' }, ALICE)

    // ① 落点就是原来那个标签：不新建、id 不变。
    expect(second.id).toBe(first.id)
    expect(provider.sessions.size).toBe(1)
    expect(provider.calls.filter(call => call.startsWith('open:'))).toEqual([])
    // ② 走的是既有 navigate 路径 —— 不是复制的一份导航逻辑。
    expect(provider.calls).toContain(`navigate:${first.id}`)
    // ③ 导航在快照之前：先换文档、再观察，回执才是新页面的。
    expect(provider.calls.indexOf(`navigate:${first.id}`))
      .toBeLessThan(provider.calls.indexOf(`observe:${first.id}`))
    // ④ 旧 ref 确实作废了：provider 的 navigate 按契约作废纪元（这条断言同时锁住「档 2
    //    必须走真导航、不能自己拼一条不发 navigate 的假路径」）。
    expect(provider.invalidated).toContain(first.id)
    // ⑤ 回执地址是**这次观察到的**新地址，不是复用前那张页面的旧地址 —— 否则模型会拿
    //    「它以为还在 A」的判断去操作一个已经停在 B 的页面。
    expect(second.url).toBe('https://example.com/b')
    // ⑥ 归属没变：A 仍持有，B 仍进不来。
    expect(() => browser.assertHeld(first.id, ALICE)).not.toThrow()
    expect(() => browser.assertHeld(first.id, BOB))
      .toThrow(expect.objectContaining({ code: 'BROWSER_TAB_NOT_HELD' }))
    await browser.dispose()
  })

  it('open(同 URL)：不重复导航，但仍激活并重拍快照（回执是这次观察到的值）', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/same' }, ALICE)
    provider.calls.length = 0

    const again = await browser.open({ url: 'https://example.com/same' }, ALICE)

    expect(again.id).toBe(first.id)
    // 关键：一个 navigate 都没有 —— 无谓刷新会让页面丢掉已填表单与页面内状态。
    expect(provider.calls.filter(call => call.startsWith('navigate:'))).toEqual([])
    // 但快照照拍：回执里的 url/title/epoch 必须是**本次观察到的**，否则模型会拿旧纪元
    // 去操作一个它以为刚打开的页面。这里断言的是「快照命令真的发出去了」+「它排在激活之后」。
    expect(provider.calls).toContain(`observe:${first.id}`)
    expect(provider.calls.indexOf('tabs:activate'))
      .toBeLessThan(provider.calls.indexOf(`observe:${first.id}`))
    expect(again).toMatchObject({ id: first.id, url: 'https://example.com/same', title: SESSION.title })
    await browser.dispose()
  })

  it('回执的 url/title 取自本次快照，而不是复用前清单里的旧值', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    // 清单里仍报旧地址（标签条的清单有缓存是常态），快照才是权威：让它给出差别明显的新值。
    const listed = provider.tabs
    provider.tabs = async (request) => {
      const result = await listed(request)
      if (request.kind !== 'list') return result
      return { ...result, tabs: result.tabs.map(tab => ({ ...tab, url: 'https://example.com/a', title: '旧标题' })) }
    }
    const observing = provider.observe
    provider.observe = async (request) => {
      const snapshot = await observing(request)
      return snapshot.kind === 'snapshot'
        ? { ...snapshot, url: 'https://example.com/b', title: '新标题' }
        : snapshot
    }

    const second = await browser.open({ url: 'https://example.com/b' }, ALICE)

    expect(second.id).toBe(first.id)
    // 若实现偷懒用清单值或复用前的会话值，这里会拿到 a / 旧标题。
    expect(second).toMatchObject({ url: 'https://example.com/b', title: '新标题' })
    await browser.dispose()
  })

  it('等价写法（大小写与默认端口不同）同样不重复导航', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/' }, ALICE)
    provider.calls.length = 0

    const again = await browser.open({ url: 'https://EXAMPLE.com:443' }, ALICE)

    // 规范化之后是同一个地址：不该为了「写法不同」白白刷新一次页面。
    expect(again.id).toBe(first.id)
    expect(provider.calls.filter(call => call.startsWith('navigate:'))).toEqual([])
    await browser.dispose()
  })

  it('持有标签被人工接管时回落新建，绝不导航别人正在操作的页面', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    // 契约：`refRecoveryState` 在人工持有时无值（src/browser/types.ts）。
    provider.refRecoveryState = (sessionId: string) => (sessionId === first.id ? undefined : 1)
    provider.calls.length = 0

    const second = await browser.open({ url: 'https://example.com/b' }, ALICE)

    expect(second.id).not.toBe(first.id)
    expect(provider.sessions.size).toBe(2)
    // 关键否证：一条 navigate 都没发 —— 「回落新建」不能顺带把人工页面导航走。
    expect(provider.calls.filter(call => call.startsWith('navigate:'))).toEqual([])
    expect(() => browser.assertHeld(first.id, ALICE)).not.toThrow()
    await browser.dispose()
  })

  it('reuseOwnTabOnOpen:false 回到旧行为（同址不同址都新建）', async () => {
    const { browser, provider } = await mountWithProvider({ reuseOwnTabOnOpen: false })
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    provider.calls.length = 0

    const other = await browser.open({ url: 'https://example.com/b' }, ALICE)
    const same = await browser.open({ url: 'https://example.com/a' }, ALICE)

    expect(other.id).not.toBe(first.id)
    expect(same.id).not.toBe(first.id)
    expect(same.id).not.toBe(other.id)
    expect(provider.sessions.size).toBe(3)
    expect(provider.calls.filter(call => call.startsWith('navigate:'))).toEqual([])
    await browser.dispose()
  })

  it('别人的标签永不被复用（哪怕它就在 provider 清单里）', async () => {
    const { browser, provider } = await mountWithProvider()
    const alice = await browser.open({ url: 'https://example.com/a' }, ALICE)
    const bob = await browser.open({ url: 'https://example.com/b' }, BOB)
    provider.calls.length = 0

    const aliceAgain = await browser.open({ url: 'https://example.com/c' }, ALICE)

    // A 只可能复用自己那一张：B 的标签不能因为「清单里看得到」就变成落点。
    expect(aliceAgain.id).toBe(alice.id)
    expect(aliceAgain.id).not.toBe(bob.id)
    expect(provider.calls.filter(call => call.startsWith('navigate:')).sort())
      .toEqual([`navigate:${alice.id}`].sort())
    expect(() => browser.assertHeld(bob.id, BOB)).not.toThrow()
    await browser.dispose()
  })

  it('弹窗家族成员不进候选：宁可新建也不复用家族子标签', async () => {
    const { browser, provider, adopt } = await mountWithAdoptingProvider()
    const parent = await browser.open({ url: 'https://example.com/parent' }, ALICE)
    provider.sessions.set('popup', { sessionId: 'popup', url: 'https://pop.example/', title: '弹窗' })
    adopt('popup', parent.id)
    provider.calls.length = 0

    const next = await browser.open({ url: 'https://example.com/next' }, ALICE)

    // 家族里的两张都不动：没有 navigate 落到 parent 或 popup 上。
    expect(provider.calls).not.toContain(`navigate:${parent.id}`)
    expect(provider.calls).not.toContain('navigate:popup')
    expect(next.id).not.toBe(parent.id)
    expect(next.id).not.toBe('popup')
    await browser.dispose()
  })

  it('多个自有标签时选前台那一张', async () => {
    const { browser, provider } = await mountWithProvider()
    // 先用「释放再新建」造出两张同属 A 的标签：直接连开两次会被档 2 合并——这正是它该做的事。
    const background = await browser.open({ url: 'https://example.com/a' }, ALICE)
    await browser.tabs({ kind: 'release', sessionId: background.id }, ALICE)
    const foreground = await browser.open({ url: 'https://example.com/b' }, ALICE)
    await browser.tabs({ kind: 'claim', sessionId: background.id }, ALICE)
    // provider 清单里前台信号是权威的：provider.tabs 的 active 标记。
    const listed = provider.tabs
    provider.tabs = async (request) => {
      const result = await listed(request)
      if (request.kind !== 'list') return result
      return {
        ...result,
        tabs: result.tabs.map(tab => ({ ...tab, active: tab.sessionId === background.id })),
      }
    }
    provider.calls.length = 0

    const next = await browser.open({ url: 'https://example.com/c' }, ALICE)

    expect(next.id).toBe(background.id)
    expect(next.id).not.toBe(foreground.id)
    await browser.dispose()
  })

  it('没有前台信号时取所有者清单里较新的那条，而不是「剩余租期最长」的那条', async () => {
    // 受控时钟造出可区分的两种答案：按登记顺序 → newer；按剩余租期 → older。
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const { browser, provider } = await mountWithProvider({ tabLeaseIdleMs: 10_000 })
      // 两张同属 A 的标签（直接连开两次会被档 2 合并 —— 这正是它该做的事）。
      const older = await browser.open({ url: 'https://example.com/a' }, ALICE)
      await browser.tabs({ kind: 'release', sessionId: older.id }, ALICE)
      const newer = await browser.open({ url: 'https://example.com/b' }, ALICE)
      await browser.tabs({ kind: 'claim', sessionId: older.id }, ALICE)
      // 晚 5 秒再碰 older：它的租期被续到最新，剩余期限比 newer 长。
      // 若实现拿「最近活跃 = 剩余租期最长」当判据，落点就会倒向 older —— 而 older 恰恰是
      // 模型正在看的那张，把它导航走正是要避免的事。
      now = 5_000
      await browser.observe({ kind: 'snapshot', sessionId: older.id }, ALICE)
      provider.calls.length = 0

      const next = await browser.open({ url: 'https://example.com/c' }, ALICE)

      expect(next.id).toBe(newer.id)
      expect(next.id).not.toBe(older.id)
      await browser.dispose()
    } finally {
      clock.mockRestore()
    }
  })

  it('复用不产生新标签，也不把这次 open 算成 opened_tabs', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    const second = await browser.open({ url: 'https://example.com/b' }, ALICE)
    // open 的回执形态是 BrowserSession，没有 openedTabs 字段；这里断言的是「真的没多开」——
    // provider 的 sessions 只有一张，且回执 id 自始至终没变过。
    expect(second.id).toBe(first.id)
    expect(provider.sessions.size).toBe(1)
    expect(Object.keys(second).sort()).toEqual(['epoch', 'id', 'title', 'url'])
    await browser.dispose()
  })

  it('目标网址非法时不进入档 2，交回 provider 的地址策略拒绝', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    const failing = provider.navigate
    provider.navigate = async () => { throw new BrowserError('bad url', 'BROWSER_INVALID_PARAMS') }
    provider.calls.length = 0

    // 非 http(s) 规范化失败 ⇒ 档 2 整档跳过 ⇒ 落到档 3 新建（而不是拿它去导航既有标签）。
    const created = await browser.open({ url: 'javascript:alert(1)' }, ALICE)
    expect(created.id).not.toBe(first.id)
    expect(provider.calls.filter(call => call.startsWith('navigate:'))).toEqual([])
    provider.navigate = failing
    await browser.dispose()
  })

  it('空 URL 的 open 不触发档 2（空白页请求仍按新建处理）', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    provider.calls.length = 0

    const blank = await browser.open({}, ALICE)

    expect(blank.id).not.toBe(first.id)
    expect(provider.calls.filter(call => call.startsWith('navigate:'))).toEqual([])
    await browser.dispose()
  })

  it('档 1（空闲同址领取）仍优先于档 2：有自己该领的空闲标签时不导航自有标签', async () => {
    const { browser, provider } = await mountWithProvider()
    // 先造一张空闲的同址标签，再让 A 另开一张自己的：档 1 命中时不该去导航后者。
    const idle = await browser.open({ url: 'https://example.com/idle' }, ALICE)
    await browser.tabs({ kind: 'release', sessionId: idle.id }, ALICE)
    const mine = await browser.open({ url: 'https://example.com/mine' }, ALICE)
    expect(mine.id).not.toBe(idle.id)
    provider.calls.length = 0

    const reused = await browser.open({ url: 'https://example.com/idle' }, ALICE)

    // 档 1 命中：领取那张空闲的同址标签，页面原样保留，不导航、也不去动 mine。
    expect(reused.id).toBe(idle.id)
    expect(reused.id).not.toBe(mine.id)
    expect(provider.calls.filter(call => call.startsWith('navigate:'))).toEqual([])
    expect(() => browser.assertHeld(mine.id, ALICE)).not.toThrow()
    await browser.dispose()
  })

  it('选好落点后被人工接管的竞争：回落新建，不把失败甩给模型', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    // 候选筛选时还看不出接管（钩子先回正常值），真正导航时才拒绝 —— 模拟「人刚按下接管」。
    let seen = 0
    provider.refRecoveryState = () => { seen += 1; return seen === 1 ? 1 : undefined }
    provider.navigate = async () => {
      throw new BrowserError('human took over', 'BROWSER_HUMAN_HOLDING')
    }

    const second = await browser.open({ url: 'https://example.com/b' }, ALICE)

    expect(second.id).not.toBe(first.id)
    expect(provider.sessions.size).toBe(2)
    await browser.dispose()
  })

  it('导航失败（非竞争类错误）照原样抛出，不变成一张新标签', async () => {
    const { browser, provider } = await mountWithProvider()
    await browser.open({ url: 'https://example.com/a' }, ALICE)
    provider.navigate = async () => { throw new BrowserError('boom', 'BROWSER_NAVIGATION_FAILED') }

    // 网络 / 地址策略失败是请求本身的问题：回落新建会掩盖它，还平白多一张标签。
    await expect(browser.open({ url: 'https://example.com/b' }, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NAVIGATION_FAILED' }))
    expect(provider.sessions.size).toBe(1)
    await browser.dispose()
  })

  it('台账里有、provider 清单里已消失的标签不进候选（回到新建）', async () => {
    const { browser, provider } = await mountWithProvider()
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    // 绕过受控入口直接关掉：台账还挂着，provider 这边已经没了。
    provider.sessions.delete(first.id)
    provider.calls.length = 0

    const next = await browser.open({ url: 'https://example.com/b' }, ALICE)

    expect(next.id).not.toBe(first.id)
    expect(provider.calls.filter(call => call.startsWith('navigate:'))).toEqual([])
    await browser.dispose()
  })
})

describe('本对话标签数硬顶 maxOwnedTabs', () => {
  // 用「不带 url 的 open()」造真新建：档 2 要求 url 有值，空白页每次都落到档 3，
  // 于是能稳定地堆出 N 张标签，不受复用逻辑干扰。
  const openBlank = (browser: BrowserRuntime, caller: BrowserCaller) => browser.open({}, caller)

  it('达到上限后拒绝新建，回执列出当前标签让模型自己腾位置', async () => {
    const { browser, provider } = await mountWithProvider({ maxOwnedTabs: 3 })
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) ids.push((await openBlank(browser, ALICE)).id)
    expect(provider.sessions.size).toBe(3)

    const before = [...provider.calls]
    await expect(openBlank(browser, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TOO_MANY_TABS' }))
    // 拒绝必须发生在派发之前：一个页面命令都不能发，否则就是「开完再报错」。
    expect(provider.calls.length).toBe(before.length)
    expect(provider.sessions.size).toBe(3)
    // 回执里点名当前持有的 session_id，模型才知道该关哪几个。
    // 用 rejects.toThrow 的正则直接断言消息文本，避免把 .catch 的返回类型收窄错。
    await expect(openBlank(browser, ALICE)).rejects.toThrow(/hard limit 3/u)
    await expect(openBlank(browser, ALICE)).rejects.toThrow(
      new RegExp(ids.map(id => id.replaceAll('.', '\\.')).join('[\\s\\S]*'), 'u'),
    )
    await browser.dispose()
  })

  it('关掉一个之后又能新建（拒绝是可恢复的，不是死锁）', async () => {
    const { browser, provider } = await mountWithProvider({ maxOwnedTabs: 2 })
    const first = await openBlank(browser, ALICE)
    await openBlank(browser, ALICE)
    await expect(openBlank(browser, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TOO_MANY_TABS' }))

    await browser.tabs({ kind: 'close', sessionId: first.id }, ALICE)
    await expect(openBlank(browser, ALICE)).resolves.toBeDefined()
    expect(provider.sessions.size).toBe(2)
    await browser.dispose()
  })

  it('上限只数本对话的标签，别人的标签不占额度', async () => {
    const { browser, provider } = await mountWithProvider({ maxOwnedTabs: 2 })
    await openBlank(browser, BOB)
    await openBlank(browser, BOB)
    // BOB 已经 2 张，但那是 BOB 的：ALICE 应仍能开满自己的 2 张。
    const a1 = await openBlank(browser, ALICE)
    const a2 = await openBlank(browser, ALICE)
    expect([a1.id, a2.id]).toHaveLength(2)
    await expect(openBlank(browser, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TOO_MANY_TABS' }))
    expect(provider.sessions.size).toBe(4)
    await browser.dispose()
  })

  it('档 1 领取、档 2 复用不受上限影响（它们不增加标签数）', async () => {
    const { browser, provider } = await mountWithProvider({ maxOwnedTabs: 1 })
    // 上限设成 1：正常读页「反复 open 不同 url」应始终复用同一张，不该被上限挡死。
    const first = await browser.open({ url: 'https://example.com/a' }, ALICE)
    const second = await browser.open({ url: 'https://example.com/b' }, ALICE)
    expect(second.id).toBe(first.id)
    expect(provider.sessions.size).toBe(1)
    await browser.dispose()
  })

  it('默认值是 8，且非法配置（0/负数/小数）当场报配置错误', async () => {
    const { browser, provider } = await mountWithProvider()
    for (let i = 0; i < 8; i += 1) await openBlank(browser, ALICE)
    expect(provider.sessions.size).toBe(8)
    await expect(openBlank(browser, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TOO_MANY_TABS' }))
    await browser.dispose()

    for (const bad of [0, -1, 2.5]) {
      await expect(mountBrowser({ maxOwnedTabs: bad }))
        .rejects.toThrow(/maxOwnedTabs.*positive integer/u)
    }
  })

  it('上限检查只在档 3 前：没有 url 的空白页也照样被拦', async () => {
    const { browser, provider } = await mountWithProvider({ maxOwnedTabs: 1 })
    await browser.open({ url: 'https://example.com/' }, ALICE)
    // 空白页 open() 不走档 2（要求 url 有值），必落档 3 → 撞上限。
    await expect(openBlank(browser, ALICE))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TOO_MANY_TABS' }))
    expect(provider.sessions.size).toBe(1)
    await browser.dispose()
  })
})
