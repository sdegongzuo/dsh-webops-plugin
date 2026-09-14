import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, GATE_ENV, HOTSEARCH_FIND_QUERY, lastRef, parseHotSearchRank, pickFifthTitle } from './index.ts'

/**
 * 最小假的 cordis 上下文：只记录 `ctx.on` 注册了什么。
 *
 * 这个闸门是 2026-09-14 那次事故的回归测试 —— v0.2.0 的出货包把 `fake-llm` 行带了出去，
 * 而它的 `llm/stream` 监听器不调 `next()`（waterfall 短路），于是每个用户的真实对话都被
 * 换成了脚本回放。断言「不置环境变量就不注册监听器」比断言「注册了」更重要。
 */
function recordingContext(events: string[]): Context {
  return {
    on: (event: string) => {
      events.push(event)
    },
  } as unknown as Context
}

describe('apply 闸门（DSH_FAKE_LLM）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not touch llm/stream when the gate is unset', () => {
    vi.stubEnv(GATE_ENV, '')
    const events: string[] = []
    apply(recordingContext(events))
    expect(events).toEqual([])
  })

  it('does not touch llm/stream for any value other than 1', () => {
    vi.stubEnv(GATE_ENV, 'true')
    const events: string[] = []
    apply(recordingContext(events))
    expect(events).toEqual([])
  })

  it('intercepts llm/stream once the gate is explicitly opened', () => {
    vi.stubEnv(GATE_ENV, '1')
    const events: string[] = []
    apply(recordingContext(events))
    expect(events).toEqual(['llm/stream'])
  })
})

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
