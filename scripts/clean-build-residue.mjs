/**
 * 清理构建残留：打包暂存目录（`.desktop-stage*`）+ 缓存目录（`.desktop-base`）。
 *
 * **默认只报告，不动任何文件**；要真删必须显式加 `--yes`。
 *
 * 为什么需要它：这些目录各含一份 `resources\app.asar`，每次都在 600MB 量级。它们删不掉时
 * 的现象很有迷惑性 —— 删除会先成功干掉一万多个文件（`desktop-stage-025` 实测 10359 → 10294），
 * 然后卡在那**一个** `app.asar` 上，报 `EBUSY`；再试连**目录改名**都报 `EPERM`。
 * 这不是权限问题、也不是 safe-delete shim（本机 shim 已用
 * `CODEBUDDY_SAFE_DELETE_ENABLED=0` 关掉），而是**有进程把它内存映射住了**——
 * 典型来源是没关掉的旧 `DeepSeek Harness.exe`（Electron 会 map 住自己的 asar）。
 * 所以先跑一次本脚本看「锁没锁」，锁着的话去关进程（或重启），再跑 `--yes`。
 *
 * 用法:
 *   node scripts/clean-build-residue.mjs          # 只看状态
 *   node scripts/clean-build-residue.mjs --yes    # 真删
 *
 * 删不掉时的正确姿势：`tasklist > /tmp/p.txt && grep -i harness /tmp/p.txt`
 * （注意**别**配 `tasklist //FO CSV` —— CSV 引号会骗过 grep，看着像没有进程）。
 */
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apply = process.argv.slice(2).includes('--yes')

/** 待清项：显式清单，不用通配符（万一以后加了别的 `.desktop-*` 目录也不会被误伤）。 */
const targets = [
  join(ROOT, '.desktop-stage'),
  join(ROOT, '.desktop-stage-024'),
  join(ROOT, '.desktop-stage-025'),
  join(ROOT, '.desktop-stage-025b'),
  join(ROOT, '.desktop-stage-probe'),
  join(ROOT, '.desktop-base'),
]

/** 递归统计文件数与总字节数。 */
function measure(path) {
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else {
        files += 1
        try {
          bytes += statSync(child).size
        } catch {
          // 读不到大小不影响计数；锁住的文件照样算。
        }
      }
    }
  }
  walk(path)
  return { files, bytes }
}

/**
 * 探测「这个目录能不能被删」：对一个真实子文件（优先 `resources\app.asar`）做改名往返。
 *
 * 判据用改名而不是删除：改名的失败码在「被映射住」时是 `EBUSY`/`EPERM`，
 * 而且**改名往返不留痕迹**（删了就真没了，探测不能有副作用）。
 */
function probeLock(path) {
  for (const rel of ['app/resources/app.asar', 'resources/app.asar']) {
    const file = join(path, rel)
    if (!existsSync(file)) continue
    const back = `${file}.lockprobe`
    try {
      renameSync(file, back)
      renameSync(back, file)
      return undefined
    } catch (error) {
      try {
        if (existsSync(back)) renameSync(back, file)
      } catch {
        // 回不去也没关系：探测本来就是可逆操作，回不去说明锁得更死。
      }
      return `${error.code ?? ''} ${rel}`
    }
  }
  return undefined
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const present = targets.filter(existsSync)
if (present.length === 0) {
  console.log('没有构建残留可清 —— 干净。')
  process.exit(0)
}

console.log(apply ? '开始清理（--yes）\n' : '只报告，不动文件（加 --yes 才真删）\n')

let removed = 0
let freed = 0
const blocked = []
for (const path of present) {
  const { files, bytes } = measure(path)
  const lock = probeLock(path)
  const label = `${path.replace(`${ROOT}\\`, '')}（${files} 个文件 / ${human(bytes)}）`
  if (lock !== undefined) {
    console.log(`锁住 ⊘  ${label}\n         ↳ ${lock}`)
    blocked.push({ path, lock })
    continue
  }
  if (!apply) {
    console.log(`可删 ✓  ${label}`)
    continue
  }
  try {
    rmSync(path, { recursive: true, force: true })
    console.log(`已删 ✓  ${label}`)
    removed += 1
    freed += bytes
  } catch (error) {
    console.log(`删不掉 ${error.code ?? ''}  ${label}`)
    blocked.push({ path, lock: error.code ?? '' })
  }
}

console.log('')
if (!apply) {
  console.log(`可删 ${present.length - blocked.length} 项，锁住 ${blocked.length} 项。`)
} else {
  console.log(`已删 ${removed} 项，释放约 ${human(freed)}；失败 ${blocked.length} 项。`)
}
if (blocked.length > 0) {
  console.log('被映射住的项要等占用进程退出（关掉旧实例，或重启）后再跑一次；')
  console.log('查占用：tasklist > /tmp/p.txt && grep -i harness /tmp/p.txt')
  process.exit(1)
}
