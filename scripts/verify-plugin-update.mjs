/**
 * 自检「插件增量更新包」：给一份**已经启动过**的便携目录打上增量包，真起宿主看插件是否换血。
 *
 * 用法：
 *   node scripts/verify-plugin-update.mjs --dir <已解压的便携版目录> [--version 0.2.8]
 *   node scripts/verify-plugin-update.mjs --dir <已解压的便携版目录> --in-place
 *       # 追加「真实用户路径」：用 pwsh Expand-Archive 把增量包解压到包根目录覆盖，
 *       # 并断言 home 里除插件目录外的文件 byte-for-byte 不变（会话 / 设置 / 凭据安全）。
 *       # 会真的改动 --dir 那份（跑完还原），该目录此后不再「刚解压没启动过」。
 *
 * 三轮启动（每轮都是真起 desktop-host，不是读文件）：
 *   [1] 出厂 lib          → 客户端 bundle 里**不该**出现探针（反向：排除「bundle 里本来就有这串」）
 *   [2] 覆盖增量包之后    → 探针**必须**出现（正向：覆盖生效）
 *   [3] 把插件还原成出厂  → 探针**必须**消失（反向：证明探针来自覆盖，不是残留或随机性）
 *
 * 为什么必须真起宿主：静态比对只能证明「zip 里的文件对」，证明不了「dsh 会去读它」。
 * 打包态有没有落盘缓存、bundle 是不是每次重打，只有真跑一遍才知道 —— 2026-09-19 的
 * 结论是「没有缓存、覆盖即生效」（bundle 字节数随 lib 精确变化），本脚本就是那条结论的护栏：
 * 上游哪天引入 bundle 缓存，[2] 会立刻转红。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchHostPath, startPackagedDesktopHost } from './run-packaged-host.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-webops-plugin'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const keep = args.includes('--keep')
const dir = readArg('dir')
if (dir === undefined) {
  console.error('用法: node scripts/verify-plugin-update.mjs --dir <已解压的便携版目录> [--version x.y.z]')
  process.exit(1)
}
const packageRoot = resolve(dir)
const appDir = join(packageRoot, 'app')
const runtimeDir = join(appDir, 'resources', 'dsh')
const srcProfile = join(packageRoot, 'home', 'profiles', 'desktop')
for (const [label, path] of [['app', appDir], ['runtime', runtimeDir], ['profile', srcProfile]]) {
  if (!existsSync(path)) {
    console.error(`verify-plugin-update: ${packageRoot} 缺 ${label}（${path}）`)
    process.exit(1)
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = readArg('version') ?? pkg.version
const probeToken = `OVERLAY_PROBE_${Date.now().toString(36).toUpperCase()}`

let failures = 0
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures += 1
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-plugin-update-verify-'))
const zipPath = join(scratch, 'update.zip')
const unzipped = join(scratch, 'unzipped')
const profile = join(scratch, 'desktop')
const home = join(scratch, 'home')

/* ---------- 1. 生成带探针的增量包 ---------- */

console.log('\n[1/4] 生成带自检探针的增量包')
const packed = spawnSync(
  process.execPath,
  [join(ROOT, 'scripts', 'package-plugin-update.mjs'), '--version', version, '--out', zipPath, '--probe-token', probeToken],
  { encoding: 'utf8', cwd: ROOT },
)
console.log((packed.stdout ?? '').trim())
if (packed.status !== 0 || !existsSync(zipPath)) {
  console.error((packed.stderr ?? '').trim() || '(无 stderr)')
  console.error('verify-plugin-update: 增量包没打出来')
  process.exit(1)
}
check(statSync(zipPath).size < 2 * 1024 * 1024,
  `增量包体积 ${String(Math.round(statSync(zipPath).size / 1024))} KB（应当远小于整包 472MB）`)

/* ---------- 2. 解开增量包，核对内容就是工作区的 lib ---------- */

console.log('\n[2/4] 解开增量包并与工作区 lib 逐文件比对')
const unzip = spawnSync('python', [join(ROOT, 'scripts', 'unzip-portable.py'), '--zip', zipPath, '--dir', unzipped], { encoding: 'utf8' })
console.log((unzip.stdout ?? '').trim())
if (unzip.status !== 0) {
  console.error((unzip.stderr ?? '').trim() || '(无 stderr)')
  console.error('verify-plugin-update: 增量包解不开')
  process.exit(1)
}

const pluginInZip = join(unzipped, 'home', 'profiles', 'desktop', 'node_modules', PLUGIN_NAME)
check(existsSync(pluginInZip), 'zip 内的路径是 home/profiles/desktop/node_modules/<插件>（可直接盖到便携包根目录）')
check(existsSync(join(pluginInZip, 'cordis.patch.yml')), 'zip 内含 cordis.patch.yml（ptc-runtime 覆盖靠它）')

/** 遍历一个目录，返回 rel → sha256。 */
function inventory(root) {
  const out = new Map()
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(childAbs, childRel)
      else out.set(childRel, createHash('sha256').update(readFileSync(childAbs)).digest('hex'))
    }
  }
  walk(root, '')
  return out
}

const shippedLib = inventory(join(ROOT, 'lib'))
const zippedLib = inventory(join(pluginInZip, 'lib'))
const missing = [...shippedLib.keys()].filter(rel => !zippedLib.has(rel))
const differing = [...shippedLib.entries()]
  .filter(([rel, hash]) => rel !== 'client.js' && zippedLib.get(rel) !== hash)
  .map(([rel]) => rel)
check(missing.length === 0, `工作区 lib 的 ${String(shippedLib.size)} 个文件都在增量包里${missing.length === 0 ? '' : `（缺：${missing.slice(0, 5).join(', ')}）`}`)
check(differing.length === 0,
  `除 client.js 外逐字节一致（client.js 被注入了探针，单独验）${differing.length === 0 ? '' : `（不一致：${differing.slice(0, 5).join(', ')}）`}`)
check((zippedLib.get('client.js') ?? '').length > 0 && readFileSync(join(pluginInZip, 'lib', 'client.js'), 'utf8').includes(probeToken),
  'client.js 含本次注入的探针（后面靠它判断加载的是不是这一份）')

// 越界检查：这个包会被用户直接解压到便携包根目录，多带任何一个 home 下的文件都是
// 覆盖用户数据的行为（settings.yaml / 凭据 / profile manifest 尤其不能碰）。
const allEntries = inventory(unzipped)
const allowedPrefix = `home/profiles/desktop/node_modules/${PLUGIN_NAME}/`
const stray = [...allEntries.keys()].filter(rel => !rel.startsWith(allowedPrefix) && rel !== '更新说明.txt')
check(stray.length === 0,
  `增量包里只有插件目录与更新说明，没有越界文件${stray.length === 0 ? '' : `（越界：${stray.slice(0, 8).join(', ')}）`}`)

/* ---------- 3. 三轮启动 ---------- */

cpSync(srcProfile, profile, { recursive: true })
mkdirSync(home, { recursive: true })
// 出厂模型配置现在是 **profile 级文件**（profile patch），随上面那次 profile 拷贝一起进来，
// 不再是 `$DSH_HOME/settings.yaml`（0.1.7 已退役）。留一条存在性断言：它没进来的话，
// 后面的对话轮次会因为「没有可用模型」而失败 —— 那个症状离现场很远，不值得再查一次。
check(existsSync(join(profile, 'cordis.patch.yml')), '出厂 profile patch 随 profile 拷贝进了工作目录')
process.env.DSH_HOME = home
rmSync(join(home, '.credentials.yaml.lock'), { force: true })

const shippedPluginDir = join(srcProfile, 'node_modules', PLUGIN_NAME)

/** 起一次宿主，取插件的客户端 bundle。 */
async function boot(label, profileDir = profile) {
  let host
  try {
    host = startPackagedDesktopHost({ runtimeDir, profileDir, env: process.env, timeoutMs: 180_000 })
  } catch (error) {
    // 起宿主**之前**的端口预检会在这里抛（见 run-packaged-host 的 assertHostPortFree）。
    // 那一类失败（19387 被别的 dsh 实例占着）以前要等宿主起来后报「N required plugins
    // did not activate」，极易误判成产物问题；现在提前到起进程之前，并且带占用者 PID。
    // 转成一条 check 失败而不是让它冒泡：三轮启动的统计要留全，别让第一轮的端口问题
    // 把整份报告吃掉。
    check(false, `${label}：${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
  let ready
  try {
    ready = await host.ready
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(false, `${label}：宿主没起来 —— ${message}`)
    console.error(`    stderr: ${host.stderr().trim().slice(0, 600)}`)
    await host.stop()
    return ''
  }
  let bundle = ''
  const index = await fetchHostPath(ready.url, '/index.html')
  if (index.status !== 200) {
    check(false, `${label}：/index.html 返回 ${String(index.status)}`)
  } else {
    const html = index.body.toString('utf8')
    const marker = html.indexOf('__DSH_BOOT__')
    if (marker < 0) {
      check(false, `${label}：首页没有 __DSH_BOOT__`)
    } else {
      const braceAt = html.indexOf('{', marker)
      let depth = 0
      let end = -1
      for (let i = braceAt; i < html.length; i += 1) {
        if (html[i] === '{') depth += 1
        else if (html[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
      }
      const graph = JSON.parse(html.slice(braceAt, end))
      const entry = graph.entries.find(item => item.id === PLUGIN_NAME)
      if (entry === undefined) {
        check(false, `${label}：boot graph 里没有 ${PLUGIN_NAME}`)
      } else {
        const fetched = await fetchHostPath(ready.url, entry.url)
        bundle = fetched.body.toString('utf8')
      }
    }
  }
  await host.stop()
  return bundle
}

/**
 * 剥掉 dsh 每次启动现生成的 revision：`sourceMappingURL=...&rev=<每次都变>`
 * （实测同一份 lib 连起两次，bundle 也只有这一处不同）。比字节前必须先剥，
 * 否则「不同」可能只是 rev 变了，证明不了覆盖生效。
 */
const stable = text => text.replace(/&rev=[^\s"'&]+/g, '&rev=X')

console.log('\n[3/4] 三轮启动（出厂 → 覆盖增量包 → 还原出厂）')

const round1 = await boot('第 1 轮 / 出厂')
check(round1 !== '' && !round1.includes(probeToken),
  '第 1 轮：出厂 lib 的 bundle 里没有探针（反向验证 —— 排除「这串本来就在」）')

cpSync(join(unzipped, 'home', 'profiles', 'desktop'), profile, { recursive: true, force: true })
const coveredVersion = JSON.parse(readFileSync(join(profile, 'node_modules', PLUGIN_NAME, 'package.json'), 'utf8')).version
check(coveredVersion === version, `覆盖后 profile 里的插件版本是 ${version}（实际 ${String(coveredVersion)}）`)

const round2 = await boot('第 2 轮 / 覆盖后')
check(round2 !== '' && round2.includes(probeToken),
  '第 2 轮：覆盖后 bundle 里出现探针（覆盖生效，dsh 读的就是这份 lib）')
check(stable(round1) !== stable(round2),
  '第 2 轮 bundle（剥掉 rev 后）与第 1 轮不同（bundle 跟着 lib 重新打包，没有落盘缓存）')

cpSync(shippedPluginDir, join(profile, 'node_modules', PLUGIN_NAME), { recursive: true, force: true })
const round3 = await boot('第 3 轮 / 还原出厂')
check(round3 !== '' && !round3.includes(probeToken),
  '第 3 轮：还原成出厂 lib 后探针消失（反向验证 —— 探针来自覆盖，不是残留）')
check(stable(round3) === stable(round1),
  '第 3 轮 bundle（剥掉 rev 后）与第 1 轮一致（打包是确定性的，「不同」不是随机噪声）')

// 不断言，只提示：tsdown 的 chunk 名带内容哈希（出厂 provider-BcrHEy2a.js / 新版 provider-DzeE81dP.js），
// 覆盖式更新**不会**删掉旧 chunk。它们在 lib/ 里躺着不参与加载（入口引用的是新名），
// 不是 bug，但目录会留残骸 —— 已在增量包的说明里写明，想彻底清就先删 lib/ 再解压。
console.log('  · 提示：chunk 文件名带内容哈希，覆盖后旧 chunk 会留在 lib/ 里（不参与加载，属正常）')

/* ---------- 3.5 原地覆盖：走真实用户操作，落在 --dir 那份包上 ---------- */

if (args.includes('--in-place')) {
  console.log('\n[3.5] 原地覆盖（真实用户操作：把增量包解压到便携包根目录）')
  console.log(`  ⚠ 这一步会真的改动 ${packageRoot}（覆盖后还原），该目录此后不再「刚解压没启动过」`)

  // 先备份出厂插件目录：**不能拿 srcProfile 下那份当还原源** —— 原地模式下它就是要被
  // 删掉重拷的目标，删完源也没了（2026-09-19 第一版就崩在这里）。
  const factoryBackup = join(scratch, 'factory-plugin')
  cpSync(shippedPluginDir, factoryBackup, { recursive: true })

  // 用**包内** home 起一次 —— 便携模式的真实形态，home 里因此留下 storages / 会话数据，
  // 后面才有「用户数据有没有被覆盖弄丢」可验。
  process.env.DSH_HOME = join(packageRoot, 'home')
  const beforeBoot = await boot('原地 / 覆盖前（用包内 home 启动）', srcProfile)
  check(beforeBoot !== '' && !beforeBoot.includes(probeToken), '原地覆盖前：出厂 lib 的 bundle 没有探针')
  check(existsSync(join(packageRoot, 'home', 'storages', 'workspace.json')),
    `home\\storages\\workspace.json 已生成（这确实是个「用过」的包，保全断言才有意义）`)

  /** home 的文件指纹，排除插件目录本身。 */
  const snapshotHome = () => {
    const out = new Map()
    for (const [rel, hash] of inventory(join(packageRoot, 'home'))) {
      if (!rel.startsWith(`profiles/desktop/node_modules/${PLUGIN_NAME}/`)) out.set(rel, hash)
    }
    return out
  }
  const homeBefore = snapshotHome()
  const manifestBefore = createHash('sha256').update(readFileSync(join(srcProfile, 'package.json'))).digest('hex')

  // 真实用户动作：把 zip 解压到便携包根目录。首选 pwsh 的 Expand-Archive（用户最常用的方式），
  // 失败退化到 python（本机 pwsh 输出恒为空，只能看退出码 + 产物）。
  const expanded = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${packageRoot}' -Force`],
    { encoding: 'utf8' },
  )
  const coveredByPwsh = existsSync(join(srcProfile, 'node_modules', PLUGIN_NAME, 'package.json'))
    && JSON.parse(readFileSync(join(srcProfile, 'node_modules', PLUGIN_NAME, 'package.json'), 'utf8')).version === version
  if (!coveredByPwsh) {
    console.log(`  · Expand-Archive 未达成（exit=${String(expanded.status)}），退化到 unzip-portable.py`)
    const fallback = spawnSync('python', [join(ROOT, 'scripts', 'unzip-portable.py'), '--zip', zipPath, '--dir', packageRoot], { encoding: 'utf8' })
    console.log((fallback.stdout ?? '').trim())
  } else {
    console.log(`  · Expand-Archive 覆盖成功（exit=${String(expanded.status)}）`)
  }

  const homeAfter = snapshotHome()
  const changed = [...homeBefore.entries()].filter(([rel, hash]) => homeAfter.get(rel) !== hash).map(([rel]) => rel)
  const lost = [...homeBefore.keys()].filter(rel => !homeAfter.has(rel))
  check(lost.length === 0, `覆盖后 home 里原有 ${String(homeBefore.size)} 个文件一个没少${lost.length === 0 ? '' : `（少了：${lost.slice(0, 8).join(', ')}）`}`)
  check(changed.length === 0, `覆盖后这些文件 byte-for-byte 未变（会话 / 设置 / 凭据安全）${changed.length === 0 ? '' : `（变了：${changed.slice(0, 8).join(', ')}）`}`)
  check(createHash('sha256').update(readFileSync(join(srcProfile, 'package.json'))).digest('hex') === manifestBefore,
    'profile 的 package.json 没被动（用户自己装的插件登记不会被抹）')

  const afterBoot = await boot('原地 / 覆盖后（用包内 home 启动）', srcProfile)
  check(afterBoot !== '' && afterBoot.includes(probeToken),
    '原地覆盖后：bundle 出现探针（走真实解压动作也一样生效）')

  // 还原：整个插件目录删掉再拷回出厂那份（合并式会留下新版多出的 chunk）。
  rmSync(join(srcProfile, 'node_modules', PLUGIN_NAME), { recursive: true, force: true })
  cpSync(factoryBackup, join(srcProfile, 'node_modules', PLUGIN_NAME), { recursive: true })
  console.log('  · 已把插件目录还原成出厂态（从覆盖前的备份拷回，chunk 残骸一并清掉）')
}

/* ---------- 4. 收尾 ---------- */

console.log('\n[4/4] 结论')
if (failures === 0) {
  console.log('✅ 增量更新包可独立分发：只换 home\\profiles\\desktop\\node_modules\\<插件> 即生效，'
    + 'dsh 启动时不重装、不联网、无 bundle 缓存。')
} else {
  console.log(`❌ ${String(failures)} 项失败 —— 增量包不能发（最常见原因：上游引入了 bundle 缓存，或插件入口路径变了）。`)
}

if (keep) console.log(`临时目录保留：${scratch}`)
else rmSync(scratch, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
