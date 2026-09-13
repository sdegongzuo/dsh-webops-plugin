#!/usr/bin/env node
/**
 * 桌面端接入的自检：用 Electron 自己开的调试端口，从外部确认
 * 「host 半边认出了插件」与「client 半边真的加载并执行了」。
 *
 * 四个信号，全部来自真实运行的进程，不依赖模型或 API key：
 *
 * 1. `http://127.0.0.1:9222/json/list` 列得出渲染页面 → 壳起来了。
 * 2. `window.__DSH_BOOT__` 的启动图里有本插件的条目 → **host 半边**把插件当成
 *    活跃 Loader 条目认出来了：profile 的 `cordis.patch.yml` 生效、包能解析、
 *    `package.json` 读得到、`dsh.client` 声明解析成功、`exports["./client"]` 找到产物。
 * 3. `document.documentElement.dataset.dshBrowserPlugin === '1'` → 客户端 bundle 被
 *    `fetchBundle()` 取回并**执行**过（`apply` 跑到了）。
 * 4. 页面里有 `[data-dsh-browser-dock]` → 面板挂进了 slot 且渲染成功。
 *
 * 第 4 条之所以是硬条件：dock 常驻渲染（无活动时显示「已就绪」），所以它**缺席即失败**——
 * 这正好让「装完在界面里看得见」这件事有了自动化证据，不必先骗模型去调一次浏览器工具。
 *
 * 5. `data-dsh-webops-plugin-dock` / `-tool-views` → slot **注册成功**（不只是 bundle 跑过）。
 *    `ctx.slots.inject` 的 cb 要等 slot 被声明才执行，所以这两个标记才能证明
 *    `conversation.input.dock` 与 `tool.call.toolview` 真的被声明并且我们注册进去了。
 *
 * 用 Node 22 内置的 WebSocket 直接说 CDP，不引任何依赖。
 *
 * 用法：`pnpm run check:desktop`（可选环境变量 RENDERER_PORT，默认 9222）。
 */

const PORT = Number(process.env.RENDERER_PORT ?? 9222)
const DEADLINE_MS = Number(process.env.CHECK_DEADLINE_MS ?? 60_000)
const PLUGIN_ID = 'dsh-webops-plugin'
/** 客户端应注册的工具卡片数：open / navigate / snapshot / screenshot / tabs / click / fill / press / scroll / wait。 */
const EXPECTED_TOOL_VIEWS = 10

const PROBE = `(() => {
  const boot = globalThis.__DSH_BOOT__;
  const entries = Array.isArray(boot?.entries) ? boot.entries : [];
  const mine = entries.filter(entry => JSON.stringify(entry).includes(${JSON.stringify(PLUGIN_ID)}));
  const dock = document.querySelector('[data-dsh-browser-dock]');
  return JSON.stringify({
    bootGraph: boot === undefined,
    bootEntries: entries.length,
    pluginEntries: mine,
    entryIds: entries.map(entry => (typeof entry?.id === 'string' ? entry.id : null)),
    beacon: document.documentElement.dataset.dshBrowserPlugin ?? null,
    dockRegistered: document.documentElement.dataset.dshBrowserPluginDock ?? null,
    toolViews: document.documentElement.dataset.dshBrowserPluginToolViews ?? null,
    hasDock: dock !== null,
    dockState: dock === null ? null : dock.getAttribute('data-dsh-browser-state'),
    dockUrl: dock === null ? null : (dock.querySelector('[data-dsh-browser-url]')?.textContent ?? null),
    toolRows: document.querySelectorAll('[data-dsh-browser-row]').length,
  });
})()`

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

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
        else if (message.result?.exceptionDetails !== undefined) {
          reject(new Error(`页面异常：${String(message.result.exceptionDetails.text ?? '')}`))
        } else resolve(message.result?.result?.value)
      })
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }))
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
      // 渲染进程还没起来，继续等。
    }
    await delay(2_000)
  }
  if (pages.length === 0) {
    throw new Error(`等了 ${String(DEADLINE_MS)}ms 也没在 ${String(PORT)} 上发现渲染页面；桌面端起得来吗？`)
  }

  let report
  while (Date.now() < deadline) {
    for (const page of pages) {
      try {
        report = { page: page.url, ...JSON.parse(await evaluate(page.webSocketDebuggerUrl, PROBE)) }
      } catch (error) {
        report = { page: page.url, error: error instanceof Error ? error.message : String(error) }
      }
      if (report?.beacon === '1') break
    }
    if (report?.beacon === '1') break
    await delay(2_000)
  }

  console.log(JSON.stringify(report, null, 2))

  const loaded = report?.beacon === '1'
  const seen = Array.isArray(report?.pluginEntries) && report.pluginEntries.length > 0
  const docked = report?.hasDock === true
  const dockRegistered = report?.dockRegistered === '1'
  const toolViews = Number(report?.toolViews ?? 0)
  const toolsRegistered = toolViews === EXPECTED_TOOL_VIEWS
  if (!loaded || !seen || !docked || !dockRegistered || !toolsRegistered) {
    console.error('\n自检未通过。')
    if (!seen) console.error(`- 启动图里没有 ${PLUGIN_ID} 条目：host 半边没把这个包当成活跃 Loader 条目。`)
    if (!loaded) console.error('- 客户端信标没亮：客户端 bundle 没被加载或执行。')
    if (!dockRegistered) console.error('- dock 没注册上：conversation.input.dock 没被声明，或 register 失败。')
    if (!docked) console.error('- 页面里没有 [data-dsh-browser-dock]：面板没挂进 conversation.input.dock。')
    if (!toolsRegistered) console.error(`- 工具卡片只注册了 ${String(toolViews)}/${String(EXPECTED_TOOL_VIEWS)} 个：tool.call.toolview 没被完全声明。`)
    process.exitCode = 1
    return
  }
  console.log(`\n自检通过：host 半边认出了 ${PLUGIN_ID}（启动图 ${String(report.pluginEntries.length)} 条），客户端半边已执行，`
    + `面板已渲染，${String(toolViews)} 个工具卡片已注册。`)
  console.log(`面板状态：${String(report.dockState)} · 地址 ${report.dockUrl ?? '（无）'}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
