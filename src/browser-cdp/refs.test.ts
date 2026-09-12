import { describe, expect, it } from 'vitest'
import { RefRegistry } from './refs.ts'

/** 一行可操作元素的候选登记项。 */
function target(role: string, name: string, backendNodeId: number): { role: string; name: string; backendNodeId: number } {
  return { role, name, backendNodeId }
}

describe('RefRegistry', () => {
  it('publishes a fresh epoch per snapshot and resolves its refs', () => {
    const registry = new RefRegistry()
    const publication = registry.publish([target('button', 'Save', 11)], false)

    expect(publication.epoch).toBe(1)
    expect(publication.refs).toEqual([{ ref: 'e1', role: 'button', name: 'Save', backendNodeId: 11 }])
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
})
