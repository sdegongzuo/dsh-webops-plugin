/**
 * 回环地址的兜底写法：**永远不要只认 `127.0.0.1` 这一个名字**。
 *
 * ## 为什么要兜底
 *
 * 有的企业终端策略（代理的 bypass 名单、Windows 防火墙 / WFP 规则、终端管控软件）
 * 只放通 `localhost` 这个名字，或者反过来只认字面 IP；还有的机器 IPv4 回环被策略掐掉、
 * 只剩 `::1`。写死 `127.0.0.1` 的结果是「本机连本机」也会失败，而报出来的错
 * （ECONNREFUSED / ETIMEDOUT）看上去跟「服务没起来」一模一样，极难诊断。
 *
 * 所以凡是连本机的地方，都要按**候选顺序**试，而不是只试一个名字。
 *
 * ## 顺序为什么是「字面 IP 在前」
 *
 * `127.0.0.1` 不经过 DNS、结果确定，成功路径最省事；`localhost` 可能解析到 `127.0.0.1`
 * 也可能解析到 `::1`（取决于系统），只在前者失败时才值得付这份不确定性。
 * 注意两者**可能指向同一个地址**：那时兜底也会一起失败 —— 兜底覆盖的是「名字被拦 /
 * IPv6-only」这两类，不是「端口上根本没服务」。
 *
 * @module dsh-webops-plugin/loopback
 */

import { connect, type Socket } from 'node:net'

/**
 * 回环主机名候选，按尝试顺序。
 *
 * 只放两个：`::1` 不单独列 —— `localhost` 在只留 IPv6 的机器上就会解析到它，
 * 显式再试一次 IPv6 字面量没有额外收益，反而多一次超时。
 */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost']

/**
 * 判断一个主机名是不是回环。
 *
 * 与 `browser-cdp/url-policy.ts` 的白名单保持一致（那里管的是「端点必须是本机」，
 * 这里管的是「本机该怎么连」），括号形式的 IPv6（`[::1]`）也算。
 *
 * @param host - 主机名，可以带 IPv6 的方括号。
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/gu, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/**
 * 以 `preferred` 打头的回环候选序列（去重、保序）。
 *
 * @param preferred - 首选主机名（通常来自配置或宿主宣布）。
 * @returns 非回环名时只有它自己 —— 兜底只在本机范围内成立，别把外部主机换掉。
 */
export function loopbackCandidates(preferred: string): readonly string[] {
  if (!isLoopbackHost(preferred)) return [preferred]
  const head = preferred.replace(/^\[|\]$/gu, '').toLowerCase()
  return [head, ...LOOPBACK_HOSTS.filter(host => host !== head)]
}

/**
 * 换掉 URL 里的主机名，协议 / 端口 / 路径一律保留。
 *
 * @param url - 原 URL 字符串。
 * @param host - 新主机名；IPv6 字面量交给 `URL` 自己加方括号。
 * @returns 换过主机名后的 URL 字符串。
 * @throws 原字符串不是合法 URL 时抛（属于调用方传错，不吞）。
 */
export function withHost(url: string, host: string): string {
  const parsed = new URL(url)
  // IPv6 字面量必须带方括号才能塞进 `hostname` —— 直接赋 `::1` 会被 URL 静默忽略
  // （于是「换了主机」其实一个字没变，这类静默失败正是要防的）。
  parsed.hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const text = parsed.toString()
  // `URL` 会给裸主机补一个根斜杠（`http://127.0.0.1:9222` → `http://127.0.0.1:9222/`），
  // 而调用方是拿端点**直接拼** `/json/list` 的 —— 多了这个斜杠就变成了 `//json/list`。
  // 所以除非调用方本来就以斜杠结尾，一律把补出来的那个去掉。
  return url.endsWith('/') ? text : text.replace(/\/+$/u, '')
}

/** `connectLoopback` 的成功结果。 */
export interface LoopbackSocket {
  /** 已连上的 socket。 */
  readonly socket: Socket
  /** 真正连上的那个主机名 —— 诊断信息要照它写，别照首选名写。 */
  readonly host: string
}

/** `connectLoopback` 的选项。 */
export interface LoopbackConnectOptions {
  /** 候选主机名；省略时用 {@link LOOPBACK_HOSTS}。 */
  readonly hosts?: readonly string[]
  /**
   * **总**预算（毫秒），不是「每个候选各一份」。
   *
   * 候选越多越容易把握手拖长，所以预算是共享的：前一个候选耗掉的时间会从后一个里扣。
   */
  readonly timeoutMs: number
}

/**
 * 按候选顺序连 `port`，返回第一个连上的。
 *
 * 每个候选失败就把 socket 收掉再试下一个 —— 否则失败的连接会留成半开句柄。
 * 全部失败时抛**最后一个**候选的错误（它的信息最贴近真实原因；首个候选的错误
 * 往往是「名字被拦」这类与端口无关的噪声）。
 *
 * @param port - 端口号。
 * @param options - 候选与超时预算。
 * @returns 连上的 socket 与它用的主机名。
 */
export async function connectLoopback(
  port: number,
  options: LoopbackConnectOptions,
): Promise<LoopbackSocket> {
  const hosts = options.hosts ?? LOOPBACK_HOSTS
  const deadline = Date.now() + options.timeoutMs
  let lastError: unknown = new Error(`no loopback host to try for port ${String(port)}`)

  for (const host of hosts) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const socket = connect({ host, port })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`connect timeout after ${String(remaining)}ms`)) }, remaining)
        socket.once('connect', () => { clearTimeout(timer); resolve() })
        socket.once('error', (error: Error) => { clearTimeout(timer); reject(error) })
      })
      return { socket, host }
    } catch (error: unknown) {
      lastError = error
      socket.destroy()
    }
  }
  throw lastError
}
