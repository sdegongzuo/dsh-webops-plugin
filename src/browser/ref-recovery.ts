/** ref 失败的单次只读恢复：预算、控制权和未派发证明均满足才观察。 */
import { BrowserError, type BrowserProvider } from './types.ts'

export async function attachRefRecovery(
  error: unknown,
  provider: BrowserProvider,
  sessionId: string,
  controlGeneration: number | undefined,
  assertHeld: () => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!(error instanceof BrowserError) || error.dispatchState !== 'not_dispatched'
    || (error.code !== 'BROWSER_STALE_REF' && error.code !== 'BROWSER_SNAPSHOT_REQUIRED')
    || signal?.aborted || controlGeneration === undefined
    || provider.refRecoveryState?.(sessionId) !== controlGeneration) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  const recoverySignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    assertHeld()
    error.recoveryAttempted = true
    const snapshot = await provider.observe({ kind: 'snapshot', sessionId }, recoverySignal)
    recoverySignal.throwIfAborted()
    assertHeld()
    if (snapshot.kind === 'snapshot' && provider.refRecoveryState?.(sessionId) === controlGeneration) {
      error.recoverySnapshot = snapshot
    }
  } catch {
    // 保留原错误；不覆盖为观察错误，不重放原操作。
  } finally {
    clearTimeout(timer)
  }
}
