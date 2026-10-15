/**
 * 网页工具的逐步披露：分阶段可见性。
 *
 * 三条不变式（定案见 docs/工具逐步披露设计.md）：
 * 1. 状态属于**对话**（宿主 agent scope），不属于窗口或插件全局；同一对话只展开、不回缩。
 * 2. 只屏蔽**本插件自己注册**的网页工具，不动其他插件，也不用 allow 列表。
 * 3. 屏蔽变更在工具返回前完成 —— 下一次模型请求必须看到新工具集合。
 *
 * 对话身份按结构化取值，不 import `@deepseek-ai/dsh-agent`：该包是上游运行时类型，
 * 本仓只依赖它的字段语义（与 `tool-runtime.ts` 的 `callerOf` 同一口径）。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 加载入口工具名：初始就可见，用来展开其余按需工具。 */
export const WEBPAGE_LOADER_TOOL = 'webpage_tools'

/** 首次进入网页任务就可见的工具（不含加载入口）。 */
export const WEBPAGE_INITIAL_KEYS = ['open', 'tabs', 'execute'] as const

/** open 或 claim **成功**之后自动展开的基础操作。 */
export const WEBPAGE_BASE_KEYS = ['navigate', 'snapshot', 'click', 'fill', 'press', 'wait'] as const

/** 只能逐项加载的工具：搜索、滚动、定位、视觉、控制台、网络。 */
export const WEBPAGE_LOADABLE_KEYS = ['find', 'scroll', 'locate', 'screenshot', 'console', 'network'] as const

/** 加载入口接受的工具名（顺序即文档顺序）。 */
export const WEBPAGE_LOADABLE_TOOLS: readonly string[] =
  WEBPAGE_LOADABLE_KEYS.map(key => webpageToolName(key))

/** 配置键 → 工具名。 */
export function webpageToolName(key: string): string {
  return `webpage_${key}`
}

/** 对话身份的最小形状：只要对象同一性（WeakMap 键）与 scoped ctx。 */
export interface DisclosureAgent {
  readonly id?: unknown
  readonly ctx?: Context
}

/** 一次加载的结果：本次真正新增的、以及此前已可见的。 */
export interface LoadResult {
  readonly added: readonly string[]
  readonly already: readonly string[]
}

/** 每个对话的披露状态。 */
interface AgentState {
  coreOpened: boolean
  readonly loaded: Set<string>
}

/** 已知（已注册）工具名在该状态下的可见集合。 */
export function visibleToolNames(
  registered: readonly string[],
  state: Pick<AgentState, 'coreOpened' | 'loaded'>,
): Set<string> {
  const visible = new Set<string>()
  for (const key of WEBPAGE_INITIAL_KEYS) {
    const name = webpageToolName(key)
    if (registered.includes(name)) visible.add(name)
  }
  if (state.coreOpened) {
    for (const key of WEBPAGE_BASE_KEYS) {
      const name = webpageToolName(key)
      if (registered.includes(name)) visible.add(name)
    }
  }
  for (const name of state.loaded) {
    if (registered.includes(name)) visible.add(name)
  }
  visible.add(WEBPAGE_LOADER_TOOL)
  return visible
}

/** 已注册但当前不可见的工具 —— 屏蔽清单（restrict 的 deny）。 */
export function deniedToolNames(registered: readonly string[], visible: ReadonlySet<string>): string[] {
  return registered.filter(name => !visible.has(name))
}

/** 加载请求里不被接受的名字；调用方以此回绝整次加载。 */
export function rejectedLoadNames(names: readonly string[]): string[] {
  return names.filter(name => !WEBPAGE_LOADABLE_TOOLS.includes(name))
}

/** 每个对话可见的网页工具集合；加载入口与 open / claim 的展开都经它。 */
export interface ToolDisclosure {
  /** 本插件本次实际注册的网页工具名（受配置影响）。 */
  readonly registered: readonly string[]
  /** 该对话当前可见的工具名集合。 */
  visible(agent: unknown): ReadonlySet<string>
  /** open / claim 成功：展开基础组。只有实际成功才调用。 */
  markOpened(agent: unknown): void
  /** 加载入口：只展开请求到的工具；返回本次新增与此前已可见。 */
  load(agent: unknown, names: readonly string[]): LoadResult
  /**
   * 给**已经存在**的对话补装屏蔽。
   *
   * 必须在网页工具全部注册**之后**调用：`restrict` 只接受已经可见的全局工具名，
   * 在注册完成前调用会拿不到名字而失败（那时屏蔽会整体失效、退化成全可见）。
   * 之后新建的对话由 `agent/created` 自动接管。
   */
  attachExisting(): void
}

/**
 * 安装逐步披露：给每个对话装 scoped 屏蔽，并接住宿主的 agent 生命周期。
 *
 * 屏蔽用 `agent.ctx.tools.restrict({ deny })` —— 它只过滤该 scope **继承**的工具，
 * 本插件自己注册在 host 层的网页工具都在继承面上，因此可被屏蔽，而其他插件不受影响。
 *
 * @param ctx - 插件上下文。
 * @param registered - 本次实际注册的网页工具名（配置关掉的不要传）。
 * @returns 供 open / claim / 加载入口调用的披露控制器。
 */
export function mountToolDisclosure(ctx: Context, registered: readonly string[]): ToolDisclosure {
  const states = new Map<object, AgentState>()
  /** 当前生效的屏蔽 disposer；变更时先释放旧的，再装新的。 */
  const masks = new Map<object, () => void>()

  const stateOf = (agent: object): AgentState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const fresh: AgentState = { coreOpened: false, loaded: new Set<string>() }
    states.set(agent, fresh)
    return fresh
  }

  const agentOf = (agent: unknown): DisclosureAgent | undefined =>
    agent !== null && typeof agent === 'object' ? agent as DisclosureAgent : undefined

  /** 重新计算并安装该对话的屏蔽；空 deny 只释放不安装（restrict({}) 是错误用法）。 */
  const applyMask = (agent: object): void => {
    const previous = masks.get(agent)
    masks.delete(agent)
    previous?.()
    const deny = deniedToolNames(registered, visibleToolNames(registered, stateOf(agent)))
    if (deny.length === 0) return
    const scopeCtx = (agent as DisclosureAgent).ctx
    if (scopeCtx === undefined) return
    try {
      masks.set(agent, scopeCtx.tools.restrict({ deny }))
    } catch (error: unknown) {
      // 不静默：屏蔽装不上意味着该对话可见全部网页工具（退化为旧行为），必须留痕。
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`webpage-tools: disclosure mask failed for one conversation: ${reason}`)
    }
  }

  const install = (agent: unknown): void => {
    const target = agentOf(agent)
    if (target === undefined) return
    applyMask(target)
  }

  const drop = (agent: unknown): void => {
    const target = agentOf(agent)
    if (target === undefined) return
    states.delete(target)
    const mask = masks.get(target)
    masks.delete(target)
    mask?.()
  }

  ctx.on('agent/created', payload => { install(payload.agent); return undefined })
  ctx.on('agent/disposed', payload => { drop(payload.agent); return undefined })
  // 插件卸载：释放全部屏蔽与状态。
  ctx.effect(() => () => {
    for (const mask of [...masks.values()]) mask()
    masks.clear()
    states.clear()
  }, 'webpage-tools.disclosure')

  return {
    registered,
    visible(agent: unknown): ReadonlySet<string> {
      const target = agentOf(agent)
      if (target === undefined) return new Set(registered)
      return visibleToolNames(registered, stateOf(target))
    },
    markOpened(agent: unknown): void {
      const target = agentOf(agent)
      if (target === undefined) return
      const state = stateOf(target)
      if (state.coreOpened) return
      state.coreOpened = true
      applyMask(target)
    },
    load(agent: unknown, names: readonly string[]): LoadResult {
      const target = agentOf(agent)
      if (target === undefined) return { added: [], already: [] }
      const state = stateOf(target)
      const before = visibleToolNames(registered, state)
      const added: string[] = []
      const already: string[] = []
      for (const name of names) {
        if (!registered.includes(name)) continue // 配置关掉的工具：不加载也不报成功
        if (before.has(name)) { already.push(name); continue }
        if (state.loaded.has(name)) { already.push(name); continue }
        state.loaded.add(name)
        added.push(name)
      }
      if (added.length > 0) applyMask(target)
      return { added, already }
    },
    attachExisting(): void {
      for (const agent of ctx.get('agents')?.list() ?? []) install(agent)
    },
  }
}
