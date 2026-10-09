/** provider 内部会话状态、协议返回体和文档变化通知；同一会话由入口持有。 */

import type { CdpConnection } from './protocol.ts'
import { RefRegistry } from './refs.ts'
import { ConsoleCollector } from './console.ts'
import { NetworkCollector } from './network.ts'
import { SessionDirtyTracker } from './dirty.ts'
import type { AxNode } from './snapshot.ts'

/**
 * 一个会话的**控制权**归属（方案 §6.5 的人工接管按钮）。
 *
 * 与 `SessionState.takeover` 是两个独立的信号，**别合并**：
 * - `holder` 是**声明** —— 人按了按钮，明说「现在换我操作」，它决定 agent 能不能动手；
 * - `takeover` 是**观测** —— 有人开着 DevTools，只影响 snapshot 回执里的提示。
 *
 * 合并的后果是真实的：「人在接管期间开一次 DevTools 又关掉」会把他自己的接管一起撤掉。
 */
export type BrowserHolder = 'agent' | 'human'

/** 一个受控标签页的全部状态。 */
export interface SessionState {
  readonly targetId: string
  readonly connection: CdpConnection
  readonly refs: RefRegistry
  /** P2 console 采集器（Runtime + Log 两域，按域分桶去重）。 */
  readonly consoleCollector: ConsoleCollector
  /** P2 network 采集器（requestId 直接用，不做映射）。 */
  readonly networkCollector: NetworkCollector
  /**
   * P2 跨轮次脏累加器（方案 §6.2 ①）：攒着「页面在本会话之外变过」的分类计数，
   * 下一次回执夹带。与 `takeover` 是两个维度 —— 见 `dirty.ts` 的文件头。
   */
  readonly dirty: SessionDirtyTracker
  url: string
  title: string
  /**
   * P3 人工接管状态位（方案 4.1.1）：有人正开着 DevTools 操作这个页面。
   * **幂等状态位，不是计数器** —— agent 自己 toggle DevTools 时也会被置位，无需去重。
   * 它只影响 snapshot 结果里的提示，**绝不推进 ref 纪元**（`[V31]`）。
   *
   * 与 {@link SessionState.dirty} 是**两个维度**，别合并：这个说「有人正开着 DevTools」（状态），
   * 那个说「页面自上次快照之后变过」（动作计数）。人工不开 DevTools 改页面时这一位是 `false`
   * 而那一边有数 —— 回执里两者同时出现不矛盾。
   */
  takeover: boolean
  /**
   * §6.5 控制权：谁在操作这个页面。
   *
   * `'agent'`（默认）时本会话的写操作全放行；`'human'` 时（人在标签条上按了「接管」）
   * 写操作一律拒（`BROWSER_HUMAN_HOLDING`），且 ref 纪元在**切换那一刻**就已作废 ——
   * 所以交还之后也不能复用接管前的号，必须重拍快照（判据 J5/J6）。
   */
  holder: BrowserHolder
  /**
   * P3 locate 高亮状态位：本 session 是否画过一层 `Overlay.highlightNode` 高亮。
   * 用于 `highlight: false` 时决定要不要补发 `Overlay.hideHighlight`（只弹自己那层，`[V31]`）。
   */
  highlightPainted: boolean
}

/** 页面元信息，由一次 `Runtime.evaluate` 取回。 */
export interface PageMeta {
  readonly url: string
  readonly title: string
}

/** `Runtime.evaluate` 的返回体（只声明用到的字段）。 */
export interface EvaluateResult {
  readonly result?: { readonly value?: unknown }
}

/** `Page.navigate` 的返回体。 */
export interface NavigateResult {
  readonly errorText?: string
  readonly isDownload?: boolean
}

/** `Page.getNavigationHistory` 的返回体（`back` / `forward` 要用）。 */
export interface NavigationHistoryResult {
  readonly currentIndex?: number
  readonly entries?: readonly { readonly id: number; readonly url?: string }[]
}

/** `Page.captureScreenshot` 的返回体。 */
export interface CaptureResult {
  readonly data?: string
}

/** `Accessibility.getFullAXTree` 的返回体。 */
export interface AxTreeResult {
  readonly nodes?: readonly AxNode[]
}

/** `Page.getFrameTree` 的返回体；只取主 frame 的 `loaderId`（url 不同源，见 `readMainLoaderId`）。 */
export interface FrameTreeResult {
  readonly frameTree?: { readonly frame?: { readonly loaderId?: string } }
}

/** `Page.getLayoutMetrics` 的视口矩形。 */
interface LayoutViewportMetrics {
  readonly pageX?: number
  readonly pageY?: number
  readonly clientWidth?: number
  readonly clientHeight?: number
}

export interface LayoutMetricsResult {
  readonly visualViewport?: LayoutViewportMetrics
  readonly cssVisualViewport?: LayoutViewportMetrics
  readonly layoutViewport?: LayoutViewportMetrics
  readonly cssLayoutViewport?: LayoutViewportMetrics
}

/** `DOMSnapshot.captureSnapshot` 的布局树。 */
export interface CaptureSnapshotResult {
  readonly strings?: readonly string[]
  readonly documents?: readonly {
    readonly nodes?: {
      readonly backendNodeId?: readonly number[]
      readonly parentIndex?: readonly number[]
      readonly nodeName?: readonly number[]
    }
    readonly layout?: {
      readonly nodeIndex?: readonly number[]
      readonly bounds?: readonly (readonly number[])[]
    }
  }[]
}

/** `DOM.resolveNode` 的返回体。 */
export interface ResolveNodeResult {
  readonly object?: { readonly objectId?: string }
}

/** `DOM.getBoxModel` 的返回体。 */
export interface BoxModelResult {
  readonly model?: { readonly border?: readonly number[]; readonly content?: readonly number[] }
}

/** 截图裁剪区域（CSS 像素，相对文档）。 */
export interface ScreenshotClip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly scale: number
}

/** 落点命中校验的结果（页面里算完带回来的一小坨描述，`hitTest` 的返回体）。 */
export interface HitTestOutcome {
  /** 目标自身（或其祖先链上最近的可链接者）的绝对 href；不是链接时为 `null`。 */
  href?: string | null
  /** `target` = 落点上就是目标（或其子孙）；`other` = 被别人盖着；`none` = 落点不在视口内。 */
  hit?: 'target' | 'other' | 'none'
  /** 只在 `hit === 'other'` 时带：盖住落点的那个元素的描述。 */
  node?: { role: string; name: string; hint: string } | null
}

/** 视口中心那层浮层的描述（{@link OVERLAY_PROBE_EXPRESSION} 的返回体）。 */
export interface OverlayProbe {
  role: string
  name: string
  hint: string
}

/**
 * 通报两个采集器「这个会话换文档了」。
 *
 * console / network 的缓冲都是按会话累积的，不区分文档时会把上一个页面的日志与请求
 * 一股脑端给模型（报告 S5）。换文档只推进文档序号、不丢数据：`read` / `list` 默认只给
 * 当前文档的，被遮掉多少条如实报告。
 */
export function noteDocumentChange(session: SessionState): void {
  session.consoleCollector.noteNavigation()
  session.networkCollector.noteNavigation()
}
