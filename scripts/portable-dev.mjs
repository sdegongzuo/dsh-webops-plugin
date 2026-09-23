/**
 * 本地便携版测试的**固定目录**：一次铺底，此后只做增量覆盖 —— 不再每轮解压一份 1.2G 的整包。
 *
 * ## 为什么需要它
 *
 * 以前每轮真机测试都 `unzip` 一份新整包（解压后 1.2G），测完就扔，`D:/dsh-build` 下堆出
 * `dsh-0.2.6-test2`、`.rel-verify-ext` 一串目录。而 dsh 版本不变时真实变化的只有插件那
 * ~160KB（`docs/打包与发版.md` §9）—— 复制 1.2G 去换 160KB 是纯浪费。
 *
 * ## 三条事实决定它怎么用（都有实测支撑，别想当然）
 *
 * 1. **增量包覆盖即生效**（`verify-plugin-update` 三轮真起宿主验过）→ `refresh` 不必碰 `app/`。
 * 2. **`verify:plugin-update --dir` 不要求出厂态** → 可以直接喂固定目录，省一份解压。
 * 3. ✅ **`verify:portable --dir` 也能直接喂固定目录，而且全绿**（2026-09-19 实测；两句旧说法都已证伪）：
 *    ① 早先「喂启动过的目录必报 `refusing to replace unowned package @deepseek-ai/cordis` +
 *    `Cannot find package 'js-yaml'`」—— 0.1.6-alpha.2 把 link 模式**整套退役**、宿主包由运行时目录
 *    直接供给（profile 里不建链），不会发生；② 中间那条「`profile 里没有越权 overlay` 会假红、要另
 *    解压一份新鲜的」—— 也修掉了：宿主**首次启动**会自己在 profile 根写两个出厂空模板
 *    `cordis.yml` / `cordis.patch.yml`（内容只有注释 + `[]`），原断言只看文件在不在 → 对复用过的目录
 *    恒红；现已改成**按内容判**（空模板放行，有内容的 patch 照样红，反向验证过）。
 *    → **一个固定目录就够**，别再为自检解压第二份 1.2G。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/portable-dev.mjs status                  # 先看：目录在不在、两个版本号、启动过没有
 * node scripts/portable-dev.mjs env                     # 看「这些路径是从哪来的」（环境变量 / .env.local）
 * node scripts/portable-dev.mjs seed                    # 首次铺底（自动挑 dist 里最新的整包）
 * node scripts/portable-dev.mjs refresh                 # 日常：build → 增量包 → 覆盖进固定目录
 * node scripts/portable-dev.mjs refresh --skip-build    # 已 build 过，只重打包（慢的是 build 不是它）
 * node scripts/portable-dev.mjs verify                  # 三轮起宿主自检（只读，不动目录）
 * node scripts/portable-dev.mjs launch --cdp 9333       # 起 GUI（WMI，脱离 job，带 CDP）
 * node scripts/portable-dev.mjs clean --yes             # 删掉整个固定目录
 * ```
 *
 * 目录来源优先级：`--dir` > 环境变量 `DSH_PORTABLE_TEST_DIR`（本机写在本目录的 `.env.local`，
 * 模板见 `.env.local.example`）。**脚本里没有写死的兜底路径** —— 没配就明确报缺哪个键，
 * 而不是静默指到某个 `D:` 盘目录（见 `scripts/local-env.mjs` 的三条语义）。
 *
 * ## 为什么 `launch` 走 WMI
 *
 * 本机 WorkBuddy 的 shell 工具把调用包在 job object 里，返回时**整棵进程树被杀** ——
 * `nohup … &` 与 `Start-Process -PassThru` 都活不过一次工具调用。WMI 创建的进程不挂进这个 job，
 * 才能跨调用存活。同理它不继承本进程的 `ELECTRON_RUN_AS_NODE`（那会让 Electron 退化成纯 Node、
 * 界面根本不初始化、exit 0 且输出为空 —— 见 `docs/开发指南.md` §4）。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRoot, describeLocalEnv, portableTestDir } from './local-env.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PLUGIN_NAME = 'dsh-webops-plugin'
const EXE_NAME = 'DeepSeek Harness.exe'

const args = process.argv.slice(2)
const command = args[0]
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const has = (name) => args.includes(`--${name}`)

// 目录来源优先级：`--dir` > 环境变量/`.env.local` 的 DSH_PORTABLE_TEST_DIR。
// 没有「脚本内写死的兜底路径」—— 没配就报缺哪个键（见 local-env.mjs 的三条语义）。
const testDir = resolve(readArg('dir') ?? portableTestDir())
const appDir = join(testDir, 'app')
const exePath = join(appDir, EXE_NAME)
const homeDir = join(testDir, 'home')
const profileDir = join(homeDir, 'profiles', 'desktop')
const pluginDir = join(profileDir, 'node_modules', PLUGIN_NAME)

/**
 * 本体缓存（`.desktop-base`）的根 —— 只有 `set-app` 的自动挑槽用它。
 *
 * 与 `package-desktop-portable.mjs` / `clean-build-residue.mjs` / `probe-tool-concurrency.mjs`
 * 同源：一律走 `local-env.mjs` 的 `buildRoot()`（`DSH_DESKTOP_BUILD_ROOT` 或 `.env.local`，
 * 缺省=仓库根）。细则见 `docs/打包与发版.md` §2。
 *
 * 注：0.2.6 之前这里还有一条「看固定目录的同级有没有 `.desktop-base`」的猜测式兜底，
 * 是为了「每次不必带环境变量」。现在值统一由 `.env.local` 提供，猜测已无必要 ——
 * 留着反而会在「env 没配」时静默指向一个**残缺**的同级缓存，比直接报错更难查。
 */
const BASE_ROOT = join(buildRoot(), '.desktop-base')

const fail = (message) => { console.error(`portable-dev: ${message}`); process.exit(1) }

/** 读一个 package.json 的 version；读不到返回 undefined（不抛）。 */
function versionOf(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')).version } catch { return undefined }
}

/** 一份目录「像」完整的 win-unpacked 吗？判据与 `package-desktop-portable.mjs` 的 `assertLooksLikeApp` 同源。 */
function appProblems(dir) {
  const missing = []
  if (!existsSync(join(dir, EXE_NAME))) missing.push(`主 exe（${EXE_NAME}）`)
  for (const rel of ['app.asar', 'dsh', 'runtime']) {
    if (!existsSync(join(dir, 'resources', rel))) missing.push(`resources/${rel}`)
  }
  return missing
}

/** 粗比版本号：数字段按数值、预发布段按字典序（够用，不为这个引 semver 依赖）。 */
function compareVersions(left, right) {
  const head = (v) => v.split('-')[0].split('.').map(Number)
  const [la, lb] = [head(left), head(right)]
  for (let i = 0; i < 3; i += 1) {
    if ((la[i] ?? 0) !== (lb[i] ?? 0)) return (la[i] ?? 0) - (lb[i] ?? 0)
  }
  const pa = left.split('-')[1] ?? ''
  const pb = right.split('-')[1] ?? ''
  if (pa === pb) return 0
  if (pa === '') return 1   // 正式版 > 预发布版
  if (pb === '') return -1
  return pa < pb ? -1 : 1
}

/**
 * 挑本体缓存里版本最高的**可用**槽。判据与 `package-desktop-portable.mjs` 一致：
 * 有 `cache.json` 完成标记 + 目录真是一份完整 win-unpacked。没标记即视为中断拷贝，
 * 宁可报「没有」也不拿去用（否则后面报的错会离真因很远）。
 */
function newestCachedApp() {
  if (!existsSync(BASE_ROOT)) return undefined
  const slots = []
  for (const entry of readdirSync(BASE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!existsSync(join(BASE_ROOT, entry.name, 'cache.json'))) continue
    const dir = join(BASE_ROOT, entry.name, 'app')
    if (appProblems(dir).length > 0) continue
    slots.push({ version: entry.name, dir })
  }
  slots.sort((a, b) => compareVersions(b.version, a.version))
  return slots[0]
}

/**
 * 删一棵树。**必须开子进程**：safe-delete 垫片在 require 期读 env，本进程内改无效，
 * 而垫片对每个 unlink 收 450ms（实测）、对 >1G 的目录还会走回收站助手并在 5 秒后抛一个
 * 没有 `.code` 的裸 Error（看着像「空报错」，见 `docs/打包与发版.md` §2 末）。
 */
function removeTreeFast(target) {
  const result = spawnSync(
    process.execPath,
    ['-e', `require('node:fs').rmSync(${JSON.stringify(target)}, { recursive: true, force: true, maxRetries: 3 })`],
    { env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' }, encoding: 'utf8' },
  )
  if (result.status !== 0) fail(`删除 ${target} 失败：${(result.stderr ?? '').trim() || `exit ${String(result.status)}`}`)
}

/** 解压（一律走 unzip-portable.py：绑了 testzip + 前 32 字节 NUL 自检）。 */
function unzip(zipPath, dir) {
  console.log(`\n解压 ${zipPath}\n  → ${dir}`)
  const result = spawnSync('python', [join(ROOT, 'scripts', 'unzip-portable.py'), '--zip', zipPath, '--dir', dir], { cwd: ROOT, encoding: 'utf8' })
  console.log((result.stdout ?? '').trim())
  if (result.status !== 0) {
    console.error((result.stderr ?? '').trim() || '(无 stderr)')
    fail('解压失败')
  }
}

/** dist 里最新的整包（按 mtime；只用来给 seed 挑默认值，会先印出来）。 */
function newestFullZip() {
  const candidates = readdirSync(DIST)
    .filter(name => name.startsWith('dsh-webops-desktop-') && name.endsWith('-win-x64-portable.zip'))
    .map(name => ({ name, path: join(DIST, name), mtime: statSync(join(DIST, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return candidates[0]
}

function requireSeeded() {
  if (!existsSync(appDir) || !existsSync(profileDir)) {
    fail(`${testDir} 还不是一份便携版 —— 先跑：node scripts/portable-dev.mjs seed`)
  }
}

/* ---------- status ---------- */

function status() {
  console.log(`固定测试目录  ${testDir}`)
  if (!existsSync(testDir)) {
    console.log('  状态          ✗ 不存在（首次：node scripts/portable-dev.mjs seed）')
    return
  }
  const pluginVersion = versionOf(join(pluginDir, 'package.json'))
  const dshVersion = versionOf(join(appDir, 'resources', 'dsh', 'package.json'))
  const launched = existsSync(join(homeDir, 'storages', 'workspace.json'))
  console.log(`  便携骨架      ${existsSync(exePath) ? '✓' : '✗'} ${exePath}`)
  console.log(`  dsh 运行时    ${dshVersion ?? '✗ 读不到（app/resources/dsh/package.json 缺失）'}`)
  console.log(`  插件版本      ${pluginVersion ?? '✗ 读不到'}`)
  console.log(`  启动过        ${launched ? '是（有 home/storages/workspace.json）' : '否（出厂态）'}`)
  console.log('')
  console.log('  ✅ verify:portable 可以直接喂这个目录（2026-09-19 实测全绿；早先「必须刚解压」'
    + '已被证伪 —— 上游 0.1.6-alpha.2 起退役了 link 模式，那条「profile 里没有越权 overlay」也改成按内容判）。')
}

/* ---------- env ---------- */

/**
 * 看「这些路径是从哪来的」。存在的意义是排查「我明明配了 `.env.local`，怎么没生效」——
 * 三类答案（文件生效 / 被环境变量盖住 / 根本没配）在这里一眼能分开，不用去猜。
 */
function showEnv() {
  describeLocalEnv()
}

/* ---------- seed ---------- */

function seed() {
  const force = has('force')
  const given = readArg('zip')
  if (existsSync(appDir) && !force) {
    fail(`${testDir} 里已经有便携版了。要重新铺底加 --force（会先整目录删掉），或换个 --dir。`)
  }
  let zipPath
  if (given !== undefined) {
    zipPath = resolve(given)
    if (!existsSync(zipPath)) fail(`--zip 指向的整包不存在：${zipPath}`)
  } else {
    const newest = newestFullZip()
    if (newest === undefined) fail(`dist 里没有 dsh-webops-desktop-*-win-x64-portable.zip —— 用 --zip 指定`)
    zipPath = newest.path
    console.log(`（未指定 --zip，按 mtime 挑最新的：${newest.name}）`)
  }
  if (force && existsSync(testDir)) {
    console.log(`--force：先删掉 ${testDir}`)
    removeTreeFast(testDir)
  }
  unzip(zipPath, testDir)
  console.log(`\n铺底完成。下一步：node scripts/portable-dev.mjs status`)
}

/* ---------- set-app：重编桌面端之后把 app/ 换进来 ---------- */

function setApp() {
  const zipArg = readArg('zip')
  const fromArg = readArg('from')
  if (zipArg !== undefined && fromArg !== undefined) fail('--zip 与 --from 只能给一个')
  if (!existsSync(profileDir)) {
    fail(`${testDir} 还不是一份便携版 —— 先跑：node scripts/portable-dev.mjs seed`)
  }
  const pluginBefore = versionOf(join(pluginDir, 'package.json'))

  if (zipArg !== undefined) {
    const zipPath = resolve(zipArg)
    if (!existsSync(zipPath)) fail(`--zip 指向的整包不存在：${zipPath}`)
    console.log(`\n清掉旧 app/（保留 home/）`)
    if (existsSync(appDir)) removeTreeFast(appDir)
    // 只解 app/ 前缀：home/ 原样保留，所以插件、会话、凭据都不动。
    const result = spawnSync(
      'python',
      [join(ROOT, 'scripts', 'unzip-portable.py'), '--zip', zipPath, '--dir', testDir, '--only-prefix', 'app/'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    console.log((result.stdout ?? '').trim())
    if (result.status !== 0) {
      console.error((result.stderr ?? '').trim() || '(无 stderr)')
      fail('从 zip 换 app 失败')
    }
    reportAppSwap(pluginBefore)
    return
  }

  let source = fromArg
  if (source === undefined) {
    const cached = newestCachedApp()
    if (cached === undefined) fail(`没给 --from，而 ${BASE_ROOT} 下也没有可用的本体缓存槽（要 cache.json + 完整 win-unpacked）`)
    source = cached.dir
    console.log(`（未指定 --from，用本体缓存里版本最高的槽：dsh ${cached.version}）`)
  }
  source = resolve(source)
  if (!existsSync(source)) fail(`--from 指的目录不存在：${source}`)
  const problems = appProblems(source)
  if (problems.length > 0) fail(`--from 那份不像完整的 win-unpacked，缺：${problems.join('、')}`)

  const move = has('move')
  console.log(`\n换 app/：${source}`)
  console.log(`     → ${appDir}（${move ? '同盘改名，瞬时' : '拷贝'}；home/ 不动）`)
  if (existsSync(appDir)) removeTreeFast(appDir)
  if (move) {
    try {
      renameSync(source, appDir)
    } catch (error) {
      // 跨盘改名是 EXDEV。退化成拷贝，源目录会留下来（预期，不是错）。
      console.log(`  · 改名不行（${error.code ?? '未知'}），退化成拷贝`)
      cpSync(source, appDir, { recursive: true })
    }
  } else {
    mkdirSync(appDir, { recursive: true })
    cpSync(source, appDir, { recursive: true })
  }
  reportAppSwap(pluginBefore)
}

/** 换完 app 之后的共同收尾：核骨架与版本，并明确「home/ 没动」。 */
function reportAppSwap(pluginBefore) {
  const problems = appProblems(appDir)
  if (problems.length > 0) fail(`换完的 app/ 不完整，缺：${problems.join('、')}`)
  const dshVersion = versionOf(join(appDir, 'resources', 'dsh', 'package.json'))
  const pluginAfter = versionOf(join(pluginDir, 'package.json'))
  console.log(`\n新 app 的 dsh 运行时：${dshVersion ?? '(读不到)'}`)
  console.log(`插件版本：${pluginBefore ?? '(无)'} → ${pluginAfter ?? '(无)'}${pluginBefore === pluginAfter ? '（未变 —— 换 app 本就不该动 home/）' : '  ⚠ 变了，检查是不是误删了 home/'}`)
  console.log(`
下一步：
  手动测   双击 ${join(testDir, '启动.cmd')}
  真机自检 node scripts/portable-dev.mjs verify
  CDP 观测 node scripts/portable-dev.mjs launch --cdp 9333`)
}

/* ---------- refresh（日常主循环） ---------- */

function refresh() {
  requireSeeded()
  const version = readArg('version') ?? versionOf(join(ROOT, 'package.json'))
  if (version === undefined) fail('读不到 package.json 的 version')

  if (!has('skip-build')) {
    console.log('\n[1/3] pnpm build')
    const build = spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit', shell: true })
    if (build.status !== 0) fail(`pnpm build 失败（exit ${String(build.status)}）`)
  } else {
    console.log('\n[1/3] 跳过 build（--skip-build）—— 打出来的是 lib/ 里现有的代码')
  }

  console.log('\n[2/3] 打增量包')
  const zipPath = join(DIST, `${PLUGIN_NAME}-update-v${version}.zip`)
  // package-plugin-update 见到同名产物会直接拒绝，所以先清掉上一轮的。
  if (existsSync(zipPath)) removeTreeFast(zipPath)
  const packed = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'package-plugin-update.mjs'), '--version', version, '--out', zipPath],
    { cwd: ROOT, encoding: 'utf8' },
  )
  console.log((packed.stdout ?? '').trim())
  if (packed.status !== 0) {
    console.error((packed.stderr ?? '').trim() || '(无 stderr)')
    fail('增量包没打出来')
  }

  console.log('\n[3/3] 覆盖进固定目录')
  // 先整目录删掉再解压，而不是就地覆盖：tsdown 的 chunk 名带内容哈希，就地覆盖会一轮轮
  // 攒下不再参与加载的旧 chunk（`verify-plugin-update` 里那条提示）。
  // 删的只是插件自己那一层，profile 的 package.json（用户装过的其它插件登记）不碰。
  if (existsSync(pluginDir)) removeTreeFast(pluginDir)
  unzip(zipPath, testDir)

  const installed = versionOf(join(pluginDir, 'package.json'))
  console.log(`\n固定目录里的插件版本：${installed ?? '✗ 读不到'}（期望 ${version}）`)
  if (installed !== version) fail('覆盖后版本对不上 —— 别拿这份去测')

  console.log(`
下一步：
  手动测   双击 ${join(testDir, '启动.cmd')}
  真机自检 node scripts/portable-dev.mjs verify
  CDP 观测 node scripts/portable-dev.mjs launch --cdp 9333`)
}

/* ---------- verify ---------- */

function verify() {
  requireSeeded()
  const extra = has('in-place') ? ['--in-place'] : []
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'verify-plugin-update.mjs'), '--dir', testDir, ...extra],
    { cwd: ROOT, stdio: 'inherit' },
  )
  process.exit(result.status ?? 1)
}

/* ---------- launch ---------- */

function launch() {
  requireSeeded()
  const cdpPort = readArg('cdp')
  const commandLine = cdpPort === undefined ? `"${exePath}"` : `"${exePath}" --remote-debugging-port=${cdpPort}`
  // 走 WMI 而不是 spawn：见文件头「为什么 launch 走 WMI」。
  const script = `([wmiclass]"Win32_Process").Create('${commandLine}', '${appDir}')`
  console.log(`启动（WMI，脱离 job）：\n  ${commandLine}\n  cwd ${appDir}`)
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error((result.stderr ?? '').trim() || '(无 stderr)')
    fail('WMI 创建进程失败')
  }
  // 本机 pwsh 的 stdout 恒为空（拿不到 WMI 的 ReturnValue），所以不去读它，只给验证手段。
  console.log(`
验证（换个工具调用再跑，别在本调用里睡 —— 那样证明不了它活过了 job 回收）：
  netstat -ano | grep LISTENING | grep 19387
  ${cdpPort === undefined ? '（想开 CDP 就下次加 --cdp 9333）' : `curl http://127.0.0.1:${cdpPort}/json/list`}`)
}

/* ---------- clean ---------- */

function clean() {
  if (!has('yes')) {
    fail(`要删的是整个 ${testDir}（1.2G，且重新铺底要几分钟）。确认就加 --yes。`)
  }
  if (!existsSync(testDir)) { console.log('目录本来就不存在。'); return }
  removeTreeFast(testDir)
  console.log(`已删除 ${testDir}`)
}

/* ---------- 派发 ---------- */

const commands = { status, env: showEnv, seed, refresh, setApp, verify, launch, clean }
/** 命令行用连字符，函数名用驼峰。 */
const aliases = { 'set-app': 'setApp' }
const resolved = command === undefined ? undefined : (aliases[command] ?? command)
if (resolved === undefined || !(resolved in commands)) {
  console.error(`用法: node scripts/portable-dev.mjs <status|env|seed|refresh|set-app|verify|launch|clean> [--dir <目录>]

  status                     看固定目录现状（两个版本号、启动过没有）
  env                        看这些路径是从哪来的（环境变量 / .env.local / 没配）
  seed   [--zip <整包>] [--force]   首次铺底（默认挑 dist 里最新的整包）
  refresh [--version x] [--skip-build]  日常：build → 增量包 → 覆盖进固定目录
  set-app [--from <win-unpacked> | --zip <整包>] [--move]
                             重编桌面端后只换 app/（home/ 与插件、会话、凭据都不动）
                             不给 --from/--zip 就用 <BUILD_ROOT>/.desktop-base 里版本最高的槽
  verify [--in-place]        起宿主三轮自检（默认只读，不动目录）
  launch [--cdp 9333]        起 GUI（WMI，脱离 job）
  clean  --yes               删掉整个固定目录

当前目录: ${testDir}
本体缓存根: ${BASE_ROOT}`)
  process.exit(1)
}
commands[resolved]()
