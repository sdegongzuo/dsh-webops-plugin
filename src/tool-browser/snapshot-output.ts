/** 快照输出与缓存的共享契约：正常观察、wait 与 ref 失败恢复使用同一路径。 */
import { type SessionOutput, type PageChangedOutput, formatPageChanged, formatReboundRefs, SESSION_OUTPUT_SCHEMA, REF_ITEM_SCHEMA, PAGE_CHANGED_SCHEMA, toPageChangedOutput } from './common-output.ts'
import { UNTRUSTED_PAGE_CONTENT_NOTICE } from './config.ts'
import { type SnapshotCache, rememberSnapshot } from './snapshot-cache.ts'
import { MAX_SNAPSHOT_LINES, DEFAULT_SNAPSHOT_LIMITS } from '../browser-cdp/snapshot.ts'
import type { BrowserSnapshot } from '../browser/index.ts'
/** `webpage_snapshot` 的输出。 */
export interface SnapshotOutput extends SessionOutput {
  observation_id?: number
  scope?: string
  outline: string
  truncated: boolean
  /** 被截断时：实际输出的大纲行数。 */
  outline_lines?: number
  /** 被截断时：因预算没输出的元素个数。 */
  dropped_elements?: number
  /** 被折叠而未打印的重复行数（与 `dropped_elements` 是两套口径：元素都还在 `refs` 里）。 */
  folded_repeats?: number
  /** 因与祖先链上的某行同名而被跳过的行数（同一条链上同一个名字只印一次）。 */
  deduped_lines?: number
  /** 区域外的可引用大纲条目数，包含控件与只读锚点。 */
  outside_region?: number
  refs: { ref: string; role: string; name: string; anchor?: boolean }[]
  /** P3：有人正开着 DevTools 操作这个页面（结果可能随时失效，但 ref 纪元不受影响）。 */
  takeover?: boolean
  /** P2：页面在本会话之外变过（脏时才出现）。与 `takeover` 是两个维度，可同时出现。 */
  page_changed?: PageChangedOutput
  /** D-5：本次**区域快照**把哪几个号的指针换到了别的节点上（只报不作废）。 */
  rebound_refs?: { ref: string; role: string; name: string }[]
}

/** 大纲的文本渲染。 */
export function formatSnapshotOutput(snapshot: SnapshotOutput, currentFullSnapshotAttached = false): string {
  const controls = snapshot.refs.filter(entry => entry.anchor !== true).length
  const anchors = snapshot.refs.length - controls
  const header = [
    `${snapshot.url}`,
    snapshot.title.length > 0
      ? `title: ${snapshot.title}`
      : 'title: (empty — the document sets no <title>, or it is still loading)',
    `session_id=${snapshot.session_id} (ref epoch ${snapshot.epoch}, ${controls} actionable controls, ${anchors} read-only anchors)`,
    ...(snapshot.scope !== undefined ? [`scope=${snapshot.scope}; observation_id=${String(snapshot.observation_id)}`] : []),
  ].join('\n')
  // 两条告警都放在**大纲正文之前**：这份回执的正文可能几千行（实测中位 5516 字符，上限 33285），
  // 塞进末尾的 notes 等于没报 —— 模型读到那段时早就不看后面了。
  const warnings = [
    snapshot.page_changed === undefined ? '' : formatPageChanged(snapshot.page_changed, currentFullSnapshotAttached),
    snapshot.rebound_refs === undefined || snapshot.rebound_refs.length === 0
      ? ''
      : formatReboundRefs(snapshot.rebound_refs),
  ].filter(entry => entry !== '')
  const body = snapshot.outline.length > 0 ? snapshot.outline : '(the outline is empty — the page may still be loading)'
  const notes = [
    'Actionable controls carry [ref=eN]; headings carry read-only [anchor=eN]. Click/fill/press require a control ref, never a heading anchor. All are valid only for this epoch.',
    UNTRUSTED_PAGE_CONTENT_NOTICE,
  ]
  if (snapshot.truncated) {
    // 截断必须「可解释」：说清截到第几行、少给了多少元素、怎么拿更多，
    // 否则模型只能猜（报告 S3 的原始抱怨就是「长页大纲截断」没有任何下文）。
    const lines = snapshot.outline_lines === undefined ? '' : ` after ${String(snapshot.outline_lines)} lines`
    const dropped = snapshot.dropped_elements === undefined
      ? ''
      : ` ${String(snapshot.dropped_elements)} further element(s) were not emitted`
    notes.unshift(
      `The outline was truncated${lines};${dropped === '' ? '' : dropped} — the refs above cover only the emitted part. `
      + `Re-run webpage_snapshot with a larger max_lines (up to ${String(MAX_SNAPSHOT_LINES)}) if you need the rest, `
      + 'or use webpage_find to search the part that was emitted.',
    )
  }
  if (snapshot.outside_region !== undefined) {
    notes.unshift(
      `${String(snapshot.outside_region)} referenceable outline item(s), including controls and read-only anchors, sit outside this region. `
      + 'Other known region_refs remain usable; take a full snapshot only when the needed location is unknown.',
    )
  }
  if (snapshot.folded_repeats !== undefined) {
    // 折叠与截断是两回事，必须分开说：折叠的元素**没丢**，ref 还在，只是没打印。
    // 混在一起说会让模型以为「少的东西要靠抬 max_lines 找回来」，而抬预算对折叠毫无作用。
    notes.unshift(
      `${String(snapshot.folded_repeats)} repeated row(s) were folded. `
      + 'Nothing was lost; webpage_find lists every ref and section.',
    )
  }
  if (snapshot.deduped_lines !== undefined) {
    // 去重也**不是**丢东西：同一个名字在一条祖先链上被印了三遍（`heading "X" > link "X" > text "X"`），
    // 只留信息最多的那一行。不解释的话，模型可能会怀疑大纲漏了内容。
    notes.unshift(
      `${String(snapshot.deduped_lines)} nested duplicate row(s) were not printed. `
      + 'Nothing was lost; the retained row keeps the name and any actionable ref.',
    )
  }
  if (controls === 0) {
    // 零 ref 不是错误，是能力边界：必须告诉模型「这页上没东西可操作」以及还能干什么，
    // 否则它只看到一堆没有 ref 的文本，会反复 snapshot 或直接放弃（报告 S4/S5）。
    notes.unshift(
      `${snapshot.scope !== undefined && snapshot.scope !== 'full' ? 'This region' : 'This page'} has NO actionable elements (no links, buttons, inputs or other controls in the outline), `
      + 'so there is nothing to click, fill or press here — ref-based tools have nothing to act on. '
      + 'You can still scroll without a ref, navigate elsewhere, or use webpage_execute.',
    )
  }
  if (snapshot.takeover === true) {
    // 接管只提示「结果可能随时失效」，**不**说 ref 作废 —— 开合 DevTools 不推进 ref 纪元。
    notes.unshift('NOTE: a human has DevTools open on this page; content may change at any moment.')
  }
  if (controls > 0 && currentFullSnapshotAttached) {
    notes.push(`${String(controls)} control refs in this full snapshot are current and ready to use. `
      + 'Use them directly; find or a regional snapshot is only needed to recover omitted details or inspect a smaller area.')
  } else if (controls > 0) {
    // B3-b（无门禁那段）：把「下一步怎么用」写在末尾 —— 模型的默认动作是「再拍一次全页」，
    // 而全页重拍既贵又会把 find 的缓存换掉。默认行数也要说清，免得它一上来就抬 max_lines。
    notes.push(
      `${String(controls)} actionable element(s) carry refs. For a control you already know: `
      + 'use its current ref directly. Use find or a regional snapshot only for missing details or ambiguous targets. '
      + `Default max_lines is ${String(DEFAULT_SNAPSHOT_LIMITS.maxLines)} — raise it only when the result says truncated.`,
    )
  }
  const head = warnings.length === 0 ? header : `${header}\n\n${warnings.join('\n\n')}`
  return `${head}\n\n${body}\n\n${notes.join('\n')}`
}

/** `webpage_snapshot` 与 wait 共用的模型可见契约。 */
export const SNAPSHOT_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    ...SESSION_OUTPUT_SCHEMA.properties,
    observation_id: { type: 'integer' }, scope: { type: 'string' },
    outline: { type: 'string', required: true }, truncated: { type: 'boolean', required: true },
    outline_lines: { type: 'integer' }, dropped_elements: { type: 'integer' },
    folded_repeats: { type: 'integer' }, deduped_lines: { type: 'integer' }, outside_region: { type: 'integer' },
    refs: { type: 'array', required: true, items: REF_ITEM_SCHEMA }, takeover: { type: 'boolean' },
    page_changed: PAGE_CHANGED_SCHEMA, rebound_refs: { type: 'array', items: REF_ITEM_SCHEMA },
  },
} as const

/** 把 BrowserRuntime 的完整观察投影成与 webpage_snapshot 一致的输出。 */
export function toSnapshotOutput(observation: BrowserSnapshot): SnapshotOutput {
  return {
    session_id: observation.sessionId, url: observation.url, title: observation.title, epoch: observation.epoch,
    outline: observation.outline, truncated: observation.truncated, outline_lines: observation.outlineLines,
    ...observation.droppedElements !== undefined ? { dropped_elements: observation.droppedElements } : {},
    ...observation.foldedRepeats !== undefined ? { folded_repeats: observation.foldedRepeats } : {},
    ...observation.dedupedLines !== undefined ? { deduped_lines: observation.dedupedLines } : {},
    ...observation.outsideRegion !== undefined ? { outside_region: observation.outsideRegion } : {},
    refs: observation.refs.map(({ ref, role, name, anchor }) => ({ ref, role, name, ...anchor === true ? { anchor: true } : {} })),
    ...observation.takeover === true ? { takeover: true } : {},
    ...observation.pageChanged !== undefined ? { page_changed: toPageChangedOutput(observation.pageChanged) } : {},
    ...observation.reboundRefs !== undefined && observation.reboundRefs.length > 0
      ? { rebound_refs: observation.reboundRefs.map(({ ref, role, name }) => ({ ref, role, name })) } : {},
  }
}

/** wait 的全页快照与显式 snapshot 使用同一 find 缓存写入路径。 */
export function rememberBrowserSnapshot(cache: SnapshotCache, observation: BrowserSnapshot, scope = observation.scope ?? 'full'): SnapshotOutput {
  const output = toSnapshotOutput(observation)
  const cached = rememberSnapshot(cache, output, observation.fullOutline ?? observation.outline, scope === 'full' ? undefined : scope, observation.fullTexts, observation.textBlocks)
  return { ...output, observation_id: cached.observationId, scope }
}
