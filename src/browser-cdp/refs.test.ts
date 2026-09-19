import { describe, expect, it } from 'vitest'
import { LIVE_BINDING_CAP, RefRegistry } from './refs.ts'

/** 一行可操作元素的候选登记项。 */
function target(role: string, name: string, backendNodeId: number): { role: string; name: string; backendNodeId: number } {
  return { role, name, backendNodeId }
}

describe('RefRegistry', () => {
  it('publishes a fresh epoch per snapshot and resolves its refs', () => {
    const registry = new RefRegistry()
    const publication = registry.publish([target('button', 'Save', 11)], false)

    expect(publication.epoch).toBe(1)
    expect(publication.refs).toEqual([{
      ref: 'e1',
      role: 'button',
      name: 'Save',
      backendNodeId: 11,
      semanticKey: '36f22b12',
    }])
    expect(registry.resolve('e1').backendNodeId).toBe(11)
    expect(registry.currentEpoch).toBe(1)
    expect(registry.observed).toBe(true)
  })

  it('reports BROWSER_SNAPSHOT_REQUIRED before any observation', () => {
    const registry = new RefRegistry()
    expect(registry.observed).toBe(false)
    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
  })

  it('reports BROWSER_STALE_REF for a ref from an earlier epoch', () => {
    const registry = new RefRegistry()
    registry.publish([target('button', 'Save', 11)], false)
    registry.invalidate()

    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('never reuses a ref number, so an obsolete ref can never hit a different element', () => {
    const registry = new RefRegistry()
    const first = registry.publish([target('button', 'Save', 11)], false)
    // 第二次 snapshot 如果从 e1 重新编号，模型拿着上一次的 e1 就会静默点到「另一个元素」。
    const second = registry.publish([target('link', 'Cancel', 22)], false)

    expect(first.refs[0]?.ref).toBe('e1')
    expect(second.refs[0]?.ref).toBe('e2')
    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
    expect(registry.resolve('e2').name).toBe('Cancel')
  })

  it('invalidates the refs published by a navigation but keeps the epoch moving forward', () => {
    const registry = new RefRegistry()
    registry.publish([target('textbox', 'Email', 7)], false)
    const epoch = registry.invalidate()

    expect(epoch).toBe(2)
    expect(registry.currentEpoch).toBe(2)
    expect(registry.list()).toEqual([])
    // 观察过就不该再报 SNAPSHOT_REQUIRED：正确诊断是「这个 ref 过时了」。
    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('lists only the current epoch and drops the backend node ids from the model-facing view', () => {
    const registry = new RefRegistry()
    registry.publish([target('button', 'A', 1), target('button', 'B', 2)], false)

    expect(registry.list()).toEqual([
      { ref: 'e1', role: 'button', name: 'A' },
      { ref: 'e2', role: 'button', name: 'B' },
    ])
  })

  it('carries the truncation flag through to the publication', () => {
    const registry = new RefRegistry()
    expect(registry.publish([], true).truncated).toBe(true)
  })

  it('writes semanticKey from role+name+path and never exposes it on list()', () => {
    const registry = new RefRegistry()
    const publication = registry.publish([
      { ...target('button', 'Save', 11), ancestorPath: 'toolbar>form' },
      { ...target('button', 'Save', 12), ancestorPath: 'dialog' },
    ], false)
    const first = publication.refs[0]?.semanticKey
    const second = publication.refs[1]?.semanticKey
    expect(first).toBe('13eb68b3')
    expect(second).toBe('4e91f45a')
    expect(first).not.toBe(second)
    expect(registry.list()[0]).toEqual({ ref: 'e1', role: 'button', name: 'Save' })
    expect(JSON.stringify(registry.list())).not.toContain('semanticKey')
  })

  it('adopt appends into the current epoch so earlier refs stay usable', () => {
    const registry = new RefRegistry()
    registry.publish([target('button', 'Save', 11)], false)
    const added = registry.adopt([target('link', 'More', 22)])
    expect(registry.currentEpoch).toBe(1)
    expect(added.refs[0]?.ref).toBe('e2')
    expect(registry.resolve('e1').name).toBe('Save')
    expect(registry.resolve('e2').name).toBe('More')
  })

  it('would drop old refs if a regional snapshot used publish instead of adopt (反向)', () => {
    const registry = new RefRegistry()
    registry.publish([target('button', 'Save', 11)], false)
    registry.publish([target('link', 'More', 22)], false)
    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('keeps the same semanticKey when the same row is published again (match-rate 1 on identical trees)', () => {
    const rows = [target('link', 'Home', 2), target('button', 'Go', 3)]
    const a = new RefRegistry().publish(rows, false).refs.map(row => row.semanticKey)
    const b = new RefRegistry().publish(rows, false).refs.map(row => row.semanticKey)
    expect(a).toEqual(b)
    expect(new Set(a).size).toBe(a.length)
  })

  it('archives a previous epoch so restore can put the same ref number back', () => {
    const registry = new RefRegistry()
    registry.publish([target('button', 'Save', 11)], false, 'loader-a')
    registry.publish([target('link', 'Next', 22)], false, 'loader-a')

    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
    const archived = registry.archived('e1')
    if (archived === undefined) throw new Error('expected e1 to be archived')
    expect(archived.loaderId).toBe('loader-a')
    expect(archived.target.backendNodeId).toBe(11)

    registry.restore([archived.target])
    expect(registry.currentEpoch).toBe(2)
    expect(registry.resolve('e1').backendNodeId).toBe(11)
    expect(registry.resolve('e1').name).toBe('Save')
    expect(registry.resolve('e2').name).toBe('Next')
  })

  it('keeps resolve strict even when an archived copy exists', () => {
    const registry = new RefRegistry()
    registry.publish([target('button', 'Save', 11)], false, 'loader-a')
    registry.publish([target('link', 'Next', 22)], false, 'loader-a')
    expect(registry.archived('e1')).toBeDefined()
    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('archives on invalidate so a navigated epoch can still be looked up', () => {
    const registry = new RefRegistry()
    registry.publish([target('button', 'Save', 11)], false, 'loader-a')
    registry.invalidate()
    const archived = registry.archived('e1')
    expect(archived?.loaderId).toBe('loader-a')
    expect(archived?.target.role).toBe('button')
  })

  it('drops archives older than the last 3 epochs', () => {
    const registry = new RefRegistry()
    for (let index = 0; index < 5; index += 1) {
      registry.publish([target('button', `B${String(index)}`, 10 + index)], false, `loader-${String(index)}`)
    }
    expect(registry.archived('e1')).toBeUndefined()
    expect(registry.archived('e2')?.loaderId).toBe('loader-1')
    expect(registry.archived('e4')?.loaderId).toBe('loader-3')
  })

  it('would mint a new number if restore used adopt (反向)', () => {
    const registry = new RefRegistry()
    registry.publish([target('button', 'Save', 11)], false, 'loader-a')
    registry.publish([target('link', 'Next', 22)], false, 'loader-a')
    const archived = registry.archived('e1')
    if (archived === undefined) throw new Error('expected e1 to be archived')
    const adopted = registry.adopt([archived.target])
    expect(adopted.refs[0]?.ref).toBe('e3')
    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
  })

  it('reuses the live ref number when adopt hits a unique semanticKey', () => {
    const registry = new RefRegistry()
    registry.publish([
      { ...target('button', 'Save', 11), ancestorPath: 'toolbar' },
    ], false)
    const again = registry.adopt([
      { ...target('button', 'Save', 99), ancestorPath: 'toolbar' },
    ])
    expect(registry.currentEpoch).toBe(1)
    expect(again.refs[0]?.ref).toBe('e1')
    expect(registry.resolve('e1').backendNodeId).toBe(99)
    expect(registry.list()).toEqual([{ ref: 'e1', role: 'button', name: 'Save' }])
  })

  it('mints two numbers when one adopt() batch contains two rows with the same semanticKey', () => {
    const registry = new RefRegistry()
    registry.publish([{ ...target('link', 'Home', 1), ancestorPath: 'nav' }], false)
    const added = registry.adopt([
      { ...target('button', '翻译此页', 11), ancestorPath: 'list' },
      { ...target('button', '翻译此页', 12), ancestorPath: 'list' },
    ])
    expect(added.refs.map(row => row.ref)).toEqual(['e2', 'e3'])
    expect(registry.resolve('e2').backendNodeId).toBe(11)
    expect(registry.resolve('e3').backendNodeId).toBe(12)
    expect(registry.resolve('e1').name).toBe('Home')

    const occupied = new RefRegistry()
    occupied.publish([{ ...target('button', 'Save', 11), ancestorPath: 'toolbar' }], false)
    const extra = occupied.adopt([
      { ...target('button', 'Save', 21), ancestorPath: 'toolbar' },
      { ...target('button', 'Save', 22), ancestorPath: 'toolbar' },
    ])
    expect(extra.refs.map(row => row.ref)).toEqual(['e2', 'e3'])
    expect(occupied.resolve('e1').backendNodeId).toBe(11)
    expect(occupied.resolve('e2').backendNodeId).toBe(21)
    expect(occupied.resolve('e3').backendNodeId).toBe(22)
  })

  it('mints new numbers when two live rows share a semanticKey (unnamed-listitem duplicates)', () => {
    const registry = new RefRegistry()
    registry.publish([
      { ...target('button', '翻译此页', 11), ancestorPath: 'list' },
      { ...target('button', '翻译此页', 12), ancestorPath: 'list' },
    ], false)
    const added = registry.adopt([
      { ...target('button', '翻译此页', 13), ancestorPath: 'list' },
    ])
    expect(added.refs[0]?.ref).toBe('e3')
    expect(registry.resolve('e1').backendNodeId).toBe(11)
    expect(registry.resolve('e2').backendNodeId).toBe(12)
  })

  it('keeps a uniquely keyed row\'s number when it is reordered among siblings', () => {
    const registry = new RefRegistry()
    registry.publish([
      { ...target('button', 'Save', 11), ancestorPath: 'form>toolbar' },
      { ...target('link', 'Help', 12), ancestorPath: 'form>footer' },
    ], false)
    const reordered = registry.adopt([
      { ...target('link', 'Help', 22), ancestorPath: 'form>footer' },
      { ...target('button', 'Save', 21), ancestorPath: 'form>toolbar' },
    ])
    expect(registry.currentEpoch).toBe(1)
    expect(reordered.refs.map(row => row.ref)).toEqual(['e2', 'e1'])
    expect(registry.resolve('e1').backendNodeId).toBe(21)
    expect(registry.resolve('e2').backendNodeId).toBe(22)
  })

  it('mints a new number when role, name, or path identity changed', () => {
    const registry = new RefRegistry()
    registry.publish([
      { ...target('button', 'Save', 11), ancestorPath: 'form' },
    ], false)
    const renamed = registry.adopt([
      { ...target('button', 'Submit', 11), ancestorPath: 'form' },
    ])
    expect(renamed.refs[0]?.ref).toBe('e2')
    expect(registry.resolve('e1').name).toBe('Save')
    expect(registry.resolve('e2').name).toBe('Submit')
  })

  it('rebinds unique keys on the first publish after hydrate, without carrying backendNodeId', () => {
    const previous = new RefRegistry()
    previous.publish([
      { ...target('button', 'Save', 11), ancestorPath: 'form' },
      { ...target('link', 'Help', 12), ancestorPath: 'nav' },
      { ...target('textbox', 'Q', 13), ancestorPath: 'search' },
    ], false)
    const bindings = previous.exportBindings()
    expect(bindings.every(entry => !('backendNodeId' in entry))).toBe(true)

    const restarted = new RefRegistry()
    restarted.hydrate(bindings)
    expect(restarted.observed).toBe(false)
    expect(() => restarted.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
    const publication = restarted.publish([
      { ...target('link', 'Help', 200), ancestorPath: 'nav' },
      { ...target('button', 'Save', 100), ancestorPath: 'form' },
      { ...target('textbox', 'Q', 300), ancestorPath: 'search' },
    ], false)

    expect(restarted.resolve('e1').backendNodeId).toBe(100)
    expect(restarted.resolve('e2').backendNodeId).toBe(200)
    expect(restarted.resolve('e3').backendNodeId).toBe(300)
    expect(publication.refs.map(row => row.ref).sort()).toEqual(['e1', 'e2', 'e3'])
    expect(publication.epoch).toBe(1)
  })

  it('does not revive a persisted ref whose key is missing or duplicated on the new page', () => {
    const previous = new RefRegistry()
    previous.publish([
      { ...target('button', 'Save', 11), ancestorPath: 'form' },
      { ...target('button', '翻译此页', 12), ancestorPath: 'list' },
    ], false)
    const restarted = new RefRegistry()
    restarted.hydrate(previous.exportBindings())
    restarted.publish([
      { ...target('button', '翻译此页', 21), ancestorPath: 'list' },
      { ...target('button', '翻译此页', 22), ancestorPath: 'list' },
      { ...target('link', 'Other', 23), ancestorPath: 'nav' },
    ], false)

    expect(() => restarted.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
    expect(() => restarted.resolve('e2')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
    expect(restarted.list().some(entry => entry.ref === 'e1')).toBe(false)
  })

  it('rebinds more than 80% of unique keys across a restart on a representative fixture', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      ...target('button', `Action ${String(index)}`, 100 + index),
      ancestorPath: `section-${String(index)}`,
    }))
    const previous = new RefRegistry()
    previous.publish(rows, false)
    const restarted = new RefRegistry()
    restarted.hydrate(previous.exportBindings())
    const shuffled = [...rows].reverse()
    restarted.publish(shuffled, false)
    const rebound = rows.filter((_, index) => {
      try {
        return restarted.resolve(`e${String(index + 1)}`).name === `Action ${String(index)}`
      } catch {
        return false
      }
    }).length
    expect(rebound / rows.length).toBeGreaterThan(0.8)
    expect(rebound).toBe(10)
  })

  it('keeps at most 2000 live bindings and soft-evicts the least recently seen', () => {
    const registry = new RefRegistry()
    const rows = Array.from({ length: LIVE_BINDING_CAP + 1 }, (_, index) => ({
      ...target('button', `Cap ${String(index)}`, 1000 + index),
      ancestorPath: `n${String(index)}`,
    }))
    registry.publish(rows, false)
    expect(registry.list()).toHaveLength(LIVE_BINDING_CAP)
    expect(JSON.stringify(registry.list())).not.toContain('semanticKey')
    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
    expect(registry.resolve('e2').name).toBe('Cap 1')
  })

  it('rebinds an evicted unique identity to the same ref number', () => {
    const registry = new RefRegistry()
    const rows = Array.from({ length: LIVE_BINDING_CAP + 1 }, (_, index) => ({
      ...target('button', `Cap ${String(index)}`, 1000 + index),
      ancestorPath: `n${String(index)}`,
    }))
    registry.publish(rows, false)
    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))
    const restored = registry.adopt([
      { ...target('button', 'Cap 0', 42), ancestorPath: 'n0' },
    ])
    expect(restored.refs[0]?.ref).toBe('e1')
    expect(registry.resolve('e1').backendNodeId).toBe(42)
    expect(registry.list().length).toBeLessThanOrEqual(LIVE_BINDING_CAP)
  })

  it('records the page url on the epoch it published and clears it when the epoch dies', () => {
    const registry = new RefRegistry()
    // 还没观察过 → 没有地址可比，写前门此时应当放行（不能拿 undefined 当证据去拦）。
    expect(registry.publishedUrl).toBeUndefined()

    registry.publish([target('button', 'Save', 11)], false, 'loader-1', 'https://example.com/a')
    expect(registry.publishedUrl).toBe('https://example.com/a')

    // 区域快照走 adopt：不推进纪元，也就不能改写纪元地址。
    registry.adopt([target('button', 'Draft', 12)])
    expect(registry.publishedUrl).toBe('https://example.com/a')

    registry.invalidate()
    expect(registry.publishedUrl).toBeUndefined()
  })

  it('drops the epoch url on hydrate (落盘锚点没有地址，写前门宁可放行)', () => {
    const registry = new RefRegistry()
    registry.publish([target('button', 'Save', 11)], false, 'loader-1', 'https://example.com/a')
    const bindings = registry.exportBindings()
    const reborn = new RefRegistry()
    reborn.hydrate(bindings)

    expect(reborn.publishedUrl).toBeUndefined()
  })
})
