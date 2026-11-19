/** 每次插件发布组装完整便携包；只写唯一新目录，保留所有输入和暂存。 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRuntimeDescriptor } from './desktop-runtime.mjs'
import { pluginFileSpec, pluginTarballName } from './plugin-registration.mjs'
import { planSlimAppCopy } from './slim-portable-app.mjs'
import { verifyDesktopBuildIdentity } from './desktop-build-identity.mjs'
import { writeProfileExemptions } from './vendor-compatibility.mjs'
import { appendFactoryDefaultModel, formatFactoryDefaultModel } from './factory-default-model.mjs'
import { writeFactoryProxy } from './factory-proxy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 出厂默认开启的实验性 bundle（2026-10-18 主上定的清单，与 package-desktop-portable.mjs
// 的 FACTORY_EXPERIMENTAL_BUNDLES 保持一致；形状与 UI 开关 setBundleEnabled 落盘的一致
// —— 只追加进 dsh.profile.bundles，不写 dependencies，包体由随包运行时 resources/dsh 供给）。
const FACTORY_EXPERIMENTAL_BUNDLES = [
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
]
const args = process.argv.slice(2)
const allowed = ['--app', '--plugin-zip', '--plugin-tgz', '--version', '--stage-root', '--out', '--desktop-build-receipt']
function required(flag) {
  const index = args.indexOf(flag)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw Error(`缺少 ${flag} 的值`)
  if (args.lastIndexOf(flag) !== index) throw Error(`参数重复：${flag}`)
  return args[index + 1]
}
function run(program, argv) {
  const result = spawnSync(program, argv, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${program} 执行失败，exit=${result.status}`)
}
try {
  for (let i = 0; i < args.length; i += 2) if (!allowed.includes(args[i])) throw Error(`未知参数：${args[i]}`)
  const app = resolve(required('--app'))
  const pluginZip = resolve(required('--plugin-zip'))
  const pluginTgz = resolve(required('--plugin-tgz'))
  const version = required('--version')
  const stageRoot = resolve(required('--stage-root'))
  const out = resolve(required('--out'))
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (version !== pkg.version) throw Error(`发布版本 ${version} 与 package.json ${pkg.version} 不一致`)
  if (existsSync(out)) throw Error(`输出已存在，拒绝覆盖：${out}`)
  if (!existsSync(pluginZip)) throw Error(`插件 ZIP 不存在：${pluginZip}`)
  if (!existsSync(pluginTgz)) throw Error(`插件 tarball 不存在：${pluginTgz}（先跑 scripts/package-plugin-tarball.mjs）`)
  const tarballName = pluginTarballName(pkg.name, version)
  if (basename(pluginTgz) !== tarballName) throw Error(`插件 tarball 文件名必须是 ${tarballName}：${pluginTgz}`)
  const runtime = readRuntimeDescriptor(app).descriptor
  const receiptIndex = args.indexOf('--desktop-build-receipt')
  const receipt = receiptIndex < 0 ? undefined : resolve(required('--desktop-build-receipt'))
  const desktopBuild = receipt === undefined ? undefined : verifyDesktopBuildIdentity(app, receipt)
  const exe = readdirSync(app).find(name => name.endsWith('.exe') && !/uninstall|elevate/i.test(name))
  if (!exe) throw Error('应用目录缺少主 exe')
  mkdirSync(stageRoot, { recursive: true })
  const stage = mkdtempSync(join(stageRoot, 'release-portable-'))
  const profile = join(stage, 'home', 'profiles', 'desktop')
  const plugin = join(profile, 'node_modules', pkg.name)
  mkdirSync(plugin, { recursive: true })
  run('python', [join(ROOT, 'scripts/unzip-portable.py'), '--zip', pluginZip, '--dir', plugin])
  const installed = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'))
  if (installed.name !== pkg.name || installed.version !== version) throw Error('插件 ZIP 身份或版本与本次发布不一致')
  if (existsSync(join(plugin, 'lib', 'fake-llm')) || installed.exports?.['./fake-llm']) throw Error('生产插件含 fake-llm')
  const harnessPeers = ['@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools']
  if (!runtime.release?.version || harnessPeers.some(name => installed.peerDependencies?.[name] !== `^${runtime.release.version}`)) {
    throw Error(`DSH ${runtime.release.version} 不在插件声明的 peerDependencies 中`)
  }
  // 复制之前过滤运行时日志，不复制后删除；不读取任何用户 home。
  const copyPlan = planSlimAppCopy(app)
  cpSync(app, join(stage, 'app'), { recursive: true, filter: path => path !== join(app, 'debug.log') && copyPlan.filter(path) })
  if (receipt !== undefined) verifyDesktopBuildIdentity(join(stage, 'app'), receipt)
  console.log(`只读核验后复制：排除${copyPlan.excluded.length}项、${copyPlan.skippedBytes}字节；输入和暂存均不执行删除`)
  const vendor = JSON.parse(readFileSync(join(ROOT, 'vendor/plugins/manifest.json'), 'utf8'))
  // 本插件的出厂登记 = file: 相对路径指向包内不可变 tarball，不写精确版本。
  // 理由（2026-11-19 实测）：本插件是本地包、从未发布到 registry；宿主 install_bundle 就是
  // profile 里的 `pnpm add <spec>`，会全量解析 dependencies —— 精确版本登记会让任何一次
  // install_bundle 对 registry 404。file: 相对路径（相对 profile 目录）让解析永远有本地
  // 事实来源，且整个便携目录搬走后仍有效。 vendored 第三方插件都在 npm 上，保持精确版本。
  const pluginSpec = pluginFileSpec(pkg.name, version)
  mkdirSync(join(stage, 'vendor'), { recursive: true })
  cpSync(pluginTgz, join(stage, 'vendor', tarballName))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: '0.0.0',
    dependencies: { [pkg.name]: pluginSpec, ...Object.fromEntries(vendor.plugins.map(p => [p.name, p.version])) },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pkg.name, ...vendor.plugins.map(p => p.name), ...FACTORY_EXPERIMENTAL_BUNDLES] } },
  }, null, 2) + '\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n')
  cpSync(join(ROOT, 'scripts/portable-profile-patch.yaml'), join(profile, 'cordis.patch.yml'))
  const factoryDefault = appendFactoryDefaultModel(join(profile, 'cordis.patch.yml'))
  run(process.execPath, [join(ROOT, 'scripts/materialize-vendored-plugins.mjs'), '--profile-dir', profile])
  // 物化之后才能读到真实 manifest：厂商插件若把 peer 钉成精确版（workbuddy-connect 钉
  // 0.2.1-rc.2 就是），宿主会把它当不兼容**静默跳过**，功能整块消失。豁免写进出厂 profile。
  await writeProfileExemptions({
    appDir: join(stage, 'app'),
    profileDir: profile,
    runtimeVersion: runtime.release.version,
    names: [pkg.name, ...vendor.plugins.map(p => p.name)],
  })
  writeFileSync(join(stage, '启动.cmd'), [
    '@echo off',
    'setlocal',
    'set "PATH=%SystemRoot%\\System32;%PATH%"',
    'set "DSH_HOME=%~dp0home"',
    'rem Node ignores the Windows system proxy; pass the WinINET proxy to dsh.',
    'rem Only a simple host:port value is used; per-protocol values are left alone.',
    'set "PROXY_ENABLE="',
    'set "PROXY_SERVER="',
    'for /f "tokens=3" %%A in (\'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable 2^>nul ^| findstr /i "ProxyEnable"\') do set "PROXY_ENABLE=%%A"',
    'if "%PROXY_ENABLE%"=="0x1" for /f "tokens=3" %%A in (\'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer 2^>nul ^| findstr /i "ProxyServer"\') do set "PROXY_SERVER=%%A"',
    'echo %PROXY_SERVER%| findstr "=" >nul && set "PROXY_SERVER="',
    'if defined PROXY_SERVER set "HTTPS_PROXY=http://%PROXY_SERVER%"',
    'if defined PROXY_SERVER set "HTTP_PROXY=http://%PROXY_SERVER%"',
    'rem Optional override: put one proxy URL on the first line of proxy.txt.',
    'if exist "%~dp0proxy.txt" for /f "usebackq delims=" %%P in ("%~dp0proxy.txt") do (set "HTTPS_PROXY=%%P" & set "HTTP_PROXY=%%P")',
    'if defined HTTPS_PROXY echo [dsh] proxy: %HTTPS_PROXY%  (edit proxy.txt at package root to change/remove)',
    'rem Grok subscription plugin: upstream cli-chat-proxy rejects CLI builds below 1.0.13',
    'rem (the plugin hardcodes 0.1.220). Its own escape hatch overrides that constant.',
    'set "GROK_BUILD_CLIENT_VERSION=1.0.13"',
    `start "" "%~dp0app\\${exe}" %*`,
    '',
  ].join('\r\n'))
  const factoryProxy = writeFactoryProxy(stage)
  writeFileSync(join(stage, '使用说明.txt'), [
    `插件发布版本：${version}；DSH 本体：${runtime.release.version}；Windows x64 完整便携包。`,
    factoryDefault === undefined
      ? '解压到较短路径，双击启动.cmd。出厂不预置默认模型：请在设置→模型选择或添加自己的提供商；包内不含凭据或用户会话。'
      : `解压到较短路径，双击启动.cmd。本构建默认 ${formatFactoryDefaultModel(factoryDefault)}：首次启动复用本机登录态，没有则按插件引导完成设备码登录（约 10 分钟内完成，不要关掉引导页 —— 期间宿主可能长时间未就绪）；包内不含凭据或用户会话。`,
    factoryProxy === undefined
      ? '启动脚本会自动读取 Windows 系统代理；也可在包根 proxy.txt 第一行写完整代理地址覆盖。'
      : `本包已预置代理 ${factoryProxy}；端口不同请改包根 proxy.txt 第一行。`,
    ...(factoryDefault === undefined
      ? ['直接双击 app 下的 exe 不会带代理；需要出网的功能会失败，请优先用启动.cmd。']
      : ['直接双击 app 下的 exe 不会带代理；本包默认模型依赖代理出网，会导致模型请求失败，请用启动.cmd。']),
    '已有用户请先备份原 home 与 data。不要用出厂 home 覆盖自己的会话、设置和凭据。',
    `插件以 file: 相对路径登记到包内 vendor\\${tarballName}（不可变 tarball，供插件管理器解析）；升级请用同版新 tgz，见安装说明。`,
    '只换插件要求插件 peer 仍匹配当前宿主版本（插件的 package.json 会写明）；DSH 本体升级时请用整包。',
    '完整安装与数据迁移说明：https://github.com/sdegongzuo/dsh-webops-plugin/blob/main/docs/portable-install.md',
  ].join('\r\n'))
  writeFileSync(join(stage, 'release-manifest.json'), JSON.stringify({ pluginVersion: version, dshVersion: runtime.release.version,
    ...factoryDefault === undefined ? {} : { factoryDefault },
    ...factoryProxy === undefined ? {} : { factoryProxy },
    ...desktopBuild !== undefined ? { desktopBuild } : {},
  }, null, 2) + '\n')
  mkdirSync(dirname(out), { recursive: true })
  // 与 package-desktop-portable 同级别：deflate level 6（Compress-Archive 的 Optimal），
  // 两条打包路径产出的同版本包压缩率一致；level 1=Fastest 已废弃（2026-10-16，alpha.3 实测省 ~60MB）。
  run('python', [join(ROOT, 'scripts/zip-stage.py'), '--stage', stage, '--out', out, '--level', '6', '--no-overwrite'])
  console.log(JSON.stringify({ out, stage, pluginVersion: version, dshVersion: runtime.release.version }))
} catch (error) {
  console.error(`package-release-portable: ${error.message}`)
  process.exitCode = 1
}
