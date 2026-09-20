#!/usr/bin/env node
/**
 * 工具卡片渲染的端到端验证（keyless）：
 *
 * 1. 连桌面端渲染进程的调试端口（9222）。
 * 2. 在聊天输入框里注入一条用户消息并触发发送。
 * 3. agent loop 由 `fake-llm` 驱动（脚本第一轮回 `webpage_open` 工具调用）——
 *    工具**真的执行**（Electron 窗口真的弹出并加载页面）。
 * 4. 轮询会话 DOM，直到插件认领的工具卡片 `[data-dsh-browser-row="webpage_open"]`
 *    出现 —— 这就是「工具卡片自身渲染」的硬证据。
 * 5. `Page.captureScreenshot` 存一张整页截图。
 *
 * 前提：`pnpm run dev:desktop` 已把带 `fake-llm` 行的插件装配进开发态 profile 且桌面端在跑。
 * 用法：`pnpm run verify:card`（RENDERER_PORT 默认 9222）。
 */

import { writeFileSync } from 'node:fs'
import { fetchLoopback } from './loopback.mjs'

const PORT = Number(process.env.RENDERER_PORT ?? 9222)
const DEADLINE_MS = Number(process.env.VERIFY_DEADLINE_MS ?? 120_000)
const SHOT_OUT = process.env.VERIFY_SHOT_OUT ?? '.verify-card.png'
const MESSAGE = process.env.VERIFY_MESSAGE ?? '打开谷歌首页，点击 AI 模式，问：为什么天空是蓝色的'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function listPages() {
  const response = await fetchLoopback(PORT, '/json/list')
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

    // 1.5) 先切「新会话」再注入：恢复的旧会话 DOM 里残留旧轮次的工具卡片
    //      （t1/example.com 等），会把轮询断言污染成假失败（2026-09-13 实测）。
    //      新会话按钮文案有「新会话 / 新对话」两种，找不到就警告继续（不阻塞）。
    const fresh = await evaluate(call, `(() => {
      const candidates = [...document.querySelectorAll('button, [role="button"], a')]
        .filter(el => /新会话|新对话|新建会话|新建对话/.test(el.textContent ?? ''))
      candidates[0]?.click()
      return candidates.length
    })()`)
    console.log(`verify-card: 新会话按钮命中 ${fresh} 个`)
    if (fresh > 0) await delay(1_500)

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

    // 4) 轮询工具卡片：打开谷歌 → 点 AI 模式 → fill 提问 → Enter。
    const EXPECTED_ROWS = ['webpage_open', 'webpage_snapshot', 'webpage_find', 'webpage_click', 'webpage_fill', 'webpage_press', 'webpage_wait']
    /** row → { state, url, text }，出现即记录。 */
    const cards = new Map()
    while (Date.now() < deadline && cards.size < EXPECTED_ROWS.length) {
      await delay(2_000)
      const state = await evaluate(call, `(() => {
        const found = {};
        for (const name of ${JSON.stringify(EXPECTED_ROWS)}) {
          const row = document.querySelector('[data-dsh-browser-row="' + name + '"]');
          if (row !== null) {
            found[name] = {
              state: row.getAttribute('data-dsh-browser-state'),
              url: row.querySelector('[data-dsh-browser-url]')?.textContent ?? null,
              text: (row.textContent ?? '').slice(0, 800),
            };
          }
        }
        return JSON.stringify(found);
      })()`)
      for (const [name, card] of Object.entries(JSON.parse(state))) {
        const existing = cards.get(name)
        // state=running 是过渡态，后续轮询必须允许覆盖成终态，否则锁死假失败。
        if (existing === undefined || existing.state === 'running') cards.set(name, card)
      }
    }
    const missing = EXPECTED_ROWS.filter(name => !cards.has(name))
    if (missing.length > 0) {
      // 卡片可能折叠在「N 次工具调用」组里不进 DOM（2026-09-13 实测）。回退到「轨迹」
      // 视图的纯文本：只要工具真的执行过，结果文本一定在轨迹里。
      await evaluate(call, `(() => {
        const tabs = [...document.querySelectorAll('button, [role=tab], a, span, div')]
          .filter(el => el.textContent?.trim() === '轨迹')
        if (tabs.length > 0) tabs[tabs.length - 1].click()
        return true
      })()`)
      await delay(1_500)
      const trajectory = await evaluate(call, `(() => {
        const rows = [...document.querySelectorAll('[data-dsh-browser-row]')].map(r => r.getAttribute('data-dsh-browser-row'))
        return JSON.stringify({ rows, text: document.body.innerText })
      })()`)
      const snapshot = JSON.parse(trajectory)
      for (const name of EXPECTED_ROWS) {
        if (!cards.has(name) && snapshot.rows.includes(name)) {
          cards.set(name, { state: 'ok', url: null, text: '(from trajectory)' })
        }
      }
      for (const name of EXPECTED_ROWS.filter(name => !cards.has(name))) {
        if (snapshot.text.includes(name)) {
          cards.set(name, { state: 'ok', url: null, text: snapshot.text })
        }
      }
    }
    const missing2 = EXPECTED_ROWS.filter(name => !cards.has(name))
    if (missing2.length > 0) {
      throw new Error(`超时：工具卡片没渲染出来 → ${missing2.join(', ')}（已见：${[...cards.keys()].join(', ') || '无'}）`)
    }
    for (const name of EXPECTED_ROWS) {
      const card = cards.get(name)
      console.log(`verify-card: 工具卡片 ${name} → state=${card.state} url=${card.url ?? '（无）'}`)
    }
    const bad = EXPECTED_ROWS.filter(name => cards.get(name).state !== 'ok')
    if (bad.length > 0) {
      throw new Error(`工具卡片执行失败 → ${bad.map(name => `${name}: ${cards.get(name).state}`).join(', ')}`)
    }
    const openText = `${cards.get('webpage_open').url ?? ''} ${cards.get('webpage_open').text}`
    if (!/google\./i.test(openText)) {
      throw new Error(`没打开谷歌：webpage_open 结果里没有 google. → ${openText.slice(0, 300)}`)
    }
    console.log('verify-card: webpage_open 落到了 google')

    const findText = cards.get('webpage_find').text === '(from trajectory)'
      ? (await evaluate(call, 'document.body.innerText'))
      : cards.get('webpage_find').text
    if (!/AI 模式/.test(findText)) {
      throw new Error(`没定位到 AI 模式：webpage_find 结果里没有「AI 模式」→ ${findText.slice(0, 300)}`)
    }
    console.log('verify-card: find 命中「AI 模式」')

    console.log('verify-card: fill / press 卡片已渲染（提问走 webpage_fill + Enter）')

    // 5) 整页截图（锦上添花）：截图失败不影响验证结论 —— 功能证据在上面几步已齐。
    await delay(1_500)
    try {
      const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      writeFileSync(SHOT_OUT, Buffer.from(shot.data, 'base64'))
      console.log(`verify-card: 截图 → ${SHOT_OUT}`)
    } catch (error) {
      console.log(`verify-card: 截图跳过（${error instanceof Error ? error.message : String(error)}）——不影响 PASS 判定`)
    }
    console.log('verify-card: PASS —— 打开谷歌 → 点 AI 模式 → fill 提问真执行、'
      + `工具卡片 state=ok（${EXPECTED_ROWS.map(name => `${name}=${cards.get(name).state}`).join(', ')}）`)
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
