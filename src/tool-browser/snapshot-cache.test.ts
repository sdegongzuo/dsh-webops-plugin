import { describe, expect, it } from 'vitest'
import { rememberSnapshot, searchOutline, SNAPSHOT_TEXT_CACHE_CHARS, type SnapshotCache } from './snapshot-cache.ts'

describe('观察缓存与完整正文检索', () => {
  it('整份正文缓存有总预算，超限明确标记，代码同组重复引用不重复消耗预算', () => {
    const cache: SnapshotCache = new Map()
    const entry = rememberSnapshot(cache, { session_id: 's1', refs: [], truncated: false }, '- text "code"', undefined,
      [{ line: 2, text: 'x'.repeat(SNAPSHOT_TEXT_CACHE_CHARS) }], [
        { line: 0, text: 'return 1;', blockId: 'code-a' },
        { line: 1, text: 'return 1;', blockId: 'code-a' },
      ])
    expect(entry.textBlocks?.[0]?.text).toBe('return 1;')
    expect(entry.textBlocks?.[1]?.text).toBe('return 1;')
    expect(entry.fullTexts?.[0]?.text.length).toBe(SNAPSHOT_TEXT_CACHE_CHARS - 'return 1;'.length)
    expect(entry.fullTexts?.[0]?.sourceTruncated).toBe(true)
  })
  it('尾部关键词参与默认与正则匹配，完整读取保留空白；默认不回传整段正文', () => {
    const cache: SnapshotCache = new Map()
    const original = '背景'.repeat(300) + '\n\n  TAIL-DEPLOY-739'
    const entry = rememberSnapshot(cache, { session_id: 's1', refs: [], truncated: false }, '- text "背景…"', undefined, [{ line: 0, text: original }])
    const plain = searchOutline(entry, text => text.includes('TAIL-DEPLOY-739'), 5)
    expect(plain).toHaveLength(1)
    expect(plain[0]?.text).toBeUndefined()
    const full = searchOutline(entry, text => /tail-deploy-\d+/i.test(text), 5, true)
    expect(full[0]?.text).toBe(original)
    expect(full[0]?.ref).toBe('')
  })

  it('正文块可独立命中，正文和大纲同时命中只产生一项', () => {
    const cache: SnapshotCache = new Map()
    const block = 'function main() {\n  return 739;\n}'
    const entry = rememberSnapshot(cache, { session_id: 's1', refs: [], truncated: false }, '- text "function main"', undefined, [], [{ line: 0, text: block }])
    expect(searchOutline(entry, text => text.includes('739'), 5, true)[0]?.block).toBe(block)
    expect(searchOutline(entry, text => text.includes('main'), 5, true)).toHaveLength(1)
  })

  it('区域覆盖搜索范围但观察序号不随清空或另一会话重置', () => {
    const cache: SnapshotCache = new Map()
    const snapshot = { session_id: 's1', refs: [], truncated: false }
    const full = rememberSnapshot(cache, snapshot, '- heading "甲"\n- heading "乙"')
    const region = rememberSnapshot(cache, snapshot, '- heading "甲"', 'ref:e1')
    expect(region.observationId).toBeGreaterThan(full.observationId)
    expect(region.region).toBe('ref:e1')
    expect(searchOutline(region, text => text.includes('乙'), 5)).toEqual([])
    cache.clear()
    const next = rememberSnapshot(cache, { ...snapshot, session_id: 's2' }, '- text "新观察"')
    expect(next.observationId).toBeGreaterThan(region.observationId)
    const independent = rememberSnapshot(new Map(), snapshot, '- text "另一个插件实例"')
    expect(independent.observationId).toBe(1)
  })

  it('同一正文组只返回一次，同文的不同章节分别保留', () => {
    const cache: SnapshotCache = new Map()
    const entry = rememberSnapshot(cache, { session_id: 's1', refs: [], truncated: false },
      '- text "const"\n- text "return"\n- text "另一节const"', undefined, [], [
        { line: 0, text: 'const a = 1;\nreturn a;', blockId: 'code-a' },
        { line: 1, text: 'const a = 1;\nreturn a;', blockId: 'code-a' },
        { line: 2, text: 'const a = 1;\nreturn a;', blockId: 'code-b' },
      ])
    const matches = searchOutline(entry, text => text.includes('return'), 10, true)
    expect(matches).toHaveLength(2)
    expect(matches.map(match => match.block)).toEqual(['const a = 1;\nreturn a;', 'const a = 1;\nreturn a;'])
  })
})
