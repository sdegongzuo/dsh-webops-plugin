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
 *    亚毫秒级（Runtime 微秒 `[V17]`、Log 毫秒带小数），同桶撞车概率低，可接受 —— 这是
 *    高水位方案的已知代价，不是 bug；
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
  /** 毫秒时间戳；`Runtime` 的微秒已折算成毫秒，两域可比。 */
  readonly timestamp: number
  /** 来自哪个域。 */
  readonly source: 'runtime' | 'log'
}

/** 读取时的过滤条件。 */
export interface ConsoleReadOptions {
  /** 最多返回多少条（从最新往回）。 */
  readonly limit: number
  /** 只保留该 level（大小写不敏感）。 */
  readonly level?: string | undefined
  /** 只保留文本包含该子串的条目（大小写不敏感）。 */
  readonly text?: string | undefined
}

/** {@link ConsoleCollector.read} 的结果。 */
export interface ConsoleReadResult {
  readonly entries: readonly ConsoleEntry[]
  /** 匹配的条目多于 `limit`。 */
  readonly truncated: boolean
  /** 过滤前缓冲里的条目总数。 */
  readonly buffered: number
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
   * @param options - 数量上限与 level / 文本子串过滤。
   */
  read(options: ConsoleReadOptions): ConsoleReadResult {
    const level = options.level?.toLowerCase()
    const text = options.text?.toLowerCase()
    const matched: ConsoleEntry[] = []
    let total = 0
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]
      if (entry === undefined) continue
      if (level !== undefined && entry.level.toLowerCase() !== level) continue
      if (text !== undefined && !entry.text.toLowerCase().includes(text)) continue
      total += 1
      if (matched.length < options.limit) matched.push(entry)
    }
    return { entries: matched, truncated: total > matched.length, buffered: this.entries.length }
  }

  /** 退订两个事件；会话关闭时调用。 */
  dispose(): void {
    for (const off of this.unsubscribes) off()
    this.unsubscribes.length = 0
  }

  /** 一条入站条目：过高水位或进提示桶。 */
  private accept(entry: ConsoleEntry, bucket: string): void {
    const { timestamp } = entry
    if (timestamp > 0) {
      const watermark = this.watermarks.get(bucket)
      if (watermark !== undefined && timestamp <= watermark) return
      this.watermarks.set(bucket, watermark === undefined ? timestamp : Math.max(watermark, timestamp))
    } else {
      // 截断提示条目（timestamp 恒为 0，`[V39]`）：它是内容缺失的唯一信号，必须绕过高水位。
      // 重复 enable 会重复投递同一条，按桶 + 文本去重，避免重复入账。
      const key = `${bucket}\u0000${entry.text}`
      if (this.notices.has(key)) return
      this.notices.add(key)
      this.replayTruncated = true
    }
    this.entries.push(entry)
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
    // Runtime 的 timestamp 是微秒（`[V17]`）；折算成毫秒，好与 Log 对齐。
    const timestamp = typeof record.timestamp === 'number' ? record.timestamp / 1000 : Date.now()
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
    // Log 的 timestamp 是毫秒带亚毫秒小数；截断提示条目恒为 0。
    const timestamp = typeof record['timestamp'] === 'number' ? record['timestamp'] : Date.now()
    this.accept({ level, text: clip(rawText), timestamp, source: 'log' }, `log:${source}`)
  }
}
