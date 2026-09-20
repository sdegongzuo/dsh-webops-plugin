/**
 * 脚本连本机的统一入口：**不要只认 `127.0.0.1`**。
 *
 * 有的企业终端策略（代理 bypass 名单、防火墙 / WFP 规则、终端管控）只放通 `localhost`
 * 这个名字，或者反过来只认字面 IP；还有的机器 IPv4 回环被掐掉、只剩 `::1`。
 * 写死 `127.0.0.1` 的表现是「本机连本机也连不上」，而报错跟「服务没起来」一模一样。
 *
 * 与 `src/loopback.ts` 是同一条规则的脚本侧版本（那边是 ESM 插件产物，这边是开发脚本，
 * 两边不共用文件但语义必须一致：候选顺序 `127.0.0.1` → `localhost`）。
 */

/** 回环主机名候选，按尝试顺序。 */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost']

/**
 * 按候选顺序 GET 本机端点。
 *
 * 只有**网络层**失败（连不上 / 被拦）才换名字重试；HTTP 状态码由调用方自己判 ——
 * 拿到一个 404 换名字再试一次没有意义，端口上就是没那个东西。
 *
 * @param port - 端口号。
 * @param path - 以 `/` 开头的路径。
 * @param init - 透传给 `fetch` 的选项（method、headers…）。
 * @returns 第一个连上的响应。
 * @throws 全部候选都连不上时抛 `Error`，消息里列出试过的名字。
 */
export async function fetchLoopback(port, path, init = undefined) {
  let lastError = new Error(`no loopback host to try for port ${String(port)}`)
  for (const host of LOOPBACK_HOSTS) {
    try {
      return await fetch(`http://${host}:${String(port)}${path}`, init)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `连不上本机 ${String(port)} 端口（试过 ${LOOPBACK_HOSTS.join('、')}）：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  )
}
