/**
 * 网页访问审计脚本的守卫测试（scripts/webpage-audit.ts）。
 *
 * 这个脚本是「agent 到底看过哪些页面」的唯一权威口径，错一次就是把失败导航算成
 * 访问过、或者把崩溃写断的日志读成「一次都没看过」。所以这里守四类东西：
 *
 *   1. 帧扫描/解码：会话日志是多帧拼接 zstd，测试用 node:zlib 压出**真实字节**
 *      （不 mock），断言多帧定位、末帧写断的 tornStart、以及写断后仍能救回前缀；
 *   2. 调用配对：`tool/call` 与 `tool/result` 按 callId↔toolCallId 配对，成功/失败/
 *      没有回执三种状态**必须**互不混淆（没有回执不是失败）；
 *   3. 口径分离：确认访问（回执自报地址）与目标地址（参数里的 url）绝不合并；
 *   4. 渲染安全：标题/URL/错误来自页面与模型，是不可信数据，注入的 `<script>`
 *      绝不能作为原始标签出现在报告里。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditEvents,
  collectSessionFiles,
  confirmedVisits,
  decodeSessionLog,
  escapeHtml,
  renderAuditHtml,
  scanZstdFrames,
  type AuditCall,
  type AuditReport,
  type SessionAudit,
} from '../scripts/webpage-audit.ts'

let root: string

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

/** 压一帧，可选带 checksum —— 宿主写入的每帧都带校验和，测试按同一形状造。 */
function frame(text: string, checksum = true): Buffer {
  return checksum
    ? zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
    : zstdCompressSync(Buffer.from(text, 'utf8'))
}

/** 宿主的一条 `tool/call` 事件行。 */
function callLine(callId: string, name: string, args: unknown, time = 1795092476273): string {
  return JSON.stringify({ type: 'tool/call', seq: 1, time, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } })
}

/** 宿主的一条 `tool/result` 事件行；`text` 是工具回执正文。 */
function resultLine(callId: string, text: string, isError = false, time = 1795092476274): string {
  return JSON.stringify({
    type: 'tool/result',
    seq: 2,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError,
        id: `m-${callId}`,
      },
    },
  })
}

/** 一次 `webpage_*` 调用的最小审计记录（聚合与渲染测试用）。 */
function auditCall(overrides: Partial<AuditCall> = {}): AuditCall {
  return {
    index: 0,
    time: undefined,
    tool: 'webpage_open',
    settled: true,
    ok: true,
    url: undefined,
    title: undefined,
    targetUrl: undefined,
    error: undefined,
    ...overrides,
  }
}

function sessionAudit(sessionId: string, calls: readonly AuditCall[], extra: Partial<SessionAudit> = {}): SessionAudit {
  return { sessionId, file: `/${sessionId}/session.v4.jsonl.zstd`, cwd: undefined, calls, frames: 1, torn: false, ...extra }
}

describe('escapeHtml', () => {
  it('转义五类危险字符，且 & 先处理避免双重转义', () => {
    // `&` 必须第一个替换，否则 `&lt;` 会被二次转义成 `&amp;lt;`。
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
    expect(escapeHtml('a & b')).toBe('a &amp; b')
    expect(escapeHtml('纯中文没有特殊字符')).toBe('纯中文没有特殊字符')
  })
})

describe('scanZstdFrames', () => {
  it('定位多帧并给出精确字节区间（含跨 block 的大载荷帧）', () => {
    const a = frame('{"a":1}\n')
    const b = frame('{"b":2}\n')
    const c = frame('{"c":3}\n', false)
    const scan = scanZstdFrames(Buffer.concat([a, b, c]))
    expect(scan.frames).toEqual([
      { start: 0, end: a.length },
      { start: a.length, end: a.length + b.length },
      { start: a.length + b.length, end: a.length + b.length + c.length },
    ])
    expect(scan.tornStart).toBeUndefined()
    // 超过单个 zstd block 上限的载荷会产生多个 block header，逐 block 跳过的逻辑靠它兜底。
    const big = frame('x'.repeat(400_000))
    expect(scanZstdFrames(big).frames).toEqual([{ start: 0, end: big.length }])
  })

  it('末帧被写断时报 tornStart 且保留前面的完整帧', () => {
    const a = frame('{"a":1}\n')
    const b = frame('{"b":2}\n')
    // 砍掉最后一帧的尾部字节：结构上不完整 = 进程崩在写入中间。
    const torn = Buffer.concat([a, b]).subarray(0, a.length + b.length - 3)
    const scan = scanZstdFrames(torn)
    expect(scan.frames).toEqual([{ start: 0, end: a.length }])
    expect(scan.tornStart).toBe(a.length)
  })

  it('空文件没有帧也没有 torn；魔数不符直接报错', () => {
    expect(scanZstdFrames(Buffer.alloc(0))).toEqual({ frames: [] })
    // 静默跳过会让「文件损坏」伪装成「这个会话没访问过页面」。
    expect(() => scanZstdFrames(Buffer.from('not a zstd file at all'))).toThrow(/magic/u)
  })
})

describe('decodeSessionLog', () => {
  it('多帧拼接的日志逐帧解出所有行', () => {
    const buffer = Buffer.concat([
      frame(`${callLine('c1', 'webpage_open', { url: 'https://example.com/' })}\n`),
      frame(`${callLine('c2', 'webpage_click', { ref: 'e1' })}\n`),
    ])
    const decoded = decodeSessionLog(buffer)
    expect(decoded.frames).toBe(2)
    expect(decoded.torn).toBe(false)
    expect(decoded.lines).toHaveLength(2)
    expect(JSON.parse(decoded.lines[0]!)).toMatchObject({ type: 'tool/call' })
  })

  it('崩溃写断的末帧仍救回前缀完整行，且不吐半截 JSON', () => {
    // 写入方每批都 flush，所以断点前通常还留着大量完整行；把它们丢掉等于漏审计。
    // 载荷要足够大才会跨多个 block（单 block 帧被截断后没有可取的前缀）。
    const lines: string[] = []
    for (let i = 0; i < 4000; i++) {
      lines.push(callLine(`c${String(i)}`, 'webpage_open', { url: `https://example.com/${String(i)}?pad=${'y'.repeat(40)}` }))
    }
    const good = frame(`${callLine('first', 'webpage_open', { url: 'https://example.com/first' })}\n`)
    const big = frame(`${lines.join('\n')}\n`)
    // 砍到帧中间：既不是帧边界，也不在最后一个字节。
    const cut = Buffer.concat([good, big]).subarray(0, good.length + Math.floor(big.length * 0.6))
    const decoded = decodeSessionLog(cut)
    expect(decoded.torn).toBe(true)
    expect(decoded.frames).toBe(1)
    // 前缀必须真的救回了不少行，且每一条都是可解析的完整 JSON。
    expect(decoded.lines.length).toBeGreaterThan(100)
    for (const line of decoded.lines) expect(() => JSON.parse(line) as unknown).not.toThrow()
    expect(JSON.parse(decoded.lines[0]!)).toMatchObject({ data: { callId: 'first' } })
  })

  it('单帧损坏不影响其它帧的行', () => {
    const bad = frame('{"type":"tool/call"}\n')
    // 翻掉一个数据字节：结构完好但解压/校验失败。
    const corrupted = Buffer.from(bad)
    corrupted[corrupted.length - 6] = corrupted[corrupted.length - 6]! ^ 0xff
    const buffer = Buffer.concat([frame('{"ok":1}\n'), corrupted, frame('{"ok":3}\n')])
    const decoded = decodeSessionLog(buffer)
    expect(decoded.frames).toBe(3)
    expect(decoded.lines).toEqual(['{"ok":1}', '{"ok":3}'])
  })
})

describe('auditEvents 的配对与口径', () => {
  it('成功回执：地址与标题取自回执头部，目标地址另存', () => {
    const lines = [
      callLine('c1', 'webpage_open', { url: 'https://example.com/landing' }),
      resultLine('c1', 'https://example.com/after-redirect\ntitle: 重定向后的页面\nsession_id=t1 (ref epoch 3)'),
    ]
    const [call] = auditEvents(lines)
    expect(call).toBeDefined()
    expect(call!.settled).toBe(true)
    expect(call!.ok).toBe(true)
    // 确认访问 = 回执自报的落地地址，不是参数里写的那个。
    expect(call!.url).toBe('https://example.com/after-redirect')
    expect(call!.title).toBe('重定向后的页面')
    expect(call!.targetUrl).toBe('https://example.com/landing')
  })

  it('失败回执：ok 为假、有错误摘要、不产生确认访问', () => {
    const lines = [
      callLine('c1', 'webpage_navigate', { url: 'https://broken.example/x' }),
      resultLine('c1', 'Error: navigation failed: net::ERR_NAME_NOT_RESOLVED\nsecond line', true),
    ]
    const [call] = auditEvents(lines)
    expect(call!.settled).toBe(true)
    expect(call!.ok).toBe(false)
    expect(call!.url).toBeUndefined()
    expect(call!.title).toBeUndefined()
    expect(call!.error).toBe('navigation failed: net::ERR_NAME_NOT_RESOLVED')
    // 目标地址照样记下来，但它只是「想去的地址」。
    expect(call!.targetUrl).toBe('https://broken.example/x')
  })

  it('没有回执：settled 为假，不当成失败，也没有错误摘要', () => {
    // 旧实现把「日志里没有回执」写成固定错误字符串并计入失败数，把「没走完」
    // 讹传成「工具报错」。三种状态必须互不混淆。
    const lines = [callLine('c1', 'webpage_open', { url: 'https://example.com/' })]
    const [call] = auditEvents(lines)
    expect(call!.settled).toBe(false)
    expect(call!.ok).toBe(false)
    expect(call!.error).toBeUndefined()
  })

  it('按 callId 精确配对，不把回执错给相邻调用', () => {
    const lines = [
      callLine('c1', 'webpage_open', { url: 'https://example.com/one' }),
      callLine('c2', 'webpage_open', { url: 'https://example.com/two' }),
      resultLine('c2', 'https://example.com/two-resolved\ntitle: 二\nsession_id=t1 (ref epoch 1)'),
      resultLine('c1', 'https://example.com/one-resolved\ntitle: 一\nsession_id=t1 (ref epoch 2)'),
    ]
    const calls = auditEvents(lines)
    expect(calls.map(call => call.url)).toEqual(['https://example.com/one-resolved', 'https://example.com/two-resolved'])
  })

  it('忽略非 webpage_ 工具与坏 JSON 行；execute 的空标题归一成「没有标题」', () => {
    const lines = [
      callLine('c1', 'team_task_list', {}),
      '{ 这不是 JSON',
      callLine('c2', 'webpage_console', {}),
      resultLine('c2', 'no console entries'),
      callLine('c3', 'webpage_execute', { expression: 'return 1' }),
      resultLine('c3', 'Runtime.evaluate on session_id=t1 (at https://example.com/x, ref epoch 0)'),
    ]
    const calls = auditEvents(lines)
    expect(calls.map(call => call.tool)).toEqual(['webpage_console', 'webpage_execute'])
    // execute 的头部格式是 `(at URL, ref epoch N)`，解析出的标题是空串。
    // 空串不是标题：留着会让报告出现「有标题但空白」的格子，与没标题无法区分。
    expect(calls[1]!.url).toBe('https://example.com/x')
    expect(calls[1]!.title).toBeUndefined()
  })
})

describe('confirmedVisits', () => {
  it('同一 URL 跨会话去重，时间与会话都取最早那次，标题取第一个非空的', () => {
    const first = sessionAudit('session-a', [
      auditCall({ time: 200, url: 'https://example.com/doc', title: '文档' }),
    ])
    const later = sessionAudit('session-b', [
      auditCall({ time: 100, url: 'https://example.com/doc', title: '文档' }),
      auditCall({ time: 300, url: 'https://example.com/other' }),
    ])
    const visits = confirmedVisits([first, later])
    expect(visits.map(visit => visit.url)).toEqual(['https://example.com/doc', 'https://example.com/other'])
    expect(visits[0]).toMatchObject({ url: 'https://example.com/doc', firstTime: 100, sessionId: 'session-b', title: '文档' })
  })

  it('先出现的空标题不会覆盖后面的真实标题，也不会带走首次访问的归属', () => {
    const empty = sessionAudit('session-a', [auditCall({ time: 100, url: 'https://example.com/doc', title: undefined })])
    const titled = sessionAudit('session-b', [auditCall({ time: 200, url: 'https://example.com/doc', title: '真正的标题' })])
    const [visit] = confirmedVisits([empty, titled])
    expect(visit!.title).toBe('真正的标题')
    // 标题来自后一个会话，但「首次访问」仍然是第一个会话。
    expect(visit!.firstTime).toBe(100)
    expect(visit!.sessionId).toBe('session-a')
  })

  it('失败调用的目标地址不算访问；缺时间的记录排在有时间的之后', () => {
    const failed = sessionAudit('session-a', [
      auditCall({ ok: false, url: undefined, targetUrl: 'https://broken.example/x', error: 'boom' }),
    ])
    expect(confirmedVisits([failed])).toEqual([])
    // `?? 0` 排序会让没有时间的记录冒到最前面，这里必须排到最后。
    const mixed = sessionAudit('session-a', [
      auditCall({ time: undefined, url: 'https://example.com/no-time' }),
      auditCall({ time: 500, url: 'https://example.com/timed' }),
    ])
    expect(confirmedVisits([mixed]).map(visit => visit.url)).toEqual(['https://example.com/timed', 'https://example.com/no-time'])
  })
})

describe('renderAuditHtml', () => {
  const injection = '<script>alert(1)</script>'
  const report: AuditReport = {
    generatedAt: '2026-11-19 22:00:00',
    sessions: [
      sessionAudit('session-aaaaaaaa-bbbb', [
        auditCall({ time: 100, url: `https://example.com/x?a=${injection}`, title: `标题${injection}`, ok: true }),
        auditCall({ time: 200, ok: false, settled: true, targetUrl: 'https://example.com/t', error: `错误${injection}` }),
        auditCall({ time: 300, ok: false, settled: false, targetUrl: 'https://example.com/u' }),
      ]),
    ],
  }

  it('URL / 标题 / 错误里的注入字符串都被转义成文本', () => {
    const html = renderAuditHtml(report)
    // 页面自己的脚本块还在，但注入的标签绝不能原样出现。
    expect(html).not.toContain(injection)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('三态标签区分成功 / 失败 / 未完成，失败计数不含未完成，目标地址单独标注', () => {
    const html = renderAuditHtml(report)
    expect(html).toContain('data-status="ok"')
    expect(html).toContain('data-status="failed"')
    expect(html).toContain('data-status="unsettled"')
    expect(html).toContain('>成功<')
    expect(html).toContain('>失败<')
    expect(html).toContain('>未完成<')
    // 卡片：1 次失败 + 1 次未完成，不能把两者加总。
    expect(html).toContain('<b>1</b><span>失败调用</span>')
    expect(html).toContain('<b>1</b><span>未完成调用</span>')
    // 确认访问与「参数里的目标地址」分列标注。
    expect(html).toContain('data-url-kind="confirmed"')
    expect(html).toContain('data-url-kind="target"')
    expect(html).toContain('>目标<')
  })
})

describe('collectSessionFiles', () => {
  /** 造一个 home 目录形状：<根>/<工作区分组>/<会话目录>/session.vN.jsonl.zstd。 */
  function seed(fileMap: Record<string, string[]>): string {
    root = mkdtempSync(join(tmpdir(), 'webpage-audit-'))
    for (const [rel, names] of Object.entries(fileMap)) {
      const dir = join(root, rel)
      mkdirSync(dir, { recursive: true })
      for (const name of names) writeFileSync(join(dir, name), frame('{"x":1}\n'))
    }
    return root
  }

  it('裸 uuid 的子 agent 目录也要收，不能只认 session- 前缀；根不存在返回空表', () => {
    // 实测同一个 home 下既有 session-<uuid>（主对话）也有裸 <uuid>（子 agent），
    // 两者都可能有 webpage_* 调用；按前缀筛会整类漏掉子 agent 的访问记录。
    const seeded = seed({
      'group/session-1111-aaaa': ['session.v4.jsonl.zstd'],
      'group/2222-bbbb': ['session.v4.jsonl.zstd'],
      'group/没有日志的目录': ['notes.txt'],
    })
    const found = collectSessionFiles(seeded)
    expect(found.map(entry => entry.sessionId).sort()).toEqual(['2222-bbbb', 'session-1111-aaaa'])
    expect(found.every(entry => entry.file.endsWith('.jsonl.zstd'))).toBe(true)
    expect(collectSessionFiles(join(tmpdir(), 'definitely-missing-audit-root'))).toEqual([])
  })

  it('多代文件共存时取版本号最大的那一代', () => {
    // 宿主迁移到更高版本后目录里会同时留着旧代文件；按目录顺序取第一个会读到旧数据。
    const seeded = seed({
      'group/session-1111': ['session.v4.jsonl.zstd', 'session.v10.jsonl.zstd', 'session.v9.jsonl.zstd'],
    })
    const [found] = collectSessionFiles(seeded)
    expect(found!.file.endsWith('session.v10.jsonl.zstd')).toBe(true)
  })

  it('--session 接受全名、裸 id 和报告里显示的短 id', () => {
    const seeded = seed({
      'group/session-1111-aaaa-bbbb': ['session.v4.jsonl.zstd'],
      'group/2222-cccc': ['session.v4.jsonl.zstd'],
    })
    const byFull = collectSessionFiles(seeded, new Set(['session-1111-aaaa-bbbb']))
    expect(byFull.map(entry => entry.sessionId)).toEqual(['session-1111-aaaa-bbbb'])
    // 报告里展示的是去掉前缀并截短的 id，用户会把它抄回命令行。
    const byShort = collectSessionFiles(seeded, new Set(['1111-aaaa']))
    expect(byShort.map(entry => entry.sessionId)).toEqual(['session-1111-aaaa-bbbb'])
    const byBare = collectSessionFiles(seeded, new Set(['2222-cccc']))
    expect(byBare.map(entry => entry.sessionId)).toEqual(['2222-cccc'])
  })
})
