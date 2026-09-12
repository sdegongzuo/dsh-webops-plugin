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
 * @module dsh-browser-plugin/browser-electron/provider
 */

import { CdpBrowserProvider } from '../browser-cdp/provider.ts'
import type { CdpProviderConfig } from '../browser-cdp/provider.ts'
import type { CdpTransport } from '../browser-cdp/protocol.ts'

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

  /**
   * @param config - 超时与快照上限（端点无关，保留给基类）。
   * @param transport - 窗口宿主传输层。
   * @param enabled - 是否允许自己参与 provider 选择。
   */
  constructor(config: CdpProviderConfig, transport: CdpTransport, enabled: boolean) {
    super(config, transport)
    this.enabled = enabled
  }

  /** 本 provider 当前是否愿意被选中。 */
  get isEnabled(): boolean {
    return this.enabled
  }

  /** @inheritdoc */
  override available(): boolean {
    if (!this.enabled) return false
    return super.available()
  }
}
