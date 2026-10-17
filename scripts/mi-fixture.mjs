#!/usr/bin/env node
/**
 * 多实例对话验收用的**本地夹具服务**（方案 §5「真实对话」的服务端账本）。
 *
 * 与 `.probe-chat-fixture.mjs`（历史一次性探针）的分工：那个管页面形状，这个管
 * **归属判定** —— 每个浏览器 profile 首次访问发一个持久 Cookie `mi-client`，
 * 服务端账本按 `who + client` 记账：
 *   · A/B 若共用同一份浏览器 profile，两条记录的 client 会相同 → 串实例立刻可见；
 *   · A 退出重启后再访问，client 不变 → 持久 Cookie 按实例保留可证。
 *
 * 路径：
 *   /            夹具首页（链接 + 锚点 + 只换 query 的链接）
 *   /race?who=X  竞技页：提交按钮 + 输入框回车，两条路都记账
 *   /record      POST 记账（kind=click|enter），发/续 Cookie，返回本 who 累计次数
 *   /log         账本 JSON（驱动脚本做判定）
 *   /reset       POST 清空账本（每轮验收前调一次）
 *
 * 用法：`node scripts/mi-fixture.mjs [--port 9788]`（前台运行，后台任务里起）。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const at = process.argv.indexOf('--port')
const PORT = Number(at === -1 ? process.env.FIXTURE_PORT ?? 9788 : process.argv[at + 1])
const HOST = '127.0.0.1'
const COOKIE = 'mi-client'

const page = (title, body) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>
${body}
</body></html>`

const RACE = (who) => page(`多实例竞技页 ${who}`, `
<p>这是实例 <strong>${who}</strong> 的竞技页。点「提交」按钮，或在输入框写字后按回车。</p>
<button id="submit" type="button" style="font-size:18px;padding:8px 20px">提交（${who}）</button>
<p><input id="q" type="text" placeholder="在这里输入，然后按回车" style="font-size:15px;padding:4px"></p>
<p id="result" aria-live="polite"></p>
<script>
const who = ${JSON.stringify(who)}
const say = (text) => { document.getElementById('result').textContent = text }
document.getElementById('submit').addEventListener('click', async () => {
  const r = await fetch('/record?who=' + encodeURIComponent(who) + '&kind=click', { method: 'POST' })
  say('按钮已提交，本页累计 ' + (await r.json()).count + ' 次')
})
document.getElementById('q').addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return
  const r = await fetch('/record?who=' + encodeURIComponent(who) + '&kind=enter', { method: 'POST' })
  say('回车已提交，本页累计 ' + (await r.json()).count + ' 次')
})
</script>
`)

const eventLog = []
const safeWho = (who) => /^[A-Za-z0-9_-]{1,16}$/u.test(who ?? '') ? who : undefined
const clientOf = (request) => {
  const cookie = String(request.headers.cookie ?? '')
  const match = new RegExp(`(?:^|; )${COOKIE}=([^;]+)`).exec(cookie)
  return match === null ? undefined : match[1]
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${String(PORT)}`)
  const path = url.pathname
  const setClientCookie = (client) => {
    response.setHeader('set-cookie', `${COOKIE}=${client}; Path=/; Max-Age=31536000; SameSite=Lax`)
  }

  if (path === '/record' && request.method === 'POST') {
    const who = safeWho(url.searchParams.get('who'))
    const kind = url.searchParams.get('kind') === 'enter' ? 'enter' : 'click'
    if (who === undefined) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'bad who' }))
      return
    }
    let client = clientOf(request)
    if (client === undefined) {
      client = randomUUID()
      setClientCookie(client)
    }
    eventLog.push({ who, kind, client, at: Date.now() })
    const count = eventLog.filter((entry) => entry.who === who).length
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, count, client }))
    return
  }
  if (path === '/log') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(eventLog))
    return
  }
  if (path === '/reset' && request.method === 'POST') {
    eventLog.length = 0
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  if (path === '/race') {
    const who = safeWho(url.searchParams.get('who'))
    if (who === undefined) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page('400', '<p>/race 需要 ?who=A（字母数字，1-16 位）</p>'))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(RACE(who))
    return
  }
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page('多实例验收夹具', '<p><a href="/race?who=A">竞技页 A</a> · <a href="/race?who=B">竞技页 B</a></p>'))
    return
  }
  response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page('404', `<p>没有这条路径：${path}</p>`))
}).listen(PORT, HOST, () => {
  console.log(`多实例夹具已起：http://${HOST}:${String(PORT)}/`)
  console.log(`  竞技页 http://${HOST}:${String(PORT)}/race?who=A`)
  console.log(`  账本   http://${HOST}:${String(PORT)}/log   重置 POST /reset`)
})
