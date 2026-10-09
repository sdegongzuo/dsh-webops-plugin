/** 统一取消感知等待与轮询骨架；保持先探测再判超时的顺序。 */

import { BrowserError } from '../browser/types.ts'
import { WAIT_POLL_INTERVAL_MS } from './provider-config.ts'

/** 可取消的 sleep。 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new BrowserError('the operation was aborted', 'BROWSER_CONNECTION_LOST'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal === undefined) return
    if (signal.aborted) {
      clearTimeout(timer)
      reject(signal.reason ?? new BrowserError('the operation was aborted', 'BROWSER_CONNECTION_LOST'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 统一的轮询骨架：**先探一次，再判超时，最后按间隔等**。
 *
 * 2026-09-17 之前，等待逻辑在本文件里写了六遍（pollUntil / detectNavigation /
 * settleDocument / waitForNavigation / waitForDocument / collectOpenedTabs），
 * 每一遍都是 `for(;;){probe; deadline; delay}` 的复制品，间隔常量还不统一
 * （100 与 `min(100, 剩余)` 两种），而「先探还是先判超时」这个顺序一旦写反，
 * `timeoutMs = 0` 就变成「一次都不探」。所以收敛到这里，六处只留各自的判定条件。
 *
 * 间隔取 `min(intervalMs, 剩余时间)`：正常情况就是 `intervalMs`，窗口快到时不会睡过头。
 *
 * @param probe - 探一次；返回真即停下。
 * @param options - 超时上限、轮询间隔（默认 {@link WAIT_POLL_INTERVAL_MS}）、取消信号；
 *   `swallowErrors` 为真时把 `probe` 的异常当「还没成立」继续等（**默认不吞** ——
 *   多数等待的 probe 自己就有 try/catch，吞掉反而会藏住真错）。
 * @returns `probe` 是否成立过。
 */
export async function pollUntil(
  probe: () => Promise<boolean>,
  options: {
    timeoutMs: number
    intervalMs?: number | undefined
    signal?: AbortSignal | undefined
    swallowErrors?: boolean | undefined
  },
): Promise<boolean> {
  const interval = options.intervalMs ?? WAIT_POLL_INTERVAL_MS
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    // `webpage_wait` 的两处 probe 是直接发 CDP 命令，页面中途导航会让 objectId 失效、
    // 单条命令也可能超时 —— 那不是「等的条件不满足」，但也不该让整个工具失败。
    // 旧骨架在这里是吞异常继续等的，语义必须保住（2026-09-17 收敛时差点丢掉）。
    const ok = options.swallowErrors === true ? await probe().catch(() => false) : await probe()
    if (ok) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await delay(Math.min(interval, remaining), options.signal)
  }
}
