/**
 * 无 API key 的「调度」验证（Electron 窗口版）：直接驱动 `ElectronBrowserProvider`
 * 跑一次 `open → snapshot → screenshot`。
 *
 * 它和 `smoke-dispatch.ts` 的差别只在 provider：那条走外部 Chrome 的调试端口，
 * 这条走**窗口宿主**（spawn 一个 Electron，开真正的 `BrowserWindow`）。
 * 桌面端 host 进程里跑的正是这条路径。
 *
 * 默认**不关闭**窗口：跑完请去看那个 Electron 窗口。
 *
 * 用法：
 *
 * ```bash
 * pnpm run smoke:window                                  # 用桌面端的 Electron 与默认地址
 * SMOKE_URL=https://www.bing.com pnpm run smoke:window
 * SMOKE_CLOSE=1 pnpm run smoke:window                    # 跑完把窗口关掉
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
const url = process.env.SMOKE_URL ?? 'https://www.baidu.com'
const shouldClose = process.env.SMOKE_CLOSE === '1'
const SHOT_OUT = resolve(process.env.SMOKE_SHOT_OUT ?? '.smoke-window.png')

const provider = new ElectronBrowserProvider(
  {},
  new ElectronWindowTransport({ electronPath, hostScript }),
  true,
)

async function main(): Promise<void> {
  console.log(`smoke-window: electron=${electronPath}`)

  const available = provider.available()
  console.log(`smoke-window: available=${String(available)}`)

  const session = await provider.open({ url })
  console.log('smoke-window: open ->', JSON.stringify(session))
  console.log('smoke-window: 应该已经弹出一个 Electron 窗口 —— 去看它。')

  const snapshot = await provider.observe({ sessionId: session.id, kind: 'snapshot' })
  if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
  console.log(`smoke-window: snapshot -> epoch ${String(snapshot.epoch)}, `
    + `${String(snapshot.refs.length)} refs, ${String(snapshot.outline.length)} chars`)
  console.log(snapshot.outline.split('\n').slice(0, 8).map(line => `  ${line}`).join('\n'))

  const shot = await provider.observe({ sessionId: session.id, kind: 'screenshot' })
  if (shot.kind !== 'screenshot') throw new Error('expected a screenshot')
  writeFileSync(SHOT_OUT, shot.data)
  console.log(`smoke-window: screenshot -> ${String(shot.data.byteLength)} bytes, 写出 ${SHOT_OUT}`)

  if (shouldClose) {
    await provider.close(session.id)
    console.log('smoke-window: closed')
  } else {
    // 宿主监听的那条 TCP 连接一断，它就会自杀、窗口跟着消失。
    // 所以「留着窗口」这件事只能靠让本进程继续活着（默认 2 分钟）。
    const holdMs = Number(process.env.SMOKE_HOLD_MS ?? 120_000)
    console.log(`smoke-window: 窗口留着不关，本进程挂 ${String(holdMs)} ms —— 去看那个窗口。`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, holdMs))
  }
}

try {
  await main()
} finally {
  // 不关窗口时也别把宿主进程杀掉：它是独立进程，会跟着这条 TCP 连接断开而退出，
  // 所以这里显式保留连接 —— dispose 只在收尾时调用。
  if (shouldClose) await provider.dispose().catch(() => undefined)
}
