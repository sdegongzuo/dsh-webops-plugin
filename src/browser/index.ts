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
import type { TabLeaseReleaseListener } from './lease.ts'
import type {
  BrowserCaller,
  BrowserConsoleRequest,
  BrowserConsoleResult,
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
  BrowserProvider,
  BrowserRevalidateRequest,
  BrowserRevalidateResult,
  BrowserSession,
  BrowserTabInfo,
  BrowserTabsRequest,
  BrowserTabsResult,
} from './types.ts'

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
}

/**
 * 让 `provider` 可以走环境变量的变量名。
 *
 * 为什么需要：桌面端的 profile 目录由应用独占并每次重建，往里写 `config.provider` 活不过一次重启；
 * 而桌面端里 `cdp`（连 9222，也就是桌面端自己）与 `electron`（开真窗口）都可能「可用」，
 * 不指定就会撞上 `BROWSER_PROVIDER_AMBIGUOUS`。env 是唯一稳定的旋钮。
 */
export const BROWSER_PROVIDER_ENV = 'DSH_BROWSER_PROVIDER'

export class BrowserRuntime extends Service {
  static Config: z<BrowserRuntimeConfig> = z.object({
    provider: z.string(),
    tabLeaseIdleMs: z.number(),
    tabHandoffTtlMs: z.number(),
  })

  private readonly providers = new Map<string, BrowserProvider>()
  private readonly providerId: string | undefined
  /** 标签占用表。内存态，插件卸载即清空（不从历史回执恢复权限）。 */
  private readonly lease: TabLeaseRegistry

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    const fromEnv = process.env[BROWSER_PROVIDER_ENV]
    this.providerId = config.provider ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined)
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
      yield () => {
        stopAdopt?.()
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

  /**
   * 相同网址的空闲受控标签优先领取复用，否则新建并登记给调用方。
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
    const available = new Set(this.lease.listAvailable(provider.id))
    if (available.size > 0 && request.url !== undefined) {
      let target: string | undefined
      try { target = new URL(request.url.trim()).href } catch { /* 非法 URL 留给 provider 的地址策略拒绝。 */ }
      if (target !== undefined) {
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
            return await this.withLease(tab.sessionId, caller, async () => {
              await provider.tabs({ kind: 'activate', sessionId: tab.sessionId }, signal)
              const snapshot = await provider.observe({ kind: 'snapshot', sessionId: tab.sessionId }, signal)
              if (snapshot.kind !== 'snapshot') throw new BrowserError('reused tab did not return a snapshot', 'BROWSER_PROTOCOL_ERROR')
              return { id: tab.sessionId, url: snapshot.url, title: snapshot.title, epoch: snapshot.epoch }
            })
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
      }
    }
    const session = await provider.open(request, signal)
    try {
      this.lease.register(provider.id, session.id, owner.ownerId)
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
    return this.withLease(request.sessionId, caller, (provider) => provider.navigate(request, signal))
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
    return this.withLease(request.sessionId, caller, (provider) => provider.observe(request, signal))
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
    return this.withLease(request.sessionId, caller, async (provider, ownerId) => {
      const result = await provider.mutate(request, signal)
      return this.filterOpenedTabs(provider, ownerId, result)
    })
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
    return this.withLease(request.sessionId, caller, (provider) => provider.console(request, signal))
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
    return this.withLease(request.sessionId, caller, (provider) => provider.network(request, signal))
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
    return this.withLease(request.sessionId, caller, (provider) => provider.execute(request, signal))
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
    return this.withLease(request.sessionId, caller, (provider) => provider.locate(request, signal))
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
    return this.withLease(request.sessionId, caller, (provider) => provider.revalidate(request, signal))
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
  ): Promise<T> {
    const owner = this.requireCaller(caller)
    const provider = this.resolve()
    const generation = this.lease.beginCall(provider.id, sessionId, owner.ownerId)
    try {
      // 派发前的二次核对：归属在这一刻变了（另一个对话刚领走 / 刚释放）就不能动页面。
      this.lease.assertHeld(provider.id, sessionId, owner.ownerId)
      return await run(provider, owner.ownerId)
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
