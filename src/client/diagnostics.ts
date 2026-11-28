/**
 * 把面板里已经有的原始材料拼成一段**可粘贴的诊断报告**：插件版本、运行环境、页面身份、
 * 会话统计，以及每条调用的参数原文、原始回执、错误码与几条「责任面」线索。
 *
 * ## 为什么单列一层
 *
 * 客户端的「一键复制」要做两件事——排版文本、写剪贴板。排版是纯函数，可以脱离浏览器
 * 单测（`diagnostics.test.ts`）；写剪贴板在打包态要过两道坎，都收在 {@link copyText} 里：
 *
 * 1. `dsh-app://` 是自定义协议，`navigator.clipboard` 只在 secure context 可用。取不到
 *    或被拒时退回 `document.execCommand('copy')`（Electron 渲染进程里稳定可用）。
 * 2. 两条路都失败时返回 `false`，由按钮显示「复制失败」，而不是假装复制成功——面板是
 *    排障现场，说谎比沉默糟。
 *
 * ## 为什么带「线索」行
 *
 * 用户要的是「判断这是插件的原因还是模型的原因」。报告只呈现**事实**，不下结论：参数
 * 是不是合法 JSON、是不是与上一次失败逐字相同（模型在重试）、回执里的错误码属于哪一层
 * （`BROWSER_EXECUTE_*` 是工具侧校验，`BROWSER_TAB_*` 是页面归属）。这些判断留给读的人。
 *
 * 时间维度刻意缺席：客户端只有调用顺序，没有墙钟（见 `observation.ts` 的 `order` 注释），
 * 所以报告用「会话内第 N 次」而不是编一个时间戳。
 *
 * ## 报告不能说假话
 *
 * 报告的价值全在「它敢不敢承认不知道」。几条硬性约束，改这个文件时不要松：
 *
 * 1. **页面 / 目标 / 未知是三件事**（{@link pageOfCall}）：只有回执自报过的地址才叫页面；
 *    参数里的 url 只是目标；两者都没有就写「地址未知」，不拿面板当前页顶替。
 * 2. **单行事实值一律过 {@link inline}**：值来自模型参数与页面文本，带换行就能注入假的
 *    事实行，带 `## ` 就能改报告结构。
 * 3. **错误码只认首行**（{@link errorCodeOf}）：回执正文里出现 `[BROWSER_…]` 是正文，不是
 *    这次调用的错误码。
 * 4. **空参数、`null`、写坏的 JSON 是三档**（{@link argsCheckOf}）：空串不参与重试判定。
 * 5. **标题数报告条数，统计数会话全量**：两个分母同时写清，别让读者以为报告漏了条目。
 *
 * 这里**不 import 任何 dsh 客户端类型**，理由同 `observation.ts`：上游一次改名就会让 UI
 * 构建失败，而这段文本只依赖自己的 `BrowserCall`。
 */
import { observedPage, parseBrowserUrl, type BrowserCall } from './observation.ts'

/** 报告里要交代的页面身份；字段缺失（或空串）就整行不写，不输出「未命名」之类的占位。 */
export interface DiagnosticPage {
  readonly url?: string | undefined
  readonly title?: string | undefined
  readonly sessionId?: string | undefined
}

/** 报告里的标签全部来自 locale，避免中英混排。 */
export interface DiagnosticLabels {
  /**
   * 标题模板。`{count}` 由 {@link renderHeader} 填：面板两个入口共用同一套模板，
   * 单条入口不必自己拼「1 条」。传进来的是已插值成品也不出错（没有占位就不动）。
   */
  readonly heading: string
  /** 回执**自报**的页面身份。 */
  readonly page: string
  /** 参数里的目标地址：回执没说到达过，不能叫「页面」。 */
  readonly target: string
  /** 本条没有任何地址证据时的说明：不伪造地址，也不复述报告头部的当前页。 */
  readonly pageUnknown: string
  readonly currentPage: string
  readonly pageTitle: string
  readonly tab: string
  readonly environment: string
  readonly plugin: string
  /** 会话统计模板：`{total}` `{running}` `{failed}` 三个占位都要填。 */
  readonly stats: string
  readonly failedTools: string
  readonly sequence: string
  readonly errorCode: string
  readonly argsCheck: string
  readonly argsJson: string
  readonly argsNotJson: string
  /** 参数是空串：模型没给参数，与「参数写坏了」是两回事。 */
  readonly argsMissing: string
  readonly retry: string
  readonly arguments: string
  readonly receipt: string
  readonly noReceipt: string
  readonly failure: string
  readonly succeeded: string
  readonly active: string
}

/** 渲染报告需要的全部输入。 */
export interface DiagnosticInput {
  readonly labels: DiagnosticLabels
  /** 面板当前观察到的页面；单条自身没有地址证据时用它兜底。 */
  readonly current: DiagnosticPage
  /** 渲染进程 UA，通常是 {@link clientEnvironment} 的返回值。 */
  readonly environment: string | undefined
  /** 插件版本，构建期注入；未注入时整行省略。 */
  readonly pluginVersion: string | undefined
  /**
   * 会话内**全部** `webpage_*` 调用（按时间顺序）。单条复制也传全量：
   * 序号与「上一次失败是什么」都要靠它，只看一条算不出来。
   */
  readonly sessionCalls: readonly BrowserCall[]
}

/** 一条调用的页面身份是哪来的：回执自报 / 只有参数里的目标地址 / 一条证据都没有。 */
export type PageSource = 'receipt' | 'target' | 'current'

/** {@link pageOfCall} 的结果；报告按 `source` 选标签，不靠猜。 */
export interface CallPage {
  /** 可用的页面身份；`source === 'current'` 时这里是面板当前页，只作兜底参考。 */
  readonly page: DiagnosticPage
  readonly source: PageSource
  /**
   * 本条没有任何地址证据（等价于 `source === 'current'`）。
   *
   * 报告**不能**拿兜底的当前页当本条的页面：那会把「这里没证据」写成一个地址，
   * 也会把头部已经写过的当前页在每条下面重复一遍。渲染层据此改打 `labels.pageUnknown`，
   * 而这个布尔值留给调用方做「这条到底有没有地址」的快速判断。
   */
  readonly fromCurrent: boolean
}

/** 参数里的 `url` 只有是 http(s) 绝对地址时才算页面身份（`ftp:`、`/api/q` 都不是页面）。 */
const HTTP_URL = /^https?:\/\/\S+$/

/**
 * 这次调用自身的页面身份，按证据强度分三档。
 *
 * 1. `receipt`：回执自报（execute 的 `(at …)`、动作族的 `(now at …)`、open/navigate/
 *    snapshot 首行）—— 只有这一档能叫「页面」，因为工具确实到过那里。
 * 2. `target`：只有参数里的 `url`。失败的 open/navigate 只有目标地址，**没有落地**，
 *    报告必须叫「目标」而不是「页面」，否则等于声称去过一个没去成的地方。
 *    非 http(s) 绝对地址（`ftp://…`、相对路径 `/api/q?eps=2`）不算地址证据：那是参数
 *    形状错误的现场，打印成页面只会更误导。
 * 3. `current`：一条证据都没有（失败的 execute、只带 ref 的 click…）。此时 `page` 是
 *    面板当前页，仅供调用方兜底，报告不得把它当本条的页面写出来。
 * @param call - 要诊断的调用。
 * @param current - 面板当前观察到的页面。
 */
export function pageOfCall(
  call: BrowserCall,
  current: DiagnosticPage,
): CallPage {
  const observed = observedPage(call)
  if (observed !== undefined) {
    return {
      page: { url: observed.url, title: observed.title, sessionId: observed.sessionId },
      source: 'receipt',
      fromCurrent: false,
    }
  }
  const url = parseBrowserUrl(call.argsRaw)
  if (url !== undefined && HTTP_URL.test(url)) {
    return { page: { url }, source: 'target', fromCurrent: false }
  }
  return { page: current, source: 'current', fromCurrent: true }
}

/**
 * 用比内容更长的反引号串围住代码块。
 *
 * 回执里可能带页面返回的文本，参数里也可能正好有 ```；固定三反引号会在那里被提前闭合，
 * 报告从此错位。取「内容里最长的连续反引号 + 1」，至少 3 个。
 * @param body - 代码块内容。
 * @param language - 围栏语言标记，空串表示纯文本。
 */
function fenced(body: string, language: string): string {
  let longest = 0
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${language}\n${body}\n${ticks}`
}

/** 把模板里的 `{name}` 占位换掉；没有该占位时原样返回。 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}

/** 单行事实值的长度上限：一行被撑到几 KB 时，报告在对话里就读不出来了。 */
const MAX_INLINE = 300

/**
 * 单行事实值的清洗：折叠换行与控制字符、替换反引号、限制长度。
 *
 * 参数与回执都是模型/页面给的内容。把 `argsRaw` 里的 `url` 直接拼进 `- 页面: …` 时，
 * 值里带换行就会凭空多出事实行（实测注入过 `- 错误码: BROWSER_INVALID_PARAMS` 与
 * `- 会话内序号: 99`），带 `## ` 时更会变成真的 Markdown 标题；值里的反引号还会抢走
 * 行内代码的配对。所以**所有单行事实值**都过这里，一个都不能漏。
 *
 * 代码块（{@link fenced}）里的原文不动：那是证据，改了就变成伪造。
 * @param value - 待清洗的单行值。
 */
function inline(value: string): string {
  // 换行、回车、制表等控制字符一律折成单个空格；连续空白再收成一个，避免字段被拉空。
  const flattened = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
  // 反引号换成同类引号：行内代码围栏与 `fenced` 的判定都靠它，不能让它从值里漏进来。
  const quoted = flattened.replace(/`/g, "'")
  return quoted.length > MAX_INLINE ? `${quoted.slice(0, MAX_INLINE)}…` : quoted
}

/**
 * 回执第一行的方括号错误码。
 *
 * 工具回执由两处生成，形状都是「`[CODE] …` 打头、其后是理由与恢复建议」
 * （`src/browser/types.ts` 的 presentBrowserError 与 `src/tool-browser/tool-runtime.ts`）；
 * 上游 harness 再用 `Error: ${message}` 把它包一层，于是模型/回执里看到的第一行是
 * `Error: [CODE] …`。
 *
 * 只认**第一行**、方括号必须**打头**（前面至多一个 `Error: ` 前缀），是因为回执正文里
 * 可能夹着页面返回的不可信文本与工具自己的报错原文：实测
 * `Error: query is not a valid regular expression: … /BROWSER_TAB_OCCUPIED(/i: Unterminated
 * group` 会被旧实现抓成 `BROWSER_TAB_OCCUPIED`（那个码只是模型 query 的一段），锚定行首
 * 后就取不到了。
 *
 * 另加一条：**首行只允许出现一个方括号码**。`[BROWSER_PAGE_TEXT] then Error:
 * [BROWSER_EXECUTE_TIMEOUT]` 这类文本是把两段不同来源的材料拼在一起，无法判断哪个属于
 * 本次调用，于是宁可不写这一行（{@link errorCodeOf} 返回 `undefined`），也不挑一个。
 *
 * 精确正则：`/^(?:Error: )?\[([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\]/`。
 * - `^`：只匹配首行行首（调用前先切出第一行），正文里的方括号不算；
 * - `(?:Error: )?`：上游 harness 用 `Error: ${message}` 包一层（见
 *   `src/tool-browser/tool-runtime.ts`），工具自己的回执则以 `[CODE]` 直接打头（见
 *   `src/browser/types.ts` 的 presentBrowserError），两种形状都认，且只吞**一次**前缀；
 * - `[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+`：至少一个下划线分组，`[HELLO_WORLD]` 这种正文
 *   标记也挡不住（它形状相同），所以不靠形状排除伪造，而靠位置与唯一性；
 * - 不复制 `BrowserErrorCode` 白名单：上游加码时报告会静默丢码，那比多一行更糟。
 * @param resultText - 原始回执正文。
 */
export function errorCodeOf(resultText: string): string | undefined {
  const firstLine = resultText.slice(0, resultText.indexOf('\n') === -1 ? undefined : resultText.indexOf('\n'))
  // 首行里所有方括号码形状的片段；多于一个说明这行是拼接文本，不猜。
  const codes = [...firstLine.matchAll(/\[([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\]/g)]
  if (codes.length !== 1) return undefined
  const match = /^(?:Error: )?\[([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\]/.exec(firstLine)
  return match?.[1]
}

/** 参数检查的三种结论：空串（模型没给）、合法 JSON、不是合法 JSON。 */
type ArgsCheck = 'missing' | 'json' | 'notJson'

/**
 * 参数的检查结论。
 *
 * 三条口径都不能混：
 * 1. **空串是「没有参数」，不是「写坏了」**。模型完全没给参数时，报「不是合法 JSON」是
 *    在给读者指错方向；这种情况单独一档（`argsMissing`）。
 * 2. **`null` 是合法 JSON**：`JSON.parse('null')` 成功，只是解析结果不是对象。旧实现
 *    顺带要求「必须是对象」，把 `null` 判成不合法——检查的是语法，就不该偷偷多判类型。
 * 3. 解析抛错才是「不是合法 JSON」。
 * @param argsRaw - 模型发出的原始参数文本。
 */
function argsCheckOf(argsRaw: string): ArgsCheck {
  if (argsRaw === '') return 'missing'
  try {
    JSON.parse(argsRaw)
    return 'json'
  } catch {
    return 'notJson'
  }
}

/** 会话内该调用之前最近的一次失败调用；用于识别「模型原样重试」。 */
function previousFailure(sessionCalls: readonly BrowserCall[], call: BrowserCall): BrowserCall | undefined {
  const index = sessionCalls.indexOf(call)
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = sessionCalls[cursor]
    if (candidate !== undefined && candidate.settled && candidate.isError) return candidate
  }
  return undefined
}

/** 一条记录的标题行：报告内序号 + 工具名 + 状态。工具名同样过 {@link inline}。 */
function sectionTitle(call: BrowserCall, ordinal: number, labels: DiagnosticLabels): string {
  const status = !call.settled ? labels.active : call.isError ? labels.failure : labels.succeeded
  return `### ${String(ordinal)}. ${inline(call.toolName)} · ${status}`
}

/** 事实行里 `标签: 值` 的通用形状；值一律过 {@link inline}，见那个函数的理由。 */
function fact(label: string, value: string): string {
  return `- ${label}: ${inline(value)}`
}

/** 页面的地址行：标签按证据来源选，「页面」与「目标」不能混用（见 {@link pageOfCall}）。 */
function pageLines(page: CallPage, current: DiagnosticPage, labels: DiagnosticLabels): string[] {
  if (page.fromCurrent) {
    // 一条地址证据都没有：报告头部的「当前页面」已经交代过，这里不重复、也不伪造。
    return [`- ${labels.pageUnknown}`]
  }
  const lines: string[] = []
  // 与头部同址时省略：批量诊断大多落在同一页，逐条重复只会把报告撑长。
  if (page.page.url !== undefined && page.page.url !== current.url) {
    // 只有回执自报才能叫「页面」；参数里的 url 是「目标」，那次调用并没有确认到达。
    lines.push(fact(page.source === 'receipt' ? labels.page : labels.target, page.page.url))
  }
  if (page.page.url !== current.url && page.page.title !== undefined) {
    lines.push(fact(labels.pageTitle, page.page.title))
  }
  // 标签号单独判：同一地址在两个受控标签里打开过是可能的，头部那个标签并不覆盖这一条。
  if (page.page.sessionId !== undefined && page.page.sessionId !== current.sessionId) {
    lines.push(fact(labels.tab, page.page.sessionId))
  }
  return lines
}

/** 每条记录自己的事实行：序号、标签、错误码、参数检查、重试线索。 */
function renderFacts(call: BrowserCall, input: DiagnosticInput): string[] {
  const { labels, sessionCalls, current } = input
  const lines: string[] = []
  const index = sessionCalls.indexOf(call)
  if (index >= 0) lines.push(fact(labels.sequence, String(index + 1)))
  lines.push(...pageLines(pageOfCall(call, current), current, labels))
  if (call.isError) {
    const code = errorCodeOf(call.resultText)
    if (code !== undefined) lines.push(fact(labels.errorCode, code))
    const check = argsCheckOf(call.argsRaw)
    lines.push(fact(labels.argsCheck, check === 'missing' ? labels.argsMissing : check === 'json' ? labels.argsJson : labels.argsNotJson))
    const previous = previousFailure(sessionCalls, call)
    // 重试必须两边都有参数：两个空串「相同」只说明两次都没给参数，不构成重试证据。
    if (
      previous !== undefined
      && previous.toolName === call.toolName
      && call.argsRaw !== ''
      && previous.argsRaw === call.argsRaw
    ) {
      lines.push(`- ${labels.retry}`)
    }
  }
  return lines
}

/**
 * 渲染一条记录。
 *
 * 页面行只在与报告头部不同时出现：批量诊断多个失败时它们大多落在同一页，逐条重复同一个
 * 地址只会把报告撑长而不增加信息；不同的那一条才需要单独点名。
 */
function renderCall(call: BrowserCall, ordinal: number, input: DiagnosticInput): string {
  const { labels } = input
  const facts = [sectionTitle(call, ordinal, labels), ...renderFacts(call, input)].join('\n')
  const args = call.argsRaw === '' ? '—' : call.argsRaw
  const argsBlock = `${labels.arguments}:\n${fenced(args, 'json')}`
  const receiptBlock = `${labels.receipt}:\n${fenced(call.resultText === '' ? labels.noReceipt : call.resultText, 'text')}`
  // 列表行与「调用参数:」之间必须空行：紧贴着的话，Markdown 会把后者当成列表项的续行，
  // 粘进对话就缩进到项目符号下面，读起来像参数属于最后一条事实。
  return [facts, argsBlock, receiptBlock].join('\n\n')
}

/**
 * 会话统计：总调用数、其中还在跑的、失败数，以及失败的工具有哪些。
 *
 * 三个数都要写出来。报告标题数的是**报告里的条数**，这里数的是**会话全量**：单看
 * 「失败 1 次」与标题「（1 条）」看不出差别，实测 3 次调用里 2 条还在进行中时，读者会
 * 以为报告漏了 2 条。把 `{running}` 摆在明面上，两个分母就各就各位了。
 *
 * 失败工具明细回答「哪类工具反复失败」——同一种工具连挂几次更像工具侧问题。
 */
function renderStats(input: DiagnosticInput): string[] {
  const { labels, sessionCalls } = input
  if (sessionCalls.length === 0) return []
  const failed = sessionCalls.filter(call => call.settled && call.isError)
  const running = sessionCalls.filter(call => !call.settled)
  const stats = fill(labels.stats, {
    total: String(sessionCalls.length),
    running: String(running.length),
    failed: String(failed.length),
  })
  const lines = [`- ${inline(stats)}`]
  const byTool = new Map<string, number>()
  for (const call of failed) byTool.set(call.toolName, (byTool.get(call.toolName) ?? 0) + 1)
  if (byTool.size > 0) {
    const breakdown = [...byTool].map(([name, count]) => `${name}×${String(count)}`).join(', ')
    lines.push(fact(labels.failedTools, breakdown))
  }
  return lines
}

/**
 * 报告头部：条数标题、插件版本、环境、当前页、统计。
 *
 * 所有可选行都要求**非空串**才输出：`environment` 可能是空串（UA 取不到时面板也不拦），
 * 用 `!== undefined` 判断会渲出一行 `- 环境: `，看着像「环境是空的」这条事实。
 */
function renderHeader(count: number, input: DiagnosticInput): string {
  const { labels, current, environment, pluginVersion } = input
  const lines = [`## ${fill(labels.heading, { count: String(count) })}`]
  const details: string[] = []
  if (pluginVersion !== undefined && pluginVersion !== '') {
    details.push(fact(labels.plugin, `dsh-webops-plugin ${pluginVersion}`))
  }
  if (environment !== undefined && environment !== '') details.push(fact(labels.environment, environment))
  if (current.url !== undefined && current.url !== '') details.push(fact(labels.currentPage, current.url))
  if (current.title !== undefined && current.title !== '') details.push(fact(labels.pageTitle, current.title))
  if (current.sessionId !== undefined && current.sessionId !== '') details.push(fact(labels.tab, current.sessionId))
  // 统计行自带 `- ` 前缀（见 renderStats），这里直接接上。
  details.push(...renderStats(input))
  // 头部与第一条记录之间留空行，粘进 Markdown 才是两个段落。
  return details.length === 0 ? lines.join('\n') : `${lines.join('\n')}\n\n${details.join('\n')}`
}

/** 组装报告；`calls` 为空时返回空串，调用方据此决定要不要渲染按钮。 */
function renderReport(calls: readonly BrowserCall[], input: DiagnosticInput): string {
  if (calls.length === 0) return ''
  const sections = calls.map((call, index) => renderCall(call, index + 1, input))
  return [renderHeader(calls.length, input), ...sections].join('\n\n').trimEnd()
}

/**
 * 单条记录的报告：用户点某一条的「复制诊断信息」时用。
 * @param call - 该条调用。
 * @param input - 文案、当前页、环境与会话全量调用。
 */
export function buildCallDiagnostic(call: BrowserCall, input: DiagnosticInput): string {
  return renderReport([call], input)
}

/**
 * 全部**失败**调用的报告：用户点「复制失败详情」时用。
 *
 * 只收已结算且 `isError` 的调用：运行中的调用还没有回执，抄进去等于把「不知道」写成
 * 「失败」。没有失败时返回空串。顺序与会话一致（早的在前），读起来就是一次失败经过。
 * @param calls - 待筛的调用，通常就是会话全量。
 * @param input - 文案、当前页、环境与会话全量调用。
 */
export function buildFailuresDiagnostic(calls: readonly BrowserCall[], input: DiagnosticInput): string {
  const failed = calls.filter(call => call.settled && call.isError)
  return renderReport(failed, input)
}

/** 渲染进程的 User-Agent：Electron / Chrome 版本都在这条串里，是排障时最省事的版本证据。 */
export function clientEnvironment(): string | undefined {
  const agent = globalThis.navigator?.userAgent
  return typeof agent === 'string' && agent !== '' ? agent : undefined
}

/**
 * 插件版本，构建期由 `tsdown` 的 define 注入（见 `tsdown.config.ts`）。
 *
 * 客户端 bundle 读不到 `package.json`，宿主也不下发插件版本，所以只能构建时写死成字面量。
 * 单测和开发态直接 import 时该标识符不存在——用 `typeof` 判定而不是直接引用，否则会抛
 * ReferenceError；取不到就让报告省略版本行，而不是写一个假的。
 */
declare const __DSH_WEBOPS_PLUGIN_VERSION__: string | undefined

/** 当前插件版本；未注入时为 `undefined`。 */
export const PLUGIN_VERSION: string | undefined =
  typeof __DSH_WEBOPS_PLUGIN_VERSION__ === 'string' ? __DSH_WEBOPS_PLUGIN_VERSION__ : undefined

/**
 * `clipboard.writeText` 的等待上限（毫秒）。
 *
 * 这个 promise 在打包态不保证 settle：渲染进程被切到后台、系统剪贴板被别的进程占着时，
 * 它会既不 resolve 也不 reject，按钮就永远停在「复制中」。等这么久还没结果就按「这条路
 * 失败」处理、继续走选区兜底——兜底是同步的，能成功照样算成功。
 */
const CLIPBOARD_WRITE_TIMEOUT_MS = 1500

/**
 * 异步剪贴板写入这一路的结果：成功、被拒、超时都归一成布尔值。
 *
 * 超时归为 `false` 而不是最终失败：调用方还要接着试选区兜底（见 {@link copyText}）。
 * 超时之后原 promise 可能仍在跑，但它的结果只会落进这个 race 的另一个分支，不再参与判定；
 * 两路的 rejection 都在 `.then` 里就地接住，所以也不会冒出未处理的 rejection。
 * @param clipboard - 渲染进程的 `navigator.clipboard`。
 * @param text - 要写入的文本。
 */
function writeViaClipboardApi(
  clipboard: { writeText(text: string): Promise<void> },
  text: string,
): Promise<boolean> {
  let written: Promise<boolean>
  try {
    // 直接调用，不额外插一层微任务：兜底路径要尽量贴近用户手势的瞬时激活窗口。
    // 同步抛出也算失败——个别宿主把 writeText 实现成会先抛的普通函数。
    written = Promise.resolve(clipboard.writeText(text)).then(() => true, () => false)
  } catch {
    return Promise.resolve(false)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, CLIPBOARD_WRITE_TIMEOUT_MS)
  })
  return Promise.race([written, timedOut]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * 文档当前是否持有焦点。
 *
 * 失焦时 `execCommand('copy')` 照样返回 `true`、`copy` 事件照样派发，但系统剪贴板没有
 * 被写入（实测 Electron 44.11.5 渲染进程），所以这条必须单独判，不能只信事件。
 * `hasFocus` 不存在时（非浏览器宿主、测试里的伪 document）无法判断，按「有焦点」放行，
 * 免得把「测不出来」写成「失败」。
 * @param document - 承载复制动作的文档。
 */
function hasDocumentFocus(document: Document): boolean {
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true
}

/**
 * 把焦点还给复制前的元素。
 *
 * 元素可能已经从文档里摘掉（`remove()` 之后再 focus 会抛），这不该让一次已经完成的复制
 * 变成异常，所以吞掉。只按「有没有 focus 方法」判断，不用 `instanceof HTMLElement`：
 * 测试里的伪元素不是真的 DOM 节点。
 * @param element - 复制前记录的 `document.activeElement`。
 */
function restoreFocus(element: Element | null): void {
  const focusable = element as (Element & { focus?: (options?: { preventScroll?: boolean }) => void }) | null
  if (typeof focusable?.focus !== 'function') return
  try {
    focusable.focus({ preventScroll: true })
  } catch {
    // 元素已不在文档里；复制本身已经做完，不为收尾动作抛错。
  }
}

/**
 * 兜底复制：隐藏 textarea + `execCommand('copy')`，用于 `navigator.clipboard` 缺席或被拒的场合。
 *
 * ## 为什么不能信 `execCommand` 的返回值
 *
 * 实测 Electron 44.11.5 渲染进程：文档失焦时（`document.hasFocus() === false`）它照样返回
 * `true`，而剪贴板里什么都没有——面板显示「已复制」，用户粘出来还是旧内容。所以成败改由
 * 两件事共同判定，缺一不可：
 *
 * 1. **收到了 `copy` 事件**：`execCommand('copy')` 真的走复制流程时会在 `document` 上同步
 *    派发它；没收到就说明它只是返回了个 `true`。参考 harness 侧那条路（`ui-primitives` 的
 *    `writeClipboard`）只用了 `execCommand` 的返回值，这一条是本仓库按上面实测补的。
 * 2. **文档有焦点**：失焦时事件照派发、返回值也照给 `true`，但系统没接收（同一次实测）。
 *
 * 监听窗口只有这一次同步调用：进来挂、`finally` 摘掉，窗口里不会混进用户的 Ctrl+C。
 *
 * ## 焦点要还回去
 *
 * `select()` 会把焦点挪到临时 textarea，摘掉之后浏览器把它丢给 `BODY`（实测：
 * `document.activeElement` 从按钮变成 body），键盘用户从此不在复制按钮上。参考实现
 * （`ui-primitives/src/clipboard.ts` 的 `writeClipboard`，打包版里是 `bo()`）在 `finally`
 * 里恢复 `activeElement`，这里照抄这一条。
 * @param text - 要复制的文本。
 * @returns 是否真的发生了复制（见上两条判据）。
 */
function copyWithSelection(text: string): boolean {
  const document = globalThis.document
  if (document === undefined || document.body === null) return false
  if (typeof document.execCommand !== 'function') return false
  // 焦点原位置：临时 textarea 会抢走它，退出前必须还回去（见「焦点要还回去」）。
  const focused = document.activeElement
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  // 固定定位把光标挪出视口：`select()` 会滚动到选中元素，留在原位会让面板跳一下。
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  // 成败的唯一证据：窗口内是否真的收到了 copy 事件。
  let sawCopy = false
  const onCopy = (): void => { sawCopy = true }
  try {
    // 监听只覆盖这一次同步调用：进来挂上、finally 摘掉，窗口里混不进用户的 Ctrl+C。
    document.addEventListener('copy', onCopy, { once: true, capture: true })
    document.body.appendChild(area)
    area.select()
    // 返回值只作参考，不参与判定：失焦时它同样是 true（见函数注释）。
    document.execCommand('copy')
    return sawCopy && hasDocumentFocus(document)
  } catch {
    // 这条路的接口可能整体缺失（宿主没实现 execCommand / addEventListener）：
    // 那就当这条路走不通，交给调用方判失败，而不是把异常抛给按钮。
    return false
  } finally {
    try {
      document.removeEventListener('copy', onCopy, { capture: true })
    } catch {
      // 摘不掉也不影响判定：监听带 once，事件到了会自行摘除。
    }
    area.remove()
    restoreFocus(focused)
  }
}

/**
 * 写剪贴板：优先异步 API，失败或超时再走选区兜底。
 *
 * 返回值语义是**「真的写进剪贴板了吗」，不是「试过了吗」**：面板据此显示「已复制」或
 * 「复制失败」，排障现场说谎比沉默糟。两条路都按这个标准判——异步 API 要真的 resolve；
 * 选区兜底要同时满足「收到 `copy` 事件」和「文档有焦点」（见 {@link copyWithSelection}）。
 * @param text - 要复制的文本；空串直接视为失败，避免覆盖用户剪贴板里的旧内容。
 * @returns 是否真的写进去了。
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === '') return false
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    if (await writeViaClipboardApi(clipboard, text)) return true
    // 自定义协议不是 secure context 时这里会拒，超时也落在这一边；
    // 两种都继续走下面的兜底，不当作最终失败。
  }
  return copyWithSelection(text)
}
