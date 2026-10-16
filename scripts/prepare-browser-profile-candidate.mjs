/**
 * 从本机 alpha3 flat 桌面基包创建一个保留原包的 browser profile 候选壳。
 * 仅改 app.asar 内唯一的浏览器 userData 路径；所有阶段与输出写入调用者给定的 D 盘新目录。
 * 不删除、不覆盖基包、候选包或阶段证据。
 *
 * 用法：pnpm exec node scripts/prepare-browser-profile-candidate.mjs --app <基包目录> --stage-root <D:\\阶段目录> --out <D:\\候选壳目录>
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { extractAll, extractFile, createPackage } from '@electron/asar'
import { readRuntimeDescriptor } from './desktop-runtime.mjs'
import { replaceBrowserProfilePath } from './release-app-isolation.mjs'

const args = process.argv.slice(2)
const flags = ['--app', '--stage-root', '--out']
const sha = value => createHash('sha256').update(value).digest('hex')
function required(flag) {
  const index = args.indexOf(flag)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf(flag) !== index) throw Error(`缺少或重复 ${flag}`)
  const raw = args[index + 1]
  if (!isAbsolute(raw) || !/^D:[\\/]/iu.test(raw)) throw Error(`${flag} 必须是 D 盘绝对路径：${raw}`)
  return resolve(raw)
}

try {
  for (let i = 0; i < args.length; i += 2) if (!flags.includes(args[i])) throw Error(`未知参数：${args[i]}`)
  const app = required('--app'), stageRoot = required('--stage-root'), out = required('--out')
  if (existsSync(out)) throw Error(`候选输出已存在，拒绝覆盖：${out}`)
  const runtime = readRuntimeDescriptor(app)
  if (runtime.layout !== 'flat' || runtime.descriptor.release.version !== '0.2.1-alpha.3') {
    throw Error(`只接受当前本机 0.2.1-alpha.3 flat 基包；实际为 ${runtime.descriptor.release.version} (${runtime.layout})`)
  }

  const archivePath = join(app, 'resources', 'app.asar')
  const archive = readFileSync(archivePath)
  const original = extractFile(archivePath, 'lib/main.js').toString('utf8')
  const after = 'DSH_BROWSER_USER_DATA_DIR: join(data, "browser"),'
  const main = replaceBrowserProfilePath(original)

  mkdirSync(stageRoot, { recursive: true })
  const stage = mkdtempSync(join(stageRoot, 'browser-profile-app-'))
  const extracted = join(stage, 'asar-source')
  extractAll(archivePath, extracted)
  writeFileSync(join(extracted, 'lib', 'main.js'), main)
  const mainEvidence = join(stage, 'main.mjs')
  writeFileSync(mainEvidence, main, { flag: 'wx' })
  const syntax = spawnSync(process.execPath, ['--check', mainEvidence], { encoding: 'utf8' })
  if (syntax.status !== 0) throw Error(`桌面主进程语法检查失败：${syntax.stderr}`)

  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(out)
  cpSync(app, out, { recursive: true, filter: sourcePath => sourcePath !== archivePath })
  await createPackage(extracted, join(out, 'resources', 'app.asar'))

  const candidateArchive = readFileSync(join(out, 'resources', 'app.asar'))
  const receipt = {
    createdAt: new Date().toISOString(), app, out, stage,
    dshVersion: runtime.descriptor.release.version,
    baseArchiveSha256: sha(archive), candidateArchiveSha256: sha(candidateArchive),
    mainBeforeSha256: sha(original), mainAfterSha256: sha(main),
    changedAnchor: { before: 'DSH_BROWSER_USER_DATA_DIR: join(temporary, "dsh-browser-electron-host"),', after, matches: 1 },
    preservedHooks: {
      configurePortableData: original.split('configurePortableData').length - 1,
      dshHomeAssignment: original.split('DSH_HOME: home').length - 1,
      logsPath: original.includes('app.setAppLogsPath()'),
    },
  }
  writeFileSync(join(stage, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(receipt, null, 2))
} catch (error) {
  console.error(`prepare-browser-profile-candidate: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
