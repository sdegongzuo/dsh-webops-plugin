#!/usr/bin/env node
/**
 * 本地多实例测试调度器 —— [本地多实例测试方案](../docs/本地多实例测试方案.md) 阶段 A/B 的入口。
 *
 * 核心约定（方案原文，别绕）：
 *   - 构建一次、固定产物、多个独立实例消费；实例目录已有同名直接拒绝；
 *   - 完成标记绑定 manifest 摘要，缺文件/多文件/内容变化均拒绝消费；
 *   - 宿主 `--port 0` 动态绑定，端点按「exe 的 desktop-host 子进程 → netstat → 探活」发现，
 *     并用命令行里的实例路径核验归属；固定 19387 自检不在此列，另行串行；
 *   - 凭据按实例注入，禁止进入产物/manifest/日志/证据；
 *   - 全程只创建不删除（AGENTS.md 删除红线）：失败目录保留，重跑换新 id。
 *
 * 用法（占位路径以 `env` 子命令输出为准）：
 *   node scripts/local-multi-instance.mjs env
 *   node scripts/local-multi-instance.mjs artifact --id <id> [--source <整包zip|解压根>] [--lib-dir <已构建目录>] [--note <文本>]
 *   node scripts/local-multi-instance.mjs assemble --artifact <id> --instance <id> [--credentials <home/.credentials.yaml>]
 *   node scripts/local-multi-instance.mjs launch  --instance <id> [--cdp 9333]
 *   node scripts/local-multi-instance.mjs endpoint --instance <id>
 *   node scripts/local-multi-instance.mjs chat    --instance <id> --msg "…" [--new] [--conv "会话名"] [--read]
 *   node scripts/local-multi-instance.mjs status  [--instance <id>]
 *   node scripts/local-multi-instance.mjs stop    --instance <id>
 *   node scripts/local-multi-instance.mjs list
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRoot, describeLocalEnv } from './local-env.mjs'
import {
  ARTIFACT_MANIFEST, INSTANCE_MANIFEST,
  artifactDir, artifactsRoot, assembleInstance, buildArtifactManifest,
  discoverInstanceEndpoints, evidenceRoot, findInstanceProcesses, findPortListener,
  gitState, hashTree, injectCredentials, instanceDir, instancesRoot,
  listProcesses,   materializeSource, productionPackageJson, readManifest,
  sha256Bytes, sha256File, stageRoot, treeDigest, verifyInstanceForLaunch,
  writeCompletion,
} from './local-multi-instance-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const DIST = join(ROOT, 'dist')

const args = process.argv.slice(2)
const command = args[0]
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const has = (name) => args.includes(`--${name}`)
const fail = (message) => { console.error(`local-multi-instance: ${message}`); process.exit(1) }

const stamp = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}
const humanBytes = (bytes) => bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
  : `${(bytes / 1024 ** 2).toFixed(1)} MB`
/** cpSync 的 filter 收到的是平台分隔符路径；判据一律用 POSIX 风格（Windows 上 relative 给反斜杠）。 */
const toPosix = (value) => value.replaceAll('\\', '/')

/* ---------------------------------------------------------------- env / list / status */

function showEnv() {
  describeLocalEnv()
  const root = buildRoot()
  console.log(`\n多实例布局（${join(root, 'local-tests')}）：`)
  console.log(`  artifacts/  固定产物（manifest + 完成标记；消费前重新核验）`)
  console.log(`  instances/  实例目录（app + home + 安装的插件；完成标记才许启动）`)
  console.log(`  evidence/   运行证据（启动身份、端点回执、截图与测试结果）`)
  console.log(`  .stage/     装配暂存（解压/构建中间态，保留作证据）`)
}

function newestFullZip() {
  if (!existsSync(DIST)) return undefined
  const candidates = readdirSync(DIST)
    .filter((name) => name.startsWith('dsh-webops-desktop-') && name.endsWith('-win-x64-portable.zip'))
    .map((name) => ({ name, path: join(DIST, name), mtime: statSync(join(DIST, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return candidates[0]
}

function listAll() {
  const root = buildRoot()
  console.log(`布局根：${join(root, 'local-tests')}\n`)
  for (const [label, dir] of [['产物', artifactsRoot(root)], ['实例', instancesRoot(root)]]) {
    if (!existsSync(dir)) { console.log(`${label}：（目录还没有）`); continue }
    const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    console.log(`${label} ${entries.length} 个：`)
    for (const name of entries) {
      const manifest = readManifest(join(dir, name), label === '产物' ? ARTIFACT_MANIFEST : INSTANCE_MANIFEST)
      const done = existsSync(join(dir, name, '.mi-complete'))
      const extra = label === '产物'
        ? `  插件 ${manifest?.inputs?.repo?.pluginVersion ?? '?'}  来源 ${manifest?.inputs?.source?.kind ?? '?'}`
        : `  产物 ${manifest?.artifactId ?? '?'}  插件 ${manifest?.plugin?.version ?? '?'}`
      console.log(`  ${done ? '✓' : '✗ 未完成'} ${name}${extra}`)
    }
    console.log('')
  }
}

function status() {
  const root = buildRoot()
  const only = readArg('instance')
  const dirs = only === undefined
    ? (existsSync(instancesRoot(root))
      ? readdirSync(instancesRoot(root), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(instancesRoot(root), entry.name))
      : [])
    : [instanceDir(root, only)]
  for (const dir of dirs) {
    const instance = readManifest(dir, INSTANCE_MANIFEST)
    console.log(`实例 ${instance?.instanceId ?? dir}`)
    if (instance === undefined) { console.log('  ✗ 没有实例清单（未完成装配？）\n'); continue }
    console.log(`  完成标记     ${existsSync(join(dir, '.mi-complete')) ? '✓' : '✗'}`)
    console.log(`  产物         ${instance.artifactId}（app ${String(instance.app.files)} 文件 / ${humanBytes(instance.app.bytes)}）`)
    console.log(`  插件         ${instance.plugin.version}（digest ${instance.plugin.digest.slice(0, 12)}…）`)
    const processes = findInstanceProcesses(instance.app.exe)
    if (processes.main === undefined) {
      console.log('  运行         未运行')
    } else {
      console.log(`  运行         主进程 PID ${String(processes.main.pid)}${processes.cdpPort === undefined ? '' : `，CDP ${String(processes.cdpPort)}`}${processes.host === undefined ? '' : `，宿主子进程 PID ${String(processes.host.pid)}`}`)
    }
    console.log('')
  }
}

/* ---------------------------------------------------------------- artifact（阶段 A：固定产物） */

function artifact() {
  const root = buildRoot()
  const state = gitState(ROOT)
  const version = REPO_PACKAGE.version
  const dirtyTag = state.dirty.length > 0 ? '-dirty' : ''
  const id = readArg('id') ?? `v${version}-${state.commit.slice(0, 7)}${dirtyTag}-${stamp()}`
  const target = artifactDir(root, id)
  if (existsSync(target)) {
    fail(`产物目录已存在：${target}（输入变化应生成新 id；要复用请直接 assemble，不要重建）`)
  }

  // 来源：默认挑 dist 里最新的整包（会先印出来），也可 --source 指定 zip 或解压好的根目录。
  let source
  const sourceArg = readArg('source')
  if (sourceArg === undefined) {
    const newest = newestFullZip()
    if (newest === undefined) fail('dist 里没有 dsh-webops-desktop-*-win-x64-portable.zip —— 用 --source 指定')
    source = { kind: 'zip', path: newest.path }
    console.log(`（未指定 --source，按 mtime 挑最新整包：${newest.name}）`)
  } else {
    const path = resolve(sourceArg)
    if (!existsSync(path)) fail(`--source 不存在：${path}`)
    source = path.endsWith('.zip') ? { kind: 'zip', path } : { kind: 'dir', path }
  }

  const started = Date.now()
  if (source.kind === 'dir' && existsSync(join(source.path, 'home', '.credentials.yaml'))) {
    fail('来源包含实例凭据，拒绝作为出厂模板；请使用未注入凭据的模板，装配后再按实例注入')
  }
  // 全部产物先落在暂存，最后**整体改名发布**：中断的构建只留下暂存证据，
  // 产物 id 不会被半成品占用（方案 §3.2「中断构建后不得启动半成品；重跑使用新目录」——
  // 改名发布让同一 id 在失败后可重试，已发布的 id 则被 rename 的 EEXIST 挡住）。
  const stage = join(stageRoot(root), `${id}-${stamp()}`)
  const staged = join(stage, 'artifact')
  mkdirSync(staged, { recursive: true })
  const sourceIdentity = {}
  if (source.kind === 'zip') {
    sourceIdentity.sha256 = sha256File(source.path)
    sourceIdentity.bytes = statSync(source.path).size
  } else {
    const appHash = hashTree(join(source.path, 'app'))
    const homeHash = hashTree(join(source.path, 'home'))
    sourceIdentity.treeDigest = sha256Bytes(Buffer.from(`${treeDigest(appHash.files)}\n${treeDigest(homeHash.files)}\n`, 'utf8'))
    sourceIdentity.files = appHash.count + homeHash.count
  }
  sourceIdentity.kind = source.kind
  sourceIdentity.path = source.path

  // 1) 插件构建（同一快照只构建一次；--lib-dir 可复用已构建目录，manifest 如实记录）。
  const buildInfo = { command: 'tsdown --no-clean + copy-assets', reused: false }
  let pluginBuildDir = join(stage, 'plugin-build')
  const libArg = readArg('lib-dir')
  if (libArg !== undefined) {
    pluginBuildDir = resolve(libArg)
    if (!existsSync(join(pluginBuildDir, 'index.js'))) fail(`--lib-dir 不像构建产物（缺 index.js）：${pluginBuildDir}`)
    buildInfo.reused = true
    buildInfo.libDir = pluginBuildDir
    buildInfo.libDigest = treeDigest(hashTree(pluginBuildDir).files)
    console.log(`\n[1/4] 复用已构建插件目录：${pluginBuildDir}`)
  } else {
    console.log('\n[1/4] 构建插件（保留式：--no-clean，输出到暂存）')
    mkdirSync(pluginBuildDir, { recursive: true })
    const built = spawnSync('pnpm', ['exec', 'tsdown', '--no-clean', '--out-dir', pluginBuildDir], { cwd: ROOT, stdio: 'inherit', shell: true })
    if (built.status !== 0) fail(`tsdown 失败（exit ${String(built.status)}）`)
    const assets = spawnSync(process.execPath, [join(ROOT, 'scripts', 'copy-assets.mjs'), '--out-dir', pluginBuildDir], { cwd: ROOT, stdio: 'inherit' })
    if (assets.status !== 0) fail(`copy-assets 失败（exit ${String(assets.status)}）`)
  }
  // 生产形态安装载荷：构建产物（排除 fake-llm）+ 生产 package.json + cordis.patch.yml。
  const pluginDir = join(staged, 'plugin')
  mkdirSync(pluginDir, { recursive: true })
  // package.json 的 main/exports 指向 lib/；不能把已构建目录拍平到包根。
  cpSync(pluginBuildDir, join(pluginDir, 'lib'), {
    recursive: true,
    filter: (src) => {
      const rel = toPosix(relative(pluginBuildDir, src))
      return rel !== 'fake-llm' && !rel.startsWith('fake-llm/')
    },
  })
  writeFileSync(join(pluginDir, 'package.json'), `${JSON.stringify(productionPackageJson(REPO_PACKAGE, version), null, 2)}\n`)
  cpSync(join(ROOT, 'cordis.patch.yml'), join(pluginDir, 'cordis.patch.yml'))

  // 2) app：从固定来源物化（zip 走 unzip-portable.py，带 NUL 自检）。
  console.log('\n[2/4] 物化 app/（固定来源，只创建不删除）')
  const appStart = Date.now()
  materializeSource(source, staged, 'app/', join(ROOT, 'scripts'))
  console.log(`  app/ 完成：${String(Date.now() - appStart)}ms`)

  // 3) home 出厂模板：先物化到暂存，再**剥掉自带插件**后进产物 —— 安装时统一用本产物的构建。
  console.log('\n[3/4] 物化出厂 home 模板（剥离自带插件，装配时统一安装本产物构建）')
  const homeStage = join(stage, 'home-src')
  materializeSource(source, homeStage, 'home/', join(ROOT, 'scripts'))
  const homeTemplate = join(homeStage, 'home')
  const stripRel = 'profiles/desktop/node_modules/dsh-webops-plugin'
  cpSync(homeTemplate, join(staged, 'home'), {
    recursive: true,
    filter: (src) => {
      const rel = toPosix(relative(homeTemplate, src))
      return rel !== stripRel && !rel.startsWith(`${stripRel}/`)
    },
  })

  // 4) 逐文件哈希 → manifest → 完成标记（标记绑定输出摘要，不是「文件存在」）。
  console.log('\n[4/4] 逐文件 SHA256 + manifest + 完成标记')

  // 工作区构建的**前后校验**（方案 §3.2 过渡路径）：构建期间输入变化即失败，
  // 不把「碰巧没变」的构建当成可复用快照。来源整包同样再核验一次哈希。
  const stateAfter = gitState(ROOT)
  if (JSON.stringify(stateAfter) !== JSON.stringify(state)) {
    fail('构建期间工作区输入发生变化（并发编辑？）—— 拒绝作为可复用快照；重跑请用新 id')
  }
  if (source.kind === 'zip' && sha256File(source.path) !== sourceIdentity.sha256) {
    fail('构建期间来源整包发生变化 —— 拒绝作为可复用快照；重跑请用新 id')
  }
  const outputs = {}
  for (const part of ['app', 'home', 'plugin']) {
    const hashed = hashTree(join(staged, part))
    outputs[part] = { files: Object.fromEntries(hashed.files), count: hashed.count, bytes: hashed.bytes, digest: treeDigest(hashed.files) }
    console.log(`  ${part}/  ${String(hashed.count)} 文件  ${humanBytes(hashed.bytes)}  digest ${hashed.count > 0 ? treeDigest(hashed.files).slice(0, 12) : '-'}…`)
  }
  const manifest = buildArtifactManifest({
    artifactId: id,
    createdAt: new Date().toISOString(),
    repo: { root: ROOT, commit: state.commit, dirty: state.dirty, pluginVersion: version },
    source: { ...sourceIdentity, note: readArg('note') ?? undefined },
    build: { ...buildInfo, mode: 'workspace-before-after', inputsStable: true, ms: Date.now() - started },
    outputs,
  })
  writeFileSync(join(staged, ARTIFACT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  const manifestFiles = new Map()
  for (const part of ['app', 'home', 'plugin']) {
    for (const [rel, hash] of Object.entries(outputs[part].files)) manifestFiles.set(`${part}/${rel}`, hash)
  }
  writeCompletion(staged, { kind: 'artifact', id, digest: treeDigest(manifestFiles) })

  // 原子发布：整 publish 由一次 rename 完成，产物 id 只会被「完成且自校验通过」的树占用。
  mkdirSync(artifactsRoot(root), { recursive: true })
  try {
    renameSync(staged, target)
  } catch (error) {
    fail(`发布产物失败（保留暂存 ${staged} 作证据）：${error.message}`)
  }

  console.log(`\n产物完成：${target}`)
  console.log(`  总耗时 ${String(Date.now() - started)}ms；app+home+plugin 合计 ${humanBytes(outputs.app.bytes + outputs.home.bytes + outputs.plugin.bytes)}`)
  console.log(`  输入身份：commit ${state.commit.slice(0, 7)}${state.dirty.length > 0 ? ` + ${String(state.dirty.length)} 个脏文件` : ''}；来源 ${source.kind} ${sourceIdentity.sha256?.slice(0, 12) ?? sourceIdentity.treeDigest?.slice(0, 12)}…`)
  console.log(`\n下一步（同一 artifact 装配 A/B，插件构建只执行一次）：`)
  console.log(`  node scripts/local-multi-instance.mjs assemble --artifact ${id} --instance A`)
  console.log(`  node scripts/local-multi-instance.mjs assemble --artifact ${id} --instance B`)
}

/* ---------------------------------------------------------------- assemble（阶段 A：装配实例） */

function assemble() {
  const root = buildRoot()
  const artifactId = readArg('artifact')
  const instanceId = readArg('instance')
  if (artifactId === undefined) fail('需要 --artifact <产物id>')
  if (instanceId === undefined) fail('需要 --instance <实例id>')
  const credentials = readArg('credentials')
  const started = Date.now()
  const { instanceDir: dir, instance } = assembleInstance({ buildRoot: root, artifactId, instanceId })
  let injected
  if (credentials !== undefined) {
    injected = injectCredentials(dir, resolve(credentials))
    console.log(`凭据已按实例注入：${injected}（不进 manifest/证据）`)
  }
  console.log(`实例完成：${dir}`)
  console.log(`  装配耗时 ${String(Date.now() - started)}ms；app ${String(instance.app.files)} 文件 / ${humanBytes(instance.app.bytes)}`)
  console.log(`  安装插件 ${instance.plugin.version}（digest ${instance.plugin.digest.slice(0, 12)}…，与产物逐文件一致）`)
  console.log(`\n下一步：`)
  console.log(`  node scripts/local-multi-instance.mjs launch --instance ${instanceId} --cdp 9333`)
}

/* ---------------------------------------------------------------- launch / endpoint / stop（阶段 B） */

/** WMI 创建进程：脱离本 shell 的 job object 才能跨工具调用存活（portable-dev.mjs 同款判据）。 */
function wmiLaunch(commandLine, cwd) {
  const script = `([wmiclass]"Win32_Process").Create('${commandLine.replace(/'/g, "''")}', '${cwd.replace(/'/g, "''")}')`
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    fail(`WMI 创建进程失败：${(result.stderr ?? '').trim().slice(0, 300) || `exit ${String(result.status)}`}`)
  }
}

async function launch() {
  const root = buildRoot()
  const instanceId = readArg('instance')
  if (instanceId === undefined) fail('需要 --instance <实例id>')
  const dir = instanceDir(root, instanceId)
  if (!existsSync(dir)) fail(`实例目录不存在：${dir}（先 assemble）`)
  const { instance, problems } = verifyInstanceForLaunch(dir)
  if (problems.length > 0) fail(`实例 ${instanceId} 门禁不通过，拒绝启动：\n  - ${problems.join('\n  - ')}`)

  // 重复启动：同目录会聚焦已有窗口（单实例锁按 realpath 归属），不再起第二份。
  const existing = findInstanceProcesses(instance.app.exe)
  if (existing.main !== undefined) {
    console.log(`实例 ${instanceId} 已在运行（PID ${String(existing.main.pid)}）—— 同目录重复启动只会聚焦已有窗口，未再启动。`)
    console.log(`  查端点：node scripts/local-multi-instance.mjs endpoint --instance ${instanceId}`)
    return
  }

  const cdpPort = Number(readArg('cdp') ?? 9333)
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) fail(`--cdp 端口不合法：${String(cdpPort)}`)
  const holder = findPortListener(cdpPort)
  if (holder !== undefined) {
    fail(`CDP 端口 ${String(cdpPort)} 已被占用（PID ${String(holder.pid)}${holder.name === undefined ? '' : ` ${holder.name}`}）—— 换一个 --cdp 端口；绑定竞争失败会明确返回，不连接其他实例充数。`)
  }

  // run-id 同一秒内只允许一个实例占用；第二个实例起自动加后缀（并发启动不互相覆盖）。
  let runId = `run-${stamp()}`
  let evidenceDir = join(evidenceRoot(root), runId)
  for (let suffix = 2; existsSync(evidenceDir); suffix += 1) {
    runId = `run-${stamp()}-${String(suffix)}`
    evidenceDir = join(evidenceRoot(root), runId)
  }
  mkdirSync(evidenceDir, { recursive: true })
  const appDir = join(dir, 'app')
  const commandLine = `"${instance.app.exe}" --remote-debugging-port=${String(cdpPort)}`
  console.log(`启动（WMI，脱离 job；cwd ${appDir}）：\n  ${commandLine}`)
  wmiLaunch(commandLine, appDir)

  const discovery = await discoverInstanceEndpoints({
    exePath: instance.app.exe,
    cdpPort,
    timeoutMs: Number(readArg('timeout') ?? 150_000),
    log: (line) => console.log(`  · ${line}`),
  })
  const record = {
    runId, instanceId, at: new Date().toISOString(),
    exe: instance.app.exe, commandLine,
    exePid: discovery.exePid ?? null, hostPid: discovery.hostPid ?? null,
    hostPort: discovery.hostPort ?? null, endpoint: discovery.endpoint ?? null,
    cdpPort, cdpReady: discovery.cdpReady,
    home: instance.paths.home, data: instance.paths.data,
    appDigest: instance.app.digest, pluginDigest: instance.plugin.digest,
    problems: discovery.problems,
  }
  writeFileSync(join(evidenceDir, `launch-${instanceId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  const runSummaryPath = join(evidenceDir, 'run.json')
  const runSummary = existsSync(runSummaryPath)
    ? JSON.parse(readFileSync(runSummaryPath, 'utf8'))
    : { runId, instances: [], at: record.at }
  if (!runSummary.instances.includes(instanceId)) runSummary.instances.push(instanceId)
  writeFileSync(runSummaryPath, `${JSON.stringify(runSummary, null, 2)}\n`)
  appendRun(instanceDir(root, instanceId), { runId, at: record.at, exePid: record.exePid, hostPort: record.hostPort, cdpPort, outcome: discovery.ok ? 'ok' : 'problems' })

  if (!discovery.ok) {
    console.error(`\n端点发现问题（实例仍在运行，PID ${String(discovery.exePid ?? '?')}；证据 ${evidenceDir}）：`)
    for (const problem of discovery.problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`\n实例 ${instanceId} 已就绪：`)
  console.log(`  主进程 PID ${String(discovery.exePid)}，宿主子进程 PID ${String(discovery.hostPid)}`)
  console.log(`  宿主端点（脱敏） ${discovery.endpoint}（动态端口，按 PID 归属核验）`)
  console.log(`  CDP ${String(cdpPort)} → dsh-app://app/ target${discovery.cdpReady ? ' 已就绪' : ' 未就绪'}`)
  console.log(`  证据目录 ${evidenceDir}`)
  console.log(`\n真实对话：node scripts/local-multi-instance.mjs chat --instance ${instanceId} --msg "…" --new`)
}

/** 运行记录追加到实例的 runs.jsonl（不动 instance.json —— 完成标记绑着它的摘要）。 */
function appendRun(dir, entry) {
  writeFileSync(join(dir, 'runs.jsonl'), `${JSON.stringify(entry)}\n`, { flag: 'a' })
}

async function endpoint() {
  const root = buildRoot()
  const instanceId = readArg('instance')
  if (instanceId === undefined) fail('需要 --instance <实例id>')
  const dir = instanceDir(root, instanceId)
  const instance = readManifest(dir, INSTANCE_MANIFEST)
  if (instance === undefined) fail(`实例清单缺失：${dir}`)
  const discovery = await discoverInstanceEndpoints({
    exePath: instance.app.exe,
    timeoutMs: Number(readArg('timeout') ?? 60_000),
    log: (line) => console.log(`  · ${line}`),
  })
  console.log(JSON.stringify({ instanceId, ...discovery, endpoint: discovery.endpoint ?? null }, null, 2))
  if (!discovery.ok) process.exit(1)
}

async function stop() {
  const root = buildRoot()
  const instanceId = readArg('instance')
  if (instanceId === undefined) fail('需要 --instance <实例id>')
  const dir = instanceDir(root, instanceId)
  const instance = readManifest(dir, INSTANCE_MANIFEST)
  if (instance === undefined) fail(`实例清单缺失：${dir}`)
  const processes = findInstanceProcesses(instance.app.exe)
  if (processes.main === undefined) {
    console.log(`实例 ${instanceId} 没有在跑（主进程不存在）。`)
    if (processes.host !== undefined) console.log(`  但其 desktop-host 子进程还在（PID ${String(processes.host.pid)}）—— 异常，请人工核对后处理。`)
    return
  }
  const pid = processes.main.pid
  console.log(`优雅退出实例 ${instanceId}：taskkill /PID ${String(pid)}（不带 /F，等价于关窗口）`)
  const killed = spawnSync('taskkill', ['/PID', String(pid)], { encoding: 'utf8', windowsHide: true })
  if (killed.status !== 0) console.error(`  taskkill 输出：${(killed.stderr ?? killed.stdout ?? '').trim().slice(0, 200)}`)
  if (await waitUntilGone(instance.app.exe, 15_000)) return settled(instanceId)
  // taskkill 不带 /F 只发 WM_CLOSE：窗口被隐藏/子进程持有时不生效。第二级仍然优雅 ——
  // 走 CDP Browser.close（浏览器自己的关闭流程，不是杀进程）。
  const cdpPort = processes.cdpPort
  if (cdpPort !== undefined) {
    console.log(`  15s 后仍在 —— 改用 CDP Browser.close（仍是优雅关闭，不是杀进程）`)
    try {
      const version = await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`)).json()
      const socket = new WebSocket(version.webSocketDebuggerUrl)
      await new Promise((resolvePromise, reject) => { socket.onopen = resolvePromise; socket.onerror = reject })
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))
      socket.close()
    } catch (error) {
      console.log(`  Browser.close 失败：${error.message}`)
    }
    if (await waitUntilGone(instance.app.exe, 20_000)) return settled(instanceId)
  }
  const still = findInstanceProcesses(instance.app.exe)
  console.log(`  仍未退出（PID ${String(still.main?.pid ?? pid)}）。不强杀 —— 请人工确认窗口状态后处理。`)
  console.log(`  记录之间的差异（如团队/终端仍在跑任务）会让优雅关闭被拦住；确认后可带上 --force 退出该测试实例。`)
  if (has('force')) {
    const forced = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', windowsHide: true })
    console.log(`  --force 强杀：${forced.status === 0 ? '已执行' : (forced.stderr ?? '').trim().slice(0, 120)}`)
    if (await waitUntilGone(instance.app.exe, 10_000)) settled(instanceId)
  }
}

/** 轮询到该实例主进程消失（true=已退出）；只按本实例 exe 路径计数，不猜 PID。 */
async function waitUntilGone(exePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (findInstanceProcesses(exePath).main === undefined) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
  }
}

function settled(instanceId) {
  console.log(`实例 ${instanceId} 已退出；home/data 保留（重启可读回）。`)
}
/* ---------------------------------------------------------------- chat（阶段 B：真实对话） */

async function chat() {
  const root = buildRoot()
  const instanceId = readArg('instance')
  if (instanceId === undefined) fail('需要 --instance <实例id>')
  const dir = instanceDir(root, instanceId)
  const instance = readManifest(dir, INSTANCE_MANIFEST)
  if (instance === undefined) fail(`实例清单缺失：${dir}`)
  const processes = findInstanceProcesses(instance.app.exe)
  if (processes.main === undefined) fail(`实例 ${instanceId} 没在运行 —— 先 launch`)
  const cdpPort = processes.cdpPort ?? Number(readArg('cdp') ?? NaN)
  if (!Number.isInteger(cdpPort)) fail('主进程命令行里没有 --remote-debugging-port，且未传 --cdp')
  const message = readArg('msg')
  const readOnly = has('read') || message === undefined
  const conversation = readArg('conv')
  const tail = Number(readArg('tail') ?? 2500)
  const settle = Number(readArg('settle') ?? 8000)
  const timeout = Number(readArg('timeout') ?? 240_000)

  const list = await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/list`)).json()
  const page = list.find((target) => target.type === 'page' && String(target.url ?? '').startsWith('dsh-app://app/'))
  if (page === undefined) fail(`dsh-app://app/ target 不存在（CDP ${String(cdpPort)}）：${list.map((t) => t.url).join(', ')}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => { ws.onopen = resolvePromise; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolvePromise, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) reject(new Error(msg.error.message))
      else resolvePromise(msg.result)
    }
  }
  // 每次调用都带兜底超时：渲染页被遮挡节流时明确失败，不要把「卡住」当成还在思考。
  const perCall = Number(readArg('cdp-timeout') ?? 60_000)
  const send = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = (seq += 1)
    pending.set(id, { resolvePromise, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(`CDP ${method} ${String(perCall)}ms 无响应 —— 明确失败，不无限等待`))
    }, perCall)
  })
  const evalJs = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`页面异常: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result.value
  }
  const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

  /** locate + 真实点击 helper：按 CSS 选择器或按钮文案找元素，在它的中心发鼠标事件。 */
  const locate = (probe) => evalJs(`(() => {
    const probe = ${JSON.stringify(probe)}
    let el
    if (probe.mode === 'selector') el = document.querySelector(probe.value)
    else el = [...document.querySelectorAll('button, [role=button], a, div[role=treeitem]')]
      .find(c => (c.getAttribute('aria-label') ?? c.textContent ?? '').trim() === probe.value)
      ?? [...document.querySelectorAll('button, [role=button], a, div[role=treeitem]')]
        .find(c => (c.textContent ?? '').includes(probe.value))
    if (el === undefined || el === null) return JSON.stringify({ found: false })
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return JSON.stringify({ found: true, tag: el.tagName, label: (el.textContent ?? '').trim().slice(0, 40),
      disabled: el.disabled === true,
      visible: style.visibility !== 'hidden' && style.display !== 'none' && r.width > 0 && r.height > 0,
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })
  })()`).then(JSON.parse)
  const realClick = async (probe, label) => {
    const box = await locate(probe)
    if (box.found !== true) fail(`找不到要点的元素：${label}`)
    if (box.disabled === true) fail(`元素 disabled，点了也不会响应：${label}`)
    if (box.visible !== true) fail(`元素不可见：${label}`)
    if (box.inViewport !== true) fail(`元素中心不在视口内（当前 UI 布局变了？）：${label} @(${String(box.x)},${String(box.y)})`)
    const point = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, buttons: 0 })
    return box
  }

  /**
   * 目标窗口必须可见才吃得下输入 —— 另一个实例在前台时本实例页面会是 `visibility: hidden`，
   * 此时 insertText 静默不生效（回执仍是空的 success，「已发送」的假象就是这么来的）。
   * 提前台不用 OS 后门：再启动一次同一个 exe，单实例锁会把焦点交给已有窗口后自己退出。
   */
  const ensureVisible = async () => {
    const state = await evalJs('document.visibilityState')
    if (state === 'visible') return false
    console.log(`  · 目标窗口不可见（${String(state)}）—— 用单实例锁把它提到前台`)
    wmiLaunch(`"${instance.app.exe}"`, dirname(instance.app.exe))
    const deadline = Date.now() + 30_000
    for (;;) {
      await wait(1500)
      if (await evalJs('document.visibilityState') === 'visible') return true
      if (Date.now() >= deadline) fail(`30s 内窗口没回到前台；界面在被别的实例遮挡时吃不进输入 —— 先人工把它调到前面`)
    }
  }

  /**
   * 确保 composer 在界面上：实例重启（或首次进入）会停在「选择一个工作区」——
   * 那时页面上根本没有输入框，直接报错会让人以为是 driving 坏了。
   * 找到「默认工作区」那一行往上找出可点的祖先，真实点一下，再复查 composer 是否出现。
   */
  const ensureComposer = async () => {
    const present = () => evalJs('document.querySelectorAll(\'[contenteditable="true"]\').length + document.querySelectorAll("textarea").length')
    if (await present() > 0) return
    const row = JSON.parse(await evalJs(`(() => {
      const leaf = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent ?? '').trim() === '默认工作区')
      if (leaf === undefined) return JSON.stringify({ found: false })
      let node = leaf
      for (let depth = 0; depth < 6 && node !== null; depth += 1) {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        if (rect.width > 40 && rect.height > 20 && (style.cursor === 'pointer' || node.tagName === 'BUTTON' || node.getAttribute('role') === 'button')) {
          return JSON.stringify({ found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) })
        }
        node = node.parentElement
      }
      return JSON.stringify({ found: false })
    })()`))
    if (row.found !== true) fail('页面上没有输入框，也找不到「默认工作区」入口 —— UI 结构可能变了，需人工确认后再补这一步的驱动')
    const point = { x: row.x, y: row.y, button: 'left', clickCount: 1 }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, buttons: 0 })
    await wait(3000)
    if (await present() === 0) fail('点了「默认工作区」之后仍然没有输入框 —— 需人工看一眼这个实例停在哪个界面')
  }

  try {
    await ensureVisible()
    await ensureComposer()
    if (has('new') && !readOnly) {
      await realClick({ mode: 'text', value: '新建会话' }, '新建会话按钮')
      await wait(2000)
    }
    if (conversation !== undefined) {
      await realClick({ mode: 'text', value: conversation }, `侧栏会话「${conversation}」`)
      await wait(2000)
    }
    if (!readOnly) {
      // 输入三步：真实点输入框 → Input.insertText → Enter（keyDown/keyUp，带 text）。
      // 不用 el.click()/execCommand 的组合：那是脚本调用，绕不过「窗口不可见吃不下输入」这类真实管线问题。
      await realClick({ mode: 'selector', value: '[contenteditable="true"], textarea' }, 'composer')
      // Composer 可能还没挂上编辑态（「新建会话」后的头几秒），也可能因为上一次残留而重复拼接 ——
      // 每次都先读现状：有残留才 Ctrl+A 全选再写；最多重试 5 次，每次都以 composer 里读到的字为准。
      let typed = ''
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const before = String(await evalJs('(document.querySelector(\'[contenteditable="true"]\')?.innerText ?? document.querySelector("textarea")?.value ?? "")'))
        if (before !== '' && before !== message) {
          const ctrlA = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }
          await send('Input.dispatchKeyEvent', { type: 'keyDown', ...ctrlA })
          await send('Input.dispatchKeyEvent', { type: 'keyUp', ...ctrlA })
        }
        await send('Input.insertText', { text: message })
        await wait(700)
        typed = String(await evalJs('(document.querySelector(\'[contenteditable="true"]\')?.innerText ?? document.querySelector("textarea")?.value ?? "")'))
        if (typed.trim() === message) break
        const diagnostics = String(await evalJs('JSON.stringify({ visibility: document.visibilityState, focus: document.hasFocus(), editors: document.querySelectorAll(\'[contenteditable="true"]\').length })'))
        console.log(`  · 第 ${String(attempt)} 次输入没进 composer（读到 ${JSON.stringify(typed.slice(0, 40))}）${diagnostics} —— 2s 后重连重试`)
        if (attempt < 5) {
          await wait(2000)
          await realClick({ mode: 'selector', value: '[contenteditable="true"], textarea' }, 'composer')
        }
      }
      if (typed.trim() !== message) {
        fail(`composer 里读不到刚输入的文字 —— 输入没进去（读到 ${JSON.stringify(typed.slice(0, 60))}）；不假定「发出去了」`)
      }
      const submit = await locate({ mode: 'text', value: '发送消息' })
      if (submit.found === true && submit.disabled !== true) await realClick({ mode: 'text', value: '发送消息' }, '发送消息按钮')
      else {
        const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r' })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
      }
      // 页面侧判据：消息真的进了会话才算发送成功（别信回执）。
      const landed = await (async () => {
        const deadline = Date.now() + 20_000
        for (;;) {
          if (await evalJs(`document.body.innerText.includes(${JSON.stringify(message.slice(0, 20))})`)) return true
          if (Date.now() >= deadline) return false
          await wait(1000)
        }
      })()
      if (!landed) fail(`20s 内会话里没出现这条消息 —— 发送失败，不是「还在思考」`)
      console.log(`已向实例 ${instanceId} 发送（会话里已读到该条消息），等待回复稳定…`)
    }
    const start = Date.now()
    let lastLen = -1
    let lastChange = Date.now()
    for (;;) {
      if (Date.now() - start > timeout) {
        console.error(`（${String(Math.round(timeout / 1000))}s 未稳定 —— 稍后用 --read 重读一遍再下结论）`)
        break
      }
      const len = await evalJs('document.body.innerText.length')
      if (len !== lastLen) { lastLen = len; lastChange = Date.now() }
      if (Date.now() - lastChange >= settle) break
      await wait(2000)
    }
    const text = await evalJs(`document.body.innerText.slice(-${String(tail)})`)
    console.log(`──── 实例 ${instanceId} 对话尾部 ────`)
    console.log(text)
  } finally {
    ws.close()
  }
}

/* ---------------------------------------------------------------- 派发 */

const commands = { env: showEnv, artifact, assemble, launch, endpoint, stop, chat, status, list: listAll }
if (command === undefined || !(command in commands)) {
  console.error(`用法: node scripts/local-multi-instance.mjs <命令> [参数]

  env                                 看本机路径来源与多实例布局
  artifact --id <id> [--source <zip|解压根>] [--lib-dir <已构建目录>] [--note <文本>]
                                       固定输入并构建一次：插件构建 + app/home 模板 + manifest + 完成标记
  assemble --artifact <id> --instance <id> [--credentials <文件>]
                                       从完成产物装配实例（已有同名目录拒绝；凭据按实例注入）
  launch  --instance <id> [--cdp 9333] 启动实例：CDP 占用预检、动态发现宿主端点、核验归属、写证据
  endpoint --instance <id>            重新发现运行中实例的端点（宿主重启后不沿用旧端口）
  chat    --instance <id> [--msg "…"] [--new] [--conv "会话名"] [--read] [--tail N] [--settle ms]
                                       经渲染页 UI 发真实 prompt / 只读对话尾部
                                       （自动处理：提前台、选工作区、注入后回读校验）
  status  [--instance <id>]           实例清单、完成标记与运行状态
  stop    --instance <id> [--force]   优雅退出：taskkill → CDP Browser.close；--force 才强杀
  list                                列出全部产物与实例

布局根: ${join(buildRoot(), 'local-tests')}`)
  process.exit(1)
}
try {
  await commands[command]()
} catch (error) {
  // 库里抛的是「人话」判据（含多行明细），直接印，不要 Node 的默认栈。
  fail(error instanceof Error ? error.message : String(error))
}
