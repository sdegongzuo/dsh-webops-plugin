/**
 * ctx.browser —— 浏览器能力的能力缝隙（Service Definition）。
 *
 * 形状与 provider 选择语义照 dsh 的 `packages/web/web/src/index.ts` 对齐：
 * 选择在**调用时**解析，绝不依赖注册顺序。
 *
 * 状态：P0 骨架。缝隙本身已可用（注册 / 选择 / 转发），页面能力在 provider 侧。
 *
 * @module dsh-webops-plugin/browser
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrowserError } from './types.ts'
import type {
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
  BrowserTabsRequest,
  BrowserTabsResult,
} from './types.ts'

export { BrowserError, isBrowserError } from './types.ts'
export type {
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
  BrowserTabsRequest,
  BrowserTabsResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/** 能力缝隙的配置：只用来钉住 provider。 */
export interface BrowserRuntimeConfig {
  /** 显式指定 provider id。省略 = 恰好一个可用时自动选。 */
  readonly provider?: string
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
  })

  private readonly providers = new Map<string, BrowserProvider>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    const fromEnv = process.env[BROWSER_PROVIDER_ENV]
    this.providerId = config.provider ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined)
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
    // 注册即 effect：贡献随 fiber 生命周期存在，disposer 由 ctx.effect 管理。
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'browser.registerProvider()')
    // ctx.effect 的 disposer 返回 Promise<void>；对外暴露同步的 fire-and-forget。
    return () => void dispose()
  }

  /**
   * 开一个受控会话。
   * @param request - 目标 URL（省略 = 空白页）。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async open(request: BrowserOpenRequest, signal?: AbortSignal): Promise<BrowserSession> {
    return this.resolve().open(request, signal)
  }

  /**
   * 让一个已存在的会话跳转。**这会作废该会话的全部既有 ref。**
   * @param request - 会话 id 与目标 URL（走地址策略）。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async navigate(request: BrowserNavigateRequest, signal?: AbortSignal): Promise<BrowserSession> {
    return this.resolve().navigate(request, signal)
  }

  /**
   * 观察会话（snapshot / screenshot）。
   * @param request - 观察类型与目标会话。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async observe(request: BrowserObserveRequest, signal?: AbortSignal): Promise<BrowserObservation> {
    return this.resolve().observe(request, signal)
  }

  /**
   * P1：标签页管理（本插件自己开的受控标签页）。
   * @param request - 清单 / 切前台 / 关闭。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async tabs(request: BrowserTabsRequest, signal?: AbortSignal): Promise<BrowserTabsResult> {
    return this.resolve().tabs(request, signal)
  }

  /**
   * P1：按 ref 定位的页面操作。provider 侧先过 ref 纪元再发命令，
   * 旧 ref 一律 `BROWSER_STALE_REF` / `BROWSER_SNAPSHOT_REQUIRED`。
   * @param request - click / fill / press / scroll / wait。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async mutate(request: BrowserMutationRequest, signal?: AbortSignal): Promise<BrowserMutationResult> {
    return this.resolve().mutate(request, signal)
  }

  /**
   * P2：读取会话的 console 环形缓冲。provider 在读取前会补发 `Runtime.enable` /
   * `Log.enable`（re-attach 后 enable 状态不保证还在，重放由高水位吃掉）。
   * @param request - 会话 id 与 limit / level / text 过滤。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async console(request: BrowserConsoleRequest, signal?: AbortSignal): Promise<BrowserConsoleResult> {
    return this.resolve().console(request, signal)
  }

  /**
   * P2：列出网络请求或按 `requestId` 取响应体。`requestId` 直接用事件里的值，不做映射。
   * @param request - `list`（limit / url 过滤）或 `body`（requestId）。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async network(request: BrowserNetworkRequest, signal?: AbortSignal): Promise<BrowserNetworkResult> {
    return this.resolve().network(request, signal)
  }

  /**
   * P2：白名单制的高危逃生舱。provider 在发命令前先过白名单（默认拒）。
   * @param request - `domain.method` 与参数。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async execute(request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> {
    return this.resolve().execute(request, signal)
  }

  /**
   * P3：按 ref 现算元素的视口坐标盒（每次 locate 重新计算，绝不缓存 snapshot 时的几何）。
   * @param request - 会话 id、ref 与 highlight / scroll 选项。
   * @param signal - 可选取消信号，转发给 provider。
   */
  async locate(request: BrowserLocateRequest, signal?: AbortSignal): Promise<BrowserLocateResult> {
    return this.resolve().locate(request, signal)
  }

  /**
   * 把旧纪元的 ref 精确装回当前纪元。文档身份对不上或节点变了就按条拒绝，绝不误绑。
   */
  async revalidate(request: BrowserRevalidateRequest, signal?: AbortSignal): Promise<BrowserRevalidateResult> {
    return this.resolve().revalidate(request, signal)
  }

  /**
   * 关闭会话并释放其 target。
   * @param sessionId - `open()` 返回的会话 id。
   */
  async close(sessionId: string): Promise<void> {
    return this.resolve().close(sessionId)
  }

  /**
   * 释放**全部** provider 持有的资源（连接、标签页）。
   * 由插件的 `ctx.effect` 在卸载时调用；逐个 provider 的失败不会阻断其余清理。
   */
  async dispose(): Promise<void> {
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
