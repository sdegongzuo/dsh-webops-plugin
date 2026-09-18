import { describe, expect, it } from 'vitest'
import { buildOutline, DEFAULT_SNAPSHOT_LIMITS, MAX_SNAPSHOT_LINES, renderOutline, resolveSnapshotLimits } from './snapshot.ts'
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
    // 截断要可解释：模型据此知道是差 17 行还是差 17000 行。
    expect(outline.droppedElements).toBe(17)
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
    expect(buildOutline([])).toEqual({
      lines: [],
      unfoldedLines: [],
      rows: [],
      truncated: false,
      droppedElements: 0,
      foldedRepeats: 0,
    })
  })

  it('resolveSnapshotLimits: raises the character budget with the line budget, and clamps', () => {
    // 只抬行数不抬字符数 = 字符预算先耗尽，「我调大了 max_lines 还是截断」。
    const raised = resolveSnapshotLimits(DEFAULT_SNAPSHOT_LIMITS, 2_000)
    expect(raised.maxLines).toBe(2_000)
    expect(raised.maxOutlineChars).toBeGreaterThanOrEqual(2_000 * 60)
    expect(raised.maxTextLength).toBe(DEFAULT_SNAPSHOT_LIMITS.maxTextLength)

    // 上限封顶，不会因为模型要 10 万行就去渲染 10 万行。
    expect(resolveSnapshotLimits(DEFAULT_SNAPSHOT_LIMITS, 1e9).maxLines).toBe(MAX_SNAPSHOT_LINES)
    expect(resolveSnapshotLimits(DEFAULT_SNAPSHOT_LIMITS, 0).maxLines).toBe(1)
    // 非法值原样落回默认限额（对象都不换）。
    expect(resolveSnapshotLimits(DEFAULT_SNAPSHOT_LIMITS, Number.NaN)).toBe(DEFAULT_SNAPSHOT_LIMITS)
    expect(resolveSnapshotLimits(DEFAULT_SNAPSHOT_LIMITS, undefined)).toBe(DEFAULT_SNAPSHOT_LIMITS)
  })

  it('resolveSnapshotLimits: 2000 lines of a long page really do come out', () => {
    const nodes: AxNode[] = Array.from({ length: 1_500 }, (_unused, index) =>
      node({ nodeId: String(index), role: { value: 'link' }, name: { value: `l${index}` }, backendDOMNodeId: index }))

    expect(buildOutline(nodes, DEFAULT_SNAPSHOT_LIMITS).truncated).toBe(true)
    const raised = buildOutline(nodes, resolveSnapshotLimits(DEFAULT_SNAPSHOT_LIMITS, 2_000))
    expect(raised.truncated).toBe(false)
    expect(raised.lines).toHaveLength(1_500)
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

// ---------------------------------------------------------------------------
// 任务 1：按 (role, name) 折叠重复行
// ---------------------------------------------------------------------------

/**
 * 造一个 SERP 形状的 AX 树：`results` 条结果，每条 = 标题 link + 摘要 text + 三个重复按钮。
 *
 * 形状照 **真实 Chrome 实测**的树来（2026-09-18 无头 Chrome 153 跑同一张页面得到的输出）：
 * - 重复按钮各自挂在**不同的 listitem** 下 —— 这正是「同父计数」折不到、必须全局计数的原因；
 * - 每个 `button` 下面还有一行**同名的 `text`** —— Chrome 把按钮内部的文本暴露成独立 StaticText。
 *   夹具少了这个子节点，单测能全绿而真实页面上一个都折不到（这个坑真踩过）。
 */
function serp(results: number): AxNode[] {
  const nodes: AxNode[] = [
    node({
      nodeId: 'list',
      role: { value: 'list' },
      childIds: Array.from({ length: results }, (_unused, index) => `li${index}`),
    }),
  ]
  const buttons = (index: number): [string, string, string][] => [
    [`a${index}`, '翻译此页', 'a'],
    [`b${index}`, '查看详细信息', 'b'],
    [`c${index}`, '分享', 'c'],
  ]
  for (let index = 0; index < results; index += 1) {
    nodes.push(node({
      nodeId: `li${index}`,
      role: { value: 'listitem' },
      childIds: [`t${index}`, `s${index}`, `a${index}`, `b${index}`, `c${index}`],
    }))
    nodes.push(node({ nodeId: `t${index}`, role: { value: 'link' }, name: { value: `结果 ${index}` }, backendDOMNodeId: 1_000 + index }))
    nodes.push(node({ nodeId: `s${index}`, role: { value: 'StaticText' }, name: { value: `摘要 ${index}` } }))
    for (const [id, label, slot] of buttons(index)) {
      nodes.push(node({
        nodeId: id,
        role: { value: 'button' },
        name: { value: label },
        childIds: [`${id}-label`],
        backendDOMNodeId: 2_000 + index * 3 + (slot.charCodeAt(0) - 97),
      }))
      nodes.push(node({ nodeId: `${id}-label`, role: { value: 'StaticText' }, name: { value: label } }))
    }
  }
  return nodes
}

describe('buildOutline：重复折叠（2026-09-18 任务 1）', () => {
  it('folds a (role, name) group of 12 into one line plus one marker', () => {
    const outline = buildOutline(serp(12))
    const text = outline.lines.map(line => line.text).join('\n')

    // 代表行 + 一行标记，而不是 12 行；标记必须说清「有几个」和「怎么拿回来」。
    expect(text).toContain('(folded) button "翻译此页" ×12 — 11 more not shown; webpage_find lists all 12 with their refs')
    expect(text.match(/button "翻译此页"/gu)).toHaveLength(2)
    // 三组重复按钮各折一组。
    expect(outline.foldedRepeats).toBe(33)
    // 折叠 ≠ 截断：两套计数不许混。
    expect(outline.truncated).toBe(false)
    expect(outline.droppedElements).toBe(0)
  })

  it('keeps a ref for every folded instance — folding is a display concern only', () => {
    const outline = buildOutline(serp(12))
    // 这是折叠方案的第一原则：折叠标记承诺「用 webpage_find 拿全部实例的 ref」，
    // 若折叠不分配 ref，那句话当场就是假的（find 从 ref 表/底稿里都找不到它们）。
    expect(outline.rows.filter(row => row.name === '翻译此页')).toHaveLength(12)
    expect(outline.rows).toHaveLength(12 + 36)
    // 折叠前的底稿里一个实例都不少（webpage_find 查的就是它）。
    expect(outline.unfoldedLines.map(line => line.text).filter(t => t.startsWith('button "翻译此页"'))).toHaveLength(12)
  })

  it('never folds statictext, even when the text repeats verbatim', () => {
    const nodes: AxNode[] = Array.from({ length: 8 }, (_unused, index) =>
      node({ nodeId: String(index), role: { value: 'StaticText' }, name: { value: '重复正文' } }))
    const outline = buildOutline(nodes)
    // 搜索结果标题/摘要是区分两条结果的正文，折了就等于把结果删了。
    expect(outline.foldedRepeats).toBe(0)
    expect(outline.lines).toHaveLength(8)
  })

  it('never folds unnamed structural rows, and never folds a row that has printed children', () => {
    const stacked: AxNode[] = [
      node({ nodeId: 'root', role: { value: 'list' }, childIds: ['a', 'b', 'c', 'd', 'e'] }),
    ]
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      // 无名 listitem：折了就把结果列表的结构抹平（缩进会把子行变成孤儿）。
      stacked.push(node({ nodeId: id, role: { value: 'listitem' }, childIds: [`${id}-text`] }))
      stacked.push(node({ nodeId: `${id}-text`, role: { value: 'StaticText' }, name: { value: '一行' } }))
    }
    const outline = buildOutline(stacked)
    expect(outline.foldedRepeats).toBe(0)
    expect(outline.lines.map(line => line.text).filter(t => t === 'listitem')).toHaveLength(5)
  })

  it('folds a button together with the same-named label text Chrome nests under it', () => {
    // 真实树上每个 button 下面都有一行同名 text。折叠必须把它一起收掉：
    // 留着的话「×5」的标记旁边还杵着 5 行重复标签，噪音只减了一半；它也不是独立元素（没有 ref），
    // 所以不进 foldedRepeats —— 口径要跟标记里的 ×N 对得上（Σ(×N − 1) === foldedRepeats）。
    const outline = buildOutline(serp(12))
    const text = outline.lines.map(line => line.text).join('\n')

    expect(text).not.toContain('text "翻译此页"')
    expect(outline.foldedRepeats).toBe(33)
    // 底稿里（find 的那份）实例一行不少。
    expect(outline.unfoldedLines.map(line => line.text).filter(t => t === 'text "翻译此页"')).toHaveLength(12)
  })

  it('never folds a line whose subtree carries content other than its own label, so nothing is swallowed', () => {
    // 5 个同名可操作容器，每个里面还有一行正文。折掉容器行的话，那 5 行正文会在缩进上
    // 变成没爹的孤儿（depth 还是 +1，父行却没了），大纲的结构信息当场错乱。
    const nodes: AxNode[] = [
      node({ nodeId: 'root', role: { value: 'list' }, childIds: ['0', '1', '2', '3', '4'] }),
    ]
    for (let index = 0; index < 5; index += 1) {
      nodes.push(node({
        nodeId: `panel${index}`,
        role: { value: 'button' },
        name: { value: '展开' },
        childIds: [`p${index}`],
        backendDOMNodeId: 700 + index,
      }))
      nodes.push(node({ nodeId: `p${index}`, role: { value: 'StaticText' }, name: { value: `内容 ${index}` } }))
    }
    const outline = buildOutline(nodes)

    expect(outline.foldedRepeats).toBe(0)
    expect(outline.lines.map(line => line.text).filter(text => text === 'button "展开"')).toHaveLength(5)
    // 不折叠 ≠ 不分配 ref：它们本来就在 rows 里。
    expect(outline.rows.filter(row => row.name === '展开')).toHaveLength(5)
  })

  it('does not fold a group that is below the threshold', () => {
    // 3 < 4：阈值真的在起作用，而不是「只要重复就折」。
    const outline = buildOutline(serp(3))
    expect(outline.foldedRepeats).toBe(0)
    expect(outline.lines.map(line => line.text).join('\n')).not.toContain('(folded)')
  })

  it('compares the group size against the configured threshold, not a hard-coded 4', () => {
    // 反向验证：把阈值抬到组大小之上 → 不折；压到组大小之下 → 折。
    expect(buildOutline(serp(12), { ...DEFAULT_SNAPSHOT_LIMITS, foldRepeatThreshold: 13 }).foldedRepeats).toBe(0)
    expect(buildOutline(serp(12), { ...DEFAULT_SNAPSHOT_LIMITS, foldRepeatThreshold: 12 }).foldedRepeats).toBe(33)
    // 阈值 2 时，3 个重复的组也要折 —— 证明用的是配置值。
    expect(buildOutline(serp(3), { ...DEFAULT_SNAPSHOT_LIMITS, foldRepeatThreshold: 2 }).foldedRepeats).toBe(6)
  })

  it('unfolds back to the full sequence for the find cache', () => {
    const outline = buildOutline(serp(12))
    const registry = new RefRegistry()
    const publication = registry.publish(outline.rows, outline.truncated)

    const folded = renderOutline(outline, publication.refs)
    const full = renderOutline(outline, publication.refs, { unfoldRepeats: true })

    expect(folded).toContain('(folded) button "翻译此页" ×12')
    expect(full).not.toContain('(folded)')
    // 底稿里每个实例都在，而且各自带着自己的 ref（find 靠它把 ref 交给模型）。
    expect(full.match(/\[ref=e\d+\]/gu)).toHaveLength(48)
    expect(full.length).toBeGreaterThan(folded.length)
  })

  it('spends the budget AFTER folding, so the freed lines buy real content', () => {
    // 40 条尾部链接排在 36 行噪音之后：预算 60 行时，不折叠的话噪音就把预算吃光了。
    const nodes: AxNode[] = [
      ...serp(12),
      ...Array.from({ length: 40 }, (_unused, index) =>
        node({ nodeId: `tail${index}`, role: { value: 'link' }, name: { value: `尾部 ${index}` }, backendDOMNodeId: 5_000 + index })),
    ]
    const outline = buildOutline(nodes, { ...DEFAULT_SNAPSHOT_LIMITS, maxLines: 60 })
    const text = outline.lines.map(line => line.text).join('\n')

    expect(outline.lines).toHaveLength(60)
    expect(outline.truncated).toBe(true)
    expect(outline.foldedRepeats).toBe(33)
    // 折掉的 33 行换来的正是这 17 条正文链接（`lines` 里尚未回填 ref，那一步在 renderOutline）。
    expect(text).toContain('link "尾部 16"')
    expect(text).not.toContain('link "尾部 17"')
  })
})
