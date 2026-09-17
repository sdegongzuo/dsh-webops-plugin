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

import type { RefTarget } from './refs.ts'

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
}

/** 默认上限：够覆盖常见页面，又不会把预算烧光。 */
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxLines: 800,
  maxDepth: 40,
  maxTextLength: 120,
  maxOutlineChars: 40_000,
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
  /** 带缩进的大纲行；ref 名尚未回填。 */
  readonly lines: readonly OutlineLine[]
  /** 可操作元素，按出现顺序；ref 名由 `RefRegistry.publish` 分配。 */
  readonly rows: readonly Omit<RefTarget, 'ref'>[]
  readonly truncated: boolean
  /**
   * 因预算耗尽而**没有**输出的节点数（含因 `maxDepth` 被砍掉的子树根）。
   *
   * 存在的意义是让截断「可解释」：只说 `truncated: true` 时模型不知道是差几行还是差几千行，
   * 也就无从决定「抬预算」还是「换招」（`webpage_find` / `webpage_scroll`）。
   */
  readonly droppedElements: number
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
 * 把一棵可访问性树压成大纲。
 *
 * @param nodes - `Accessibility.getFullAXTree` 的原始节点数组（平面）。
 * @param limits - 规模上限，默认 {@link DEFAULT_SNAPSHOT_LIMITS}。
 * @returns 大纲行、可操作元素候选行，以及截断情况（是否截断 + 少输出了多少元素）。
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

  const lines: OutlineLine[] = []
  const rows: Omit<RefTarget, 'ref'>[] = []
  const visited = new Set<string>()
  let truncated = false
  let droppedElements = 0
  let chars = 0

  const visit = (node: AxNode, depth: number): void => {
    if (visited.has(node.nodeId)) return
    visited.add(node.nodeId)

    const role = roleOf(node)
    const name = clip(stringValue(node.name) ?? '', limits.maxTextLength)
    const transparent = node.ignored === true || TRANSPARENT_ROLES.has(role)
    const actionable = !transparent && ACTIONABLE_ROLES.has(role)

    // 预算耗尽后整棵子树都不再输出，并在结果里标记截断（调用方据此提示模型先缩小范围）。
    if (lines.length >= limits.maxLines || chars >= limits.maxOutlineChars) {
      truncated = true
      droppedElements += 1
      return
    }

    let childDepth = depth
    const text = transparent ? undefined : renderLine(node, role, name, limits.maxTextLength, actionable)
    if (text !== undefined) {
      const targetRow = actionable && typeof node.backendDOMNodeId === 'number'
        ? rows.push({ role, name, backendNodeId: node.backendDOMNodeId }) - 1
        : undefined
      lines.push({
        depth,
        text,
        ...targetRow !== undefined ? { targetRow } : {},
      })
      chars += text.length + depth * 2 + 3
      childDepth = depth + 1
    }

    if (depth >= limits.maxDepth) {
      if ((node.childIds ?? []).length > 0) {
        truncated = true
        droppedElements += 1
      }
      return
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child === undefined) continue
      visit(child, childDepth)
    }
  }

  for (const root of roots) visit(root, 0)

  return { lines, rows, truncated, droppedElements }
}

/**
 * 回填 ref 名，产出模型看到的大纲文本（一行一个元素，缩进表示可访问性树层级）。
 *
 * @param outline - {@link buildOutline} 的结果。
 * @param refs - 与 `outline.rows` 一一对应的、已分配 ref 名的元素。
 * @returns 大纲文本。
 */
export function renderOutline(
  outline: SnapshotOutline,
  refs: readonly RefTarget[],
): string {
  return outline.lines
    .map((line) => {
      const indent = '  '.repeat(line.depth)
      const target = line.targetRow === undefined ? undefined : refs[line.targetRow]
      return target === undefined ? `${indent}- ${line.text}` : `${indent}- ${line.text} [ref=${target.ref}]`
    })
    .join('\n')
}
