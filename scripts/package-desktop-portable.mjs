/**
 * 把「桌面端应用目录 + 已物化的插件 profile」组装成 Windows x64 便携版 zip。
 *
 * 便携版 = 解压即用、配置随包走（`$DSH_HOME` 指向包内 `home\`）、插件**已经装好**的
 * dsh 桌面端。用户端不需要 pnpm / Node / 签名证书，也不需要联网装插件。
 *
 * 用法：
 *   node scripts/package-desktop-portable.mjs --app <win-unpacked 目录> [--version 0.1.0]
 *   node scripts/package-desktop-portable.mjs [--version 0.1.0]        # 复用缓存的 base
 *   node scripts/package-desktop-portable.mjs --app <dir> --cache-base # 构建后顺便缓存 base
 *
 * 产出：
 *   dist/dsh-webops-desktop-v<ver>-win-x64-portable.zip
 *
 * 两层拆分（避免每次发版都重编译 dsh）：
 *   第 1 层 base = dsh 桌面端本体（app/，~300MB，只在升级 dsh 时重建）；
 *   第 2 层 overlay = home/profiles/desktop/ 里的插件（几十 KB，每次发版都换）。
 *   `--cache-base` 把本次的 app/ 存到 `.desktop-base/app`，之后不带 `--app` 跑就直接复用，
 *   只重新生成 overlay 并重新压缩。
 *
 * 为什么 profile 是我们自己写而不是调桌面端去装：
 * 打包态桌面端装插件只能走 UI 插件管理器（IPC pluginsAdd → pnpm add），CLI 碰不到这个
 * profile，也没有任何官方入口能「预装」第三方插件。所以这里按官方
 * `project-manager.ts:604 createPluginProfile` 的模板手工物化一份，让桌面端启动时
 * 认为「这个插件本来就是装好的」（`applyRelease()` 状态自洽时不会重装，见
 * `project-manager.ts:306-322`）。
 *
 * **但光写 package.json 不够**：`applyRelease()` 在 `previous === undefined` 时会调
 * `createPluginProfile()` 把 package.json 重写成空插件列表 —— 登记的插件被静默冲掉。
 * 所以还必须写 `desktop-runtime-state.json`（见下面 2.5 节的详细理由）。
 * 这个坑 2026-09-14 才被发现：v0.1.0 和 v0.2.0 的包都因此启动后没有任何插件。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const STAGE = join(ROOT, '.desktop-stage')
/** 第 1 层 base 的本地缓存：dsh 本体不常变，缓存后插件发版无需重编译。 */
const BASE_CACHE = join(ROOT, '.desktop-base', 'app')

/** 官方常量，抄自 `apps/desktop/src/project-manager.ts`（改错任何一个桌面端直接抛错）。 */
const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

const cacheBase = args.includes('--cache-base')
let appDir = readArg('app')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = readArg('version') ?? pkg.version
const pluginName = pkg.name

if (appDir === undefined && existsSync(BASE_CACHE)) {
  appDir = BASE_CACHE
  console.log(`复用缓存的 dsh 本体: ${BASE_CACHE}`)
}
if (appDir === undefined || !existsSync(appDir)) {
  console.error('用法: node scripts/package-desktop-portable.mjs --app <win-unpacked 目录> [--version x.y.z]')
  console.error('      node scripts/package-desktop-portable.mjs [--version x.y.z]   # 复用 .desktop-base/app')
  process.exit(1)
}
if (cacheBase) {
  rmSync(BASE_CACHE, { recursive: true, force: true })
  mkdirSync(dirname(BASE_CACHE), { recursive: true })
  cpSync(appDir, BASE_CACHE, { recursive: true })
  console.log(`已缓存 dsh 本体到 ${BASE_CACHE}（下次发版可省略 --app）`)
}
if (!existsSync(join(ROOT, 'lib'))) {
  console.error('package-desktop-portable: 缺少 lib/，先跑 pnpm build')
  process.exit(1)
}

/** win-unpacked 里的主 exe（electron-builder 按 productName 命名）。 */
const exe = readdirSync(appDir).find(name => name.endsWith('.exe') && !/uninstall|elevate/i.test(name))
if (exe === undefined) {
  console.error(`package-desktop-portable: ${appDir} 里没找到主 exe`)
  process.exit(1)
}
console.log(`主程序: ${exe}`)

const zipName = `dsh-webops-desktop-v${version}-win-x64-portable.zip`
const zipPath = join(DIST, zipName)

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })
mkdirSync(STAGE, { recursive: true })
if (existsSync(zipPath)) rmSync(zipPath)

// 1) 应用本体
cpSync(appDir, join(STAGE, 'app'), { recursive: true })
console.log('  + app/')

// 2) profile：官方模板 + 本插件
//    dependencies 必须是**精确版本**（project-manager.ts:160-162 会校验），
//    bundles 必须以前两个内置 bundle 开头（project-manager.ts:169）。
const profileDir = join(STAGE, 'home', 'profiles', 'desktop')
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify(
    {
      name: PROJECT_NAME,
      private: true,
      version: '0.0.0',
      dependencies: { [pluginName]: version },
      dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES, pluginName] } },
    },
    null,
    2,
  )}\n`,
)
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), WORKSPACE_SETTINGS)
console.log('  + home/profiles/desktop/package.json')

// 2.5) 桌面端认可的 profile 状态文件。**少了它，上面登记的插件会被静默抹掉。**
//
// `DesktopProjectManager.applyRelease()`（project-manager.ts:306）的流程是：
//   previous = readDesktopProfileState(profile)          // 读 desktop-runtime-state.json
//   if (previous === undefined) createPluginProfile()    // ← 这里
// 而 `createPluginProfile()`（project-manager.ts:604）会把 package.json **整个重写**成
// `dependencies: {}` + `bundles: [dsh-base, dsh-web-app]` —— 我们刚写进去的
// `dsh-webops-plugin` 被冲掉，随后 `prepareProfile` 拿空的 activePlugins 去校验，
// 直接 `return`，**不报错、不提示**，启动后什么插件都没有。
//
// 所以必须让 previous !== undefined。三个字段的取值有硬约束：
//   · nodeVersion / platform / arch 必须与 app 内 runtime 完全一致 —— 不一致会让
//     `reconcileProfile` 判定 rebuild=true，**删掉整个 node_modules** 再跑
//     `pnpm install --frozen-lockfile`（我们的插件不在 registry，必挂）。
//   · runtimeId 是 `sha256(JSON.stringify(descriptor))`（runtime-tree.ts:220），
//     descriptor 由 `readDesktopRuntime`（runtime-tree.ts:150）按固定键序重建；
//     这里照抄那个键序算出同值，好让第二次启动能走 applyRelease 的快速返回分支。
//   · links 给空数组：真实 junction 的 target 是**用户机器上的绝对路径**，打包时
//     不可能知道；给空数组让 host 那步重新建链并回写正确值。代价只是首次启动多跑
//     一次 prepareProfile（幂等）。
//   · lockHash 必须等于 `desktopPluginLockHash()` 在「没有 pnpm-lock.yaml」时的值，
//     即空串的 sha256。
const descriptorPath = join(appDir, 'resources', 'dsh', 'desktop-runtime.json')
if (!existsSync(descriptorPath)) {
  console.error(`package-desktop-portable: 缺 ${descriptorPath}（app 目录不完整？）`)
  process.exit(1)
}
const runtime = JSON.parse(readFileSync(descriptorPath, 'utf8'))
const descriptor = {
  schemaVersion: runtime.schemaVersion,
  release: runtime.release,
  platform: runtime.platform,
  arch: runtime.arch,
  sharedPackages: runtime.sharedPackages,
  files: runtime.files,
}
writeFileSync(
  join(profileDir, 'desktop-runtime-state.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    runtimeId: createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
    version: runtime.release.version,
    nodeVersion: runtime.release.nodeVersion,
    platform: runtime.platform,
    arch: runtime.arch,
    lockHash: createHash('sha256').update('').digest('hex'),
    links: [],
  }, undefined, 2)}\n`,
)
console.log(`  + home/profiles/desktop/desktop-runtime-state.json (node ${runtime.release.nodeVersion}, ${runtime.platform}/${runtime.arch})`)

// 3) 插件真身。必须是**真实文件**：validateDesktopPluginGraph 见 symlink 就拒。
//    发布版 package.json 剔除 devDependencies 里指向本机 harness 的 link:。
const pluginDir = join(profileDir, 'node_modules', pluginName)
mkdirSync(pluginDir, { recursive: true })
cpSync(join(ROOT, 'lib'), join(pluginDir, 'lib'), { recursive: true })
cpSync(join(ROOT, 'cordis.patch.yml'), join(pluginDir, 'cordis.patch.yml'))
const releasePkg = { ...pkg, version }
delete releasePkg.devDependencies
delete releasePkg.scripts
writeFileSync(join(pluginDir, 'package.json'), `${JSON.stringify(releasePkg, null, 2)}\n`)
console.log(`  + home/profiles/desktop/node_modules/${pluginName}/`)

// 4) 启动器：把 DSH_HOME 指到包内，配置就随包走
//    （apps/desktop/src/paths.ts:26 默认参数 resolveDshHome() 读 $DSH_HOME）
writeFileSync(
  join(STAGE, '启动.cmd'),
  [
    '@echo off',
    'setlocal',
    'set "ROOT=%~dp0"',
    'set "DSH_HOME=%ROOT%home"',
    'if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"',
    `start "" "%ROOT%app\\${exe}"`,
    '',
  ].join('\r\n'),
)
console.log('  + 启动.cmd')

// 5) 说明
writeFileSync(
  join(STAGE, '使用说明.txt'),
  [
    `dsh 桌面端便携版 v${version}（Windows x64，已内置 ${pluginName} 插件）`,
    '',
    '【运行】',
    '  双击「启动.cmd」。不要直接点 app 目录里的 exe —— 那样 $DSH_HOME 会落回用户目录，',
    '  配置就不再随包走，插件也不在生效的 profile 里。',
    '',
    '【数据在哪】',
    '  home\\  = dsh 的全部用户数据（会话、设置、凭据、已装插件）。',
    '  整个目录拷到 U 盘就能带走；删掉 home\\ 即恢复出厂。',
    '',
    '【插件】',
    `  ${pluginName} 已经预装在 home\\profiles\\desktop\\node_modules\\ 下，`,
    '  并在该 profile 的 dsh.profile.bundles 里登记过，开箱即用。',
    '',
    '【验证插件生效】',
    '  1) 先「选择工作区」，然后新建一个会话。',
    '     状态条挂在**会话面**的输入框上方；停在工作区选择页时它不会出现 ——',
    '     那时插件其实已经加载好了（客户端半边已注册），只是那一面还没挂载。',
    '  2) 会话打开后，输入框上方应能看到「网页操作」状态条；没有浏览器调用时',
    '     它显示「已就绪」，并提示 agent 可以打开、观察与操作网页。',
    '',
    '【浏览器工具的前提】',
    '  要真的打开网页，需要一个**外接的真 Chrome**，dsh 通过调试端口驱动它：',
    '',
    '      chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\\dsh-chrome"',
    '',
    '  这个 Chrome 先起来，再让 agent 调 browser_open。默认连 127.0.0.1:9222；',
    '  换端口就设环境变量 DSH_BROWSER_CDP_ENDPOINT（优先级高于插件配置）。',
    '  不要用桌面端自带的嵌入式 Chromium 当目标：它不实现 PUT /json/new，',
    '  连上去只会得到「Could not create new page」。',
    '',
    '【注意】',
    '  这是未签名构建：SmartScreen 会拦第一次运行，点「更多信息」→「仍要运行」。',
    '  路径不要含中文，也不要放在需要管理员权限的目录。',
    '',
  ].join('\r\n'),
  { encoding: 'utf8' },
)

// 6) 打包
//
// 压缩级别用 Fastest：app/ 里绝大多数是已经压过的二进制（Electron 运行时、asar、
// .node、图片），Optimal 换来的体积收益是个位数 MB，代价却是几分钟的 CPU ——
// 实测这一整步（物化 profile + 打 zip）在 CI 上要 294s，压缩占了绝大部分。
// 产物仍是标准 zip（Compress-Archive 只换 deflate 级别），不影响用户侧解压。
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${join(STAGE, '*')}' -DestinationPath '${zipPath}' -CompressionLevel Fastest -Force`,
  ],
  { stdio: 'pipe' },
)

rmSync(STAGE, { recursive: true, force: true })

const bytes = readFileSync(zipPath)
console.log(`\n${zipName}  (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`)
console.log(`sha256: ${createHash('sha256').update(bytes).digest('hex')}`)
console.log(zipPath)
