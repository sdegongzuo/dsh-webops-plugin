#!/usr/bin/env node
// 只读：切「轨迹」抓 c3 execute / c4 find / 打开的详情 URL。
import { writeFileSync } from 'node:fs'
import { fetchLoopback } from './loopback.mjs'

const PORT = process.env.RENDERER_PORT ?? 9222
const pages = await (await fetchLoopback(PORT, '/json/list')).json()
writeFileSync('scripts/.last-cdp-targets.json', JSON.stringify(pages.map(p => ({
  type: p.type, title: p.title, url: p.url, ws: Boolean(p.webSocketDebuggerUrl),
})), null, 2))

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
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}

await evalJs(`(() => {
  const els = [...document.querySelectorAll('button, [role="tab"], a, span, div')]
    .filter(el => el.textContent?.trim() === '轨迹')
  els.at(-1)?.click()
  return els.length
})()`)
await new Promise(r => setTimeout(r, 1500))

const text = String(await evalJs('document.body.innerText') ?? '')
writeFileSync('scripts/.last-fulltext.txt', text)
console.log('targets:', pages.length, 'fulltext:', text.length)

const fifthJson = text.match(/\{"fifth":[\s\S]{0,2500}?\}/)
console.log('--- fifth JSON ---')
console.log(fifthJson ? fifthJson[0].slice(0, 2000) : '(none)')

const findIdx = text.indexOf('match(es)')
console.log('--- find ---')
console.log(findIdx >= 0 ? text.slice(Math.max(0, findIdx - 80), findIdx + 800) : '(none)')

const clickIdx = text.indexOf('click done')
console.log('--- click ---')
console.log(clickIdx >= 0 ? text.slice(clickIdx, clickIdx + 200) : '(none)')

const t2 = text.match(/session_id=t2[^\n]{0,400}/)
console.log('--- t2 ---')
console.log(t2 ? t2[0] : '(none)')
socket.close()
