/**
 * 打「插件增量更新包」——只含 overlay（`home\profiles\desktop\` 下那部分），几十 KB。
 *
 * 为什么需要它：便携版整包 472MB，其中 dsh 本体占 1.2G（解压后）、每次发版完全不变，
 * 插件侧真实变化只有 407KB。给已经装过旧包的用户重下 472MB 是纯粹的浪费。
 *
 * 用法：
 *   node scripts/package-plugin-update.mjs [--version 0.2.8] [--out dist/xxx.zip]
 *   node scripts/package-plugin-update.mjs --probe-token XXX   # 自检专用：注入一行可识别的打印
 *
 * 产出（默认 `dist/dsh-webops-plugin-update-v<ver>.zip`），内部结构对应便携包根目录：
 *   home\profiles\desktop\node_modules\dsh-webops-plugin\{lib\, package.json, cordis.patch.yml}
 *   更新说明.txt
 *
 * 两条设计约束（都是踩出来的）：
 *   1. **不碰 `home\profiles\desktop\package.json`**。那份 manifest 是用户的，
 *      可能登记了他自己在桌面端里装过的其它插件；整份覆盖会把它们抹掉。
 *      而不动它**没有任何代价**（2026-09-19 查证）：`profile-plugins.ts:64-77` 的
 *      `version: installed?.version ?? spec` 里 `installed` 读的是
 *      `profileDir/node_modules/<name>/package.json` —— 版本号与 bundle 判定都取自插件自身目录。
 *      另外：只换 node_modules 下这个插件目录就能生效（scripts/verify-plugin-update.mjs 三轮启动实测）——
 *      启动时 `applyRelease()` 不跑包管理器、不校验依赖版本
 *      （`apps/desktop/src/project-manager.ts:86` 注释：without installing packages），
 *      `cleanProfileCorePackages` 也只删 app-owned core 包。
 *   2. 产物必须是**真实文件**，不能用 symlink 压缩进去（`validateDesktopPluginGraph` 见链就拒）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PLUGIN_NAME = 'dsh-webops-plugin'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const probeToken = readArg('probe-token')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = readArg('version') ?? pkg.version
const out = resolve(readArg('out') ?? join(DIST, `${PLUGIN_NAME}-update-v${version}.zip`))

// 产物来自 `lib/`（tsdown 输出），没 build 就打出来的是上一版的代码，且不会报错。
for (const rel of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
  if (!existsSync(join(ROOT, rel))) {
    console.error(`package-plugin-update: 缺少 ${rel} —— 先跑 pnpm build`)
    process.exit(1)
  }
}
if (existsSync(out) && !args.includes('--force')) {
  console.error(`package-plugin-update: 目标已存在 ${out}`)
  console.error('package-plugin-update: 确认要覆盖就加 --force（与 package-desktop-portable 的删旧重写不同，这里默认拒绝，防止把一份验证过的更新包悄悄冲掉）')
  process.exit(1)
}
if (existsSync(out) && args.includes('--force')) {
  rmSync(out)
  console.warn(`package-plugin-update: --force，已移除旧的 ${out}`)
}

const stage = mkdtempSync(join(tmpdir(), 'dsh-plugin-update-'))
const profileInZip = join(stage, 'home', 'profiles', 'desktop')
const pluginDir = join(profileInZip, 'node_modules', PLUGIN_NAME)
mkdirSync(pluginDir, { recursive: true })

cpSync(join(ROOT, 'lib'), join(pluginDir, 'lib'), { recursive: true })
cpSync(join(ROOT, 'cordis.patch.yml'), join(pluginDir, 'cordis.patch.yml'))
const releasePkg = { ...pkg, version }
delete releasePkg.devDependencies
delete releasePkg.scripts
writeFileSync(join(pluginDir, 'package.json'), `${JSON.stringify(releasePkg, null, 2)}\n`)
console.log(`  + home/profiles/desktop/node_modules/${PLUGIN_NAME}/`)

// **不动** `home/profiles/desktop/package.json`：那份 manifest 是用户的，可能登记了他自己装的插件，
// 整份覆盖会把它们抹掉。而且**不动它没有任何代价**（2026-09-19 查证）：
// `packages/boot/app-boot/src/profile-plugins.ts:64-77` 里
// `version: installed?.version ?? spec`，`installed` 读的是
// `profileDir/node_modules/<name>/package.json` —— 插件管理页显示的版本取自插件自身目录；
// 同处第 72 行的 bundle 判定也读插件自身，第 73 行的 `enabled` 读 manifest 的 bundles 列表（我们不动那个列表）。
console.log('  · 不动 home/profiles/desktop/package.json（保护用户自己装的插件登记）')

// 自检专用：往客户端产物顶部插一行打印，用来证明「拉到的 bundle 就是这一份 lib 打出来的」。
// 正式产物不带它（不传参就不写）。
if (probeToken !== undefined) {
  const clientPath = join(pluginDir, 'lib', 'client.js')
  const body = readFileSync(clientPath, 'utf8')
  writeFileSync(clientPath, `console.log("${probeToken}")\n${body}`)
  console.log(`  · 注入自检探针 ${probeToken}`)
}

writeFileSync(
  join(stage, '更新说明.txt'),
  [
    `${PLUGIN_NAME} 增量更新包 v${version}`,
    '',
    '【适用】',
    '  已经装过 dsh 桌面端便携版、只想把插件升到新版。',
    '  home\\ 目录还在（没删过数据）、便携包能正常启动时用这个；',
    '  整包重下没必要 —— dsh 本体一个字节都没变。',
    '',
    '【用法】',
    '  1) 完全退出 dsh 桌面端（任务栏右下角退出；正在跑着会占住文件，覆盖会失败）',
    '  2) 把这个 zip **解压到便携包的根目录**（与 home\\、app\\ 同层那一层），选「覆盖」',
    '     PowerShell 等价写法（把路径换成你的）：',
    '',
    '       Expand-Archive -Path 更新包.zip -DestinationPath D:\\dsh-webops -Force',
    '',
    '     解压后应看到文件落在 home\\profiles\\desktop\\node_modules\\dsh-webops-plugin\\ 下；',
    '     落成了 profiles\\... 开头说明你选错了解压目标，退回去重来。',
    '  3) 重新启动，插件即新版，会话 / 设置 / 凭据都不受影响（都在 home\\ 里，本包不碰）',
    '',
    '【关于 lib\\ 里的旧文件】',
    '  构建产物的 chunk 名带内容哈希（如 provider-XXXX.js），每次发版名字都不一样，',
    '  而覆盖式更新只加新的、**不删旧的** —— 所以 lib\\ 里会留下上一版的 chunk。',
    '  它们不参与加载（入口引用的是新名字），不影响功能，只是占几十 KB。',
    '  想彻底清干净：先删掉 home\\profiles\\desktop\\node_modules\\dsh-webops-plugin\\lib\\ 再解压本包。',
    '',
    '【本包改了什么】',
    `  只替换 home\\profiles\\desktop\\node_modules\\${PLUGIN_NAME}\\ 整个目录。`,
    '  profile 的 package.json 不动 —— 那是你的文件，可能登记了你自己装过的其它插件，',
    '  整份覆盖会把它们抹掉。副作用：插件管理页里看到的版本号可能还是旧的，不影响功能。',
    '',
    '【没生效怎么查】',
    '  · 确认 dsh 已经完全退出后重新覆盖一次（最常见的失败就是进程还占着文件）',
    '  · 确认解压目标层面对（见上面第 2 步）',
    '  · 覆盖完看一眼 home\\profiles\\desktop\\node_modules\\dsh-webops-plugin\\package.json 的 version',
    `    是不是 ${version}；不是就说明没盖上去`,
    '',
  ].join('\r\n'),
  { encoding: 'utf8' },
)

mkdirSync(DIST, { recursive: true })
const zipped = spawnSync('python', [join(ROOT, 'scripts', 'zip-stage.py'), '--stage', stage, '--out', out], { encoding: 'utf8' })
console.log((zipped.stdout ?? '').trim())
if (zipped.status !== 0 || !existsSync(out)) {
  console.error(`package-plugin-update: 压缩失败（exit=${String(zipped.status)}）`)
  console.error((zipped.stderr ?? '').trim() || '(无 stderr)')
  process.exit(1)
}

const bytes = readFileSync(out)
const sha256 = createHash('sha256').update(bytes).digest('hex')
console.log(`\n产物: ${out}`)
console.log(`体积: ${String(Math.round(statSync(out).size / 1024))} KB（整包 zip 是 472MB）`)
console.log(`sha256: ${sha256}`)

rmSync(stage, { recursive: true, force: true })
