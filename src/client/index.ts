/**
 * 浏览器插件的**浏览器半边**（`dsh.client` 双面包的 client face）。
 *
 * 它做两件事，都只读、都不新增基础设施：
 *
 * 1. `conversation.input.dock` —— 常驻状态条；数据来自对话快照里已有的 `webpage_*`
 *    工具调用节点，因此天然「跟随 agent 操作」，无需新增 RPC。
 * 2. `tool.call.toolview` 的四个 key —— 让 `webpage_open / navigate / snapshot /
 *    screenshot` 各自有专属卡片（地址、大纲、截图），而不是落进通用兜底卡片。
 *
 * 注册一律走 `ctx.slots.inject`：`tool.call.toolview` 由 ui-tool 在更深的组合里声明，
 * 直接从外部 `register` 会因加载顺序抛「slot is not declared」。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { BrowserDock } from './BrowserDock.tsx'
import { BrowserToolRow } from './BrowserToolRow.tsx'
import { BROWSER_NS, en, zh } from './locales.ts'

/** 需要浏览器服务、slot 注册表与文案。 */
export const inject = ['slots', 'locale']

/** 本插件认领的工具（P0 只读四个 + P1 的 tabs 与五个操作工具 + P2/P3 的五个调试工具）。 */
export const BROWSER_TOOLS = [
  'webpage_open',
  'webpage_navigate',
  'webpage_snapshot',
  'webpage_screenshot',
  'webpage_tabs',
  'webpage_click',
  'webpage_fill',
  'webpage_press',
  'webpage_scroll',
  'webpage_wait',
  'webpage_console',
  'webpage_network',
  'webpage_execute',
  'webpage_find',
  'webpage_locate',
  'webpage_revalidate',
] as const

/**
 * 在 `<html>` 上落一个加载信标。
 *
 * 客户端半边跑在浏览器里，没有 stdout 可看；这个属性是「bundle 被拉取并执行过」的
 * 唯一外部可观测证据（也是验证脚本用 CDP 检查的锚点）。它只写一个 dataset 键，
 * 不参与任何渲染或业务逻辑。
 */
function markLoaded(): void {
  const root = globalThis.document?.documentElement
  if (root === undefined) return
  root.dataset['dshBrowserPlugin'] = '1'
}

/**
 * 记录某个 slot 面上**真正注册成功**的条目数。
 *
 * 为什么不能只看 `markLoaded`：`ctx.slots.inject(name, cb)` 的 cb 要等 `name` 被声明才跑，
 * 声明没来就什么都不发生——「bundle 执行过」和「卡片注册上了」是两件事。把注册结果也写成
 * dataset 键，验证脚本才能分开断言这两件事（否则卡片静默缺席时无从察觉）。
 * @param face - dataset 键后缀（`Dock` / `ToolViews`）。
 * @param count - 该面上已注册的条目数。
 */
function markRegistered(face: string, count: number): void {
  const root = globalThis.document?.documentElement
  if (root === undefined) return
  root.dataset[`dshBrowserPlugin${face}`] = String(count)
}

/**
 * 浏览器半边入口。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  markLoaded()
  ctx.effect(() => ctx.locale.register(BROWSER_NS, { zh, en }), 'webops-plugin: dictionaries')

  ctx.slots.inject('conversation.input.dock', () => {
    const dispose = ctx.slots.register(
      { name: 'conversation.input.dock', id: 'browser', order: 10, locale: BROWSER_NS },
      BrowserDock,
    )
    markRegistered('Dock', 1)
    return dispose
  })

  let toolViews = 0
  for (const key of BROWSER_TOOLS) {
    ctx.slots.inject('tool.call.toolview', () => {
      const dispose = ctx.slots.register(
        { name: 'tool.call.toolview', key, locale: BROWSER_NS },
        BrowserToolRow,
      )
      toolViews += 1
      markRegistered('ToolViews', toolViews)
      return dispose
    })
  }
}
