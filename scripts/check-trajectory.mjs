#!/usr/bin/env node
// 只读+视图切换：点击「轨迹」tab，抓取轨迹全文里 c7（webpage_execute 详情页正文）的结果行，
// 验证 detailDigest 依赖的 `Runtime.evaluate on session_id=` 格式是否存在。
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
const evalJs = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true })
  return r.result?.value
}

// 1. 点「轨迹」tab
const clicked = await evalJs(`(() => {
  const els = [...document.querySelectorAll('button, [role="tab"], a, span, div')]
    .filter(el => el.textContent?.trim() === '轨迹')
  els.at(-1)?.click()
  return els.length
})()`)
console.log('轨迹 tab 候选数:', clicked)
await new Promise(r => setTimeout(r, 1500))

// 2. 抓轨迹全文中 webpage_execute / Runtime.evaluate 相关行
const text = await evalJs('document.body.innerText')
const lines = String(text ?? '').split('\n')
const hits = []
for (let i = 0; i < lines.length; i++) {
  if (/webpage_execute|Runtime\.evaluate|session_id=/.test(lines[i])) {
    hits.push(lines.slice(i, i + 6).join('\n'))
    i += 6
  }
}
console.log('命中行组数:', hits.length)
// 只看最后两个 execute 相关组（c3 与 c7）
for (const h of hits.slice(-4)) {
  console.log('======')
  console.log(h.slice(0, 800))
}
socket.close()
