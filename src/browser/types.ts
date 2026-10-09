/**
 * ctx.browser 的公共类型：会话、观察请求与结果、错误类型。
 *
 * 分包与命名照 dsh 的 `packages/web/web/src/types.ts` 对齐。
 *
 * ## ref 纪元（P0 的核心语义）
 *
 * 一次 snapshot 产出一批 ref，它们只属于**那一次** snapshot 建立的纪元。导航（或人工接管，
 * P3）会作废整个纪元。作废之后使用旧 ref 必须抛 `BROWSER_STALE_REF`，绝不能静默命中
 * 「恰好同号」的新元素 —— 那正是「点错元素」这类事故的成因。
 */

/**
 * 浏览器能力错误的机器可读码。
 *
 * 前六个是 provider 选择语义（与 dsh 的 `WebErrorCode` 一一对应）；
 * 其余是 provider 实现层的事实描述，模型应据此决定「重新观察」而不是「换招」。
 */
export type BrowserErrorCode =
  /** 同一个 id 的 provider 被注册了两次。 */
  | 'BROWSER_DUPLICATE_PROVIDER'
  /** 配置里钉住的 provider id 根本没有注册。 */
  | 'BROWSER_PROVIDER_CONFIGURED_MISSING'
  /** 配置里钉住的 provider 注册了但当前不可用。 */
  | 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE'
  /** 没有任何可用 provider，且没有配置。 */
  | 'BROWSER_PROVIDER_UNAVAILABLE'
  /** 多个可用 provider 且没有配置钉住哪一个。 */
  | 'BROWSER_PROVIDER_AMBIGUOUS'
  /** P0 未实现的操作。 */
  | 'BROWSER_NOT_IMPLEMENTED'
  /** 会话 id 不存在（或已关闭）。可恢复：重新 open。 */
  | 'BROWSER_TARGET_NOT_FOUND'
  /** 从未成功 snapshot，谈不上 ref 有效性。可恢复：先 snapshot。 */
  | 'BROWSER_SNAPSHOT_REQUIRED'
  /** ref 属于已作废的纪元。可恢复：重新 snapshot，不要重试同一个 ref。 */
  | 'BROWSER_STALE_REF'
  /** 目标 URL 被地址策略拒绝（非 HTTP(S)、含内嵌凭据、超长）。 */
  | 'BROWSER_URL_BLOCKED'
  /** 调试端口连不上（Chrome 没开、端口不对、被防火墙拦）。 */
  | 'BROWSER_ENDPOINT_UNREACHABLE'
  /** 导航失败或等待加载超时。 */
  | 'BROWSER_NAVIGATION_FAILED'
  /** CDP 返回了错误，或返回了不符合协议的消息。 */
  | 'BROWSER_PROTOCOL_ERROR'
  /** CDP 本地定时器或 Electron host 超时；保留结构化预算，供 execute 转成页面等待超时。 */
  | 'BROWSER_CDP_COMMAND_TIMEOUT'
  | 'BROWSER_INVALID_PARAMS'
  /** WebSocket 在命令完成前断开。 */
  | 'BROWSER_CONNECTION_LOST'
  /** 卸载时某个 provider 未能干净释放资源。 */
  | 'BROWSER_DISPOSE_FAILED'
  /**
   * P2：CDP 命令抛出 `No target available` —— 调试器在「打开 DevTools 那一瞬让位」期间
   * 被 detach 了（`[V16]`）。**可恢复**：re-attach 后自动恢复，不需要探测式重试。
   */
  | 'BROWSER_DEBUGGER_DETACHED'
  /**
   * P2：要写一个冲突的 target 级状态。判定条件与处置见方案 2.3.1，恢复路径见 2.1.1。
   * **不可重试**（状态没变，原样重发必然再失败），但允许显式 `force` 覆盖。
   */
  | 'BROWSER_STATE_CONTENDED'
  /**
   * P2：`webpage_execute` 的返回值无法序列化（`document.body` 会**静默**变成 `{}`，
   * 循环引用 / `Symbol` 会抛错，`[V22]`）。提示模型改用原始值或 JSON 字符串。
   */
  | 'BROWSER_EXECUTE_RESULT_UNSERIALIZABLE'
  /** 页面 async 函数体的语法错误、运行时异常或拒绝的 Promise。 */
  | 'BROWSER_EXECUTE_SCRIPT_ERROR'
  /** 页面 execute 等待预算耗尽；页面代码可能仍在运行。 */
  | 'BROWSER_EXECUTE_TIMEOUT'
  /**
   * P2：`webpage_execute` 只放行白名单里的 CDP 命令（方案 3.3）。不在允许列表里的
   * `domain.method` 一律拒绝 —— **新命令默认拒**，避免黑名单永远追不上协议演进。
   * 错误消息里带被拒的 method 全文。
   */
  | 'BROWSER_EXECUTE_NOT_ALLOWED'
  /**
   * §6.5：该会话当前由**人工持有**（人在标签条上按了「接管」），一切写操作拒绝。
   *
   * 与 `BROWSER_STATE_CONTENDED` 是两回事：那个是「一条 target 级状态被占」，这个是
   * 「整个页面现在不归你动」。**不可重试** —— 重发一次还是被拒，状态不会自己变。
   * 唯一恢复路径：等人按「交还」，然后**重拍一次 snapshot**（接管时纪元已作废，
   * 交还**不**恢复任何旧 ref）。
   */
  | 'BROWSER_HUMAN_HOLDING'
  /**
   * 多会话占用：这次工具调用没有拿到宿主对话身份（`exec.agent.id` 缺失）。
   *
   * **不是模型能自己修的错误** —— 身份来自宿主执行上下文，不是工具参数。模型侧唯一的
   * 动作是报告「这个运行环境没有传递调用方身份」；补身份属于宿主/插件装配的修复。
   * 因此它**绝不**回落到「没有身份就全部放行」：那会让门禁在缺身份时静默失效。
   */
  | 'BROWSER_CALLER_REQUIRED'
  /**
   * 多会话占用：目标标签不归本对话所有（别人占着、空闲待领、移交待领，或标签根本
   * 不在受控台账里）。**可恢复**：对空闲标签先 `webpage_tabs(action=claim)`，
   * 领取成功后重拍一次完整快照再操作。
   */
  | 'BROWSER_TAB_NOT_HELD'
  /**
   * 多会话占用：领取竞争失败 —— 就在这次调用之前，另一个对话已经把该标签领走。
   *
   * 与 `BROWSER_TAB_NOT_HELD` 分开的理由只有一个：**恢复动作不同**。那个是「去领取」，
   * 这个是「别争了，换一个空闲标签或等对方释放」。合成一个码会让模型对着同一个标签
   * 反复重试领取。
   */
  | 'BROWSER_TAB_OCCUPIED'
  /**
   * 多会话占用：标签上有正在执行的调用，此刻不能释放 / 移交 / 关闭。
   * **可重试**：等执行中的调用结束后重发即可。
   */
  | 'BROWSER_TAB_BUSY'
  /**
   * 多会话占用：移交码错误、已过期或已被消费。**不可重放旧码** —— 向原持有者要一个新码。
   */
  | 'BROWSER_HANDOFF_INVALID'
  /**
   * 点击落点被其它元素盖住（`elementFromPoint` 命中测试证实事件会打在别人身上），
   * 事件**没有派发**（2026-10-07 独立验收：派发前拒绝，零页面副作用）。
   * **不可盲目重试** —— 页面没变，重发还是被拒。恢复路径：关掉浮层或先操作盖在上面的
   * 控件（它通常不在 ref 表里），然后重拍 snapshot 再点目标。
   */
  | 'BROWSER_TARGET_OCCLUDED'
  /**
   * 窗口当前报告零尺寸视口（innerWidth/innerHeight = 0，通常是最小化或隐藏）。
   * 此状态下布局坐标、命中测试与输入派发都没有意义（坐标全为负、事件落不到真实内容上），
   * 动作**没有派发**（2026-10-07 独立验收：禁止假成功）。
   * **可恢复**：把浏览器窗口恢复显示后重试；宿主在最小化期间刻意不重排（host.cjs 退化
   * 读数守卫），插件侧没有安全的恢复路径，所以只拒绝 + 指路，不代恢复。
   */
  | 'BROWSER_WINDOW_NOT_VISIBLE'
  | 'BROWSER_TAB_NOT_VISIBLE'
  | 'BROWSER_READ_ONLY_ANCHOR'

/** 能力缝隙与 provider 唯一抛出的错误类型。 */
/**
 * `BROWSER_STALE_REF` 的分桶原因：这个 ref 是被**哪一道门**拒的。
 *
 * 存在的理由只有一个 —— P0 取数（方案 §4）：光有总数答不了「换文档导致的旧号」与
 * 「同文档被换掉 / 被复用」哪个是主要矛盾，而这两类分别要由粗门与细门来治。
 * 从错误消息里正则硬分是脏办法，所以在**抛出点**就把它标出来。
 *
 * 只在 `code === 'BROWSER_STALE_REF'` 时有意义；其它错误码一律不带。
 */
export type BrowserStaleRefReason =
  /** `refs.resolve`：这个号不在当前纪元的表里（换过一次快照 / 纪元刚被作废）。 */
  | 'obsolete_epoch'
  /** `DOM.resolveNode` 失败或拿不到句柄：节点彻底没了。 */
  | 'node_gone'
  /** `isConnected === false`：地址没变，但节点被换掉 / 摘掉了（同文档重渲染）。 */
  | 'detached'
  /** 写前门·粗门：纪元记的地址与当下顶层文档的地址不符（换文档，含 SPA 路由）。 */
  | 'stale_document'
  /** `revalidate` 的四道门对不上（loaderId / role+name）—— 归档恢复的拒绝理由。 */
  | 'identity_mismatch'
export class BrowserError extends Error {
  readonly code: BrowserErrorCode
  /** HTTP 状态码；仅当错误源自一次真实的 HTTP 响应时才有值（如 DevTools 端点回 404/403）。 */
  readonly status: number | undefined
  /** 见 {@link BrowserStaleRefReason}；非 `BROWSER_STALE_REF` 时为 `undefined`。 */
  readonly reason: BrowserStaleRefReason | undefined
  readonly timeoutMs: number | undefined
  readonly method: string | undefined

  constructor(
    message: string,
    code: BrowserErrorCode,
    options?: { cause?: unknown; status?: number; reason?: BrowserStaleRefReason; timeoutMs?: number; method?: string },
  ) {
    super(message, options)
    this.name = 'BrowserError'
    this.code = code
    this.status = options?.status
    this.reason = options?.reason
    this.timeoutMs = options?.timeoutMs
    this.method = options?.method
  }
}

/**
 * 判断一个值是不是 {@link BrowserError}。
 * @param value - 待判断的值。
 * @returns 是否为本插件抛出的能力错误。
 */
export function isBrowserError(value: unknown): value is BrowserError {
  return value instanceof BrowserError
}

/**
 * 每个错误码的**可执行**恢复建议（2026-10-07 实测教训：模型只看得到 `error.message`，
 * `code` 字段上游不透出 —— 布局错误后模型只能盲目重试或乱按 Enter）。按码给方向，
 * 不在抛出点逐个拼句；具体细节（如哪个 CDP method 被拒）仍由抛出点写在 message 里。
 */
const BROWSER_ERROR_RECOVERY: Readonly<Partial<Record<BrowserErrorCode, string>>> = {
  BROWSER_TARGET_NOT_FOUND: 'the session is gone; open the page again with webpage_open.',
  BROWSER_SNAPSHOT_REQUIRED: 'take a webpage_snapshot first, then act on the fresh refs.',
  BROWSER_STALE_REF: 'this ref is obsolete — take a fresh webpage_snapshot and use the new refs; do not retry this ref.',
  BROWSER_URL_BLOCKED: 'use an http(s) URL without embedded credentials.',
  BROWSER_ENDPOINT_UNREACHABLE: 'check that the browser is running and its debugging port is reachable.',
  BROWSER_NAVIGATION_FAILED: 'check the URL; if the page is slow, retry once or report the site as unreachable.',
  BROWSER_PROTOCOL_ERROR: 'the browser connection or protocol could not complete this command; inspect the current page and connection state, then retry only when the action is safe.',
  BROWSER_CDP_COMMAND_TIMEOUT: 'the CDP command did not return within its wait budget; the result is unknown, so inspect state before repeating any potentially mutating action.',
  BROWSER_INVALID_PARAMS: 'fix the tool arguments exactly as described in the message — this is a malformed tool call, not a page problem; no snapshot, retry or page inspection can fix it.',
  BROWSER_CONNECTION_LOST: 'the connection dropped; re-open the page with webpage_open.',
  BROWSER_DEBUGGER_DETACHED: 'the debugger briefly detached (e.g. DevTools opened); this recovers automatically — retry once after a moment.',
  BROWSER_STATE_CONTENDED: 'the state is held by someone else; do not retry the same write — coordinate or use force only if you mean to override.',
  BROWSER_EXECUTE_RESULT_UNSERIALIZABLE: 'return ordinary JSON data with enumerable data fields; avoid live DOM nodes, functions, cycles, accessors, and deeply nested objects.',
  BROWSER_EXECUTE_SCRIPT_ERROR: 'fix the reported JavaScript syntax or runtime error; the function body is not automatically retried.',
  BROWSER_EXECUTE_TIMEOUT: 'inspect the page state before retrying; the result is unconfirmed and page code may still finish.',
  BROWSER_EXECUTE_NOT_ALLOWED: 'this internal CDP command is not exposed by webpage_execute; use its documented session_id, code, and optional timeout_ms interface.',
  BROWSER_HUMAN_HOLDING: 'a human is holding this tab — do not retry; wait for them to release it, then take a fresh webpage_snapshot (old refs stay invalid).',
  BROWSER_CALLER_REQUIRED: 'the runtime did not pass a caller identity; report this as an environment problem.',
  BROWSER_TAB_NOT_HELD: 'if the tab is idle, claim it with webpage_tabs(action=claim); if another conversation holds it, wait for release or an explicit handover instead of trying to take it over. After acquiring it, take a fresh webpage_snapshot.',
  BROWSER_TAB_OCCUPIED: 'another conversation holds this tab — do not fight for it; use another tab or wait for release.',
  BROWSER_TAB_BUSY: 'a call is still running on this tab; wait for it to finish, then retry.',
  BROWSER_HANDOFF_INVALID: 'this handoff code is used or expired — ask the previous holder for a fresh code.',
  BROWSER_TARGET_OCCLUDED: 'do not retry the same click — close the overlay or act on the element on top of the target first, then take a fresh webpage_snapshot and click the target again.',
  BROWSER_WINDOW_NOT_VISIBLE: 'restore the browser window (un-minimize or show it), then retry; do not retry while the window stays hidden or minimized.',
  BROWSER_TAB_NOT_VISIBLE: 'real mouse/keyboard input only lands on a visible tab (visibilityState=hidden) — activate the tab with webpage_tabs(action=activate), make sure the browser window itself is shown, then retry; do not dispatch input into a hidden tab.',
  BROWSER_READ_ONLY_ANCHOR: 'this anchor only locates content for reading — use webpage_snapshot with region_ref, webpage_locate or a screenshot on it; to interact, take a fresh webpage_snapshot and use an actionable element (link/button/textbox) instead.',
}

/**
 * 统一错误呈现：把 `code` 与恢复建议折进 message（上游 harness 只把 `error.message`
 * 给模型 —— `Error: ${message}` —— 结构化的 code 字段到不了模型）。保持
 * code/status/reason/cause 不变，所以按 code 断言的既有测试与多会话门禁不受影响。
 *
 * 已经带 `[CODE]` 前缀的消息原样返回（幂等），避免包裹层重复叠加。
 */
export function presentBrowserError(error: unknown): unknown {
  if (!(error instanceof BrowserError) || error.message.startsWith(`[${error.code}]`)) return error
  const recovery = BROWSER_ERROR_RECOVERY[error.code]
  const message = `[${error.code}] ${error.message}${recovery !== undefined ? ` Recovery: ${recovery}` : ''}`
  return new BrowserError(message, error.code, {
    ...error.cause !== undefined ? { cause: error.cause } : {},
    ...error.status !== undefined ? { status: error.status } : {},
    ...error.reason !== undefined ? { reason: error.reason } : {},
  })
}

/**
 * 新开一个受控标签页。省略 `url` 时开空白页（`about:blank`）。
 *
 * `url` 会过地址策略：只允许 HTTP(S)、禁止内嵌凭据、长度有上限。
 */
export interface BrowserOpenRequest {
  readonly url?: string
}

/**
 * 让一个已存在的受控标签页跳转。**作废该会话的全部既有 ref。**
 *
 * `url` 与 `history` **恰好给一个**：后退 / 前进 / 刷新走浏览器自己的历史栈，
 * 与「跳到某个地址」是两件事。都给或都不给都报错，绝不猜。
 */
export interface BrowserNavigateRequest {
  readonly sessionId: string
  readonly url?: string
  /** 走历史栈：`back` / `forward` / `reload`。与 `url` 互斥。 */
  readonly history?: 'back' | 'forward' | 'reload'
}

/** 一个受控的浏览器会话（P0 里等于一个标签页）。 */
export interface BrowserSession {
  readonly id: string
  readonly url: string
  readonly title: string
  /**
   * 当前 ref 纪元。每次 snapshot 递增；导航使其作废并递增。
   * 调用方不需要自己记账，这个字段只用于在结果里回显「你现在处于哪个纪元」。
   */
  readonly epoch: number
}

/** 大纲里的一个可操作引用。 */
export interface BrowserRef {
  /** 形如 `e12`；序号在**整个会话内**单调递增，绝不跨 snapshot 复用。 */
  readonly ref: string
  /** 可访问性角色，例如 `button` / `textbox` / `link`。 */
  readonly role: string
  /** 可访问性名称（已做空白折叠与长度裁剪）。 */
  readonly name: string
  /**
   * 只读文本锚点（项 3 补正，2026-10-08）：`true` = 仅授予读权限
   * （region_ref / locate / 截图 / revalidate / wait）；click / fill / press 拿它
   * 报 `BROWSER_READ_ONLY_ANCHOR`。普通可操作元素不带这个字段。
   */
  readonly anchor?: boolean
}

/**
 * 「自上一次全量快照之后，页面在本会话之外变过」—— 跨轮次累加的分类计数（方案 §6.2 ①）。
 *
 * 为什么不是一个 `takeover: boolean`：那个位只说明「有人开着 DevTools」，人工不开 DevTools
 * 改页面、页面自己的脚本换路由，它一律看不见；而且它描述的是**状态**，模型拿到「内容随时可能变」
 * 无从决策。这里给的是**动作**（导航过几次、从哪个地址到哪个地址），配一句话就能决策。
 *
 * 三个来源（`navigated` / `withinDocument` / `addressDrift`）都是**离散**事件，不刷屏 ——
 * 所以它可以安全地挂在每条回执上；这也正是它没有做成「检出即 `invalidate()`」的原因：
 * 时钟、轮询、SSE 那些非离散变化会被误判成变更，反复作废把上下文刷爆。
 *
 * ⚠️ **它是通知，不是防线**：纯 JS 改 DOM（`textContent`、列表重排）不产生任何导航事件，
 * 这里完全看不见。保命靠写前门（方案 §5.1）。
 */
export interface BrowserPageChanged {
  /** 主 frame **真导航**（换文档）次数 —— 由 `Page.frameNavigated` 计数。 */
  readonly navigated: number
  /**
   * 主 frame **软导航**次数（`pushState` / `replaceState` / `location.hash`）——
   * 由 `Page.navigatedWithinDocument` 计数。两个桶实测完全不重叠（方案 §6.3）。
   */
  readonly withinDocument: number
  /**
   * 同一 `scheme+host+path` 下只有 query / hash 变过的次数（D-19）。
   *
   * 单独一桶而不是并进 `navigated`，因为这一桶**没有作废 ref 纪元**（文档身份没变）：
   * Google 类页面每交互一次就换一批遥测令牌（`sxsrf=` / `sca_esv=` / `ei=` …），
   * 全文全等比较会把每次抖动都判成「换文档」→ 模型手上 ref 全废、白重拍一次。
   * 但它也可能真是一次「同 path 换关键词」的变化，所以如实报出来让模型自己判断，
   * 而不是插件替它选一边。
   *
   * ⚠️ 口径（2026-09-19 实测补）：这一桶只接**事件流没报过**的那一类变化。同一次变化若已经
   * 走到 `navigated` / `withinDocument` 两个桶里（事件线处理过：外部变化计数、自己引发的抵账），
   * 轮询线不再重复记 —— 否则自己点击引发的遥测抖动会被报成「本会话之外变过」，
   * 把 D-19 要省的那笔全量重拍又加回来（见 `dirty.ts` 的 `noteAddressDrift`）。
   */
  readonly addressDrift?: number
  /**
   * 人工接管窗口开启次数（§6.5 的 `holder` → `human`，或 DevTools 被打开）。
   *
   * **通道缺席时整条不出现**（直连外部 Chrome 的 provider 没有这条信号）：「观察到 0 次」
   * 与「观察不到」是两件事，都印成 0 就是给噪声加喇叭。
   */
  readonly takeoverWindow?: number
  /** 最近一次文档变化：从哪个地址到哪个地址。地址读不到时缺席。 */
  readonly route?: { readonly from: string; readonly to: string }
  /** 最近一次文档变化的时刻（毫秒时间戳）。 */
  readonly at?: number
}

/** 正文读取的单条文本：底稿行号 + 未裁切文本。 */
export interface BrowserTextRead {
  readonly line: number
  readonly text: string
}

/**
 * 紧凑页面大纲。
 *
 * ref 的**纪元语义**是这套能力的核心：ref 只在产生它的那次 snapshot、以及同一观察纪元内有效；
 * 导航或人工接管直接作废。用旧 ref 必须报 `BROWSER_STALE_REF`，绝不能静默命中别的元素。
 */
export interface BrowserSnapshot {
  readonly kind: 'snapshot'
  readonly sessionId: string
  /** 本次观察的 ref 纪元。 */
  readonly epoch: number
  readonly url: string
  readonly title: string
  /** 裁剪后的可访问性树大纲文本。 */
  readonly outline: string
  readonly refs: readonly BrowserRef[]
  /** 大纲是否因规模上限被截断（截断后 ref 只覆盖已输出的部分）。 */
  readonly truncated: boolean
  /** 被截断时：本次实际输出的大纲行数（`truncated=false` 时等于总行数）。 */
  readonly outlineLines: number
  /** 被截断时：因规模预算没被输出的元素个数（差几行还是差几千行，模型据此决定要不要抬预算）。 */
  readonly droppedElements?: number
  /**
   * **折叠前**的完整大纲，`webpage_find` 用的检索底稿。
   *
   * 为什么单独留一份：`outline` 会把重复控件折叠成标记行（SERP 里 36 行噪音压成 6 行），
   * 而标记行向模型承诺「用 webpage_find 拿全部实例的 ref」—— 兑现它的前提就是 find 手上
   * 那份底稿里一个实例都不少。`refs` 本来就是全量的，这里只是把同一批元素按折叠前渲染一遍。
   *
   * **不进模型上下文**（模型看到的是 `outline`）；provider 不做折叠时可以不填。
   */
  readonly fullOutline?: string
  /**
   * 正文读取（项 3，2026-10-07）：底稿行的**未裁切**可访问性名称，稀疏 `{line, text}`
   * （`line` 与 `fullOutline` 的行号对齐，只含有增量信息的行）。不进模型上下文，
   * 由 `webpage_find(full_text=true)` 按需读取 —— 120 字符裁切的长段落靠它拿回尾部。
   */
  readonly fullTexts?: readonly BrowserTextRead[]
  /**
   * 同级 statictext **块**文本（代码块被高亮拆成一串 statictext，块文本才是完整代码，
   * 换行与缩进保留）。行号口径同 `fullTexts`；由 `webpage_find(full_text=true)` 按需读取。
   */
  readonly textBlocks?: readonly BrowserTextRead[]
  /**
   * 被折叠而未打印的重复行数。与 `droppedElements` 是两套口径：那个是「预算不够、没输出」，
   * 这个是「重复、没打印」—— 元素都还在 `refs` 里。两者必须分开报，否则「要不要抬 max_lines」
   * 这个判断会失真（给错口径比不给更糟）。
   */
  readonly foldedRepeats?: number
  /**
   * 因与**祖先链上的某行同名**而被跳过的行数（同一条链上同一个名字只印一次）。
   *
   * 与 `foldedRepeats` 分开报：那个是平级/跨父的重复**实例**，这个是一条祖先链上的同名嵌套
   * （真实树上结果标题是 `heading "X" > link "X" > text "X"` 三行同文）。两者都不进
   * `droppedElements` —— 元素没丢、信息也没少，只是不再重复印。
   */
  readonly dedupedLines?: number
  /**
   * P3 人工接管状态位：`true` 表示有人正开着 DevTools 操作这个页面，**本结果可能随时失效**，
   * 模型应当把它当作「需要重新观察」的信号。
   *
   * 注意它**不影响 ref 纪元** —— `[V31]` 实测人工在 DevTools 里选元素与 agent 的高亮
   * 互不干扰，所以开合 DevTools 绝不推进纪元（否则每次人工看一眼都会把模型的 ref 全废掉）。
   * 缺省 = 未知 / 无接管；直连外部 Chrome 的 provider 不实现这条通道，恒为 `undefined`。
   */
  readonly takeover?: boolean
  /** 区域快照：区域外还有几个可操作元素。与 foldedRepeats 口径独立。 */
  readonly outsideRegion?: number
  /**
   * 页面上一次全量快照之后在**本会话之外**变过的分类计数（方案 §6.2 ①②，字段**脏时才出现**）。
   *
   * 与 `takeover` 是两个维度，别混：`takeover` = 「有人正开着 DevTools」，`changed` =
   * 「页面自那份快照之后变过」。所以回执里出现 `takeover: false` + 本字段是有意义的组合，
   * 不矛盾 —— 人工没开 DevTools 一样能改页面，页面自己的脚本也能换路由。
   */
  readonly pageChanged?: BrowserPageChanged
  /**
   * D-5（方案 §5.2）：本次**区域快照**把哪几个 ref 的指针换到了另一个 DOM 节点上。
   *
   * `adopt()` 不换表，所以 ref 号被复用；同一个 `semanticKey`（role + name + 稳定祖先路径）
   * 唯一命中时它会**就地改写 `backendNodeId`**，而号还是那个号 —— 从换掉那一刻起到模型下次
   * 点击之间，没有任何一处代码知道发生过什么：写前门两道门（地址、`isConnected`）全绿，
   * `webpage_revalidate` 也会（因为它当前表命中即成功，一次 CDP 都不发）说「这个号没问题」。
   *
   * ⚠️ 报出来的是「指针动过」，**不是**「元素变了」：SPA 重渲染把同一个控件换成新节点一样会命中
   * 这里（同 role+name+路径、不同 `backendNodeId`），那是无害的。两者的区别在插件这一侧判不出来，
   * 所以如实报事实、让模型自己决定要不要核实 —— 这比「静默」和「假装作废」都诚实。
   */
  readonly reboundRefs?: readonly BrowserRef[]
}

/** 截图。字节落盘走 `ctx.attachments.saveImage`，消息里只留引用。 */
export interface BrowserScreenshot {
  readonly kind: 'screenshot'
  readonly sessionId: string
  /** 截图时刻的 ref 纪元。 */
  readonly epoch: number
  readonly data: Uint8Array
  readonly mediaType: 'image/png'
  readonly width: number
  readonly height: number
  /** 元素级截图时命中的 ref；整页/视口截图为 undefined。 */
  readonly ref?: string
}

/** P0 的观察类请求。P1 会加入 click / fill / press 等 mutation 类型。 */
export type BrowserObserveRequest =
  | {
    readonly kind: 'snapshot'
    readonly sessionId: string
    /**
     * 大纲的行数上限（1-{@link MAX_SNAPSHOT_LINES}）。省略 = provider 默认（800）。
     * 长文页默认会被截断，调大它可以多看几屏 —— 代价是上下文预算。
     */
    readonly maxLines?: number
    /**
     * 区域快照。三种形态互斥：`ref` 子树 / `viewport: true` / `box`。
     * 区域快照走 adopt（不换表），全页快照仍走 publish。
     */
    readonly region?: {
      readonly ref?: string
      readonly viewport?: boolean
      readonly box?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    }
  }
  | {
    readonly kind: 'screenshot'
    readonly sessionId: string
    /** 只截这个 ref 对应的元素。ref 失效时报 `BROWSER_STALE_REF`。 */
    readonly ref?: string
    /** 截取超出视口的完整页面。与 `ref` 互斥。 */
    readonly fullPage?: boolean
  }

export type BrowserObservation = BrowserSnapshot | BrowserScreenshot

/**
 * P1 的页面操作请求。**全部按 ref 定位**（wait 的 hidden 语义也吃 ref）：
 * provider 必须在发出**任何**页面命令之前先过 ref 纪元 —— 旧 ref 直接
 * `BROWSER_STALE_REF` / `BROWSER_SNAPSHOT_REQUIRED`，绝不能先动页面再失败。
 */
export type BrowserMutationRequest =
  | { readonly kind: 'click'; readonly sessionId: string; readonly ref: string }
  | { readonly kind: 'fill'; readonly sessionId: string; readonly ref: string; readonly value: string }
  | { readonly kind: 'press'; readonly sessionId: string; readonly ref: string; readonly key: string }
  | {
    readonly kind: 'scroll'
    readonly sessionId: string
    /**
     * 滚轮事件的落点元素。**可以省略** —— 省略时落在视口中心（整页滚动），
     * 这样在「只有标题、没有任何可操作元素」的页面上也能滚，且不需要先 snapshot。
     */
    readonly ref?: string
    /** 横向滚动量（正 = 向右）；与 `deltaY` 至少给一个。 */
    readonly deltaX?: number
    /** 纵向滚动量（正 = 向下）；与 `deltaX` 至少给一个。 */
    readonly deltaY?: number
  }
  | {
    readonly kind: 'wait'
    readonly sessionId: string
    /** 纯等待。 */
    readonly timeMs?: number
    /** 等页面文本包含该串。 */
    readonly text?: string
    /** 等该 ref 的元素从文档里消失（spinner 消失之类）。 */
    readonly ref?: string
    /**
     * ref 等待的具体条件（项 2 补正，2026-10-08）：
     * - `'removed'`（默认）：元素脱离文档（旧语义，兼容不动）；
     * - `'hidden'`：元素**还在文档里**但已不可见（无布局盒 / display:none /
     *   visibility:hidden 等）。流式页的发送按钮提交后往往只是被隐藏而不是被移除，
     *   只等 removed 的条件永远不会成立 —— hidden 条件成功而 removed 不成功正是
     *   「本轮已提交、旧回答还留着」的证据。
     * 必须与 `ref` 同给；与 time/text/until 互斥。
     */
    readonly refState?: 'removed' | 'hidden'
    /**
     * 等页面安静（readyState complete + DOM 静默 + 网络静默或已超宽限期）。
     * 与 time_ms / text / ref 四选一；`timeoutMs` 只覆盖本模式的 deadline。
     */
    readonly until?: 'stable'
    /** `until: 'stable'` 的 deadline（毫秒）；默认与 `MAX_WAIT_TIME_MS` 对齐。 */
    readonly timeoutMs?: number
  }

/**
 * 被点击目标的身份信息（`click` 才有）。
 *
 * 存在的理由：`navigated=false` 的回执如果不说「你刚才点的到底是什么、它的 href 是什么」，
 * 模型只能去翻 console / network 猜（§6 禁止清单里的第四条）。
 */
export interface BrowserMutationTarget {
  readonly role: string
  readonly name: string
  /** 绝对化后的链接地址（只给 http(s)）；不是链接时为 `undefined`。 */
  readonly href?: string
}

/**
 * 挡在点击落点上的那个元素（`click` 才有）。
 *
 * `hint` 是给模型的选择器线索（`#id` / `.class`）：遮罩通常不是可操作控件、**不在 ref 表里**，
 * 没有 `ref` 可给；光有 role/name 模型还是无从下手。
 */
export interface BrowserOcclusion {
  readonly role?: string
  readonly name?: string
  readonly ref?: string
  readonly hint?: string
}

/** 一次页面操作的结果。 */
export interface BrowserMutationResult {
  readonly kind: 'mutation'
  readonly sessionId: string
  readonly action: 'click' | 'fill' | 'press' | 'scroll' | 'wait'
  /**
   * 操作落地后的 ref 纪元。click/press 引发导航时会**先作废旧纪元再推进**，
   * 所以旧 ref 在结果返回后就已经不可用。
   */
  readonly epoch: number
  readonly url: string
  readonly title: string
  /** 本次操作是否引发了导航（地址变了）。wait 恒为 false。 */
  readonly navigated: boolean
  /**
   * 页面上一次全量快照之后在**本会话之外**变过的分类计数（方案 §6.2 ②，字段**脏时才出现**）。
   *
   * 这是本字段最要紧的落点：人工的操作落在两轮之间，而模型下一轮往往是 `webpage_click` ——
   * 只有 `webpage_snapshot` 一条回执带提示的话，它**结构性地看不到**（§6.1 缺口 2）。
   * 自己引发的导航不算（见 `dirty.ts` 的赊账机制），那条已经由 `navigated` 报过了。
   */
  readonly pageChanged?: BrowserPageChanged
  /** wait 独有：条件是否在超时前成立（超时为 false，不是错误）。 */
  readonly satisfied?: boolean
  /**
   * wait(ref) 超时独有（项 2，2026-10-07）：元素超时那一刻的状态 ——
   * `hidden` = 还在文档里但没有布局盒（display:none / 未渲染），`visible` = 还在且显示着，
   * `removed` = 已脱离文档（hidden 等待下「等隐藏却先被移除」就是这个；removed 等待下
   * 出现即为自相矛盾，同样要如实报）。
   * 超时原因靠它区分，模型不再把「元素被隐藏」当成「页面没提交」。
   */
  readonly refState?: 'hidden' | 'visible' | 'removed'
  /**
   * `until: 'stable'` 独有：各信号是否安静。超时也如实报，不把慢页面谎成稳定。
   * 不暴露页面探针的全局名。
   */
  readonly signals?: {
    readonly readyState: 'complete' | 'loading'
    readonly dom: 'quiet' | 'busy'
    readonly network: 'quiet' | 'busy'
  }
  /**
   * 本次操作**新接管**的标签页：页面自己开了新窗口（`target=_blank` 链接、`window.open`），
   * 宿主把它收编成了同窗口里的新受控会话。
   *
   * 收编是**异步**的（宿主的「弹窗转标签」通报实测 140~156ms 才到 provider），所以这是
   * 收尾时按会话台账取差集的结果，不是点击那一刻的快照。无新增时为 `undefined`。
   *
   * 存在的理由见 {@link BrowserMutationResult} 的调用方（`webpage-tools`）：没有这个字段时，
   * 模型点完弹窗链接会一直以为只有一个标签，整条弯路都从这儿开始。
   */
  readonly openedTabs?: readonly BrowserTabInfo[]
  /** 被点击目标的身份（只有 click 填）：未导航回执要用它报「点的是什么」。 */
  readonly target?: BrowserMutationTarget
  /**
   * 落点被别的元素盖住（只有 click 填）。
   *
   * **事件照样派发了** —— 这个字段只是把「打在谁身上」如实回给模型。自动 Escape、
   * 自动改点遮罩上的按钮都是误触（见方案 §5），不做。
   */
  readonly occluded_by?: BrowserOcclusion
  /**
   * 动作已投递出去，但**没拿到浏览器的回执**（只有 scroll 会置 true）。
   *
   * 不是失败：滚轮事件发过了，只是页面没回话（后台标签 / Electron 上不回包）。
   * 与其让工具卡满 30s 报超时，不如如实说「不知道滚没滚」，让模型自己去确认位置。
   */
  readonly unconfirmed?: boolean
}

/**
 * 调用方身份 —— **宿主执行上下文给的**，不是模型参数。
 *
 * 为什么必须是独立的参数而不是请求体里的字段：请求体整体来自模型 JSON；只要身份能从
 * 请求体里给，模型就能伪造成别人去操作别人的标签，门禁等于没有。所以它由工具层从
 * `exec.agent.id` 提取，沿调用链单独传递。
 */
export interface BrowserCaller {
  readonly ownerId: string
}

/** 一个受控标签当前的占用状态（见实施方案 §2.2）。 */
export type BrowserTabLeaseState =
  /** 归某个对话独占；只有它自己看得见、只有它能操作。 */
  | 'held'
  /** 空闲待领：清单里只披露标签 id，领取后才可读写。 */
  | 'available'
  /** 移交待领：不入普通清单，凭一次性移交码领取。 */
  | 'handoff'

/** 标签占用信息，随清单一起回给调用方。 */
export interface BrowserTabLease {
  readonly state: BrowserTabLeaseState
  /** 距空闲释放 / 移交码过期还有多少毫秒；`available` 没有期限，故缺席。 */
  readonly remainingMs?: number
}

/** 标签页清单里的一项（本插件自己开的受控标签页）。 */
export interface BrowserTabInfo {
  readonly sessionId: string
  /**
   * 地址与标题。**空闲清单（`scope: 'available'`）里缺席** —— 领取之前不向其他对话
   * 披露别人页面上有什么，这是「只显示标签 id」那条规则的机器可读形态。
   */
  readonly url?: string
  readonly title?: string
  /** 是否在前台；provider 判断不了时省略（外部 Chrome 没有可靠的「活动标签」信号）。 */
  readonly active?: boolean
  /** 占用状态与剩余租期；未登记的标签缺席。 */
  readonly lease?: BrowserTabLease
}

/**
 * 标签页管理请求。
 *
 * `list` / `activate` / `close` 是 provider 动作（`activate` / `close` 只管本 provider
 * 自己开的标签）；`claim` / `release` / `handoff` 是**占用动作**，由能力缝隙在本地裁决，
 * 一个 CDP 命令都不发（`release` 只额外作废 ref 纪元）。
 */
export type BrowserTabsRequest =
  | {
    readonly kind: 'list'
    /** `held`（默认）= 本对话占用的；`available` = 本运行实例里空闲待领的。 */
    readonly scope?: 'held' | 'available'
  }
  | {
    readonly kind: 'claim'
    readonly sessionId: string
    /** 移交待领时必须带码；空闲标签不该带（带了也不改变占用记录）。 */
    readonly handoffCode?: string
  }
  | { readonly kind: 'release'; readonly sessionId: string }
  | { readonly kind: 'handoff'; readonly sessionId: string }
  | { readonly kind: 'activate'; readonly sessionId: string }
  | { readonly kind: 'close'; readonly sessionId: string }

/** 标签页管理结果；`tabs` 是动作落地后的清单。 */
export interface BrowserTabsResult {
  readonly action: 'list' | 'activate' | 'close' | 'claim' | 'release' | 'handoff'
  /** activate / close / claim / release / handoff 的目标会话 id。 */
  readonly sessionId?: string
  readonly tabs: readonly BrowserTabInfo[]
  /**
   * `handoff` 才有：一次性移交码。**只在这条回执里出现一次** —— 不写日志、不进指标、
   * 不进标题。持码的对话在下一次 `claim` 里消费它。
   */
  readonly handoffCode?: string
  /**
   * 本次占用迁移**实际波及**的全部标签 id（含请求目标）。
   *
   * claim / release / handoff 是以弹窗家族为单位迁移的，所以这里通常不止一个 id。调用方
   * 按这张清单逐个作废 ref 与清理快照缓存 —— 只处理 `sessionId` 会给新主人留下旧主人的
   * 缓存与 ref（方案 §3.2）。超时回收走 `onLeaseRelease` 逐标签通知，不填这个字段。
   */
  readonly affectedSessionIds?: readonly string[]
}

/** P2：从会话的 console 环形缓冲读取条目。 */
export interface BrowserConsoleRequest {
  readonly sessionId: string
  /** 最多返回多少条（从最新往回）。省略 = provider 默认（50）。 */
  readonly limit?: number
  /** 只保留该 level 的条目（大小写不敏感，例如 `error`）。 */
  readonly level?: string
  /** 只保留文本包含该子串的条目（大小写不敏感）。 */
  readonly text?: string
  /** 连更早文档（导航前那几页）的条目一起读。默认 false：只给当前文档的。 */
  readonly allDocuments?: boolean
}

/** 一条归一化后的 console 条目。 */
export interface BrowserConsoleEntry {
  /** `Runtime` 用事件 type；`Log` 用 `entry.level`。 */
  readonly level: string
  readonly text: string
  /**
   * 毫秒时间戳。两域口径不同且随版本漂移，采集时按量级归一（见
   * `browser-cdp/console.ts` 的 `normalizeTimestamp`），所以两域可比。
   */
  readonly timestamp: number
  /** 来源域：`runtime` = `Runtime.consoleAPICalled`，`log` = `Log.entryAdded`。 */
  readonly source: 'runtime' | 'log'
}

/** `webpage_console` 的结果。 */
export interface BrowserConsoleResult {
  readonly kind: 'console'
  readonly sessionId: string
  readonly entries: readonly BrowserConsoleEntry[]
  /** 过滤前缓冲里的条目总数（含更早文档的）。 */
  readonly buffered: number
  /** 匹配的条目多于 `limit`。 */
  readonly truncated: boolean
  /**
   * `Log` 域曾发生过重放截断（即收到过 `[V39]` 那条 `timestamp=0` 的提示条目）——
   * 说明有 console 内容永久缺失，模型应据此判断窗口是否完整。
   */
  readonly replayTruncated: boolean
  /** 当前文档序号（0 起；本会话观察到几次导航就加几）。 */
  readonly document: number
  /** 属于更早文档、**没被返回**的条目数（`allDocuments: true` 时恒为 0 —— 都被返回了）。 */
  readonly earlierDocuments: number
  /**
   * 是否被**文本总量预算**截断（而不是被 `limit` 截断）。
   * 分开报的理由：被 `limit` 截断时调大 limit 有用，被预算截断时没用，得换 `level`/`text` 过滤。
   */
  readonly truncatedByBudget: boolean
}

/** P2：网络采集的两种动作。 */
export type BrowserNetworkRequest =
  | {
    readonly kind: 'list'
    readonly sessionId: string
    /** 最多返回多少条（从最新往回）。省略 = provider 默认（50）。 */
    readonly limit?: number
    /** 只保留 URL 包含该子串的条目（大小写不敏感）。 */
    readonly url?: string
    /** 连更早文档（导航前那几页）的请求一起列。默认 false：只给当前文档的。 */
    readonly allDocuments?: boolean
  }
  | { readonly kind: 'body'; readonly sessionId: string; readonly requestId: string }

/** 一条网络请求记录（可能是缺请求头的降级记录）。 */
export interface BrowserNetworkEntry {
  readonly requestId: string
  /** 请求方法；缺 `requestWillBeSent` 的降级记录里未知。 */
  readonly method?: string
  readonly url: string
  readonly status?: number
  readonly mimeType?: string
  readonly fromDiskCache?: boolean
  /** 是否缺 `requestWillBeSent` 的降级记录（`[V40]`）。 */
  readonly partial?: boolean
  /** 降级原因；目前只有 `request-headers-missing`。 */
  readonly reason?: string
  /** `loadingFailed` 的错误文本。 */
  readonly errorText?: string
}

/** `webpage_network` 的结果。 */
export interface BrowserNetworkResult {
  readonly kind: 'network'
  readonly sessionId: string
  readonly action: 'list' | 'body'
  readonly requests: readonly BrowserNetworkEntry[]
  /** body 动作才有。 */
  readonly requestId?: string
  /** body 动作才有：响应体（可能被裁剪）。 */
  readonly body?: string
  readonly base64Encoded?: boolean
  /** body 动作：正文超长被裁剪。list 动作：还有更多请求没返回（`limit` 或总量预算截断）。 */
  readonly truncated?: boolean
  /** list 动作才有：当前文档序号（0 起）。 */
  readonly document?: number
  /** list 动作才有：属于更早文档、**没被列出**的请求数（`allDocuments: true` 时恒为 0）。 */
  readonly earlierDocuments?: number
  /** list 动作才有：被 URL 总量预算截断（调大 limit 无用，得用 url 过滤）。 */
  readonly truncatedByBudget?: boolean
}

/** 内部 CDP execute 请求；模型入口的 async 函数体由工具层转换到此请求。 */
export interface BrowserExecuteRequest {
  readonly sessionId: string
  /** 内部 CDP `domain.method`，例如 `Runtime.evaluate`；不是网页工具参数。 */
  readonly method: string
  readonly params?: Record<string, unknown>
  /**
   * 本条 CDP 命令的等待上限（毫秒）——**只能用来缩短**。
   *
   * 实测（2026-09-20 · V44）：`Runtime.evaluate` 会一直等到 Promise settle，一个永不落定
   * 的表达式（等一个不会来的事件、`await` 了被拦的 fetch）会把调用方挂到 provider 的
   * `commandTimeoutMs`（默认 30s）才有回音。逃生舱因此允许调用方压短这段等待。
   *
   * provider 取 `min(此值, commandTimeoutMs)`：**只许更短，不许借此把内层超时放大**。
   * ⚠️ 它不改变「拿不到值」这个事实 —— 对挂住的 Promise，缩短只省时间、不给结果，
   * 想拿值仍要自己包 `Promise.race`。
   */
  readonly timeoutMs?: number
}

/** 内部 CDP execute 结果；工具层再解开页面 JSON 信封。 */
export interface BrowserExecuteResult {
  readonly kind: 'execute'
  readonly sessionId: string
  readonly method: string
  /** 执行后的 ref 纪元；导航类命令会推进它。 */
  readonly epoch: number
  readonly url: string
  /** 执行后实际页面标题；旧 provider 可省略，不从表达式或结果正文推断。 */
  readonly title?: string
  /** 该命令是否属于导航类（`Page.navigate` / `Page.reload`），或探测到地址变化。 */
  readonly navigated: boolean
  /**
   * 页面上一次全量快照之后在**本会话之外**变过的分类计数（方案 §6.2 ②，字段**脏时才出现**）。
   * 逃生舱跑的可以是任意页面代码，所以它是「自己引发的导航」之外的最后一道可见性。
   */
  readonly pageChanged?: BrowserPageChanged
  /** `Runtime.evaluate` 的返回值（已确认可序列化）。 */
  readonly value?: unknown
  /** 其它命令的原始 CDP result。 */
  readonly result?: unknown
  /** 结果是否因过大被裁剪成字符串。 */
  readonly truncated: boolean
}

/** P3：`webpage_locate` —— 按 ref 现算元素的视口坐标盒（方案 4.3）。 */
export interface BrowserLocateRequest {
  readonly sessionId: string
  /** 最新一次 snapshot 里的元素 ref。旧 ref 一律 `BROWSER_STALE_REF`。 */
  readonly ref: string
  /** 在元素上画一层高亮（`Overlay.highlightNode`；保持到 hideHighlight / 导航）。 */
  readonly highlight?: boolean
  /**
   * 量之前先 `scrollIntoView` 把元素滚到视口中央。**默认 false**（只读、不动视口）：
   * 默认滚动会让 locate 无法用来验证「刚才那次 scroll 到底滚没滚」，也会悄悄改掉
   * 用户看到的画面；要看元素在视口里的**当前位置**就别开它。
   */
  readonly scroll?: boolean
}

/** `webpage_revalidate`：把旧纪元的 ref 精确装回当前纪元。 */
export interface BrowserRevalidateRequest {
  readonly sessionId: string
  /** 要恢复的 ref；单个 ref 做成一元素数组。 */
  readonly refs: readonly string[]
}

/** 一条没能精确恢复的 ref。 */
export type BrowserRevalidateFailureReason =
  | 'not_archived'
  | 'document_changed'
  | 'node_gone'
  | 'identity_mismatch'

export interface BrowserRevalidateFailure {
  readonly ref: string
  readonly reason: BrowserRevalidateFailureReason
}

/** `webpage_revalidate` 的结果：成功的同号装回，失败的按条说明原因。 */
export interface BrowserRevalidateResult {
  readonly kind: 'revalidate'
  readonly sessionId: string
  readonly epoch: number
  readonly restored: readonly BrowserRef[]
  readonly failed: readonly BrowserRevalidateFailure[]
  /**
   * 页面上一次全量快照之后在**本会话之外**变过的分类计数（方案 §6.2 ②，字段**脏时才出现**）。
   *
   * 这条回执尤其需要它：恢复成功的判据只是「归档 `loaderId` 对得上 + role/name 一致」，
   * 而同一份文档里的重排（列表换序、控件被替换）它一个字都看不出来 —— 模型拿到一片
   * `restored` 会以为「号都好了」，这时「页面自己变过」是它唯一能拿到的额外线索。
   */
  readonly pageChanged?: BrowserPageChanged
}

/** `webpage_locate` 的结果：视口坐标（语义与 click 的落点计算一致）。 */
export interface BrowserLocateResult {
  readonly kind: 'locate'
  readonly sessionId: string
  /** 量取时刻的 ref 纪元。 */
  readonly epoch: number
  readonly ref: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /**
   * `scroll=true` 时是否真的居中成功：按**最终一次测量**判定「元素中心对齐视口中心」
   * （每轴容差 16px，盖住滚动条半宽与亚像素抖动；元素超过视口的轴按「完全盖住该轴」判，
   * 那是滚动被文档边缘夹住时居中的极限）。「看得见」不算居中 —— 只是「元素中心落在视口内」
   * 的旧判据会把 smooth 动画刚进视口的中间帧谎报成已居中（2026-10-07 独立验收）。
   * 视口尺寸测不到或为零时无法证明居中，恒为 `false`，绝不默认成功。
   */
  readonly centered: boolean
  /** 本次调用是否请求了滚动（与 `centered` 区分「请求了」和「生效了」）。 */
  readonly scrollRequested: boolean
  /**
   * 量到的那一刻，元素是否与视口有交集（`scroll=false` 时直接回答「它在不在屏幕上」）。
   * 视口尺寸读不到时为 `undefined`。
   */
  readonly inViewport?: boolean
}

/**
 * provider 契约。能力缝隙只认这个接口，不认识任何具体驱动方式
 * （CDP 直连、Playwright、Electron 代持都实现它）。
 */
export interface BrowserProvider {
  readonly id: string
  /** 当前是否可用（例如调试端口是否在监听）。 */
  available(): boolean
  open(request: BrowserOpenRequest, signal?: AbortSignal): Promise<BrowserSession>
  navigate(request: BrowserNavigateRequest, signal?: AbortSignal): Promise<BrowserSession>
  observe(request: BrowserObserveRequest, signal?: AbortSignal): Promise<BrowserObservation>
  /** P1：标签页管理（本插件自己开的受控标签页）。 */
  tabs(request: BrowserTabsRequest, signal?: AbortSignal): Promise<BrowserTabsResult>
  /** P1：按 ref 定位的页面操作。实现必须先过 ref 纪元再发任何页面命令。 */
  mutate(request: BrowserMutationRequest, signal?: AbortSignal): Promise<BrowserMutationResult>
  /** P2：读取会话的 console 环形缓冲（读取前会补发 `Runtime.enable` / `Log.enable`）。 */
  console(request: BrowserConsoleRequest, signal?: AbortSignal): Promise<BrowserConsoleResult>
  /** P2：读取 / 取回网络请求（`requestId` 直接用，不做映射）。 */
  network(request: BrowserNetworkRequest, signal?: AbortSignal): Promise<BrowserNetworkResult>
  /** P2：白名单制的高危逃生舱，只放行只读 / session 私有 / 只导航的 CDP 命令。 */
  execute(request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>
  /**
   * P3：按 ref 现算元素的视口坐标盒。**每次调用都重新计算，绝不缓存 snapshot 时的几何**
   * （方案 4.4 的硬要求）—— 「现算」配合 `isConnected` 守卫才是 ref 失效的真正兜底。
   */
  locate(request: BrowserLocateRequest, signal?: AbortSignal): Promise<BrowserLocateResult>
  /**
   * 把旧纪元的 ref 精确装回当前纪元（同一文档、同一 backendNodeId、role/name 仍一致）。
   * `resolve` 仍然对旧号报 stale；成功的号与 snapshot 当时相同。
   */
  revalidate(request: BrowserRevalidateRequest, signal?: AbortSignal): Promise<BrowserRevalidateResult>
  /**
   * 订阅「收编了一个非 `open()` 创建的受控标签」（页面弹窗、宿主标签条的「+」）。
   *
   * 能力缝隙用它把**占用归属**从父标签继承给子标签（实施方案 §5.2）。`openerTargetId`
   * 为 `undefined` 时表示这一页没有受控父标签（人工新建）—— 那时**不登记**，标签留在
   * 台账之外：不猜主人的代价是它只能由创建者重新 open，猜错的代价是把别人的页面交出去。
   *
   * @returns 退订函数。
   */
  onSessionAdopted?(listener: (targetId: string, openerTargetId: string | undefined) => void): () => void
  /**
   * 占用归属变了（释放 / 移交 / 空闲超时回收）：把该会话的 ref 纪元与快照缓存作废。
   *
   * **为什么必须由能力缝隙来通知**：租约表住在 `ctx.browser` 这一层，provider 看不见它；
   * 而 ref 纪元住在 provider 手里。归属一变就作废纪元，是「换了 owner 必须重拍快照」
   * 这条规则的执行点 —— 少了它，新 owner 会拿到一个「表面可用、实际属于上一个对话」
   * 的 ref。可选：没有 ref 纪元的 provider 不必实现。
   */
  invalidateSession?(sessionId: string): void
  /** 归还一个会话：关闭它的标签页并释放连接。 */
  close(sessionId: string): Promise<void>
  /** 释放 provider 持有的全部资源（连接、标签页、进程）。可省略。 */
  dispose?(): Promise<void>
}
