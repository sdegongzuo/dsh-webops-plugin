/**
 * 代理相关的两件事：可选地把出厂代理写进包根 proxy.txt，以及启动器的 `NO_PROXY` 白名单。
 *
 * 默认不写 proxy.txt —— 代理端口因机器而异，普通发布不预置。
 * 面向固定环境的构建（例如本机 FlClash 的 7890）可以显式设置：
 *
 *   DSH_FACTORY_PROXY=http://127.0.0.1:7890
 *
 * 只有显式设置该环境变量才会生成 proxy.txt；文件格式与 `启动.cmd` 的读取约定一致：
 * 第一行一个完整代理 URL。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 启动器的 `NO_PROXY` 白名单：代理只留给「从本机连不通」的域名（Grok 的 cli-chat-proxy 等）。
 *
 * 国内服务走直连：绕一次本地代理没有收益，代理挂掉还会把 DeepSeek 与 WorkBuddy 一起拖死。
 * 口径与 undici 的匹配规则对齐（宿主 `@deepseek-ai/dsh-http-proxy` 与插件自带的那份都是它）：
 *
 * - 裸域名同时命中该域与全部子域，所以只写 apex（`deepseek.com` 覆盖 `api.deepseek.com`）；
 * - 不要写 `*.` 前缀 —— undici 的 `*.example.com` 只配子域、不配 apex；
 * - 环回地址宿主本来会强制并进 bypass 列表，这里显式列出是为了让脚本自身可读。
 *
 * 2026-11-20 实测（同一份 undici 8.11.2 + 必然拒连的假代理做对照）：
 * `api.deepseek.com` → 401、`copilot.tencent.com` / `wb.tencentbuddy.com` → 200；
 * 对照组（noProxy 为空）三者全 `ECONNREFUSED`，证明是绕开代理而不是代理碰巧可用。
 */
export const LOOPBACK_DIRECT_HOSTS = ['localhost', '127.0.0.1', '::1']

export const DOMESTIC_DIRECT_HOSTS = [
  'deepseek.com',
  'copilot.tencent.com',
  'tencentbuddy.com',
  'workbuddy.cn',
  'codebuddy.cn',
]

/** 渲染成 `NO_PROXY=` 的值：去重、去空白、拒绝分隔符，避免写出一份宿主看不懂的名单。 */
export function renderNoProxyValue(hosts = [...LOOPBACK_DIRECT_HOSTS, ...DOMESTIC_DIRECT_HOSTS]) {
  const seen = new Set()
  const entries = []
  for (const host of hosts) {
    const value = String(host).trim().toLowerCase()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    entries.push(value)
  }
  if (entries.length === 0) throw new Error('NO_PROXY 白名单不能为空')
  const bad = entries.find((entry) => /[\s,]/.test(entry))
  if (bad !== undefined) throw new Error(`NO_PROXY 条目不能含分隔符：${bad}`)
  return entries.join(',')
}

/**
 * 写进 `启动.cmd` 的代理分流片段（两个打包脚本共用，别各写一份）。
 *
 * 位置必须在设置 `HTTP(S)_PROXY` 之后、`start` 之前：宿主只在启动时读一次 env。
 */
export function launcherNoProxyLines() {
  return [
    'rem Domestic endpoints stay direct: the proxy is only for hosts unreachable from here',
    'rem (cli-chat-proxy.grok.com and friends). undici treats a bare domain as itself plus',
    'rem every subdomain, so the apex entries below also cover api./wb./www.',
    `set "NO_PROXY=${renderNoProxyValue()}"`,
  ]
}

export function normalizeFactoryProxy(raw) {
  if (raw === undefined || raw === '') return undefined
  let value = raw.trim()
  if (value === '') return undefined
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`DSH_FACTORY_PROXY 不是合法 URL：${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`DSH_FACTORY_PROXY 只支持 http/https 代理：${raw}`)
  }
  // 拒绝带用户名密码的代理 URL：凭据会明文落盘 proxy.txt、进分发 zip 并被打印进使用说明
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`DSH_FACTORY_PROXY 不能带账号密码（凭据会明文落盘 proxy.txt 并进分发 zip）：${raw}`)
  }
  if (parsed.hostname === '' || parsed.port === '') {
    throw new Error(`DSH_FACTORY_PROXY 必须带 host:port：${raw}`)
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`DSH_FACTORY_PROXY 不能带 query/hash：${raw}`)
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`DSH_FACTORY_PROXY 不能带路径：${raw}`)
  }
  return parsed.href.replace(/\/$/, '')
}

/** 写入包根 proxy.txt；未设置环境变量时返回 undefined，且不产生文件。 */
export function writeFactoryProxy(stageDir, raw = process.env.DSH_FACTORY_PROXY) {
  const proxy = normalizeFactoryProxy(raw)
  if (proxy === undefined) return undefined
  writeFileSync(join(stageDir, 'proxy.txt'), `${proxy}\n`, 'utf8')
  return proxy
}
