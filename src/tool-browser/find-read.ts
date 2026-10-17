/** find 原文读取预算与同观察续读；不发页面命令、不改变查询范围。 */
import type { FindMatch } from './snapshot-cache.ts'
import { BrowserError } from '../browser/types.ts'

export const FIND_TEXT_PAGE_CHARS = 4000
export const FIND_TEXT_TOTAL_CHARS = 20000

/** 完整块优先，避免同一代码在 text 与 block 中重复返回。偏移按原始UTF-16字符计。 */
export function pageFindText(matches: readonly FindMatch[], offset = 0): FindMatch[] {
  let remaining = FIND_TEXT_TOTAL_CHARS
  return matches.map(match => {
    const { text, block, ...metadata } = match
    const original = block ?? text
    if (original === undefined) return match
    if (offset > original.length) throw new BrowserError('read.offset exceeds the cached text length; use the returned next_text_offset.', 'BROWSER_INVALID_PARAMS')
    let end = Math.min(original.length, offset + FIND_TEXT_PAGE_CHARS, offset + remaining)
    // 模型回执用JSON原文消除缩进歧义，预算按转义后的字符结算，防止大量换行/控制符放大回执。
    if (JSON.stringify(original.slice(offset, end)).length - 2 > remaining) {
      let low = offset
      let high = end
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (JSON.stringify(original.slice(offset, middle)).length - 2 <= remaining) low = middle
        else high = middle - 1
      }
      end = low
    }
    // UTF-16偏移保持连续，同时避免在回执中拆开emoji的代理项。
    if (end > offset && end < original.length && /[\uD800-\uDBFF]/u.test(original[end - 1]!) && /[\uDC00-\uDFFF]/u.test(original[end]!)) end -= 1
    const page = original.slice(offset, end)
    remaining -= JSON.stringify(page).length - 2
    const moreCached = end < original.length
    return {
      ...metadata,
      ...(block !== undefined ? { block: page } : { text: page }),
      text_offset: offset,
      text_length: original.length,
      text_complete: !moreCached && match.source_truncated !== true,
      ...moreCached ? { next_text_offset: end } : {},
    }
  })
}
