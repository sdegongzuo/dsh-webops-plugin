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
 * 用法：
 *   node scripts/verify-ptc.mjs --dir <解压后的便携包根目录>
 *   node scripts/verify-ptc.mjs --dir <包根> --expect 42
 *
 * 退出码 0 = 通过，1 = 失败。`--dir` 必须是**刚解压、没启动过的**目录（同 verify:portable）。
 */

import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeRuntimeDir } from './desktop-runtime.mjs'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

const packageRoot = resolve(readArg('dir') ?? '')
const expected = readArg('expect') ?? '42'
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

console.log(`\n[1/3] 修复所需的前置文件（runtime=${materialized.layout}）`)

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

console.log('\n[2/3] 生产路径启动宿主并在 ptc 模式下真跑一段程序')

const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-verify-ptc-')))
const profileDir = join(home, 'profiles', 'desktop')
const probeDir = join(profileDir, 'node_modules', 'ptc-probe')
const reportPath = join(home, 'report.json')
mkdirSync(probeDir, { recursive: true })

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
    try {
      const result = await runtime.run(runtime.resolve({
        program: 'return 6 * 7',
        bindings: [],
        signal: new AbortController().signal,
      }))
      report.value = result.value
      report.error = result.error === undefined ? undefined : result.error.message
    } catch (error) {
      report.threw = String(error?.message ?? error)
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
  // PTC 子进程要真起一次 node；给足冷启动时间。
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'))
      if (report.value !== undefined || report.error !== undefined || report.threw !== undefined) break
    } catch { /* 报告还没写 */ }
    if (Date.now() > deadline) break
    await new Promise(r => setTimeout(r, 500))
  }
}

console.log('\n[3/3] 结论')
check(report?.ptcRuntime === true, 'ctx.ptcRuntime 已挂载')
if (report?.ptcRuntime === true) check(report.language === 'typescript', `PTC 语言 = typescript（实际 ${String(report.language)}）`)
check(String(report?.value) === expected, `PTC 程序返回值 = ${expected}（实际 ${JSON.stringify(report?.value)}）`)
if (report?.error !== undefined) check(false, `PTC 程序报错：${report.error}`)
if (report?.threw !== undefined) check(false, `PTC 程序抛异常：${report.threw}`)

if (host !== undefined) await host.dispose()
materialized.cleanup()
rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n✗ verify:ptc 未通过（${failures.length} 项）`)
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
console.log('\n✓ verify:ptc 通过：ptc 模式下 run_code 的执行体真能跑起来')
