import { describe, expect, it } from 'vitest'
import { BrowserError } from './types.ts'
import { TabLeaseRegistry } from './lease.ts'
import type { TabLeaseClock } from './lease.ts'

const ALICE = 'alice'
const BOB = 'bob'
const PROVIDER = 'cdp'

/** 假时钟：时间只在 `advance()` 里走，定时器按到期时刻精确触发。 */
class FakeClock implements TabLeaseClock {
  private time = 0
  private sequence = 0
  private readonly timers = new Map<number, { readonly at: number; readonly callback: () => void }>()

  now(): number {
    return this.time
  }

  setTimer(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence
    this.timers.set(id, { at: this.time + delayMs, callback })
    return id
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** 推进时间；到期的定时器按序触发（触发时可能又排新的，所以每轮重扫）。 */
  advance(ms: number): void {
    this.time += ms
    for (let guard = 0; guard < 100; guard++) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.time)
      if (due.length === 0) return
      for (const [id, timer] of due) {
        this.timers.delete(id)
        timer.callback()
      }
    }
  }
}

function makeRegistry(options: { idleMs?: number; handoffTtlMs?: number } = {}): {
  registry: TabLeaseRegistry
  clock: FakeClock
} {
  const clock = new FakeClock()
  const registry = new TabLeaseRegistry({ ...options, clock })
  return { registry, clock }
}

/** 断言一段代码抛出带指定 code 的 BrowserError。 */
function expectCode(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BrowserError)
    expect((error as BrowserError).code).toBe(code)
    return
  }
  throw new Error(`expected a BrowserError with code ${code}, but nothing was thrown`)
}

describe('TabLeaseRegistry ownership', () => {
  it('registers a tab as held by its opener only', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)

    expect(registry.listHeld(PROVIDER, ALICE).map(view => view.targetId)).toEqual(['t1'])
    expect(registry.listHeld(PROVIDER, BOB)).toEqual([])
    expect(registry.listAvailable(PROVIDER)).toEqual([])
    expect(registry.has(PROVIDER, 't1')).toBe(true)
  })

  it('refuses anyone but the owner, and refuses tabs outside the ledger', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)

    expectCode(() => registry.assertHeld(PROVIDER, 't1', BOB), 'BROWSER_TAB_NOT_HELD')
    // 未登记的标签（宿主标签条「+」开的页面）谁都碰不了 —— 不猜主人。
    expectCode(() => registry.assertHeld(PROVIDER, 'never-registered', ALICE), 'BROWSER_TAB_NOT_HELD')
    expectCode(() => registry.claim(PROVIDER, 'never-registered', ALICE), 'BROWSER_TAB_NOT_HELD')
    expect(() => registry.assertHeld(PROVIDER, 't1', ALICE)).not.toThrow()
  })

  it('keeps providers apart: the same tab id under another provider is a different tab', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)
    expect(registry.has('electron', 't1')).toBe(false)
    expectCode(() => registry.assertHeld('electron', 't1', ALICE), 'BROWSER_TAB_NOT_HELD')
  })
})

describe('TabLeaseRegistry claim / release', () => {
  it('lets an idle tab be claimed, and starts reporting its lease', () => {
    const { registry } = makeRegistry({ idleMs: 60_000 })
    registry.register(PROVIDER, 't1', ALICE)
    registry.release(PROVIDER, 't1', ALICE)

    expect(registry.listAvailable(PROVIDER)).toEqual(['t1'])
    expect(registry.listHeld(PROVIDER, ALICE)).toEqual([])

    registry.claim(PROVIDER, 't1', BOB)
    expect(registry.listAvailable(PROVIDER)).toEqual([])
    expect(registry.listHeld(PROVIDER, BOB)).toEqual([
      { targetId: 't1', state: 'held', remainingMs: 60_000 },
    ])
    expectCode(() => registry.assertHeld(PROVIDER, 't1', ALICE), 'BROWSER_TAB_NOT_HELD')
  })

  it('treats re-claiming your own tab as an idempotent success that does not bump the generation', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)
    const generation = registry.beginCall(PROVIDER, 't1', ALICE)
    registry.endCall(PROVIDER, 't1', generation)
    // 返回值 false = 归属没变，调用方据此**不**作废 ref 纪元（幂等重领不该废掉模型手上的号）。
    expect(registry.claim(PROVIDER, 't1', ALICE)).toBe(false)
    // 代次没变 ⇒ 这次 `beginCall` 拿到的还是同一个号（旧回调不会误伤新租期）。
    expect(registry.beginCall(PROVIDER, 't1', ALICE)).toBe(generation)
  })

  it('refuses to claim a tab someone else holds', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)
    expectCode(() => registry.claim(PROVIDER, 't1', BOB), 'BROWSER_TAB_OCCUPIED')
  })

  it('refuses to release / hand over / close while a call is in flight', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)
    const generation = registry.beginCall(PROVIDER, 't1', ALICE)

    expectCode(() => registry.release(PROVIDER, 't1', ALICE), 'BROWSER_TAB_BUSY')
    expectCode(() => registry.handoff(PROVIDER, 't1', ALICE), 'BROWSER_TAB_BUSY')
    expectCode(() => registry.assertClosable(PROVIDER, 't1', ALICE), 'BROWSER_TAB_BUSY')

    registry.endCall(PROVIDER, 't1', generation)
    expect(() => registry.release(PROVIDER, 't1', ALICE)).not.toThrow()
  })

  it('ignores an endCall from a superseded generation instead of corrupting the new lease', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)
    const staleGeneration = registry.beginCall(PROVIDER, 't1', ALICE)
    // 调用还在飞的时候换了主人（现实里靠 release/handoff 的 BUSY 挡住，这里直接验代次语义）。
    registry.forget(PROVIDER, 't1')
    registry.register(PROVIDER, 't1', BOB)
    const freshGeneration = registry.beginCall(PROVIDER, 't1', BOB)

    registry.endCall(PROVIDER, 't1', staleGeneration)
    // 旧代次的核销不该动到新主人的计数：还在执行中，所以仍然拒绝释放。
    expectCode(() => registry.release(PROVIDER, 't1', BOB), 'BROWSER_TAB_BUSY')
    registry.endCall(PROVIDER, 't1', freshGeneration)
    expect(() => registry.release(PROVIDER, 't1', BOB)).not.toThrow()
  })
})

describe('TabLeaseRegistry handoff', () => {
  it('stores only a hash of the code, and never the code itself', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)
    const code = registry.handoff(PROVIDER, 't1', ALICE)

    const stored = registry.storedHandoffHash(PROVIDER, 't1')
    expect(typeof stored).toBe('string')
    expect(stored).not.toBe(code)
    expect(code.length).toBeGreaterThanOrEqual(20)
    expect(registry.listHeld(PROVIDER, ALICE)).toEqual([])
  })

  it('consumes the code exactly once and rejects wrong codes without burning the tab', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)
    const code = registry.handoff(PROVIDER, 't1', ALICE)

    expectCode(() => registry.claim(PROVIDER, 't1', BOB), 'BROWSER_HANDOFF_INVALID')
    expectCode(() => registry.claim(PROVIDER, 't1', BOB, 'wrong-code'), 'BROWSER_HANDOFF_INVALID')
    // 错码之后仍然能用法码领走 —— 拒绝一个坏码不该把标签变成废号。
    registry.claim(PROVIDER, 't1', BOB, code)
    expect(registry.listHeld(PROVIDER, BOB).map(view => view.targetId)).toEqual(['t1'])
    // 码被消费掉了：表里不再留它的哈希。
    expect(registry.storedHandoffHash(PROVIDER, 't1')).toBeUndefined()
    // 原主人拿着同一个码也重放不了。
    expectCode(() => registry.claim(PROVIDER, 't1', ALICE, code), 'BROWSER_TAB_OCCUPIED')
  })

  it('turns an expired handoff into an idle tab and tells the host to drop the epoch', () => {
    const { registry, clock } = makeRegistry({ handoffTtlMs: 1_000 })
    const released: string[] = []
    registry.onRelease((_providerId, targetId, reason) => { released.push(`${targetId}:${reason}`) })
    registry.register(PROVIDER, 't1', ALICE)
    registry.handoff(PROVIDER, 't1', ALICE)

    clock.advance(1_001)
    expect(registry.listAvailable(PROVIDER)).toEqual(['t1'])
    expect(released).toEqual(['t1:handoff-expired'])
    // 码随之作废（表里的哈希被清掉），标签退化成普通空闲标签：不带码直接领即可。
    expect(registry.storedHandoffHash(PROVIDER, 't1')).toBeUndefined()
    registry.claim(PROVIDER, 't1', BOB)
    expect(registry.listHeld(PROVIDER, BOB).map(view => view.targetId)).toEqual(['t1'])
  })
})

describe('TabLeaseRegistry idle recycling', () => {
  it('frees an expired lease but keeps the tab, and refuses to do so with a call in flight', () => {
    const { registry, clock } = makeRegistry({ idleMs: 1_000 })
    const released: string[] = []
    registry.onRelease((_providerId, targetId, reason) => { released.push(`${targetId}:${reason}`) })
    registry.register(PROVIDER, 't1', ALICE)
    const generation = registry.beginCall(PROVIDER, 't1', ALICE)

    // 执行中的调用跨越截止点：不得回收（§3.1.4）。
    clock.advance(5_000)
    expect(registry.listHeld(PROVIDER, ALICE).map(view => view.targetId)).toEqual(['t1'])
    expect(released).toEqual([])

    // 调用结束那一刻续期，而不是立刻过期。
    registry.endCall(PROVIDER, 't1', generation)
    clock.advance(999)
    expect(registry.listHeld(PROVIDER, ALICE).map(view => view.targetId)).toEqual(['t1'])

    clock.advance(1)
    expect(released).toEqual(['t1:idle'])
    expect(registry.listAvailable(PROVIDER)).toEqual(['t1'])
    expectCode(() => registry.assertHeld(PROVIDER, 't1', ALICE), 'BROWSER_TAB_NOT_HELD')
  })

  it('does not recycle a refreshed lease when the previous deadline passes', () => {
    const { registry, clock } = makeRegistry({ idleMs: 1_000 })
    registry.register(PROVIDER, 't1', ALICE)
    clock.advance(500)
    // 一次调用把截止时间推到 1500（`endCall` 续期），并且**重排**了定时器。
    // 走到旧的 1000 那一刻不该回收 —— 所以这里只推进到 1100 之后再查一次。
    const generation = registry.beginCall(PROVIDER, 't1', ALICE)
    registry.endCall(PROVIDER, 't1', generation)

    clock.advance(600)
    expect(registry.listHeld(PROVIDER, ALICE).map(view => view.targetId)).toEqual(['t1'])
    clock.advance(400)
    expect(registry.listAvailable(PROVIDER)).toEqual(['t1'])
  })

  it('rejects a zero lease instead of silently disabling the guard', () => {
    expect(() => new TabLeaseRegistry({ idleMs: 0 })).toThrow(expect.objectContaining({
      code: 'BROWSER_PROTOCOL_ERROR',
    }))
    expect(() => new TabLeaseRegistry({ handoffTtlMs: -1 })).toThrow(expect.objectContaining({
      code: 'BROWSER_PROTOCOL_ERROR',
    }))
  })
})

describe('TabLeaseRegistry popup families', () => {
  it('inherits the parent state, and refuses to register a child with no parent record', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)

    expect(registry.adoptChild(PROVIDER, 't2', 't1')).toBe(true)
    expect(registry.listHeld(PROVIDER, ALICE).map(view => view.targetId).sort()).toEqual(['t1', 't2'])
    // 人工新建的标签没有受控父：不登记，谁都领不走。
    expect(registry.adoptChild(PROVIDER, 't3', 'not-controlled')).toBe(false)
    expect(registry.has(PROVIDER, 't3')).toBe(false)
    expectCode(() => registry.claim(PROVIDER, 't3', BOB), 'BROWSER_TAB_NOT_HELD')
  })

  it('carries the whole popup family through a handoff in one claim', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)
    registry.adoptChild(PROVIDER, 't2', 't1')

    const code = registry.handoff(PROVIDER, 't1', ALICE)
    // 父子共用同一个码与截止时间 —— 所以「一并迁移」不需要第二套机制。
    expect(registry.storedHandoffHash(PROVIDER, 't2')).toBe(registry.storedHandoffHash(PROVIDER, 't1'))

    registry.claim(PROVIDER, 't2', BOB, code)
    expect(registry.listHeld(PROVIDER, BOB).map(view => view.targetId).sort()).toEqual(['t1', 't2'])
    expect(registry.listHeld(PROVIDER, ALICE)).toEqual([])
  })

  it('releases the whole family together', () => {
    const { registry } = makeRegistry()
    registry.register(PROVIDER, 't1', ALICE)
    registry.adoptChild(PROVIDER, 't2', 't1')

    registry.release(PROVIDER, 't1', ALICE)
    expect(registry.listAvailable(PROVIDER).sort()).toEqual(['t1', 't2'])
  })
})
