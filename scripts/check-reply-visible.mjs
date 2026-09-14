#!/usr/bin/env node
// 只读检查：连渲染进程 CDP，读聊天 DOM 最后一段 assistant 回复文本，
// 确认 fake-llm 动态证据收尾（热搜第五条 + 详情页 + 正文摘录）是否可见。
import { writeFileSync } from 'node:fs'

const PORT = process.env.RENDERER_PORT ?? 9222
const pages = await (await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)).json()
const page = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl)
if (!page) throw new Error('没有可用的 page 目标')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true })
})
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const m = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
  const e = pending.get(m.id)
  if (!e) return
  pending.delete(m.id)
  if (m.error) e.reject(new Error(JSON.stringify(m.error)))
  else e.resolve(m.result)
})
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)) }, 15_000)
  socket.send(JSON.stringify({ id, method, params }))
})

const expr = `(() => {
  const sel = '[data-dsh-browser-row], [class*="markdown"], [class*="message"], [class*="chat"]'
  const texts = Array.from(document.querySelectorAll('body *'))
    .filter(el => el.children.length === 0 && el.textContent && el.textContent.trim().length > 10)
    .map(el => el.textContent.trim())
  const joined = texts.join('\\n===\\n')
  return joined
})()`

const { result } = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
const text = String(result?.value ?? '')
writeFileSync('scripts/.last-chat-dom.txt', text)
console.log('DOM 全文长度:', text.length)

const FIFTH = '烧烤店被检查15次'
const hasFifth = text.includes(FIFTH)
const hasDetailUrl = text.includes('baidu.com/s?wd=') || text.includes('wd=%E7%83%A7%E7%83%')
const hasExcerptMarker = text.includes('正文摘录')
const hasEvidenceHeader = text.includes('已完成「打开百度')
console.log('证据检查：')
console.log('  第五条标题出现:', hasFifth)
console.log('  详情页 URL 出现:', hasDetailUrl)
console.log('  「正文摘录」标记出现:', hasExcerptMarker)
console.log('  证据收尾开头出现:', hasEvidenceHeader)

// 把含证据的片段打出来
if (hasFifth || hasExcerptMarker) {
  const idx = Math.max(text.lastIndexOf(FIFTH), text.lastIndexOf('正文摘录'))
  console.log('\n--- 证据片段（前后各 600 字）---')
  console.log(text.slice(Math.max(0, idx - 600), idx + 600))
} else {
  console.log('\n--- DOM 尾部 1200 字 ---')
  console.log(text.slice(-1200))
}
socket.close()
