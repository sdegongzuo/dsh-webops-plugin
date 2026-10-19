/** 绑定构建来源与实际 app 字节；打包时复核，防止同版本号的旧壳混入。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRuntimeDescriptor } from './desktop-runtime.mjs'

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')

export function createDesktopBuildIdentity(app, source) {
  if (!/^[a-f0-9]{40}$/.test(source.harnessCommit ?? '')) throw Error('桌面构建必须记录完整提交 SHA')
  if (!/^[a-f0-9]{64}$/.test(source.patchSha256 ?? '')) throw Error('桌面构建必须记录补丁 SHA256')
  const runtime = readRuntimeDescriptor(app)
  if (runtime.layout !== 'flat') throw Error('发布构建回执只接受 flat 运行时')
  const dshVersion = runtime.descriptor.release?.version
  if (typeof dshVersion !== 'string' || !dshVersion) throw Error('运行时缺少 DSH 版本')
  return {
    harnessCommit: source.harnessCommit, patchSha256: source.patchSha256, dshVersion,
    asarSha256: sha(join(app, 'resources', 'app.asar')),
    runtimeSha256: sha(join(runtime.runtimeDir, 'desktop-runtime.json')),
  }
}

export function verifyDesktopBuildIdentity(app, receipt) {
  const recorded = JSON.parse(readFileSync(receipt, 'utf8'))
  return assertDesktopBuildIdentity(app, recorded)
}

export function assertDesktopBuildIdentity(app, recorded) {
  const actual = createDesktopBuildIdentity(app, recorded)
  if (Object.keys(actual).some(key => recorded[key] !== actual[key])) throw Error('桌面构建回执与实际 app 不一致')
  return actual
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), allowed = ['--app', '--harness-commit', '--patch', '--out']
    if (args.length !== allowed.length * 2) throw Error('用法：node scripts/desktop-build-identity.mjs --app <app> --harness-commit <完整SHA> --patch <补丁> --out <新回执>')
    for (let index = 0; index < args.length; index += 2) if (!allowed.includes(args[index]) || args.indexOf(args[index]) !== index) throw Error(`未知或重复参数：${args[index]}`)
    const value = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw Error(`缺少 ${name}`); return args[index + 1] }
    const out = resolve(value('--out'))
    if (existsSync(out)) throw Error(`构建回执已存在，拒绝覆盖：${out}`)
    const identity = createDesktopBuildIdentity(resolve(value('--app')), { harnessCommit: value('--harness-commit'), patchSha256: sha(resolve(value('--patch'))) })
    writeFileSync(out, JSON.stringify(identity, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify(identity))
  } catch (error) { console.error(`desktop-build-identity: ${error.message}`); process.exitCode = 1 }
}
