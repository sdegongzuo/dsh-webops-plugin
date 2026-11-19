/**
 * 可选：把出厂代理写进包根 proxy.txt。
 *
 * 默认不写 —— 代理端口因机器而异，普通发布不预置。
 * 面向固定环境的构建（例如本机 FlClash 的 7890）可以显式设置：
 *
 *   DSH_FACTORY_PROXY=http://127.0.0.1:7890
 *
 * 只有显式设置该环境变量才会生成 proxy.txt；文件格式与 `启动.cmd` 的读取约定一致：
 * 第一行一个完整代理 URL。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
