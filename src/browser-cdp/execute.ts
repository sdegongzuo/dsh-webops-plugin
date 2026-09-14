/**
 * `browser_execute` 的能力边界与返回值处理（方案 3.3）。
 *
 * ## 白名单制，默认拒
 *
 * 原方案的「拒绝列表」是反的：命令会不断加入，黑名单永远追不上，任何没被列出的新命令默认
 * 都是**放行**。这与 7.2「新命令默认按共享处理」、3.2「采集期间不得调
 * `Network.emulateNetworkConditions`」的保守哲学自相矛盾。所以改成**默认拒**：不在允许列表里的
 * `domain.method` 一律 `BROWSER_EXECUTE_NOT_ALLOWED`，错误消息里带上被拒的 method 全文。
 *
 * 允许列表（只读 / session 私有 / 只导航）：
 * `Runtime.evaluate`、`Runtime.getProperties`、`DOM.getDocument`、`DOM.querySelector`、
 * `Page.navigate`、`Page.reload`、`Page.captureScreenshot`、`Accessibility.getFullAXTree`、
 * `Network.enable`、`Network.getResponseBody`、`Log.enable`。
 *
 * ## 必须拒绝的（无论允许列表怎么长）
 *
 * | 前缀 / 命令 | 理由（各按方案 3.3） |
 * |---|---|
 * | `Target.*` | `Target.attachToTarget` 可拿到**其它标签页**的 session，越出本会话边界 |
 * | `Browser.*` | `Browser.close` 关掉整个浏览器 |
 * | `Emulation.*` / `Fetch.*` | 跨 client 污染 `[V6][V9]`；`Fetch.enable` 还能拦截、改写请求 |
 * | `Overlay.*` | **理由不是「跨 client」**：`[V31]` 实测多 client 高亮各自独立。拒它是因为它是**给眼睛看的副作用**——会污染截图、干扰人工在 DevTools Elements 里的高亮，而 `highlightRect` 的 `color` 还会把整个视口染色 `[V32]`。agent 的高亮走 `browser_locate` 这条受控通道 |
 * | `Input.*` | 绕过 P1 的 `BROWSER_TOOL_CAPABILITIES` 分级，架空 `read`/`mutate` 判定 |
 * | `Network.emulateNetworkConditions` / `Network.setExtraHTTPHeaders` | `[V25][V26]` 实测跨 client 覆盖、后写赢，会污染人工会话 |
 * | `Network.setCacheDisabled` | `[V27]` 作用域无法判定，按最坏假设处理 |
 * | `Page.addScriptToEvaluateOnNewDocument` / `remove…` | `[V35]` 实测注册表是 target 级共享：注册者不导航、**别人触发的导航照样被注入**。副作用要到「下一次导航」才显形，事后无法察觉 |
 *
 * ## 返回值处理（三种失败形态，`[V22]` 全部实测）
 *
 * `document.body` + `returnByValue` 会**静默返回 `{}`**（不报错，最危险）；循环引用 / `window`
 * 抛 `Object reference chain is too long`；`Symbol('s')` 抛 `Object couldn't be returned by value`。
 * 所以**不能只判 `result.value === undefined`**，要同时看 `result.type` / `result.subtype`。
 *
 * ## Promise：等它落定，再判能不能跨边界（2026-09-14 修）
 *
 * 报告 S5 实测：`fetch('/get').then(r => r.status)` 报 `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`，
 * 但 network 里那条 `GET /get` 明明已经 200 —— 表达式**已经跑完并产生了副作用**，只是返回值是个
 * `Promise`（`subtype: 'promise'`，没有 `value`），于是被当成「不可序列化」拒掉。现在两条一起改：
 *
 * 1. provider 给 `Runtime.evaluate` 强制带上 `awaitPromise: true`，Promise 落定后返回**它兑现的值**；
 * 2. 仍然拿到 `promise` / `error` 这类没有 `value` 的对象时，错误消息**如实说明表达式已执行**，
 *    不再让调用方以为是「没跑」。
 *
 * 另外 `exceptionDetails`（表达式抛异常、或者被 await 的 Promise reject）不再被压成
 * 「不可序列化」，而是由 {@link extractEvaluateException} 取出真实异常文本。
 *
 * @module dsh-webops-plugin/browser-cdp/execute
 */

import { BrowserError } from '../browser/types.ts'

/** 允许通过的 CDP 方法（完整名单，一条都不多）。 */
export const BROWSER_EXECUTE_ALLOWED: readonly string[] = Object.freeze([
  'Runtime.evaluate',
  'Runtime.getProperties',
  'DOM.getDocument',
  'DOM.querySelector',
  'Page.navigate',
  'Page.reload',
  'Page.captureScreenshot',
  'Accessibility.getFullAXTree',
  'Network.enable',
  'Network.getResponseBody',
  'Log.enable',
])

/** 整段前缀一律拒绝的理由。 */
const DENIED_PREFIXES: readonly { readonly prefix: string; readonly reason: string }[] = [
  { prefix: 'Target.', reason: 'Target.attachToTarget can obtain a session for a different tab, escaping this session boundary' },
  { prefix: 'Browser.', reason: 'Browser.close would close the whole browser' },
  { prefix: 'Emulation.', reason: 'Emulation.* writes target-level state shared across clients [V6][V9]' },
  { prefix: 'Fetch.', reason: 'Fetch.enable intercepts and can rewrite requests across clients' },
  { prefix: 'Overlay.', reason: 'Overlay.* is a visible side effect for the human eye: it pollutes screenshots and the human DevTools highlight, and highlightRect tints the whole viewport [V32]' },
  { prefix: 'Input.', reason: 'Input.* bypasses the P1 read/mutate capability grading' },
]

/** 单条命令一律拒绝的理由。 */
const DENIED_METHODS: ReadonlyMap<string, string> = new Map([
  [
    'Network.emulateNetworkConditions',
    'Network.emulateNetworkConditions is shared across clients and last-write-wins [V25], so it would pollute the human session',
  ],
  [
    'Network.setExtraHTTPHeaders',
    'Network.setExtraHTTPHeaders is shared across clients and last-write-wins [V26], so it would pollute the human session',
  ],
  [
    'Network.setCacheDisabled',
    'the scope of Network.setCacheDisabled is undecidable in this environment [V27], so it is rejected under the worst-case assumption',
  ],
  [
    'Page.addScriptToEvaluateOnNewDocument',
    'the Page.addScriptToEvaluateOnNewDocument registry is target-level shared: a script registered here is injected into navigations triggered by ANY client [V35]',
  ],
  [
    'Page.removeScriptToEvaluateOnNewDocument',
    'Page.removeScriptToEvaluateOnNewDocument manipulates a target-level shared registry [V35]',
  ],
])

/**
 * 校验一条 CDP 方法是否允许执行。
 * @param method - 模型给出的 `domain.method` 全文。
 * @throws `BROWSER_EXECUTE_NOT_ALLOWED`：命中拒绝列表，或不在允许列表里（默认拒）。
 */
export function assertExecuteAllowed(method: string): void {
  for (const { prefix, reason } of DENIED_PREFIXES) {
    if (method.startsWith(prefix)) {
      throw notAllowed(method, reason)
    }
  }
  const denied = DENIED_METHODS.get(method)
  if (denied !== undefined) {
    throw notAllowed(method, denied)
  }
  if (!BROWSER_EXECUTE_ALLOWED.includes(method)) {
    throw notAllowed(
      method,
      'it is not on the browser_execute allow-list, and every command is denied by default — a new command '
      + 'must be reviewed and added to the allow-list explicitly, never admitted by omission',
    )
  }
}

/** 造一条带 method 全文的拒绝错误。 */
function notAllowed(method: string, reason: string): BrowserError {
  return new BrowserError(
    `browser_execute refused the CDP command "${method}": ${reason}. `
    + 'Only the read-only / session-private commands on its allow-list may run through this escape hatch.',
    'BROWSER_EXECUTE_NOT_ALLOWED',
  )
}

/** `Runtime.evaluate` 的结果 RemoteObject（只声明用到的字段）。 */
interface RemoteObject {
  readonly type?: unknown
  readonly subtype?: unknown
  readonly value?: unknown
  readonly description?: unknown
}

/** 一个值是不是「没有任何自身可枚举键的普通对象」。 */
function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
}

/** `Runtime.evaluate` 结果里的 `exceptionDetails`（表达式抛错 / 被 await 的 Promise reject）。 */
interface ExceptionDetails {
  readonly text?: unknown
  readonly exception?: { readonly description?: unknown; readonly value?: unknown; readonly preview?: unknown }
}

/**
 * 从 `Runtime.evaluate` 的返回体里取出异常文本。
 *
 * 为什么必须单独处理：被 `await` 的 Promise **reject** 时，CDP 把错误放在 `exceptionDetails`
 * 而不是抛协议错误 —— 只按返回值三态判会把它当成「不可序列化」，模型看到的是
 * `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`，而真实原因是页面上那句表达式抛了。
 *
 * @param result - CDP 返回的 `{ result, exceptionDetails }`。
 * @returns 异常文本；没有异常时 `undefined`。
 */
export function extractEvaluateException(result: unknown): string | undefined {
  const details = (result as { exceptionDetails?: ExceptionDetails } | null | undefined)?.exceptionDetails
  if (details === undefined || details === null) return undefined
  const description = details.exception?.description
  if (typeof description === 'string' && description.length > 0) return description
  const value = details.exception?.value
  if (typeof value === 'string' && value.length > 0) return value
  const text = details.text
  return typeof text === 'string' && text.length > 0 ? text : 'the evaluated expression threw an unknown error'
}

/**
 * 从 `Runtime.evaluate` 的返回体里取出可序列化的值（方案 3.3 的三态处理）。
 *
 * @param result - CDP 返回的 `{ result: RemoteObject }`。
 * @returns 可序列化的值。
 * @throws `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`：`document.body` 那种静默 `{}`、DOM 节点、
 * 函数 / Symbol / Promise 等无法跨 CDP 边界返回的值。
 */
export function extractEvaluateValue(result: unknown): unknown {
  const remote = (result as { result?: RemoteObject } | null | undefined)?.result
  if (remote === undefined || typeof remote !== 'object' || remote === null) {
    throw unserializable('CDP returned no value object for this expression')
  }
  const type = typeof remote.type === 'string' ? remote.type : 'undefined'
  const subtype = typeof remote.subtype === 'string' ? remote.subtype : undefined
  const value = remote.value
  if (type === 'object') {
    // `document.body` 会静默变成 `{}`（看着有值其实是垃圾），DOM 节点 subtype 是 `node`。
    if (subtype === 'promise') {
      // 走到这里说明 awaitPromise 没生效（老版本 / 被调用方显式关掉）。表达式**已经跑了**，
      // 必须说清楚，否则调用方会以为「什么都没发生」而重复执行一次带副作用的表达式。
      throw unserializable(
        'the expression returned a Promise and it was not awaited, so there is no value to return '
        + '(the expression itself has already run and may have had side effects)',
      )
    }
    if (subtype === 'node' || value === undefined || isEmptyObject(value)) {
      throw unserializable('the expression returned a DOM node or an object that serialized to an empty value')
    }
  } else if (value === undefined && type !== 'undefined') {
    // function / symbol 之类没有可返回值。
    throw unserializable(`the expression returned a ${type} value that cannot cross the CDP boundary`)
  }
  return value
}

/**
 * 把 CDP 在返回值序列化时抛出的两个错误消息映射成能力错误码（`[V22]`）。
 * @param error - provider 捕获到的任意错误。
 * @returns 若是「无法序列化」，返回映射后的错误；否则原样返回。
 */
export function translateEvaluateError(error: unknown): unknown {
  if (!(error instanceof BrowserError) || error.code !== 'BROWSER_PROTOCOL_ERROR') return error
  const { message } = error
  if (message.includes('Object reference chain is too long') || message.includes("Object couldn't be returned by value")) {
    return unserializable(message)
  }
  return error
}

/** 造一条「返回值无法序列化」的错误，并告诉模型正确的写法。 */
function unserializable(detail: string): BrowserError {
  return new BrowserError(
    `the expression's value could not be serialized by CDP: ${detail}. `
    + 'The expression itself has already run in the page, so any side effect it had is NOT rolled back. '
    + 'Return a primitive value or a JSON string (for example JSON.stringify(...)) instead of a DOM node, '
    + 'a cyclic object, a function, a Symbol, or an unawaited Promise.',
    'BROWSER_EXECUTE_RESULT_UNSERIALIZABLE',
  )
}
