/**
 * 披露状态的持久化与恢复：宿主 `sessionProjections` 上的一个 host-only 投影。
 *
 * 为什么需要它：内存里的披露状态（`disclosure.ts`）随进程消亡，重启 / 重载 /
 * fork 之后模型会被打回初始组，已经加载过的工具要重新加载一遍。定案要求状态
 * 属于**对话**且在重启、压缩、fork 后不丢 —— 宿主的会话投影正是这个载体：
 * 它是按会话隔离的纯 fold，由已提交的会话事件驱动，持久化缓存只是捷径。
 *
 * 三条口径：
 * 1. fold 只看 `tool/call` + `tool/result` 配对：**调用出错不结算**（open 失败
 *    不提升、未知名整次拒绝不加载），与 `disclosure.ts` 的运行期判据同源。
 * 2. 状态必须纯 JSON（宿主投影缓存的前提），`pending` 只留未结算的调用。
 * 3. 不 import 上游类型：本仓不依赖 `@deepseek-ai/dsh-session-projection`，
 *    按结构形状声明用到的注册表面（与 `disclosure.ts` 对 agent 的同一口径）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { WEBPAGE_LOADABLE_TOOLS, WEBPAGE_LOADER_TOOL, webpageToolName } from './disclosure.ts'

/** 投影 key：与宿主自己的投影（modelSelection 等）平级，host-only，无 wire。 */
export const DISCLOSURE_PROJECTION_KEY = 'webpageToolDisclosure'

/**
 * 序列化状态或 fold 语义变更时 +1：宿主持久化缓存行带 `ver`，版本不匹配的行
 * 会被丢弃并从头重折，不会被前向应用成垃圾。
 */
export const DISCLOSURE_PROJECTION_STATE_VERSION = 1

/** 一个待结算的网页工具调用：`tool/call` 已入日志、`tool/result` 未到。 */
interface PendingCall {
  readonly kind: 'open' | 'claim' | 'load'
  /** 仅 `load` 有值：本次请求加载的工具名（已过滤掉枚举外名字）。 */
  readonly tools: readonly string[]
}

/** 投影状态：纯 JSON，`pending` 按 callId 索引未结算调用。 */
export interface DisclosureProjectionState {
  coreOpened: boolean
  /** 已加载工具名，去重且有序（确定性：同样事件序列得到同样状态）。 */
  loaded: string[]
  pending: Record<string, PendingCall>
}

/** 宿主会话事件的最小形状（只取本 fold 用到的字段）。 */
interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

/** 宿主投影注册表的最小形状：宿主实现只用到结构里的这几个成员。 */
export interface SessionProjectionRegistryLike {
  register(definition: {
    key: string
    /** 宿主只在 parse 持久化行时调用；形状不符必须抛错（与 zod 语义一致）。 */
    stateSchema: { parse(value: unknown): unknown }
    init(header: unknown, inheritedEventCount: number): unknown
    apply(state: unknown, event: unknown): unknown
    stateVersion: number
  }): () => void
  stateOf(session: unknown, key: string): unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * 宿主会话投影注册表；部署未组装时为 undefined。
     * 弱取用而非注入：缺它只丢恢复能力，不阻断插件加载。
     */
    readonly sessionProjections?: SessionProjectionRegistryLike
  }
}

/** 空状态：没有网页工具调用过的对话。 */
export function initialDisclosureState(): DisclosureProjectionState {
  return { coreOpened: false, loaded: [], pending: {} }
}

/** 解析 `tool/call` 的原始参数字符串；畸形或非对象按「没有参数」处理。 */
function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 一个 `tool/call` 是否计入披露状态，计入的话记成什么。
 *
 * 与运行期判据逐条对齐：只有 `webpage_open`、`webpage_tabs(action=claim)` 与
 * `webpage_tools` 算；其余动作（list / release / handoff / activate / close）
 * 不进入网页任务，不记录。加载项只收枚举内的名字 —— 未知名在工具层就被整次
 * 拒绝，这里过滤只是让 fold 与回执保持一致。
 */
function pendingCallFor(name: string, rawArguments: unknown): PendingCall | undefined {
  if (name === webpageToolName('open')) return { kind: 'open', tools: [] }
  if (name === webpageToolName('tabs')) {
    return parseArguments(rawArguments)?.action === 'claim' ? { kind: 'claim', tools: [] } : undefined
  }
  if (name === WEBPAGE_LOADER_TOOL) {
    const requested = parseArguments(rawArguments)?.tools
    const tools = Array.isArray(requested)
      ? requested.filter(entry => typeof entry === 'string' && WEBPAGE_LOADABLE_TOOLS.includes(entry))
      : []
    // 一个可加载名字都不剩的调用（空数组 / 全未知名 / 畸形参数）不记录：
    // 它要么被工具层整次拒绝，要么什么也不加载，进状态只会留下垃圾 pending。
    return tools.length === 0 ? undefined : { kind: 'load', tools: [...new Set(tools)].sort() }
  }
  return undefined
}

/**
 * 推进一个会话事件：纯 fold，与事件无关时返回**同一引用**（宿主的零工作量判据）。
 *
 * 配对规则：`tool/call` 记 pending，`tool/result` 按 `toolCallId` 结算 ——
 * `isError` 的结果只清 pending，不改变可见性（失败不提升）。
 *
 * @param state - 事件前的状态。
 * @param event - 一条已提交的会话事件。
 * @returns 事件后的状态；无关事件原样返回。
 */
export function advanceDisclosureState(
  state: DisclosureProjectionState,
  event: SessionEventLike,
): DisclosureProjectionState {
  if (event.type === 'tool/call') {
    const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined
    const callId = typeof data?.callId === 'string' ? data.callId : undefined
    const name = typeof data?.name === 'string' ? data.name : undefined
    if (callId === undefined || name === undefined || data === undefined) return state
    const pending = pendingCallFor(name, data.arguments)
    if (pending === undefined) return state
    return { ...state, pending: { ...state.pending, [callId]: pending } }
  }
  if (event.type === 'tool/result') {
    const message = (event.data as { message?: { toolCallId?: unknown; isError?: unknown } } | undefined)?.message
    const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
    if (callId === undefined) return state
    const entry = state.pending[callId]
    if (entry === undefined) return state
    const pending = { ...state.pending }
    delete pending[callId]
    if (message?.isError === true) return { ...state, pending }
    if (entry.kind === 'load') {
      return {
        coreOpened: state.coreOpened,
        loaded: [...new Set([...state.loaded, ...entry.tools])].sort(),
        pending,
      }
    }
    // open / claim 成功：进入网页任务，基础组展开。
    return { coreOpened: true, loaded: state.loaded, pending }
  }
  return state
}

/** 手写校验：不引 zod（本仓无此依赖），宿主只用 `parse` 一个方法；形状不符抛错。 */
const STATE_SCHEMA = {
  parse(value: unknown): DisclosureProjectionState {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('webpageToolDisclosure state must be an object')
    }
    const record = value as Record<string, unknown>
    if (typeof record.coreOpened !== 'boolean' || !Array.isArray(record.loaded)) {
      throw new Error('webpageToolDisclosure state has wrong shape')
    }
    if (!record.loaded.every(entry => typeof entry === 'string')) {
      throw new Error('webpageToolDisclosure state has wrong shape')
    }
    const pending: Record<string, PendingCall> = {}
    if (record.pending !== undefined && record.pending !== null) {
      if (typeof record.pending !== 'object' || Array.isArray(record.pending)) {
        throw new Error('webpageToolDisclosure state has wrong shape')
      }
      for (const [callId, entry] of Object.entries(record.pending as Record<string, unknown>)) {
        if (entry === null || typeof entry !== 'object') {
          throw new Error('webpageToolDisclosure state has wrong shape')
        }
        const call = entry as Record<string, unknown>
        if (call.kind !== 'open' && call.kind !== 'claim' && call.kind !== 'load') {
          throw new Error('webpageToolDisclosure state has wrong shape')
        }
        const tools = call.kind === 'load' && Array.isArray(call.tools)
          ? call.tools.filter(entry => typeof entry === 'string')
          : []
        pending[callId] = { kind: call.kind, tools }
      }
    }
    return { coreOpened: record.coreOpened, loaded: [...record.loaded] as string[], pending }
  },
}

/**
 * 注册披露投影：把 fold 挂到宿主注册表上，由宿主按会话事件驱动。
 *
 * @param registry - 宿主投影注册表（`ctx.get('sessionProjections')`）。
 * @returns 反注册 disposer；插件卸载时必须调用（注册表活在根 ctx，不随我们消亡）。
 */
export function registerDisclosureProjection(registry: SessionProjectionRegistryLike): () => void {
  return registry.register({
    key: DISCLOSURE_PROJECTION_KEY,
    stateSchema: STATE_SCHEMA,
    init: () => initialDisclosureState(),
    apply: (state, event) => advanceDisclosureState(
      state as DisclosureProjectionState,
      event as SessionEventLike,
    ),
    stateVersion: DISCLOSURE_PROJECTION_STATE_VERSION,
  })
}

/**
 * 读一个对话的持久化披露状态；没有投影、没有会话或读失败时返回 undefined。
 *
 * 失败（含投影缓存行损坏）不抛：恢复是增益不是前提，调用方退化为内存状态。
 *
 * @param registry - 宿主投影注册表。
 * @param session - 该对话的 Session；缺失时无从恢复。
 * @param warn - 失败留痕用（与屏蔽装不上同一口径：不静默）。
 */
export function restoreDisclosureState(
  registry: SessionProjectionRegistryLike | undefined,
  session: unknown,
  warn?: (message: string) => void,
): DisclosureProjectionState | undefined {
  if (registry === undefined || session === undefined || session === null) return undefined
  try {
    const state = registry.stateOf(session, DISCLOSURE_PROJECTION_KEY)
    return state === undefined ? undefined : STATE_SCHEMA.parse(state)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    warn?.(`webpage-tools: disclosure restore failed for one conversation: ${reason}`)
    return undefined
  }
}
