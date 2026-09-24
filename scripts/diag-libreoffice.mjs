/**
 * 打包态 LibreOffice 转换诊断 —— **只在发版流程失败后跑**（workflow 里挂 `if: failure()`）。
 *
 * ## 为什么要有它
 *
 * dsh 0.1.7 给打包链最后一步加了 Office→PDF 冒烟（`apps/desktop/scripts/smoke-runtime.ts`），
 * 而它在我们 CI 上**必现**地挂在 xlsx 上（docx 能过）：
 *
 *   desktop runtime: xlsx conversion failed: OfficeToPdfError: LibreOffice conversion failed.
 *     [cause]: ConversionError: LibreOffice native conversion failed:
 *              loadComponentFromURL returned an empty reference
 *
 * 这一句**信息量太低**：它既可能是「载荷不全」（打包/安装少拷了文件），
 * 也可能是「这台机器跑不起来」（内存/环境），还可能是「只有 in-host 那条路径有问题」。
 * 而失败发生在 runner 上，证据随 runner 一起没了 —— 所以必须由本脚本把证据带回来。
 *
 * ## 它回答三个互斥的问题
 *
 * 1. **载荷完整吗？** 对 `prebuilds.json` 里那份**全量 sha256 清单**逐条核对磁盘。
 *    上游自己就用这份清单定义「预构建产物该有什么」，所以它是权威判据，不是我们的猜测。
 * 2. **LibreOffice 本身能在这台机器上转吗？** 用 kit 自己的 CLI **绕开 dsh 宿主**单跑
 *    docx / xlsx / pptx。若单跑能过而 in-host 不过 ⇒ 问题在宿主那一侧（内存压力/环境），
 *    与「载荷」「runner 缺组件」无关。
 * 3. **机器够用吗？** 打印内存 / 临时盘可用空间 —— Calc 是进程内加载，比 Writer 重得多。
 *
 * ## 用法
 *
 * ```bash
 * # 本地校准（对着本机那份 win-unpacked）
 * node scripts/diag-libreoffice.mjs --resources "<…>/win-unpacked/resources"
 * # CI（workflow 里由失败触发）
 * node scripts/diag-libreoffice.mjs --resources "$env:WIN_UNPACKED\resources" --harness "$env:HARNESS_ROOT"
 * ```
 *
 * 诊断脚本**不许 fail-fast**：任何一步失败都只记录、继续跑下一步 —— 它的全部价值在于
 * 把现场尽可能完整地带回来。所以它最后总是 exit 0（除非连 `--resources` 都不存在）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

const resources = resolve(arg('resources', ''))
// `--resources` 通常指向 `<…>/win-unpacked/resources`：往上 8 层才是 harness 仓库根
// （resources → win-unpacked → unsigned-artifacts → win-x64 → targets → .desktop-build → desktop → apps → 根）。
const harness = resolve(arg('harness', join(resources, ...Array(8).fill('..'))))

function say(line = '') {
  console.log(line)
}

function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function dirStats(dir) {
  if (!existsSync(dir)) return null
  let files = 0
  let bytes = 0
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const child = join(at, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) { files += 1; bytes += statSync(child).size }
    }
  }
  walk(dir)
  return { files, mb: Math.round(bytes / 1048576) }
}

/* ---------- 0. 定位 ---------- */

const dsh = join(resources, 'dsh')
const wrapper = join(dsh, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
const payload = join(dsh, 'node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64')
const python = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe')
const fixture = join(harness, 'apps', 'desktop', 'tests', 'fixtures', 'office-conversion-inputs.py')

say('================ LibreOffice 转换诊断 ================')
say(`resources  ${resources}`)
say(`harness    ${harness}`)
for (const [label, path] of [['kit 包装', wrapper], ['kit 载荷', payload], ['内置 python', python], ['夹具脚本', fixture]]) {
  say(`  ${label.padEnd(10)} ${existsSync(path) ? '✓' : '✗ 不存在'}  ${path}`)
}
if (!existsSync(dsh)) {
  say('resources/dsh 不存在 —— 产物没打出来？后面的检查全部无意义。')
  process.exit(0)
}

/* ---------- 1. 载荷形态 + 自证清单（回答「载荷完整吗」） ---------- */

say('')
say('---- 1. 载荷形态 ----')
for (const [label, dir] of [
  ['kit 载荷', payload],
  ['program/program', join(payload, 'program', 'program')],
  ['kit 包装 lib', join(wrapper, 'lib')],
]) {
  const stats = dirStats(dir)
  say(`  ${label.padEnd(18)} ${stats === null ? '✗ 不存在' : `${stats.files} 个文件 / ${stats.mb} MB`}`)
}

const manifestPath = join(payload, 'prebuilds.json')
say('')
say('---- 2. prebuilds.json 全量 sha256 自检（上游自己定义的「该有什么」）----')
if (!existsSync(manifestPath)) {
  say(`  ✗ 没有 ${manifestPath}`)
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entries = Object.entries(manifest.files ?? {})
  say(`  status=${JSON.stringify(manifest.status)} version=${String(manifest.version)}`)
  say(`  engine=${JSON.stringify(manifest.engine)}`)
  say(`  清单条目 ${entries.length}`)
  const missing = []
  const changed = []
  for (const [rel, expected] of entries) {
    const actual = sha256(join(payload, rel))
    if (actual === null) missing.push(rel)
    else if (actual !== expected) changed.push(rel)
  }
  say(`  ✓ 一致 ${entries.length - missing.length - changed.length} / 缺失 ${missing.length} / 哈希不符 ${changed.length}`)
  for (const rel of missing.slice(0, 10)) say(`    缺失  ${rel}`)
  for (const rel of changed.slice(0, 10)) say(`    不符  ${rel}`)
  // 载荷里有没有「清单之外」的文件：多余不算错（可能被 electron-builder 加了东西），但值得知道。
  const onDisk = new Set()
  const walk = (at, rel) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const child = join(at, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child, childRel)
      else onDisk.add(childRel)
    }
  }
  walk(payload, '')
  const extra = [...onDisk].filter((rel) => !(rel in (manifest.files ?? {})))
  say(`  磁盘上共 ${onDisk.size} 个文件，其中清单外 ${extra.length}`)
  for (const rel of extra.slice(0, 10)) say(`    清单外 ${rel}`)
}

/* ---------- 3. 机器状况（回答「这台机器够用吗」） ---------- */

say('')
say('---- 3. 机器状况 ----')
say(`  platform=${process.platform} arch=${process.arch} cpus=${String(cpus().length)}`)
if (process.platform === 'win32') {
  const os = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress",
  ], { encoding: 'utf8', windowsHide: true })
  say(`  内存 ${os.stdout?.trim() || os.stderr?.trim() || '（查不到）'}`)
  const drive = spawnSync('powershell', ['-NoProfile', '-Command',
    "$d=Get-PSDrive C; [pscustomobject]@{FreeMB=[math]::Round($d.Free/1MB);UsedMB=[math]::Round($d.Used/1MB)} | ConvertTo-Json -Compress",
  ], { encoding: 'utf8', windowsHide: true })
  say(`  C 盘 ${drive.stdout?.trim() || '（查不到）'}`)
}
say(`  TEMP   ${tmpdir()}`)
say(`  NODE_OPTIONS=${JSON.stringify(process.env.NODE_OPTIONS ?? null)}`)

/* ---------- 4/5. 绕开宿主单跑 kit CLI（回答「LibreOffice 本身能不能转」） ---------- */

const home = mkdtempSync(join(tmpdir(), 'dsh-diag-office-'))
say('')
say(`---- 4. 用内置 python 生成夹具（${home}）----`)
if (existsSync(python) && existsSync(fixture)) {
  const made = spawnSync(python, ['-I', '-B', fixture, home], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
  say(`  exit=${String(made.status)}`)
  if (made.stdout?.trim()) say(`  stdout ${made.stdout.trim()}`)
  if (made.stderr?.trim()) say(`  stderr ${made.stderr.trim()}`)
  for (const ext of ['docx', 'xlsx', 'pptx']) {
    const file = join(home, `input.${ext}`)
    say(`  input.${ext}  ${existsSync(file) ? `${statSync(file).size} 字节` : '✗ 没生成'}`)
  }
} else {
  say('  跳过：内置 python 或夹具脚本不在')
}

say('')
say('---- 5. kit CLI 单跑（**绕开 dsh 宿主**，只用 LibreOffice 自己）----')
const cli = join(wrapper, 'lib', 'cli.js')
if (!existsSync(cli)) {
  say(`  ✗ 没有 ${cli}`)
} else {
  // 与冒烟里那段插件代码用同一组选项：清空 PATH（证明不依赖系统工具）+ 120s 超时。
  const options = { cwd: home, env: { ...process.env, PATH: '' }, timeout: 120_000, encoding: 'utf8', windowsHide: true }
  const run = (label, argv) => {
    const started = Date.now()
    const result = spawnSync(process.execPath, [cli, ...argv], options)
    const ms = Date.now() - started
    say(`  ${label}  exit=${String(result.status)} ${ms}ms`)
    const stderr = (result.stderr ?? '').trim()
    const stdout = (result.stdout ?? '').trim()
    if (stderr) say(`    stderr ${stderr.split('\n').slice(0, 12).join('\n           ')}`)
    if (stdout) say(`    stdout ${stdout.slice(0, 1500)}`)
    return result
  }
  run('capabilities', ['capabilities'])
  for (const ext of ['docx', 'xlsx', 'pptx']) {
    const input = join(home, `input.${ext}`)
    if (!existsSync(input)) { say(`  ${ext} 跳过（没夹具）`); continue }
    const output = join(home, `cli.${ext}.pdf`)
    const result = run(`convert ${ext}`, ['convert', '--input', input, '--output', output])
    say(`    产物 ${existsSync(output) ? `${statSync(output).size} 字节` : '✗ 没产出'}`
      + (existsSync(output) ? `，头 ${readFileSync(output).subarray(0, 5).toString()}` : ''))
    if (result.status !== 0) say(`    ⇧ 这一步若失败，说明**不经过 dsh 宿主也转不了** ⇒ 指向 LibreOffice/runner，而不是宿主`)
  }
}

/* ---------- 6. LibreOffice 自己的日志 ---------- */

say('')
say('---- 6. 现场残留的日志文件 ----')
const logs = []
const collect = (dir, depth = 0) => {
  if (depth > 3 || !existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) collect(child, depth + 1)
    else if (/\.(log|txt)$/iu.test(entry.name) && statSync(child).size < 200_000) logs.push(child)
  }
}
collect(payload)
say(logs.length === 0 ? '  载荷目录下没有 .log/.txt' : logs.slice(0, 8).map((l) => `  ${l}`).join('\n'))

rmSync(home, { recursive: true, force: true })
say('')
say('================ 诊断结束 ================')
say('（本脚本不判定成败，只把现场带回来；结论由人看上面的三组数字得出。）')
