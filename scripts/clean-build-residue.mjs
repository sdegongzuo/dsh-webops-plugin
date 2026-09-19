/**
 * 清理构建残留：打包暂存目录（`.desktop-stage*`）+ 缓存目录（`.desktop-base`）。
 *
 * **默认只报告，不动任何文件**；要真删必须显式加 `--yes`。
 *
 * ⚠️ **删 `.desktop-base` 的代价比从前大**：它现在按 dsh 版本分槽存本体
 * （`.desktop-base/<dsh 版本>/app`，每份解压 1.2G，还带 `cache.json` 完成标记）。
 * 删掉之后下次打包必须重编 dsh（十几分钟的 electron-builder）或重新入库一份。
 * 只想清「某个坏槽」就别用本脚本，直接删那个 `<版本>` 目录。
 *
 * 为什么需要它：这些目录各含一份 `resources\app.asar`，每次都在 600MB 量级。它们删不掉时
 * 的现象很有迷惑性 —— 删除会先成功干掉一万多个文件（`desktop-stage-025` 实测 10359 → 10294），
 * 然后卡在那**一个** `app.asar` 上，报 `EBUSY`；再试连**目录改名**都报 `EPERM`。
 * 这不是权限问题、也不是 safe-delete shim（**锁**跟垫片无关；垫片是另一个坑，见下一段）。
 *
 * **真凶是 IDE，不是杀毒软件**（2026-09-19 用 `scripts/who-locks.ps1` 点名纠正，
 * 此前两天一直误记成「常驻安全软件套件给每个新出现的 `app.asar` 挂独占句柄」）：
 * VS Code 系 IDE（`WorkBuddy.exe` / `Qoder CN`）把 asar 当**可解析的归档格式**去打开解析，
 * 句柄不带 `FILE_SHARE_DELETE` 且**不释放**（与 IDE 同生共死）—— 只挡改名与删除，
 * 共享读和原地位写通畅。触发条件是「**在工作区内** 且 **内容真能解析成 asar 归档**」：
 * 工作区内 40 个 `.asar` 锁住 39 个（唯一没锁的是内容全零、解析不成归档的那个），
 * 工作区外的同内容文件 180 秒全程无人碰。
 * → **根治法是把大件挪出工作区**：把 `DSH_DESKTOP_BUILD_ROOT` 指到工作区外
 * （本机写在 `.env.local`，模板 `.env.local.example`；见下面 `BUILD_ROOT`）。
 *
 * ⚠️ **另一个会让本脚本「看起来卡死」的东西是安全删除垫片**（2026-09-19 实测）：
 * 本机 `CODEBUDDY_SAFE_DELETE_ENABLED=1` 时，**每个** `unlink` 要 **450ms**
 * （新建 0.5ms、读取 0.1ms，只有删除慢 → 是删除专属钩子，不是磁盘/杀软的问题）。
 * 于是删两万个文件要几小时，中途文件数看着一动不动，极易误判成卡死。
 * 置 `0` 后同一批删除是 **0.4ms/个，差 1130 倍**。
 * 陷阱：垫片在 **require 期**读 env，进程内 `process.env.X='0'` 无效（实测仍 470ms/个），
 * 所以本脚本在 `--yes` 下**换一个进程重跑自己**（见下面 `reexecWithoutSafeDelete`）。
 *
 * 用法:
 *   node scripts/clean-build-residue.mjs          # 只看状态
 *   node scripts/clean-build-residue.mjs --yes    # 真删（会自动关掉安全删除垫片）
 * 扫哪个根取自 `DSH_DESKTOP_BUILD_ROOT`（本机写在 `.env.local`）；临时换一次就带前缀，
 * 例如 `DSH_DESKTOP_BUILD_ROOT=<工作区外的目录> node scripts/clean-build-residue.mjs --yes`。
 *
 * 查持有者用 `powershell -File scripts/who-locks.ps1 -Path '<glob>' -OutFile <路径>`
 * （别用 `tasklist //FO CSV` + grep —— CSV 引号会骗过 grep，看着像没有进程；
 *  也别用 `Get-CimInstance … CommandLine -like '*xxx*'` —— 过滤串本身就在自己进程的命令行里，
 *  而且本机 `Get-CimInstance Win32_Process` 本来就静默失败）。
 */
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRoot } from './local-env.mjs'

/**
 * 扫哪个根找残留。默认仓库根；`DSH_DESKTOP_BUILD_ROOT`（本机写在 `.env.local`）指到
 * 工作区外就跟着跑 —— 大件搬到工作区外之后，残留也跟着在那儿，
 * 不认这个变量就等于「报告干净、其实一堆躺外面」。
 *
 * ⚠️ 注意：**只扫 BUILD_ROOT 一个根**。两种根混用（工作区里留一半、外面放一半）时，
 * 得跑两次、各带一次变量，本脚本不做合并 —— 与其猜，不如让调用方说清楚。
 * 取值统一走 `local-env.mjs` 的 `buildRoot()`（与 `package-desktop-portable.mjs` 同源）。
 */
const BUILD_ROOT = buildRoot()
const apply = process.argv.slice(2).includes('--yes')

/** 安全删除垫片的开关名（WorkBuddy CLI 通过 `NODE_OPTIONS=--require=…node-language-shim.cjs` 注入）。 */
const SAFE_DELETE_FLAG = 'CODEBUDDY_SAFE_DELETE_ENABLED'

/**
 * 关掉安全删除垫片并重跑自己。
 *
 * 不这么做的话，垫片会把每个 `unlink` 变成 ~450ms 的慢操作（原因见文件头），
 * 一次全量清理要跑几小时 —— 而调用方完全看不出哪里不对（输出要等整项做完才有一行）。
 * 垫片是在 `require` 期读的 env，所以**只能换进程**，不能在进程内改。
 * 只在 `--yes`（真要删东西）时重跑；只看状态时没必要，也少一层「脚本偷偷重启自己」的意外。
 */
function reexecWithoutSafeDelete() {
  if (!apply || process.env[SAFE_DELETE_FLAG] === '0') return
  console.log(`安全删除垫片开着（${SAFE_DELETE_FLAG}=${process.env[SAFE_DELETE_FLAG] ?? '未设置'}）：`
    + '实测每个文件删除约 450ms，关掉后 0.4ms —— 本脚本要删几万个文件。')
  console.log('换一个关掉垫片的进程重跑本脚本。\n')
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [SAFE_DELETE_FLAG]: '0' },
  })
  process.exit(result.status ?? 1)
}

reexecWithoutSafeDelete()


/**
 * 待清项：扫仓库根，按**显式前缀清单**匹配。
 *
 * 既不用 `.desktop-*` 这种宽通配（以后新增的别的 `.desktop-*` 目录会被误伤），
 * 也不像旧版那样把目录名一个个写死 —— 2026-09-19 实测根目录堆了 **19 个**残留目录，
 * 而写死的清单只覆盖其中 6 个，于是跑完会看到「已清干净」而其实还有 13 个躺着。
 *
 * ⚠️ **`.desktop-base` 必须拆成子项，不能整目录当成一个目标**：它里面既有该清的旧缓存
 * （单坑时代的 `app`、失败改名的 `app.new`），也有**必须留着**的本体缓存槽
 * （`<dsh 版本>/app` + `cache.json`，1.2G 且重编一次要十几分钟）。而 `--yes` 下的「瘦身」
 * 会删掉除被锁文件以外的一切 —— 拿整目录当目标等于把好缓存一起收走。
 */
const RESIDUE_PREFIXES = ['.desktop-stage', '.desktop-base', '.rel-verify']
/** 与 `package-desktop-portable.mjs` 的 CACHE_MARKER 同名（那边是唯一写它的地方）。 */
const CACHE_MARKER = 'cache.json'

/**
 * 判「这个子目录是不是要留着」的本体缓存槽。
 *
 * 两个判据取或：`cache.json` 完成标记，**或者** `app/` 下真有主 exe。
 * 取或而不是只认标记，是因为这里判错的代价不对称 —— 误判成「该清」会把 1.2G 缓存收走，
 * 误判成「该留」只是少清一个目录。所以标记被改名了也还有第二道兜底。
 * @param slotDir - `.desktop-base` 下的一个子目录。
 */
function isProtectedSlot(slotDir) {
  if (existsSync(join(slotDir, CACHE_MARKER))) return true
  const app = join(slotDir, 'app')
  if (!existsSync(app)) return false
  try {
    return readdirSync(app).some(name => name.endsWith('.exe'))
  } catch {
    return false
  }
}

/**
 * 收集待清项。`.desktop-base` 的子目录里，缓存槽只收它自己的 `app.new` / `app.retired`
 * 历史残留（本体不动），非缓存槽整目录收。
 * @returns 排序后的绝对路径列表（可能不存在，调用方再 `filter(existsSync)`）。
 */
function collectTargets() {
  const out = []
  for (const entry of readdirSync(BUILD_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(BUILD_ROOT, entry.name)
    if (entry.name === '.desktop-base') {
      let slots = []
      try {
        slots = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const slot of slots) {
        const slotDir = join(dir, slot.name)
        if (!slot.isDirectory()) continue
        if (!isProtectedSlot(slotDir)) {
          out.push(slotDir)
          continue
        }
        for (const suffix of ['app.new', 'app.retired']) {
          const leftover = join(slotDir, suffix)
          if (existsSync(leftover)) out.push(leftover)
        }
      }
      continue
    }
    if (RESIDUE_PREFIXES.some(prefix => entry.name.startsWith(prefix))) out.push(dir)
  }
  return out.sort()
}

const targets = collectTargets()

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
 * 在这些残留目录里找第一个 `app.asar`（广度优先、深度 ≤3）。
 *
 * 深度 3 是为了同时覆盖三种布局：`resources/app.asar`（asar 布局）、
 * `app/resources/app.asar`（win-unpacked / 暂存目录）、
 * `<dsh 版本>/app/resources/app.asar`（分槽后的本体缓存）。
 * 旧版只试前两种相对路径，于是版本槽永远探不出锁、被误报成「可删」。
 *
 * @param path - 残留目录。
 * @returns `app.asar` 的绝对路径；找不到则 `undefined`。
 */
function findAppAsar(path) {
  const queue = [{ dir: path, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    const direct = join(dir, 'app.asar')
    if (existsSync(direct)) return direct
    if (depth >= 3) continue
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 读不动的子树跳过；锁探测本来就有兜底
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
    }
  }
  return undefined
}

/**
 * 探测「这个目录能不能被删」：对真实存在的 `app.asar` 做改名往返。
 *
 * 判据用改名而不是删除：改名的失败码在「被独占句柄占住」时是 `EBUSY`/`EPERM`，
 * 而且**改名往返不留痕迹**（删了就真没了，探测不能有副作用）。
 */
function probeLock(path) {
  const file = findAppAsar(path)
  if (file === undefined) return undefined
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
    return `${error.code ?? ''} ${file.replace(`${BUILD_ROOT}\\`, '')}`
  }
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 把一棵「有文件被独占句柄占住」的目录尽量瘦身：自底向上删，删得掉的都删，
 * 删不掉的（连同它们的祖目录）留着。
 *
 * **为什么需要它**（2026-09-19）：本机常驻的扫描器会给每个新出现的 `app.asar` 挂独占句柄，
 * 而且这个句柄**不会因为源进程退出而消失**（实测：截断成 0 字节后仍然 `EBUSY`，
 * 存量文件能挂好几天）。于是这些 240MB~1.2GB 的残留目录**永远**删不干净，
 * 旧版脚本对它们只能报一句「锁住 ⊘」然后什么都不做 —— 磁盘一直不降。
 * 但锁只作用在那**一个**文件上：整棵树里另外几万个文件都是可删的。
 * 把它们收回来，能把残留从 GB 级降到 MB 级（每个目录只剩它那个 `<dir>/resources/app.asar`）。
 * @param root - 残留目录。
 * @returns `{ freed, kept }`，`kept` 是被锁住而留下的路径。
 */
function shrinkLocked(root) {
  const kept = []
  let freed = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      kept.push(dir)
      return false
    }
    let allGone = true
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!walk(child)) allGone = false
        continue
      }
      let size = 0
      try {
        size = statSync(child).size
      } catch {
        // 读不到大小不影响删除
      }
      try {
        rmSync(child, { force: true })
        freed += size
      } catch {
        kept.push(child)
        allGone = false
      }
    }
    if (allGone) {
      try {
        rmSync(dir, { force: true })
      } catch {
        // 空目录删不掉也无所谓，反正不占空间
      }
    }
    return allGone
  }
  walk(root)
  return { freed, kept }
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
  // 真删模式下先报「正在处理哪一项」再动手：`measure`/`probeLock` 之后才出结果行，
  // 而大目录（两万多个文件）在 `--yes` 下一项就能跑几十秒 —— 没有这行前置，
  // 中途卡住时输出全是空的，看不出到底停在哪一项上（2026-09-19 实测踩过）。
  if (apply) console.log(`处理…    ${path.replace(`${BUILD_ROOT}\\`, '')}`)
  const { files, bytes } = measure(path)
  const lock = probeLock(path)
  const label = `${path.replace(`${BUILD_ROOT}\\`, '')}（${files} 个文件 / ${human(bytes)}）`
  if (lock !== undefined) {
    blocked.push({ path, lock })
    if (!apply) {
      console.log(`锁住 ⊘  ${label}\n         ↳ ${lock}`)
      continue
    }
    // `--yes` 下不再跳过：锁只在那一个文件上，其余的照样收回来。
    const shrunk = shrinkLocked(path)
    freed += shrunk.freed
    console.log(`已瘦身 ◐  ${label} —— 腾出 ${human(shrunk.freed)}，`
      + `留下 ${shrunk.kept.length} 个被锁文件\n         ↳ ${lock}`)
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
  if (blocked.length > 0) console.log('加 --yes 会把「锁住」的那些也尽量瘦身（锁只在一个文件上）。')
} else {
  console.log(`整目录删掉 ${removed} 项；瘦身 ${blocked.length} 项；合计释放约 ${human(freed)}。`)
}
if (blocked.length > 0) {
  console.log('')
  console.log('剩下的都是被独占句柄占住的 app.asar（本机常驻扫描器加的锁，源进程退出也不会释放）。');
  console.log('它们删不掉也改不了名，但**目录名和后缀已经不构成任何语义**：');
  console.log('  · 判断「缓存能不能用」看的是 <槽>/cache.json 完成标记，不是目录在不在；');
  console.log('  · 想彻底清掉只能等重启后立刻跑本脚本 --yes（趁扫描器还没挂上锁）。');
  console.log('查残留进程：tasklist > /tmp/p.txt && grep -i harness /tmp/p.txt');
  process.exit(1)
}
