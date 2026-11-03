/**
 * 披露投影的契约测试：fold 语义、注册表面与恢复读取。
 *
 * fold 的判据与运行期（disclosure.ts）逐条同源：**失败不结算** —— open 失败
 * 不提升、未知名整次拒绝不加载；无关事件必须原样返回同一引用（宿主的零工作量
 * 前提）。这里全部用宿主事件日志里的真实形状构造，不引入第二套口径。
 */

import { describe, expect, it } from 'vitest'
import {
  advanceDisclosureState,
  DISCLOSURE_PROJECTION_KEY,
  DISCLOSURE_PROJECTION_STATE_VERSION,
  initialDisclosureState,
  registerDisclosureProjection,
  restoreDisclosureState,
  type DisclosureProjectionState,
  type ProjectionHandleLike,
  type SessionProjectionRegistryLike,
} from './disclosure-projection.ts'

/** 宿主 `tool/call` 事件（字段与 packages/core/session/src/types.ts 一致）。 */
function toolCall(callId: string, name: string, args: unknown): { type: 'tool/call'; data: unknown } {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } }
}

/** 宿主 `tool/result` 事件（message 与 ToolResultMessage 一致）。 */
function toolResult(callId: string, isError = false): { type: 'tool/result'; data: unknown } {
  return { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: callId, isError } } }
}

/** 把一串事件折成状态：测试里反复用到。 */
function fold(...events: { type: string; data: unknown }[]): DisclosureProjectionState {
  return events.reduce<DisclosureProjectionState>(advanceDisclosureState, initialDisclosureState())
}

describe('披露投影：fold 语义', () => {
  it('空状态：没有任何网页工具调用', () => {
    expect(initialDisclosureState()).toEqual({ coreOpened: false, loaded: [], pending: {} })
  })

  it('open 成功结算：基础组展开', () => {
    const state = fold(toolCall('c1', 'webpage_open', { url: 'https://example.com/' }), toolResult('c1'))
    expect(state.coreOpened).toBe(true)
    expect(state.pending).toEqual({})
  })

  it('open 失败不结算：可见性不变，pending 清掉', () => {
    const before = initialDisclosureState()
    const state = fold(toolCall('c1', 'webpage_open', { url: 'https://example.com/' }), toolResult('c1', true))
    expect(state.coreOpened).toBe(false)
    expect(state.pending).toEqual({})
    expect(state).not.toBe(before)
  })

  it('claim 成功才算进入网页任务；list 不记录 pending', () => {
    const claim = fold(toolCall('c1', 'webpage_tabs', { action: 'claim', session_id: 's1' }), toolResult('c1'))
    expect(claim.coreOpened).toBe(true)
    const list = fold(toolCall('c2', 'webpage_tabs', { action: 'list' }))
    expect(list).toEqual(initialDisclosureState())
  })

  it('release / handoff / activate / close 都不提升', () => {
    for (const action of ['release', 'handoff', 'activate', 'close']) {
      const state = fold(
        toolCall('c1', 'webpage_tabs', { action, session_id: 's1' }),
        toolResult('c1'),
      )
      expect(state.coreOpened).toBe(false)
    }
  })

  it('加载入口按请求展开，枚举外名字不进状态', () => {
    const state = fold(
      toolCall('c1', 'webpage_tools', { tools: ['webpage_console', 'webpage_find', 'webpage_snapshot'] }),
      toolResult('c1'),
    )
    expect(state.loaded).toEqual(['webpage_console', 'webpage_find'])
    expect(state.coreOpened).toBe(false)
  })

  it('加载失败（未知名整次拒绝）不加载任何工具', () => {
    const state = fold(
      toolCall('c1', 'webpage_tools', { tools: ['webpage_find', 'webpage_snapshot'] }),
      toolResult('c1', true),
    )
    expect(state.loaded).toEqual([])
    expect(state.pending).toEqual({})
  })

  it('重复加载幂等：loaded 去重有序', () => {
    const state = fold(
      toolCall('c1', 'webpage_tools', { tools: ['webpage_find'] }),
      toolResult('c1'),
      toolCall('c2', 'webpage_tools', { tools: ['webpage_find', 'webpage_locate'] }),
      toolResult('c2'),
    )
    expect(state.loaded).toEqual(['webpage_find', 'webpage_locate'])
  })

  it('没有配对的 result 不结算；来路不明的 result 被忽略', () => {
    const orphan = fold(toolResult('c9'))
    expect(orphan).toEqual(initialDisclosureState())
    const dangling = fold(toolCall('c1', 'webpage_open', { url: 'https://example.com/' }))
    expect(dangling.coreOpened).toBe(false)
    expect(Object.keys(dangling.pending)).toEqual(['c1'])
  })

  it('畸形 arguments 不记 pending', () => {
    const state = fold({ type: 'tool/call', data: { callId: 'c1', name: 'webpage_tools', arguments: '{oops' } })
    expect(state).toEqual(initialDisclosureState())
  })

  it('空 / 全未知名的加载调用不记 pending', () => {
    const empty = fold(toolCall('c1', 'webpage_tools', { tools: [] }), toolResult('c1'))
    expect(empty).toEqual(initialDisclosureState())
    const unknown = fold(toolCall('c2', 'webpage_tools', { tools: ['webpage_snapshot'] }))
    expect(unknown).toEqual(initialDisclosureState())
  })

  it('无关事件原样返回同一引用', () => {
    const state = initialDisclosureState()
    for (const event of [
      { type: 'user/message', data: {} },
      { type: 'assistant/message', data: {} },
      { type: 'tool/call', data: { callId: 'c1', name: 'webpage_click', arguments: '{}' } },
      { type: 'tool/result', data: { message: {} } },
      { type: 'tool/call', data: { name: 'webpage_open', arguments: '{}' } },
    ]) {
      expect(advanceDisclosureState(state, event)).toBe(state)
    }
  })

  it('状态是纯 JSON：可 structuredClone 往返', () => {
    const state = fold(
      toolCall('c1', 'webpage_open', { url: 'https://example.com/' }),
      toolResult('c1'),
      toolCall('c2', 'webpage_tools', { tools: ['webpage_find'] }),
      toolResult('c2'),
      toolCall('c3', 'webpage_tabs', { action: 'claim', session_id: 's2' }),
    )
    expect(structuredClone(state)).toEqual(state)
  })
})

describe('披露投影：注册与恢复', () => {
  it('注册表面：key、版本、init 与 fold 串联', () => {
    const definitions: Parameters<SessionProjectionRegistryLike['register']>[0][] = []
    const registry: SessionProjectionRegistryLike = {
      register: definition => { definitions.push(definition); return () => undefined },
      stateOf: () => undefined,
    }
    const projection = registerDisclosureProjection(registry)
    expect(typeof projection.dispose).toBe('function')
    const definition = definitions[0]
    expect(definition?.key).toBe(DISCLOSURE_PROJECTION_KEY)
    expect(definition?.stateVersion).toBe(DISCLOSURE_PROJECTION_STATE_VERSION)
    let state = definition?.init({}, 0)
    expect(state).toEqual(initialDisclosureState())
    state = definition?.apply(state, toolCall('c1', 'webpage_open', { url: 'https://example.com/' }))
    state = definition?.apply(state, toolResult('c1'))
    expect((state as DisclosureProjectionState).coreOpened).toBe(true)
  })

  it('stateSchema 拒绝坏形状，接受本 fold 产出的状态', () => {
    const definitions: Parameters<SessionProjectionRegistryLike['register']>[0][] = []
    registerDisclosureProjection({
      register: definition => { definitions.push(definition); return () => undefined },
      stateOf: () => undefined,
    })
    const schema = definitions[0]?.stateSchema
    const good = fold(toolCall('c1', 'webpage_open', {}), toolResult('c1'))
    expect(schema?.parse(good)).toEqual(good)
    expect(() => schema?.parse({ coreOpened: 'yes', loaded: [] })).toThrow()
    expect(() => schema?.parse(null)).toThrow()
    expect(() => schema?.parse({ coreOpened: true, loaded: [1] })).toThrow()
  })

  it('句柄到手后读口切到 handle.stateOf，未到手才用弃用的注册表级读', () => {
    const reads: string[] = []
    const projected = { coreOpened: true, loaded: ['webpage_find'], pending: {} }
    // 上游的注册返回值是「disposer + thenable」，句柄经 then 异步交付；
    // 桩用一个可推迟的 then 精确复现这两个时刻。
    let deliver: ((handle: ProjectionHandleLike) => unknown) | undefined
    const registry: SessionProjectionRegistryLike = {
      register: () => Object.assign(() => undefined, {
        then: (onFulfilled: (handle: ProjectionHandleLike) => unknown) => {
          deliver = onFulfilled
          return undefined
        },
      }),
      stateOf: () => { reads.push('registry'); return undefined },
    }
    const projection = registerDisclosureProjection(registry)
    expect(projection.stateOf({ id: 's1' })).toBeUndefined()
    expect(reads).toEqual(['registry'])
    deliver?.({ stateOf: () => { reads.push('handle'); return projected } })
    expect(projection.stateOf({ id: 's1' })).toBe(projected)
    expect(reads).toEqual(['registry', 'handle'])
  })

  it('注册失败（thenable 拒绝）留痕而不是静默丢恢复能力', async () => {
    const warnings: string[] = []
    registerDisclosureProjection({
      register: () => Object.assign(() => undefined, {
        then: (onFulfilled: (handle: ProjectionHandleLike) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.reject(new Error('同名投影已在更高版本注册')).then(onFulfilled, onRejected),
      }),
    }, message => { warnings.push(message) })
    // 拒绝经一个微任务才落到我们的 onRejected 上。
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings.some(message => message.includes('registration failed'))).toBe(true)
  })

  it('读不到（无注册表 / 无会话 / 无状态）时返回 undefined，不抛', () => {
    const projection = registerDisclosureProjection({ register: () => () => undefined, stateOf: () => undefined })
    expect(restoreDisclosureState(undefined, {})).toBeUndefined()
    expect(restoreDisclosureState(projection, undefined)).toBeUndefined()
    expect(restoreDisclosureState(projection, {})).toBeUndefined()
  })

  it('读失败留痕并退化，不把异常抛给调用方', () => {
    const warnings: string[] = []
    const projection = registerDisclosureProjection({
      register: () => () => undefined,
      stateOf: () => { throw new Error('投影缓存行损坏') },
    })
    const restored = restoreDisclosureState(
      projection,
      { id: 's1' },
      message => { warnings.push(message) },
    )
    expect(restored).toBeUndefined()
    expect(warnings.some(message => message.includes('disclosure restore failed'))).toBe(true)
  })
})
