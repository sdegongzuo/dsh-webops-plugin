/** 每次插件发布组装完整便携包；只写唯一新目录，保留所有输入和暂存。 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRuntimeDescriptor } from './desktop-runtime.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const allowed = ['--app', '--plugin-zip', '--version', '--stage-root', '--out']
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
  const version = required('--version')
  const stageRoot = resolve(required('--stage-root'))
  const out = resolve(required('--out'))
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (version !== pkg.version) throw Error(`发布版本 ${version} 与 package.json ${pkg.version} 不一致`)
  if (existsSync(out)) throw Error(`输出已存在，拒绝覆盖：${out}`)
  if (!existsSync(pluginZip)) throw Error(`插件 ZIP 不存在：${pluginZip}`)
  const runtime = readRuntimeDescriptor(app).descriptor
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
  cpSync(app, join(stage, 'app'), { recursive: true, filter: path => path !== join(app, 'debug.log') })
  const vendor = JSON.parse(readFileSync(join(ROOT, 'vendor/plugins/manifest.json'), 'utf8'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: '0.0.0',
    dependencies: { [pkg.name]: version, ...Object.fromEntries(vendor.plugins.map(p => [p.name, p.version])) },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pkg.name, ...vendor.plugins.map(p => p.name)] } },
  }, null, 2) + '\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n')
  cpSync(join(ROOT, 'scripts/portable-profile-patch.yaml'), join(profile, 'cordis.patch.yml'))
  run(process.execPath, [join(ROOT, 'scripts/materialize-vendored-plugins.mjs'), '--profile-dir', profile])
  writeFileSync(join(stage, '启动.cmd'), ['@echo off', 'set "DSH_HOME=%~dp0home"', `start "" "%~dp0app\\${exe}"`, ''].join('\r\n'))
  writeFileSync(join(stage, '使用说明.txt'), [
    `插件发布版本：${version}；DSH 本体：${runtime.release.version}；Windows x64 完整便携包。`,
    '解压到较短路径，双击启动.cmd。首次使用在设置→模型填写 API Key；包内不含凭据或用户会话。',
    '已有用户请先备份原 home。不要用出厂 home 覆盖自己的会话、设置和凭据。',
    '只更新插件时，完全退出后使用同一 Release 的独立插件 ZIP 覆盖实际插件目录，再重启。',
    '完整安装与数据迁移说明：https://github.com/sdegongzuo/dsh-webops-plugin/blob/main/docs/portable-install.md',
  ].join('\r\n'))
  writeFileSync(join(stage, 'release-manifest.json'), JSON.stringify({ pluginVersion: version, dshVersion: runtime.release.version }, null, 2) + '\n')
  mkdirSync(dirname(out), { recursive: true })
  run('python', [join(ROOT, 'scripts/zip-stage.py'), '--stage', stage, '--out', out, '--level', '1', '--no-overwrite'])
  console.log(JSON.stringify({ out, stage, pluginVersion: version, dshVersion: runtime.release.version }))
} catch (error) {
  console.error(`package-release-portable: ${error.message}`)
  process.exitCode = 1
}
