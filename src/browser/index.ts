/**
 * ctx.browser —— 浏览器能力的能力缝隙（Service Definition）。
 *
 * 形状与 provider 选择语义照 dsh 的 `packages/web/web/src/index.ts` 对齐：
 * 选择在**调用时**解析，绝不依赖注册顺序。
 *
 * ## 它同时是**唯一的受控入口**
 *
 * 每个受控标签同时最多归一个宿主对话使用（实施方案《多会话防冲突》§5.1）。这条规则
 * 只在能力缝隙这一层能立住：provider 不认识「谁在调用我」，工具层又不能既做检查又裸调
 * provider（那会留下一条绕过检查的路）。所以本服务的每一个公开方法都：
 *
 * 1. 要求**调用方身份** `caller`（由工具层从 `exec.agent.id` 提取，**不是模型参数**）；
 * 2. 走 {@link TabLeaseRegistry} 核对占用、记 `activeCalls`；
 * 3. 才把请求转发给 provider；`finally` 里核销记账。
 *
 * 跨对话的标签在 `list` 里根本不出现；要操作得先 `claim`（空闲）或凭一次性码领取（移交）。
 *
 * @module dsh-webops-plugin/browser
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrowserError } from './types.ts'
import { TabLeaseRegistry } from './lease.ts'
import { attachRefRecovery } from './ref-recovery.ts'
import { TabCallQueue } from './tab-call-queue.ts'
import type { TabLeaseReleaseListener } from './lease.ts'
import type {
  BrowserCaller,
  BrowserCompletionEvidence,
  BrowserConsoleRequest,
  BrowserConsoleResult,
  BrowserErrorCode,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserLocateRequest,
  BrowserLocateResult,
  BrowserMutationRequest,
  BrowserMutationResult,
  BrowserNavigateRequest,
  BrowserNetworkRequest,
  BrowserNetworkResult,
  BrowserObservation,
  BrowserObserveRequest,
  BrowserOpenRequest,
  BrowserPageChanged,
  BrowserProvider,
  BrowserRevalidateRequest,
  BrowserRevalidateResult,
  BrowserSession,
  BrowserTabInfo,
  BrowserTabsRequest,
  BrowserTabsResult,
  BrowserWaitEvidence,
} from './types.ts'

/**
 * 把 provider 的等待原始证据补成模型可见的完成证据。
 *
 * 范围、大纲完整性只能等附观察真正拿到之后再填：请求里写了 `region_tail` 不等于
 * 最后真的落在 tail（首次/导航/交还/新浮层会强制全页）。观察缺失时一律按
 * `outlineComplete=false` / `truncated=true` 的保守值，绝不把「未观察」写成「完整」。
 */
function withCompletion(result: BrowserMutationResult): BrowserMutationResult {
  const evidence = result.waitEvidence
  if (evidence === undefined) return result
  const snapshot = result.snapshot
  const completion: BrowserCompletionEvidence = {
    ...evidence,
    outlineComplete: snapshot !== undefined && snapshot.truncated === false,
    textComplete: false,
    scope: snapshot?.scope ?? 'unobserved',
    truncated: snapshot?.truncated ?? true,
  }
  return { ...result, completion }
}

function mergePageChanges(first: BrowserPageChanged | undefined, second: BrowserPageChanged | undefined): BrowserPageChanged | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return {
    navigated: first.navigated + second.navigated,
    withinDocument: first.withinDocument + second.withinDocument,
    ...(first.addressDrift !== undefined || second.addressDrift !== undefined
      ? { addressDrift: (first.addressDrift ?? 0) + (second.addressDrift ?? 0) } : {}),
    ...(first.takeoverWindow !== undefined || second.takeoverWindow !== undefined
      ? { takeoverWindow: (first.takeoverWindow ?? 0) + (second.takeoverWindow ?? 0) } : {}),
    ...(second.route !== undefined || first.route !== undefined
      ? { route: second.route ?? first.route } : {}),
    ...(second.at !== undefined || first.at !== undefined
      ? { at: second.at ?? first.at } : {}),
  }
}

function observationFailure(error: unknown): { code: BrowserErrorCode; message: string } {
  return error instanceof BrowserError
    ? { code: error.code, message: error.message }
    : { code: 'BROWSER_PROTOCOL_ERROR', message: error instanceof Error ? error.message : String(error) }
}

/**
 * 校验「正整数个数」配置（与 `lease.ts` 的 `requirePositiveMs` 同一口径，只是单位不同）。
 *
 * 不静默回落默认值：配置写错时人要立刻知道，否则「改成 8 了」和「根本没改」在运行态同形。
 * @param value - 配置值。
 * @param field - 配置键名，写进错误消息。
 * @returns 原值（已确认是正整数）。
 * @throws `BROWSER_PROTOCOL_ERROR`：非正整数。
 */
function requirePositiveCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BrowserError(
      `browser config "${field}" must be a positive integer, got ${String(value)}; `
      + 'zero or negative would forbid every new tab instead of limiting them — remove the option to keep the default',
      'BROWSER_PROTOCOL_ERROR',
    )
  }
  return value
}

/**
 * 目标网址的规范化形式，**只用于比较落点是否已经在目标地址上**。
 *
 * 只认 http(s)：其余 scheme（`javascript:` / `mailto:` / `about:`）不是「打开一个网页」，
 * 让它们走新建路径，由 provider 的地址策略照今天的样子拒绝 —— 用复用路径去试探策略边界，
 * 等于把「拒绝」变成「把用户手上的页面导航到一个非法地址」。
 *
 * 非法 URL 返回 `undefined`：地址策略归 provider，这里绝不替它判合法性。
 */
function normalizedUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

/**
 * 复用落点在「选好之后、动手之前」失效的三种竞争。
 *
 * 都只说明**这个落点此刻不能用**，不说明请求本身有问题：人刚按下接管、标签被关掉、
 * 同标签上还有一次调用在跑。回落新建比把失败甩给模型更接近 OPEN 的本意。
 */
function isReuseRace(error: unknown): boolean {
  return error instanceof BrowserError
    && (error.code === 'BROWSER_TAB_NOT_HELD'
      || error.code === 'BROWSER_TAB_BUSY'
      || error.code === 'BROWSER_HUMAN_HOLDING')
}

export { BrowserError, isBrowserError, presentBrowserError } from './types.ts'
export { DEFAULT_TAB_HANDOFF_TTL_MS, DEFAULT_TAB_LEASE_IDLE_MS, TabLeaseRegistry } from './lease.ts'
export type { TabLeaseReleaseReason, TabLeaseView } from './lease.ts'
export type {
  BrowserCaller,
  BrowserConsoleEntry,
  BrowserConsoleRequest,
  BrowserConsoleResult,
  BrowserErrorCode,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserLocateRequest,
  BrowserLocateResult,
  BrowserMutationRequest,
  BrowserMutationResult,
  BrowserNavigateRequest,
  BrowserNetworkEntry,
  BrowserNetworkRequest,
  BrowserNetworkResult,
  BrowserObservation,
  BrowserObserveRequest,
  BrowserOpenRequest,
  BrowserPageChanged,
  BrowserProvider,
  BrowserRef,
  BrowserRevalidateFailure,
  BrowserRevalidateFailureReason,
  BrowserRevalidateRequest,
  BrowserRevalidateResult,
  BrowserScreenshot,
  BrowserSession,
  BrowserSnapshot,
  BrowserTabInfo,
  BrowserTabLease,
  BrowserTabLeaseState,
  BrowserTabsRequest,
  BrowserTabsResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/** 能力缝隙的配置：钉住 provider，并给出标签租期的两个时限。 */
export interface BrowserRuntimeConfig {
  /** 显式指定 provider id。省略 = 恰好一个可用时自动选。 */
  readonly provider?: string
  /** 标签空闲多久后自动释放占用（毫秒）。默认 30 分钟；必须是正整数。 */
  readonly tabLeaseIdleMs?: number
  /** 一次性移交码的有效期（毫秒）。默认 5 分钟；必须是正整数。 */
  readonly tabHandoffTtlMs?: number
  /**
   * `open()` 在本对话**已持有**标签时，是否复用其中一个并导航过去。默认 `true`。
   *
   * 为什么要这个开关：它把「一个 URL 一个标签」从模型纪律变成接口默认行为 —— 模型最直觉的
   * 写法（每个 URL 一次 `webpage_open`）不再必然堆标签。但复用意味着**旧页面被导航走**，
   * 与「open = 开新页」的既有预期不同，所以要留一条关掉即回到旧行为的路。
   */
  readonly reuseOwnTabOnOpen?: boolean
  /**
   * 本对话最多能同时持有多少个受控标签。默认 `8`；必须是正整数。
   *
   * 只在「新建」（档 3）前检查：档 1 领取空闲标签、档 2 复用自有标签都不增加标签数，
   * 因此不受限 —— 否则「上限 1 且复用开着」的正常读页路径会被自己挡死。
   *
   * 为什么要有它：`reuseOwnTabOnOpen` 只挡住「每个 URL 一次 open」这一种堆积方式，
   * 而 `open()`（不带 url，开空白页）仍然每次新建。没有上限时，一个反复开空白页再
   * 导航的模型可以把标签堆到几十个，而租期到期只释放占用、不关页面，页面一直活到进程退出。
   *
   * 8 是**绝对硬顶**：模型确实需要并排好几个页面时可以开到 8，但超过就不给开，
   * 回执里列出当前持有的标签让它先关掉几个或改用 navigate，而不是无界增长。
   */
  readonly maxOwnedTabs?: number
}

/**
 * 让 `provider` 可以走环境变量的变量名。
 *
 * 为什么需要：桌面端的 profile 目录由应用独占并每次重建，往里写 `config.provider` 活不过一次重启；
 * 而桌面端里 `cdp`（连 9222，也就是桌面端自己）与 `electron`（开真窗口）都可能「可用」，
 * 不指定就会撞上 `BROWSER_PROVIDER_AMBIGUOUS`。env 是唯一稳定的旋钮。
 */
export const BROWSER_PROVIDER_ENV = 'DSH_BROWSER_PROVIDER'

/**
 * 本对话同时持有标签数的默认硬顶。
 *
 * 取 8：正常读页路径（档 2 复用）几乎不涨，8 给「主页面 + 若干并排对照 + 弹窗」留足余量；
 * 它要拦的是「堆到几十个也没人管」，而不是一般人开三四个页。达到 8 后 `open` 返回
 * `BROWSER_TOO_MANY_TABS`，模型关掉几个或改用 navigate 才能继续 —— 不是静默失败。
 */
export const DEFAULT_MAX_OWNED_TABS = 8

export class BrowserRuntime extends Service {
  static Config: z<BrowserRuntimeConfig> = z.object({
    provider: z.string(),
    tabLeaseIdleMs: z.number(),
    tabHandoffTtlMs: z.number(),
    // `.default(true)` 而不是在代码里 `?? true`：配置回执与文档必须能直接读出默认值，
    // 「没写就是 true」一旦只活在实现里，关掉它的人会以为默认是 false。
    reuseOwnTabOnOpen: z.boolean().default(true),
    // 同样用 `.default`：这条上限必须能从配置回执里读出来。`0` 不做「等于关闭」的约定 ——
    // 关闭用不着它（档 2 才是关闭开关），而 0 会让任何 open 都失败，是配置错误不是用法。
    maxOwnedTabs: z.number().default(DEFAULT_MAX_OWNED_TABS),
  })

  private readonly providers = new Map<string, BrowserProvider>()
  /** 同标签调用互斥，包含失败后的恢复观察；不同标签仍可并行。 */
  private readonly tabCalls = new TabCallQueue()
  private readonly providerId: string | undefined
  /** 标签占用表。内存态，插件卸载即清空（不从历史回执恢复权限）。 */
  private readonly lease: TabLeaseRegistry
  /** `open()` 是否复用本对话自己已有的标签（见 {@link BrowserRuntimeConfig.reuseOwnTabOnOpen}）。 */
  private readonly reuseOwnTabOnOpen: boolean
  /** 本对话同时持有的标签数上限（见 {@link BrowserRuntimeConfig.maxOwnedTabs}）。 */
  private readonly maxOwnedTabs: number

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    const fromEnv = process.env[BROWSER_PROVIDER_ENV]
    this.providerId = config.provider ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined)
    // 直接构造 Config 的地方（单测、编程式装配）绕过了 schema 的默认值，所以这里再兜一次；
    // 两处都写 true 而只有一处是默认值来源，是最容易让「关掉却不生效」的坑。
    this.reuseOwnTabOnOpen = config.reuseOwnTabOnOpen ?? true
    // 与 tabLeaseIdleMs 同一套校验口径：非正整数是**配置错误**，当场抛出而不是悄悄回落默认值。
    // 静默回落会让「我把上限改成 8 了」和「我根本没改」在运行态完全同形。
    this.maxOwnedTabs = requirePositiveCount(config.maxOwnedTabs ?? DEFAULT_MAX_OWNED_TABS, 'maxOwnedTabs')
    this.lease = new TabLeaseRegistry({
      // 展开写而不是直接赋值：`exactOptionalPropertyTypes` 下把 undefined 显式传进去
      // 与「不传」是两回事，而这里要的恰恰是「不传就用默认值」。
      ...config.tabLeaseIdleMs !== undefined ? { idleMs: config.tabLeaseIdleMs } : {},
      ...config.tabHandoffTtlMs !== undefined ? { handoffTtlMs: config.tabHandoffTtlMs } : {},
    })
    // 到期回收要作废 ref 纪元：那是 provider 的状态，租约表看不见它，只能在这里搭桥。
    this.lease.onRelease((providerId, targetId) => {
      this.providers.get(providerId)?.invalidateSession?.(targetId)
    })
  }

  /**
   * 注册一个 provider。id 重复时抛 `BROWSER_DUPLICATE_PROVIDER`。
   * @param provider - provider 本身；它的 `id` 就是注册键。
   * @returns 注销该 provider 的 disposer，随调用方 fiber 一并销毁。
   */
  registerProvider(provider: BrowserProvider): () => void {
    const store = this.providers
    if (store.has(provider.id)) {
      throw new BrowserError(
        `a browser provider with id "${provider.id}" is already registered`,
        'BROWSER_DUPLICATE_PROVIDER',
      )
    }
    const lease = this.lease
    // 注册即 effect：贡献随 fiber 生命周期存在，disposer 由 ctx.effect 管理。
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      // 页面弹窗的归属继承（§5.2）：有受控父就跟着父走，没有就**不登记** —— 那条记录
      // 不存在正是「人工新建的页面不属于任何对话」的表达。
      const stopAdopt = provider.onSessionAdopted?.((targetId, openerTargetId) => {
        if (openerTargetId === undefined) return
        lease.adoptChild(provider.id, targetId, openerTargetId)
      })
      const stopCreated = provider.onSessionCreated?.((targetId, openerTargetId) => {
        const parent = lease.view(provider.id, openerTargetId)
        if (parent === undefined) return false
        return lease.adoptChild(provider.id, targetId, openerTargetId)
      })
      yield () => {
        stopAdopt?.()
        stopCreated?.()
        store.delete(provider.id)
      }
    }, 'browser.registerProvider()')
    // ctx.effect 的 disposer 返回 Promise<void>；对外暴露同步的 fire-and-forget。
    return () => void dispose()
  }

  /**
   * 订阅「某个标签的占用被自动回收」（空闲超时 / 移交码过期）。
   *
   * 用途：本插件的 snapshot 缓存住在工具层，它也必须跟着作废 —— 否则模型能在一个已经
   * 不属于自己的标签上做本地检索，读到别人的页面大纲。ref 纪元由本服务自己作废，
   * 不需要订阅者操心。
   */
  onLeaseRelease(listener: TabLeaseReleaseListener): () => void {
    return this.lease.onRelease(listener)
  }

  /**
   * 门禁的同步查询口：这个标签现在归本对话持有吗？
   *
   * `webpage_find` 要用它 —— 那条工具查的是工具层自己的缓存，一个 CDP 命令都不发，
   * 所以它必须**自己**在检索前过门禁，否则缓存会变成绕过占用的后门。
   */
  assertHeld(sessionId: string, caller: BrowserCaller | undefined): void {
    const owner = this.requireCaller(caller)
    const provider = this.resolve()
    this.lease.assertHeld(provider.id, sessionId, owner.ownerId)
  }

  /** 当前 owner 交还后仍需全页重观察的标签；不泄露其他 owner 的标签。 */
  reobserveRequired(ownerId: string): readonly string[] {
    if (!ownerId) return []
    const pending: string[] = []
    for (const provider of this.providers.values()) {
      for (const tab of this.lease.listHeld(provider.id, ownerId)) {
        if (provider.needsReobserve?.(tab.targetId) === true) pending.push(tab.targetId)
      }
    }
    return pending
  }

  /**
   * 打开一个受控标签页：按「空闲同址领取 → 复用本对话已有标签 → 新建」三档决定落点。
   *
   * 档 2 是「一个 URL 一个标签」从模型纪律变成接口默认行为的那一步：模型最直觉的写法
   * （每个 URL 一次 `webpage_open`）此前必然堆标签，而租期到期只释放占用、不关页面，
   * 于是页面一直活到浏览器进程退出。**注意它是有代价的选择**：复用会把本对话原有的页面
   * 导航走，所以留了 `reuseOwnTabOnOpen` 关掉它。
   *
   * 登记必须在返回 session id 之前完成：只要模型看到了 id，它就能用，而中间那一瞬
   * 谁都用不了的窗口没有意义。登记失败则关掉刚开的标签（§5.1），不留孤儿。
   *
   * @param request - 目标 URL（省略 = 空白页）。
   * @param caller - 调用方身份；缺失即 `BROWSER_CALLER_REQUIRED`。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async open(
    request: BrowserOpenRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserSession> {
    const owner = this.requireCaller(caller)
    const provider = this.resolve()
    const target = normalizedUrl(request.url)
    // 档 1（既有行为，一字不改）：空闲且同址的受控标签直接领取，页面原样保留。
    if (request.url !== undefined && target !== undefined && this.lease.listAvailable(provider.id).length > 0) {
      const idle = await this.claimIdleSameUrl(provider, owner, target, signal)
      if (idle !== undefined) return idle
    }
    // 档 2（新增）：本对话已经持有标签时，挑一个复用并导航过去，返回**同一个** session_id。
    if (this.reuseOwnTabOnOpen && request.url !== undefined && target !== undefined) {
      const reused = await this.reuseOwnTab(provider, owner, target, signal)
      if (reused !== undefined) return reused
    }
    // 档 3 前的硬顶检查：档 1/档 2 都不增加标签数，只有走到「真要新建」这一步才数。
    // 用 listHeld 而不是 provider.tabs()：占用表是归属的权威，provider 清单里还混着别人的标签，
    // 拿它计数会把别的对话占的页面算到本对话头上，误拒一次合法的新建。
    const held = this.lease.listHeld(provider.id, owner.ownerId)
    if (held.length >= this.maxOwnedTabs) {
      throw new BrowserError(
        `cannot open a new tab: this conversation already holds ${String(held.length)} controlled tabs `
        + `(hard limit ${String(this.maxOwnedTabs)}). Close the ones you no longer need — `
        + `session_id=${held.map(tab => tab.targetId).join(', ')} — with webpage_tabs(action=close, session_id=…), `
        + 'or use webpage_navigate on an existing tab instead. Retrying this open will fail the same way.',
        'BROWSER_TOO_MANY_TABS',
      )
    }
    // 档 3（既有行为）：新建并登记给调用方。
    return this.createAndRegister(provider, owner.ownerId, request, signal)
  }

  /**
   * 档 1：领取「空闲且同址」的受控标签。
   *
   * 返回 `undefined` = 没有可领取的落点，让调用方继续往下走。**领取成功之后的一切失败
   * 都照原样抛出**（含快照失败）：那条路径已经把占用拿到手，回退成「新建」会让模型在
   * 一次 open 里拿到两张标签。
   */
  private async claimIdleSameUrl(
    provider: BrowserProvider,
    owner: BrowserCaller,
    target: string,
    signal?: AbortSignal,
  ): Promise<BrowserSession | undefined> {
    const available = new Set(this.lease.listAvailable(provider.id))
    if (available.size === 0) return undefined
    const listed = await provider.tabs({ kind: 'list' }, signal)
    for (const tab of listed.tabs) {
      if (!available.has(tab.sessionId) || tab.url !== target
        || this.lease.view(provider.id, tab.sessionId)?.state !== 'available') continue
      // 检查和领取之间没有 await，竞争者不能抢入；不领取移交中的或人工新建的标签。
      this.lease.claim(provider.id, tab.sessionId, owner.ownerId)
      try {
        // 领取是家族级的，ref 作废也家族级（复用的标签可能带着上次留下的弹窗）。
        for (const id of this.lease.familyTargets(provider.id, tab.sessionId)) {
          provider.invalidateSession?.(id)
        }
        return await this.withLease(tab.sessionId, owner, async () => {
          await provider.tabs({ kind: 'activate', sessionId: tab.sessionId }, signal)
          const snapshot = await provider.observe({ kind: 'snapshot', sessionId: tab.sessionId }, signal)
          if (snapshot.kind !== 'snapshot') throw new BrowserError('reused tab did not return a snapshot', 'BROWSER_PROTOCOL_ERROR')
          return { id: tab.sessionId, url: snapshot.url, title: snapshot.title, epoch: snapshot.epoch }
        }, signal)
      } catch (error) {
        // 失败只退还本次领取的租约，不覆盖期间发生的释放或移交。
        // 调用计数已在 finally 归零；无 await，核对与退还之间不会换主。
        try {
          this.lease.assertHeld(provider.id, tab.sessionId, owner.ownerId)
          this.lease.release(provider.id, tab.sessionId, owner.ownerId)
        } catch { /* 已不归本调用者持有，保留新状态。 */ }
        throw error
      }
    }
    return undefined
  }

  /**
   * 档 2：复用**本对话自己**持有的标签，导航到目标地址后返回同一个 session_id。
   *
   * 三处刻意的保守取舍：
   *
   * 1. **只认同一 ownerId**。别人的、移交中的、空闲的都不在候选里 —— 门禁不是这里新加的
   *    判断，而是 `listHeld` 本身就只回主人的标签；后续每一步仍走 `withLease` 再核一次。
   * 2. **人工接管的标签不复用**。判据只有 `provider.refRecoveryState()`：契约写明「人工
   *    持有时无值」。这是**不完整的判断** —— provider 没实现该钩子时根本无从得知 holder，
   *    此时按「非人工」处理，真正拦住写操作的是 provider 的写前门
   *    （`BROWSER_HUMAN_HOLDING`）。所以选完落点后的竞态失败一律回落新建，而不是把
   *    「人刚按下接管」变成一次 open 失败。
   * 3. **弹窗家族成员不进候选**。`lease.parentKey` 是租约表的私有字段，本轮不为此改它的
   *    公开面，所以只认 `familyTargets()` 长度为 1 的孤立标签 —— 拿不到「这个标签是不是
   *    弹窗子标签」的可靠答案时，宁可回落新建，也不猜。改取父标签那条路同理留待以后
   *    （不是不能，而是需要先给租约表加一个公开的家族查询口）。
   *
   * 返回 `undefined` = 没有可复用的落点（含选好之后失效的竞态），调用方回落新建。
   */
  private async reuseOwnTab(
    provider: BrowserProvider,
    owner: BrowserCaller,
    target: string,
    signal?: AbortSignal,
  ): Promise<BrowserSession | undefined> {
    const held = this.lease.listHeld(provider.id, owner.ownerId)
    if (held.length === 0) return undefined
    const listed = await provider.tabs({ kind: 'list' }, signal)
    const byId = new Map(listed.tabs.map(tab => [tab.sessionId, tab]))
    const candidates = held.filter((view) => {
      // 台账里有、provider 清单里没有：标签已经被关掉（或连接断了），导航它没意义。
      if (byId.get(view.targetId) === undefined) return false
      // 家族成员一律跳过（父标签同样跳过：复用父标签会把整族的页面一起带走，见头注 ③）。
      if (this.lease.familyTargets(provider.id, view.targetId).length !== 1) return false
      return !this.underHumanControl(provider, view.targetId)
    })
    if (candidates.length === 0) return undefined
    // 前台优先；没有前台信号（外部 Chrome 没有可靠的活动标签信号）时取所有者清单里靠后的
    // 那一条（`listHeld` 按台账插入顺序给出，靠后 = 较晚登记的）。
    // 刻意**不用**剩余租期来猜「最近活跃」：租约在每次调用结束时续期，期限最长只说明「最近
    // 被调用过」，而模型最常调用的往往正是它正在盯着的那个页面 —— 拿它当落点恰好会把模型
    // 手上的页面导航走。登记顺序是确定性的，不会因为一次 observe 就改变选择。
    const chosen = candidates.find(view => byId.get(view.targetId)?.active === true)
      ?? candidates[candidates.length - 1]
    if (chosen === undefined) return undefined
    const sessionId = chosen.targetId
    try {
      // 「当前地址已经是目标地址」不重新导航：无谓刷新会让页面丢掉已填表单、滚动位置与
      // 页面内状态 —— 而这正是模型「再 open 一次同一个网址」时最不想要的结果。
      const current = byId.get(sessionId)?.url
      if (current === undefined || normalizedUrl(current) !== target) {
        // 复用既有导航路径：`navigate()` 自己走 withLease、作废 ref 纪元，并让 provider 记
        // `expectSelfNavigation` 赊账 —— 不在这里复制一遍导航逻辑。
        // 它必须**在**下面的 withLease 之前调用：同一个标签重复进 `tabCalls` 的临界区
        // 会自己等自己。
        await this.navigate({ sessionId, url: target }, owner, signal)
      }
      return await this.withLease(sessionId, owner, async () => {
        await provider.tabs({ kind: 'activate', sessionId }, signal)
        // 无论有没有导航都要重拍一次全页：回执里的 url / title / epoch 必须是**这次真的
        // 观察到的**值。少了这一步，模型会拿着旧纪元（甚至旧 ref）去操作一个新地址。
        const snapshot = await provider.observe({ kind: 'snapshot', sessionId }, signal)
        if (snapshot.kind !== 'snapshot') throw new BrowserError('reused tab did not return a snapshot', 'BROWSER_PROTOCOL_ERROR')
        return { id: sessionId, url: snapshot.url, title: snapshot.title, epoch: snapshot.epoch }
      }, signal)
    } catch (error) {
      // 选好落点之后才失效的几种竞争：人刚按下接管、标签被关掉、同标签上还有调用在跑。
      // 它们只说明「这个落点此刻不能用」，不说明请求本身有问题 —— 回落新建比把失败甩给
      // 模型更接近 open 的本意。其余错误（地址策略、网络、超时）照原样抛。
      if (isReuseRace(error)) return undefined
      throw error
    }
  }

  /**
   * 这个标签是否正被人接管。**只看得到一部分**：provider 不实现
   * `refRecoveryState` 时无从判断（外部 Chrome 直连没有 holder 通道），此时按「非人工」
   * 处理，靠写前门兜底。
   */
  private underHumanControl(provider: BrowserProvider, sessionId: string): boolean {
    if (provider.refRecoveryState === undefined) return false
    return provider.refRecoveryState(sessionId) === undefined
  }

  /** 档 3：新建标签并登记给调用方；登记失败就关掉刚开的标签，不留孤儿。 */
  private async createAndRegister(
    provider: BrowserProvider,
    ownerId: string,
    request: BrowserOpenRequest,
    signal?: AbortSignal,
  ): Promise<BrowserSession> {
    let createdId: string | undefined
    const session = await provider.open({
      ...request,
      onCreated: id => {
        this.lease.register(provider.id, id, ownerId)
        createdId = id
      },
    }, signal).catch(error => {
      if (createdId !== undefined && !signal?.aborted) this.lease.forget(provider.id, createdId)
      throw error
    })
    try {
      if (createdId !== session.id) this.lease.register(provider.id, session.id, ownerId)
    } catch (error: unknown) {
      await provider.close(session.id).catch(() => undefined)
      throw error
    }
    return session
  }

  /**
   * 让一个已持有的会话跳转。**这会作废该会话的全部既有 ref。**
   * @param request - 会话 id 与目标 URL（走地址策略）。
   * @param caller - 调用方身份；必须正持有该标签。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async navigate(
    request: BrowserNavigateRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserSession> {
    return this.withLease(request.sessionId, caller, (provider) => provider.navigate(request, signal), signal)
  }

  /**
   * 观察会话（snapshot / screenshot）。
   * @param request - 观察类型与目标会话。
   * @param caller - 调用方身份；必须正持有该标签。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async observe(
    request: BrowserObserveRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserObservation> {
    return this.withLease(request.sessionId, caller, (provider) => provider.observe(request, signal), signal,
      request.kind === 'screenshot' ? request.ref !== undefined : request.region?.ref !== undefined)
  }

  /**
   * P1：标签页管理。`list` / `activate` / `close` 走 provider；`claim` / `release` /
   * `handoff` 是占用动作，在本地裁决（`release` 只额外作废 ref 纪元）。
   *
   * @param request - 清单 / 领取 / 释放 / 移交 / 切前台 / 关闭。
   * @param caller - 调用方身份。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async tabs(
    request: BrowserTabsRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserTabsResult> {
    const owner = this.requireCaller(caller)
    const provider = this.resolve()
    switch (request.kind) {
      case 'list':
        return request.scope === 'available'
          ? { action: 'list', tabs: await this.availableTabs(provider, signal) }
          : { action: 'list', tabs: await this.heldTabs(provider, owner.ownerId, signal) }
      case 'claim': {
        const claimed = this.lease.claim(provider.id, request.sessionId, owner.ownerId, request.handoffCode)
        // 归属变了 ⇒ 上一任拍的 ref 全部作废，新主人必须重新拍快照才能动手。
        // 幂等重领（自己还持有）**不**作废：那会凭空废掉模型手上的号（§3.2）。
        // 幂等重领（自己还持有）不作废 ⇒ 也没有「受影响的标签」要清缓存。
        const affected = claimed ? this.invalidateFamily(provider, request.sessionId) : []
        return {
          action: 'claim',
          sessionId: request.sessionId,
          tabs: await this.heldTabs(provider, owner.ownerId, signal),
          affectedSessionIds: affected,
        }
      }
      case 'release': {
        this.lease.release(provider.id, request.sessionId, owner.ownerId)
        // 释放是**整个弹窗家族**一起转空闲的，所以 ref 也要逐个作废：只作废请求目标，
        // 子标签会带着旧主人的 ref 落到新主人手里（§3.2）。
        const affected = this.invalidateFamily(provider, request.sessionId)
        return {
          action: 'release',
          sessionId: request.sessionId,
          tabs: await this.heldTabs(provider, owner.ownerId, signal),
          affectedSessionIds: affected,
        }
      }
      case 'handoff': {
        const handoffCode = this.lease.handoff(provider.id, request.sessionId, owner.ownerId)
        // 发起方**立刻**失去操作权，所以它的 ref 也在这一刻作废 —— 同样覆盖整个家族。
        const affected = this.invalidateFamily(provider, request.sessionId)
        return {
          action: 'handoff',
          sessionId: request.sessionId,
          tabs: await this.heldTabs(provider, owner.ownerId, signal),
          handoffCode,
          affectedSessionIds: affected,
        }
      }
      case 'activate': {
        this.lease.assertHeld(provider.id, request.sessionId, owner.ownerId)
        const result = await provider.tabs(request, signal)
        // 回执清单按归属过滤：provider 的 activate 回执带的是**全量**受控标签，直接透传会
        // 让 A 激活自己的标签就拿到 B 的 id、标题与地址。与 `list` / `close` 同口径。
        // 全量清单从这次回执里取，不再多付一次 `list`。
        return {
          action: 'activate',
          sessionId: result.sessionId ?? request.sessionId,
          tabs: await this.heldTabs(provider, owner.ownerId, signal, result.tabs),
        }
      }
      case 'close': {
        this.lease.assertClosable(provider.id, request.sessionId, owner.ownerId)
        const result = await provider.tabs(request, signal)
        // 会话没了 ⇒ 记录也摘掉。顺序不能反：先摘记录的话，provider 关闭失败就留下一张
        // 「谁都碰不了但页面还在」的僵尸记录。
        this.lease.forget(provider.id, request.sessionId)
        return {
          action: 'close',
          sessionId: request.sessionId,
          // 同样是关闭后的清单：关掉的那个已经从 `held` 里摘掉了，不会再出现在回执里。
          tabs: await this.heldTabs(provider, owner.ownerId, signal, result.tabs),
        }
      }
    }
  }

  /**
   * P1：按 ref 定位的页面操作。provider 侧先过 ref 纪元再发命令，
   * 旧 ref 一律 `BROWSER_STALE_REF` / `BROWSER_SNAPSHOT_REQUIRED`。
   * @param request - click / fill / press / scroll / wait。
   * @param caller - 调用方身份；必须正持有该标签。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async mutate(
    request: BrowserMutationRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserMutationResult> {
    if ((request.kind === 'wait' || request.kind === 'click' || request.kind === 'press') && request.observeRef !== undefined) {
      if (request.observeRef.trim().length === 0 || (request.kind !== 'wait' && request.observe !== true && request.waitText === undefined)) {
        throw new BrowserError('observe_ref requires a non-empty ref and post-action observation', 'BROWSER_INVALID_PARAMS')
      }
    }
    if (request.kind === 'click' || request.kind === 'press') {
      if (request.waitText !== undefined && request.waitText.trim().length === 0) {
        throw new BrowserError('wait_text must contain non-whitespace text', 'BROWSER_INVALID_PARAMS')
      }
      // timeout_ms：wait_text 的完成等待期限，或 observe=true 的「动作后等待页面安静」期限。
      if (request.timeoutMs !== undefined && request.waitText === undefined && request.observe !== true) {
        throw new BrowserError('timeout_ms requires wait_text or observe=true', 'BROWSER_INVALID_PARAMS')
      }
      if (request.timeoutMs !== undefined
        && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30_000)) {
        throw new BrowserError('timeout_ms must be an integer from 1 to 30000', 'BROWSER_INVALID_PARAMS')
      }
    }
    return this.withLease(request.sessionId, caller, async (provider, ownerId) => {
      const result = await provider.mutate(request, signal)
      let filtered = this.filterOpenedTabs(provider, ownerId, result)
      // 动作后的等待条件：已知本轮完成原文时等文本；只给 observe=true+timeout_ms 时等页面安静（至多 timeout_ms）。
      const followUpWait: Extract<BrowserMutationRequest, { kind: 'wait' }> | undefined =
        request.kind === 'click' || request.kind === 'press'
          ? request.waitText !== undefined
            ? { kind: 'wait', sessionId: request.sessionId, text: request.waitText,
              ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}) }
            : request.observe === true && request.timeoutMs !== undefined
              ? { kind: 'wait', sessionId: request.sessionId, until: 'stable', timeoutMs: request.timeoutMs }
              : undefined
          : undefined
      if (followUpWait !== undefined) {
        let waited: BrowserMutationResult
        try {
          waited = await provider.mutate(followUpWait, signal)
        } catch (error) {
          // 等待本身失败也是「证据不足」，必须显式报 completion=unverified；
          // 只回一句 observation_error 会让模型把缺失的完成证据当成不需要证明。
          return withCompletion({
            ...filtered,
            actionDispatched: true,
            observationError: observationFailure(error),
            waitEvidence: {
              condition: followUpWait.text !== undefined ? 'text' : 'stable',
              conditionMet: false,
              completion: 'unverified',
              basis: 'wait_failed',
              newContent: 'unknown',
            } satisfies BrowserWaitEvidence,
          })
        }
        const waitResult = this.filterOpenedTabs(provider, ownerId, waited)
        const openedTabs = new Map<string, BrowserTabInfo>()
        for (const tab of [...(filtered.openedTabs ?? []), ...(waitResult.openedTabs ?? [])]) {
          openedTabs.set(tab.sessionId, tab)
        }
        const pageChanged = mergePageChanges(filtered.pageChanged, waitResult.pageChanged)
        filtered = this.filterOpenedTabs(provider, ownerId, {
          ...filtered,
          epoch: waitResult.epoch,
          url: waitResult.url,
          title: waitResult.title,
          navigated: filtered.navigated || waitResult.navigated,
          ...(pageChanged !== undefined ? { pageChanged } : {}),
          ...(waitResult.satisfied !== undefined ? { satisfied: waitResult.satisfied } : {}),
          ...waitResult.waitEvidence !== undefined ? { waitEvidence: waitResult.waitEvidence } : {},
          ...waitResult.signals !== undefined ? { signals: waitResult.signals } : {},
          ...(openedTabs.size > 0 ? { openedTabs: [...openedTabs.values()] } : {}),
        })
      }
      const shouldSnapshot = request.kind === 'wait'
        || ((request.kind === 'click' || request.kind === 'press')
          && (request.observe === true || request.waitText !== undefined))
      if (!shouldSnapshot) return filtered
      try {
        const observeRef = request.kind === 'wait' || request.kind === 'click' || request.kind === 'press' ? request.observeRef : undefined
        const observeRegion = request.kind === 'wait' || request.kind === 'click' || request.kind === 'press' ? request.observeRegion : undefined
        const requiresFull = filtered.navigated || (filtered.pageChanged?.navigated ?? 0) > 0
          || provider.needsReobserve?.(request.sessionId) === true || provider.hasFullObservation?.(request.sessionId) !== true
        // 显式区域最优先：已知结果区用 region_ref，未知但回复在文档尾部用 region_tail=true，
        // 只看当前屏幕用 region_viewport=true。它们都指向「本轮回复」，不是被操作元素所在区块。
        const explicitRegion = observeRef !== undefined
          ? { ref: observeRef }
          : observeRegion?.tail === true
            ? { tail: true, ...observeRegion.tailLines !== undefined ? { tailLines: observeRegion.tailLines } : {} }
            : observeRegion?.viewport === true ? { viewport: true } : undefined
        // 动作后的默认落点仍是**被操作元素所在的区块**（2026-10-18），但独立 wait 不再回退整页：
        // `previous` 由 provider 按可继承区域重算，无有效区域时默认落文档尾部有界区域。
        const actionRef = request.kind === 'click' || request.kind === 'press' ? request.ref : undefined
        const region = explicitRegion ?? (actionRef !== undefined ? { enclosing: actionRef }
          : request.kind === 'wait' ? { previous: true } : undefined)
        const snapshot = await provider.observe({ kind: 'snapshot', sessionId: request.sessionId,
          ...region !== undefined && !requiresFull ? { region, guardGlobal: true } : {},
        }, signal)
        if (snapshot.kind !== 'snapshot') {
          throw new BrowserError(`mutation received a "${snapshot.kind}" observation`, 'BROWSER_PROTOCOL_ERROR')
        }
        return withCompletion({ ...filtered, epoch: snapshot.epoch, url: snapshot.url, title: snapshot.title, snapshot })
      } catch (error) {
        if (request.kind === 'click' || request.kind === 'press') {
          return withCompletion({ ...filtered, actionDispatched: true, observationError: observationFailure(error) })
        }
        throw error
      }
    }, signal, true)
  }

  /**
   * 回执里的「本次操作新开出来的标签」只留**本对话**的。
   *
   * provider 是用「动作前后全局会话集合的差集」算这张清单的（见 `collectOpenedTabs`），
   * 它不认识调用方：A 在 wait / click 期间，B 并发开的标签、以及用户人工新建的标签都会
   * 落进 A 的回执，标题与地址一并泄露。租约表认识主人，所以在这里过滤 —— 没有记录的
   * （人工新建、不猜 owner）同样不回（§5.2）。
   */
  private filterOpenedTabs(
    provider: BrowserProvider,
    ownerId: string,
    result: BrowserMutationResult,
  ): BrowserMutationResult {
    const opened = result.openedTabs
    if (opened === undefined || opened.length === 0) return result
    const mine = opened.filter(tab => this.lease.ownerOf(provider.id, tab.sessionId) === ownerId)
    // 一条都没被滤掉（弹窗继承链路正常，弹出的本来就是自己的）⇒ 原样返回，不造新对象。
    if (mine.length === opened.length) return result
    if (mine.length === 0) {
      // 与 provider 同口径：一个都不剩时**不带**这个字段，而不是给个空数组。
      const without = { ...result }
      delete without.openedTabs
      return without
    }
    return { ...result, openedTabs: mine }
  }

  /**
   * P2：读取会话的 console 环形缓冲。provider 在读取前会补发 `Runtime.enable` /
   * `Log.enable`（re-attach 后 enable 状态不保证还在，重放由高水位吃掉）。
   * @param request - 会话 id 与 limit / level / text 过滤。
   * @param caller - 调用方身份；必须正持有该标签。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async console(
    request: BrowserConsoleRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserConsoleResult> {
    return this.withLease(request.sessionId, caller, (provider) => provider.console(request, signal), signal)
  }

  /**
   * P2：列出网络请求或按 `requestId` 取响应体。`requestId` 直接用事件里的值，不做映射。
   * @param request - `list`（limit / url 过滤）或 `body`（requestId）。
   * @param caller - 调用方身份；必须正持有该标签。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async network(
    request: BrowserNetworkRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserNetworkResult> {
    return this.withLease(request.sessionId, caller, (provider) => provider.network(request, signal), signal)
  }

  /**
   * P2：白名单制的高危逃生舱。provider 在发命令前先过白名单（默认拒）。
   * @param request - `domain.method` 与参数。
   * @param caller - 调用方身份；必须正持有该标签。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async execute(
    request: BrowserExecuteRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserExecuteResult> {
    return this.withLease(request.sessionId, caller, (provider) => provider.execute(request, signal), signal)
  }

  /**
   * P3：按 ref 现算元素的视口坐标盒（每次 locate 重新计算，绝不缓存 snapshot 时的几何）。
   * @param request - 会话 id、ref 与 highlight / scroll 选项。
   * @param caller - 调用方身份；必须正持有该标签。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async locate(
    request: BrowserLocateRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserLocateResult> {
    return this.withLease(request.sessionId, caller, (provider) => provider.locate(request, signal), signal, true)
  }

  /**
   * 把旧纪元的 ref 精确装回当前纪元。文档身份对不上或节点变了就按条拒绝，绝不误绑。
   * @param request - 会话 id 与要恢复的 ref。
   * @param caller - 调用方身份；必须正持有该标签。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async revalidate(
    request: BrowserRevalidateRequest,
    caller: BrowserCaller | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserRevalidateResult> {
    return this.withLease(request.sessionId, caller, (provider) => provider.revalidate(request, signal), signal)
  }

  /**
   * 关闭会话并释放其 target。**必须是自己持有的标签**。
   * @param sessionId - `open()` 返回的会话 id。
   * @param caller - 调用方身份。
   */
  async close(sessionId: string, caller: BrowserCaller | undefined): Promise<void> {
    const owner = this.requireCaller(caller)
    const provider = this.resolve()
    this.lease.assertClosable(provider.id, sessionId, owner.ownerId)
    await provider.close(sessionId)
    this.lease.forget(provider.id, sessionId)
  }

  /**
   * 释放**全部** provider 持有的资源（连接、标签页）。
   * 由插件的 `ctx.effect` 在卸载时调用；逐个 provider 的失败不会阻断其余清理。
   */
  async dispose(): Promise<void> {
    // 占用表是内存态，卸载即清空 —— 不留下「重启后仍记得旧主人」的任何可能。
    this.lease.dispose()
    const providers = [...this.providers.values()]
    const failures: unknown[] = []
    for (const provider of providers) {
      if (provider.dispose === undefined) continue
      try {
        await provider.dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new BrowserError(
        `${failures.length} browser provider(s) failed to dispose`,
        'BROWSER_DISPOSE_FAILED',
        { cause: failures[0] },
      )
    }
  }

  /**
   * 身份是硬前置：没有它就拒绝调用。
   *
   * 为什么不「没身份就放行」：那正好是最需要门禁的运行时（宿主没接好身份传递）最不设防，
   * 而且会把一个装配缺陷伪装成「一切正常」。诊断信息里点名修复方向，但**不提供任何
   * 用模型参数补身份的写法** —— 那等于把门禁交给被门禁的对象。
   */
  private requireCaller(caller: BrowserCaller | undefined): BrowserCaller {
    if (caller !== undefined && caller.ownerId.length > 0) return caller
    throw new BrowserError(
      'this tool call carries no caller identity, so it cannot be attributed to a conversation. '
      + 'The browser tools take the caller from the host tool-execution context (exec.agent.id); '
      + 'this runtime did not provide one, which is a host/plugin wiring problem — NOT something the model '
      + 'can fix by passing an owner id as a tool argument, and not a reason to open the guard. '
      + 'Report it: the browser guard stays closed until the identity is delivered.',
      'BROWSER_CALLER_REQUIRED',
    )
  }

  /**
   * 受控入口：核对占用 → 记 `activeCalls` → 派发 → `finally` 核销。
   *
   * 检查与实际调用必须在**同一个**函数里（§5.1）：工具层检查完再裸调 provider 会留下
   * 一条绕过路径，而「检查通过之后、命令发出之前」这段窗口里归属完全可能变。
   */
  private async withLease<T>(
    sessionId: string,
    caller: BrowserCaller | undefined,
    run: (provider: BrowserProvider, ownerId: string) => Promise<T>,
    signal?: AbortSignal,
    recoverRefs = false,
  ): Promise<T> {
    const owner = this.requireCaller(caller)
    const provider = this.resolve()
    const key = `${provider.id}:${sessionId}`
    // 排队也计入本租约的在途调用，避免候补跨越释放后同 owner 重新领取的代次。
    const generation = this.lease.beginCall(provider.id, sessionId, owner.ownerId)
    try {
      const controlGeneration = provider.refRecoveryState?.(sessionId)
      const acquisition = this.tabCalls.acquire(key, signal)
      const release = typeof acquisition === 'function' ? acquisition : await acquisition
      try {
        // 排队后重新核对归属；候补期间可能已释放或移交。
        this.lease.assertHeld(provider.id, sessionId, owner.ownerId)
        return await run(provider, owner.ownerId)
      } catch (error) {
        if (recoverRefs) await attachRefRecovery(error, provider, sessionId, controlGeneration,
          () => this.lease.assertHeld(provider.id, sessionId, owner.ownerId), signal)
        throw error
      } finally {
        release()
      }
    } finally {
      this.lease.endCall(provider.id, sessionId, generation)
    }
  }

  /**
   * 作废一个标签**连同它的弹窗家族**的 ref 纪元，返回被作废的标签 id。
   *
   * 租约的 claim / release / handoff 都是以家族为单位迁移的，ref 纪元作废必须跟同样的
   * 粒度：只作废请求目标，子标签就带着旧主人的 ref 落到新主人手里（方案 §3.2）。
   */
  private invalidateFamily(provider: BrowserProvider, targetId: string): string[] {
    const affected = this.lease.familyTargets(provider.id, targetId)
    for (const id of affected) provider.invalidateSession?.(id)
    return affected
  }

  /** 本对话占用的标签：以占用表为准，用 provider 的清单补标题 / 地址 / 前台状态。 */
  private async heldTabs(
    provider: BrowserProvider,
    ownerId: string,
    signal?: AbortSignal,
    /**
     * 已经取到的 provider 全量清单。provider 的 activate / close 回执里就带着它，传进来可
     * 以省掉一次 `list` 往返（过滤逻辑完全一样）。
     */
    listed?: readonly BrowserTabInfo[],
  ): Promise<readonly BrowserTabInfo[]> {
    const held = this.lease.listHeld(provider.id, ownerId)
    if (held.length === 0) return []
    const tabs = listed ?? (await provider.tabs({ kind: 'list' }, signal)).tabs
    const byId = new Map(tabs.map(tab => [tab.sessionId, tab]))
    return held.flatMap((view) => {
      const tab = byId.get(view.targetId)
      // 台账里有、provider 清单里没有：标签已经被关掉了（或连接断了）。不回给模型 ——
      // 一个点不动的 session id 比「它不见了」更难用。
      if (tab === undefined) return []
      return [{
        sessionId: tab.sessionId,
        ...tab.url !== undefined ? { url: tab.url } : {},
        ...tab.title !== undefined ? { title: tab.title } : {},
        ...tab.active !== undefined ? { active: tab.active } : {},
        lease: view.remainingMs === undefined
          ? { state: view.state }
          : { state: view.state, remainingMs: view.remainingMs },
      }]
    })
  }

  /**
   * 空闲清单：**只给标签 id**。
   *
   * 领取之前不披露标题与地址 —— 空闲标签可能是别的对话刚放下的页面，标题里往往就写着
   * 它在干什么（「订单 #4821 确认」）。需要内容就先领取。
   */
  private async availableTabs(
    provider: BrowserProvider,
    signal?: AbortSignal,
  ): Promise<readonly BrowserTabInfo[]> {
    const available = this.lease.listAvailable(provider.id)
    if (available.length === 0) return []
    // 与 provider 的清单取交集：租约表里还挂着、但标签已经不在的，不算可用。
    const listed = await provider.tabs({ kind: 'list' }, signal)
    const live = new Set(listed.tabs.map(tab => tab.sessionId))
    return available.filter(id => live.has(id)).map(id => ({
      sessionId: id,
      lease: { state: 'available' as const },
    }))
  }

  /**
   * 调用时解析 provider：
   * - 配了 id、已注册且可用 → 用它
   * - 配了 id 但没注册 → `BROWSER_PROVIDER_CONFIGURED_MISSING`
   * - 配了 id 但不可用 → `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE`
   * - 没配、恰好一个可用 → 自动选
   * - 没配、多个可用 → `BROWSER_PROVIDER_AMBIGUOUS`
   * - 没配、没有可用 → `BROWSER_PROVIDER_UNAVAILABLE`
   */
  private resolve(): BrowserProvider {
    const { providerId } = this
    if (providerId !== undefined) {
      const provider = this.providers.get(providerId)
      if (!provider) {
        throw new BrowserError(
          `configured browser provider "${providerId}" is not registered`,
          'BROWSER_PROVIDER_CONFIGURED_MISSING',
        )
      }
      if (!provider.available()) {
        throw new BrowserError(
          `configured browser provider "${providerId}" is registered but unavailable`,
          'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE',
        )
      }
      return provider
    }
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new BrowserError('no usable browser provider is registered', 'BROWSER_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new BrowserError(
        `multiple usable browser providers are registered (${ids}); configure one explicitly`,
        'BROWSER_PROVIDER_AMBIGUOUS',
      )
    }
    return single
  }
}

export default BrowserRuntime
