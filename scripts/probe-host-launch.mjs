/**
 * 「窗口宿主没宣布端口」的现场诊断 —— 单独把宿主拉起来，把它的 stdout/stderr 逐行打时间戳。
 *
 * ## 为什么需要它
 *
 * `verify-browser-host.mjs` 走的是插件自己的 bridge：超时 20s，失败时只有一句
 * `the host never announced a port`（bridge 只回带 stderr 尾部，且宿主此时往往**一个字节都没输出**）。
 * 那句话分不出下面三种情况，而它们的修法完全不同：
 *
 *   1. 宿主**根本没走到**窗口宿主分支（main.ts 的模块图在 import 期就卡住 —— 那一段在分支之前）；
 *   2. 走到了，但 `app.whenReady()` 一直没落定（runner 上的 GPU/会话问题）；
 *   3. 只是**慢**（冷启动 + 杀软扫 240MB 的 exe），20s 不够。
 *
 * 所以这里不做任何超时上的判断，只**忠实记录**：等多久、期间有没有输出、进程还在不在。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/probe-host-launch.mjs --dir <解压后的便携包根目录>
 * node scripts/probe-host-launch.mjs --dir <包根> --timeout 90000
 * node scripts/probe-host-launch.mjs --dir <包根> --tmp-copy   # 复刻 verify-browser-host 的临时拷贝
 * ```
 *
 * 退出码恒为 0（这是诊断工具，不是自检）。判读：
 *   · 出现 `host-loaded` → shell 的模块图加载完、走到了窗口宿主分支；
 *   · 出现 `host-ready`  → `app.whenReady()` 落定；
 *   · 出现 `listening`   → 时延就是真正的启动耗时；
 *   · 一行都没有 + 进程还活着 → 卡在 shell 的模块加载（或没走到那个分支）；
 *   · 进程已退出 → 看退出码与 stderr（那才是崩溃）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 读一个进程的「未捕获异常框」文本（Windows）。Electron 的错误框是原生对话框，
 * **异常消息与调用栈就在里面**，而 Node 拿不到窗口文本，所以借 PowerShell：
 *
 *   1. 先走 **UI Automation** —— Electron 那个框是 TaskDialog 风格，消息文本不在普通子控件里
 *      （2026-09-24 实测：Win32 枚举只读得到「确定」按钮），UIA 才看得到 Text 元素；
 *   2. UIA 什么都读不到时，退回 Win32 `EnumChildWindows` 兜底。
 *
 * 脚本走 `-EncodedCommand`（base64 的 UTF-16LE），免得跟引号打架；
 * 读不到不算失败，只是少一条证据。
 *
 * @param pid - 目标进程号。
 * @returns 文本行；读不到就返回空数组。
 */
function dumpDialogTexts(pid) {
  if (process.platform !== 'win32') return []
  const script = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$target = ${String(pid)}
$out = New-Object System.Collections.ArrayList
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $target)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $wins) {
    [void]$out.Add('UIA WINDOW: ' + $w.Current.Name)
    $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) {
      $n = $e.Current.Name
      if ($n) { [void]$out.Add('  ' + $e.Current.ControlType.ProgrammaticName + ': ' + $n) }
    }
  }
} catch { [void]$out.Add('UIA 失败: ' + $_.Exception.Message) }
if ($out.Count -eq 0) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshWinDump {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
    $found = New-Object System.Collections.ArrayList
    $visit = [DshWinDump+EnumProc]{
      param($h, $l)
      $owner = 0
      [void][DshWinDump]::GetWindowThreadProcessId($h, [ref]$owner)
      if ($owner -eq $target) {
        $inner = [DshWinDump+EnumProc]{
          param($c, $l2)
          $sb = New-Object System.Text.StringBuilder 16384
          [void][DshWinDump]::GetWindowTextW($c, $sb, 16384)
          if ($sb.Length -gt 0) { [void]$found.Add('WIN32 TEXT: ' + $sb.ToString()) }
          return $true
        }
        [void][DshWinDump]::EnumChildWindows($h, $inner, [IntPtr]::Zero)
      }
      return $true
    }
    [void][DshWinDump]::EnumWindows($visit, [IntPtr]::Zero)
    foreach ($t in $found) { [void]$out.Add($t) }
  } catch { [void]$out.Add('Win32 兜底也失败: ' + $_.Exception.Message) }
}
foreach ($line in $out) { Write-Output $line }
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  if (result.error !== undefined) return []
  return String(result.stdout ?? '').split(/\r?\n/u).map(line => line.trimEnd()).filter(line => line.trim() !== '')
}

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const has = (name) => args.includes(`--${name}`)

const packageRoot = resolve(readArg('dir') ?? '')
if (readArg('dir') === undefined) {
  console.error('用法: node scripts/probe-host-launch.mjs --dir <包根> [--timeout 60000] [--tmp-copy] [--host <宿主脚本>] [--exe <主 exe>]')
  process.exit(1)
}
const timeoutMs = Number(readArg('timeout') ?? 60_000)

const appRoot = join(packageRoot, 'app')
const exeName = existsSync(appRoot)
  ? readdirSync(appRoot).find(name => name.toLowerCase().endsWith('.exe') && !/uninstall|elevate/iu.test(name))
  : undefined
const exePath = readArg('exe') ?? (exeName === undefined ? undefined : join(appRoot, exeName))

// `--tmp-copy` 复刻 `verify-browser-host.mjs` 的做法：把插件产物**拷到临时目录**再当宿主脚本。
// 单独给这个开关是因为「宿主脚本在 %TEMP% 下」本身就是候选变量之一（杀软 / 策略），
// 而它在自检里是不可见的。两次跑一对比就能把它排掉。
const packagedPluginDir = join(packageRoot, 'home', 'profiles', 'desktop', 'node_modules', 'dsh-webops-plugin')
let pluginDir = packagedPluginDir
let scratch
if (has('tmp-copy')) {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-probe-browser-'))
  pluginDir = join(scratch, 'node_modules', 'dsh-webops-plugin')
  cpSync(packagedPluginDir, pluginDir, { recursive: true })
}
const hostScript = readArg('host') ?? join(pluginDir, 'lib', 'browser-electron', 'host.cjs')

console.log('=== 窗口宿主现场诊断 ===')
console.log(`坑位       : ${has('tmp-copy') ? '临时拷贝（复刻自检）' : '包内原路径'}`)
console.log(`主 exe     : ${String(exePath)}  ${exePath !== undefined && existsSync(exePath) ? '✓' : '✗ 不存在'}`)
console.log(`宿主脚本   : ${hostScript}  ${existsSync(hostScript) ? '✓' : '✗ 不存在'}`)
console.log(`超时上限   : ${String(timeoutMs)}ms（只是本次观察窗口，不是断言）`)
if (exePath === undefined || !existsSync(exePath) || !existsSync(hostScript)) {
  console.log('前置件缺失，无法诊断。')
  process.exit(0)
}

// 与 `resolveHostLaunch`（src/browser-electron/bridge.ts）保持同一套契约：
// 删掉 ELECTRON_RUN_AS_NODE（否则它不是真 Electron 应用），脚本路径走环境变量，argv 留 userData 开关。
const env = { ...process.env, DSH_BROWSER_ELECTRON_HOST: hostScript }
delete env['ELECTRON_RUN_AS_NODE']
const userDataDir = join(tmpdir(), 'dsh-browser-electron-host')
const started = Date.now()
const stamp = () => `+${String(Date.now() - started).padStart(6, ' ')}ms`

console.log(`userDataDir: ${userDataDir}`)
console.log('--- 宿主输出（stdout 标 [out]，stderr 标 [err]）---')

const child = spawn(exePath, [`--user-data-dir=${userDataDir}`], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
})

let announcedAt
let announcedLine
/** 宿主自报的阶段（host.cjs 的 `announce()`），用来切开「模块加载 / whenReady / 监听」。 */
const marks = {}
const outLines = []
const errLines = []
const record = (line, sink) => {
  sink.push(line)
  // ⚠️ 别写成 `\{"type":"…"\}`：宣布行后面还有 pid/electron 字段，`"` 之后跟的是逗号
  // 不是 `}` —— 那个正则只认「恰好只有 type 一个字段」的 JSON，实测静默不匹配。
  const marker = /"type":"(host-loaded|host-ready)"/u.exec(line)
  if (marker !== null && marks[marker[1]] === undefined) marks[marker[1]] = Date.now() - started
  if (line.includes('"listening"') || line.includes('"port"')) {
    if (announcedAt === undefined) {
      announcedAt = Date.now() - started
      announcedLine = line
    }
  }
  console.log(`[${stamp()}] ${line}`)
}
const wire = (stream, tag, sink) => {
  stream.setEncoding('utf8')
  let buffer = ''
  stream.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') record(`[${tag}] ${line}`, sink)
    }
  })
}
wire(child.stdout, 'out', outLines)
wire(child.stderr, 'err', errLines)

let exited
child.once('exit', (code, signal) => { exited = { code, signal } })

// 等「宣布」或等满观察窗口 —— 已经宣布了就再收 1.5s（紧随其后的行也一起记下来）就收工，
// 免得健康的那次也白等 90s。
const deadline = Date.now() + timeoutMs
while (Date.now() < deadline && announcedAt === undefined) {
  await new Promise(done => { setTimeout(done, 200) })
}
if (announcedAt !== undefined) await new Promise(done => { setTimeout(done, 1500) })

const alive = child.exitCode === null && child.signalCode === null
console.log('--- 结论 ---')
console.log(`host-loaded ：${marks['host-loaded'] === undefined ? '未出现' : `${String(marks['host-loaded'])}ms`}（走到窗口宿主分支、脚本已 require）`)
console.log(`host-ready  ：${marks['host-ready'] === undefined ? '未出现' : `${String(marks['host-ready'])}ms`}（app.whenReady 落定）`)
if (announcedAt !== undefined) {
  console.log(`listening   ：${String(announcedAt)}ms  ${String(announcedLine)}`)
} else {
  console.log(`listening   ：${String(timeoutMs)}ms 内没有宣布`)
}
console.log(`进程状态    ：${alive ? '仍在运行' : `已退出 code=${String(exited?.code)} signal=${String(exited?.signal ?? child.signalCode)}`}`)
console.log(`输出        ：stdout ${String(outLines.length)} 行 / stderr ${String(errLines.length)} 行`)
if (outLines.length === 0 && marks['host-loaded'] === undefined) {
  console.log('  · 连 host-loaded 都没有 → 卡在 shell 的模块图（或没走到窗口宿主分支），不是宿主脚本的问题')
}
if (alive && marks['host-loaded'] !== undefined && marks['host-ready'] === undefined) {
  console.log('  · 走到了宿主脚本但 whenReady 没落定 → 指向 runner 的 GUI/会话，而不是我们的代码')
}
let windowTitle
if (alive && process.platform === 'win32') {
  // 冻住 vs 忙等：CPU 时间为 0 说明进程被挂起（杀软扫描 / SmartScreen），不为 0 说明它在干活。
  // 顺带取最后一列「Window Title」—— Electron 的未捕获异常框标题恒为 `Error`，是最硬的指纹。
  const row = spawnSync('tasklist', ['/FI', `PID eq ${String(child.pid)}`, '/V', '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true })
  const line = String(row.stdout ?? '').trim().split(/\r?\n/u)[0] ?? ''
  if (line !== '') console.log(`tasklist /V ：${line}`)
  // CSV 里字段都用双引号包着：`"a","b",…,"窗口标题"`。
  const fields = line.replace(/^"|"$/gu, '').split('","')
  windowTitle = fields.at(-1)
}

// 没宣布 + 还活着 + 窗口标题是 `Error` = Electron 给主进程未捕获异常弹的**模态**框。
// 它在原生层阻塞进程，**并且不往 stderr 写一个字** —— 2026-09-24 本机用故意抛错的宿主脚本
// 复刻过：stderr 只有 NODE_OPTIONS 警告，框的标题就叫 `Error`，进程 CPU 为 0、不退。
// 所以那句报错只能从窗口里读：这里 P/Invoke 枚举该进程的窗口与子控件，把静态文本
// （= 异常消息 + 调用栈）打出来。读不到不算失败，只是没有额外证据。
if (alive && process.platform === 'win32' && windowTitle === 'Error') {
  console.log('  · 窗口标题是 `Error` → 读它的内容（Electron 的未捕获异常框）')
  const texts = dumpDialogTexts(child.pid)
  if (texts.length === 0) console.log('    （枚举不到文本；框可能已被关掉或权限不足）')
  for (const text of texts) console.log(`    ${text}`)
}

if (child.exitCode === null) child.kill()
if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
process.exit(0)
