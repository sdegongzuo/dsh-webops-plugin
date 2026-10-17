import { describe, expect, it } from 'vitest'
import { pageFindText, FIND_TEXT_PAGE_CHARS, FIND_TEXT_TOTAL_CHARS } from './find-read.ts'
import type { FindMatch } from './snapshot-cache.ts'

const match = (text: string, line = 0): FindMatch => ({ ref: '', role: '', name: '', line: '- text "正文"', line_index: line, text })

describe('原文预算与续读', () => {
  it('分页拼接原文准确，空白和emoji不被裁坏', () => {
    const original = 'x'.repeat(FIND_TEXT_PAGE_CHARS - 1) + '🙂\n\n  return value;'
    const first = pageFindText([match(original)])[0]!
    expect(first.text).toHaveLength(FIND_TEXT_PAGE_CHARS - 1)
    expect(first.text_complete).toBe(false)
    const last = pageFindText([match(original)], first.next_text_offset)[0]!
    expect(first.text! + last.text!).toBe(original)
    expect(last.text_complete).toBe(true)
    expect(last.next_text_offset).toBeUndefined()
  })

  it('多项匹配也受正文总预算约束，未返回的正文可以从offset=0续读', () => {
    const matches = Array.from({ length: 8 }, (_, i) => match('x'.repeat(5000), i))
    const page = pageFindText(matches)
    expect(page.reduce((sum, item) => sum + (item.text?.length ?? 0), 0)).toBe(FIND_TEXT_TOTAL_CHARS)
    expect(page[5]).toMatchObject({ text: '', text_complete: false, next_text_offset: 0, line_index: 5 })
    expect(pageFindText([matches[5]!], 0)[0]?.text).toHaveLength(FIND_TEXT_PAGE_CHARS)
  })

  it('代码块只返回一次，不把内部缓存截断说成完整原文', () => {
    const page = pageFindText([{ ...match('return 1;'), block: 'function f() {\n  return 1;\n}', source_truncated: true }])[0]!
    expect(page.text).toBeUndefined()
    expect(page.block).toBe('function f() {\n  return 1;\n}')
    expect(page.text_complete).toBe(false)
    expect(page.next_text_offset).toBeUndefined()
    expect(page.source_truncated).toBe(true)
  })

  it('拒绝越过缓存正文的偏移，不伪造空的完整页', () => {
    expect(() => pageFindText([match('abc')], 4)).toThrow(expect.objectContaining({ code: 'BROWSER_INVALID_PARAMS' }))
  })

  it('JSON转义后的正文也不超过总预算，续读偏移仍按原文计', () => {
    const original = '\u0001'.repeat(8000)
    const pages = pageFindText(Array.from({ length: 8 }, (_, i) => match(original, i)))
    expect(pages.reduce((sum, item) => sum + JSON.stringify(item.text).length - 2, 0)).toBeLessThanOrEqual(FIND_TEXT_TOTAL_CHARS)
    expect(pages[0]?.next_text_offset).toBeLessThan(FIND_TEXT_PAGE_CHARS)
    expect(pages[0]?.next_text_offset).toBe(pages[0]?.text?.length)
  })
})
