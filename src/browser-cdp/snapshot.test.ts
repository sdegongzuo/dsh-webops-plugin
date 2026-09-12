import { describe, expect, it } from 'vitest'
import { buildOutline, DEFAULT_SNAPSHOT_LIMITS, renderOutline } from './snapshot.ts'
import type { AxNode } from './snapshot.ts'
import { RefRegistry } from './refs.ts'

/** 造一个 AX 节点；省略的字段保持缺省。 */
function node(partial: Partial<AxNode> & { nodeId: string }): AxNode {
  return {
    ignored: false,
    ...partial,
  }
}

/** `Accessibility.getFullAXTree` 的典型形状：一个 rootWebArea，下面挂 div + 表单。 */
const PAGE: AxNode[] = [
  node({
    nodeId: '1',
    role: { value: 'RootWebArea' },
    name: { value: 'Sign in' },
    childIds: ['2'],
    backendDOMNodeId: 1,
  }),
  node({ nodeId: '2', role: { value: 'generic' }, childIds: ['3', '4', '5'], backendDOMNodeId: 2 }),
  node({ nodeId: '3', role: { value: 'heading' }, name: { value: 'Welcome back' }, properties: [{ name: 'level', value: { value: 1 } }], backendDOMNodeId: 3 }),
  node({ nodeId: '4', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 4 }),
  node({ nodeId: '5', role: { value: 'button' }, name: { value: 'Sign in' }, properties: [{ name: 'disabled', value: { value: true } }], backendDOMNodeId: 5 }),
]

describe('buildOutline', () => {
  it('drops transparent layout layers from the line budget but keeps their children', () => {
    const outline = buildOutline(PAGE)
    const text = outline.lines.map(line => line.text).join('\n')

    expect(text).toContain('heading "Welcome back" level=1')
    expect(text).toContain('textbox "Email"')
    expect(text).toContain('button "Sign in" disabled')
    // RootWebArea 与 div 都是透明层：它们不该占行，子节点直接落在深度 0。
    expect(text).not.toContain('RootWebArea')
    expect(text).not.toContain('generic')
    expect(outline.lines.every(line => line.depth === 0)).toBe(true)
  })

  it('assigns refs to actionable roles only', () => {
    const outline = buildOutline(PAGE)
    expect(outline.rows).toEqual([
      { role: 'textbox', name: 'Email', backendNodeId: 4 },
      { role: 'button', name: 'Sign in', backendNodeId: 5 },
    ])
  })

  it('skips an actionable element without a backend node id, because it is not addressable', () => {
    const outline = buildOutline([
      node({ nodeId: '1', role: { value: 'button' }, name: { value: 'Ghost' } }),
    ])
    expect(outline.rows).toEqual([])
    expect(outline.lines[0]?.text).toBe('button "Ghost"')
    expect(outline.lines[0]?.targetRow).toBeUndefined()
  })

  it('renders an unnamed actionable element without a name segment', () => {
    const outline = buildOutline([node({ nodeId: '1', role: { value: 'button' }, backendDOMNodeId: 9 })])
    expect(outline.lines[0]?.text).toBe('button')
  })

  it('renders a textbox value and drops structural nodes that carry nothing', () => {
    const outline = buildOutline([
      node({ nodeId: '1', role: { value: 'paragraph' } }),
      node({ nodeId: '2', role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'a@b.c' }, backendDOMNodeId: 3 }),
      node({ nodeId: '3', role: { value: 'StaticText' }, name: { value: 'Hello   world' } }),
    ])
    expect(outline.lines.map(line => line.text)).toEqual([
      'textbox "Email" value="a@b.c"',
      'text "Hello world"',
    ])
  })

  it('keeps a link URL, which is otherwise invisible in the outline', () => {
    const outline = buildOutline([
      node({
        nodeId: '1',
        role: { value: 'link' },
        name: { value: 'Docs' },
        properties: [{ name: 'url', value: { value: 'https://example.com/docs' } }],
        backendDOMNodeId: 1,
      }),
    ])
    expect(outline.lines[0]?.text).toBe('link "Docs" url=https://example.com/docs')
  })

  it('clips a runaway name instead of letting one aria-label blow up a line', () => {
    const outline = buildOutline(
      [node({ nodeId: '1', role: { value: 'button' }, name: { value: 'x'.repeat(500) }, backendDOMNodeId: 1 })],
      { ...DEFAULT_SNAPSHOT_LIMITS, maxTextLength: 10 },
    )
    expect(outline.lines[0]?.text).toBe('button "xxxxxxxxx…"')
  })

  it('stops at maxLines and flags the truncation', () => {
    const nodes: AxNode[] = Array.from({ length: 20 }, (_unused, index) =>
      node({ nodeId: String(index), role: { value: 'button' }, name: { value: `b${index}` }, backendDOMNodeId: index }))
    const outline = buildOutline(nodes, { ...DEFAULT_SNAPSHOT_LIMITS, maxLines: 3 })

    expect(outline.lines).toHaveLength(3)
    expect(outline.truncated).toBe(true)
  })

  it('stops descending at maxDepth and flags the truncation', () => {
    const nodes: AxNode[] = [
      node({ nodeId: '1', role: { value: 'list' }, childIds: ['2'] }),
      node({ nodeId: '2', role: { value: 'list' }, childIds: ['3'] }),
      node({ nodeId: '3', role: { value: 'button' }, name: { value: 'deep' }, backendDOMNodeId: 3 }),
    ]
    const outline = buildOutline(nodes, { ...DEFAULT_SNAPSHOT_LIMITS, maxDepth: 0 })
    expect(outline.truncated).toBe(true)
  })

  it('does not loop forever on a cyclic tree', () => {
    const nodes: AxNode[] = [
      node({ nodeId: '1', role: { value: 'list' }, childIds: ['2'] }),
      node({ nodeId: '2', role: { value: 'list' }, childIds: ['1'] }),
    ]
    expect(buildOutline(nodes).lines).toHaveLength(2)
  })

  it('keeps a semantic container even when it has no name', () => {
    const nodes: AxNode[] = [
      node({ nodeId: '1', role: { value: 'list' }, childIds: ['2'] }),
      node({ nodeId: '2', role: { value: 'listitem' }, childIds: ['3'] }),
      node({ nodeId: '3', role: { value: 'StaticText' }, name: { value: 'One' } }),
    ]
    const outline = buildOutline(nodes)
    expect(outline.lines.map(line => `${'  '.repeat(line.depth)}${line.text}`)).toEqual([
      'list',
      '  listitem',
      '    text "One"',
    ])
    // 结构行不是可操作元素，不该拿到 ref。
    expect(outline.rows).toEqual([])
  })

  it('ignores child ids that are missing from the payload', () => {
    const nodes: AxNode[] = [node({ nodeId: '1', role: { value: 'list' }, childIds: ['nope'] })]
    expect(buildOutline(nodes).lines.map(line => line.text)).toEqual(['list'])
  })

  it('treats an ignored subtree as transparent rather than dropping it', () => {
    const nodes: AxNode[] = [
      node({ nodeId: '1', role: { value: 'generic' }, ignored: true, childIds: ['2'] }),
      node({ nodeId: '2', role: { value: 'button' }, name: { value: 'Keep me' }, backendDOMNodeId: 2 }),
    ]
    const outline = buildOutline(nodes)
    expect(outline.lines.map(line => line.text)).toEqual(['button "Keep me"'])
    expect(outline.rows).toHaveLength(1)
  })

  it('produces nothing for an empty tree', () => {
    expect(buildOutline([])).toEqual({ lines: [], rows: [], truncated: false })
  })
})

describe('renderOutline', () => {
  it('backfills the ref names assigned by the registry and indents by tree depth', () => {
    const outline = buildOutline([
      node({ nodeId: '1', role: { value: 'navigation' }, name: { value: 'Main' }, childIds: ['2'] }),
      node({ nodeId: '2', role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 2 }),
    ])
    const registry = new RefRegistry()
    const publication = registry.publish(outline.rows, outline.truncated)

    expect(renderOutline(outline, publication.refs)).toBe([
      '- navigation "Main"',
      '  - link "Home" [ref=e1]',
    ].join('\n'))
  })
})
