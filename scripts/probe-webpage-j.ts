/**
 * webpage 交互改进的真机判据探针：拿**真 Chrome**把方案 §2 的 J1 / J4 / J6 与 B2-d 跑一遍。
 *
 * ## 它和 `probe-b0-gate.ts` 的分工
 *
 * B0 是**决策**夹具（决定 B1-b / B1-c 做不做）；本脚本是**验收**夹具：代码落地之后，
 * 判据必须在真浏览器上真的转绿。两者都用 `DSH_CDP_ENDPOINT` 指向一台能开标签页的真 Chrome。
 *
 * ## 覆盖与不覆盖
 *
 * | 判据 | 本脚本 | 理由 |
 * |---|---|---|
 * | J1 遮挡回执 / 拿掉遮罩后能跳 | ✅ | 纯 provider 行为，夹具能表达 |
 * | J2 fill 提交值 | ✅（B0-2 已坐实） | 本轮不重复跑 |
 * | J3 旧 ref → `BROWSER_STALE_REF` | ✅（`probe-stale-node.ts`） | 已有探针 |
 * | J4 `history=back` | ✅ | 真 Chrome 的历史栈是真的 |
 * | J5 回执文案 | 单测锁 | 文案不需要浏览器 |
 * | J6 scroll 3s 内返回 | ✅ | 必须在真浏览器上量时间 |
 * | B2-d snapshot 顶部 OVERLAY | ✅ | 命中测试只有真浏览器有 |
 * | B2-e 截断 find | 单测锁 | tool 层零状态逻辑 |
 *
 * **不覆盖**：模型侧的端到端（场景 A/B/C 里「模型会不会按回执走」）—— 那需要 GUI 会话 +
 * 真实 LLM，本脚本不冒充它。
 *
 * ## 跑法
 *
 *   "<真 Chrome>" --headless=new --remote-debugging-port=9444 \
 *     --user-data-dir=<工作区外的一次性目录> about:blank &
 *   DSH_CDP_ENDPOINT=http://127.0.0.1:9444 node node_modules/tsx/dist/cli.mjs scripts/probe-webpage-j.ts
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

/** 正文里一条直链 + 一层可摘掉的 fixed 遮罩（`?overlay=1` 时挂上）。 */
function pageJ1(overlay: boolean): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>j1 ${overlay ? 'with overlay' : 'clean'}</title></head>
<body>
  <h1>J1</h1>
  <p>正文</p>
  <a id="deeplink" href="/dest">正文里的外链</a>
  ${overlay
    ? '<div id="veil" style="position:fixed;left:0;top:0;width:100%;height:100%;z-index:9999;background:rgba(0,0,0,.5)">'
      + '<span>登录后查看</span></div>'
    : ''}
</body></html>`
}

/** 长文页（J6）：300 段，保证真的有得滚。 */
function pageLong(label: string): string {
  const body = Array.from({ length: 300 }, (_unused, index) => `<p>${label} 第 ${index + 1} 段</p>`).join('\n')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${label}</title></head>
<body><h1>${label}</h1>${body}</body></html>`
}

const PAGE_P1 = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>P1</title></head>'
  + '<body><h1>P1</h1><a href="/p2">去 P2</a></body></html>'
const PAGE_P2 = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>P2</title></head>'
  + '<body><h1>P2</h1><a href="/p1">回 P1</a></body></html>'
const LANDED = (path: string): string =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>landed</title></head>`
  + `<body><h1>landed ${path}</h1></body></html>`

const results: { name: string; ok: boolean }[] = []

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} —— ${detail}`)
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
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const html = path === '/j1'
      ? pageJ1(url.searchParams.get('overlay') === '1')
      : path === '/long'
        ? pageLong('长文页')
        : path === '/other'
          ? pageLong('另一个站点')
          : path === '/p1'
            ? PAGE_P1
            : path === '/p2'
              ? PAGE_P2
              : LANDED(path)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${String(port)}`

  const provider = new CdpBrowserProvider({ endpoint: ENDPOINT })

  try {
    // ───────────── J1：遮罩盖住链接 ─────────────
    {
      const url = `${base}/j1?overlay=1`
      const session = await provider.open({ url })
      const side = await SideChannel.attach(session.url ?? url)
      const shot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (shot.kind !== 'snapshot') throw new Error('J1：期望 snapshot')
      const ref = shot.refs.find(entry => entry.role === 'link' && entry.name === '正文里的外链')?.ref
      if (ref === undefined) throw new Error('J1：快照里没有那条外链')

      const result = await provider.mutate({ kind: 'click', sessionId: session.id, ref })
      const occluded = result.occluded_by
      console.log(`OBS  J1：click 回执 occluded_by=${JSON.stringify(occluded ?? null)}；`
        + `navigated=${String(result.navigated)}；target=${JSON.stringify(result.target ?? null)}`)
      check('J1-a：遮罩盖住链接时，回执带 occluded_by（不再是「click done 然后什么都不说」）',
        occluded !== undefined
        && result.navigated === false
        && result.openedTabs === undefined,
        `occluded_by=${JSON.stringify(occluded ?? null)} navigated=${String(result.navigated)}`)

      // 拿掉遮罩再点：必须真的跳走。
      await side.evaluate('document.getElementById("veil").remove()')
      await delay(100)
      const shot2 = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (shot2.kind !== 'snapshot') throw new Error('J1：第二次期望 snapshot')
      const ref2 = shot2.refs.find(entry => entry.role === 'link' && entry.name === '正文里的外链')?.ref
      if (ref2 === undefined) throw new Error('J1：拿掉遮罩后快照里没有那条外链')
      const again = await provider.mutate({ kind: 'click', sessionId: session.id, ref: ref2 })
      const landed = String(await side.evaluate('location.pathname'))
      console.log(`OBS  J1：拿掉遮罩后 click → navigated=${String(again.navigated)}；location=${landed}`)
      check('J1-b：拿掉遮罩后同一条链接真能跳（/dest）',
        again.navigated === true && landed === '/dest',
        `navigated=${String(again.navigated)} location=${landed}`)
      side.close()
    }

    // ───────────── B2-d：小 max_lines 也要看见 OVERLAY ─────────────
    {
      const url = `${base}/j1?overlay=1`
      const session = await provider.open({ url })
      const side = await SideChannel.attach(session.url ?? url)
      const shot = await provider.observe({ kind: 'snapshot', sessionId: session.id, maxLines: 60 })
      if (shot.kind !== 'snapshot') throw new Error('B2-d：期望 snapshot')
      const first = shot.outline.split('\n')[0] ?? ''
      console.log(`OBS  B2-d：max_lines=60 的首行=${first}`)
      check('B2-d：浮层在时，即使 max_lines=60，第一屏就有 OVERLAY',
        first.includes('OVERLAY at viewport center'), first)

      await side.evaluate('document.getElementById("veil").remove()')
      await delay(100)
      const clean = await provider.observe({ kind: 'snapshot', sessionId: session.id, maxLines: 60 })
      if (clean.kind !== 'snapshot') throw new Error('B2-d：期望 snapshot')
      const cleanFirst = clean.outline.split('\n')[0] ?? ''
      check('B2-d 反向：关掉浮层后 OVERLAY 行消失（不误报）',
        !cleanFirst.includes('OVERLAY'), cleanFirst)
      side.close()
    }

    // ───────────── J6：scroll 不许把工具拖到 30s ─────────────
    for (const [label, path] of [['长文页', '/long'], ['另一个站点', '/other']] as const) {
      const url = `${base}${path}`
      const session = await provider.open({ url })
      const started = Date.now()
      const result = await provider.mutate({ kind: 'scroll', sessionId: session.id, deltaY: 300 })
      const elapsed = Date.now() - started
      console.log(`OBS  J6 ${label}：scroll 用了 ${elapsed}ms；unconfirmed=${String(result.unconfirmed ?? false)}`)
      check(`J6：${label} 的 scroll 3s 内返回（禁止 tool call timed out after 30000ms）`,
        elapsed < 3_000, `${elapsed}ms`)
    }

    // ───────────── J4：navigate(history=back) ─────────────
    {
      const session = await provider.open({ url: `${base}/p1` })
      const side = await SideChannel.attach(session.url ?? `${base}/p1`)
      const shot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (shot.kind !== 'snapshot') throw new Error('J4：期望 snapshot')
      const ref = shot.refs.find(entry => entry.role === 'link' && entry.name === '去 P2')?.ref
      if (ref === undefined) throw new Error('J4：快照里没有「去 P2」')
      await provider.mutate({ kind: 'click', sessionId: session.id, ref })
      const atP2 = String(await side.evaluate('location.pathname'))
      const back = await provider.navigate({ sessionId: session.id, history: 'back' })
      console.log(`OBS  J4：点进 ${atP2} → history=back → ${back.url}`)
      check('J4：history=back 真的回到上一页（不用 webpage_execute）',
        atP2 === '/p2' && back.url.endsWith('/p1'), `click→${atP2}，back→${back.url}`)
      side.close()
    }
  } catch (error: unknown) {
    const crashed = shape(error)
    check('探针全程无异常', false, `${crashed.code} / ${crashed.message}`)
  }

  await provider.dispose().catch(() => undefined)
  await server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => { resolve() }))

  const failed = results.filter(entry => !entry.ok)
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main().catch((error: unknown) => {
  console.error('探针本身跑崩了：', error)
  process.exit(1)
})
