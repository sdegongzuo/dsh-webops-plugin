/** 点击、填充、按键、滚动与等待共用注册逻辑，保留各动作的参数和行为契约。 */

import type { Context } from '@deepseek-ai/cordis'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  PAGE_CHANGED_SCHEMA,
  TAB_ITEM_SCHEMA,
  formatMutationOutput,
  type MutationOutput,
  toPageChangedOutput,
  toTabOutput,
  SESSION_ID_PARAMETER,
} from '../common-output.ts'
import type { SnapshotCache } from '../snapshot-cache.ts'
import { defineTool, callerOf, observeCall } from '../tool-runtime.ts'
import { BROWSER_OBSERVE_TIMEOUT_MS, BROWSER_WAIT_TIMEOUT_MS } from '../config.ts'
import type { BrowserMutationRequest } from '../../browser/index.ts'
import { SNAPSHOT_OUTPUT_SCHEMA, formatSnapshotOutput, rememberBrowserSnapshot, type SnapshotOutput } from './observation.ts'

/** 五个 mutation 工具共用的输出契约。 */
const MUTATION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    action: { type: 'string', required: true },
    epoch: { type: 'integer', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    navigated: { type: 'boolean', required: true },
    // P2：页面在**本会话之外**变过的分类计数。脏时才出现（方案 §6.2 ②）——
    // 这是「人工操作落在两轮之间」唯一能被模型看见的地方（它下一轮常常是 click，不是 snapshot）。
    page_changed: PAGE_CHANGED_SCHEMA,
    // 页面自己弹出来的新受控标签页（target=_blank / window.open）。不是每次都有，
    // 所以不标 required；有就必须点名，否则模型不知道它存在。
    opened_tabs: { type: 'array', items: TAB_ITEM_SCHEMA },
    // 只有 click 才有：未导航回执要报「点的是谁 / 被谁挡了」。
    target: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', required: true },
        name: { type: 'string', required: true },
        href: { type: 'string' },
      },
    },
    occluded_by: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string' },
        name: { type: 'string' },
        hint: { type: 'string' },
      },
    },
    // scroll 才有：滚轮已投递、浏览器没回话。
    unconfirmed: { type: 'boolean' },
    satisfied: { type: 'boolean' },
    snapshot: SNAPSHOT_OUTPUT_SCHEMA,
    action_dispatched: { type: 'boolean' },
    observation_error: {
      type: 'object', additionalProperties: false,
      properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
    },
  },
} as const

/** `webpage_wait` 在共用契约上多一个 `satisfied`。 */
const WAIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...MUTATION_OUTPUT_SCHEMA.properties,
    satisfied: { type: 'boolean', required: true },
    ref_state: { type: 'string' },
    signals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        readyState: { type: 'string', required: true },
        dom: { type: 'string', required: true },
        network: { type: 'string', required: true },
      },
    },
    snapshot: { ...SNAPSHOT_OUTPUT_SCHEMA, required: true },
  },
} as const

const POST_ACTION_PARAMETERS = {
  observe: { type: 'boolean', description: 'Add a full snapshot.' },
  wait_text: { type: 'string', description: 'Visible body text marker.' },
  timeout_ms: { type: 'integer', description: '1-30000ms; default 10000.' },
} as const

function postActionOptions(args: Record<string, unknown>): Pick<Extract<BrowserMutationRequest, { kind: 'click' | 'press' }>, 'observe' | 'waitText' | 'timeoutMs'> {
  const waitText = args['wait_text']
  const timeoutMs = args['timeout_ms']
  return {
    ...(typeof args['observe'] === 'boolean' ? { observe: args['observe'] } : {}),
    ...(typeof waitText === 'string' ? { waitText } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  }
}

/**
 * 五个 mutation 工具共用的注册壳：输出契约、渲染、错误语义完全一致，
 * 只有参数、描述与请求体不同。`build` 收到规范化后的参数（session_id 必有）。
 */
function registerMutationTool(
  ctx: Context,
  cache: SnapshotCache,
  spec: {
    name: string
    action: 'click' | 'fill' | 'press' | 'scroll' | 'wait'
    description: string
    parameters: ParameterSchemaSpec
    timeoutMs: number
    build: (args: Record<string, unknown>, sessionId: string) => BrowserMutationRequest
    presentTitle: (args: Record<string, unknown>) => string
  },
): void {
  ctx.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: spec.action === 'wait' ? WAIT_OUTPUT_SCHEMA : MUTATION_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const mutation = value as MutationOutput & { snapshot?: SnapshotOutput }
        const hasSnapshot = mutation.snapshot !== undefined
        const text = formatMutationOutput(mutation, hasSnapshot)
        return [{ type: 'text', text: mutation.snapshot === undefined
          ? text
          : `${text}\n\n${spec.action === 'wait' ? 'Observation after wait' : 'Observation after action'}:\n${formatSnapshotOutput(mutation.snapshot, true)}` }]
      },
    },
    timeoutMs: spec.timeoutMs,
    async execute(rawArgs, exec) {
      const args = rawArgs as Record<string, unknown>
      const sessionId = args['session_id'] as string
      const result = await ctx.browser.mutate(spec.build(args, sessionId), callerOf(exec), exec.signal)
      // 导航过的会话，其 ref 与 find 缓存里的旧大纲一起作废（理由同 registerExecute）。
      if (result.navigated) cache.delete(result.sessionId)
      const snapshot = result.snapshot === undefined ? undefined : rememberBrowserSnapshot(cache, result.snapshot)
      if (spec.action === 'wait' && snapshot === undefined) {
        throw new Error('webpage_wait completed without its required full snapshot')
      }
      return {
        session_id: result.sessionId,
        action: result.action,
        epoch: result.snapshot?.epoch ?? result.epoch,
        url: result.snapshot?.url ?? result.url,
        title: result.snapshot?.title ?? result.title,
        navigated: result.navigated,
        ...result.pageChanged !== undefined ? { page_changed: toPageChangedOutput(result.pageChanged) } : {},
        ...result.satisfied !== undefined ? { satisfied: result.satisfied } : {},
        ...result.actionDispatched === true ? { action_dispatched: true } : {},
        ...result.observationError !== undefined ? { observation_error: result.observationError } : {},
        ...result.refState !== undefined ? { ref_state: result.refState } : {},
        ...result.signals !== undefined ? { signals: result.signals } : {},
        ...snapshot !== undefined ? { snapshot } : {},
        ...result.openedTabs !== undefined ? { opened_tabs: result.openedTabs.map(toTabOutput) } : {},
        ...result.target !== undefined ? { target: result.target } : {},
        ...result.unconfirmed === true ? { unconfirmed: true } : {},
      }
    },
    presentCall: rawArgs => observeCall(
      spec.presentTitle(rawArgs as Record<string, unknown>),
      'edit',
      (rawArgs as Record<string, unknown>)['ref'],
    ),
  }, cache))
}

/** 注册 `webpage_click` / `webpage_fill` / `webpage_press` / `webpage_scroll` / `webpage_wait`（可逐个关闭）。 */
export function registerMutations(
  ctx: Context,
  cache: SnapshotCache,
  enabled: { click: boolean; fill: boolean; press: boolean; scroll: boolean; wait: boolean },
): void {
  // 四个 ref 工具共用的失效提示。**刻意只留「判据 + 失败码 + 下一步」**：逐工具再重复
  // "from the latest webpage_snapshot" 是纯浪费（每个工具的 ref 参数描述里已经写了），
  // 而这段 ×4 是每一步都付的前缀成本（方案 §2.T-C2）。
  const STALE_NOTICE =
    'BROWSER_STALE_REF: use the attached fresh snapshot when present; otherwise take a full snapshot. Never retry old refs.'

  if (enabled.click) registerMutationTool(ctx, cache, {
    name: 'webpage_click',
    action: 'click',
    description:
      'Click a ref with real mouse events, scrolling it into view. navigated=true invalidates earlier refs. '
      // 点击 target=_blank / window.open 链接会在**同一个窗口**里开出一个新的受控标签页
      // （宿主的「弹窗转标签」通报异步收编）。2026-09-17 真机：点热搜第 5 条开出 t2，
      // 模型 6 分钟里毫不知情 —— 于是 provider 侧按会话差集把新标签页写进回执的
      // `opened_tabs`，这里只需告诉模型「看到这个字段就换到那个 session_id 去干活」。
      + 'Popup links return opened_tabs with new session_id(s) in the same window; switch to the content tab. '
      + 'Use observe=true for new controls; wait_text waits and returns new refs. '
      + STALE_NOTICE,
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      ref: { type: 'string', required: true, description: 'Element ref, like e12.' },
      ...POST_ACTION_PARAMETERS,
    },
    timeoutMs: BROWSER_WAIT_TIMEOUT_MS,
    build: (args, sessionId) => ({ kind: 'click', sessionId, ref: args['ref'] as string, ...postActionOptions(args) }),
    presentTitle: args => `Click ${String(args['ref'])}`,
  })

  if (enabled.fill) registerMutationTool(ctx, cache, {
    name: 'webpage_fill',
    action: 'fill',
    description:
      'Replace text by ref. Inputs/textarea use the native setter plus input/change; contenteditable uses real browser text input (beforeinput), updating editor state. Other elements replace textContent. '
      + STALE_NOTICE,
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      ref: { type: 'string', required: true, description: 'Element ref of the field.' },
      value: { type: 'string', required: true, description: 'Text to put into the field (replaces the current value).' },
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    build: (args, sessionId) => ({ kind: 'fill', sessionId, ref: args['ref'] as string, value: args['value'] as string }),
    presentTitle: args => `Fill ${String(args['ref'])}`,
  })

  if (enabled.press) registerMutationTool(ctx, cache, {
    name: 'webpage_press',
    action: 'press',
    description:
      'Focus a ref and press a named key or one ASCII character. Use webpage_fill for CJK/composed text. Enter may submit; navigated=true invalidates earlier refs. '
      + 'Use observe=true for new controls; wait_text waits and returns new refs. '
      + STALE_NOTICE,
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      ref: { type: 'string', required: true, description: 'Element ref to focus.' },
      key: { type: 'string', required: true, description: 'Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp/Down, Space, or one ASCII character.' },
      ...POST_ACTION_PARAMETERS,
    },
    timeoutMs: BROWSER_WAIT_TIMEOUT_MS,
    build: (args, sessionId) => ({ kind: 'press', sessionId, ref: args['ref'] as string, key: args['key'] as string, ...postActionOptions(args) }),
    presentTitle: args => `Press ${String(args['key'])} on ${String(args['ref'])}`,
  })

  if (enabled.scroll) registerMutationTool(ctx, cache, {
    name: 'webpage_scroll',
    action: 'scroll',
    description:
      'Real wheel scroll: with ref, target its container; WITHOUT ref, target the viewport centre (no snapshot needed). Give delta_x and/or delta_y in pixels; positive = right/down. '
      + STALE_NOTICE,
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      ref: {
        type: 'string',
        description: 'Element to scroll at. Omit to scroll at the viewport centre (no snapshot required).',
      },
      delta_x: { type: 'number', description: 'Horizontal scroll amount in pixels; positive scrolls right.' },
      delta_y: { type: 'number', description: 'Vertical scroll amount in pixels; positive scrolls down.' },
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    build: (args, sessionId) => ({
      kind: 'scroll',
      sessionId,
      ...typeof args['ref'] === 'string' ? { ref: args['ref'] } : {},
      ...typeof args['delta_x'] === 'number' ? { deltaX: args['delta_x'] } : {},
      ...typeof args['delta_y'] === 'number' ? { deltaY: args['delta_y'] } : {},
    }),
    presentTitle: args => args['ref'] === undefined
      ? 'Scroll at the viewport centre'
      : `Scroll at ${String(args['ref'])}`,
  })

  if (enabled.wait) registerMutationTool(ctx, cache, {
    name: 'webpage_wait',
    action: 'wait',
    description:
      'Wait for exactly ONE condition: time_ms, text, ref, or until="stable" (document complete + DOM/network quiet, not reply completion). Prefer completion text from the CURRENT reply; one such wait confirms submission too. time_ms is a fixed delay and cannot combine with timeout_ms. For text/ref/stable, timeout_ms is the shared 1-30000 ms deadline (default 10000); normal timeout returns satisfied=false. On success or normal timeout, returns a full snapshot with usable refs. '
      + STALE_NOTICE,
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      // 「exactly one」只在顶层描述里说一次。四个参数各写一遍是纯重复（方案 §2.T-C2）。
      time_ms: { type: 'integer', description: 'Plain wait duration in milliseconds (1-30000).' },
      text: { type: 'string', description: 'Wait until the page text contains this string.' },
      ref: { type: 'string', description: 'Element to wait for; see ref_state.' },
      ref_state: { type: 'string', enum: ['removed', 'hidden'], description: 'Only with ref: removed (default) = detached; hidden = attached but invisible.' },
      until: { type: 'string', enum: ['stable'], description: 'Page quietness; timeout_ms sets the shared wait deadline.' },
      timeout_ms: { type: 'integer', description: 'Shared deadline for text/ref/stable (1-30000 ms; default 10000). Cannot combine with time_ms.' },
    },
    timeoutMs: BROWSER_WAIT_TIMEOUT_MS,
    build: (args, sessionId) => ({
      kind: 'wait',
      sessionId,
      ...typeof args['time_ms'] === 'number' ? { timeMs: args['time_ms'] } : {},
      ...typeof args['text'] === 'string' && args['text'] !== '' ? { text: args['text'] } : {},
      ...typeof args['ref'] === 'string' ? { ref: args['ref'] } : {},
      ...args['ref_state'] === 'hidden' ? { refState: 'hidden' as const } : {},
      ...args['until'] === 'stable' ? { until: 'stable' as const } : {},
      ...typeof args['timeout_ms'] === 'number' ? { timeoutMs: args['timeout_ms'] } : {},
    }),
    presentTitle: (args) => {
      const what = args['until'] === 'stable'
        ? 'stable'
        : args['time_ms'] !== undefined
          ? `${String(args['time_ms'])}ms`
          : args['text'] !== undefined
            ? `text "${String(args['text'])}"`
            : args['ref_state'] === 'hidden'
              ? `ref ${String(args['ref'])} hidden`
              : `ref ${String(args['ref'])}`
      return `Wait for ${what}`
    },
  })
}
