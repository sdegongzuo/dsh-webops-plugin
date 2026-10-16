#!/usr/bin/env node
/** 保留式开发装配：每次创建独立 profile，沿用用户 home，不清理旧产物。
 * 先完成安全构建，再用 pnpm dev:desktop 启动；--prepare-only 仅装配核验。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyLocalLlmKey } from '../src/local-llm-credentials.ts'
import { buildRoot, harnessRoot, harnessElectronBin } from './local-env.mjs'
import { prepareDevelopmentProfile, registerDevelopmentPlugin } from './prepare-development-profile.mjs'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = harnessRoot()
const APP_ROOT = join(REPO_ROOT, 'apps', 'desktop')
const DEVELOPMENT_ROOT = join(buildRoot(), 'development-webops')
let PROJECT_DIR
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
const libIndex = process.argv.indexOf('--lib-dir')
const LIB_DIR = libIndex < 0 ? undefined : process.argv[libIndex + 1]

function manifestVersion(path, subject) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof manifest.version !== 'string') throw new Error(`dev-desktop: ${subject} 没有 version`)
  return manifest.version
}

/**
 * 把构建产物复制进 profile 的 `node_modules/`。
 *
 * 必须是**真实目录**、不能是 symlink/junction：`validateDesktopPluginGraph` 对
 * 「linked private package」是直接拒绝的，打包态还要再检查依赖闭包必须物理落在 profile 内。
 * 复制一份同时也就对齐了打包态的形态。
 */
function installIntoProfile(profileDir) {
  const source = join(PLUGIN_ROOT, 'package.json')
  if (LIB_DIR === undefined || !existsSync(join(LIB_DIR, 'client.js'))) {
    throw new Error('dev-desktop: 必须传 --lib-dir <本轮构建目录>，先按打包文档执行 tsdown --no-clean 与 copy-assets')
  }
  const destination = join(profileDir, 'node_modules', PLUGIN_NAME)
  mkdirSync(destination, { recursive: true })
  for (const entry of SHIPPED) {
    const from = entry === 'lib' ? resolve(LIB_DIR) : join(PLUGIN_ROOT, entry)
    if (existsSync(from)) cpSync(from, join(destination, entry), { recursive: true })
  }
  // 生产配置由实际 profile 的 bundle 登记加载；overlay 只覆盖开发差异。
  const devOverlayPath = join(PLUGIN_ROOT, DEV_OVERLAY)
  const devOverlay = process.argv.includes('--fake-llm') && existsSync(devOverlayPath) ? readFileSync(devOverlayPath, 'utf8') : ''
  const base = JSON.parse(readFileSync(join(PROJECT_DIR, 'package.json'), 'utf8')).dsh.profile.bundles
  registerDevelopmentPlugin(profileDir, JSON.parse(readFileSync(source, 'utf8')), base, devOverlay)
  console.log(`dev-desktop: 已装配 ${PLUGIN_NAME}@${manifestVersion(source, '插件')} → ${destination}`)
}

async function loadDshModules() {
  // 通过 tsx 的 ESM hook 直接 import dsh 自己的 TS，避免复制它的逻辑。
  const projectManager = await import(pathToFileURL(join(APP_ROOT, 'src', 'project-manager.ts')).href)
  const hostProtocol = await import(pathToFileURL(join(APP_ROOT, 'src', 'host-protocol.ts')).href)
  // 开发态 primary runtime 目录 + 构建 target：0.1.7-rc.1 起两个都必须显式给（见文件头）。
  // 取上游同一份 helper，不硬拼平台串 —— 拼错会静默指到一个不存在的目录 / 直接被 assert 拦下。
  const buildPaths = await import(
    pathToFileURL(join(APP_ROOT, 'scripts', 'desktop-build-paths.mjs')).href
  )
  return {
    createDevelopmentProjectMetadata: projectManager.createDevelopmentProjectMetadata,
    hostProtocolVersion: hostProtocol.DESKTOP_HOST_PROTOCOL_VERSION,
    developmentRuntimeDirectory: buildPaths.developmentRuntimeDirectory,
    resolveDesktopBuildTarget: buildPaths.resolveDesktopBuildTarget,
    desktopTargetPlatform: buildPaths.desktopTargetPlatform,
  }
}

async function main() {
  const build = process.argv.includes('--build')
  if (!existsSync(join(REPO_ROOT, 'package.json'))) {
    throw new Error(`dev-desktop: 找不到 dsh checkout：${REPO_ROOT}`)
  }

  if (build) throw Error('dev-desktop: --build 已停用，避免上游默认清理；请先按打包与发版文档完成保留式构建')
  if (LIB_DIR === undefined || !existsSync(join(LIB_DIR, 'client.js'))) throw Error('dev-desktop: 缺少 --lib-dir <本轮构建目录>，未开始装配')
  const electron = harnessElectronBin()
  if (!process.argv.includes('--prepare-only') && !existsSync(electron)) {
    throw Error(`dev-desktop: Electron 二进制不存在：${electron}；请在 .env.local 配置 DSH_ELECTRON_BIN，不自动下载或安装`)
  }

  for (const path of [
    join(APP_ROOT, 'lib', 'main.js'),
    join(REPO_ROOT, 'apps', 'desktop-host', 'lib', 'index.js'),
  ]) {
    if (!existsSync(path)) throw new Error(`dev-desktop: 缺少构建产物 ${path}，请先按打包文档完成保留式构建`)
  }

  const { createDevelopmentProjectMetadata, hostProtocolVersion, developmentRuntimeDirectory, resolveDesktopBuildTarget, desktopTargetPlatform } = await loadDshModules()
  // 运行时清单的平台与 primary runtime 必须来自同一构建 target。
  const target = resolveDesktopBuildTarget()
  const release = {
    schemaVersion: 1,
    version: manifestVersion(join(APP_ROOT, 'package.json'), '桌面端'),
    hostProtocolVersion,
    nodeVersion: process.versions.node,
    pnpmVersion: manifestVersion(join(APP_ROOT, 'node_modules', 'pnpm', 'package.json'), 'pnpm'),
  }

  mkdirSync(DEVELOPMENT_ROOT, { recursive: true })
  PROJECT_DIR = join(mkdtempSync(join(DEVELOPMENT_ROOT, 'run-')), 'project')
  const assembled = prepareDevelopmentProfile({
    projectDir: PROJECT_DIR, cliDir: join(REPO_ROOT, 'apps', 'cli'),
    hostDir: join(REPO_ROOT, 'apps', 'desktop-host'),
    dependencyDir: join(REPO_ROOT, 'node_modules', '.pnpm', 'node_modules'),
    release, platform: desktopTargetPlatform(target), metadata: createDevelopmentProjectMetadata,
    excluded: [PLUGIN_NAME],
  })
  const home = resolve(process.env.DSH_HOME ?? join(DEVELOPMENT_ROOT, 'home'))
  const profileDir = join(home, 'profiles', 'desktop')
  if (existsSync(profileDir)) cpSync(profileDir, join(PROJECT_DIR, 'previous-profile'), { recursive: true })
  installIntoProfile(profileDir)
  console.log(JSON.stringify(assembled))
  if (process.argv.includes('--prepare-only')) return

  // 3. 启动，参数与环境与 dev.ts 保持一致。

  const environment = { ...process.env }
  // 宿主注入的 ELECTRON_RUN_AS_NODE 会让 electron.exe 退化成纯 Node，窗口起不来。
  delete environment.ELECTRON_RUN_AS_NODE
  environment.DSH_HOME = home
  // 与便携 app 模式共用 DSH_BROWSER_USER_DATA_DIR 契约，但按当前 DSH_HOME 隔离。
  // 开发态旧的系统 temp profile 没有所属 home 的标记，不自动让多个 profile 共用它。
  const configuredBrowserData = environment.DSH_BROWSER_USER_DATA_DIR?.trim()
  environment.DSH_BROWSER_USER_DATA_DIR = configuredBrowserData || join(home, 'data', 'browser')
  environment.DSH_DESKTOP_DSH_DIR = PROJECT_DIR
  const temporary = join(DEVELOPMENT_ROOT, 'temp')
  mkdirSync(temporary, { recursive: true })
  environment.TEMP = temporary
  environment.TMP = temporary
  environment.TMPDIR = temporary
  // 复用便携版 app 同级 home\.credentials.yaml 里已经填过的 key
  // （DSH_PORTABLE_ROOT=<解压根>，或 DSH_HOME 本身就是那个 home）。
  // 只注入子进程 env，不写进开发态 home，更不写进发版包。不读 ~/.dsh。
  const localKey = applyLocalLlmKey(environment)
  if (localKey !== undefined) {
    const where = localKey.source === 'env' ? '环境变量' : 'app 同级 home'
    console.log(`dev-desktop: 复用 ${localKey.name}（${where}，不进发版包）`)
  } else {
    console.log('dev-desktop: 没有本机 LLM key；真实对话需配置模型，开发回放仅在 --fake-llm 时启用')
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
  // profile 链接装配）。不存在就早说清楚，别等宿主 boot 到一半报个看不懂的错。
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
  // 的 GATE_ENV）；只有 --fake-llm 开启回放，正式对话与出货包不启用。
  environment.DSH_FAKE_LLM = process.argv.includes('--fake-llm') ? '1' : '0'
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
  console.log(`dev-desktop: 浏览器 userData=${environment.DSH_BROWSER_USER_DATA_DIR}（来源=${configuredBrowserData ? '环境变量' : '当前 DSH_HOME'}；此实例标签和对话共享）`)
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
