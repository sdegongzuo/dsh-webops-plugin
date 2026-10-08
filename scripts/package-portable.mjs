/**
 * 打 Windows x64 便携版 zip（纯插件包）。
 *
 * 便携版 = **免构建**的产物包：`lib/` 已经编译好，解压后直接 `dsh plugin add <目录>`
 * 即可加载，用户端不需要 pnpm / tsdown / TypeScript，也不需要本地的 deepseek-harness
 * checkout（开发期那 13 个 `link:` 依赖在发布包里被剔除）。
 *
 * ## 两种模式
 *
 * **保留安全模式**（传了 --lib-dir / --stage-root / --out / --keep-stage 任意一个即进入）：
 *   · 暂存目录 = stage-root 下 mkdtemp 出的**唯一新目录**，绝不删除、绝不复用旧目录；
 *   · 输出 zip **必须尚不存在**，存在即报错退出，绝不覆盖；
 *   · 全程零 rmSync —— 符合 AGENTS.md 的文件删除禁令，发版工作流走这条。
 *
 * **兼容模式**（一个新参数都不传）：沿用旧行为 —— 起手删除 `.portable-stage`、
 *   删除同名旧 ZIP、收尾删除暂存。⚠️ 含删除分支，本仓文件规则**禁止实际运行**；
 *   仅为不破坏旧调用方而保留，新流程一律用保留安全模式。
 *
 * 用法（保留安全模式，推荐）：
 *   node scripts/package-portable.mjs 0.2.13 \
 *     --lib-dir <本轮构建目录，默认 ./lib> \
 *     --stage-root <D 盘暂存父目录，默认仓库内 .portable-stage> \
 *     --out <未存在的 ZIP 路径，默认 dist/dsh-webops-plugin-<ver>-win-x64-portable.zip> \
 *     --keep-stage   # 保留暂存证据；安全模式下暂存本来就永远保留，此参数仅为与
 *                    # package-plugin-update 的参数面保持一致
 *
 * 兼容模式（含删除，本仓规则禁止运行）：
 *   node scripts/package-portable.mjs [版本号]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

const fail = (msg) => {
  console.error(`package-portable: ${msg}`)
  process.exit(1)
}

// ── 参数解析：新旗标进入保留安全模式；裸参数是版本号；--help 打印用法 ──
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '用法：',
    '  保留安全模式（推荐，零删除零覆盖）：',
    '    node scripts/package-portable.mjs [版本] --lib-dir <目录> --stage-root <目录> --out <未存在的zip> [--keep-stage]',
    '      --lib-dir     打进包里的构建产物目录（须含 index.js 等，默认 ./lib）',
    '      --stage-root  唯一暂存目录的父目录（会在其下新建 dsh-portable-XXXX）',
    '      --out         输出 zip 路径；必须尚不存在，存在即报错，绝不覆盖',
    '      --keep-stage  保留暂存目录（安全模式下本就永远保留，参数仅为参数面对齐）',
    '  兼容模式（含删除分支，本仓文件规则禁止运行）：',
    '    node scripts/package-portable.mjs [版本]',
  ].join('\n'))
  process.exit(0)
}

const readArg = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

const safeMode =
  hasFlag('lib-dir') || hasFlag('stage-root') || hasFlag('out') || hasFlag('keep-stage')

const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    if (!['--lib-dir', '--stage-root', '--out', '--keep-stage'].includes(argv[i])) {
      fail(`未知参数: ${argv[i]}（--help 看用法）`)
    }
    if (argv[i] !== '--keep-stage') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
        fail(`${argv[i]} 缺少路径值（--help 看用法）`)
      }
      i++
    }
    continue
  }
  positional.push(argv[i])
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (positional.length > 1) fail('只允许一个位置参数：版本号')
const version = positional[0] ?? pkg.version

if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  fail(`版本号不合法: ${version}`)
}

const libDir = resolve(readArg('lib-dir') ?? join(ROOT, 'lib'))
const stageRoot = resolve(readArg('stage-root') ?? join(ROOT, '.portable-stage'))
const zipName = `dsh-webops-plugin-v${version}-win-x64-portable.zip`
const zipPath = resolve(readArg('out') ?? join(DIST, zipName))

/** 相对仓库根 → 包内相对路径。目录整体拷贝，文件单拷贝。lib 一项用 libDir 来源。 */
const PAYLOAD = [
  ['lib', 'lib'],
  ['cordis.patch.yml', 'cordis.patch.yml'],
  ['package.json', 'package.json'],
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
  ['docs/portable-install.md', 'INSTALL.md'],
]

// 完整性前置：lib 运行时（含 browser-electron 窗口资产等，由 copy-assets 物化）与
// 安装/元数据文件一个都不能少，缺哪个报哪个，绝不静默打出残包。
for (const [from] of PAYLOAD) {
  const src = from === 'lib' ? libDir : join(ROOT, from)
  if (!existsSync(src)) fail(`缺少 ${src}（${from === 'lib' ? '先构建，或用 --lib-dir 指到本轮构建目录' : '仓库文件缺失'}）`)
}
for (const file of ['index.js', 'client.js',
  ...['host.cjs', 'action-overlay.cjs', 'action-overlay.html', 'tabbar.html', 'tabbar-preload.cjs']
    .map(name => join('browser-electron', name))]) {
  if (!existsSync(join(libDir, file))) {
    fail(`缺少 ${join(libDir, file)} —— lib-dir 不是完整运行时，先构建并运行 copy-assets`)
  }
}

if (safeMode) {
  if (existsSync(zipPath)) {
    fail([
      `目标已存在: ${zipPath}`,
      '保留安全模式不覆盖既有产物（AGENTS.md 文件删除禁令）；换一个未存在的 --out 路径。',
    ].join('\npackage-portable: '))
  }
  if (existsSync(stageRoot) === false) mkdirSync(stageRoot, { recursive: true })
  // 唯一新目录：mkdtemp 保证不与任何旧暂存复用，全程不删除（无论是否传 --keep-stage）。
  var STAGE = mkdtempSync(join(stageRoot, 'dsh-portable-'))
  console.log(`保留安全模式：暂存 ${STAGE}（保留，不删除）`)
} else {
  console.warn('package-portable: ⚠️ 兼容模式含删除分支（删旧 stage / 删同名 ZIP / 收尾删 stage），本仓文件规则禁止实际运行')
  var STAGE = join(ROOT, '.portable-stage')
  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(DIST, { recursive: true })
  mkdirSync(STAGE, { recursive: true })
  if (existsSync(zipPath)) rmSync(zipPath)
}

for (const [from, to] of PAYLOAD) {
  const src = from === 'lib' ? libDir : join(ROOT, from)
  const dst = join(STAGE, to)
  cpSync(src, dst, {
    recursive: true,
    // 生产包与增量包使用同一口径，不出货测试模型。
    filter: source => from !== 'lib' || resolve(source) !== join(libDir, 'fake-llm'),
  })
  console.log(`  + ${to}`)
}

// 发布用的 package.json：剔掉开发期专属的东西。
// - devDependencies 里那 13 个 `link:../deepseek-harness/...` 指向本机的 dsh checkout，
//   便携版里它们指向不存在的路径，留着只会让任何试图 install 的工具炸掉。
// - scripts 里的 dev:desktop / smoke:* 依赖 harness 与本地 Chrome，发布包里跑不了。
// 其余字段（name / exports / dsh / peerDependencies）原样保留 —— dsh 的 Loader 与
// 桌面端的 validateDesktopPluginGraph 读的就是这些。
const releasePkg = { ...pkg, version }
releasePkg.exports = { ...pkg.exports }
delete releasePkg.exports['./fake-llm']
delete releasePkg.devDependencies
delete releasePkg.scripts
writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(releasePkg, null, 2)}\n`)
console.log('  + package.json (已剔除 devDependencies / scripts)')

// 安全模式不带 -Force：目标已在上游被拒绝，这里再多一层「目标出现即失败」的保险，
// 而不是悄悄覆盖。兼容模式维持旧行为（-Force）。
const compressArgs = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -Path '${join(STAGE, '*')}' -DestinationPath '${zipPath}' -CompressionLevel Optimal${safeMode ? '' : ' -Force'}`,
]
if (safeMode && existsSync(zipPath)) {
  fail(`压缩前目标突然出现: ${zipPath} —— 拒绝覆盖，中止`)
}
if (safeMode) {
  // 全新 checkout 没有 dist；明确创建父目录。Python 参数直传避免路径含单引号时
  // 被拼接成 PowerShell 代码，exclusive 模式同时封住检查后的输出文件竞争。
  mkdirSync(dirname(zipPath), { recursive: true })
  const zipped = spawnSync('python', [join(ROOT, 'scripts', 'zip-stage.py'),
    '--stage', STAGE, '--out', zipPath, '--level', '6', '--no-overwrite'], { encoding: 'utf8' })
  console.log((zipped.stdout ?? '').trim())
  if (zipped.status !== 0 || !existsSync(zipPath)) {
    fail((zipped.stderr ?? '').trim() || `压缩失败（exit=${String(zipped.status)}）`)
  }
} else {
  execFileSync('powershell', compressArgs, { stdio: 'pipe' })
}

if (!safeMode) rmSync(STAGE, { recursive: true, force: true })

const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
const sizeMb = (readFileSync(zipPath).length / 1024 / 1024).toFixed(2)
console.log(`\n${zipName}  (${sizeMb} MB)`)
console.log(`sha256: ${sha256}`)
console.log(zipPath)
if (safeMode) console.log(`暂存目录已保留（不删除）：${STAGE}`)
