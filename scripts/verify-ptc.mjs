/**
 * 验证便携版里 PTC（`run_code`）能真正跑起来。
 *
 * 背景（2026-09-17 定位）：`run_code` 的实际执行体是 `@deepseek-ai/dsh-ptc-runtime-node`
 * 拉起的一个**子进程**。它在 spawn 时会把子进程环境清空到只剩
 * PATH/PATHEXT/SYSTEMROOT/WINDIR/TEMP/TMP，再按 `'pkg' in process` 这个 vercel/pkg 标记
 * 决定要不要补自己的启动变量；`nodeExecutable` 默认取 `process.execPath`。
 *
 * 桌面端打包态里这两条同时踩雷：
 *   · `process.execPath` 是 Electron 主 exe（不是 node），它靠 host 子进程注入的
 *     `ELECTRON_RUN_AS_NODE=1` 才以 node 模式运行；
 *   · 那个变量正好在 ptc-runtime-node 的清空范围里 —— 被删掉。
 * 于是 PTC 子进程启起的是 Electron GUI，stdin/stdout 上的控制协议永远建立不起来，
 * `run_code` 一直挂到超时。症状是「ptc 模式下工具起不来」，且**只在打包态复现**
 * （开发态 `process.execPath` 本来就是 node，所以本地开发永远看不到）。
 *
 * 修复：shell 在 `main.ts` 顶层把 `DSH_PTC_NODE` 指向包内自带的真 node
 * （`resources\runtime\node\node.exe`），desktop-host 的 composition patch 把它写进
 * `ptc-runtime` 行的 `nodeExecutable`（见 `docs/harness-desktop-build.patch`）。
 *
 * 本脚本在**真产物的生产路径**上把这条链走一遍：起宿主 → 让 ptc 真跑一段 TS 程序 →
 * 断言返回值。只验「服务存在」不够 —— 服务一直在，挂的是子进程本身。
 *
 * ## 2026-09-17 第二次修正：这个自检原先有**两个盲区**，都让同一类坑溜了过去
 *
 * 坑本身是同一句话的第二层：`process.execPath` 在打包态是 Electron 主 exe。ptc 自己的
 * node 已经由 `DSH_PTC_NODE` 修好，但**沙箱 runner 也在用它** ——
 * `dsh-sandbox-local` 的 `windowsAclRunnerInvocation()` 返回 `[process.execPath, runner.js]`，
 * 于是 runner.js 被交给 Electron 当 GUI 起（环境清了，没有 ELECTRON_RUN_AS_NODE），
 * 撞单实例锁、退出 0、零输出 → `worker-exit: Node process exited before completing (0)`。
 * 只在**会话权限是 workspace-write**（桌面端默认）时才走沙箱，所以症状是
 * 「run_code 一律起不来」。修法见 harness patch 里的 `runnerExecutable()`。
 *
 * 两个盲区（现在都堵上了）：
 *   1. 探针原先不带 `sandboxPolicy` → `ctx.sandboxPolicy.resolve()` 给 full-access →
 *      `confine()` 整段被跳过。**沙箱那条链断了也照样全绿**。现在显式用
 *      workspace-write 再跑一次，并断言 `sandbox.mode`。
 *   2. 更根本：本脚本起的宿主是**普通 node**，`process.execPath` 本来就是 node ——
 *      跟上面那条坑一模一样的链路，在普通 node 宿主下**永远测不出来**。
 *      所以新增一段：用包内主 exe + `ELECTRON_RUN_AS_NODE=1` 把宿主跑在**真 Electron
 *      运行时**里，直接问沙箱「你要用哪个程序起 runner」，断言它不是主 exe。
 *      —— 这一段是那个坑的唯一真凭据，删了它这个 bug 会再次静默复发。
 *
 * 用法：
 *   node scripts/verify-ptc.mjs --dir <解压后的便携包根目录>
 *   node scripts/verify-ptc.mjs --dir <包根> --expect 42
 *
 * 退出码 0 = 通过，1 = 失败。`--dir` 必须是**刚解压、没启动过的**目录（同 verify:portable）。
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeRuntimeDir } from './desktop-runtime.mjs'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

const packageRoot = resolve(readArg('dir') ?? '')
const expected = readArg('expect') ?? '42'
// 沙箱那一次跑的程序不同，好让两侧的返回值能区分开（不至于一次成功掩盖另一次）。
const confinedExpected = '43'
if (readArg('dir') === undefined) {
  console.error('用法: node scripts/verify-ptc.mjs --dir <解压后的便携包根目录> [--expect 42]')
  process.exit(1)
}

const appRoot = join(packageRoot, 'app')
const materialized = materializeRuntimeDir(appRoot)
const runtimeDir = materialized.runtimeDir
const failures = []

function check(ok, message) {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures.push(message)
}

// 在 Electron 运行时里跑的小探针：只想问一句「沙箱打算用哪个程序起 windows-acl runner」。
// 路径都走 argv 传，源码里不出现模板插值（这个字符串本身是模板字面量）。
const RUNNER_PROBE_SOURCE = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [runtimeDir, workspace, out] = process.argv.slice(2)
const report = {
  execPath: process.execPath,
  electron: process.versions.electron ?? null,
  runnerProgram: undefined,
  argv: undefined,
}
try {
  const entry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js')
  const mod = await import(pathToFileURL(entry).href)
  const cordis = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
  const provider = new mod.default(new cordis.Context(), {
    runnerCommand: [],
    runnerFailureSignatures: [],
    probeTimeoutMs: 5000,
  })
  const confined = await provider.confine(['node', '-e', '1'], { mode: 'workspace-write', workspaceRoot: workspace })
  report.runnerProgram = confined.argv[0]
  report.argv = confined.argv
} catch (error) {
  report.threw = String(error && error.stack ? error.stack : error)
}
writeFileSync(out, JSON.stringify(report, null, 2))
`.trim() + '\n'

console.log(`\n[1/4] 修复所需的前置文件（runtime=${materialized.layout}）`)

// 真 node 必须随包进来 —— 修复完全依赖它。
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const nodePath = join(appRoot, 'resources', 'runtime', 'node', nodeName)
let nodeOk = false
try {
  nodeOk = readFileSync(nodePath).byteLength > 0
} catch { nodeOk = false }
check(nodeOk, `包内自带真 node：app/resources/runtime/node/${nodeName}`)

// desktop-host 的 composition patch 必须真的覆盖了 ptc-runtime 行。
const overlayPath = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'config', 'desktop.cordis.patch.yml')
let overlay = ''
try { overlay = readFileSync(overlayPath, 'utf8') } catch { overlay = '' }
check(/id:\s*ptc-runtime/u.test(overlay), 'desktop-host patch 里有 ptc-runtime 覆盖行')
check(/DSH_PTC_NODE/u.test(overlay), 'desktop-host patch 读 DSH_PTC_NODE')

// ptc 运行时包本体（0.1.6 起才有）。
let runtimeJson = {}
try { runtimeJson = JSON.parse(readFileSync(join(runtimeDir, 'desktop-runtime.json'), 'utf8')) } catch { runtimeJson = {} }
const shared = new Set((runtimeJson.sharedPackages ?? []).map(entry => entry.name))
check(shared.has('@deepseek-ai/dsh-ptc-runtime-node'), 'runtime 携带 @deepseek-ai/dsh-ptc-runtime-node')

if (!nodeOk) {
  console.log('\n前置文件缺失，后续真跑无意义。')
  materialized.cleanup()
  process.exit(1)
}

console.log('\n[2/4] 生产路径启动宿主并在 ptc 模式下真跑一段程序')

const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-verify-ptc-')))
const profileDir = join(home, 'profiles', 'desktop')
const probeDir = join(profileDir, 'node_modules', 'ptc-probe')
const reportPath = join(home, 'report.json')
// 沙箱那一次跑的 workspaceRoot：必须是真存在的绝对目录。
const workspace = join(home, 'ptc-workspace')
mkdirSync(probeDir, { recursive: true })
mkdirSync(workspace, { recursive: true })

// 探针插件：宿主 controller 不暴露 ctx，只能用一个真挂进 profile 的行来读服务。
writeFileSync(join(probeDir, 'package.json'), `${JSON.stringify({
  name: 'ptc-probe', version: '1.0.0', type: 'module', main: './index.js',
  exports: { '.': { default: './index.js' } },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)}\n`)
writeFileSync(join(probeDir, 'cordis.patch.yml'), [
  '- insert:',
  '    - id: ptc-probe',
  "      name: 'ptc-probe'",
  '      config:',
  `        report: '${reportPath.replace(/\\/g, '/')}'`,
  `        workspace: '${workspace.replace(/\\/g, '/')}'`,
  '',
].join('\n'))
writeFileSync(join(probeDir, 'index.js'), `
import { writeFileSync } from 'node:fs'

export const name = 'ptc-probe'

export function apply(ctx, config) {
  const report = { ptcRuntime: false }
  const flush = () => writeFileSync(config.report, JSON.stringify(report, null, 2))
  flush()
  ctx.inject(['ptcRuntime'], async (c) => {
    report.ptcRuntime = true
    const runtime = c.get('ptcRuntime')
    report.language = runtime?.language
    flush()
    // 1) 显式给 sandboxPolicy：必须真走一遍 confine()。
    //    2026-09-17 之前这里不带 sandboxPolicy，于是 ctx.sandboxPolicy.resolve()
    //    给了 full-access，confine() 整段被跳过 —— 沙箱那条链断了也照样全绿。
    //    真机上桌面端默认是 workspace-write，于是 run_code 全线 worker-exit。
    try {
      const result = await runtime.run(runtime.resolve({
        program: 'return 6 * 7',
        bindings: [],
        signal: new AbortController().signal,
      }))
      report.value = result.value
      report.sandboxMode = result.sandbox?.mode
      report.error = result.error === undefined ? undefined : result.error.message
    } catch (error) {
      report.threw = String(error?.message ?? error)
    }
    flush()
    try {
      const confined = await runtime.run(runtime.resolve({
        program: 'return 6 * 7 + 1',
        bindings: [],
        signal: new AbortController().signal,
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: config.workspace },
      }))
      report.confinedValue = confined.value
      report.confinedMode = confined.sandbox?.mode
      report.confinedEnforcement = confined.sandbox?.enforcement
      report.confinedError = confined.error === undefined ? undefined : confined.error.message
    } catch (error) {
      report.confinedThrew = String(error?.message ?? error)
    }
    flush()
  })
}
`.trim() + '\n')

writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: '@deepseek-ai/dsh-desktop-runtime',
  private: true,
  version: '0.0.0',
  dependencies: { 'ptc-probe': '1.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ptc-probe'] } },
}, null, 2)}\n`)

process.env.DSH_HOME = home
process.env.DSH_TOOLS_MODE = 'ptc'
// 这一条正是 main.ts 在打包态注入的东西；模拟它是为了让本脚本能在开发机上验生产行为。
process.env.DSH_PTC_NODE = nodePath

const require = createRequire(join(runtimeDir, 'package.json'))
const { runDesktopHost } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-desktop-host')).href)

let host
try {
  host = await runDesktopHost(runtimeDir, profileDir, async () => {}, { allowLinkedPackages: true })
  check(true, `宿主启动成功（dsh ${host.dshVersion}）`)
} catch (error) {
  check(false, `宿主启动：${error instanceof Error ? error.message : String(error)}`)
}

let report
if (host !== undefined) {
  // 两段都要等：第一段（无沙箱）先落地就退出的话，沙箱那段的结果永远读不到。
  // PTC 子进程要真起两次 node，还要在沙箱那条链上建 ACL 授权、给足冷启动时间。
  const settled = () => (
    report?.value !== undefined || report?.error !== undefined || report?.threw !== undefined
  ) && (
    report?.confinedValue !== undefined || report?.confinedError !== undefined || report?.confinedThrew !== undefined
  )
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'))
      if (settled()) break
    } catch { /* 报告还没写 */ }
    if (Date.now() > deadline) break
    await new Promise(r => setTimeout(r, 500))
  }
}

console.log('\n[3/4] Electron 运行时下，沙箱 runner 必须用包内真 node')

// 这是本轮修的那个坑的**唯一真凭据**，也是 [2/4] 测不出来的地方。
//
// [2/4] 里宿主是普通 `node` 起的 → `process.execPath` 本来就是 node → 沙箱 runner
// 拿它当前缀永远能跑，链路断了也照样全绿。只有把宿主的父进程换成 Electron 运行时
// （主 exe + ELECTRON_RUN_AS_NODE=1），`process.execPath` 才等于主 exe；而 ptc 起子进程
// 时会把环境清到只剩 PATH/PATHEXT/SYSTEMROOT/WINDIR/TEMP/TMP，ELECTRON_RUN_AS_NODE
// 正好被清掉 —— 于是「用 process.execPath 起 runner」= 把 runner.js 交给 Electron 当
// GUI 起：撞单实例锁、退出 0、零输出，所有受限 ptc 调用报
// `worker-exit: Node process exited before completing (0)`。
//
// 所以这里直接在 Electron 运行时里问沙箱：「你要用哪个程序起 runner？」。
const mainExe = readdirSync(appRoot).find(entry => entry.toLowerCase().endsWith('.exe'))
const runnerProbeScript = join(home, 'runner-probe.mjs')
const runnerProbeReport = join(home, 'runner-probe.json')
if (mainExe === undefined) {
  check(false, 'app/ 里找不到主 exe，没法在 Electron 运行时下断言 runner 程序')
} else {
  writeFileSync(runnerProbeScript, RUNNER_PROBE_SOURCE)
  const probe = spawnSync(join(appRoot, mainExe), [runnerProbeScript, runtimeDir, workspace, runnerProbeReport], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  let observed
  try { observed = JSON.parse(readFileSync(runnerProbeReport, 'utf8')) } catch { observed = undefined }
  if (observed === undefined) {
    check(false, `Electron 运行时探针没写出报告（exit=${String(probe.status)}）：${(probe.stderr ?? '').trim().slice(0, 400)}`)
  } else if (observed.threw !== undefined) {
    check(false, `Electron 运行时探针抛异常：${String(observed.threw).slice(0, 400)}`)
  } else {
    check(observed.electron !== null, `确实跑在 Electron 运行时里（electron=${String(observed.electron)}）`)
    const program = observed.runnerProgram
    check(program !== undefined && program !== observed.execPath, `runner 不是用主 exe 起的（argv[0]=${String(program)}）`)
    check(
      program !== undefined && basename(program).toLowerCase() === (process.platform === 'win32' ? 'node.exe' : 'node'),
      `runner 用的是真 node（${String(program)}）`,
    )
    check(program !== undefined && existsSync(program), 'runner 指向的程序真在包里')
    check(String(observed.argv?.[1] ?? '').endsWith('runner.js'), 'runner argv 契约没变（argv[1] 仍是 runner.js）')
  }
}

console.log('\n[4/4] 结论')
check(report?.ptcRuntime === true, 'ctx.ptcRuntime 已挂载')
if (report?.ptcRuntime === true) check(report.language === 'typescript', `PTC 语言 = typescript（实际 ${String(report.language)}）`)
check(String(report?.value) === expected, `PTC 程序返回值 = ${expected}（实际 ${JSON.stringify(report?.value)}）`)
check(
  String(report?.confinedValue) === confinedExpected,
  `受限（workspace-write）下 PTC 返回值 = ${confinedExpected}（实际 ${JSON.stringify(report?.confinedValue)}）`,
)
check(report?.confinedMode === 'workspace-write', `受限那次真跑在 workspace-write 下（实际 ${String(report?.confinedMode)}）`)
if (report?.error !== undefined) check(false, `PTC 程序报错：${report.error}`)
if (report?.threw !== undefined) check(false, `PTC 程序抛异常：${report.threw}`)
if (report?.confinedError !== undefined) check(false, `受限 PTC 程序报错：${report.confinedError}`)
if (report?.confinedThrew !== undefined) check(false, `受限 PTC 程序抛异常：${report.confinedThrew}`)

if (host !== undefined) await host.dispose()
materialized.cleanup()
rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n✗ verify:ptc 未通过（${failures.length} 项）`)
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
console.log('\n✓ verify:ptc 通过：ptc 执行体真能跑起来（含真跑在 workspace-write 沙箱下的那次）')
console.log('  且 Electron 运行时下沙箱 runner 用的是包内真 node，不是主 exe。')
