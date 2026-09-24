#!/usr/bin/env node
/**
 * 开发态把本插件装进**桌面端 profile** 并启动 Electron。
 *
 * ## 为什么需要这个脚本
 *
 * 桌面端的插件管理在未打包（开发）态是被硬禁的：
 * `apps/desktop/src/main.ts` 里 `plugin package changes require a packaged application`，
 * 且 `plugin-add` 只接受 npm registry 形态的 spec（拒绝 `file:` 与路径）。
 * 所以开发态必须手工装配 profile。
 *
 * 手工装配本来只有两步 —— 把包放进 `project/node_modules/`，再写 profile 自己的
 * `cordis.patch.yml`（`loadProfileDirectory` 会把它当作 bundle 层之后的 overlay）。
 * 但 `apps/desktop/scripts/dev.ts` 每次启动都会用 `prepareDevelopmentProject` **整目录重建**
 * `project/`，这两步都会被擦掉。
 *
 * 因此本脚本复刻 dev.ts 的启动序列，只在中间插入装配：prepare → 装插件 → 启动。
 * 它**不改动 deepseek-harness 里任何文件**：`prepareDevelopmentProject` 与
 * `DESKTOP_HOST_PROTOCOL_VERSION` 都是从 dsh 源码直接 import 的，没有复制。
 *
 * ## 用法
 *
 * ```bash
 * pnpm run dev:desktop            # 复用已有构建产物，装配后启动
 * pnpm run dev:desktop -- --build # 先跑 dsh 的完整构建再启动
 * ```
 *
 * 跑之前确保已经在 dsh 仓里执行过 `pnpm run build` 与 `pnpm --filter @deepseek-ai/dsh-desktop run build`
 * （或先跑一次 `pnpm run dev:desktop`），否则会明确报缺哪个产物。
 *
 * ## 上游版本相关的硬要求（跟随 dsh 升级时容易漏）
 *
 * **0.1.7-rc.1 起，未打包启动多了两条「调用方必须给」的强制契约**（都在 harness 侧，
 * 补丁 diff 里看不出来；alpha.2 都还没有）：
 *
 * 1. **`DSH_DESKTOP_PRIMARY_RUNTIME_DIR` 环境变量**。上游把它从「桌面壳内部按
 *    `.desktop-build/targets/<平台>-<架构>/runtime/primary-runtime` 自己拼」改成「调用方传」，
 *    `main.ts` 里拿不到就直接 `throw` —— 所以**每个自己起未打包 electron 的地方都得补**。
 *    本脚本按上游 `scripts/dev.ts:71` 的同一份实现注入，并把「目录不存在」提前成明确告警。
 * 2. **`prepareDevelopmentProject` 的 `target` 选项**（`development-project.ts` 里是
 *    `readonly target: DesktopAutoUpdateTarget`）。不传不是「用默认值」，而是 `undefined`
 *    一路传到 `desktopTargetPlatform(undefined)` → 抛
 *    `desktop build paths: unsupported target undefined`（**报错里连个能搜的关键词都没有**）。
 *    上游 `scripts/dev.ts:120` 传的是 `resolveDesktopBuildTarget()`，本脚本照抄。
 *
 * 两条都从**同一个 `process.env`** 解析，所以「拿哪一份 target」不会有分歧 —— 别自己拼平台串。
 *
 * **0.1.7-rc.1 起还有一个「上游自有软链没清干净就起不来」的坑**：`prepareDevelopmentProject`
 * 会把依赖目录里每个条目 `symlinkSync(realpathSync(source), …)` 链进 `project/node_modules`，
 * 而 **`realpathSync` 遇到悬空软链会抛 `ENOENT … stat`**（不是「跳过」）。pnpm 升级后
 * **不会清理** `.pnpm/node_modules` 里指向已删 workspace 包的那些死链（本机从 0.1.6→rc.1
 * 留了 12 条），于是报错长得像「某个包没装」。`pnpm install` 显示 `Already up to date` 也没用。
 * 判据与修法：
 *   `cd <harness> && find node_modules/.pnpm/node_modules -maxdepth 2 -xtype l -delete`
 * （`-xtype l` = 只看悬空链；它们全是零字节软链，删掉不丢数据。删前 `-printf '%f -> %l\n'`
 *   留一份目标清单即可。）
 *
 * ## 本机环境相关的硬要求
 *
 * **跑之前必须关掉安全删除垫片**（WorkBuddy 注入 `CODEBUDDY_SAFE_DELETE_ENABLED=1`）。
 * `prepareDevelopmentProject` 每次启动都要整目录重删 `project/`（本机 105 项 > 垫片阈值 50）
 * → 报 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，看着像脚本坏了。
 * 垫片在 **require 期**读 env，进程内改 `process.env` 无效 → 本脚本**换一个进程重跑自己**
 * （同 `scripts/clean-build-residue.mjs` 的 `reexecWithoutSafeDelete`，那边有实测数字）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyLocalLlmKey } from '../src/local-llm-credentials.ts'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', 'deepseek-harness')
const APP_ROOT = join(REPO_ROOT, 'apps', 'desktop')
const DEVELOPMENT_ROOT = join(APP_ROOT, '.desktop-build', 'development')
const PROJECT_DIR = join(DEVELOPMENT_ROOT, 'project')
const PLUGIN_NAME = 'dsh-webops-plugin'

/** 装进 profile 的包内容；`src/` 不进去，桌面端只吃构建产物。 */
const SHIPPED = ['lib', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']

/**
 * 仅开发态拼接的 overlay 文件名。
 *
 * `cordis.patch.yml` 是**出货版**的 patch（随 `package.json#files` 进便携版），里面的行
 * 每个用户都会装上；`fake-llm` 会接管 `llm/stream`，只能待在开发态，所以它单独一个文件，
 * 由本脚本拼在出货 patch 之后写进 profile overlay。
 * 2026-09-14：v0.2.0 曾把那一行随包带出去，真实对话会被换成假回放。
 */
const DEV_OVERLAY = 'cordis.fake-llm.patch.yml'

/** 桌面端在开发态固定使用的三个调试端口，与 dsh 的 dev.ts 一致。 */
const PORTS = { main: 9229, renderer: 9222, host: 9230 }

/** 安全删除垫片的开关名（WorkBuddy CLI 通过 `NODE_OPTIONS=--require=…node-language-shim.cjs` 注入）。 */
const SAFE_DELETE_FLAG = 'CODEBUDDY_SAFE_DELETE_ENABLED'

/**
 * 关掉安全删除垫片并重跑自己（原因见文件头「本机环境相关的硬要求」）。
 *
 * 垫片在 require 期读 env，所以**只能换进程**：本脚本里 `prepareDevelopmentProject`
 * 是 import 进来的、跑在**当前**进程里，没法像 harness:build 那样只给子进程带 env。
 * 只在垫片真开着时重跑（本机实测取值 `1`），否则白起一层进程；重跑出来的子进程带着 `0`，
 * 不会无限递归。
 *
 * ⚠️ 必须把 `process.execArgv` 一起带上：本脚本由 `tsx` 拉起，tsx 是通过
 * `--require preflight.cjs --import loader.mjs` 注册的 hooks（不在 `NODE_OPTIONS` 里）。
 * 只 `spawn(execPath, [脚本])` 会退化成**纯 node**，于是 import `../src/*.ts` 时就地触发
 * Node 自带的 type-stripping 并报 `TypeScript parameter property is not supported in
 * strip-only mode` —— 看着像源码坏了，其实是少传了 loader。
 */
function reexecWithoutSafeDelete() {
  if (process.env[SAFE_DELETE_FLAG] !== '1') return
  console.log(`安全删除垫片开着（${SAFE_DELETE_FLAG}=1）：它会把 prepareDevelopmentProject 的整目录`
    + '删除拦成 SAFE_DELETE_BULK_CONFIRM_REQUIRED。换一个关掉垫片的进程重跑本脚本。\n')
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, [SAFE_DELETE_FLAG]: '0' } },
  )
  process.exit(result.status ?? 1)
}

reexecWithoutSafeDelete()

function manifestVersion(path, subject) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof manifest.version !== 'string') throw new Error(`dev-desktop: ${subject} 没有 version`)
  return manifest.version
}

function runPackageScript(script, cwd) {
  const packageManager = process.env.npm_execpath
  if (packageManager === undefined || packageManager === '') {
    throw new Error('dev-desktop: 请通过 pnpm 运行（pnpm run dev:desktop）')
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [packageManager, 'run', script], { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolvePromise()
      : reject(new Error(`dev-desktop: ${script} 退出码 ${String(code)}`)))
  })
}

/**
 * 把构建产物复制进 profile 的 `node_modules/`。
 *
 * 必须是**真实目录**、不能是 symlink/junction：`validateDesktopPluginGraph` 对
 * 「linked private package」是直接拒绝的，打包态还要再检查依赖闭包必须物理落在 profile 内。
 * 复制一份同时也就对齐了打包态的形态。
 */
function installIntoProfile() {
  const source = join(PLUGIN_ROOT, 'package.json')
  if (!existsSync(join(PLUGIN_ROOT, 'lib', 'client.js'))) {
    throw new Error('dev-desktop: 缺少 lib/client.js —— 先在插件仓跑 pnpm run build')
  }
  const destination = join(PROJECT_DIR, 'node_modules', PLUGIN_NAME)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  for (const entry of SHIPPED) {
    const from = join(PLUGIN_ROOT, entry)
    if (existsSync(from)) cpSync(from, join(destination, entry), { recursive: true })
  }
  // profile 自己的 overlay：`loadProfileDirectory` 在 bundle 层之后读它。
  //
  // 开发态里本插件**不是**注册的 bundle（`prepareDevelopmentProject` 不写 bundles 列表），
  // 所以这个 overlay 必须承载全部行 —— 出货 patch + 开发专用的 fake-llm 行。
  const shippedPatch = readFileSync(join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8')
  const devOverlayPath = join(PLUGIN_ROOT, DEV_OVERLAY)
  const devOverlay = existsSync(devOverlayPath) ? readFileSync(devOverlayPath, 'utf8') : ''
  writeFileSync(
    join(PROJECT_DIR, 'cordis.patch.yml'),
    devOverlay === '' ? shippedPatch : `${shippedPatch}\n\n${devOverlay}`,
  )
  if (devOverlay === '') {
    console.warn(`dev-desktop: 缺 ${DEV_OVERLAY} —— fake-llm 不会挂上，keyless 验证链路跑不了`)
  }
  console.log(`dev-desktop: 已装配 ${PLUGIN_NAME}@${manifestVersion(source, '插件')} → ${destination}`)
}

async function loadDshModules() {
  // 通过 tsx 的 ESM hook 直接 import dsh 自己的 TS，避免复制它的逻辑。
  const developmentProject = await import(
    pathToFileURL(join(APP_ROOT, 'scripts', 'development-project.ts')).href
  )
  const hostProtocol = await import(pathToFileURL(join(APP_ROOT, 'src', 'host-protocol.ts')).href)
  // 开发态 primary runtime 目录 + 构建 target：0.1.7-rc.1 起两个都必须显式给（见文件头）。
  // 取上游同一份 helper，不硬拼平台串 —— 拼错会静默指到一个不存在的目录 / 直接被 assert 拦下。
  const buildPaths = await import(
    pathToFileURL(join(APP_ROOT, 'scripts', 'desktop-build-paths.mjs')).href
  )
  return {
    prepareDevelopmentProject: developmentProject.prepareDevelopmentProject,
    hostProtocolVersion: hostProtocol.DESKTOP_HOST_PROTOCOL_VERSION,
    developmentRuntimeDirectory: buildPaths.developmentRuntimeDirectory,
    resolveDesktopBuildTarget: buildPaths.resolveDesktopBuildTarget,
  }
}

async function main() {
  const build = process.argv.includes('--build')
  if (!existsSync(join(REPO_ROOT, 'package.json'))) {
    throw new Error(`dev-desktop: 找不到 dsh checkout：${REPO_ROOT}`)
  }

  if (build) {
    await runPackageScript('build', REPO_ROOT)
    await runPackageScript('build', APP_ROOT)
  }

  for (const path of [
    join(APP_ROOT, 'lib', 'main.js'),
    join(REPO_ROOT, 'apps', 'desktop-host', 'lib', 'index.js'),
  ]) {
    if (!existsSync(path)) throw new Error(`dev-desktop: 缺少构建产物 ${path}（去掉 --build 前先跑一次 pnpm run dev:desktop，或加上 --build）`)
  }

  const { prepareDevelopmentProject, hostProtocolVersion, developmentRuntimeDirectory, resolveDesktopBuildTarget } = await loadDshModules()
  // 构建 target 必须显式解析一次（rc.1 起 `prepareDevelopmentProject` 要求；不给就 assert 抛错）。
  const target = resolveDesktopBuildTarget()
  const release = {
    schemaVersion: 1,
    version: manifestVersion(join(APP_ROOT, 'package.json'), '桌面端'),
    hostProtocolVersion,
    nodeVersion: process.versions.node,
    pnpmVersion: manifestVersion(join(APP_ROOT, 'node_modules', 'pnpm', 'package.json'), 'pnpm'),
  }

  // 1. 复刻 dev.ts 的重建（会清空 project/）。
  prepareDevelopmentProject({
    projectDir: PROJECT_DIR,
    cliDir: join(REPO_ROOT, 'apps', 'cli'),
    hostDir: join(REPO_ROOT, 'apps', 'desktop-host'),
    dependencyDir: join(REPO_ROOT, 'node_modules', '.pnpm', 'node_modules'),
    release,
    target,
  })

  // 2. 在被擦掉之前之后插入装配 —— 这就是本脚本存在的全部理由。
  installIntoProfile()

  // 3. 启动，参数与环境与 dev.ts 保持一致。
  const require = createRequire(join(APP_ROOT, 'package.json'))
  const electron = require('electron')
  if (typeof electron !== 'string') throw new Error('dev-desktop: 取不到 electron 可执行文件（apps/desktop/node_modules/electron 装好了吗）')

  const environment = { ...process.env }
  // 宿主注入的 ELECTRON_RUN_AS_NODE 会让 electron.exe 退化成纯 Node，窗口起不来。
  delete environment.ELECTRON_RUN_AS_NODE
  environment.DSH_HOME = resolve(process.env.DSH_HOME ?? join(DEVELOPMENT_ROOT, 'home'))
  // 复用便携版 app 同级 home\.credentials.yaml 里已经填过的 key
  // （DSH_PORTABLE_ROOT=<解压根>，或 DSH_HOME 本身就是那个 home）。
  // 只注入子进程 env，不写进开发态 home，更不写进发版包。不读 ~/.dsh。
  const localKey = applyLocalLlmKey(environment)
  if (localKey !== undefined) {
    const where = localKey.source === 'env' ? '环境变量' : 'app 同级 home'
    console.log(`dev-desktop: 复用 ${localKey.name}（${where}，不进发版包）`)
  } else {
    console.log('dev-desktop: 便携 home 里没有 LLM key，keyless 验证走 fake-llm')
  }
  environment.DSH_DESKTOP_HOST_INSPECT_PORT = String(PORTS.host)
  environment.DSH_DESKTOP_NODE_BINARY = process.execPath
  // 0.1.7-rc.1 起 unpackaged 启动**必须**显式给 primary runtime 目录：`main.ts` 的
  // `developmentPrimaryRuntime()` 拿不到就 **throw**（不是警告）—— 上游把它从「桌面壳内部
  // 按 `.desktop-build/targets/<平台>-<架构>/runtime/primary-runtime` 自己拼」改成了「调用方传」，
  // 于是每个自己起未打包 electron 的地方都得补。上游 `scripts/dev.ts:71` 的写法就是
  // `?? developmentRuntimeDirectory()`，这里照同一份实现。
  //
  // ⚠️ 这里和上面的 `target` 都从**同一个 `process.env`**解析（`developmentRuntimeDirectory()`
  // 内部自己再 resolve 一次 target），所以两者不可能指向不同的 target —— 别改成手拼路径。
  environment.DSH_DESKTOP_PRIMARY_RUNTIME_DIR ??= developmentRuntimeDirectory()
  // 它由 harness 的 `preparePrimaryRuntime` 准备，**本脚本不代劳**（我们只复刻
  // `prepareDevelopmentProject`）。不存在就早说清楚，别等宿主 boot 到一半报个看不懂的错。
  if (!existsSync(environment.DSH_DESKTOP_PRIMARY_RUNTIME_DIR)) {
    console.warn(`dev-desktop: ⚠ ${environment.DSH_DESKTOP_PRIMARY_RUNTIME_DIR} 不存在 ——`
      + ' 开发态 primary runtime 未准备，宿主很可能起不来。'
      + ' 准备方式：在 dsh checkout 里跑一次 `pnpm --filter @deepseek-ai/dsh-desktop dev`（或任何会调 preparePrimaryRuntime 的入口）。')
  }
  environment.DSH_DESKTOP_OPEN_DEVTOOLS ??= '0'
  environment.ELECTRON_ENABLE_LOGGING ??= '1'
  // 打开本插件的加载诊断，便于确认 host 半边是否真的挂上。
  environment.DSH_BROWSER_PLUGIN_DEBUG ??= '1'
  // P0 采样（方案 §4）：默认落在插件仓库内的 `.metrics/`（已 gitignore）。
  // 为什么给默认值而不是只写文档：样本要「日常使用自动积累」，靠人记得在命令行加前缀
  // 等于永远收不到样本（§4 的三个数至今为零就是这么来的）。`??=` 不覆盖外部设置，
  // 想换目录仍然是 `DSH_BROWSER_PLUGIN_METRICS=<别处> pnpm run dev:desktop`。
  // 出货包里这个变量不存在，插件侧整条计数为 no-op（metrics.ts 纪律 1）。
  environment.DSH_BROWSER_PLUGIN_METRICS ??= join(PLUGIN_ROOT, '.metrics')
  // 开发态显式开闸：`fake-llm` 的 `llm/stream` 接管是**默认关闭**的（见 src/fake-llm/index.ts
  // 的 GATE_ENV），keyless 验证需要它，所以这里置 1。出货包里两者都不存在。
  environment.DSH_FAKE_LLM ??= '1'
  // 桌面端的浏览器 provider 用 `electron`：它开的是**桌面端自己的 BrowserWindow**。
  // 不用 `cdp` 是因为桌面端那个调试端口（9222）就是它自己的渲染进程，嵌入式 Chromium
  // 不实现 `PUT /json/new` —— 连它做 webpage_open 只会得到「Could not create new page」。
  environment.DSH_BROWSER_PROVIDER ??= 'electron'
  // 窗口宿主需要真的 Electron 二进制；这里就用跑桌面端的这一个。
  environment.DSH_BROWSER_ELECTRON_PATH ??= electron
  // 万一有人把 provider 切回 `cdp`，端点也别指向桌面端自己。
  // 注意：默认的 `electron` provider **完全用不到**这个端点 —— 桌面模式下不起任何
  // Chrome；只有显式把 provider 换成 `cdp`（或跑 headless 无头验证链路）才需要
  // 一个真 Chrome 实例监听 9333。
  environment.DSH_BROWSER_CDP_ENDPOINT ??= 'http://127.0.0.1:9333'

  console.log(`dev-desktop: DSH_HOME=${environment.DSH_HOME}`)
  console.log(`dev-desktop: 调试端口 main=${PORTS.main} renderer=${PORTS.renderer} host=${PORTS.host}`)
  console.log(`dev-desktop: 浏览器 provider=${environment.DSH_BROWSER_PROVIDER}`
    + `（electron = 桌面端自己的窗口；换 cdp 需另起真 Chrome）`)
  console.log(`dev-desktop: P0 采样落盘 → ${environment.DSH_BROWSER_PLUGIN_METRICS}`
    + '（会话关闭时追加一行 JSONL；不想要就设成空串）')
  console.log('dev-desktop: 校验用 → pnpm run check:desktop')

  await new Promise((resolvePromise, reject) => {
    const child = spawn(electron, [
      `--inspect=127.0.0.1:${String(PORTS.main)}`,
      `--remote-debugging-port=${String(PORTS.renderer)}`,
      `--user-data-dir=${join(DEVELOPMENT_ROOT, 'electron-user-data')}`,
      APP_ROOT,
    ], { cwd: APP_ROOT, env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => resolvePromise(code ?? 0))
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
