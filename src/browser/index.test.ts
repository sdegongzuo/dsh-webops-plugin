import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, { BrowserError } from './index.ts'
import type { BrowserNavigateRequest, BrowserObserveRequest, BrowserOpenRequest, BrowserProvider } from './index.ts'

const SESSION = { id: 's1', url: 'https://example.com/', title: 'Example', epoch: 3 }

/** 一个只会记账的 provider 桩。 */
function makeProvider(id: string, available: boolean): BrowserProvider {
  return {
    id,
    available: () => available,
    open: (request: BrowserOpenRequest) => Promise.resolve({ ...SESSION, url: request.url ?? SESSION.url }),
    navigate: (request: BrowserNavigateRequest) => Promise.resolve({ ...SESSION, url: request.url }),
    observe: (request: BrowserObserveRequest) => Promise.resolve({
      kind: 'snapshot',
      sessionId: request.sessionId,
      epoch: SESSION.epoch,
      url: SESSION.url,
      title: SESSION.title,
      outline: '',
      refs: [],
      truncated: false,
    }),
    close: () => Promise.resolve(),
  }
}

/** 挂一个 BrowserRuntime 到全新根上下文。 */
async function mountBrowser(config: ConstructorParameters<typeof BrowserRuntime>[1] = {}): Promise<BrowserRuntime> {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntime, config)
  return ctx.browser
}

describe('BrowserRuntime provider selection', () => {
  it('auto-selects the only usable provider and unregisters it through the returned disposer', async () => {
    const browser = await mountBrowser()
    const dispose = browser.registerProvider(makeProvider('cdp', true))

    await expect(browser.open({ url: 'https://example.com/' }))
      .resolves.toEqual({ ...SESSION, url: 'https://example.com/' })

    dispose()
    await expect(browser.open({}))
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
    await expect(browser.open({}))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('reports BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE when the pinned provider is down', async () => {
    const browser = await mountBrowser({ provider: 'cdp' })
    browser.registerProvider(makeProvider('cdp', false))
    await expect(browser.open({}))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('ignores unusable providers when auto-selecting', async () => {
    const browser = await mountBrowser()
    browser.registerProvider(makeProvider('down', false))
    browser.registerProvider(makeProvider('up', true))
    await expect(browser.open({})).resolves.toMatchObject({ id: 's1' })
  })

  it('refuses to guess when several providers are usable', async () => {
    const browser = await mountBrowser()
    browser.registerProvider(makeProvider('one', true))
    browser.registerProvider(makeProvider('two', true))
    await expect(browser.open({}))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_AMBIGUOUS' }))
  })

  it('reports BROWSER_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const browser = await mountBrowser()
    await expect(browser.open({}))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
  })

  it('resolves the provider at call time, never from registration order', async () => {
    const browser = await mountBrowser({ provider: 'two' })
    browser.registerProvider(makeProvider('one', true))
    browser.registerProvider(makeProvider('two', true))
    await expect(browser.open({})).resolves.toMatchObject({ id: 's1' })
  })
})

describe('BrowserRuntime forwarding', () => {
  it('forwards navigate to the selected provider', async () => {
    const browser = await mountBrowser()
    browser.registerProvider(makeProvider('cdp', true))
    await expect(browser.navigate({ sessionId: 's1', url: 'https://example.com/next' }))
      .resolves.toMatchObject({ url: 'https://example.com/next' })
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
