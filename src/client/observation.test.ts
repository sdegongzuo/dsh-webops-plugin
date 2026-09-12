import { describe, expect, it } from 'vitest'
import {
  browserCallsFrom,
  callFromBlock,
  observeBrowser,
  parseBrowserUrl,
  type BrowserCall,
} from './observation.ts'

/** 造一个已结算的工具结果节点。 */
function settled(toolName: string, argsRaw: string, content: readonly unknown[] = [], isError = false): unknown {
  return { kind: 'tool-result', seq: 1, callId: `call-${toolName}`, call: { name: toolName, argsRaw }, content, isError }
}

/** 造一个运行中的工具调用。 */
function running(toolName: string, argsRaw: string): unknown {
  return { callId: `live-${toolName}`, name: toolName, argsRaw }
}

function snapshot(nodes: readonly unknown[], runningCalls: readonly unknown[] = []): unknown {
  return { legacy: { nodes, runningCalls } }
}

function call(partial: Partial<BrowserCall> & Pick<BrowserCall, 'toolName'>): BrowserCall {
  return {
    callId: 'c', settled: true, isError: false, argsRaw: '', resultText: '', image: undefined,
    ...partial,
  }
}

describe('parseBrowserUrl', () => {
  it('取出参数里的 url', () => {
    expect(parseBrowserUrl('{"url":"https://example.com/a"}')).toBe('https://example.com/a')
  })

  it('参数不是合法 JSON 时返回 undefined，而不是抛错', () => {
    expect(parseBrowserUrl('{ url: ')).toBeUndefined()
  })

  it('没有 url 字段、或 url 为空串时返回 undefined', () => {
    expect(parseBrowserUrl('{"ref":"e3"}')).toBeUndefined()
    expect(parseBrowserUrl('{"url":""}')).toBeUndefined()
    expect(parseBrowserUrl('')).toBeUndefined()
  })

  it('url 不是字符串时返回 undefined', () => {
    expect(parseBrowserUrl('{"url":42}')).toBeUndefined()
  })
})

describe('browserCallsFrom', () => {
  it('只收 browser_* 调用，其它工具被滤掉', () => {
    const calls = browserCallsFrom(snapshot([
      settled('read_file', '{}'),
      settled('browser_navigate', '{"url":"https://a.test"}'),
      settled('web_search', '{}'),
    ]))
    expect(calls.map(entry => entry.toolName)).toEqual(['browser_navigate'])
  })

  it('已结算节点排在前、运行中节点追加在后（于是最后一项就是最新调用）', () => {
    const calls = browserCallsFrom(snapshot(
      [settled('browser_open', '{}')],
      [running('browser_screenshot', '{}')],
    ))
    expect(calls.map(entry => entry.toolName)).toEqual(['browser_open', 'browser_screenshot'])
    expect(calls.at(-1)?.settled).toBe(false)
  })

  it('抽得出结果正文与图片附件引用', () => {
    const calls = browserCallsFrom(snapshot([settled('browser_screenshot', '{}', [
      { type: 'text', text: 'Captured the viewport.' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 12, width: 800, height: 600, name: 'shot.png' } },
    ])]))
    const first = calls[0]
    expect(first?.resultText).toBe('Captured the viewport.')
    expect(first?.image).toEqual({ attachmentId: 'a1', mediaType: 'image/png', bytes: 12, width: 800, height: 600, name: 'shot.png' })
  })

  it('截断过的历史节点（call 为 null）被跳过，而不是造出一个空名调用', () => {
    const calls = browserCallsFrom(snapshot([{ kind: 'tool-result', seq: 2, callId: 'x', call: null, content: [] }]))
    expect(calls).toEqual([])
  })

  it('形状不符的输入退化成空列表', () => {
    expect(browserCallsFrom(undefined)).toEqual([])
    expect(browserCallsFrom({})).toEqual([])
    expect(browserCallsFrom({ legacy: 'nope' })).toEqual([])
    expect(browserCallsFrom({ legacy: { nodes: 'nope' } })).toEqual([])
  })

  it('缺字段时按缺省值收窄，不抛错', () => {
    const calls = browserCallsFrom(snapshot([{ kind: 'tool-result', callId: 7, call: { name: 'browser_open', argsRaw: 1 } }]))
    expect(calls).toEqual([{ callId: '', toolName: 'browser_open', settled: true, isError: false, argsRaw: '', resultText: '', image: undefined }])
  })
})

describe('callFromBlock', () => {
  it('有 kind 的块是已结算，没有的是运行中', () => {
    const done = callFromBlock(
      { kind: 'tool-result', callId: 'c1', call: { argsRaw: '{"ref":"e1"}' }, content: [{ type: 'text', text: 'ok' }] },
      'browser_snapshot',
    )
    expect(done).toMatchObject({ callId: 'c1', settled: true, argsRaw: '{"ref":"e1"}', resultText: 'ok' })

    const live = callFromBlock({ callId: 'c2', argsRaw: '{"url":"https://a.test"}' }, 'browser_open')
    expect(live).toMatchObject({ callId: 'c2', settled: false, argsRaw: '{"url":"https://a.test"}', resultText: '', image: undefined })
  })

  it('运行中的调用不读结果字段', () => {
    const live = callFromBlock({ callId: 'c', content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png' } }] }, 'browser_screenshot')
    expect(live.image).toBeUndefined()
  })
})

describe('observeBrowser', () => {
  it('没有调用时给出空观察', () => {
    expect(observeBrowser([])).toEqual({
      latest: undefined, running: false, url: undefined, calls: 0, snapshots: 0, screenshots: 0, failures: 0,
    })
  })

  it('取最后一个带 url 的调用作为当前地址', () => {
    const observation = observeBrowser([
      call({ toolName: 'browser_open', argsRaw: '{"url":"https://first.test"}' }),
      call({ toolName: 'browser_snapshot', argsRaw: '{"session_id":"s"}' }),
      call({ toolName: 'browser_navigate', argsRaw: '{"url":"https://second.test"}' }),
    ])
    expect(observation.url).toBe('https://second.test')
    expect(observation.latest?.toolName).toBe('browser_navigate')
  })

  it('地址不会因为后续调用不带 url 而被清掉', () => {
    const observation = observeBrowser([
      call({ toolName: 'browser_navigate', argsRaw: '{"url":"https://kept.test"}' }),
      call({ toolName: 'browser_screenshot', argsRaw: '{"session_id":"s"}' }),
    ])
    expect(observation.url).toBe('https://kept.test')
  })

  it('计数快照/截图，并且只把已结算的错误算作失败', () => {
    const observation = observeBrowser([
      call({ toolName: 'browser_snapshot' }),
      call({ toolName: 'browser_snapshot' }),
      call({ toolName: 'browser_screenshot' }),
      call({ toolName: 'browser_snapshot', isError: true }),
      call({ toolName: 'browser_navigate', settled: false }),
      call({ toolName: 'browser_screenshot', settled: false, isError: true }),
    ])
    expect(observation).toMatchObject({ snapshots: 3, screenshots: 2, failures: 1, running: true, calls: 6 })
  })

  it('全部结算且无错时 running 与 failures 均为空', () => {
    const observation = observeBrowser([call({ toolName: 'browser_snapshot' })])
    expect(observation.running).toBe(false)
    expect(observation.failures).toBe(0)
  })
})
