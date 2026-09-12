/**
 * browser-cdp 插件入口：把 {@link CdpBrowserProvider} 注册进 `ctx.browser`。
 *
 * 所有贡献都走 `ctx.effect()` —— 插件卸载时 provider 一并释放它持有的连接与标签页。
 *
 * @module dsh-browser-plugin/browser-cdp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '../browser/index.ts'
import { CdpBrowserProvider, DEFAULT_CDP_ENDPOINT } from './provider.ts'
import type { CdpProviderConfig } from './provider.ts'
import { DEFAULT_SNAPSHOT_LIMITS } from './snapshot.ts'
import { noteLoaded } from '../debug.ts'

export {
  CdpBrowserProvider,
  CDP_PROVIDER_ID,
  DEFAULT_CDP_ENDPOINT,
  validateProviderConfig,
} from './provider.ts'
export type { CdpProviderConfig } from './provider.ts'
export { CdpConnection, HttpCdpTransport } from './protocol.ts'
export type { CdpSocket, CdpSocketFactory, CdpTarget, CdpTransport, CdpVersion } from './protocol.ts'
export { RefRegistry } from './refs.ts'
export type { RefPublication, RefTarget } from './refs.ts'
export { buildOutline, DEFAULT_SNAPSHOT_LIMITS, renderOutline } from './snapshot.ts'
export type { AxNode, OutlineLine, SnapshotLimits, SnapshotOutline } from './snapshot.ts'
export { BROWSER_MAX_URL_LENGTH, validateEndpoint, validateTargetUrl } from './url-policy.ts'

/** Cordis 插件名，用于加载器诊断。 */
export const name = 'browser-cdp'

/** 本 provider 依赖的能力服务。 */
export const inject = ['browser']

/** 插件配置：调试端点、各类超时、大纲规模上限，全部有默认值。 */
export interface Config {
  /** Chrome 调试端点，只允许回环地址。默认 `http://127.0.0.1:9222`。 */
  endpoint?: string
  /** 单条 CDP 命令超时（毫秒）。默认 30000。 */
  commandTimeoutMs?: number
  /** 一次 HTTP 探测/发现的超时（毫秒）。默认 5000。 */
  requestTimeoutMs?: number
  /** 等页面加载完成的上限（毫秒）。默认 15000。 */
  navigationTimeoutMs?: number
  /** `available()` 缓存探测结果的有效期（毫秒）。默认 1000。 */
  probeTtlMs?: number
  /** 紧凑大纲的规模上限。 */
  snapshotLimits?: {
    maxLines?: number
    maxDepth?: number
    maxTextLength?: number
    maxOutlineChars?: number
  }
}

export const Config: z<Config> = z.object({
  endpoint: z.string().default(DEFAULT_CDP_ENDPOINT),
  commandTimeoutMs: z.number().default(30_000),
  requestTimeoutMs: z.number().default(5_000),
  navigationTimeoutMs: z.number().default(15_000),
  probeTtlMs: z.number().default(1_000),
  snapshotLimits: z.object({
    maxLines: z.number().default(DEFAULT_SNAPSHOT_LIMITS.maxLines),
    maxDepth: z.number().default(DEFAULT_SNAPSHOT_LIMITS.maxDepth),
    maxTextLength: z.number().default(DEFAULT_SNAPSHOT_LIMITS.maxTextLength),
    maxOutlineChars: z.number().default(DEFAULT_SNAPSHOT_LIMITS.maxOutlineChars),
  }),
})

/**
 * 端点覆盖用的环境变量名。
 *
 * 为什么需要它：桌面端里 profile 目录由应用**独占并每次重建**，往里写 `config.endpoint`
 * 是一次性改动 —— 下次启动就没了。而桌面端自己的调试端口（9222）就是它自己的渲染进程，
 * 嵌入式 Chromium 不实现 `PUT /json/new`，连它必然开不出标签页。要让桌面端里的浏览器工具
 * 真的能用，必须把端点指到**外接的真 Chrome**，env 是唯一稳定的旋钮。
 *
 * 优先级高于 `config.endpoint`：它表达的是「部署时说了算」，不是「插件默认值」。
 */
export const CDP_ENDPOINT_ENV = 'DSH_BROWSER_CDP_ENDPOINT'

/** 读一次端点覆盖；空串按「没设」处理。 */
function readEndpointOverride(): string | undefined {
  const value = process.env[CDP_ENDPOINT_ENV]
  return value !== undefined && value.length > 0 ? value : undefined
}

/** 把插件配置折算成 provider 配置；每一格都留着 `??` 兜底。 */
function toProviderConfig(config: Config): CdpProviderConfig {
  const limits = config.snapshotLimits
  const endpoint = readEndpointOverride() ?? config.endpoint
  return {
    ...endpoint !== undefined ? { endpoint } : {},
    ...config.commandTimeoutMs !== undefined ? { commandTimeoutMs: config.commandTimeoutMs } : {},
    ...config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {},
    ...config.navigationTimeoutMs !== undefined ? { navigationTimeoutMs: config.navigationTimeoutMs } : {},
    ...config.probeTtlMs !== undefined ? { probeTtlMs: config.probeTtlMs } : {},
    ...limits !== undefined
      ? {
        snapshotLimits: {
          maxLines: limits.maxLines ?? DEFAULT_SNAPSHOT_LIMITS.maxLines,
          maxDepth: limits.maxDepth ?? DEFAULT_SNAPSHOT_LIMITS.maxDepth,
          maxTextLength: limits.maxTextLength ?? DEFAULT_SNAPSHOT_LIMITS.maxTextLength,
          maxOutlineChars: limits.maxOutlineChars ?? DEFAULT_SNAPSHOT_LIMITS.maxOutlineChars,
        },
      }
      : {},
  }
}

/**
 * 注册 CDP provider，并把它挂到插件 fiber 的生命周期上。
 *
 * `config` 必须容忍 `undefined`：本插件的 patch 行不带 `config:` 键，此时加载器传进来的就是
 * 空值，而不是 schemastery 补好的默认值。所有默认值因此都在 `toProviderConfig` 里用 `??` 兜底。
 *
 * （另注：**不要**给本模块加 `export default`。加载器会执行 `exports = exports.default ?? exports`，
 * 一旦有默认导出，`name` / `inject` / `Config` 这三个命名导出就整批消失，症状是
 * `cannot get property "systemPrompt" without inject` 这类莫名其妙的报错。）
 *
 * @param ctx - 上下文，其 `browser` 服务会收到这个 provider。
 * @param config - 插件配置；缺省即全部使用默认值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = toProviderConfig(config)
  const provider = new CdpBrowserProvider(settings)
  ctx.browser.registerProvider(provider)
  // 卸载时释放连接与标签页；不注册这一步，进程退出前会留下一堆没关的 WebSocket 和标签页。
  ctx.effect(function* () {
    yield () => {
      void provider.dispose().catch(() => undefined)
    }
  }, 'browser-cdp.dispose()')
  noteLoaded('browser-cdp', `endpoint=${settings.endpoint ?? DEFAULT_CDP_ENDPOINT}`)
}
