/** 控制台、网络与 CDP 执行工具：诊断输出、schema 和注册。 */

import type { Context } from '@deepseek-ai/cordis'
import {
  type PageChangedOutput,
  formatPageChanged,
  PAGE_CHANGED_SCHEMA,
  SESSION_ID_PARAMETER,
  toPageChangedOutput,
} from '../common-output.ts'
import {
  UNTRUSTED_PAGE_CONTENT_NOTICE,
  BROWSER_OBSERVE_TIMEOUT_MS,
  BROWSER_NAVIGATION_TIMEOUT_MS,
} from '../config.ts'
import { defineTool, callerOf, observeCall } from '../tool-runtime.ts'
import type { SnapshotCache } from '../snapshot-cache.ts'
import { CONSOLE_TEXT_MAX_CHARS } from '../../browser-cdp/console.ts'
import { NETWORK_MAX_BASE64_CHARS, NETWORK_MAX_BODY_CHARS } from '../../browser-cdp/network.ts'
import { type BrowserNetworkEntry, BrowserError } from '../../browser/index.ts'
import { MAX_P2_LIMIT, DEFAULT_P2_LIMIT } from '../../browser-cdp/provider.ts'
import { unwrapExecuteEnvelope, wrapExecuteFunctionBody } from './execute-script.ts'

/**
 * schema DSL 的 `{ type: 'json' }` 对应的值类型。
 *
 * provider 侧 execute 值是 `unknown`；工具层只把受页面包装器验证后的 JSON 值交给输出 schema。
 */
type SerializableJson = string | number | boolean | null | SerializableJson[] | { [key: string]: SerializableJson }

/** `webpage_console` 的输出。 */
interface ConsoleOutput {
  session_id: string
  buffered: number
  truncated: boolean
  replay_truncated: boolean
  /** 当前文档序号（0 起）；本会话观察到几次导航就加几。 */
  document: number
  /** 属于更早文档、**没被返回**的条目数（`all_documents: true` 时恒为 0）。 */
  earlier_documents: number
  /** 被文本总量预算截断（调大 limit 无用，得用 level/text 过滤）。 */
  truncated_by_budget: boolean
  entries: { level: string; text: string; timestamp: number; source: string }[]
}

/** `webpage_network` 的输出（list 与 body 共用一份宽 schema）。 */
interface NetworkOutput {
  session_id: string
  action: 'list' | 'body'
  requests: {
    request_id: string
    method?: string
    url: string
    status?: number
    mime_type?: string
    from_disk_cache?: boolean
    partial?: boolean
    reason?: string
    error_text?: string
  }[]
  request_id?: string
  body?: string
  base64_encoded?: boolean
  /** list：还有更多请求没返回；body：正文超长被裁剪。 */
  truncated?: boolean
  /** list 动作才有：当前文档序号（0 起）。 */
  document?: number
  /** list 动作才有：属于更早文档、**没被列出**的请求数（`all_documents: true` 时恒为 0）。 */
  earlier_documents?: number
  /** list 动作才有：被 URL 总量预算截断（调大 limit 无用，得用 url 过滤）。 */
  truncated_by_budget?: boolean
}

/** `webpage_execute` 的输出。 */
interface ExecuteOutput {
  session_id: string
  method: string
  has_value: boolean
  epoch: number
  url: string
  title?: string
  navigated: boolean
  /** P2：页面在本会话之外变过（脏时才出现）。 */
  page_changed?: PageChangedOutput
  value?: unknown
  truncated: boolean
}

/** console 结果的文本渲染：条目是不可信数据，逐条列出并附上窗口信息。 */
function formatConsoleOutput(value: ConsoleOutput): string {
  const header = `session_id=${value.session_id} — ${value.entries.length} entr${value.entries.length === 1 ? 'y' : 'ies'} `
    + `(buffer holds ${value.buffered}, newest first)`
  const rows = value.entries.length === 0
    ? ['(no console entries match)']
    : value.entries.map(entry => `[${entry.source}/${entry.level}] ${entry.text}`)
  const notes = [UNTRUSTED_PAGE_CONTENT_NOTICE]
  if (value.truncated_by_budget) {
    // 被**总量预算**截断时「调大 limit」是假建议 —— 必须说成「过滤」。
    notes.unshift(
      `The result was cut to fit the size budget (a single console entry can be ${String(CONSOLE_TEXT_MAX_CHARS)} chars), so `
      + '**raising limit will not add more** — narrow it with level/text instead.',
    )
  } else if (value.truncated) {
    notes.unshift('Only the newest entries are shown; pass a higher limit for more.')
  }
  if (value.earlier_documents > 0) {
    // 跨导航的过滤必须说清楚「遮了多少」：条目还在缓冲里，不是丢了（报告 S5）。
    notes.unshift(
      `${value.earlier_documents} buffered entr${value.earlier_documents === 1 ? 'y belongs' : 'ies belong'} `
      + 'to an earlier document (this tab navigated since) and is not shown; pass all_documents=true to read it too.',
    )
  }
  if (value.replay_truncated) {
    notes.unshift(
      'The Log domain reported that older entries were dropped, so this window is incomplete '
      + '(the console buffer keeps at most 1000 entries, the same cap on replay after a detach).',
    )
  }
  return [header, ...rows, '', ...notes].join('\n')
}

/** network list 的文本渲染。 */
function formatNetworkList(value: NetworkOutput): string {
  const rows = value.requests.length === 0
    ? ['(no network requests recorded for the current document — Network events are never replayed, '
      + 'so requests that finished while the debugger was detached are gone)']
    : value.requests.map((request) => {
      const method = request.method ?? '?'
      const status = request.status === undefined ? '—' : String(request.status)
      const bits = [
        request.mime_type !== undefined ? request.mime_type : undefined,
        request.from_disk_cache === true ? 'from-disk-cache' : undefined,
        request.partial === true ? `partial:${request.reason ?? 'unknown'}` : undefined,
        request.error_text !== undefined ? `failed:${request.error_text}` : undefined,
      ].filter(bit => bit !== undefined)
      return `- ${request.request_id} ${method} ${request.url} → ${status}${bits.length > 0 ? ` (${bits.join(', ')})` : ''}`
    })
  const notes = [
    'A request marked partial has no requestWillBeSent event (it started while the debugger was detached), '
    + 'so its method and headers are unknown.',
  ]
  if (value.truncated_by_budget === true) {
    // 被**总量预算**截断时「调大 limit」是假建议 —— 必须说成「过滤」。
    notes.unshift(
      'The list was cut to fit the total size budget (URLs can be very long), so **raising limit will not '
      + 'add more** — narrow it with url instead.',
    )
  } else if (value.truncated === true) {
    notes.unshift('Only the newest requests are shown; pass a higher limit or narrow with url for more.')
  }
  if ((value.earlier_documents ?? 0) > 0) {
    notes.unshift(
      `${value.earlier_documents ?? 0} recorded request(s) belong to an earlier document (this tab navigated `
      + 'since) and are hidden; pass all_documents=true to list them too.',
    )
  }
  return [
    `session_id=${value.session_id} — ${value.requests.length} request(s) for the current document, newest first`,
    ...rows,
    ...notes,
    '',
    UNTRUSTED_PAGE_CONTENT_NOTICE,
  ].join('\n')
}

/** network body 的文本渲染。 */
function formatNetworkBody(value: NetworkOutput): string {
  const notes: string[] = []
  if (value.base64_encoded === true) {
    // base64 正文对模型几乎不可读，且很容易吃掉整个窗口预算 —— 明确劝退。
    notes.push(
      'This body is base64-encoded, which means the resource is binary (an image, font, archive or media '
      + `file): the text below is not readable, and it is capped at ${String(NETWORK_MAX_BASE64_CHARS)} chars so it is also incomplete. `
      + 'Do NOT request it again — use webpage_screenshot for a visual, or read the HTML/JSON/text resources '
      + 'instead.',
    )
  }
  if (value.truncated === true && value.base64_encoded !== true) {
    notes.push(
      `The body was truncated to fit the size budget (${String(NETWORK_MAX_BODY_CHARS)} chars); the rest is not retrievable through this `
      + 'tool.',
    )
  }
  return [
    `session_id=${value.session_id} — response body for request_id=${value.request_id ?? ''}`
    + `${value.base64_encoded === true ? ' (base64 encoded)' : ''}${value.truncated === true ? ', truncated' : ''}:`,
    '',
    value.body ?? '',
    '',
    ...notes,
    UNTRUSTED_PAGE_CONTENT_NOTICE,
  ].join('\n')
}

/** execute 结果的文本渲染。 */
function formatExecuteOutput(value: ExecuteOutput): string {
  const payload = value.has_value ? value.value : undefined
  const rendered = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  const notes = [UNTRUSTED_PAGE_CONTENT_NOTICE]
  if (value.navigated) {
    notes.unshift('This command navigated the page: every ref from earlier snapshots is now invalid — run webpage_snapshot again.')
  }
  if (value.truncated) notes.unshift('The result was too large and was truncated to a JSON string.')
  // 逃生舱能跑任意页面代码，所以「页面在本会话之外变过」这条线索放在**正文之前**：
  // 返回体可能很大，放末尾等于没报。
  const changed = value.page_changed === undefined ? '' : `\n${formatPageChanged(value.page_changed)}\n`
  return [
    `${value.method} on session_id=${value.session_id} (at ${value.url}${value.title !== undefined ? ` — ${value.title}` : ''}, ref epoch ${value.epoch})`,
    changed,
    value.has_value ? (rendered ?? 'null') : 'The function completed without returning a value (undefined). Use return when you need data.',
    '',
    ...notes,
  ].join('\n')
}

/** `webpage_console` 里的一条。 */
const CONSOLE_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    level: { type: 'string', required: true },
    text: { type: 'string', required: true },
    timestamp: { type: 'number', required: true },
    source: { type: 'string', required: true },
  },
} as const

/** `webpage_console` 的输出契约。 */
const CONSOLE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    buffered: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    replay_truncated: { type: 'boolean', required: true },
    document: { type: 'integer', required: true },
    earlier_documents: { type: 'integer', required: true },
    truncated_by_budget: { type: 'boolean', required: true },
    entries: { type: 'array', required: true, items: CONSOLE_ENTRY_SCHEMA },
  },
} as const

/** `webpage_network` list 里的一条。 */
const NETWORK_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    request_id: { type: 'string', required: true },
    method: { type: 'string' },
    url: { type: 'string', required: true },
    status: { type: 'integer' },
    mime_type: { type: 'string' },
    from_disk_cache: { type: 'boolean' },
    partial: { type: 'boolean' },
    reason: { type: 'string' },
    error_text: { type: 'string' },
  },
} as const

/** `webpage_network` 的输出契约（list 与 body 共用一份宽 schema）。 */
const NETWORK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    action: { type: 'string', required: true },
    requests: { type: 'array', required: true, items: NETWORK_REQUEST_SCHEMA },
    request_id: { type: 'string' },
    body: { type: 'string' },
    base64_encoded: { type: 'boolean' },
    truncated: { type: 'boolean' },
    document: { type: 'integer' },
    earlier_documents: { type: 'integer' },
    truncated_by_budget: { type: 'boolean' },
  },
} as const

/** `webpage_execute` 的输出契约；仅有返回值时包含 value，undefined 由 has_value 区分。 */
const EXECUTE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    method: { type: 'string', required: true },
    has_value: { type: 'boolean', required: true },
    epoch: { type: 'integer', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string' },
    navigated: { type: 'boolean', required: true },
    page_changed: PAGE_CHANGED_SCHEMA,
    value: { type: 'json' },
    truncated: { type: 'boolean', required: true },
  },
} as const

/**
 * 把 provider 侧的网络条目投影成工具输出（snake_case）。
 */
function toNetworkRequestOutput(entry: BrowserNetworkEntry): NetworkOutput['requests'][number] {
  return {
    request_id: entry.requestId,
    ...entry.method !== undefined ? { method: entry.method } : {},
    url: entry.url,
    ...entry.status !== undefined ? { status: entry.status } : {},
    ...entry.mimeType !== undefined ? { mime_type: entry.mimeType } : {},
    ...entry.fromDiskCache !== undefined ? { from_disk_cache: entry.fromDiskCache } : {},
    ...entry.partial !== undefined ? { partial: entry.partial } : {},
    ...entry.reason !== undefined ? { reason: entry.reason } : {},
    ...entry.errorText !== undefined ? { error_text: entry.errorText } : {},
  }
}

/**
 * 注册 `webpage_console`：读会话的 console 环形缓冲。
 *
 * 采集在会话建立时就已开启（provider 侧订阅 `Runtime.consoleAPICalled` + `Log.entryAdded`）；
 * 每次读取前 provider 会补发 `Runtime.enable` / `Log.enable` 找回 re-attach 后可能丢失的
 * enable 状态，ephemeral 的全量重放由高水位去重吃掉。
 */
export function registerConsole(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'webpage_console',
    description:
      'Read the recent console output of a controlled tab: JavaScript console messages and browser log entries, merged and deduplicated, newest first. Collection starts when the tab is opened; reading re-enables both domains, and the resulting replay is deduplicated by a per-stream high-watermark, so no entry is ever reported twice. At most the newest 1000 entries are kept, so older ones are lost in a long window — replay_truncated reports when the Log domain dropped some. ',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      limit: {
        type: 'integer',
        description: `Maximum entries to return, newest first (1-${String(MAX_P2_LIMIT)}). Default ${String(DEFAULT_P2_LIMIT)}. `
          + `One entry can be ${String(CONSOLE_TEXT_MAX_CHARS)} chars, so the result is also cut by a total size budget: `
          + 'when truncated_by_budget is true, narrow with level/text instead of raising this.',
      },
      level: { type: 'string', description: 'Exact level filter, e.g. info or error.' },
      text: { type: 'string', description: 'Substring filter on the entry text (case-insensitive).' },
      all_documents: {
        type: 'boolean',
        description: 'Include entries from earlier documents of this tab (before its last navigation). '
          + 'Default false: only the current document.',
      },
    },
    output: {
      schema: CONSOLE_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatConsoleOutput(value as ConsoleOutput) }],
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    async execute(args, exec) {
      const result = await ctx.browser.console({
        sessionId: args.session_id,
        ...args.limit !== undefined ? { limit: args.limit } : {},
        ...args.level !== undefined ? { level: args.level } : {},
        ...args.text !== undefined ? { text: args.text } : {},
        ...args.all_documents !== undefined ? { allDocuments: args.all_documents } : {},
      }, callerOf(exec), exec.signal)
      return {
        session_id: result.sessionId,
        buffered: result.buffered,
        truncated: result.truncated,
        replay_truncated: result.replayTruncated,
        document: result.document,
        earlier_documents: result.earlierDocuments,
        truncated_by_budget: result.truncatedByBudget,
        entries: result.entries.map(entry => ({
          level: entry.level,
          text: entry.text,
          timestamp: entry.timestamp,
          source: entry.source,
        })),
      }
    },
    presentCall: args => observeCall(`Console ${args.session_id}`, 'read', args.session_id),
  }))
}

/**
 * 注册 `webpage_network`：list（列请求）/ body（按 requestId 取响应体）。
 *
 * 只读采集，不做任何请求拦截：禁止 `Fetch.enable`，也不调 `Network.emulateNetworkConditions` /
 * `setExtraHTTPHeaders`（`[V25][V26]` 会跨 client 污染人工会话）。
 */
export function registerNetwork(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'webpage_network',
    description:
      'Inspect the network activity of a controlled tab. action=list returns recent requests (newest first) with request_id, method, url, status, mime_type and disk-cache flag; action=body fetches one response body. Collection is read-only (Network.enable only; no interception or rewriting). IMPORTANT: network events are never replayed — a request that finished while the debugger was detached is lost, and one that started then is reported as partial with unknown method and headers. ',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      action: { type: 'string', required: true, description: 'One of: list, body.' },
      request_id: { type: 'string', description: 'Fetch the response body of this request_id (action=body only).' },
      limit: {
        type: 'integer',
        description: `Maximum requests to return for action=list (1-${String(MAX_P2_LIMIT)}). Default ${String(DEFAULT_P2_LIMIT)}. `
          + 'URLs are long, so the list is also cut by a total size budget: when '
          + 'truncated_by_budget is true, narrow with url instead of raising this.',
      },
      url: { type: 'string', description: 'Substring filter on the request URL. action=list only.' },
      all_documents: {
        type: 'boolean',
        description: 'Include requests from earlier documents of this tab (before its last navigation). '
          + 'Default false: only the current document.',
      },
    },
    output: {
      schema: NETWORK_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: (value as NetworkOutput).action === 'body'
          ? formatNetworkBody(value as NetworkOutput)
          : formatNetworkList(value as NetworkOutput),
      }],
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    async execute(args, exec) {
      if (args.action !== 'list' && args.action !== 'body') {
        throw new Error('action must be one of: list, body')
      }
      if (args.action === 'body') {
        if (args.request_id === undefined) throw new Error('action "body" requires request_id')
        const result = await ctx.browser.network(
          { kind: 'body', sessionId: args.session_id, requestId: args.request_id },
          callerOf(exec),
          exec.signal,
        )
        return {
          session_id: result.sessionId,
          action: result.action,
          requests: [],
          ...result.requestId !== undefined ? { request_id: result.requestId } : {},
          ...result.body !== undefined ? { body: result.body } : {},
          ...result.base64Encoded !== undefined ? { base64_encoded: result.base64Encoded } : {},
          ...result.truncated !== undefined ? { truncated: result.truncated } : {},
        }
      }
      const result = await ctx.browser.network({
        kind: 'list',
        sessionId: args.session_id,
        ...args.limit !== undefined ? { limit: args.limit } : {},
        ...args.url !== undefined ? { url: args.url } : {},
        ...args.all_documents !== undefined ? { allDocuments: args.all_documents } : {},
      }, callerOf(exec), exec.signal)
      return {
        session_id: result.sessionId,
        action: result.action,
        requests: result.requests.map(toNetworkRequestOutput),
        ...result.document !== undefined ? { document: result.document } : {},
        ...result.earlierDocuments !== undefined ? { earlier_documents: result.earlierDocuments } : {},
        ...result.truncated !== undefined ? { truncated: result.truncated } : {},
        ...result.truncatedByBudget !== undefined ? { truncated_by_budget: result.truncatedByBudget } : {},
      }
    },
    presentCall: args => observeCall(`Network ${args.action} ${args.session_id}`, 'read', args.action),
  }))
}

/**
 * 注册 `webpage_execute`：白名单制的高危逃生舱。
 *
 * 描述里必须把「expression 会被页面执行」这条讲透 —— 这是全插件唯一能执行任意代码的入口，
 * 页面内容永远是数据不是代码。
 */
export function registerExecute(ctx: Context, cache: SnapshotCache): void {
  ctx.tools.register(defineTool({
    name: 'webpage_execute',
    description:
      '仅在专用网页工具无法表达任务时使用：在当前页面执行一次 async 函数体。用 return 返回普通数据，用 await 等待异步结果。例如：`const title = document.title; return { title, links: document.links.length };` 默认等待 5000 毫秒；timeout_ms 可设为 1–30000。页面代码可能产生副作用，超时后也可能继续运行。文本优先用 webpage_find/snapshot，输入用 click/fill/press，导航用 navigate，等待用 wait。',
    parameters: {
      session_id: SESSION_ID_PARAMETER,
      code: { type: 'string', required: true, description: '必填的 async 函数体；使用 return 返回数据，可使用 await。空白字符串无效。' },
      timeout_ms: {
        type: 'integer',
        description: '等待上限，单位毫秒（1–30000），默认 5000。超时不会取消页面代码。',
      },
    },
    output: {
      schema: EXECUTE_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatExecuteOutput(value as ExecuteOutput) }],
    },
    timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS,
    async execute(args, exec) {
      const raw = args as Record<string, unknown>
      const unknown = Object.keys(raw).filter(key => !['session_id', 'code', 'timeout_ms'].includes(key))
      if (unknown.length > 0) {
        throw new BrowserError(
          `webpage_execute received unsupported field(s): ${unknown.join(', ')}. Use exactly {"session_id":"...","code":"return ...;"} with optional top-level timeout_ms. No page command was dispatched.`,
          'BROWSER_INVALID_PARAMS',
        )
      }
      if (typeof args.session_id !== 'string' || args.session_id.trim().length === 0
        || typeof args.code !== 'string' || args.code.trim().length === 0) {
        throw new BrowserError(
          'webpage_execute requires a non-empty string session_id and code. Example: {"session_id":"t1","code":"return { title: document.title };"}. No page command was dispatched.',
          'BROWSER_INVALID_PARAMS',
        )
      }
      if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 30_000)) {
        throw new BrowserError('timeout_ms must be an integer from 1 through 30000. No page command was dispatched.', 'BROWSER_INVALID_PARAMS')
      }
      const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 5_000
      let result
      try {
        result = await ctx.browser.execute({
          sessionId: args.session_id,
          method: 'Runtime.evaluate',
          params: { expression: wrapExecuteFunctionBody(args.code) },
          timeoutMs,
        }, callerOf(exec), exec.signal)
      } catch (error) {
        if (error instanceof BrowserError && error.code === 'BROWSER_CDP_COMMAND_TIMEOUT') {
          throw new BrowserError(
            `webpage_execute stopped waiting after ${error.timeoutMs ?? timeoutMs} ms. The result is unconfirmed; page code may still be running and side effects are not rolled back. Do not rerun until you inspect the page state.`,
            'BROWSER_EXECUTE_TIMEOUT',
          )
        }
        throw error
      }
      // `Page.navigate` / `Page.reload` / 表达式里的 `location.href=…` 都会作废该会话的
      // 全部 ref —— 缓存里那份旧大纲必须一起丢掉，否则下一次 webpage_find 会拿已废的
      // ref 去喂 webpage_click，模型撞 BROWSER_STALE_REF 却不知道为什么。
      if (result.navigated) cache.delete(result.sessionId)
      const envelope = unwrapExecuteEnvelope(result.value)
      if (envelope.script_error !== undefined) {
        throw new BrowserError(
          envelope.script_error.phase === 'compile'
            ? `webpage_execute ${envelope.script_error.name}: ${envelope.script_error.message}${envelope.script_error.stack === undefined ? '' : `\n${envelope.script_error.stack}`} The function body did not run; correct the code and call again.`
            : `webpage_execute ${envelope.script_error.name}: ${envelope.script_error.message}${envelope.script_error.stack === undefined ? '' : `\n${envelope.script_error.stack}`} The function body ran once; any side effects are not rolled back. Inspect page state before deciding whether to call again.`,
          'BROWSER_EXECUTE_SCRIPT_ERROR',
        )
      }
      if (envelope.serialization_error !== undefined) {
        throw new BrowserError(
          `webpage_execute ran once but could not serialize the returned value: ${envelope.serialization_error}. Return only ordinary JSON data and avoid DOM nodes, functions, cycles, accessors, and deep objects. Any side effects are not rolled back.`,
          'BROWSER_EXECUTE_RESULT_UNSERIALIZABLE',
        )
      }
      return {
        session_id: result.sessionId,
        method: result.method,
        has_value: envelope.has_value,
        epoch: result.epoch,
        url: result.url,
        ...result.title !== undefined ? { title: result.title } : {},
        navigated: result.navigated,
        ...result.pageChanged !== undefined ? { page_changed: toPageChangedOutput(result.pageChanged) } : {},
        ...(envelope.has_value ? { value: envelope.value as SerializableJson } : {}),
        truncated: result.truncated || envelope.truncated === true,
      }
    },
    presentCall: args => observeCall('Execute page JavaScript', 'execute', args.session_id),
  }))
}
