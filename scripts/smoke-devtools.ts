/**
 * 端到端验证「人工开着 DevTools 看页面时，agent 依然可用」—— 这次改动唯一有效的证据。
 *
 * 为什么单测顶不上：`toggleDevTools` 跑在 Electron 子进程（`host.cjs`）里，单测只有
 * 假通道；而这条行为的失败形态是**静默**的 —— `openDevTools` 不抛错也不打开，
 * `isDevToolsOpened()` 默默保持 false。所以必须起真的宿主、真的开一次 DevTools。
 *
 * 断言链（任何一条不过就退出码非 0）：
 *
 * 1. 基线：`provider.observe(snapshot)` 成功。
 * 2. 第一轮 `toggleDevTools()` 回报 `action=opened` **且** `isOpen=true` —— 证明真开了，
 *    不是「让位没成功导致的静默失败」；同时宿主**只发一条** `Inspector.detached`
 *    （reason=`devtools-opened`，Electron 原生的 `target closed` 被 `lettingGo` 状态位拦下）。
 * 3. **DevTools 开着时再 observe 一次，必须仍成功** ← 本次改动的核心。
 * 4. **连开 / 关 5 轮**：每轮开、关之后 observe 都成功，且**每次 snapshot 的 ref 纪元恰好 +1**
 *    —— 即开合 DevTools 本身没有推进纪元（方案 8.1 回归②：防 P3 误拿 `Inspector.detached`
 *    当失效信号去推纪元）。
 * 5. 每轮开 / 关都从**新的 takeover 通道**（方案 4.1.1）收到一条消息，`active` 依次 true / false。
 *
 * 用法：`pnpm run smoke:devtools`
 */

import { fileURLToPath } from 'node:url'
import { ElectronBrowserProvider } from '../src/browser-electron/provider.ts'
import { ElectronWindowTransport, tabHandle } from '../src/browser-electron/transport.ts'

/** 默认 Electron：开发态就是桌面端自己装的那一个。 */
const DEFAULT_ELECTRON = 'D:/dev/cli/deepseek-harness/apps/desktop/node_modules/electron/dist/electron.exe'

/** 连开 / 关的轮数（方案 8.1 回归②）。 */
const ROUNDS = 5

const electronPath = process.env.DSH_BROWSER_ELECTRON_PATH ?? DEFAULT_ELECTRON
const hostScript = fileURLToPath(new URL('../src/browser-electron/host.cjs', import.meta.url))
const url = process.env.SMOKE_URL ?? 'https://www.baidu.com'

// keepAlive 关掉：验证完就让宿主一起退，不留窗口、不留进程。
const transport = new ElectronWindowTransport({ electronPath, hostScript, keepAlive: false })
const provider = new ElectronBrowserProvider({}, transport, true)

/** 上一次 snapshot 的 ref 纪元；下一次必须恰好 +1。 */
let lastEpoch = 0

/**
 * 跑一次真实的 observe（走工具层那条路），返回一行人可读的结果；失败就抛。
 *
 * **纪元判据是「恰好 +1」而不是「等于基线」**：每次 `publish` 都推进纪元是 P0 的既有语义
 * （`refs.ts`），拿基线去比会永远不成立。要防的是**额外**的推进 —— 比如 detach 被误当失效
 * 信号（那会让 delta 变成 2）。
 */
async function observe(sessionId: string, label: string): Promise<string> {
  const started = Date.now()
  const result = await provider.observe({ sessionId, kind: 'snapshot' })
  if (result.kind !== 'snapshot') throw new Error(`${label}: expected a snapshot`)
  if (result.epoch !== lastEpoch + 1) {
    throw new Error(
      `${label}: ref epoch jumped ${String(lastEpoch)} -> ${String(result.epoch)} instead of +1 — a `
      + 'non-snapshot path advanced it (opening/closing DevTools must not; see 8.1 回归②)',
    )
  }
  lastEpoch = result.epoch
  return `${label}: ok — epoch ${String(result.epoch)}, ${String(result.refs.length)} refs, ${String(Date.now() - started)}ms`
}

/** 轮询等一个条件成立；超时就抛。host → 父进程是异步 TCP，不能假设消息已经到齐。 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function main(): Promise<void> {
  console.log(`smoke-devtools: electron=${electronPath}`)
  const session = await provider.open({ url })
  console.log(`smoke-devtools: open ${url} -> ${session.id}`)

  console.log(`smoke-devtools: ${await observe(session.id, 'baseline')}`)

  // 接管通知通道（方案 4.1.1）：**先挂订阅再开始开合**，晚挂会漏掉第一条。
  const takeovers: { tabId: string; active: boolean }[] = []
  const stopTakeover = await transport.onTakeover((tabId, active) => { takeovers.push({ tabId, active }) })

  // 让位会 detach 一次。宿主侧应当**只发一条** `Inspector.detached`，且 reason 是
  // `devtools-opened` —— Electron 自己给的那条 reason 恒为 `target closed`，会被宿主的
  // 状态位（`lettingGo`）拦下不发。多于一条就说明状态位没生效。
  const probe = await transport.connect(tabHandle(session.id))
  const detached: unknown[] = []
  probe.on('Inspector.detached', (params) => { detached.push(params) })

  for (let round = 1; round <= ROUNDS; round += 1) {
    // --- 打开 DevTools ---
    const opened = await transport.toggleDevTools()
    console.log(`smoke-devtools: [${round}] toggle -> ${JSON.stringify(opened)}`)
    if (opened.action !== 'opened') throw new Error(`[${round}] expected action=opened, got ${opened.action}`)
    if (!opened.isOpen) {
      throw new Error(`[${round}] openDevTools 静默失败：宿主回报 isOpen=false —— 让位没生效（调试器还 attach 着？）`)
    }
    if (round === 1) {
      const reasons = detached.map(item => (item as { reason?: unknown } | undefined)?.reason)
      console.log(`smoke-devtools: Inspector.detached -> ${JSON.stringify(reasons)}`)
      if (reasons.length !== 1 || reasons[0] !== 'devtools-opened') {
        throw new Error(`expected exactly one Inspector.detached (reason=devtools-opened), got ${JSON.stringify(reasons)}`)
      }
    }

    // ★ 核心断言：不 sleep，直接测。`toggleDevTools` 的 op 返回时状态已经落定，
    //   若这里要先 sleep 才能过，说明「打开后立刻接回」这句话不成立。
    console.log(`smoke-devtools: ${await observe(session.id, `[${round}] devtools-open`)}`)

    // --- 关掉 DevTools ---
    const closed = await transport.toggleDevTools()
    console.log(`smoke-devtools: [${round}] toggle -> ${JSON.stringify(closed)}`)
    if (closed.action !== 'closed') throw new Error(`[${round}] expected action=closed, got ${closed.action}`)
    if (closed.isOpen) throw new Error(`[${round}] DevTools 没关掉：宿主回报 isOpen=true`)

    console.log(`smoke-devtools: ${await observe(session.id, `[${round}] devtools-closed`)}`)
  }

  // takeover 断言：5 开 5 关 → 10 条，`active` 依次 true / false，且带的是本会话的 tabId。
  const expected = Array.from({ length: ROUNDS }, () => [true, false]).flat()
  await waitUntil(
    () => takeovers.length === expected.length,
    `takeover messages (${String(takeovers.length)}/${String(expected.length)})`,
  )
  const actives = takeovers.map(item => item.active)
  console.log(`smoke-devtools: takeover -> ${JSON.stringify(actives)}`)
  if (JSON.stringify(actives) !== JSON.stringify(expected)) {
    throw new Error(`expected takeover active sequence ${JSON.stringify(expected)}, got ${JSON.stringify(actives)}`)
  }
  if (takeovers.some(item => item.tabId !== session.id)) {
    throw new Error(`takeover carried the wrong tabId: ${JSON.stringify(takeovers)}`)
  }

  stopTakeover()
  probe.close()
}

try {
  await main()
  console.log(`smoke-devtools: PASS —— DevTools 开合 ${String(ROUNDS)} 轮期间 agent 依然可用，ref 纪元未被 detach 推进`)
} catch (error) {
  console.error('smoke-devtools: FAIL', error)
  process.exitCode = 1
} finally {
  await provider.dispose().catch(() => undefined)
}
