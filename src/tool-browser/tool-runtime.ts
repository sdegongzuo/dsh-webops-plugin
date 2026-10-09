/** 工具调用的统一包装：身份透传、错误呈现、计时与输出 schema 兼容。 */

import {
  type GenericCallView,
  type ParameterSchemaSpec,
  type ValueSchemaSpec,
  type DefineToolOptions,
  type ToolDefinition,
  defineTool as defineHarnessTool,
} from '@deepseek-ai/dsh-tools'
import { type BrowserCaller, presentBrowserError } from '../browser/index.ts'

/** 待执行卡片：一条观察/操作。`kind` 沿用 dsh 的 `ToolCallKind` 词表。 */
export function observeCall(title: string, kind: 'read' | 'fetch' | 'edit' | 'execute', rawInput: unknown): GenericCallView {
  return { card: 'generic', title, kind, rawInput }
}

/**
 * 取本次调用的宿主对话身份 —— **唯一**来源是 `exec.agent.id`。
 *
 * 为什么不把它做成工具参数：工具参数整体来自模型 JSON，身份一旦能从参数里给，模型就能
 * 伪造成别的对话去操作别人的标签，整套门禁等于不存在。所以它只能从宿主执行上下文里拿；
 * 拿不到就**保持 `undefined`**，由能力缝隙抛 `BROWSER_CALLER_REQUIRED`——绝不回落成
 * 「没身份就放行」（那正好让最需要门禁的运行环境最不设防）。
 *
 * 形状按结构化取值而不是 import 那个类型：`@deepseek-ai/dsh-agent` 是上游的运行时类型，
 * 本仓只依赖它的字段语义，不该为此多绑一个包。
 */
export function callerOf(exec: unknown): BrowserCaller | undefined {
  const agent = (exec as { readonly agent?: unknown } | null | undefined)?.agent
  const id = (agent as { readonly id?: unknown } | null | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? { ownerId: id } : undefined
}

/**
 * 项 7（2026-10-07）：每次工具调用的实测耗时（单调时钟，毫秒）。挂在返回值对象上，
 * 渲染时取回 —— 不进 output schema（schema 预算只算 name+description+parameters），
 * 也不改各工具自己的 render。
 */
/**
 * 项 7 的跨边界键：execute 量出的墙钟时间随 **value 本身** 走（普通可枚举字段）。
 * 不能用 WeakMap<value> —— 打包态 harness 的 createSuccessResult 在 execute 与 render
 * 之间对 value 做 snapshotToolValue（JSON 快照）+ deepFreeze，render 收到的是克隆，
 * WeakMap 键必然丢失（2026-10-07 打包态实测：单测绿但真实回执无 duration_ms）。
 * JSON 快照保留可枚举字段，所以随值走能穿过快照；schema 由 patchOutputSchema 补声明。
 */
const DURATION_KEY = 'durationMs'

/** 给对象型输出 schema 统一补 `durationMs` 声明 —— 多数输出 schema 是
 *  additionalProperties:false，不补声明的话 execute 塞进 value 的时长字段会在
 *  harness 的 schema 校验处把整个工具结果打红。 */
function patchOutputSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return schema
  const node = schema as Record<string, unknown>
  if (node['type'] !== 'object') return schema
  const properties = { ...(node['properties'] as Record<string, unknown> | undefined ?? {}), [DURATION_KEY]: { type: 'number' } }
  return { ...node, properties }
}

/**
 * 统一错误呈现（方案「错误回执」§3.2）：所有 webpage 工具的 execute 都经这里注册，
 * BrowserError 在穿出工具边界前把 `[CODE]` 与恢复建议折进 message —— 上游 harness 只把
 * `error.message` 给模型（`Error: ${message}`），结构化的 code 字段到不了模型，
 * 这是 2026-10-07 实测「布局错误没有独立错误码或恢复指引」的根因。
 * 非 BrowserError 原样穿透；同一入口包裹，避免在各工具重复拼码。
 *
 * 同时（项 7）用单调时钟量一次 execute 的真实墙钟时间，渲染时附 `duration_ms=…`，
 * 标明只代表本次工具调用 —— 模型时间、网站回复时间与端到端时间不在此内；缺数据时
 * 宁可不输出，也不让模型拿配置 timeout 或自己估时来顶数。
 */
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  const definition = defineHarnessTool<S, O>(options)
  const rawExecute = definition.execute.bind(definition)
  const rawRender = definition.output.render?.bind(definition.output)
  return {
    ...definition,
    execute: async (args, exec) => {
      const startedAt = performance.now()
      try {
        const value = await rawExecute(args, exec)
        if (value !== null && typeof value === 'object') {
          ;(value as Record<string, unknown>)[DURATION_KEY] = Math.round(performance.now() - startedAt)
        }
        return value
      } catch (error) {
        throw presentBrowserError(error)
      }
    },
    output: {
      ...definition.output,
      schema: patchOutputSchema(definition.output.schema) as typeof definition.output.schema,
      render: (args, value) => {
        const blocks = rawRender === undefined ? [] : rawRender(args, value)
        const duration = value !== null && typeof value === 'object'
          ? (value as Record<string, unknown>)[DURATION_KEY]
          : undefined
        if (typeof duration !== 'number') return blocks
        return [...blocks, {
          type: 'text',
          // 项 7 边界修正（2026-10-08）：旧文案「excludes … site response time」是错的 ——
          // wait(time_ms) 等的 10 秒就是花在等站点上，本回调里的页面探测/导航等待也都在内。
          // 这台钟量的边界是「本次工具调用」：不含模型思考，含调用内的全部等待。
          text: `duration_ms=${String(duration)} (wall time of this tool call, monotonic clock; excludes model thinking, includes all waits inside this call such as site response time)`,
        }]
      },
    },
  }
}
