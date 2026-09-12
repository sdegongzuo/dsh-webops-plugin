/**
 * 地址策略：provider 在把 URL 交给浏览器**之前**做的、与网络无关的校验。
 *
 * 思路照 dsh 的 `packages/web/web-fetch-http/src/policy.ts` 抄（只做 HTTP(S)、禁止内嵌凭据、
 * 长度有上限），但浏览器语境下多一条豁免：`about:blank` 是开空白页的合法目标。
 *
 * 这里**不做**公网地址解析与逐跳校验 —— 浏览器自己会走网络，逐跳 pinning 在浏览器进程里没有
 * 落点；对浏览器来说真正的边界是「模型能不能让浏览器去任意地址」，而那由**用户自己开着的
 * Chrome 的登录态**兜底：这是调试形态，不是匿名抓取形态。
 *
 * @module dsh-browser-plugin/browser-cdp/url-policy
 */

import { BrowserError } from '../browser/types.ts'

/** 浏览器目标 URL 的长度上限（与 web 抓取 provider 对齐）。 */
export const BROWSER_MAX_URL_LENGTH = 2048

/** 允许但不走网络的内部目标。 */
const INTERNAL_TARGETS = new Set(['about:blank'])

/**
 * 校验一个浏览器目标 URL。
 *
 * @param input - 模型给出的原始 URL。
 * @returns 规范化后的 URL 字符串（`about:blank` 原样返回）。
 * @throws 用 `BROWSER_URL_BLOCKED` 拒绝非 HTTP(S)、内嵌凭据或超长的输入。
 */
export function validateTargetUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new BrowserError('target URL must be a non-empty string', 'BROWSER_URL_BLOCKED')
  }
  if (INTERNAL_TARGETS.has(trimmed)) return trimmed
  if (trimmed.length > BROWSER_MAX_URL_LENGTH) {
    throw new BrowserError(
      `target URL exceeds the maximum length of ${BROWSER_MAX_URL_LENGTH}`,
      'BROWSER_URL_BLOCKED',
    )
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch (error: unknown) {
    throw new BrowserError(`invalid target URL: ${trimmed}`, 'BROWSER_URL_BLOCKED', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError(
      `unsupported URL scheme "${url.protocol}" (only http and https are allowed)`,
      'BROWSER_URL_BLOCKED',
    )
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new BrowserError('credentials in URLs are not allowed', 'BROWSER_URL_BLOCKED')
  }
  return url.toString()
}

/**
 * 校验调试端点地址。只允许回环地址 —— 调试端口没有任何认证，
 * 把 `BROWSER_CDP_ENDPOINT` 指向非本机等于把本机浏览器交给远端。
 *
 * @param input - 形如 `http://127.0.0.1:9222` 的端点。
 * @returns 去掉尾斜杠的规范化端点。
 * @throws 端点非法或非回环时抛普通 `Error`（属于配置错误，不是模型可恢复的浏览器错误）。
 */
export function validateEndpoint(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new Error(`browser-cdp: endpoint must be a valid URL, got "${input}"`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`browser-cdp: endpoint must use http or https, got "${url.protocol}"`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`browser-cdp: endpoint must be a loopback address, got "${url.hostname}"`)
  }
  return input.replace(/\/+$/u, '')
}
