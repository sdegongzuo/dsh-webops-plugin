/**
 * B0 夹具探针：决定 `docs/webpage交互改进-实施方案.md` 里 B1-b / B1-c **做不做**。
 *
 * 方案 §4.B0 给了两个夹具，结论没写进文档之前 B1-b / B1-c 不得标完成。本脚本就是那两个夹具，
 * 输出直接可抄进文档（每条结论打印成一行 `结论：…`）。
 *
 * ## B0-1（决定 B1-b：click 要不要补 mouseMoved 的完整鼠标序列）
 *
 * 夹具是一个 **mousedown 时才改写 href** 的链接：
 *
 *     <a href="/goto?url=placeholder" onmousedown="this.href='/dest'">…</a>
 *
 * 现在的 `click` 只发 `mousePressed` + `mouseReleased`。若浏览器仍按改写后的 href 导航 →
 * 结果 `/dest` → **B1-b 不做**（删掉）。若导航到改写前的 `/goto?url=placeholder` → **做 B1-b**。
 *
 * ## B0-2（决定 B1-c：fill 要不要 focus + `Input.insertText`）
 *
 * 两问，都要答：
 *
 * 1. fill 之后页面收到的 `input` 事件 `isTrusted` 是不是 false（不可信 = 站点自己写的
 *    「只认真实输入」逻辑可能不触发，联想/校验不跟着走）。
 * 2. 带**假联想下拉**的搜索框：focus 时高亮第一项，提交时下拉开着就把高亮项写进输入框 ——
 *    提交出去的 `q=` 是否等于填入词。不等于 → **做 B1-c**（且 B3-a 的前置才成立）。
 *
 * ## 跑法（端点必须是一台**能开标签页的真 Chrome**，与 probe-stale-node 同一要求）
 *
 *   "<真 Chrome>" --headless=new --remote-debugging-port=9444 \
 *     --user-data-dir=<工作区外的一次性目录> about:blank &
 *   DSH_CDP_ENDPOINT=http://127.0.0.1:9444 node node_modules/tsx/dist/cli.mjs scripts/probe-b0-gate.ts
 *
 * 只跑一半：`--only=b0-1` / `--only=b0-2`。
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CdpBrowserProvider } from '../src/browser-cdp/provider.ts'
import { validateEndpoint } from '../src/browser-cdp/url-policy.ts'

const rawEndpoint = process.env['DSH_CDP_ENDPOINT']
if (rawEndpoint === undefined || rawEndpoint.length === 0) {
  console.error('缺 DSH_CDP_ENDPOINT：指向一台能开标签页的真 Chrome（见文件头跑法）')
  process.exit(1)
}
const ENDPOINT = validateEndpoint(rawEndpoint)

const ONLY = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length)
if (ONLY !== undefined && ONLY !== 'b0-1' && ONLY !== 'b0-2') {
  console.error(`--only 只认 b0-1 / b0-2，收到：${ONLY}`)
  process.exit(1)
}

/** B0-1：mousedown 改写 href 的链接。 */
const B01_HTML = `<!doctype html>
<html lang="zh">
  <head><meta charset="utf-8"><title>b0-1 rewrite-on-mousedown</title></head>
  <body>
    <h1>B0-1</h1>
    <a id="rewriter" href="/goto?url=placeholder"
       onmousedown="this.href='/dest'">rewrite-on-mousedown</a>
  </body>
</html>
`

/** B0-2：可信输入探针 + 假联想下拉。 */
const B02_HTML = `<!doctype html>
<html lang="zh">
  <head><meta charset="utf-8"><title>b0-2 trusted input + fake suggest</title></head>
  <body>
    <h1>B0-2</h1>
    <form id="form" action="/search" method="get">
      <input id="q" name="q" type="text" autocomplete="off">
      <button id="go" type="submit">搜索</button>
    </form>
    <ul id="suggest" style="display:none"><li>联想项一</li><li>联想项二</li></ul>
    <script>
      window.__inputEvents = []
      window.__suggestOpen = false
      const q = document.getElementById('q')
      const suggest = document.getElementById('suggest')
      q.addEventListener('input', (event) => {
        window.__inputEvents.push({ trusted: event.isTrusted, value: q.value })
      })
      q.addEventListener('focus', () => {
        // 真站点：聚焦即开联想并高亮第一项。
        window.__suggestOpen = true
        suggest.style.display = 'block'
      })
      document.getElementById('form').addEventListener('submit', () => {
        // 真站点：下拉还开着就把高亮项写进输入框 —— 这就是「提交值被联想覆盖」。
        if (window.__suggestOpen) q.value = '联想项一'
      })
    </script>
  </body>
</html>
`

const results: { name: string; ok: boolean }[] = []

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} —— ${detail}`)
}

function conclusion(line: string): void {
  console.log(`\n结论：${line}\n`)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function shape(error: unknown): { code: string; message: string } {
  const e = error as { code?: unknown; message?: unknown } | undefined
  return {
    code: typeof e?.code === 'string' ? e.code : '',
    message: typeof e?.message === 'string' ? e.message : String(error ?? ''),
  }
}

/** 不经 provider 的旁路：改页面、读页面状态。 */
class SideChannel {
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
  }

  static async attach(pageUrl: string): Promise<SideChannel> {
    const list = (await fetch(`${ENDPOINT}/json/list`).then(r => r.json())) as {
      type: string
      url: string
      webSocketDebuggerUrl?: string
    }[]
    const target = list.find(entry => entry.type === 'page' && entry.url === pageUrl)
    if (target?.webSocketDebuggerUrl === undefined) {
      throw new Error(`找不到 target：${pageUrl}（当前列表：${list.map(e => e.url).join(', ')}）`)
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => { resolve() }, { once: true })
      socket.addEventListener('error', () => { reject(new Error('旁路 WebSocket 连不上')) }, { once: true })
    })
    return new SideChannel(socket)
  }

  evaluate(expression: string): Promise<unknown> {
    return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      .then(result => (result as { result?: { value?: unknown } }).result?.value)
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = Math.floor(Math.random() * 1e9)
    return await new Promise<unknown>((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        const msg = JSON.parse(String(event.data)) as {
          id?: number
          result?: unknown
          error?: { code?: number; message?: string }
        }
        if (msg.id !== id) return
        this.socket.removeEventListener('message', onMessage)
        if (msg.error !== undefined) reject(new Error(msg.error.message ?? 'CDP 错误'))
        else resolve(msg.result)
      }
      this.socket.addEventListener('message', onMessage)
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

async function main(): Promise<void> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/b0-1')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(B01_HTML)
      return
    }
    if (url.startsWith('/b0-2')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(B02_HTML)
      return
    }
    // 导航落点：无论 /dest 还是 /goto，都回一页能认出来的东西。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>landed</title></head>
      <body><h1>landed: ${url}</h1></body></html>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${String(port)}`

  const provider = new CdpBrowserProvider({ endpoint: ENDPOINT })

  try {
    // ───────────────────────── B0-1 ─────────────────────────
    if (ONLY === undefined || ONLY === 'b0-1') {
      const url = `${base}/b0-1`
      const session = await provider.open({ url })
      const side = await SideChannel.attach(session.url ?? url)
      const shot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (shot.kind !== 'snapshot') throw new Error('B0-1：期望 snapshot')
      const ref = shot.refs.find(entry => entry.role === 'link' && entry.name === 'rewrite-on-mousedown')?.ref
      if (ref === undefined) {
        throw new Error(`B0-1：快照里没有那个链接（拿到 ${shot.refs.map(e => `${e.role}/${e.name}`).join(', ')}）`)
      }
      const result = await provider.mutate({ kind: 'click', sessionId: session.id, ref })
      // click 的 settle 已经等过一轮；再给导航一点余量。
      await delay(500)
      const path = String(await side.evaluate('location.pathname + location.search'))
      const hrefAfter = String(await side.evaluate(
        '(document.getElementById("rewriter") || {}).href ?? "(节点已随导航消失)"',
      ))
      console.log(`OBS  B0-1：click 后 location=${path}；navigated=${String(result.navigated)}；`
        + `链接 href=${hrefAfter}`)
      const reachedDest = path === '/dest'
      check('B0-1：click 之后落到 /dest',
        reachedDest,
        `location=${path}（${reachedDest ? 'mousedown 改写生效' : '改写没生效，走的是改写前的 href'}）`)
      conclusion(reachedDest
        ? 'B0-1：不成立（已经是 /dest）→ **不做 B1-b**，click 序列保持 mousePressed/mouseReleased。'
        : 'B0-1：成立（没到 /dest）→ **做 B1-b**，click 补 mouseMoved + buttons 的完整序列。')

      await side.send('Target.closeTarget').catch(() => undefined)
      side.close()
      await provider.dispose().catch(() => undefined)
    }

    // ───────────────────────── B0-2 ─────────────────────────
    if (ONLY === undefined || ONLY === 'b0-2') {
      const url = `${base}/b0-2`
      const session = await provider.open({ url })
      const side = await SideChannel.attach(session.url ?? url)
      const shot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (shot.kind !== 'snapshot') throw new Error('B0-2：期望 snapshot')
      const inputRef = shot.refs.find(entry => entry.role === 'textbox')?.ref
      const buttonRef = shot.refs.find(entry => entry.role === 'button')?.ref
      if (inputRef === undefined || buttonRef === undefined) {
        throw new Error(`B0-2：快照里缺输入框或按钮（拿到 ${shot.refs.map(e => `${e.role}/${e.name}`).join(', ')}）`)
      }
      const word = '2026年大语言模型发展趋势'
      await provider.mutate({ kind: 'fill', sessionId: session.id, ref: inputRef, value: word })
      const events = (await side.evaluate('window.__inputEvents')) as { trusted: boolean; value: string }[]
      const valueAfterFill = String(await side.evaluate('document.getElementById("q").value'))
      const focused = String(await side.evaluate('document.activeElement && document.activeElement.id'))
      console.log(`OBS  B0-2：fill 后 input 事件=${JSON.stringify(events)}；`
        + `输入框值=${valueAfterFill}；当前焦点=${focused}`)
      const allUntrusted = events.length > 0 && events.every(entry => entry.trusted === false)
      check('B0-2(1)：fill 只产生**不可信** input 事件',
        allUntrusted,
        `${String(events.length)} 条，trusted=${events.map(e => String(e.trusted)).join(',') || '（无）'}`)
      check('B0-2(1)：值本身写进去了（否则后面提交值的判据没有意义）',
        valueAfterFill === word,
        `输入框值=${valueAfterFill}`)

      // 提交：点搜索按钮（B1-c 未做时这一步可能被联想覆盖）。
      await provider.mutate({ kind: 'click', sessionId: session.id, ref: buttonRef })
      await delay(800)
      const landed = String(await side.evaluate('location.pathname + location.search'))
      const q = new URLSearchParams(landed.includes('?') ? landed.slice(landed.indexOf('?')) : '').get('q')
      console.log(`OBS  B0-2：点搜索后 location=${landed}；q=${String(q)}`)
      const overwritten = q !== null && q !== word
      check('B0-2(2)：提交出去的 q 等于填入词（没被联想覆盖）',
        q === word,
        `q=${String(q)}（填入词=${word}）`)
      // —— 反向验证：夹具本身必须是活的 ——
      // 「提交值没被覆盖」有两种解释：① 联想压根没开（**因为 fill 不 focus**，绕过去了）；
      // ② 夹具坏了，压根不会覆盖。两者结论完全不同，必须分清：这里**手动 focus** 一次
      // （真站点里用户点进输入框就是这个状态）再提交，q 必须被改成联想项，否则夹具是死的。
      await provider.navigate({ sessionId: session.id, url })
      await delay(300)
      const shot2 = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (shot2.kind !== 'snapshot') throw new Error('B0-2 反向验证：期望 snapshot')
      const inputRef2 = shot2.refs.find(entry => entry.role === 'textbox')?.ref
      const buttonRef2 = shot2.refs.find(entry => entry.role === 'button')?.ref
      if (inputRef2 === undefined || buttonRef2 === undefined) {
        throw new Error('B0-2 反向验证：快照里缺输入框或按钮')
      }
      await provider.mutate({ kind: 'fill', sessionId: session.id, ref: inputRef2, value: word })
      await side.evaluate('document.getElementById("q").focus()')
      // ⚠️ 这里有个反直觉的现象，先记下来免得后人误判：evaluate 里 `focus()` 之后
      // `document.activeElement` 立刻就是 `q`，但**同一条 evaluate 之后马上读、隔 200ms 再读**，
      // `window.__suggestOpen` 都是 false；可提交时 handler 看到的却是 true（值确实被覆盖了）。
      // 也就是说旁路读到的状态与页面脚本自己看到的不同步 —— 所以本条的判据只认**提交结果**
      // （`q` 是不是被改写），不认旁路读出来的那个布尔。
      await delay(200)
      const focusState = await side.evaluate(
        '({ active: document.activeElement && document.activeElement.id,'
        + ' open: window.__suggestOpen,'
        + ' shown: document.getElementById("suggest").style.display })',
      )
      await provider.mutate({ kind: 'click', sessionId: session.id, ref: buttonRef2 })
      await delay(800)
      const landed2 = String(await side.evaluate('location.pathname + location.search'))
      const q2 = new URLSearchParams(
        landed2.includes('?') ? landed2.slice(landed2.indexOf('?')) : '',
      ).get('q')
      console.log(`OBS  B0-2 反向验证：focus 后状态=${JSON.stringify(focusState)}；`
        + `提交 q=${String(q2)}（期望「联想项一」）`)
      check('B0-2 反向验证：手动 focus 打开联想后，提交值**确实**会被覆盖（夹具是活的）',
        q2 === '联想项一',
        `q=${String(q2)}`)
      conclusion(allUntrusted && overwritten
        ? 'B0-2：成立（fill 只有不可信事件，且提交值被联想覆盖）→ **做 B1-c**，之后才允许 B3-a。'
        : allUntrusted && !overwritten
          ? 'B0-2：**半成立** —— fill 只有不可信事件，但提交值没被覆盖 → 只做提示词里的 fill+Enter，**不做 insertText**（B1-c 降级）。'
          : 'B0-2：不成立（已有可信输入 / 提交值没被改写）→ **不做 B1-c**。')

      await side.send('Target.closeTarget').catch(() => undefined)
      side.close()
      await provider.dispose().catch(() => undefined)
    }
  } catch (error: unknown) {
    const crashed = shape(error)
    check('探针全程无异常', false, `${crashed.code} / ${crashed.message}`)
  }

  await server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => { resolve() }))

  const failed = results.filter(entry => !entry.ok)
  console.log(`合计 ${String(results.length)} 项断言，失败 ${String(failed.length)} 项`
    + '（断言失败不等于结论错 —— 结论行才是要抄进文档的）')
}

await main().catch((error: unknown) => {
  console.error('探针本身跑崩了：', error)
  process.exit(1)
})
