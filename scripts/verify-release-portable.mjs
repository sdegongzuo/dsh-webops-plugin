/** 发布门禁直接验证随包运行时，不依赖开发机或 CI 的 harness 编译产物。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeRuntimeDir } from './desktop-runtime.mjs'
import { fetchHostPath, startPackagedDesktopHost } from './run-packaged-host.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const argv = process.argv.slice(2)
if (argv.length !== 2 || argv[0] !== '--dir') throw Error('用法：node scripts/verify-release-portable.mjs --dir <最终 ZIP 解压目录>')
const dir = resolve(argv[1])
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const assert = (ok, message) => { if (!ok) throw Error(message) }
const pkg = json(join(ROOT, 'package.json'))
const manifest = json(join(dir, 'release-manifest.json'))
const { runtimeDir } = materializeRuntimeDir(join(dir, 'app'))
const runtime = json(join(runtimeDir, 'desktop-runtime.json'))
assert(manifest.pluginVersion === pkg.version, '便携包插件版本与发布源码不一致')
assert(manifest.dshVersion === runtime.release.version, '便携包 DSH 版本与实际运行时不一致')
assert(runtime.platform === 'win32' && runtime.arch === 'x64', '便携包平台必须为 Windows x64')
assert(runtime.files?.length > 0, '缺少运行时完整性清单')
for (const file of runtime.files) {
  const target = resolve(runtimeDir, file.path)
  assert(target.startsWith(resolve(runtimeDir) + sep), `清单路径越界：${file.path}`)
  const bytes = readFileSync(target)
  assert(bytes.length === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256,
    `运行时完整性失败：${file.path}`)
}
const home = join(dir, 'home')
for (const name of ['.credentials.yaml', 'sessions', 'storages', '.anonymous-user-id']) {
  assert(!existsSync(join(home, name)), `出厂包含用户数据：${name}`)
}
const profile = join(home, 'profiles', 'desktop')
const bundles = json(join(profile, 'package.json')).dsh.profile.bundles
const vendor = json(join(ROOT, 'vendor/plugins/manifest.json')).plugins
for (const plugin of [{ name: pkg.name, version: pkg.version }, ...vendor]) {
  const installed = join(profile, 'node_modules', plugin.name)
  assert(json(join(installed, 'package.json')).version === plugin.version, `插件版本不一致：${plugin.name}`)
  assert(bundles.includes(plugin.name), `插件未登记：${plugin.name}`)
  assert(!existsSync(join(installed, 'lib', 'fake-llm')), `生产插件含 fake-llm：${plugin.name}`)
}
console.log(`运行时 ${runtime.release.version}：${runtime.files.length} 个文件哈希匹配，三个插件与出厂 home 通过`)
// 使用新的临时 home；仅启动验收副本，不向解压出的出厂 home 写入用户数据。
const { cpSync, mkdirSync, mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const scratch = mkdtempSync(join(tmpdir(), 'webops-release-check-'))
const workProfile = join(scratch, 'home', 'profiles', 'desktop')
mkdirSync(workProfile, { recursive: true })
cpSync(profile, workProfile, { recursive: true })
const host = startPackagedDesktopHost({ runtimeDir, profileDir: workProfile, env: { ...process.env, DSH_HOME: join(scratch, 'home') } })
try {
  const ready = await host.ready
  const page = await fetchHostPath(ready.url, '/index.html')
  assert(page.status === 200, `首页返回 ${page.status}`)
  const html = page.body.toString('utf8')
  assert(html.includes('__DSH_BOOT__'), '首页缺少客户端加载图')
  for (const name of [pkg.name, ...vendor.map(p => p.name)]) assert(html.includes(name), `客户端加载图缺少 ${name}`)
  // 只见客户端不能证明后端挂载；GET 必须进入侧边栏处理器的 JSON 方法校验。
  const sidebar = await fetchHostPath(ready.url, '/sidebar/api/fs.read')
  let envelope
  try { envelope = JSON.parse(sidebar.body.toString('utf8')) } catch { /* 空 405 是本次回归症状。 */ }
  assert(sidebar.status === 405 && envelope?.ok === false && envelope?.error?.code === 'method-error',
    `侧边栏后端未正常挂载：HTTP ${sidebar.status}，缺少方法校验信封`)
  console.log(`verify-release-portable: 实际生产宿主首页、三个插件加载图与侧边栏后端路由通过；验收副本保留在 ${scratch}`)
} finally {
  await host.stop()
}
