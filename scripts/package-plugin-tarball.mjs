/**
 * 打「插件 npm tarball」——`dsh-webops-plugin-<version>.tgz`，与独立插件 zip 同源同内容
 * （npm files 白名单自动剔除 INSTALL.md，属 npm pack 标准语义）。
 *
 * 为什么需要它（2026-11-19 实测定位）：本插件是本地包，从未发布到任何 registry；
 * 而宿主的 install_bundle 就是 profile 目录里的 `pnpm add <spec>`，会**全量解析** profile
 * 的 dependencies —— 出厂登记写精确版本 `0.2.28` 时，任何一次 install_bundle 都对
 * registry.npmjs.org/dsh-webops-plugin 404。把出厂登记改成 `file:` 相对路径指向包内
 * 这份不可变 tarball 后，解析永远有本地事实来源，install_bundle 任意时刻可用。
 *
 * 为什么不直接对本仓根跑 `npm pack`：根 package.json 带着 13 个 `link:` 开发期依赖与
 * scripts，进 tgz 会让任何 install 炸掉。这里与 package-portable.mjs 同一口径净化
 * （剔 devDependencies / scripts / exports['./fake-llm']），在干净暂存目录里 pack。
 *
 * 保留安全模式：唯一新暂存目录（mkdtemp，保留不删除）、输出必须尚不存在、全程零删除。
 *
 * 用法：
 *   node scripts/package-plugin-tarball.mjs --lib-dir <本轮构建目录> [--version 0.2.28]
 *        [--out dist/dsh-webops-plugin-<version>.tgz] [--stage-root <D 盘暂存父目录>]
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

const fail = (msg) => {
  console.error(`package-plugin-tarball: ${msg}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
for (let i = 0; i < args.length; i += 1) {
  if (!['--lib-dir', '--version', '--out', '--stage-root'].includes(args[i])) fail(`未知参数：${args[i]}`)
  if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail(`${args[i]} 缺少路径值`)
  i += 1
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = readArg('version') ?? pkg.version
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) fail(`版本号不合法：${version}`)

const libArg = readArg('lib-dir')
if (!libArg) fail('--lib-dir 必须显式指定本轮构建目录；拒绝回退到仓库旧 lib')
const libDir = resolve(libArg)
const tarballName = `${pkg.name}-${version}.tgz`
const out = resolve(readArg('out') ?? join(DIST, tarballName))
if (basename(out) !== tarballName) fail(`输出文件名必须是 ${tarballName}（npm pack 的标准命名，登记与自检按它对齐）：${out}`)
if (existsSync(out)) fail(`目标已存在：${out} —— 保留安全模式不覆盖既有产物，换一个未存在的 --out 路径`)
const stageRoot = resolve(readArg('stage-root') ?? join(ROOT, '.portable-stage'))

// 完整性前置：与 package-portable.mjs 同一清单，缺哪个报哪个，不静默打出残包。
for (const from of ['cordis.patch.yml', 'README.md', 'LICENSE']) {
  if (!existsSync(join(ROOT, from))) fail(`缺少 ${join(ROOT, from)}（仓库文件缺失）`)
}
for (const file of ['index.js', 'client.js',
  ...['host.cjs', 'action-overlay.cjs', 'action-overlay.html', 'tabbar.html', 'tabbar-preload.cjs']
    .map(name => join('browser-electron', name))]) {
  if (!existsSync(join(libDir, file))) fail(`缺少 ${join(libDir, file)} —— lib-dir 不是完整运行时，先构建并运行 copy-assets`)
}

mkdirSync(stageRoot, { recursive: true })
const stage = mkdtempSync(join(stageRoot, 'dsh-plugin-tarball-'))
// npm pack 的产物以 `package/` 为前缀，所以暂存目录本身就叫 package。
const pkgDir = join(stage, 'package')
mkdirSync(pkgDir, { recursive: true })
cpSync(libDir, join(pkgDir, 'lib'), {
  recursive: true,
  // 与独立插件 zip / 增量包同一口径：测试模型不出货。
  filter: source => resolve(source) !== join(libDir, 'fake-llm'),
})
for (const from of ['cordis.patch.yml', 'README.md', 'LICENSE']) {
  cpSync(join(ROOT, from), join(pkgDir, from))
}
// 净化口径同 package-portable.mjs：开发期 link: 依赖与本地脚本不进发布产物。
const releasePkg = { ...pkg, version }
releasePkg.exports = { ...pkg.exports }
delete releasePkg.exports['./fake-llm']
delete releasePkg.devDependencies
delete releasePkg.scripts
writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(releasePkg, null, 2)}\n`)
console.log(`  + 暂存 ${pkgDir}（保留，不删除；lib 已滤 fake-llm，package.json 已净化）`)

mkdirSync(dirname(out), { recursive: true })
// Windows 上 npm 是 npm.cmd；Node ≥18.20.2 禁止无 shell 直接 spawn .cmd（EINVAL，
// CVE-2024-27980 防护），所以 Windows 走 shell 并显式双引号包住路径（Windows 路径不能含 `"`）。
const packed = process.platform === 'win32'
  ? spawnSync(['npm pack', `"${pkgDir}"`, '--pack-destination', `"${dirname(out)}"`].join(' '), { encoding: 'utf8', shell: true })
  : spawnSync('npm', ['pack', pkgDir, '--pack-destination', dirname(out)], { encoding: 'utf8' })
if (packed.status !== 0 || !existsSync(out)) {
  console.error((packed.stdout ?? '').trim())
  fail((packed.stderr ?? '').trim() || `npm pack 失败（exit=${String(packed.status)}），产物未落盘：${out}`)
}

const bytes = readFileSync(out)
console.log(`\n产物: ${out}`)
console.log(`体积: ${(bytes.length / 1024).toFixed(1)} KB`)
console.log(`sha256: ${createHash('sha256').update(bytes).digest('hex')}`)
console.log(`sha512: sha512-${createHash('sha512').update(bytes).digest('base64')}`)
console.log(`暂存目录已保留（不删除）：${stage}`)
