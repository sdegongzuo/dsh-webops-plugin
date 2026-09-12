/**
 * 无 API key 的「调度」验证：直接驱动 provider 跑一次 `open → snapshot → screenshot`。
 *
 * 这是绕过 agent loop 的最小调度路径 —— 模型那一侧做的事就是「决定调哪个工具、
 * 传什么参数」，落到能力层就是这几个调用。没有 `DEEPSEEK_API_KEY` 时也跑得动，
 * 所以它能回答「插件被调度后到底会发生什么」，而不必先骗模型调一次。
 *
 * 默认**不关闭**标签页：跑完请去看那个浏览器窗口，页面就在那儿。
 *
 * 用法：
 *
 * ```bash
 * pnpm run smoke:dispatch                         # 对 9333 开 https://example.com
 * SMOKE_ENDPOINT=http://127.0.0.1:9222 pnpm run smoke:dispatch   # 对照：连桌面端自己
 * SMOKE_CLOSE=1 pnpm run smoke:dispatch           # 跑完关掉标签页
 * ```
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CdpBrowserProvider } from '../src/browser-cdp/provider.ts'

const endpoint = process.env.SMOKE_ENDPOINT ?? 'http://127.0.0.1:9333'
const url = process.env.SMOKE_URL ?? 'https://example.com'
const shouldClose = process.env.SMOKE_CLOSE === '1'
const SHOT_OUT = resolve(process.env.SMOKE_SHOT_OUT ?? '.smoke-shot.png')

const provider = new CdpBrowserProvider({ endpoint })

async function main(): Promise<void> {
  console.log(`smoke-dispatch: endpoint=${endpoint}`)

  const available = await provider.available()
  console.log(`smoke-dispatch: available=${String(available)}`)
  if (!available) {
    console.error('smoke-dispatch: 端点不可用。真 Chrome 要带 --remote-debugging-port 启动；')
    console.error('                Electron（含 dsh 桌面端）不接受 /json/new，连它必然开不出标签页。')
    process.exitCode = 1
    return
  }

  const session = await provider.open({ url })
  console.log('smoke-dispatch: open ->', JSON.stringify(session))

  const snapshot = await provider.observe({ sessionId: session.id, kind: 'snapshot' })
  if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
  console.log(`smoke-dispatch: snapshot -> epoch ${String(snapshot.epoch)}, `
    + `${String(snapshot.refs.length)} refs, ${String(snapshot.outline.length)} chars, `
    + `truncated=${String(snapshot.truncated)}`)
  console.log(snapshot.outline.split('\n').slice(0, 12).map(line => `  ${line}`).join('\n'))

  const shot = await provider.observe({ sessionId: session.id, kind: 'screenshot' })
  if (shot.kind !== 'screenshot') throw new Error('expected a screenshot')
  console.log(`smoke-dispatch: screenshot -> ${String(shot.data.byteLength)} bytes, ${shot.mediaType}`)
  writeFileSync(SHOT_OUT, shot.data)
  console.log(`smoke-dispatch: 截图已写出 ${SHOT_OUT}`)

  if (shouldClose) {
    await provider.close(session.id)
    console.log('smoke-dispatch: closed')
  } else {
    console.log('smoke-dispatch: 标签页留着不关 —— 去看那个浏览器窗口。')
  }
}

await main()
await provider.dispose().catch(() => undefined)
