import { describe, expect, it } from 'vitest'
import { buildOutline, DEFAULT_SNAPSHOT_LIMITS, MAX_SNAPSHOT_LINES, renderOutline, resolveSnapshotLimits } from './snapshot.ts'
import type { AxNode, OutlineLine } from './snapshot.ts'
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
      dedupedLines: 0,
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
    // 底稿里**实例**一行不少（find 要靠它拿 ref）……
    expect(outline.unfoldedLines.map(line => line.text).filter(t => t.startsWith('button "翻译此页"'))).toHaveLength(12)
    // ……但同名标签行一行都不能进：它们是刻意隐藏的副本，进了底稿就是一条 ref 为空的幻影命中
    // （模型手里的大纲没有这行，find 却报出来）。2026-09-18 真机全链路套出来的。
    expect(outline.unfoldedLines.map(line => line.text).filter(t => t === 'text "翻译此页"')).toHaveLength(0)
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

// ---------------------------------------------------------------------------
// 同名链去重：一条祖先链上同一个名字只印一次
// ---------------------------------------------------------------------------

describe('buildOutline：同名链去重（2026-09-18）', () => {
  /** 真实树上的一条结果标题：`heading "X" > link "X" > text "X"` 三行同文。 */
  function titleChain(name: string): AxNode[] {
    return [
      node({ nodeId: 'li', role: { value: 'listitem' }, childIds: ['h'] }),
      node({
        nodeId: 'h',
        role: { value: 'heading' },
        name: { value: name },
        childIds: ['a'],
        properties: [{ name: 'level', value: { value: 3 } }],
      }),
      node({
        nodeId: 'a',
        role: { value: 'link' },
        name: { value: name },
        childIds: ['t'],
        backendDOMNodeId: 7,
      }),
      node({ nodeId: 't', role: { value: 'StaticText' }, name: { value: name } }),
    ]
  }

  it('keeps exactly one row of a same-name ancestor chain, and it is the actionable one', () => {
    const outline = buildOutline(titleChain('Rust 官方文档'))
    const text = outline.lines.map(line => line.text).join('\n')

    // 三行同文只留一行（`listitem` 是结构行，本来就在），留下的必须是**带 ref 的那行**
    // —— 留 heading 会把寻址能力删掉。
    expect(outline.lines.map(line => line.text)).toEqual(['listitem', 'link "Rust 官方文档"'])
    expect(outline.lines[1]?.targetRow).toBe(0)
    expect(outline.dedupedLines).toBe(2)
    // 去重不是截断、也不是折叠，三套计数互不串味。
    expect(outline.truncated).toBe(false)
    expect(outline.droppedElements).toBe(0)
    expect(outline.foldedRepeats).toBe(0)
    // ref 照旧分配（去重只影响打印）。
    expect(outline.rows).toEqual([{ role: 'link', name: 'Rust 官方文档', backendNodeId: 7 }])
  })

  it('keeps every folded instance in the find outline, and nothing else', () => {
    const outline = buildOutline(titleChain('Rust 官方文档'))
    const registry = new RefRegistry()
    const publication = registry.publish(outline.rows, outline.truncated)

    const full = renderOutline(outline, publication.refs, { unfoldRepeats: true })
    // 底稿 = 打印行 ∪ 被折叠的实例行。这里没有折叠，所以底稿就是打印的那两行 ——
    // 被去重掉的 `heading` / `text` **不进底稿**：它们已经从 `link` 那行读到了同样的名字，
    // 留在底稿里只会让 webpage_find 多报两条 ref 为空的幻影命中。
    expect(full.split('\n')).toHaveLength(2)
    expect(full).not.toContain('(folded)')
    expect(full).toContain('link "Rust 官方文档" [ref=e1]')
    expect(full).not.toContain('heading "Rust 官方文档"')
    expect(full).not.toContain('text "Rust 官方文档"')
  })

  it('prefers the richer non-actionable row when no row in the chain is actionable', () => {
    // heading `level=3` 比裸 text 多一个属性，留它。
    const outline = buildOutline([
      node({
        nodeId: 'h',
        role: { value: 'heading' },
        name: { value: '搜索结果' },
        childIds: ['t'],
        properties: [{ name: 'level', value: { value: 1 } }],
      }),
      node({ nodeId: 't', role: { value: 'StaticText' }, name: { value: '搜索结果' } }),
    ])
    expect(outline.lines.map(line => line.text)).toEqual(['heading "搜索结果" level=1'])
    expect(outline.dedupedLines).toBe(1)
  })

  it('never dedupes siblings or unrelated duplicates — only a real ancestor chain', () => {
    // 两条结果各有一段**不同**的摘要，另外两条同名的兄弟 text 也不能互相吃掉。
    const outline = buildOutline([
      node({ nodeId: 'root', role: { value: 'list' }, childIds: ['a', 'b'] }),
      node({ nodeId: 'a', role: { value: 'listitem' }, childIds: ['a1'] }),
      node({ nodeId: 'a1', role: { value: 'StaticText' }, name: { value: '同一句' } }),
      node({ nodeId: 'b', role: { value: 'listitem' }, childIds: ['b1'] }),
      node({ nodeId: 'b1', role: { value: 'StaticText' }, name: { value: '同一句' } }),
    ])
    expect(outline.lines.map(line => line.text).filter(text => text === 'text "同一句"')).toHaveLength(2)
    expect(outline.dedupedLines).toBe(0)
  })

  it('never eats text that belongs to a single result, even under a same-name wrapper', () => {
    const outline = buildOutline([
      node({ nodeId: 'li', role: { value: 'listitem' }, childIds: ['a', 's'] }),
      node({ nodeId: 'a', role: { value: 'link' }, name: { value: '结果 A' }, childIds: ['t'], backendDOMNodeId: 1 }),
      node({ nodeId: 't', role: { value: 'StaticText' }, name: { value: '结果 A' } }),
      // 摘要挂在 listitem 下，祖先链上没有同名行 → 必须照旧打印。
      node({ nodeId: 's', role: { value: 'StaticText' }, name: { value: '这是 A 的摘要' } }),
    ])
    expect(outline.lines.map(line => line.text)).toEqual([
      'listitem',
      'link "结果 A"',
      'text "这是 A 的摘要"',
    ])
    expect(outline.dedupedLines).toBe(1)
  })

  it('survives a chain of 4 identical rows and still leaves one', () => {
    const outline = buildOutline([
      node({ nodeId: '1', role: { value: 'listitem' }, childIds: ['2'] }),
      node({ nodeId: '2', role: { value: 'heading' }, name: { value: 'X' }, childIds: ['3'] }),
      node({ nodeId: '3', role: { value: 'link' }, name: { value: 'X' }, childIds: ['4'], backendDOMNodeId: 3 }),
      node({ nodeId: '4', role: { value: 'StaticText' }, name: { value: 'X' }, childIds: ['5'] }),
      node({ nodeId: '5', role: { value: 'StaticText' }, name: { value: 'X' } }),
    ])
    expect(outline.lines.map(line => line.text).filter(text => text.includes('"X"'))).toHaveLength(1)
    expect(outline.dedupedLines).toBe(3)
    expect(outline.rows).toHaveLength(1)
  })

  it('re-normalizes indentation after removing a middle layer, so siblings stay aligned', () => {
    // 真机实测的坑（2026-09-18）：抽掉 `heading` 之后，留下的 `link` 还顶着一层空缩进 ——
    // 后面那条摘要却是浅一级，两份同属一个 listitem 的行看起来像大纲坏了。
    // 所以保留行的 depth 要按「保留行里还有几层祖先」重算，而不是照抄原始 depth。
    const outline = buildOutline([
      node({ nodeId: 'li', role: { value: 'listitem' }, childIds: ['h', 's'] }),
      node({
        nodeId: 'h',
        role: { value: 'heading' },
        name: { value: '结果 A' },
        childIds: ['a'],
        properties: [{ name: 'level', value: { value: 3 } }],
      }),
      node({
        nodeId: 'a',
        role: { value: 'link' },
        name: { value: '结果 A' },
        childIds: ['t'],
        backendDOMNodeId: 1,
      }),
      node({ nodeId: 't', role: { value: 'StaticText' }, name: { value: '结果 A' } }),
      node({ nodeId: 's', role: { value: 'StaticText' }, name: { value: '结果 A 的摘要' } }),
    ])

    expect(outline.lines.map(line => [line.depth, line.text])).toEqual([
      [0, 'listitem'],
      [1, 'link "结果 A"'],
      [1, 'text "结果 A 的摘要"'],
    ])
    // 通用不变量：任何一行最多比上一行深一级 —— 去掉中间层后不许出现缩进断层。
    outline.lines.forEach((line, index) => {
      if (index === 0) return
      const previous = outline.lines[index - 1] as OutlineLine
      expect(line.depth).toBeLessThanOrEqual(previous.depth + 1)
    })
    // 底稿 = 打印行 ∪ 折叠实例（这里没有折叠），所以与上面同构；被去重的两行不在里面。
    expect(outline.unfoldedLines.map(line => [line.depth, line.text])).toEqual([
      [0, 'listitem'],
      [1, 'link "结果 A"'],
      [1, 'text "结果 A 的摘要"'],
    ])
  })

  it('never dedupes a chain that carries more than one actionable row', () => {
    // 护栏：去重要留谁都是猜，而丢掉的那行带着一个可用的 ref —— 省一行的收益换不来少一个能点的元素。
    const outline = buildOutline([
      node({ nodeId: 'li', role: { value: 'listitem' }, childIds: ['a'] }),
      node({ nodeId: 'a', role: { value: 'link' }, name: { value: '同名' }, childIds: ['b'], backendDOMNodeId: 1 }),
      node({ nodeId: 'b', role: { value: 'link' }, name: { value: '同名' }, backendDOMNodeId: 2 }),
    ])

    expect(outline.lines.map(line => line.text)).toEqual(['listitem', 'link "同名"', 'link "同名"'])
    expect(outline.dedupedLines).toBe(0)
    // 两个 ref 都还在，两个都能点。
    expect(outline.rows).toHaveLength(2)
  })
})
