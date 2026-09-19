/**
 * `Page.navigatedWithinDocument` 覆盖面探针（真机，无头 Chrome）。
 *
 * ## 为什么需要它（方案 §6.3 挂着的那条 `[ ]` 未实测）
 *
 * P2 的 §6.2 ① 要按**三种来源**给「页面变过」分桶：`Page.frameNavigated`（真导航）/
 * `Page.navigatedWithinDocument`（同文档软导航）/ takeover 窗口。其中第二个桶的**覆盖面是未知的**：
 * CDP 文档只承诺它在「same-document navigation」时发，但**哪些 JS 手段算**没写清 ——
 * `history.pushState` / `history.replaceState` / 改 `location.hash` 三者是不是都算？
 * 方案 §6.3 原话：「落地前要用 live 组验一次，**别照 CDP 文档的承诺写进回执文案**」。
 *
 * 没验就写文案的代价很具体：如果 `replaceState` 根本不发事件，那么**改了历史记录却没换文档**
 * 这一类（tab 切换常用它）就会静默漏掉，而回执却对模型宣称「页面没变过」——
 * 一个**说反了**的信号比没有信号更糟（§6.3 已为同类问题写过一次：自相矛盾的提示比没有提示更糟）。
 *
 * ## 判据
 *
 * 对每个动作，记录三个事件**有没有到**：`Page.frameNavigated` / `Page.navigatedWithinDocument` /
 * `Page.loadEventFired`。四个动作的期望形态（**先写下来，再看实测对不对**）：
 *
 * | 动作 | 期望 |
 * |---|---|
 * | `pushState` | withinDocument ✅ / frameNavigated ❌ |
 * | `replaceState` | **未知 —— 这正是要测的** |
 * | 改 `location.hash` | withinDocument ✅ / frameNavigated ❌ |
 * | 真导航（`location.href=` 另一个路径） | frameNavigated ✅ + loadEventFired ✅ |
 *
 * 真导航那一行是**反向验证**：它必须与前三行形态不同，否则说明探针根本没在听事件
 * （「全都没发」这种结果，既可能是真的，也可能是监听没装上 —— 必须能区分）。
 *
 * ## 跑法
 *
 *   "<真 Chrome>" --headless=new --remote-debugging-port=9446 \
 *     --user-data-dir=<工作区外的一次性目录> about:blank &
 *   DSH_CDP_ENDPOINT=http://127.0.0.1:9446 node node_modules/tsx/dist/cli.mjs \
 *     scripts/probe-within-document.ts
 *
 * ⚠️ 与 `probe-gate-live.ts` 同一个坑：本机 9222/9333 常年被桌面端 Electron 占着，
 * 它 `/json/version` 同样回 200 却**不实现** `PUT /json/new` —— 别把那种端点当真 Chrome。
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

const FIXTURE_HTML = `<!doctype html>
<html lang="zh">
  <head><meta charset="utf-8"><title>within-document fixture</title></head>
  <body>
    <h1>软导航夹具</h1>
    <p id="mark">就绪</p>
    <script>
      window.__push = () => { document.getElementById('mark').textContent = 'pushed'; history.pushState({n:1}, '', '/pushed'); };
      window.__replace = () => { document.getElementById('mark').textContent = 'replaced'; history.replaceState({n:2}, '', '/replaced'); };
      window.__hash = () => { location.hash = '#section-1'; };
      window.__hard = () => { location.href = '/hard-navigation'; };
    </script>
  </body>
</html>
`

/** 一条入站 CDP 事件。 */
interface Wire {
  readonly method: string
  readonly params?: { frame?: { url?: string }; url?: string }
}

/** 记事件、也能发命令的旁路连接（与 provider 各自一条 session，互不干扰）。 */
class SideChannel {
  private readonly socket: WebSocket
  private readonly events: Wire[] = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data)) as Wire & { id?: number }
      if (typeof msg.id === 'number') return // 命令回执不是事件
      if (typeof msg.method === 'string') this.events.push(msg)
    })
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

  /** 发命令并等它自己的回执（**不是**等事件）。 */
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = Math.floor(Math.random() * 1e9)
    return await new Promise<unknown>((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } }
        if (msg.id !== id) return
        this.socket.removeEventListener('message', onMessage)
        if (msg.error !== undefined) reject(new Error(msg.error.message ?? 'CDP 错误'))
        else resolve(msg.result)
      }
      this.socket.addEventListener('message', onMessage)
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        this.socket.removeEventListener('message', onMessage)
        reject(new Error(`${method} 超时`))
      }, 5000)
    })
  }

  /** 取走某个时间点之后累积的事件（消费型，避免上一动作的事件混进下一动作）。 */
  drain(): Wire[] {
    const taken = [...this.events]
    this.events.length = 0
    return taken
  }

  close(): void {
    this.socket.close()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

const FLAGS = ['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.loadEventFired'] as const

/** 一个动作的结果：三个事件各自有没有到。 */
interface Row {
  readonly action: string
  readonly fired: Record<string, boolean>
  readonly urls: string[]
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
  const rows: Row[] = []
  let side: SideChannel | undefined

  try {
    const session = await provider.open({ url: baseUrl })
    const pageUrl = session.url ?? baseUrl
    side = await SideChannel.attach(pageUrl)
    // Page 域**必须**先 enable，否则一个事件都收不到 —— 而「一个事件都收不到」正是本探针的观测面，
    // 漏了这一步会把「没在听」误读成「不发事件」。真导航那一行的反向验证就是防这个。
    await side.send('Page.enable')
    await side.send('Runtime.enable')
    await delay(300)
    side.drain() // 丢掉 enable 时的存量事件

    const drive = async (action: string, expression: string, settleMs = 900): Promise<void> => {
      await side!.send('Runtime.evaluate', { expression, returnByValue: true })
      await delay(settleMs)
      const events = side!.drain()
      const fired: Record<string, boolean> = {}
      for (const flag of FLAGS) fired[flag] = events.some(event => event.method === flag)
      const urls = events
        .filter(event => event.method === 'Page.frameNavigated' || event.method === 'Page.navigatedWithinDocument')
        .map(event => `${event.method.replace('Page.', '')}:${event.params?.frame?.url ?? event.params?.url ?? '?'}`)
      rows.push({ action, fired, urls })
      console.log(`  ${action.padEnd(26)} 事件${events.length} 条  ` +
        FLAGS.map(flag => `${flag.replace('Page.', '')}=${fired[flag] ? '✅' : '❌'}`).join('  ')
        + (urls.length > 0 ? `\n${' '.repeat(30)}${urls.join('\n' + ' '.repeat(30))}` : ''))
    }

    console.log(`\n=== Page.navigatedWithinDocument 覆盖面（真机 ${ENDPOINT}）===`)
    await drive('history.pushState', 'window.__push()')
    await drive('history.replaceState', 'window.__replace()')
    await drive('location.hash = ...', 'window.__hash()')
    // 反向验证：真导航必须与上面三行**形态不同**，否则「全都没发」分不清是被测行为还是监听没装上。
    await drive('真导航（location.href）', 'window.__hard()', 1500)
  } catch (error: unknown) {
    console.log(`\nFAIL 探针本身出错：${error instanceof Error ? error.message : String(error)}`)
  }
  side?.close()
  await provider.dispose().catch(() => undefined)
  await server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => { resolve() }))

  // ---------- 判据 ----------
  console.log('\n=== 读数与判据 ===')
  const byAction = new Map(rows.map(row => [row.action, row]))
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const hard = rows.find(row => row.action.startsWith('真导航'))
  checks.push({
    name: '反向验证：真导航必须发 frameNavigated（否则探针没在听事件）',
    ok: hard?.fired['Page.frameNavigated'] === true,
    detail: hard === undefined ? '这一行没跑' : `frameNavigated=${String(hard.fired['Page.frameNavigated'])}`,
  })
  for (const action of ['history.pushState', 'history.replaceState', 'location.hash = ...']) {
    const row = byAction.get(action)
    checks.push({
      name: `${action} 是否发 navigatedWithinDocument`,
      ok: row?.fired['Page.navigatedWithinDocument'] === true,
      detail: row === undefined ? '这一行没跑' : `withinDocument=${String(row.fired['Page.navigatedWithinDocument'])}`,
    })
  }
  for (const check_ of checks) console.log(`${check_.ok ? 'PASS' : 'FAIL'} ${check_.name} —— ${check_.detail}`)

  const missing = checks.filter(check_ => !check_.ok)
  if (missing.length > 0) {
    console.log('\n⚠️ 有动作**没有**产生 navigatedWithinDocument。这不是「探针坏了」——'
      + '反向验证那一行绿着就说明监听是好的。它意味着 §6.2 ① 的 `withinDocument` 桶'
      + '**盖不住**这些手段，回执文案不许对模型宣称「页面没变过」；'
      + '要么把它们计入别的桶，要么在文案里留出不确定度。**别照 CDP 文档的承诺写。**')
  } else {
    console.log('\n✅ 三种软导航手段都发 navigatedWithinDocument —— §6.2 ① 的 `withinDocument` 桶可用，'
      + '文案可以按「同文档软导航」写。')
  }
  process.exit(0)
}

await main().catch((error: unknown) => {
  console.error('探针本身跑崩了：', error)
  process.exit(1)
})
