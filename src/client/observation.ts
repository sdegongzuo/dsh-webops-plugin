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
  /** 最新有效页面观察的自报地址（L8：click 导航、历史后退、execute 都能更新）。 */
  readonly url: string | undefined
  /** 最新有效页面观察的自报标题；只有参数兜底或无回执标题时为 `undefined`。 */
  readonly title: string | undefined
  /**
   * 当前地址所属的受控标签（回执 `session_id=t9` 里的 `t9`）。
   * 地址来自参数兜底（而非回执观察）时为 `undefined` —— 那次调用还没带回「这是哪个标签」。
   */
  readonly sessionId: string | undefined
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

/** 一次「页面此刻在哪」的观测：实际地址 + 标题 + 它属于哪个受控标签。 */
export interface PageObservation {
  readonly url: string
  readonly title: string | undefined
  readonly sessionId: string | undefined
  /**
   * 回执头部自报的 ref epoch（页面身份的单调序号，同一标签内只增不减）。
   * 用它识别「晚到旧结果」：同标签内 epoch 更小的回执是过时观察，不得覆盖新状态。
   * tabs 行不带 epoch，按宿主保证的模型调用顺序应用。
   */
  readonly epoch: number | undefined
}

/** 回执头部里的受控标签号（`session_id=t9 (ref epoch …)` → `t9`）。 */
const SESSION_ID_PATTERN = /session_id=([^\s),]+)/

/** 尾部「`, ref epoch 4)` / `, ref epoch 4).`」——epoch 序号紧贴行尾。 */
const EPOCH_TAIL = /, ref epoch (\d+)\)?\.?$/

/**
 * 把 `(now at …)` / `(at …)` 括号内的载荷拆成地址、标题与 epoch。
 *
 * 边界按「最后一个 `, ref epoch N`」与行尾定位，**不**把地址自身的逗号、括号当分隔符
 * （独立验收：`/chapter?x=a,b(c)` 被旧正则截断到 `a`）。剥掉 epoch 段后：
 * `URL — 标题`（动作族带标题）或裸 `URL`（execute 不带标题）。
 */
function parseAtPayload(payload: string): { url: string; title: string | undefined; epoch: number | undefined } | undefined {
  const epochMatch = EPOCH_TAIL.exec(payload)
  const epoch = epochMatch === null ? undefined : Number(epochMatch[1])
  const body = epochMatch === null ? payload : payload.slice(0, epochMatch.index)
  // 地址不含空白；首个「 — 」之后的都是标题（标题里再出现「 — 」属于标题本身）。
  const dash = body.indexOf(' — ')
  const url = dash === -1 ? body : body.slice(0, dash)
  const title = dash === -1 ? undefined : body.slice(dash + ' — '.length)
  if (!/^https?:\/\/\S+$/.test(url)) return undefined
  return { url, title, epoch }
}

/**
 * 从成功回执里取出工具**自报**的页面身份（地址/标题/标签/epoch）（L8-20261008 独立验收）。
 *
 * 面板地址不能只看参数里的 `url`：click 引发的导航、真实历史后退（`history=back`）、
 * 重定向都不带 url 参数，旧实现让地址永远停在最后一次 open/navigate 的参数值上。
 * 各回执的**首行头部是工具自己生成的**（页面内容只能出现在头部之后、且大纲行都以
 * `- ` 开头），所以只解析与工具族匹配的头部形状，回执正文里的不可信文本伪造不出观察；
 * execute 的参数 expression 与回执正文（如 `{"href":…}`、站点里的 `/event`、
 * `batchexecute` 链接）都不参与页面身份推断：
 *
 * - open / navigate / snapshot：首行就是地址，`title:` 行与 session 行在前三行；
 * - click / fill / press / scroll / wait：`… done on session_id=t9 (now at URL — 标题, ref epoch N).`；
 * - execute：`<method> on session_id=t9 (at URL, ref epoch N)`；
 * - tabs：只认 `[foreground]` 行 —— 那是「当前页」的权威观察（无 epoch）。
 *
 * 失败与运行中的调用不算观察（动作没落地或没回话，页面状态未知）。
 */
export function observedPage(call: BrowserCall): PageObservation | undefined {
  if (!call.settled || call.isError || call.resultText === '') return undefined
  const firstLine = call.resultText.slice(0, call.resultText.indexOf('\n') === -1 ? undefined : call.resultText.indexOf('\n'))
  switch (call.toolName) {
    case 'webpage_open':
    case 'webpage_navigate':
    case 'webpage_snapshot': {
      // 首行必须是**纯**地址；会话头按行首锚定，页面标题里伪造的 `session_id=` 认不出。
      const lines = call.resultText.split('\n', 3)
      const url = lines[0] ?? ''
      if (!/^https?:\/\/\S+$/.test(url)) return undefined
      // title 行与 session 行都在前三行内；二者都按整行锚定，不扫正文。
      let title: string | undefined
      let sessionId: string | undefined
      let epoch: number | undefined
      for (const line of lines.slice(1)) {
        const titleMatch = /^title: (.*)$/.exec(line)
        if (titleMatch !== null) {
          title = titleMatch[1] === '' ? undefined : titleMatch[1]
          continue
        }
        const sessionMatch = /^session_id=(\S+)/.exec(line)
        if (sessionMatch !== null) {
          sessionId = sessionMatch[1]
          const epochMatch = /ref epoch (\d+)/.exec(line)
          epoch = epochMatch === null ? undefined : Number(epochMatch[1])
        }
      }
      return { url, title, sessionId, epoch }
    }
    case 'webpage_click':
    case 'webpage_fill':
    case 'webpage_press':
    case 'webpage_scroll':
    case 'webpage_wait': {
      if (!/^\S+ done on session_id=/.test(firstLine)) return undefined
      const at = firstLine.indexOf('(now at ')
      if (at === -1) return undefined
      // 载荷终止于行尾最后一个 `)`（可带句点）；地址后跟 ` — 标题` 或直接接 `, ref epoch`。
      const payload = parseAtPayload(firstLine.slice(at + '(now at '.length).replace(/\)\.?$/, ''))
      if (payload === undefined) return undefined
      return { url: payload.url, title: payload.title, sessionId: SESSION_ID_PATTERN.exec(firstLine)?.[1], epoch: payload.epoch }
    }
    case 'webpage_execute': {
      const at = firstLine.indexOf('(at ')
      if (at === -1) return undefined
      // 同上：按「最后的 `, ref epoch N`」取边界，地址里的逗号/括号（`?x=a,b(c)`）不截断。
      const payload = parseAtPayload(firstLine.slice(at + '(at '.length).replace(/\)$/, ''))
      if (payload === undefined) return undefined
      return { url: payload.url, title: payload.title, sessionId: SESSION_ID_PATTERN.exec(firstLine)?.[1], epoch: payload.epoch }
    }
    case 'webpage_tabs': {
      // 标签清单里「当前页」只认前台行；后台行的地址与标签号都不是这个面板要显示的状态。
      // 只接受本对话持有清单；available/release/handoff 不代表当前页面归属。
      if (!/HELD BY THIS CONVERSATION|Your held tab\(s\) now:|your held tab\(s\) are:/.test(firstLine)) return undefined
      const row = /^- session_id=(\S+) \[foreground\] — (https?:\/\/\S+?)(?: \((.*?)\))?(?: \| .*)?$/m.exec(call.resultText)
      if (row === null || row[1] === undefined || row[2] === undefined) return undefined
      return { url: row[2], title: row[3] === '' ? undefined : row[3], sessionId: row[1], epoch: undefined }
    }
    default:
      return undefined
  }
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
 *
 * 地址语义（L8-20261008 独立验收）：**最新有效的页面观察优先** —— 成功的回执观察
 * （含 click 导航、真实历史后退、execute 自报地址、tabs 前台行）优先于参数兜底，且
 * 失败的调用不产生任何观察（导航失败的 url 参数不得把地址改到一个没去成的地方）。
 * 运行中的调用同样不算观察，等回话落地再更新。
 *
 * 宿主按模型调用顺序提交结果；后来的 tabs 观察可以更新当前状态。
 * 同标签回执的 ref epoch 单调递增，低 epoch 结果额外按过时观察丢弃。
 * 多标签时地址跟随最新有效观察所在的标签（{@link BrowserObservation.sessionId} 同步跟走）。
 * @param calls - 按时间顺序排列的调用列表（{@link browserCallsFrom} 的输出）。
 */
export function observeBrowser(calls: readonly BrowserCall[]): BrowserObservation {
  let url: string | undefined
  let title: string | undefined
  let sessionId: string | undefined
  /** 每个受控标签已见过的最大 ref epoch；晚到旧结果的判据。 */
  const sessionEpochs = new Map<string, number>()
  let running = false
  let snapshots = 0
  let screenshots = 0
  let failures = 0
  for (const call of calls) {
    if (!call.settled) running = true
    if (call.settled && call.isError) failures += 1
    if (call.toolName === 'webpage_snapshot') snapshots += 1
    if (call.toolName === 'webpage_screenshot') screenshots += 1
    const observed = observedPage(call)
    if (observed !== undefined) {
      if (observed.sessionId !== undefined) {
        const prevEpoch = sessionEpochs.get(observed.sessionId)
        if (observed.epoch === undefined) {
          // tabs 按调用顺序观察本对话持有页；旧版动作缺 epoch 时保持保守。
          if (prevEpoch !== undefined && call.toolName !== 'webpage_tabs') continue
        } else {
          if (prevEpoch !== undefined && observed.epoch < prevEpoch) continue
          sessionEpochs.set(observed.sessionId, Math.max(prevEpoch ?? observed.epoch, observed.epoch))
        }
      }
      const samePage = sessionId === observed.sessionId && url === observed.url
      title = observed.title ?? (samePage ? title : undefined)
      url = observed.url
      sessionId = observed.sessionId
      continue
    }
    // 仅 open/navigate 的成功旧版回执可退回 url 参数，其他工具参数不是页面身份。
    if (call.settled && !call.isError && (call.toolName === 'webpage_open' || call.toolName === 'webpage_navigate')) {
      const argUrl = parseBrowserUrl(call.argsRaw)
      if (argUrl !== undefined) {
        url = argUrl
        title = undefined
        sessionId = undefined
      }
    }
  }
  return {
    latest: calls.at(-1),
    running,
    url,
    title,
    sessionId,
    calls: calls.length,
    snapshots,
    screenshots,
    failures,
  }
}
