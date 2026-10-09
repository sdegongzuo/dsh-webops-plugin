/** provider 的纯值转换、按键描述、几何判定与图片尺寸读取。 */

import { BrowserError } from '../browser/types.ts'
import { type AxNode, DEFAULT_SNAPSHOT_LIMITS, type BoxRect } from './snapshot.ts'
import { DEFAULT_P2_LIMIT, MAX_P2_LIMIT, EXECUTE_MAX_RESULT_CHARS } from './provider-config.ts'
import type { LayoutMetricsResult } from './provider-session.ts'

/**
 * 空格键的键参数。
 *
 * 两个名字共用一份描述：`' '`（单字符写法）与 `Space`（命名键写法，Playwright 风格）。
 * `Space` 这个别名不是可有可无的 —— 错误文案与 `webpage_press` 的工具描述都把 `Space`
 * 当作命名键宣传，表里却只有 `' '`，于是模型照描述写 `key: "Space"` 会被判成
 * 「unsupported key」（2026-09-18 修）。**宣传的名字必须真的能用。**
 *
 * `text: ' '` 也不是装饰：`Input.dispatchKeyEvent` 的 keyDown **只有带 text 才会合成字符
 * 插入**（keypress/input 事件链），不带 text 时聚焦输入框按空格不产生任何字符。
 */
const SPACE_KEY = { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ' }

/** 元素盒与视口是否有交集。视口尺寸缺失时无法判定，按「有交集」处理（不触发重测）。 */
export function boxIntersectsViewport(box: {
  x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number
}): boolean {
  if (box.viewportWidth === undefined || box.viewportHeight === undefined) return true
  return box.x < box.viewportWidth && box.x + box.width > 0
    && box.y < box.viewportHeight && box.y + box.height > 0
}

/**
 * 居中容差（CSS 像素）。要盖住两类已知偏差：滚动条半宽（`innerWidth` 含滚动条而
 * `getBoundingClientRect` 不含，垂直居中因此偏差 ≈ 滚动条宽的一半，Chromium 约 8px）
 * 与亚像素取整。16px 远小于「smooth 动画刚进视口边缘」的偏离量，判不出假阳性。
 */
const CENTER_TOLERANCE_PX = 16

/**
 * 元素盒是否**真的居中**在视口里（`webpage_locate` 的 `centered` 判据）。
 *
 * 「元素中心落在视口内」只证明看得见，不证明居中 —— smooth 滚动动画刚把元素送进视口
 * 边缘的中间帧会被它谎报成已居中（2026-10-07 独立验收）。这里按轴判真实对齐：
 *
 * - 元素该轴不超过视口：中心与视口中心对齐（±{@link CENTER_TOLERANCE_PX}）；
 * - 元素该轴超过视口：滚动被文档边缘夹住，「居中的极限」是元素完全盖住该轴的视口范围
 *   （此时 scrollIntoView 的 center 已把能滚的都滚了）。
 *
 * 视口尺寸缺读或 ≤0 时返回 `undefined` —— **无法判定**，调用方不得把 undefined 当成功。
 */
export function boxCenteredInViewport(box: {
  x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number
}): boolean | undefined {
  const vw = box.viewportWidth
  const vh = box.viewportHeight
  if (vw === undefined || vh === undefined || vw <= 0 || vh <= 0) return undefined
  const centredX = box.width >= vw
    ? box.x <= 0 && box.x + box.width >= vw
    : Math.abs(box.x + box.width / 2 - vw / 2) <= CENTER_TOLERANCE_PX
  const centredY = box.height >= vh
    ? box.y <= 0 && box.y + box.height >= vh
    : Math.abs(box.y + box.height / 2 - vh / 2) <= CENTER_TOLERANCE_PX
  return centredX && centredY
}

/** smooth 滚动重测的间隔等待；signal 中止时立即返回（下一轮测量自己会带上中止的 signal）。 */
export function sleepForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** `webpage_press` 认得的键：名字 → CDP 键参数。 */
const KNOWN_KEYS: ReadonlyMap<string, { key: string; code: string; virtualKeyCode: number; text?: string }> = new Map([
  ['Enter', { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' }],
  ['Tab', { key: 'Tab', code: 'Tab', virtualKeyCode: 9 }],
  ['Escape', { key: 'Escape', code: 'Escape', virtualKeyCode: 27 }],
  ['Backspace', { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8 }],
  ['Delete', { key: 'Delete', code: 'Delete', virtualKeyCode: 46 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 }],
  ['Home', { key: 'Home', code: 'Home', virtualKeyCode: 36 }],
  ['End', { key: 'End', code: 'End', virtualKeyCode: 35 }],
  ['PageUp', { key: 'PageUp', code: 'PageUp', virtualKeyCode: 33 }],
  ['PageDown', { key: 'PageDown', code: 'PageDown', virtualKeyCode: 34 }],
  [' ', SPACE_KEY],
  // 命名键别名：工具描述与错误文案都写的是 `Space`，必须真的收 —— 否则模型照描述写
  // `key: "Space"` 会被判成 unsupported key，看起来就是「这个插件按不了空格」。
  ['Space', SPACE_KEY],
])

/**
 * 把模型给的键名收窄成 CDP 键参数。
 * @param key - `Enter` / `Tab` / `ArrowDown` … 或单个可打印字符。
 * @throws `BROWSER_PROTOCOL_ERROR`：多字符且不在已知名单里（模型该换个写法重试）。
 */
export function describeKey(key: string): { key: string; code: string; virtualKeyCode: number; text?: string } {
  const known = KNOWN_KEYS.get(key)
  if (known !== undefined) return known
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      virtualKeyCode: key.toUpperCase().charCodeAt(0),
      text: key,
    }
  }
  throw new BrowserError(
    `unsupported key "${key}"; use a named key (Enter, Tab, Escape, Backspace, Delete, `
    + 'ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space) or a single character',
    'BROWSER_PROTOCOL_ERROR',
  )
}

/** 收窄 `limit`：缺省 / 非法落到默认值，过大压到 {@link MAX_P2_LIMIT}。 */
export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_P2_LIMIT
  return Math.min(Math.floor(limit), MAX_P2_LIMIT)
}

/**
 * 把过大的结果压成一段截断字符串。
 *
 * 逃生舱可能返回极大的对象（`DOM.getDocument{depth:-1}`、完整 AX 树），直接塞进工具结果会
 * 撑爆模型上下文。这里统一设一个上限：超了就退化成「JSON 文本 + 截断说明」，并在回执里标
 * `truncated`。注意退化后 `value` / `result` 的类型从对象变成字符串 —— schema 声明的是
 * 任意 JSON，两者都合法。
 */
export function capResult(value: unknown): { payload: unknown; truncated: boolean } {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = undefined
  }
  if (serialized === undefined || serialized.length <= EXECUTE_MAX_RESULT_CHARS) {
    return { payload: value, truncated: false }
  }
  const overflow = serialized.length - EXECUTE_MAX_RESULT_CHARS
  return {
    payload: `${serialized.slice(0, EXECUTE_MAX_RESULT_CHARS)}\n...[truncated ${overflow} chars]`,
    truncated: true,
  }
}

/** 把 `navigationSettled` 的探测结果从 `unknown` 收窄成结构化状态。 */export function readNavigationState(value: unknown): { ready: boolean; href: string } | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record: Record<string, unknown> = { ...parsed }
  const ready = record['ready']
  const href = record['href']
  return typeof ready === 'boolean' && typeof href === 'string' ? { ready, href } : undefined
}

/** 从 AX 节点读出与 snapshot 同一口径的 role/name，供 revalidate 核对。 */
export function axIdentity(nodes: readonly AxNode[], backendNodeId: number): { role: string; name: string } | undefined {
  const node = nodes.find(item => item.backendDOMNodeId === backendNodeId) ?? nodes[0]
  if (node === undefined) return undefined
  const roleRaw = node.role?.value
  const role = (typeof roleRaw === 'string' ? roleRaw : 'generic').toLowerCase()
  const nameRaw = node.name?.value
  const name = typeof nameRaw === 'string' ? clipObservedName(nameRaw) : ''
  return { role, name }
}

function clipObservedName(raw: string): string {
  const text = raw.replace(/\s+/gu, ' ').trim()
  const max = DEFAULT_SNAPSHOT_LIMITS.maxTextLength
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function viewportBoxFromMetrics(metrics: LayoutMetricsResult): BoxRect | undefined {
  const view = metrics.cssVisualViewport
    ?? metrics.visualViewport
    ?? metrics.cssLayoutViewport
    ?? metrics.layoutViewport
  if (view === undefined) return undefined
  const width = view.clientWidth
  const height = view.clientHeight
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  return { x: view.pageX ?? 0, y: view.pageY ?? 0, width, height }
}

/**
 * 从 PNG 的 IHDR 里读宽高。
 *
 * 不额外发一次 `Page.getLayoutMetrics`：真正要落盘的是这张图的像素尺寸，
 * 而 IHDR 就是它的权威来源（`Page.getLayoutMetrics` 给的是 CSS 像素，两者在
 * devicePixelRatio ≠ 1 时并不相等）。
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]
  const signatureMatches = PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  if (!signatureMatches || bytes.length < 24) {
    throw new BrowserError('the captured screenshot is not a PNG image', 'BROWSER_PROTOCOL_ERROR')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
