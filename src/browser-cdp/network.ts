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
 * ## 跨导航的请求
 *
 * 标签页导航后，上位文档的请求对新页面是噪音（报告 2026-09-14 S5：console/network 跨
 * Wikipedia → the-internet → httpbin 一路累积）。所以每条记录带上文档序号，`list` 默认只返回
 * **当前文档**的请求，被遮掉多少条如实报告（`earlierDocuments`），`allDocuments` 可读全部；
 * `body` 按 `requestId` 取，不受影响（旧 requestId 仍取得到就取）。
 *
 * @module dsh-webops-plugin/browser-cdp/network
 */

import type { CdpConnection } from './protocol.ts'

/**
 * 每个会话的请求表上限（条，环形）。见文件头「内存」一节：网络事件比 console 更密集，
 * 需要一个独立于 console 缓冲的上界来防止长会话膨胀。
 */
export const NETWORK_TABLE_CAPACITY = 500

/** `Network.getResponseBody` 返回体的裁剪上限（字符）。只对**文本**响应生效。 */
export const NETWORK_MAX_BODY_CHARS = 20_000

/**
 * 二进制响应（`base64Encoded: true`）的裁剪上限（字符），比文本那条**紧十倍**。
 *
 * 为什么不一视同仁：base64 的 2 万字符约合 5.7k token，而它编码的是图片 / 字体 / wasm ——
 * 模型既解不出来也读不懂，属于纯噪声。留一小段只为「看出这是什么格式」（PNG 头、`woff2` 等），
 * 真要看图得走 `webpage_screenshot`（工具层会用一句话把这件事讲明）。
 */
export const NETWORK_MAX_BASE64_CHARS = 2_000

/**
 * 一次 `list` 返回的 URL 总字符预算。
 *
 * 数量上限（`limit`）挡不住单条超长：`data:` 开头的 URL 本身就能有几百 KB，请求表里
 * **从来不做 URL 截断**（截了会误导——URL 是要给模型复制出去用的）。所以再加一道**总量**闸门：
 * URL 累加超过本值就停，并在结果里如实说明「是被总量截断的」——那时调大 `limit` 没有用，
 * 得靠 `url` 过滤。（第一条永远返回，否则模型拿不到任何线索。）
 */
export const NETWORK_LIST_MAX_CHARS = 40_000

/**
 * 请求表的**字节**上界（URL 字符总数）。
 *
 * {@link NETWORK_TABLE_CAPACITY} 只按**条数**封顶，而单条 URL 的长度是不受控的：
 * 长 query string、`data:` / `blob:` URL 都能到几十甚至几百 KB。500 条 × 几百 KB
 * 就是几十上百 MB 的常驻 —— 而 {@link NETWORK_LIST_MAX_CHARS} 那道闸门管的是
 * **输出给模型的量**，管不了内存在存多少。所以存储侧再加一道字节预算。
 *
 * 2M 字符（≈2MB）的选法：常态下 500 条 × 平均几百字节不过几十 KB，永远碰不到这条线，
 * 也就是说它**只**在真的遇到超长 URL 时才生效，不会改变正常页面的行为。
 */
export const NETWORK_TABLE_MAX_URL_CHARS = 2_000_000

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
  /** 采集到这条时该标签页处于第几个文档（0 起；导航一次 +1）。 */
  readonly document: number
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
  /** 缺省时由 {@link NetworkCollector} 填成「当前文档」。 */
  document?: number
}

/** {@link NetworkCollector.list} 的结果。 */
export interface NetworkListResult {
  readonly requests: readonly NetworkEntry[]
  /** 当前文档序号（0 起）。 */
  readonly document: number
  /** 表里属于更早文档、**没被列出**的条目数（`allDocuments: true` 时恒为 0 —— 都列出来了）。 */
  readonly earlierDocuments: number
  /** 匹配的条目多于返回的（被 `limit` 或总量预算截断；两者都算「还有更多」）。 */
  readonly truncated: boolean
  /**
   * 是否**被总量预算**（{@link NETWORK_LIST_MAX_CHARS}）截断，而不是被 `limit` 截断。
   *
   * 两者要分开报：被 `limit` 截断时「调大 limit」有用，被预算截断时**调大 limit 没用**，
   * 得换 `url` 过滤。给错建议比不给更糟。
   */
  readonly truncatedByBudget: boolean
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
  /** 表里所有 URL 的字符总数；{@link NETWORK_TABLE_MAX_URL_CHARS} 的计数器。 */
  private urlChars = 0
  private readonly unsubscribes: (() => void)[] = []
  /** 当前文档序号（0 起）；provider 每次观察到导航就 +1。 */
  private document = 0
  /**
   * 尚未 `loadingFinished` / `loadingFailed` 的请求 id。
   * `until: 'stable'` 用它当「网络是否安静」：inflight === 0 才算 quiet。
   */
  private readonly inflightIds = new Set<string>()

  /**
   * @param connection - 该会话的 CDP 连接；构造时立即订阅请求生命周期事件。
   */
  constructor(connection: CdpConnection) {
    this.connection = connection
    this.unsubscribes.push(connection.on('Network.requestWillBeSent', params => this.onRequest(params)))
    this.unsubscribes.push(connection.on('Network.responseReceived', params => this.onResponse(params)))
    this.unsubscribes.push(connection.on('Network.loadingFinished', params => this.onFinished(params)))
    this.unsubscribes.push(connection.on('Network.loadingFailed', params => this.onFailed(params)))
  }

  /** 当前未完成的请求数（SSE 在连接关闭前会一直占 1）。 */
  get inflight(): number {
    return this.inflightIds.size
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

  /** 当前文档序号（0 起）。 */
  get currentDocument(): number {
    return this.document
  }

  /**
   * 通报「标签页换文档了」：此后到达的事件归入新文档，`list` 默认不再返回旧文档的请求。
   *
   * 记录**不**删除（`allDocuments` 仍可列、`body` 仍可按 requestId 取），只是默认过滤。
   * 已经在表里的记录保留各自原有的文档序号 —— 请求属于它发起时所在的那个文档。
   */
  noteNavigation(): void {
    this.document += 1
  }

  /**
   * 列出请求（从最新往回，最多 `limit` 条，且 URL 总量不超过 {@link NETWORK_LIST_MAX_CHARS}）。
   *
   * 两道闸门分别记在 `truncated` / `truncatedByBudget` 上：前者调大 `limit` 有用，
   * 后者调大没用、只能靠 `url` 过滤。
   *
   * @param limit - 数量上限。
   * @param urlFilter - 只保留 URL 包含该子串的条目（大小写不敏感）。
   * @param allDocuments - 连更早文档的请求一起返回。默认 false：只给当前文档的。
   */
  list(limit: number, urlFilter?: string | undefined, allDocuments = false): NetworkListResult {
    const needle = urlFilter?.toLowerCase()
    const requests: NetworkEntry[] = []
    let earlierDocuments = 0
    let chars = 0
    let truncated = false
    let truncatedByBudget = false
    const values = [...this.requests.values()]
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const entry = values[index]
      if (entry === undefined) continue
      if (entry.document !== this.document && !allDocuments) {
        // 只在真的被遮住时计数：`allDocuments` 时它们会被列出来，报「隐藏了 N 条」是假话。
        earlierDocuments += 1
        continue
      }
      if (needle !== undefined && !entry.url.toLowerCase().includes(needle)) continue
      // 走到这里说明本条**是匹配的**，所以任何一次 break 都意味着「还有更多没返回」。
      // `limit` 优先判定；总量闸门第一条必进（否则模型拿不到任何线索）。
      if (requests.length >= limit) {
        truncated = true
        break
      }
      if (requests.length > 0 && chars >= NETWORK_LIST_MAX_CHARS) {
        truncated = true
        truncatedByBudget = true
        break
      }
      requests.push(entry)
      chars += entry.url.length
    }
    return { requests, document: this.document, earlierDocuments, truncated, truncatedByBudget }
  }

  /** 取一条记录（诊断用）。 */
  get(requestId: string): NetworkEntry | undefined {
    return this.requests.get(requestId)
  }

  /**
   * 取响应体。直接用收到的事件里的 `requestId`（`[V18]`，不需要任何映射）。
   *
   * 上限**按编码分流**：文本 2 万字符，二进制（base64）只有 2 千 —— 后者模型解不出来，
   * 给再多也是烧上下文（见 {@link NETWORK_MAX_BASE64_CHARS}）。
   *
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
    const cap = base64Encoded ? NETWORK_MAX_BASE64_CHARS : NETWORK_MAX_BODY_CHARS
    if (body.length <= cap) return { body, base64Encoded, truncated: false }
    return {
      body: `${body.slice(0, cap)}\n…[truncated ${body.length - cap} chars]`,
      base64Encoded,
      truncated: true,
    }
  }

  /** 退订事件；会话关闭时调用。 */
  dispose(): void {
    for (const off of this.unsubscribes) off()
    this.unsubscribes.length = 0
  }

  /** 淘汰最旧的一条，并同步维护字节计数器。 */
  private evictOldest(): void {
    const oldest = this.requests.keys().next().value
    if (oldest === undefined) return
    const dropped = this.requests.get(oldest)
    if (dropped !== undefined) this.urlChars -= dropped.url.length
    this.requests.delete(oldest)
  }

  /**
   * 写一条记录并维持两道上界：条数 {@link NETWORK_TABLE_CAPACITY} 与
   * URL 字符总数 {@link NETWORK_TABLE_MAX_URL_CHARS}（最旧的先出）。
   */
  private put(entry: MutableEntry): void {
    // 没带文档序号的是「新到达」的事件（带序号的是更新已有记录），归入当前文档。
    const stored = { ...entry, document: entry.document ?? this.document }
    // 更新已有记录时先扣掉旧 URL 的长度，否则计数器只增不减。
    const previous = this.requests.get(entry.requestId)
    if (previous !== undefined) this.urlChars -= previous.url.length
    this.requests.set(entry.requestId, stored)
    this.urlChars += stored.url.length

    while (this.requests.size > NETWORK_TABLE_CAPACITY) this.evictOldest()
    // `size > 1` 是循环能停下的**条件**，不是「至少留一条」的副作用：单条 URL 本身就
    // 超过预算时，删无可删只能认了 —— 一条超长记录也好过一张空表（空表连「有什么请求」
    // 都答不上来）。
    while (this.urlChars > NETWORK_TABLE_MAX_URL_CHARS && this.requests.size > 1) this.evictOldest()
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
    this.inflightIds.add(requestId)
  }

  /** `loadingFinished`：请求结束，inflight −1。 */
  private onFinished(params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    const requestId = readString(params as Record<string, unknown>, 'requestId')
    if (requestId === undefined) return
    this.inflightIds.delete(requestId)
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
    this.inflightIds.delete(requestId)
  }
}
