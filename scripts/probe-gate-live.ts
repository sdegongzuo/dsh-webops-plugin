/**
 * 真机门探针：对着**真 Chrome** 验写前门（方案 §5.1 的 J1 / J2），非常驻自检。
 *
 * 为什么需要它：`provider.test.ts` 那批用例全跑在 fake-CDP 上，「真机上门到底拦不拦」这件事
 * 只能由真浏览器回答。这里刻意走**旁路**改页面（自己开一条 WebSocket 发 `Runtime.evaluate`，
 * 不经过 provider），因为「人工在两轮之间动了页面」的本质就是**插件不参与**。
 * 判据不止「报了 stale」：还要读回页面里的 `__clicked` 计数器，证明**动作真的没落到页面上**。
 *
 * 跑法（端点必须是一台**能开标签页的真 Chrome**，先自己起一个）：
 *   "<真 Chrome>" --headless=new --remote-debugging-port=9444 \
 *     --user-data-dir=<工作区外的一次性目录> about:blank &
 *   DSH_CDP_ENDPOINT=http://127.0.0.1:9444 node node_modules/tsx/dist/cli.mjs scripts/probe-gate-live.ts
 *
 * ⚠️ **不给端点默认值**：本机 9222/9333 常年被桌面端 Electron 占着，它同样会 `/json/version` 200
 * 却不实现 `PUT /json/new` —— 拿它当端点，这组会带着假前提跑出一个看着可信、其实无意义的结论。
 * 与 `live.test.ts` 的「认不出真 Chrome 就跳过」是同一个坑的两种表现：**别把 skip 当绿**。
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CdpBrowserProvider } from '../src/browser-cdp/provider.ts'
import { validateEndpoint } from '../src/browser-cdp/url-policy.ts'

const rawEndpoint = process.env['DSH_CDP_ENDPOINT']
if (rawEndpoint === undefined || rawEndpoint.length === 0) {
  console.error('缺 DSH_CDP_ENDPOINT：指向一台能开标签页的真 Chrome，例如 '
    + 'DSH_CDP_ENDPOINT=http://127.0.0.1:9444 node scripts/probe-gate-live.ts（见文件头）')
  process.exit(1)
}
const ENDPOINT = validateEndpoint(rawEndpoint)

const FIXTURE_HTML = `<!doctype html>
<html lang="zh">
  <head><meta charset="utf-8"><title>gate fixture</title></head>
  <body>
    <h1>门探针夹具</h1>
    <button id="submit" type="button">提交</button>
    <script>
      window.__clicked = 0;
      window.__node = document.getElementById('submit');
      window.__node.addEventListener('click', () => { window.__clicked += 1; });
      // 模拟「人工动了一下」的两条旁路：换路由 / 把节点摘掉。
      window.__spa = () => history.pushState({}, '', '/after-human-nav');
      window.__detach = () => window.__node.remove();
    </script>
  </body>
</html>
`

const results: { name: string; ok: boolean; detail: string }[] = []

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} —— ${detail}`)
}

/** 不经 provider 的 CDP 通道：读页面里的真实状态 / 触发「人工操作」。 */
class SideChannel {
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
  }

  static async attach(targetUrl: string): Promise<SideChannel> {
    const list = (await fetch(`${ENDPOINT}/json/list`).then(r => r.json())) as {
      type: string
      url: string
      webSocketDebuggerUrl?: string
    }[]
    const target = list.find(entry => entry.type === 'page' && entry.url === targetUrl)
    if (target?.webSocketDebuggerUrl === undefined) {
      throw new Error(`找不到 target：${targetUrl}（当前列表：${list.map(e => e.url).join(', ')}）`)
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('旁路 WebSocket 连不上')), { once: true })
    })
    return new SideChannel(socket)
  }

  async evaluate(expression: string): Promise<unknown> {
    const id = Math.floor(Math.random() * 1e9)
    return new Promise<unknown>((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        const msg = JSON.parse(String(event.data)) as {
          id?: number
          result?: { result?: { value?: unknown } }
          error?: { message?: string }
        }
        if (msg.id !== id) return
        this.socket.removeEventListener('message', onMessage)
        if (msg.error !== undefined) reject(new Error(msg.error.message ?? 'CDP 错误'))
        else resolve(msg.result?.result?.value)
      }
      this.socket.addEventListener('message', onMessage)
      this.socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

/** 把错误摊开成「code + message」，判据按 code 判，别去正则匹配 `String(error)`。 */
function shape(error: unknown): { code: string; message: string } {
  const e = error as { code?: unknown; message?: unknown } | undefined
  return {
    code: typeof e?.code === 'string' ? e.code : '',
    message: typeof e?.message === 'string' ? e.message : String(error ?? ''),
  }
}

async function main(): Promise<void> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${String(port)}/`

  const provider = new CdpBrowserProvider({ endpoint: ENDPOINT })
  let side: SideChannel | undefined

  try {
    const session = await provider.open({ url: baseUrl })
    const pageUrl = session.url ?? baseUrl
    side = await SideChannel.attach(pageUrl)

    // 基线：证明「真点下去会命中」，否则后面「没命中」证明不了任何事。
    const first = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (first.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref = first.refs.find(entry => entry.role === 'button')?.ref
    if (ref === undefined) throw new Error('快照里没有按钮 ref，夹具或真实 AX 树对不上')

    await provider.mutate({ kind: 'click', sessionId: session.id, ref })
    const clickedBaseline = await side.evaluate('window.__clicked')
    check('基线：未被拦的点击真的落到页面上', clickedBaseline === 1,
      `__clicked=${String(clickedBaseline)}（应为 1）`)

    // —— 粗门：人工换了 SPA 路由，地址变了、文档没换 ——
    await side.evaluate('window.__spa()')
    const coarse = await provider.mutate({ kind: 'click', sessionId: session.id, ref })
      .then(() => undefined)
      .catch((error: unknown) => error)
    const clickedAfterCoarse = await side.evaluate('window.__clicked')
    const coarseShape = shape(coarse)
    check('粗门拦下人工改路由后的点击',
      coarseShape.code === 'BROWSER_STALE_REF' && /stale document/.test(coarseShape.message),
      `${coarseShape.code} / ${coarseShape.message}`)
    check('J1 动作未发出（粗门）', clickedAfterCoarse === 1,
      `__clicked=${String(clickedAfterCoarse)}（应仍是 1）`)

    // 门作废纪元之后，重拍 + 点同一处必须能成功（否则「拦下」等于「永久点不动」= 违 J2）。
    const second = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (second.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref2 = second.refs.find(entry => entry.role === 'button')?.ref
    if (ref2 === undefined) throw new Error('重拍后找不到按钮')
    await provider.mutate({ kind: 'click', sessionId: session.id, ref: ref2 })
    const clickedAfterResnapshot = await side.evaluate('window.__clicked')
    check('J2 重拍后同一处照样点得动', clickedAfterResnapshot === 2,
      `__clicked=${String(clickedAfterResnapshot)}（应为 2）`)

    // —— 细门：地址不变、节点被摘掉 ——
    const third = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (third.kind !== 'snapshot') throw new Error('expected a snapshot')
    const ref3 = third.refs.find(entry => entry.role === 'button')?.ref
    if (ref3 === undefined) throw new Error('快照里找不到按钮')
    await side.evaluate('window.__detach()')
    const fine = await provider.mutate({ kind: 'click', sessionId: session.id, ref: ref3 })
      .then(() => undefined)
      .catch((error: unknown) => error)
    // 读的是「节点还找得到吗」的**反面**：true = 确实已被摘掉。
    const detached = await side.evaluate('document.getElementById("submit") === null')
    const clickedAfterFine = await side.evaluate('window.__clicked')
    const fineShape = shape(fine)
    // 注意分辨是哪一道门报的：门还没跑就被 `DOM.resolveNode` 兜住，话术是
    // "no longer attached to the document"，门的细门话术是 "was removed from the document"。
    check('细门拦下节点被摘掉后的点击',
      fineShape.code === 'BROWSER_STALE_REF' && /was removed from the document/.test(fineShape.message),
      `${fineShape.code} / ${fineShape.message}（节点确实已摘：${String(detached)}）`)
    check('J1 动作未发出（细门）', clickedAfterFine === 2,
      `__clicked=${String(clickedAfterFine)}（应仍是 2）`)
  } catch (error: unknown) {
    // 探针自己被异常掀掉也要成为一项结论 —— 沉默的崩溃不等于通过。
    const crashed = shape(error)
    check('门用例全程无异常', false, `${crashed.code} / ${crashed.message}`)
  }
  side?.close()
  // dispose 恒报一项：**只在失败时才打印等于「没结论」**，静默通过和静默没跑长得一样。
  // 判据两半：dispose 不抛，且标签页真的没了（旧缺陷里标签页本来也是关掉的，
  // 只查后者会把假红修成假绿）。
  {
    let disposeError: unknown
    try {
      await provider.dispose()
    } catch (error: unknown) {
      disposeError = error
    }
    const leftover = await fetch(`${ENDPOINT}/json/list`)
      .then(response => response.json())
      .then((body: unknown) => (body as { url?: string }[]).filter(entry => entry.url?.startsWith(baseUrl) === true))
      .catch(() => undefined)
    const shapeResult = shape(disposeError ?? new Error(''))
    check('dispose 干净：不抛错且标签页已回收',
      disposeError === undefined && leftover !== undefined && leftover.length === 0,
      disposeError === undefined
        ? `无错 / 该夹具的 target 剩 ${String(leftover?.length ?? -1)} 个（应为 0）`
        : `${shapeResult.code} / ${shapeResult.message}`)
  }
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
