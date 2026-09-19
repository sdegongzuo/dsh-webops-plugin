/**
 * 跨轮次脏累加器（方案 §6.2 ①，含 D-19 的「query 变只标脏」）。
 *
 * ## 它解决什么
 *
 * `session.takeover: boolean` 只说明「有人开着 DevTools」，而人工不开 DevTools 改页面、
 * 页面自己的脚本换路由，它一律看不见；而且它描述的是**状态**，模型拿到「内容随时可能变」
 * 无从决策。这里改成按**事件**分类计数，文案给的是**动作**：导航过几次、从哪个地址到哪个地址。
 *
 * ## 拉而不推（§6.0）
 *
 * 人工动手的那一刻模型没在读上下文，推给它要么打断 turn、要么落进没人看的地方。所以这里是
 * **攒着、下一次回执夹带**：{@link SessionDirtyTracker.report} 是只读的，锚点是**上一次全量
 * 快照**（{@link SessionDirtyTracker.reset}），中途读多少次都不会把脏标记读没 ——
 * 否则第一次回执报完，后面几条回执又会骗模型「页面没变过」。
 *
 * ## 两个桶是干净划分（§6.3 实测）
 *
 * `scripts/probe-within-document.ts` 真机跑出来的覆盖面：
 * 真导航（`location.href=`）只发 `Page.frameNavigated`；`pushState` / `replaceState` /
 * `location.hash` 只发 `Page.navigatedWithinDocument`。两类事件**完全不重叠**，所以
 * 「两个都到算哪个」这种去重规则不需要。
 *
 * ## 自己发的导航不算「脏」
 *
 * `click` / `press` / `execute` / `navigate` 都可能由我们自己引发导航，而那条事回执里已经
 * 用 `navigated: true` 报过了（§6.3 明确要求与 `detectNavigation` 去重）。所以在派发动作**之前**
 * 记一次 {@link SessionDirtyTracker.expectSelfNavigation}，事件到达时把它抵掉。抵账带
 * {@link SELF_NAVIGATION_TTL_MS} 有效期：动作没引发导航时这条赊账自然过期，不会去吞掉
 * 后来一次真的人工导航。
 *
 * ## 它是通知，不是防线（§6.3）
 *
 * 纯 JS 改 DOM（`textContent`、列表重排）不产生任何导航事件，这里完全看不见 ——
 * 保命靠写前门（§5.1）。**绝不**做成「检出即 `invalidate()`」：时钟/轮询/SSE 都会被判成
 * 变更，反复作废把上下文刷爆（教训见 `src/browser/types.ts` 里「开合 DevTools 绝不推进纪元」）。
 *
 * @module dsh-webops-plugin/browser-cdp/dirty
 */

import type { BrowserPageChanged } from '../browser/types.ts'
import type { CdpConnection } from './protocol.ts'

/**
 * 赊账有效期：动作发出后多久之内到达的文档变化事件算「我们自己引发的」。
 *
 * 取 `MUTATION_NAVIGATION_SETTLE_MS`（5s，provider 的导航轮询窗口）加一倍余量：
 * 事件正常在毫秒级到达，这个窗口只是为了让「动作没引发导航」的赊账**不会**留到下一轮
 * 去吞掉一次真的人工导航。窗口外的事件一律照实计数。
 */
export const SELF_NAVIGATION_TTL_MS = 10_000

/**
 * 文档身份：`scheme + host + path`。**不含 query 与 hash** —— D-19 的实测口径。
 *
 * Google 类页面每交互一次就换一批遥测令牌（`sxsrf=` / `sca_esv=` / `ei=` …），
 * 地址全文全等比较会把每次抖动都判成「换文档」，于是模型手上 ref 全废、白重拍一次
 * （中位 ≈5500 字符）。这一层把「换文档」与「同 path 换了参数」分开。
 *
 * @param url - 一个 http(s) 地址。
 * @returns 身份串；解析失败时 `undefined`（调用方按「判不出」处理）。
 */
export function documentIdentity(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return undefined
  }
}

/**
 * 两个地址是否指向**同一份文档**。
 *
 * ⚠️ 拿不到身份（解析失败 / 空串）时返回 `false` —— 与「判不出就不作废」相反。
 * 因为两处调用方（写前门、`detectNavigation`）的保守方向都是**作废**：宁可多付一次重拍，
 * 也不能让旧 ref 在身份不明的地址上静默命中。
 */
export function sameDocumentIdentity(left: string, right: string): boolean {
  const a = documentIdentity(left)
  const b = documentIdentity(right)
  return a !== undefined && a === b
}

/** {@link SessionDirtyTracker} 的可选项。 */
export interface DirtyTrackerOptions {
  /**
   * 发生**非本会话引发**的文档变化时回调一次（不是每个事件一次 —— 同一批只报最新态）。
   * 方案 §6.2 ③ 用它把「谁 / 何时」写进 {@link import('./state.ts').TargetStateRegistry}。
   */
  readonly onDocumentChanged?: (report: BrowserPageChanged) => void
}

/**
 * 一个会话的跨轮次脏累加器。与 `RefRegistry` / 采集器一样，**不是并发安全的写者** ——
 * 它被 provider 的会话对象独占，同一会话的操作在 provider 内部串行。
 */
export class SessionDirtyTracker {
  private readonly onDocumentChanged: ((report: BrowserPageChanged) => void) | undefined
  private readonly unsubscribes: (() => void)[] = []

  /** 事件流里最近一次见到的地址；用来给下一个事件补出 `from`。 */
  private lastUrl: string

  /** 主 frame 真导航（换文档）次数。 */
  private navigated = 0
  /** 主 frame 软导航（`pushState` / `replaceState` / `location.hash`）次数。 */
  private withinDocument = 0
  /** 同 host+path 下只有 query/hash 变过的次数（D-19：遥测令牌抖动这一类）。 */
  private addressDrift = 0
  /** 人工接管窗口开启次数；`undefined` 表示**本 provider 没有这条信号通道**，不是「0 次」。 */
  private takeoverWindow: number | undefined

  /** 最近一次文档变化（软/硬/仅地址）的 from → to 与时刻。 */
  private route: { from: string; to: string } | undefined
  private at: number | undefined

  /**
   * 最近一次「仅 query/hash 变」之后的地址。
   *
   * 为什么要专门记一份：写前门是**每次动作都查**的，而纪元里的 `publishedUrl` 一直没变
   * （D-19 特意不作废它），于是同一个抖动会被每一次动作重复数一遍，计数变成「模型动了多少次」
   * 而不是「页面变过几次」。这个游标让同一个新地址只记一笔。
   */
  private lastDriftTo: string | undefined

  /** 动作发出时刻的赊账队列（FIFO）；见 {@link expectSelfNavigation}。 */
  private readonly selfNavigations: number[] = []


  /**
   * @param connection - 该会话的 CDP 连接；构造时立即订阅两类导航事件。
   * @param initialUrl - 建会话那一刻的地址，用来给第一个事件补出 `from`。
   * @param options - 见 {@link DirtyTrackerOptions}。
   */
  constructor(connection: CdpConnection, initialUrl: string, options: DirtyTrackerOptions = {}) {
    this.onDocumentChanged = options.onDocumentChanged
    this.lastUrl = initialUrl
    // `Page.enable` 由 `open()` / `adoptSession()` 负责（那两处早就发过了），这里不重复 enable ——
    // 本模块一行 CDP 命令都不发，只是搭在既有事件流上。
    this.unsubscribes.push(connection.on('Page.frameNavigated', params => { this.onFrameNavigated(params) }))
    this.unsubscribes.push(connection.on('Page.navigatedWithinDocument', params => { this.onWithinDocument(params) }))
  }

  /**
   * 记一次「本会话马上要动手了」的赊账：接下来 TTL 内到达的**一次**文档变化算我们自己引起的。
   *
   * 必须在派发动作**之前**调用 —— 事件与地址变化是同时发生的，事后补记必然与到达顺序赛跑。
   */
  expectSelfNavigation(): void {
    const now = Date.now()
    // 顺手清掉过期的：动作失败（写前门拒绝、命令超时）时这条赊账不会等到事件来抵，
    // 而队尾只在 `absorb()` 里 pop —— 不清就成了长期会话里的单向增长。
    while (this.selfNavigations.length > 0
      && now - (this.selfNavigations[0] as number) > SELF_NAVIGATION_TTL_MS) {
      this.selfNavigations.shift()
    }
    this.selfNavigations.push(now)
  }

  /**
   * 记一次人工接管窗口开启（§6.5 的 `holder` → `human`，或 DevTools 被打开）。
   *
   * 同时把 `takeoverWindow` 从 `undefined` 翻成数字 —— **第一次真实信号到达才认这条通道存在**。
   */
  noteTakeoverWindow(): void {
    this.takeoverWindow = (this.takeoverWindow ?? 0) + 1
    this.at = Date.now()
  }

  /**
   * D-19：同 host+path 下只有 query/hash 变过 —— **不作废 ref 纪元**，只标脏。
   *
   * ## 为什么要挡「事件流已经见过的地址」（2026-09-19 实测查出的一处归因反了）
   *
   * 这个方法有**两个**调用方，两条独立的时间线：
   * - 事件线：`Page.navigatedWithinDocument` 到达 → 计数或抵账（赊账命中时**不计数**）；
   * - 轮询线：写前门 / `detectNavigation` 读到地址与纪元不同 → 调这里。
   *
   * 两条线都会看见**同一次**变化。于是自己点击引发的软导航（Google 类页面每交互一次换一批
   * 遥测令牌）会出现：事件被赊账抵掉（正确），轮询线却又数了一笔 —— 回执于是宣称
   * 「页面在**本会话之外**变过」，而它明明是这次点击自己造成的，还会让模型照那句
   * 「重拍一次全量快照」（中位 ≈5500 字符）白付一次 —— 正好是 D-19 要省掉的那笔开销。
   *
   * 判据用**事件流的游标**：`lastUrl` 记的是「事件流最近报过或抵过的地址」。它已经等于
   * `to` 就说明这一次变化事件线处理过了 —— 无论当时是计数（外部变化，已进
   * `withinDocument`）还是抵账（自己引发的，**按 §6.3 本就该静默**），轮询线都不该再记一笔。
   * 反过来，地址真的变了而 `lastUrl` 还停在旧值，就说明**事件没到**（`Page.enable` 之前
   * 加载完、事件丢失），这正是这个桶作为兜底该接住的那一类。
   *
   * @param from - 纪元记录的地址。
   * @param to - 当下读到的地址。
   */
  noteAddressDrift(from: string, to: string): void {
    // 事件线已经处理过这一次变化（计过数或抵过账）→ 不重复记。见上面的长注释。
    if (to === this.lastUrl) return
    if (to === this.lastDriftTo) return
    this.lastDriftTo = to
    this.addressDrift += 1
    this.route = { from, to }
    this.at = Date.now()
  }

  /**
   * 全量快照落地 → 锚点前移，脏标记清空。
   *
   * **只在 `publish()`（全页快照）后调用**，不在 `adopt()`（区域快照）后调用：区域快照
   * 不换表、旧 ref 仍然有效，页面「在模型之外变过」这件事并没有因为拍了一个角落而消失。
   */
  reset(): void {
    this.navigated = 0
    this.withinDocument = 0
    this.addressDrift = 0
    this.takeoverWindow = undefined
    this.route = undefined
    this.at = undefined
    this.lastDriftTo = undefined
    // ⚠️ **不清** `selfNavigations`，这一条是必需的而不是顺手：`Page.frameNavigated` 走
    // WebSocket，与「轮询读到新文档」是两条独立的时间线 —— `open()` / `webpage_navigate`
    // 等到新文档可用时，提交事件可能还在路上。`reset()` 清掉赊账 = 那条迟到的事件会被
    // 记成一笔「模型之外有人动过页面」。队列靠 TTL 自净，不会因为「动作失败没等来事件」而变长
    // （见 `expectSelfNavigation`）。
    //
    // 代价（写下来免得被当成 bug）：动作失败时那笔赊账会在 TTL（10s）内继续有效，
    // 期间一次**真**的外部导航会被抵掉一次。方向是**少报**，不是错报 —— 宁可漏一次提示，
    // 也不要凭空告诉模型「旁边有人在动页面」（那会它去重拍一次没有任何必要的快照）。
    // 也不重置 `lastUrl`：它跟着事件流走，是给下一个事件补 `from` 用的。
  }

  /**
   * 当前的脏累加状态。**只读**，调用它不会清空任何计数（见文件头的「拉而不推」）。
   *
   * @returns 脏时给出报告；完全干净时 `undefined` —— 字段「脏时才出现」是 §6.2 的约束，
   *   它同时兑现 J3（别把回执再撑大）与「不给噪声加喇叭」。
   */
  report(): BrowserPageChanged | undefined {
    if (this.navigated === 0 && this.withinDocument === 0 && this.addressDrift === 0
      && (this.takeoverWindow ?? 0) === 0) {
      return undefined
    }
    return {
      navigated: this.navigated,
      withinDocument: this.withinDocument,
      ...this.addressDrift > 0 ? { addressDrift: this.addressDrift } : {},
      // 信号通道缺席时**整条不出现**：恒 0 与「观察不到」是两件事，都印成 0 就是骗模型。
      ...this.takeoverWindow !== undefined ? { takeoverWindow: this.takeoverWindow } : {},
      ...this.route !== undefined ? { route: this.route } : {},
      ...this.at !== undefined ? { at: this.at } : {},
    }
  }

  /** 退订事件（会话关闭时）。 */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes.length = 0
  }

  /** 主 frame 真导航。子 frame（带 `parentId`）不算 —— 它换文档不影响模型手上的 ref。 */
  private onFrameNavigated(params: unknown): void {
    const frame = (params as { frame?: { readonly url?: unknown; readonly parentId?: unknown } }).frame
    if (frame === undefined || frame.parentId !== undefined) return
    const to = typeof frame.url === 'string' ? frame.url : ''
    if (this.absorb()) {
      this.lastUrl = to
      return
    }
    this.navigated += 1
    this.note(to)
  }

  /**
   * 软导航。**不做主 frame 过滤**：这个事件不带 `parentId`，而唯一的判据 `frameId`
   * 在「页面在 `Page.enable` 之前就加载完」的常见情形下拿不到（那正是大多数会话）。
   * 代价是同源子 frame 自己 `pushState` 会多记一笔 —— 方向是**多报一次提示**，
   * 不是漏报，可以接受（§6.3「事件通道会漏，别当全集」，这里是它的反面：会多）。
   */
  private onWithinDocument(params: unknown): void {
    const to = (params as { readonly url?: unknown }).url
    const url = typeof to === 'string' ? to : ''
    if (this.absorb()) {
      this.lastUrl = url
      return
    }
    this.withinDocument += 1
    this.note(url)
  }

  /** 抵掉一次赊账；没有未过期的赊账时返回 `false`（那就是真·外部变化）。 */
  private absorb(): boolean {
    const now = Date.now()
    while (this.selfNavigations.length > 0) {
      const issued = this.selfNavigations[0] as number
      this.selfNavigations.shift()
      if (now - issued <= SELF_NAVIGATION_TTL_MS) return true
    }
    return false
  }

  /** 记下 route / at，并通知外部（§6.2 ③ 的簿记写入）。 */
  private note(to: string): void {
    if (to !== '') this.route = { from: this.lastUrl, to }
    this.at = Date.now()
    if (to !== '') this.lastUrl = to
    const report = this.report()
    if (report !== undefined) this.onDocumentChanged?.(report)
  }
}
