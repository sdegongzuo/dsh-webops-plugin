#!/usr/bin/env node
/**
 * 便携包 app 瘦身：清理重复的 pnpm 运行时、语言包只留中英文。
 *
 * 背景（2026-10-14 实测 v0.2.14-rc.0 便携包）：
 * - 上游基包把同一份 pnpm 11.7.0 打了两处：
 *   `resources/runtime/pnpm/`（旧布局残留，约 18MB）与
 *   `resources/runtime/primary-runtime/dependencies/pnpm/`（现行布局）。
 *   宿主代码只认后者：dsh-sandbox-local 注释明写
 *   "ships a real node ... `resources/runtime/primary-runtime/dependencies/node/bin`"，
 *   dsh-desktop-host 的 office 插件 source 也是 `join(runtimeDir, "..", "runtime", "primary-runtime")`。
 *   `desktop-runtime.json` 的 files 清单一共 13278 条，全部在 node_modules 下，
 *   不覆盖 runtime/ 任何路径 —— 删旧布局那份不影响 verify:portable 的 sha256 校验。
 * - Chromium 语言包 55 个共 48MB，按需只保留 en-US（Electron 回退基准）+ zh-CN。
 *
 * 安全口径：
 * - 只在**暂存副本**上运行（package-release-portable 与 package-desktop-portable 都是
 *   拷贝完 app 之后、zip 之前调用），输入 app 不动。
 * - 删旧布局 pnpm 前必须证明它与现行布局**逐字节相同**（全量 md5），有一处不同就中止，
 *   绝不「猜一个删一个」——上游哪天把两份做成有差异的，静默删错就是运行时缺件。
 * - 白名单语言包必须全部存在，缺一个就中止：Electron 找不到 en-US 会回退到内置默认，
 *   找不到 zh-CN 则中文用户界面变英文，这是可见的行为回退，不能静默发生。
 * - 上游若已修掉重复（只有一处 pnpm），本脚本按「无可清理」正常退出，不算失败。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const allowed = ['--app']
function required(args, flag) {
  const index = args.indexOf(flag)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw Error(`缺少 ${flag} 的值`)
  if (args.lastIndexOf(flag) !== index) throw Error(`参数重复：${flag}`)
  return args[index + 1]
}

/** 保留的语言包：en-US 是 Electron 的回退基准，zh-CN 是默认用户语言。 */
const KEEP_LOCALES = ['zh-CN.pak', 'en-US.pak']
/** 旧布局残留的一份 pnpm（相对 app 目录）。 */
const LEGACY_PNPM = join('resources', 'runtime', 'pnpm')
/** 现行布局的一份 pnpm（相对 app 目录），宿主实际使用的位置。 */
const CANONICAL_PNPM = join('resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm')

function dirSize(dir) {
  let total = 0
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const info = statSync(full)
      if (info.isDirectory()) walk(full)
      else total += info.size
    }
  }
  walk(dir)
  return total
}

/** 递归列出目录下所有文件（相对路径 + 大小），用于两棵树的逐字节比对。 */
function inventory(dir) {
  const files = new Map()
  const walk = (current, prefix) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const info = statSync(full)
      if (info.isDirectory()) walk(full, rel)
      else files.set(rel, info.size)
    }
  }
  walk(dir, '')
  return files
}

function md5Of(file) {
  return createHash('md5').update(readFileSync(file)).digest('hex')
}

function slimLocales(app, excluded) {
  const dir = join(app, 'locales')
  if (!existsSync(dir)) return { removed: 0, bytes: 0, missing: [] }
  const missing = KEEP_LOCALES.filter(name => !existsSync(join(dir, name)))
  if (missing.length > 0) {
    throw Error(`locales 缺少保留语言包：${missing.join(', ')} —— 白名单不齐全就中止，不做静默行为回退`)
  }
  let removed = 0
  let bytes = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.pak') || KEEP_LOCALES.includes(name)) continue
    const full = join(dir, name)
    if (!statSync(full).isFile()) continue
    bytes += statSync(full).size
    if (excluded) excluded.add(full)
    else rmSync(full)
    removed += 1
  }
  return { removed, bytes, missing: [] }
}

function slimLegacyPnpm(app, excluded) {
  const legacy = join(app, LEGACY_PNPM)
  if (!existsSync(legacy)) return { removed: false, reason: '无旧布局 pnpm（上游已修复或基包不同）', bytes: 0 }
  const canonical = join(app, CANONICAL_PNPM)
  if (!existsSync(canonical)) {
    throw Error(`发现旧布局 pnpm 但找不到现行布局 ${CANONICAL_PNPM} —— 布局与预期不符，拒绝盲删`)
  }
  // 先比文件集合，再逐文件比 md5：集合不同直接中止（可能一方是多平台增量），
  // md5 不同同样中止 —— 证明不了逐字节相同，就没有删除的依据。
  const legacyFiles = inventory(legacy)
  const canonicalFiles = inventory(canonical)
  const onlyLegacy = [...legacyFiles.keys()].filter(name => !canonicalFiles.has(name))
  const onlyCanonical = [...canonicalFiles.keys()].filter(name => !legacyFiles.has(name))
  if (onlyLegacy.length > 0 || onlyCanonical.length > 0) {
    throw Error(`两份 pnpm 文件集合不一致（仅旧布局 ${String(onlyLegacy.length)} 个 / 仅现行布局 ${String(onlyCanonical.length)} 个），拒绝删除`)
  }
  for (const [name, size] of legacyFiles) {
    if (canonicalFiles.get(name) !== size) throw Error(`两份 pnpm 中 ${name} 大小不同，拒绝删除`)
    if (md5Of(join(legacy, name)) !== md5Of(join(canonical, name))) {
      throw Error(`两份 pnpm 中 ${name} 内容不同（md5），拒绝删除`)
    }
  }
  const bytes = dirSize(legacy)
  const count = legacyFiles.size
  if (excluded) excluded.add(legacy)
  else rmSync(legacy, { recursive: true, force: true })
  return { removed: true, reason: `旧布局 pnpm 与现行布局逐字节相同（${String(count)} 个文件 md5 全同），已删`, bytes }
}

/**
 * 对一个 app 目录执行瘦身。导出供单测与打包脚本共用；CLI 只是薄壳。
 * @returns {{ locales: { removed: number, bytes: number }, legacyPnpm: { removed: boolean, reason: string, bytes: number } }}
 */
export function slimApp(app) {
  if (!existsSync(app) || !statSync(app).isDirectory()) throw Error(`app 目录不存在：${app}`)
  return { locales: slimLocales(app), legacyPnpm: slimLegacyPnpm(app) }
}

/** 只读核验复制排除项；返回cpSync过滤器，不删除、覆盖或移动输入文件。 */
export function planSlimAppCopy(app) {
  if (!existsSync(app) || !statSync(app).isDirectory()) throw Error(`app 目录不存在：${app}`)
  const excluded = new Set()
  const locales = slimLocales(app, excluded)
  const legacyPnpm = slimLegacyPnpm(app, excluded)
  return {
    excluded: [...excluded].map(path => relative(app, path)),
    skippedBytes: locales.bytes + legacyPnpm.bytes,
    filter: path => ![...excluded].some(exclude => path === exclude || path.startsWith(exclude + sep)),
  }
}

function main() {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 2) if (!allowed.includes(args[i])) throw Error(`未知参数：${args[i]}`)
  const app = required(args, '--app')
  const result = slimApp(app)
  const savedMB = (result.locales.bytes + result.legacyPnpm.bytes) / 1048576
  console.log(JSON.stringify({
    app,
    locales: { kept: KEEP_LOCALES, removed: result.locales.removed, removedMB: Number((result.locales.bytes / 1048576).toFixed(1)) },
    legacyPnpm: { removed: result.legacyPnpm.removed, reason: result.legacyPnpm.reason, removedMB: Number((result.legacyPnpm.bytes / 1048576).toFixed(1)) },
    savedMB: Number(savedMB.toFixed(1)),
  }))
}

/** CLI 入口带直跑守卫：打包脚本直接 `import { slimApp }` 复用逻辑，不再开子进程。 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    console.error(`slim-portable-app: ${error.message}`)
    process.exitCode = 1
  }
}
