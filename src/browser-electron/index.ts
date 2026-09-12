/**
 * browser-electron 插件入口：注册一个「在桌面端里开 Electron 窗口」的浏览器 provider。
 *
 * ## 它解决什么问题
 *
 * P0 的 `browser-cdp` provider 连的是**外部** Chrome 的调试端口。在 dsh 桌面端里这条路走不通 ——
 * 桌面端自己的调试端口（9222）就是它的渲染进程，而嵌入式 Chromium 不实现 `PUT /json/new`，
 * 于是 `browser_open` 只会得到一句「Could not create a new page」。
 *
 * 本插件换成让 host 进程 **spawn 一个 Electron 窗口宿主**：窗口是桌面端自己的 `BrowserWindow`，
 * 由 `webContents.debugger`（同一套 CDP）驱动。同一份 `CdpBrowserProvider` 原样复用，
 * 只换传输层。
 *
 * ## 启用方式
 *
 * 必须**显式启用**，否则它不参与 provider 选择（理由见 `provider.ts`）：
 *
 * ```bash
 * # 1) 指 Electron 二进制
 * export DSH_BROWSER_ELECTRON_PATH="…/node_modules/electron/dist/electron.exe"
 * # 2) 让 browser 服务选它
 * export DSH_BROWSER_PROVIDER=electron
 * ```
 *
 * 也可以在 profile 里写 `config:`（`enabled` / `electronPath`）。
 *
 * @module dsh-browser-plugin/browser-electron
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '../browser/index.ts'
import { DEFAULT_SNAPSHOT_LIMITS } from '../browser-cdp/snapshot.ts'
import { DEFAULT_BRIDGE_COMMAND_TIMEOUT_MS, DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS } from './bridge.ts'
import { ElectronBrowserProvider } from './provider.ts'
import { ElectronWindowTransport } from './transport.ts'
import { noteLoaded } from '../debug.ts'

export { ELECTRON_PROVIDER_ID, ElectronBrowserProvider } from './provider.ts'
export { BridgeError, ElectronWindowBridge } from './bridge.ts'
export type { BridgeOptions, BridgeWindow } from './bridge.ts'
export { ELECTRON_WINDOW_SCHEME, ElectronWindowTransport, windowHandle, windowIdFromHandle } from './transport.ts'
export { WindowCdpSocket } from './socket.ts'

/** Cordis 插件名。 */
export const name = 'browser-electron'

/** 依赖的能力服务。 */
export const inject = ['browser']

/** 让 `browser` 服务选择本 provider 的环境变量（与 `DSH_BROWSER_PROVIDER` 一致）。 */
export const PROVIDER_ENV = 'DSH_BROWSER_PROVIDER'

/** Electron 可执行文件路径的环境变量。 */
export const ELECTRON_PATH_ENV = 'DSH_BROWSER_ELECTRON_PATH'

/** 本 provider 的 id（供外部引用）。 */
export const PROVIDER_ID = 'electron'

/** 默认窗口尺寸。 */
export const DEFAULT_WINDOW_SIZE = { width: 1100, height: 820 } as const

/** 插件配置。 */
export interface Config {
  /** 是否启用；缺省时看 `DSH_BROWSER_PROVIDER`。 */
  enabled?: boolean
  /** Electron 可执行文件路径；缺省时看 `DSH_BROWSER_ELECTRON_PATH`。 */
  electronPath?: string
  /** 新建窗口的尺寸。 */
  windowSize?: { width?: number; height?: number }
  /** 单条命令超时（毫秒）。 */
  commandTimeoutMs?: number
  /** 等宿主宣布端口的上限（毫秒）。 */
  handshakeTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  electronPath: z.string(),
  windowSize: z.object({
    width: z.number().default(DEFAULT_WINDOW_SIZE.width),
    height: z.number().default(DEFAULT_WINDOW_SIZE.height),
  }),
  commandTimeoutMs: z.number().default(DEFAULT_BRIDGE_COMMAND_TIMEOUT_MS),
  handshakeTimeoutMs: z.number().default(DEFAULT_BRIDGE_HANDSHAKE_TIMEOUT_MS),
})

/**
 * 注册 provider。
 *
 * 与 `browser-cdp` 一样，`config` 必须容忍 `undefined`：patch 行不带 `config:` 时加载器传进来的是空值。
 *
 * @param ctx - 上下文，其 `browser` 服务会收到这个 provider。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveConfig(config)
  const provider = new ElectronBrowserProvider(
    {
      ...settings.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: settings.commandTimeoutMs },
      snapshotLimits: DEFAULT_SNAPSHOT_LIMITS,
    },
    new ElectronWindowTransport({
      electronPath: settings.electronPath ?? '',
      hostScript: resolveHostScript(),
      windowSize: settings.windowSize,
      ...settings.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: settings.commandTimeoutMs },
      ...settings.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: settings.handshakeTimeoutMs },
    }),
    settings.enabled,
  )
  ctx.browser.registerProvider(provider)
  ctx.effect(function* () {
    yield () => {
      void provider.dispose().catch(() => undefined)
    }
  }, 'browser-electron.dispose()')
  noteLoaded('browser-electron', `enabled=${String(settings.enabled)} electron=${settings.electronPath ?? '（未指定）'}`)
}

/** 解析配置：`config` 优先，环境变量兜底。 */
export function resolveConfig(config: Config = {}): {
  enabled: boolean
  electronPath: string | undefined
  windowSize: { width: number; height: number }
  commandTimeoutMs: number | undefined
  handshakeTimeoutMs: number | undefined
} {
  const enabled = config.enabled ?? process.env[PROVIDER_ENV] === PROVIDER_ID
  const fromEnv = process.env[ELECTRON_PATH_ENV]
  const electronPath = config.electronPath ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined)
  return {
    enabled,
    electronPath,
    windowSize: {
      width: config.windowSize?.width ?? DEFAULT_WINDOW_SIZE.width,
      height: config.windowSize?.height ?? DEFAULT_WINDOW_SIZE.height,
    },
    commandTimeoutMs: config.commandTimeoutMs,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
  }
}

/** 窗口宿主脚本的位置：与编译产物同目录（`lib/browser-electron/host.cjs`）。 */
function resolveHostScript(): string {
  return fileURLToPath(new URL('./host.cjs', import.meta.url))
}
