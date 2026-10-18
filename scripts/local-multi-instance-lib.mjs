/**
 * 本地多实例测试调度核心库 —— [本地多实例测试方案](../docs/本地多实例测试方案.md) 阶段 A/B。
 *
 * 管三件事，全部围绕「同一份固定产物装配多个独立实例」：
 *
 * 1. **artifact（阶段 A）**：固定输入快照 → 保留式构建插件一次 → 复制 app 与出厂 home 模板
 *    → 逐文件 SHA256 manifest → 完成标记。消费时重新核验，缺文件、多文件、内容变化一律拒绝。
 * 2. **assemble（阶段 A）**：从完成产物装配实例目录（app + home + 安装同一份插件），
 *    独占创建（已存在即拒绝），复制后校验再写完成标记；没有标记的实例不许启动。
 * 3. **endpoints（阶段 B）**：运行中实例的宿主端点发现与归属核验 —— 桌面宿主 `--port 0`
 *    动态绑定，按「exe 的 desktop-host 子进程 → netstat  LISTENING → HTTP 探活」发现，
 *    并用命令行里的实例路径核验归属；CDP 端口启动前查占用、启动后核验监听 PID。
 *
 * 本文件**不解析 argv、不退出进程、不写用户数据**；CLI 在 `local-multi-instance.mjs。
 * 目录一律位于 `.env.local` 配置的 D 盘构建根下（`scripts/local-env.mjs`），不写死路径。
 *
 * 删除红线（AGENTS.md）：本库没有任何 rm/unlink/rmdir —— 失败目录保留作证据，重跑用新 id。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findPortListener } from './run-packaged-host.mjs'
import { prepareInstanceWritableDirectories } from './instance-workspace-acl.mjs'

// 单端口占用查询沿用 run-packaged-host.mjs 的实现（netstat + tasklist，判据同源），
// 从这里再导出，调用方只依赖本库一个入口。
export { findPortListener }

export const INSTANCE_EXE = 'DeepSeek Harness.exe'
export const PLUGIN_NAME = 'dsh-webops-plugin'
export const COMPLETION_FILE = '.mi-complete'
export const ARTIFACT_MANIFEST = 'manifest.json'
export const INSTANCE_MANIFEST = 'instance.json'

/* ------------------------------------------------------------------ 布局 */

export const localTestsRoot = (buildRoot) => join(buildRoot, 'local-tests')
export const artifactsRoot = (buildRoot) => join(localTestsRoot(buildRoot), 'artifacts')
export const instancesRoot = (buildRoot) => join(localTestsRoot(buildRoot), 'instances')
export const evidenceRoot = (buildRoot) => join(localTestsRoot(buildRoot), 'evidence')
export const stageRoot = (buildRoot) => join(localTestsRoot(buildRoot), '.stage')
export const artifactDir = (buildRoot, artifactId) => join(artifactsRoot(buildRoot), artifactId)
export const instanceDir = (buildRoot, instanceId) => join(instancesRoot(buildRoot), instanceId)

/** 实例内插件安装位置（与出货布局一致：home/profiles/desktop/node_modules/<插件>）。 */
export const instancePluginDir = (root) => join(root, 'home', 'profiles', 'desktop', 'node_modules', PLUGIN_NAME)

/* ------------------------------------------------------------------ 哈希 */

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function sha256Bytes(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 逐文件哈希一棵树。返回 `{ files, bytes, count }`；
 * `files` 是 `Map<POSIX 相对路径, sha256>`，按键排序后序列化进 manifest。
 *
 * 约束（方案 §1）：不接受符号链接/junction —— 路径解析与更新写入会串到别的实例，
 * 见到即抛错，不静默跳过。
 *
 * @param root 树根目录。
 * @param options.ignore (rel) => boolean，rel 为 POSIX 风格相对路径。
 */
export function hashTree(root, options = {}) {
  const ignore = options.ignore ?? (() => false)
  const files = new Map()
  let bytes = 0
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (ignore(rel)) continue
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`拒绝作为快照内容：${full} 是符号链接（方案禁用 junction/symlink 共享）`)
      }
      if (entry.isDirectory()) {
        walk(full, rel)
        continue
      }
      if (!entry.isFile()) continue
      const size = statSync(full).size
      files.set(rel, sha256File(full))
      bytes += size
    }
  }
  if (!existsSync(root)) throw new Error(`目录不存在：${root}`)
  walk(root, '')
  const sorted = new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return { files: sorted, bytes, count: sorted.size }
}

/** 把 files Map 转成可 JSON 序列化、顺序稳定的普通对象。 */
export function filesToObject(files) {
  const out = {}
  for (const [rel, hash] of files) out[rel] = hash
  return out
}

/** 整树摘要：对排序后的 `rel\0hash\n` 再取 sha256。缺文件/多文件/内容变化都会改变它。 */
export function treeDigest(files) {
  const lines = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, hash]) => `${rel}\0${hash}\n`).join('')
  return sha256Bytes(Buffer.from(lines, 'utf8'))
}

/** 目录字节数（测量用，不读内容）。 */
export function dirSize(root) {
  let bytes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else bytes += statSync(full).size
    }
  }
  if (!existsSync(root)) return 0
  walk(root)
  return bytes
}

/* ------------------------------------------------------------------ git 输入状态 */

/**
 * 解析 `git status --porcelain` 输出。纯函数（测试用合成输入覆盖引号路径与改名）。
 * @param stdout porcelain 文本。
 * @param hashOf (absPath) => sha256 | null，文件不存在/非文件时返回 null。
 * @param repoRoot 仓库根（拼绝对路径用）。
 */
export function parsePorcelain(stdout, repoRoot, hashOf) {
  const dirty = []
  // 不整串 trim：porcelain 行首的两个状态位**允许是空格**（' M file' 是常见形态），
  // 整串 trim 会把第一行的行首空格吃掉，路径跟着错位。
  for (const raw of String(stdout).split(/\r?\n/u)) {
    const line = raw.replace(/\r$/u, '')
    if (line.trim() === '') continue
    const status = line.slice(0, 2).trim()
    let path = line.slice(3)
    if (path.startsWith('"')) {
      // porcelain 对特殊字符路径加双引号并按 C 风格转义；够用解一级，不引依赖。
      path = path.slice(1, path.lastIndexOf('"'))
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
    }
    const parts = path.split(' -> ')
    const target = parts[parts.length - 1]
    dirty.push({ path: target, status, sha256: hashOf(join(repoRoot, target)) })
  }
  return dirty
}

/**
 * 仓库输入状态：commit + 脏工作树逐文件哈希。
 * 方案 §3.2：「脏工作树不能只用 commit 作缓存键」—— 未提交改动按文件哈希进身份。
 *
 * @returns {{ commit: string, dirty: Array<{ path: string, status: string, sha256: string|null }> }}
 */
export function gitState(repoRoot) {
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} 失败：${(result.stderr ?? '').trim().slice(0, 200) || `exit ${String(result.status)}`}`)
    }
    return result.stdout
  }
  const commit = run(['rev-parse', 'HEAD']).trim()
  const hashOf = (abs) => (existsSync(abs) && statSync(abs).isFile() ? sha256File(abs) : null)
  return { commit, dirty: parsePorcelain(run(['status', '--porcelain']), repoRoot, hashOf) }
}

/* ------------------------------------------------------------------ manifest 与完成标记 */

/**
 * 构建 artifact manifest。输入身份（仓库状态、来源、版本、平台）由调用方采集后传入，
 * 输出逐文件哈希由 {@link verifyArtifact} 现场重算核对。
 */
export function buildArtifactManifest(input) {
  return {
    schema: 1,
    artifactId: input.artifactId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    inputs: {
      repo: input.repo,
      source: input.source,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    build: input.build,
    outputs: input.outputs,
  }
}

/** 读 manifest；不存在或不是合法 JSON 时返回 undefined。 */
export function readManifest(dir, name = ARTIFACT_MANIFEST) {
  const path = join(dir, name)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 核验产物目录与 manifest 一致。返回问题列表（空 = 通过）。
 * 判据（方案 §3.2）：缺文件、多文件、内容变化均拒绝；完成标记必须绑定 manifest 摘要。
 */
export function verifyArtifact(dir) {
  const problems = []
  if (existsSync(join(dir, 'home', '.credentials.yaml'))) {
    problems.push('产物含实例凭据，拒绝消费；凭据只能在实例装配后注入')
  }
  const manifest = readManifest(dir)
  if (manifest === undefined) {
    problems.push(`manifest 缺失或损坏：${join(dir, ARTIFACT_MANIFEST)}`)
    return { manifest: undefined, problems }
  }
  for (const part of ['app', 'home', 'plugin']) {
    const expected = manifest.outputs?.[part]?.files
    if (expected === undefined) {
      problems.push(`manifest 缺少 outputs.${part}.files`)
      continue
    }
    const partDir = join(dir, part)
    if (!existsSync(partDir)) {
      problems.push(`产物目录缺失：${partDir}`)
      continue
    }
    const actual = hashTree(partDir)
    const expectedMap = new Map(Object.entries(expected))
    for (const [rel, hash] of expectedMap) {
      if (!actual.files.has(rel)) problems.push(`${part}/ 缺文件：${rel}`)
      else if (actual.files.get(rel) !== hash) problems.push(`${part}/ 内容变化：${rel}`)
    }
    for (const rel of actual.files.keys()) {
      if (!expectedMap.has(rel)) problems.push(`${part}/ 多出文件：${rel}`)
    }
  }
  problems.push(...verifyCompletion(dir, treeDigestOfManifestFiles(manifest), 'artifact'))
  return { manifest, problems }
}

/** manifest 输出侧的文件摘要（完成标记绑定它，而不是绑定整个 manifest 文本）。 */
export function treeDigestOfManifestFiles(manifest) {
  const combined = {}
  for (const part of ['app', 'home', 'plugin']) {
    Object.assign(combined, Object.fromEntries(Object.entries(manifest.outputs?.[part]?.files ?? {}).map(([rel, hash]) => [`${part}/${rel}`, hash])))
  }
  return treeDigest(new Map(Object.entries(combined)))
}

/** 写完成标记：绑定 manifest 摘要，不是「文件存在」就算成功。 */
export function writeCompletion(dir, payload) {
  writeFileSync(join(dir, COMPLETION_FILE), `${JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2)}\n`)
}

export function readCompletion(dir) {
  const path = join(dir, COMPLETION_FILE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 核验完成标记：存在、kind 匹配、绑定的摘要与当前 manifest 一致。 */
export function verifyCompletion(dir, expectedDigest, kind) {
  const problems = []
  const marker = readCompletion(dir)
  if (marker === undefined) {
    problems.push(`完成标记缺失或损坏：${join(dir, COMPLETION_FILE)}（未完成目录不许消费/启动）`)
    return problems
  }
  if (kind !== undefined && marker.kind !== kind) problems.push(`完成标记 kind 不匹配：期望 ${kind}，实际 ${String(marker.kind)}`)
  if (expectedDigest !== undefined && marker.digest !== expectedDigest) {
    problems.push('完成标记绑定的摘要与当前 manifest 不一致（产物被改动或标记属另一版本）')
  }
  return problems
}

/* ------------------------------------------------------------------ 实例装配 */

/**
 * 从完成产物装配一个全新实例（方案 §3.3/§4-A）。
 *
 * 顺序即门禁：核验产物 → 独占创建实例目录 → 复制 app/home → 安装同一份插件 →
 * 复制后重算哈希对比 → 写实例清单 → 写完成标记。任一步失败都**不留标记**，
 * 失败目录保留作证据，重跑请换新 instanceId（方案 §3.2）。
 *
 * @param options.buildRoot 构建根（D 盘，来自 local-env）。
 * @param options.artifactId 产物 id。
 * @param options.instanceId 实例 id（目录名）。
 * @returns {{ instanceDir, instance, verification, ms }}。
 */
export function assembleInstance(options) {
  const started = Date.now()
  const { buildRoot, artifactId, instanceId } = options
  const source = artifactDir(buildRoot, artifactId)
  if (!existsSync(source)) throw new Error(`产物不存在：${source}（先跑 artifact 子命令）`)
  const { manifest, problems } = verifyArtifact(source)
  if (problems.length > 0) {
    throw new Error(`产物 ${artifactId} 校验不通过，拒绝装配：\n  - ${problems.join('\n  - ')}`)
  }

  const target = instanceDir(buildRoot, instanceId)
  mkdirSync(instancesRoot(buildRoot), { recursive: true })
  try {
    // 非 recursive：已存在即 EEXIST —— 「已有同名目录直接拒绝」，且对并发装配者是原子判据。
    mkdirSync(target)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`实例目录已存在：${target}（已有同名目录直接拒绝；中断的装配保留作证据，重跑请换新 instanceId）`)
    }
    throw error
  }

  try {
    // 只处理刚刚独占创建的新实例；显式 ACE 向随后创建的默认工作区与临时目录继承。
    prepareInstanceWritableDirectories(target)
    cpSync(join(source, 'app'), join(target, 'app'), { recursive: true })
    cpSync(join(source, 'home'), join(target, 'home'), { recursive: true })
    // 安装「同一份插件」：从产物复制，而不是让实例各自构建（阶段 A 的核心判据）。
    cpSync(join(source, 'plugin'), instancePluginDir(target), { recursive: true })
  } catch (error) {
    // 复制失败：目录留着（无标记 → 不许启动），明确告知这是半成品。
    throw new Error(`装配 ${instanceId} 复制失败：${error.message}\n  失败目录保留作证据（未写完成标记，不许启动）：${target}`)
  }

  // 复制后校验：app 与插件逐文件对比产物 manifest。
  const verification = { app: [], plugin: [] }
  const appHash = hashTree(join(target, 'app'))
  const expectedApp = new Map(Object.entries(manifest.outputs.app.files))
  for (const [rel, hash] of expectedApp) {
    if (appHash.files.get(rel) !== hash) verification.app.push(`app/${rel}`)
  }
  if (appHash.files.size !== expectedApp.size) verification.app.push(`文件数不一致：${String(appHash.files.size)} ≠ ${String(expectedApp.size)}`)
  const pluginHash = hashTree(instancePluginDir(target))
  const expectedPlugin = new Map(Object.entries(manifest.outputs.plugin.files))
  for (const [rel, hash] of expectedPlugin) {
    if (pluginHash.files.get(rel) !== hash) verification.plugin.push(`${rel}`)
  }
  if (pluginHash.files.size !== expectedPlugin.size) verification.plugin.push(`文件数不一致：${String(pluginHash.files.size)} ≠ ${String(expectedPlugin.size)}`)
  if (verification.app.length > 0 || verification.plugin.length > 0) {
    throw new Error(`装配 ${instanceId} 后校验不通过：\n  app: ${verification.app.slice(0, 5).join(', ') || '一致'}\n  plugin: ${verification.plugin.slice(0, 5).join(', ') || '一致'}\n  失败目录保留作证据（未写完成标记，不许启动）：${target}`)
  }

  const instance = {
    schema: 1,
    instanceId,
    artifactId,
    artifactDigest: treeDigestOfManifestFiles(manifest),
    createdAt: new Date().toISOString(),
    plugin: { name: PLUGIN_NAME, version: manifest.inputs.repo?.pluginVersion ?? null, digest: treeDigest(pluginHash.files) },
    app: { exe: join(target, 'app', INSTANCE_EXE), digest: treeDigest(appHash.files), files: appHash.count, bytes: appHash.bytes },
    paths: { root: target, home: join(target, 'home'), data: join(target, 'data') },
    runs: [],
  }
  writeFileSync(join(target, INSTANCE_MANIFEST), `${JSON.stringify(instance, null, 2)}\n`)
  writeCompletion(target, { kind: 'instance', id: instanceId, digest: sha256Bytes(Buffer.from(JSON.stringify(instance), 'utf8')) })
  return { instanceDir: target, instance, ms: Date.now() - started }
}

/**
 * 启动前的实例门禁：完成标记在、绑定当前 instance.json、app 与插件哈希仍与记录一致。
 * 运行时写入的 home 会话/数据不重新校验（会恒变），只验不可变部分。
 */
export function verifyInstanceForLaunch(dir) {
  const problems = []
  const instance = readManifest(dir, INSTANCE_MANIFEST)
  if (instance === undefined) {
    problems.push(`实例清单缺失或损坏：${join(dir, INSTANCE_MANIFEST)}`)
    return { instance: undefined, problems }
  }
  problems.push(...verifyCompletion(dir, sha256Bytes(Buffer.from(JSON.stringify(instance), 'utf8')), 'instance'))
  if (problems.length > 0) return { instance, problems }
  const appHash = hashTree(join(dir, 'app'))
  if (treeDigest(appHash.files) !== instance.app.digest) problems.push('app/ 与实例清单记录不一致（被改动？拒绝启动）')
  const pluginHash = hashTree(instancePluginDir(dir))
  if (treeDigest(pluginHash.files) !== instance.plugin.digest) problems.push('安装的插件与实例清单记录不一致（被改动？拒绝启动）')
  return { instance, problems }
}

/**
 * 按实例注入凭据（方案 §3.4：当前本机凭据按实例注入，禁止进入产物/manifest/日志/证据）。
 * 已存在则拒绝覆盖；返回注入路径。哈希与清单一律排除它。
 */
export function injectCredentials(dir, credentialsPath) {
  const target = join(dir, 'home', '.credentials.yaml')
  if (existsSync(target)) throw new Error(`实例已注入过凭据：${target}（不覆盖；要更换请先停实例并手动处理）`)
  if (!existsSync(credentialsPath)) throw new Error(`凭据文件不存在：${credentialsPath}`)
  mkdirSync(join(dir, 'home'), { recursive: true })
  cpSync(credentialsPath, target)
  return target
}

/* ------------------------------------------------------------------ Windows 进程清单 */

/**
 * 全机进程清单（含命令行）。走 PowerShell CIM 落盘再读 ——
 * 本机 spawnSync 的 powershell stdout 可能恒空（portable-dev.mjs 同款坑），
 * 且 Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 带 BOM，读前剥掉。
 *
 * @returns {Array<{ pid: number, ppid: number, name: string, commandLine: string }>}
 */
export function listProcesses() {
  if (process.platform !== 'win32') throw new Error('listProcesses 只在 Windows 上实现（CIM Win32_Process）')
  const out = join(tmpdir(), `mi-procs-${String(process.pid)}-${String(Date.now())}.json`)
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress | Set-Content -Path ' + JSON.stringify(out) + ' -Encoding utf8'
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`PowerShell 进程清单失败：${(result.stderr ?? '').trim().slice(0, 200) || `exit ${String(result.status)}`}`)
  }
  const raw = readFileSync(out, 'utf8').replace(/^\uFEFF/, '')
  const data = JSON.parse(raw)
  const list = Array.isArray(data) ? data : [data]
  // 临时 JSON 不主动删除（AGENTS.md 删除红线），由系统临时目录管理。
  return list.map((entry) => ({
    pid: Number(entry.ProcessId),
    ppid: Number(entry.ParentProcessId),
    name: String(entry.Name ?? ''),
    commandLine: String(entry.CommandLine ?? ''),
  })).filter((entry) => Number.isFinite(entry.pid))
}

/**
 * 按 exe 绝对路径找实例进程。命令行匹配带引号的 exe 路径，并区分三类：
 * - main：主 GUI（无 --type= / --expose-internals 参数），同时解析出 --remote-debugging-port；
 * - host：`--expose-internals <runtimeDir>/…/dsh-desktop-host/lib/index.js` 子进程；
 * - others：同实例的渲染/GPU 等子进程。
 */
export function findInstanceProcesses(exePath, processes = listProcesses()) {
  const quoted = `"${exePath}"`
  const belongs = (commandLine) => commandLine.includes(quoted) || commandLine.includes(` ${exePath} `) || commandLine.startsWith(`${exePath} `)
  const own = processes.filter((entry) => belongs(entry.commandLine))
  const main = own.find((entry) => !entry.commandLine.includes('--type=') && !entry.commandLine.includes('--expose-internals'))
  const host = own.find((entry) => entry.commandLine.includes('dsh-desktop-host'))
  const cdpMatch = main?.commandLine.match(/--remote-debugging-port=(\d+)/)
  return {
    main,
    host,
    others: own.filter((entry) => entry !== main && entry !== host),
    cdpPort: cdpMatch === null || cdpMatch === undefined ? undefined : Number(cdpMatch[1]),
  }
}

/** 平台系统目录里的 exe —— 不靠 PATH（调用方可能改过 cwd/PATH）。 */
function systemExe(name) {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name)
}

/**
 * 解析 `netstat -ano` 输出里的 LISTENING 行 → `PID → 端口[]`。纯函数（测试喂合成输出）。
 * 字段固定为：Proto / 本地地址 / 外部地址 / 状态 / PID。
 */
export function parseNetstatListening(stdout) {
  const byPid = new Map()
  for (const line of String(stdout).split(/\r?\n/u)) {
    if (!/\bLISTENING\b/iu.test(line)) continue
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 4) continue
    const colon = fields[1].lastIndexOf(':')
    if (colon === -1) continue
    const port = Number.parseInt(fields[1].slice(colon + 1), 10)
    const pid = Number.parseInt(fields[fields.length - 1], 10)
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue
    if (!byPid.has(pid)) byPid.set(pid, [])
    byPid.get(pid).push(port)
  }
  return byPid
}

/**
 * 一次 netstat 拿全机 `PID → LISTENING 端口` 表。
 * 不「绑一下试试」：Windows 上绑 `127.0.0.1:<port>` 与占用者绑 `0.0.0.0:<port>` 不冲突，
 * 会得到「端口空闲」的假阴性（run-packaged-host.mjs 同款判据）。
 */
export function listeningPortsByPid() {
  if (process.platform !== 'win32') return new Map()
  const netstat = spawnSync(systemExe('netstat.exe'), ['-ano'], { encoding: 'utf8', windowsHide: true })
  if (netstat.error !== undefined || netstat.stdout === null) return new Map()
  return parseNetstatListening(netstat.stdout)
}

/** 某 PID 正在 LISTENING 的端口（升序）。 */
export function listenPortsOf(pid, byPid = listeningPortsByPid()) {
  return [...(byPid.get(pid) ?? [])].sort((a, b) => a - b)
}

/* ------------------------------------------------------------------ 端点发现与归属核验 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 发现运行中实例的宿主端点并核验归属（方案 §3.4/§4-B）。
 *
 * - 宿主：exe 的 desktop-host 子进程（命令行含该实例 runtimeDir）→ 其 LISTENING 端口 →
 *   HTTP 探活（401/303 即活着）。**不猜端口、不连别的实例充数**；
 * - CDP：从主进程命令行解析 --remote-debugging-port，核验监听 PID 就是主 exe，
 *   再等 `dsh-app://app/` target 出现。端口在启动前已查过占用；这里的竞争失败明确报错。
 *
 * @param options.exePath 实例 exe 绝对路径。
 * @param options.cdpPort 期望的 CDP 端口（启动时传入；已在运行实例可省略，从命令行解析）。
 * @param options.timeoutMs 总等待上限。
 * @param options.listProcesses / options.listenPortsOf / options.probeHttp / options.portListener / options.fetchImpl 可注入（测试用）。
 */
export async function discoverInstanceEndpoints(options) {
  const list = options.listProcesses ?? listProcesses
  const portsOf = options.listenPortsOf ?? ((pid) => listenPortsOf(pid))
  const probe = options.probeHttp ?? defaultProbeHttp
  const portListener = options.portListener ?? findPortListener
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 90_000
  const deadline = Date.now() + timeoutMs
  const problems = []
  const log = options.log ?? (() => {})

  let processes = findInstanceProcesses(options.exePath, list())
  while (processes.main === undefined && Date.now() < deadline) {
    await sleep(500)
    processes = findInstanceProcesses(options.exePath, list())
  }
  if (processes.main === undefined) {
    return { ok: false, problems: [`${String(Math.round(timeoutMs / 1000))}s 内没找到实例主进程：${options.exePath}（启动失败或已退出）`], ...processes }
  }
  log(`主进程 PID ${String(processes.main.pid)}`)

  // CDP 归属核验：监听者必须是主 exe 本人。
  let cdpReady = false
  const cdpPort = options.cdpPort ?? processes.cdpPort
  if (cdpPort !== undefined) {
    const cdpDeadline = Math.min(deadline, Date.now() + 30_000)
    for (;;) {
      const holder = portListener(cdpPort)
      if (holder !== undefined && holder.pid === processes.main.pid) { cdpReady = true; break }
      if (holder !== undefined && holder.pid !== processes.main.pid) {
        problems.push(`CDP 端口 ${String(cdpPort)} 被其他进程占用（PID ${String(holder.pid)}${holder.name === undefined ? '' : ` ${holder.name}`}）—— 绑定竞争失败，未连接其他实例`)
        break
      }
      if (Date.now() >= cdpDeadline) { problems.push(`CDP 端口 ${String(cdpPort)} 在 30s 内没有监听者`); break }
      await sleep(500)
    }
    if (cdpReady) {
      const target = await waitForCdpTarget(cdpPort, Math.min(deadline, Date.now() + 30_000), sleep, fetchImpl)
      if (target === undefined) problems.push(`CDP 已监听但 30s 内没有 dsh-app://app/ target`)
      else log(`CDP target：${target.url}`)
    }
  }

  // 宿主端点：子进程 → LISTENING → 探活。宿主重启（端口消失再出现）也按此重新发现。
  let hostPort
  const hostDeadline = Math.min(deadline, Date.now() + 60_000)
  for (;;) {
    processes = findInstanceProcesses(options.exePath, list())
    const host = processes.host
    if (host !== undefined) {
      const ports = portsOf(host.pid).filter((port) => port !== cdpPort)
      for (const port of ports) {
        if (await probe(port)) { hostPort = port; break }
      }
      if (hostPort !== undefined) break
    }
    if (Date.now() >= hostDeadline) {
      problems.push(host === undefined
        ? '等待超时：没找到 desktop-host 子进程（宿主没起来或已退出）'
        : `等待超时：desktop-host 子进程（PID ${String(host.pid)}）没有 LISTENING 端口或探活失败`)
      break
    }
    await sleep(500)
  }

  const endpoint = hostPort === undefined ? undefined : `http://127.0.0.1:${String(hostPort)}`
  if (endpoint !== undefined) log(`宿主端点（脱敏）：${endpoint}`)
  return {
    ok: problems.length === 0 && endpoint !== undefined,
    problems,
    exePid: processes.main?.pid,
    hostPid: processes.host?.pid,
    hostPort,
    endpoint,
    cdpPort,
    cdpReady,
  }
}

/** HTTP 探活：任何响应都算活着（宿主无 token 时返回 401/303）。 */
export async function defaultProbeHttp(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, { redirect: 'manual' })
    return response.status > 0
  } catch {
    return false
  }
}

async function waitForCdpTarget(port, deadline, sleepFn, fetchImpl = fetch) {
  for (;;) {
    try {
      const list = await (await fetchImpl(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = list.find((target) => target.type === 'page' && String(target.url ?? '').startsWith('dsh-app://app/'))
      if (page !== undefined) return page
    } catch { /* 还没起来 */ }
    if (Date.now() >= deadline) return undefined
    await sleepFn(500)
  }
}

/* ------------------------------------------------------------------ 复制与解压来源 */

/**
 * 把来源物化到目标目录的指定子目录。
 * - zip：走 unzip-portable.py（绑 testzip + NUL 自检），只解指定前缀；
 * - dir：整树 cpSync。
 * 全程只创建不删除；目标必须不存在。
 */
export function materializeSource(source, targetDir, prefix, scriptsRoot) {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
  if (source.kind === 'zip') {
    const result = spawnSync('python', [
      join(scriptsRoot, 'unzip-portable.py'),
      '--zip', source.path,
      '--dir', targetDir,
      '--only-prefix', prefix,
    ], { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`解压 ${prefix} 失败（exit ${String(result.status)}）：${(result.stderr ?? '').trim().slice(0, 300)}`)
    }
    return
  }
  if (source.kind !== 'dir') throw new Error(`未知来源类型：${String(source.kind)}`)
  cpSync(join(source.path, prefix.replace(/\/$/, '')), join(targetDir, prefix.replace(/\/$/, '')), { recursive: true })
}

/** 生产形态 package.json（与 package-plugin-update.mjs 同款：去 devDeps/scripts/fake-llm 导出）。 */
export function productionPackageJson(repoPackage, version) {
  const releasePkg = { ...repoPackage, version }
  releasePkg.exports = { ...repoPackage.exports }
  delete releasePkg.exports['./fake-llm']
  delete releasePkg.devDependencies
  delete releasePkg.scripts
  return releasePkg
}
