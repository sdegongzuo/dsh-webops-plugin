// 一次性探针（本机复现发版链的 Office 冒烟失败）：
// 把**同一份** LibreOffice 载荷放在不同的绝对路径长度下，各跑一次 docx/xlsx/pptx→pdf，
// 找出行为翻转的那个长度点。
//
// 背景：CI 发版链里冒烟必现挂 xlsx（`loadComponentFromURL returned an empty reference`）
// 与 pptx（helper 原生崩溃），而同一份载荷在浅路径的探针里三个全过。
// 载荷在链里的绝对路径比本机长 12 个字符；链里最深的一个文件 266 字符 > 260（MAX_PATH）。
//
// 用法（在本仓根目录）：
//   CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/probe-deep-path.mjs          # 只打印计划
//   CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/probe-deep-path.mjs --run    # 四臂（短/深 × PATH 原样/清空）
//   CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/probe-deep-path.mjs --sweep  # 长度扫描，找翻转点
// 本仓只读；写只写 D:\dsh-build\_lo-deep\ 下的临时目录。
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const UNPACKED = 'D:/dev/cli/deepseek-harness/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked'
const SHORT_PARENT = `${UNPACKED}/resources/dsh/node_modules/@deepseek-ai`
const SHORT_NODE_MODULES = join(SHORT_PARENT, '..')
const SHORT_PAYLOAD_LENGTH = join(SHORT_PARENT, 'libreoffice-kit-win32-x64').length
const PYTHON = `${UNPACKED}/resources/runtime/primary-runtime/dependencies/python/python.exe`
const FIXTURE_SCRIPT = 'D:/dev/cli/deepseek-harness/apps/desktop/tests/fixtures/office-conversion-inputs.py'
const WORK = 'D:/dsh-build/_lo-deep'

const PAYLOAD_PACKAGE = 'libreoffice-kit-win32-x64'
const WRAPPER_PACKAGE = 'libreoffice-kit'
// 结构必须逐字复刻：…\resources\dsh\node_modules\@deepseek-ai\<包>
// （`node_modules` 这个名字不能动 —— Node 解析就是靠它逐级向上找的）
const STRUCTURAL_TAIL = '\\resources\\dsh\\node_modules'
const SCOPE_TAIL = `\\@deepseek-ai\\${PAYLOAD_PACKAGE}`

// 链里那个**确切**的前缀长度（逐字取自 CI 日志，含末尾反斜杠）：
//   D:\a\dsh-webops-plugin\deepseek-harness\apps\desktop\.desktop-build\targets\win-x64\
//   unsigned-artifacts\win-unpacked\resources\dsh\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\
const CHAIN_PAYLOAD_LENGTH = 182 - 1
// 载荷里相对路径最长的一条（84 字符）——它决定「绝对路径最长」是多少。
const DEEPEST_REL = 'program\\share\\config\\soffice.cfg\\modules\\simpress\\popupmenu\\pagepanecanvasmaster.xml'

/** 拼一条长度**精确等于** target 的目录路径（差额全补在最后一段里）。 */
function paddedPath(prefix, target) {
  let path = prefix
  while (path.length + 6 <= target) path = `${path}\\lod`   // 留够「\ + 补位段」的最小长度
  return `${path}\\${'p'.repeat(target - path.length - 1)}`
}

/** 按「载荷根绝对路径长度 = payloadLength」造出一套路径。 */
function layout(payloadLength) {
  const base = paddedPath(`${WORK.replaceAll('/', '\\')}\\lo-deep`, payloadLength - STRUCTURAL_TAIL.length - SCOPE_TAIL.length)
  const nodeModules = `${base}${STRUCTURAL_TAIL}`
  const scope = `${nodeModules}\\@deepseek-ai`
  return {
    scope,
    nodeModules,
    payload: `${scope}\\${PAYLOAD_PACKAGE}`,
    wrapper: `${scope}\\${WRAPPER_PACKAGE}`,
    deepest: `${scope}\\${PAYLOAD_PACKAGE}\\${DEEPEST_REL}`,
  }
}

function countFiles(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name))
    else total += 1
  }
  return total
}

/** 包装包（及其依赖）里出现的、能在 nodeModulesDir 平铺找到的全部包名。 */
function dependencyClosure(root, nodeModulesDir) {
  const read = dir => {
    const file = join(dir, 'package.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  }
  const found = new Set()
  const missing = new Set()
  const visit = name => {
    if (found.has(name) || missing.has(name)) return
    const dir = join(nodeModulesDir, name)
    if (!existsSync(dir)) { missing.add(name); return }
    found.add(name)
    for (const dep of Object.keys(read(dir).dependencies ?? {})) visit(dep)
  }
  for (const dep of Object.keys(read(join(root, 'package.json')).dependencies ?? {})) visit(dep)
  if (missing.size > 0) console.log(`  （这些依赖在 ${nodeModulesDir} 里找不到，跳过：${[...missing].join(' ')}）`)
  return [...found]
}

/** 把载荷 + 包装包 + 依赖复制到 payloadLength 那条深路径下（大目录先真删）。 */
function materialize(payloadLength, deps) {
  const target = layout(payloadLength)
  rmSync(target.nodeModules.slice(0, target.nodeModules.length - STRUCTURAL_TAIL.length), { recursive: true, force: true })
  mkdirSync(target.scope, { recursive: true })
  for (const name of deps) {
    cpSync(join(SHORT_NODE_MODULES, name), join(target.nodeModules, name), { recursive: true, dereference: true })
  }
  for (const name of [WRAPPER_PACKAGE, PAYLOAD_PACKAGE]) {
    cpSync(join(SHORT_PARENT, name), `${target.scope}\\${name}`, { recursive: true })
  }
  return target
}

function convert(cli, extension, { emptyPath = false } = {}) {
  const output = join(WORK, `out.${extension}.pdf`)
  // ⚠️ 输出必须走**文件**而不是管道：LibreOffice 助手进程是孙子进程，会继承管道写端；
  // 超时杀掉直接子进程后 spawnSync 仍会等管道 EOF —— 表现为整个脚本「静默卡死」。
  const logFile = join(WORK, `convert.${extension}.log`)
  const env = emptyPath ? { ...process.env, PATH: '' } : { ...process.env }
  const started = Date.now()
  const fd = openSync(logFile, 'w')
  const result = spawnSync(process.execPath,
    [cli, 'convert', '--input', join(WORK, 'work', `input.${extension}`), '--output', output],
    { env, windowsHide: true, timeout: Number(process.env.PROBE_TIMEOUT_MS ?? 120_000), killSignal: 'SIGKILL', stdio: ['ignore', fd, fd] })
  closeSync(fd)
  const detail = readFileSync(logFile, 'utf8').trim().split('\n').slice(0, 3).join(' / ').slice(0, 220)
  const size = existsSync(output) ? statSync(output).size : undefined
  rmSync(output, { force: true })
  return { status: result.status, size, seconds: (Date.now() - started) / 1000, detail }
}

// ---------------- 计划 ----------------
const deps = dependencyClosure(join(SHORT_PARENT, WRAPPER_PACKAGE), SHORT_NODE_MODULES)
const deep181 = layout(CHAIN_PAYLOAD_LENGTH)
console.log(`短路径（本机打包产物）  载荷根 ${SHORT_PAYLOAD_LENGTH} 字符`)
console.log(`  ${join(SHORT_PARENT, PAYLOAD_PACKAGE)}`)
console.log(`深路径（复刻 CI）        载荷根 ${deep181.payload.length} 字符   最长文件 ${deep181.deepest.length} 字符`)
console.log(`  ${deep181.payload}`)
console.log(`包装包运行时依赖 ${deps.length} 个：${deps.join(' ')}`)

const mode = process.argv.includes('--sweep') ? 'sweep'
  : process.argv.includes('--guard') ? 'guard'
    : process.argv.includes('--run') ? 'run' : 'plan'
if (mode === 'plan') {
  console.log('\n只打印计划，没动盘。加 --run / --sweep / --guard 才真的复制并跑。')
  process.exit(0)
}

// ---- 守卫的反向验证：造一个「harness 根够长」的假 harness，守卫必须转红 ----
if (mode === 'guard') {
  // 守卫认的布局是 <harness>/node_modules/.pnpm/<槽>/node_modules/@deepseek-ai/<载荷>
  // 故意把假 harness 根造成 **37 字符** = 旧 CI 布局里 `D:\a\dsh-webops-plugin\deepseek-harness`
  // 的长度（守卫只看 harness 根长度，不看载荷自身在哪）。这样这一轮就是在验「旧布局会被拦」。
  const fakeHarness = `${WORK.replaceAll('/', '\\')}\\fh-${'x'.repeat(12)}`
  console.log(`假 harness 根 ${fakeHarness.length} 字符（旧 CI 布局是 37）`)
  const slot = `${fakeHarness}\\node_modules\\.pnpm\\@deepseek-ai+libreoffice-kit-win32-x64@0.1.0\\node_modules\\@deepseek-ai\\libreoffice-kit-win32-x64`
  rmSync(fakeHarness, { recursive: true, force: true })
  mkdirSync(slot, { recursive: true })
  cpSync(join(SHORT_PARENT, PAYLOAD_PACKAGE), slot, { recursive: true })
  const guard = 'scripts/check-office-payload-path.mjs'
  for (const [label, harness] of [['短根（本机 harness）', 'D:/dev/cli/deepseek-harness'], ['长根（复刻 CI）', fakeHarness]]) {
    console.log(`\n======== 守卫 / ${label} ========`)
    const result = spawnSync(process.execPath, [guard, '--harness', harness], { encoding: 'utf8', windowsHide: true })
    console.log((result.stdout || '').trim())
    if (result.status !== 0) console.log((result.stderr || '').trim())
    console.log(`  ⇒ exit=${result.status}（期望：短根 0 / 长根 1）`)
  }
  process.exit(0)
}

// ---------------- 夹具（与冒烟那一步同一条命令、同一个脚本、同一份 python） ----------------
rmSync(WORK, { recursive: true, force: true })
const fixtureDir = join(WORK, 'work')
mkdirSync(fixtureDir, { recursive: true })
const fixture = spawnSync(PYTHON, ['-I', '-B', FIXTURE_SCRIPT, fixtureDir], { encoding: 'utf8', windowsHide: true })
console.log(`\n生成夹具 exit=${fixture.status}${fixture.stderr ? `\n${fixture.stderr}` : ''}`)
for (const ext of ['docx', 'xlsx', 'pptx']) {
  const file = join(fixtureDir, `input.${ext}`)
  console.log(`  input.${ext}  ${existsSync(file) ? statSync(file).size : '缺失'} 字节`)
}

if (mode === 'run') {
  const deep = materialize(CHAIN_PAYLOAD_LENGTH, deps)
  const shortFiles = countFiles(join(SHORT_PARENT, PAYLOAD_PACKAGE))
  const deepFiles = countFiles(deep.payload)
  console.log(`\n文件数 短=${shortFiles} 深=${deepFiles} ${shortFiles === deepFiles ? '✓ 一致' : '✗ 不一致（复制被 MAX_PATH 截了）'}`)
  console.log(`最深那条 ${deep.deepest.length} 字符 在深路径下：${existsSync(deep.deepest) ? '✓ 存在' : '✗ 缺失'}`)
  console.log(`入口 bin\\libreoffice-kit.exe：${existsSync(`${deep.payload}\\bin\\libreoffice-kit.exe`) ? '✓ 在' : '✗ 不在'}；装载的载荷 ${existsSync(`${deep.payload}\\prebuilds.json`) ? '✓ 有 prebuilds.json' : '✗ 缺 prebuilds.json'}`)

  const arms = [
    { name: 'A 短路径 + 原样 PATH', parent: SHORT_PARENT, emptyPath: false },
    { name: 'B 短路径 + PATH 清空', parent: SHORT_PARENT, emptyPath: true },
    { name: 'C 深路径 + 原样 PATH', parent: deep.scope.replaceAll('\\', '/'), emptyPath: false },
    { name: 'D 深路径 + PATH 清空', parent: deep.scope.replaceAll('\\', '/'), emptyPath: true },
  ]
  console.log('')
  for (const arm of arms) {
    const cli = join(arm.parent, `${WRAPPER_PACKAGE}/lib/cli.js`)
    console.log(`======== ${arm.name} ========`)
    if (!existsSync(cli)) { console.log('  ✗ 找不到 cli.js'); continue }
    for (const ext of ['docx', 'xlsx', 'pptx']) {
      const r = convert(cli, ext, { emptyPath: arm.emptyPath })
      console.log(`  convert ${ext}  exit=${r.status}  ${r.seconds.toFixed(1)}s  ${r.size ? `产物 ${r.size} 字节` : '没产出'}${r.status === 0 ? '' : `\n     ${r.detail}`}`)
    }
  }
  process.exit(0)
}

// ---------------- 长度扫描：找翻转点 ----------------
// 约束：Windows 的 MAX_PATH=260 **含结尾 NUL**，所以能用的路径上限是 259 字符。
// 若根因是 MAX_PATH，翻转点应落在「最长文件 = 259→260」之间，即载荷根 175→176。
const sweepExtensions = (process.env.SWEEP_EXTS ?? 'docx,xlsx,pptx').split(',')
console.log(`\n载荷根 / 最长文件 / ${sweepExtensions.join(' / ')}`)
console.log(`（本机打包产物那条 ${SHORT_PAYLOAD_LENGTH} / 253 作为对照）`)
console.log('（SWEEP_ROOTS 可覆盖扫描点，SWEEP_EXTS 可只留 xlsx —— pptx 失败路径要等超时，慢）')
const sweepRoots = (process.env.SWEEP_ROOTS ?? `${SHORT_PAYLOAD_LENGTH},174,175,176,177,179,${CHAIN_PAYLOAD_LENGTH}`)
  .split(',').map(Number)
for (const payloadLength of sweepRoots) {
  const target = payloadLength === SHORT_PAYLOAD_LENGTH
    ? { scope: SHORT_PARENT, payload: join(SHORT_PARENT, PAYLOAD_PACKAGE), deepest: join(SHORT_PARENT, PAYLOAD_PACKAGE, DEEPEST_REL) }
    : materialize(payloadLength, deps)
  const cli = join(target.scope.replaceAll('\\', '/'), `${WRAPPER_PACKAGE}/lib/cli.js`)
  const cells = []
  for (const ext of sweepExtensions) {
    const r = convert(cli, ext)
    cells.push(`${ext}=${r.status === 0 ? 'ok' : '✗'}(${r.seconds.toFixed(0)}s)`.padEnd(12))
  }
  console.log(`  ${String(payloadLength).padStart(3)}    ${String(target.deepest.length).padStart(3)}   ${cells.join(' ')}`)
}
