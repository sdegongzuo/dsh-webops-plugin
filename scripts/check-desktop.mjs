#!/usr/bin/env node
/**
 * 桌面端接入的自检：用 Electron 自己开的调试端口，从外部确认
 * 「host 半边装了没」与「client 半边跑了没，面板挂上了没」。
 *
 * 三个信号，全部来自真实运行中的进程，不依赖模型或 API key：
 *
 * 1. `http://127.0.0.1:9222/json/list` 能列出渲染进程页面 → 壳起来了。
 * 2. 渲染进程里 `document.documentElement.dataset.dshBrowserPlugin === '1'`
 *    → 客户端 bundle 被 `fetchBundle()` 拉取并**执行**过（客户端插件入口跑到了）。
 * 3. 页面里有 `[data-dsh-browser-dock]` → 面板组件真的挂进了 slot 并被渲染。
 *
 * 2 与 3 的区别很重要：2 只证明插件加载，3 还要 slot 组合正确、组件没抛异常。
 *
 * 用 Node 22 内置的 WebSocket 直接说 CDP，不引任何依赖。
 *
 * 用法：`pnpm run check:desktop`（可选环境变量 RENDERER_PORT，默认 9222）。
 */

const PORT = Number(process.env.RENDERER_PORT ?? 9222)
const DEADLINE_MS = Number(process.env.CHECK_DEADLINE_MS ?? 60_000)

/** 面板为空时的说明：不是错误，只是这一会话还没有浏览器调用。 */
const DOCK_PROBE = `(() => {
  const root = document.documentElement;
  const dock = document.querySelector('[data-dsh-browser-dock]');
  const rows = document.querySelectorAll('[data-dsh-browser-row]');
  return JSON.stringify({
    plugin: root.dataset.dshBrowserPlugin ?? null,
    hasDock: dock !== null,
    dockState: dock === null ? null : dock.getAttribute('data-dsh-browser-state'),
    dockUrl: dock === null ? null : (dock.querySelector('[data-dsh-browser-url]')?.textContent ?? null),
    toolRows: rows.length,
    title: document.title,
  });
})()`

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function listPages() {
  const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)
  if (!response.ok) throw new Error(`/json/list 返回 ${String(response.status)}`)
  const pages = await response.json()
  return pages.filter(page => page.type === 'page' && typeof page.webSocketDebuggerUrl === 'string')
}

/** 对一条 CDP 连接做一次 Runtime.evaluate。 */
async function evaluate(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 求值超时')), 15_000)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
        if (message.id !== 1) return
        clearTimeout(timer)
        if (message.error !== undefined) reject(new Error(`CDP 错误：${JSON.stringify(message.error)}`))
        else if (message.result?.exceptionDetails !== undefined) reject(new Error(`页面异常：${message.result.exceptionDetails.text ?? ''}`))
        else resolve(message.result?.result?.value)
      })
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    })
  } finally {
    socket.close()
  }
}

async function main() {
  const deadline = Date.now() + DEADLINE_MS
  let pages = []
  while (Date.now() < deadline) {
    try {
      pages = await listPages()
      if (pages.length > 0) break
    } catch {
      // 渲染进程还没起来；继续等。
    }
    await delay(2_000)
  }
  if (pages.length === 0) throw new Error(`等了 ${String(DEADLINE_MS)}ms 也没在 ${String(PORT)} 上发现渲染页面；桌面端起了吗？`)

  let last = undefined
  while (Date.now() < deadline) {
    for (const page of pages) {
      try {
        const raw = await evaluate(page.webSocketDebuggerUrl, DOCK_PROBE)
        last = { url: page.url, ...JSON.parse(raw) }
        if (last.plugin === '1' && last.hasDock) break
      } catch (error) {
        last = { url: page.url, error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (last?.plugin === '1' && last?.hasDock) break
    await delay(2_000)
  }

  console.log(JSON.stringify(last, null, 2))
  const ok = last?.plugin === '1' && last?.hasDock === true
  if (!ok) {
    console.error('\n自检未通过：需要 plugin="1" 且 hasDock=true。')
    console.error('- plugin 不是 "1"：客户端半边没被加载（看 host 进程日志里有没有 [dsh-browser-plugin] 行）。')
    console.error('- hasDock 是 false：面板组件没渲染（可能这一会话还没有 browser_* 调用 —— 面板无活动时不占位）。')
    process.exitCode = 1
    return
  }
  console.log('\n自检通过：客户端半边已加载，浏览器面板已挂载。')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
