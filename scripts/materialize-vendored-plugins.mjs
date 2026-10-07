/**
 * 把 vendor/plugins/manifest.json 里登记的第三方插件与其运行时依赖物化为
 * profile node_modules 下的**真实文件**（symlink 会被桌面端校验直接拒）。
 *
 * 设计要点：
 *  · tarball 一律先做 sha512 校验（manifest.integrity，与 npm registry 的
 *    dist.integrity 逐字节一致）再解包 —— vendor 里的 tgz 被篡改/截断时在这里爆，
 *    而不是打包出一份带着坏插件的 zip。
 *  · 解包是纯 Node（zlib + 512 字节 tar 头解析），不依赖外部 tar —— Windows 自带
 *    bsdtar 但 spawn('tar') 在无 shell 的 Node 子进程里不保证命中 PATH。
 *  · 运行时依赖（如 dsh-context 的 zod）按 npm 的嵌套规则落在
 *    node_modules/<插件>/node_modules/<依赖>/ —— profile 顶层 node_modules
 *    只出现「登记过的插件」，语义与「dependencies = 插件注册表」一致。
 *
 * 用法：
 *   node scripts/materialize-vendored-plugins.mjs --profile-dir <profile 目录>
 *   node scripts/materialize-vendored-plugins.mjs --check   # 只校验 vendor 完整性，不写盘
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'plugins')

/* ---------- 参数 ---------- */

const args = process.argv.slice(2)
function readArg(name) {
  const index = args.indexOf(`--${name}`)
  return index !== -1 ? args[index + 1] : undefined
}
const profileDirArg = readArg('profile-dir')
const checkOnly = args.includes('--check')

/* ---------- 校验与解包 ---------- */

function verifyTarball(tarball, expectedIntegrity) {
  const body = readFileSync(tarball)
  const actual = 'sha512-' + createHash('sha512').update(body).digest('base64')
  if (actual !== expectedIntegrity) {
    throw new Error(`sha512 不匹配：${tarball}\n  期望 ${expectedIntegrity}\n  实际 ${actual}`
      + '\n  vendor 里的 tgz 与 manifest 登记不一致 —— 换包必须连校验值一起换。')
  }
  return body
}

/** 解析 tar 头里的路径（含 pax / GNU longname 扩展），返回 { path, type, data } 数组。 */
function untar(buffer) {
  const entries = []
  let offset = 0
  let pendingPath = undefined // pax('x') 或 GNU longname('L') 给下一个条目的真实路径
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/, ''), 8) || 0
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    let name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('ascii').replace(/\0.*$/, '')
    if (prefix !== '') name = `${prefix}/${name}`
    offset += 512
    const data = size > 0 ? buffer.subarray(offset, offset + size) : Buffer.alloc(0)
    offset += Math.ceil(size / 512) * 512
    if (type === 'x') {
      // pax 扩展头："<len> key=value\n" 的序列，只关心 path=
      const text = data.toString('utf8')
      const pathMatch = text.match(/(?:^|\n)\d+ path=([^\n]*)\n/)
      if (pathMatch) pendingPath = pathMatch[1]
      continue
    }
    if (type === 'L') {
      pendingPath = data.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'g' || type === '3' || type === '4') continue // global header / 卷标，不落地
    entries.push({ path: pendingPath ?? name, type, data })
    pendingPath = undefined
  }
  return entries
}

/**
 * 把 tgz 解到目标目录（npm tarball 顶层是 package/，剥掉）。
 * @returns 解出的 package.json 里读到的 { name, version }。
 */
function extractTarball(tarballBody, targetDir) {
  const entries = untar(gunzipSync(tarballBody))
  if (entries.length === 0) throw new Error(`tarball 解出来是空的：${tarballBody.length} 字节`)
  let meta
  for (const entry of entries) {
    const relative = entry.path.replace(/^\.?\//, '').replace(/^package\//, '')
    if (relative === '' || relative.startsWith('PaxHeader/') || relative.includes('/PaxHeader/')) continue
    const target = join(targetDir, relative)
    if (!target.startsWith(targetDir)) throw new Error(`tarball 含越界路径 ${entry.path}，拒绝解包`)
    if (entry.type === '5') {
      mkdirSync(target, { recursive: true })
    } else if (entry.type === '0' || entry.type === '\0') {
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, entry.data)
      if (relative === 'package.json') meta = JSON.parse(entry.data.toString('utf8'))
    } else {
      console.warn(`  · 跳过不落地的 tar 条目类型 ${typeLabel(entry.type)}：${entry.path}`)
    }
  }
  return meta
}

function typeLabel(type) {
  return type === '2' ? 'symlink' : type === '1' ? 'hardlink' : `type=${type}`
}

/* ---------- 主流程 ---------- */

const manifestPath = join(VENDOR_DIR, 'manifest.json')
if (!existsSync(manifestPath)) throw new Error(`缺少 ${manifestPath} —— vendor 目录不完整`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

// 先整体校验（哪怕只物化一个插件，所有 tgz 的完整性都过一遍 —— 便宜，且坏得早好过坏得晚）
for (const item of [...manifest.plugins, ...manifest.dependencies]) {
  const tarball = join(VENDOR_DIR, item.tarball)
  if (!existsSync(tarball)) throw new Error(`vendor 缺 tarball：${tarball}`)
  verifyTarball(tarball, item.integrity)
}
console.log(`vendor 完整性校验通过（${manifest.plugins.length} 插件 + ${manifest.dependencies.length} 依赖）`)
if (checkOnly) process.exit(0)

if (profileDirArg === undefined) {
  console.error('用法: node scripts/materialize-vendored-plugins.mjs --profile-dir <profile 目录> | --check')
  process.exit(1)
}
const nodeModulesDir = join(resolve(profileDirArg), 'node_modules')
mkdirSync(nodeModulesDir, { recursive: true })

for (const plugin of manifest.plugins) {
  const pluginDir = join(nodeModulesDir, plugin.name)
  if (existsSync(pluginDir)) {
    throw new Error(`${pluginDir} 已存在 —— 物化脚本只负责从零铺；已装目录交给增量更新流程处理，不静默覆盖。`)
  }
  const meta = extractTarball(verifyTarball(join(VENDOR_DIR, plugin.tarball), plugin.integrity), pluginDir)
  if (meta?.name !== plugin.name || meta?.version !== plugin.version) {
    throw new Error(`tarball 身份对不上：期望 ${plugin.name}@${plugin.version}，实际 ${meta?.name}@${meta?.version}`)
  }
  console.log(`+ node_modules/${plugin.name}@${plugin.version}`)

  // 该插件声明的运行时依赖，按 npm 嵌套规则落到插件自己的 node_modules 下
  for (const depName of plugin.runtimeDependencies ?? []) {
    const dep = manifest.dependencies.find(item => item.name === depName)
    if (dep === undefined) throw new Error(`manifest.dependencies 缺 ${depName}（${plugin.name} 声明依赖它）`)
    const depDir = join(pluginDir, 'node_modules', dep.name)
    const depMeta = extractTarball(verifyTarball(join(VENDOR_DIR, dep.tarball), dep.integrity), depDir)
    if (depMeta?.name !== dep.name || depMeta?.version !== dep.version) {
      throw new Error(`依赖 tarball 身份对不上：期望 ${dep.name}@${dep.version}，实际 ${depMeta?.name}@${depMeta?.version}`)
    }
    console.log(`+ node_modules/${plugin.name}/node_modules/${dep.name}@${dep.version}`)
  }
}
