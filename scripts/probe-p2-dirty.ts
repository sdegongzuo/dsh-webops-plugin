/**
 * P2 跨轮次脏累加器的**真机**走查（方案 §6.2 ①②、§6.3 去重、D-19）。
 *
 * ## 为什么单测不够，非要真机走一遍
 *
 * `provider.test.ts` 里的假 Chrome 是**我说事件会发、它才发**的：夹具里
 * `Page.navigatedWithinDocument` 什么时候来、带什么 `url`，全由我写死。而 P2 这一整条
 * 判据都建立在「事件线上的地址」与「轮询线上读到的地址」是不是**同一个字符串**上 ——
 * 这正是夹具最不可能证伪的一格：真 Chrome 给事件的 `url` 可能归一化（补斜杠、去尾 `#`、
 * 编码 `+` / `%20`），只要差一个字符，去重判据就整条失效，而单测全绿。
 *
 * 所以本探针的观测面是**两条线各报什么**：旁路 WebSocket 自己订阅同一份事件流（与 provider
 * 各自一条 session，互不干扰），于是每一步都能对照「事件线看到了什么」与「回执写了什么」。
 *
 * ## 五个断言（先写下期望，再看实测）
 *
 * | # | 施加者 | 动作 | 期望 |
 * |---|---|---|---|
 * | A | 旁路（= 本会话之外） | `location.href = '/human-page'` | 回执 `pageChanged.navigated ≥ 1`，`route.to` 命中新地址 |
 * | B | —— | 紧接着再拍一次全量快照 | `pageChanged` **缺席**（锚点已前移，同一笔账不许报两遍） |
 * | C | 旁路 | `location.hash = '#human'` | `pageChanged.withinDocument ≥ 1`，且 `navigated` 仍为 0 |
 * | D | 旁路改地址 + **本会话**点一下 | `replaceState` 只换 query，再点一个不导航的按钮 | **同一个变化只进一个桶**：`withinDocument` 有、`addressDrift` 没有 |
 * | D2 | 旁路改 path（**反向验证**） | `replaceState` 换 path（还是同一份文档），再走一次 ref 动作 | 门必须拒：`BROWSER_STALE_REF(stale_document)` |
 * | E | **本会话自己点击** | 页面脚本 `replaceState` 只换 query | `navigated === false`，且回执**不许**出现 `addressDrift` |
 * | F | **本会话自己点击** | 页面脚本 `location.href = '/from-click'` | `navigated === true`，`pageChanged` 缺席 |
 * | G | 全程 | —— | 任何回执都**没有** `takeoverWindow`（直连 cdp provider 没有这条信号通道） |
 *
 * ### E 那条为什么要看旁路的事件读数才能判
 *
 * 「自己点击引发的仅 query 变」有两种可能的真机形态，**判据相反**：
 *
 * - 真 Chrome **发**了 `Page.navigatedWithinDocument` → 事件线被赊账抵掉，轮询线必须认出
 *   是**同一次**变化而不再记一笔 → 回执里 `addressDrift` 应当**缺席**。
 *   修前它记了一笔，回执于是渲染成「PAGE CHANGED **OUTSIDE THIS SESSION** … 重拍一次全量快照」
 *   —— 归因说反，还让模型为一次遥测抖动白付 ≈5500 字符（正是 D-19 要省的那笔）。
 * - 真 Chrome **不发**（query-only 的 `replaceState` 不算 same-document navigation）→
 *   事件线从未见过它，轮询线是这个变化**唯一的观测者** → `addressDrift` **应当出现**，
 *   而且这就是它作为兜底桶存在的意义。此时若缺席才是 bug（模型对一次「同 path 换参数」
 *   完全失明，而 D-19 特意没有作废纪元）。
 *
 * 所以 E 的判据是**条件式**的，两边都写死在探针里 —— 不替 Chrome 假定行为。
 *
 * F 是 E 的**反向验证**：同样的施加者（本会话自己点击）、同样「地址变了」，
 * 但换文档那一档必须与 E 形态不同（`navigated: true`）。两行同时绿才说明读数是有分辨力的，
 * 而不是「反正都报 false」。
 *
 * ## 跑法
 *
 *   "<真 Chrome>" --headless=new --remote-debugging-port=9447 \
 *     --user-data-dir=<工作区外的一次性目录> about:blank &
 *   DSH_CDP_ENDPOINT=http://127.0.0.1:9447 node node_modules/tsx/dist/cli.mjs \
 *     scripts/probe-p2-dirty.ts
 *
 * ⚠️ 与 `probe-gate-live.ts` / `probe-within-document.ts` 同一个坑：本机 9222/9333 常年被
 * 桌面端 Electron 占着，它 `/json/version` 同样回 200 却**不实现** `PUT /json/new` ——
 * 别把那种端点当真 Chrome（症状是 `open()` 报「refuses to create tabs」）。
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CdpBrowserProvider } from '../src/browser-cdp/provider.ts'
import { validateEndpoint } from '../src/browser-cdp/url-policy.ts'
import type {
  BrowserPageChanged,
  BrowserSnapshot,
} from '../src/browser/types.ts'

const rawEndpoint = process.env['DSH_CDP_ENDPOINT']
if (rawEndpoint === undefined || rawEndpoint.length === 0) {
  console.error('缺 DSH_CDP_ENDPOINT：指向一台能开标签页的真 Chrome（见文件头跑法）')
  process.exit(1)
}
const ENDPOINT = validateEndpoint(rawEndpoint)

/**
 * 夹具页。四个按钮各自对应一种「地址变化」，**全部由页面脚本自己完成** ——
 * 探针点它们时，变化就是「本会话自己引发的」那一类（赊账该抵掉的那一类）。
 */
const FIXTURE_HTML = `<!doctype html>
<html lang="zh">
  <head><meta charset="utf-8"><title>p2 dirty fixture</title></head>
  <body>
    <h1>P2 脏累加器夹具</h1>
    <button id="agent-drift">agent-drift</button>
    <button id="agent-nav">agent-nav</button>
    <button id="noop">noop</button>
    <p id="mark">就绪</p>
    <script>
      // 自己点击 → 页面脚本只换 query（D-19 的那一类：托底不该作废纪元）。
      // ⚠️ 用 location.pathname 拼，**不能**写死 '/'：探针中途会把页面停在别的 path 上
      // （A 走 /human-page），写死就成了「换文档」那一档，测的就不是 D-19 了
      // —— 第一版正是这么写的，真机直接撞出 BROWSER_STALE_REF(stale_document)。
      document.getElementById('agent-drift').addEventListener('click', () => {
        document.getElementById('mark').textContent = 'drifted';
        history.replaceState({ n: 1 }, '', location.pathname + '?sxsrf=AGENT');
      });
      // 自己点击 → 真导航（换文档）。
      document.getElementById('agent-nav').addEventListener('click', () => {
        location.href = '/from-click';
      });
      // 不产生任何变化的按钮：用来在「地址已经在外面变过」的状态下走一次 ref 动作。
      document.getElementById('noop').addEventListener('click', () => {
        document.getElementById('mark').textContent = 'noop';
      });
    </script>
  </body>
</html>
`

/** 一条入站 CDP 事件。 */
interface Wire {
  readonly method: string
  readonly params?: { frame?: { url?: string }; url?: string }
}

/**
 * 旁路连接：与 provider 各自一条 session，**互不干扰**。
 *
 * 它同时是两件事：**观测面**（自己订阅同一份事件流，看真 Chrome 到底发了什么）与
 * **施加者**（`Runtime.evaluate` 直接从外面改页面 —— 对 provider 来说就是「本会话之外」）。
 */
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
      socket.addEventListener('open', () => { resolve() }, { once: true })
      socket.addEventListener('error', () => { reject(new Error('旁路 WebSocket 连不上')) }, { once: true })
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

/** 一条判据的读数。 */
interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/** 把回执里的 `pageChanged` 变成一行好读的读数；缺席时明说「缺席」。 */
function showChanged(changed: BrowserPageChanged | undefined): string {
  return changed === undefined ? '缺席' : JSON.stringify(changed)
}

/** 事件流里的两条导航事件，压成 `withinDocument:/soft` 这种短标签。 */
function showEvents(events: readonly Wire[]): string {
  const navs = events
    .filter(event => event.method === 'Page.frameNavigated' || event.method === 'Page.navigatedWithinDocument')
    .map(event => `${event.method.replace('Page.', '')}:${event.params?.frame?.url ?? event.params?.url ?? '?'}`)
  return navs.length === 0 ? '（无导航事件）' : navs.join(' | ')
}

async function main(): Promise<void> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${String(port)}/`

  const provider = new CdpBrowserProvider({ endpoint: ENDPOINT })
  const checks: Check[] = []
  let side: SideChannel | undefined

  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`)
  }

  try {
    const session = await provider.open({ url: baseUrl })
    const sessionId = session.id
    side = await SideChannel.attach(session.url ?? baseUrl)
    // `Page` 域必须先 enable，否则**一个事件都收不到** —— 而「事件线看到了什么」正是本探针
    // 判据的一半。漏了这一步会把「没在听」误读成「Chrome 没发」。
    await side.send('Page.enable')
    await delay(300)
    side.drain()

    const snapshot = async (): Promise<BrowserSnapshot> => {
      const observed = await provider.observe({ kind: 'snapshot', sessionId })
      if (observed.kind !== 'snapshot') throw new Error('期望一份快照')
      return observed
    }

    /** 按可访问性名称取一个 ref；取不到时把当前 ref 表打出来，别猜。 */
    const refNamed = (shot: BrowserSnapshot, name: string): string => {
      const found = shot.refs.find(entry => entry.name === name)
      if (found === undefined) {
        throw new Error(`夹具里没有名为 "${name}" 的元素；当前 ref 表：`
          + shot.refs.map(entry => `${entry.role}:"${entry.name}"`).join(', '))
      }
      return found.ref
    }

    /** 从外面改页面（对 provider 而言就是「本会话之外」），返回这段时间里的事件线读数。 */
    const outside = async (expression: string, settleMs = 800): Promise<Wire[]> => {
      side?.drain()
      await side?.send('Runtime.evaluate', { expression, returnByValue: true })
      await delay(settleMs)
      return side?.drain() ?? []
    }

    console.log(`\n=== P2 脏累加器真机走查（${ENDPOINT}）===`)

    // ---------- 锚点 ----------
    const first = await snapshot()
    console.log(`  锚点：epoch=${String(first.epoch)} url=${first.url}`)

    // ---------- A. 外部硬导航 ----------
    const aEvents = await outside('location.href = "/human-page"', 1200)
    const a = await snapshot()
    console.log(`  A 事件线：${showEvents(aEvents)}\n  A 回执：pageChanged=${showChanged(a.pageChanged)}`)
    check(
      'A 外部硬导航：回执报出 navigated ≥ 1，且 route.to 命中新地址',
      (a.pageChanged?.navigated ?? 0) >= 1 && (a.pageChanged?.route?.to ?? '').endsWith('/human-page'),
      `pageChanged=${showChanged(a.pageChanged)}`,
    )

    // ---------- B. 锚点前移 ----------
    const b = await snapshot()
    check(
      'B 全量快照后锚点前移：紧接着再拍一次必须干净（同一笔账不许报两遍）',
      b.pageChanged === undefined,
      `pageChanged=${showChanged(b.pageChanged)}`,
    )

    // ---------- C. 外部 hash 变更 ----------
    const cEvents = await outside('location.hash = "#human"')
    const c = await snapshot()
    console.log(`  C 事件线：${showEvents(cEvents)}\n  C 回执：pageChanged=${showChanged(c.pageChanged)}`)
    check(
      'C 外部 hash 变更：进 withinDocument 桶，且不被当成换文档（navigated 仍为 0）',
      (c.pageChanged?.withinDocument ?? 0) >= 1 && (c.pageChanged?.navigated ?? 0) === 0,
      `pageChanged=${showChanged(c.pageChanged)}`,
    )

    // ---------- D. 外部仅 query 变 + 本会话点一下（两个桶不许各记一笔） ----------
    // 表达式按 `location.pathname` 拼：只换 query、**保住 path** —— 这才是 D-19 那一档。
    const dEvents = await outside('history.replaceState({}, "", location.pathname + "?sxsrf=HUMAN")')
    const dRef = refNamed(c, 'noop')
    const d = await provider.mutate({ kind: 'click', sessionId, ref: dRef })
    console.log(`  D 事件线：${showEvents(dEvents)}\n  D 回执：navigated=${String(d.navigated)} pageChanged=${showChanged(d.pageChanged)}`)
    const dSawEvent = dEvents.some(event => event.method === 'Page.navigatedWithinDocument')
    check(
      'D 同一个变化只进一个桶：事件线报过的地址，轮询线（写前门）不再记一笔',
      dSawEvent && (d.pageChanged?.withinDocument ?? 0) >= 1 && d.pageChanged?.addressDrift === undefined,
      `事件线到过 withinDocument=${String(dSawEvent)}；pageChanged=${showChanged(d.pageChanged)}`
      + '（addressDrift 若出现，说明两条线各记了一笔）',
    )

    // ---------- D2. 反向验证：同文档**换 path** 照旧作废（D-19 的放宽只针对 query/hash） ----------
    // 与 D 只差一个 path：同样的施加者、同样的同文档软导航。允许 D 通过、却必须拦住 D2，
    // 这条界线只有两行同时绿才算真的立住（否则「放宽」可能已经放宽到了换文档那一档）。
    const d2Anchor = await snapshot()
    const d2Ref = refNamed(d2Anchor, 'noop')
    const d2Events = await outside('history.replaceState({}, "", location.pathname + "-elsewhere")')
    const d2 = await provider.mutate({ kind: 'click', sessionId, ref: d2Ref }).then(
      () => ({ threw: false, code: undefined as string | undefined, reason: undefined as string | undefined, message: '没有抛错 —— 门放行了' }),
      (error: unknown) => ({
        threw: true,
        code: (error as { code?: string }).code,
        reason: (error as { reason?: string }).reason,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    console.log(`  D2 事件线：${showEvents(d2Events)}\n  D2 结果：${d2.threw ? `${String(d2.code)}/${String(d2.reason)}` : d2.message}`)
    check(
      'D2 反向验证：同文档只换了 path 时门照旧作废并拒发（D-19 放宽不覆盖换文档）',
      d2.threw && d2.code === 'BROWSER_STALE_REF' && d2.reason === 'stale_document',
      `${String(d2.code)}/${String(d2.reason)} —— ${d2.message.slice(0, 140)}`,
    )

    // ---------- E. 自己点击 → 页面脚本只换 query ----------
    const anchorE = await snapshot()
    const eRef = refNamed(anchorE, 'agent-drift')
    side.drain()
    const e = await provider.mutate({ kind: 'click', sessionId, ref: eRef })
    await delay(600)
    const eEvents = side.drain()
    const eSawEvent = eEvents.some(event => event.method === 'Page.navigatedWithinDocument')
    console.log(`  E 事件线：${showEvents(eEvents)}\n  E 回执：navigated=${String(e.navigated)} url=${e.url} pageChanged=${showChanged(e.pageChanged)}`)
    check(
      'E 自己点击引发的「仅 query 变」不许报成「本会话之外」：navigated=false 且 pageChanged 缺席',
      e.navigated === false && e.pageChanged === undefined,
      `navigated=${String(e.navigated)} pageChanged=${showChanged(e.pageChanged)}`,
    )
    check(
      'E′ 条件式：真 Chrome 若**没发**事件，则 addressDrift 必须补上（兜底桶是唯一的观测者）',
      eSawEvent ? e.pageChanged === undefined : (e.pageChanged?.addressDrift ?? 0) >= 1,
      `事件线到过 withinDocument=${String(eSawEvent)}（${showEvents(eEvents)}）`
      + `；pageChanged=${showChanged(e.pageChanged)}`,
    )
    // 地址确实变了、但纪元没被作废 —— D-19 的口径：变化如实呈现在回执自己的 `url` 上。
    check(
      'E″ D-19：仅 query 变不作废 ref 纪元（旧 ref 仍可用，模型不必白重拍）',
      e.url.includes('sxsrf=AGENT') && e.epoch === anchorE.epoch,
      `url=${e.url} epoch=${String(e.epoch)}（点击前 epoch=${String(anchorE.epoch)}）`,
    )

    // ---------- F. 反向验证：自己点击引发**真导航** ----------
    const anchorF = await snapshot()
    const fRef = refNamed(anchorF, 'agent-nav')
    side.drain()
    const f = await provider.mutate({ kind: 'click', sessionId, ref: fRef })
    await delay(600)
    const fEvents = side.drain()
    console.log(`  F 事件线：${showEvents(fEvents)}\n  F 回执：navigated=${String(f.navigated)} url=${f.url} pageChanged=${showChanged(f.pageChanged)}`)
    check(
      'F 反向验证：自己点击引发真导航时形态必须与 E 不同（navigated=true，pageChanged 仍缺席）',
      f.navigated === true && f.pageChanged === undefined,
      `navigated=${String(f.navigated)} pageChanged=${showChanged(f.pageChanged)}`,
    )

    // ---------- G. 全部回执都没有 takeoverWindow ----------
    const receipts: { label: string; changed: BrowserPageChanged | undefined }[] = [
      { label: 'A 快照', changed: a.pageChanged },
      { label: 'C 快照', changed: c.pageChanged },
      { label: 'D 点击', changed: d.pageChanged },
      { label: 'E 点击', changed: e.pageChanged },
      { label: 'F 点击', changed: f.pageChanged },
    ]
    const withTakeover = receipts.filter(entry => entry.changed?.takeoverWindow !== undefined)
    check(
      'G 直连 cdp provider 没有接管通道：takeoverWindow 全程缺席（「观察不到」不许印成 0 次）',
      withTakeover.length === 0,
      withTakeover.length === 0
        ? `五条回执都没有该字段：${receipts.map(entry => entry.label).join(' / ')}`
        : `这些回执带了它：${withTakeover.map(entry => entry.label).join(' / ')}`,
    )
  } catch (error: unknown) {
    console.log(`\nFAIL 探针本身出错：${error instanceof Error ? error.message : String(error)}`)
  }

  side?.close()
  await provider.dispose().catch(() => undefined)
  await server.closeAllConnections()
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })

  // ---------- 总账 ----------
  console.log('\n=== 总账 ===')
  for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}`)
  const failed = checks.filter(entry => !entry.ok)
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} 通过`)
  if (failed.length > 0) {
    console.log('\n⚠️ 有判据没过。**别先怀疑探针** —— 先看那一行的「事件线」读数：'
      + '它是真 Chrome 实际发的，探针的期望写在文件头那张表里。两者不一致时，'
      + '要么是实现的判据（`dirty.ts` / provider 的接线）要改，要么是那张表写错了，'
      + '但**不许**为了让它变绿去改期望 —— 那等于把证据改成结论。')
  }
  process.exit(0)
}

await main().catch((error: unknown) => {
  console.error('探针本身跑崩了：', error)
  process.exit(1)
})
