#!/usr/bin/env node
/**
 * 便携版发布前的**生产路径自检**：拿解压好的便携版目录，真起一次 dsh 桌面端宿主。
 *
 * ## 为什么需要它
 *
 * v0.1.0 与 v0.2.0 两个包发出去之后，插件**从来没有在打包形态下被起过一次**。
 * 三次都因此踩到「只有真启动才会暴露」的问题：
 *
 * - v0.1.0 / v0.2.0：profile 少了 `desktop-runtime-state.json`，登记的插件被
 *   `createPluginProfile()` 静默抹掉 —— 界面正常、插件没有，不报错。
 * - v0.2.0：出货 patch 里带着 keyless 验证用的 `fake-llm`，它接管 `llm/stream`，
 *   任何真实对话都会被换成脚本回放。
 * - 便携版自检首轮：**解压产物损坏**（14071 个文件里 5160 个是 NUL 填充，
 *   连 `使用说明.txt` 和 `dsh-desktop-host/lib/index.js` 都中招）被误读成
 *   「包坏了」。zip 的 CRC 全绿，真正坏的是解压那一步。此后完整性校验成为硬断言。
 *
 * 这三件事**都不会**被 `pnpm typecheck` / `pnpm test` / CI 构建拦住：那一行是合法配置，
 * 插件也是合法加载。只有「真起一次 + 读真图」才能发现。
 *
 * ## 它到底做了什么
 *
 * 不起 GUI。0.1.6-alpha.2 起 `@deepseek-ai/dsh-desktop-host` **不再导出** `runDesktopHost()`
 * （入口是 `import.meta.main` + IPC `{ type: 'ready', url }`）。本脚本按 Electron 壳
 * `host-process.ts` 的同一条 spawn 把 packaged 宿主拉起来，再 HTTP 拉 `/index.html` ——
 * 与真启动同源（同一个 `webServer`、同一个 `clientModules`）。
 *
 * 真启动前还会用 **harness 的真代码**（不是本脚本的复刻）走一遍桌面端的准备阶段：
 * `readDesktopRuntime` → `verifyDesktopRuntime` →（在 profile 副本上跑真 `applyRelease()`）。
 * 这几步在 Electron 里就是启动路径本身，跳过任何一步都可能漏掉真实的启动失败。
 *
 * 断言（任一不过即退出码 1）：
 *   1. 运行时树（0.1.5 是 `app/resources/dsh`，0.1.6 起在 `app/resources/app.asar` 里）
 *      全量 sha256 与 `desktop-runtime.json` 的 `files` 清单一致
 *      （挡住解压损坏 / 打包截断，这是「包到底好不好」的唯一硬证据）；
 *   2. 包里**没有**遗留的 `desktop-runtime-state.json`（alpha.2 起该文件退役，见 [1/5] 的说明）；
 *   3. 在 profile 的工作副本上跑真 `applyRelease(true)`，然后断言插件登记（`dependencies` +
 *      `bundles`）与 `node_modules` 下的插件文件**都还在** —— 这是「插件被静默抹掉」的回归护栏
 *      （0.1.5 / alpha.1 时代它会把 package.json 重写成空依赖，靠我们写状态文件才躲过去）；
 *   4. 出货 patch 里没有 `llm/stream` 劫持行；profile 里没有越权的 overlay；
 *   5. `__DSH_BOOT__` 里存在插件的客户端行，且它的 bundle 能 200 拉下来、内容是合法模块；
 *   6. `--browser` 给了 Chrome 时，再验客户端半边真的在浏览器里注册成功
 *      （`<html>` 上的信标：`dshBrowserPlugin` / `Dock` / `ToolViews`）；
 *   7. 便携 home 兜底成立：exe 与 `home/` 同级（打包脚本决定的布局），且 harness 的
 *      `resolvePortableDshHome` 在那个 exe 上真的命中它 —— 正反两向都验，这条保证
 *      「双击 `app\<exe>`」与「走 启动.cmd」等价。本地 harness 没打
 *      `docs/harness-desktop-build.patch` 时跳过（CI 是先打补丁再跑本脚本，必跑）；
 *   8. `app/resources/app.asar` 的主进程代码里真的含 harness 补丁注入的那几处
 *      （主 exe 路径、便携 home 兜底、窗口宿主早期分支）—— 光验 profile 看不出这些，
 *      而它们缺失时 profile 一样是干净的。
 *
 * 第 6 条**不断言状态条出现在 DOM 里**：状态条挂在会话面的 `conversation.input.dock` 上，
 * 而 `ui-conversation` 只在会话存在时才渲染那个 slot（空 home 会停在「选择工作区」页）。
 * 信标证明的是「bundle 被拉取、`apply` 跑过、slot 注册成功」—— 这正是打包回归会破坏的部分；
 * DOM 可见性依赖会话状态，不适合当发布闸门。
 *
 * ## 用法
 *
 * ```bash
 * # 先解压便携版，然后：
 * pnpm run verify:portable -- --dir D:/tmp/dsh-v021-run
 * # 想在真浏览器里再确认一次客户端注册：
 * pnpm run verify:portable -- --dir D:/tmp/dsh-v021-run \
 *     --browser "C:/Program Files/Google/Chrome/Application/chrome.exe"
 * ```
 *
 * `--dir` 里 `home/` 的设置与凭据会被复制到一次性 home（`--home` 可指定、`--keep-home` 保留），
 * **不会**动包里那份；profile 的建链也在工作副本上做。
 *
 * ⚠️ **`--dir` 必须是「刚解压、还没启动过」的目录**。启动过一次的便携版，它的 profile 里
 * 已经躺着自己建好的 241 条链接，工作副本复制过去后建链会失败并报
 * `refusing to replace unowned package @deepseek-ai/cordis`；紧接着还会连锁出
 * `Cannot find package 'js-yaml'` / `plugin tree failed to load` 之类看起来吓人的错误 ——
 * **都不是包坏了**，是这份目录不再是出厂态。要复验就重新解压一份。
 *
 * `--harness` 指向 deepseek-harness 源码（默认 `$DSH_HARNESS` 或 `D:/dev/cli/deepseek-harness`）。
 * 前 3 条断言依赖它的 `apps/desktop/src/*.ts`，缺了就没法验真启动路径，脚本会直接报错退出。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeRuntimeDir } from './desktop-runtime.mjs'
import { fetchHostPath, startPackagedDesktopHost } from './run-packaged-host.mjs'

/* ---------- 参数 ---------- */

const FLAGS = new Set(['--dir', '--profile', '--browser', '--home', '--port', '--cdp-port', '--harness'])

function parseArgs(argv) {
  const options = { profile: 'desktop', port: 19333, cdpPort: 19222 }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    // `pnpm run verify:portable -- --dir X` 在部分 pnpm 版本里会把 `--` 本身也透传进来，
    // 于是文档里那条命令会直接报「未知参数 --」。这里吞掉它，两种写法都能用。
    if (flag === '--') continue
    if (flag === '--keep-home') { options.keepHome = true; continue }
    if (!FLAGS.has(flag)) throw new Error(`verify-portable: 未知参数 ${JSON.stringify(flag)}`)
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`verify-portable: ${flag} 缺值`)
    i += 1
    if (flag === '--dir') options.dir = value
    else if (flag === '--profile') options.profile = value
    else if (flag === '--browser') options.browser = value
    else if (flag === '--home') options.home = value
    else if (flag === '--harness') options.harness = value
    else if (flag === '--port') options.port = Number(value)
    else options.cdpPort = Number(value)
  }
  if (options.dir === undefined) throw new Error('verify-portable: 需要 --dir <解压后的便携版目录>')
  return options
}

// 用法错误（缺 --dir、指错目录）不是「自检失败」，是「命令敲错了」：
// 以前这里直接 throw，顶层未捕获 → 打一屏栈、退出码还是 1，看日志的人分不清
// 究竟是包没过还是参数没给对。现在统一打一行原因 + 用法，退出码 2。
let options
let packageRoot
let appRoot
try {
  options = parseArgs(process.argv.slice(2))
  packageRoot = resolve(options.dir)
  appRoot = join(packageRoot, 'app')
  if (!existsSync(appRoot)) {
    throw new Error(`${appRoot} 不存在 —— --dir 要指到解压后的便携版根目录（里面有 app/）`)
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)
  // parseArgs 自己的消息已经带过前缀，别打成「verify-portable: verify-portable: …」。
  console.error(`verify-portable: ${reason.replace(/^verify-portable:\s*/u, '')}`)
  console.error('用法：node scripts/verify-portable.mjs --dir <解压后的便携版根目录> '
    + '[--harness <deepseek-harness 源根目录>] [--profile <名>] [--port <端口>] [--cdp-port <端口>] [--keep-home]')
  process.exit(2)
}
const profileDir = join(packageRoot, 'home', 'profiles', options.profile)

// dsh 0.1.6 起运行时被打进 app.asar，磁盘上不是真目录（见 desktop-runtime.mjs 文件头）。
// 纯 Node 脚本读不了 asar，先物化成临时目录再验；0.1.5 的 `resources\dsh` 直接用。
const materialized = materializeRuntimeDir(appRoot)
const resourcesRoot = materialized.resources ?? join(appRoot, 'resources')
const runtimeDir = materialized.runtimeDir
/** 日志/失败信息里说清楚验的是哪棵树，免得看日志的人再去猜版本。 */
const runtimeLabel = materialized.layout === 'asar'
  ? 'app/resources/app.asar 内的 dsh 树（已解到临时目录）'
  : 'app/resources/dsh'
process.on('exit', () => materialized.cleanup())

const harnessDesktopSrc = join(resolve(options.harness ?? process.env.DSH_HARNESS ?? 'D:/dev/cli/deepseek-harness'), 'apps', 'desktop', 'src')
for (const file of ['runtime-tree.ts', 'profile-packages.ts', 'paths.ts']) {
  if (!existsSync(join(harnessDesktopSrc, file))) {
    throw new Error(`verify-portable: 找不到 ${join(harnessDesktopSrc, file)} —— 用 --harness 指向 deepseek-harness 源码根目录`)
  }
}

/**
 * 桌面端用什么方式把宿主包给到插件：**只能问 harness 源码，不能拿布局猜。**
 *
 * 判据是「打包态解析模式是否为 runtime」：
 * - 0.1.5 / 0.1.6-alpha.1：`runtimeResources()` 返回 `profileResolution: 'runtime'`；
 * - 0.1.6-alpha.2 起：字段被删掉了，改在构造 host 那行的**实参位置**内联三元
 *   `development ? 'link' : 'runtime', resources)`（见 `new DesktopHostProcess(...)`）。
 *
 * 为何非查源码不可：runtime 模式走 `recordDesktopRuntimeProfile`（只记状态、不建链），
 * link 模式走 `linkDesktopHostPackages`（建几百条 junction）；两条路产物完全不同。
 * 而它**与布局彼此独立** —— 0.1.6 上游把两件事绑在一起改，我们打补丁把 dsh 挪回了
 * extraResources，于是出现「布局 flat、解析 runtime」的组合，按布局推断必然跑错分支。
 *
 * 判据锚在**实参位置**（`'link' : 'runtime', resources)`），不全文扫 `'runtime'`：
 * `runtimeResources()` 里到处是 `resourcesPath, 'runtime', ...` 这类路径片段，全文扫必误判。
 * 两种形态都不认得就直接报错 —— 宁可自检挂掉，也不要静默走错分支出一个假绿。
 *
 * **为什么没有「link」那一种形态**（2026-09-18 review 后删掉了原先预留的那支）：查过上游
 * `main.ts` 的历史，`profileResolution` 这个字段**只出现过 `'runtime'` 一个字面量** ——
 * 上游的写法始终是 `...(development ? {} : { profileResolution: 'runtime' })`，开发态
 * 干脆不带这个字段，任何版本都不会产出字面量 `'link'`。所以那一支是凭空的猜测：它一旦命中，
 * 只可能是「有人把字段硬写成 link」这种异常，而猜成 link 会让本脚本去跑 link 那套期望 ——
 * 正是本函数注释里说的「静默走错分支」。认不出就抛错。
 * @param source - `apps/desktop/src/main.ts` 的源码。
 * @returns 打包态的解析模式，目前只可能是 `'runtime'`（见上）；认不出判据则抛错。
 */
function detectResolutionMode(source) {
  if (/'link'\s*:\s*'runtime'\s*,\s*resources\s*\)/u.test(source)) return 'runtime'
  if (/profileResolution:\s*'runtime'/u.test(source)) return 'runtime'
  throw new Error(
    'verify-portable: 在 main.ts 里找不到 resolutionMode 判据（既没有实参位置的三元，'
    + "也没有 profileResolution 字段）—— 上游大概又改了桌面壳，先看本函数的注释再动判据",
  )
}

const resolutionMode = detectResolutionMode(readFileSync(join(harnessDesktopSrc, 'main.ts'), 'utf8'))

const failures = []
const notes = []

function check(ok, message) {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures.push(message)
  return ok
}

/* ---------- 0. 加载桌面端真代码 ---------- */

const { tsImport } = await import('tsx/esm/api')
const runtimeTree = await tsImport(pathToFileURL(join(harnessDesktopSrc, 'runtime-tree.ts')).href, import.meta.url)
// 这里原先还 import 了 `profile-packages.ts`（用它的 recordDesktopRuntimeProfile /
// readDesktopProfileState / linkDesktopHostPackages / validateDesktopPluginGraph 复刻
// 「prepareProfile」）。2026-09-18 适配 alpha.2 时全部删掉：那四个函数**在上游不存在了**
// （profile-packages.ts 现在只剩一个一次性迁移函数），而「profile 是怎么被准备的」现在
// 跑 `project-manager.ts` 的 `applyRelease()` 就是——见 [2/5]，直接跑真代码，不再复刻。
const desktopPaths = await tsImport(pathToFileURL(join(harnessDesktopSrc, 'paths.ts')).href, import.meta.url)

/* ---------- 1. 产物完整性 + runtime 身份 ---------- */

console.log(`\n[1/5] 产物完整性 + runtime 身份（桌面端真代码，harness=${harnessDesktopSrc})`)

const runtime = runtimeTree.readDesktopRuntime(runtimeDir)
console.log(`      runtime ${runtime.release.version} / node ${runtime.release.nodeVersion} / ${runtime.platform}/${runtime.arch}` +
  ` / ${String(runtime.sharedPackages.length)} 个共享包 / ${String(runtime.files.length)} 个受校验文件`)

// 把「解压是否完整」从臆测变成证据：逐文件 sha256 对齐打包时记录的清单。
try {
  await runtimeTree.verifyDesktopRuntime(runtimeDir, runtime.release.version)
  check(true, `${runtimeLabel} 完整性：${String(runtime.files.length)} 个文件 sha256 全部匹配`)
} catch (error) {
  check(false, `${runtimeLabel} 完整性校验失败（解压损坏？）：${error.message}`)
  // 官方只丢一句 `integrity verification failed`，不说是哪个文件 —— 定位全靠猜。
  // 这里自己再比一遍，把「缺了谁 / 多了谁 / 谁的字节变了」直接打出来。
  try {
    const expected = new Map(runtime.files.map(file => [file.path, file]))
    const actual = new Map(runtimeTree.inventoryDesktopRuntime(runtimeDir).map(file => [file.path, file]))
    const missing = [...expected.keys()].filter(path => !actual.has(path))
    const extra = [...actual.keys()].filter(path => !expected.has(path))
    const changed = [...expected.values()].filter(file => {
      const found = actual.get(file.path)
      return found !== undefined && (found.sha256 !== file.sha256 || found.bytes !== file.bytes)
    })
    const show = (label, list, format) => console.log(`      ${label} ${String(list.length)} 个${list.length > 0 ? `：${list.slice(0, 10).map(format).join('、')}${list.length > 10 ? ' …' : ''}` : ''}`)
    show('清单有、盘上没有：', missing, path => path)
    show('盘上有、清单没有：', extra, path => path)
    show('字节/sha256 不符：', changed, file => `${file.path}(${String(file.bytes)}B→${String(actual.get(file.path).bytes)}B)`)
  } catch (detailError) {
    console.log(`      （差异明细没算出来：${detailError.message}）`)
  }
}

// `desktop-runtime-state.json` 是**遗留文件**，2026-09-18 起反过来断言它不该在包里。
//
// 0.1.6-alpha.2 把整套「link 模式 + 状态文件」退役了：`apps/desktop/src/profile-packages.ts`
// 现在只剩一个一次性迁移函数 `migrateDesktopProfileLinks()`（在 `applyRelease()` 里调用），
// 它的作用就是**把这个文件删掉**；而插件登记之所以还能保住，是因为 `createPluginProfile()`
// 落到的 `initProfile()` 是「不存在才写」（`packages/boot/app-boot/src/profile.ts:203`）——
// 也就是说，那个最隐蔽的坑「状态文件缺失 → package.json 被重写成空依赖 → 插件静默消失」
// **上游自己修掉了**。我们此前写这个文件的理由（见 `package-desktop-portable.mjs` 的历史注释）
// 随之作废；继续写它不但没用（启动即被删），还会让人以为绕法仍然必需。
const legacyStatePath = join(profileDir, 'desktop-runtime-state.json')
check(!existsSync(legacyStatePath),
  '包里没有遗留的 desktop-runtime-state.json（alpha.2 起该文件退役；插件登记由 initProfile 的「不存在才写」保住）')
check(!existsSync(join(profileDir, 'desktop-packages-pending')), '没有遗留 desktop-packages-pending（否则启动即报「准备未完成」）')

// fail fast：完整性 / runtime 身份不过，说明**这棵树本身就是坏的**。
// 后面四步读的是同一棵树，继续跑只会把同一个结论重复四遍，还把真正的失败项淹在后面。
if (failures.length > 0) {
  console.error(`\n[1/5] 已失败 ${String(failures.length)} 项 —— 产物本身不对，后面四步验的是同一棵树，就此打住：`)
  for (const message of failures) console.error(`  ✗ ${message}`)
  process.exit(1)
}

/* ---------- 2. 复刻桌面端启动时的 profile 准备（applyRelease） ---------- */

console.log('\n[2/5] 复刻桌面端 applyRelease（用真代码跑一遍首次启动那条路）')

const BUILTIN_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const scratchBase = mkdtempSync(join(tmpdir(), 'dsh-verify-profile-'))
const workProfileDir = join(scratchBase, options.profile)

// 打包态把 profileResolution 传成 runtime 这件事仍然重要（app-boot 的 `runProfile` 按它决定
// 从哪里解析宿主包），但它**不再从 profile 的内容上看得出来** —— link 模式那套记账
// （`linkDesktopHostPackages`）已被上游整个删除，profile 在两种模式下长得一样。
// 所以它只能按源码判据断言，这也成了 `detectResolutionMode` 如今唯一的用途。
check(resolutionMode === 'runtime',
  'main.ts 的打包态把 profileResolution 传成 runtime（源码判据，见 detectResolutionMode）')

if (existsSync(profileDir)) {
  // 在副本上做：applyRelease 会加锁、会清理 core 包、还会让 initProfile 补写缺的文件，
  // 不该污染 `--dir` 里那份。副本从「出厂态」开始，正好验证首次启动那条路径。
  cpSync(profileDir, workProfileDir, { recursive: true })

  const manifest = JSON.parse(readFileSync(join(workProfileDir, 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  check(BUILTIN_BUNDLES.every((bundle, index) => bundles[index] === bundle),
    'profile 的 bundles 以两个内置 bundle 正确开头（profilePluginNames 的前置校验）')
  check(new Set(bundles).size === bundles.length, 'profile bundles 无重复')
  const activePlugins = bundles.slice(BUILTIN_BUNDLES.length)
  check(activePlugins.includes('dsh-webops-plugin'), `本插件在 activePlugins 里：${JSON.stringify(activePlugins)}`)

  const nmDir = join(profileDir, 'node_modules')
  const shipped = existsSync(nmDir) ? readdirSync(nmDir) : []
  notes.push(`出厂态 profile/node_modules 只有 ${String(shipped.length)} 个条目（${shipped.join(', ')}）——`
    + `${String(runtime.sharedPackages.length)} 个宿主包由运行时目录直接供给（不建链），这是设计如此`)

  // 真代码跑一遍启动时真正动 profile 的那一步。**这一步才是「插件会不会静默消失」的真凭据**：
  // 0.1.5 / 0.1.6-alpha.1 时代它会把 package.json 整个重写成空依赖，靠我们随包写的
  // `desktop-runtime-state.json` 才躲过去；alpha.2 起落到「不存在才写」的 `initProfile()`，
  // 出厂 profile 原样保留。这条断言就是那次行为变更的回归护栏 —— 它比「复刻一遍内部记账」
  // 更贴近真机，因为跑的就是启动路径上那个函数。
  try {
    const projectManager = await tsImport(pathToFileURL(join(harnessDesktopSrc, 'project-manager.ts')).href, import.meta.url)
    const manager = new projectManager.DesktopProjectManager(
      { profile: workProfileDir, lock: join(workProfileDir, 'lock') },
      { dsh: runtimeDir },
    )
    await manager.applyRelease(true)
    check(true, 'applyRelease(true) 在出货 profile 上跑通（跑的是桌面端真代码，不是复刻）')

    const after = JSON.parse(readFileSync(join(workProfileDir, 'package.json'), 'utf8'))
    check(after.dependencies?.['dsh-webops-plugin'] !== undefined,
      'applyRelease 之后插件仍在 dependencies 里（这就是「静默抹掉」的回归护栏）')
    check((after.dsh?.profile?.bundles ?? []).includes('dsh-webops-plugin'), 'applyRelease 之后插件仍在 bundles 里')

    const pluginDirInCopy = join(workProfileDir, 'node_modules', 'dsh-webops-plugin')
    const entry = lstatSync(pluginDirInCopy)
    // 必须是**真目录**：老版桌面端见 symlink 直接拒（`validateDesktopPluginGraph`，该函数已被
    // 上游删除，但这条要求在用户机器上更硬 —— 那边没有本机 checkout 可以指过去）。
    check(entry.isDirectory() && !entry.isSymbolicLink(),
      '插件是真实目录（不是 symlink：用户机器上没有本机 checkout 可指）')
    check(existsSync(join(pluginDirInCopy, 'cordis.patch.yml')), '插件的 cordis.patch.yml 还在（ptc-runtime 覆盖靠它）')
    check(existsSync(join(pluginDirInCopy, 'lib', 'index.js')), '插件的 lib/index.js 还在（package.json 的入口）')
    check(!existsSync(join(workProfileDir, 'desktop-runtime-state.json')), 'applyRelease 之后也没冒出遗留状态文件')
  } catch (error) {
    check(false, `applyRelease 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ---------- 3. 插件目录的静态检查 ---------- */

console.log(`\n[3/5] 便携版内容（profile=${options.profile}）`)

const shippedPluginDir = join(profileDir, 'node_modules', 'dsh-webops-plugin')
check(existsSync(shippedPluginDir), '插件已物化到 profile 的 node_modules')

if (existsSync(shippedPluginDir)) {
  const shippedPatch = readFileSync(join(shippedPluginDir, 'cordis.patch.yml'), 'utf8')
  const body = shippedPatch.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  for (const hijacker of ['fake-llm', 'llm-replay', 'mock-llm']) {
    check(!body.includes(hijacker), `出货 patch 不含 ${hijacker}（它会接管 llm/stream，把真实对话换成假回放）`)
  }
  check(body.includes('dsh-webops-plugin/browser-cdp'), '出货 patch 含 browser-cdp 行')
  check(body.includes('dsh-webops-plugin/browser-electron'), '出货 patch 含 browser-electron 行')
  check(body.includes('dsh-webops-plugin/tool-browser'), '出货 patch 含 tool-browser 行')
  check(/name:\s*['"]?dsh-webops-plugin['"]?\s*$/mu.test(body), '出货 patch 含裸包名行（客户端半边靠它被发现）')
  // 「行存在」不够 —— 2026-09-15 事故就是「行在、config 没了」：provider 于是从不参与
  // 选择，webpage_open 落到桌面端的死路上，症状是「没法打开新的窗口」，且不报任何错。
  const electronAt = body.indexOf('browser-electron')
  const nextRowAt = electronAt === -1 ? -1 : body.indexOf('- id:', electronAt + 1)
  const electronRow = electronAt === -1 ? '' : body.slice(electronAt, nextRowAt === -1 ? undefined : nextRowAt)
  check(/enabled:\s*true/u.test(electronRow),
    'browser-electron 带 enabled: true（否则 available() 恒为 false）')
  check(/appMode:\s*true/u.test(electronRow),
    'browser-electron 带 appMode: true（便携版里没有独立的 electron.exe 可 spawn）')
  check(existsSync(join(shippedPluginDir, 'lib', 'client.js')), '客户端产物 lib/client.js 在包里')
  check(existsSync(join(shippedPluginDir, 'lib', 'tool-browser', 'index.js')), '工具产物 lib/tool-browser/index.js 在包里')
  check(existsSync(join(shippedPluginDir, 'lib', 'browser-electron', 'host.cjs')), '窗口宿主脚本 lib/browser-electron/host.cjs 在包里')
  // 窗口名是给人看的（任务栏 / Alt-Tab 里认人），所以出货包里的标题必须仍是那个中文名。
  // 它只写在 host.cjs 一处，改错了没有任何别的地方会报错 —— 只有真机肉眼看才发现的类型。
  const hostSource = readFileSync(join(shippedPluginDir, 'lib', 'browser-electron', 'host.cjs'), 'utf8')
  check(hostSource.includes('dsh网页窗口'), '宿主窗口标题是「dsh网页窗口」')
  check(!hostSource.includes("'dsh browser'"), '宿主窗口标题没有退回旧的 dsh browser')
  // 最小化 / 隐藏时 `getContentBounds()` 返回 0×0，采信它就会把视图钉成 0 宽，
  // 而尺寸归零的 webContents 不再出帧 —— 真机症状是「内容整片变白、CDP 却正常」。
  // 这两条是那个 bug 的完整防线：不采信退化读数 + 重新可见时补 layout。
  check(/isMinimized\(\)\s*\|\|\s*!shell\.isVisible\(\)/u.test(hostSource),
    'layout() 不采信退化读数（最小化 / 隐藏 / 0 尺寸时不跑）')
  check(hostSource.includes("shell.on('restore', layout)") && hostSource.includes("shell.on('show', layout)"),
    '重新可见时会补跑 layout（restore / show）')
}

check(!existsSync(join(profileDir, 'cordis.patch.yml')),
  'profile 里没有越权 overlay（出货包不该带 profile 级 patch）')

/* ---------- 3.6 app.asar 里必须真含 harness 补丁注入的代码 ---------- */

// 上面几条只看 profile —— 而「harness 补丁到底有没有进包」只有 app.asar 知道。这跟
// 2026-09-15「browser-electron 行在、config 没了」是同一类失败：profile 一切正常，
// Electron 主进程里却少一段代码，症状只会在真机上出现（窗口开不出来 / 双击 exe 找不到配置）。
// 打包用的 main.js 会经 tsdown 重写（单引号规范成双引号），所以断言用**引号无关的正则**，
// 不用字面量 —— 这几条正则是在已发布的 v0.2.2 包上逐条试出来的。
const asarPath = join(resourcesRoot, 'app.asar')
if (check(existsSync(asarPath), 'app/resources/app.asar 在包里')) {
  const asarText = readFileSync(asarPath).toString('latin1')   // 标记全是 ASCII，按字节对齐
  for (const [pattern, what] of [
    [/process\.env\.DSH_APP_EXECUTABLE = process\.execPath/u, '主 exe 路径注入（app 模式的窗口宿主靠它）'],
    [/resolvePortableDshHome\(process\.execPath\)/u, '便携 home 兜底（双击 exe 免启动脚本）'],
    [/\(process\.env\.DSH_HOME \?\? ['"]{2}\)\.trim\(\) === ['"]{2}/u, '便携兜底只在 $DSH_HOME 为空时生效'],
    [/process\.env\.DSH_BROWSER_ELECTRON_HOST/u, '窗口宿主的早期分支'],
    // 2026-09-17 补：桌面端里 `cdp` 与 `electron` 会同时「可用」（前者 available() 乐观为真），
    // 没人指定 provider 就抛 BROWSER_PROVIDER_AMBIGUOUS —— `webpage_open` 直接失败，而
    // profile 每次重建、写不进 `config.provider`，只能由 shell 落这个默认值。
    // 两条一起断言：既要「判空后兜底」的写法在，也要兜底值真的是 electron。
    [/process\.env\.DSH_BROWSER_PROVIDER \?\? ['"]{2}/u, '浏览器 provider 的判空兜底'],
    [/process\.env\.DSH_BROWSER_PROVIDER = ['"]electron['"]/u, '浏览器 provider 默认落成 electron（避免 cdp/electron 撞 ambiguous）'],
  ]) {
    check(pattern.test(asarText), `app.asar 主进程含 ${what}`)
  }
  check(!/process\.env\.DSH_DESKTOP_APP_EXECUTABLE/u.test(asarText),
    'app.asar 里没有 DSH_DESKTOP_ 前缀的变量名（host 子进程会把该前缀全过滤掉）')
}

/* ---------- 3.5 便携 home 兜底：双击 exe 与走 启动.cmd 等价 ---------- */

// 兜底要成立，两个前提一个都不能少：
//   1) 布局确实是 `<root>\app\<exe>` + `<root>\home` —— 打包脚本决定的，这里拿真目录验；
//   2) harness 的 `resolvePortableDshHome` 在那个 exe 上真的认出这个 home —— 用**真代码**跑。
// 只验 1 是文本假设，只验 2 是「函数自己跟自己一致」；两个一起才是「双击能用」。
const launcherExe = readdirSync(join(packageRoot, 'app'))
  .find(name => name.endsWith('.exe') && !/uninstall|elevate/iu.test(name))
check(launcherExe !== undefined, 'app/ 里有主 exe（便携 home 兜底与窗口宿主都指向它）')

if (launcherExe !== undefined) {
  const exePath = join(packageRoot, 'app', launcherExe)
  const expectedHome = resolve(join(packageRoot, 'home'))
  if (typeof desktopPaths.resolvePortableDshHome !== 'function') {
    // 本地 harness 通常是「出厂态」（补丁现场生成完就还原），这条只能在 CI 里真跑。
    notes.push('harness 源码未应用 docs/harness-desktop-build.patch → 便携 home 的行为验证跳过' +
      '（CI 先打补丁再跑本脚本，那里会真验；本页其余断言不受影响）')
  } else {
    check(desktopPaths.resolvePortableDshHome(exePath) === expectedHome,
      `resolvePortableDshHome(app/${launcherExe}) 命中 home/ —— 双击 exe 自带配置与插件`)
    // 反向：不能把任意 exe 都判成便携版，否则配置会写到意想不到的地方。
    const notPortable = mkdtempSync(join(tmpdir(), 'dsh-not-portable-'))
    const verdict = desktopPaths.resolvePortableDshHome(join(notPortable, 'app', 'x.exe'))
    check(verdict === undefined,
      'resolvePortableDshHome 对「没有兄弟 home/ 的 exe」返回 undefined（反向验证，防止误判）')
    rmSync(notPortable, { recursive: true, force: true })
  }
}

/* ---------- 4. 真起宿主，读 boot graph ---------- */

console.log('\n[4/5] 生产路径启动宿主并读取 __DSH_BOOT__')

const scratchHome = options.home === undefined
  ? mkdtempSync(join(tmpdir(), 'dsh-verify-home-'))
  : resolve(options.home)
mkdirSync(scratchHome, { recursive: true })
const packagedHome = join(packageRoot, 'home')
if (options.home === undefined && existsSync(packagedHome)) {
  for (const entry of ['settings.yaml', '.credentials.yaml', '.anonymous-user-id']) {
    const from = join(packagedHome, entry)
    if (existsSync(from)) cpSync(from, join(scratchHome, entry))
  }
}

// 必须把 DSH_HOME 指到一次性 home：`loadLayeredEnv` 在 boot 时读它，不设就会落到
// 开发机自己的 `~/.dsh`（那份可能有正在运行的实例持有 .credentials.yaml.lock，
// 表现为 boot 挂在 writer lock 上而不是报错）。
process.env.DSH_HOME = scratchHome
// 上一次跑到一半被杀留下的锁会让下一次 boot 直接超时，先清掉。
rmSync(join(scratchHome, '.credentials.yaml.lock'), { force: true })

const host = startPackagedDesktopHost({
  runtimeDir,
  profileDir: workProfileDir,
  env: process.env,
})
let ready
try {
  ready = await host.ready
  check(true, `宿主启动成功（${ready.url}）`)
} catch (error) {
  check(false, `宿主启动：${error instanceof Error ? error.message : String(error)}`)
}

const ORIGIN = ready === undefined ? `http://127.0.0.1:${String(options.port)}` : new URL(ready.url).origin

/** 走宿主 HTTP 通道取一个路径（带 ready URL 上的认证 query）。 */
async function hostFetch(pathname) {
  if (ready === undefined) throw new Error('宿主没起来，没法 fetch')
  return fetchHostPath(ready.url, pathname)
}

const index = await hostFetch('/index.html')
check(index.status === 200, `/index.html 返回 200（实际 ${String(index.status)}）`)

const html = index.body.toString('utf8')
const marker = html.indexOf('__DSH_BOOT__')

let pluginEntry
if (check(marker >= 0, '__DSH_BOOT__ 已注入首页（clientModules 构造成功）')) {
  const braceAt = html.indexOf('{', marker)
  let depth = 0
  let end = -1
  for (let i = braceAt; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1
    else if (html[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  const graph = JSON.parse(html.slice(braceAt, end))
  check(graph.entries.length > 40, `boot graph 有 ${String(graph.entries.length)} 行`)
  pluginEntry = graph.entries.find((entry) => entry.id === 'dsh-webops-plugin')
  check(pluginEntry !== undefined, 'boot graph 里存在 dsh-webops-plugin（客户端半边被发现）')
}

if (pluginEntry !== undefined) {
  const bundle = await hostFetch(pluginEntry.url)
  const text = bundle.body.toString('utf8')
  check(bundle.status === 200, `插件客户端 bundle 可拉取（${String(bundle.body.byteLength)} 字节）`)
  check(text.includes('__ModuleLoader__.load'), 'bundle 是合法客户端模块（执行时注册自身工厂）')
  check(text.includes('conversation.input.dock'), 'bundle 含 input dock 注册目标')
  check(text.includes('tool.call.toolview'), 'bundle 含工具卡片注册目标')
}

/* ---------- 5. 可选：真浏览器里确认客户端注册 ---------- */

if (options.browser === undefined) {
  console.log('\n[5/5] 跳过浏览器验证（没给 --browser，客户端注册那一步未验）')
  // 这里的 [5/5] 只覆盖「客户端半边在真浏览器里注册」，与「窗口开不开得出来」是两件事。
  // 后者 2026-09-17 起由 verify-browser-host.mjs 覆盖（它自己起窗口宿主，不需要浏览器），
  // 两次真机事故（打不开窗口 / provider ambiguous）都落在那一段。别再以为这里跳过了就没人管。
  console.log('      注：「窗口真开得出来 + provider 选对了」由 scripts/verify-browser-host.mjs 覆盖。')
} else {
  console.log('\n[5/5] 真浏览器里确认客户端半边注册')

  const hopByHop = new Set(['content-encoding', 'transfer-encoding', 'content-length', 'connection'])
  const proxy = createServer((req, res) => {
    const streamId = nextStreamId++
    sinks.set(streamId, {
      start: (meta) => {
        res.statusCode = meta.status
        for (const [name, value] of meta.headers) {
          if (!hopByHop.has(name.toLowerCase())) res.setHeader(name, value)
        }
      },
      data: (payload) => { res.write(payload) },
      end: () => { res.end() },
      error: (message) => { res.end(message) },
    })
    const headers = Object.entries(req.headers)
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value ?? '')])
    host.fetch({ streamId, request: { url: `${ORIGIN}${req.url ?? '/'}`, method: req.method ?? 'GET', headers } }, null)
      .catch((error) => { res.end(String(error)) })
  })
  await new Promise((resolvePromise) => proxy.listen(options.port, '127.0.0.1', resolvePromise))

  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-verify-chrome-'))
  const chrome = spawn(options.browser, [
    '--headless=new',
    `--remote-debugging-port=${String(options.cdpPort)}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' })

  async function cdpJson(path) {
    for (let i = 0; i < 80; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(options.cdpPort)}${path}`)
        if (response.ok) return await response.json()
      } catch { /* 还没起来 */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
    throw new Error(`verify-portable: CDP 未就绪（--cdp-port ${String(options.cdpPort)} 被占？）`)
  }

  try {
    const version = await cdpJson('/json/version')
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolvePromise, reject) => {
      socket.addEventListener('open', resolvePromise, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    let messageId = 0
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    })
    const send = (method, params = {}, sessionId) => new Promise((resolvePromise) => {
      const id = (messageId += 1)
      pending.set(id, resolvePromise)
      socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
    })

    const target = await send('Target.createTarget', { url: 'about:blank' })
    const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })
    const session = attached.result.sessionId
    await send('Runtime.enable', {}, session)
    await send('Page.navigate', { url: `${ORIGIN}/` }, session)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15000))

    const probe = await send('Runtime.evaluate', {
      expression: '({...document.documentElement.dataset})',
      returnByValue: true,
    }, session)
    const dataset = probe.result?.result?.value ?? {}
    check(dataset.dshBrowserPlugin === '1', '客户端 bundle 执行过（dataset.dshBrowserPlugin=1）')
    check(Number(dataset.dshBrowserPluginDock ?? 0) >= 1, 'input dock 注册成功（dataset.dshBrowserPluginDock≥1）')
    check(Number(dataset.dshBrowserPluginToolViews ?? 0) >= 15, '工具卡片全部注册（dataset.dshBrowserPluginToolViews≥15）')
    notes.push('空 home 会停在「选择工作区」页，所以状态条不会出现在 DOM 里 —— 信标已证明它注册成功')
  } finally {
    chrome.kill()
    proxy.close()
    // Chrome 退出时还攥着 crashpad 的 .pma 句柄，删目录必然 EBUSY；临时目录，删不掉就算了。
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch { /* Chrome 还没退干净，留给系统清 */ }
  }
}

/* ---------- 收尾 ---------- */

await host.stop()
// workProfileDir 是 profile 的工作副本（含脚本建出的 241 条 junction），连同它的父目录一起清掉。
try {
  rmSync(scratchBase, { recursive: true, force: true })
} catch { /* 临时目录，删不掉不影响结论 */ }
if (!options.keepHome) {
  try {
    rmSync(scratchHome, { recursive: true, force: true })
  } catch { /* 临时目录，删不掉不影响结论 */ }
}

console.log('')
for (const note of notes) console.log(`注：${note}`)
if (notes.length > 0) console.log('')

if (failures.length > 0) {
  console.error(`verify-portable: ${String(failures.length)} 项不通过：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('verify-portable: 全部通过。')
