/**
 * 把「桌面端应用目录 + 已物化的插件 profile」组装成 Windows x64 便携版 zip。
 *
 * 便携版 = 解压即用、配置随包走（`$DSH_HOME` 指向包内 `home\`）、插件**已经装好**的
 * dsh 桌面端。用户端不需要 pnpm / Node / 签名证书，也不需要联网装插件。
 *
 * 用法：
 *   node scripts/package-desktop-portable.mjs --app <win-unpacked 目录> [--version 0.1.0]
 *
 * 产出：
 *   dist/dsh-webops-desktop-v<ver>-win-x64-portable.zip
 *
 * 为什么 profile 是我们自己写而不是调桌面端去装：
 * 打包态桌面端装插件只能走 UI 插件管理器（IPC pluginsAdd → pnpm add），CLI 碰不到这个
 * profile，也没有任何官方入口能「预装」第三方插件。所以这里按官方
 * `project-manager.ts:604 createPluginProfile` 的模板手工物化一份，让桌面端启动时
 * 认为「这个插件本来就是装好的」（`applyRelease()` 状态自洽时不会重装，见
 * `project-manager.ts:306-322`）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const STAGE = join(ROOT, '.desktop-stage')

/** 官方常量，抄自 `apps/desktop/src/project-manager.ts`（改错任何一个桌面端直接抛错）。 */
const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

/** @type {string | undefined} */
const appDir = readArg('app')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = readArg('version') ?? pkg.version
const pluginName = pkg.name

if (appDir === undefined) {
  console.error('用法: node scripts/package-desktop-portable.mjs --app <win-unpacked 目录> [--version x.y.z]')
  process.exit(1)
}
if (!existsSync(appDir)) {
  console.error(`package-desktop-portable: 应用目录不存在: ${appDir}`)
  process.exit(1)
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
    '  启动后在输入框上方应能看到「网页操作」状态条；让 agent 调用 browser_open 能开页面。',
    '',
    '【注意】',
    '  这是未签名构建：SmartScreen 会拦第一次运行，点「更多信息」→「仍要运行」。',
    '  路径不要含中文，也不要放在需要管理员权限的目录。',
    '',
  ].join('\r\n'),
  { encoding: 'utf8' },
)

// 6) 打包（与 package-portable.mjs 一致，走 Compress-Archive）
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${join(STAGE, '*')}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
  ],
  { stdio: 'pipe' },
)

rmSync(STAGE, { recursive: true, force: true })

const bytes = readFileSync(zipPath)
console.log(`\n${zipName}  (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`)
console.log(`sha256: ${createHash('sha256').update(bytes).digest('hex')}`)
console.log(zipPath)
