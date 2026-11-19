/**
 * 网页访问审计：把会话日志里的 `webpage_*` 调用抽出来，生成一份**可打开查看的 HTML**。
 *
 * ## 为什么要有它
 *
 * 标签关掉之后「agent 到底看过哪些页面」就只剩会话日志一处证据：
 * `home/sessions/<工作区>/session-<id>/session.v*.jsonl.zstd` 里按 `tool/call`（参数）与
 * `tool/result`（回执）成对记录，`callId` 与 `toolCallId` 一一对应。日志是权威的、跨重启
 * 保留的，也是**未读窗口之外的调用唯一还在的地方** —— 客户端面板只能看到已加载的窗口
 * （`DEFAULT_MAX_MESSAGES = 50`），长会话翻页或压缩之后会静默变少。
 *
 * ## 两个口径必须分开（不许混用）
 *
 * - **确认访问**：成功回执头部自报的地址（`https://…\ntitle: …\nsession_id=…`）。这是
 *   「真的到了那个文档」。解析直接复用客户端面板的 `observedPage`，两边不各写一套。
 * - **目标地址**：失败或未落地的调用，参数里写的是 `url`。那是「想去的地址」，**不是**
 *   「去过的地址」，导航失败时页面根本没换。HTML 里两种来源分列标注。
 *
 * 失败项的 URL 因此单独标记为 `target`，绝不与确认访问合并计数。
 *
 * ## 帧格式
 *
 * 会话文件是**拼接的多帧** zstd，`node:zlib` 的 `zstdDecompressSync` 只解第一帧，
 * 所以要按帧结构扫描后逐帧解压。扫描逻辑与宿主的
 * `session-persistence-jsonl/src/zstd.ts`（`scanZstdFrames`）同一套规则：魔数、
 * frame header descriptor、block header、可选 checksum。本仓不依赖那个包，
 * 所以这里独立实现一份；两边不一致时以会话文件的实际字节为准。
 *
 * 用法：
 *
 * ```bash
 * pnpm audit:webpage                                   # 探测本机 home
 * pnpm audit:webpage -- --home D:/dsh-build/portable-test/home
 * pnpm audit:webpage -- --sessions <dir> --out report.html
 * pnpm audit:webpage -- --session <session-id>          # 只审一个对话
 * ```
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { constants, zstdDecompressSync } from 'node:zlib'
import { observedPage, parseBrowserUrl, type BrowserCall } from '../src/client/observation.ts'

/** zstd 帧魔数（小端读出的 `0xFD2FB528`）。 */
const ZSTD_MAGIC = 0xfd2fb528

/** 本插件认领的工具名前缀；与客户端面板同一判据。 */
const TOOL_PREFIX = 'webpage_'

/** 一次调用的时间与标题都缺失时，HTML 里显示这个。 */
const UNKNOWN = '—'

/** 一个结构完整的 zstd 帧在源缓冲区里的字节区间。 */
export interface ZstdFrame {
  readonly start: number
  /** 开区间：帧结束后第一个字节。 */
  readonly end: number
}

/** 扫描结果；`tornStart` 表示末尾有一帧被写断（进程崩溃的现场）。 */
export interface ZstdScan {
  readonly frames: readonly ZstdFrame[]
  readonly tornStart?: number
}

/**
 * 按帧结构定位所有完整帧，**不解压**。
 *
 * 规则与宿主扫描器一致：魔数 → frame header descriptor → 逐 block 跳过 →
 * 可选 4 字节 checksum。遇到保留位或保留 block 类型按损坏处理并抛出，交给调用方
 * 记成「这个文件读不了」，而不是静默跳过。
 * @param buffer - 文件全部字节。
 * @returns 完整帧区间；末帧被截断时附带它的起点。
 */
export function scanZstdFrames(buffer: Buffer): ZstdScan {
  const frames: ZstdFrame[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${String(offset)}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved frame-header bit at byte ${String(offset - 1)}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    // 单段帧没有 window descriptor，但 content size 字段长度为 0 时仍占 1 字节。
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const headerRest = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < headerRest) return { frames, tornStart: start }
    offset += headerRest

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`reserved block type at byte ${String(offset - 3)}`)
      }
      // RLE block 的载荷只有一个字节，blockSize 是「解压后长度」。
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      // 与宿主扫描器同一判据：先减出剩余字节再比，避免 `buffer.length < offset` 这种
      // 「先加后比」的写法在 offset 越界后仍被读一次（虽然立即返回，但判据依赖减法更直白）。
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 一个会话文件解码后的结果。 */
export interface DecodedLog {
  /** 按文件顺序解码出的 JSONL 行（空行已去掉）。 */
  readonly lines: readonly string[]
  readonly frames: number
  /** 末帧被写断（崩溃现场）；已解出的完整帧仍然可用。 */
  readonly torn: boolean
}

/**
 * 逐帧解压一个会话文件。
 *
 * 单帧解压失败不丢弃整个文件：把它记成该帧的错误并继续 — 审计宁可少几行，
 * 也不该因为一帧坏了就回答「没访问过任何页面」。
 * @param buffer - 文件全部字节。
 * @returns 解码出的文本行与帧统计。
 */
export function decodeSessionLog(buffer: Buffer): DecodedLog {
  const scan = scanZstdFrames(buffer)
  const parts: Buffer[] = []
  for (const frame of scan.frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
    } catch {
      // 结构完整但校验失败（或解码器不支持）：跳过这一帧，其余照常。
      continue
    }
  }
  if (scan.tornStart !== undefined) {
    // 崩溃被写断的末帧并不等于「一行都没有」：写入方每批都 flush，断点前通常还留着
    // 成千上万条完整行。实测 570KB 的截断帧救回 3.3MB / 19956 行完整 JSON，所以这里
    // 用 ZSTD_e_flush 解出前缀，而不是把它整个丢掉。
    try {
      const prefix = zstdDecompressSync(buffer.subarray(scan.tornStart), { finishFlush: constants.ZSTD_e_flush })
      const text = prefix.toString('utf8')
      // 末行一定是被切断的半行（没有结尾换行），必须丢掉：半截 JSON 永远解析不出来，
      // 留在 lines 里只会变成一条「坏行」噪音。
      const end = text.lastIndexOf('\n')
      if (end !== -1) parts.push(Buffer.from(text.slice(0, end + 1), 'utf8'))
    } catch {
      // 前缀也解不出来（例如帧头损坏）：退回「只审计完整帧」，与修复前行为一致。
    }
  }
  const text = Buffer.concat(parts).toString('utf8')
  return {
    lines: text.split('\n').filter(line => line.trim() !== ''),
    frames: scan.frames.length,
    torn: scan.tornStart !== undefined,
  }
}

/** 会话日志里一条事件的最小形状（只取审计要用的字段）。 */
interface SessionEvent {
  readonly type?: unknown
  readonly time?: unknown
  readonly data?: unknown
}

/** 一次 `webpage_*` 调用的审计记录。 */
export interface AuditCall {
  /** 在该会话内的调用顺序（0 起）。 */
  readonly index: number
  /** `tool/call` 的毫秒时间戳。 */
  readonly time: number | undefined
  readonly tool: string
  /** 日志里找到了这次调用的回执（`tool/result`）。未结算 = 日志在回执前就结束了。 */
  readonly settled: boolean
  /** 已结算且 `isError` 为假。 */
  readonly ok: boolean
  /** 成功回执头部自报的地址；失败或未结算时为 `undefined`。 */
  readonly url: string | undefined
  readonly title: string | undefined
  /** 参数里的 `url`：那是**目标**地址，不等于访问过。 */
  readonly targetUrl: string | undefined
  /** 失败回执的首行错误摘要。 */
  readonly error: string | undefined
}

/** 一个会话文件的审计结果。 */
export interface SessionAudit {
  readonly sessionId: string
  readonly file: string
  readonly cwd: string | undefined
  readonly calls: readonly AuditCall[]
  readonly frames: number
  readonly torn: boolean
  /** 读不了 / 解不开时的原因；此时 `calls` 为空。 */
  readonly error?: string
}

/** 审计报告：多个会话聚合。 */
export interface AuditReport {
  readonly generatedAt: string
  readonly sessions: readonly SessionAudit[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 结果正文：把 `content` 里的 text 块拼起来，与客户端面板同一口径。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const block = asRecord(part)
    if (block === undefined || block['type'] !== 'text') continue
    const text = asString(block['text'])
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/** 失败回执的首行摘要；越短越好，完整正文留在原始日志里。 */
function errorSummary(text: string): string | undefined {
  const first = (text.split('\n')[0] ?? '').replace(/^Error:\s*/u, '').trim()
  if (first === '') return undefined
  return first.length > 200 ? `${first.slice(0, 200)}…` : first
}

/**
 * 从已解码的 JSONL 行里抽出 `webpage_*` 调用，并按 `callId` 配对回执。
 * @param lines - {@link decodeSessionLog} 的输出。
 * @returns 按调用顺序排列的审计记录。
 */
export function auditEvents(lines: readonly string[]): readonly AuditCall[] {
  const events: SessionEvent[] = []
  for (const line of lines) {
    try {
      const parsed = asRecord(JSON.parse(line))
      if (parsed !== undefined) events.push(parsed as SessionEvent)
    } catch {
      // 坏行跳过：单行 JSON 损坏不该让整份审计失效。
      continue
    }
  }

  /**
   * toolCallId → 回执的 message。
   *
   * 同一 callId 出现多次回执时**保留最后一条**：日志可能带 surfaceOp=replace 的覆盖行
   * （宿主会把被替换的旧行原样留在文件里），后写的才是当期状态。
   */
  const results = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const data = asRecord(event.data)
    const message = asRecord(data?.['message'])
    const id = asString(message?.['toolCallId'])
    if (id !== undefined && message !== undefined) results.set(id, message)
  }

  const calls: AuditCall[] = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = asRecord(event.data)
    const tool = asString(data?.['name'])
    if (tool === undefined || !tool.startsWith(TOOL_PREFIX)) continue
    const callId = asString(data?.['callId'])
    const argsRaw = asString(data?.['arguments']) ?? ''
    // 没有 callId 就无法配对：既不能声称成功，也不能声称失败，按「未结算」记录。
    const message = callId === undefined ? undefined : results.get(callId)
    const resultText = message === undefined ? '' : textOf(message['content'])
    const isError = message?.['isError'] === true
    // 未结算的调用（日志里没有回执）不是失败：它只是没走完，成功与否无证据。
    const settled = message !== undefined
    const call: BrowserCall = {
      callId: callId ?? '',
      toolName: tool,
      settled,
      isError,
      argsRaw,
      resultText,
      image: undefined,
    }
    const observed = settled && !isError ? observedPage(call) : undefined
    calls.push({
      index: calls.length,
      time: typeof event.time === 'number' ? event.time : undefined,
      tool,
      settled,
      ok: settled && !isError,
      url: observed?.url,
      // observedPage 对 execute 这类「无标题族」回执给出空串标题；空串不是标题，
      // 否则 HTML 里会出现「有标题但内容为空」的格子，和「没有标题」无法区分。
      title: observed?.title === '' ? undefined : observed?.title,
      targetUrl: parseBrowserUrl(argsRaw),
      error: !settled ? undefined : (isError ? errorSummary(resultText) ?? 'failed (no message text)' : undefined),
    })
  }
  return calls
}

/**
 * 审计一个会话文件。
 * @param file - `session.v*.jsonl.zstd` 的绝对路径。
 * @param sessionId - 目录名里的会话 id（回执里没有它也能用）。
 * @param cwd - 会话创建时的工作目录（从头部事件读，读不到为 `undefined`）。
 * @returns 该会话的审计结果；读不了时 `error` 有值。
 */
export function auditSessionFile(file: string, sessionId: string, cwd?: string): SessionAudit {
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch (error) {
    return {
      sessionId,
      file,
      cwd,
      calls: [],
      frames: 0,
      torn: false,
      error: `read failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  try {
    const decoded = decodeSessionLog(buffer)
    return {
      sessionId,
      file,
      cwd,
      calls: auditEvents(decoded.lines),
      frames: decoded.frames,
      torn: decoded.torn,
    }
  } catch (error) {
    return {
      sessionId,
      file,
      cwd,
      calls: [],
      frames: 0,
      torn: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 收集 `<sessions 根>` 下所有会话文件。
 *
 * 目录形状是 `<root>/<工作区分组>/<会话 id>/session.v<N>.jsonl.zstd`，
 * 版本号不进契约（宿主的文件名会变），所以按前缀找。
 *
 * 会话目录名**不能**用 `session-` 前缀筛：实测同一个 home 下既有
 * `session-<uuid>`（主对话）也有裸 `<uuid>`（子 agent），两族都可能有 webpage_* 调用；
 * 判据只能是「这个目录里有会话日志」。同一目录里有多代文件时取版本号最大的那个，
 * 与宿主 `resolveGenerationInDirectory` 的选择一致。
 * @param root - `sessions` 目录。
 * @param only - 只审这些会话 id（省略 = 全部）。
 * @returns 会话 id、文件路径与工作区标签。
 */
export function collectSessionFiles(root: string, only?: ReadonlySet<string>): { sessionId: string; file: string; group: string }[] {
  const found: { sessionId: string; file: string; group: string }[] = []
  if (!existsSync(root)) return found
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group)
    if (!isDirectory(groupDir)) continue
    for (const sessionId of readdirSync(groupDir)) {
      if (only !== undefined && !matchesSessionId(sessionId, only)) continue
      const sessionDir = join(groupDir, sessionId)
      if (!isDirectory(sessionDir)) continue
      const file = newestLogIn(sessionDir)
      if (file === undefined) continue
      found.push({ sessionId, file, group })
    }
  }
  return found
}

/** 目录探测：读不了的条目当成「不是目录」，一个坏条目不该中断整轮扫描。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 目录里版本号最大的会话日志。
 *
 * 只按名字匹配而不看版本会在多代文件共存时读到旧那一代（宿主已迁移到 v5 而目录里
 * 还留着 v4 时，审计结果会少掉迁移后的全部事件）。
 */
function newestLogIn(dir: string): string | undefined {
  let best: { name: string; version: number } | undefined
  for (const name of readdirSync(dir)) {
    const match = /^session\.v(\d+)\.jsonl\.zstd$/u.exec(name)
    if (match === null) continue
    const version = Number(match[1])
    if (best === undefined || version > best.version) best = { name, version }
  }
  return best === undefined ? undefined : join(dir, best.name)
}

/**
 * `--session` 的匹配：接受目录名、完整 session id，也接受报告里显示的**去掉前缀并截短**的 id。
 *
 * 报告与 HTML 都按 `session-` 前缀剥掉、并截到前 8 位展示，用户自然会把那段抄回
 * `--session`；只做全等比较会让这条路径永远「没有找到会话」。截短后的值只可能更短，
 * 所以判据是「去掉前缀后以它开头」——代价是前缀本身也命中，审计场景可以接受。
 */
function matchesSessionId(dirName: string, only: ReadonlySet<string>): boolean {
  const bare = dirName.replace(/^session-/u, '')
  for (const wanted of only) {
    if (wanted === dirName) return true
    if (wanted === bare) return true
    if (bare.startsWith(wanted)) return true
  }
  return false
}

/** 会话的历史工作目录：头部事件里的 `cwd`。 */
export function readSessionCwd(file: string): string | undefined {
  try {
    // 只解第一帧：头部必然在第一帧里（写入方先写头再追加批次），而整轮审计对
    // 每个会话要读两次文件，解全部帧等于把这个最大的开销翻倍。
    const buffer = readFileSync(file)
    const [first] = scanZstdFrames(buffer).frames
    if (first === undefined) return undefined
    const head = zstdDecompressSync(buffer.subarray(first.start, first.end)).toString('utf8')
    const line = head.split('\n')[0]
    if (line === undefined || line.trim() === '') return undefined
    return asString(asRecord(JSON.parse(line))?.['cwd'])
  } catch {
    return undefined
  }
}

/** HTML 转义：页面标题与错误文本都是不可信数据。 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** `1795092476273` → `2026-11-19 21:27:56`（本地时区，给人读）。 */
function formatTime(time: number | undefined): string {
  if (time === undefined) return UNKNOWN
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 报告里的一个确认访问：用于摘要与「访问过哪些页面」的去重清单。 */
export interface ConfirmedVisit {
  readonly url: string
  readonly title: string | undefined
  readonly sessionId: string
  readonly firstTime: number | undefined
}

/**
 * 把多个会话的**确认访问**聚合成一张去重清单（同一 URL 跨会话合并，取最早一次）。
 * @param sessions - 各会话审计结果。
 * @returns 按首次访问时间排序的清单。
 */
export function confirmedVisits(sessions: readonly SessionAudit[]): readonly ConfirmedVisit[] {
  const byUrl = new Map<string, ConfirmedVisit>()
  for (const session of sessions) {
    for (const call of session.calls) {
      if (call.url === undefined) continue
      const existing = byUrl.get(call.url)
      if (existing === undefined) {
        byUrl.set(call.url, {
          url: call.url,
          title: call.title,
          sessionId: session.sessionId,
          firstTime: call.time,
        })
        continue
      }
      // 一次遍历里算完三项：标题取第一个非空的、首次时间取最早、会话跟着最早那一次。
      // 旧实现分两次读改写同一个 key，后一次从 Map 里重新取，前一次写入的 title
      // 会被旧对象覆盖；而且「最早」只更新时间不更新会话，报告会自相矛盾。
      const title = existing.title === undefined ? call.title : existing.title
      const earlier = call.time !== undefined
        && (existing.firstTime === undefined || call.time < existing.firstTime)
      const firstTime = earlier ? call.time : existing.firstTime
      const sessionId = earlier ? session.sessionId : existing.sessionId
      if (title !== existing.title || firstTime !== existing.firstTime || sessionId !== existing.sessionId) {
        byUrl.set(call.url, { url: call.url, title, sessionId, firstTime })
      }
    }
  }
  // 时间戳缺失的排到最后，否则 `?? 0` 会让没有时间的记录冒到最前面。
  return [...byUrl.values()].sort((a, b) => {
    if (a.firstTime === undefined) return b.firstTime === undefined ? 0 : 1
    if (b.firstTime === undefined) return -1
    return a.firstTime - b.firstTime
  })
}

/** 渲染一份自包含的 HTML：无外部请求，断网也能看。 */
export function renderAuditHtml(report: AuditReport): string {
  const visits = confirmedVisits(report.sessions)
  const totalCalls = report.sessions.reduce((sum, session) => sum + session.calls.length, 0)
  // 失败与未完成分开计：混在一起会把「日志在回执前结束」讹传成「工具失败」。
  const failures = report.sessions.reduce(
    (sum, session) => sum + session.calls.filter(call => call.settled && !call.ok).length, 0)
  const unsettled = report.sessions.reduce(
    (sum, session) => sum + session.calls.filter(call => !call.settled).length, 0)
  const badFiles = report.sessions.filter(session => session.error !== undefined)

  const rows: string[] = []
  let serial = 0
  for (const session of report.sessions) {
    const short = session.sessionId.replace(/^session-/u, '')
    for (const call of session.calls) {
      serial += 1
      // 三态：成功 / 失败（有回执且 isError）/ 未完成（日志在回执前结束）。
      // 未结算曾经被折进「失败」并与「成功」写进同一个三元式的两个分支（同值死代码），
      // 于是「失败 N 次」把没走完的调用也算进去了。
      const status = call.ok ? 'ok' : (call.settled ? 'failed' : 'unsettled')
      const statusLabel = status === 'ok' ? '成功' : (status === 'failed' ? '失败' : '未完成')
      const url = call.url ?? call.targetUrl
      const urlKind = call.url === undefined ? (call.targetUrl === undefined ? 'none' : 'target') : 'confirmed'
      rows.push([
        `<tr data-status="${status}" data-url-kind="${urlKind}">`,
        `<td class="seq">${String(serial)}</td>`,
        `<td class="time">${escapeHtml(formatTime(call.time))}</td>`,
        `<td class="session" title="${escapeHtml(session.sessionId)}">${escapeHtml(short.slice(0, 8))}</td>`,
        `<td class="tool">${escapeHtml(call.tool)}</td>`,
        `<td class="status status-${status}">${statusLabel}</td>`,
        `<td class="url">${url === undefined
          ? '—'
          : `${urlKind === 'target' ? '<span class="hint" title="参数里的目标地址，未确认到达">目标</span>' : ''}${escapeHtml(url)}`}</td>`,
        `<td class="title">${call.title === undefined ? '' : escapeHtml(call.title)}</td>`,
        `<td class="error">${call.error === undefined ? '' : escapeHtml(call.error)}</td>`,
        '</tr>',
      ].join(''))
    }
  }

  const visitRows = visits.map(visit => [
    '<tr>',
    `<td class="url">${escapeHtml(visit.url)}</td>`,
    `<td class="title">${visit.title === undefined ? '' : escapeHtml(visit.title)}</td>`,
    `<td class="session">${escapeHtml(visit.sessionId.replace(/^session-/u, '').slice(0, 8))}</td>`,
    `<td class="time">${escapeHtml(formatTime(visit.firstTime))}</td>`,
    '</tr>',
  ].join(''))

  const badList = badFiles.length === 0
    ? ''
    : `<section class="bad"><h2>读取失败的文件（${String(badFiles.length)}）</h2><ul>${badFiles
      .map(session => `<li><code>${escapeHtml(session.file)}</code> — ${escapeHtml(session.error ?? '')}</li>`)
      .join('')}</ul></section>`

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>网页访问审计 · ${escapeHtml(report.generatedAt)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:24px;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:Canvas;color:CanvasText}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:28px 0 8px}
.meta{opacity:.7;margin-bottom:16px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
.card{border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:10px 14px;min-width:120px}
.card b{display:block;font-size:20px}
.card span{opacity:.7;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border-bottom:1px solid rgba(127,127,127,.2);padding:5px 8px;text-align:left;vertical-align:top}
th{position:sticky;top:0;background:Canvas;z-index:1}
td.url{word-break:break-all;max-width:520px}
td.title{max-width:320px}
td.error{color:#d04444;max-width:360px;word-break:break-word}
td.seq{opacity:.5;text-align:right}
td.time{white-space:nowrap;opacity:.75}
.status-ok{color:#12805c}.status-failed{color:#d04444}.status-unsettled{color:#b26b00}
.hint{display:inline-block;margin-right:6px;padding:0 5px;border-radius:4px;background:rgba(208,68,68,.15);color:#d04444;font-size:11px}
.tools{display:flex;gap:12px;align-items:center;margin:8px 0}
input[type=search]{padding:5px 8px;border:1px solid rgba(127,127,127,.4);border-radius:6px;background:Canvas;color:CanvasText;min-width:260px}
.bad code{font-size:11px;word-break:break-all}
</style></head><body>
<h1>网页访问审计</h1>
<div class="meta">生成于 ${escapeHtml(report.generatedAt)} · 数据来自会话日志（标签关掉不影响它）</div>
<div class="cards">
<div class="card"><b>${String(report.sessions.length)}</b><span>会话</span></div>
<div class="card"><b>${String(totalCalls)}</b><span>webpage_* 调用</span></div>
<div class="card"><b>${String(visits.length)}</b><span>确认访问过的地址</span></div>
<div class="card"><b>${String(failures)}</b><span>失败调用</span></div>
<div class="card"><b>${String(unsettled)}</b><span>未完成调用</span></div>
</div>
<h2>访问过哪些页面（按 URL 去重，跨会话聚合）</h2>
<table><thead><tr><th>URL</th><th>标题</th><th>会话</th><th>首次访问</th></tr></thead>
<tbody>${visitRows.join('') || '<tr><td colspan="4">没有确认访问记录</td></tr>'}</tbody></table>
<h2>全部调用时间线</h2>
<div class="tools">
<input id="q" type="search" placeholder="过滤 URL / 标题 / 工具 / 错误">
<label><input id="onlyFailed" type="checkbox"> 只看失败</label>
<span id="count" class="meta"></span>
</div>
<table id="rows"><thead><tr><th>#</th><th>时间</th><th>会话</th><th>工具</th><th>状态</th><th>URL</th><th>标题</th><th>错误</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="8">没有 webpage_* 调用</td></tr>'}</tbody></table>
${badList}
<script>
(function(){
  var q = document.getElementById('q');
  var only = document.getElementById('onlyFailed');
  var rows = Array.prototype.slice.call(document.querySelectorAll('#rows tbody tr'));
  var count = document.getElementById('count');
  function apply(){
    var need = (q.value || '').toLowerCase();
    var show = 0;
    rows.forEach(function(row){
      var text = row.textContent.toLowerCase();
      var hit = (need === '' || text.indexOf(need) !== -1) && (!only.checked || row.dataset.status === 'failed');
      row.hidden = !hit;
      if (hit) show++;
    });
    count.textContent = '显示 ' + show + ' / ' + rows.length + ' 条';
  }
  q.addEventListener('input', apply); only.addEventListener('change', apply); apply();
}());
</script>
</body></html>
`
}

/** 打印用法并退出。 */
function usage(message?: string): never {
  if (message !== undefined) console.error(`audit: ${message}`)
  console.error([
    '用法：pnpm audit:webpage [-- 选项]',
    '  --sessions <dir>   sessions 目录（优先）',
    '  --home <dir>       DSH home；取其下的 sessions',
    '  --session <id>     只审指定会话（可重复或用逗号分隔）',
    '  --out <file>       输出 HTML 路径（默认 ./webpage-audit.html）',
    '目录都没给时依次尝试 $DSH_HOME、$DSH_PORTABLE_TEST_DIR/home。',
  ].join('\n'))
  process.exit(1)
}

/**
 * 读一个 `--key value` 形式的参数。
 *
 * 值以 `--` 开头时视为**没给值**：`--out --session x` 这种漏值写法不该把下一个开关名
 * 当成路径用，否则报告会写到名叫 `--session` 的文件里。
 */
function argOf(argv: readonly string[], key: string): string | undefined {
  const at = argv.indexOf(`--${key}`)
  if (at === -1) return undefined
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) return undefined
  return value
}

/** 收集某个开关的**所有**出现（`--session a --session b`），并支持逗号分隔。 */
function listOf(argv: readonly string[], key: string): string[] | undefined {
  const values: string[] = []
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] !== `--${key}`) continue
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) continue
    values.push(...value.split(',').map(entry => entry.trim()).filter(entry => entry !== ''))
  }
  return values.length === 0 ? undefined : values
}

/** 导出报告的 JSON 形态（便于二次加工）。 */
export function toJsonReport(report: AuditReport): string {
  return JSON.stringify({
    generatedAt: report.generatedAt,
    sessions: report.sessions.map(session => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      file: session.file,
      frames: session.frames,
      torn: session.torn,
      ...session.error === undefined ? {} : { error: session.error },
      calls: session.calls,
    })),
    visits: confirmedVisits(report.sessions),
  }, null, 2)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // 明确写了开关却没给值，直接报错退出：静默回落（--out 用默认文件、
  // --sessions 去探测环境变量）会把报告写到用户没预期的位置，
  // 而「文件生成了」看起来像成功。
  for (const flag of ['sessions', 'home', 'out', 'session'] as const) {
    if (argv.includes(`--${flag}`) && (flag === 'session' ? listOf(argv, flag) : argOf(argv, flag)) === undefined) {
      usage(`--${flag} 缺少取值`)
    }
  }
  const explicitSessions = argOf(argv, 'sessions')
  const home = argOf(argv, 'home')
  let root: string | undefined
  if (explicitSessions !== undefined) root = resolve(explicitSessions)
  else if (home !== undefined) root = resolve(home, 'sessions')
  else if ((process.env['DSH_HOME'] ?? '') !== '') root = resolve(process.env['DSH_HOME']!, 'sessions')
  else if ((process.env['DSH_PORTABLE_TEST_DIR'] ?? '') !== '') root = resolve(process.env['DSH_PORTABLE_TEST_DIR']!, 'home', 'sessions')
  if (root === undefined) usage('没有会话目录：给 --sessions 或 --home')
  if (!existsSync(root)) usage(`会话目录不存在：${root}`)

  const onlyIds = listOf(argv, 'session')
  const only = onlyIds === undefined ? undefined : new Set(onlyIds)
  const targets = collectSessionFiles(root, only)
  if (targets.length === 0) usage(`没有找到会话文件：${root}`)

  const sessions = targets.map(target => auditSessionFile(target.file, target.sessionId, readSessionCwd(target.file)))
  const report: AuditReport = { generatedAt: formatTime(Date.now()), sessions }

  const out = resolve(argOf(argv, 'out') ?? 'webpage-audit.html')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, renderAuditHtml(report), 'utf8')
  const jsonPath = out.replace(/\.html?$/u, '') + '.json'
  writeFileSync(jsonPath, toJsonReport(report), 'utf8')

  const visits = confirmedVisits(sessions)
  const totalCalls = sessions.reduce((sum, session) => sum + session.calls.length, 0)
  // 失败（有回执且 isError）与未完成（日志在回执前结束）分开报：两者含义不同，
  // 混成一句「失败 N 次」会让读者以为工具报错了 N 次。
  const failures = sessions.reduce(
    (sum, session) => sum + session.calls.filter(call => call.settled && !call.ok).length, 0)
  const unsettled = sessions.reduce(
    (sum, session) => sum + session.calls.filter(call => !call.settled).length, 0)
  console.log(`读取 ${String(sessions.length)} 个会话 / ${String(totalCalls)} 次 webpage_* 调用`)
  console.log(`确认访问 ${String(visits.length)} 个地址；失败 ${String(failures)} 次；未完成 ${String(unsettled)} 次`)
  for (const session of sessions.filter(entry => entry.error !== undefined)) {
    console.error(`跳过（读不了）：${session.file} — ${session.error ?? ''}`)
  }
  for (const session of sessions.filter(entry => entry.torn)) {
    console.error(`注意：${session.file} 末帧被写断，已按完整帧 + 可恢复前缀审计`)
  }
  console.log(`HTML: ${out}`)
  console.log(`JSON: ${jsonPath}`)
}

// 只有被直接执行时才跑 CLI；被单测 import 时保持纯函数。
if (process.argv[1] !== undefined && /webpage-audit\.(ts|js|mjs)$/u.test(process.argv[1])) {
  await main()
}
