#!/usr/bin/env node
// 只读检查：连渲染进程 CDP，读聊天 DOM 最后一段 assistant 回复文本，
// 确认 fake-llm 动态证据收尾（打开谷歌 → AI 模式 → 提问）是否可见。
import { writeFileSync } from 'node:fs'
import { fetchLoopback } from './loopback.mjs'

const PORT = process.env.RENDERER_PORT ?? 9222
const pages = await (await fetchLoopback(PORT, '/json/list')).json()
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

// 用 innerText 全文，不要只收「无子节点的叶子」：markdown 会把「详情页：<url>」拆成
// 文本节点 + <a>，叶子过滤会把证据行整行漏掉（2026-09-14 假阴性的真因）。
const expr = `(() => document.body.innerText)()`

const { result } = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
const text = String(result?.value ?? '')
writeFileSync('scripts/.last-chat-dom.txt', text)
console.log('DOM 全文长度:', text.length)

const questionLine = /问题：([^\n]+)/u.exec(text)?.[1]?.trim() ?? ''
const hasQuestion = questionLine.length > 0 || text.includes('为什么天空是蓝色的')
const hasGoogle = /google\./i.test(text)
const hasExcerptMarker = text.includes('页面摘录')
const hasEvidenceHeader = text.includes('已完成「打开谷歌')
console.log('证据检查：')
console.log('  谷歌地址出现:', hasGoogle)
console.log('  问题出现:', hasQuestion, hasQuestion && questionLine !== '' ? `（${questionLine}）` : '')
console.log('  「页面摘录」标记出现:', hasExcerptMarker)
console.log('  证据收尾开头出现:', hasEvidenceHeader)

if (hasQuestion || hasExcerptMarker) {
  const idx = Math.max(text.lastIndexOf('问题：'), text.lastIndexOf('页面摘录'))
  console.log('\n--- 证据片段（前后各 600 字）---')
  console.log(text.slice(Math.max(0, idx - 600), idx + 600))
} else {
  console.log('\n--- DOM 尾部 1200 字 ---')
  console.log(text.slice(-1200))
}
socket.close()
