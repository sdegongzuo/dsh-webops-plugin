/** 文档身份读取、导航等待与动作后的文档收敛。 */

import { BrowserError, type BrowserMutationResult } from '../browser/types.ts'
import { sameDocumentIdentity } from './dirty.ts'
import type { CdpConnection } from './protocol.ts'
import {
  type SessionState,
  type FrameTreeResult,
  noteDocumentChange,
  type PageMeta,
  type EvaluateResult,
  type NavigateResult,
} from './provider-session.ts'
import { pollUntil } from './polling.ts'
import {
  MUTATION_NAVIGATION_POLL_MS,
  MUTATION_NAVIGATION_SETTLE_MS,
  type ResolvedConfig,
} from './provider-config.ts'
import { readNavigationState } from './provider-helpers.ts'

export class PageNavigation {
  constructor(
    private readonly config: Pick<ResolvedConfig, 'commandTimeoutMs' | 'navigationTimeoutMs'>,
  ) {}

  // ---------------------------------------------------------------------------
  // P1 mutation：click / fill / press / scroll / wait
  // ---------------------------------------------------------------------------

  /**
   * 读主 frame 的文档身份（`loaderId`）。读不到当身份未知：`revalidate` 会拒绝而不是误绑。
   *
   * 这里**不**顺带返回 `frame.url`（第 3 批曾合并成一次读，第 4 批撤回）：`Page.getFrameTree`
   * 的 url 是浏览器进程侧的镜像，而写前门比的是 renderer 的 `window.top.location.href`，
   * 两者在导航在飞 / 重定向 / 特权页上会差一档。需要纪元地址时一律走
   * {@link readPageMeta}，宁多一次往返也不要不同源的基线。
   */
  async readMainLoaderId(
    session: SessionState,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const tree = await session.connection.send<FrameTreeResult>(
        'Page.getFrameTree',
        {},
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      const loaderId = tree.frameTree?.frame?.loaderId
      return typeof loaderId === 'string' && loaderId.length > 0 ? loaderId : undefined
    } catch (error: unknown) {
      if (error instanceof BrowserError
        && (error.code === 'BROWSER_DEBUGGER_DETACHED' || error.code === 'BROWSER_CONNECTION_LOST')) {
        throw error
      }
      return undefined
    }
  }

  /**
   * 操作落地后的收尾：探测「地址是否变了」，变了就作废旧纪元并更新会话元信息。
   *
   * click / press 可能引发导航，但导航是异步的 —— 立刻读一次往往还是旧地址。
   * 所以这两类动作给一个短轮询窗口；fill / scroll / wait 只读一次。
   */
  async settleMutation(
    session: SessionState,
    action: BrowserMutationResult['action'],
    beforeUrl: string,
    awaitNavigation: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const navigated = await this.detectNavigation(session, beforeUrl, awaitNavigation, signal)
    const changed = session.dirty.report()
    return {
      kind: 'mutation',
      sessionId: session.targetId,
      action,
      epoch: session.refs.currentEpoch,
      url: session.url,
      title: session.title,
      navigated,
      ...changed !== undefined ? { pageChanged: changed } : {},
    }
  }

  /**
   * 探测地址是否变了；**文档身份**变了就作废既有 ref、换文档、更新会话元信息。
   *
   * 判据是**地址变化**（`meta.url !== beforeUrl`）而不是 `readyState`：软导航 / 异步提交
   * 都可能让 readyState 先于地址稳定。`awaitNavigation` 为真时给一个短轮询窗口
   * （`MUTATION_NAVIGATION_POLL_MS`），否则只读一次。
   *
   * ⚠️ 地址变化分两档（D-19，与 {@link assertPreActionGate} 同一口径）：
   * - **`scheme+host+path` 变了** → 真换文档，作废纪元；
   * - **只有 query / hash 变了** → 同一份文档，**不作废**，交给脏累加器报一句。
   *   这一档在 Google 类页面上是被实测过的痛点：遥测令牌每次交互都换，全文全等比较会让
   *   每一次点击都白作废一次 ref 表。
   *
   * 一旦判定导航（且 `awaitNavigation`），再等新文档「能用」（见 {@link settleDocument}）：
   * 地址变了但 `<title>` 还没解析时返回空标题，会被当成「页没就绪」（报告 S1）。
   *
   * @returns 是否检测到**换文档**（不含仅 query/hash 变化）。
   */
  async detectNavigation(
    session: SessionState,
    beforeUrl: string,
    awaitNavigation: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let navigated = false
    let settled = false
    // `timeoutMs = 0` 时骨架仍会先探一次再判超时 —— 这正是「只读一次」的语义。
    await pollUntil(
      async () => {
        const meta = await this.readPageMeta(session.connection, signal)
        if (meta !== undefined) {
          if (meta.url !== '' && meta.url !== beforeUrl) {
            if (sameDocumentIdentity(meta.url, beforeUrl)) {
              // D-19：同一份文档，只有 query / hash 变了（Google 类页面的遥测令牌抖动是最常见的一类）。
              // **不作废纪元**：全文全等比较会把每次抖动都判成「换文档」，于是模型手上 ref 全废、
              // 白重拍一次（中位 ≈5500 字符）。地址此刻已经定下来，所以也停止轮询，但**不算导航** ——
              // 回执里的 `navigated` 保持 false，另由脏累加器如实报一句「地址变了」。
              session.dirty.noteAddressDrift(beforeUrl, meta.url)
              settled = true
            } else {
              // 文档身份变了：旧 ref 全部作废，绝不许旧 ref 静默命中新页面上的元素。
              session.refs.invalidate()
              navigated = true
              noteDocumentChange(session)
            }
          }
          session.url = meta.url
          session.title = meta.title
        }
        return navigated || settled
      },
      { timeoutMs: awaitNavigation ? MUTATION_NAVIGATION_POLL_MS : 0, signal },
    )
    if (navigated && awaitNavigation) await this.settleDocument(session, signal)
    return navigated
  }

  /**
   * 等新文档「真的能用」：读到非空标题，或文档已 `complete`（那说明它本来就没有 `<title>`），
   * 或窗口耗尽。
   *
   * 报告 S1 的成因很具体：`webpage_press` 回车跳维基搜索页，`Page.navigate` 已提交（地址变了），
   * 但 `<title>` 还在解析中，于是工具立刻返回 `title: ''`，调用方据此误判「页还没就绪」。
   * 这里只补这一小段等待，**超时不算失败**（页面是慢，不是错），也绝不把 `press` 拖成超时。
   */
  async settleDocument(session: SessionState, signal?: AbortSignal): Promise<void> {
    await pollUntil(
      async () => {
        const meta = await this.readPageMeta(session.connection, signal)
        if (meta !== undefined) {
          session.url = meta.url
          session.title = meta.title
          if (meta.title.length > 0) return true
        }
        // 加载完还读不到标题 ⇒ 这个页面本来就没有 `<title>`，没必要等满窗口。
        return await this.documentComplete(session.connection, signal)
      },
      { timeoutMs: MUTATION_NAVIGATION_SETTLE_MS, signal },
    )
  }

  /** 读页面 URL 与标题；失败返回 `undefined`（页面可能是空白页或已崩溃）。 */
  async readPageMeta(connection: CdpConnection, signal?: AbortSignal): Promise<PageMeta | undefined> {
    try {
      const evaluated = await connection.send<EvaluateResult>(
        'Runtime.evaluate',
        { expression: '({ url: location.href, title: document.title })', returnByValue: true },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      const value = evaluated.result?.value
      if (typeof value !== 'object' || value === null) return undefined
      const { url, title } = value as Record<string, unknown>
      return {
        url: typeof url === 'string' ? url : '',
        title: typeof title === 'string' ? title : '',
      }
    } catch {
      return undefined
    }
  }

  /**
   * 跳到目标地址并等**新文档**顶上来。
   *
   * `about:blank` 是「不需要导航」的特例：它本来就是空白页，等 `readyState` 就够。
   *
   * @param connection - 目标页面的连接。
   * @param url - 目标地址（已过地址策略）。
   * @param previousUrl - 导航前的地址；用来判断新文档是否已提交。
   * @param signal - 取消信号。
   * @returns 是否在超时前完成加载（超时不抛错，交给调用方决定）。
   */
  async navigateTo(
    connection: CdpConnection,
    url: string,
    previousUrl: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (url !== 'about:blank') {
      const result = await connection.send<NavigateResult>(
        'Page.navigate',
        { url },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      if (result.errorText !== undefined && result.errorText.length > 0) {
        throw new BrowserError(`navigation to ${url} failed: ${result.errorText}`, 'BROWSER_NAVIGATION_FAILED')
      }
      return this.waitForNavigation(connection, previousUrl, signal, this.config.navigationTimeoutMs)
    }
    return this.waitForDocument(connection, signal, this.config.navigationTimeoutMs)
  }

  /**
   * 轮询到「地址已经变了，且新文档加载完成」。
   *
   * 判据必须是**地址变化**而不是 `readyState`：新标签页在导航提交前就是一个
   * `readyState === 'complete'` 的空白页，只看 readyState 会立刻判定加载完成，
   * 随后读到的 url / title / 大纲全是空白页的。
   *
   * @param connection - 目标页面的连接。
   * @param previousUrl - 导航前的地址。
   * @param signal - 取消信号。
   * @param timeoutMs - 超时上限。
   * @returns 是否在超时前完成。
   */
  async waitForNavigation(
    connection: CdpConnection,
    previousUrl: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    return await pollUntil(
      () => this.navigationSettled(connection, previousUrl, signal),
      { timeoutMs, signal },
    )
  }

  /** 问一次「地址变了吗 + 加载完了吗」；任何读取失败都当作「还没完成」。 */
  private async navigationSettled(
    connection: CdpConnection,
    previousUrl: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const evaluated = await connection.send<EvaluateResult>(
        'Runtime.evaluate',
        {
          expression: 'JSON.stringify({ ready: document.readyState === "complete", href: String(location.href) })',
          returnByValue: true,
        },
        { signal, timeoutMs: Math.min(this.config.commandTimeoutMs, 5_000) },
      )
      const state = readNavigationState(evaluated.result?.value)
      if (state === undefined || !state.ready) return false
      // 从空白页出发时只要求「不再是空白页」；否则要求「不再是刚才那个地址」。
      return previousUrl === 'about:blank' ? state.href !== 'about:blank' : state.href !== previousUrl
    } catch {
      return false
    }
  }

  /**
   * 轮询 `document.readyState === 'complete'`。
   *
   * 用轮询而不是 `Page.loadEventFired`，是因为后者有两个坑：事件可能在 `Page.enable` 之前
   * 就已经发过（空白页、缓存页），而 SPA 的软导航又可能根本不发。轮询只贵几次本机往返。
   * @returns 是否在超时前完成加载。
   */
  async waitForDocument(
    connection: CdpConnection,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    return await pollUntil(
      () => this.documentComplete(connection, signal),
      { timeoutMs, signal },
    )
  }

  /** 问一次 `document.readyState`；任何读取失败都当作「还没完成」。 */
  private async documentComplete(connection: CdpConnection, signal?: AbortSignal): Promise<boolean> {
    try {
      const evaluated = await connection.send<EvaluateResult>(
        'Runtime.evaluate',
        { expression: "document.readyState === 'complete'", returnByValue: true },
        { signal, timeoutMs: Math.min(this.config.commandTimeoutMs, 5_000) },
      )
      return evaluated.result?.value === true
    } catch {
      return false
    }
  }

}
