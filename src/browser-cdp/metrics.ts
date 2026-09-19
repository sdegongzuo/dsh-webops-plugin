/**
 * P0 · 事故分布自计（方案 §4，D-7=B）。
 *
 * **只为测量而写的生产代码**：`BROWSER_STALE_REF` 命中多少次、分别是被哪道门拒的。
 * 目的是给 P1/P2 的优先级一个数字依据，而不是继续用推理排期。
 *
 * ## 三条纪律
 *
 * 1. **不开就是 no-op**：只有设了 `DSH_BROWSER_PLUGIN_METRICS=<目录>` 才计数与落盘。
 *    正常运行（没设环境变量）时零文件 IO、零额外分配 —— 复用一个冻结的空实现。
 *    不复用 `DSH_BROWSER_PLUGIN_DEBUG`：那个的语义是「往 stdout 打一行」，与「按会话累积计数」不是一件事。
 * 2. **绝不打断浏览器流程**：计数与落盘全走 try/catch 吞掉。测量代码把被测流程弄挂是最坏的一种副作用。
 * 3. **测完就删**：本模块连同所有调用点一起，在 §4 的结论写进方案文档后删除（见该节「退出条件」）。
 *    留着必须在该节标注「它还活着、为什么」。
 *
 * ## 落盘形态
 *
 * 每会话一份 `<目录>/<sessionId>.jsonl`，**追加**一行 JSON。一行就是一份快照：
 * `refCalls` 是分母（这个会话收到过多少次吃 ref 或可能吃 ref 的调用），
 * `stale` 是按 {@link BrowserStaleRefReason} 分桶的命中数。崩溃丢最后几行不影响「分布」结论。
 *
 * @module dsh-webops-plugin/browser-cdp/metrics
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserStaleRefReason } from '../browser/types.ts'

/** 打开计数落盘的环境变量名；值是**目录**。 */
export const METRICS_ENV = 'DSH_BROWSER_PLUGIN_METRICS'

/** 一个会话的计数。 */
interface SessionCounter {
  /** 该会话收到过多少次吃 ref 的调用（`mutate` / `locate` / `revalidate`）—— 命中率的分母。 */
  refCalls: number
  /** 按门分桶的 `BROWSER_STALE_REF` 命中数。 */
  stale: Map<BrowserStaleRefReason, number>
}

/** 落盘的一行。字段名即语义，不做缩写 —— 它是给人读的，不是给机器喂的。 */
export interface StaleRefMetricsRecord {
  /** ISO 8601 时刻。 */
  readonly at: string
  readonly sessionId: string
  /** 分母：这个会话收到过多少次吃 ref 的调用。 */
  readonly refCalls: number
  /** 分桶命中数；没命中过的桶不出现。 */
  readonly stale: Record<string, number>
  /** 命中总数，省得读的人自己加。 */
  readonly staleTotal: number
  /**
   * 写这一行时的 ref 纪元。
   *
   * ⚠ 这个字段**必须在这里声明**：它是靠对象展开（`...epoch === undefined ? {} : { epoch }`）
   * 挂上去的，而 TS 不对展开做 excess-property 检查 —— 不声明时 tsc 全绿，但写出来的
   * JSON 里就是有它，读的人从类型里看不出来。类型要么反映行为，要么就是谎话。
   */
  readonly epoch?: number
}

/**
 * 计数器。未启用时所有方法立即返回，**不分配、不写盘**。
 *
 * 生命周期跟着 provider：`note*` 随时可调，`flush` 在会话关闭 / `dispose` 时调。
 */
export class StaleRefMetrics {
  private readonly directory: string | undefined
  private readonly sessions = new Map<string, SessionCounter>()

  /**
   * @param directory - 落盘目录；缺省读 `DSH_BROWSER_PLUGIN_METRICS`，为空即停用。
   */
  constructor(directory: string | undefined = process.env[METRICS_ENV]) {
    this.directory = directory === undefined || directory === '' ? undefined : directory
  }

  /**
   * 是否在计数。给自检与用例用：不开的时候「没写文件」才是可断言的。
   *
   * ⚠ **必须由 `directory` 推导，不能另存一个 `enabled` 布尔** —— 曾经那样写过，
   * 结果是构造里填 `true`、开关实际没接上，于是 `active` 恒真：三条「默认关」的判据
   * 全成了装饰（断言恒为真，而不是断言真在 no-op）。单一真相，不给它走样的机会。
   */
  get active(): boolean {
    return this.directory !== undefined
  }

  /** 记一次「吃 ref 的调用」，用来当命中率的分母。 */
  noteRefCall(sessionId: string): void {
    if (this.directory === undefined) return
    this.counter(sessionId).refCalls += 1
  }

  /**
   * 记一次 `BROWSER_STALE_REF` 命中。
   * @param sessionId - 哪个会话拒的（跨会话共用同一标签时才看得出区别）。
   * @param reason - 哪道门拒的，与抛出的 `BrowserError.reason` 是同一个值。
   */
  noteStale(sessionId: string, reason: BrowserStaleRefReason): void {
    if (this.directory === undefined) return
    const counter = this.counter(sessionId)
    counter.stale.set(reason, (counter.stale.get(reason) ?? 0) + 1)
  }

  /**
   * 把某个会话的计数追加一行到它的 JSONL。
   *
   * @param sessionId - 会话 id，也是文件名。
   * @param epoch - 顺带记一笔当时的 ref 纪元，便于对照「这一行是连着几次作废之后写的」。
   * @returns 写出的那一行；未启用时为 `undefined`。
   */
  async flush(sessionId: string, epoch?: number): Promise<StaleRefMetricsRecord | undefined> {
    const directory = this.directory
    if (directory === undefined) return undefined
    const counter = this.sessions.get(sessionId)
    if (counter === undefined) return undefined
    const stale = Object.fromEntries(counter.stale)
    const record: StaleRefMetricsRecord = {
      at: new Date().toISOString(),
      sessionId,
      refCalls: counter.refCalls,
      stale,
      staleTotal: [...counter.stale.values()].reduce((sum, value) => sum + value, 0),
      ...epoch === undefined ? {} : { epoch },
    }
    try {
      await mkdir(directory, { recursive: true })
      await appendFile(join(directory, `${safeFileName(sessionId)}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // 纪律 2：测量代码不许打断浏览器流程 —— 落盘失败只当这一行没写。
      return undefined
    }
    return record
  }

  /** 取一个会话的计数器，没有就建。 */
  private counter(sessionId: string): SessionCounter {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionCounter = { refCalls: 0, stale: new Map() }
    this.sessions.set(sessionId, created)
    return created
  }
}

/** 会话 id 直接来自 CDP 的 targetId（十六进制），但仍要防它带上路径分隔符。 */
function safeFileName(sessionId: string): string {
  return sessionId.replaceAll(/[^A-Za-z0-9._-]/g, '_')
}
