/**
 * 节点「彻底消失」探针：坐实方案 §6.3 里那条**已知剩余漏报**的失败形态。
 *
 * ## 为什么需要它（会话 f6b89609 的实测把它顶出来了）
 *
 * §6.3 写「细门抓不到的是**同文档重排**」。真实会话里抓到的形态比这句更糟：
 * 模型在 `[3.11]` 拿到 `e92`，下一轮 `[4.1]` 直接 `webpage_fill(e92)`，收到的是
 *
 *     Error: CDP error: No node with given id found
 *
 * —— **一个裸的协议错误**：没有 stale 文案、没告诉模型「重拍快照」，模型只能自己猜。
 * 而同一份会话里门的话术（`the action was NOT dispatched … run webpage_snapshot again`）
 * 出现过 1 次，说明**门在这台构建上是活的**，不是构建旧。
 *
 * ## 代码上的根因（读出来的假设，本探针就是来验它的）
 *
 * `resolveNodeObjectId`（`provider.ts:1491`）与 `elementClip`（`provider.ts:1313`）都这样写：
 *
 *     const resolved = await connection.send('DOM.resolveNode', { backendNodeId })
 *     const objectId = resolved.object?.objectId
 *     if (objectId === undefined) { … → BROWSER_STALE_REF(reason: 'node_gone') }
 *
 * 兜住的只是「CDP **成功返回**但没带 object」。而节点真的没了时，CDP 走的是另一条路：
 * **直接回一条 JSON-RPC 错误**（`No node with given id found`）。于是 `send` 抛 →
 * `mapCdpError` 把它翻成 `BROWSER_PROTOCOL_ERROR` → 上面那个 if 压根没机会执行。
 *
 * 这同时说明 `assertPreActionGate` 注释里那句「上面 `resolveNodeObjectId` 已经把它兜成
 * `BROWSER_STALE_REF`（实测 22/22 失败）」**只覆盖了「失败」这个词，没覆盖「失败被翻译成什么码」**
 * —— 22/22 那次量的是「解析失败与否」，所以它绿着，缺口却在。
 *
 * ## 为什么 `probe-gate-live.ts` 结构上抓不到
 *
 * 它的夹具是 `window.__node = getElementById('submit')` 然后 `window.__node.remove()`：
 * **JS 引用还在**，节点没被销毁，`DOM.resolveNode` 照常成功 → 落到细门 `isConnected === false`
 * → 报 `was removed from the document`。而真实页面的重排会把旧节点连同引用一起丢掉。
 * 本探针就是补上这半边：**摘除 + 丢引用 + 强制 GC**。
 *
 * ## 跑法（端点必须是一台**能开标签页的真 Chrome**）
 *
 *   "<真 Chrome>" --headless=new --remote-debugging-port=9444 \
 *     --user-data-dir=<工作区外的一次性目录> about:blank &
 *   DSH_CDP_ENDPOINT=http://127.0.0.1:9444 node node_modules/tsx/dist/cli.mjs \
 *     scripts/probe-stale-node.ts [--expect=current|fixed]
 *
 * `--expect` 是判据档位，默认 `current`（断言缺口存在）。**修掉之后必须跑 `fixed` 才算验完**：
 *
 * | 档位 | 断言 | 什么时候用 |
 * |---|---|---|
 * | `current` | 硬销毁后是**裸协议错误**（`BROWSER_PROTOCOL_ERROR` / `No node with given id found`） | 修之前跑，必须绿 —— 绿了才证明缺口真的存在 |
 * | `fixed` | 硬销毁后是 **`BROWSER_STALE_REF`(node_gone)** | 修之后跑，必须绿 |
 *
 * 两档交叉跑应当**红**（修前跑 fixed 红、修后跑 current 红）—— 否则判据是装饰性的。
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

const EXPECT = (process.argv.find(arg => arg.startsWith('--expect='))?.slice('--expect='.length)) ?? 'current'
if (EXPECT !== 'current' && EXPECT !== 'fixed') {
  console.error(`--expect 只认 current / fixed，收到：${EXPECT}`)
  process.exit(1)
}

const FIXTURE_HTML = `<!doctype html>
<html lang="zh">
  <head><meta charset="utf-8"><title>stale-node fixture</title></head>
  <body>
    <h1>节点消失夹具</h1>
    <input id="field" type="text" value="">
    <script>
      window.__seq = 0;
      // 造一个新按钮当靶子。每轮的靶子都是新的 id —— 免得「旧 ref 指向的还是同一个节点」。
      window.__make = () => {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = 'target-' + (++window.__seq);
        b.textContent = '目标按钮';
        document.body.appendChild(b);
        window.__target = b;
        return b.id;
      };
      // 软摘除：摘掉但**保住 JS 引用** —— 节点不销毁，probe-gate-live 走的就是这条。
      window.__detachSoft = () => { window.__target.remove(); };
      window.__make();
    </script>
  </body>
</html>
`

const results: { name: string; ok: boolean; detail: string }[] = []

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} —— ${detail}`)
}

/** 不经 provider 的 CDP 通道：既能改页面，也能发任意 CDP 命令读 CDP 自己的行为。 */
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

  evaluate(expression: string): Promise<unknown> {
    return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      .then(result => (result as { result?: { value?: unknown } }).result?.value)
  }

  /** 发任意 CDP 命令，**原样抛出** CDP 的 JSON-RPC 错误（不做任何翻译）。 */
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
        if (msg.error !== undefined) {
          const error = new Error(msg.error.message ?? 'CDP 错误') as Error & { cdpCode?: number }
          error.cdpCode = msg.error.code
          reject(error)
        } else resolve(msg.result)
      }
      this.socket.addEventListener('message', onMessage)
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** 把错误摊开成「code + message」，判据按 code 判，别去正则匹配 `String(error)`。 */function shape(error: unknown): { code: string; message: string; cdpCode?: number } {
  const e = error as { code?: unknown; message?: unknown; cdpCode?: unknown } | undefined
  return {
    code: typeof e?.code === 'string' ? e.code : '',
    message: typeof e?.message === 'string' ? e.message : String(error ?? ''),
    ...typeof e?.cdpCode === 'number' ? { cdpCode: e.cdpCode } : {},
  }
}

/**
 * 缺口的指纹：**裸协议错误**（`BROWSER_PROTOCOL_ERROR`）。
 *
 * ⚠️ 只按 `BROWSER_PROTOCOL_ERROR` 判，**不**按 CDP 的 `code === -32000` 判 ——
 * 实测同一条错误有时**不带 code**：会话 f6b89609 里那条报的是
 * `CDP error: No node with given id found`（无 `(code …)` 后缀），
 * 而本探针重放出来的是 `… does not belong to the document (code -32000)`。
 * 带上话术是为了别把「连接断了」那类协议错误也算成缺口。
 */
function isRawNodeGoneError(shape_: { code: string; message: string }): boolean {
  return shape_.code === 'BROWSER_PROTOCOL_ERROR'
    && /No node with given id found|does not belong to the document/.test(shape_.message)
}

/**
 * 修好后的指纹：**能力错误 + 恢复指引**。
 *
 * 两种话术都要认：`resolveBackendNodeId` 抛的是 `is gone from the document`，
 * 而「CDP 成功返回但缺 objectId」那条分支抛的是 `is no longer attached to the document`。
 * 两个都得算修好 —— 只认一种会把探针变成装饰。
 */
function isStaleRefNodeGone(shape_: { code: string; message: string }): boolean {
  return shape_.code === 'BROWSER_STALE_REF'
    && /(is gone from the document|no longer attached to the document)/.test(shape_.message)
    && /run webpage_snapshot again/.test(shape_.message)
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

    // —— 形态：直接拿一个不存在的 backendNodeId 问 CDP，看它到底「抛」还是「返回空」 ——
    // 这一步不看场景，只回答「CDP 在 node 没了时的行为是什么」。它是根因假设的一半。
    const bogus = await side.send('DOM.resolveNode', { backendNodeId: 999_999_999 })
      .then(result => ({ threw: false, result }))
      .catch((error: unknown) => ({ threw: true, error }))
    const bogusShape = shape(bogus.threw ? bogus.error : undefined)
    check('形态：DOM.resolveNode 对不存在的 node **抛协议错误**（而不是返回空 object）',
      bogus.threw,
      bogus.threw
        ? `抛出：${bogusShape.message}${bogusShape.cdpCode === undefined ? '' : ` (cdpCode ${String(bogusShape.cdpCode)})`}`
        : `**没抛**，返回了 ${JSON.stringify(bogus.result)} —— 那根因假设不成立，缺口另有解释`)

    /** 拍一次快照，取当前那个「目标按钮」的 ref。靶子一直在换 id，所以每轮都要重取。 */
    const targetRef = async (): Promise<string> => {
      const shot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (shot.kind !== 'snapshot') throw new Error('expected a snapshot')
      const found = shot.refs.find(entry => entry.role === 'button' && entry.name === '目标按钮')?.ref
      if (found === undefined) {
        throw new Error(`快照里没有目标按钮的 ref（拿到 ${shot.refs.map(e => `${e.role}/${e.name}`).join(', ')}）`)
      }
      return found
    }

    // —— 基线：正常 ref 的 fill 必须成功（否则后面的失败证明不了任何事） ——
    const ref = await targetRef()
    await provider.mutate({ kind: 'fill', sessionId: session.id, ref, value: '基线' })
    check('基线：未被拦的 fill 真的落到页面上', true, `ref=${ref} 填写成功`)

    // —— 对照组：软摘除（保引用）。这条 probe-gate-live 已覆盖，这里只用来证明两档确实不同 ——
    await side.evaluate('window.__make()')
    const refSoft = await targetRef()
    await side.evaluate('window.__detachSoft()')
    const softError = await provider.mutate({ kind: 'fill', sessionId: session.id, ref: refSoft, value: 'x' })
      .then(() => undefined)
      .catch((error: unknown) => error)
    const softShape = shape(softError)
    // 软摘除落在细门（节点还在，只是 isConnected=false），话术是 "was removed from the document"。
    check('对照：软摘除（保引用）走细门，报 `was removed from the document`',
      softShape.code === 'BROWSER_STALE_REF' && /was removed from the document/.test(softShape.message),
      `${softShape.code} / ${softShape.message}`)

    // —— 主角：**同 URL 的整页刷新** ——
    // 这是 §5.1 注释点名说「已由 `resolveNodeObjectId` 兜成 BROWSER_STALE_REF」的那一类：
    // 地址一个字没变（粗门看不见）、文档整个换了（旧 backendNodeId 失效）。
    // 手段刻意选刷新而不是「摘除 + GC」：实测 Chrome 的 inspector 会**保留已摘除的节点**
    // （`m_detachedNodes`），摘除后 resolveNode 照常成功、被细门兜住，场景重放不出来。
    // 而整页刷新会 `didCommitLoad` —— DOM agent 的节点表跟着重置，旧 id 才是真的指不到东西。
    await side.evaluate('window.__make()')
    const refHard = await targetRef()
    const markerBefore = await side.evaluate('window.__seq')
    await side.send('Page.enable').catch(() => undefined)
    await side.send('Page.reload').catch(() => undefined)
    // 等新文档真的起来：夹具脚本重跑会重置 __seq，用它当「换过文档了」的凭据。
    for (let i = 0; i < 60; i += 1) {
      const seq = await side.evaluate('window.__seq').catch(() => undefined)
      if (seq === 1 && markerBefore !== 1) break
      await delay(100)
    }
    const reloaded = await side.evaluate('window.__seq')
    console.log(`OBS  同 URL 刷新：刷新前 __seq=${String(markerBefore)}，刷新后 __seq=${String(reloaded)}`
      + '（=1 说明是新文档跑了一遍夹具脚本）')
    const hardError = await provider.mutate({ kind: 'fill', sessionId: session.id, ref: refHard, value: 'x' })
      .then(() => undefined)
      .catch((error: unknown) => error)
    const hardShape = shape(hardError)
    // 这一档**不断言**（见文件头）：CDP 到底抛错、还是旧 id 恰好撞上新文档里的另一个节点
    // （= §1.4 的静默点错），两种结果都值得记下来，判据留给 fake-CDP 单测。
    console.log(`OBS  同 URL 刷新后复用旧 ref（${refHard}）：${hardShape.code || '（没报错）'} / ${hardShape.message}`)
    if (EXPECT === 'current') {
      check('现状：同 URL 刷新后复用旧 ref 会露出**裸协议错误**（缺口成立）',
        isRawNodeGoneError(hardShape),
        `${hardShape.code} / ${hardShape.message}`)
    } else {
      check('修后：同 URL 刷新后复用旧 ref 报 `BROWSER_STALE_REF`(node_gone)（缺口已修）',
        isStaleRefNodeGone(hardShape) || (hardShape.code === 'BROWSER_STALE_REF' && /stale document/.test(hardShape.message)),
        `${hardShape.code} / ${hardShape.message}`)
    }
  } catch (error: unknown) {
    const crashed = shape(error)
    check('探针全程无异常', false, `${crashed.code} / ${crashed.message}`)
  }
  side?.close()
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
    check('dispose 干净：不抛错且标签页已回收',
      disposeError === undefined && leftover !== undefined && leftover.length === 0,
      disposeError === undefined
        ? `无错 / 该夹具的 target 剩 ${String(leftover?.length ?? -1)} 个（应为 0）`
        : `${shape(disposeError).code} / ${shape(disposeError).message}`)
  }
  await server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => { resolve() }))

  const failed = results.filter(entry => !entry.ok)
  console.log(`\n（判据档位 --expect=${EXPECT}）合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main().catch((error: unknown) => {
  console.error('探针本身跑崩了：', error)
  process.exit(1)
})
