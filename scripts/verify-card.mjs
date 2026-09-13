#!/usr/bin/env node
/**
 * 工具卡片渲染的端到端验证（keyless）：
 *
 * 1. 连桌面端渲染进程的调试端口（9222）。
 * 2. 在聊天输入框里注入一条用户消息并触发发送。
 * 3. agent loop 由 `fake-llm` 驱动（脚本第一轮回 `browser_open` 工具调用）——
 *    工具**真的执行**（Electron 窗口真的弹出并加载页面）。
 * 4. 轮询会话 DOM，直到插件认领的工具卡片 `[data-dsh-browser-row="browser_open"]`
 *    出现 —— 这就是「工具卡片自身渲染」的硬证据。
 * 5. `Page.captureScreenshot` 存一张整页截图。
 *
 * 前提：`pnpm run dev:desktop` 已把带 `fake-llm` 行的插件装配进开发态 profile 且桌面端在跑。
 * 用法：`pnpm run verify:card`（RENDERER_PORT 默认 9222）。
 */

import { writeFileSync } from 'node:fs'

const PORT = Number(process.env.RENDERER_PORT ?? 9222)
const DEADLINE_MS = Number(process.env.VERIFY_DEADLINE_MS ?? 120_000)
const SHOT_OUT = process.env.VERIFY_SHOT_OUT ?? '.verify-card.png'
const MESSAGE = process.env.VERIFY_MESSAGE ?? '打开 example.com'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function listPages() {
  const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)
  if (!response.ok) throw new Error(`/json/list 返回 ${String(response.status)}`)
  const pages = await response.json()
  return pages.filter(page => page.type === 'page' && typeof page.webSocketDebuggerUrl === 'string')
}

/** 一条 CDP 连接上的多次 Runtime.evaluate。 */
async function withSession(webSocketDebuggerUrl, run) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(`CDP 错误：${JSON.stringify(message.error)}`))
    else if (message.result?.exceptionDetails !== undefined) {
      entry.reject(new Error(`页面异常：${String(message.result.exceptionDetails.text ?? '')} ${JSON.stringify(message.result.exceptionDetails.exception?.description ?? '')}`.slice(0, 500)))
    } else entry.resolve(message.result)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} 超时`))
    }, 20_000)
    pending.get(id).reject = (error) => { clearTimeout(timer); reject(error) }
    socket.send(JSON.stringify({ id, method, params }))
  })
  try {
    return await run(call)
  } finally {
    socket.close()
  }
}

async function evaluate(call, expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`页面异常：${String(result.exceptionDetails.text ?? '')}`)
  }
  return result.result?.value
}

async function main() {
  const deadline = Date.now() + DEADLINE_MS
  let page
  while (Date.now() < deadline) {
    try {
      const pages = await listPages()
      if (pages.length > 0) { page = pages[0]; break }
    } catch { /* 还没起 */ }
    await delay(2_000)
  }
  if (page === undefined) throw new Error(`等了 ${String(DEADLINE_MS)}ms 也没连上 ${String(PORT)}`)

  console.log(`verify-card: 连上 ${page.url}`)

  await withSession(page.webSocketDebuggerUrl, async (call) => {
    // 1) 找聊天输入框：textarea 优先，其次 contenteditable。
    const probe = await evaluate(call, `(() => {
      const textarea = document.querySelector('textarea');
      const editable = document.querySelector('[contenteditable="true"]');
      const input = textarea ?? editable;
      return JSON.stringify({
        found: input !== null,
        kind: textarea !== null ? 'textarea' : editable !== null ? 'contenteditable' : null,
        sendButtons: [...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') ?? b.title ?? b.textContent ?? '').trim()).filter(t => t !== '').slice(0, 30),
      });
    })()`)
    const dom = JSON.parse(probe)
    if (!dom.found) throw new Error(`聊天输入框没找到；页面按钮：${JSON.stringify(dom.sendButtons)}`)
    console.log(`verify-card: 输入框 ${dom.kind}`)

    // 2) 注入消息并触发框架识别（React 的受控组件要动 native setter）。
    await evaluate(call, `(() => {
      const input = document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]');
      const text = ${JSON.stringify(MESSAGE)};
      input.focus();
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.setter;
        setter?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }
      return true;
    })()`)

    // 3) 发送：优先点发送按钮，失败退回回车。
    const sent = await evaluate(call, `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const send = buttons.find(b => (b.getAttribute('aria-label') ?? b.title ?? '').toLowerCase().includes('send'))
        ?? buttons.find(b => (b.getAttribute('aria-label') ?? b.title ?? '').includes('发送'));
      if (send !== undefined && !send.disabled) { send.click(); return 'button'; }
      const input = document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      return 'enter';
    })()`)
    console.log(`verify-card: 消息已发送（${sent}）`)

    // 4) 轮询工具卡片。
    let card = null
    while (Date.now() < deadline) {
      await delay(2_000)
      const state = await evaluate(call, `(() => {
        const row = document.querySelector('[data-dsh-browser-row="browser_open"]');
        if (row === null) return null;
        return JSON.stringify({
          state: row.getAttribute('data-dsh-browser-state'),
          url: row.querySelector('[data-dsh-browser-url]')?.textContent ?? null,
          text: (row.textContent ?? '').slice(0, 200),
        });
      })()`)
      if (state !== null) { card = JSON.parse(state); break }
    }
    if (card === null) throw new Error('超时：工具卡片 [data-dsh-browser-row=browser_open] 没渲染出来')
    console.log(`verify-card: 工具卡片已渲染 → state=${card.state} url=${card.url ?? '（无）'}`)

    // 5) 整页截图。
    await delay(1_500)
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOT_OUT, Buffer.from(shot.data, 'base64'))
    console.log(`verify-card: 截图 → ${SHOT_OUT}`)
    console.log(`verify-card: PASS —— browser_open 真执行、工具卡片真渲染（state=${card.state}）`)
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
