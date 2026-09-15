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
 * 不起 GUI、不需要 Electron。桌面端宿主的入口 `@deepseek-ai/dsh-desktop-host` 导出了
 * `runDesktopHost()`，可以直接调用 —— Electron 壳做了三件事：给宿主 fd3/fd4 管道、
 * 把 `dsh-app://app/*` 的请求转过去、把渲染进程开起来。本脚本只复刻前两件，
 * 拿到的 `/index.html` 与真启动**同源**（同一个 `assetHandler`、同一个 `clientModules`）。
 *
 * 真启动前还会用 **harness 的真代码**（不是本脚本的复刻）走一遍桌面端的准备阶段：
 * `readDesktopRuntime` → `desktopRuntimeId` → `verifyDesktopRuntime` →
 * `linkDesktopHostPackages` → `validateDesktopPluginGraph`。这几步在 Electron 里
 * 由 `applyRelease()` 串起来，跳过任何一步都可能漏掉真实的启动失败。
 *
 * 断言（任一不过即退出码 1）：
 *   1. 运行时树（0.1.5 是 `app/resources/dsh`，0.1.6 起在 `app/resources/app.asar` 里）
 *      全量 sha256 与 `desktop-runtime.json` 的 `files` 清单一致
 *      （挡住解压损坏 / 打包截断，这是「包到底好不好」的唯一硬证据）；
 *   2. `desktop-runtime-state.json` 的 `runtimeId` 与本包 runtime 一致
 *      （不一致会被 `assertProfileRuntime` 在起宿主之前拦下），且
 *      `nodeVersion` / `platform` / `arch` 一致（不一致会触发
 *      `pnpm install --frozen-lockfile` 重建 node_modules，而插件不在 registry → 必然失败）；
 *   3. 在 profile 的工作副本上复刻 `prepareProfile`：能建出全部宿主链接、且
 *      `validateDesktopPluginGraph` 通过（插件依赖本地化 + 共享宿主实例 + peer 版本满足）；
 *   4. 出货 patch 里没有 `llm/stream` 劫持行；profile 里没有越权的 overlay；
 *      `desktop-runtime-state.json` 在位（少了它插件会被静默抹掉）；
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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeRuntimeDir } from './desktop-runtime.mjs'

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

const options = parseArgs(process.argv.slice(2))
const packageRoot = resolve(options.dir)
const profileDir = join(packageRoot, 'home', 'profiles', options.profile)

const appRoot = join(packageRoot, 'app')
if (!existsSync(appRoot)) throw new Error(`verify-portable: ${appRoot} 不存在 —— --dir 要指到解压后的便携版根目录（里面有 app/）`)

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
 * `main.ts` 在打包态返回 `profileResolution: 'runtime'`，于是 `prepareProfile` 走
 * `recordDesktopRuntimeProfile`（只记状态、不建链）；0.1.5 及更早没有这个字段，走
 * `linkDesktopHostPackages`（建几百条 junction）。
 *
 * 这两件事与「dsh 放在 `resources\dsh` 还是 app.asar 里」**彼此独立**：0.1.6 上游
 * 把它们绑在一起改，但我们打补丁把 dsh 挪回了 extraResources，于是出现了
 * 「布局是 flat、解析却是 runtime」的组合。按布局推断就会跑错分支。
 */
const resolutionMode = /profileResolution:\s*'runtime'/u.test(readFileSync(join(harnessDesktopSrc, 'main.ts'), 'utf8'))
  ? 'runtime' : 'link'

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
const profilePackages = await tsImport(pathToFileURL(join(harnessDesktopSrc, 'profile-packages.ts')).href, import.meta.url)
const desktopPaths = await tsImport(pathToFileURL(join(harnessDesktopSrc, 'paths.ts')).href, import.meta.url)

/* ---------- 1. 产物完整性 + runtime 身份 ---------- */

console.log(`\n[1/5] 产物完整性 + runtime 身份（桌面端真代码，harness=${harnessDesktopSrc})`)

const runtime = runtimeTree.readDesktopRuntime(runtimeDir)
const runtimeId = runtimeTree.desktopRuntimeId(runtime)
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

const statePath = join(profileDir, 'desktop-runtime-state.json')
if (check(existsSync(statePath), 'desktop-runtime-state.json 在位（缺了它插件登记会被静默抹掉）')) {
  const state = profilePackages.readDesktopProfileState(profileDir)
  check(state.runtimeId === runtimeId, 'state.runtimeId 与本包 runtime 一致（assertProfileRuntime 会放行）')
  // reconcileProfile 的 rebuild 触发器：任一不一致就删 node_modules 跑
  // `pnpm install --frozen-lockfile --ignore-scripts`，而插件不在 registry 里 → 用户机器上必然失败。
  check(state.nodeVersion === runtime.release.nodeVersion,
    `state.nodeVersion=${state.nodeVersion} 与 runtime 一致（否则触发 pnpm install 重建）`)
  check(state.platform === runtime.platform, `state.platform=${state.platform} 与 runtime 一致`)
  check(state.arch === runtime.arch, `state.arch=${state.arch} 与 runtime 一致`)
  check(!existsSync(join(profileDir, 'desktop-packages-pending')), '没有遗留 desktop-packages-pending（否则启动即报「准备未完成」）')
}

/* ---------- 2. 复刻桌面端 prepareProfile ---------- */

console.log('\n[2/5] 复刻桌面端 prepareProfile（建链 + 依赖图校验）')

const BUILTIN_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const scratchBase = mkdtempSync(join(tmpdir(), 'dsh-verify-profile-'))
const workProfileDir = join(scratchBase, options.profile)

let activePlugins = []
if (existsSync(profileDir)) {
  // 在副本上做：link 模式下 `linkDesktopHostPackages` 会往 node_modules 写几百条 junction 并重写 state，
  // 不该污染 `--dir` 里那份。副本也从「出厂态」开始，正好验证首次启动那条路径。
  cpSync(profileDir, workProfileDir, { recursive: true })

  const manifest = JSON.parse(readFileSync(join(workProfileDir, 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  check(BUILTIN_BUNDLES.every((bundle, index) => bundles[index] === bundle),
    'profile 的 bundles 以两个内置 bundle 正确开头（profilePluginNames 的前置校验）')
  check(new Set(bundles).size === bundles.length, 'profile bundles 无重复')
  activePlugins = bundles.slice(BUILTIN_BUNDLES.length)
  check(activePlugins.includes('dsh-webops-plugin'), `本插件在 activePlugins 里：${JSON.stringify(activePlugins)}`)

  const nmDir = join(profileDir, 'node_modules')
  const shipped = existsSync(nmDir) ? readdirSync(nmDir) : []
  notes.push(`出厂态 profile/node_modules 只有 ${String(shipped.length)} 个条目（${shipped.join(', ')}）——` +
    resolutionMode === 'runtime'
      ? `${String(runtime.sharedPackages.length)} 个宿主包由运行时目录直接供给（runtime 模式不建链），这是设计如此`
      : `${String(runtime.sharedPackages.length)} 条宿主链接由桌面端首次启动时建立，不在 zip 里，这是设计如此`)

  try {
    if (resolutionMode === 'runtime') {
      // dsh 0.1.6 起打包态不再建 junction：宿主包由 `app.asar\dsh` 直接供给
      // （宿主进程改成本 exe + ELECTRON_RUN_AS_NODE，能读 asar）。`prepareProfile`
      // 因此只记状态，而 `applyRelease` 的快速返回分支也**不检查 links**。
      // 这里照抄它，顺带断言「不建链」这件事本身 —— 若哪天上游改回 link 模式，
      // 这一条会先转红，提示下面的分支该换回来了。
      profilePackages.recordDesktopRuntimeProfile(workProfileDir, runtime)
      const recorded = profilePackages.readDesktopProfileState(workProfileDir)
      check(recorded.runtimeId === runtimeId,
        'runtime 模式只记状态（recordDesktopRuntimeProfile 写回 runtimeId）')
      check(recorded.links.length === 0,
        `runtime 模式不建宿主链接（links=${String(recorded.links.length)}），宿主包由 runtime 目录直接解析`)
      profilePackages.validateDesktopPluginGraph(workProfileDir, runtimeDir, runtime, activePlugins, 'runtime')
      check(true, `依赖图校验通过（runtime 模式：${String(runtime.sharedPackages.length)} 个宿主包由 runtime 目录供给 + peer 版本满足）`)
    } else {
      profilePackages.linkDesktopHostPackages(workProfileDir, runtimeDir, runtime)
      const linked = profilePackages.readDesktopProfileState(workProfileDir)
      check(linked.links.length === runtime.sharedPackages.length,
        `建链 ${String(linked.links.length)}/${String(runtime.sharedPackages.length)} 条宿主包链接`)
      profilePackages.validateDesktopPluginGraph(workProfileDir, runtimeDir, runtime, activePlugins)
      check(true, '依赖图校验通过（插件依赖本地化 + 共享宿主实例 + peer 版本满足）')
    }
  } catch (error) {
    check(false, `prepareProfile 失败：${error.message}`)
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
  // 选择，browser_open 落到桌面端的死路上，症状是「没法打开新的窗口」，且不报任何错。
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

const require = createRequire(join(runtimeDir, 'package.json'))
const { runDesktopHost } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-desktop-host')).href)

// 必须把 DSH_HOME 指到一次性 home：`loadLayeredEnv` 在 boot 时读它，不设就会落到
// 开发机自己的 `~/.dsh`（那份可能有正在运行的实例持有 .credentials.yaml.lock，
// 表现为 boot 挂在 writer lock 上而不是报错）。
process.env.DSH_HOME = scratchHome
// 上一次跑到一半被杀留下的锁会让下一次 boot 直接超时，先清掉。
rmSync(join(scratchHome, '.credentials.yaml.lock'), { force: true })

const FRAME_MAGIC = 1146308659
const FRAME_HEADER_BYTES = 13
const STREAM_START = 1
const STREAM_DATA = 2
const STREAM_END = 3
const STREAM_ERROR = 4
/** 每个 streamId 一个响应槽：start / data / end / error。 */
const sinks = new Map()
let decoderBuffer = Buffer.alloc(0)

/** 增量解码宿主响应管道（与 Electron 壳的 DesktopHostResponseDecoder 同协议）。 */
function feedResponsePipe(chunk) {
  decoderBuffer = decoderBuffer.byteLength === 0
    ? Buffer.from(chunk)
    : Buffer.concat([decoderBuffer, Buffer.from(chunk)])
  for (;;) {
    if (decoderBuffer.byteLength < FRAME_HEADER_BYTES) return
    if (decoderBuffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('响应帧标记不对（宿主协议版本不匹配？）')
    const type = decoderBuffer.readUInt8(4)
    const streamId = decoderBuffer.readUInt32BE(5)
    const length = decoderBuffer.readUInt32BE(9)
    if (decoderBuffer.byteLength < FRAME_HEADER_BYTES + length) return
    const payload = decoderBuffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)
    decoderBuffer = decoderBuffer.subarray(FRAME_HEADER_BYTES + length)
    const sink = sinks.get(streamId)
    if (sink === undefined) continue
    if (type === STREAM_START) sink.start(JSON.parse(payload.toString('utf8')))
    else if (type === STREAM_DATA) sink.data(payload)
    else if (type === STREAM_END) { sinks.delete(streamId); sink.end() }
    else if (type === STREAM_ERROR) { sinks.delete(streamId); sink.error(JSON.parse(payload.toString('utf8')).message) }
  }
}

const host = await runDesktopHost(runtimeDir, workProfileDir, async (frame) => feedResponsePipe(frame), {
  allowLinkedPackages: true,
})

// 宿主只认 URL 的 pathname，给个绝对 URL 即可。
const ORIGIN = `http://127.0.0.1:${String(options.port)}`
let nextStreamId = 1

/** 走宿主的 fetch 通道取一个路径，把响应缓冲成完整 body。 */
async function hostFetch(pathname) {
  const streamId = nextStreamId++
  const chunks = []
  let status = 0
  const done = new Promise((resolvePromise, rejectPromise) => {
    sinks.set(streamId, {
      start: (meta) => { status = meta.status },
      data: (payload) => chunks.push(payload),
      end: () => resolvePromise({ status, body: Buffer.concat(chunks) }),
      error: (message) => rejectPromise(new Error(message)),
    })
  })
  await host.fetch({ streamId, request: { url: `${ORIGIN}${pathname}`, method: 'GET', headers: [] } }, null)
  return await done
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

await host.dispose()
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
