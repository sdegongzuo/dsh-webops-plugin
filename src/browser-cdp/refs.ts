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
 * 3. **区域快照走 {@link RefRegistry.adopt}，不换表。** 全页 `publish` 仍推进纪元；
 *    区域快照只追加新号，旧 ref 继续可用。
 * 4. **revalidate 走 {@link RefRegistry.restore}，同号装回。** `resolve` 仍然严格报 stale；
 *    最近 K 个纪元的表连同文档 `loaderId` 留在归档里，恢复时先对文档身份再对节点。
 *
 * 于是旧 ref 只会落到「表里没有」，报 `BROWSER_STALE_REF`（有过 snapshot）或
 * `BROWSER_SNAPSHOT_REQUIRED`（从来没 snapshot 过）。恢复优先 `webpage_revalidate`，
 * 失败再重新观察。
 *
 * @module dsh-webops-plugin/browser-cdp/refs
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
  /**
   * 恢复锚点：`hash(role + name + 稳定祖先路径)`。只参与匹配，不生成 ref 号。
   * 不出现在模型可见的 `list()` 里。
   */
  readonly semanticKey: string
}

/** `publish` 的输入行：祖先路径可选，缺省按空路径哈希。 */
export type RefPublishRow = Omit<RefTarget, 'ref' | 'semanticKey'> & {
  readonly ancestorPath?: string
}

/** 一次 snapshot 产出的 ref 表。 */
export interface RefPublication {
  readonly epoch: number
  readonly refs: readonly RefTarget[]
  readonly truncated: boolean
}

/** 归档里的一条过期纪元：revalidate 用，`resolve` 不看这里。 */
export interface ArchivedEpoch {
  readonly epoch: number
  readonly loaderId: string | undefined
  readonly target: RefTarget
}

/** 保留最近几个过期纪元；再早的精确恢复直接放弃。 */
export const ARCHIVE_EPOCH_LIMIT = 3

/** 归档条目总数上限；超出时从最旧的纪元整表丢掉。 */
export const ARCHIVE_ENTRY_CAP = 2000

/** 当前纪元 live 表上限。超出时软淘汰：丢掉元素指针，保留 semanticKey 索引。 */
export const LIVE_BINDING_CAP = 2000

/** 可序列化的恢复锚点：只存 ref 号与 semanticKey，不存元素指针。 */
export interface SemanticBinding {
  readonly ref: string
  readonly semanticKey: string
}

interface EpochArchive {
  readonly epoch: number
  readonly loaderId: string | undefined
  readonly targets: Map<string, RefTarget>
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

  /** 当前纪元记录的文档身份（主 frame `loaderId`）。 */
  private loaderId: string | undefined

  /** 最近几个过期纪元，最旧在前。 */
  private readonly archives: EpochArchive[] = []

  /**
   * 重启后第一次 `publish` 才消费：semanticKey → 唯一的旧 ref。
   * 多命中的 key 不进这张表，避免静默复活。
   */
  private pendingRebind: Map<string, string> | undefined

  /** 被软淘汰的 ref → semanticKey；唯一命中时可重新绑定同一号。 */
  private readonly evicted = new Map<string, string>()

  /** live ref → 最近一次写入的时钟，给 LRU 用。 */
  private readonly lastSeen = new Map<string, number>()

  private clock = 0

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
   * @param loaderId - 主 frame 的文档身份；revalidate 先拿这个比对，对不上就拒绝精确恢复。
   * @returns 带 ref 名的完整登记结果。
   */
  publish(rows: readonly RefPublishRow[], truncated: boolean, loaderId?: string): RefPublication {
    this.archiveCurrent()
    this.evicted.clear()
    this.lastSeen.clear()
    const targets = new Map<string, RefTarget>()
    const refs: RefTarget[] = []
    const pending = this.pendingRebind
    this.pendingRebind = undefined
    const { keys, counts } = indexBatch(rows)
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as RefPublishRow
      const semanticKey = keys[index] as string
      const reused = pending !== undefined
        && (counts.get(semanticKey) ?? 0) === 1
        ? pending.get(semanticKey)
        : undefined
      const entry = reused === undefined
        ? this.mint(row, semanticKey)
        : bindTarget(reused, row, semanticKey)
      targets.set(entry.ref, entry)
      refs.push(entry)
      this.touch(entry.ref)
    }
    this.targets = targets
    this.loaderId = loaderId
    this.epoch += 1
    this.trimLive()
    return { epoch: this.epoch, refs, truncated }
  }

  /**
   * 往**当前纪元**追加映射，不推进 epoch。
   *
   * `semanticKey` **唯一**命中当前表里的一条 → 复用该 ref 号，只更新节点指针。
   * 未命中或多命中 → 分配新号。同一次调用里同一 key 出现两次也算多命中
   * （否则第一条 mint 之后第二条会把这个号偷走，两个 backendNodeId 共用一个 ref）。
   */
  adopt(rows: readonly RefPublishRow[]): RefPublication {
    if (this.targets === undefined) {
      this.epoch = this.epoch === 0 ? 1 : this.epoch
      this.targets = new Map<string, RefTarget>()
    }
    const { keys, counts } = indexBatch(rows)
    const refs: RefTarget[] = []
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as RefPublishRow
      const uniqueInBatch = (counts.get(keys[index] as string) ?? 0) === 1
      refs.push(this.bindRow(row, uniqueInBatch))
    }
    this.trimLive()
    return { epoch: this.epoch, refs, truncated: false }
  }

  /**
   * 把已有的 ref 号装回**当前纪元**，不分配新号、不推进 epoch。
   *
   * `adopt` 会继续单调编号，不能拿来做 revalidate：模型手里拿的是旧号。
   * 序号只在装回的号大于当前序列时才上推，绝不回退。
   */
  restore(targets: readonly RefTarget[]): void {
    if (this.targets === undefined) {
      this.epoch = this.epoch === 0 ? 1 : this.epoch
      this.targets = new Map<string, RefTarget>()
    }
    for (const target of targets) {
      this.targets.set(target.ref, target)
      this.evicted.delete(target.ref)
      this.touch(target.ref)
      const serial = refSerial(target.ref)
      if (Number.isFinite(serial) && serial > this.sequence) this.sequence = serial
    }
    this.trimLive()
  }

  /**
   * 在过期纪元里查找一个 ref。当前表里的命中不走这里 —— `resolve` 才是当前表。
   * 从新到旧扫，所以同一号若出现在多个归档里（不该发生）取最近的。
   */
  archived(ref: string): ArchivedEpoch | undefined {
    for (let index = this.archives.length - 1; index >= 0; index -= 1) {
      const archive = this.archives[index]
      if (archive === undefined) continue
      const target = archive.targets.get(ref)
      if (target !== undefined) {
        return { epoch: archive.epoch, loaderId: archive.loaderId, target }
      }
    }
    return undefined
  }

  /**
   * 作废当前纪元（导航、人工接管）。序号**不**回退，所以旧 ref 永远不会被新元素复用。
   * @returns 推进后的纪元。
   */
  invalidate(): number {
    this.archiveCurrent()
    this.epoch += 1
    this.targets = new Map<string, RefTarget>()
    this.loaderId = undefined
    this.pendingRebind = undefined
    this.evicted.clear()
    this.lastSeen.clear()
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
        `ref "${ref}" cannot be resolved: this session has never been observed; run webpage_snapshot first`,
        'BROWSER_SNAPSHOT_REQUIRED',
      )
    }
    const target = targets.get(ref)
    if (target === undefined) {
      throw new BrowserError(
        `ref "${ref}" belongs to an obsolete observation epoch (current epoch ${this.epoch}); run webpage_snapshot again and use the refs it returns`,
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

  /** 可持久化的 `ref → semanticKey` 映射，不含 backendNodeId。 */
  exportBindings(): readonly SemanticBinding[] {
    const bindings: SemanticBinding[] = []
    if (this.targets !== undefined) {
      for (const { ref, semanticKey } of this.targets.values()) bindings.push({ ref, semanticKey })
    }
    for (const [ref, semanticKey] of this.evicted) bindings.push({ ref, semanticKey })
    return bindings
  }

  /**
   * 载入上一进程留下的锚点。不把会话标成已观察：第一次 `publish` 之前
   * `resolve` 仍是 `BROWSER_SNAPSHOT_REQUIRED`。下一次全页 `publish` 对**唯一**
   * key 复用旧号；缺席或多命中的在 snapshot 之后才是 stale，不复活。
   */
  hydrate(bindings: readonly SemanticBinding[]): void {
    this.loaderId = undefined
    const byKey = new Map<string, string[]>()
    for (const binding of bindings) {
      const list = byKey.get(binding.semanticKey) ?? []
      list.push(binding.ref)
      byKey.set(binding.semanticKey, list)
      const serial = refSerial(binding.ref)
      if (serial > this.sequence) this.sequence = serial
    }
    const pending = new Map<string, string>()
    for (const [key, refs] of byKey) {
      const only = refs[0]
      if (refs.length === 1 && only !== undefined) pending.set(key, only)
    }
    this.pendingRebind = pending
  }

  /**
   * 当前表里该 key 只有一条 → 复用其号；否则发新号。
   * 扫描当前 live 表，不看归档（跨 epoch 恢复走 restore / revalidate）。
   */
  private bindRow(row: RefPublishRow, uniqueInBatch: boolean): RefTarget {
    const live = this.targets
    if (live === undefined) {
      throw new Error('bindRow requires a live table')
    }
    const semanticKey = computeSemanticKey(row.role, row.name, row.ancestorPath ?? '')
    if (!uniqueInBatch) {
      const minted = this.mint(row, semanticKey)
      live.set(minted.ref, minted)
      this.touch(minted.ref)
      return minted
    }
    const hits: RefTarget[] = []
    for (const target of live.values()) {
      if (target.semanticKey === semanticKey) hits.push(target)
    }
    if (hits.length === 1) {
      const existing = hits[0] as RefTarget
      const updated = bindTarget(existing.ref, row, semanticKey)
      live.set(existing.ref, updated)
      this.touch(existing.ref)
      return updated
    }
    const evictedHits: string[] = []
    for (const [ref, key] of this.evicted) {
      if (key === semanticKey) evictedHits.push(ref)
    }
    if (hits.length === 0 && evictedHits.length === 1) {
      const ref = evictedHits[0] as string
      this.evicted.delete(ref)
      const updated = bindTarget(ref, row, semanticKey)
      live.set(ref, updated)
      this.touch(ref)
      return updated
    }
    const entry = this.mint(row, semanticKey)
    live.set(entry.ref, entry)
    this.touch(entry.ref)
    return entry
  }

  private touch(ref: string): void {
    this.clock += 1
    this.lastSeen.set(ref, this.clock)
  }

  /** 软淘汰直到 live 表不超过 {@link LIVE_BINDING_CAP}。 */
  private trimLive(): void {
    const live = this.targets
    if (live === undefined) return
    while (live.size > LIVE_BINDING_CAP) {
      let oldestRef: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const ref of live.keys()) {
        const seen = this.lastSeen.get(ref) ?? 0
        if (seen < oldestAt) {
          oldestAt = seen
          oldestRef = ref
        }
      }
      if (oldestRef === undefined) break
      const target = live.get(oldestRef)
      live.delete(oldestRef)
      this.lastSeen.delete(oldestRef)
      if (target !== undefined) this.evicted.set(oldestRef, target.semanticKey)
    }
  }

  private mint(row: RefPublishRow, semanticKey: string): RefTarget {
    this.sequence += 1
    return bindTarget(`e${this.sequence}`, row, semanticKey)
  }

  /** 把当前非空表推进归档，按纪元数和条目数封顶。 */
  private archiveCurrent(): void {
    const { targets } = this
    if (targets === undefined || targets.size === 0) return
    this.archives.push({
      epoch: this.epoch,
      loaderId: this.loaderId,
      targets,
    })
    while (this.archives.length > ARCHIVE_EPOCH_LIMIT) this.archives.shift()
    while (this.archiveSize() > ARCHIVE_ENTRY_CAP && this.archives.length > 0) this.archives.shift()
  }

  private archiveSize(): number {
    let total = 0
    for (const archive of this.archives) total += archive.targets.size
    return total
  }
}

/**
 * semanticKey：role + 可访问名 + 稳定祖先路径。只做匹配，不生成 ref。
 */
export function computeSemanticKey(role: string, name: string, ancestorPath = ''): string {
  return djb2Hex(`${role}\u0000${name}\u0000${ancestorPath}`)
}

function indexBatch(rows: readonly RefPublishRow[]): { keys: string[]; counts: Map<string, number> } {
  const keys = rows.map(row => computeSemanticKey(row.role, row.name, row.ancestorPath ?? ''))
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return { keys, counts }
}

function bindTarget(ref: string, row: RefPublishRow, semanticKey: string): RefTarget {
  return {
    ref,
    role: row.role,
    name: row.name,
    backendNodeId: row.backendNodeId,
    semanticKey,
  }
}

function refSerial(ref: string): number {
  const match = /^e(\d+)$/u.exec(ref)
  return match === null ? Number.NaN : Number(match[1])
}

function djb2Hex(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
