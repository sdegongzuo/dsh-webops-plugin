/**
 * Electron 窗口 provider：把 `CdpBrowserProvider` 的 CDP 语义接到「桌面端自己的窗口」上。
 *
 * 为什么是继承而不是重写：`open` / `navigate` / `observe` / `close` 这套语义与端点是
 * Chrome 还是 Electron 窗口无关 —— 两边都吃标准 CDP。差别只在于「怎么造一个 target」
 * 与「怎么连上它」，而那两件事已经被 {@link ElectronWindowTransport} 封住了。
 *
 * provider id 是 `electron`，与 `cdp` 并列注册；两者是否可用由
 * {@link ElectronBrowserProvider.available} 与 `browser` 服务的配置决定。
 *
 * @module dsh-webops-plugin/browser-electron/provider
 */

import { CdpBrowserProvider } from '../browser-cdp/provider.ts'
import type { CdpProviderConfig } from '../browser-cdp/provider.ts'
import type { CdpTransport } from '../browser-cdp/protocol.ts'
import { BrowserError } from '../browser/types.ts'
import type { BrowserOpenRequest, BrowserSession } from '../browser/types.ts'
import { ElectronWindowTransport } from './transport.ts'

/** 本 provider 的 id，用于 `browser` 服务的 `provider` 配置。 */
export const ELECTRON_PROVIDER_ID = 'electron'

/**
 * 把窗口宿主当作一种浏览器。
 *
 * `available()` 多一道 `enabled` 闸门：Electron 二进制在多数的 CLI 环境里也能找到
 * （桌面端就装了），若不加这道闸，`cdp` 与 `electron` 会同时「可用」，
 * `browser` 服务就会因为无法自动选择而报 `BROWSER_PROVIDER_AMBIGUOUS`。
 * 所以默认只有显式要求（配置或环境变量）时才承认自己可用。
 */
export class ElectronBrowserProvider extends CdpBrowserProvider {
  /** @inheritdoc */
  override readonly id = ELECTRON_PROVIDER_ID

  private readonly enabled: boolean
  private readonly windowTransport: ElectronWindowTransport | undefined
  /** 人工接管通道的订阅（只挂一次；同一个宿主进程里所有标签共用一条）。 */
  private takeoverChannel: Promise<void> | undefined

  /**
   * @param config - 超时与快照上限（端点无关，保留给基类）。
   * @param transport - 窗口宿主传输层。
   * @param enabled - 是否允许自己参与 provider 选择。
   */
  constructor(config: CdpProviderConfig, transport: CdpTransport, enabled: boolean) {
    super(config, transport)
    this.enabled = enabled
    // 基类把 transport 收成私有了，这里留一份具体类型，好用上标签页相关的那几个动作。
    this.windowTransport = transport instanceof ElectronWindowTransport ? transport : undefined
  }

  /** 本 provider 当前是否愿意被选中。 */
  get isEnabled(): boolean {
    return this.enabled
  }

  /**
   * 开一个会话，并把宿主的人工接管通知接进来（方案 4.1.1）。
   *
   * 订阅放在 `super.open()` **之后**：宿主此刻已经起来（`connect()` 需要它），会话 id 也才
   * 存在 —— 接管通知带 `tabId`，早挂少一次竞态。通道只有一条，后续会话共用（幂等）。
   */
  override async open(request: BrowserOpenRequest, signal?: AbortSignal): Promise<BrowserSession> {
    const session = await super.open(request, signal)
    this.ensureTakeoverChannel()
    return session
  }

  /**
   * 订阅宿主的人工接管通道（只挂一次）。
   *
   * 宿主没起来 / 不是窗口传输层时跳过；订阅失败不致命（接管提示只是增强信息），
   * 所以这里把 rejection 吞掉，不让它冒泡成 `open()` 的失败。
   */
  private ensureTakeoverChannel(): void {
    const transport = this.windowTransport
    if (transport === undefined) return
    this.takeoverChannel ??= transport.onTakeover((tabId, active) => {
      this.setTakeover(tabId, active)
    }).then(() => undefined, () => undefined)
  }

  /**
   * 把某个标签页切到前台（同一个壳窗口里换页，不是新开窗口）。
   *
   * @param sessionId - 会话 id，即标签 id。
   * @throws `BROWSER_TARGET_NOT_FOUND` 会话不存在或本 provider 没有窗口传输层。
   */
  async activate(sessionId: string): Promise<void> {
    if (this.windowTransport === undefined) {
      throw new BrowserError('this provider has no window host to activate tabs on', 'BROWSER_TARGET_NOT_FOUND')
    }
    await this.windowTransport.activateTarget(sessionId)
  }

  /**
   * 收摊：关掉会话之后**还要关掉宿主进程**。
   *
   * 基类只关会话 —— 那对 `cdp` provider 是对的（它连的是用户自己的 Chrome，不能把人家的
   * 浏览器关了）。但窗口宿主的 Electron 是**本插件自己 spawn 的**：只关会话的话，桥上的
   * TCP socket 一直活着，宿主进程也不退，于是跑完 `smoke:*` 这类脚本的 node 进程会一直挂
   * 在那里（事件循环还有活跃句柄），桌面端卸载插件时也会留下孤儿窗口。
   */
  override async dispose(): Promise<void> {
    try {
      await super.dispose()
    } finally {
      // 有会话没能干净关掉时，宿主仍然要收 —— 否则错误会把进程泄漏一起带出来。
      await this.windowTransport?.dispose()
    }
  }

  /** @inheritdoc */
  override available(): boolean {
    if (!this.enabled) return false
    return super.available()
  }
}
