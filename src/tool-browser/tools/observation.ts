/** 页面打开、导航、快照与截图：专用 schema、输出渲染及注册集中在此。 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  SESSION_OUTPUT_SCHEMA,
  formatSessionOutput,
  toSessionOutput,
  SESSION_ID_PARAMETER,
} from '../common-output.ts'
import {
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_OBSERVE_TIMEOUT_MS,
} from '../config.ts'
import { defineTool, callerOf, observeCall } from '../tool-runtime.ts'
import { type SnapshotCache, rememberSnapshot } from '../snapshot-cache.ts'
import type { ToolDisclosure } from '../disclosure.ts'
import { MAX_SNAPSHOT_LINES, DEFAULT_SNAPSHOT_LIMITS } from '../../browser-cdp/snapshot.ts'
import { formatSnapshotOutput, SNAPSHOT_OUTPUT_SCHEMA, toSnapshotOutput } from '../snapshot-output.ts'
export { formatSnapshotOutput, SNAPSHOT_OUTPUT_SCHEMA, toSnapshotOutput, rememberBrowserSnapshot, type SnapshotOutput } from '../snapshot-output.ts'

/** `webpage_screenshot` 的输出。 */
interface ScreenshotOutput {
  session_id: string
  epoch: number
  width: number
  height: number
  ref?: string
  attachment: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }
}

/** 截图的文本渲染；图片本身由 `render` 作为第二个内容块附上。 */
function formatScreenshotOutput(args: { session_id: string; full_page?: boolean }, value: ScreenshotOutput): string {
  const scope = value.ref !== undefined ? `element ref=${value.ref}` : args.full_page === true ? 'the full page' : 'the viewport'
  return `Captured ${scope} at ${value.width}x${value.height} px (session_id=${args.session_id}, ref epoch ${value.epoch}), saved as image attachment ${value.attachment.attachmentId}.`
}

/**
 * 把一次成功的 snapshot 放进缓存（容量封顶，淘汰最旧）。
 * @param cache - 会话缓存。
 * @param snapshot - 刚产出的快照输出（取会话号与 ref 表）。
 * @param searchOutline - find 的检索底稿：打印行 ∪ 被折叠的实例行（见 {@link SnapshotCacheEntry}）。
 */
function snapshotRegionFromArgs(args: {
  region_ref?: unknown
  region_viewport?: unknown
  region_box?: unknown
}): { ref?: string; viewport?: boolean; box?: { x: number; y: number; width: number; height: number } } | undefined {
  const ref = typeof args.region_ref === 'string' ? args.region_ref : undefined
  const viewport = args.region_viewport === true
  const box = parseRegionBox(args.region_box)
  const kinds = [ref !== undefined, viewport, box !== undefined].filter(Boolean).length
  if (kinds > 1) {
    throw new Error('region_ref, region_viewport and region_box are mutually exclusive; pass at most one')
  }
  if (ref !== undefined) return { ref }
  if (viewport) return { viewport: true }
  if (box !== undefined) return { box }
  return undefined
}

function parseRegionBox(
  value: unknown,
): { x: number; y: number; width: number; height: number } | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('region_box must be an object {x, y, width, height} in CSS pixels')
  }
  const record = value as Record<string, unknown>
  const x = record['x']
  const y = record['y']
  const width = record['width']
  const height = record['height']
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
    || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('region_box needs finite x, y, width, height')
  }
  if (width <= 0 || height <= 0) {
    throw new Error('region_box width and height must be positive')
  }
  return { x, y, width, height }
}

/** 截图的 attachment 引用 schema；放开额外字段，规范化过的图片会多带 originalDimensions。 */
const ATTACHMENT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    name: { type: 'string' },
  },
} as const

/**
 * 注册 `webpage_open`。
 *
 * 打开**成功**才把该对话提升到基础组（逐步披露）：失败不提升，模型看到的仍是初始四项。
 *
 * @param ctx - 上下文；其 `browser` 服务执行打开动作。
 * @param disclosure - 逐步披露控制器；缺省时不接线（单测与未启用披露的场景）。
 */
export function registerOpen(ctx: Context, disclosure?: ToolDisclosure): void {
  ctx.tools.register(defineTool({
    name: 'webpage_open',
    description:
      'Open a controlled webpage and return its session id. Reuse an idle tab with the same full URL, otherwise create one. Occupied tabs are never reused. Omit url for a blank page.',
    parameters: {
      url: {
        type: 'string',
        description: 'Absolute http(s) URL to load. Omit to open a blank page.',
      },
    },
    output: {
      schema: SESSION_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSessionOutput(value) }],
    },
    timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS,
    async execute(args, exec) {
      const session = await ctx.browser.open(
        args.url === undefined ? {} : { url: args.url },
        callerOf(exec),
        exec.signal,
      )
      // 只有真的拿到会话才展开基础组：打开失败时模型仍应停在初始四项。
      disclosure?.markOpened(exec.agent)
      return toSessionOutput(session)
    },
    presentCall: args => observeCall(
      args.url === undefined ? 'Open browser tab' : `Open browser tab: ${args.url}`,
      'fetch',
      args.url,
    ),
  }))
}

/**
 * 注册 `webpage_navigate`。
 * @param ctx - 上下文；其 `browser` 服务执行跳转。
 * @param cache - find 的 snapshot 缓存；导航成功即删（旧大纲的 ref 已全部作废）。
 */
export function registerNavigate(ctx: Context, cache: SnapshotCache): void {
  ctx.tools.register(defineTool({
    name: 'webpage_navigate',
    description:
      'Navigate with exactly one of url or history. Prefer history over executing history.back(); unavailable history fails BROWSER_NAVIGATION_FAILED. Every navigation invalidates refs: take a full webpage_snapshot before ref use to avoid BROWSER_STALE_REF.',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      url: { type: 'string', description: 'Absolute http(s) URL to load. Exclusive with history.' },
      history: {
        type: 'string',
        enum: ['back', 'forward', 'reload'],
        description: 'Browser history; exclusive with url.',
      },
    },
    output: {
      schema: SESSION_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSessionOutput(value) }],
    },
    timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS,
    async execute(args, exec) {
      const url = args.url === undefined ? undefined : String(args.url)
      const history = args.history === undefined ? undefined : String(args.history)
      const session = await ctx.browser.navigate({
        sessionId: args.session_id,
        ...url !== undefined ? { url } : {},
        ...history !== undefined ? { history: history as 'back' | 'forward' | 'reload' } : {},
      }, callerOf(exec), exec.signal)
      cache.delete(session.id)
      return toSessionOutput(session)
    },
    presentCall: args => observeCall(
      args.history === undefined ? `Navigate to ${String(args.url)}` : `Navigate ${String(args.history)}`,
      'fetch',
      args.history === undefined ? args.url : undefined,
    ),
  }))
}

/**
 * 注册 `webpage_snapshot`。
 * @param ctx - 上下文；其 `browser` 服务产出大纲。
 * @param cache - find 的 snapshot 缓存；成功即落表（旧纪元的大纲被覆盖）。
 */
export function registerSnapshot(ctx: Context, cache: SnapshotCache): void {
  ctx.tools.register(defineTool({
    name: 'webpage_snapshot',
    description:
      'Compact AX outline, not verbatim source. Full snapshot invalidates refs; regional does NOT invalidate other refs. Give at most one region_*. Read CURRENT replies with region_ref; region_viewport reads only the visible fragment. Read-only anchors select sections. For exact text: webpage_find heading, snapshot(region_ref=anchor), then find(query=unique text,full_text=true); preserve whitespace and verify the tail. If truncated=true, raise max_lines.',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      max_lines: {
        type: 'integer',
        description: `Line budget 1-${String(MAX_SNAPSHOT_LINES)}; default ${String(DEFAULT_SNAPSHOT_LIMITS.maxLines)}. Increase only when truncated.`,
      },
      // 「不使其他 ref 失效」与互斥关系只在顶层描述 + 这里各说一次：三个区域参数各写一遍是重复。
      region_ref: {
        type: 'string',
        description: 'Subtree/anchor section; new refs are appended.',
      },
      region_viewport: {
        type: 'boolean',
        description: 'Only elements intersecting the viewport.',
      },
      region_box: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
        },
        description: 'Rectangle in document CSS pixels; width/height must be positive.',
      },
    },
    output: {
      schema: SNAPSHOT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSnapshotOutput(value) }],
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    async execute(args, exec) {
      const region = snapshotRegionFromArgs(args)
      const observation = await ctx.browser.observe({
        kind: 'snapshot',
        sessionId: args.session_id,
        ...args.max_lines !== undefined ? { maxLines: args.max_lines } : {},
        ...region !== undefined ? { region } : {},
      }, callerOf(exec), exec.signal)
      if (observation.kind !== 'snapshot') {
        // 能力缝隙按 `kind` 分派，这里不可能拿到别的观察类型；真拿到就是缝隙有 bug。
        throw new Error(`webpage_snapshot received a "${observation.kind}" observation`)
      }
      const output = toSnapshotOutput(observation)
      // 落缓存给 webpage_find 用：它只查这份大纲，不再发任何 CDP 命令。
      // 底稿 = 打印行 ∪ 被折叠的实例行 —— 折叠标记承诺「用 find 拿全部实例的 ref」，缓存里少了实例，
      // 这句承诺就是假的（provider 不提供 fullOutline 时退回模型看到的那份，至少不更差）。
      const regional = region !== undefined
      // find 的契约是 LAST snapshot；区域新回复不能继续读旧全页缓存。
      rememberSnapshot(cache, output, observation.fullOutline ?? observation.outline,
        regional ? (region.ref !== undefined ? 'ref' : region.viewport === true ? 'viewport' : 'box') : undefined,
        observation.fullTexts, observation.textBlocks)
      return output
    },
    presentCall: args => observeCall(`Snapshot ${args.session_id}`, 'read', args.session_id),
  }, cache))
}

/**
 * 注册 `webpage_screenshot`。
 * @param ctx - 上下文；其 `browser` 服务取图，`attachments` 服务落盘。
 */
export function registerScreenshot(ctx: Context, cache: SnapshotCache): void {
  ctx.tools.register(defineTool({
    name: 'webpage_screenshot',
    description:
      'Capture a PNG attachment/image block: viewport by default, full_page=true, or one ref. Stale refs fail BROWSER_STALE_REF.',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      ref: {
        type: 'string',
        description: 'Capture just this element instead of the viewport.',
      },
      full_page: {
        type: 'boolean',
        description: 'Capture the whole scrollable page. Exclusive with ref.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          epoch: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          ref: { type: 'string' },
          attachment: { ...ATTACHMENT_SCHEMA, required: true },
        },
      },
      render: (args, value) => [
        { type: 'text', text: formatScreenshotOutput(args, value) },
        // schema DSL 表达不了 `attachmentId` 的品牌类型，而这里塞进去的就是
        // `ctx.attachments.saveImage` 的返回体本身，运行时一定成立。
        { type: 'image', attachment: value.attachment as unknown as ImageAttachmentRef },
      ],
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    async execute(args, exec) {
      if (args.ref !== undefined && args.full_page === true) {
        throw new Error('ref and full_page are mutually exclusive; pass at most one')
      }
      const observation = await ctx.browser.observe({
        kind: 'screenshot',
        sessionId: args.session_id,
        ...args.ref !== undefined ? { ref: args.ref } : {},
        ...args.full_page !== undefined ? { fullPage: args.full_page } : {},
      }, callerOf(exec), exec.signal)
      const screenshot = observation
      if (screenshot.kind !== 'screenshot') {
        throw new Error(`webpage_screenshot received a "${observation.kind}" observation`)
      }
      const ref = await ctx.attachments.saveImage({
        data: screenshot.data,
        mediaType: screenshot.mediaType,
        name: 'browser-screenshot.png',
      })
      return {
        session_id: screenshot.sessionId,
        epoch: screenshot.epoch,
        width: screenshot.width,
        height: screenshot.height,
        ...screenshot.ref !== undefined ? { ref: screenshot.ref } : {},
        attachment: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
      }
    },
    presentCall: args => observeCall(
      args.ref === undefined ? `Screenshot ${args.session_id}` : `Screenshot ${args.session_id} ${args.ref}`,
      'read',
      args.ref,
    ),
  }, cache))
}
