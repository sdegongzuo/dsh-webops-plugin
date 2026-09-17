/**
 * 验证便携版里「agent 调 `webpage_open` 能开出真窗口」这条链 —— **全程自动**。
 *
 * ## 为什么要有这个脚本
 *
 * 2026-09-15 主上在真机上反馈「没法调用打开新的窗口」，2026-09-17 又撞上
 * `multiple usable browser providers are registered (cdp, electron)`。两次都是
 * **打包形态才有**的病，而当时的三道自检全绿：
 *
 *   · `verify:portable` 只看包的结构（profile、完整性、asar 里的补丁代码）——
 *     它证明「东西都在」，不证明「窗口真能开出来」；
 *   · `verify:ptc` 只管 `run_code` 那条链；
 *   · `window:desktop` / `smoke:window` 跑在**开发态**（用未打包的 electron.exe，
 *     且 `dev-desktop.mjs` 会替我们把 `DSH_BROWSER_PROVIDER` 设好）—— 打包态的病它们看不见。
 *
 * 于是「开窗口」这条链长期处在**只能靠主上真机点一遍**的状态。本脚本把它拉进自动化：
 * 不碰 profile、不需要 API key、不需要模型，把**包内编译产物**当生产代码跑。
 *
 * ## 它验的是什么
 *
 * 1. **窗口链**：用包内 `lib/browser-electron` 构造
 *    `ElectronWindowTransport(appMode: true)` + `ElectronBrowserProvider`，然后
 *
 *        spawn(主 exe, --user-data-dir=…)   ← main.ts 早期分支接管 → require(host.cjs)
 *          → 宿主开 BaseWindow + WebContentsView，从 stdout 宣布端口
 *          → 插件连 TCP、发 {op:'open'} 真导航
 *          → 发 {op:'cdp'} 取快照 / 截图
 *
 * 2. **provider 选择**：`cdp` 与 `electron` 同时可用时会不会撞 `BROWSER_PROVIDER_AMBIGUOUS`。
 *    这一段做**正反两向**断言（不设 env 必须抛、设了必须选中 electron）——
 *    单向断言只能证明「能过」，证明不了「它真能发现这个问题」。
 *
 * ## 它验不了什么（两件，必须留给人）
 *
 * - **模型真的调用 `webpage_open`**：需要一个能用的 API key，key 只在用户机器上；
 * - **窗口外观**：截图（`--out` 落盘）能替代一部分，「窗口在屏幕上、拖得动」只能人看。
 *
 * ## 一个实现上的坑（踩过）
 *
 * 直接 `import` 包内产物是不行的：`lib/browser-electron/index.js` 里 import 了
 * `@deepseek-ai/schemastery`，而 profile 的 `node_modules` **只有插件自己**（dsh 的包
 * 全在 `app/resources/dsh/node_modules`，由宿主的解析环境供给）。
 * 所以这里复刻宿主的解析环境：临时目录里放插件产物的一份**拷贝** + 一条指向 runtime
 * `@deepseek-ai` 的 junction。用拷贝而不是 junction 指回产物，是因为 ESM 默认解析真实路径
 * （realpath），junction 指回去等于没换地方，裸包名照样解析不到。
 *
 * 用法：
 *
 * ```bash
 * node scripts/verify-browser-host.mjs --dir <解压后的便携包根目录>
 * node scripts/verify-browser-host.mjs --dir <包根> --url https://www.baidu.com --out dist/win.png
 * ```
 *
 * 退出码 0 = 通过，1 = 失败。`--dir` 可以是启动过的目录（本脚本只读产物，不写 profile）。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeRuntimeDir } from './desktop-runtime.mjs'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

if (readArg('dir') === undefined) {
  console.error('用法: node scripts/verify-browser-host.mjs --dir <解压后的便携包根目录> [--url <页面>] [--out <png>]')
  process.exit(1)
}

const packageRoot = resolve(readArg('dir'))
const appRoot = join(packageRoot, 'app')
const explicitUrl = readArg('url')
const shotOut = resolve(readArg('out') ?? 'verify-browser-host.png')

const failures = []
function check(ok, message) {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures.push(message)
}

console.log('\n[1/5] 前置文件（这套自检只认包内产物，不用源码）')

const exeName = existsSync(appRoot)
  ? readdirSync(appRoot).find(name => name.toLowerCase().endsWith('.exe') && !/uninstall|elevate/iu.test(name))
  : undefined
const exePath = exeName === undefined ? undefined : join(appRoot, exeName)
check(exePath !== undefined, `app/ 里有主 exe（${String(exeName)}）`)

const artifactPluginDir = join(packageRoot, 'home', 'profiles', 'desktop', 'node_modules', 'dsh-webops-plugin')
const artifactLibDir = join(artifactPluginDir, 'lib', 'browser-electron')
check(existsSync(join(artifactLibDir, 'index.js')), '包内插件产物 lib/browser-electron/index.js 在')
check(existsSync(join(artifactLibDir, 'host.cjs')), '包内窗口宿主 lib/browser-electron/host.cjs 在')

if (exePath === undefined || !existsSync(join(artifactLibDir, 'index.js'))) {
  console.log('\n前置文件缺失，后续真跑无意义。')
  process.exit(1)
}

console.log('\n[2/5] 复刻宿主的模块解析环境（产物拷贝 + runtime 的 @deepseek-ai）')

const materialized = materializeRuntimeDir(appRoot)
const probeModules = join(mkdtempSync(join(tmpdir(), 'dsh-verify-browser-')), 'node_modules')
mkdirSync(probeModules, { recursive: true })
const sharedScope = join(materialized.runtimeDir, 'node_modules', '@deepseek-ai')
check(existsSync(sharedScope), `runtime 里有 @deepseek-ai（${sharedScope}）`)
symlinkSync(sharedScope, join(probeModules, '@deepseek-ai'), 'junction')

const probePluginDir = join(probeModules, 'dsh-webops-plugin')
cpSync(artifactPluginDir, probePluginDir, { recursive: true })
const libEntry = join(probePluginDir, 'lib', 'browser-electron', 'index.js')
const libDir = join(probePluginDir, 'lib')
const hostScript = join(libDir, 'browser-electron', 'host.cjs')

console.log('\n[3/5] 本地探针页（默认不依赖外网；给了 --url 就用它）')

// 探针页：标题、正文、可交互元素各一个，断言时逐字对 ——
// 「页面开了但没加载」会漏掉标题，而 ref 只给可交互节点，光有 h1 会得到 0 个 ref
// （第一次写这页就栽在「0 个 ref」上，那不是 bug，是我的页面没有可交互元素）。
const PROBE_TITLE = 'dsh-webops 窗口宿主自检'
const PROBE_TEXT = '窗口宿主可用'
let server
let url = explicitUrl
if (url === undefined) {
  const html = `<!doctype html><meta charset="utf-8"><title>${PROBE_TITLE}</title>`
    + `<h1 id="verdict">${PROBE_TEXT}</h1><a id="link" href="https://example.com/">探针链接</a>`
    + `<button id="btn" type="button">探针按钮</button>`
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  url = `http://127.0.0.1:${String(server.address().port)}/`
  console.log(`  · 探针页起在 ${url}`)
} else {
  console.log(`  · 用外部地址 ${url}`)
}

console.log('\n[4/5] 用包内产物真开一个窗口并走 CDP')

const lib = await import(pathToFileURL(libEntry).href)
const transport = new lib.ElectronWindowTransport({
  // 打包态没有独立 electron.exe：窗口宿主就是桌面端主 exe 自己（app 模式）。
  electronPath: exePath,
  hostScript,
  appMode: true,
  keepAlive: false,
})
const provider = new lib.ElectronBrowserProvider({}, transport, true)

let session
let snapshot
let shot
const started = Date.now()
try {
  check(provider.id === 'electron', `provider id = electron（实际 ${String(provider.id)}）`)
  check(provider.available(), 'provider 自认可用（enabled=true）')
  session = await provider.open({ url })
  check(true, `窗口开出来了（${String(Date.now() - started)}ms，session=${session.id}）`)
  console.log(`  · session: url=${session.url} title=${JSON.stringify(session.title)}`)
  snapshot = await provider.observe({ sessionId: session.id, kind: 'snapshot' })
  shot = await provider.observe({ sessionId: session.id, kind: 'screenshot' })
} catch (error) {
  check(false, `开窗口/观察失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  try { if (session !== undefined) await provider.close(session.id) } catch { /* 收尾失败不影响结论 */ }
  try { await provider.dispose() } catch { /* 同上 */ }
  if (server !== undefined) server.close()
}

check(session !== undefined, '拿到会话')
if (session !== undefined) {
  check(session.url === url || session.url.replace(/\/$/u, '') === url.replace(/\/$/u, ''),
    `会话落在目标地址上（实际 ${session.url}）`)
}
if (explicitUrl === undefined) {
  check(session?.title === PROBE_TITLE, `页面标题读到了（期望 ${JSON.stringify(PROBE_TITLE)}，实际 ${JSON.stringify(session?.title)}）`)
  check(snapshot?.outline?.includes(PROBE_TEXT) === true, `快照大纲含页面正文（${PROBE_TEXT}）`)
}
check((snapshot?.refs?.length ?? 0) > 0, `快照出了 ref（${String(snapshot?.refs?.length ?? 0)} 个）`)
check((snapshot?.outline?.length ?? 0) > 0, `快照大纲非空（${String(snapshot?.outline?.length ?? 0)} 字符）`)
check(readFileSync(libEntry).byteLength > 0, '包内插件产物不是空文件')

const shotBytes = shot?.data?.byteLength ?? 0
check(shotBytes > 1000, `截图有内容（${shotBytes} 字节）`)
if (shotBytes > 0) {
  const png = Buffer.from(shot.data)
  const isPng = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
  check(isPng, '截图是合法 PNG（魔数对）')
  try {
    writeFileSync(shotOut, png)
    console.log(`  · 截图已落盘：${shotOut}`)
  } catch (error) {
    check(false, `截图落盘失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\n[5/5] provider 选择：cdp 与 electron 同时可用时不能撞 ambiguous')

// 桌面端里两个 provider 会**同时**「可用」：
//   · browser-cdp 的 available() 是乐观的（探测不到就返回 true，把精确诊断留给 open()）；
//   · browser-electron 由出货 patch 带着 `enabled: true`。
// 没人指定 provider 时能力缝隙抛 BROWSER_PROVIDER_AMBIGUOUS —— 2026-09-17 主上真机撞的就是这个，
// 而当时 profile 一切正常（`config.provider` 根本写不进去：桌面端 profile 每次重建）。
// 兜底值是 shell 在 main.ts 顶层落的 `DSH_BROWSER_PROVIDER=electron`
// （存在性由 `verify:portable` 的 asar 断言守）。
const cordis = await import('@deepseek-ai/cordis')
const browserLib = await import(pathToFileURL(join(libDir, 'browser', 'index.js')).href)

/** 造一个 ctx：真 electron provider + 一个「可用」的 cdp 桩（只需 id 与 available）。 */
async function resolveWith(envValue) {
  const previous = process.env.DSH_BROWSER_PROVIDER
  if (envValue === undefined) delete process.env.DSH_BROWSER_PROVIDER
  else process.env.DSH_BROWSER_PROVIDER = envValue
  try {
    const ctx = new cordis.Context()
    await ctx.plugin(browserLib.default, {})
    ctx.browser.registerProvider({ id: 'cdp', available: () => true })
    ctx.browser.registerProvider(new lib.ElectronBrowserProvider({}, new lib.ElectronWindowTransport({
      electronPath: exePath, hostScript, appMode: true, keepAlive: false,
    }), true))
    // resolve() 是私有的：这里量的是「能力缝隙选了谁」，跟它的公开方法无关，
    // 所以直接问它，不绕 open()（那会真开窗口）。
    return { id: ctx.browser['resolve']().id }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (previous === undefined) delete process.env.DSH_BROWSER_PROVIDER
    else process.env.DSH_BROWSER_PROVIDER = previous
  }
}

const unset = await resolveWith(undefined)
check(unset.error !== undefined && /multiple usable browser providers/u.test(unset.error),
  `反向：不设 env 时必须撞 ambiguous（实际 ${unset.error === undefined ? `选中了 ${String(unset.id)}` : unset.error}）`)
const set = await resolveWith('electron')
check(set.id === 'electron', `正向：设成 electron 后选中 electron（实际 ${set.error === undefined ? String(set.id) : set.error}）`)

rmSync(probeModules, { recursive: true, force: true })
materialized.cleanup()

if (failures.length > 0) {
  console.log(`\n✗ verify:browser-host 未通过（${failures.length} 项）`)
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
console.log('\n✓ verify:browser-host 通过：包内产物能在打包 exe 上开出真窗口（open → 快照 → 截图），')
console.log('  且 cdp/electron 同时可用时的 provider 选择不再撞 ambiguous。')
console.log('  仍未覆盖：模型真的调用 webpage_open（要 API key）、窗口外观（要人眼）。')
// 宿主 keepAlive=false，连接一断就自己退；显式退出免得等它。
process.exit(0)
