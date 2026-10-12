import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachRefRecovery } from './ref-recovery.ts'
import { BrowserError, type BrowserProvider, type BrowserSnapshot } from './types.ts'

const snapshot: BrowserSnapshot = {
  kind: 'snapshot', sessionId: 's1', url: 'https://example.com/', title: '记录 B', epoch: 2,
  outline: '- button "执行" [ref=e9]', refs: [{ ref: 'e9', role: 'button', name: '执行' }],
  truncated: false, outlineLines: 1,
}
function fixture() {
  const observe = vi.fn<BrowserProvider['observe']>().mockResolvedValue(snapshot)
  const state = vi.fn((): number | undefined => 1)
  const provider = { observe, refRecoveryState: state } as unknown as BrowserProvider
  const held = vi.fn()
  return { provider, observe, state, held }
}
function stale() { return new BrowserError('旧 ref', 'BROWSER_STALE_REF', { dispatchState: 'not_dispatched' }) }

describe('单次 ref 失败恢复边界', () => {
  afterEach(() => vi.useRealTimers())
  it('未派发的失败附带新观察，前后核对权限且仅采集一次', async () => {
    const f = fixture(); const error = stale()
    await attachRefRecovery(error, f.provider, 's1', 1, f.held)
    expect(error.recoverySnapshot).toBe(snapshot)
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.held).toHaveBeenCalledTimes(2)
    expect(error.code).toBe('BROWSER_STALE_REF')
  })
  it.each(['BROWSER_STALE_REF', 'BROWSER_CDP_COMMAND_TIMEOUT', 'BROWSER_HUMAN_HOLDING', 'BROWSER_CONNECTION_LOST'] as const)(
    '%s 缺未派发证明或不在恢复白名单时，不观察', async code => {
      const f = fixture()
      await attachRefRecovery(new BrowserError('未知结果', code,
        code === 'BROWSER_STALE_REF' ? undefined : { dispatchState: 'not_dispatched' }), f.provider, 's1', 1, f.held)
      expect(f.observe).not.toHaveBeenCalled()
    })
  it('取消及人工持有时不观察', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort()
    await attachRefRecovery(stale(), f.provider, 's1', 1, f.held, controller.signal)
    f.state.mockReturnValue(undefined)
    await attachRefRecovery(stale(), f.provider, 's1', 1, f.held)
    expect(f.observe).not.toHaveBeenCalled()
  })
  it('观察期间控制权切换或权限丢失，不把新快照交给原调用者', async () => {
    const f = fixture(); const error = stale()
    f.observe.mockImplementation(async () => { f.state.mockReturnValue(2); return snapshot })
    await attachRefRecovery(error, f.provider, 's1', 1, f.held)
    expect(error.recoverySnapshot).toBeUndefined()
    f.state.mockReturnValue(1)
    f.held.mockImplementation(() => { throw new Error('权限丢失') })
    await attachRefRecovery(error, f.provider, 's1', 1, f.held)
    expect(f.observe).toHaveBeenCalledTimes(1)
  })
  it('恢复子预算最多两秒，失败保留原错误', async () => {
    vi.useFakeTimers()
    const f = fixture(); const error = stale()
    f.observe.mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const pending = attachRefRecovery(error, f.provider, 's1', 1, f.held)
    await vi.advanceTimersByTimeAsync(2_000)
    await pending
    expect(error.recoverySnapshot).toBeUndefined()
    expect(error.code).toBe('BROWSER_STALE_REF')
    expect(error.recoveryAttempted).toBe(true)
    expect(f.observe).toHaveBeenCalledTimes(1)
  })
})
