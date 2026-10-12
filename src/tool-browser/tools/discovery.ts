/** 页面内容检索与元素定位：专用输出与工具注册。 */

import type { Context } from '@deepseek-ai/cordis'
import {
  type FindMatch,
  type SnapshotCache,
  normalizeWhitespace,
  normalizeFindLimit,
  searchOutline,
} from '../snapshot-cache.ts'
import { UNTRUSTED_PAGE_CONTENT_NOTICE, BROWSER_OBSERVE_TIMEOUT_MS } from '../config.ts'
import { defineTool, callerOf, observeCall } from '../tool-runtime.ts'
import {
  SESSION_ID_PARAMETER,
} from '../common-output.ts'
import { BrowserError } from '../../browser/index.ts'

/** `webpage_find` 的输出。 */
interface FindOutput {
  session_id: string
  matches: FindMatch[]
  truncated: boolean
  /** 缓存里那份大纲本身是被截断的（B2-e）：0 命中不等于「页面上没有」。 */
  outline_truncated?: boolean
  /** 请求了正文读取（项 3）：渲染时把 text/block 带出来。 */
  full_text?: boolean
}

/** `webpage_locate` 的输出。 */
interface LocateOutput {
  session_id: string
  ref: string
  x: number
  y: number
  width: number
  height: number
  /**
   * 测得事实：scroll=true 且最终测量「元素中心对齐视口中心」（±16px 容差）。
   * 「看得见」不算居中；视口尺寸测不到或为零时恒为 false。不是请求回显。
   */
  centered: boolean
  /** 本次是否请求了滚动（与 centered 区分「请求了」和「生效了」）。 */
  scroll_requested: boolean
  in_viewport?: boolean
}

/** find 结果的文本渲染：命中行是不可信数据，逐条列出并附上不可信提示。 */
function formatFindOutput(value: FindOutput): string {
  // 0 命中 + 大纲被截断：最可能的原因是「它在被截掉的那半截里」，而不是「页面上没有」。
  // find 搜的是**已发出**的大纲（不是完整 ref 表），所以这条提示必须出现。
  const rows = value.matches.length === 0
    ? [value.outline_truncated === true
      ? '(no outline line matches) — the cached outline was TRUNCATED, so the line you want is probably in '
        + 'the part that was cut: re-run webpage_snapshot with a larger max_lines and find again.'
      : '(no outline line matches)']
    : value.matches.map((match) => {
      const tag = match.ref.length > 0 ? `[${match.ref}] ${match.role} "${match.name}" — ` : ''
      // 只读锚点要当场讲破用法与边界：能读不能点（项 3 补正）。
      const anchorNote = match.anchor === true
        ? '\n  (read-only anchor: webpage_snapshot(region_ref=this ref) reads this section, webpage_locate/'
          + 'screenshot work too; click/fill/press are rejected with BROWSER_READ_ONLY_ANCHOR)'
        : ''
      const context = match.context === undefined ? '' : `  ← context: ${match.context}`
      const body = [`- ${tag}${match.line}${context}${anchorNote}`]
      // 项 3：full_text=true 时正文按需带出；text 是未裁切整行，block 是整块（代码）。
      if (match.text !== undefined && match.text !== match.line) body.push(`  text: ${match.text}`)
      if (match.block !== undefined) body.push(`  block:\n${match.block}`)
      return body.join('\n')
    })
  const lines = [
    `session_id=${value.session_id} — ${value.matches.length} match(es) in the cached outline of the last webpage_snapshot`,
    ...rows,
  ]
  if (value.truncated) lines.push('More matches may exist; raise limit or narrow the query.')
  lines.push('', UNTRUSTED_PAGE_CONTENT_NOTICE)
  return lines.join('\n')
}

/** locate 结果的文本渲染。 */
/** locate 结果的文本渲染。按事实输出：请求了滚动 ≠ 滚动生效（2026-10-07 实测教训）。 */
function formatLocateOutput(value: LocateOutput): string {
  const visibility = value.in_viewport === undefined
    ? ''
    : value.in_viewport
      ? ' It is inside the viewport right now.'
      : ' It is OUTSIDE the viewport right now (the coordinates can be negative or beyond the viewport size).'
  const scrollFact = value.scroll_requested
    ? value.centered
      ? 'scroll=true was requested and the fresh measurement confirms the element is now centred in the viewport.'
      : 'scroll=true was requested, but the fresh measurement does NOT show the element centred — it may still '
        + 'be outside the viewport, or visible but off-centre (the centring did NOT take effect; a window that is '
        + 'minimized reports a zero viewport and nothing can be centred). Do not treat the scroll as done; '
        + 'restore/scroll explicitly or re-check.'
    : 'The box was measured fresh at call time, WITHOUT scrolling the viewport (pass scroll=true to centre it first).'
  return [
    `ref=${value.ref} is at x=${value.x} y=${value.y}, ${value.width}x${value.height} px in viewport `
    + `coordinates on session_id=${value.session_id}.${visibility}`,
    scrollFact + ' It reflects the page as it is NOW, not the snapshot, and it is how you verify a webpage_scroll.',
    UNTRUSTED_PAGE_CONTENT_NOTICE,
  ].join('\n')
}

/** `webpage_find` 的一条命中；`ref` 为空串表示该行没有可操作元素。 */
const FIND_MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', required: true },
    role: { type: 'string', required: true },
    name: { type: 'string', required: true },
    line: { type: 'string', required: true },
    context: { type: 'string' },
    text: { type: 'string' },
    block: { type: 'string' },
    // 项 3 补正（2026-10-08）：true = 这条 ref 是只读文本锚点（heading 等），
    // 配 webpage_snapshot(region_ref=...) / webpage_locate 读内容，click/fill/press 拒绝。
    anchor: { type: 'boolean' },
  },
} as const

/** `webpage_find` 的输出契约。 */
const FIND_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    matches: { type: 'array', required: true, items: FIND_MATCH_SCHEMA },
    truncated: { type: 'boolean', required: true },
    // B2-e：缓存的那份大纲本身被截断过（`truncated` 是「命中数到了 limit」，两回事）。
    outline_truncated: { type: 'boolean' },
    full_text: { type: 'boolean' },
  },
} as const

/** `webpage_locate` 的输出契约：视口坐标 + 是否先滚动居中 + 是否在视口内。 */
const LOCATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    ref: { type: 'string', required: true },
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    centered: { type: 'boolean', required: true },
    scroll_requested: { type: 'boolean', required: true },
    in_viewport: { type: 'boolean' },
  },
} as const

/**
 * 注册 `webpage_find`：在最近一次 snapshot 的大纲上做零状态文本检索（方案 4.2）。
 *
 * 纯本地检索 —— **不产生任何 CDP 命令**，查的是 {@link SnapshotCache} 里那份大纲；
 * 没有 cache 时报 `BROWSER_SNAPSHOT_REQUIRED`（与「先 snapshot」的既有语义同码同义）。
 */
export function registerFind(ctx: Context, cache: SnapshotCache): void {
  ctx.tools.register(defineTool({
    name: 'webpage_find',
    description:
      'Search the LAST snapshot cache, including folded rows: substring or JS regex. Returns refs/heading context; full_text adds original text/code whitespace. Heading anchor=true selects its own region_ref section, including duplicate headings; anchors grant no writes. No cache: BROWSER_SNAPSHOT_REQUIRED. No page commands.',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      query: {
        type: 'string',
        required: true,
        description: 'Substring to search for; a JavaScript regular expression when regex=true.',
      },
      regex: {
        type: 'boolean',
        description: 'Treat query as a regular expression. Default false.',
      },
      limit: { type: 'integer', description: 'Maximum matches to return (1-100). Default 20.' },
      full_text: {
        type: 'boolean',
        description: 'Also return the unclipped text cached at snapshot time (text, and block for code-block lines). Default false.',
      },
    },
    output: {
      schema: FIND_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatFindOutput(value as FindOutput) }],
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    async execute(args, exec) {
      // 这条工具一个 CDP 命令都不发，查的是工具层自己的缓存 —— 所以它必须**自己**过占用门禁，
      // 否则缓存会变成绕过占用的后门：别的对话能在这儿读到你的页面大纲。
      ctx.browser.assertHeld(args.session_id, callerOf(exec))
      const cached = cache.get(args.session_id)
      if (cached === undefined) {
        throw new BrowserError(
          `no snapshot is cached for session "${args.session_id}"; run webpage_snapshot first, `
          + 'then webpage_find searches its outline. The cache is dropped by navigation and by every full '
          + 'webpage_snapshot — after either of those, find cannot answer until you snapshot again',
          'BROWSER_SNAPSHOT_REQUIRED',
        )
      }
      // regex 解析失败属于参数错误（模型换个写法重试），不是浏览器错误。
      let matcher: (line: string) => boolean
      if (args.regex === true) {
        let pattern: RegExp
        try {
          pattern = new RegExp(args.query, 'i')
        } catch (error: unknown) {
          throw new Error(`query is not a valid regular expression: ${(error as Error).message}`)
        }
        matcher = line => pattern.test(line)
      } else {
        // 空白归一化匹配（\s 含 NBSP U+00A0）：网页标题里的空格常是不可断行空格，
        // 而模型从渲染文本里抄 query 时拿到的是普通空格——两侧都归一，避免漏匹配。
        const needle = normalizeWhitespace(args.query).toLowerCase()
        matcher = line => normalizeWhitespace(line).toLowerCase().includes(needle)
      }
      const limit = normalizeFindLimit(args.limit)
      const fullText = args.full_text === true
      const matches = searchOutline(cached, matcher, limit, fullText)
      if (fullText && cached.fullTexts === undefined) {
        // 缺数据必须明说（项 7 的口径）：这份缓存来自不带正文的旧快照，模型不能猜。
        // 与「0 命中」分开：命中照常返回，只是没有附加正文。
        const hasText = matches.some(match => match.text !== undefined || match.block !== undefined)
        if (!hasText) {
          throw new BrowserError(
            'full_text was requested, but the cached snapshot carries no full text — take a fresh '
            + 'webpage_snapshot, then find again with full_text=true',
            'BROWSER_SNAPSHOT_REQUIRED',
          )
        }
      }
      return {
        session_id: args.session_id,
        matches,
        truncated: matches.length >= limit,
        // 0 命中时「没找到」与「在被截断的那半截里」必须分得开（B2-e）。
        ...cached.truncated ? { outline_truncated: true } : {},
        ...fullText ? { full_text: true } : {},
      }
    },
    presentCall: args => observeCall(`Find "${args.query}" in ${args.session_id}`, 'read', args.query),
  }))
}

/**
 * 注册 `webpage_locate`：按 ref 现算视口坐标盒（方案 4.3 / 4.4，backendNodeId 路线）。
 *
 * 转发到 provider.locate —— 三道失效守卫（resolveNode / isConnected / 零尺寸）与
 * 「每次现算 rect」都在 provider 侧执法，工具层只做参数与结果的 snake_case 投影。
 */
export function registerLocate(ctx: Context, cache: SnapshotCache): void {
  ctx.tools.register(defineTool({
    name: 'webpage_locate',
    description:
      'Measure live viewport x/y/width/height and in_viewport. scroll=false (default) preserves viewport; scroll=true centres the element (16 CSS px tolerance), reporting centered=false if unfinished. BROWSER_STALE_REF needs a fresh snapshot; zero layout boxes fail as invisible. highlight affects only this client\'s outline.',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      ref: { type: 'string', required: true, description: 'Element ref, like e12.' },
      highlight: {
        type: 'boolean',
        description: 'Draw outline; false clears it. Navigation also clears it.',
      },
      scroll: {
        type: 'boolean',
        description: 'Centre before measuring; default false (measure without scrolling).',
      },
    },
    output: {
      schema: LOCATE_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatLocateOutput(value as LocateOutput) }],
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    async execute(args, exec) {
      const result = await ctx.browser.locate({
        sessionId: args.session_id,
        ref: args.ref,
        ...args.highlight !== undefined ? { highlight: args.highlight } : {},
        ...args.scroll !== undefined ? { scroll: args.scroll } : {},
      }, callerOf(exec), exec.signal)
      return {
        session_id: result.sessionId,
        ref: result.ref,
        x: result.x,
        y: result.y,
        width: result.width,
        height: result.height,
        centered: result.centered,
        scroll_requested: result.scrollRequested,
        ...result.inViewport !== undefined ? { in_viewport: result.inViewport } : {},
      }
    },
    presentCall: args => observeCall(`Locate ${args.ref} in ${args.session_id}`, 'read', args.ref),
  }, cache))
}
