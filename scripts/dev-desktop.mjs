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
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', 'deepseek-harness')
const APP_ROOT = join(REPO_ROOT, 'apps', 'desktop')
const DEVELOPMENT_ROOT = join(APP_ROOT, '.desktop-build', 'development')
const PROJECT_DIR = join(DEVELOPMENT_ROOT, 'project')
const PLUGIN_NAME = 'dsh-browser-plugin'

/** 装进 profile 的包内容；`src/` 不进去，桌面端只吃构建产物。 */
const SHIPPED = ['lib', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']

/** 桌面端在开发态固定使用的三个调试端口，与 dsh 的 dev.ts 一致。 */
const PORTS = { main: 9229, renderer: 9222, host: 9230 }

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
  writeFileSync(
    join(PROJECT_DIR, 'cordis.patch.yml'),
    readFileSync(join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8'),
  )
  console.log(`dev-desktop: 已装配 ${PLUGIN_NAME}@${manifestVersion(source, '插件')} → ${destination}`)
}

async function loadDshModules() {
  // 通过 tsx 的 ESM hook 直接 import dsh 自己的 TS，避免复制它的逻辑。
  const developmentProject = await import(
    pathToFileURL(join(APP_ROOT, 'scripts', 'development-project.ts')).href
  )
  const hostProtocol = await import(pathToFileURL(join(APP_ROOT, 'src', 'host-protocol.ts')).href)
  return {
    prepareDevelopmentProject: developmentProject.prepareDevelopmentProject,
    hostProtocolVersion: hostProtocol.DESKTOP_HOST_PROTOCOL_VERSION,
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

  const { prepareDevelopmentProject, hostProtocolVersion } = await loadDshModules()
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
  environment.DSH_DESKTOP_HOST_INSPECT_PORT = String(PORTS.host)
  environment.DSH_DESKTOP_NODE_BINARY = process.execPath
  environment.DSH_DESKTOP_OPEN_DEVTOOLS ??= '0'
  environment.ELECTRON_ENABLE_LOGGING ??= '1'
  // 打开本插件的加载诊断，便于确认 host 半边是否真的挂上。
  environment.DSH_BROWSER_PLUGIN_DEBUG ??= '1'

  console.log(`dev-desktop: DSH_HOME=${environment.DSH_HOME}`)
  console.log(`dev-desktop: 调试端口 main=${PORTS.main} renderer=${PORTS.renderer} host=${PORTS.host}`)
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
