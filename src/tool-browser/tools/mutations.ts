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
import { BROWSER_NAVIGATION_TIMEOUT_MS, BROWSER_OBSERVE_TIMEOUT_MS } from '../config.ts'
import type { BrowserMutationRequest } from '../../browser/index.ts'

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
  },
} as const

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
      render: (_args, value) => [{ type: 'text', text: formatMutationOutput(value as MutationOutput) }],
    },
    timeoutMs: spec.timeoutMs,
    async execute(rawArgs, exec) {
      const args = rawArgs as Record<string, unknown>
      const sessionId = args['session_id'] as string
      const result = await ctx.browser.mutate(spec.build(args, sessionId), callerOf(exec), exec.signal)
      // 导航过的会话，其 ref 与 find 缓存里的旧大纲一起作废（理由同 registerExecute）。
      if (result.navigated) cache.delete(result.sessionId)
      return {
        session_id: result.sessionId,
        action: result.action,
        epoch: result.epoch,
        url: result.url,
        title: result.title,
        navigated: result.navigated,
        ...result.pageChanged !== undefined ? { page_changed: toPageChangedOutput(result.pageChanged) } : {},
        ...result.satisfied !== undefined ? { satisfied: result.satisfied } : {},
        ...result.refState !== undefined ? { ref_state: result.refState } : {},
        ...result.signals !== undefined ? { signals: result.signals } : {},
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
  }))
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
    'Refs must come from the latest webpage_snapshot or a successful webpage_revalidate; an older epoch fails with BROWSER_STALE_REF — recover with webpage_revalidate, then a fresh snapshot if that fails.'

  if (enabled.click) registerMutationTool(ctx, cache, {
    name: 'webpage_click',
    action: 'click',
    description:
      'Click an element by ref with real mouse events at its center (it is scrolled into view first). A click may navigate: navigated=true, and every earlier ref then becomes invalid. '
      // 点击 target=_blank / window.open 链接会在**同一个窗口**里开出一个新的受控标签页
      // （宿主的「弹窗转标签」通报异步收编）。2026-09-17 真机：点热搜第 5 条开出 t2，
      // 模型 6 分钟里毫不知情 —— 于是 provider 侧按会话差集把新标签页写进回执的
      // `opened_tabs`，这里只需告诉模型「看到这个字段就换到那个 session_id 去干活」。
      + 'A link that opens a popup / target=_blank creates a NEW controlled tab in the SAME window, reported as `opened_tabs` with the new session_id(s) — switch to the tab that has your content instead of assuming a single tab. '
      + STALE_NOTICE,
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      ref: { type: 'string', required: true, description: 'Element ref, like e12.' },
    },
    timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS,
    build: (args, sessionId) => ({ kind: 'click', sessionId, ref: args['ref'] as string }),
    presentTitle: args => `Click ${String(args['ref'])}`,
  })

  if (enabled.fill) registerMutationTool(ctx, cache, {
    name: 'webpage_fill',
    action: 'fill',
    description:
      'Fill an input or textarea by ref with value: it goes through the native setter and fires input + change, so framework-controlled fields (React etc.) notice it. A contenteditable element (rich-text editors such as Lexical / ProseMirror, used by AI chat pages) instead has its content selected and typed through the browser input pipeline, so beforeinput fires and the editor state — including its send button — updates. Any other non-editable element gets textContent replaced. '
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
      'Focus an element by ref and press a key. key is a named key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space) or a single character. Only single ASCII characters can be produced this way — CJK and other composed text cannot go through key events, so use webpage_fill for text, especially into rich-text / contenteditable boxes. Pressing Enter on a form field may submit and navigate: navigated=true then means earlier refs are invalid. '
      + STALE_NOTICE,
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      ref: { type: 'string', required: true, description: 'Element ref to focus.' },
      key: { type: 'string', required: true, description: 'Named key or a single character, e.g. Enter, Tab, ArrowDown, a.' },
    },
    timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS,
    build: (args, sessionId) => ({ kind: 'press', sessionId, ref: args['ref'] as string, key: args['key'] as string }),
    presentTitle: args => `Press ${String(args['key'])} on ${String(args['ref'])}`,
  })

  if (enabled.scroll) registerMutationTool(ctx, cache, {
    name: 'webpage_scroll',
    action: 'scroll',
    description:
      'Scroll by dispatching a real mouse-wheel event. With ref the event lands at the centre of that element, so the scrollable container under it moves; WITHOUT ref it lands at the viewport centre and scrolls the page itself — use that on long pages and on pages with no actionable elements at all (it needs no snapshot). Give deltaX and/or deltaY in pixels (positive = right/down). '
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
      'Wait for exactly ONE condition: time_ms (sleep), text (page contains it), ref (element leaves the document), or until="stable" (document complete + DOM/network quiet, with a grace period for busy networks). ref_state="hidden" refines the ref condition: succeed as soon as the element is still attached but no longer visible (a send button that gets hidden after submit) — the default removal condition would never fire for a merely hidden element. For generated replies prefer text from the CURRENT reply marking completion; one such wait confirms submission too. Avoid separate echo/completion waits, sleep/stable or snapshot-polling. Text/ref waits use the provider wait timeout; stable defaults to 30000ms, shortened by timeout_ms (1-30000). A stable timeout returns satisfied=false with readyState/dom/network signals. '
      + STALE_NOTICE,
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      // 「exactly one」只在顶层描述里说一次。四个参数各写一遍是纯重复（方案 §2.T-C2）。
      time_ms: { type: 'integer', description: 'Plain wait duration in milliseconds (1-30000).' },
      text: { type: 'string', description: 'Wait until the page text contains this string.' },
      ref: { type: 'string', description: 'Wait until this ref is gone from the document (or, with ref_state="hidden", until it is merely hidden).' },
      ref_state: { type: 'string', description: 'Only with ref: "hidden" = succeed when the element is still in the document but no longer visible; default "removed" = succeed when it leaves the document.' },
      until: { type: 'string', description: 'Set to "stable" to wait until the page is quiet; combine with timeout_ms for the deadline.' },
      timeout_ms: { type: 'integer', description: 'Deadline in milliseconds (1-30000) for until=stable. Default 30000; ignored for other modes.' },
    },
    timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS,
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
