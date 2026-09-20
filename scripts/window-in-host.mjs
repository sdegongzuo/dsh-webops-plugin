/**
 * 让**正在运行的桌面端 host 进程**自己弹一个 Electron 窗口 —— 端到端证据脚本。
 *
 * 为什么要绕 inspector：桌面端开发态的 host 是独立的纯 Node 子进程（端口 9230），
 * 我们没法往它里面塞代码；但它的 inspector 开着，`Runtime.evaluate` 就是一条注入通道。
 *
 * 注意 evaluate 里**不能**用动态 `import()`（Node inspector 报
 * "A dynamic import callback was not specified"），所以走
 * `process.getBuiltinModule('module').createRequire(...)` —— Node 22 的 `require()`
 * 认 ESM，插件的 `lib/` 产物没有顶层 await，能直接 require 进来。
 *
 * 前提：桌面端在跑（`pnpm run dev:desktop`）。
 *
 * 用法：`pnpm run window:desktop`（可选 SMOKE_URL）。
 */

import { join, resolve } from 'node:path'
import { harnessDevProject } from './local-env.mjs'
import { fetchLoopback } from './loopback.mjs'

const PORT = Number(process.env.HOST_INSPECT_PORT ?? 9230)
// `DESKTOP_PROJECT_DIR` 显式指定优先；否则按 `.env.local` 的 `DSH_HARNESS` 推开发态工程目录
// `<DSH_HARNESS>/apps/desktop/.desktop-build/development/project`。路径不写死在这里。
const PROJECT = resolve(
  process.env.DESKTOP_PROJECT_DIR
    ?? harnessDevProject(),
)
const URL_TO_OPEN = process.env.SMOKE_URL ?? 'https://www.baidu.com'

/** 在 host 进程里执行的一段代码：require 插件产物 → 开窗口 → 读大纲。 */
const EXPRESSION = `(async () => {
  const { createRequire } = process.getBuiltinModule('module')
  const req = createRequire(${JSON.stringify(join(PROJECT, 'package.json'))})
  const mod = req('dsh-webops-plugin/browser-electron')
  const provider = new mod.ElectronBrowserProvider(
    {},
    new mod.ElectronWindowTransport({
      electronPath: process.env.DSH_BROWSER_ELECTRON_PATH,
      hostScript: req.resolve('dsh-webops-plugin/browser-electron').replace(/index\\.js$/u, 'host.cjs'),
    }),
    true,
  )
  const session = await provider.open({ url: ${JSON.stringify(URL_TO_OPEN)} })
  const snapshot = await provider.observe({ sessionId: session.id, kind: 'snapshot' })
  const shot = await provider.observe({ sessionId: session.id, kind: 'screenshot' })
  return JSON.stringify({
    providerId: provider.id,
    enabled: provider.isEnabled,
    session: { id: session.id, url: session.url, title: session.title },
    snapshot: { epoch: snapshot.epoch, refs: snapshot.refs.length, chars: snapshot.outline.length },
    screenshotBytes: shot.data.byteLength,
  })
})()`

const list = await (await fetchLoopback(PORT, '/json/list')).json()
const target = list.find(item => typeof item.webSocketDebuggerUrl === 'string')
if (target === undefined) {
  throw new Error(`桌面端 host 没在回环 ${String(PORT)} 端口上开 inspector；先跑 pnpm run dev:desktop`)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolvePromise, reject) => {
  socket.addEventListener('open', resolvePromise, { once: true })
  socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
})

try {
  const response = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('求值超时（开窗口 + 截图可能确实要久一点）')), 90_000)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      if (message.id !== 1) return
      clearTimeout(timer)
      if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
      else resolvePromise(message.result)
    })
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: EXPRESSION, awaitPromise: true, returnByValue: true },
    }))
  })

  const value = response?.result?.value
  if (typeof value !== 'string') {
    console.error('没拿到结果：', JSON.stringify(response))
    process.exitCode = 1
  } else {
    console.log('桌面端 host 里弹窗结果：', JSON.stringify(JSON.parse(value), undefined, 2))
    console.log('\n去看那个窗口 —— 它是桌面端 host 进程自己开的 BrowserWindow。')
  }
} finally {
  socket.close()
}
