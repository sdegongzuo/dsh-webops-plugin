/** 跨工具组共享的输出投影、回执渲染与 schema；专用输出随工具组维护。 */

import { UNTRUSTED_PAGE_CONTENT_NOTICE } from './config.ts'
import type { BrowserSession, BrowserPageChanged, BrowserTabInfo } from '../browser/index.ts'

/**
 * 工具返回给会话的会话摘要（`webpage_open` / `webpage_navigate` 的 `output.schema`）。
 * 字段名用 snake_case，与模型侧参数命名一致。
 */
export interface SessionOutput {
  session_id: string
  url: string
  title: string
  epoch: number
}

/**
 * P2 的脏累加回执字段（`provider.BrowserPageChanged` 的 snake_case 投影）。
 *
 * 为什么是对象而不是一个 `changed: true`：文案口径（§6.2）要的是**动作**
 * （「导航过 1 次（A → B）」），模型据此才知道该不该重拍；只给一个布尔，它只能一律重拍。
 * 「出现即脏」这条语义不变 —— 干净时整个 `page_changed` 字段都不出现。
 */
export interface PageChangedOutput {
  navigated: number
  within_document: number
  address_drift?: number
  takeover_window?: number
  from?: string
  to?: string
  at?: number
}

/** 把一个会话投影成工具输出。 */
export function toSessionOutput(session: BrowserSession): SessionOutput {
  return { session_id: session.id, url: session.url, title: session.title, epoch: session.epoch }
}

/** 会话摘要的文本渲染：模型需要一眼看到自己在哪个页面、哪个纪元。 */
export function formatSessionOutput(session: SessionOutput): string {
  // 标题为空要**说出来**，不能只留一行空白：报告 S1/S5 就是在空标题上误判「页已就绪」的
  // （一个是导航刚提交、另一个是 httpbin 这种本来就没有 <title> 的页）。
  const title = session.title.length > 0
    ? `title: ${session.title}`
    : 'title: (empty — the document sets no <title>, or it is still loading)'
  return `${session.url}\n${title}\nsession_id=${session.session_id} (ref epoch ${session.epoch})\n\n${UNTRUSTED_PAGE_CONTENT_NOTICE}`
}

/**
 * 受控标签页在工具输出里的投影（snake_case），`webpage_tabs` 与 mutation 回执共用。
 *
 * `url` / `title` 可缺席：**空闲清单（`scope=available`）只给 id** —— 领取之前不向其他
 * 对话披露别人的页面标题（标题里往往就写着「订单 #4821 确认」这种内容）。
 */
export type TabOutput = {
  session_id: string
  url?: string
  title?: string
  active?: boolean
  /** 占用状态与剩余租期（毫秒）。只有 `webpage_tabs` 的清单会带上。 */
  lease?: { state: string; remaining_ms?: number }
}

/**
 * provider 的 `BrowserPageChanged` → 工具层的 snake_case 投影（方案 §6.2 ②）。
 *
 * 逐字段手写而不做通用 key 转换：工具层的字段名是**模型可见契约**，必须显式、可 diff，
 * 不能让一个大小写转换函数悄悄改掉它。
 */
export function toPageChangedOutput(changed: BrowserPageChanged): PageChangedOutput {
  return {
    navigated: changed.navigated,
    within_document: changed.withinDocument,
    ...changed.addressDrift !== undefined ? { address_drift: changed.addressDrift } : {},
    ...changed.takeoverWindow !== undefined ? { takeover_window: changed.takeoverWindow } : {},
    ...changed.route !== undefined ? { from: changed.route.from, to: changed.route.to } : {},
    ...changed.at !== undefined ? { at: changed.at } : {},
  }
}

/** provider 的标签页信息 → 工具输出。 */
export function toTabOutput(tab: BrowserTabInfo): TabOutput {
  return {
    session_id: tab.sessionId,
    ...tab.url !== undefined ? { url: tab.url } : {},
    ...tab.title !== undefined ? { title: tab.title } : {},
    ...tab.active !== undefined ? { active: tab.active } : {},
    ...tab.lease !== undefined
      ? { lease: { state: tab.lease.state, ...tab.lease.remainingMs !== undefined ? { remaining_ms: tab.lease.remainingMs } : {} } }
      : {},
  }
}

/** mutation 工具的输出。 */
export interface MutationOutput {
  session_id: string
  action: 'click' | 'fill' | 'press' | 'scroll' | 'wait'
  epoch: number
  url: string
  title: string
  navigated: boolean
  /**
   * P2：页面在本会话之外变过（脏时才出现）。
   *
   * 这是本字段最要紧的落点：人工的操作落在两轮之间，而模型下一轮往往是 `webpage_click` ——
   * 只有 snapshot 一条回执带提示的话它**结构性地看不到**（方案 §6.1 缺口 2）。
   */
  page_changed?: PageChangedOutput
  satisfied?: boolean
  /** wait(ref) 超时独有：元素此刻 hidden（在文档但无布局盒）、visible（还在显示）或 removed（已脱离文档）。 */
  ref_state?: string
  signals?: { readyState: string; dom: string; network: string }
  /** 本次操作新接管的标签页（页面自己弹的窗）；空则省略。 */
  opened_tabs?: TabOutput[]
  /** 被点击目标的身份（click 才有）：未导航回执要靠它说「点的是什么」。 */
  target?: { role: string; name: string; href?: string }
  /** 滚轮已投递但浏览器没回话（scroll 才有）：位置未确认，不是失败。 */
  unconfirmed?: boolean
}

/**
 * `click` 之后**没跳转**的回执正文（B2-a）。
 *
 * 顺序就是优先级，不能换（方案 §4.B2-a）：
 *
 * 1. 有 http(s) href —— 报 role/name/href，下一步要么按 Enter 要么直接 navigate
 * 2. 都没有 —— 八成是纯 JS 控件，先 snapshot 看有没有弹出对话框/菜单
 *
 * 被盖住的点击不再走到这里：命中测试证实遮挡时在派发前就拒绝（`BROWSER_TARGET_OCCLUDED`，
 * 2026-10-07 独立验收要求零页面副作用），回执里不会再出现「DISPATCHED 但被盖」的形态。
 * 不做自动 Enter（误触菜单），也不做自动 Escape（误关对话框）。
 */
function formatNoNavigation(value: MutationOutput): string {
  const target = value.target
  if (target !== undefined && target.href !== undefined) {
    return `\nThe click did NOT navigate. Target: role=${target.role}, name="${target.name}", href=${target.href}. `
      + 'Next step: press Enter on the same ref (webpage_press) — links that rewrite on mousedown or open in a new tab often need it — '
      + `or navigate straight to that href with webpage_navigate.`
  }
  const who = target === undefined
    ? 'no navigation followed'
    : `role=${target.role}, name="${target.name}" has no href (probably a JS control)`
  if ((value.page_changed?.navigated ?? 0) > 0) {
    return `\nThe click did NOT navigate — ${who}. Follow the document-change recovery above.`
  }
  return `\nThe click did NOT navigate — ${who}. `
    + 'If expecting generated text, use webpage_wait(text=...) for this reply. Otherwise inspect with '
    + 'webpage_snapshot(region_viewport=true) for a dialog or menu; use a full snapshot only if local '
    + 'observation cannot recover the structure. Check console/network only after observation.'
}

/**
 * P2 脏标记的文案（方案 §6.2 的「文案口径」）：**给动作，不给状态**。
 *
 * 「内容随时可能变」这种状态描述模型无从决策；这里必须说清三件事 —— 变了几次、从哪到哪、
 * 所以现在该干什么（重拍快照再动 ref）。
 *
 * ⚠️ 措辞是「本会话之外」而**不是「有人」**：事件这一层分不出「人工导航」和「页面自己的脚本
 * 换路由 / 重定向」，写死成「有人动过」就是插件替模型下了一个它证不了的结论。
 */
export function formatPageChanged(changed: PageChangedOutput): string {
  const parts: string[] = []
  if (changed.navigated > 0) {
    const where = changed.from === undefined || changed.to === undefined
      ? ''
      : ` (${changed.from} → ${changed.to})`
    parts.push(`navigated ${String(changed.navigated)} time(s)${where}`)
  }
  if (changed.within_document > 0) {
    parts.push(`had ${String(changed.within_document)} in-page navigation(s) `
      + '(history.pushState / replaceState / location.hash)')
  }
  if ((changed.address_drift ?? 0) > 0) {
    parts.push(`changed only its query/hash ${String(changed.address_drift)} time(s) — same page, so those refs were `
      + 'NOT invalidated (telemetry-style parameters such as sxsrf= change on nearly every interaction, but a search page '
      + 'may also really have changed)')
  }
  if ((changed.takeover_window ?? 0) > 0) {
    parts.push(`a human takeover window was opened ${String(changed.takeover_window)} time(s)`)
  }
  // 「SINCE YOUR LAST SNAPSHOT」只陈述观察事实（页面在上次观察后变过），不暗示有另一个
  // 操作者 —— 2026-10-07 实测：Google 页面自发的 pushState/replaceState 也会触发这条，
  // 旧文案 "OUTSIDE THIS SESSION" 让模型以为存在第二个对话或人工在抢页面。
  return `PAGE CHANGED SINCE YOUR LAST SNAPSHOT: this page ${parts.join('; ')}. `
    // ⚠️ 指令**按最强信号分级**（2026-09-20 实测修正）：只有真换文档（`navigated`）才配
    // 「重拍全页」。软导航/仅地址漂移时文档没换，refs 大概率仍有效，而重拍一张全页快照
    // 实测是 ~10.7K 字符，`webpage_revalidate` 只有几百 —— 用便宜探测代替贵重拍。
    // 旧文案对全部信号一律写 “run webpage_snapshot (full, not regional)”，与同一段里
    // `address_drift` 那半句刚说完的 “NOT invalidated” **自相矛盾**；Google 类页面每次交互
    // 换一批遥测令牌，于是模型被这句推着把同一页连拍 4 次（尺寸逐字节相同）。
    + (changed.navigated > 0
      ? 'The document changed, so every ref you took before that snapshot is dead — run webpage_snapshot '
        + '(full, not regional) before your next ref-based call.'
      : (changed.takeover_window ?? 0) > 0
        ? 'Opening DevTools alone does not invalidate refs, but pressing the human take-over button does: '
          + 'refs from before that take-over remain obsolete after handback. Use refs from a fresh full '
          + 'webpage_snapshot after handback; never retry a pre-take-over ref.'
        : 'The document itself did not change, so the refs you hold are probably still valid — verify the one you '
        + 'are about to use with webpage_revalidate (one cheap call) instead of re-running the full snapshot. '
        + 'Take a full snapshot only if that reports BROWSER_STALE_REF, or if the outline you hold no longer '
        + 'matches what the page reports.')
}

/**
 * D-5 的文案：区域快照**复用旧号**、把指针换到了另一个 DOM 节点上（方案 §5.2）。
 *
 * 必须讲清「报的是指针动过、不是元素变了」：SPA 重渲染把同一个控件换成新节点一样会命中这里，
 * 那是无害的；插件这一侧判不出两者的区别，所以给事实 + 判据，而不是给一个它保证不了的结论。
 */
export function formatReboundRefs(refs: { ref: string; role: string; name: string }[]): string {
  const listed = refs.slice(0, 20).map(entry => `${entry.ref} (${entry.role} "${entry.name}")`).join(', ')
  const more = refs.length > 20 ? `, and ${String(refs.length - 20)} more` : ''
  return `⚠ ${String(refs.length)} ref(s) were RE-BOUND to a different DOM node by this regional snapshot: `
    + `${listed}${more}. A regional snapshot does not invalidate refs, so these kept their numbers — but each now `
    + 'points at a newly created node carrying the same role and name. That is what a plain re-render looks like, so '
    + 'it is usually harmless; it is also what a list reorder / replacement looks like, and those two cannot be told '
    + 'apart from here. Verify one of them with webpage_locate, or take a full webpage_snapshot, before acting on them.'
}

/** mutation 结果的文本渲染：模型最需要知道的是「页面是否被导航、ref 是否还活着」。 */
export function formatMutationOutput(value: MutationOutput): string {
  // 点弹窗链接后**必须**明确点名新标签页：真机报告里模型点开 t2 之后 6 分钟毫不知情，
  // 一直对着旧页面做判断，最后在窗口最小化时发 activate → 撞出整窗空白。
  // 放在最前面（紧跟标题行）是因为它是本次调用里唯一「模型不查就永远不知道」的事实。
  const opened = value.opened_tabs === undefined || value.opened_tabs.length === 0
    ? ''
    : [
      // 「refs 不受影响」只在没导航时成立；导航并弹窗时下面那段 NAVIGATION DETECTED 才是正文，
      // 这里不能替它下结论（自相矛盾的提示比没有提示更糟）。
      `\nNEW TAB(S) OPENED by this ${value.action}: ${value.opened_tabs.length}. The page handed a popup / new-window target to this browser and it is now a controlled tab in the SAME window — session_id=${value.session_id} is still open${value.navigated ? '.' : ', and its refs are unaffected.'}`,
      ...value.opened_tabs.map(tab =>
        `- session_id=${tab.session_id}${tab.active === true ? ' [foreground]' : ''} — ${tab.url ?? ''}${tab.title !== undefined && tab.title.length > 0 ? ` (${tab.title})` : ' (title not read yet — the page may still be loading)'}`),
      `Act on it with the new session_id (webpage_snapshot on it, webpage_tabs(action=activate, session_id=...) to bring it forward, webpage_tabs(action=close, ...) to discard it). If what you were looking for ended up in one of these tabs, switch to it — do NOT re-navigate the old tab hunting for it.`,
    ].join('\n')
  // 点完没跳转是最容易被误解的回执：模型拿不到任何「为什么」，于是去翻 console / network
  // 猜（方案 §6 禁止清单）。按顺序把**真实原因与下一步**摆出来，省掉那一圈瞎猜。
  const noNavigation = value.navigated || value.action !== 'click'
    ? ''
    : formatNoNavigation(value)
  // 「下一步是 snapshot，不是 find」必须写死在这句话里：导航把 find 的缓存大纲一起作废了，
  // 而模型刚跳完页最想做的恰恰是「找刚才那个东西」—— 于是一次必红的 find 就这么发生了
  // （方案 §6 禁止清单第三条）。
  const navigation = value.navigated
    ? '\nNAVIGATION DETECTED: every ref from earlier snapshots is now invalid — run webpage_snapshot again before any ref-based call. '
      + 'The next call is webpage_snapshot, NOT webpage_find: the cached outline was dropped with the navigation, so find has nothing to search.'
    : '\nRefs from the latest snapshot are still valid unless the page changed on its own.'
  // 导航后标题为空要说清是「还没读到」而不是「没导航」：报告 S1 就是拿空标题当「页没就绪」，
  // 于是又等一次。provider 已经补过一小段等待，这里只是把残留情况讲明白。
  const title = value.navigated && value.title.length === 0
    ? '\nThe new document has no title yet (it may still be loading).'
    : ''
  // 「已投递未确认」必须说清**不是失败**：否则模型会当成没滚成功，反复重发把页面滚过头。
  const unconfirmed = value.unconfirmed !== true
    ? ''
    : '\nDELIVERED BUT NOT ACKNOWLEDGED: the wheel event was sent, but the browser did not answer in time — '
      + 'the scroll may or may not have happened. Confirm the position with webpage_snapshot or webpage_locate '
      + 'instead of scrolling again (repeating it blindly overshoots).'
  const waitSignals = value.signals === undefined
    ? ''
    : `\nSignals: readyState=${value.signals.readyState}, dom=${value.signals.dom}, network=${value.signals.network}.`
  const wait = value.satisfied === undefined
    ? ''
    : value.satisfied
      ? `\nThe awaited condition became true before the timeout.${waitSignals}`
        + (!value.navigated && (value.page_changed?.navigated ?? 0) === 0
          ? ' If needed, read updated text with webpage_snapshot(region_viewport=true) for a visible fragment, or region_ref covering the CURRENT reply; verify its tail before claiming a complete answer.'
          : '')
      : `\nThe awaited condition did NOT become true before the timeout; decide whether to retry, re-snapshot, or give up.${waitSignals}`
        // 项 2（2026-10-07）：ref 等待超时时，把元素此刻的三态之一讲破 ——
        // 「被隐藏」与「页面没移除它」是两回事，别把隐藏当成提交失败。
        + (value.ref_state === 'hidden'
          ? ' The awaited element is still in the document but not visible; it may retain a layout box (visibility:hidden). The removal condition succeeds only when the node actually leaves the document.'
          : value.ref_state === 'visible'
            ? ' The awaited element is still attached AND displayed — the page has not removed or hidden it.'
            : value.ref_state === 'removed'
              ? ' The awaited element has already left the document — if you were waiting for it to be merely hidden (ref_state="hidden"), the node was removed instead, which is a different outcome.'
              : '')
        // `until=stable` 在「页面还在加载 / 还在发请求」时几乎不可能满足：加长 stable 的 deadline
        // 只是把空等拉长。真正该做的是等**具体内容**出现（B2-c 第 3 条）。
        + (value.signals !== undefined
          && (value.signals.network === 'busy' || value.signals.readyState === 'loading')
          ? ' The page is still busy (network or document), so waiting longer for "stable" is unlikely to help: '
            + 'switch to webpage_wait(text=...) for the text you actually expect, or wait for a specific ref.'
          : '')
  const where = value.title.length > 0 ? `${value.url} — ${value.title}` : value.url
  // 紧挨着 `navigation` 那一段：两句话说的是同一件事的两个侧面（「我这次动作换页了没」与
  // 「页面在我之外换过没」），分开放进 notes 会让模型只读到其中一句（§6.3 的去重意图）。
  const pageChanged = value.page_changed === undefined ? '' : `\n${formatPageChanged(value.page_changed)}`
  return [
    `${value.action} done on session_id=${value.session_id} (now at ${where}, ref epoch ${value.epoch}).`,
    opened,
    navigation,
    pageChanged,
    noNavigation,
    unconfirmed,
    title,
    wait,
    `\n${UNTRUSTED_PAGE_CONTENT_NOTICE}`,
  ].join('')
}

/**
 * 会话 id 参数的定义（四个工具共用同一份文案，避免各处漂移）。
 *
 * 必须写成 `as const` 而不是标注成 `ParameterPropertySpec`：后者会把字面量类型擦成联合类型，
 * 于是 `defineTool` 推不出 `args.session_id: string`，只会得到 `JsonValue | ...`。
 */
export const SESSION_ID_PARAMETER = {
  type: 'string',
  required: true,
  // 「在同一个 tab 上每次调用都复用」这句归**系统提示词**（它每步只发一份）；
  // 写在这里等于 ×15 份重复（方案 §2.T-C2；系统提示词里已有 "pass it to every later call"）。
  description: 'Session id from webpage_open.',
} as const

/** 可操作 ref 的 schema，`refs` 数组与 `outline` 共用。 */
export const REF_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', required: true },
    role: { type: 'string', required: true },
    name: { type: 'string', required: true },
  },
} as const

/**
 * P2 脏标记字段的 schema（`snapshot` / `mutate` 全族 / `execute` / `revalidate` 共用）。
 *
 * 全部字段**非 required** —— 这个对象本身「脏时才出现」，出现了也不是每个桶都有数
 * （`takeover_window` 在通道缺席时整条不出现，`from`/`to` 在读不到地址时不出现）。
 * 把它写成 required 会逼出「填个 0 顶上去」，而那正是 D-20 禁止的「给噪声加喇叭」。
 */
export const PAGE_CHANGED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    navigated: { type: 'integer', required: true },
    within_document: { type: 'integer', required: true },
    address_drift: { type: 'integer' },
    takeover_window: { type: 'integer' },
    from: { type: 'string' },
    to: { type: 'string' },
    at: { type: 'integer' },
  },
} as const

/** 会话摘要的 schema，`open` / `navigate` 共用。 */
export const SESSION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    epoch: { type: 'integer', required: true },
  },
} as const

/**
 * `webpage_tabs` 清单里的一项。
 *
 * `url` / `title` 不标 required：空闲清单（`scope=available`）只给标签 id，领取之前
 * 不披露别人的页面内容。
 */
export const TAB_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session_id: { type: 'string', required: true },
    url: { type: 'string' },
    title: { type: 'string' },
    active: { type: 'boolean' },
    lease: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: { type: 'string', required: true },
        remaining_ms: { type: 'integer' },
      },
    },
  },
} as const
