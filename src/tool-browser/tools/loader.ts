/** `webpage_tools`：按需加载网页工具的唯一入口；不操作页面，不索取脚本代码。 */

import type { Context } from '@deepseek-ai/cordis'
import {
  type ToolDisclosure,
  WEBPAGE_LOADABLE_TOOLS,
  WEBPAGE_LOADER_TOOL,
  rejectedLoadNames,
} from '../disclosure.ts'
import { defineTool, observeCall } from '../tool-runtime.ts'
import { BrowserError } from '../../browser/index.ts'
import { BROWSER_OBSERVE_TIMEOUT_MS } from '../config.ts'

/** 加载回执的输出。 */
interface LoaderOutput {
  /** 本次真正新增、下次请求即可调用的工具名。 */
  loaded: string[]
  /** 此前已可见的工具名（重复加载幂等）。 */
  already_visible: string[]
  /** 本次返回后该对话可见的全部网页工具名。 */
  visible: string[]
}

const LOADER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    loaded: { type: 'array', required: true, items: { type: 'string' } },
    already_visible: { type: 'array', required: true, items: { type: 'string' } },
    visible: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** 每个可加载工具的一句话用途；回执与描述共用，避免两处措辞分叉。 */
const LOADABLE_PURPOSE: Readonly<Record<string, string>> = Object.freeze({
  webpage_find: 'search the last observation (query or regex, optional full text) — no page command',
  webpage_scroll: 'real wheel input over a ref or the viewport',
  webpage_locate: 'measure or verify where a ref is; does not scroll by default',
  webpage_screenshot: 'capture the viewport, full page, or one element as a PNG attachment',
  webpage_console: 'read console entries of the current document',
  webpage_network: 'read network requests of the current document',
})

function formatLoaderOutput(value: LoaderOutput): string {
  const lines: string[] = []
  if (value.loaded.length > 0) {
    lines.push(`Loaded ${value.loaded.join(', ')} — callable from your next request.`)
    for (const name of value.loaded) {
      const purpose = LOADABLE_PURPOSE[name]
      if (purpose !== undefined) lines.push(`- ${name}: ${purpose}`)
    }
  }
  if (value.already_visible.length > 0) {
    lines.push(`Already visible (nothing to load): ${value.already_visible.join(', ')}.`)
  }
  if (value.loaded.length === 0 && value.already_visible.length === 0) {
    lines.push('Nothing was loaded: none of the requested tools is available in this installation.')
  }
  lines.push(`Visible webpage tools now: ${value.visible.join(', ')}.`)
  return lines.join('\n')
}

/**
 * 注册加载入口。
 *
 * 它只提升**请求到的**工具，不按用途暗捆绑（要 console 不会顺带给 network）；
 * 重复加载幂等。配置里被关掉的工具不在此列，也不会被谎报成已加载。
 *
 * @param ctx - 上下文。
 * @param disclosure - 逐步披露控制器；状态属于对话。
 */
export function registerToolLoader(ctx: Context, disclosure: ToolDisclosure): void {
  ctx.tools.register(defineTool({
    name: WEBPAGE_LOADER_TOOL,
    description:
      'Load extra webpage tools by name (they stay available for the rest of this conversation): '
      + 'webpage_find — search the last observation; webpage_scroll — real wheel input; '
      + 'webpage_locate — measure or verify a ref; webpage_screenshot — capture a PNG; '
      + 'webpage_console — console entries; webpage_network — network requests. '
      + 'Pass only what the current step needs; loading one does not load the others.',
    parameters: {
      tools: {
        type: 'array',
        required: true,
        description: 'Tool names to load, e.g. ["webpage_find"]. Unknown names are rejected.',
        items: { type: 'string', enum: [...WEBPAGE_LOADABLE_TOOLS] },
      },
    },
    output: {
      schema: LOADER_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatLoaderOutput(value as LoaderOutput) }],
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    async execute(args, exec) {
      const requested = Array.isArray(args.tools) ? args.tools.map(entry => String(entry)) : []
      // schema 已挡住枚举外的值，这里再兜一次：加载入口不能把别的插件的工具名带进来。
      const rejected = rejectedLoadNames(requested)
      if (rejected.length > 0) {
        throw new BrowserError(
          `webpage_tools 只接受这些名字：${WEBPAGE_LOADABLE_TOOLS.join(', ')}；不接受 ${rejected.map(n => `"${n}"`).join(', ')}。本次未加载任何工具。`,
          'BROWSER_INVALID_PARAMS',
        )
      }
      const { added, already } = disclosure.load(exec.agent, requested)
      return {
        loaded: [...added],
        already_visible: [...already],
        visible: [...disclosure.visible(exec.agent)],
      }
    },
    presentCall: args => observeCall(
      `Load webpage tools: ${Array.isArray(args.tools) ? args.tools.join(', ') : ''}`,
      'read',
      args.tools,
    ),
  }))
}
