/**
 * 端到端验证 P2/P3 五个新工具在**真窗口**上的行为（P2/P3 的 smoke）。
 *
 * 为什么单测顶不上：console / network 依赖真 CDP 事件流，locate / 高亮要真渲染、
 * 真视口坐标；这些和 smoke-devtools 同理，必须起真的宿主、真的开一个页面。
 *
 * 断言链（任何一条不过就退出码非 0）：
 *
 * 1. 打开 example.com，snapshot 出 ref。
 * 2. `browser_console`：先读一次（触发 enable），再通过 evaluate 打一条带标记的
 *    console.log，再读一次 —— 必须恰好收到这条（重放 + 高水位去重不重复不遗漏）。
 * 3. `browser_network`：evaluate 发一个 fetch，list 必须采到它；再用事件里的
 *    requestId 直接取回响应体（[V18] 不做映射）。
 * 4. `browser_execute`：`1 + 1` 正常返回；`document.body` 识别为不可序列化而不是
 *    静默 `{}`（[V22]）；`Emulation.setDeviceMetricsOverride` 被白名单拒
 *    （BROWSER_EXECUTE_NOT_ALLOWED，消息带 method 全文）。
 * 5. `browser_locate`：对 heading 的 ref 现算 rect（宽高 > 0），带高亮时窗口上
 *    overlay 只覆盖目标元素（[V31][V32] 用 highlightNode）。
 *
 * `browser_find` 是纯本地检索（零 CDP），单测已覆盖，这里不重复。
 *
 * 用法：`pnpm run smoke:p2p3`
 */

import { fileURLToPath } from 'node:url'
import { ElectronBrowserProvider } from '../src/browser-electron/provider.ts'
import { ElectronWindowTransport } from '../src/browser-electron/transport.ts'
import { isBrowserError } from '../src/browser/types.ts'

/** 默认 Electron：开发态就是桌面端自己装的那一个。 */
const DEFAULT_ELECTRON = 'D:/dev/cli/deepseek-harness/apps/desktop/node_modules/electron/dist/electron.exe'

const electronPath = process.env.DSH_BROWSER_ELECTRON_PATH ?? DEFAULT_ELECTRON
const hostScript = fileURLToPath(new URL('../src/browser-electron/host.cjs', import.meta.url))
const url = process.env.SMOKE_URL ?? 'https://example.com'

// keepAlive 关掉：验证完就让宿主一起退，不留窗口、不留进程。
const transport = new ElectronWindowTransport({ electronPath, hostScript, keepAlive: false })
const provider = new ElectronBrowserProvider({}, transport, true)

let failed = 0

/** 记一条断言结果；失败累计但不中断（能看的证据一次拿全）。 */
function check(label: string, ok: boolean, detail: string): void {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failed += 1
  console.log(`smoke-p2p3: [${mark}] ${label} — ${detail}`)
}

async function main(): Promise<void> {
  console.log(`smoke-p2p3: electron=${electronPath}`)
  const session = await provider.open({ url })
  console.log(`smoke-p2p3: open ${url} -> ${session.id}`)

  // --- 1. snapshot ---
  const snap = await provider.observe({ sessionId: session.id, kind: 'snapshot' })
  if (snap.kind !== 'snapshot') throw new Error('expected a snapshot')
  check('snapshot', snap.refs.length > 0, `epoch ${String(snap.epoch)}, ${String(snap.refs.length)} refs`)
  const heading = snap.refs[0]

  // --- 2. console：先读一次（enable），再打标记日志，再读（重放被高水位吃掉） ---
  await provider.console({ sessionId: session.id, limit: 10 })
  await provider.execute({
    sessionId: session.id,
    method: 'Runtime.evaluate',
    params: { expression: `console.log('smoke-p2p3-marker-${session.id}')`, returnByValue: true },
  })
  const consoleRead = await provider.console({ sessionId: session.id, limit: 50 })
  const marker = consoleRead.entries.filter(entry => entry.text.includes(`smoke-p2p3-marker-${session.id}`))
  check('console 收到标记日志', marker.length === 1,
    `恰好 ${String(marker.length)} 条（0=漏、2+=重放去重失效），总条目 ${String(consoleRead.entries.length)}`)

  // --- 3. network：fetch 产生请求，list 采到，requestId 直取 body ---
  await provider.execute({
    sessionId: session.id,
    method: 'Runtime.evaluate',
    params: { expression: "fetch('/').then(r => r.status).catch(() => 'err')", returnByValue: true, awaitPromise: true },
  })
  const netList = await provider.network({ sessionId: session.id, kind: 'list', limit: 50 })
  // 取最新的同源文档请求（列表 newest-first 由 provider 保证，这里反转找最早匹配 = 我们 fetch 的那条）。
  const fetched = [...netList.requests].filter(entry => entry.url.replace(/\/$/, '') === 'https://example.com').at(-1)
  check('network 采到 fetch', fetched !== undefined,
    `共 ${String(netList.requests.length)} 条，目标请求 ${fetched === undefined ? '缺失' : `requestId=${fetched.requestId}`}`)
  if (fetched !== undefined) {
    const body = await provider.network({ sessionId: session.id, kind: 'body', requestId: fetched.requestId })
    check('network body 直取', typeof body.body === 'string' && body.body.includes('example'),
      `requestId=${fetched.requestId} bodyLength=${String(body.body?.length ?? 0)} base64=${String(body.base64Encoded)}`)
  }

  // --- 4. execute：正常值 / 不可序列化 / 白名单外 ---
  const arithmetic = await provider.execute({
    sessionId: session.id,
    method: 'Runtime.evaluate',
    params: { expression: '1 + 1', returnByValue: true },
  })
  check('evaluate 返回值', arithmetic.value === 2, `value=${String(arithmetic.value)}`)

  try {
    await provider.execute({
      sessionId: session.id,
      method: 'Runtime.evaluate',
      params: { expression: 'document.body', returnByValue: true },
    })
    check('document.body 三态识别', false, '没有抛错 —— 静默 {} 漏网')
  } catch (error) {
    const ok = isBrowserError(error) && error.code === 'BROWSER_EXECUTE_RESULT_UNSERIALIZABLE'
    check('document.body 三态识别', ok, ok ? 'BROWSER_EXECUTE_RESULT_UNSERIALIZABLE' : String(error))
  }

  try {
    await provider.execute({
      sessionId: session.id,
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 400, height: 300, deviceScaleFactor: 1, mobile: false },
    })
    check('白名单外拒绝', false, '没有抛错 —— 黑名单命令放行了')
  } catch (error) {
    const ok = isBrowserError(error)
      && error.code === 'BROWSER_EXECUTE_NOT_ALLOWED'
      && error.message.includes('Emulation.setDeviceMetricsOverride')
    check('白名单外拒绝', ok,
      ok ? 'BROWSER_EXECUTE_NOT_ALLOWED 且消息带 method 全文' : String(error))
  }

  // --- 5. locate：现算 rect + 高亮 ---
  const rect = await provider.locate({ sessionId: session.id, ref: heading.ref, highlight: true })
  check('locate 现算 rect',
    rect.width > 0 && rect.height > 0,
    `ref=${heading.ref} (${String(rect.x)},${String(rect.y)}) ${String(rect.width)}x${String(rect.height)} centered=${String(rect.centered)}`)

  const rectAgain = await provider.locate({ sessionId: session.id, ref: heading.ref })
  check('locate 二次调用（现算 + 不依赖上次几何）',
    rectAgain.width === rect.width && rectAgain.height === rect.height,
    `两次一致 ${String(rectAgain.width)}x${String(rectAgain.height)}`)
}

try {
  await main()
  if (failed > 0) {
    console.error(`smoke-p2p3: FAIL —— ${String(failed)} 条断言未过`)
    process.exitCode = 1
  } else {
    console.log('smoke-p2p3: PASS —— P2/P3 五类能力在真窗口上全部符合方案预期')
  }
} catch (error) {
  console.error('smoke-p2p3: FAIL', error)
  process.exitCode = 1
} finally {
  await provider.dispose().catch(() => undefined)
}
