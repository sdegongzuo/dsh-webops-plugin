/**
 * 从中性的「已观测记录」里派生出面板要显示的状态。
 *
 * 这里刻意**不 import 任何 dsh 客户端类型**：面板要读的对话快照（`ChatSnapshot`）与
 * 工具调用切片（`ToolCallBlock`）属于别的插件，形状会随上游演化；插件一旦写死它们的
 * 类型，上游一次改名就会让整个 UI 构建失败。所以本模块只认结构、不认类型别名，
 * 输入声明为 `unknown` 并逐层防御性收窄——拿不到就退化成「没有浏览器活动」，
 * 而不是让面板崩掉。
 *
 * 好处是这一层可以完全用固定数据单测（见 `observation.test.ts`），不需要跑客户端运行时。
 */

/** wire 之后仍然保持结构不变、可直接喂给授权加载器的图片附件引用。 */
export interface WireImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name: string | undefined
}

/** 会话里的一次 `webpage_*` 调用，运行中与已结算统一成同一个形状。 */
export interface BrowserCall {
  readonly callId: string
  readonly toolName: string
  /** 已拿到结果（`tool-result` 节点）为 true；仍在跑为 false。 */
  readonly settled: boolean
  readonly isError: boolean
  /** 模型发出的原始参数 JSON。 */
  readonly argsRaw: string
  /** 已结算结果里 `text` 块拼接出的正文。 */
  readonly resultText: string
  /** 结果里的第一张图（`webpage_screenshot` 用）。 */
  readonly image: WireImageRef | undefined
}

/** 面板渲染所需的全部状态，由 {@link observeBrowser} 从调用列表一次性算出。 */
export interface BrowserObservation {
  /** 最近一次调用；整个会话没有浏览器活动时为 `undefined`。 */
  readonly latest: BrowserCall | undefined
  /** 是否有调用仍在运行。 */
  readonly running: boolean
  /** 最近一次带 `url` 参数的调用所指向的地址。 */
  readonly url: string | undefined
  readonly calls: number
  readonly snapshots: number
  readonly screenshots: number
  readonly failures: number
}

/** 本插件认领的工具名前缀。 */
export const BROWSER_TOOL_PREFIX = 'webpage_'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value as readonly unknown[] : []
}

/** 该工具名是不是本插件的。 */
export function isBrowserToolName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(BROWSER_TOOL_PREFIX)
}

/** 拼接结果里的文本块；非文本块（图片等）留给 {@link imageOf}。 */
function textOf(content: unknown): string {
  const parts: string[] = []
  for (const part of asArray(content)) {
    const block = asRecord(part)
    if (block === undefined || block.type !== 'text') continue
    const text = asString(block.text)
    if (text !== undefined && text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/** 取结果里的第一张图；`ImageBlock.attachment` 的字段在 wire 前后是同一组。 */
function imageOf(content: unknown): WireImageRef | undefined {
  for (const part of asArray(content)) {
    const block = asRecord(part)
    if (block === undefined || block.type !== 'image') continue
    const ref = asRecord(block.attachment)
    if (ref === undefined) continue
    const attachmentId = asString(ref.attachmentId)
    const mediaType = asString(ref.mediaType)
    if (attachmentId === undefined || mediaType === undefined) continue
    return {
      attachmentId,
      mediaType,
      bytes: asNumber(ref.bytes),
      width: asNumber(ref.width),
      height: asNumber(ref.height),
      name: asString(ref.name),
    }
  }
  return undefined
}

/** 从参数 JSON 里取 `url`；模型写的参数不保证是合法 JSON，解析失败即视为没有。 */
export function parseBrowserUrl(argsRaw: string): string | undefined {
  if (argsRaw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  const url = record === undefined ? undefined : asString(record.url)
  return url === undefined || url === '' ? undefined : url
}

/**
 * 把一个工具调用切片（运行中或已结算）收窄成 {@link BrowserCall}。
 * @param block - `ToolCallBlock`：有 `kind` 为已结算，否则为运行中。
 * @param toolName - 分发用的 wire 工具名，运行中节点自己不带。
 */
export function callFromBlock(block: unknown, toolName: string): BrowserCall {
  const record = asRecord(block) ?? {}
  const settled = record.kind === 'tool-result'
  const call = asRecord(record.call)
  return {
    callId: asString(record.callId) ?? '',
    toolName,
    settled,
    isError: record.isError === true,
    argsRaw: (settled ? asString(call?.argsRaw) : asString(record.argsRaw)) ?? '',
    resultText: settled ? textOf(record.content) : '',
    image: settled ? imageOf(record.content) : undefined,
  }
}

/**
 * 从对话快照里抽出全部 `webpage_*` 调用。
 *
 * 取的是 `legacy.nodes`（已结算，按日志顺序）与 `legacy.runningCalls`（运行中），
 * 保持原顺序追加：已结算的在前、在跑的在后，于是「最后一项」天然就是最新的那次调用。
 * 截断过的历史节点 `call` 会是 `null`，此时认不出工具名，只能跳过。
 * @param chatSnapshot - `ui-chat` 的 `ChatSnapshot`；形状不符时返回空列表。
 */
export function browserCallsFrom(chatSnapshot: unknown): readonly BrowserCall[] {
  const legacy = asRecord(asRecord(chatSnapshot)?.legacy)
  if (legacy === undefined) return []
  const calls: BrowserCall[] = []
  for (const node of asArray(legacy.nodes)) {
    const record = asRecord(node)
    if (record === undefined || record.kind !== 'tool-result') continue
    const call = asRecord(record.call)
    const name = call === undefined ? undefined : asString(call.name)
    if (!isBrowserToolName(name)) continue
    calls.push(callFromBlock(record, name))
  }
  for (const node of asArray(legacy.runningCalls)) {
    const record = asRecord(node)
    if (record === undefined) continue
    const name = asString(record.name)
    if (!isBrowserToolName(name)) continue
    calls.push(callFromBlock(record, name))
  }
  return calls
}

/**
 * 汇总整个会话的浏览器活动。
 * @param calls - 按时间顺序排列的调用列表（{@link browserCallsFrom} 的输出）。
 */
export function observeBrowser(calls: readonly BrowserCall[]): BrowserObservation {
  let url: string | undefined
  let running = false
  let snapshots = 0
  let screenshots = 0
  let failures = 0
  for (const call of calls) {
    if (!call.settled) running = true
    if (call.settled && call.isError) failures += 1
    if (call.toolName === 'webpage_snapshot') snapshots += 1
    if (call.toolName === 'webpage_screenshot') screenshots += 1
    url = parseBrowserUrl(call.argsRaw) ?? url
  }
  return {
    latest: calls.at(-1),
    running,
    url,
    calls: calls.length,
    snapshots,
    screenshots,
    failures,
  }
}
