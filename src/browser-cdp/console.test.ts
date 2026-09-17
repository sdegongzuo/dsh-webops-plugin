import { describe, expect, it } from 'vitest'
import {
  CONSOLE_RESULT_MAX_CHARS,
  CONSOLE_RING_CAPACITY,
  CONSOLE_TEXT_MAX_CHARS,
  ConsoleCollector,
  normalizeTimestamp,
} from './console.ts'
import { CdpConnection } from './protocol.ts'
import type { CdpSocket } from './protocol.ts'

/**
 * 记录命令、可注入 CDP 事件的假 socket：所有命令都以空 result 回复。
 * `refresh()` 发出的 `Runtime.enable` / `Log.enable` 依赖这个回复路径才能 resolve。
 */
class EventSocket implements CdpSocket {
  closed = false
  readonly methods: string[] = []
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>()

  send(data: string): void {
    const request = JSON.parse(data) as { id: number; method: string }
    this.methods.push(request.method)
    queueMicrotask(() => {
      this.dispatch('message', { data: JSON.stringify({ id: request.id, result: {} }) })
    })
  }

  close(): void {
    this.closed = true
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(listener)
    this.handlers.set(type, list)
  }

  /** 注入一条 CDP 事件（与真实 WebSocket 的 `{ method, params }` 帧同形）。 */
  emit(method: string, params: unknown): void {
    this.dispatch('message', { data: JSON.stringify({ method, params }) })
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...this.handlers.get(type) ?? []]) listener(event)
  }
}

/** 造一条 `Runtime.consoleAPICalled` 参数。timestamp 按量级归一，测试里给哪种口径都行。 */
function rtParams(timestampMicros: number, text: string, type = 'log', contextId = 1): Record<string, unknown> {
  return {
    type,
    timestamp: timestampMicros,
    executionContextId: contextId,
    args: [{ type: 'string', value: text }],
  }
}

/** 造一条 `Log.entryAdded` 参数。timestamp 按量级归一（截断提示恒为 0）。 */
function logParams(timestamp: number, text: string, source = 'javascript', level = 'error'): Record<string, unknown> {
  return { entry: { source, level, text, timestamp } }
}

/** 一次 refresh + 紧随其后的重放：`[V13]` 里「每次 enable 都全量重放」的最小模拟。 */
async function enableAndReplay(socket: EventSocket, collector: ConsoleCollector, replay: () => void): Promise<void> {
  await collector.refresh({ timeoutMs: 100 })
  replay()
}

describe('ConsoleCollector', () => {
  it('survives three enable/replay rounds with exactly four distinct entries ([V13])', async () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    // 实时收到 M1、M2（微秒时间戳，同桶内严格递增）。
    socket.emit('Runtime.consoleAPICalled', rtParams(1000_500, 'M1'))
    socket.emit('Runtime.consoleAPICalled', rtParams(1000_700, 'M2'))

    // 第一次 enable → 全量重放 M1M2；随后实时来 M3。
    await enableAndReplay(socket, collector, () => {
      socket.emit('Runtime.consoleAPICalled', rtParams(1000_500, 'M1'))
      socket.emit('Runtime.consoleAPICalled', rtParams(1000_700, 'M2'))
    })
    socket.emit('Runtime.consoleAPICalled', rtParams(1000_900, 'M3'))

    // 第二次 enable → 重放 M1M2M3；随后实时来 M4。
    await enableAndReplay(socket, collector, () => {
      socket.emit('Runtime.consoleAPICalled', rtParams(1000_500, 'M1'))
      socket.emit('Runtime.consoleAPICalled', rtParams(1000_700, 'M2'))
      socket.emit('Runtime.consoleAPICalled', rtParams(1000_900, 'M3'))
    })
    socket.emit('Runtime.consoleAPICalled', rtParams(1001_200, 'M4'))

    // 第三次 enable → 重放 M1M2M3M4。
    await enableAndReplay(socket, collector, () => {
      socket.emit('Runtime.consoleAPICalled', rtParams(1000_500, 'M1'))
      socket.emit('Runtime.consoleAPICalled', rtParams(1000_700, 'M2'))
      socket.emit('Runtime.consoleAPICalled', rtParams(1000_900, 'M3'))
      socket.emit('Runtime.consoleAPICalled', rtParams(1001_200, 'M4'))
    })

    const result = collector.read({ limit: 50 })
    // read 从最新往回返回。
    expect(result.entries.map(entry => entry.text)).toEqual(['M4', 'M3', 'M2', 'M1'])
    expect(result.buffered).toBe(4)
    expect(result.truncated).toBe(false)
  })

  it('dedupes a 1000-entry replay after 1500 realtime entries ([V24]) without any duplication', async () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    for (let index = 1; index <= 1500; index += 1) {
      socket.emit('Runtime.consoleAPICalled', rtParams(index * 1000 + 7, `msg-${index}`))
    }

    // re-enable 后重放只回最新的 1000 条（msg-501 .. msg-1500），全部应被高水位吃掉。
    await enableAndReplay(socket, collector, () => {
      for (let index = 501; index <= 1500; index += 1) {
        socket.emit('Runtime.consoleAPICalled', rtParams(index * 1000 + 7, `msg-${index}`))
      }
    })

    const result = collector.read({ limit: 2000 })
    expect(result.buffered).toBe(1000)
    expect(result.entries.map(entry => entry.text)).toEqual(
      Array.from({ length: 1000 }, (_, offset) => `msg-${1500 - offset}`),
    )
    expect(new Set(result.entries.map(entry => entry.text)).size).toBe(1000)
  })

  it('clips the ring buffer to its capacity, dropping the oldest entries first', () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    for (let index = 1; index <= CONSOLE_RING_CAPACITY + 5; index += 1) {
      socket.emit('Runtime.consoleAPICalled', rtParams(index * 1000 + 7, `msg-${index}`))
    }

    expect(collector.buffered).toBe(CONSOLE_RING_CAPACITY)
    const oldest = collector.read({ limit: CONSOLE_RING_CAPACITY }).entries.at(-1)
    const newest = collector.read({ limit: 1 }).entries[0]
    expect(oldest?.text).toBe('msg-6')
    expect(newest?.text).toBe(`msg-${CONSOLE_RING_CAPACITY + 5}`)
  })

  it('lets the [V39] truncation notice (timestamp=0) through the watermark exactly once', () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    socket.emit('Log.entryAdded', logParams(5000, 'boom'))
    // 提示条目 timestamp 恒为 0；重复 enable 会重复投递，必须只入账一次。
    socket.emit('Log.entryAdded', logParams(0, '2010 log entries are not shown.', 'other', 'info'))
    socket.emit('Log.entryAdded', logParams(0, '2010 log entries are not shown.', 'other', 'info'))
    // 提示之后的新条目照常入账 —— 高水位没有被 timestamp=0 拉低。
    socket.emit('Log.entryAdded', logParams(6000, 'after'))

    expect(collector.truncatedReplay).toBe(true)
    const texts = collector.read({ limit: 50 }).entries.map(entry => entry.text)
    expect(texts).toEqual(['after', '2010 log entries are not shown.', 'boom'])
    expect(texts.filter(text => text.includes('log entries are not shown'))).toHaveLength(1)
  })

  it('survives a detach/re-enable round after 3000 log entries: no duplicates, notice kept, buckets apart', async () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    // detach 前：3000 条 Log（同一个 source 桶）+ 一条 timestamp=0 的截断提示，
    // 再掺一条 Runtime 条目（两域分桶，串了桶就会比错）。
    for (let index = 1; index <= 3000; index += 1) {
      socket.emit('Log.entryAdded', logParams(index * 10, `log-${index}`))
    }
    socket.emit('Log.entryAdded', logParams(0, '2990 log entries are not shown.', 'other', 'info'))
    socket.emit('Runtime.consoleAPICalled', rtParams(30_000_000, 'from-runtime'))
    const before = collector.buffered

    // re-attach → refresh 重放：CDP 只回最新的那些，外加那条提示。
    await enableAndReplay(socket, collector, () => {
      for (let index = 2001; index <= 3000; index += 1) {
        socket.emit('Log.entryAdded', logParams(index * 10, `log-${index}`))
      }
      socket.emit('Log.entryAdded', logParams(0, '2990 log entries are not shown.', 'other', 'info'))
    })

    const result = collector.read({ limit: CONSOLE_RING_CAPACITY + 50 })
    // ① 上限截断没有变成重复：重放全被高水位吃掉，条数一涨都没涨。
    expect(result.buffered).toBe(before)
    expect(new Set(result.entries.map(entry => entry.text)).size).toBe(result.entries.length)
    // ② timestamp=0 的截断提示没有被高水位吃掉，也没因为重复投递变成两条。
    expect(result.entries.filter(entry => entry.text.includes('log entries are not shown'))).toHaveLength(1)
    // ③ Runtime 与 Log 各按自己的桶去重：Runtime 那条没被 Log 的高水位带走。
    expect(result.entries.some(entry => entry.text === 'from-runtime')).toBe(true)
  })

  it('keeps per-domain buckets independent: identical timestamps in different domains both survive', () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    // 两域即使给了不同单位的同一瞬间（Runtime 微秒、Log 毫秒），也要各自存活且落到同一把尺子上。
    socket.emit('Runtime.consoleAPICalled', rtParams(1789289442861_960, 'from-runtime'))
    socket.emit('Log.entryAdded', logParams(1789289442861.96, 'from-log'))

    const entries = collector.read({ limit: 50 }).entries
    expect(entries.map(entry => entry.text).sort()).toEqual(['from-log', 'from-runtime'])
    expect(entries.map(entry => entry.source).sort()).toEqual(['log', 'runtime'])
    expect(Math.abs((entries[0]?.timestamp ?? 0) - (entries[1]?.timestamp ?? 0))).toBeLessThan(1)
  })

  it('drops the second of two same-bucket entries with an identical timestamp (documented side effect)', () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    socket.emit('Runtime.consoleAPICalled', rtParams(1000_500, 'first'))
    socket.emit('Runtime.consoleAPICalled', rtParams(1000_500, 'second'))

    expect(collector.read({ limit: 50 }).entries.map(entry => entry.text)).toEqual(['first'])
  })

  it('reads newest first and applies level and case-insensitive text filters', () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    socket.emit('Runtime.consoleAPICalled', rtParams(1000, 'Cache miss', 'log'))
    socket.emit('Runtime.consoleAPICalled', rtParams(2000, 'Failed to load', 'error'))
    socket.emit('Runtime.consoleAPICalled', rtParams(3000, 'Another error', 'error'))
    socket.emit('Log.entryAdded', logParams(4000, 'network hiccup', 'network', 'warning'))

    expect(collector.read({ limit: 2 }).entries.map(entry => entry.text)).toEqual(['network hiccup', 'Another error'])
    expect(collector.read({ limit: 50, level: 'ERROR' }).entries.map(entry => entry.text))
      .toEqual(['Another error', 'Failed to load'])
    expect(collector.read({ limit: 50, text: 'CACHE' }).entries.map(entry => entry.text)).toEqual(['Cache miss'])
    expect(collector.read({ limit: 50, text: 'nomatch' }).entries).toEqual([])
  })

  it('separates a limit cut from the text size budget — only one of them is fixed by a bigger limit', () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    // 每条恰好顶到单条上限（2000 字符，不会被 clip 加长），且文本互不相同（去重键含 text）。
    for (let index = 0; index < 25; index += 1) {
      const text = `${String(index).padStart(4, '0')}${'x'.repeat(CONSOLE_TEXT_MAX_CHARS - 4)}`
      socket.emit('Runtime.consoleAPICalled', rtParams(1000 + index * 10, text, 'log', 1))
    }

    // 闸门是在「push 之前」判 `>=`，所以放行条数 = ceil(预算 / 每行)。
    // limit 给到 50 也没用 —— 这正是要如实报出来的事。
    const fitsByBudget = Math.ceil(CONSOLE_RESULT_MAX_CHARS / CONSOLE_TEXT_MAX_CHARS)
    const budgeted = collector.read({ limit: 50 })
    expect(budgeted.entries).toHaveLength(fitsByBudget)
    expect(budgeted.truncated).toBe(true)
    expect(budgeted.truncatedByBudget).toBe(true)

    // 小 limit 时是条数截断：调大 limit 有用，两个标志必须分得开。
    const byLimit = collector.read({ limit: 3 })
    expect(byLimit.entries).toHaveLength(3)
    expect(byLimit.truncated).toBe(true)
    expect(byLimit.truncatedByBudget).toBe(false)

    // 预算够用时一个字都不能多报（否则工具层会给出「调大 limit 没用」的假建议）。
    expect(collector.read({ limit: 50, level: 'nomatch' }))
      .toMatchObject({ truncated: false, truncatedByBudget: false })
  })

  it('sends Runtime.enable before Log.enable on every refresh and never disables anything', async () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    await collector.refresh({ timeoutMs: 100 })
    await collector.refresh({ timeoutMs: 100 })

    expect(socket.methods.filter(method => method === 'Runtime.enable')).toHaveLength(2)
    expect(socket.methods.filter(method => method === 'Log.enable')).toHaveLength(2)
    expect(socket.methods.some(method => method.includes('disable'))).toBe(false)
  })

  it('hides earlier-document entries by default and reports how many are hidden (2026-09-14)', () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    socket.emit('Runtime.consoleAPICalled', rtParams(1000_500, 'from-wikipedia'))
    socket.emit('Log.entryAdded', logParams(1000_900, 'also-wikipedia'))
    collector.noteNavigation()
    socket.emit('Runtime.consoleAPICalled', rtParams(2000_500, 'from-httpbin'))

    const current = collector.read({ limit: 50 })
    expect(current.document).toBe(1)
    expect(current.entries.map(entry => entry.text)).toEqual(['from-httpbin'])
    expect(current.earlierDocuments).toBe(2)
    // 缓冲没有被清空：allDocuments 读得回来（这是「过滤」不是「丢弃」）。
    expect(current.buffered).toBe(3)
    expect(collector.read({ limit: 50, allDocuments: true }).entries.map(entry => entry.text))
      .toEqual(['from-httpbin', 'also-wikipedia', 'from-wikipedia'])
  })

  it('lets the [V39] truncation notice through once per document, not once per session', () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    socket.emit('Log.entryAdded', logParams(0, '2010 log entries are not shown.', 'other', 'info'))
    socket.emit('Log.entryAdded', logParams(0, '2010 log entries are not shown.', 'other', 'info'))
    expect(collector.read({ limit: 50 }).entries).toHaveLength(1)

    // 换文档后必须再报一次：新文档的缺失是**新的**缺失，被上一份的去重键吃掉就是不报。
    collector.noteNavigation()
    socket.emit('Log.entryAdded', logParams(0, '2010 log entries are not shown.', 'other', 'info'))
    expect(collector.read({ limit: 50 }).entries).toHaveLength(1)
    expect(collector.read({ limit: 50, allDocuments: true }).entries).toHaveLength(2)
  })
})

describe('normalizeTimestamp', () => {
  it('puts the Runtime and Log domains on the same millisecond scale whatever unit they use', () => {
    // 同一个瞬间，三种口径：秒（Log 的旧口径）、毫秒（两域当前口径）、微秒（Runtime 的旧口径）。
    const epochMs = 1_789_316_204_273
    for (const raw of [epochMs / 1000, epochMs, epochMs * 1000]) {
      expect(normalizeTimestamp(raw)).toBeCloseTo(epochMs, 0)
    }
  })

  it('leaves the [V39] notice sentinel (0) and non-positive values untouched', () => {
    expect(normalizeTimestamp(0)).toBe(0)
    expect(normalizeTimestamp(-1)).toBe(-1)
  })

  it('keeps two domains comparable inside one read (the bug the report found)', () => {
    const socket = new EventSocket()
    const collector = new ConsoleCollector(new CdpConnection(socket))

    // 报告 S5 的原样数据：Runtime 给毫秒、Log 给毫秒。旧实现把 Runtime 又除以 1000，
    // 于是同一瞬间的两条差 1000 倍。
    socket.emit('Runtime.consoleAPICalled', rtParams(1_789_316_252_000, 'dsh-probe-s5'))
    socket.emit('Log.entryAdded', logParams(1_789_316_204_273, 'dsh-probe-warn'))

    const [log, runtime] = collector.read({ limit: 50 }).entries
    expect(runtime?.source).toBe('runtime')
    expect(runtime?.timestamp).toBe(1_789_316_252_000)
    expect(log?.source).toBe('log')
    expect(log?.timestamp).toBe(1_789_316_204_273)
    // 旧实现里 Runtime 被多除了一次 1000，两条会差 1000 倍（约 10^9 ms ≈ 12 天）。
    const gapMs = Math.abs((runtime?.timestamp ?? 0) - (log?.timestamp ?? 0))
    expect(gapMs).toBeLessThan(120_000)
  })
})
