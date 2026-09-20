#!/usr/bin/env node
// 只读：连 renderer，点击「轨迹」视图后抓取 webpage_execute 行的返回文本，
// 验证新版 HOTSEARCH_EXPRESSION 抽到的 fifth 是否真是榜单序号 5。
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

const { result } = await call('Runtime.evaluate', {
  expression: `(() => {
    // 不切视图，直接在全文里搜 fifth/list 痕迹（卡片组 + 轨迹都在 DOM 里）
    const all = document.body.innerText
    return all
  })()`,
  returnByValue: true,
})
const text = String(result?.value ?? '')
writeFileSync('scripts/.last-fulltext.txt', text)
console.log('全文长度:', text.length)

// 找 execute 返回的 JSON
const m = text.match(/\{\\?"fifth\\?"[\s\S]{0,1200}?\}/)
if (m) {
  console.log('--- execute 返回 ---')
  console.log(m[0].slice(0, 1200))
} else {
  const i = text.indexOf('fifth')
  console.log('未找到 fifth JSON，附近文本：')
  console.log(i >= 0 ? text.slice(Math.max(0, i - 300), i + 900) : text.slice(-1500))
}
socket.close()
