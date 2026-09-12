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

/** 能力缝隙与 provider 唯一抛出的错误类型。 */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode

  constructor(message: string, code: BrowserErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BrowserError'
    this.code = code
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
  | { readonly kind: 'snapshot'; readonly sessionId: string }
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
  /** 归还一个会话：关闭它的标签页并释放连接。 */
  close(sessionId: string): Promise<void>
  /** 释放 provider 持有的全部资源（连接、标签页、进程）。可省略。 */
  dispose?(): Promise<void>
}
