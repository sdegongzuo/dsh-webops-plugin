import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply } from './index.ts'

/** 使用真实注册入口；服务桩只记录越过参数边界的调用。 */
function mount() {
  const tools = new Map<string, ToolDefinition>()
  const dispatched: string[] = []
  const sentinel = new Error('服务已派发')
  const browser = new Proxy({}, { get: (_target, key) => key === 'onLeaseRelease'
    ? () => () => {}
    : () => { dispatched.push(String(key)); throw sentinel } })
  // 逐步披露要接宿主生命周期：桩给最小的事件口（`on`）与探测口（`get`），
  // 这里没有 agent 注册服务，所以 `attachExisting()` 不会装任何屏蔽。
  apply({ browser, tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool), get: () => undefined },
    systemPrompt: { section: () => {} }, effect: () => {}, on: () => () => {}, get: () => undefined,
    logger: { warn: () => {} } } as unknown as Context)
  const execute = (name: string, args: unknown) => tools.get(name)!.execute(args, { agent: { id: '验收对话' } } as unknown as ToolRunContext)
  return { tools, dispatched, sentinel, execute }
}

const basic: Record<string, Record<string, unknown>> = {
  webpage_open: { url: 'https://example.com/' }, webpage_tabs: { action: 'list' },
  webpage_navigate: { session_id: 's1', history: 'back' }, webpage_snapshot: { session_id: 's1' },
  webpage_screenshot: { session_id: 's1' }, webpage_click: { session_id: 's1', ref: 'e1' },
  webpage_fill: { session_id: 's1', ref: 'e1', value: '' }, webpage_press: { session_id: 's1', ref: 'e1', key: 'Enter' },
  webpage_scroll: { session_id: 's1', delta_y: 10 }, webpage_wait: { session_id: 's1', time_ms: 1 },
  webpage_console: { session_id: 's1' }, webpage_network: { session_id: 's1', action: 'list' },
  webpage_execute: { session_id: 's1', code: 'return 1;' }, webpage_find: { session_id: 's1', query: 'x' },
  webpage_locate: { session_id: 's1', ref: 'e1' },
}

describe('网页工具统一参数边界', () => {
  it.each(Object.entries(basic))('%s 未知字段在任何服务调用前拒绝，并公开严格 schema', async (name, args) => {
    const h = mount()
    expect(h.tools.get(name)!.parameters.additionalProperties).toBe(false)
    await expect(h.execute(name, { ...args, unexpected_field: true })).rejects.toThrow(new RegExp(`BROWSER_INVALID_PARAMS.*${name}.*unexpected_field.*允许字段`))
    expect(h.dispatched).toEqual([])
  })

  it.each([
    ['webpage_navigate', { session_id: 's1', url: 'https://example.com', history: 'back' }, '互斥'],
    ['webpage_tabs', { action: 'close' }, 'session_id'],
    ['webpage_network', { session_id: 's1', action: 'body' }, 'request_id'],
    ['webpage_network', { session_id: 's1', action: 'body', request_id: 'r1', limit: 10 }, 'limit'],
    ['webpage_wait', { session_id: 's1', text: 'x', time_ms: 1 }, '只能'],
    ['webpage_wait', { session_id: 's1', text: 'x', ref_state: 'hidden' }, 'ref_state'],
    ['webpage_wait', { session_id: 's1', text: 'x', timeout_ms: 0 }, 'timeout_ms'],
    ['webpage_click', { session_id: 's1', ref: 'e1', timeout_ms: 200 }, 'timeout_ms'],
    ['webpage_press', { session_id: 's1', ref: 'e1', key: 'Enter', timeout_ms: 200, observe: false }, 'timeout_ms'],
    ['webpage_click', { session_id: 's1', ref: 'e1', wait_text: '   ' }, 'wait_text'],
    ['webpage_click', { session_id: 's1', ref: 'e1', observe_ref: 'e1' }, 'observe_ref'],
    ['webpage_wait', { session_id: 's1', text: 'x', observe_ref: ' ' }, 'observe_ref'],
    ['webpage_click', { session_id: 's1', ref: 'e1', region_ref: 'e2' }, 'region_ref'],
    ['webpage_wait', { session_id: 's1', text: 'x', region_ref: ' ' }, 'region_ref'],
    ['webpage_wait', { session_id: 's1', text: 'x', region_ref: 'e2', observe_ref: 'e2' }, '互斥'],
    ['webpage_click', { session_id: 's1', ref: 'e1', observe: true, region_ref: 'e2', observe_ref: 'e3' }, '互斥'],
    ['webpage_snapshot', { session_id: 's1', max_lines: 1.5 }, 'max_lines'],
    ['webpage_snapshot', { session_id: 's1', region_box: { x: 0, y: 0, width: 10, height: 10, extra: 1 } }, 'region_box.extra'],
    ['webpage_scroll', { session_id: 's1', delta_y: Infinity }, 'delta_y'],
    ['webpage_scroll', { session_id: 's1', delta_y: NaN }, 'delta_y'],
    ['webpage_press', { session_id: 's1', ref: 'e1', key: '中' }, 'ASCII'],
    ['webpage_press', { session_id: 's1', ref: 'e1', key: '🙂' }, 'ASCII'],
    ['webpage_press', { session_id: 's1', ref: 'e1', key: '\x7f' }, 'ASCII'],
    ['webpage_click', { session_id: ' ', ref: 'e1' }, 'session_id'],
    ['webpage_find', { session_id: 's1', query: '[', regex: true }, '正则'],
    ['webpage_find', { session_id: 's1', query: 'x', read: { observation_id: 1, line: 0, offset: 0 } }, 'full_text'],
    ['webpage_find', { session_id: 's1', query: 'x', full_text: true, read: { observation_id: 1, line: 0, offset: -1 } }, 'read.offset'],
    ['webpage_find', { session_id: 's1', query: 'x', full_text: true, read: { observation_id: 1, line: 0, offset: 0, unexpected: true } }, 'read.unexpected'],
  ] as const)('%s 拒绝非法契约并指出字段 %s', async (name, args, hint) => {
    const h = mount()
    await expect(h.execute(name, args)).rejects.toThrow('BROWSER_INVALID_PARAMS')
    await expect(h.execute(name, args)).rejects.toThrow(hint)
    expect(h.dispatched).toEqual([])
  })

  it.each([
    ['webpage_fill', { session_id: 's1', ref: 'e1', value: '' }],
    ['webpage_press', { session_id: 's1', ref: 'e1', key: ' ' }],
    ['webpage_press', { session_id: 's1', ref: 'e1', key: 'Space' }],
    ['webpage_click', { session_id: 's1', ref: 'e1', observe: true, region_ref: 'e2' }],
    ['webpage_press', { session_id: 's1', ref: 'e1', key: 'Enter', wait_text: '完成', region_ref: 'e2' }],
    // observe=false 与 wait_text 不再拒绝：完成等待总会附观察，observe 字段被忽略而不是报错。
    ['webpage_press', { session_id: 's1', ref: 'e1', key: 'Enter', wait_text: 'Saved', observe: false }],
    // 只给 observe=true+timeout_ms：动作后等页面安静至多该毫秒，再观察。
    ['webpage_click', { session_id: 's1', ref: 'e1', observe: true, timeout_ms: 200 }],
    ['webpage_press', { session_id: 's1', ref: 'e1', key: 'Enter', observe: true, timeout_ms: 200 }],
    ['webpage_wait', { session_id: 's1', text: '完成', region_ref: 'e2' }],
    ['webpage_snapshot', { session_id: 's1', region_ref: 'e1', region_viewport: false }],
    ['webpage_screenshot', { session_id: 's1', ref: 'e1', full_page: false }],
    ['webpage_console', { session_id: 's1', text: '' }],
    ['webpage_network', { session_id: 's1', action: 'list', url: '' }],
    ['webpage_scroll', { session_id: 's1', delta_y: 0.5 }],
  ] as const)('%s 合法边界保持可派发，服务异常不改写为参数错误', async (name, args) => {
    const h = mount()
    await expect(h.execute(name, args)).rejects.toBe(h.sentinel)
    expect(h.dispatched).toHaveLength(1)
  })
})
