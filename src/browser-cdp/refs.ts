/**
 * ref 纪元（epoch）—— P0 唯一一件「不做就会出错」的状态机。
 *
 * ## 为什么不能只靠 ref 字符串
 *
 * 一次 snapshot 给页面上每个可操作元素编号。下一次 snapshot 若从 1 重新编号，那么模型拿
 * 上一次的 `e3` 来操作时，很可能**命中一个完全不同的元素** —— 这是静默的、最难排查的错误。
 * 所以本实现用两条规则把这个可能性从根上删掉：
 *
 * 1. **序号在会话内单调递增，绝不重置。** `e1`、`e2` …… 只属于历史上某一次 snapshot；
 *    新 snapshot 从上一个纪元的最大值之后继续编号，因此「同号不同元素」不可能出现。
 * 2. **解析前先比纪元。** 持有 ref 表的永远是「当前纪元」那一份；换纪元就把整张表换掉。
 *
 * 于是旧 ref 只会落到「表里没有」，报 `BROWSER_STALE_REF`（有过 snapshot）或
 * `BROWSER_SNAPSHOT_REQUIRED`（从来没 snapshot 过），两者都是模型应当用「重新观察」来恢复的。
 *
 * @module dsh-browser-plugin/browser-cdp/refs
 */

import { BrowserError } from '../browser/types.ts'
import type { BrowserRef } from '../browser/types.ts'

/**
 * ref 指向的页面元素。`backendNodeId` 是 CDP 的「跨导航稳定 id」，用于后续
 * `DOM.resolveNode` / `DOM.getBoxModel`。
 */
export interface RefTarget {
  readonly ref: string
  readonly role: string
  readonly name: string
  readonly backendNodeId: number
}

/** 一次 snapshot 产出的 ref 表。 */
export interface RefPublication {
  readonly epoch: number
  readonly refs: readonly RefTarget[]
  readonly truncated: boolean
}

/**
 * 一个会话的 ref 状态机。**不是**并发安全的写者：它被 provider 的会话对象独占，
 * provider 内部对同一会话的操作是串行的。
 */
export class RefRegistry {
  private epoch = 0
  /**
   * 当前纪元的 ref 表。
   * - `undefined`：本次会话从未成功 snapshot。
   * - 空 Map：纪元被导航作废，但历史上观察过页面。
   */
  private targets: Map<string, RefTarget> | undefined

  /** 下一个可用的 ref 序号；跨 snapshot 单调递增。 */
  private sequence = 0

  /** 当前 ref 纪元。 */
  get currentEpoch(): number {
    return this.epoch
  }

  /** 是否曾经成功 snapshot 过（用于区分 `stale_ref` 与 `snapshot_required`）。 */
  get observed(): boolean {
    return this.targets !== undefined
  }

  /**
   * 把新一批 ref 装入新纪元。每次调用都会推进纪元 —— 上一次 snapshot 的 ref 立即作废。
   * @param rows - 本次 snapshot 里按出现顺序排列的元素（尚未分配 ref 名）。
   * @param truncated - 大纲是否因规模上限被截断。
   * @returns 带 ref 名的完整登记结果。
   */
  publish(rows: readonly Omit<RefTarget, 'ref'>[], truncated: boolean): RefPublication {
    const targets = new Map<string, RefTarget>()
    const refs: RefTarget[] = []
    for (const row of rows) {
      this.sequence += 1
      const entry: RefTarget = { ref: `e${this.sequence}`, ...row }
      targets.set(entry.ref, entry)
      refs.push(entry)
    }
    this.epoch += 1
    this.targets = targets
    return { epoch: this.epoch, refs, truncated }
  }

  /**
   * 作废当前纪元（导航、人工接管）。序号**不**回退，所以旧 ref 永远不会被新元素复用。
   * @returns 推进后的纪元。
   */
  invalidate(): number {
    this.epoch += 1
    this.targets = new Map<string, RefTarget>()
    return this.epoch
  }

  /**
   * 解析一个 ref。
   * @param ref - 模型给出的 ref 字符串。
   * @returns 当前纪元里该 ref 指向的元素。
   * @throws `BROWSER_SNAPSHOT_REQUIRED`（从未观察）或 `BROWSER_STALE_REF`（属于旧纪元）。
   */
  resolve(ref: string): RefTarget {
    const targets = this.targets
    if (targets === undefined) {
      throw new BrowserError(
        `ref "${ref}" cannot be resolved: this session has never been observed; run browser_snapshot first`,
        'BROWSER_SNAPSHOT_REQUIRED',
      )
    }
    const target = targets.get(ref)
    if (target === undefined) {
      throw new BrowserError(
        `ref "${ref}" belongs to an obsolete observation epoch (current epoch ${this.epoch}); run browser_snapshot again and use the refs it returns`,
        'BROWSER_STALE_REF',
      )
    }
    return target
  }

  /** 当前纪元的全部 ref（模型可见形态）。 */
  list(): readonly BrowserRef[] {
    if (this.targets === undefined) return []
    return [...this.targets.values()].map(({ ref, role, name }) => ({ ref, role, name }))
  }
}
