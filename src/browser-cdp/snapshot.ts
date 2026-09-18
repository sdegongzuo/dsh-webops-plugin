/**
 * 可访问性树 → 紧凑大纲 + ref 候选。
 *
 * 这是 P0 里唯一「有算法」的部分：`Accessibility.getFullAXTree` 返回的是几千个节点的平面数组，
 * 直接喂给模型既超预算又没用。这里把它压成一份**带缩进的大纲**，只保留有语义的行，
 * 并且只给**可操作**的元素分配 ref。
 *
 * 设计取舍：
 * - 不做「视觉树 + 布局」反推（Minke 的 `cdp.ts` 走那条路，5219 行）。可访问性树已经带着
 *   角色与名称，是浏览器自己算好的语义，P0 直接用它，代码量少一个数量级。
 * - 透明节点（`none` / `generic` / `InlineTextBox` 等纯布局层）只下钻、不占行。
 * - ref 只给可操作角色：给 `heading` 发 ref 只会诱使模型去「点标题」。
 * - 本模块是**纯函数**，不碰 CDP、不碰网络；ref 名由 `RefRegistry` 分配，所以这里只产出
 *   「行 + 该行是否绑定一个可操作元素」，由调用方在 publish 之后拼上真实 ref。
 *
 * @module dsh-webops-plugin/browser-cdp/snapshot
 */

import type { RefPublishRow, RefTarget } from './refs.ts'

/** AX 树里的一个值包装（`{ type, value }`）。 */
interface AxValue {
  readonly type?: string
  readonly value?: unknown
}

/** AX 树里的一条属性。 */
interface AxProperty {
  readonly name?: string
  readonly value?: AxValue
}

/** `Accessibility.getFullAXTree` 返回的节点（只声明本模块用到的字段）。 */
export interface AxNode {
  readonly nodeId: string
  readonly parentId?: string
  readonly childIds?: readonly string[]
  readonly ignored?: boolean
  readonly role?: AxValue
  readonly name?: AxValue
  readonly value?: AxValue
  readonly description?: AxValue
  readonly properties?: readonly AxProperty[]
  readonly backendDOMNodeId?: number
}

/** 大纲规模上限。超限即截断，并在结果里如实标记。 */
export interface SnapshotLimits {
  /** 最多输出多少行。 */
  readonly maxLines: number
  /** 最大下钻深度。 */
  readonly maxDepth: number
  /** 单个名称/值最多保留多少字符。 */
  readonly maxTextLength: number
  /** 大纲总字符上限。 */
  readonly maxOutlineChars: number
  /**
   * 重复折叠阈值：同一 `(role, name)` 在本次输出里出现 **≥** 该次数才折叠。
   *
   * 缺省 {@link DEFAULT_FOLD_REPEAT_THRESHOLD}。**不做成插件配置项** —— 它是实现的安全阀，
   * 不是部署旋钮；测试会显式覆盖它，用来证明阈值真的在起作用（而不是「反正都能折」）。
   */
  readonly foldRepeatThreshold?: number
}

/**
 * 重复折叠的默认阈值。
 *
 * 为什么是「全局 (role, name) 计数」而不是「同父计数」：Google SERP 的重复按钮
 * （「翻译此页」「查看详细信息」）各自挂在**不同的 listitem** 下，按父分组一条都折不到；
 * 而 8~10 条结果的跨父计数又够不着「≥10」的旧阈值。SERP 是这个问题被提出来的原始场景，
 * 阈值必须能在它身上生效，否则等于没做。
 */
export const DEFAULT_FOLD_REPEAT_THRESHOLD = 4

/** 默认上限：够覆盖常见页面，又不会把预算烧光。 */
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxLines: 800,
  maxDepth: 40,
  maxTextLength: 120,
  maxOutlineChars: 40_000,
  foldRepeatThreshold: DEFAULT_FOLD_REPEAT_THRESHOLD,
}

/**
 * `maxLines` 的硬上限（`webpage_snapshot` 的 `max_lines` 参数封顶）。
 *
 * 为什么封顶而不是无限：大纲直接进上下文预算，5000 行已经是一屏长文页全量（≈250KB 文本），
 * 再大就不是「紧凑大纲」了。超限按上限夹住，不报错 —— 模型要的只是「多给点」。
 */
export const MAX_SNAPSHOT_LINES = 5_000

/** 单行平均字符数（缩进 + 角色 + 名称）的估计值，用来按行数缩放字符预算。 */
const OUTLINE_CHARS_PER_LINE = 60

/**
 * 按调用方给的 `maxLines` 调整一份限额。
 *
 * 关键点：**行数预算和字符预算必须一起动**。只抬 `maxLines` 而不抬 `maxOutlineChars`，
 * 字符预算会先耗尽，模型会看到「我把 max_lines 调大了，大纲还是截断」（2026-09-14 报告
 * 里长文页截断的修法）。所以字符预算取 `max(原值, 行数 × 60)`。
 *
 * @param base - provider 配置里的默认限额。
 * @param maxLines - 调用方要求的行数上限；非法值按默认处理。
 * @returns 调整后的限额。
 */
export function resolveSnapshotLimits(base: SnapshotLimits, maxLines?: number | undefined): SnapshotLimits {
  if (maxLines === undefined || !Number.isFinite(maxLines)) return base
  const clamped = Math.max(1, Math.min(Math.floor(maxLines), MAX_SNAPSHOT_LINES))
  return {
    ...base,
    maxLines: clamped,
    maxOutlineChars: Math.max(base.maxOutlineChars, clamped * OUTLINE_CHARS_PER_LINE),
  }
}

/** 纯布局层：只下钻，不占行。 */
const TRANSPARENT_ROLES = new Set([
  'rootwebarea',
  'webarea',
  'none',
  'generic',
  'genericcontainer',
  'presentation',
  'ignored',
  'inlinetextbox',
  'linebreak',
  'inlinebox',
  'inlineblock',
  'listmarker',
  'caret',
])

/**
 * 语义容器：即使没有名称也要占一行。
 *
 * 与 {@link TRANSPARENT_ROLES} 的区别是「有没有信息量」：`div` 是纯布局，删掉它不影响理解；
 * 而「这里是列表 / 表单 / 对话框 / iframe」本身就是结构信息，模型据此才知道自己在哪一层。
 * 这些角色**不会**拿到 ref —— 能读出结构不等于能操作它。
 */
const STRUCTURAL_ROLES = new Set([
  'article',
  'blockquote',
  'dialog',
  'figure',
  'form',
  'grid',
  'group',
  'iframe',
  'list',
  'listitem',
  'main',
  'menu',
  'navigation',
  'radiogroup',
  'region',
  'row',
  'status',
  'table',
  'tablist',
  'toolbar',
])

/**
 * 可操作角色 —— 只有这些角色会拿到 ref。
 * 表偏保守：加进来的每一个角色都在告诉模型「这个可以点/可以填」。
 */
const ACTIONABLE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'disclosure-triangle',
  'gridcell',
  'link',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
])

/** 属性里值得回显给模型的键（其余是噪音）。 */
const REPORTED_PROPERTIES = [
  'checked',
  'expanded',
  'selected',
  'disabled',
  'required',
  'readonly',
  'level',
  'pressed',
  'haspopup',
  'invalid',
  'multiselectable',
  'url',
]

/** 大纲里的一行。`targetRow` 指向同一次构建产出的 `rows` 下标。 */
export interface OutlineLine {
  readonly depth: number
  readonly text: string
  /** 该行绑定了一个可操作元素时，是它在 `rows` 里的下标。 */
  readonly targetRow?: number
}

/** 大纲构建结果。 */
export interface SnapshotOutline {
  /**
   * 打印出来的大纲行（重复项已折叠压成标记行）。ref 名尚未回填。
   *
   * 折叠掉的元素**仍然**在 {@link SnapshotOutline.rows} 里 —— 折叠只减少打印行数，
   * 不减少可寻址元素。这是本功能的第一原则：折叠是展示层的事，不是寻址层的事。
   */
  readonly lines: readonly OutlineLine[]
  /**
   * find 的检索底稿：**打印行 ∪ 被折叠掉的实例行**，按文档顺序。
   *
   * 为什么必须有它：折叠标记向模型承诺「用 webpage_find 拿全部实例的 ref」，而 find 查的
   * 就是交给它的那份大纲文本 —— 底稿里少了被折叠的实例，这句承诺立刻变成谎话，
   * 折叠就等于真的丢了寻址能力。它不进模型上下文（模型看到的是 `lines`）。
   *
   * 为什么**不是**「所有原始行」：同名标签行与去重掉的副本行是刻意隐藏的，进了底稿就会变成
   * 一条 ref 为空的幻影命中 —— 模型手里的大纲没有这行，find 却报出来（2026-09-18 真机实测）。
   * 换句话说底稿 = `lines`（去掉折叠标记）+ `foldedInstances`，两者之外的行都不该被搜到。
   */
  readonly unfoldedLines: readonly OutlineLine[]
  /** 可操作元素，按出现顺序；ref 名由 `RefRegistry.publish` 分配。 */
  readonly rows: readonly RefPublishRow[]
  readonly truncated: boolean
  /**
   * 因预算耗尽而**没有**输出的节点数（含因 `maxDepth` 被砍掉的子树根）。
   *
   * 存在的意义是让截断「可解释」：只说 `truncated: true` 时模型不知道是差几行还是差几千行，
   * 也就无从决定「抬预算」还是「换招」（`webpage_find` / `webpage_scroll`）。
   *
   * **不含**被折叠的行：它们没丢，只是没打印（折叠数看 {@link SnapshotOutline.foldedRepeats}）。
   * 两个计数混在一起会让「要不要抬 max_lines」这个判断直接失真。
   */
  readonly droppedElements: number
  /**
   * 被折叠而未打印的**重复实例**数（口径 = `Σ(标记里的 ×N − 1)`）。
   *
   * 口径只此一个：**本次输出集合**里，因 (role, name) 重复而被压掉的实例数
   * （区域快照下就是区域内，见任务 5）。它与「区域外还有几个」是两套互不相干的计数，
   * 回执必须分开报、各自注明口径 —— 与 P2 预算那次「`truncated` 与 `truncatedByBudget`
   * 不能混报」是同一类教训：给错口径比不给更糟。
   *
   * 每个实例下面那份**与它同名的标签行**（真实按钮会带一个）跟着一起收起，但**不**计入这个数
   * —— 它不是独立元素，只是那个控件的内部文本。所以「标记说 ×5」与「本数是 4 的整数倍」永远对得上。
   */
  readonly foldedRepeats: number
  /**
   * 因**与祖先链上的某行同名**而被跳过的行数（同一名字在一条祖先链上被重复印多遍，只留一条）。
   *
   * 与 `foldedRepeats` 是两回事：那个是「平级/跨父的重复实例」，这个是「一条链上的同名嵌套」
   * （真实树上结果标题长成 `heading "X" > link "X" > text "X"` 三行同文）。也不进
   * `droppedElements` —— 信息一个字没少，只是不再重复印。
   *
   * 口径副作用：被跳过的行会让它后面的子行在缩进上「跳层」（被隐藏的中间层不再占行）。
   * 缩进仍然是真的树深度，不是错乱 —— 底稿（`unfoldedLines`）里那一层还在，find 的
   * 「所属上下文」照样能报到被隐藏的 heading。
   */
  readonly dedupedLines: number
}

/** 折叠空白并裁剪到 `maxLength`，避免一个 `aria-label` 撑爆一行。 */
function clip(raw: string, maxLength: number): string {
  const text = raw.replace(/\s+/gu, ' ').trim()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`
}

/** 读取 `{ type, value }` 包装里的可展示文本。 */
function stringValue(value: AxValue | undefined): string | undefined {
  const raw = value?.value
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return undefined
}

/** 从属性数组里取一个属性值，按小写名匹配。 */
function propertyValue(node: AxNode, name: string): unknown {
  for (const property of node.properties ?? []) {
    if (property.name?.toLowerCase() === name) return property.value?.value
  }
  return undefined
}

/** 把 `properties` 压成 `k=v` 片段；没有任何可报告属性时返回空数组。 */
function describeProperties(node: AxNode, maxLength: number): string[] {
  const parts: string[] = []
  for (const name of REPORTED_PROPERTIES) {
    const value = propertyValue(node, name)
    if (value === undefined || value === false) continue
    if (value === true) {
      parts.push(name)
      continue
    }
    parts.push(`${name}=${clip(String(value), maxLength)}`)
  }
  return parts
}

/** 取节点角色，统一小写；缺失时视为透明。 */
function roleOf(node: AxNode): string {
  return (stringValue(node.role) ?? 'generic').toLowerCase()
}

/**
 * 一条节点对应的行文本；返回 `undefined` 表示这行不值得占位。
 *
 * 占位条件：有名称、有值、是语义容器，或者**可操作**。最后一条不能少 ——
 * 一个没有可访问性名称的按钮恰恰最需要被看见并拿到 ref。
 */
function renderLine(
  node: AxNode,
  role: string,
  name: string,
  maxLength: number,
  actionable: boolean,
): string | undefined {
  const value = stringValue(node.value)
  const hasValue = value !== undefined && value.length > 0
  const isStaticText = role === 'statictext'
  if (!isStaticText && !actionable && !STRUCTURAL_ROLES.has(role) && name.length === 0 && !hasValue) return undefined

  const parts = [isStaticText ? 'text' : role]
  if (name.length > 0) parts.push(`"${name}"`)
  if (!isStaticText && hasValue) parts.push(`value="${clip(value, maxLength)}"`)
  if (!isStaticText) parts.push(...describeProperties(node, maxLength))
  return parts.join(' ')
}

/**
 * 折叠标记行的前缀。
 *
 * 单独导出的原因：标记行是**插件自己生成的注释**，不是页面上的元素。`webpage_find` 检索的
 * 底稿万一是折叠后的那份（provider 给不出 `fullOutline` 时），没有这条前缀就会把标记行
 * 当成一条命中返回给模型 —— 没有 ref、也无法点击的幻影命中。
 */
export const FOLD_MARKER_PREFIX = '(folded) '

/**
 * 折叠标记行的文本。
 *
 * 措辞必须同时说清三件事：这里**折叠了**、一共有几个、**怎么拿回**全部实例的 ref。
 * 少最后一条，模型只会看到一个不可点的行，然后回退到「重新 snapshot」把上下文再烧一遍 ——
 * 那正好是折叠要解决的问题本身。
 *
 * @param text - 被折叠下去的那一行（代表行）的完整行文本。
 * @param size - 本组**可折叠**实例的总数（含代表行）。
 */
function foldMarker(text: string, size: number): string {
  return `${FOLD_MARKER_PREFIX}${text} ×${String(size)} — ${String(size - 1)} more not shown; `
    + `webpage_find lists all ${String(size)} with their refs`
}

/**
 * 把一棵可访问性树压成大纲。
 *
 * 分两遍：
 *
 * 1. **全量走树**，产出候选行，并记录「最近祖先」关系与 (role, name) 计数；
 * 2. **折叠 + 结算预算**：先按重复计数决定哪些行不打印，再按**折叠后**的集合累计行数与字符数。
 *
 * 第 2 步的顺序是关键：折叠若发生在预算之后，省下来的行额换不到任何正文
 * （SERP 里 36 行噪音压成 6 行，本该换来正文多 30 行），折叠就只剩「看着清爽」这个作用。
 * 代价是不能再像早期实现那样「超预算即停止下钻」—— 重复计数要看完才能定，所以走完整棵树
 * （AX 树本来就整棵在内存里，多走一遍是线性的）。
 *
 * @param nodes - `Accessibility.getFullAXTree` 的原始节点数组（平面）。
 * @param limits - 规模上限，默认 {@link DEFAULT_SNAPSHOT_LIMITS}。
 * @returns 打印行、折叠前的检索底稿、可操作元素候选行，以及三套互相区分的计数。
 */
export function buildOutline(
  nodes: readonly AxNode[],
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): SnapshotOutline {
  const byId = new Map<string, AxNode>()
  for (const node of nodes) byId.set(node.nodeId, node)

  // 根 = 没有被任何已知节点列为子节点的节点（顺序保持输入顺序）。
  const referenced = new Set<string>()
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) referenced.add(childId)
  }
  const detected = nodes.filter(node => !referenced.has(node.nodeId))
  // 兜底：整棵树互相引用（畸形负载）时至少从第一个节点开始走，不要静默产出空大纲。
  const roots = detected.length > 0 ? detected : nodes.slice(0, 1)

  const threshold = limits.foldRepeatThreshold ?? DEFAULT_FOLD_REPEAT_THRESHOLD

  // ---- 第一遍：全量走树，产出候选行（不结算预算）----
  const candidates: { depth: number; text: string; role: string; name: string; targetRow?: number; foldKey?: string }[] = []
  const rows: RefPublishRow[] = []
  const visited = new Set<string>()
  let truncated = false
  let droppedElements = 0

  const visit = (node: AxNode, depth: number, ancestors: readonly string[]): void => {
    if (visited.has(node.nodeId)) return
    visited.add(node.nodeId)

    const role = roleOf(node)
    const name = clip(stringValue(node.name) ?? '', limits.maxTextLength)
    const transparent = node.ignored === true || TRANSPARENT_ROLES.has(role)
    const actionable = !transparent && ACTIONABLE_ROLES.has(role)

    let childDepth = depth
    const text = transparent ? undefined : renderLine(node, role, name, limits.maxTextLength, actionable)
    if (text !== undefined) {
      const targetRow = actionable && typeof node.backendDOMNodeId === 'number'
        ? rows.push({
          role,
          name,
          backendNodeId: node.backendDOMNodeId,
          ancestorPath: ancestors.join('>'),
        }) - 1
        : undefined
      // 只有「可操作 + 有名字 + 不是 statictext」的行才可能被折叠：
      // - 可操作：折叠是给重复**控件**去噪的，正文与结构行不在此列；
      // - 有名字：无名控件彼此之间连「重复」都谈不上，折了就是纯粹的信息丢失；
      // - statictext 永不折叠：搜索结果标题/摘要正是区分两条结果的正文（任务 1 硬约束）。
      const foldKey = actionable && name.length > 0 && role !== 'statictext'
        ? `${role}\u0000${name}`
        : undefined
      candidates.push({
        depth,
        text,
        role,
        name,
        ...targetRow !== undefined ? { targetRow } : {},
        ...foldKey !== undefined ? { foldKey } : {},
      })
      childDepth = depth + 1
    }

    if (depth >= limits.maxDepth) {
      if ((node.childIds ?? []).length > 0) {
        truncated = true
        droppedElements += 1
      }
      return
    }
    const nextAncestors = (transparent || isUnstableAncestor(node, role, name))
      ? ancestors
      : [...ancestors, name.length > 0 ? `${role}:${name}` : role]
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child === undefined) continue
      visit(child, childDepth, nextAncestors)
    }
  }

  for (const root of roots) visit(root, 0, [])

  // ---- 祖先 / 后代关系：DFS 前序里「最近一个深度更小的前驱」就是父行 ----
  const parentOf: (number | undefined)[] = []
  const childrenOf = new Map<number, number[]>()
  {
    const stack: number[] = []
    for (const [index, candidate] of candidates.entries()) {
      while (stack.length > 0) {
        const top = stack[stack.length - 1]
        if (top === undefined || (candidates[top] as { depth: number }).depth < candidate.depth) break
        stack.pop()
      }
      const parent = stack[stack.length - 1]
      parentOf[index] = parent
      if (parent !== undefined) {
        const siblings = childrenOf.get(parent)
        if (siblings === undefined) childrenOf.set(parent, [index])
        else siblings.push(index)
      }
      stack.push(index)
    }
  }

  /** 某个候选行的全部后代下标（多层）。 */
  const descendantsOf = (index: number): number[] => {
    const out: number[] = []
    const pending = [...childrenOf.get(index) ?? []]
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined) continue
      out.push(next)
      pending.push(...childrenOf.get(next) ?? [])
    }
    return out
  }

  // ---- 同名链去重：连续的「祖先-后代且同名」的行里只留一条 ----
  //
  // 真实树上一条结果标题会长成 `heading "X" > link "X" > text "X"` 三行同文（实测），
  // 每条结果白占两行。这**不是**折叠要处理的东西：折叠管的是平级/跨父的重复实例，
  // 这里管的是同一个名字在一条祖先链上被重复印三遍。
  //
  // 与「statictext 永不折叠」不冲突：那条禁的是**把区分结果的正文折掉**；这里被跳过的行
  // 名字已经由链上保留的那行印出来了，正文一个字没少（摘要这类只属于自己的文本，
  // 祖先链上找不到同名行，照旧打印）。
  const chainHead: number[] = []
  for (const [index, candidate] of candidates.entries()) {
    const parent = parentOf[index]
    const parentCandidate = parent === undefined ? undefined : candidates[parent]
    chainHead[index] = candidate.name.length > 0
      && parentCandidate !== undefined
      && (parentCandidate as { name: string }).name === candidate.name
      ? (chainHead[parent as number] as number)
      : index
  }

  const chains = new Map<number, number[]>()
  for (const index of candidates.keys()) {
    const head = chainHead[index] as number
    const members = chains.get(head)
    if (members === undefined) chains.set(head, [index])
    else members.push(index)
  }

  /**
   * 链上留哪一行：**可操作优先**（它的 ref 是寻址能力，绝不能为了去重丢掉），
   * 同级里再取「渲染文本最长」的那行 —— 文本越长带的信息越多（`level` / `url` / `disabled`…）。
   * 并列时保最靠前（最浅）的那行：成员按出现顺序排，只在**严格更长**时才替换。
   */
  const survivorOf = (members: readonly number[]): number => {
    const actionable = members.filter(index => (candidates[index] as { targetRow?: number }).targetRow !== undefined)
    const pool = actionable.length > 0 ? actionable : members
    let best = pool[0] as number
    for (const index of pool) {
      if ((candidates[index] as { text: string }).text.length > (candidates[best] as { text: string }).text.length) best = index
    }
    return best
  }

  /** 因与祖先同名而被跳过的行下标（信息已由链上保留的那行携带，不进 `foldedRepeats`）。 */
  const redundantRows = new Set<number>()
  for (const members of chains.values()) {
    if (members.length < 2) continue
    // 护栏：一条链上出现 2 个以上可操作行就不去重。去重要留谁都是猜，而丢掉的那行带着一个**可用
    // 的 ref** —— 去重的收益只是省一行，代价是少一个能点的元素，不划算。（真实树上罕见，
    // 但「折叠不丢寻址」这条承诺没理由在去重上破例。）
    if (members.filter(index => (candidates[index] as { targetRow?: number }).targetRow !== undefined).length > 1) continue
    const survivor = survivorOf(members)
    for (const index of members) {
      if (index !== survivor) redundantRows.add(index)
    }
  }

  // ---- 折叠决策：同 (role, name) 的**可折叠**实例数 ≥ 阈值即折，只留首个 ----
  //
  // 折叠单元是「实例行 + 它下面与它同名的标签行」。这一条是**真机实测**逼出来的：Chrome 的
  // 可访问性树里 `<button aria-label="翻译此页">翻译此页</button>` 会给出
  // `button "翻译此页"` 加一个子节点 `text "翻译此页"`（按钮内部的文本是独立的 StaticText）。
  // 早期实现要求「有已打印子行就不折」，于是真实页面上的重复按钮一个都折不到 ——
  // 夹具里没有这个子节点，单测全绿也照样漏。(2026-09-18 无头 Chrome 实测)
  //
  // 同时立一条护栏：子树里只要夹带了**同名标签之外**的内容就不折。折一个带真内容的容器
  // 会把内容一起吞掉，那已经不是去噪而是删信息。
  const mirrorRowsOf = (index: number): number[] | undefined => {
    const self = candidates[index] as { role: string; name: string }
    const descendants = descendantsOf(index)
    const labels: number[] = []
    for (const descendant of descendants) {
      const child = candidates[descendant] as { role: string; name: string }
      if (child.role !== 'statictext' || child.name !== self.name) return undefined
      labels.push(descendant)
    }
    return labels
  }

  const foldableByKey = new Map<string, number[]>()
  /** 可能被折的行 → 它连带的同名标签行（折它时跟着一起收起）。 */
  const labelRows = new Map<number, number[]>()
  for (const [index, candidate] of candidates.entries()) {
    const key = candidate.foldKey
    if (key === undefined) continue
    const labels = mirrorRowsOf(index)
    if (labels === undefined) continue
    labelRows.set(index, labels)
    const list = foldableByKey.get(key)
    if (list === undefined) foldableByKey.set(key, [index])
    else list.push(index)
  }

  /** 代表行下标 → 本组可折叠实例总数。 */
  const foldGroups = new Map<number, number>()
  /** 被折叠掉的**实例行**下标（计数口径：它们才是「重复了几个」）。 */
  const foldedInstances = new Set<number>()
  /** 连同同名标签行在内的、不打印的行下标（标签行不算进 `foldedRepeats` —— 它们不是元素）。 */
  const hiddenRows = new Set<number>()
  for (const list of foldableByKey.values()) {
    if (list.length < threshold) continue
    const first = list[0]
    if (first === undefined) continue
    foldGroups.set(first, list.length)
    // 代表行的同名标签行也是同一份重复，一并收掉：行本身已经带着名字，那行不提供任何新信息。
    for (const label of labelRows.get(first) ?? []) hiddenRows.add(label)
    for (let index = 1; index < list.length; index += 1) {
      const instance = list[index]
      if (instance === undefined) continue
      foldedInstances.add(instance)
      hiddenRows.add(instance)
      for (const label of labelRows.get(instance) ?? []) hiddenRows.add(label)
    }
  }

  // ---- 第二遍：按折叠 / 去重后的集合结算预算 ----
  const lines: OutlineLine[] = []
  const unfoldedLines: OutlineLine[] = []
  let chars = 0
  let foldedRepeats = 0
  let dedupedLines = 0

  for (const [index, candidate] of candidates.entries()) {
    const line: OutlineLine = {
      depth: candidate.depth,
      text: candidate.text,
      ...candidate.targetRow !== undefined ? { targetRow: candidate.targetRow } : {},
    }
    const foldedAway = hiddenRows.has(index)
    if (foldedAway || redundantRows.has(index)) {
      // 被折叠 / 被去重的行不占行额、不占字符额，也不算 droppedElements —— 它们没丢，只是没打印。
      //
      // 但**底稿只收被折叠掉的实例行**，不收「同名标签行」和「被去重掉的副本行」：
      // 底稿存在的唯一理由是「让 webpage_find 拿回折叠实例的 ref」，凡是本来就不该被看见的副本，
      // 进了底稿就变成一条 ref 为空的幻影命中 —— 模型看到的大纲里没有这行，find 却报出来，
      // 看起来就是坏了。(2026-09-18 真机全链路实测：翻页按钮的同名标签行全成了幻影命中)
      if (foldedInstances.has(index)) {
        unfoldedLines.push(line)
        foldedRepeats += 1
      } else if (!foldedAway) {
        dedupedLines += 1
      }
      continue
    }
    if (lines.length >= limits.maxLines || chars >= limits.maxOutlineChars) {
      truncated = true
      droppedElements += 1
      continue
    }
    lines.push(line)
    unfoldedLines.push(line)
    chars += candidate.text.length + candidate.depth * 2 + 3
    const groupSize = foldGroups.get(index)
    if (groupSize === undefined) continue
    // 标记行也占一行预算；行额见底时优先保代表行（它有 ref，能直接点）。
    if (lines.length >= limits.maxLines || chars >= limits.maxOutlineChars) continue
    const marker = foldMarker(candidate.text, groupSize)
    lines.push({ depth: candidate.depth, text: marker })
    chars += marker.length + candidate.depth * 2 + 3
  }

  return {
    lines: normalizeDepths(lines),
    unfoldedLines: normalizeDepths(unfoldedLines),
    rows,
    truncated,
    droppedElements,
    foldedRepeats,
    dedupedLines,
  }
}

/**
 * 把一串行的缩进按**保留下来的行**重新归一：第 n 层 = 「它上面共有几个保留的祖先」。
 *
 * 为什么必须做：删掉中间层（去重、折叠）之后，照抄真实深度会出现「孙子行比它后面的叔叔行
 * 深两级」这种看着像 bug 的豁口（真实树上 `listitem > heading > link` 去掉 heading 后，
 * link 停在 depth 4，而同一张卡片里的兄弟 `text` 在 depth 3）。归一后每一行都恰好比它最近的
 * 保留祖先深一层 —— 这才是读大纲的人（模型）期望的结构。
 *
 * 两个视图各归一各的：底稿里被去重的行还在，所以它的归一结果与打印视图**本就不该相同**。
 * 各自内部自洽即可 —— 每个视图里「最近一个更浅的前驱就是父」这条性质都被保留
 * （归一是一致单调的重标号），`webpage_find` 的祖先反推照样成立。
 */
function isUnstableAncestor(node: AxNode, role: string, name: string): boolean {
  if (node.ignored === true) return true
  if (TRANSPARENT_ROLES.has(role)) return true
  const trimmed = name.trim()
  if (/^[0-9a-f]{8,}$/iu.test(trimmed)) return true
  if (/\d{10,}/u.test(trimmed)) return true
  return false
}

function normalizeDepths(rows: readonly OutlineLine[]): OutlineLine[] {
  const ancestors: number[] = []
  return rows.map((line) => {
    while (ancestors.length > 0 && (ancestors[ancestors.length - 1] as number) >= line.depth) ancestors.pop()
    ancestors.push(line.depth)
    const depth = ancestors.length - 1
    return depth === line.depth ? line : { ...line, depth }
  })
}

/** {@link renderOutline} 的可选项。 */
export interface RenderOutlineOptions {
  /**
   * 渲染折叠前的完整行序列（`webpage_find` 的检索底稿）而不是打印行。
   *
   * 缺省 false —— 模型看到的是折叠后的大纲。
   */
  readonly unfoldRepeats?: boolean
}

/**
 * 回填 ref 名，产出模型看到的大纲文本（一行一个元素，缩进表示可访问性树层级）。
 *
 * @param outline - {@link buildOutline} 的结果。
 * @param refs - 与 `outline.rows` 一一对应的、已分配 ref 名的元素。
 * @param options - `unfoldRepeats: true` 时渲染折叠前的检索底稿。
 * @returns 大纲文本。
 */
export function renderOutline(
  outline: SnapshotOutline,
  refs: readonly RefTarget[],
  options: RenderOutlineOptions = {},
): string {
  const source = options.unfoldRepeats === true ? outline.unfoldedLines : outline.lines
  return source
    .map((line) => {
      const indent = '  '.repeat(line.depth)
      const target = line.targetRow === undefined ? undefined : refs[line.targetRow]
      return target === undefined ? `${indent}- ${line.text}` : `${indent}- ${line.text} [ref=${target.ref}]`
    })
    .join('\n')
}

/** 文档坐标下的轴对齐矩形。 */
export interface BoxRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 把 `DOMSnapshot` 的 bounds 收成 AABB。
 * 4 个数当 `[x, y, width, height]`；8 个数当四角 quad，取 min/max。
 */
export function boundsToBox(bounds: readonly number[]): BoxRect | undefined {
  if (bounds.length >= 8) {
    const xs = [bounds[0], bounds[2], bounds[4], bounds[6]].filter((value): value is number => typeof value === 'number')
    const ys = [bounds[1], bounds[3], bounds[5], bounds[7]].filter((value): value is number => typeof value === 'number')
    if (xs.length < 4 || ys.length < 4) return undefined
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  }
  if (bounds.length >= 4) {
    const x = bounds[0]
    const y = bounds[1]
    const width = bounds[2]
    const height = bounds[3]
    if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
    return { x, y, width, height }
  }
  return undefined
}

/** 两个矩形有交集（含边贴边）即算可见；部分入屏的元素不该丢。 */
export function boxesIntersect(left: BoxRect, right: BoxRect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
}

/**
 * 只保留 backendNodeId 落在区域内的节点，以及它们的祖先（撑住大纲结构）。
 * 区域外的兄弟不进结果。
 */
export function filterAxTreeByBackendIds(
  nodes: readonly AxNode[],
  keepBackend: ReadonlySet<number>,
): AxNode[] {
  const byId = new Map<string, AxNode>()
  const parentOf = new Map<string, string>()
  for (const node of nodes) {
    byId.set(node.nodeId, node)
    for (const childId of node.childIds ?? []) parentOf.set(childId, node.nodeId)
  }
  const keep = new Set<string>()
  for (const node of nodes) {
    if (typeof node.backendDOMNodeId !== 'number' || !keepBackend.has(node.backendDOMNodeId)) continue
    let current: string | undefined = node.nodeId
    while (current !== undefined && !keep.has(current)) {
      keep.add(current)
      current = parentOf.get(current)
    }
  }
  return nodes
    .filter(node => keep.has(node.nodeId))
    .map((node) => {
      if (node.childIds === undefined) return node
      return { ...node, childIds: node.childIds.filter(id => keep.has(id)) }
    })
}
