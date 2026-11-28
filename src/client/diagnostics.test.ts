/**
 * `diagnostics.ts` 的行为回归：报告排版纯函数 + 剪贴板兜底。
 *
 * ## 夹具为什么直接取 locales.ts
 *
 * 审查发现旧夹具的 LABELS 是**手抄**的，其中 4 个键（heading / stats / argsNotJson / retry）
 * 与 `locales.ts` 不一致，断言于是对着过期文案跑绿 —— 报告说假话也测不出来。所以这里直接
 * 从 `locales.ts` 的 zh 取标签：面板填什么，测试就断言什么，不会再漂。
 *
 * `locales.ts` 只有 `import type {} from '@deepseek-ai/dsh-client-ui-slots'`（类型导入在运行时
 * 被擦除），所以这个 node 环境的纯函数测试不会因此加载任何客户端 UI 运行时。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCallDiagnostic,
  buildFailuresDiagnostic,
  clientEnvironment,
  copyText,
  errorCodeOf,
  pageOfCall,
  type DiagnosticInput,
  type DiagnosticLabels,
} from './diagnostics.ts'
import { zh } from './locales.ts'
import type { BrowserCall } from './observation.ts'

/** 与面板实际传入的一一对应（键名见 `DiagnosticLabels` 与 `BrowserDock` 的接线）。 */
const LABELS: DiagnosticLabels = {
  heading: zh.diagnosticHeading,
  page: zh.diagnosticPage,
  target: zh.diagnosticTarget,
  pageUnknown: zh.diagnosticPageUnknown,
  currentPage: zh.diagnosticCurrentPage,
  pageTitle: zh.diagnosticTitle,
  tab: zh.diagnosticTab,
  environment: zh.diagnosticEnvironment,
  plugin: zh.diagnosticPlugin,
  stats: zh.diagnosticStats,
  failedTools: zh.diagnosticFailedTools,
  sequence: zh.diagnosticSequence,
  errorCode: zh.diagnosticErrorCode,
  argsCheck: zh.diagnosticArgsCheck,
  argsJson: zh.diagnosticArgsJson,
  argsNotJson: zh.diagnosticArgsNotJson,
  argsMissing: zh.diagnosticArgsMissing,
  retry: zh.diagnosticRetry,
  arguments: zh.arguments,
  receipt: zh.receipt,
  noReceipt: zh.emptyReceipt,
  failure: zh.diagnosticFailed,
  succeeded: zh.diagnosticSucceeded,
  active: zh.diagnosticActive,
}

/** 造一条已结算的调用；默认失败。 */
function call(partial: Partial<BrowserCall> & Pick<BrowserCall, 'toolName'>): BrowserCall {
  return {
    callId: `c-${partial.toolName}`,
    settled: true,
    isError: true,
    argsRaw: '{"code":"return 1"}',
    resultText: 'Error: [BROWSER_EXECUTE_SCRIPT_ERROR] boom',
    image: undefined,
    ...partial,
  }
}

/** 组一份输入：`sessionCalls` 默认就是待报告的那些调用。 */
function input(calls: readonly BrowserCall[], overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return {
    labels: LABELS,
    current: { url: 'https://example.com/a', title: '示例', sessionId: 't1' },
    environment: 'Electron/38.2.0 Chrome/140',
    pluginVersion: '0.2.31',
    sessionCalls: calls,
    ...overrides,
  }
}

/** 标题行：`{count}` 由报告自己填，调用方不手拼条数。 */
function headingOf(count: number): string {
  return `## ${LABELS.heading.replace('{count}', String(count))}`
}

/**
 * 报告里的「事实行」：不在代码块内、以 `- ` 开头的行。
 *
 * 代码块里的原文（参数、回执）是证据，可能恰好以 `- ` 开头（快照大纲就是这样），
 * 不能算成报告的事实行，所以这里按围栏状态过滤。
 */
function facts(text: string): string[] {
  const lines: string[] = []
  /** 当前围栏的反引号个数；`undefined` 表示不在代码块里。 */
  let fence: number | undefined
  for (const line of text.split('\n')) {
    const ticks = /^(`{3,})[a-z]*$/.exec(line)
    if (ticks !== null) {
      const width = ticks[1]?.length ?? 0
      if (fence === undefined) {
        fence = width
        continue
      }
      // 只有同宽或更长的围栏才闭合：短反引号运行是块内原文。
      if (width >= fence) {
        fence = undefined
        continue
      }
    }
    if (fence === undefined && line.startsWith('- ')) lines.push(line)
  }
  return lines
}

describe('LABELS 与 locale 同源', () => {
  it('夹具逐字取 locales.ts 的 zh，没有手抄副本', () => {
    expect(LABELS.heading).toBe(zh.diagnosticHeading)
    expect(LABELS.stats).toBe(zh.diagnosticStats)
    expect(LABELS.argsNotJson).toBe(zh.diagnosticArgsNotJson)
    expect(LABELS.retry).toBe(zh.diagnosticRetry)
    expect(LABELS.target).toBe(zh.diagnosticTarget)
    expect(LABELS.pageUnknown).toBe(zh.diagnosticPageUnknown)
    expect(LABELS.argsMissing).toBe(zh.diagnosticArgsMissing)
  })

  it('两个模板的占位都在，且面板能填满', () => {
    // 占位名对不上时 fill 会原样留下 {running}，报告里就会出现一个字面量占位符。
    expect(LABELS.heading).toContain('{count}')
    expect(LABELS.stats).toContain('{total}')
    expect(LABELS.stats).toContain('{running}')
    expect(LABELS.stats).toContain('{failed}')
    expect(zh.diagnosticCallHeading).toContain('{count}')
  })

  it('三个新键不是旧键的别名', () => {
    // 「目标」不能说成「页面」，空参数不能说成「不是合法 JSON」——混用就是本轮要修的说假话。
    expect(LABELS.target).not.toBe(LABELS.page)
    expect(LABELS.argsMissing).not.toBe(LABELS.argsNotJson)
    expect(LABELS.pageUnknown).not.toBe(LABELS.currentPage)
  })
})

describe('问题 4：errorCodeOf 只认首行行首的码', () => {
  it('取首行方括号里的 BROWSER_ 错误码', () => {
    expect(errorCodeOf('Error: [BROWSER_EXECUTE_RESULT_UNSERIALIZABLE] $[0].eps …'))
      .toBe('BROWSER_EXECUTE_RESULT_UNSERIALIZABLE')
  })

  it('回执以 [CODE] 直接打头时也认（工具自己的回执形状）', () => {
    expect(errorCodeOf('[BROWSER_STALE_REF] ref belongs to an obsolete epoch')).toBe('BROWSER_STALE_REF')
  })

  it('正文里没有 BROWSER_ 前缀的大写串时不猜错误码', () => {
    expect(errorCodeOf('page said [HELLO_WORLD] and NOT_AN_ERROR')).toBeUndefined()
  })

  it('反例：模型 query 拼出的普通 Error 正文里的 BROWSER_ 串不是错误码', () => {
    // 真实形状：src/tool-browser/tools/discovery.ts 把模型给的 query 拼进 Error 文本。
    const text = 'Error: query is not a valid regular expression: Invalid regular expression: /BROWSER_TAB_OCCUPIED(/i: Unterminated group'
    expect(errorCodeOf(text)).toBeUndefined()
  })

  it('反例：首行出现两个方括号码时不挑一个', () => {
    // 真实形状：两段来源不同的材料拼在一行，无法判断哪个属于本次调用。
    expect(errorCodeOf('[BROWSER_PAGE_TEXT] then Error: [BROWSER_EXECUTE_TIMEOUT]')).toBeUndefined()
  })

  it('反例：码不在首行行首时不认', () => {
    expect(errorCodeOf('Error: failed, see [BROWSER_EXECUTE_TIMEOUT]')).toBeUndefined()
  })

  it('反例：首行没码、次行有码时不认', () => {
    // 上一条反例是**单行**输入，删掉「先切出首行」这一步也照样绿。
    expect(errorCodeOf('Error: the page did not answer in time\n[BROWSER_EXECUTE_TIMEOUT] retry later'))
      .toBeUndefined()
  })

  it('次行的方括号不算错误码，首行行首的码照取（钉住「先切首行」）', () => {
    // 两行输入：首行行首是本次调用的真码，次行是页面正文里形状相同的假码。
    // 删掉切首行后，全文会数出两个方括号码，唯一性判定直接返回 undefined，这条就红。
    expect(errorCodeOf('Error: [BROWSER_EXECUTE_TIMEOUT] page said\n[BROWSER_PAGE_TEXT] more'))
      .toBe('BROWSER_EXECUTE_TIMEOUT')
  })

  it('反例：小写方括号不猜', () => {
    expect(errorCodeOf('Error: [timeout] the page did not answer')).toBeUndefined()
  })

  it('首行的码后面跟着长原因也照取', () => {
    expect(errorCodeOf('Error: [BROWSER_INVALID_PARAMS] url must be http(s)\nRecovery: fix it'))
      .toBe('BROWSER_INVALID_PARAMS')
  })
})

describe('pageOfCall', () => {
  it('回执自报的身份是唯一能叫「页面」的来源', () => {
    const observed = call({
      toolName: 'webpage_snapshot',
      isError: false,
      resultText: 'https://observed.example/x\ntitle: 观察到的\nsession_id=t9 (ref epoch 2)\n\n大纲',
    })
    const result = pageOfCall(observed, { url: 'https://example.com/a' })
    expect(result.page).toEqual({ url: 'https://observed.example/x', title: '观察到的', sessionId: 't9' })
    expect(result.source).toBe('receipt')
    expect(result.fromCurrent).toBe(false)
  })

  it('没有回执观察时，参数里的 http(s) 地址是「目标」而不是页面', () => {
    const target = call({ toolName: 'webpage_navigate', argsRaw: '{"url":"https://dead.example/"}' })
    const result = pageOfCall(target, { url: 'https://example.com/a' })
    expect(result.page.url).toBe('https://dead.example/')
    expect(result.source).toBe('target')
    expect(result.fromCurrent).toBe(false)
  })

  it('参数里的非 http(s) 地址不算地址证据', () => {
    // 真实形状：open 传 ftp://，工具回执 BROWSER_INVALID_PARAMS、什么都没派发。
    const ftp = call({ toolName: 'webpage_open', argsRaw: '{"url":"ftp://files.example/x"}' })
    expect(pageOfCall(ftp, { url: 'https://example.com/a' }).source).toBe('current')
    // 真实形状：webpage_network 的 url 参数是相对路径（接口路径），不是页面。
    const relative = call({ toolName: 'webpage_network', argsRaw: '{"url":"/api/q?eps=2"}' })
    expect(pageOfCall(relative, { url: 'https://example.com/a' }).source).toBe('current')
  })

  it('完全没有地址证据时退回面板当前页，但仍标记为 current', () => {
    const result = pageOfCall(call({ toolName: 'webpage_execute' }), { url: 'https://example.com/a' })
    expect(result.page.url).toBe('https://example.com/a')
    expect(result.source).toBe('current')
    expect(result.fromCurrent).toBe(true)
  })
})

describe('buildFailuresDiagnostic', () => {
  it('只收失败调用，按会话顺序输出，带参数与回执原文', () => {
    const ok = call({ toolName: 'webpage_open', isError: false, resultText: 'https://example.com/a' })
    const failed = call({ toolName: 'webpage_execute', resultText: 'Error: [BROWSER_EXECUTE_RESULT_UNSERIALIZABLE] $[0].eps' })
    const text = buildFailuresDiagnostic([ok, failed], input([ok, failed]))

    expect(text).toContain(headingOf(1))
    expect(text).toContain(`### 1. webpage_execute · ${zh.diagnosticFailed}`)
    expect(facts(text)).toContain(`- ${zh.diagnosticErrorCode}: BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`)
    expect(text).toContain('{"code":"return 1"}')
    // 成功的那条不进报告。
    expect(text).not.toContain('webpage_open')
  })

  it('运行中的调用不算失败', () => {
    const running = call({ toolName: 'webpage_click', settled: false, resultText: '' })
    expect(buildFailuresDiagnostic([running], input([running]))).toBe('')
  })

  it('没有失败时返回空串，调用方据此不渲染按钮', () => {
    expect(buildFailuresDiagnostic([], input([]))).toBe('')
    expect(buildFailuresDiagnostic([call({ toolName: 'webpage_open', isError: false })],
      input([call({ toolName: 'webpage_open', isError: false })]))).toBe('')
  })

  it('头部带插件版本、环境、当前页与三个口径的会话统计', () => {
    const one = call({ toolName: 'webpage_execute' })
    const two = call({ toolName: 'webpage_execute' })
    const text = buildFailuresDiagnostic([one, two], input([one, two]))
    const lines = facts(text)

    expect(lines).toContain(`- ${zh.diagnosticPlugin}: dsh-webops-plugin 0.2.31`)
    expect(lines).toContain(`- ${zh.diagnosticEnvironment}: Electron/38.2.0 Chrome/140`)
    expect(lines).toContain(`- ${zh.diagnosticCurrentPage}: https://example.com/a`)
    expect(lines).toContain(`- ${zh.diagnosticTitle}: 示例`)
    expect(lines).toContain(`- ${zh.diagnosticTab}: t1`)
    expect(lines).toContain(`- ${zh.diagnosticFailedTools}: webpage_execute×2`)
    // 三个数都写清：总数（含进行中）、进行中、失败。
    expect(lines).toContain('- 会话统计: 网页调用 2 次（进行中 0 次），失败 2 次')
  })

  it('版本与环境拿不到时省略对应行，不写占位', () => {
    const one = call({ toolName: 'webpage_execute' })
    const text = buildFailuresDiagnostic([one], input([one], { pluginVersion: undefined, environment: undefined }))
    const lines = facts(text)

    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticPlugin}:`))).toBe(false)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticEnvironment}:`))).toBe(false)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticCurrentPage}:`))).toBe(true)
  })
})

describe('问题 1：目标地址不冒充页面', () => {
  it('失败的 webpage_navigate 写「目标地址」，不写「页面」', () => {
    const failed = call({
      toolName: 'webpage_navigate',
      argsRaw: '{"url":"https://dead.example/x"}',
      resultText: 'Error: [BROWSER_NAVIGATION_FAILED] net::ERR_NAME_NOT_RESOLVED',
    })
    const text = buildFailuresDiagnostic([failed], input([failed]))
    const lines = facts(text)

    expect(lines).toContain(`- ${zh.diagnosticTarget}: https://dead.example/x`)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticPage}:`))).toBe(false)
  })

  it('参数是 ftp:// 时不打印地址行（回执已说明未派发）', () => {
    const failed = call({
      toolName: 'webpage_open',
      argsRaw: '{"url":"ftp://files.example/x"}',
      resultText: 'Error: [BROWSER_INVALID_PARAMS] url must be http(s); dispatch_state=not_dispatched. 未派发任何浏览器操作',
    })
    const text = buildCallDiagnostic(failed, input([failed]))
    const lines = facts(text)

    // 参数原文照旧进代码块（那是证据），但事实行里不出现这个地址。
    expect(text).toContain('ftp://files.example/x')
    expect(lines.some(line => line.includes('ftp://'))).toBe(false)
    expect(lines).toContain(`- ${zh.diagnosticPageUnknown}`)
  })

  it('webpage_network 的相对路径参数不当页面', () => {
    const failed = call({
      toolName: 'webpage_network',
      argsRaw: '{"url":"/api/q?eps=2"}',
      resultText: 'Error: [BROWSER_INVALID_PARAMS] url must be absolute',
    })
    const text = buildCallDiagnostic(failed, input([failed]))
    const lines = facts(text)

    expect(lines.some(line => line.includes('/api/q?eps=2'))).toBe(false)
    expect(lines).toContain(`- ${zh.diagnosticPageUnknown}`)
  })

  it('成功回执自报的地址仍然叫「页面」', () => {
    const ok = call({
      toolName: 'webpage_open',
      isError: false,
      argsRaw: '{"url":"https://wanted.example/"}',
      resultText: 'https://landed.example/y\ntitle: 落地页\nsession_id=t1 (ref epoch 1)',
    })
    const text = buildCallDiagnostic(ok, input([ok]))
    const lines = facts(text)

    // 回执说落到了 land 页，就报 land 页；参数里的目标地址不能顶替它。
    expect(lines).toContain(`- ${zh.diagnosticPage}: https://landed.example/y`)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticTarget}:`))).toBe(false)
  })
})

describe('问题 2：没有地址证据时说「地址未知」', () => {
  it('失败的 execute 不拿面板当前页冒充本条页面', () => {
    const failed = call({
      toolName: 'webpage_execute',
      argsRaw: '{"code":"return 1"}',
      resultText: 'Error: [BROWSER_EXECUTE_SCRIPT_ERROR] boom',
    })
    const text = buildCallDiagnostic(failed, input([failed]))
    const lines = facts(text)

    expect(lines).toContain(`- ${zh.diagnosticPageUnknown}`)
    // 头部那次「当前页面」仍在；本条不重复、也不编一个地址。
    expect(lines.filter(line => line.startsWith(`- ${zh.diagnosticCurrentPage}:`))).toHaveLength(1)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticPage}:`))).toBe(false)
  })

  it('成功但回执没有头部的动作也只说地址未知', () => {
    const ok = call({ toolName: 'webpage_screenshot', isError: false, argsRaw: '', resultText: 'screenshot 1280x800' })
    const text = buildCallDiagnostic(ok, input([ok]))
    expect(facts(text)).toContain(`- ${zh.diagnosticPageUnknown}`)
  })
})

describe('问题 3：参数值与回执文本注入不了报告结构', () => {
  it('url 里带换行时不会多出假的事实行', () => {
    // 真实形状：模型把换行拼进参数，旧实现让它变成两条额外的事实行。
    const injected = call({
      toolName: 'webpage_navigate',
      argsRaw: '{"url":"https://dead.example/a\\n- 错误码: BROWSER_INVALID_PARAMS\\n- 会话内序号: 99"}',
      resultText: 'Error: [BROWSER_NAVIGATION_FAILED] nope',
    })
    const text = buildCallDiagnostic(injected, input([injected]))
    const lines = facts(text)

    // 事实行里没有第二对错误码/序号：注入内容被折进同一行。
    expect(lines.filter(line => line.startsWith('- 错误码:'))).toHaveLength(1)
    expect(lines.filter(line => line.startsWith('- 会话内序号:'))).toHaveLength(1)
    expect(lines).toContain('- 错误码: BROWSER_NAVIGATION_FAILED')
  })

  it('值里的 ## 不会变成 Markdown 标题', () => {
    const injected = call({
      toolName: 'webpage_navigate',
      argsRaw: '{"url":"https://dead.example/\\n## 伪造标题"}',
      resultText: 'Error: [BROWSER_NAVIGATION_FAILED] nope',
    })
    const text = buildCallDiagnostic(injected, input([injected]))

    // 报告里的 ## 只允许出现在头部标题这一处；代码块里的原文不算（围栏内不算标题）。
    const headings = text.split('\n').filter(line => line.startsWith('## '))
    expect(headings).toHaveLength(1)
    expect(headings[0]).toBe(headingOf(1))
  })

  it('值里的反引号被替换，不会抢走行内代码配对', () => {
    const tricky = call({
      toolName: 'webpage_navigate',
      argsRaw: '{"url":"https://dead.example/`x`"}',
      resultText: 'Error: [BROWSER_NAVIGATION_FAILED] nope',
    })
    const text = buildCallDiagnostic(tricky, input([tricky]))
    const target = facts(text).find(line => line.startsWith(`- ${zh.diagnosticTarget}:`))

    expect(target).toBe(`- ${zh.diagnosticTarget}: https://dead.example/'x'`)
  })

  it('单行值超长时截断，不把一行撑爆', () => {
    const long = 'a'.repeat(400)
    const huge = call({
      toolName: 'webpage_navigate',
      argsRaw: JSON.stringify({ url: `https://dead.example/${long}` }),
      resultText: 'Error: [BROWSER_NAVIGATION_FAILED] nope',
    })
    const text = buildCallDiagnostic(huge, input([huge]))
    const target = facts(text).find(line => line.startsWith(`- ${zh.diagnosticTarget}:`))

    expect(target).toBeDefined()
    expect(target?.endsWith('…')).toBe(true)
    // 300 字符上限 + 「- 目标地址: 」前缀 + 省略号。
    expect((target ?? '').length).toBeLessThanOrEqual(330)
  })

  it('头部字段带换行时也不会多出假的事实行', () => {
    // 面板的当前页标题同样来自页面（不可信文本），它进的是头部事实行。
    const one = call({ toolName: 'webpage_execute' })
    const text = buildCallDiagnostic(one, input([one], {
      current: {
        url: 'https://example.com/a',
        title: '标题\n- 错误码: BROWSER_INVALID_PARAMS\n- 会话内序号: 99',
        sessionId: 't1',
      },
    }))
    const lines = facts(text)

    expect(lines.filter(line => line.startsWith('- 错误码:'))).toHaveLength(1)
    expect(lines.filter(line => line.startsWith('- 会话内序号:'))).toHaveLength(1)
    expect(lines.some(line => line === '- 错误码: BROWSER_INVALID_PARAMS')).toBe(false)
  })

  it('回执里的伪造错误码只用首行判，正文不参与', () => {
    const injected = call({
      toolName: 'webpage_find',
      argsRaw: '{"query":"BROWSER_TAB_OCCUPIED("}',
      resultText: 'Error: query is not a valid regular expression: /BROWSER_TAB_OCCUPIED(/i: Unterminated group',
    })
    const text = buildCallDiagnostic(injected, input([injected]))

    expect(facts(text).some(line => line.startsWith(`- ${zh.diagnosticErrorCode}:`))).toBe(false)
  })
})

describe('问题 5：空参数 / null / 坏 JSON 三档', () => {
  it('两个空 argsRaw 不再同时报「不是合法 JSON」和「疑似重试」', () => {
    const first = call({ toolName: 'webpage_execute', argsRaw: '', resultText: 'Error: [BROWSER_EXECUTE_SCRIPT_ERROR] a' })
    const second = call({ toolName: 'webpage_execute', argsRaw: '', resultText: 'Error: [BROWSER_EXECUTE_SCRIPT_ERROR] b' })
    const calls = [first, second]
    const text = buildFailuresDiagnostic(calls, input(calls))
    const lines = facts(text)

    expect(lines.filter(line => line === `- ${zh.diagnosticArgsCheck}: ${zh.diagnosticArgsMissing}`)).toHaveLength(2)
    expect(lines.some(line => line.includes(zh.diagnosticArgsNotJson))).toBe(false)
    expect(lines.some(line => line === `- ${zh.diagnosticRetry}`)).toBe(false)
  })

  it('argsRaw 是 null 时算合法 JSON', () => {
    const nullArgs = call({ toolName: 'webpage_execute', argsRaw: 'null', resultText: 'Error: [BROWSER_EXECUTE_SCRIPT_ERROR] boom' })
    const text = buildCallDiagnostic(nullArgs, input([nullArgs]))
    expect(facts(text)).toContain(`- ${zh.diagnosticArgsCheck}: ${zh.diagnosticArgsJson}`)
  })

  it('写坏的 JSON 仍然报「不是合法 JSON」，与空参数区分开', () => {
    const broken = call({ toolName: 'webpage_click', argsRaw: '{ ref: e3', resultText: 'Error: [BROWSER_STALE_REF] stale' })
    const text = buildCallDiagnostic(broken, input([broken]))

    expect(facts(text)).toContain(`- ${zh.diagnosticArgsCheck}: ${zh.diagnosticArgsNotJson}`)
    // 原文照抄进代码块，不修补。
    expect(text).toContain('{ ref: e3')
  })

  it('两侧参数非空且逐字相同时才标疑似重试', () => {
    const first = call({ toolName: 'webpage_execute' })
    const second = call({ toolName: 'webpage_execute' })
    const third = call({ toolName: 'webpage_execute', argsRaw: '{"code":"return 2"}' })
    const calls = [first, second, third]
    const text = buildFailuresDiagnostic(calls, input(calls))
    const lines = facts(text)

    expect(lines.filter(line => line === `- ${zh.diagnosticRetry}`)).toHaveLength(1)
    // 序号是会话内的，不是报告内的。
    expect(lines).toContain(`- ${zh.diagnosticSequence}: 3`)
  })
})

describe('问题 6：标题数报告条数，统计数会话全量', () => {
  it('3 次调用里 2 次在进行中时，统计三个数都写出来', () => {
    const failed = call({ toolName: 'webpage_navigate', argsRaw: '{"url":"https://dead.example/x"}' })
    const runningA = call({ toolName: 'webpage_click', settled: false, resultText: '' })
    const runningB = call({ toolName: 'webpage_wait', settled: false, resultText: '' })
    const calls = [failed, runningA, runningB]
    const text = buildFailuresDiagnostic(calls, input(calls))
    const lines = facts(text)

    expect(text).toContain(headingOf(1))
    expect(lines).toContain('- 会话统计: 网页调用 3 次（进行中 2 次），失败 1 次')
  })
})

describe('问题 7：空环境不渲空值行', () => {
  it('environment 是空串时整行省略', () => {
    const one = call({ toolName: 'webpage_execute' })
    const text = buildFailuresDiagnostic([one], input([one], { environment: '' }))
    const lines = facts(text)

    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticEnvironment}:`))).toBe(false)
    // 别的头部行照旧。
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticPlugin}:`))).toBe(true)
  })

  it('当前页字段是空串时也不写空行', () => {
    const one = call({ toolName: 'webpage_execute' })
    const text = buildCallDiagnostic(one, input([one], { current: { url: '', title: '', sessionId: '' } }))
    const lines = facts(text)

    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticCurrentPage}:`))).toBe(false)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticTitle}:`))).toBe(false)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticTab}:`))).toBe(false)
  })
})

describe('buildCallDiagnostic', () => {
  it('单条也带会话内序号与错误码，参数与回执各成一块', () => {
    const ok = call({ toolName: 'webpage_open', isError: false, resultText: 'https://example.com/a' })
    const failed = call({ toolName: 'webpage_fill', argsRaw: '{"ref":"e1","text":"x"}' })
    const text = buildCallDiagnostic(failed, input([ok, failed]))
    const lines = facts(text)

    expect(text).toContain(headingOf(1))
    expect(lines).toContain(`- ${zh.diagnosticSequence}: 2`)
    expect(lines).toContain(`- ${zh.diagnosticErrorCode}: BROWSER_EXECUTE_SCRIPT_ERROR`)
    expect(text).toContain(`${zh.arguments}:`)
    expect(text).toContain(`${zh.receipt}:`)
  })

  it('标题模板里的 {count} 由报告填，不由调用方手拼', () => {
    const one = call({ toolName: 'webpage_execute' })
    const two = call({ toolName: 'webpage_execute', argsRaw: '{"code":"return 2"}' })
    const text = buildFailuresDiagnostic([one, two], input([one, two]))

    expect(text.split('\n')[0]).toBe(headingOf(2))
  })

  it('面板已插值好的标题原样保留，不再二次替换', () => {
    // 汇总入口传的是 t('diagnosticHeading', { count }) 的成品（没有占位），
    // 单条入口传的是带 {count} 的模板 —— 两种形状都要对。
    const one = call({ toolName: 'webpage_execute' })
    const interpolated = zh.diagnosticHeading.replace('{count}', '1')
    const text = buildCallDiagnostic(one, input([one], { labels: { ...LABELS, heading: interpolated } }))

    expect(text.split('\n')[0]).toBe('## ' + interpolated)
  })

  it('成功调用不写错误码与参数检查，但仍给参数和回执', () => {
    const ok = call({ toolName: 'webpage_snapshot', isError: false, resultText: '- button "保存"' })
    const text = buildCallDiagnostic(ok, input([ok]))
    const lines = facts(text)

    expect(text).toContain(`### 1. webpage_snapshot · ${zh.diagnosticSucceeded}`)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticErrorCode}:`))).toBe(false)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticArgsCheck}:`))).toBe(false)
    // 代码块里的回执原文照抄（快照大纲本来就以 `- ` 开头，它不算报告的事实行）。
    expect(text).toContain('- button "保存"')
    // 事实列表与「调用参数:」之间留空行，否则 Markdown 会把它算成列表项的续行。
    expect(text).toMatch(/- 地址未知[^\n]*\n\n调用参数:/)
  })

  it('回执自报的地址与头部当前页相同时不重复写页面行', () => {
    const same = call({
      toolName: 'webpage_snapshot',
      isError: false,
      resultText: 'https://example.com/a\ntitle: 示例\nsession_id=t1 (ref epoch 2)',
    })
    const text = buildCallDiagnostic(same, input([same]))
    const lines = facts(text)

    // 头部有「当前页面」，本条不再重复一行「页面」，也不谎称地址未知。
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticPage}:`))).toBe(false)
    expect(lines.some(line => line.startsWith(`- ${zh.diagnosticPageUnknown}`))).toBe(false)
    expect(lines.filter(line => line.startsWith(`- ${zh.diagnosticCurrentPage}:`))).toHaveLength(1)
  })

  it('参数里自带三反引号时围栏自动加长，报告不被内容截断', () => {
    const tricky = call({ toolName: 'webpage_execute', argsRaw: '{"code":"// ``` fence"}' })
    const text = buildCallDiagnostic(tricky, input([tricky]))

    // 内容里最多的连续反引号是 3，围栏必须是 4 个。代码块里的内容不做清洗。
    expect(text).toContain('````json\n{"code":"// ``` fence"}\n````')
  })

  it('回执为空时写「无文本回执」而不是空块', () => {
    const empty = call({ toolName: 'webpage_wait', resultText: '' })
    const text = buildCallDiagnostic(empty, input([empty]))

    expect(text).toContain(zh.emptyReceipt)
  })
})

describe('clientEnvironment', () => {
  it('拿到渲染进程的 User-Agent', () => {
    const agent = clientEnvironment()
    expect(typeof agent).toBe('string')
    expect(agent).not.toBe('')
  })
})

/**
 * 复制路径（`copyText` / `copyWithSelection`）的行为回归。
 *
 * ## 这些用例只钉契约，不证明真剪贴板
 *
 * 全部断言都跑在**伪造的 `document` 与 `navigator.clipboard`** 上：node 环境没有真的事件派发、
 * 没有焦点，也没有系统剪贴板。所以这里能证明的只有「实现按哪几条判据判成败」「焦点有没有
 * 还回去」「writeText 不 settle 时会不会挂住」——**不能**证明真实 Electron 渲染进程里一次
 * 复制真的落到了系统剪贴板。判据本身的来源是真机实测（Electron 44.11.5：文档失焦时
 * `execCommand('copy')` 返回 true、`copy` 事件照派发，而剪贴板里没有内容），那次实测不是
 * 这些用例复现出来的；改判据前请回真机复测。
 */
describe('copyText', () => {
  /** 临时替换 `navigator.clipboard`，返回还原函数。 */
  function stubClipboard(writeText: (text: string) => Promise<void>): () => void {
    const holder = globalThis.navigator as unknown as { clipboard?: unknown }
    const had = 'clipboard' in holder
    const previous = holder.clipboard
    Object.defineProperty(holder, 'clipboard', { value: { writeText }, configurable: true, writable: true })
    return () => {
      if (had) Object.defineProperty(holder, 'clipboard', { value: previous, configurable: true, writable: true })
      else Reflect.deleteProperty(holder, 'clipboard')
    }
  }

  /** 明确抹掉 `navigator.clipboard`：单独验兜底路径的用例不该受前一条用例的残留影响。 */
  function stubNoClipboard(): void {
    const holder = globalThis.navigator as unknown as { clipboard?: unknown }
    const had = 'clipboard' in holder
    const previous = holder.clipboard
    Object.defineProperty(holder, 'clipboard', { value: undefined, configurable: true, writable: true })
    restores.push(() => {
      if (had) Object.defineProperty(holder, 'clipboard', { value: previous, configurable: true, writable: true })
      else Reflect.deleteProperty(holder, 'clipboard')
    })
  }

  /**
   * 假的 `document`：只实现复制路径用得到的那几个接口。
   *
   * `dispatchCopy` 模拟「`execCommand('copy')` 真的走了复制流程」——真浏览器里那是它**同步
   * 派发**的 `copy` 事件；假 document 没有事件循环，只能在这里按开关手动派发。`execCommand`
   * 恒返回 `true`：要钉的正是「返回 true 也不能直接当成功」。
   */
  function fakeDocument(options: {
    readonly dispatchCopy: boolean
    readonly hasFocus?: boolean
    /** 让 `execCommand` 抛错：验收尾（摘监听、摘 textarea、还焦点）在异常路径上照做。 */
    readonly execThrows?: boolean
  }): {
    document: Record<string, unknown>
    selected: string[]
    focusCalls: { preventScroll?: boolean }[]
    /** 关键动作的时间顺序；焦点恢复必须排在 execCommand 之后（说明它走的是 finally）。 */
    log: string[]
    execCalls: () => number
    listenerCount: () => number
  } {
    const listeners: ((event: unknown) => void)[] = []
    const selected: string[] = []
    const focusCalls: { preventScroll?: boolean }[] = []
    const log: string[] = []
    let execCalls = 0
    // 复制前的 activeElement：兜底路径结束时应该被 focus 回来（`preventScroll: true`）。
    const activeElement = {
      focus: (focusOptions?: { preventScroll?: boolean }) => {
        focusCalls.push(focusOptions ?? {})
        log.push('focus')
      },
    }
    const area = {
      value: '',
      style: {} as Record<string, string>,
      setAttribute: () => {},
      select(this: { value: string }) { selected.push(this.value) },
      remove: () => {},
    }
    const document = {
      activeElement,
      body: { appendChild: () => {} },
      createElement: () => area,
      hasFocus: () => options.hasFocus ?? true,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === 'copy') listeners.push(listener)
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      },
      execCommand: () => {
        execCalls += 1
        log.push('exec')
        if (options.execThrows === true) throw new Error('execCommand refused')
        if (options.dispatchCopy) for (const listener of [...listeners]) listener({ type: 'copy' })
        return true
      },
    }
    return {
      document,
      selected,
      focusCalls,
      log,
      execCalls: () => execCalls,
      listenerCount: () => listeners.length,
    }
  }

  /** 把假 `document` 挂到 `globalThis` 上，退出时还原。 */
  function stubDocument(fake: Record<string, unknown>): void {
    const holder = globalThis as unknown as { document?: unknown }
    const had = 'document' in holder
    const previous = holder.document
    Object.defineProperty(holder, 'document', { value: fake, configurable: true, writable: true })
    restores.push(() => {
      if (had) Object.defineProperty(holder, 'document', { value: previous, configurable: true, writable: true })
      else Reflect.deleteProperty(holder, 'document')
    })
  }

  const restores: (() => void)[] = []
  afterEach(() => {
    for (const restore of restores.splice(0)) restore()
  })

  it('空串不写剪贴板', async () => {
    await expect(copyText('')).resolves.toBe(false)
  })

  it('异步剪贴板可用时走它', async () => {
    const written: string[] = []
    restores.push(stubClipboard(async (text) => { written.push(text) }))
    await expect(copyText('报告正文')).resolves.toBe(true)
    expect(written).toEqual(['报告正文'])
  })

  it('execCommand 返回 true 但没派发 copy 事件时判失败', async () => {
    // 钉住「不能用 execCommand 的返回值当成功」：实测失焦时它就是返回 true 而剪贴板没内容，
    // 所以判据换成「窗口内有没有真的收到 copy 事件」。这里是伪造 DOM 的行为断言，不代表真机。
    stubNoClipboard()
    const fake = fakeDocument({ dispatchCopy: false })
    stubDocument(fake.document)

    await expect(copyText('兜底正文')).resolves.toBe(false)
    // 兜底确实执行过：文本被选中、execCommand 调了一次、焦点还回去了。
    expect(fake.selected).toEqual(['兜底正文'])
    expect(fake.execCalls()).toBe(1)
    expect(fake.focusCalls).toEqual([{ preventScroll: true }])
    // 一次性监听不能在复制之后留在 document 上。
    expect(fake.listenerCount()).toBe(0)
  })

  it('收到 copy 事件且文档有焦点时判成功', async () => {
    stubNoClipboard()
    const fake = fakeDocument({ dispatchCopy: true, hasFocus: true })
    stubDocument(fake.document)

    await expect(copyText('兜底正文')).resolves.toBe(true)
    expect(fake.execCalls()).toBe(1)
    expect(fake.listenerCount()).toBe(0)
  })

  it('收到 copy 事件但文档失焦时仍判失败', async () => {
    // 实测那条：失焦时事件照派发、返回值也照给 true，但系统剪贴板没被写入。焦点因此是
    // 与 copy 事件并列的第二条判据，缺一不可。
    stubNoClipboard()
    const fake = fakeDocument({ dispatchCopy: true, hasFocus: false })
    stubDocument(fake.document)

    await expect(copyText('兜底正文')).resolves.toBe(false)
    expect(fake.execCalls()).toBe(1)
  })

  it('兜底结束后把焦点还给复制前的元素', async () => {
    // 实测缺口：复制后 document.activeElement 会从按钮变成 BODY，键盘用户就此掉出按钮。
    // 参考实现（harness ui-primitives 的 writeClipboard）在 finally 里恢复，这里钉住这条：
    // 焦点恢复必须发生在 execCommand 之后——只在失败分支里补一句是做不到这个顺序的。
    stubNoClipboard()
    const fake = fakeDocument({ dispatchCopy: true, hasFocus: true })
    stubDocument(fake.document)

    await expect(copyText('焦点正文')).resolves.toBe(true)
    expect(fake.focusCalls).toEqual([{ preventScroll: true }])
    expect(fake.log).toEqual(['exec', 'focus'])
  })

  it('execCommand 抛错时也还原现场（焦点与监听都要收尾）', async () => {
    // 异常路径同样要收尾：否则一次失败的复制会留下抢走焦点的 textarea 和挂着的监听。
    stubNoClipboard()
    const fake = fakeDocument({ dispatchCopy: false, execThrows: true })
    stubDocument(fake.document)

    await expect(copyText('异常正文')).resolves.toBe(false)
    expect(fake.focusCalls).toEqual([{ preventScroll: true }])
    expect(fake.listenerCount()).toBe(0)
  })

  it('writeText 永不 settle 时在上限内继续走兜底，不挂住按钮', async () => {
    // 伪造 DOM 上的行为断言：真机里这个 promise 长时间不 settle 会让按钮一直卡在「复制中」，
    // 所以给 writeText 加了超时；超时按「这条路失败」处理，接着试兜底（这里兜底成功）。
    vi.useFakeTimers()
    try {
      restores.push(stubClipboard(() => new Promise<void>(() => {})))
      const fake = fakeDocument({ dispatchCopy: true, hasFocus: true })
      stubDocument(fake.document)

      let settled: boolean | undefined
      const pending = copyText('超时正文').then((value) => {
        settled = value
        return value
      })

      // 上限之内不返回：证明它确实在等异步结果，而不是立刻判失败。
      await vi.advanceTimersByTimeAsync(1000)
      expect(settled).toBeUndefined()

      // 越过上限：转兜底并成功，不把「异步那条没回音」直接当最终失败。
      await vi.advanceTimersByTimeAsync(600)
      await expect(pending).resolves.toBe(true)
      expect(settled).toBe(true)
      expect(fake.execCalls()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writeText 永不 settle 且兜底也没成时判失败，同样不挂住', async () => {
    vi.useFakeTimers()
    try {
      restores.push(stubClipboard(() => new Promise<void>(() => {})))
      const fake = fakeDocument({ dispatchCopy: false })
      stubDocument(fake.document)

      const pending = copyText('超时正文')
      await vi.advanceTimersByTimeAsync(1600)
      await expect(pending).resolves.toBe(false)
      expect(fake.execCalls()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('异步剪贴板被拒时退回 execCommand', async () => {
    restores.push(stubClipboard(async () => { throw new Error('not a secure context') }))
    const fake = fakeDocument({ dispatchCopy: true, hasFocus: true })
    stubDocument(fake.document)

    await expect(copyText('兜底正文')).resolves.toBe(true)
    expect(fake.selected).toEqual(['兜底正文'])
    expect(fake.execCalls()).toBe(1)
  })

  it('没有任何剪贴板通路时如实返回 false', async () => {
    const holder = globalThis as unknown as { document?: unknown }
    const hadDocument = 'document' in holder
    if (hadDocument) {
      const previousDocument = holder.document
      Reflect.deleteProperty(holder, 'document')
      restores.push(() => Object.defineProperty(holder, 'document', { value: previousDocument, configurable: true, writable: true }))
    }
    // node 环境没有 navigator.clipboard，也没有 document。
    await expect(copyText('无处可写')).resolves.toBe(false)
  })
})
