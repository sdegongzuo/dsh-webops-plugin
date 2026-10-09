/** CDP provider 配置、预算及兼容导出的常量。 */

import { type SnapshotLimits, DEFAULT_SNAPSHOT_LIMITS } from './snapshot.ts'
import { validateEndpoint } from './url-policy.ts'

/** provider 的 id，也是 `ctx.browser` 配置里 `provider` 字段要填的值。 */
export const CDP_PROVIDER_ID = 'cdp'

/**
 * 本机 Chrome 的默认调试端点。
 *
 * 写 `127.0.0.1` 只是「先试哪个」：连不上时 `HttpCdpTransport` 会自动换 `localhost`
 * 再试一次（企业策略常常只放通其中一个名字，见 `../loopback.ts`）。
 */
export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222'

/** P0 支持的浏览器操作；能力缝隙的 `observe` 只认这些。 */
export interface CdpProviderConfig {
  /** 调试端点，只允许回环地址。 */
  readonly endpoint?: string
  /** 单条 CDP 命令超时（毫秒）。 */
  readonly commandTimeoutMs?: number
  /** 一次 HTTP 探测/发现的超时（毫秒）。 */
  readonly requestTimeoutMs?: number
  /** 等页面加载完成的上限（毫秒）。 */
  readonly navigationTimeoutMs?: number
  /** `available()` 缓存探测结果的有效期（毫秒）。 */
  readonly probeTtlMs?: number
  /** 大纲规模上限。 */
  readonly snapshotLimits?: SnapshotLimits
  /** `wait` 类操作里 text / hidden 条件的默认超时（毫秒）。 */
  readonly waitTimeoutMs?: number
  /** `until: 'stable'` 的 DOM/网络安静窗口（毫秒）。默认 500。 */
  readonly stableQuietWindowMs?: number
  /** `until: 'stable'` 网络忙宽限期（毫秒）。默认 3000。 */
  readonly stableNetworkGraceMs?: number
}

/** 配置补齐默认值之后的样子。 */
export interface ResolvedConfig {
  readonly endpoint: string
  readonly commandTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly navigationTimeoutMs: number
  readonly probeTtlMs: number
  readonly snapshotLimits: SnapshotLimits
  readonly waitTimeoutMs: number
  readonly stableQuietWindowMs: number
  readonly stableNetworkGraceMs: number
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  endpoint: DEFAULT_CDP_ENDPOINT,
  commandTimeoutMs: 30_000,
  requestTimeoutMs: 5_000,
  navigationTimeoutMs: 15_000,
  probeTtlMs: 1_000,
  snapshotLimits: DEFAULT_SNAPSHOT_LIMITS,
  waitTimeoutMs: 10_000,
  stableQuietWindowMs: 500,
  stableNetworkGraceMs: 3_000,
}

/** `wait` 的纯等待上限（毫秒）；再长就是部署配错了。`until: 'stable'` 默认也用这个。 */
export const MAX_WAIT_TIME_MS = 30_000

/** `until: 'stable'` 连续安静窗口数（每个窗口 {@link ResolvedConfig.stableQuietWindowMs}）。 */
export const STABLE_QUIET_WINDOWS = 2

/** click / press 落地后探测「地址是否变了」的窗口（毫秒）。 */
export const MUTATION_NAVIGATION_POLL_MS = 800

/**
 * 一次 mutation 里「页面可能开出来的新标签页」必须被观测到的时间点：**动作发起点 + 本值**（毫秒）。
 *
 * 为什么是这个数：宿主的「弹窗转标签」链路（`setWindowOpenHandler` → `openTab` →
 * `{type:'opened'}` 通报 → provider `adoptSession`）是异步的，本机实测（2026-09-17，
 * `D:\Temp\dshhost\measure-opened.mjs`，n=5）从 `window.open` 被派发到父进程收到通报：
 * **min 140ms / 中位 152ms / max 156ms**。取 250ms 是给慢机器留余量 ——
 * 这个窗口只在「来不及观测」的路径上真正付出等待，代价见 {@link collectOpenedTabs}。
 */
export const TAB_OPEN_WATCH_MS = 250

/** 补观测新标签页时的轮询间隔（毫秒）；远小于窗口本身，够细。 */
export const TAB_OPEN_WATCH_POLL_MS = 25

/**
 * 探测到导航之后再等新文档「能用」的上限（毫秒）。
 *
 * 为什么需要：地址变了不等于新文档已解析完 —— 报告 S1 实测 `webpage_press` 回车跳维基搜索页时
 * 返回的 `title` 是**空串**（文档已提交，`<title>` 还没解析出来），调用方据此会误判「页没就绪」。
 * 所以检测到导航后额外等一小段：`readyState === 'complete'` 或标题出现即返回，超时也返回
 * （页面是慢，不是错，别把 `press` 拖成失败）。窗口远小于工具超时（60s）。
 */
export const MUTATION_NAVIGATION_SETTLE_MS = 5_000

/** `wait` 轮询 text / hidden 条件的间隔（毫秒）。 */
export const WAIT_POLL_INTERVAL_MS = 100

/**
 * `mouseWheel` 单独用的回包等待上限（毫秒）。
 *
 * 为什么与 `commandTimeoutMs`（30s）脱钩：滚轮事件在 Electron / 后台标签上**可能根本不回包**，
 * 而工具的观察超时也是 30s —— 不脱钩时一次 `webpage_scroll` 就把 agent 卡满 30s（J6）。
 * 2s 是「够真浏览器回一次包」与「不至于让模型干等」之间的折中。
 *
 * **超时不是失败**：事件已经投递出去了，只是不知道页面有没有滚。回执照给，位置让模型自己去
 * 确认（snapshot / locate），总比「工具超时、模型什么都不知道」强。
 */
export const WHEEL_ACK_TIMEOUT_MS = 2_000

/** `webpage_console` / `webpage_network` 的默认返回条数（从最新往回）。 */
export const DEFAULT_P2_LIMIT = 50

/**
 * `limit` 的硬上限（条）。**从 500 收到 150**（2026-09-17）。
 *
 * 500 那条是照采集环形容量抄的，但它同时是「一次调用能塞进上下文的条数」：
 * console 单条上限 2000 字符 × 500 = 100 万字符，network 长 URL 一行 276 字符 × 500 =
 * 13.8 万字符 —— 都远超一次观察该有的体量。收到 150 之后，配合各自的**总量预算**
 * （`CONSOLE_RESULT_MAX_CHARS` / `NETWORK_LIST_MAX_CHARS`，见各自模块），单次观察的最坏
 * 情况被钉在几万字符量级。要更多就分页/过滤，那本来就比一次拉满更好用。
 */
export const MAX_P2_LIMIT = 150

/** `webpage_execute` 结果的裁剪上限（字符）；逃生舱可能返回极大对象，别撑爆上下文。 */
export const EXECUTE_MAX_RESULT_CHARS = 20_000

/**
 * 命令白名单判定里的「导航类」命令：执行后要走既有的导航检测 / 纪元推进路径。
 * 这两条会替换文档，旧 ref 一律作废 —— `Page.reload` 地址不变，所以必须**无条件**作废。
 */
export const NAVIGATION_COMMANDS: ReadonlySet<string> = new Set(['Page.navigate', 'Page.reload'])

/**
 * 校验 provider 配置里的数值项。端点由构造函数校验（那里也会补齐默认值）。
 * @param config - 原始配置。
 * @throws 端点非法或数值超时非正时抛普通 `Error`（属于部署配置错误，不是模型可恢复的浏览器错误）。
 */
export function validateProviderConfig(config: CdpProviderConfig = {}): void {
  validateEndpoint(config.endpoint ?? DEFAULT_CONFIG.endpoint)
  for (const [name, value] of Object.entries({
    commandTimeoutMs: config.commandTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    navigationTimeoutMs: config.navigationTimeoutMs,
    probeTtlMs: config.probeTtlMs,
    waitTimeoutMs: config.waitTimeoutMs,
  })) {
    if (value === undefined) continue
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`browser-cdp: ${name} must be a positive finite number`)
    }
  }
}
