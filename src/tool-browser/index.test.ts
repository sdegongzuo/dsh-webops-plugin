import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, BROWSER_TOOL_CAPABILITIES, name as pluginName, TOOL_BROWSER_SECTION_ORDER } from './index.ts'
import type { BrowserObservation, BrowserSession, BrowserSnapshot, BrowserTabInfo } from '../browser/index.ts'

const SESSION: BrowserSession = { id: 's1', url: 'https://example.com/', title: 'Example', epoch: 4 }

/** 一张尺寸可读的假 PNG（签名 + IHDR）。 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** 一次 `apply()` 之后可供断言的测试台。 */
interface Harness {
  readonly tools: Map<string, ToolDefinition>
  readonly sections: { name: string; order: number; text: unknown }[]
  readonly browserCalls: { method: string; args: unknown }[]
  readonly savedImages: { name?: string; mediaType: string; bytes: number }[]
  /** 设置后 `observe` 一律失败，用来验证工具层不吞异常。 */
  failObserve: Error | undefined
  /** 设置后 `locate` 一律失败，用来验证工具层不吞异常。 */
  failLocate: Error | undefined
  /** snapshot 观察的返回体；find 的缓存测试会换上多行大纲的版本。 */
  snapshotResponse: BrowserSnapshot
  /** 设置后 `mutate` 结果带上 `openedTabs`（模拟点击弹出了新标签页）。 */
  openedTabs: BrowserTabInfo[] | undefined
}

const SNAPSHOT: BrowserSnapshot = {
  kind: 'snapshot',
  sessionId: 's1',
  epoch: 4,
  url: SESSION.url,
  title: SESSION.title,
  outline: '- button "Submit" [ref=e1]',
  refs: [{ ref: 'e1', role: 'button', name: 'Submit' }],
  truncated: false,
  outlineLines: 1,
}

const SCREENSHOT = {
  kind: 'screenshot' as const,
  sessionId: 's1',
  epoch: 4,
  data: pngBytes(640, 480),
  mediaType: 'image/png' as const,
  width: 640,
  height: 480,
}

/**
 * 用只实现被用到的那几个方法的桩上下文挂上 tool-browser。
 *
 * `defineTool` 是真的 —— 所以这个测试同时证明了四个工具的 schema 能在 dsh 的 DSL 下编译通过，
 * 而这是 `apply()` 在真实 profile 里不炸的必要条件。
 */
function mount(): Harness {
  const tools = new Map<string, ToolDefinition>()
  const sections: { name: string; order: number; text: unknown }[] = []
  const browserCalls: { method: string; args: unknown }[] = []
  const savedImages: { name?: string; mediaType: string; bytes: number }[] = []
  const harness: Harness = {
    tools,
    sections,
    browserCalls,
    savedImages,
    failObserve: undefined,
    failLocate: undefined,
    snapshotResponse: SNAPSHOT,
    openedTabs: undefined,
  }

  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (toolName: string) => tools.get(toolName),
    },
    systemPrompt: {
      section: (section: { name: string; order: number; text: unknown }) => {
        sections.push(section)
        return () => undefined
      },
    },
    attachments: {
      saveImage: (input: { data: Uint8Array; mediaType: string; name?: string }) => {
        savedImages.push({
          ...input.name !== undefined ? { name: input.name } : {},
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
        })
        return Promise.resolve({
          attachmentId: 'att-1',
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 640,
          height: 480,
        })
      },
    },
    browser: {
      open: (args: unknown) => {
        browserCalls.push({ method: 'open', args })
        return Promise.resolve(SESSION)
      },
      navigate: (args: unknown) => {
        browserCalls.push({ method: 'navigate', args })
        return Promise.resolve(SESSION)
      },
      tabs: (args: { kind: string; sessionId?: string }) => {
        browserCalls.push({ method: 'tabs', args })
        return Promise.resolve({
          action: args.kind,
          ...args.sessionId !== undefined ? { sessionId: args.sessionId } : {},
          tabs: [{ sessionId: 's1', url: SESSION.url, title: SESSION.title, active: true }],
        })
      },
      mutate: (args: { kind: string; sessionId?: string; ref?: string; value?: string; key?: string; deltaX?: number; deltaY?: number; timeMs?: number; text?: string }) => {
        browserCalls.push({ method: 'mutate', args })
        return Promise.resolve({
          kind: 'mutation',
          sessionId: 's1',
          action: args.kind,
          epoch: 4,
          url: SESSION.url,
          title: SESSION.title,
          navigated: false,
          ...args.kind === 'wait' ? { satisfied: true } : {},
          ...harness.openedTabs !== undefined ? { openedTabs: harness.openedTabs } : {},
        })
      },
      observe: (args: { kind: string }) => {
        browserCalls.push({ method: 'observe', args })
        if (harness.failObserve !== undefined) return Promise.reject(harness.failObserve)
        const observation: BrowserObservation = args.kind === 'snapshot' ? harness.snapshotResponse : SCREENSHOT
        return Promise.resolve(observation)
      },
      locate: (args: { sessionId: string; ref: string; highlight?: boolean; scroll?: boolean }) => {
        browserCalls.push({ method: 'locate', args })
        if (harness.failLocate !== undefined) return Promise.reject(harness.failLocate)
        return Promise.resolve({
          kind: 'locate',
          sessionId: args.sessionId,
          epoch: 4,
          ref: args.ref,
          x: 10,
          y: 20,
          width: 100,
          height: 40,
          centered: args.scroll ?? false,
          inViewport: true,
        })
      },
      // P2 三工具的桩：返回最小合法结果，让转发与 schema 校验有东西可断言。
      console: (args: unknown) => {
        browserCalls.push({ method: 'console', args })
        return Promise.resolve({
          kind: 'console',
          sessionId: 's1',
          entries: [
            { level: 'error', text: 'boom', timestamp: 1234, source: 'runtime' },
            { level: 'error', text: 'boom again', timestamp: 1235, source: 'log' },
          ],
          buffered: 2,
          truncated: false,
          replayTruncated: true,
          document: 1,
          earlierDocuments: 3,
        })
      },
      network: (args: { kind: string; requestId?: string }) => {
        browserCalls.push({ method: 'network', args })
        return args.kind === 'list'
          ? Promise.resolve({
            kind: 'network',
            sessionId: 's1',
            action: 'list',
            requests: [{
              requestId: 'req-1',
              method: 'GET',
              url: 'https://api.example.com/x',
              status: 200,
              mimeType: 'application/json',
            }],
            document: 1,
            earlierDocuments: 2,
          })
          : Promise.resolve({
            kind: 'network',
            sessionId: 's1',
            action: 'body',
            requests: [],
            requestId: args.requestId ?? 'req-1',
            body: 'pong',
            base64Encoded: false,
            truncated: false,
          })
      },
      execute: (args: { method: string }) => {
        browserCalls.push({ method: 'execute', args })
        return Promise.resolve({
          kind: 'execute',
          sessionId: 's1',
          method: args.method,
          epoch: 4,
          url: SESSION.url,
          navigated: false,
          value: 2,
          truncated: false,
        })
      },
      close: () => Promise.resolve(),
    },
  } as unknown as Context

  apply(ctx, {})
  return harness
}

/** 一个够用的执行上下文桩：工具只读 `signal`。 */
function exec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

/** 取一个工具，缺失即测试台搭错了。 */
function tool(harness: Harness, toolName: string): ToolDefinition {
  const definition = harness.tools.get(toolName)
  if (definition === undefined) throw new Error(`tool ${toolName} was not registered`)
  return definition
}

describe('registration', () => {
  it('exposes exactly the P0 read-only tools, the P1 operation tools, the P2 collectors and the P3 locators', () => {
    expect([...mount().tools.keys()].sort()).toEqual([
      'browser_click',
      'browser_console',
      'browser_execute',
      'browser_fill',
      'browser_find',
      'browser_locate',
      'browser_navigate',
      'browser_network',
      'browser_open',
      'browser_press',
      'browser_screenshot',
      'browser_scroll',
      'browser_snapshot',
      'browser_tabs',
      'browser_wait',
    ])
  })

  it('classifies read vs mutate tools in the capability metadata', () => {
    expect(BROWSER_TOOL_CAPABILITIES).toMatchObject({
      browser_open: 'read',
      browser_navigate: 'read',
      browser_snapshot: 'read',
      browser_screenshot: 'read',
      browser_wait: 'read',
      // P2：console / network 是纯读采集；execute 的允许列表里有 Page.navigate，归 mutate。
      browser_console: 'read',
      browser_network: 'read',
      browser_execute: 'mutate',
      // P3：find 是纯本地检索；locate 只观察（scrollIntoView 是观察辅助，不是页面操作）。
      browser_find: 'read',
      browser_locate: 'read',
      browser_tabs: 'mutate',
      browser_click: 'mutate',
      browser_fill: 'mutate',
      browser_press: 'mutate',
      browser_scroll: 'mutate',
    })
    // 元数据必须覆盖全部已注册工具，新工具进来忘了分级会在这里炸。
    expect(Object.keys(BROWSER_TOOL_CAPABILITIES).sort()).toEqual([...mount().tools.keys()].sort())
  })

  it('declares the plugin name and a section order right above the web tools', () => {
    expect(pluginName).toBe('tool-browser')
    expect(TOOL_BROWSER_SECTION_ORDER).toBe(2050)

    const section = mount().sections[0]
    expect(section?.name).toBe('tool:browser')
    expect(section?.order).toBe(TOOL_BROWSER_SECTION_ORDER)
  })

  it('tells the model that page content is untrusted and how to recover from a stale ref', () => {
    const section = mount().sections[0]
    const text = (section?.text as (context: { scope?: undefined }) => string)({ scope: undefined })

    expect(text).toContain('untrusted')
    expect(text).toContain('BROWSER_STALE_REF')
    expect(text).toContain('browser_snapshot')
  })

  it('contributes nothing to the prompt when the tools are not visible in that scope', () => {
    const harness = mount()
    harness.tools.clear()
    const section = harness.sections[0]
    expect((section?.text as (context: { scope?: undefined }) => string)({ scope: undefined })).toBe('')
  })

  it('can turn individual tools off through config', () => {
    const tools = new Map<string, ToolDefinition>()
    const ctx = {
      tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => undefined }, get: () => undefined },
      systemPrompt: { section: () => () => undefined },
    } as unknown as Context
    apply(ctx, {
      snapshot: false, screenshot: false, tabs: false,
      click: false, fill: false, press: false, scroll: false, wait: false,
      console: false, network: false, execute: false, find: false, locate: false,
    })

    expect([...tools.keys()].sort()).toEqual(['browser_navigate', 'browser_open'])
  })
})

describe('argument and output contracts', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('rejects arguments that violate the declared schema', async () => {
    await expect(tool(harness, 'browser_snapshot').execute({}, exec())).rejects.toThrow(/session_id/u)
  })

  it('rejects a screenshot asking for a ref and the full page at once', async () => {
    await expect(tool(harness, 'browser_screenshot').execute({ session_id: 's1', ref: 'e1', full_page: true }, exec()))
      .rejects.toThrow(/mutually exclusive/u)
  })

  it('forwards the session id and url to ctx.browser.navigate', async () => {
    const value = await tool(harness, 'browser_navigate').execute(
      { session_id: 's1', url: 'https://example.com/next' },
      exec(),
    )

    expect(harness.browserCalls).toEqual([
      { method: 'navigate', args: { sessionId: 's1', url: 'https://example.com/next' } },
    ])
    expect(value).toEqual({ session_id: 's1', url: 'https://example.com/', title: 'Example', epoch: 4 })
  })

  it('omits the url entirely when the model opens a blank page', async () => {
    await tool(harness, 'browser_open').execute({}, exec())
    expect(harness.browserCalls).toEqual([{ method: 'open', args: {} }])
  })

  it('passes a snapshot through the seam and returns its refs', async () => {
    const value = await tool(harness, 'browser_snapshot').execute({ session_id: 's1' }, exec())

    expect(harness.browserCalls).toEqual([
      { method: 'observe', args: { kind: 'snapshot', sessionId: 's1' } },
    ])
    expect(value).toMatchObject({ session_id: 's1', epoch: 4, refs: [{ ref: 'e1', role: 'button', name: 'Submit' }] })
    expect(value).toSatisfy((candidate: unknown) =>
      validateJsonSchemaValue(tool(harness, 'browser_snapshot').output.schema, candidate).length === 0)
  })

  it('renders the outline together with the ref lifetime warning', () => {
    const definition = tool(harness, 'browser_snapshot')
    const blocks = definition.output.render({ session_id: 's1' }, {
      session_id: 's1',
      url: SESSION.url,
      title: SESSION.title,
      epoch: 4,
      outline: '- button "Submit" [ref=e1]',
      truncated: false,
      refs: [{ ref: 'e1', role: 'button', name: 'Submit' }],
    })

    const text = String((blocks[0] as { text: string }).text)
    expect(text).toContain('[ref=e1]')
    expect(text).toContain('valid only for this epoch')
    expect(text).toContain('untrusted')
  })
})

describe('browser_tabs and the P1 mutation tools', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('forwards list / activate / close to ctx.browser.tabs', async () => {
    const definition = tool(harness, 'browser_tabs')
    const listed = await definition.execute({ action: 'list' }, exec())
    expect(harness.browserCalls).toEqual([{ method: 'tabs', args: { kind: 'list' } }])
    expect(listed).toEqual({
      action: 'list',
      tabs: [{ session_id: 's1', url: SESSION.url, title: SESSION.title, active: true }],
    })

    harness.browserCalls.length = 0
    const closed = await definition.execute({ action: 'close', session_id: 's1' }, exec())
    expect(harness.browserCalls).toEqual([{ method: 'tabs', args: { kind: 'close', sessionId: 's1' } }])
    expect(closed).toMatchObject({ action: 'close', session_id: 's1' })
  })

  it('rejects tabs actions that miss their session id or use an unknown action', async () => {
    const definition = tool(harness, 'browser_tabs')
    await expect(definition.execute({ action: 'activate' }, exec())).rejects.toThrow(/session_id/u)
    await expect(definition.execute({ action: 'reboot', session_id: 's1' }, exec())).rejects.toThrow(/list, activate, close/u)
  })

  it('forwards click with the ref and reports the resulting epoch', async () => {
    const definition = tool(harness, 'browser_click')
    const value = await definition.execute({ session_id: 's1', ref: 'e1' }, exec())

    expect(harness.browserCalls).toEqual([
      { method: 'mutate', args: { kind: 'click', sessionId: 's1', ref: 'e1' } },
    ])
    expect(value).toEqual({
      session_id: 's1',
      action: 'click',
      epoch: 4,
      url: SESSION.url,
      title: SESSION.title,
      navigated: false,
    })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
  })

  it('passes fill / press / scroll arguments through unchanged', async () => {
    await tool(harness, 'browser_fill').execute({ session_id: 's1', ref: 'e1', value: 'hi' }, exec())
    await tool(harness, 'browser_press').execute({ session_id: 's1', ref: 'e1', key: 'Enter' }, exec())
    await tool(harness, 'browser_scroll').execute({ session_id: 's1', ref: 'e1', delta_y: 300 }, exec())

    expect(harness.browserCalls).toEqual([
      { method: 'mutate', args: { kind: 'fill', sessionId: 's1', ref: 'e1', value: 'hi' } },
      { method: 'mutate', args: { kind: 'press', sessionId: 's1', ref: 'e1', key: 'Enter' } },
      { method: 'mutate', args: { kind: 'scroll', sessionId: 's1', ref: 'e1', deltaY: 300 } },
    ])
  })

  it('wait reports satisfied; the "exactly one condition" rule is enforced in the provider', async () => {
    const value = await tool(harness, 'browser_wait').execute({ session_id: 's1', time_ms: 5 }, exec())
    expect(value).toMatchObject({ action: 'wait', satisfied: true })
    expect(harness.browserCalls).toEqual([{ method: 'mutate', args: { kind: 'wait', sessionId: 's1', timeMs: 5 } }])
  })

  it('renders a navigated mutation with the re-snapshot instruction', async () => {
    const definition = tool(harness, 'browser_click')
    const blocks = definition.output.render({ session_id: 's1' }, {
      session_id: 's1',
      action: 'click',
      epoch: 5,
      url: 'https://example.com/next',
      title: 'Next',
      navigated: true,
    })

    const text = String((blocks[0] as { text: string }).text)
    expect(text).toContain('NAVIGATION DETECTED')
    expect(text).toContain('browser_snapshot')
    expect(text).toContain('untrusted')
  })

  it('surfaces a popup the click opened as opened_tabs (snake_case, schema-valid)', async () => {
    harness.openedTabs = [{
      sessionId: 't2',
      url: 'https://example.com/hot-5',
      title: '热搜第五条',
    }]

    const value = await tool(harness, 'browser_click').execute({ session_id: 's1', ref: 'e1' }, exec())

    expect(value).toMatchObject({
      session_id: 's1',
      // 回执里的**原会话不变**：新标签页是并存，不是替换。
      url: SESSION.url,
      opened_tabs: [{ session_id: 't2', url: 'https://example.com/hot-5', title: '热搜第五条' }],
    })
    // required 之外的字段一旦出现，必须能被工具输出契约接受。
    expect(validateJsonSchemaValue(tool(harness, 'browser_click').output.schema, value)).toEqual([])
  })

  it('renders the new tab(s) prominently so the model stops assuming a single tab', async () => {
    const blocks = tool(harness, 'browser_click').output.render({ session_id: 's1' }, {
      session_id: 's1',
      action: 'click',
      epoch: 4,
      url: SESSION.url,
      title: SESSION.title,
      navigated: false,
      opened_tabs: [{ session_id: 't2', url: 'https://example.com/hot-5', title: '热搜第五条' }],
    })

    const text = String((blocks[0] as { text: string }).text)
    expect(text).toContain('NEW TAB(S) OPENED')
    expect(text).toContain('session_id=t2')
    expect(text).toContain('https://example.com/hot-5')
    expect(text).toContain('session_id=s1 is still open')
    // 「refs 不受影响」只在没导航时成立；导航并弹窗时不能与下面的 NAVIGATION DETECTED 打架。
    expect(text).toContain('refs are unaffected')
    const alsoNavigated = String((tool(harness, 'browser_click').output.render({ session_id: 's1' }, {
      session_id: 's1',
      action: 'click',
      epoch: 5,
      url: 'https://example.com/next',
      title: 'Next',
      navigated: true,
      opened_tabs: [{ session_id: 't2', url: 'https://example.com/hot-5', title: '热搜第五条' }],
    })[0] as { text: string }).text)
    expect(alsoNavigated).toContain('NEW TAB(S) OPENED')
    expect(alsoNavigated).toContain('NAVIGATION DETECTED')
    expect(alsoNavigated).not.toContain('refs are unaffected')
    // 反向：没开新标签时不许出现这段提示（否则模型会去找不存在的标签页）。
    const plain = tool(harness, 'browser_click').output.render({ session_id: 's1' }, {
      session_id: 's1',
      action: 'click',
      epoch: 4,
      url: SESSION.url,
      title: SESSION.title,
      navigated: false,
    })
    expect(String((plain[0] as { text: string }).text)).not.toContain('NEW TAB(S) OPENED')
  })
})

describe('browser_screenshot', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('stores the PNG as an attachment and returns an image content block', async () => {
    const definition = tool(harness, 'browser_screenshot')
    const value = await definition.execute({ session_id: 's1' }, exec())

    expect(harness.savedImages).toEqual([{ name: 'browser-screenshot.png', mediaType: 'image/png', bytes: 24 }])
    // 工具的输出必须过它声明的 schema —— dsh 的 createSuccessResult 就是这么校验的。
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])

    const blocks = definition.output.render({ session_id: 's1' }, value as never)
    expect(blocks.map(block => block.type)).toEqual(['text', 'image'])
    expect(blocks[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'att-1' } })
    // 消息里只留引用：字节不进工具结果。
    expect(JSON.stringify(blocks)).not.toContain('data')
  })

  it('forwards an element ref so a stale ref fails instead of capturing the wrong thing', async () => {
    await tool(harness, 'browser_screenshot').execute({ session_id: 's1', ref: 'e1' }, exec())
    expect(harness.browserCalls).toEqual([
      { method: 'observe', args: { kind: 'screenshot', sessionId: 's1', ref: 'e1' } },
    ])
  })

  it('reports the provider failure instead of inventing an image', async () => {
    const failure = Object.assign(new Error('ref belongs to an obsolete epoch'), { code: 'BROWSER_STALE_REF' })
    harness.failObserve = failure

    await expect(tool(harness, 'browser_screenshot').execute({ session_id: 's1', ref: 'e1' }, exec()))
      .rejects.toThrow('ref belongs to an obsolete epoch')
    expect(harness.savedImages).toEqual([])
  })
})

describe('browser_console / browser_network / browser_execute', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('forwards console filters and maps replayTruncated to snake_case', async () => {
    const definition = tool(harness, 'browser_console')
    const value = await definition.execute(
      { session_id: 's1', limit: 10, level: 'error', text: 'boom' },
      exec(),
    )

    expect(harness.browserCalls).toEqual([
      { method: 'console', args: { sessionId: 's1', limit: 10, level: 'error', text: 'boom' } },
    ])
    expect(value).toMatchObject({
      session_id: 's1',
      buffered: 2,
      truncated: false,
      replay_truncated: true,
      entries: [
        { level: 'error', text: 'boom', timestamp: 1234, source: 'runtime' },
        { level: 'error', text: 'boom again', timestamp: 1235, source: 'log' },
      ],
    })
    // 输出必须过它声明的 schema —— 含 replay_truncated 这条 P2 新增字段。
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
  })

  it('forwards network list and body actions; body requires request_id', async () => {
    const definition = tool(harness, 'browser_network')
    const listed = await definition.execute({ session_id: 's1', action: 'list', url: 'api' }, exec())

    expect(harness.browserCalls).toEqual([
      { method: 'network', args: { kind: 'list', sessionId: 's1', url: 'api' } },
    ])
    expect(listed).toMatchObject({
      session_id: 's1',
      action: 'list',
      requests: [{ request_id: 'req-1', method: 'GET', status: 200, mime_type: 'application/json' }],
    })
    expect(validateJsonSchemaValue(definition.output.schema, listed)).toEqual([])

    await expect(definition.execute({ session_id: 's1', action: 'body' }, exec()))
      .rejects.toThrow(/request_id/u)

    const body = await definition.execute({ session_id: 's1', action: 'body', request_id: 'req-1' }, exec())
    expect(harness.browserCalls[1]).toEqual({
      method: 'network',
      args: { kind: 'body', sessionId: 's1', requestId: 'req-1' },
    })
    expect(body).toMatchObject({ action: 'body', request_id: 'req-1', body: 'pong' })
    expect(validateJsonSchemaValue(definition.output.schema, body)).toEqual([])
  })

  it('rejects an unknown network action', async () => {
    await expect(tool(harness, 'browser_network').execute({ session_id: 's1', action: 'replay' }, exec()))
      .rejects.toThrow(/list, body/u)
  })

  it('forwards the whitelisted CDP command with its params and returns the value', async () => {
    const definition = tool(harness, 'browser_execute')
    const value = await definition.execute(
      { session_id: 's1', method: 'Runtime.evaluate', params: { expression: '1 + 1' } },
      exec(),
    )

    expect(harness.browserCalls).toEqual([{
      method: 'execute',
      args: { sessionId: 's1', method: 'Runtime.evaluate', params: { expression: '1 + 1' } },
    }])
    expect(value).toMatchObject({ session_id: 's1', method: 'Runtime.evaluate', value: 2, truncated: false })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
  })
})

describe('browser_find / browser_locate (P3)', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  /** find 的执行返回体视图（defineTool 对带可选参数的工具推不出具体形状）。 */
  interface FindResultView {
    session_id: string
    truncated: boolean
    matches: { ref: string; role: string; name: string; line: string }[]
  }

  it('refuses to search before a snapshot is cached, then matches case-insensitively', async () => {
    const definition = tool(harness, 'browser_find')
    await expect(definition.execute({ session_id: 's1', query: 'submit' }, exec()))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))

    await tool(harness, 'browser_snapshot').execute({ session_id: 's1' }, exec())
    const value = await definition.execute({ session_id: 's1', query: 'SUBMIT' }, exec())

    expect(harness.browserCalls.filter(call => call.method === 'observe')).toHaveLength(1)
    expect(value).toEqual({
      session_id: 's1',
      truncated: false,
      matches: [{ ref: 'e1', role: 'button', name: 'Submit', line: '- button "Submit" [ref=e1]' }],
    })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
  })

  it('supports regex mode and rejects invalid patterns as argument errors', async () => {
    await tool(harness, 'browser_snapshot').execute({ session_id: 's1' }, exec())
    const definition = tool(harness, 'browser_find')

    const value = await definition.execute({ session_id: 's1', query: '^\\s*- button', regex: true }, exec()) as FindResultView
    expect(value.matches).toHaveLength(1)

    await expect(definition.execute({ session_id: 's1', query: '([', regex: true }, exec()))
      .rejects.toThrow(/regular expression/u)
  })

  it('caps matches at limit, clips overlong lines and marks ref-less lines', async () => {
    const longText = 'x'.repeat(300)
    harness.snapshotResponse = {
      ...SNAPSHOT,
      outline: [
        `- link "needle ${longText}" [ref=e1]`,
        '- text "needle in a plain line"',
        '- text "unrelated"',
      ].join('\n'),
      refs: [{ ref: 'e1', role: 'link', name: `needle ${longText}` }],
    }
    await tool(harness, 'browser_snapshot').execute({ session_id: 's1' }, exec())

    const value = await tool(harness, 'browser_find')
      .execute({ session_id: 's1', query: 'needle', limit: 2 }, exec()) as FindResultView

    expect(value.truncated).toBe(true)
    expect(value.matches).toHaveLength(2)
    expect(value.matches[0]).toMatchObject({ ref: 'e1', role: 'link' })
    const firstLine = (value.matches[0] as { line: string }).line
    expect(firstLine.length).toBe(200)
    expect(firstLine.endsWith('…')).toBe(true)
    // 没挂 ref 的内容行照样返回，ref 留空串。
    expect(value.matches[1]).toEqual({ ref: '', role: '', name: '', line: '- text "needle in a plain line"' })
  })

  it('finds the rank-5 hot-search link without matching rank 2 or a title that merely contains 5', async () => {
    harness.snapshotResponse = {
      ...SNAPSHOT,
      outline: [
        '- link "2 渔民落水11天后事都办了 人回来了" [ref=e22]',
        '- link "5 亚朵店长叫“现长”店助叫“政委”" [ref=e35]',
        '- text "烧烤店被检查15次：系1人投诉116次"',
        '- link "15 其他" [ref=e40]',
      ].join('\n'),
      refs: [
        { ref: 'e22', role: 'link', name: '2 渔民落水11天后事都办了 人回来了' },
        { ref: 'e35', role: 'link', name: '5 亚朵店长叫“现长”店助叫“政委”' },
        { ref: 'e40', role: 'link', name: '15 其他' },
      ],
    }
    await tool(harness, 'browser_snapshot').execute({ session_id: 's1' }, exec())
    const value = await tool(harness, 'browser_find')
      .execute({ session_id: 's1', query: 'link "5 ' }, exec()) as FindResultView
    expect(value.matches).toHaveLength(1)
    expect(value.matches[0]).toMatchObject({ ref: 'e35', role: 'link' })
  })

  it('drops the cached outline on navigate so stale refs cannot be searched', async () => {
    await tool(harness, 'browser_snapshot').execute({ session_id: 's1' }, exec())
    await tool(harness, 'browser_navigate').execute({ session_id: 's1', url: 'https://example.com/next' }, exec())

    await expect(tool(harness, 'browser_find').execute({ session_id: 's1', query: 'submit' }, exec()))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
  })

  it('renders find output with the untrusted-content notice', () => {
    const blocks = tool(harness, 'browser_find').output.render({ session_id: 's1' }, {
      session_id: 's1',
      truncated: false,
      matches: [{ ref: 'e1', role: 'button', name: 'Submit', line: '- button "Submit" [ref=e1]' }],
    } as never)

    const text = String((blocks[0] as { text: string }).text)
    expect(text).toContain('[ref=e1]')
    expect(text).toContain('untrusted')
  })

  it('forwards locate with ref and optional flags, mapping the result to snake_case', async () => {
    const definition = tool(harness, 'browser_locate')
    const value = await definition.execute({ session_id: 's1', ref: 'e1', highlight: true }, exec())

    expect(harness.browserCalls).toEqual([
      { method: 'locate', args: { sessionId: 's1', ref: 'e1', highlight: true } },
    ])
    expect(value).toEqual({
      session_id: 's1',
      ref: 'e1',
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      centered: false,
      in_viewport: true,
    })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])
  })

  it('forwards scroll=false and lets stale-ref failures surface untouched', async () => {
    const definition = tool(harness, 'browser_locate')
    await definition.execute({ session_id: 's1', ref: 'e1', scroll: false }, exec())
    expect(harness.browserCalls).toEqual([
      { method: 'locate', args: { sessionId: 's1', ref: 'e1', scroll: false } },
    ])

    harness.failLocate = Object.assign(new Error('ref belongs to an obsolete epoch'), { code: 'BROWSER_STALE_REF' })
    await expect(definition.execute({ session_id: 's1', ref: 'e1' }, exec())).rejects.toThrow('obsolete epoch')
  })

  it('renders locate output with the fresh-measurement note', () => {
    const blocks = tool(harness, 'browser_locate').output.render({ session_id: 's1' }, {
      session_id: 's1',
      ref: 'e1',
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      centered: true,
    } as never)

    const text = String((blocks[0] as { text: string }).text)
    expect(text).toContain('100x40')
    expect(text).toContain('measured fresh')
  })
})

describe('2026-09-14 五个场景报告的逐条修复', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('#2 long-page truncation is explainable and the budget can be raised', async () => {
    const definition = tool(harness, 'browser_snapshot')
    const value = await definition.execute({ session_id: 's1', max_lines: 2_000 }, exec())

    expect(harness.browserCalls).toEqual([
      { method: 'observe', args: { kind: 'snapshot', sessionId: 's1', maxLines: 2_000 } },
    ])
    expect(value).toMatchObject({ outline_lines: 1, truncated: false })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])

    const blocks = definition.output.render({}, {
      session_id: 's1',
      url: SESSION.url,
      title: SESSION.title,
      epoch: 4,
      outline: ['- button "A" [ref=e1]', '- button "B" [ref=e2]'].join('\n'),
      truncated: true,
      outline_lines: 800,
      dropped_elements: 412,
      refs: [{ ref: 'e1', role: 'button', name: 'A' }],
    } as never)
    const text = String((blocks[0] as { text: string }).text)
    expect(text).toContain('after 800 lines')
    expect(text).toContain('412 further element(s)')
    expect(text).toContain('max_lines')
  })

  it('#5/#9 a snapshot with zero refs says there is nothing actionable', () => {
    const blocks = tool(harness, 'browser_snapshot').output.render({ session_id: 's1' }, {
      session_id: 's1',
      url: 'https://the-internet.herokuapp.com/windows/new',
      title: 'New Window',
      epoch: 7,
      outline: '- heading "New Window"',
      truncated: false,
      outline_lines: 1,
      refs: [],
    } as never)

    const text = String((blocks[0] as { text: string }).text)
    expect(text).toContain('NO actionable elements')
    expect(text).toContain('scroll without a ref')
  })

  it('#9 an empty title is spelled out instead of silently omitted', () => {
    const session = tool(harness, 'browser_navigate').output.render(
      { session_id: 's1' },
      { session_id: 's1', url: 'https://httpbin.org/html', title: '', epoch: 2 } as never,
    )
    expect(String((session[0] as { text: string }).text)).toContain('title: (empty')

    const snapshot = tool(harness, 'browser_snapshot').output.render({ session_id: 's1' }, {
      session_id: 's1', url: 'https://httpbin.org/html', title: '', epoch: 2,
      outline: '- text "hi"', truncated: false, outline_lines: 1, refs: [],
    } as never)
    expect(String((snapshot[0] as { text: string }).text)).toContain('title: (empty')
  })

  it('#4 browser_scroll no longer needs a ref: it can scroll at the viewport centre', async () => {
    const definition = tool(harness, 'browser_scroll')
    const value = await definition.execute({ session_id: 's1', delta_y: 300 }, exec())

    expect(harness.browserCalls).toEqual([
      { method: 'mutate', args: { kind: 'scroll', sessionId: 's1', deltaY: 300 } },
    ])
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])

    // 带 ref 时行为不变。
    harness.browserCalls.length = 0
    await definition.execute({ session_id: 's1', ref: 'e1', delta_y: 300 }, exec())
    expect(harness.browserCalls).toEqual([
      { method: 'mutate', args: { kind: 'scroll', sessionId: 's1', ref: 'e1', deltaY: 300 } },
    ])
  })

  it('#3 locate does not scroll the viewport by default and reports in_viewport', async () => {
    const definition = tool(harness, 'browser_locate')
    const value = await definition.execute({ session_id: 's1', ref: 'e1' }, exec())

    expect(harness.browserCalls).toEqual([{ method: 'locate', args: { sessionId: 's1', ref: 'e1' } }])
    expect(value).toMatchObject({ centered: false, in_viewport: true })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])

    const text = String((definition.output.render({}, value as never)[0] as { text: string }).text)
    expect(text).toContain('WITHOUT scrolling the viewport')
    expect(text).toContain('inside the viewport')
  })

  it('#8 console / network default to the current document and say how much they hid', async () => {
    const consoleValue = await tool(harness, 'browser_console')
      .execute({ session_id: 's1', all_documents: true }, exec())
    expect(harness.browserCalls[0]).toEqual({
      method: 'console',
      args: { sessionId: 's1', allDocuments: true },
    })
    expect(consoleValue).toMatchObject({ document: 1, earlier_documents: 3 })

    const consoleText = String((tool(harness, 'browser_console').output.render({}, consoleValue as never)[0] as { text: string }).text)
    expect(consoleText).toContain('earlier document')
    expect(consoleText).toContain('all_documents=true')

    const networkValue = await tool(harness, 'browser_network')
      .execute({ session_id: 's1', action: 'list' }, exec())
    expect(networkValue).toMatchObject({ document: 1, earlier_documents: 2 })
    const networkText = String((tool(harness, 'browser_network').output.render({}, networkValue as never)[0] as { text: string }).text)
    expect(networkText).toContain('earlier document')
    expect(networkText).toContain('all_documents=true')
  })
})
