import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  AI_MODE_FIND_QUERY,
  DEFAULT_QUESTION,
  DEFAULT_URL,
  GATE_ENV,
  PROMPT_FIND_QUERY,
  apply,
  googleDigest,
  lastRef,
} from './index.ts'

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

describe('AI 模式入口查询', () => {
  it('targets the Chinese AI Mode control, not a generic Mode button', () => {
    expect(AI_MODE_FIND_QUERY).toBe('AI 模式')
    expect('tab "图片"').not.toContain(AI_MODE_FIND_QUERY)
    expect('button "AI 模式"').toContain(AI_MODE_FIND_QUERY)
    expect(PROMPT_FIND_QUERY).toBe('textbox')
    expect(DEFAULT_URL).toContain('google.com')
    expect(DEFAULT_QUESTION).toContain('天空')
  })
})

describe('lastRef', () => {
  it('takes the find hit and does not fall back to a snapshot [ref=eN]', () => {
    const history = [
      '- button "AI 模式" [ref=e12]',
      '- textbox "搜索" [ref=e3]',
      'session_id=t1 — 1 match(es) in the cached outline of the last webpage_snapshot',
      '- [e12] button "AI 模式" — - button "AI 模式" [ref=e12]',
    ].join('\n')
    expect(lastRef(history)).toBe('e12')
  })

  it('returns undefined when find missed, so click will not use the last snapshot ref', () => {
    const history = '- button "图片" [ref=e22]\n(no outline line matches)'
    expect(lastRef(history)).toBeUndefined()
  })
})

describe('googleDigest', () => {
  const QUESTION = DEFAULT_QUESTION

  function historyOf(outline: string): string {
    return [
      `webpage_open → ok url=https://www.google.com/?hl=zh-CN session_id=t1`,
      `webpage_fill value=${QUESTION}`,
      `webpage_snapshot session_id=t1`,
      outline,
    ].join('\n')
  }

  it('extracts google url / question / outline from a complete trajectory', () => {
    const result = googleDigest(historyOf('- heading "AI 概览"\n- paragraph "瑞利散射"'), QUESTION)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.digest.url).toContain('google.com')
    expect(result.digest.question).toBe(QUESTION)
    expect(result.digest.outline).toContain('瑞利散射')
  })

  it('fails with a located reason when google was never opened', () => {
    const result = googleDigest(`webpage_fill value=${QUESTION}\nwebpage_snapshot hello world outline`, QUESTION)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('url:')
  })

  it('fails with a located reason when the question was never filled', () => {
    const result = googleDigest('webpage_open https://www.google.com/\nwebpage_snapshot plenty of outline text here', QUESTION)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('question:')
  })
})
