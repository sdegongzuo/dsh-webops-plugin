/** 将本轮重编的 DSH 库与桌面入口装入全新测试 app；不清理旧包或复制用户数据。 */
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { createPackageWithOptions, extractAll, extractFile } from '@electron/asar'
import { harnessRoot } from './local-env.mjs'
import { readRuntimeDescriptor } from './desktop-runtime.mjs'

const args = process.argv.slice(2)
function required(name) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw Error(`缺少 ${name}`)
  return resolve(args[index + 1])
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const posix = path => path.split(sep).join('/')
function files(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name)
    if (entry.isSymbolicLink()) throw Error(`拒绝链接产物：${join(root, path)}`)
    return entry.isDirectory() ? files(root, path) : [posix(path)]
  })
}

try {
  const base = required('--base-app'), desktop = required('--desktop-lib'), out = required('--out')
  const harness = harnessRoot()
  if (existsSync(out)) throw Error(`输出已存在：${out}`)
  const stage = `${out}-asar-source`
  if (existsSync(stage)) throw Error(`解包目录已存在：${stage}`)
  const runtime = readRuntimeDescriptor(base)
  if (runtime.layout !== 'flat') throw Error('测试装配仅支持 flat 运行时')
  const version = JSON.parse(readFileSync(join(harness, 'package.json'), 'utf8')).version
  if (version !== runtime.descriptor.release.version) throw Error('源码与基包版本不同，必须重建依赖闭包')
  for (const entry of runtime.descriptor.files) {
    const bytes = readFileSync(join(runtime.runtimeDir, entry.path))
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw Error(`基包完整性失败：${entry.path}`)
  }
  const archive = join(base, 'resources', 'app.asar')
  extractAll(archive, stage)
  const desktopFiles = files(desktop)
  if (!desktopFiles.includes('main.js') || !desktopFiles.includes('welcome/welcome.js')) throw Error('桌面编译产物不完整')
  cpSync(desktop, join(stage, 'lib'), { recursive: true })
  mkdirSync(out, { recursive: true })
  cpSync(base, out, {
    recursive: true,
    filter: path => ![archive, `${archive}.unpacked`, join(base, 'debug.log')].includes(path),
  })
  await createPackageWithOptions(stage, join(out, 'resources', 'app.asar'), { unpack: '**/*.{node,dll,exe}' })
  if (!extractFile(join(out, 'resources', 'app.asar'), 'lib/main.js').equals(readFileSync(join(desktop, 'main.js')))) {
    throw Error('新归档桌面入口与编译结果不一致')
  }

  const runtimeOut = join(out, 'resources', 'dsh')
  const replacements = []
  const packageFiles = globSync(['vendor/*/package.json', 'packages/*/*/package.json', 'apps/desktop-host/package.json', 'apps/cli/package.json'], { cwd: harness })
  // 根 dsh 包与 workspace 包都从本轮 lib 构建消费；不改变生产依赖清单。
  for (const packageFile of ['package.json', ...packageFiles]) {
    const sourceManifest = join(harness, packageFile)
    const pkg = JSON.parse(readFileSync(sourceManifest, 'utf8'))
    const target = join(runtimeOut, 'node_modules', pkg.name)
    if (!existsSync(join(target, 'package.json'))) continue
    const installed = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    if (pkg.version !== installed.version) throw Error(`运行库版本不匹配：${pkg.name}`)
    const sourceLib = join(sourceManifest, '..', 'lib')
    if (!existsSync(sourceLib)) throw Error(`缺少重编运行库：${pkg.name}`)
    cpSync(sourceLib, join(target, 'lib'), {
      recursive: true,
      filter: path => {
        const suffix = posix(relative(sourceLib, path))
        return suffix !== 'types' && !suffix.startsWith('types/')
      },
    })
    replacements.push(pkg.name)
  }
  const descriptor = structuredClone(runtime.descriptor)
  descriptor.files = files(runtimeOut).filter(path => path !== 'desktop-runtime.json').sort().map(path => {
    const bytes = readFileSync(join(runtimeOut, path))
    return { path, bytes: bytes.length, sha256: sha(bytes) }
  })
  writeFileSync(join(runtimeOut, 'desktop-runtime.json'), JSON.stringify(descriptor, null, 2) + '\n')
  const receipt = {
    at: new Date().toISOString(), base, out, stage, harness, version,
    desktopFiles: desktopFiles.map(path => ({ path, sha256: sha(readFileSync(join(desktop, path))) })),
    baseArchiveSha256: sha(readFileSync(archive)),
    archiveSha256: sha(readFileSync(join(out, 'resources', 'app.asar'))),
    replacements, runtimeFiles: descriptor.files.length,
    limits: '本机重编测试 app，复用基包 Electron 与第三方依赖；尚未进行 GUI 和真实模型验收，不是正式发布包。',
  }
  writeFileSync(`${out}-receipt.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  console.log(`本机重编测试 app 已装配：${out}；更新 ${replacements.length} 个 DSH 运行库；${descriptor.files.length} 个清单文件`)
} catch (error) {
  console.error(`assemble-rebuilt-test-app: ${error.message}`)
  process.exitCode = 1
}
