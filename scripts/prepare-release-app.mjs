/** 在唯一新目录升级固定桌面基包；保留基包、解包与编译证据。 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { extractAll, extractFile, createPackage } from '@electron/asar'
import { readRuntimeDescriptor } from './desktop-runtime.mjs'
import { overlayPortableMain, portableSource, portableWorkspaceModule } from './release-app-isolation.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const flags = ['--app', '--stage-root', '--out']
const sha = value => createHash('sha256').update(value).digest('hex')
function required(flag) {
  const index = args.indexOf(flag)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf(flag) !== index) throw Error(`缺少或重复 ${flag}`)
  return resolve(args[index + 1])
}
try {
  for (let i = 0; i < args.length; i += 2) if (!flags.includes(args[i])) throw Error(`未知参数：${args[i]}`)
  const app = required('--app'), stageRoot = required('--stage-root'), out = required('--out')
  if (existsSync(out)) throw Error(`输出已存在，拒绝覆盖：${out}`)
  const archivePath = join(app, 'resources', 'app.asar')
  const runtime = readRuntimeDescriptor(app)
  if (runtime.layout !== 'flat' || runtime.descriptor.release.version !== '0.2.1-alpha.2') throw Error('仅接受固定 0.2.1-alpha.2 flat 基包')
  const patch = readFileSync(join(root, 'docs', 'harness-desktop-build.patch'), 'utf8')
  const source = portableSource(patch)
  const original = extractFile(archivePath, 'lib/main.js').toString('utf8')
  const { main, compiled } = overlayPortableMain(original, source)
  const relative = 'node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/index.js'
  const modulePath = join(runtime.runtimeDir, relative)
  const oldModule = readFileSync(modulePath)
  const updatedModule = Buffer.from(portableWorkspaceModule(oldModule.toString('utf8'), patch))
  const descriptor = structuredClone(runtime.descriptor)
  const entry = descriptor.files.find(value => value.path === relative)
  if (!entry || entry.sha256 !== sha(oldModule) || entry.bytes !== oldModule.length) throw Error('默认工作区基包完整性不符')
  entry.sha256 = sha(updatedModule)
  entry.bytes = updatedModule.length
  mkdirSync(stageRoot, { recursive: true })
  const stage = mkdtempSync(join(stageRoot, 'release-app-'))
  const extracted = join(stage, 'asar-source')
  extractAll(archivePath, extracted)
  // 正常源码编辑；原归档和编译输入始终保留。
  writeFileSync(join(extracted, 'lib/main.js'), main)
  writeFileSync(join(stage, 'portable-data.ts'), source, { flag: 'wx' })
  writeFileSync(join(stage, 'portable-data.js'), compiled, { flag: 'wx' })
  const mainEvidence = join(stage, 'main.mjs')
  writeFileSync(mainEvidence, main, { flag: 'wx' })
  const syntax = spawnSync(process.execPath, ['--check', mainEvidence], { encoding: 'utf8' })
  if (syntax.status !== 0) throw Error(`桌面入口语法检查失败：${syntax.stderr}`)
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(out)
  const descriptorPath = join(runtime.runtimeDir, 'desktop-runtime.json')
  cpSync(app, out, { recursive: true, filter: path => ![archivePath, modulePath, descriptorPath, join(app, 'debug.log')].includes(path) })
  await createPackage(extracted, join(out, 'resources', 'app.asar'))
  writeFileSync(join(out, 'resources', 'dsh', relative), updatedModule, { flag: 'wx' })
  writeFileSync(join(out, 'resources', 'dsh', 'desktop-runtime.json'), JSON.stringify(descriptor, null, 2) + '\n', { flag: 'wx' })
  const receipt = { app, out, stage, dshVersion: descriptor.release.version, patchHash: sha(patch), sourceHash: sha(source),
    baseArchiveHash: sha(readFileSync(archivePath)), archiveHash: sha(readFileSync(join(out, 'resources', 'app.asar'))),
    mainHash: sha(main), workspaceBeforeHash: sha(oldModule), workspaceHash: sha(updatedModule), workspaceBytes: updatedModule.length }
  writeFileSync(join(stage, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
  console.log(JSON.stringify(receipt))
} catch (error) {
  console.error(`prepare-release-app: ${error.message}`)
  process.exitCode = 1
}
