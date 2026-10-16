/**
 * 用当前 bridge 与本轮 host.cjs 验证 profile 隔离、关标签与重启持久化。
 * 仅创建 D 盘证据目录；不清理 profile、旧路径或证据。该脚本模式不替代便携 app.exe 验收。
 *
 * 用法：pnpm exec tsx scripts/verify-browser-profile-persistence.ts --electron <Electron.exe> --host <host.cjs> --evidence <D:\\evidence>
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import type { ElectronWindowBridge as SourceBridge } from '../src/browser-electron/bridge.ts'
import { resolveHostLaunch as resolveSourceHostLaunch } from '../src/browser-electron/bridge.ts'

const parsed = parseArgs({ options: {
  electron: { type: 'string' }, host: { type: 'string' }, evidence: { type: 'string' }, bundle: { type: 'string' },
  'app-mode': { type: 'boolean' }, 'app-root': { type: 'string' }, 'runtime-app': { type: 'string' },
}, strict: true })
const rawEvidence = parsed.values.evidence
if (!parsed.values.electron || !parsed.values.host || !rawEvidence) {
  throw new Error('用法：pnpm exec tsx scripts/verify-browser-profile-persistence.ts --electron <Electron.exe> --host <host.cjs> --evidence <D盘证据目录> [--bundle <browser-electron/index.js> --runtime-app <win-unpacked目录>] [--app-mode --app-root <候选包根目录>]')
}
if (!isAbsolute(rawEvidence) || !/^D:[\\/]/iu.test(rawEvidence)) {
  throw new Error(`证据目录必须是 D 盘绝对路径：${rawEvidence}`)
}
const electronPath = resolve(parsed.values.electron)
const hostScript = resolve(parsed.values.host)
const evidenceRoot = resolve(rawEvidence)
const appMode = parsed.values['app-mode'] === true
const appRoot = parsed.values['app-root'] ? resolve(parsed.values['app-root']) : undefined
const runtimeApp = parsed.values['runtime-app'] ? resolve(parsed.values['runtime-app']) : (appMode ? join(appRoot!, 'app') : undefined)
if (appMode && appRoot === undefined) throw new Error('--app-mode 需要显式 --app-root，避免把可写目录推断到未知安装位置')
if (!appMode && appRoot !== undefined) throw new Error('--app-root 仅适用于 --app-mode')
if (appMode && dirname(electronPath) !== join(appRoot!, 'app')) throw new Error(`候选 Electron 必须位于指定 app 根目录：${electronPath}`)
if (appMode && (!isAbsolute(parsed.values['app-root']!) || !/^D:[\\/]/iu.test(parsed.values['app-root']!))) {
  throw new Error(`--app-root 必须是 D 盘绝对路径：${parsed.values['app-root']}`)
}
const runRoot = join(evidenceRoot, `browser-profile-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`)
mkdirSync(runRoot, { recursive: true })

let ElectronWindowBridge: typeof SourceBridge
let loadedBridge: Record<string, unknown>
let actualBridgeIdentity: Record<string, unknown>
if (parsed.values.bundle) {
  if (!runtimeApp) throw new Error('--bundle 必须提供 --runtime-app，或在 --app-mode 下使用 --app-root')
  const bundlePath = resolve(parsed.values.bundle)
  const buildRoot = dirname(dirname(bundlePath))
  const isolatedBuild = join(runRoot, 'bundle-runtime')
  cpSync(buildRoot, isolatedBuild, { recursive: true })
  const nodeModules = join(isolatedBuild, 'node_modules')
  if (!existsSync(nodeModules)) mkdirSync(nodeModules)
  const runtimeScope = join(runtimeApp, 'resources', 'dsh', 'node_modules', '@deepseek-ai')
  if (!existsSync(runtimeScope)) throw new Error(`runtime 缺少 @deepseek-ai 依赖目录：${runtimeScope}`)
  const scopeLink = join(nodeModules, '@deepseek-ai')
  if (existsSync(scopeLink)) throw new Error(`隔离 bundle 的 @deepseek-ai 已存在，拒绝复用：${scopeLink}`)
  symlinkSync(runtimeScope, scopeLink, 'junction')
  const entry = join(isolatedBuild, relative(buildRoot, bundlePath))
  loadedBridge = await import(pathToFileURL(entry).href) as Record<string, unknown>
  if (typeof loadedBridge['ElectronWindowBridge'] !== 'function') {
    throw new Error(`构建 bundle 缺少 bridge 导出：${bundlePath}`)
  }
  ElectronWindowBridge = loadedBridge['ElectronWindowBridge'] as typeof SourceBridge
  actualBridgeIdentity = { kind: '本轮构建 bundle 实际执行', sourcePath: bundlePath, sha256: sha256(bundlePath), isolatedExecutionPath: entry, runtimeApp, runtimeScope }
} else {
  loadedBridge = await import('../src/browser-electron/bridge.ts') as Record<string, unknown>
  ElectronWindowBridge = loadedBridge['ElectronWindowBridge'] as typeof SourceBridge
  actualBridgeIdentity = { kind: '当前源码 bridge 实际执行', sourcePath: resolve('src/browser-electron/bridge.ts'), sha256: sha256(resolve('src/browser-electron/bridge.ts')) }
}

const page = '<!doctype html><meta charset="utf-8"><title>profile persistence probe</title><body>profile probe</body>'
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
})
await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen)
  server.listen(0, '127.0.0.1', resolveListen)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('本地测试页没有 TCP 地址')
const url = `http://127.0.0.1:${String(address.port)}/`
const launchRecords: Record<string, unknown>[] = []

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function evaluatedValue(result: unknown): unknown {
  const outer = result as { result?: { value?: unknown } }
  return outer.result?.value
}

async function evaluate(bridge: ElectronWindowBridge, tabId: string, expression: string): Promise<unknown> {
  return evaluatedValue(await bridge.command(tabId, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }))
}

async function startBridge(profilePath: string): Promise<ElectronWindowBridge> {
  process.env.DSH_BROWSER_USER_DATA_DIR = profilePath
  const options = { electronPath, hostScript, ...(appMode ? { appMode: true } : {}) }
  const launch = resolveSourceHostLaunch(options)
  launchRecords.push({
    profilePath, args: launch.args, appHostScript: launch.environment.DSH_BROWSER_ELECTRON_HOST,
    electronRunAsNodeRemoved: launch.environment.ELECTRON_RUN_AS_NODE === undefined,
  })
  return ElectronWindowBridge.start(options)
}

function processIdentity(bridge: ElectronWindowBridge) {
  // 仅验收脚本读取 bridge 的私有 ChildProcess，以保存真实 spawn PID 与参数，不扩展生产 API。
  const runtime = bridge as unknown as { child: { pid?: number; spawnfile?: string; spawnargs?: string[] } }
  return { pid: runtime.child.pid, spawnfile: runtime.child.spawnfile, spawnargs: runtime.child.spawnargs }
}

async function profileState(bridge: ElectronWindowBridge, tabId: string, marker: string) {
  const browserVersion = await bridge.command(tabId, 'Browser.getVersion')
  const values = await evaluate(bridge, tabId, `({
    localStorage: localStorage.getItem('profile_marker'),
    persistentCookie: document.cookie.includes('persistent_marker=' + encodeURIComponent(${JSON.stringify(marker)})),
    sessionCookie: document.cookie.includes('session_marker=' + encodeURIComponent(${JSON.stringify(marker)})),
  })`)
  return { browserVersion, values }
}

const profiles = appMode
  ? [{ name: 'portable-app', marker: 'portable-profile', path: join(appRoot!, 'data', 'browser') }]
  : ['instance-a', 'instance-b'].map((name, index) => ({
    name, marker: index === 0 ? 'profile-A' : 'profile-B',
    path: join(runRoot, 'profiles', name, 'data', 'browser'),
  }))
if (appMode) mkdirSync(join(appRoot!, 'home'), { recursive: true })
for (const profile of profiles) mkdirSync(profile.path, { recursive: true })

const report: Record<string, unknown> = {
  createdAt: new Date().toISOString(), electronPath, electronSha256: sha256(electronPath),
  hostScript, hostSha256: sha256(hostScript), bridgeSourceSha256: sha256(resolve('src/browser-electron/bridge.ts')),
  actualBridgeIdentity, bundleLaunchRecords: launchRecords, mode: appMode ? '候选便携 app.exe appMode' : 'Electron script host',
  ...(appRoot ? { appRoot, appProfilePath: profiles[0]!.path } : {}),
  testPage: url, evidenceRoot: runRoot, profiles: [],
  sessionCookie: '要求关标签后仍存在；重启后的值仅记录 Chromium 实际策略，不设为通过门槛。',
  scope: appMode
    ? '候选便携 app.exe appMode 使用目标壳启动本轮 host.cjs；bridge 实际来源见 actualBridgeIdentity，单 profile 持久化验收。'
    : `Electron script 模式；bridge 实际来源见 actualBridgeIdentity，host.cjs 为指定构建；${profiles.length === 2 ? '双 profile 隔离' : '单 profile'}与持久化验收。`,
}
const bridges: ElectronWindowBridge[] = []
const profileResults: Record<string, unknown>[] = []

try {
  const tabs: Array<{ id: string; bridge: ElectronWindowBridge }> = []
  for (const profile of profiles) {
    const bridge = await startBridge(profile.path)
    bridges.push(bridge)
    const tab = await bridge.open(url)
    tabs.push({ id: tab.id, bridge })
    const browserVersion = await bridge.command(tab.id, 'Browser.getVersion')
    profileResults.push({
      name: profile.name, marker: profile.marker, profilePath: profile.path,
      process: processIdentity(bridge), browserVersion: evaluatedValue(browserVersion),
    })
  }

  const initialStates = await Promise.all(tabs.map(({ bridge, id }, index) => profileState(bridge, id, profiles[index]!.marker)))
  for (const state of initialStates) {
    const values = state.values as { localStorage?: unknown; persistentCookie?: unknown; sessionCookie?: unknown }
    if (values.localStorage !== null || values.persistentCookie !== false || values.sessionCookie !== false) {
      throw new Error(`新 profile 初始状态非空，隔离验收前提失败：${JSON.stringify(state)}`)
    }
  }

  const writeMarker = async (index: number) => evaluate(tabs[index]!.bridge, tabs[index]!.id, `(() => {
    localStorage.setItem('profile_marker', ${JSON.stringify(profiles[index]!.marker)});
    document.cookie = 'persistent_marker=' + encodeURIComponent(${JSON.stringify(profiles[index]!.marker)}) + '; Max-Age=2592000; Path=/; SameSite=Lax';
    document.cookie = 'session_marker=' + encodeURIComponent(${JSON.stringify(profiles[index]!.marker)}) + '; Path=/; SameSite=Lax';
    return true;
  })()`)
  let crossWriteResults: unknown[] = []
  if (profiles.length === 2) {
    await writeMarker(0)
    const bAfterAWrite = await profileState(tabs[1]!.bridge, tabs[1]!.id, profiles[1]!.marker)
    if ((bAfterAWrite.values as { localStorage?: unknown }).localStorage !== null) throw new Error('A 写入后 B 读到 A 数据，profile 隔离失败')
    await writeMarker(1)
    const aAfterBWrite = await profileState(tabs[0]!.bridge, tabs[0]!.id, profiles[0]!.marker)
    const bAfterBWrite = await profileState(tabs[1]!.bridge, tabs[1]!.id, profiles[1]!.marker)
    if ((aAfterBWrite.values as { localStorage?: unknown }).localStorage !== profiles[0]!.marker
      || (bAfterBWrite.values as { localStorage?: unknown }).localStorage !== profiles[1]!.marker) {
      throw new Error('A/B 交叉写入后 profile 内容未保持独立')
    }
    crossWriteResults = [aAfterBWrite, bAfterBWrite]
  } else {
    await writeMarker(0)
  }

  const closeTabResults: Record<string, unknown>[] = []
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]!
    const tabRef = tabs[index]!
    await tabRef.bridge.closeTab(tabRef.id)
    const tab = await tabRef.bridge.open(url)
    tabs[index] = { id: tab.id, bridge: tabRef.bridge }
    const state = await profileState(tabRef.bridge, tab.id, profile.marker)
    const values = state.values as { localStorage?: unknown; persistentCookie?: unknown; sessionCookie?: unknown }
    if (values.localStorage !== profile.marker || values.persistentCookie !== true || values.sessionCookie !== true) {
      throw new Error(`关标签后 profile 数据未保留：${profile.name}`)
    }
    closeTabResults.push({ name: profile.name, state })
  }

  const processIdentities = profileResults.map(profile => profile['process'])
  for (const bridge of bridges) await bridge.dispose()
  bridges.length = 0

  const restartResults: Record<string, unknown>[] = []
  for (const profile of profiles) {
    const bridge = await startBridge(profile.path)
    try {
      const tab = await bridge.open(url)
      const state = await profileState(bridge, tab.id, profile.marker)
      const values = state.values as { localStorage?: unknown; persistentCookie?: unknown; sessionCookie?: unknown }
      if (values.localStorage !== profile.marker || values.persistentCookie !== true) {
        throw new Error(`正常宿主退出再启动后 localStorage/持久 Cookie 未保留：${profile.name}`)
      }
      restartResults.push({ name: profile.name, state, process: processIdentity(bridge) })
    } finally {
      await bridge.dispose()
    }
  }

  report['profiles'] = profileResults.map((profile, index) => ({
    ...profile, afterCrossWrite: crossWriteResults[index],
    afterCloseTab: closeTabResults[index], afterRestart: restartResults[index],
    firstProcess: processIdentities[index],
  }))
  const reportPath = join(runRoot, 'report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
} catch (error) {
  const failure = { error: String(error), stack: error instanceof Error ? error.stack : undefined, report, profiles: profileResults }
  const failurePath = join(runRoot, 'failure.json')
  try {
    writeFileSync(failurePath, JSON.stringify(failure, null, 2))
    console.error(JSON.stringify({ ...failure, failurePath }, null, 2))
  } catch (writeError) {
    console.error(JSON.stringify({ ...failure, evidenceWriteError: String(writeError), stdoutStderrRetention: '本进程 stdout/stderr 保持原样供命令记录，不删除临时证据。' }, null, 2))
  }
  throw error
} finally {
  for (const bridge of bridges) {
    if (!bridge.isClosed) {
      try { await bridge.dispose() } catch (error) { console.error(`宿主收尾失败：${String(error)}`) }
    }
  }
  server.close()
}
