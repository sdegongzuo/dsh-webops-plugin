/** 标签列表、占用、移交与关闭：回执和关联缓存失效。 */

import type { Context } from '@deepseek-ai/cordis'
import { type TabOutput, TAB_ITEM_SCHEMA, toTabOutput } from '../common-output.ts'
import { UNTRUSTED_PAGE_CONTENT_NOTICE, BROWSER_OBSERVE_TIMEOUT_MS } from '../config.ts'
import type { SnapshotCache } from '../snapshot-cache.ts'
import { defineTool, callerOf, observeCall } from '../tool-runtime.ts'
import type { BrowserTabsRequest } from '../../browser/index.ts'

/** `webpage_tabs` 的输出。 */
interface TabsOutput {
  action: 'list' | 'activate' | 'close' | 'claim' | 'release' | 'handoff'
  session_id?: string
  tabs: TabOutput[]
  /** `handoff` 才有的一次性移交码。**只出现在这一条回执里**。 */
  handoff_code?: string
}

/** 一条清单行的渲染：标签 id、前台标记、地址与标题、剩余租期。 */
function formatTabRow(tab: TabOutput): string {
  const where = tab.url === undefined
    ? ''
    : ` — ${tab.url}${tab.title !== undefined && tab.title.length > 0 ? ` (${tab.title})` : ''}`
  const lease = tab.lease === undefined
    ? ''
    : tab.lease.remaining_ms === undefined
      ? ` | ${tab.lease.state}`
      : ` | ${tab.lease.state}, releases in ${formatLeaseRemaining(tab.lease.remaining_ms)}`
  return `- session_id=${tab.session_id}${tab.active === true ? ' [foreground]' : ''}${where}${lease}`
}

/** 剩余租期的可读形态。秒级精度足够 —— 模型要的是「还早 / 快到了」。 */
function formatLeaseRemaining(remainingMs: number): string {
  const minutes = Math.round(remainingMs / 60_000)
  if (minutes >= 1) return `${String(minutes)}m`
  return `${String(Math.max(1, Math.round(remainingMs / 1000)))}s`
}

/**
 * 标签页清单的文本渲染。
 *
 * 两条分支的**差别是刻意的**（实施方案 §4）：
 * - 默认清单只列本对话占用的标签，带地址、标题与剩余租期；
 * - `scope=available` 只给标签 id —— 领取之前不披露别人页面上有什么。
 */
function formatTabsOutput(value: TabsOutput, scope?: 'held' | 'available'): string {
  if (scope === 'available') {
    const rows = value.tabs.length === 0
      ? ['(none — every controlled tab is held right now)']
      : value.tabs.map(formatTabRow)
    return [
      `${String(value.tabs.length)} idle controlled tab(s). Titles and URLs are withheld until you claim one:`,
      ...rows,
      '',
      'Either open your own tab with webpage_open, or claim one with webpage_tabs(action=claim, session_id=...) — '
      + 'a successful claim invalidates every ref the previous owner held, so run a FULL webpage_snapshot before using any ref. '
      + 'An idle tab is first-come-first-served: if another conversation claims it first you get BROWSER_TAB_OCCUPIED, which is not retryable — pick another.',
      UNTRUSTED_PAGE_CONTENT_NOTICE,
    ].join('\n')
  }
  const header = ((): string => {
    switch (value.action) {
      case 'list':
        return `${String(value.tabs.length)} controlled tab(s) HELD BY THIS CONVERSATION (tabs held by other conversations are not listed; user tabs are never listed or touched):`
      case 'activate':
        return `Activated session_id=${value.session_id ?? ''}. Your held tab(s) now:`
      case 'close':
        return `Closed session_id=${value.session_id ?? ''}. Your held tab(s) now:`
      case 'claim':
        return `Claimed session_id=${value.session_id ?? ''}. You are its owner now: your held tab(s) are:`
      case 'release':
        return `Released session_id=${value.session_id ?? ''}. The page stays open and is now IDLE — any conversation may claim it:`
      case 'handoff':
        return `Handed off session_id=${value.session_id ?? ''}. You lost write access the moment it was issued:`
    }
  })()
  const rows = value.tabs.length === 0
    ? ['(none — open one with webpage_open)']
    : value.tabs.map(formatTabRow)
  const notes: string[] = []
  if (value.action === 'claim') {
    notes.push('Claiming bumped the ref epoch: every ref from before is dead, so run a FULL webpage_snapshot before any ref-based call.')
  }
  if (value.action === 'release' || value.action === 'handoff') {
    notes.push('Any ref you held on the released session is now invalid.')
  }
  if (value.handoff_code !== undefined) {
    notes.push(
      `ONE-TIME HANDOFF CODE (session ${value.session_id ?? ''}): ${value.handoff_code}`,
      'Give this code to the other conversation; it claims the tab with webpage_tabs(action=claim, session_id=..., handoff_code=<code>). '
      + 'The code works exactly once and expires on its own — if it expires first the tab simply becomes idle, and the page is kept. '
      + 'To open a tab up for anyone instead of one specific conversation, use action=release.',
    )
  }
  notes.push(UNTRUSTED_PAGE_CONTENT_NOTICE)
  return [header, ...rows, '', ...notes].join('\n')
}

/** `webpage_tabs` 的输出。 */
const TABS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    session_id: { type: 'string' },
    tabs: { type: 'array', required: true, items: TAB_ITEM_SCHEMA },
    /** `handoff` 才有的一次性移交码。 */
    handoff_code: { type: 'string' },
  },
} as const

/**
 * 注册 `webpage_tabs`：受控标签页的 list / activate / close。
 *
 * 所有权边界与 P0 一致 —— 清单里只有**本插件自己开**的标签页；用户的标签页
 * 既不出现也不会被关掉。
 *
 * @param ctx - 上下文；其 `browser` 服务执行标签页操作。
 * @param cache - find 的 snapshot 缓存；close 成功即删对应会话的大纲。
 */
export function registerTabs(ctx: Context, cache: SnapshotCache): void {
  ctx.tools.register(defineTool({
    name: 'webpage_tabs',
    description:
      'Manage this plugin\'s tabs; they are owned per conversation — only your own are listed. '
      + 'list (scope=held default, or available for idle ids); claim an idle tab — it kills every ref, so re-snapshot after; '
      + 'release returns it open; handoff gives a one-time code and ends your access; activate; close. ',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'list | claim | release | handoff | activate | close',
      },
      session_id: { type: 'string', description: 'Omit for list.' },
      scope: { type: 'string', description: 'For list: held | available.' },
      handoff_code: { type: 'string', description: 'For claim on a handed-over tab.' },
    },
    output: {
      schema: TABS_OUTPUT_SCHEMA,
      // schema DSL 的 value 类型把 action 推成 string；这里收口成具体形态。
      render: (args, value) => [{
        type: 'text',
        text: formatTabsOutput(value as TabsOutput, args.scope === 'available' ? 'available' : undefined),
      }],
    },
    timeoutMs: BROWSER_OBSERVE_TIMEOUT_MS,
    async execute(args, exec) {
      const action = String(args.action)
      if (action !== 'list' && action !== 'claim' && action !== 'release' && action !== 'handoff'
        && action !== 'activate' && action !== 'close') {
        throw new Error('action must be one of: list, claim, release, handoff, activate, close')
      }
      if (action !== 'list' && args.session_id === undefined) {
        throw new Error(`action "${action}" requires session_id`)
      }
      if (args.scope !== undefined && action !== 'list') {
        throw new Error('scope only applies to action=list')
      }
      if (args.handoff_code !== undefined && action !== 'claim') {
        throw new Error('handoff_code only applies to action=claim')
      }
      const request: BrowserTabsRequest = action === 'list'
        ? { kind: 'list', ...args.scope === 'available' ? { scope: 'available' as const } : {} }
        : action === 'claim'
          ? {
            kind: 'claim',
            sessionId: args.session_id as string,
            ...args.handoff_code !== undefined ? { handoffCode: String(args.handoff_code) } : {},
          }
          : {
            kind: action as 'release' | 'handoff' | 'activate' | 'close',
            sessionId: args.session_id as string,
          }
      const result = await ctx.browser.tabs(request, callerOf(exec), exec.signal)
      // 归属一变，本地缓存的那份大纲就属于上一个主人了：claimed 的人不该看到它，
      // released / handed off 的人也不该留着它（门禁虽然拦得住，但留着只会误导）。
      // 逐个删 `affectedSessionIds`：迁移是整个弹窗家族一起做的，只删请求目标会把旧主人
      // 拍的子标签快照留给新主人 —— 它能跳过「先拍快照」这一步，直接检索别人的大纲（§3.2）。
      // `close` 不填这个字段（只摘目标一条记录），所以用 `sessionId` 兜底。
      if (result.action === 'close' || result.action === 'claim'
        || result.action === 'release' || result.action === 'handoff') {
        const affected = result.affectedSessionIds
          ?? (result.sessionId !== undefined ? [result.sessionId] : [])
        for (const id of affected) cache.delete(id)
      }
      return {
        action: result.action,
        ...result.sessionId !== undefined ? { session_id: result.sessionId } : {},
        tabs: result.tabs.map(toTabOutput),
        ...result.handoffCode !== undefined ? { handoff_code: result.handoffCode } : {},
      }
    },
    presentCall: args => observeCall(
      args.action === 'list'
        ? (args.scope === 'available' ? 'List idle browser tabs' : 'List held browser tabs')
        : `${String(args.action).charAt(0).toUpperCase()}${String(args.action).slice(1)} tab ${args.session_id ?? ''}`,
      args.action === 'list' ? 'read' : 'execute',
      args.session_id ?? args.action,
    ),
  }))
}
