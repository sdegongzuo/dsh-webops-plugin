/** 时间、文本、元素状态及稳定性等待；导航收尾复用 PageNavigation。 */

import { type BrowserMutationRequest, type BrowserMutationResult, type BrowserWaitEvidence, BrowserError } from '../browser/types.ts'
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
    if (wantsTime && request.timeoutMs !== undefined) {
      throw new BrowserError('webpage_wait time_ms cannot be combined with timeout_ms', 'BROWSER_PROTOCOL_ERROR')
    }
    if (request.refState !== undefined && !wantsRef) {
      throw new BrowserError('webpage_wait ref_state requires ref', 'BROWSER_PROTOCOL_ERROR')
    }
    const deadlineMs = wantsTime ? undefined : request.timeoutMs ?? this.config.waitTimeoutMs
    if (deadlineMs !== undefined && (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_WAIT_TIME_MS)) {
      throw new BrowserError(`webpage_wait timeout_ms must be between 1 and ${String(MAX_WAIT_TIME_MS)}`, 'BROWSER_PROTOCOL_ERROR')
    }
    const beforeUrl = session.url
    // 完成证据的基线：等待**开始前**的正文长度与本轮标记是否已存在。
    // 「旧轮完成标记」在等待前就在页面上，命中它不能证明本轮回复完成 —— 必须在这里先量一次，
    // 不能只靠回执文案提醒模型。探测一律受本次等待期限约束，不能让短期限 wait 多阻塞两条命令。
    const evidenceDeadlineMs = Date.now() + (deadlineMs ?? request.timeMs ?? this.config.waitTimeoutMs)
    const baseline = await this.readContentBaseline(
      session, wantsText ? request.text as string : undefined, signal, evidenceDeadlineMs - Date.now(),
    )
    let satisfied = true
    let signals: BrowserMutationResult['signals']
    let refState: 'hidden' | 'visible' | 'removed' | undefined
    if (wantsStable) {
      const outcome = await this.waitUntilStable(session, request.timeoutMs, signal)
      satisfied = outcome.satisfied
      signals = outcome.signals
    } else if (request.timeMs !== undefined) {
      if (!Number.isInteger(request.timeMs) || !(request.timeMs > 0) || request.timeMs > MAX_WAIT_TIME_MS) {
        throw new BrowserError(
          `webpage_wait time_ms must be between 1 and ${String(MAX_WAIT_TIME_MS)}`,
          'BROWSER_PROTOCOL_ERROR',
        )
      }
      await delay(request.timeMs, signal)
    } else if (wantsText) {
      const text = request.text as string
      satisfied = await pollUntil(
        async remainingMs => {
          const evaluated = await session.connection.send<EvaluateResult>(
            'Runtime.evaluate',
            { expression: `document.body !== null && document.body.innerText.includes(${JSON.stringify(text)})`, returnByValue: true },
            { signal, timeoutMs: Math.min(this.config.commandTimeoutMs, remainingMs) },
          )
          return evaluated.result?.value === true
        },
        // wait 的 probe 会真发命令：失败要当「还没等到」继续等，而不是让整个工具失败。
        { timeoutMs: deadlineMs as number, signal, swallowErrors: true },
      )
    } else {
      const ref = request.ref as string
      const wantsHidden = request.refState === 'hidden'
      // hidden 语义也吃 ref 纪元：旧 ref 在这里直接抛，不会傻等一个不存在的元素。
      // 但「元素已脱离文档」正是 removed 分支要等的结果，细门对它放行（allowDetached）。
      const objectId = await this.nodes.resolveObjectId(session, ref, signal, { allowDetached: true })
      try {
        satisfied = await pollUntil(
          async remainingMs => {
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
              { signal, timeoutMs: Math.min(this.config.commandTimeoutMs, remainingMs) },
            )
            return evaluated.result?.value === true
          },
          // 同上：hidden 分支的 probe 也是直接发命令，同样不能让工具失败。
          { timeoutMs: deadlineMs as number, signal, swallowErrors: true },
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
            if (signal?.aborted === true) {
              throw signal.reason ?? new BrowserError('the operation was aborted', 'BROWSER_CONNECTION_LOST')
            }
            // 状态读不到就不附加（不把探测失败当成状态结论）。
          }
        }
      } finally {
        this.nodes.releaseObject(session, objectId, signal)
      }
    }
    // 条件未成立时期限通常已耗尽，不再发第二条命令；newContent 如实报 unknown。
    const after = satisfied
      ? await this.readContentBaseline(session, undefined, signal, evidenceDeadlineMs - Date.now())
      : undefined
    const newContent: BrowserWaitEvidence['newContent'] =
      baseline?.length === undefined || after?.length === undefined
        ? 'unknown'
        : after.length > baseline.length ? 'observed' : 'not_observed'
    const condition: BrowserWaitEvidence['condition'] = wantsTime ? 'time'
      : wantsText ? 'text' : wantsRef ? 'ref' : 'stable'
    let basis: BrowserWaitEvidence['basis']
    let completion: BrowserWaitEvidence['completion'] = 'unverified'
    if (wantsText) {
      if (!satisfied) basis = 'timeout'
      else if (baseline === undefined) basis = 'baseline_unavailable'
      else if (baseline.textPresent === true) basis = 'preexisting_marker'
      else {
        basis = 'exclusive_text_marker'
        completion = 'verified'
      }
    } else if (wantsStable) {
      basis = satisfied ? 'quiet_only' : 'timeout'
    } else if (wantsTime) {
      basis = 'fixed_delay'
    } else {
      basis = satisfied ? 'node_only' : 'timeout'
    }
    const waitEvidence: BrowserWaitEvidence = {
      condition, conditionMet: satisfied, completion, basis, newContent,
    }
    const result = await this.navigation.settleMutation(session, 'wait', beforeUrl, false, signal)
    return {
      ...result,
      satisfied,
      waitEvidence,
      ...signals !== undefined ? { signals } : {},
      ...refState !== undefined ? { refState } : {},
    }
  }

  /**
   * 一次 `Runtime.evaluate` 读页面正文长度（以及可选标记是否已存在）。
   *
   * 这是**只读探测**，不是完成判据：正文变长可能来自广告、时间戳或别的轮次，
   * 所以它只写进 `newContent`，不参与 `completion` 判定。读不到返回 undefined，
   * 让上层保守地标 `baseline_unavailable` / `unknown`，不把探测失败伪装成没变化。
   */
  private async readContentBaseline(
    session: SessionState,
    marker: string | undefined,
    signal: AbortSignal | undefined,
    remainingMs: number,
  ): Promise<{ length: number; textPresent: boolean } | undefined> {
    if (remainingMs <= 0) return undefined
    const includes = marker === undefined ? 'false' : `t.includes(${JSON.stringify(marker)})`
    try {
      const evaluated = await session.connection.send<EvaluateResult>(
        'Runtime.evaluate',
        {
          expression: `(() => { const el = document.body; const t = el && el.innerText !== undefined ? el.innerText : '';`
            + ` return { length: t.length, textPresent: ${includes} }; })()`,
          returnByValue: true,
        },
        { signal, timeoutMs: Math.min(this.config.commandTimeoutMs, remainingMs) },
      )
      const value = evaluated.result?.value
      if (value === null || typeof value !== 'object') return undefined
      const record = value as Record<string, unknown>
      const length = record['length']
      if (typeof length !== 'number' || !Number.isFinite(length)) return undefined
      return { length, textPresent: record['textPresent'] === true }
    } catch (error) {
      // 期限到点/命令超时按「读不到」处理；取消必须原样传播，不能吞掉 abort。
      if (signal?.aborted === true) throw signal.reason ?? error
      return undefined
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
    const deadlineMs = timeoutMs ?? this.config.waitTimeoutMs
    const windowMs = this.config.stableQuietWindowMs
    const graceMs = this.config.stableNetworkGraceMs
    const deadline = Date.now() + deadlineMs
    let quietStreak = 0
    let networkBusySince: number | undefined
    let signals: NonNullable<BrowserMutationResult['signals']> = {
      readyState: 'loading',
      dom: 'busy',
      network: 'busy',
    }
    const installed = await this.withinDeadline(deadline, signal, timeout =>
      this.evaluateDomQuietInstall(session, signal, timeout).then(() => true))
    if (installed === undefined) return { satisfied: false, signals }
    for (;;) {
      const ready = await this.withinDeadline(deadline, signal, timeout =>
        this.evaluateReadyComplete(session, signal, timeout))
      if (ready === undefined) return { satisfied: false, signals }
      const mutations = await this.withinDeadline(deadline, signal, timeout =>
        this.evaluateDomQuietRead(session, signal, timeout))
      if (mutations === undefined) return { satisfied: false, signals }
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

  private async withinDeadline<T>(
    deadline: number,
    signal: AbortSignal | undefined,
    command: (timeoutMs: number) => Promise<T>,
  ): Promise<T | undefined> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    const timeoutMs = Math.min(this.config.commandTimeoutMs, remaining)
    try {
      return await command(timeoutMs)
    } catch (error) {
      if (signal?.aborted !== true && timeoutMs < this.config.commandTimeoutMs
        && Date.now() >= deadline && error instanceof BrowserError
        && error.code === 'BROWSER_CDP_COMMAND_TIMEOUT') return undefined
      throw error
    }
  }

  private async evaluateReadyComplete(session: SessionState, signal?: AbortSignal, timeoutMs = this.config.commandTimeoutMs): Promise<boolean> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      { expression: 'document.readyState === "complete"', returnByValue: true },
      { signal, timeoutMs },
    )
    return evaluated.result?.value === true
  }

  private async evaluateDomQuietInstall(session: SessionState, signal?: AbortSignal, timeoutMs = this.config.commandTimeoutMs): Promise<void> {
    await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      {
        expression: '(() => { const g = globalThis; if (g.__dsh_mut_installed === true) return true; try { g.__dsh_mut_count = 0; new MutationObserver(() => { g.__dsh_mut_count = (g.__dsh_mut_count ?? 0) + 1 }).observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true }); g.__dsh_mut_installed = true; return true } catch { return false } })()',
        returnByValue: true,
      },
      { signal, timeoutMs },
    )
  }

  private async evaluateDomQuietRead(session: SessionState, signal?: AbortSignal, timeoutMs = this.config.commandTimeoutMs): Promise<number> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      {
        expression: '(() => { const g = globalThis; const n = Number(g.__dsh_mut_count ?? 0); g.__dsh_mut_count = 0; return n })()',
        returnByValue: true,
      },
      { signal, timeoutMs },
    )
    const value = evaluated.result?.value
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

}
