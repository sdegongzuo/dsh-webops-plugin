/** 每次 apply 独立持有的大纲缓存及纯文本检索；缓存失效由入口和工具动作驱动。 */

import { FOLD_MARKER_PREFIX } from '../browser-cdp/snapshot.ts'

// ---------------------------------------------------------------------------
// P3：webpage_find 的「最近一次 snapshot」缓存与检索
// ---------------------------------------------------------------------------

/**
 * `webpage_find` 用的「最近一次 snapshot」缓存：`session_id → SnapshotCacheEntry`。
 *
 * 方案 4.2 的零状态语义落在 tool 层：find 只查这份缓存，**绝不发任何 CDP 命令**，
 * 因此也没有归属问题。维护规则：
 * - `webpage_snapshot` 成功时整体覆盖（新纪元落表，旧大纲随之失效）；
 * - `webpage_navigate` / `webpage_tabs close` 时删除（ref 已作废，留着只会误导）；
 * - 容量封顶（{@link SNAPSHOT_CACHE_CAPACITY}），超出按插入序淘汰最旧 —— tool 层没有
 *   会话关闭的现成清理钩子，用容量上限兜底防泄漏。
 */
export type SnapshotCache = Map<string, SnapshotCacheEntry>

interface SnapshotCacheEntry {
  session_id: string
  /** 全页缓存为 undefined；区域快照写入时标记，find 回执要声明范围。 */
  region?: string
  /**
   * 检索底稿：**打印行 ∪ 被折叠掉的实例行**（`BrowserSnapshot.fullOutline`，由 buildOutline 产出）。
   *
   * 必须是这份 —— 折叠标记对模型承诺「用 webpage_find 拿全部实例的 ref」，而 find 查的就是这里。
   * 存折叠后的大纲，被折叠的实例就永远搜不到，承诺当场落空。
   *
   * 也不能图省事换成「所有原始行」：同名标签行、被去重掉的副本行是刻意隐藏的，混进来就会
   * 多出 ref 为空的幻影命中（2026-09-18 真机实测：翻页按钮的标签行整批变成幻影）。
   */
  outline: string
  refs: { ref: string; role: string; name: string }[]
  /**
   * 正文读取（项 3）：底稿行的未裁切全文与同级 statictext 块文本，稀疏 {行号, 文本}，
   * 行号与底稿行号对齐。`webpage_find(full_text=true)` 按需读取；不进模型上下文。
   * 导航 / 重拍快照时随整条缓存一起失效（与 outline 同生命周期，纪元语义免费继承）。
   */
  fullTexts?: readonly { line: number; text: string }[]
  textBlocks?: readonly { line: number; text: string }[]
  /**
   * 这次快照的大纲是不是被截断了（B2-e）。
   *
   * find 搜的是**已发出**的那份大纲，不是完整 ref 表 —— 所以当它报 0 命中时，
   * 「真的没有」与「在被截掉的那半截里」是两回事。不把标志留下来，回执就没法区分。
   */
  truncated: boolean
}

/** 缓存的会话数上限。 */
const SNAPSHOT_CACHE_CAPACITY = 32

/** `webpage_find` 的默认与最大命中数。 */
const DEFAULT_FIND_LIMIT = 20

const MAX_FIND_LIMIT = 100

/** 单条命中行的长度上限 —— 大纲是不可信数据，输出前先限长。 */
const FIND_LINE_MAX_CHARS = 200

/** 单条命中行附带的「所属上下文」的长度上限。 */
const FIND_CONTEXT_MAX_CHARS = 80

/** `webpage_find` 的一条命中。`ref` 为空串表示该行没有可操作元素（只是内容行）。 */
export interface FindMatch {
  ref: string
  role: string
  name: string
  line: string
  /**
   * 项 3 补正（2026-10-08）：`true` = 这条 ref 是**只读文本锚点**（大纲行标 `[anchor=eN]`，
   * 通常是 heading）。它定位内容：`webpage_snapshot(region_ref=锚点)` 读的就是那一节正文，
   * `webpage_locate` / 截图也可用；但 click / fill / press 拿它会被
   * `BROWSER_READ_ONLY_ANCHOR` 拒绝 —— 文本定位不凭空增加点击权限。
   */
  anchor?: boolean
  /**
   * 该行所属的最近 heading / 静态文本（形如 `heading "Rust 官方文档"`）。
   *
   * 折叠把「点哪个」的决策转嫁给 find，但 12 个「翻译此页」在 find 结果里文本完全相同 ——
   * 没有这一条，模型拿到 12 个 ref 也不知道该点哪个，折叠反而变成「更难用」。
   */
  context?: string
  /**
   * 项 3（2026-10-07）：`full_text=true` 时返回该行的**未裁切**正文（快照时缓存，
   * 只读 —— 拿不到 ref 也不构成点击权限）。长段落被 120 字符裁掉的尾部靠它拿回。
   */
  text?: string
  /** `full_text=true` 且该行属于一个同级 statictext 组（代码块）时，整块文本（换行缩进保留）。 */
  block?: string
}

export function rememberSnapshot(
  cache: SnapshotCache,
  snapshot: Pick<SnapshotCacheEntry, 'session_id' | 'refs' | 'truncated'>,
  searchOutline: string,
  region?: string,
  fullTexts?: readonly { line: number; text: string }[],
  textBlocks?: readonly { line: number; text: string }[],
): void {
  if (!cache.has(snapshot.session_id) && cache.size >= SNAPSHOT_CACHE_CAPACITY) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(snapshot.session_id, {
    session_id: snapshot.session_id,
    outline: searchOutline,
    refs: snapshot.refs,
    truncated: snapshot.truncated,
    ...region !== undefined ? { region } : {},
    ...fullTexts !== undefined ? { fullTexts } : {},
    ...textBlocks !== undefined && textBlocks.length > 0 ? { textBlocks } : {},
  })
}

/** 收窄 `limit`：非法落到默认值，过大压到上限（与 console / network 的 limit 同风格）。 */
export function normalizeFindLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_FIND_LIMIT
  return Math.min(Math.floor(limit), MAX_FIND_LIMIT)
}

/** 归一空白序列为单个普通空格（\s 已含 NBSP U+00A0），给 find 的空白不敏感匹配用。 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ')
}

/** 大纲的一行 = 缩进 + `- ` + 正文。缩进每层 2 空格（`renderOutline` 的格式）。 */
const OUTLINE_LINE = /^( *)- (.*)$/u

/** 取一行的大纲深度；不是大纲格式的行按 0 处理（宁可少给上下文，也不要错认亲子关系）。 */
function outlineDepth(line: string): number {
  const match = OUTLINE_LINE.exec(line)
  return match === null ? 0 : Math.floor((match[1] ?? '').length / 2)
}

/**
 * 给每一行算出「所属上下文」：祖先链上最近的 heading / 静态文本行。
 *
 * 为什么靠缩进反推而不是让 provider 传结构化行：缩进本身就是祖先链的完整编码，解析它
 * 不必给 `webpage_find` 单开一条数据通道。代价是这条格式约定必须钉在测试里
 * （`renderOutline` 的缩进规则一改，这里必须跟着改）。
 *
 * 兜底：祖先链上一个 heading / 静态文本都没有时（SERP 的结果标题常是 link，不是 heading），
 * 退到「本行之前最近的一个 heading / 静态文本」。它不保证就是同一条结果的标题，所以回执里
 * 字段叫 `context` 而不是「父节点」—— 它是消歧提示，不是结构断言。
 */
function outlineContexts(lines: readonly string[]): (string | undefined)[] {
  const contexts: (string | undefined)[] = []
  const stack: { depth: number; context: string | undefined }[] = []
  let previous: string | undefined
  for (const line of lines) {
    const depth = outlineDepth(line)
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop()
    const inherited = stack[stack.length - 1]?.context
    contexts.push(inherited ?? previous)
    const match = OUTLINE_LINE.exec(line)
    const body = match === null ? undefined : match[2]
    const own = body !== undefined && /^(?:heading|text)\b/u.test(body)
      ? body.replace(/\s*\[ref=e\d+\]$/u, '')
      : undefined
    if (own !== undefined) previous = own
    stack.push({ depth, context: own ?? inherited })
  }
  return contexts
}

/** 命中行的限长（大纲是不可信数据，输出前先夹住）。 */
function clipFindText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

/**
 * 在大纲文本上做一次检索。
 *
 * 命中行若带 `[ref=eN]` 标记就从 ref 表补全 role / name；不带（纯内容行）也返回，
 * `ref` 留空串 —— 模型可以据此了解上下文，但不能拿去操作。
 *
 * 检索底稿含被折叠的实例（外加模型已经看到的那份打印大纲），所以被折叠的实例照样命中、各自带
 * 自己的 ref；刻意隐藏的同名副本行不在底稿里，不会多出点不了的幻影命中。
 * 再给每条命中附上所属上下文，12 个同名按钮才分得清是「哪一条结果的按钮」。
 */
export function searchOutline(
  snapshot: SnapshotCacheEntry,
  matcher: (line: string) => boolean,
  limit: number,
  withFullText = false,
): FindMatch[] {
  const byRef = new Map(snapshot.refs.map(item => [item.ref, item]))
  const lines = snapshot.outline.length === 0 ? [] : snapshot.outline.split('\n')
  const contexts = outlineContexts(lines)
  const fullTextByLine = new Map((withFullText ? snapshot.fullTexts ?? [] : []).map(entry => [entry.line, entry.text]))
  const blockByLine = new Map((withFullText ? snapshot.textBlocks ?? [] : []).map(entry => [entry.line, entry.text]))
  const matches: FindMatch[] = []
  for (const [index, line] of lines.entries()) {
    const body = OUTLINE_LINE.exec(line)?.[2]
    // 折叠标记行是插件自己写的注释，不是页面元素：底稿万一就是折叠后的那份，
    // 放它进来会多出一条没有 ref、点不了的幻影命中。
    if (body?.startsWith(FOLD_MARKER_PREFIX) === true) continue
    if (!matcher(line)) continue
    // `[ref=eN]` = 可操作元素；`[anchor=eN]` = 只读文本锚点（项 3 补正）：能配 region_ref /
    // locate 读内容，click/fill/press 拿它会被 BROWSER_READ_ONLY_ANCHOR 拒绝。
    const marked = /\[(ref|anchor)=(e\d+)\]/u.exec(line)
    const refId = marked?.[2]
    const isAnchor = marked?.[1] === 'anchor'
    const known = refId === undefined ? undefined : byRef.get(refId)
    const context = contexts[index]
    const full = fullTextByLine.get(index)
    const block = blockByLine.get(index)
    matches.push({
      ref: known?.ref ?? refId ?? '',
      role: known?.role ?? '',
      name: known?.name ?? '',
      ...(isAnchor ? { anchor: true } : {}),
      line: clipFindText(line, FIND_LINE_MAX_CHARS),
      ...context !== undefined ? { context: clipFindText(context, FIND_CONTEXT_MAX_CHARS) } : {},
      ...full !== undefined ? { text: full } : {},
      ...block !== undefined ? { block } : {},
    })
    if (matches.length >= limit) break
  }
  return matches
}
