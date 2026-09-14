import { describe, expect, it } from 'vitest'
import { lastRef, parseHotSearchRank, pickFifthTitle, HOTSEARCH_FIND_QUERY } from './index.ts'

describe('pickFifthTitle', () => {
  it('does not fall back to the 5th DOM item when ranks are missing', () => {
    const items = [
      { rank: '', title: '筑牢金砖合作根基 壮大全球南方力量' },
      { rank: '', title: '亚朵店长叫“现长”店助叫“政委”' },
      { rank: '', title: '造假景区“早就没人了”' },
      { rank: '', title: '烧烤店被检查15次：系1人投诉116次' },
      { rank: '', title: '渔民落水11天后事都办了 人回来了' },
    ]
    expect(pickFifthTitle(items)).toBeUndefined()
  })

  it('picks the item whose rank is 5 even when it is not fifth in DOM order', () => {
    const items = [
      { rank: '', title: '筑牢金砖合作根基 壮大全球南方力量' },
      { rank: '5新', title: '亚朵店长叫“现长”店助叫“政委”' },
      { rank: '1', title: '造假景区“早就没人了”' },
      { rank: '2', title: '渔民落水11天后事都办了 人回来了' },
    ]
    expect(pickFifthTitle(items)).toBe('亚朵店长叫“现长”店助叫“政委”')
  })
})

describe('parseHotSearchRank', () => {
  it('keeps a bare digit and strips a trailing badge', () => {
    expect(parseHotSearchRank('5')).toBe('5')
    expect(parseHotSearchRank('5新')).toBe('5')
    expect(parseHotSearchRank('热')).toBe('')
  })
})

describe('HOTSEARCH_FIND_QUERY', () => {
  it('targets the outline line whose accessible name starts with rank 5', () => {
    expect(HOTSEARCH_FIND_QUERY).toBe('link "5 ')
    expect('link "2 渔民落水11天后事都办了 人回来了"').not.toContain(HOTSEARCH_FIND_QUERY)
    expect('link "5 亚朵店长叫“现长”店助叫“政委”"').toContain(HOTSEARCH_FIND_QUERY)
    expect('link "15 其他"').not.toContain(HOTSEARCH_FIND_QUERY)
    expect('烧烤店被检查15次').not.toContain(HOTSEARCH_FIND_QUERY)
  })
})

describe('lastRef', () => {
  it('takes the find hit and does not fall back to a snapshot [ref=eN]', () => {
    const history = [
      '- link "2 渔民落水11天后事都办了 人回来了" [ref=e22]',
      '- link "5 亚朵店长叫“现长”店助叫“政委”" [ref=e35]',
      'session_id=t1 — 1 match(es) in the cached outline of the last browser_snapshot',
      '- [e35] link "5 亚朵店长叫“现长”店助叫“政委”" — - link "5 亚朵店长叫“现长”店助叫“政委”" [ref=e35]',
    ].join('\n')
    expect(lastRef(history)).toBe('e35')
  })

  it('returns undefined when find missed, so click will not use the last snapshot ref', () => {
    const history = '- link "2 渔民落水11天后事都办了 人回来了" [ref=e22]\n(no outline line matches)'
    expect(lastRef(history)).toBeUndefined()
  })
})
