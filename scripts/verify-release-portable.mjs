/** 发布门禁直接验证随包运行时，不依赖开发机或 CI 的 harness 编译产物。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeRuntimeDir } from './desktop-runtime.mjs'
import { fetchHostPath, startPackagedDesktopHost } from './run-packaged-host.mjs'
import { assertDesktopBuildIdentity } from './desktop-build-identity.mjs'
import { verifyMaterializedRuntime } from './vendored-runtime-lock.mjs'
import { COMPATIBILITY_FILE, loadHostCompatibility } from './vendor-compatibility.mjs'
import { checkPluginRegistration } from './plugin-registration.mjs'

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
if (manifest.desktopBuild !== undefined) assertDesktopBuildIdentity(join(dir, 'app'), manifest.desktopBuild)
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
const profileManifest = json(join(profile, 'package.json'))
// 出厂登记护栏（唯一真相源见 scripts/plugin-registration.mjs）：本插件必须登记为 file: 相对
// 路径指向包内 tarball。精确版本登记会让 install_bundle（= profile 里的 pnpm add 全量解析）
// 对未发布的本地包 404。除了字面量比对，还会按 path 语义解析一次（层级写错会红），并检查
// tarball 内容与出厂 node_modules 同源（残包会让用户第一次装旁路插件时把插件换成坏版本）。
const registration = checkPluginRegistration({ root: dir, pluginName: pkg.name, version: pkg.version, profileManifest })
for (const problem of registration.problems) assert(false, problem)
const bundles = profileManifest.dsh.profile.bundles
const vendor = json(join(ROOT, 'vendor/plugins/manifest.json')).plugins
for (const plugin of [{ name: pkg.name, version: pkg.version }, ...vendor]) {
  const installed = join(profile, 'node_modules', plugin.name)
  assert(json(join(installed, 'package.json')).version === plugin.version, `插件版本不一致：${plugin.name}`)
  assert(bundles.includes(plugin.name), `插件未登记：${plugin.name}`)
  assert(!existsSync(join(installed, 'lib', 'fake-llm')), `生产插件含 fake-llm：${plugin.name}`)
}
for (const plugin of vendor) {
  if (plugin.runtimeLock) verifyMaterializedRuntime(join(profile, 'node_modules', plugin.name), join(ROOT, 'vendor/plugins'), plugin.runtimeLock)
}
// 宿主的 bundle 准入：判不满足就把整层**静默跳过**（只进 skippedBundles），症状只是功能
// 消失、客户端加载图少一行 —— 2026-11-04 就是这么红的。这里先用宿主自己的读入器与判定
// 实现把话说清楚，免得又靠「首页少个名字」间接定位。豁免写在哪见 scripts/vendor-compatibility.mjs。
const hostApi = await loadHostCompatibility(join(dir, 'app'))
const compatibility = hostApi.readProfileCompatibility(profile)
assert(compatibility.warnings.length === 0,
  `出厂 profile 的 ${COMPATIBILITY_FILE} 有宿主不接受的记录：${compatibility.warnings.join('；')}`)
for (const name of [pkg.name, ...vendor.map(p => p.name)]) {
  const issue = hostApi.evaluatePluginCompatibility(json(join(profile, 'node_modules', name, 'package.json')), compatibility.exemptions, runtime.release.version)
  assert(issue === undefined || issue.exempted,
    `插件 ${name} 在 dsh ${runtime.release.version} 下不兼容，且出厂 profile 没有它的精确版本豁免：要求 ${JSON.stringify(issue?.requirements)}`)
}
console.log(`运行时 ${runtime.release.version}：${runtime.files.length} 个文件哈希匹配，${vendor.length + 1} 个插件与出厂 home 通过`)
// 使用新的临时 home；仅启动验收副本，不向解压出的出厂 home 写入用户数据。
const { cpSync, mkdirSync, mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const scratch = mkdtempSync(join(tmpdir(), 'webops-release-check-'))
const workProfile = join(scratch, 'home', 'profiles', 'desktop')
mkdirSync(workProfile, { recursive: true })
cpSync(profile, workProfile, { recursive: true })
// 自检不需要任何登录绕过：随包 Grok 插件是 dsh-coding-subscription-oauth，它**惰性**登录
// （只在用户点「登录」时才起设备码流程），宿主启动阶段不碰浏览器、不阻塞 ready。
// 上一代 dsh-llm-xai-oauth 会在无 token 时主动开视觉设备码登录，才需要 DSH_XAI_OAUTH_NO_LOGIN；
// 换插件后该开关不再适用，若残留会让人误以为还需要它。
const host = startPackagedDesktopHost({ runtimeDir, profileDir: workProfile, env: { ...process.env, DSH_HOME: join(scratch, 'home') } })
try {
  const ready = await host.ready
  const page = await fetchHostPath(ready.url, '/index.html', ready.authenticationCookie)
  assert(page.status === 200, `首页返回 ${page.status}`)
  const html = page.body.toString('utf8')
  assert(html.includes('__DSH_BOOT__'), '首页缺少客户端加载图')
  // 客户端加载图只列**有 client half 的插件**：`dsh.client` 声明 + `exports["./client"]`。
  // 纯后端插件没有客户端产物，本就不会出现在这张图里 —— 不能拿「首页少个名字」当它加载
  // 失败的证据。判据读插件实际 exports，而不是 manifest 里的 client 标记（那是文档性字段，
  // 填错也不影响物化）。后端是否加载由上面的 bundles 登记、版本一致性和兼容性判定覆盖。
  // 2026-11-19 起随包 Grok 插件是 dsh-coding-subscription-oauth，它**带** client half
  // （设置页「账户与模型」卡片），所以会出现在这张图里；上一代 dsh-llm-xai-oauth 没有。
  const clientNames = [pkg.name]
  for (const plugin of vendor) {
    const installedPkg = json(join(profile, 'node_modules', plugin.name, 'package.json'))
    if (installedPkg.dsh?.client !== undefined && installedPkg.exports?.['./client'] !== undefined) {
      clientNames.push(plugin.name)
    }
  }
  for (const name of clientNames) assert(html.includes(name), `客户端加载图缺少 ${name}`)
  // 只见客户端不能证明后端挂载；GET 必须进入侧边栏处理器的 JSON 方法校验。
  const sidebar = await fetchHostPath(ready.url, '/sidebar/api/fs.read', ready.authenticationCookie)
  let envelope
  try { envelope = JSON.parse(sidebar.body.toString('utf8')) } catch { /* 空 405 是本次回归症状。 */ }
  assert(sidebar.status === 405 && envelope?.ok === false && envelope?.error?.code === 'method-error',
    `侧边栏后端未正常挂载：HTTP ${sidebar.status}，缺少方法校验信封`)
  console.log(`verify-release-portable: 实际生产宿主首页、客户端加载图（${clientNames.length} 个含 client half 的插件；纯后端插件按 bundles/兼容性判定覆盖）与侧边栏后端路由通过；验收副本保留在 ${scratch}`)
} finally {
  await host.stop()
}
