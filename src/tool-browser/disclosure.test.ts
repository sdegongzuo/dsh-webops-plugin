/**
 * 逐步披露的契约测试：状态属于对话、只展开不回缩、其他插件不受影响。
 *
 * 桩按「宿主可见性解析器」的形状搭：`tools.get(name, scope)` 反映该对话被
 * `restrict` 之后的可见集合（与模型工具清单、lookup、dispatch 同一份判据），
 * 因此这里的断言就是模型下一步真正看到的工具集。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, type Config } from './index.ts'
import { WEBPAGE_LOADABLE_TOOLS } from './disclosure.ts'
import {
  DISCLOSURE_PROJECTION_KEY,
  type SessionProjectionRegistryLike,
} from './disclosure-projection.ts'

const SESSION = { id: 's1', url: 'https://example.com/', title: 'Example', epoch: 4 }

interface Agent {
  readonly id: string
  readonly ctx: unknown
  /** 宿主 Session：投影按它隔离；每个对话一个独立对象。 */
  readonly session: unknown
}

/**
 * 宿主投影注册表的测试替身：按「注册定义 + 每会话事件日志」重放 fold。
 *
 * 它不用第二套语义 —— `stateOf` 走的是本插件注册时交上去的 `init` / `apply`，
 * 因此这条链路同时验了「注册表面可用」与「播种读的是投影」。
 */
class FakeProjections implements SessionProjectionRegistryLike {
  readonly definitions = new Map<string, Parameters<SessionProjectionRegistryLike['register']>[0]>()
  readonly disposals: string[] = []
  /** 每个会话已提交的事件日志（重启前发生的事都在这里）。 */
  readonly logs = new Map<unknown, { type: string; data: unknown }[]>()
  /** 注入故障：让 `stateOf` 抛错。 */
  failRead = false

  register(definition: Parameters<SessionProjectionRegistryLike['register']>[0]): () => void {
    this.definitions.set(definition.key, definition)
    return () => {
      this.disposals.push(definition.key)
      this.definitions.delete(definition.key)
    }
  }

  /** 提交一条会话事件（宿主在工具结果入日志时做等价的事）。 */
  commit(session: unknown, event: { type: string; data: unknown }): void {
    const log = this.logs.get(session) ?? []
    log.push(event)
    this.logs.set(session, log)
  }

  stateOf(session: unknown, key: string): unknown {
    if (this.failRead) throw new Error('投影缓存行损坏（桩）')
    const definition = this.definitions.get(key)
    if (definition === undefined) return undefined
    let state = definition.init({}, 0)
    for (const event of this.logs.get(session) ?? []) state = definition.apply(state, event)
    return state
  }
}

/** 宿主 `tool/call` 事件（字段与上游一致）。 */
function toolCall(callId: string, name: string, args: unknown): { type: 'tool/call'; data: unknown } {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } }
}

/** 宿主 `tool/result` 事件。 */
function toolResult(callId: string, isError = false): { type: 'tool/result'; data: unknown } {
  return { type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: callId, isError } } }
}

interface TestBed {
  readonly tools: Map<string, ToolDefinition>
  /** 每个对话被屏蔽的工具名；`restrict` 写它，disposer 清它。 */
  readonly hidden: Map<object, Set<string>>
  readonly restrictCalls: { agent: string; deny: string[] }[]
  readonly disposals: string[]
  /** `restrict` 抛错时的留痕：屏蔽装不上必须可见，不能静默。 */
  readonly warnings: string[]
  /** 让 `restrict` 抛错，验证失败不静默也不阻断。 */
  failRestrict: boolean
  createAgent(id: string): Agent
  /** 重启 / fork：复用旧 session 对象新建 agent，恢复只能来自投影。 */
  createRestoredAgent(id: string, session: unknown): Agent
  emit(event: string, payload: unknown): void
  visible(agent: Agent): string[]
  /** 宿主内置工具在该对话里还剩哪些可见 —— 屏蔽是否真的落到宿主工具上。 */
  hostVisible(agent: Agent): string[]
  prompt(agent: Agent): string
  run(agent: Agent, toolName: string, args: Record<string, unknown>): Promise<unknown>
  /** 让 `webpage_open` 失败，用来验证「失败不提升」。 */
  failOpen: boolean
  /** `apply()` 之前就已存在的对话（不派发 agent/created）。 */
  existing: Agent[]
  /** 宿主投影注册表替身；`null` 表示部署未组装投影服务。 */
  projections: FakeProjections | null
  /** 跑一遍插件卸载的清理（屏蔽、内存状态、投影注册）。 */
  unload(): void
}

function mount(
  config: Config = {},
  preExisting: readonly string[] = [],
  projections: FakeProjections | null = new FakeProjections(),
  /** 模拟宿主已注册的内置工具（真实宿主有 `web_fetch`）；空数组表示宿主没这个工具。 */
  hostTools: readonly string[] = ['web_fetch'],
): TestBed {
  const tools = new Map<string, ToolDefinition>()
  /** 宿主内置工具名：不在 `tools` 里，但在同一条可见性继承面上。 */
  const builtin = new Set<string>(hostTools)
  const hidden = new Map<object, Set<string>>()
  const restrictCalls: { agent: string; deny: string[] }[] = []
  const disposals: string[] = []
  const warnings: string[] = []
  const listeners = new Map<string, ((payload: unknown) => unknown)[]>()
  const cleanups: (() => void)[] = []
  const agents: Agent[] = []
  let sections: { text: unknown }[] = []
  /** 造一个对话：scoped `restrict` 只作用于它自己的 hidden。 */
  const record = (id: string, session: unknown = { id }): Agent => {
    const set = new Set<string>()
    const agent: Agent = {
      id,
      session,
      ctx: {
        tools: {
          restrict: ({ deny }: { deny?: readonly string[] }) => {
            if (bed.failRestrict) throw new Error('restrict 不可用（桩）')
            const names = [...deny ?? []]
            // 真实宿主的行为：`restrict` 只认继承面上的工具名，混进未知名整次调用失败。
            const unknown = names.filter(name => !tools.has(name) && !builtin.has(name))
            if (unknown.length > 0) throw new Error(`unknown tool: ${unknown.join(', ')}`)
            restrictCalls.push({ agent: id, deny: names })
            for (const name of names) set.add(name)
            return () => {
              disposals.push(id)
              for (const name of names) set.delete(name)
            }
          },
        },
      },
    }
    hidden.set(agent, set)
    return agent
  }
  const bed: TestBed = {
    tools,
    hidden,
    restrictCalls,
    disposals,
    warnings,
    failOpen: false,
    failRestrict: false,
    existing: [],
    projections,
    createAgent(id: string): Agent {
      const agent = record(id)
      agents.push(agent)
      bed.emit('agent/created', { agent })
      return agent
    },
    /**
     * 重启 / fork 后的对话：复用**上一代进程的同一个 session 对象**（日志里
     * 已有历史事件），agent 与 scoped ctx 都是新建的 —— 恢复只能来自投影。
     */
    createRestoredAgent(id: string, session: unknown): Agent {
      const agent = record(id, session)
      agents.push(agent)
      bed.emit('agent/created', { agent })
      return agent
    },
    emit(event: string, payload: unknown): void {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    visible(agent: Agent): string[] {
      const set = hidden.get(agent) ?? new Set<string>()
      return [...tools.keys()].filter(name => !set.has(name)).sort()
    },
    hostVisible(agent: Agent): string[] {
      const set = hidden.get(agent) ?? new Set<string>()
      return [...builtin].filter(name => !set.has(name)).sort()
    },
    prompt(agent: Agent): string {
      const section = sections[0]
      return (section?.text as (context: { scope: unknown }) => string)({ scope: agent })
    },
    run(agent: Agent, toolName: string, args: Record<string, unknown>): Promise<unknown> {
      const definition = tools.get(toolName)
      if (definition === undefined) throw new Error(`${toolName} 未注册`)
      const exec = { signal: new AbortController().signal, agent, token: Symbol(toolName) } as unknown as ToolRunContext
      return definition.execute(args, exec)
    },
    unload(): void {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (name: string, scope?: unknown) => {
        const set = scope === undefined ? undefined : hidden.get(scope as object)
        if (set !== undefined && set.has(name)) return undefined
        // 宿主内置工具也在继承面上，只是定义不归本插件管：判据只需「能不能解析到」。
        return tools.get(name) ?? (builtin.has(name) ? { name } as ToolDefinition : undefined)
      },
    },
    systemPrompt: {
      section: (section: { name: string; order: number; text: unknown }) => {
        sections.push(section)
        return () => undefined
      },
    },
    browser: {
      onLeaseRelease: () => () => undefined,
      reobserveRequired: () => [],
      open: () => bed.failOpen ? Promise.reject(new Error('BROWSER_NAVIGATION_FAILED')) : Promise.resolve(SESSION),
      tabs: (request: { kind: string; sessionId?: string }) => Promise.resolve({
        action: request.kind,
        ...request.sessionId !== undefined ? { sessionId: request.sessionId } : {},
        tabs: [],
      }),
    },
    attachments: { saveImage: () => Promise.resolve({}) },
    // 兼容 cordis effect 的两种形态：纯工厂（返回 disposer）与 generator
    // （yield 出一串 disposer）。这里不跑 generator 本体，只在卸载时驱动它。
    effect: (factory: () => unknown) => {
      const produced = factory()
      const cleanup = typeof produced === 'function'
        ? produced as () => void
        : () => {
          if (produced !== null && typeof produced === 'object' && Symbol.iterator in produced) {
            for (const dispose of produced as Iterable<(() => void) | undefined>) dispose?.()
          }
        }
      cleanups.push(cleanup)
      return cleanup
    },
    on: (event: string, listener: (payload: unknown) => unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => undefined
    },
    get: (key: string) => {
      if (key === 'agents') return { list: () => agents }
      if (key === 'sessionProjections') return projections ?? undefined
      return undefined
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
  } as unknown as Context
  sections = []
  // 插件加载晚于 agent 创建时的形态：这些对话只出现在列表里，不会有 agent/created。
  const existing = preExisting.map(id => {
    const agent = record(id)
    agents.push(agent)
    return agent
  })
  apply(ctx, config)
  bed.existing = existing
  return bed
}

const INITIAL_STAGE = ['webpage_execute', 'webpage_open', 'webpage_tabs', 'webpage_tools']

describe('逐步披露：工具按对话分阶段可见', () => {
  it('新建对话只看到初始四项，加载入口始终可见', () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    expect(bed.visible(alice)).toEqual(INITIAL_STAGE)
    // 两次：网页工具披露一次、宿主内置抓取工具一次（后者不随阶段变化）。
    expect(bed.restrictCalls).toHaveLength(2)
    expect(bed.restrictCalls[0]?.deny).not.toContain('webpage_tools')
  })

  it('宿主内置的 web_fetch 一起被屏蔽，网页工具清单不受影响', () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    expect(bed.hostVisible(alice)).toEqual([])
    expect(bed.restrictCalls.filter(call => call.deny.includes('web_fetch'))).toHaveLength(1)
    expect(bed.visible(alice)).toEqual(INITIAL_STAGE)
  })

  it('配置 hideHostWebFetch=false 时保留宿主 web_fetch', () => {
    const bed = mount({ hideHostWebFetch: false })
    const alice = bed.createAgent('alice')
    expect(bed.hostVisible(alice)).toEqual(['web_fetch'])
    expect(bed.restrictCalls.some(call => call.deny.includes('web_fetch'))).toBe(false)
  })

  it('宿主没有 web_fetch 时留痕，且不牵连网页工具的屏蔽', () => {
    const bed = mount({}, [], new FakeProjections(), [])
    const alice = bed.createAgent('alice')
    expect(bed.warnings.some(message => message.includes('host tool mask failed'))).toBe(true)
    // 反向验证：未知名若混进网页工具那次 restrict，整批屏蔽会被打掉（16 项全可见）。
    expect(bed.visible(alice)).toEqual(INITIAL_STAGE)
    expect(bed.restrictCalls.every(call => !call.deny.includes('web_fetch'))).toBe(true)
  })

  it('提示只在 web_fetch 真的看不见时说它不可用', () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    expect(bed.prompt(alice)).toContain('web_fetch is unavailable here')
    bed.failRestrict = true
    const bob = bed.createAgent('bob')
    expect(bed.prompt(bob)).not.toContain('web_fetch is unavailable')
  })

  it('open 成功展开基础组；只装一次屏蔽，旧屏蔽先释放', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    await bed.run(alice, 'webpage_open', { url: 'https://example.com/' })
    expect(bed.visible(alice)).toEqual([
      'webpage_click', 'webpage_execute', 'webpage_fill', 'webpage_navigate', 'webpage_open',
      'webpage_press', 'webpage_snapshot', 'webpage_tabs', 'webpage_tools', 'webpage_wait',
    ])
    // 创建时 2 次（网页 + 宿主），open 成功重算网页那次（先释放旧的）。
    expect(bed.restrictCalls).toHaveLength(3)
    expect(bed.disposals).toEqual(['alice'])
  })

  it('open 失败不提升：模型仍停在初始四项', async () => {
    const bed = mount()
    bed.failOpen = true
    const alice = bed.createAgent('alice')
    await expect(bed.run(alice, 'webpage_open', { url: 'https://example.com/' })).rejects.toThrow()
    expect(bed.visible(alice)).toEqual(INITIAL_STAGE)
    expect(bed.restrictCalls).toHaveLength(2)
  })

  it('claim 成功才提升，list 不算进入网页任务', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    const bob = bed.createAgent('bob')
    await bed.run(alice, 'webpage_tabs', { action: 'list' })
    expect(bed.visible(alice)).toEqual(INITIAL_STAGE)
    await bed.run(bob, 'webpage_tabs', { action: 'claim', session_id: 's1' })
    expect(bed.visible(bob)).toContain('webpage_snapshot')
    expect(bed.visible(alice)).toEqual(INITIAL_STAGE)
  })

  it('加载入口只展开请求到的工具，且不会顺带展开基础组', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    const value = await bed.run(alice, 'webpage_tools', { tools: ['webpage_find'] }) as { loaded: string[]; visible: string[] }
    expect(value.loaded).toEqual(['webpage_find'])
    expect(bed.visible(alice)).toEqual(['webpage_execute', 'webpage_find', 'webpage_open', 'webpage_tabs', 'webpage_tools'])
    expect(value.visible).not.toContain('webpage_snapshot')
  })

  it('一次可以列出多项，console 与 network 互不捆绑', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    await bed.run(alice, 'webpage_tools', { tools: ['webpage_console', 'webpage_screenshot'] })
    expect(bed.visible(alice)).toEqual([
      'webpage_console', 'webpage_execute', 'webpage_open', 'webpage_screenshot', 'webpage_tabs', 'webpage_tools',
    ])
  })

  it('重复加载幂等，回执区分新增与此前已可见', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    const first = await bed.run(alice, 'webpage_tools', { tools: ['webpage_find'] }) as { loaded: string[]; already_visible: string[] }
    const second = await bed.run(alice, 'webpage_tools', { tools: ['webpage_find', 'webpage_locate'] }) as { loaded: string[]; already_visible: string[] }
    expect(first.loaded).toEqual(['webpage_find'])
    expect(second.loaded).toEqual(['webpage_locate'])
    expect(second.already_visible).toEqual(['webpage_find'])
  })

  it('未知名整次拒绝，且不加载任何工具', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    await expect(bed.run(alice, 'webpage_tools', { tools: ['webpage_find', 'webpage_snapshot'] }))
      .rejects.toThrow(/BROWSER_INVALID_PARAMS/)
    expect(bed.visible(alice)).toEqual(INITIAL_STAGE)
    await expect(bed.run(alice, 'webpage_tools', { tools: [] })).rejects.toThrow(/BROWSER_INVALID_PARAMS/)
  })

  it('照其他工具的样子带上 session_id 不被拒绝，仍然只展开请求到的工具', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    const value = await bed.run(alice, 'webpage_tools', { tools: ['webpage_find'], session_id: 's1' }) as { loaded: string[] }
    expect(value.loaded).toEqual(['webpage_find'])
    expect(bed.visible(alice)).toContain('webpage_find')
    // 只放宽这一个字段：其他未知字段照样整次拒绝。
    await expect(bed.run(alice, 'webpage_tools', { tools: ['webpage_locate'], tab: 't1' }))
      .rejects.toThrow(/BROWSER_INVALID_PARAMS/)
    expect(bed.visible(alice)).not.toContain('webpage_locate')
  })

  it('配置关掉的工具不谎报成已加载', async () => {
    const bed = mount({ find: false })
    const alice = bed.createAgent('alice')
    const value = await bed.run(alice, 'webpage_tools', { tools: ['webpage_find'] }) as { loaded: string[]; visible: string[] }
    expect(value.loaded).toEqual([])
    expect(bed.visible(alice)).not.toContain('webpage_find')
  })

  it('加载过的工具不回缩：同一对话后续请求仍然可见', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    await bed.run(alice, 'webpage_tools', { tools: ['webpage_locate'] })
    await bed.run(alice, 'webpage_open', { url: 'https://example.com/' })
    expect(bed.visible(alice)).toContain('webpage_locate')
    expect(bed.visible(alice)).toContain('webpage_snapshot')
  })

  it('两个对话互不影响：一个加载不影响另一个的可见集', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    const bob = bed.createAgent('bob')
    await bed.run(alice, 'webpage_tools', { tools: ['webpage_console'] })
    expect(bed.visible(alice)).toContain('webpage_console')
    expect(bed.visible(bob)).toEqual(INITIAL_STAGE)
    expect(bed.restrictCalls.map(call => call.agent)).toEqual(['alice', 'alice', 'bob', 'bob', 'alice'])
  })

  it('对话销毁释放屏蔽，不留下别人的限制', () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    bed.emit('agent/disposed', { agent: alice })
    // 网页披露一层、宿主内置一层，两层都要释放。
    expect(bed.disposals).toEqual(['alice', 'alice'])
    expect(bed.hidden.get(alice)?.size).toBe(0)
    expect(bed.hostVisible(alice)).toEqual(['web_fetch'])
  })

  it('插件加载前就存在的对话由 attachExisting 接管（热加载也只看到初始组）', () => {
    const bed = mount({}, ['older'])
    const older = bed.existing[0]
    expect(older).toBeDefined()
    expect(bed.restrictCalls.map(call => call.agent)).toEqual(['older', 'older'])
    expect(bed.visible(older!)).toEqual(INITIAL_STAGE)
    expect(bed.hostVisible(older!)).toEqual([])
  })

  it('装不上屏蔽时不静默：留痕并退化为全可见，不阻断插件', () => {
    const bed = mount()
    bed.failRestrict = true
    const alice = bed.createAgent('alice')
    expect(bed.warnings.some(message => message.includes('disclosure mask failed'))).toBe(true)
    expect(bed.visible(alice)).toContain('webpage_snapshot')
  })

  it('提示只讲当前可见的工具，初始阶段给出加载办法', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    const initial = bed.prompt(alice)
    expect(initial).toContain('Webpage tools appear in stages')
    expect(initial).toContain('webpage_tools(tools=["webpage_find"])')
    expect(initial).not.toContain('webpage_snapshot gives a compact accessibility outline')
    await bed.run(alice, 'webpage_open', { url: 'https://example.com/' })
    const upgraded = bed.prompt(alice)
    expect(upgraded).toContain('webpage_snapshot gives a compact accessibility outline')
    expect(upgraded).not.toContain('Webpage tools appear in stages')
  })

  it('可加载清单与加载入口的枚举一致', () => {
    const bed = mount()
    const parameters = bed.tools.get('webpage_tools')?.parameters as { properties: { tools: { items?: { enum?: string[] } } } }
    expect(parameters.properties.tools.items?.enum).toEqual([...WEBPAGE_LOADABLE_TOOLS])
  })
})

describe('逐步披露：投影恢复（重启 / fork / 重载）', () => {
  it('注册了投影：key 与版本随插件装载落到宿主注册表', () => {
    const bed = mount()
    expect(bed.projections?.definitions.has(DISCLOSURE_PROJECTION_KEY)).toBe(true)
  })

  it('重启后恢复：新对话从投影拿回已展开的状态，不用重新加载', () => {
    const projections = new FakeProjections()
    const bed = mount({}, [], projections)
    // 上一代进程里发生过的事：open 成功 + 加载过 find。
    const session = { id: 'restarted' }
    projections.commit(session, toolCall('c1', 'webpage_open', { url: 'https://example.com/' }))
    projections.commit(session, toolResult('c1'))
    projections.commit(session, toolCall('c2', 'webpage_tools', { tools: ['webpage_find'] }))
    projections.commit(session, toolResult('c2'))
    // 重启后的新对话：同样一个 session 对象，agent 是新建的。
    const agent = bed.createRestoredAgent('restarted', session)
    expect(bed.visible(agent)).toContain('webpage_snapshot')
    expect(bed.visible(agent)).toContain('webpage_find')
    expect(bed.visible(agent)).not.toContain('webpage_console')
  })

  it('fork 出的对话只拿到继承前缀里的提升：加载过 find 但没 open 就没有基础组', () => {
    const projections = new FakeProjections()
    const bed = mount({}, [], projections)
    const session = { id: 'forked' }
    projections.commit(session, toolCall('c1', 'webpage_tools', { tools: ['webpage_find'] }))
    projections.commit(session, toolResult('c1'))
    const agent = bed.createRestoredAgent('forked', session)
    expect(bed.visible(agent)).toContain('webpage_find')
    expect(bed.visible(agent)).not.toContain('webpage_snapshot')
  })

  it('失败调用不进投影：重启后不会恢复未成功的提升', () => {
    const projections = new FakeProjections()
    const bed = mount({}, [], projections)
    const session = { id: 'failed' }
    projections.commit(session, toolCall('c1', 'webpage_open', { url: 'https://example.com/' }))
    projections.commit(session, toolResult('c1', true))
    const agent = bed.createRestoredAgent('failed', session)
    expect(bed.visible(agent)).toEqual(INITIAL_STAGE)
  })

  it('播种只发生一次：投影后来的事件不覆盖内存里已展开的状态', async () => {
    const projections = new FakeProjections()
    const bed = mount({}, [], projections)
    const alice = bed.createAgent('alice')
    await bed.run(alice, 'webpage_tools', { tools: ['webpage_console'] })
    // 播种之后再往日志里补事件（真实里对应别的进程/回放路径），不得回缩或改判。
    projections.commit(alice.session, toolCall('c9', 'webpage_open', { url: 'https://example.com/' }))
    projections.commit(alice.session, toolResult('c9'))
    expect(bed.visible(alice)).not.toContain('webpage_snapshot')
    expect(bed.visible(alice)).toContain('webpage_console')
  })

  it('投影缺位时退化为纯内存披露：open 仍然展开，不报错', async () => {
    const bed = mount({}, [], null)
    expect(bed.projections).toBeNull()
    const alice = bed.createAgent('alice')
    await bed.run(alice, 'webpage_open', { url: 'https://example.com/' })
    expect(bed.visible(alice)).toContain('webpage_snapshot')
  })

  it('投影读失败留痕并退化，不把异常抛给 agent 创建流程', () => {
    const projections = new FakeProjections()
    projections.failRead = true
    const bed = mount({}, [], projections)
    const alice = bed.createAgent('alice')
    expect(bed.warnings.some(message => message.includes('disclosure restore failed'))).toBe(true)
    expect(bed.visible(alice)).toEqual(INITIAL_STAGE)
  })

  it('插件卸载释放投影注册、屏蔽与内存状态', () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    bed.unload()
    expect(bed.projections?.disposals).toContain(DISCLOSURE_PROJECTION_KEY)
    expect(bed.projections?.definitions.has(DISCLOSURE_PROJECTION_KEY)).toBe(false)
    expect(bed.disposals).toEqual(['alice', 'alice'])
    expect(bed.hidden.get(alice)?.size).toBe(0)
    expect(bed.hostVisible(alice)).toEqual(['web_fetch'])
  })
})
