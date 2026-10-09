/** 页面打开、导航、快照与截图：专用 schema、输出渲染及注册集中在此。 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  type SessionOutput,
  type PageChangedOutput,
  formatPageChanged,
  formatReboundRefs,
  SESSION_OUTPUT_SCHEMA,
  formatSessionOutput,
  toSessionOutput,
  SESSION_ID_PARAMETER,
  REF_ITEM_SCHEMA,
  PAGE_CHANGED_SCHEMA,
  toPageChangedOutput,
} from '../common-output.ts'
import {
  UNTRUSTED_PAGE_CONTENT_NOTICE,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_OBSERVE_TIMEOUT_MS,
} from '../config.ts'
import { defineTool, callerOf, observeCall } from '../tool-runtime.ts'
import { type SnapshotCache, rememberSnapshot } from '../snapshot-cache.ts'
import { MAX_SNAPSHOT_LINES, DEFAULT_SNAPSHOT_LIMITS } from '../../browser-cdp/snapshot.ts'

/** `webpage_snapshot` 的输出。 */
interface SnapshotOutput extends SessionOutput {
  outline: string
  truncated: boolean
  /** 被截断时：实际输出的大纲行数。 */
  outline_lines?: number
  /** 被截断时：因预算没输出的元素个数。 */
  dropped_elements?: number
  /** 被折叠而未打印的重复行数（与 `dropped_elements` 是两套口径：元素都还在 `refs` 里）。 */
  folded_repeats?: number
  /** 因与祖先链上的某行同名而被跳过的行数（同一条链上同一个名字只印一次）。 */
  deduped_lines?: number
  /** 区域快照：区域外还有几个可操作元素。 */
  outside_region?: number
  refs: { ref: string; role: string; name: string }[]
  /** P3：有人正开着 DevTools 操作这个页面（结果可能随时失效，但 ref 纪元不受影响）。 */
  takeover?: boolean
  /** P2：页面在本会话之外变过（脏时才出现）。与 `takeover` 是两个维度，可同时出现。 */
  page_changed?: PageChangedOutput
  /** D-5：本次**区域快照**把哪几个号的指针换到了别的节点上（只报不作废）。 */
  rebound_refs?: { ref: string; role: string; name: string }[]
}

/** `webpage_screenshot` 的输出。 */
interface ScreenshotOutput {
  session_id: string
  epoch: number
  width: number
  height: number
  ref?: string
  attachment: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }
}

/** 大纲的文本渲染。 */
function formatSnapshotOutput(snapshot: SnapshotOutput): string {
  const header = [
    `${snapshot.url}`,
    snapshot.title.length > 0
      ? `title: ${snapshot.title}`
      : 'title: (empty — the document sets no <title>, or it is still loading)',
    `session_id=${snapshot.session_id} (ref epoch ${snapshot.epoch}, ${snapshot.refs.length} refs)`,
  ].join('\n')
  // 两条告警都放在**大纲正文之前**：这份回执的正文可能几千行（实测中位 5516 字符，上限 33285），
  // 塞进末尾的 notes 等于没报 —— 模型读到那段时早就不看后面了。
  const warnings = [
    snapshot.page_changed === undefined ? '' : formatPageChanged(snapshot.page_changed),
    snapshot.rebound_refs === undefined || snapshot.rebound_refs.length === 0
      ? ''
      : formatReboundRefs(snapshot.rebound_refs),
  ].filter(entry => entry !== '')
  const body = snapshot.outline.length > 0 ? snapshot.outline : '(the outline is empty — the page may still be loading)'
  const notes = [
    'Actionable elements carry [ref=eN] in the outline; those refs are valid only for this epoch.',
    UNTRUSTED_PAGE_CONTENT_NOTICE,
  ]
  if (snapshot.truncated) {
    // 截断必须「可解释」：说清截到第几行、少给了多少元素、怎么拿更多，
    // 否则模型只能猜（报告 S3 的原始抱怨就是「长页大纲截断」没有任何下文）。
    const lines = snapshot.outline_lines === undefined ? '' : ` after ${String(snapshot.outline_lines)} lines`
    const dropped = snapshot.dropped_elements === undefined
      ? ''
      : ` ${String(snapshot.dropped_elements)} further element(s) were not emitted`
    notes.unshift(
      `The outline was truncated${lines};${dropped === '' ? '' : dropped} — the refs above cover only the emitted part. `
      + `Re-run webpage_snapshot with a larger max_lines (up to ${String(MAX_SNAPSHOT_LINES)}) if you need the rest, `
      + 'or use webpage_find to search the part that was emitted.',
    )
  }
  if (snapshot.outside_region !== undefined) {
    notes.unshift(
      `${String(snapshot.outside_region)} actionable element(s) sit outside this region. `
      + 'This outline is not the whole page — take a full webpage_snapshot if you need those refs.',
    )
  }
  if (snapshot.folded_repeats !== undefined) {
    // 折叠与截断是两回事，必须分开说：折叠的元素**没丢**，ref 还在，只是没打印。
    // 混在一起说会让模型以为「少的东西要靠抬 max_lines 找回来」，而抬预算对折叠毫无作用。
    notes.unshift(
      `${String(snapshot.folded_repeats)} repeated row(s) were folded. `
      + 'Nothing was lost; webpage_find lists every ref and section.',
    )
  }
  if (snapshot.deduped_lines !== undefined) {
    // 去重也**不是**丢东西：同一个名字在一条祖先链上被印了三遍（`heading "X" > link "X" > text "X"`），
    // 只留信息最多的那一行。不解释的话，模型可能会怀疑大纲漏了内容。
    notes.unshift(
      `${String(snapshot.deduped_lines)} nested duplicate row(s) were not printed. `
      + 'Nothing was lost; the retained row keeps the name and any actionable ref.',
    )
  }
  if (snapshot.refs.length === 0) {
    // 零 ref 不是错误，是能力边界：必须告诉模型「这页上没东西可操作」以及还能干什么，
    // 否则它只看到一堆没有 ref 的文本，会反复 snapshot 或直接放弃（报告 S4/S5）。
    notes.unshift(
      'This page has NO actionable elements (no links, buttons, inputs or other controls in the outline), '
      + 'so there is nothing to click, fill or press here — ref-based tools have nothing to act on. '
      + 'You can still scroll without a ref, navigate elsewhere, or use webpage_execute.',
    )
  }
  if (snapshot.takeover === true) {
    // 接管只提示「结果可能随时失效」，**不**说 ref 作废 —— 开合 DevTools 不推进 ref 纪元。
    notes.unshift('NOTE: a human has DevTools open on this page; content may change at any moment.')
  }
  if (snapshot.refs.length > 0) {
    // B3-b（无门禁那段）：把「下一步怎么用」写在末尾 —— 模型的默认动作是「再拍一次全页」，
    // 而全页重拍既贵又会把 find 的缓存换掉。默认行数也要说清，免得它一上来就抬 max_lines。
    notes.push(
      `${String(snapshot.refs.length)} actionable element(s) carry refs. For a control you already know: `
      + 'webpage_find it, then take a regional snapshot (region_ref) for a closer look. '
      + `Default max_lines is ${String(DEFAULT_SNAPSHOT_LIMITS.maxLines)} — raise it only when the result says truncated.`,
    )
  }
  const head = warnings.length === 0 ? header : `${header}\n\n${warnings.join('\n\n')}`
  return `${head}\n\n${body}\n\n${notes.join('\n')}`
}

/** 截图的文本渲染；图片本身由 `render` 作为第二个内容块附上。 */
function formatScreenshotOutput(args: { session_id: string }, value: ScreenshotOutput): string {
  const scope = value.ref === undefined ? 'the viewport' : `element ref=${value.ref}`
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
 * @param ctx - 上下文；其 `browser` 服务执行打开动作。
 */
export function registerOpen(ctx: Context): void {
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
      'Navigate an existing session: give url, or history=back / forward / reload to walk the browser\'s own history (exactly one of them — giving both or neither is rejected). Prefer history=back over webpage_execute("history.back()"); at either end of the history it fails with BROWSER_NAVIGATION_FAILED instead of silently doing nothing. Any of these INVALIDATES every ref from earlier snapshots: take a fresh webpage_snapshot before using a ref, or calls fail with BROWSER_STALE_REF. ',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      url: { type: 'string', description: 'Absolute http(s) URL to load. Exclusive with history.' },
      history: {
        type: 'string',
        description: 'Walk the browser history instead of loading a URL: back / forward / reload. Exclusive with url.',
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
      "Compact AX outline, not verbatim source. Full snapshot on first observation/navigation; later prefer regional reads. For reply text after webpage_wait use region_ref covering the CURRENT reply; region_viewport reads only the visible fragment, never proves completeness. [anchor=eN] is read-only: region_ref reads its section; click/fill/press reject it. For exact code/long text: find heading, snapshot(region_ref=anchor), then find(query=unique text,full_text=true) for cached original text/block. Verify tail and truncation; do not reconstruct whitespace from outline tokens. Full snapshots/navigation invalidate refs; a regional snapshot does NOT invalidate other refs. Recover old refs with webpage_revalidate. webpage_find returns folded refs/context. If truncated=true, raise max_lines (up to 2000). With 0 refs, scroll without ref or navigate.",
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      max_lines: {
        type: 'integer',
        description: `Outline size budget (1-${String(MAX_SNAPSHOT_LINES)}), for a long page that came back truncated. Default ${String(DEFAULT_SNAPSHOT_LIMITS.maxLines)}; `
          + 'the character budget scales with it, so raising it really does return more.',
      },
      // 「不使其他 ref 失效」与互斥关系只在顶层描述 + 这里各说一次：三个区域参数各写一遍是重复。
      region_ref: {
        type: 'string',
        description: 'Snapshot only the subtree of this ref. Give at most one region_*; new refs are appended.',
      },
      region_viewport: {
        type: 'boolean',
        description: 'Snapshot only elements whose box intersects the current viewport.',
      },
      region_box: {
        type: 'json',
        description: 'Snapshot only elements intersecting this CSS-pixel rectangle {x, y, width, height} in document coordinates.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...SESSION_OUTPUT_SCHEMA.properties,
          outline: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          outline_lines: { type: 'integer' },
          dropped_elements: { type: 'integer' },
          folded_repeats: { type: 'integer' },
          deduped_lines: { type: 'integer' },
          outside_region: { type: 'integer' },
          refs: { type: 'array', required: true, items: REF_ITEM_SCHEMA },
          takeover: { type: 'boolean' },
          page_changed: PAGE_CHANGED_SCHEMA,
          rebound_refs: { type: 'array', items: REF_ITEM_SCHEMA },
        },
      },
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
      const output = {
        session_id: observation.sessionId,
        url: observation.url,
        title: observation.title,
        epoch: observation.epoch,
        outline: observation.outline,
        truncated: observation.truncated,
        outline_lines: observation.outlineLines,
        ...observation.droppedElements !== undefined ? { dropped_elements: observation.droppedElements } : {},
        ...observation.foldedRepeats !== undefined ? { folded_repeats: observation.foldedRepeats } : {},
        ...observation.dedupedLines !== undefined ? { deduped_lines: observation.dedupedLines } : {},
        ...observation.outsideRegion !== undefined ? { outside_region: observation.outsideRegion } : {},
        refs: observation.refs.map(({ ref, role, name }) => ({ ref, role, name })),
        ...observation.takeover === true ? { takeover: true } : {},
        ...observation.pageChanged !== undefined
          ? { page_changed: toPageChangedOutput(observation.pageChanged) }
          : {},
        // D-5：区域快照复用旧号、把指针换到别的节点上的那几个（只报不作废）。
        ...observation.reboundRefs !== undefined && observation.reboundRefs.length > 0
          ? { rebound_refs: observation.reboundRefs.map(({ ref, role, name }) => ({ ref, role, name })) }
          : {},
      }
      // 落缓存给 webpage_find 用：它只查这份大纲，不再发任何 CDP 命令。
      // 底稿 = 打印行 ∪ 被折叠的实例行 —— 折叠标记承诺「用 find 拿全部实例的 ref」，缓存里少了实例，
      // 这句承诺就是假的（provider 不提供 fullOutline 时退回模型看到的那份，至少不更差）。
      const regional = region !== undefined
      // find 的契约是 LAST snapshot；区域新回复不能继续读旧全页缓存。
      rememberSnapshot(
          cache,
          output,
          observation.fullOutline ?? observation.outline,
          regional
            ? (region.ref !== undefined ? 'ref' : region.viewport === true ? 'viewport' : 'box')
            : undefined,
          observation.fullTexts,
          observation.textBlocks,
      )
      return output
    },
    presentCall: args => observeCall(`Snapshot ${args.session_id}`, 'read', args.session_id),
  }))
}

/**
 * 注册 `webpage_screenshot`。
 * @param ctx - 上下文；其 `browser` 服务取图，`attachments` 服务落盘。
 */
export function registerScreenshot(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'webpage_screenshot',
    description:
      'Capture a PNG of the viewport, of the full page (full_page: true), or of one element (ref). The image is stored as an attachment and returned as an image block. A ref from an obsolete snapshot fails with BROWSER_STALE_REF instead of silently capturing the wrong element. ',
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
  }))
}
