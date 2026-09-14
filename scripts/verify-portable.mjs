#!/usr/bin/env node
/**
 * 便携版发布前的**生产路径自检**：拿解压好的便携版目录，真起一次 dsh 桌面端宿主。
 *
 * ## 为什么需要它
 *
 * v0.1.0 与 v0.2.0 两个包发出去之后，插件**从来没有在打包形态下被起过一次**。
 * 两次都因此踩到「只有真启动才会暴露」的问题：
 *
 * - v0.1.0 / v0.2.0：profile 少了 `desktop-runtime-state.json`，登记的插件被
 *   `createPluginProfile()` 静默抹掉 —— 界面正常、插件没有，不报错。
 * - v0.2.0：出货 patch 里带着 keyless 验证用的 `fake-llm`，它接管 `llm/stream`，
 *   任何真实对话都会被换成脚本回放。
 *
 * 这两件事**都不会**被 `pnpm typecheck` / `pnpm test` / CI 构建拦住：那一行是合法配置，
 * 插件也是合法加载。只有「真起一次 + 读真图」才能发现。
 *
 * ## 它到底做了什么
 *
 * 不起 GUI、不需要 Electron。桌面端宿主的入口 `@deepseek-ai/dsh-desktop-host` 导出了
 * `runDesktopHost()`，可以直接调用 —— Electron 壳做了三件事：给宿主 fd3/fd4 管道、
 * 把 `dsh-app://app/*` 的请求转过去、把渲染进程开起来。本脚本只复刻前两件，
 * 拿到的 `/index.html` 与真启动**同源**（同一个 `assetHandler`、同一个 `clientModules`）。
 *
 * 断言（任一不过即退出码 1）：
 *   1. 插件目录的出货 patch 里没有 `llm/stream` 劫持行；profile 里没有越权的 overlay；
 *      `desktop-runtime-state.json` 在位（少了它插件会被静默抹掉）；
 *   2. `__DSH_BOOT__` 里存在插件的客户端行，且它的 bundle 能 200 拉下来、内容是合法模块；
 *   3. `--browser` 给了 Chrome 时，再验客户端半边真的在浏览器里注册成功
 *      （`<html>` 上的信标：`dshBrowserPlugin` / `Dock` / `ToolViews`）。
 *
 * 第 3 条**不断言状态条出现在 DOM 里**：状态条挂在会话面的 `conversation.input.dock` 上，
 * 而 `ui-conversation` 只在会话存在时才渲染那个 slot（空 home 会停在「选择工作区」页）。
 * 信标证明的是「bundle 被拉取、`apply` 跑过、slot 注册成功」—— 这正是打包回归会破坏的部分；
 * DOM 可见性依赖会话状态，不适合当发布闸门。
 *
 * ## 用法
 *
 * ```bash
 * # 先解压便携版，然后：
 * pnpm run verify:portable -- --dir D:/tmp/dsh-v021-run
 * # 想在真浏览器里再确认一次客户端注册：
 * pnpm run verify:portable -- --dir D:/tmp/dsh-v021-run \
 *     --browser "C:/Program Files/Google/Chrome/Application/chrome.exe"
 * ```
 *
 * `--dir` 里 `home/` 的设置与凭据会被复制到一次性 home（`--home` 可指定，`--keep-home` 保留），
 * **不会**动包里那份；因此可以反复跑。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/* ---------- 参数 ---------- */

const FLAGS = new Set(['--dir', '--profile', '--browser', '--home', '--port', '--cdp-port'])

function parseArgs(argv) {
  const options = { profile: 'desktop', port: 19333, cdpPort: 19222 }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--keep-home') { options.keepHome = true; continue }
    if (!FLAGS.has(flag)) throw new Error(`verify-portable: 未知参数 ${JSON.stringify(flag)}`)
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`verify-portable: ${flag} 缺值`)
    i += 1
    if (flag === '--dir') options.dir = value
    else if (flag === '--profile') options.profile = value
    else if (flag === '--browser') options.browser = value
    else if (flag === '--home') options.home = value
    else if (flag === '--port') options.port = Number(value)
    else options.cdpPort = Number(value)
  }
  if (options.dir === undefined) throw new Error('verify-portable: 需要 --dir <解压后的便携版目录>')
  return options
}

const options = parseArgs(process.argv.slice(2))
const packageRoot = resolve(options.dir)
const resourcesRoot = join(packageRoot, 'app', 'resources')
const runtimeDir = join(resourcesRoot, 'dsh')
const profileDir = join(packageRoot, 'home', 'profiles', options.profile)

for (const path of [join(packageRoot, 'app'), runtimeDir]) {
  if (!existsSync(path)) throw new Error(`verify-portable: ${path} 不存在 —— --dir 要指到解压后的便携版根目录（里面有 app/）`)
}

const failures = []
const notes = []

function check(ok, message) {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures.push(message)
  return ok
}

/* ---------- 1. 插件目录的静态检查 ---------- */

console.log(`\n[1/3] 便携版内容（profile=${options.profile}）`)

const shippedPluginDir = join(profileDir, 'node_modules', 'dsh-webops-plugin')
check(existsSync(shippedPluginDir), '插件已物化到 profile 的 node_modules')

if (existsSync(shippedPluginDir)) {
  const shippedPatch = readFileSync(join(shippedPluginDir, 'cordis.patch.yml'), 'utf8')
  const body = shippedPatch.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  for (const hijacker of ['fake-llm', 'llm-replay', 'mock-llm']) {
    check(!body.includes(hijacker), `出货 patch 不含 ${hijacker}（它会接管 llm/stream，把真实对话换成假回放）`)
  }
  check(body.includes('dsh-webops-plugin/browser-cdp'), '出货 patch 含 browser-cdp 行')
  check(body.includes('dsh-webops-plugin/browser-electron'), '出货 patch 含 browser-electron 行')
  check(body.includes('dsh-webops-plugin/tool-browser'), '出货 patch 含 tool-browser 行')
  check(/name:\s*['"]?dsh-webops-plugin['"]?\s*$/mu.test(body), '出货 patch 含裸包名行（客户端半边靠它被发现）')
  check(existsSync(join(shippedPluginDir, 'lib', 'client.js')), '客户端产物 lib/client.js 在包里')
  check(existsSync(join(shippedPluginDir, 'lib', 'tool-browser', 'index.js')), '工具产物 lib/tool-browser/index.js 在包里')
}

check(existsSync(join(profileDir, 'desktop-runtime-state.json')),
  'desktop-runtime-state.json 在位（缺了它插件登记会被静默抹掉）')
check(!existsSync(join(profileDir, 'cordis.patch.yml')),
  'profile 里没有越权 overlay（出货包不该带 profile 级 patch）')

/* ---------- 2. 真起宿主，读 boot graph ---------- */

console.log('\n[2/3] 生产路径启动宿主并读取 __DSH_BOOT__')

const scratchHome = options.home === undefined
  ? mkdtempSync(join(tmpdir(), 'dsh-verify-home-'))
  : resolve(options.home)
mkdirSync(scratchHome, { recursive: true })
const packagedHome = join(packageRoot, 'home')
if (options.home === undefined && existsSync(packagedHome)) {
  for (const entry of ['settings.yaml', '.credentials.yaml', '.anonymous-user-id']) {
    const from = join(packagedHome, entry)
    if (existsSync(from)) cpSync(from, join(scratchHome, entry))
  }
}

const require = createRequire(join(runtimeDir, 'package.json'))
const { runDesktopHost } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-desktop-host')).href)

// 必须把 DSH_HOME 指到一次性 home：`loadLayeredEnv` 在 boot 时读它，不设就会落到
// 开发机自己的 `~/.dsh`（那份可能有正在运行的实例持有 .credentials.yaml.lock，
// 表现为 boot 挂在 writer lock 上而不是报错）。
process.env.DSH_HOME = scratchHome
// 上一次跑到一半被杀留下的锁会让下一次 boot 直接超时，先清掉。
rmSync(join(scratchHome, '.credentials.yaml.lock'), { force: true })

const FRAME_MAGIC = 1146308659
const FRAME_HEADER_BYTES = 13
const STREAM_START = 1
const STREAM_DATA = 2
const STREAM_END = 3
const STREAM_ERROR = 4
/** 每个 streamId 一个响应槽：start / data / end / error。 */
const sinks = new Map()
let decoderBuffer = Buffer.alloc(0)

/** 增量解码宿主响应管道（与 Electron 壳的 DesktopHostResponseDecoder 同协议）。 */
function feedResponsePipe(chunk) {
  decoderBuffer = decoderBuffer.byteLength === 0
    ? Buffer.from(chunk)
    : Buffer.concat([decoderBuffer, Buffer.from(chunk)])
  for (;;) {
    if (decoderBuffer.byteLength < FRAME_HEADER_BYTES) return
    if (decoderBuffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('响应帧标记不对（宿主协议版本不匹配？）')
    const type = decoderBuffer.readUInt8(4)
    const streamId = decoderBuffer.readUInt32BE(5)
    const length = decoderBuffer.readUInt32BE(9)
    if (decoderBuffer.byteLength < FRAME_HEADER_BYTES + length) return
    const payload = decoderBuffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)
    decoderBuffer = decoderBuffer.subarray(FRAME_HEADER_BYTES + length)
    const sink = sinks.get(streamId)
    if (sink === undefined) continue
    if (type === STREAM_START) sink.start(JSON.parse(payload.toString('utf8')))
    else if (type === STREAM_DATA) sink.data(payload)
    else if (type === STREAM_END) { sinks.delete(streamId); sink.end() }
    else if (type === STREAM_ERROR) { sinks.delete(streamId); sink.error(JSON.parse(payload.toString('utf8')).message) }
  }
}

const host = await runDesktopHost(runtimeDir, profileDir, async (frame) => feedResponsePipe(frame), {
  allowLinkedPackages: true,
})

// 宿主只认 URL 的 pathname，给个绝对 URL 即可。
const ORIGIN = `http://127.0.0.1:${String(options.port)}`
let nextStreamId = 1

/** 走宿主的 fetch 通道取一个路径，把响应缓冲成完整 body。 */
async function hostFetch(pathname) {
  const streamId = nextStreamId++
  const chunks = []
  let status = 0
  const done = new Promise((resolvePromise, rejectPromise) => {
    sinks.set(streamId, {
      start: (meta) => { status = meta.status },
      data: (payload) => chunks.push(payload),
      end: () => resolvePromise({ status, body: Buffer.concat(chunks) }),
      error: (message) => rejectPromise(new Error(message)),
    })
  })
  await host.fetch({ streamId, request: { url: `${ORIGIN}${pathname}`, method: 'GET', headers: [] } }, null)
  return await done
}

const index = await hostFetch('/index.html')
check(index.status === 200, `/index.html 返回 200（实际 ${String(index.status)}）`)

const html = index.body.toString('utf8')
const marker = html.indexOf('__DSH_BOOT__')

let pluginEntry
if (check(marker >= 0, '__DSH_BOOT__ 已注入首页（clientModules 构造成功）')) {
  const braceAt = html.indexOf('{', marker)
  let depth = 0
  let end = -1
  for (let i = braceAt; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1
    else if (html[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  const graph = JSON.parse(html.slice(braceAt, end))
  check(graph.entries.length > 40, `boot graph 有 ${String(graph.entries.length)} 行`)
  pluginEntry = graph.entries.find((entry) => entry.id === 'dsh-webops-plugin')
  check(pluginEntry !== undefined, 'boot graph 里存在 dsh-webops-plugin（客户端半边被发现）')
}

if (pluginEntry !== undefined) {
  const bundle = await hostFetch(pluginEntry.url)
  const text = bundle.body.toString('utf8')
  check(bundle.status === 200, `插件客户端 bundle 可拉取（${String(bundle.body.byteLength)} 字节）`)
  check(text.includes('__ModuleLoader__.load'), 'bundle 是合法客户端模块（执行时注册自身工厂）')
  check(text.includes('conversation.input.dock'), 'bundle 含 input dock 注册目标')
  check(text.includes('tool.call.toolview'), 'bundle 含工具卡片注册目标')
}

/* ---------- 3. 可选：真浏览器里确认客户端注册 ---------- */

if (options.browser === undefined) {
  console.log('\n[3/3] 跳过浏览器验证（没给 --browser，客户端注册那一步未验）')
} else {
  console.log('\n[3/3] 真浏览器里确认客户端半边注册')

  const hopByHop = new Set(['content-encoding', 'transfer-encoding', 'content-length', 'connection'])
  const proxy = createServer((req, res) => {
    const streamId = nextStreamId++
    sinks.set(streamId, {
      start: (meta) => {
        res.statusCode = meta.status
        for (const [name, value] of meta.headers) {
          if (!hopByHop.has(name.toLowerCase())) res.setHeader(name, value)
        }
      },
      data: (payload) => { res.write(payload) },
      end: () => { res.end() },
      error: (message) => { res.end(message) },
    })
    const headers = Object.entries(req.headers)
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value ?? '')])
    host.fetch({ streamId, request: { url: `${ORIGIN}${req.url ?? '/'}`, method: req.method ?? 'GET', headers } }, null)
      .catch((error) => { res.end(String(error)) })
  })
  await new Promise((resolvePromise) => proxy.listen(options.port, '127.0.0.1', resolvePromise))

  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-verify-chrome-'))
  const chrome = spawn(options.browser, [
    '--headless=new',
    `--remote-debugging-port=${String(options.cdpPort)}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' })

  async function cdpJson(path) {
    for (let i = 0; i < 80; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(options.cdpPort)}${path}`)
        if (response.ok) return await response.json()
      } catch { /* 还没起来 */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
    throw new Error(`verify-portable: CDP 未就绪（--cdp-port ${String(options.cdpPort)} 被占？）`)
  }

  try {
    const version = await cdpJson('/json/version')
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolvePromise, reject) => {
      socket.addEventListener('open', resolvePromise, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    let messageId = 0
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    })
    const send = (method, params = {}, sessionId) => new Promise((resolvePromise) => {
      const id = (messageId += 1)
      pending.set(id, resolvePromise)
      socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
    })

    const target = await send('Target.createTarget', { url: 'about:blank' })
    const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })
    const session = attached.result.sessionId
    await send('Runtime.enable', {}, session)
    await send('Page.navigate', { url: `${ORIGIN}/` }, session)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15000))

    const probe = await send('Runtime.evaluate', {
      expression: '({...document.documentElement.dataset})',
      returnByValue: true,
    }, session)
    const dataset = probe.result?.result?.value ?? {}
    check(dataset.dshBrowserPlugin === '1', '客户端 bundle 执行过（dataset.dshBrowserPlugin=1）')
    check(Number(dataset.dshBrowserPluginDock ?? 0) >= 1, 'input dock 注册成功（dataset.dshBrowserPluginDock≥1）')
    check(Number(dataset.dshBrowserPluginToolViews ?? 0) >= 15, '工具卡片全部注册（dataset.dshBrowserPluginToolViews≥15）')
    notes.push('空 home 会停在「选择工作区」页，所以状态条不会出现在 DOM 里 —— 信标已证明它注册成功')
  } finally {
    chrome.kill()
    proxy.close()
    // Chrome 退出时还攥着 crashpad 的 .pma 句柄，删目录必然 EBUSY；临时目录，删不掉就算了。
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch { /* Chrome 还没退干净，留给系统清 */ }
  }
}

/* ---------- 收尾 ---------- */

await host.dispose()
if (!options.keepHome) {
  try {
    rmSync(scratchHome, { recursive: true, force: true })
  } catch { /* 临时目录，删不掉不影响结论 */ }
}

console.log('')
for (const note of notes) console.log(`注：${note}`)
if (notes.length > 0) console.log('')

if (failures.length > 0) {
  console.error(`verify-portable: ${String(failures.length)} 项不通过：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('verify-portable: 全部通过。')
