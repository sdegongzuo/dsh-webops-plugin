/** 同标签调用排队；取消一个候补不能让后续调用越过仍运行的前任。 */
export class TabCallQueue {
  private readonly tails = new Map<string, Promise<void>>()

  acquire(key: string, signal?: AbortSignal): (() => void) | Promise<() => void> {
    signal?.throwIfAborted()
    const pending = this.tails.get(key)
    const previous = pending ?? Promise.resolve()
    let release!: () => void
    const finished = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => finished)
    this.tails.set(key, tail)
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    if (pending === undefined) return release
    return this.wait(previous, release, signal)
  }

  private async wait(previous: Promise<void>, release: () => void, signal?: AbortSignal): Promise<() => void> {
    let abort: (() => void) | undefined
    try {
      if (signal === undefined) await previous
      else await Promise.race([previous, new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })])
      signal?.throwIfAborted()
      return release
    } catch (error) {
      release()
      throw error
    } finally {
      if (abort !== undefined) signal?.removeEventListener('abort', abort)
    }
  }
}
