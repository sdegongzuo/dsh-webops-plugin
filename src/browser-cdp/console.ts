/**
 * console 采集器（方案 3.1 + 3.1.1）。
 *
 * ## 事件源与去重
 *
 * 只吃两个 CDP 事件：`Runtime.consoleAPICalled` 与 `Log.entryAdded`。
 *
 * **去重走 3.1.1 的路径乙：按域分桶的高水位时间戳。** 每个桶只记「该流已处理到的最大
 * timestamp」，重放回来的旧消息时间戳必然 ≤ 高水位，一律丢弃。内存是 O(桶数) 而不是
 * O(消息数)，长时间运行不涨。三条注记：
 *
 * 1. 重放是**按序**的（`[V13]`：`M1M2` → `M1M2M3` → `M1M2M3M4`），所以「记最新一条的时间戳」
 *    这种 O(1) 判据成立，不需要 seen-set；
 * 2. 副作用：**同一桶内、时间戳完全相同（或更旧）的第二条会被丢掉**。两域的时间戳精度都在
 *    亚毫秒级，同桶撞车概率低，可接受 —— 这是高水位方案的已知代价，不是 bug；
 * 3. 桶维度**不能两域共用**：`Runtime.consoleAPICalled` 有 `executionContextId`，桶用
 *    `('rt', contextId, type)`；`Log.entryAdded` 没有这个字段，只剩 `source`
 *    （实测取值 `javascript` / `network` / `other`），桶用 `('log', source)`。按域分桶同时
 *    也是最安全的做法：某版本对 `Log` 重放口径的保证与 `Runtime` 不一致时，两域不会串桶。
 *
 * ## 环形缓冲：为什么是 ≥1000
 *
 * `RING_CAPACITY >= 1000` **不是去重的正确性前提**（路径乙里高水位独立于缓冲存活），而是
 * **窗口一致性**要求：实时采集能留存的历史不应短于 re-attach 时能补齐的量。两域的重放上限
 * 实测都是 1000（`[V24][V39]`），所以 1000 就是下界 —— 否则补齐时反而要丢掉大部分重放消息、
 * 兜底白做。别写成「因为要去重所以要 1000」。
 *
 * ## enable 策略：与去重是同一个闭环
 *
 * host 侧 re-attach 之后 **不保证** 之前 enable 过的 domain 还在（方案 2.2 另注），而 provider
 * 观测不到 re-attach 的确切时刻。务实做法：**每次 read 之前补发 `Runtime.enable` + `Log.enable`
 * 再读缓冲**。enable 会触发全量重放（`[V13]`），这批重放正好被高水位吃掉 —— 于是「补发
 * enable」和「去重」合成一个闭环：补得越频繁，重放越频繁，但都进不了缓冲。
 *
 * **绝不调 `Runtime.disable` / `Log.disable`**：那是 session 私有的使能位，但 disable 会掐掉
 * 本 session 的事件流而无任何收益，且语义上像在替其它 client 关东西。
 *
 * ## `Log` 的超限信号
 *
 * `Log` 域超限时会显式补一条截断提示条目（`timestamp` 恒为 0，形如
 * `'2010 log entries are not shown.'`，`[V39]`）。它是「这里有内容缺失」的**唯一信号**，任何
 * 高水位都会把它当旧消息丢掉 —— 所以 `timestamp <= 0` 的条目**绕过高水位**直接放行。
 * 但重复 enable 会重复投递同一条提示，因此对这类条目额外按文本去重，避免重复入账。
 *
 * ## 时间戳单位：按量级判，不写死假设（2026-09-14 修）
 *
 * 两个域的时间戳**口径不一致**，而且会随 Chromium 版本漂移。2026-09-14 实测（驱动真
 * Electron 窗口）：`Runtime.consoleAPICalled.timestamp` 给的是**毫秒**（≈1.79e12），而本文件
 * 曾按「微秒」硬除以 1000 —— 读出来的 Runtime 条目比 Log 条目小 1000 倍（报告里 Runtime
 * `1789316252`「秒」对 Log `1789316204273`「毫秒」）。
 * 所以换算不再写死单位，改由 {@link normalizeTimestamp} 按量级判（秒 / 毫秒 / 微秒三种口径
 * 都能落回毫秒），跨版本也不会再翻 1000 倍。
 *
 * ## 跨导航的条目
 *
 * 一个标签页会导航很多次（`browser_click` 就会）。缓冲里的旧条目属于**上一个文档**，
 * 直接读会给模型看一片早已过期的日志，所以每条都带上文档序号，`read` 默认只返回
 * **当前文档**的条目，并如实报告被隐藏了多少条（`earlierDocuments`）—— 不是静默丢弃
 * （条目仍在缓冲里，`allDocuments` 可读全部）。文档序号由 `provider` 在观察到导航时推进。
 *
 * @module dsh-webops-plugin/browser-cdp/console
 */

import type { CdpConnection } from './protocol.ts'

/**
 * 环形缓冲容量（条）。见文件头：这是**窗口一致性**下界（两域重放上限 `[V24][V39]` 都是 1000），
 * 不是去重前提。
 */
export const CONSOLE_RING_CAPACITY = 1000

/** 单条 console 文本的裁剪上限（字符）；控制台内容是不可信数据，别让它撑爆上下文。 */
export const CONSOLE_TEXT_MAX_CHARS = 2_000

/** 归一化后的一条 console 条目（毫秒时间戳）。 */
export interface ConsoleEntry {
  /** `Runtime` 用事件 type（log / info / warning / error …）；`Log` 用 `entry.level`。 */
  readonly level: string
  readonly text: string
  /** 毫秒时间戳；两域经 {@link normalizeTimestamp} 折算到同一把尺子上，可比。 */
  readonly timestamp: number
  /** 来自哪个域。 */
  readonly source: 'runtime' | 'log'
  /** 采集到这条时该标签页处于第几个文档（0 起；导航一次 +1）。 */
  readonly document: number
}

/** 读取时的过滤条件。 */
export interface ConsoleReadOptions {
  /** 最多返回多少条（从最新往回）。 */
  readonly limit: number
  /** 只保留该 level（大小写不敏感）。 */
  readonly level?: string | undefined
  /** 只保留文本包含该子串的条目（大小写不敏感）。 */
  readonly text?: string | undefined
  /** 连更早文档的条目一起返回。默认 false：只给当前文档的。 */
  readonly allDocuments?: boolean | undefined
}

/** {@link ConsoleCollector.read} 的结果。 */
export interface ConsoleReadResult {
  readonly entries: readonly ConsoleEntry[]
  /** 匹配的条目多于 `limit`。 */
  readonly truncated: boolean
  /** 过滤前缓冲里的条目总数（含更早文档的）。 */
  readonly buffered: number
  /** 当前文档序号（0 起）。 */
  readonly document: number
  /** 缓冲里属于更早文档、**没被返回**的条目数（`allDocuments: true` 时恒为 0 —— 都返回了）。 */
  readonly earlierDocuments: number
}

/**
 * 把 CDP 给的时间戳统一成**毫秒**。
 *
 * 两个域的口径不一致，且随 Chromium 版本漂移过，所以不写死单位、按量级判：
 * 秒级 ≈1.7e9、毫秒级 ≈1.7e12、微秒级 ≈1.7e15。`raw <= 0` 是 `Log` 的截断提示
 * （`timestamp` 恒为 0，`[V39]`），原样透传 —— 它必须继续绕过高水位。
 *
 * @param raw - CDP 给的原样时间戳。
 * @returns 毫秒时间戳（`raw <= 0` 时原样返回）。
 */
export function normalizeTimestamp(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return raw
  if (raw < 1e11) return raw * 1000
  if (raw < 1e14) return raw
  return raw / 1000
}

/** `Runtime.consoleAPICalled` 里用到的字段。 */
interface ConsoleApiParams {
  readonly type?: unknown
  readonly args?: unknown
  readonly executionContextId?: unknown
  readonly timestamp?: unknown
}

/** 把任意值安全地压成一段文本（console 参数可能是对象 / 循环引用）。 */
function stringify(value: unknown): string {
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? String(value) : encoded
  } catch {
    return String(value)
  }
}

/** 把一个 `RemoteObject` 压成一行文本。 */
function formatRemoteObject(arg: unknown): string {
  if (typeof arg !== 'object' || arg === null) return String(arg)
  const record = arg as Record<string, unknown>
  const value = record['value']
  if (value !== undefined) {
    if (typeof value === 'string') return value
    return typeof value === 'object' ? stringify(value) : String(value)
  }
  const description = record['description']
  if (typeof description === 'string') return description
  const type = record['type']
  return typeof type === 'string' ? type : 'undefined'
}

/** 裁剪一条文本。 */
function clip(text: string): string {
  return text.length <= CONSOLE_TEXT_MAX_CHARS
    ? text
    : `${text.slice(0, CONSOLE_TEXT_MAX_CHARS)}…[truncated ${text.length - CONSOLE_TEXT_MAX_CHARS} chars]`
}

/**
 * 一条 `CdpConnection` 上的 console 采集器。provider 的会话对象独占它；同一会话的操作串行。
 */
export class ConsoleCollector {
  private readonly connection: CdpConnection
  private readonly entries: ConsoleEntry[] = []
  /** 桶 → 该流已处理到的最大 timestamp。 */
  private readonly watermarks = new Map<string, number>()
  /** 已入账的 `timestamp <= 0` 提示条目标识（跨多次 enable 去重）。 */
  private readonly notices = new Set<string>()
  private readonly unsubscribes: (() => void)[] = []
  private replayTruncated = false
  /** 当前文档序号（0 起）；provider 每次观察到导航就 +1。 */
  private document = 0

  /**
   * @param connection - 该会话的 CDP 连接；构造时立即订阅两个事件。
   */
  constructor(connection: CdpConnection) {
    this.connection = connection
    this.unsubscribes.push(connection.on('Runtime.consoleAPICalled', params => this.onConsoleApi(params)))
    this.unsubscribes.push(connection.on('Log.entryAdded', params => this.onLogEntry(params)))
  }

  /** 缓冲里当前的条目总数（过滤前）。 */
  get buffered(): number {
    return this.entries.length
  }

  /** `Log` 域是否发生过重放截断（收到过 `timestamp=0` 的提示条目，`[V39]`）。 */
  get truncatedReplay(): boolean {
    return this.replayTruncated
  }

  /** 当前文档序号（0 起）。 */
  get currentDocument(): number {
    return this.document
  }

  /**
   * 通报「标签页换文档了」：此后采集到的条目属于新文档，`read` 默认只返回它们的。
   *
   * 条目**不**被丢弃（`allDocuments` 仍可读），也不动高水位 —— 时间是单调的，旧文档的
   * 事件不会在新文档之后再到达。
   */
  noteNavigation(): void {
    this.document += 1
  }

  /**
   * 补发 `Runtime.enable` + `Log.enable`，把 re-attach 后可能丢失的 enable 状态找回来。
   *
   * 会触发全量重放（`[V13]`），但重放被高水位吃掉，所以这里只管发命令、不管结果 ——
   * 命令本身失败（例如 detach 期间）会按原样上抛，交给工具层当可恢复错误处理。
   *
   * @param options - 单次命令的超时与取消信号。
   */
  async refresh(options: { signal?: AbortSignal | undefined; timeoutMs: number }): Promise<void> {
    await this.connection.send('Runtime.enable', {}, options)
    await this.connection.send('Log.enable', {}, options)
  }

  /**
   * 读取最近的条目（从最新往回，最多 `limit` 条）。
   *
   * 默认只返回**当前文档**的条目 —— 导航之后旧文档的日志对模型是噪音；被过滤掉多少条
   * 如实写在 `earlierDocuments` 里，`allDocuments: true` 可以连它们一起读。
   *
   * @param options - 数量上限与 level / 文本子串 / 文档范围过滤。
   */
  read(options: ConsoleReadOptions): ConsoleReadResult {
    const level = options.level?.toLowerCase()
    const text = options.text?.toLowerCase()
    const allDocuments = options.allDocuments === true
    const matched: ConsoleEntry[] = []
    let total = 0
    let earlierDocuments = 0
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]
      if (entry === undefined) continue
      if (entry.document !== this.document && !allDocuments) {
        // 只在真的被遮住时计数：`allDocuments: true` 时它们是返回了的，报「隐藏了 N 条」是假话。
        earlierDocuments += 1
        continue
      }
      if (level !== undefined && entry.level.toLowerCase() !== level) continue
      if (text !== undefined && !entry.text.toLowerCase().includes(text)) continue
      total += 1
      if (matched.length < options.limit) matched.push(entry)
    }
    return {
      entries: matched,
      truncated: total > matched.length,
      buffered: this.entries.length,
      document: this.document,
      earlierDocuments,
    }
  }

  /** 退订两个事件；会话关闭时调用。 */
  dispose(): void {
    for (const off of this.unsubscribes) off()
    this.unsubscribes.length = 0
  }

  /** 一条入站条目：过高水位或进提示桶。 */
  private accept(entry: Omit<ConsoleEntry, 'document'>, bucket: string): void {
    const { timestamp } = entry
    if (timestamp > 0) {
      const watermark = this.watermarks.get(bucket)
      if (watermark !== undefined && timestamp <= watermark) return
      this.watermarks.set(bucket, watermark === undefined ? timestamp : Math.max(watermark, timestamp))
    } else {
      // 截断提示条目（timestamp 恒为 0，`[V39]`）：它是内容缺失的唯一信号，必须绕过高水位。
      // 重复 enable 会重复投递同一条，按 文档 + 桶 + 文本 去重，避免重复入账（换了文档要重新报一次）。
      const key = `${this.document}\u0000${bucket}\u0000${entry.text}`
      if (this.notices.has(key)) return
      this.notices.add(key)
      this.replayTruncated = true
    }
    this.entries.push({ ...entry, document: this.document })
    // 环形裁剪：超出容量丢掉最旧的。
    if (this.entries.length > CONSOLE_RING_CAPACITY) {
      this.entries.splice(0, this.entries.length - CONSOLE_RING_CAPACITY)
    }
  }

  /** `Runtime.consoleAPICalled` → 桶 `('rt', executionContextId, type)`（`[V17]`）。 */
  private onConsoleApi(params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    const record = params as ConsoleApiParams
    const type = typeof record.type === 'string' ? record.type : 'log'
    const contextId = typeof record.executionContextId === 'number' ? record.executionContextId : -1
    // 单位不写死：`normalizeTimestamp` 按量级把秒 / 毫秒 / 微秒都折算成毫秒。
    // 旧实现硬按微秒 `/1000`，在「已是毫秒」的 Chromium 上把 Runtime 条目读小了 1000 倍。
    const timestamp = typeof record.timestamp === 'number' ? normalizeTimestamp(record.timestamp) : Date.now()
    const args = Array.isArray(record.args) ? record.args : []
    const text = clip(args.map(formatRemoteObject).join(' '))
    this.accept({ level: type, text, timestamp, source: 'runtime' }, `rt:${contextId}:${type}`)
  }

  /** `Log.entryAdded` → 桶 `('log', source)`；该域**没有** `executionContextId`。 */
  private onLogEntry(params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    const entry = (params as { entry?: unknown }).entry
    if (typeof entry !== 'object' || entry === null) return
    const record = entry as Record<string, unknown>
    const source = typeof record['source'] === 'string' ? record['source'] : 'other'
    const level = typeof record['level'] === 'string' ? record['level'] : 'info'
    const rawText = typeof record['text'] === 'string' ? record['text'] : ''
    // Log 的时间戳同样是按量级归一；截断提示条目恒为 0，原样保留（要绕过高水位）。
    const timestamp = typeof record['timestamp'] === 'number' ? normalizeTimestamp(record['timestamp']) : Date.now()
    this.accept({ level, text: clip(rawText), timestamp, source: 'log' }, `log:${source}`)
  }
}
