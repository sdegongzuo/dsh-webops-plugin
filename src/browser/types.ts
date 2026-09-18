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
  /**
   * P2：`webpage_execute` 只放行白名单里的 CDP 命令（方案 3.3）。不在允许列表里的
   * `domain.method` 一律拒绝 —— **新命令默认拒**，避免黑名单永远追不上协议演进。
   * 错误消息里带被拒的 method 全文。
   */
  | 'BROWSER_EXECUTE_NOT_ALLOWED'

/** 能力缝隙与 provider 唯一抛出的错误类型。 */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode
  /** HTTP 状态码；仅当错误源自一次真实的 HTTP 响应时才有值（如 DevTools 端点回 404/403）。 */
  readonly status: number | undefined

  constructor(message: string, code: BrowserErrorCode, options?: { cause?: unknown; status?: number }) {
    super(message, options)
    this.name = 'BrowserError'
    this.code = code
    this.status = options?.status
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
 * 新开一个受控标签页。省略 `url` 时开空白页（`about:blank`）。
 *
 * `url` 会过地址策略：只允许 HTTP(S)、禁止内嵌凭据、长度有上限。
 */
export interface BrowserOpenRequest {
  readonly url?: string
}

/** 让一个已存在的受控标签页跳转。**作废该会话的全部既有 ref。** */
export interface BrowserNavigateRequest {
  readonly sessionId: string
  readonly url: string
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
   * 被折叠而未打印的重复行数。与 `droppedElements` 是两套口径：那个是「预算不够、没输出」，
   * 这个是「重复、没打印」—— 元素都还在 `refs` 里。两者必须分开报，否则「要不要抬 max_lines」
   * 这个判断会失真（给错口径比不给更糟）。
   */
  readonly foldedRepeats?: number
  /**
   * P3 人工接管状态位：`true` 表示有人正开着 DevTools 操作这个页面，**本结果可能随时失效**，
   * 模型应当把它当作「需要重新观察」的信号。
   *
   * 注意它**不影响 ref 纪元** —— `[V31]` 实测人工在 DevTools 里选元素与 agent 的高亮
   * 互不干扰，所以开合 DevTools 绝不推进纪元（否则每次人工看一眼都会把模型的 ref 全废掉）。
   * 缺省 = 未知 / 无接管；直连外部 Chrome 的 provider 不实现这条通道，恒为 `undefined`。
   */
  readonly takeover?: boolean
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
  /** wait 独有：条件是否在超时前成立（超时为 false，不是错误）。 */
  readonly satisfied?: boolean
  /**
   * 本次操作**新接管**的标签页：页面自己开了新窗口（`target=_blank` 链接、`window.open`），
   * 宿主把它收编成了同窗口里的新受控会话。
   *
   * 收编是**异步**的（宿主的「弹窗转标签」通报实测 140~156ms 才到 provider），所以这是
   * 收尾时按会话台账取差集的结果，不是点击那一刻的快照。无新增时为 `undefined`。
   *
   * 存在的理由见 {@link BrowserMutationResult} 的调用方（`tool-browser`）：没有这个字段时，
   * 模型点完弹窗链接会一直以为只有一个标签，整条弯路都从这儿开始。
   */
  readonly openedTabs?: readonly BrowserTabInfo[]
}

/** 标签页清单里的一项（本插件自己开的受控标签页）。 */
export interface BrowserTabInfo {
  readonly sessionId: string
  readonly url: string
  readonly title: string
  /** 是否在前台；provider 判断不了时省略（外部 Chrome 没有可靠的「活动标签」信号）。 */
  readonly active?: boolean
}

/** 标签页管理请求：清单 / 切前台 / 关闭。 */
export type BrowserTabsRequest =
  | { readonly kind: 'list' }
  | { readonly kind: 'activate'; readonly sessionId: string }
  | { readonly kind: 'close'; readonly sessionId: string }

/** 标签页管理结果；`tabs` 是动作落地后的清单。 */
export interface BrowserTabsResult {
  readonly action: 'list' | 'activate' | 'close'
  /** activate / close 的目标会话 id。 */
  readonly sessionId?: string
  readonly tabs: readonly BrowserTabInfo[]
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

/** P2：`webpage_execute` —— 唯一能直接发任意 CDP 命令的逃生舱。 */
export interface BrowserExecuteRequest {
  readonly sessionId: string
  /** `domain.method` 全文，例如 `Runtime.evaluate`。 */
  readonly method: string
  readonly params?: Record<string, unknown>
}

/** `webpage_execute` 的结果。 */
export interface BrowserExecuteResult {
  readonly kind: 'execute'
  readonly sessionId: string
  readonly method: string
  /** 执行后的 ref 纪元；导航类命令会推进它。 */
  readonly epoch: number
  readonly url: string
  /** 该命令是否属于导航类（`Page.navigate` / `Page.reload`），或探测到地址变化。 */
  readonly navigated: boolean
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
  /** `scroll=true` 时元素先被滚到视口中央再量，为 true。 */
  readonly centered: boolean
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
  /** 归还一个会话：关闭它的标签页并释放连接。 */
  close(sessionId: string): Promise<void>
  /** 释放 provider 持有的全部资源（连接、标签页、进程）。可省略。 */
  dispose?(): Promise<void>
}
