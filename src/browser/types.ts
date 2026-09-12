/**
 * ctx.browser 的公共类型：会话、观察请求与结果、错误类型。
 *
 * 分包与命名照 dsh 的 `packages/web/web/src/types.ts` 对齐。
 */

/** 浏览器能力错误的机器可读码。 */
export type BrowserErrorCode =
  | 'BROWSER_DUPLICATE_PROVIDER'
  | 'BROWSER_PROVIDER_CONFIGURED_MISSING'
  | 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'BROWSER_PROVIDER_UNAVAILABLE'
  | 'BROWSER_PROVIDER_AMBIGUOUS'
  | 'BROWSER_TARGET_NOT_FOUND'
  | 'BROWSER_SNAPSHOT_REQUIRED'
  | 'BROWSER_STALE_REF'
  | 'BROWSER_NOT_IMPLEMENTED'

/** 能力缝隙唯一抛出的错误类型。 */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode

  constructor(message: string, code: BrowserErrorCode) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

/** 新开一个受控标签页。省略 `url` 时开空白页。 */
export interface BrowserOpenRequest {
  readonly url?: string
}

/** 一个受控的浏览器会话（P0 里等于一个标签页）。 */
export interface BrowserSession {
  readonly id: string
  readonly url: string
  readonly title: string
}

/** 大纲里的一个可操作引用。 */
export interface BrowserRef {
  /** 形如 `e12`；只在产生它的 epoch 内有效。 */
  readonly ref: string
  readonly role: string
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
}

/** 截图。字节落盘走 `ctx.attachments.saveImage`，消息里只留引用。 */
export interface BrowserScreenshot {
  readonly kind: 'screenshot'
  readonly sessionId: string
  readonly data: Uint8Array
  readonly mediaType: 'image/png'
  readonly width: number
  readonly height: number
}

/** P0 的观察类请求。P1 会加入 click / fill / press 等 mutation 类型。 */
export type BrowserObserveRequest =
  | { readonly kind: 'snapshot'; readonly sessionId: string }
  | { readonly kind: 'screenshot'; readonly sessionId: string; readonly fullPage?: boolean }

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
  observe(request: BrowserObserveRequest, signal?: AbortSignal): Promise<BrowserObservation>
  close(sessionId: string): Promise<void>
}
