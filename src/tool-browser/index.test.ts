import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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
  /** 置 true 让 `mutate` 报 `navigated:true`（模拟点击跳走了页面）。 */
  mutateNavigated: boolean
  /** `mutate` 结果里的 sessionId；默认 s1，用来断言只丢导航的那一个会话。 */
  mutateSessionId: string
  /** 置 true 让 `execute` 报 `navigated:true`（模拟表达式改了 location）。 */
  executeNavigated: boolean
  /**
   * console / network list 的桩要模拟哪种截断：
   * `limit` 是「条数到了」，`budget` 是「总量到了」。用来验证工具层的建议
   * **分得清**「调大 limit 有用」和「调大没用、得过滤」。
   */
  truncation: 'none' | 'limit' | 'budget'
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
 * 用只实现被用到的那几个方法的桩上下文挂上 webpage-tools。
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
    mutateNavigated: false,
    mutateSessionId: 's1',
    executeNavigated: false,
    truncation: 'none',
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
          sessionId: harness.mutateSessionId,
          action: args.kind,
          epoch: 4,
          url: SESSION.url,
          title: SESSION.title,
          navigated: harness.mutateNavigated,
          ...args.kind === 'wait' ? { satisfied: true } : {},
          ...harness.openedTabs !== undefined ? { openedTabs: harness.openedTabs } : {},
        })
      },
      observe: (args: { kind: string; sessionId?: string }) => {
        browserCalls.push({ method: 'observe', args })
        if (harness.failObserve !== undefined) return Promise.reject(harness.failObserve)
        const observation: BrowserObservation = args.kind === 'snapshot' ? harness.snapshotResponse : SCREENSHOT
        // snapshot 的返回体决定 find 缓存的 key —— 桩要能跟着请求的 sessionId 走，
        // 否则「只丢导航的那个会话」这种回归没法在工具层断言。
        return Promise.resolve(
          args.sessionId === undefined || args.sessionId === 's1'
            ? observation
            : { ...observation, sessionId: args.sessionId } as BrowserObservation,
        )
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
      revalidate: (args: { sessionId: string; refs: string[] }) => {
        browserCalls.push({ method: 'revalidate', args })
        return Promise.resolve({
          kind: 'revalidate',
          sessionId: args.sessionId,
          epoch: 4,
          restored: args.refs.map(ref => ({ ref, role: 'button', name: 'Submit' })),
          failed: [],
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
          truncated: harness.truncation !== 'none',
          replayTruncated: true,
          document: 1,
          earlierDocuments: 3,
          truncatedByBudget: harness.truncation === 'budget',
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
            truncated: harness.truncation !== 'none',
            truncatedByBudget: harness.truncation === 'budget',
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
          navigated: harness.executeNavigated,
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
      'webpage_click',
      'webpage_console',
      'webpage_execute',
      'webpage_fill',
      'webpage_find',
      'webpage_locate',
      'webpage_navigate',
      'webpage_network',
      'webpage_open',
      'webpage_press',
      'webpage_revalidate',
      'webpage_screenshot',
      'webpage_scroll',
      'webpage_snapshot',
      'webpage_tabs',
      'webpage_wait',
    ])
  })

  it('classifies read vs mutate tools in the capability metadata', () => {
    expect(BROWSER_TOOL_CAPABILITIES).toMatchObject({
      webpage_open: 'read',
      webpage_navigate: 'read',
      webpage_snapshot: 'read',
      webpage_screenshot: 'read',
      webpage_wait: 'read',
      // P2：console / network 是纯读采集；execute 的允许列表里有 Page.navigate，归 mutate。
      webpage_console: 'read',
      webpage_network: 'read',
      webpage_execute: 'mutate',
      // P3：find 是纯本地检索；locate 只观察（scrollIntoView 是观察辅助，不是页面操作）。
      webpage_find: 'read',
      webpage_locate: 'read',
      webpage_revalidate: 'read',
      webpage_tabs: 'mutate',
      webpage_click: 'mutate',
      webpage_fill: 'mutate',
      webpage_press: 'mutate',
      webpage_scroll: 'mutate',
    })
    // 元数据必须覆盖全部已注册工具，新工具进来忘了分级会在这里炸。
    expect(Object.keys(BROWSER_TOOL_CAPABILITIES).sort()).toEqual([...mount().tools.keys()].sort())
  })

  it('declares the plugin name and a section order right above the web tools', () => {
    expect(pluginName).toBe('webpage-tools')
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
    expect(text).toContain('webpage_snapshot')
    expect(text).toContain('webpage_revalidate')
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
      console: false, network: false, execute: false, find: false, locate: false, revalidate: false,
    })

    expect([...tools.keys()].sort()).toEqual(['webpage_navigate', 'webpage_open'])
  })
})

describe('argument and output contracts', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('rejects arguments that violate the declared schema', async () => {
    await expect(tool(harness, 'webpage_snapshot').execute({}, exec())).rejects.toThrow(/session_id/u)
  })

  it('rejects a screenshot asking for a ref and the full page at once', async () => {
    await expect(tool(harness, 'webpage_screenshot').execute({ session_id: 's1', ref: 'e1', full_page: true }, exec()))
      .rejects.toThrow(/mutually exclusive/u)
  })

  it('forwards the session id and url to ctx.browser.navigate', async () => {
    const value = await tool(harness, 'webpage_navigate').execute(
      { session_id: 's1', url: 'https://example.com/next' },
      exec(),
    )

    expect(harness.browserCalls).toEqual([
      { method: 'navigate', args: { sessionId: 's1', url: 'https://example.com/next' } },
    ])
    expect(value).toEqual({ session_id: 's1', url: 'https://example.com/', title: 'Example', epoch: 4 })
  })

  it('omits the url entirely when the model opens a blank page', async () => {
    await tool(harness, 'webpage_open').execute({}, exec())
    expect(harness.browserCalls).toEqual([{ method: 'open', args: {} }])
  })

  it('passes a snapshot through the seam and returns its refs', async () => {
    const value = await tool(harness, 'webpage_snapshot').execute({ session_id: 's1' }, exec())

    expect(harness.browserCalls).toEqual([
      { method: 'observe', args: { kind: 'snapshot', sessionId: 's1' } },
    ])
    expect(value).toMatchObject({ session_id: 's1', epoch: 4, refs: [{ ref: 'e1', role: 'button', name: 'Submit' }] })
    expect(value).toSatisfy((candidate: unknown) =>
      validateJsonSchemaValue(tool(harness, 'webpage_snapshot').output.schema, candidate).length === 0)
  })

  it('renders the outline together with the ref lifetime warning', () => {
    const definition = tool(harness, 'webpage_snapshot')
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

  it('forwards webpage_revalidate refs and returns restored numbers', async () => {
    const value = await tool(harness, 'webpage_revalidate').execute(
      { session_id: 's1', refs: ['e1', 'e2'] },
      exec(),
    )
    expect(harness.browserCalls).toEqual([
      { method: 'revalidate', args: { sessionId: 's1', refs: ['e1', 'e2'] } },
    ])
    expect(value).toEqual({
      session_id: 's1',
      epoch: 4,
      restored: [
        { ref: 'e1', role: 'button', name: 'Submit' },
        { ref: 'e2', role: 'button', name: 'Submit' },
      ],
      failed: [],
    })
  })

  it('rejects combining region_ref with region_viewport', async () => {
    await expect(tool(harness, 'webpage_snapshot').execute(
      { session_id: 's1', region_ref: 'e1', region_viewport: true },
      exec(),
    )).rejects.toThrow(/mutually exclusive/u)
  })

  it('forwards region_viewport to observe', async () => {
    await tool(harness, 'webpage_snapshot').execute(
      { session_id: 's1', region_viewport: true },
      exec(),
    )
    expect(harness.browserCalls).toEqual([
      { method: 'observe', args: { kind: 'snapshot', sessionId: 's1', region: { viewport: true } } },
    ])
  })

  it('tells click to recover via revalidate before a fresh snapshot', () => {
    expect(String(tool(harness, 'webpage_click').description)).toContain('webpage_revalidate')
  })
})

describe('webpage_tabs and the P1 mutation tools', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('forwards list / activate / close to ctx.browser.tabs', async () => {
    const definition = tool(harness, 'webpage_tabs')
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
    const definition = tool(harness, 'webpage_tabs')
    await expect(definition.execute({ action: 'activate' }, exec())).rejects.toThrow(/session_id/u)
    await expect(definition.execute({ action: 'reboot', session_id: 's1' }, exec())).rejects.toThrow(/list, activate, close/u)
  })

  it('forwards click with the ref and reports the resulting epoch', async () => {
    const definition = tool(harness, 'webpage_click')
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
    await tool(harness, 'webpage_fill').execute({ session_id: 's1', ref: 'e1', value: 'hi' }, exec())
    await tool(harness, 'webpage_press').execute({ session_id: 's1', ref: 'e1', key: 'Enter' }, exec())
    await tool(harness, 'webpage_scroll').execute({ session_id: 's1', ref: 'e1', delta_y: 300 }, exec())

    expect(harness.browserCalls).toEqual([
      { method: 'mutate', args: { kind: 'fill', sessionId: 's1', ref: 'e1', value: 'hi' } },
      { method: 'mutate', args: { kind: 'press', sessionId: 's1', ref: 'e1', key: 'Enter' } },
      { method: 'mutate', args: { kind: 'scroll', sessionId: 's1', ref: 'e1', deltaY: 300 } },
    ])
  })

  it('wait reports satisfied; the "exactly one condition" rule is enforced in the provider', async () => {
    const value = await tool(harness, 'webpage_wait').execute({ session_id: 's1', time_ms: 5 }, exec())
    expect(value).toMatchObject({ action: 'wait', satisfied: true })
    expect(harness.browserCalls).toEqual([{ method: 'mutate', args: { kind: 'wait', sessionId: 's1', timeMs: 5 } }])
  })

  it('wait until=stable forwards until and timeout_ms', async () => {
    await tool(harness, 'webpage_wait').execute({ session_id: 's1', until: 'stable', timeout_ms: 20_000 }, exec())
    expect(harness.browserCalls).toEqual([{
      method: 'mutate',
      args: { kind: 'wait', sessionId: 's1', until: 'stable', timeoutMs: 20_000 },
    }])
  })

  it('renders a navigated mutation with the re-snapshot instruction', async () => {
    const definition = tool(harness, 'webpage_click')
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
    expect(text).toContain('webpage_snapshot')
    expect(text).toContain('untrusted')
  })

  it('surfaces a popup the click opened as opened_tabs (snake_case, schema-valid)', async () => {
    harness.openedTabs = [{
      sessionId: 't2',
      url: 'https://example.com/hot-5',
      title: '热搜第五条',
    }]

    const value = await tool(harness, 'webpage_click').execute({ session_id: 's1', ref: 'e1' }, exec())

    expect(value).toMatchObject({
      session_id: 's1',
      // 回执里的**原会话不变**：新标签页是并存，不是替换。
      url: SESSION.url,
      opened_tabs: [{ session_id: 't2', url: 'https://example.com/hot-5', title: '热搜第五条' }],
    })
    // required 之外的字段一旦出现，必须能被工具输出契约接受。
    expect(validateJsonSchemaValue(tool(harness, 'webpage_click').output.schema, value)).toEqual([])
  })

  it('renders the new tab(s) prominently so the model stops assuming a single tab', async () => {
    const blocks = tool(harness, 'webpage_click').output.render({ session_id: 's1' }, {
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
    const alsoNavigated = String((tool(harness, 'webpage_click').output.render({ session_id: 's1' }, {
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
    const plain = tool(harness, 'webpage_click').output.render({ session_id: 's1' }, {
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

describe('webpage_screenshot', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('stores the PNG as an attachment and returns an image content block', async () => {
    const definition = tool(harness, 'webpage_screenshot')
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
    await tool(harness, 'webpage_screenshot').execute({ session_id: 's1', ref: 'e1' }, exec())
    expect(harness.browserCalls).toEqual([
      { method: 'observe', args: { kind: 'screenshot', sessionId: 's1', ref: 'e1' } },
    ])
  })

  it('reports the provider failure instead of inventing an image', async () => {
    const failure = Object.assign(new Error('ref belongs to an obsolete epoch'), { code: 'BROWSER_STALE_REF' })
    harness.failObserve = failure

    await expect(tool(harness, 'webpage_screenshot').execute({ session_id: 's1', ref: 'e1' }, exec()))
      .rejects.toThrow('ref belongs to an obsolete epoch')
    expect(harness.savedImages).toEqual([])
  })
})

describe('webpage_console / webpage_network / webpage_execute', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  it('forwards console filters and maps replayTruncated to snake_case', async () => {
    const definition = tool(harness, 'webpage_console')
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
    const definition = tool(harness, 'webpage_network')
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
    await expect(tool(harness, 'webpage_network').execute({ session_id: 's1', action: 'replay' }, exec()))
      .rejects.toThrow(/list, body/u)
  })

  it('forwards the whitelisted CDP command with its params and returns the value', async () => {
    const definition = tool(harness, 'webpage_execute')
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

describe('webpage_find / webpage_locate (P3)', () => {
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
    const definition = tool(harness, 'webpage_find')
    await expect(definition.execute({ session_id: 's1', query: 'submit' }, exec()))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))

    await tool(harness, 'webpage_snapshot').execute({ session_id: 's1' }, exec())
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
    await tool(harness, 'webpage_snapshot').execute({ session_id: 's1' }, exec())
    const definition = tool(harness, 'webpage_find')

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
    await tool(harness, 'webpage_snapshot').execute({ session_id: 's1' }, exec())

    const value = await tool(harness, 'webpage_find')
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
    await tool(harness, 'webpage_snapshot').execute({ session_id: 's1' }, exec())
    const value = await tool(harness, 'webpage_find')
      .execute({ session_id: 's1', query: 'link "5 ' }, exec()) as FindResultView
    expect(value.matches).toHaveLength(1)
    expect(value.matches[0]).toMatchObject({ ref: 'e35', role: 'link' })
  })

  it('drops the cached outline on navigate so stale refs cannot be searched', async () => {
    await tool(harness, 'webpage_snapshot').execute({ session_id: 's1' }, exec())
    await tool(harness, 'webpage_navigate').execute({ session_id: 's1', url: 'https://example.com/next' }, exec())

    await expect(tool(harness, 'webpage_find').execute({ session_id: 's1', query: 'submit' }, exec()))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
  })

  it('renders find output with the untrusted-content notice', () => {
    const blocks = tool(harness, 'webpage_find').output.render({ session_id: 's1' }, {
      session_id: 's1',
      truncated: false,
      matches: [{ ref: 'e1', role: 'button', name: 'Submit', line: '- button "Submit" [ref=e1]' }],
    } as never)

    const text = String((blocks[0] as { text: string }).text)
    expect(text).toContain('[ref=e1]')
    expect(text).toContain('untrusted')
  })

  it('forwards locate with ref and optional flags, mapping the result to snake_case', async () => {
    const definition = tool(harness, 'webpage_locate')
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
    const definition = tool(harness, 'webpage_locate')
    await definition.execute({ session_id: 's1', ref: 'e1', scroll: false }, exec())
    expect(harness.browserCalls).toEqual([
      { method: 'locate', args: { sessionId: 's1', ref: 'e1', scroll: false } },
    ])

    harness.failLocate = Object.assign(new Error('ref belongs to an obsolete epoch'), { code: 'BROWSER_STALE_REF' })
    await expect(definition.execute({ session_id: 's1', ref: 'e1' }, exec())).rejects.toThrow('obsolete epoch')
  })

  it('renders locate output with the fresh-measurement note', () => {
    const blocks = tool(harness, 'webpage_locate').output.render({ session_id: 's1' }, {
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
    const definition = tool(harness, 'webpage_snapshot')
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
    const blocks = tool(harness, 'webpage_snapshot').output.render({ session_id: 's1' }, {
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
    const session = tool(harness, 'webpage_navigate').output.render(
      { session_id: 's1' },
      { session_id: 's1', url: 'https://httpbin.org/html', title: '', epoch: 2 } as never,
    )
    expect(String((session[0] as { text: string }).text)).toContain('title: (empty')

    const snapshot = tool(harness, 'webpage_snapshot').output.render({ session_id: 's1' }, {
      session_id: 's1', url: 'https://httpbin.org/html', title: '', epoch: 2,
      outline: '- text "hi"', truncated: false, outline_lines: 1, refs: [],
    } as never)
    expect(String((snapshot[0] as { text: string }).text)).toContain('title: (empty')
  })

  it('#4 webpage_scroll no longer needs a ref: it can scroll at the viewport centre', async () => {
    const definition = tool(harness, 'webpage_scroll')
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
    const definition = tool(harness, 'webpage_locate')
    const value = await definition.execute({ session_id: 's1', ref: 'e1' }, exec())

    expect(harness.browserCalls).toEqual([{ method: 'locate', args: { sessionId: 's1', ref: 'e1' } }])
    expect(value).toMatchObject({ centered: false, in_viewport: true })
    expect(validateJsonSchemaValue(definition.output.schema, value)).toEqual([])

    const text = String((definition.output.render({}, value as never)[0] as { text: string }).text)
    expect(text).toContain('WITHOUT scrolling the viewport')
    expect(text).toContain('inside the viewport')
  })

  it('#8 console / network default to the current document and say how much they hid', async () => {
    const consoleValue = await tool(harness, 'webpage_console')
      .execute({ session_id: 's1', all_documents: true }, exec())
    expect(harness.browserCalls[0]).toEqual({
      method: 'console',
      args: { sessionId: 's1', allDocuments: true },
    })
    expect(consoleValue).toMatchObject({ document: 1, earlier_documents: 3 })

    const consoleText = String((tool(harness, 'webpage_console').output.render({}, consoleValue as never)[0] as { text: string }).text)
    expect(consoleText).toContain('earlier document')
    expect(consoleText).toContain('all_documents=true')

    const networkValue = await tool(harness, 'webpage_network')
      .execute({ session_id: 's1', action: 'list' }, exec())
    expect(networkValue).toMatchObject({ document: 1, earlier_documents: 2 })
    const networkText = String((tool(harness, 'webpage_network').output.render({}, networkValue as never)[0] as { text: string }).text)
    expect(networkText).toContain('earlier document')
    expect(networkText).toContain('all_documents=true')
  })

  it('#10 a SIZE BUDGET cut must not suggest raising limit — that advice would be a lie', async () => {
    const render = (name: string, value: unknown): string =>
      String((tool(harness, name).output.render({}, value as never)[0] as { text: string }).text)

    // 被总量预算截断：调大 limit 拿不到更多，必须改口成「过滤」。
    harness.truncation = 'budget'
    const consoleValue = await tool(harness, 'webpage_console').execute({ session_id: 's1' }, exec())
    expect(consoleValue).toMatchObject({ truncated: true, truncated_by_budget: true })
    const consoleText = render('webpage_console', consoleValue)
    expect(consoleText).toContain('raising limit will not add more')
    expect(consoleText).toContain('level/text')

    const networkValue = await tool(harness, 'webpage_network')
      .execute({ session_id: 's1', action: 'list' }, exec())
    expect(networkValue).toMatchObject({ truncated: true, truncated_by_budget: true })
    const networkText = render('webpage_network', networkValue)
    expect(networkText).toContain('raising limit will not add more')
    expect(networkText).toContain('url')

    // 只是被 limit 截断：这时「调大 limit 有用」，给的是另一条建议。两条路不能混。
    harness.truncation = 'limit'
    const byLimit = await tool(harness, 'webpage_network')
      .execute({ session_id: 's1', action: 'list' }, exec())
    expect(byLimit).toMatchObject({ truncated: true, truncated_by_budget: false })
    const byLimitText = render('webpage_network', byLimit)
    expect(byLimitText).toContain('higher limit')
    expect(byLimitText).not.toContain('will not add more')
  })

  it('#10 a base64 body is spelled out as binary noise instead of being silently dumped', () => {
    const text = String((tool(harness, 'webpage_network').output.render({}, {
      session_id: 's1',
      action: 'body',
      requests: [],
      request_id: 'req-1',
      body: 'iVBORw0KGgo=',
      base64_encoded: true,
      truncated: true,
    } as never)[0] as { text: string }).text)

    expect(text).toContain('base64-encoded')
    expect(text).toContain('binary')
    expect(text).toContain('webpage_screenshot')
    // 不能建议「再取一次」—— 再取一次是同样的噪声。
    expect(text).toContain('Do NOT request it again')
  })
})

describe('2026-09-17 导航后 find 缓存必须失效', () => {
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  /** 先让某个会话有一份缓存大纲：snapshot 一次就是缓存写入的全部途径。 */
  async function cacheSnapshot(sessionId = 's1'): Promise<void> {
    await tool(harness, 'webpage_snapshot').execute({ session_id: sessionId }, exec())
  }

  it('#1 a click that navigates drops the cached outline (find then asks for a fresh snapshot)', async () => {
    await cacheSnapshot()
    harness.mutateNavigated = true
    await tool(harness, 'webpage_click').execute({ session_id: 's1', ref: 'e1' }, exec())

    await expect(tool(harness, 'webpage_find').execute({ session_id: 's1', query: 'submit' }, exec()))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
  })

  it('#1 an execute that navigates drops the cached outline too', async () => {
    await cacheSnapshot()
    harness.executeNavigated = true
    await tool(harness, 'webpage_execute').execute(
      { session_id: 's1', method: 'Runtime.evaluate', params: { expression: 'location.href="/x"' } },
      exec(),
    )

    await expect(tool(harness, 'webpage_find').execute({ session_id: 's1', query: 'submit' }, exec()))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
  })

  it('#1 a NON-navigating mutation keeps the outline (no needless re-snapshot)', async () => {
    await cacheSnapshot()
    await tool(harness, 'webpage_click').execute({ session_id: 's1', ref: 'e1' }, exec())

    const value = await tool(harness, 'webpage_find').execute({ session_id: 's1', query: 'submit' }, exec())
    expect(value).toMatchObject({ session_id: 's1', matches: [{ ref: 'e1' }] })
  })

  it('#1 only the session that navigated is dropped, the others keep their outline', async () => {
    await cacheSnapshot('s1')
    await cacheSnapshot('s2')
    harness.mutateNavigated = true
    harness.mutateSessionId = 's1'
    await tool(harness, 'webpage_click').execute({ session_id: 's1', ref: 'e1' }, exec())

    // s1 跳走了 —— 它的旧大纲不能再用。
    await expect(tool(harness, 'webpage_find').execute({ session_id: 's1', query: 'submit' }, exec()))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_SNAPSHOT_REQUIRED' }))
    // s2 没动过 —— 整表清空的实现会在这里露馅。
    await expect(tool(harness, 'webpage_find').execute({ session_id: 's2', query: 'submit' }, exec()))
      .resolves.toMatchObject({ session_id: 's2', matches: [{ ref: 'e1' }] })
  })
})

describe('2026-09-17 工具清单必须单点真相', () => {
  // 2026-09-17：`scripts/check-desktop.mjs` 里写死 `EXPECTED_TOOL_VIEWS = 10`，
  // 而清单早就 15 个 —— 魔数过期脚本恒红，还因为没进 CI 一直没人发现。
  // 这条测试让「客户端要渲染的卡片」与「工具层真正注册的工具」必须对得上，
  // 从此任一侧增删工具都会在这里转红，而不是等到有人手工跑 check:desktop。
  it('client 的 BROWSER_TOOLS 与 BROWSER_TOOL_CAPABILITIES 同名同数', () => {
    const source = readFileSync(new URL('../client/index.ts', import.meta.url), 'utf8')
    const match = /export const BROWSER_TOOLS = \[([\s\S]*?)\] as const/u.exec(source)
    if (match === null) throw new Error('没能在 src/client/index.ts 里找到 BROWSER_TOOLS 清单')

    const body = match[1] ?? ''
    const clientTools = [...body.matchAll(/'([^']+)'/gu)]
      .map(found => found[1] ?? '')
      .filter(name => name !== '')
      .sort()
    expect(clientTools).toEqual(Object.keys(BROWSER_TOOL_CAPABILITIES).sort())
    expect(clientTools.length).toBeGreaterThan(0)
  })
})

describe('2026-09-17 回执与卡片文本的护栏', () => {
  // 这批断言是为一次事故立的：那天用正则批量把描述里的数字换成常量插值，
  // 正则连**代码里的字符串**一起改了 —— 反引号被塞进字符串内部，语法照样合法、
  // tsc 照样过、当时所有测试照样绿，但模型收到的回执里 session_id / url / title 全没了。
  // 所以这里专门盯「模型直接读的那几段文本」的完整内容，而不是只测「不抛错」。
  const harness = mount()

  it('tabs 的 activate / close 回执带上 session_id（正则曾把它整段吃掉）', () => {
    const value = {
      session_id: 's1',
      action: 'close',
      tabs: [{ session_id: 't2', url: 'https://example.com/hot-5', title: 'Hot 5', active: false }],
    }
    const blocks = tool(harness, 'webpage_tabs').output.render({ session_id: 's1' }, value as never)
    const text = String((blocks[0] as { text: string }).text)

    expect(text).toContain('Closed session_id=s1')
    expect(text).toContain('session_id=t2')
    expect(text).toContain('https://example.com/hot-5')
    expect(text).toContain('Hot 5')
    // 反引号漏进输出的典型症状：把模板占位符当字面量吐出来。
    expect(text).not.toContain('${')
    expect(text).not.toContain('`')
  })

  it('press 的待执行卡片标题带上 key 与 ref（正则曾让它们变成 undefined）', () => {
    const definition = tool(harness, 'webpage_press')
    if (definition.presentCall === undefined) throw new Error('webpage_press 没有 presentCall')
    const title = definition.presentCall({
      session_id: 's1',
      ref: 'e12',
      key: 'Enter',
    } as never)

    expect(JSON.stringify(title)).toContain('Enter')
    expect(JSON.stringify(title)).toContain('e12')
    expect(JSON.stringify(title)).not.toContain('undefined')
  })
})

describe('2026-09-18 折叠：find 必须能拿回被折叠的实例，并说清是哪一条', () => {
  // 折叠把「点哪个」的决策转嫁给 find。这条链路一旦断，折叠就从「省密度」变成「更难用」：
  // 模型看到一行标记 + 12 个文本完全相同的实例，不知道点哪个，只能重新 snapshot 把上下文再烧一遍。
  let harness: Harness

  beforeEach(() => {
    harness = mount()
  })

  interface FoldedFindView {
    session_id: string
    truncated: boolean
    matches: { ref: string; role: string; name: string; line: string; context?: string }[]
  }

  /** 折叠前的底稿：4 条结果各带一个同名按钮（文本完全一样，只能靠上下文区分）。 */
  const FULL_OUTLINE = [
    '- list',
    '  - listitem',
    '    - link "Rust 官方文档" [ref=e1]',
    '    - text "Rust 是一门系统编程语言"',
    '    - button "翻译此页" [ref=e5]',
    '  - listitem',
    '    - link "Rust 圣经" [ref=e2]',
    '    - text "在线中文版 Rust 教程"',
    '    - button "翻译此页" [ref=e6]',
    '  - listitem',
    '    - link "Rust 中文社区" [ref=e3]',
    '    - text "社区与文档索引"',
    '    - button "翻译此页" [ref=e7]',
    '  - listitem',
    '    - link "Rust 论坛" [ref=e4]',
    '    - text "用户讨论区"',
    '    - button "翻译此页" [ref=e8]',
  ].join('\n')

  /** 模型看到的那份：(role, name) 出现 4 次 → 只留首个 + 一行标记。 */
  const FOLDED_OUTLINE = [
    '- list',
    '  - listitem',
    '    - link "Rust 官方文档" [ref=e1]',
    '    - text "Rust 是一门系统编程语言"',
    '    - button "翻译此页" [ref=e5]',
    '    - (folded) button "翻译此页" ×4 — 3 more not shown; webpage_find lists all 4 with their refs',
    '  - listitem',
    '    - link "Rust 圣经" [ref=e2]',
    '    - text "在线中文版 Rust 教程"',
    '  - listitem',
    '    - link "Rust 中文社区" [ref=e3]',
    '    - text "社区与文档索引"',
    '  - listitem',
    '    - link "Rust 论坛" [ref=e4]',
    '    - text "用户讨论区"',
  ].join('\n')

  const REFS = [
    { ref: 'e1', role: 'link', name: 'Rust 官方文档' },
    { ref: 'e2', role: 'link', name: 'Rust 圣经' },
    { ref: 'e3', role: 'link', name: 'Rust 中文社区' },
    { ref: 'e4', role: 'link', name: 'Rust 论坛' },
    { ref: 'e5', role: 'button', name: '翻译此页' },
    { ref: 'e6', role: 'button', name: '翻译此页' },
    { ref: 'e7', role: 'button', name: '翻译此页' },
    { ref: 'e8', role: 'button', name: '翻译此页' },
  ]

  /** 装上「折叠后的模型视图 + 折叠前的 find 底稿」这一对 observation。 */
  async function snapshotFolded(): Promise<{ outline: string; folded_repeats?: number; outline_lines?: number }> {
    harness.snapshotResponse = {
      ...SNAPSHOT,
      outline: FOLDED_OUTLINE,
      fullOutline: FULL_OUTLINE,
      foldedRepeats: 3,
      outlineLines: 14,
      refs: REFS,
    }
    return await tool(harness, 'webpage_snapshot').execute({ session_id: 's1' }, exec()) as
      { outline: string; folded_repeats?: number; outline_lines?: number }
  }

  it('reports the folding without calling it truncation', async () => {
    const output = await snapshotFolded()

    expect(output.outline).toContain('(folded) button "翻译此页" ×4')
    expect(output.folded_repeats).toBe(3)
    const text = String((tool(harness, 'webpage_snapshot').output.render({ session_id: 's1' }, output as never)[0] as { text: string }).text)
    // 折叠与截断是两码事：折叠的元素**没丢**，说成截断会把模型推去抬 max_lines（对折叠毫无作用）。
    expect(text).toContain('3 repeated row(s) were folded')
    expect(text).toContain('Nothing was lost')
    expect(text).not.toContain('was truncated')
  })

  it('explains a same-name-chain dedup as "not printed", not as truncation', async () => {
    harness.snapshotResponse = { ...SNAPSHOT, dedupedLines: 11, refs: REFS }
    const output = await tool(harness, 'webpage_snapshot').execute({ session_id: 's1' }, exec()) as
      { deduped_lines?: number }

    expect(output.deduped_lines).toBe(11)
    const text = String((tool(harness, 'webpage_snapshot').output.render({ session_id: 's1' }, output as never)[0] as { text: string }).text)
    // 去重同样不是截断：名字已经由保留的那行印出来了，说成截断会让模型去抬 max_lines（毫无作用）。
    expect(text).toContain('11 nested duplicate row(s) were not printed')
    expect(text).toContain('Nothing was lost')
    expect(text).not.toContain('was truncated')
  })

  it('finds the 3 instances the model never saw, each with its own ref and context', async () => {
    await snapshotFolded()

    const value = await tool(harness, 'webpage_find')
      .execute({ session_id: 's1', query: '翻译此页' }, exec()) as FoldedFindView

    // 4 个实例全部命中 —— 折叠承诺的「用 find 拿全部实例的 ref」必须兑现。
    expect(value.matches.map(match => match.ref)).toEqual(['e5', 'e6', 'e7', 'e8'])
    // 标记行不在底稿里，所以不会冒出一条没有 ref 的幻影命中。
    expect(value.matches.every(match => match.role === 'button')).toBe(true)
    // 文本完全相同的 4 行，靠所属上下文才分得清是「哪一条结果的按钮」。
    expect(value.matches.map(match => match.context)).toEqual([
      'text "Rust 是一门系统编程语言"',
      'text "在线中文版 Rust 教程"',
      'text "社区与文档索引"',
      'text "用户讨论区"',
    ])
    expect(validateJsonSchemaValue(tool(harness, 'webpage_find').output.schema, value)).toEqual([])
  })

  it('renders the context next to the match, and keeps the line clipped', () => {
    const view = tool(harness, 'webpage_find').output.render({ session_id: 's1' }, {
      session_id: 's1',
      truncated: false,
      matches: [
        { ref: 'e5', role: 'button', name: '翻译此页', line: '-     - button "翻译此页" [ref=e5]', context: 'text "Rust 是一门系统编程语言"' },
        { ref: '', role: '', name: '', line: '- link "Rust 圣经"' },
      ],
    } as never)

    const text = String((view[0] as { text: string }).text)
    expect(text).toContain('[e5] button "翻译此页"')
    expect(text).toContain('← context: text "Rust 是一门系统编程语言"')
    // 没有上下文的行不硬凑一个空壳字段。
    expect(text.split('\n').filter(line => line.includes('Rust 圣经'))).toHaveLength(1)
    expect(text).not.toContain('undefined')
  })

  it('falls back to the model-visible outline when a provider cannot supply the unfolded one', async () => {
    harness.snapshotResponse = { ...SNAPSHOT, outline: FOLDED_OUTLINE, foldedRepeats: 3, refs: REFS }
    await tool(harness, 'webpage_snapshot').execute({ session_id: 's1' }, exec())

    const value = await tool(harness, 'webpage_find')
      .execute({ session_id: 's1', query: '翻译此页' }, exec()) as FoldedFindView

    // 底稿退回折叠后的那份时，只有代表行能命中；标记行是插件写的注释，不会被当成命中
    // （否则会冒出一条没有 ref、点不了的幻影）。比报错好，但也不是完整能力，如实如此。
    expect(value.matches.map(match => match.ref)).toEqual(['e5'])
  })
})
