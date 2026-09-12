#!/usr/bin/env node
/**
 * 给正在跑的桌面端截一张图，落成本地 PNG。
 *
 * 自检（check:desktop）证明的是「DOM 里有面板」；截图证明的是「用户真的看得见」。
 * 走 Electron 自己开的调试端口用 CDP 的 `Page.captureScreenshot`，不引任何依赖。
 *
 * 用法：`pnpm run shot:desktop`（环境变量：RENDERER_PORT 默认 9222，SHOT_OUT 默认 docs/desktop-dock.png）。
 *
 * 默认落在 `docs/` 里并**提交进仓库**：这张图是「装完在界面里看得见」这条要求的唯一目视证据。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const PORT = Number(process.env.RENDERER_PORT ?? 9222)
const OUT = resolve(process.env.SHOT_OUT ?? 'docs/desktop-dock.png')

/**
 * 首启引导弹窗（没有 API key 时每次启动都会挡在中间）的关闭按钮文案。
 * 截图前先点掉，否则拍到的是弹窗而不是界面。设 `SHOT_KEEP_ONBOARDING=1` 可跳过。
 */
const DISMISS_LABELS = ['稍后配置', 'Later']

/** 一条 CDP 连接上发一次请求。 */
function send(socket, method, params) {
  return new Promise((resolvePromise, reject) => {
    const id = Math.floor(Math.random() * 1e6)
    const timer = setTimeout(() => reject(new Error(`shot-desktop: ${method} 超时`)), 20_000)
    const listener = (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      if (message.error !== undefined) reject(new Error(`CDP 错误：${JSON.stringify(message.error)}`))
      else resolvePromise(message.result)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** 有首启弹窗就点掉，没有就当无事发生。 */
async function dismissOnboarding(socket) {
  const labels = JSON.stringify(DISMISS_LABELS)
  const expression = `(() => {
    const labels = ${labels};
    const button = [...document.querySelectorAll('button')]
      .find(candidate => labels.includes(candidate.textContent.trim()));
    if (button === undefined) return 'none';
    button.click();
    return button.textContent.trim();
  })()`
  const result = await send(socket, 'Runtime.evaluate', { expression, returnByValue: true })
  const clicked = result?.result?.value
  if (typeof clicked === 'string' && clicked !== 'none') {
    console.log(`shot-desktop: 已点掉首启弹窗「${clicked}」`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  }
}

/** 等页面可用，再截一张。 */
async function main() {
  const deadline = Date.now() + 60_000
  let page
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)
      const pages = await response.json()
      page = pages.find(item => item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string')
      if (page !== undefined) break
    } catch {
      // 还没起来，继续等。
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
  }
  if (page === undefined) throw new Error(`shot-desktop: ${String(PORT)} 上没有渲染页面；桌面端起得来吗？`)

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', () => reject(new Error('shot-desktop: CDP 连接失败')), { once: true })
  })
  try {
    if (process.env.SHOT_KEEP_ONBOARDING !== '1') await dismissOnboarding(socket)
    const { data } = await send(socket, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    if (typeof data !== 'string' || data === '') throw new Error('shot-desktop: CDP 没返回图像数据')
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, Buffer.from(data, 'base64'))
    console.log(`shot-desktop: 已写出 ${OUT}`)
  } finally {
    socket.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
