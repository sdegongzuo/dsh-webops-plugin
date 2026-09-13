/**
 * 打 Windows x64 便携版 zip。
 *
 * 便携版 = **免构建**的产物包：`lib/` 已经编译好，解压后直接 `dsh plugin add <目录>`
 * 即可加载，用户端不需要 pnpm / tsdown / TypeScript，也不需要本地的 deepseek-harness
 * checkout（开发期那 13 个 `link:` 依赖在发布包里被剔除）。
 *
 * 用法：
 *   node scripts/package-portable.mjs              # 版本取 package.json
 *   node scripts/package-portable.mjs 0.1.0        # 显式指定
 *
 * 产出：
 *   dist/dsh-webops-plugin-<version>-win-x64-portable.zip
 *
 * 打包走 PowerShell 的 Compress-Archive：本机（Git Bash）和 GitHub 的 windows-latest
 * runner 都有，不必依赖外部 zip 工具。
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const STAGE = join(ROOT, '.portable-stage')

/** 相对仓库根 → 包内相对路径。目录整体拷贝，文件单拷贝。 */
const PAYLOAD = [
  ['lib', 'lib'],
  ['cordis.patch.yml', 'cordis.patch.yml'],
  ['package.json', 'package.json'],
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
  ['docs/portable-install.md', 'INSTALL.md'],
]

const fail = (msg) => {
  console.error(`package-portable: ${msg}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = process.argv[2] ?? pkg.version

if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  fail(`版本号不合法: ${version}`)
}
for (const [from] of PAYLOAD) {
  if (!existsSync(join(ROOT, from))) fail(`缺少 ${from}，先跑 pnpm build`)
}

const zipName = `dsh-webops-plugin-v${version}-win-x64-portable.zip`
const zipPath = join(DIST, zipName)

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })
mkdirSync(STAGE, { recursive: true })
if (existsSync(zipPath)) rmSync(zipPath)

for (const [from, to] of PAYLOAD) {
  const src = join(ROOT, from)
  const dst = join(STAGE, to)
  cpSync(src, dst, { recursive: true })
  console.log(`  + ${to}`)
}

// 发布用的 package.json：剔掉开发期专属的东西。
// - devDependencies 里那 13 个 `link:../deepseek-harness/...` 指向本机的 dsh checkout，
//   便携版里它们指向不存在的路径，留着只会让任何试图 install 的工具炸掉。
// - scripts 里的 dev:desktop / smoke:* 依赖 harness 与本地 Chrome，发布包里跑不了。
// 其余字段（name / exports / dsh / peerDependencies）原样保留 —— dsh 的 Loader 与
// 桌面端的 validateDesktopPluginGraph 读的就是这些。
const releasePkg = { ...pkg, version }
delete releasePkg.devDependencies
delete releasePkg.scripts
writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(releasePkg, null, 2)}\n`)
console.log('  + package.json (已剔除 devDependencies / scripts)')

execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${join(STAGE, '*')}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
  ],
  { stdio: 'pipe' },
)

rmSync(STAGE, { recursive: true, force: true })

const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
const sizeMb = (readFileSync(zipPath).length / 1024 / 1024).toFixed(2)
console.log(`\n${zipName}  (${sizeMb} MB)`)
console.log(`sha256: ${sha256}`)
console.log(zipPath)
