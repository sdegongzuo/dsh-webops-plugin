/**
 * 无 API key 的「调度」验证（Electron 窗口版）：直接驱动 `ElectronBrowserProvider`
 * 在一个窗口里开**多个标签页**，跑 `open → activate → snapshot → screenshot`。
 *
 * 它和 `smoke-dispatch.ts` 的差别只在 provider：那条走外部 Chrome 的调试端口，
 * 这条走**窗口宿主**（spawn 一个 Electron，开真正的 `BrowserWindow`）。
 * 桌面端 host 进程里跑的正是这条路径。
 *
 * 默认**留着窗口**（`keepAlive`）：父进程退出后宿主不自杀，窗口一直在屏幕上。
 * 想收摊就 `SMOKE_CLOSE=1`。
 *
 * 用法：
 *
 * ```bash
 * pnpm run smoke:window                                    # 开默认两个标签，窗口留下
 * SMOKE_URLS=https://www.baidu.com,https://cn.bing.com pnpm run smoke:window
 * SMOKE_CLOSE=1 pnpm run smoke:window                      # 跑完关掉
 * ```
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ElectronBrowserProvider } from '../src/browser-electron/provider.ts'
import { ElectronWindowTransport } from '../src/browser-electron/transport.ts'

/** 默认 Electron：开发态就是桌面端自己装的那一个。 */
const DEFAULT_ELECTRON = 'D:/dev/cli/deepseek-harness/apps/desktop/node_modules/electron/dist/electron.exe'

const electronPath = process.env.DSH_BROWSER_ELECTRON_PATH ?? DEFAULT_ELECTRON
const hostScript = fileURLToPath(new URL('../src/browser-electron/host.cjs', import.meta.url))
const urls = (process.env.SMOKE_URLS ?? 'https://www.baidu.com,https://cn.bing.com')
  .split(',')
  .map(item => item.trim())
  .filter(item => item !== '')
const shouldClose = process.env.SMOKE_CLOSE === '1'
const SHOT_OUT = resolve(process.env.SMOKE_SHOT_OUT ?? '.smoke-window.png')

const transport = new ElectronWindowTransport({ electronPath, hostScript, keepAlive: !shouldClose })
const provider = new ElectronBrowserProvider({}, transport, true)

async function main(): Promise<void> {
  console.log(`smoke-window: electron=${electronPath}`)
  console.log(`smoke-window: available=${String(provider.available())}`)

  // 1) 依次开标签页 —— 它们落在同一个壳窗口里。
  const sessions: { id: string; url: string; title: string }[] = []
  for (const url of urls) {
    const session = await provider.open({ url })
    sessions.push({ id: session.id, url: session.url, title: session.title })
    console.log(`smoke-window: open ${url} -> ${JSON.stringify(session)}`)
  }
  console.log(`smoke-window: ${String(sessions.length)} 个标签页开好了 —— 去看那个窗口的标签条。`)

  // 2) 列一遍，确认宿主确实把它们当成同一窗口的多个标签。
  const targets = await transport.list()
  console.log(`smoke-window: list -> ${JSON.stringify(targets.map(item => ({ id: item.id, url: item.url })))}`)

  // 3) 切回第一个标签再操作：验证 activate 真的换了前台。
  const first = sessions[0]
  if (first !== undefined && sessions.length > 1) {
    await provider.activate(first.id)
    console.log(`smoke-window: activate ${String(first.id)}`)
  }
  if (first === undefined) throw new Error('no tab was opened')

  // 3.5) 标签条自检：宿主自己画的那条 UI 必须真的渲染了出来，
  // 否则「多标签」只是宿主内存里的账面数字。`rendered` 是标签条 DOM 里的 `.tab` 节点数。
  const bar = await transport.barState()
  if (bar.tabs !== sessions.length) {
    throw new Error(`tab bar mismatch: host holds ${String(bar.tabs)} tabs, opened ${String(sessions.length)}`)
  }
  if (bar.rendered !== sessions.length) {
    throw new Error(`tab bar not rendered: expected ${String(sessions.length)} .tab nodes, got ${String(bar.rendered)}`)
  }
  if (sessions.length > 1 && bar.active !== first.id) {
    throw new Error(`tab bar active mismatch: expected ${String(first.id)}, got ${String(bar.active)}`)
  }
  console.log(`smoke-window: bar -> ${JSON.stringify(bar)}`)

  const snapshot = await provider.observe({ sessionId: first.id, kind: 'snapshot' })
  if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
  console.log(`smoke-window: snapshot(${String(first.id)}) -> epoch ${String(snapshot.epoch)}, `
    + `${String(snapshot.refs.length)} refs, ${String(snapshot.outline.length)} chars`)
  console.log(snapshot.outline.split('\n').slice(0, 6).map(line => `  ${line}`).join('\n'))

  const shot = await provider.observe({ sessionId: first.id, kind: 'screenshot' })
  if (shot.kind !== 'screenshot') throw new Error('expected a screenshot')
  writeFileSync(SHOT_OUT, shot.data)
  console.log(`smoke-window: screenshot -> ${String(shot.data.byteLength)} bytes, 写出 ${SHOT_OUT}`)

  if (shouldClose) {
    for (const session of sessions) await provider.close(session.id)
    console.log('smoke-window: 全部标签已关')
    return
  }

  // 窗口留着。**本进程也必须留着**：宿主是它的子进程，父进程一走（哪怕 keepAlive）
  // 很多环境会把整棵进程树收掉。所以这里挂住，直到超时或被 Ctrl-C。
  const holdMs = Number(process.env.SMOKE_HOLD_MS ?? 600_000)
  console.log(`smoke-window: 窗口与标签都留着 —— 现在就能去看。本进程挂 ${String(holdMs)} ms（Ctrl-C 结束）。`)
  await new Promise(resolvePromise => setTimeout(resolvePromise, holdMs))
}

try {
  await main()
} finally {
  // keepAlive 时**不能** dispose：那会把窗口一起收掉。
  if (shouldClose) await provider.dispose().catch(() => undefined)
}
