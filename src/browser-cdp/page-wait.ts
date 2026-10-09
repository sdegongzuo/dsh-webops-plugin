/** 时间、文本、元素状态及稳定性等待；导航收尾复用 PageNavigation。 */

import { type BrowserMutationRequest, type BrowserMutationResult, BrowserError } from '../browser/types.ts'
import type { SessionState, EvaluateResult } from './provider-session.ts'
import { MAX_WAIT_TIME_MS, STABLE_QUIET_WINDOWS, type ResolvedConfig } from './provider-config.ts'
import { delay, pollUntil } from './polling.ts'
import { PageNodes } from './page-nodes.ts'
import { PageNavigation } from './page-navigation.ts'

export class PageWait {
  constructor(
    private readonly config: Pick<ResolvedConfig, 'commandTimeoutMs' | 'waitTimeoutMs' | 'stableQuietWindowMs' | 'stableNetworkGraceMs'>,
    private readonly nodes: PageNodes,
    private readonly navigation: PageNavigation,
  ) {}

  /** 等待：timeMs / text / ref / until:stable 四选一。 */
  async wait(
    session: SessionState,
    request: Extract<BrowserMutationRequest, { kind: 'wait' }>,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    const wantsTime = request.timeMs !== undefined
    const wantsText = request.text !== undefined && request.text.length > 0
    const wantsRef = request.ref !== undefined
    const wantsStable = request.until === 'stable'
    if ([wantsTime, wantsText, wantsRef, wantsStable].filter(chosen => chosen).length !== 1) {
      throw new BrowserError(
        'webpage_wait needs exactly one of time_ms, text, ref, or until',
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    const beforeUrl = session.url
    let satisfied = true
    let signals: BrowserMutationResult['signals']
    let refState: 'hidden' | 'visible' | 'removed' | undefined
    if (wantsStable) {
      const outcome = await this.waitUntilStable(session, request.timeoutMs, signal)
      satisfied = outcome.satisfied
      signals = outcome.signals
    } else if (request.timeMs !== undefined) {
      if (!(request.timeMs > 0) || request.timeMs > MAX_WAIT_TIME_MS) {
        throw new BrowserError(
          `webpage_wait time_ms must be between 1 and ${String(MAX_WAIT_TIME_MS)}`,
          'BROWSER_PROTOCOL_ERROR',
        )
      }
      await delay(request.timeMs, signal)
    } else if (wantsText) {
      const text = request.text as string
      satisfied = await pollUntil(
        async () => {
          const evaluated = await session.connection.send<EvaluateResult>(
            'Runtime.evaluate',
            { expression: `document.body !== null && document.body.innerText.includes(${JSON.stringify(text)})`, returnByValue: true },
            { signal, timeoutMs: this.config.commandTimeoutMs },
          )
          return evaluated.result?.value === true
        },
        // wait 的 probe 会真发命令：失败要当「还没等到」继续等，而不是让整个工具失败。
        { timeoutMs: this.config.waitTimeoutMs, signal, swallowErrors: true },
      )
    } else {
      const ref = request.ref as string
      const wantsHidden = request.refState === 'hidden'
      if (request.refState !== undefined && !wantsRef) {
        throw new BrowserError(
          'webpage_wait ref_state requires ref (it refines what "gone" means for that element)',
          'BROWSER_PROTOCOL_ERROR',
        )
      }
      // hidden 语义也吃 ref 纪元：旧 ref 在这里直接抛，不会傻等一个不存在的元素。
      // 但「元素已脱离文档」正是 removed 分支要等的结果，细门对它放行（allowDetached）。
      const objectId = await this.nodes.resolveObjectId(session, ref, signal, { allowDetached: true })
      try {
        satisfied = await pollUntil(
          async () => {
            const evaluated = await session.connection.send<EvaluateResult>(
              'Runtime.callFunctionOn',
              {
                objectId,
                // removed（默认）：等脱离文档。hidden：元素还连着文档但已不可见 ——
                // `checkVisibility()` 覆盖 display:none / visibility:hidden / content-visibility
                // 及祖先隐藏；没有该 API 的老内核退回布局盒判定。注意 hidden 条件**不含**
                // 已移除：流式页「等发送按钮消失」要的是被隐藏（本轮已提交、旧回答还在），
                // 节点被移除是另一回事，不能混作成功。
                functionDeclaration: wantsHidden
                  ? 'function () { if (!this.isConnected) return false;'
                    + ' if (typeof this.checkVisibility === "function") return !this.checkVisibility({ visibilityProperty: true });'
                    + ' const r = this.getBoundingClientRect(); const v = getComputedStyle(this).visibility;'
                    + ' return v === "hidden" || v === "collapse" || !(r.width > 0 && r.height > 0); }'
                  : 'function () { return !this.isConnected; }',
                returnByValue: true,
              },
              { signal, timeoutMs: this.config.commandTimeoutMs },
            )
            return evaluated.result?.value === true
          },
          // 同上：hidden 分支的 probe 也是直接发命令，同样不能让工具失败。
          { timeoutMs: this.config.waitTimeoutMs, signal, swallowErrors: true },
        )
        if (!satisfied) {
          // 项 2（2026-10-07）：超时要说明元素**此刻**是什么状态 —— 还在但隐藏
          // （display:none，盒子为 0）与还在且显示着，模型该走的下一步完全不同。
          // 只等「移除」的条件对一个只被隐藏的元素永远不会成立，回执必须把这层讲破。
          try {
            const boxProbe = await session.connection.send<EvaluateResult>(
              'Runtime.callFunctionOn',
              {
                objectId,
                functionDeclaration: 'function () {'
                  + ' if (!this.isConnected) return "removed";'
                  + ' const r = this.getBoundingClientRect();'
                  + ' const laidOut = r.width > 0 && r.height > 0'
                  + '   && (typeof this.checkVisibility === "function" ? this.checkVisibility({ visibilityProperty: true })'
                  + '     : !["hidden", "collapse"].includes(getComputedStyle(this).visibility));'
                  + ' return laidOut ? "visible" : "hidden"; }',
                returnByValue: true,
              },
              { signal, timeoutMs: this.config.commandTimeoutMs },
            )
            const state = boxProbe.result?.value
            if (state === 'hidden' || state === 'visible' || state === 'removed') refState = state
          } catch {
            // 状态读不到就不附加（不把探测失败当成状态结论）。
          }
        }
      } finally {
        this.nodes.releaseObject(session, objectId, signal)
      }
    }
    const result = await this.navigation.settleMutation(session, 'wait', beforeUrl, false, signal)
    return {
      ...result,
      satisfied,
      ...signals !== undefined ? { signals } : {},
      ...refState !== undefined ? { refState } : {},
    }
  }

  /**
   * `until: 'stable'`：readyState complete 是前置，DOM 连续两个安静窗口，
   * 网络 inflight==0 或已忙过宽限期。超时如实报 signals，不把慢页谎成稳定。
   */
  private async waitUntilStable(
    session: SessionState,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ satisfied: boolean; signals: NonNullable<BrowserMutationResult['signals']> }> {
    const deadlineMs = timeoutMs ?? MAX_WAIT_TIME_MS
    if (!(deadlineMs > 0) || deadlineMs > MAX_WAIT_TIME_MS) {
      throw new BrowserError(
        `webpage_wait timeout_ms must be between 1 and ${String(MAX_WAIT_TIME_MS)}`,
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    const windowMs = this.config.stableQuietWindowMs
    const graceMs = this.config.stableNetworkGraceMs
    await this.evaluateDomQuietInstall(session, signal)
    let quietStreak = 0
    let networkBusySince: number | undefined
    let signals: NonNullable<BrowserMutationResult['signals']> = {
      readyState: 'loading',
      dom: 'busy',
      network: 'busy',
    }
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const ready = await this.evaluateReadyComplete(session, signal)
      const mutations = await this.evaluateDomQuietRead(session, signal)
      if (mutations === 0) quietStreak += 1
      else quietStreak = 0
      const inflight = session.networkCollector.inflight
      if (inflight > 0) networkBusySince ??= Date.now()
      else networkBusySince = undefined
      const networkQuiet = inflight === 0
      const networkOk = networkQuiet
        || (networkBusySince !== undefined && Date.now() - networkBusySince >= graceMs)
      signals = {
        readyState: ready ? 'complete' : 'loading',
        dom: quietStreak >= STABLE_QUIET_WINDOWS ? 'quiet' : 'busy',
        network: networkQuiet ? 'quiet' : 'busy',
      }
      if (ready && quietStreak >= STABLE_QUIET_WINDOWS && networkOk) {
        return { satisfied: true, signals }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { satisfied: false, signals }
      await delay(Math.min(windowMs, remaining), signal)
    }
  }

  private async evaluateReadyComplete(session: SessionState, signal?: AbortSignal): Promise<boolean> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      { expression: 'document.readyState === "complete"', returnByValue: true },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    return evaluated.result?.value === true
  }

  private async evaluateDomQuietInstall(session: SessionState, signal?: AbortSignal): Promise<void> {
    await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      {
        expression: '(() => { const g = globalThis; if (g.__dsh_mut_installed === true) return true; try { g.__dsh_mut_count = 0; new MutationObserver(() => { g.__dsh_mut_count = (g.__dsh_mut_count ?? 0) + 1 }).observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true }); g.__dsh_mut_installed = true; return true } catch { return false } })()',
        returnByValue: true,
      },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
  }

  private async evaluateDomQuietRead(session: SessionState, signal?: AbortSignal): Promise<number> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      {
        expression: '(() => { const g = globalThis; const n = Number(g.__dsh_mut_count ?? 0); g.__dsh_mut_count = 0; return n })()',
        returnByValue: true,
      },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const value = evaluated.result?.value
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

}
