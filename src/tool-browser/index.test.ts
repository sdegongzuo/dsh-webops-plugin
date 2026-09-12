import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, name as pluginName, TOOL_BROWSER_SECTION_ORDER } from './index.ts'
import type { BrowserObservation, BrowserSession, BrowserSnapshot } from '../browser/index.ts'

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
  const harness: Harness = { tools, sections, browserCalls, savedImages, failObserve: undefined }

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
      observe: (args: { kind: string }) => {
        browserCalls.push({ method: 'observe', args })
        if (harness.failObserve !== undefined) return Promise.reject(harness.failObserve)
        const observation: BrowserObservation = args.kind === 'snapshot' ? SNAPSHOT : SCREENSHOT
        return Promise.resolve(observation)
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
  it('exposes exactly the four P0 read-only tools', () => {
    expect([...mount().tools.keys()].sort()).toEqual([
      'browser_navigate',
      'browser_open',
      'browser_screenshot',
      'browser_snapshot',
    ])
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
    apply(ctx, { snapshot: false, screenshot: false })

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
