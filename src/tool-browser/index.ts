/** webpage 工具插件入口：配置启用、实例级缓存、租约监听与注册顺序。内部实现按职责拆分。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '../browser/index.ts'
import type { Config } from './config.ts'
import type { SnapshotCache } from './snapshot-cache.ts'
import { registerOpen, registerNavigate, registerSnapshot, registerScreenshot } from './tools/observation.ts'
import { registerTabs } from './tools/tabs.ts'
import { registerMutations } from './tools/mutations.ts'
import { registerConsole, registerNetwork, registerExecute } from './tools/diagnostics.ts'
import { registerFind, registerLocate, registerRevalidate } from './tools/discovery.ts'
import { registerSystemPrompt } from './system-prompt.ts'
import { noteLoaded } from '../debug.ts'

export {
  TOOL_BROWSER_SECTION_ORDER,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_OBSERVE_TIMEOUT_MS,
  UNTRUSTED_PAGE_CONTENT_NOTICE,
  Config,
  BROWSER_TOOL_CAPABILITIES,
} from './config.ts'

export const name = 'webpage-tools'

/** 本工具集依赖的服务。 */
export const inject = ['tools', 'browser', 'systemPrompt', 'attachments']

/**
 * 按配置注册网页工具与系统提示分段，并绑定实例级缓存的租约释放监听。
 *
 * `config` 容忍 `undefined`：本插件的 patch 行不带 `config:` 键，此时加载器传进来的是空值。
 *
 * （另注：**不要**给本模块加 `export default`。加载器会执行 `exports = exports.default ?? exports`，
 * 一旦有默认导出，`name` / `inject` / `Config` 这三个命名导出就整批消失，症状是
 * `cannot get property "systemPrompt" without inject` 这类莫名其妙的报错。）
 *
 * @param ctx - 上下文；`tools` / `systemPrompt` / `attachments` 与 `browser` 都必须已就绪。
 * @param config - 可选地关掉某几个工具。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const enabled = {
    open: config.open ?? true,
    navigate: config.navigate ?? true,
    snapshot: config.snapshot ?? true,
    screenshot: config.screenshot ?? true,
    tabs: config.tabs ?? true,
    click: config.click ?? true,
    fill: config.fill ?? true,
    press: config.press ?? true,
    scroll: config.scroll ?? true,
    wait: config.wait ?? true,
    console: config.console ?? true,
    network: config.network ?? true,
    execute: config.execute ?? true,
    find: config.find ?? true,
    locate: config.locate ?? true,
    revalidate: config.revalidate ?? true,
  }

  // find 的「最近一次 snapshot」缓存：本插件的 tool 层持有，provider 不掺和（零状态检索）。
  const snapshotCache: SnapshotCache = new Map()

  // 占用被**自动**回收（空闲超时 / 移交码过期）时，这份本地大纲缓存也要一起作废：
  // ref 纪元由能力缝隙通知 provider 作废，但缓存是纯本地的，provider 一个字都看不见它。
  // 显式的 release / handoff / close 在各自的分支里直接删，不必走这条通道。
  const stopLeaseWatch = ctx.browser.onLeaseRelease((_providerId, sessionId) => {
    snapshotCache.delete(sessionId)
  })
  ctx.effect(function* () {
    yield stopLeaseWatch
  }, 'webpage-tools.lease-watch()')

  registerSystemPrompt(ctx)

  if (enabled.open) registerOpen(ctx)
  if (enabled.navigate) registerNavigate(ctx, snapshotCache)
  if (enabled.snapshot) registerSnapshot(ctx, snapshotCache)
  if (enabled.screenshot) registerScreenshot(ctx)
  if (enabled.tabs) registerTabs(ctx, snapshotCache)
  if (enabled.click || enabled.fill || enabled.press || enabled.scroll || enabled.wait) {
    registerMutations(ctx, snapshotCache, { click: enabled.click, fill: enabled.fill, press: enabled.press, scroll: enabled.scroll, wait: enabled.wait })
  }
  if (enabled.console) registerConsole(ctx)
  if (enabled.network) registerNetwork(ctx)
  if (enabled.execute) registerExecute(ctx, snapshotCache)
  if (enabled.find) registerFind(ctx, snapshotCache)
  if (enabled.locate) registerLocate(ctx)
  if (enabled.revalidate) registerRevalidate(ctx)

  // 全部注册完再报，这样这一行同时证明 browser 能力与 systemPrompt / attachments
  // 都已就绪 —— 任一个 inject 没解析成功，本函数根本不会被执行。
  const registered = (Object.keys(enabled) as (keyof typeof enabled)[])
    .filter(key => enabled[key])
  noteLoaded('webpage-tools', `registered ${registered.join(', ')}`)
}
