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

const SESSION = { id: 's1', url: 'https://example.com/', title: 'Example', epoch: 4 }

interface Agent {
  readonly id: string
  readonly ctx: unknown
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
  emit(event: string, payload: unknown): void
  visible(agent: Agent): string[]
  prompt(agent: Agent): string
  run(agent: Agent, toolName: string, args: Record<string, unknown>): Promise<unknown>
  /** 让 `webpage_open` 失败，用来验证「失败不提升」。 */
  failOpen: boolean
  /** `apply()` 之前就已存在的对话（不派发 agent/created）。 */
  existing: Agent[]
}

function mount(config: Config = {}, preExisting: readonly string[] = []): TestBed {
  const tools = new Map<string, ToolDefinition>()
  const hidden = new Map<object, Set<string>>()
  const restrictCalls: { agent: string; deny: string[] }[] = []
  const disposals: string[] = []
  const warnings: string[] = []
  const listeners = new Map<string, ((payload: unknown) => unknown)[]>()
  const agents: Agent[] = []
  let sections: { text: unknown }[] = []
  /** 造一个对话：scoped `restrict` 只作用于它自己的 hidden。 */
  const record = (id: string): Agent => {
    const set = new Set<string>()
    const agent: Agent = {
      id,
      ctx: {
        tools: {
          restrict: ({ deny }: { deny?: readonly string[] }) => {
            if (bed.failRestrict) throw new Error('restrict 不可用（桩）')
            const names = [...deny ?? []]
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
    createAgent(id: string): Agent {
      const agent = record(id)
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
  }
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (name: string, scope?: unknown) => {
        const set = scope === undefined ? undefined : hidden.get(scope as object)
        return set !== undefined && set.has(name) ? undefined : tools.get(name)
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
    effect: () => () => undefined,
    on: (event: string, listener: (payload: unknown) => unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => undefined
    },
    get: (key: string) => key === 'agents' ? { list: () => agents } : undefined,
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
    expect(bed.restrictCalls).toHaveLength(1)
    expect(bed.restrictCalls[0]?.deny).not.toContain('webpage_tools')
  })

  it('open 成功展开基础组；只装一次屏蔽，旧屏蔽先释放', async () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    await bed.run(alice, 'webpage_open', { url: 'https://example.com/' })
    expect(bed.visible(alice)).toEqual([
      'webpage_click', 'webpage_execute', 'webpage_fill', 'webpage_navigate', 'webpage_open',
      'webpage_press', 'webpage_snapshot', 'webpage_tabs', 'webpage_tools', 'webpage_wait',
    ])
    expect(bed.restrictCalls).toHaveLength(2)
    expect(bed.disposals).toEqual(['alice'])
  })

  it('open 失败不提升：模型仍停在初始四项', async () => {
    const bed = mount()
    bed.failOpen = true
    const alice = bed.createAgent('alice')
    await expect(bed.run(alice, 'webpage_open', { url: 'https://example.com/' })).rejects.toThrow()
    expect(bed.visible(alice)).toEqual(INITIAL_STAGE)
    expect(bed.restrictCalls).toHaveLength(1)
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
    expect(bed.restrictCalls.map(call => call.agent)).toEqual(['alice', 'bob', 'alice'])
  })

  it('对话销毁释放屏蔽，不留下别人的限制', () => {
    const bed = mount()
    const alice = bed.createAgent('alice')
    bed.emit('agent/disposed', { agent: alice })
    expect(bed.disposals).toEqual(['alice'])
    expect(bed.hidden.get(alice)?.size).toBe(0)
  })

  it('插件加载前就存在的对话由 attachExisting 接管（热加载也只看到初始组）', () => {
    const bed = mount({}, ['older'])
    const older = bed.existing[0]
    expect(older).toBeDefined()
    expect(bed.restrictCalls.map(call => call.agent)).toEqual(['older'])
    expect(bed.visible(older!)).toEqual(INITIAL_STAGE)
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
