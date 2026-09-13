/**
 * network 采集器（方案 3.2 + 3.2.1）。
 *
 * ## 采集方式与边界
 *
 * 只用 `Network.enable` 读事件（`requestWillBeSent` / `responseReceived` / `loadingFailed`）。
 * **`requestId` 直接使用，不做任何映射**（`[V18]` 实测跨 session 完全一致，且用收到的 id 调
 * `Network.getResponseBody` 能拿到响应体）。**禁止 `Fetch.enable`** —— 它是拦截 / 改写请求的
 * 通道，超出「只读采集」的边界。**也禁止顺手调 `Network.emulateNetworkConditions` /
 * `setExtraHTTPHeaders`** —— `[V25][V26]` 实测二者跨 client 覆盖、后写赢，会污染人工会话。
 *
 * ## 「会丢」不是「全丢」，是「半截」（3.2.1）
 *
 * `Network` **不做历史重放**（`[V38]`）：detach 窗口内**已完成**的请求事件永久丢失 —— 这是
 * 已知且接受的能力边界。但**进行中**的请求在 re-attach 后仍会投递后续事件，其中
 * **detach 期间发起**的那些**缺 `requestWillBeSent`**（`[V40]`）—— 而 `requestWillBeSent` 带着
 * method / URL / 请求头，是建档的唯一来源。所以「只在 `requestWillBeSent` 时建 entry」是最自然
 * 也最危险的写法：那批响应事件会变成无头孤儿被**静默丢弃**。
 *
 * 本实现的处置：收到找不到 entry 的 `responseReceived` / `loadingFailed` 时**建一条降级记录**，
 * 标 `partial: true` + `reason: 'request-headers-missing'`，URL 从 `response.url` 取，method 明确
 * 标为未知。绝不静默丢弃。
 *
 * ## 内存：为什么请求表也有上限
 *
 * 方案没规定，这里定 `NETWORK_TABLE_CAPACITY = 500` 条环形。理由：`Runtime`/`Log` 的 console
 * 缓冲有 1000 条硬下界，而网络请求在真实页面里通常**比 console 更密集**（一个页面几十上百条
 * 子资源很正常）；不设上限的长会话会无界增长。500 条足够覆盖「最近一次交互产生的请求」，
 * 更早的请求体绝大多数也已经拿不到了（`Network.getResponseBody` 对已回收的资源会报错）。
 *
 * @module dsh-webops-plugin/browser-cdp/network
 */

import type { CdpConnection } from './protocol.ts'

/**
 * 每个会话的请求表上限（条，环形）。见文件头「内存」一节：网络事件比 console 更密集，
 * 需要一个独立于 console 缓冲的上界来防止长会话膨胀。
 */
export const NETWORK_TABLE_CAPACITY = 500

/** `Network.getResponseBody` 返回体的裁剪上限（字符）。 */
export const NETWORK_MAX_BODY_CHARS = 20_000

/** 一条网络请求（可能是降级的半截记录）。 */
export interface NetworkEntry {
  readonly requestId: string
  /** 请求方法；半截记录里未知（缺 `requestWillBeSent`）。 */
  readonly method?: string
  readonly url: string
  readonly status?: number
  readonly mimeType?: string
  readonly fromDiskCache?: boolean
  /** 是否缺 `requestWillBeSent` 的降级记录。 */
  readonly partial?: boolean
  /** 降级原因；目前只有 `request-headers-missing`。 */
  readonly reason?: string
  /** `loadingFailed` 的错误文本。 */
  readonly errorText?: string
}

/** 读取响应体的结果。 */
export interface NetworkBodyResult {
  readonly body: string
  readonly base64Encoded: boolean
  /** body 因超长被裁剪。 */
  readonly truncated: boolean
}

/** 从 `Network.loadingFailed` 里读出的字段。 */
interface LoadingFailedParams {
  readonly requestId?: unknown
  readonly errorText?: unknown
}

/** 一条请求在表里的可变形态。 */
interface MutableEntry {
  requestId: string
  method?: string
  url: string
  status?: number
  mimeType?: string
  fromDiskCache?: boolean
  partial?: boolean
  reason?: string
  errorText?: string
}

/** 读一个对象字段里的字符串。 */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * 一条 `CdpConnection` 上的 network 采集器。provider 的会话对象独占它。
 */export class NetworkCollector {
  private readonly connection: CdpConnection
  /** 按到达顺序保存；`Map` 保留插入序，所以最早插入的就是最旧的。 */
  private readonly requests = new Map<string, NetworkEntry>()
  private readonly unsubscribes: (() => void)[] = []

  /**
   * @param connection - 该会话的 CDP 连接；构造时立即订阅三个事件。
   */
  constructor(connection: CdpConnection) {
    this.connection = connection
    this.unsubscribes.push(connection.on('Network.requestWillBeSent', params => this.onRequest(params)))
    this.unsubscribes.push(connection.on('Network.responseReceived', params => this.onResponse(params)))
    this.unsubscribes.push(connection.on('Network.loadingFailed', params => this.onFailed(params)))
  }

  /** 当前请求表里的条目数。 */
  get size(): number {
    return this.requests.size
  }

  /**
   * 补发 `Network.enable`。命令失败原样上抛（例如 detach 期间），交给工具层处理。
   * @param options - 单次命令的超时与取消信号。
   */
  async refresh(options: { signal?: AbortSignal | undefined; timeoutMs: number }): Promise<void> {
    await this.connection.send('Network.enable', {}, options)
  }

  /**
   * 列出请求（从最新往回，最多 `limit` 条）。
   * @param limit - 数量上限。
   * @param urlFilter - 只保留 URL 包含该子串的条目（大小写不敏感）。
   */
  list(limit: number, urlFilter?: string | undefined): readonly NetworkEntry[] {
    const needle = urlFilter?.toLowerCase()
    const matched: NetworkEntry[] = []
    const values = [...this.requests.values()]
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const entry = values[index]
      if (entry === undefined) continue
      if (needle !== undefined && !entry.url.toLowerCase().includes(needle)) continue
      matched.push(entry)
      if (matched.length >= limit) break
    }
    return matched
  }

  /** 取一条记录（诊断用）。 */
  get(requestId: string): NetworkEntry | undefined {
    return this.requests.get(requestId)
  }

  /**
   * 取响应体。直接用收到的事件里的 `requestId`（`[V18]`，不需要任何映射）。
   * @param requestId - 事件里的请求 id。
   * @param options - 单次命令的超时与取消信号。
   */
  async body(requestId: string, options: { signal?: AbortSignal | undefined; timeoutMs: number }): Promise<NetworkBodyResult> {
    const response = await this.connection.send<{ body?: unknown; base64Encoded?: unknown }>(
      'Network.getResponseBody',
      { requestId },
      options,
    )
    const body = typeof response.body === 'string' ? response.body : ''
    const base64Encoded = response.base64Encoded === true
    if (body.length <= NETWORK_MAX_BODY_CHARS) return { body, base64Encoded, truncated: false }
    return {
      body: `${body.slice(0, NETWORK_MAX_BODY_CHARS)}\n…[truncated ${body.length - NETWORK_MAX_BODY_CHARS} chars]`,
      base64Encoded,
      truncated: true,
    }
  }

  /** 退订三个事件；会话关闭时调用。 */
  dispose(): void {
    for (const off of this.unsubscribes) off()
    this.unsubscribes.length = 0
  }

  /** 写一条记录并维持 500 条的环形上界（最旧的先出）。 */
  private put(entry: MutableEntry): void {
    this.requests.set(entry.requestId, { ...entry })
    if (this.requests.size > NETWORK_TABLE_CAPACITY) {
      const oldest = this.requests.keys().next().value
      if (oldest !== undefined) this.requests.delete(oldest)
    }
  }

  /** `requestWillBeSent`：建档的唯一来源。 */
  private onRequest(params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    const record = params as Record<string, unknown>
    const requestId = readString(record, 'requestId')
    const request = record['request']
    if (requestId === undefined || typeof request !== 'object' || request === null) return
    const requestRecord = request as Record<string, unknown>
    const method = readString(requestRecord, 'method')
    this.put({
      requestId,
      url: readString(requestRecord, 'url') ?? '',
      ...method !== undefined ? { method } : {},
    })
  }

  /** `responseReceived`：更新已有记录；找不到就建降级记录（`[V40]`，半截记录）。 */
  private onResponse(params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    const record = params as Record<string, unknown>
    const requestId = readString(record, 'requestId')
    const response = record['response']
    if (requestId === undefined || typeof response !== 'object' || response === null) return
    const responseRecord = response as Record<string, unknown>
    const url = readString(responseRecord, 'url') ?? ''
    const status = typeof responseRecord['status'] === 'number' ? responseRecord['status'] : undefined
    const mimeType = readString(responseRecord, 'mimeType')
    const fromDiskCache = responseRecord['fromDiskCache'] === true
    const existing = this.requests.get(requestId)
    if (existing === undefined) {
      // 无头孤儿：`requestWillBeSent` 在 detach 窗口里没补发。绝不静默丢弃 —— 建降级记录。
      this.put({
        requestId,
        url,
        ...status !== undefined ? { status } : {},
        ...mimeType !== undefined ? { mimeType } : {},
        ...fromDiskCache ? { fromDiskCache } : {},
        partial: true,
        reason: 'request-headers-missing',
      })
      return
    }
    this.put({
      ...existing,
      requestId,
      url: url.length > 0 ? url : existing.url,
      ...status !== undefined ? { status } : {},
      ...mimeType !== undefined ? { mimeType } : {},
      ...fromDiskCache ? { fromDiskCache } : {},
    })
  }

  /** `loadingFailed`：记录错误文本；找不到记录同样建降级记录。 */
  private onFailed(params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    const record = params as LoadingFailedParams
    const requestId = typeof record.requestId === 'string' ? record.requestId : undefined
    if (requestId === undefined) return
    const errorText = typeof record.errorText === 'string' ? record.errorText : 'loading failed'
    const existing = this.requests.get(requestId)
    this.put(existing === undefined
      ? { requestId, url: '', errorText, partial: true, reason: 'request-headers-missing' }
      : { ...existing, requestId, errorText })
  }
}
