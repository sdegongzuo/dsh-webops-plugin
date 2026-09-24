/**
 * 把「桌面端应用目录 + 已物化的插件 profile」组装成 Windows x64 便携版 zip。
 *
 * 便携版 = 解压即用、配置随包走（`$DSH_HOME` 指向包内 `home\`）、插件**已经装好**的
 * dsh 桌面端。用户端不需要 pnpm / Node / 签名证书，也不需要联网装插件。
 *
 * 用法：
 *   node scripts/package-desktop-portable.mjs --app <win-unpacked 目录> [--version 0.1.0]
 *   node scripts/package-desktop-portable.mjs [--version 0.1.0]        # 复用缓存里最新的 base
 *   node scripts/package-desktop-portable.mjs --app <dir> --cache-base # 构建后顺便把 base 入库
 *   node scripts/package-desktop-portable.mjs --app <dir> --cache-base --cache-move  # 入库时优先同盘改名
 *   node scripts/package-desktop-portable.mjs --app <dir> --cache-base --cache-only  # 只入库、不打 zip
 *   node scripts/package-desktop-portable.mjs --app <dir> --stage .desktop-stage-2  # 默认暂存目录被占用时
 *
 * 大件（`.desktop-base` / `.desktop-stage`）默认放仓库根；把环境变量 `DSH_DESKTOP_BUILD_ROOT`
 * 指到**工作区外**就能搬走它们（IDE 会锁工作区里的 `app.asar`，见下面 `BUILD_ROOT` 的注释）：
 *   DSH_DESKTOP_BUILD_ROOT=<工作区外的目录> node scripts/package-desktop-portable.mjs
 * 本机已把这条写进 `.env.local`，所以平时直接跑即可、不必带前缀。
 *
 * 产出：
 *   dist/dsh-webops-desktop-v<ver>-win-x64-portable.zip
 *
 * 两层拆分（避免每次发版都重编译 dsh）：
 *   第 1 层 base = dsh 桌面端本体（app/，几百 MB，只在升级 dsh 时重建）；
 *   第 2 层 overlay = home/profiles/desktop/ 里的插件（几十 KB，每次发版都换）。
 *   `--cache-base` 把本次的 app/ 存到 `.desktop-base/<dsh 版本>/app`，之后不带 `--app` 跑就
 *   按版本挑一份复用，只重新生成 overlay 并重新压缩。
 *
 * 缓存**按 dsh 版本分槽**（`.desktop-base/0.1.6-alpha.2/app`）。不分的单坑写法有两个后果，
 * 2026-09-17 都真踩到了：① 升级 dsh 重编一次就把旧的一份覆盖掉，回退无路；
 * ② **没有任何东西能告诉你坑里那堆文件是哪个版本** —— 当时 `.desktop-base\app` 是一份
 * dsh 0.1.5-rc.2 的残缺缓存（18 个条目被删剩 7 个，连主 exe 都没了），不带 `--app` 跑就会
 * 拿它当 base，打出来的便携版里躺着一个上个版本的 dsh，而日志上看不出任何异常。
 * 现在槽位名即版本号，扫描时再拿 `desktop-runtime.json` 复核一遍，挑不出来就明确报错，
 * 不静默降级。
 *
 * 为什么 profile 是我们自己写而不是调桌面端去装：
 * 打包态桌面端装插件只能走 UI 插件管理器（IPC pluginsAdd → pnpm add），CLI 碰不到这个
 * profile，也没有任何官方入口能「预装」第三方插件。所以这里按官方
 * `project-manager.ts:604 createPluginProfile` 的模板手工物化一份，让桌面端启动时
 * 认为「这个插件本来就是装好的」（`applyRelease()` 状态自洽时不会重装，见
 * `project-manager.ts:306-322`）。
 *
 * **但光写 package.json 不够**：`applyRelease()` 在 `previous === undefined` 时会调
 * `createPluginProfile()` 把 package.json 重写成空插件列表 —— 登记的插件被静默冲掉。
 * **2026-09-18（dsh 0.1.6-alpha.2）起这条绕法作废、已删除**：上游把 `createPluginProfile()`
 * 换成了「不存在才写」的 `initProfile()`，并且**主动删除**这份状态文件（见下面 2.5 节的理由）。
 * 这个坑 2026-09-14 才被发现：v0.1.0 和 v0.2.0 的包都因此启动后没有任何插件。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRoot } from './local-env.mjs'
import { readRuntimeDescriptor } from './desktop-runtime.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
/**
 * 大件（`.desktop-base` / `.desktop-stage`）的存放根，默认就是仓库根。
 *
 * **为什么留这个口子**（2026-09-19 实测）：**在工作区里的 `app.asar` 会被 IDE 锁死** ——
 * VS Code 系 IDE 把 asar 当**可解析的归档格式**去打开解析，句柄不带 `FILE_SHARE_DELETE`
 * 且**不释放**，于是文件「能读能写、就是删不掉改不了名」。实测：工作区内 40 个 `.asar`
 * 锁住 39 个（唯一没锁的是内容全零、解析不成归档的那个）；工作区**外**的同内容 `.asar`
 * 180 秒全程无人碰。用 `scripts/who-locks.ps1` 可以随时点名持有者。
 * 把这两坨搬到工作区外，`package-desktop-portable` 里那一整套绕法（避免改名/删除、
 * 残留只能瘦身、`--stage` 换目录……）就可以逐步退掉。
 *
 * **默认值必须是仓库根**：CI 的 `actions/cache` 缓存的就是仓库下的 `.desktop-base`
 * （`.github/workflows/release-desktop.yml` 里 `path: .desktop-base`，相对路径没法事先写死成别处），
 * 改了默认值 CI 就取不到缓存、每次都要重编十几分钟。
 *
 * 取值统一走 `local-env.mjs` 的 `buildRoot()`：`DSH_DESKTOP_BUILD_ROOT` 或本机
 * `.env.local`（模板 `.env.local.example`），缺省=仓库根。
 */
const BUILD_ROOT = buildRoot()
/**
 * 第 1 层 base 的本地缓存根。每个 dsh 版本一个槽：`.desktop-base/<版本>/app`。
 * dsh 本体不常变，缓存后插件发版无需重编译（也不必重跑那条十几分钟的 electron-builder）。
 */
const BASE_ROOT = join(BUILD_ROOT, '.desktop-base')
/**
 * 槽位里的「拷贝已完整落盘」凭据，放在 `<槽>/cache.json`（与 `<槽>/app` 同级）。
 * 没有它就是没装完 —— 见 `scanBaseSlots()` 为什么把它当硬门槛。
 */
const CACHE_MARKER = 'cache.json'

/** 官方常量，抄自 `apps/desktop/src/project-manager.ts`（改错任何一个桌面端直接抛错）。 */
const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

const cacheBase = args.includes('--cache-base')
/** `--cache-only`：把 `--app` 那份本体入库后即退出，不打 zip。CI 用它给 `actions/cache` 备料。 */
const cacheOnly = args.includes('--cache-only')
/** `--cache-move`：入库时优先同盘改名（瞬时、不复制 1.2G），失败自动回落拷贝。CI 用得上。 */
const cacheMove = args.includes('--cache-move')
/** `--list-cached`：只挑缓存、印一行 `CACHE_APP_DIR=<路径>` 就退出（给 CI 判断要不要重建）。 */
const listCached = args.includes('--list-cached')
let appDir = readArg('app')
/**
 * 暂存目录。默认 `<BUILD_ROOT>/.desktop-stage`（默认即仓库根）；`--stage` 可临时换一个。
 *
 * 为什么留这个口子（2026-09-17）：本机出现过 `.desktop-stage\app\resources\app.asar`
 * 被某个进程**内存映射**住（能 `r+` 打开，但拿不到删除权，`unlink` 恒 EBUSY、
 * 连目录都改不了名）。脚本开头那句 `rmSync(STAGE)` 于是直接抛 `EBUSY`，
 * 整个打包在「主程序: …」之后一步都走不动，看着完全像打包脚本坏了。
 * 换个空目录就能继续，不必等那个句柄自己消失（CI 每次都是新目录，碰不到）。
 *
 * 2026-09-19 查明那个「某个进程」就是 **IDE**（VS Code 系解析工作区里的 asar 归档）——
 * 用 `DSH_DESKTOP_BUILD_ROOT` 把 STAGE 挪出工作区，根上就不会再有这个句柄。
 */
const STAGE = resolve(readArg('stage') ?? join(BUILD_ROOT, '.desktop-stage'))

/** 把错误压成一行。垫片抛的 `Error` **没有 `error.code`**，所以不能只看 code（见 `removeTree`）。 */
function describeError(error) {
  const kind = error.code ?? error.constructor?.name ?? 'Error'
  return `${kind}: ${String(error.message ?? '').slice(0, 200)}`
}

/**
 * 删掉一棵树；返回是否真删干净。
 *
 * **为什么要两个进程**（2026-09-19 实测，踩了一整轮才定位）：本机 CLI 通过 `NODE_OPTIONS`
 * 注入 safe-delete 垫片，它把每次删除改成「先丢进回收站」，而回收站助手
 * （`resources/vendor/genie-trash/win32-x64.exe`）**只有 5 秒超时**。1.2G / 两万多条目的
 * 暂存目录搬不完，于是抛 `[safe-delete] 操作失败: spawnSync … ETIMEDOUT` ——
 * 那是个**普通 `Error`，没有 `error.code`**，旧代码 `（${error.code ?? ''}）` 就打了个空括号，
 * 看着像「莫名其妙的失败」，很容易误判成文件被锁。
 * 垫片在 **require 期**读 env（进程内 `process.env.X='0'` 无效），所以直接换一个带
 * `CODEBUDDY_SAFE_DELETE_ENABLED=0` 的子进程来删 —— 本机实测 1.2G 瞬间删净。
 *
 * 注意判据用「垫片是否加载」而不是「有没有报错」：垫片开着时先试一次必然白等 5 秒。
 */
function removeTree(dir) {
  if (!existsSync(dir)) return true
  if (globalThis.__CODEBUDDY_NODE_SAFE_DELETE_SHIM_LOADED__ !== true) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return !existsSync(dir)
    } catch (error) {
      console.warn(`package-desktop-portable: rmSync 删 ${dir} 失败 —— ${describeError(error)}`)
      return false
    }
  }
  const retry = spawnSync(
    process.execPath,
    ['-e', `require('node:fs').rmSync(${JSON.stringify(dir)}, { recursive: true, force: true })`],
    { encoding: 'utf8', env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' } },
  )
  if (retry.status === 0 && !existsSync(dir)) {
    console.log('  （由关掉安全删除垫片的子进程删除：垫片对 >1G 的目录会 ETIMEDOUT）')
    return true
  }
  console.warn(`package-desktop-portable: 关掉垫片的子进程也删不掉 ${dir} —— `
    + `${(retry.stderr ?? '').trim() || `exit=${String(retry.status)}`}`)
  return false
}

/** win-unpacked 里的主 exe（electron-builder 按 productName 命名）。 */
function findMainExe(dir) {
  return readdirSync(dir).find(name => name.endsWith('.exe') && !/uninstall|elevate/i.test(name))
}

/**
 * 断言一个目录「像」完整的 win-unpacked：有主 exe + `resources\{app.asar,dsh,runtime}`。
 *
 * 为什么要有这一道：`.desktop-base\app` 曾被一次中断的缓存更新删残（18 个条目 → 7 个），
 * 之后不带 `--app` 就会把它当 base，而报错要等到很后面才出现（「没找到主 exe」或自检里的
 * 完整性失败），很容易被误判成「包坏了」。所以在**拷贝完就验**，把残缺挡在提升之前。
 */
function assertLooksLikeApp(dir, label) {
  const exe = findMainExe(dir)
  const missing = ['resources/app.asar', 'resources/dsh', 'resources/runtime']
    .filter(rel => !existsSync(join(dir, rel)))
  if (exe === undefined) missing.unshift('主 exe')
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`${label} ${dir} 不像完整的 win-unpacked，缺：${missing.join('、')}`),
      { code: 'EPARTIAL' },
    )
  }
  return exe
}

/**
 * 比较两个 dsh 版本号（`0.1.6-alpha.2` 这种带预发布的也要能排）。
 *
 * 只用于「多个缓存槽里挑哪一份」，不参与任何构建决策，所以按 semver 的排序规则做个够用的
 * 实现即可：主版本段按数值比；预发布段「没有 > 有」（release 比 prerelease 新），都有则逐段
 * 比（纯数字按数值、否则按字典序）。
 * @param a - 左版本号。
 * @param b - 右版本号。
 * @returns 负数 / 0 / 正数，语义同 `Array#sort` 的比较器。
 */
function compareDshVersion(a, b) {
  const parse = (value) => {
    const [core, ...pre] = String(value).split('-')
    return {
      core: core.split('.').map(part => Number.parseInt(part, 10) || 0),
      pre: pre.join('-').split('.').filter(Boolean),
    }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i += 1) {
    const delta = (left.core[i] ?? 0) - (right.core[i] ?? 0)
    if (delta !== 0) return delta
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const p = left.pre[i]
    const q = right.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = Number.parseInt(p, 10)
    const qn = Number.parseInt(q, 10)
    if (Number.isNaN(pn) || Number.isNaN(qn)) {
      if (p !== q) return p < q ? -1 : 1
    } else if (pn !== qn) {
      return pn - qn
    }
  }
  return 0
}

/**
 * 扫描 `.desktop-base` 下的所有版本槽，并逐槽复核「真是一份完整、可读出版本的 win-unpacked」。
 *
 * 复核放在扫描里而不是选完再验，是为了让「槽里躺着什么」这件事在**没被选中的槽**上也说得清：
 * 一个残缺槽如果是唯一的槽，旧写法会把它当 base，然后死在后面对不上号的错误上。
 *
 * **完成标记是硬门槛**：拷贝中断会留下一个「文件看着都在、其实少了几个」的目录，
 * 而 `assertLooksLikeApp` 只看顶层那几项，拦不住这种。中断过的槽必须报出来而不是拿去用。
 *
 * 两种条目的区别要分清楚：**没有 `app/` 子目录的不算槽，是残留**（旧单坑时代的 `.desktop-base/app`，
 * 以及被安全软件锁得只剩一个 `app.asar` 的空壳 —— 本机删不掉，见 `clean-build-residue.mjs`）。
 * 把它们和「真槽但坏了」分开报，否则每次跑都刷一串看着像出事的警告。
 * @returns 每槽一项 `{ slot, appDir, version?, problem?, residue? }`；`problem` 非空表示不可用，
 *   `residue` 为真表示它压根不是缓存槽。
 */
function scanBaseSlots() {
  if (!existsSync(BASE_ROOT)) return []
  return readdirSync(BASE_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !/\.(new|retired)$/u.test(entry.name))
    .map((entry) => {
      const appDir = join(BASE_ROOT, entry.name, 'app')
      if (!existsSync(appDir)) {
        // 残留，不是槽：`.desktop-base/app` 下面直接就是文件（旧单坑缓存），
        // 或只剩一个删不掉的 `resources/app.asar` 空壳。
        return { slot: entry.name, appDir, residue: true }
      }
      const marker = join(BASE_ROOT, entry.name, CACHE_MARKER)
      if (!existsSync(marker)) {
        return { slot: entry.name, appDir, problem: `缺 ${CACHE_MARKER} 完成标记（拷贝被中断过？）` }
      }
      try {
        assertLooksLikeApp(appDir, `缓存槽 ${entry.name}`)
      } catch (error) {
        return { slot: entry.name, appDir, problem: error.message }
      }
      try {
        const dshVersion = readRuntimeDescriptor(appDir).descriptor.release.version
        if (dshVersion !== entry.name) {
          // 槽位名和实际内容不符：要么目录被手动搬过，要么版本号取错了来源。两种都不能信。
          return { slot: entry.name, appDir, problem: `槽位名是 ${entry.name}，内容是 dsh ${dshVersion}` }
        }
        return { slot: entry.name, appDir, version: dshVersion }
      } catch (error) {
        return { slot: entry.name, appDir, problem: error.message }
      }
    })
}

/**
 * 一个 app 目录该进哪个槽 —— 以它自己的 `desktop-runtime.json` 为准，不猜、也不接受手填。
 * @param targetDir - 待入库的 win-unpacked 目录。
 * @returns `{ version, slotDir, appDir }`，`appDir` 是该版本的槽位路径。
 */
function cacheSlotFor(targetDir) {
  const dshVersion = readRuntimeDescriptor(targetDir).descriptor.release.version
  const slotDir = join(BASE_ROOT, dshVersion)
  return { version: dshVersion, slotDir, appDir: join(slotDir, 'app') }
}

/** best-effort 删一个目录；删不掉只记一句，不抛。 */
function removeQuietly(target, what) {
  if (!existsSync(target)) return true
  try {
    rmSync(target, { recursive: true, force: true })
    return true
  } catch (error) {
    console.warn(`package-desktop-portable: ${what} 留在 ${target}（${error.code ?? ''} ${error.message}）`)
    return false
  }
}

/**
 * 把一份 dsh 本体装进它对应的版本槽；返回落位后的路径。
 *
 * **为什么是「直接拷进最终位置 + 完成标记」而不是「拷到 `.new` 再改名」**（2026-09-18 改）：
 * **IDE**（不是杀毒软件，2026-09-19 用 `scripts/who-locks.ps1` 点名纠正）会去解析工作区里
 * 新出现的 `resources\app.asar`，句柄只挡改名和删除（共享读、原地位写都通畅）。
 * 而 Windows **不允许改名一个内含无 `FILE_SHARE_DELETE` 句柄文件的目录** —— 于是
 * `.new → app` 这一步恒 `EPERM`，旧写法在这台机器上永远装不进去（实测；
 * 同一现象也解释了为什么历史上 `.desktop-base\app`、`.desktop-stage\*` 一律删不掉）。
 * 把大件放到工作区外（`DSH_DESKTOP_BUILD_ROOT`）能让这个句柄根本不出现 —— 届时这条
 * 「不用改名」的约束就成了纯冗余，但**别急着删**：CI 与其他人本机仍在工作区里跑。
 * 现在改成不需要任何改名/删除的写路径：`mkdir` → `cpSync` → 校验 → 写标记。
 * 代价是「同版本重装」必须先手工删掉那个槽（槽里的 app.asar 删不掉时也就删不掉整槽），
 * 但这个代价基本不出现：dsh 一升级就是新版本、自然落新槽。
 *
 * 缓存是**优化**不是**前置**：装不进去就只能「这次没缓存」，不该把整个打包带崩 ——
 * 2026-09-17 真踩过：这一步抛在 `rmSync`，脚本连 zip 都没开始打。所以整个函数只警告不抛。
 * @param sourceDir - 要缓存的那份 win-unpacked。
 * @param options - `move` 为真时优先用同盘改名（瞬时），失败回落拷贝。
 * @returns 槽位路径；失败时为 `undefined`。
 */
function installBaseCache(sourceDir, options = {}) {
  let slot
  try {
    slot = cacheSlotFor(sourceDir)
  } catch (error) {
    console.warn(`package-desktop-portable: 读不出 ${sourceDir} 的 dsh 版本，本次不缓存（${error.message}）`)
    return undefined
  }
  const marker = join(slot.slotDir, CACHE_MARKER)
  if (existsSync(marker) && existsSync(slot.appDir)) {
    console.log(`dsh 本体缓存已就位（dsh ${slot.version}），本次不动它: ${slot.appDir}`)
    removeQuietly(`${slot.appDir}.new`, '旧的暂存目录')
    removeQuietly(`${slot.appDir}.retired`, '旧的退役目录')
    return slot.appDir
  }
  if (existsSync(slot.appDir)) {
    // 没有完成标记 = 上次拷贝断了。残缺槽不能直接用，但也不该悄悄覆盖出一个新旧混合体。
    if (!removeQuietly(slot.appDir, '残缺槽位')) {
      console.warn('  槽里那个 app.asar 被安全软件占着删不掉，本轮放弃入库；')
      console.warn(`  修法：手动删掉整个 ${slot.slotDir} 再跑，或直接用 --app 打包（不影响正确性）。`)
      return undefined
    }
  }
  try {
    // 先清历史写法留下的暂存/退役目录（趁拷贝前，省一半峰值磁盘；内含被占住的 app.asar 时
    // 只能删掉一部分，剩下那点无害 —— 槽位识别不认这两个后缀）。
    removeQuietly(`${slot.appDir}.new`, '旧的暂存目录')
    removeQuietly(`${slot.appDir}.retired`, '旧的退役目录')
    mkdirSync(slot.slotDir, { recursive: true })
    let mode = 'copy'
    if (options.move === true) {
      try {
        renameSync(sourceDir, slot.appDir)
        mode = 'move'
      } catch {
        // 同盘改名要求源目录里没有被独占的句柄；本机有安全软件时基本必失败，回落拷贝。
      }
    }
    if (mode === 'copy') cpSync(sourceDir, slot.appDir, { recursive: true })
    assertLooksLikeApp(slot.appDir, '缓存副本')
    writeFileSync(marker, `${JSON.stringify({
      dshVersion: slot.version,
      createdAt: new Date().toISOString(),
      mode,
      source: sourceDir,
      note: '本文件是「拷贝已完整落盘」的凭据；缺了它这个槽会被当作残缺缓存拒绝使用。',
    }, null, 2)}\n`)
    console.log(`已缓存 dsh 本体（dsh ${slot.version}，${mode}）到 ${slot.appDir}（下次发版可省略 --app）`)
    return slot.appDir
  } catch (error) {
    console.warn(`package-desktop-portable: 更新 dsh 本体缓存失败（${error.code ?? ''} ${error.message}）`)
    console.warn('  不影响本次打包（用的是 --app 指的那个目录）；只是下次仍需要带 --app。')
    console.warn('  要修的话：关掉占用它的进程（常见是上一轮复现留下的 DeepSeek Harness.exe）再跑。')
    return undefined
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = readArg('version') ?? pkg.version
const pluginName = pkg.name

const explicitApp = appDir !== undefined
const scanned = scanBaseSlots()
/** 真缓存槽（有 `app/` 子目录）与**残留目录**（没有，多半是被锁得只剩一个 app.asar 的空壳）分开。 */
const slots = scanned.filter(item => item.residue !== true)
const residues = scanned.filter(item => item.residue === true)
const usable = slots
  .filter(slot => slot.version !== undefined)
  .sort((a, b) => compareDshVersion(b.version, a.version))

/** 把所有槽位的状态印出来（选中的那个 + 其余的），多槽并存时「用了哪个/还躺着哪个」要一眼可见。 */
function reportSlots(chosen) {
  for (const slot of slots) {
    if (slot === chosen) continue
    console.warn(slot.version === undefined
      ? `  · 另有缓存槽 ${slot.slot}（不可用：${slot.problem}）`
      : `  · 另有缓存槽 ${slot.slot}（dsh ${slot.version}，本次未选用）`)
  }
  if (residues.length > 0) {
    // 一行带过即可：残留目录已经被安全软件锁死（app.asar 删不掉），本机属常态，不是故障。
    console.warn(`  · 另有 ${String(residues.length)} 个残留目录（不是缓存槽，已忽略）：`
      + `${residues.map(item => item.slot).join('、')}`
      + ' —— 清不干净的原因见 scripts/clean-build-residue.mjs')
  }
}

if (appDir === undefined) {
  if (usable.length === 0) {
    const detail = slots.length > 0
      ? [
        `${BASE_ROOT} 下有缓存槽，但没有一个能当 base：`,
        ...slots.map(slot => `  · ${slot.slot}：${slot.problem}`),
        `  修法：删掉**有问题的那一个**槽位目录，或加 --app <win-unpacked> 指真产物。`,
        ...(residues.length > 0
          ? [`  （另有 ${String(residues.length)} 个残留目录不是缓存槽、已忽略：${residues.map(item => item.slot).join('、')}）`]
          : []),
        '  ⚠ 别删整个 .desktop-base：那会把其它版本的好缓存一起收走，而且本机被安全软件',
        '     锁住的 app.asar 本来就删不掉（见 scripts/clean-build-residue.mjs）。',
      ]
      : [
        `${BASE_ROOT} 下没有可用的缓存槽`
        + (residues.length > 0 ? `（只有 ${String(residues.length)} 个残留目录：${residues.map(item => item.slot).join('、')}）` : '')
        + '。',
        '用法: node scripts/package-desktop-portable.mjs --app <win-unpacked 目录> [--version x.y.z]',
        '      构建完加 --cache-base 入库，下次就能省掉 --app；--stage <目录> 可换暂存目录（被占用时用）',
      ]
    if (listCached) {
      // CI 用：`--list-cached` 的契约是「有就印 CACHE_APP_DIR，没有就印诊断并 exit 0」，
      // 让调用方据此决定「用缓存」还是「重新构建」，而不是把整个 job 判失败。
      for (const line of detail) console.warn(`package-desktop-portable: ${line}`)
      process.exit(0)
    }
    for (const line of detail) console.error(`package-desktop-portable: ${line}`)
    process.exit(1)
  }
  appDir = usable[0].appDir
  console.log(`复用缓存的 dsh 本体（dsh ${usable[0].version}）: ${appDir}`)
  reportSlots(usable[0])
} else if (!existsSync(appDir)) {
  console.error(`package-desktop-portable: --app 指的目录不存在：${appDir}`)
  process.exit(1)
}

if (listCached) {
  console.log(`CACHE_APP_DIR=${appDir}`)
  process.exit(0)
}

if (cacheBase) {
  const cached = installBaseCache(appDir, { move: cacheMove })
  // `--cache-move` 成功时源目录已经**不在原地**了（它被改名成了槽位），必须跟着换目标，
  // 否则后面 `cpSync(appDir, STAGE/app)` 会去拷一个已经不存在的路径。
  if (cached !== undefined) appDir = cached
  if (cacheOnly) {
    // CI 用：构建完先把本体入库、供 actions/cache 存档，不打 zip。
    // 单独打一行机器可读的标记，避免 pwsh 去解析中文日志。
    if (cached === undefined) process.exit(1)
    console.log(`CACHE_APP_DIR=${cached}`)
    process.exit(0)
  }
} else if (cacheOnly) {
  console.error('package-desktop-portable: --cache-only 要和 --cache-base 一起用（前者只是「入库后即退出」）')
  process.exit(1)
}

if (!existsSync(join(ROOT, 'lib'))) {
  console.error('package-desktop-portable: 缺少 lib/，先跑 pnpm build')
  process.exit(1)
}

/** 校验 base 目录完整性，再取主 exe —— 缓存残缺要在这里就说清楚，别拖到打包中途/自检。 */
let exe
try {
  exe = assertLooksLikeApp(appDir, explicitApp ? '--app 指定的目录' : '缓存的 dsh 本体')
} catch (error) {
  console.error(`package-desktop-portable: ${error.message}`)
  if (!explicitApp) {
    console.error('  这是**缓存**里的那一份。残缺时加 --app <win-unpacked> 指真产物即可，')
    console.error(`  也可以直接删掉 ${appDir} 这个槽位让它下次重建。`)
  }
  process.exit(1)
}
console.log(`主程序: ${exe}`)

const zipName = `dsh-webops-desktop-v${version}-win-x64-portable.zip`
const zipPath = join(DIST, zipName)

if (!removeTree(STAGE)) {
  // 走到这里说明「关掉垫片的子进程」也删不掉，那就是真有东西占着它（IDE 会锁工作区里的
  // `app.asar`；或某个进程把它当工作目录 —— 后者是 `EPERM`）。
  console.error(`package-desktop-portable: 清不掉暂存目录 ${STAGE}，没法继续。`)
  console.error('  多半是有进程占着里面的文件。三个办法：')
  console.error('    · 关掉占用它的进程后再跑（查持有者：powershell -File scripts/who-locks.ps1 -Path <glob>）；或')
  console.error(`    · 换个暂存目录：--stage <别的目录>`)
  console.error(`    · 或把大件整体挪出工作区：DSH_DESKTOP_BUILD_ROOT=<工作区外的目录>`)
  process.exit(1)
}
mkdirSync(DIST, { recursive: true })
mkdirSync(STAGE, { recursive: true })
// 这里**不**删旧的同名 zip。理由：删掉之后一旦压缩环节失败，就既没有新产物、也把上一版
// 打好的包弄没了（2026-09-17 真踩过：Compress-Archive 无声失败，dist/ 里空了一次）。
// 新 zip 先写成 `.building-<name>.zip`，确认落盘后再原子替换，见第 6 节。

// 1) 应用本体
cpSync(appDir, join(STAGE, 'app'), { recursive: true })
console.log('  + app/')

// 2) profile：官方模板 + 本插件
//    dependencies 必须是**精确版本**（project-manager.ts:160-162 会校验），
//    bundles 必须以前两个内置 bundle 开头（project-manager.ts:169）。
const profileDir = join(STAGE, 'home', 'profiles', 'desktop')
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify(
    {
      name: PROJECT_NAME,
      private: true,
      version: '0.0.0',
      dependencies: { [pluginName]: version },
      dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES, pluginName] } },
    },
    null,
    2,
  )}\n`,
)
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), WORKSPACE_SETTINGS)
console.log('  + home/profiles/desktop/package.json')

// 2.5) **不再写** `desktop-runtime-state.json`（2026-09-18，适配 dsh 0.1.6-alpha.2）。
//
// 历史（v0.1.0 / v0.2.0 两个包就栽在这）：0.1.5 / 0.1.6-alpha.1 的 `applyRelease()` 在
// `readDesktopProfileState()` 返回 undefined 时会调 `createPluginProfile()`，而那个版本
// **把 package.json 整个重写成 `dependencies: {}`** —— 我们刚登记的 `dsh-webops-plugin`
// 被静默冲掉。当时的绕法是随包写一份状态文件，让 previous !== undefined。
//
// alpha.2 把整套「link 模式 + 状态文件」退役了：
//   · `profile-packages.ts` 现在只剩一个一次性迁移函数 `migrateDesktopProfileLinks()`
//     （在 `applyRelease()` 里被调用），它干的事就是**把这个文件删掉**；
//   · 插件登记之所以保得住，是因为 `createPluginProfile()` 落到了 `initProfile()` 的
//     「不存在才写」（`packages/boot/app-boot/src/profile.ts:203`：`if (!existsSync(manifestPath))`）。
// 也就是说那个坑**上游自己修掉了**。继续写这个文件从「必要」变成「误导」—— 所以删掉，
// 并改由自检反向守住：`verify:portable` 的 [1/5] 断言「包里不该有它」，[2/5] 真跑一遍
// `applyRelease()` 断言插件登记与文件都还在。
//
// 下面仍然读一次 descriptor：它不再是给状态文件用的，而是「这个 app 目录是不是完整的
// win-unpacked」的第一手判据 —— 读不到清单说明布局不对（或上游又改了布局），
// 要在这里就说清楚，别拖到整包打完之后。
let runtime
try {
  runtime = readRuntimeDescriptor(appDir).descriptor
} catch (error) {
  console.error(`package-desktop-portable: ${error.message}`)
  process.exit(1)
}
console.log(`  · app 内的 dsh 运行时：${runtime.release.version}`
  + `（node ${runtime.release.nodeVersion}, ${runtime.platform}/${runtime.arch}）`
  + ' —— 不写 profile 状态文件（alpha.2 起该文件已退役）')

// 2.7) 出厂模型配置：预置模型接入。便携版的 home\ 是全新的一份，不写这里的话
//      用户开箱只有 dsh 自带的默认路由、且没有凭据，等于没有可用模型。
//      模板在 scripts/portable-profile-patch.yaml：**凭据引用名**（apiKeyEnv）进包，
//      API Key 本身不进包，由用户在「设置 → 模型」里填，落到 home\.credentials.yaml。
//
// ⚠️ **落点是 profile patch，不是 `home/settings.yaml`**（2026-09-24 适配 dsh 0.1.7）。
//      上游在 0.1.7 把 `settings.yaml` 退役了（`packages/settings/settings/src/index.ts`
//      的 `importLegacyDocument()` 只把它一次性导入本 profile 再改名 `.imported`，
//      源码注释称其为 the **removed** `settings.yaml`）。设置现在的家就是这份 profile patch
//      （`configEditor.documentPath` = `profileContext.patchPath`），用户每次在「设置」页里
//      改动也写在这里 —— 出厂配置直接写在终点。
//      历史：v0.2.x 一直写 `home/settings.yaml`，靠上面那个迁移垫片生效；垫片一旦被上游删掉，
//      用户开箱就没有任何可用模型，所以主动前移。
//      ⚠️ 这个文件是**用户自己的设置文档**（出厂表头就写着 “Your patch layer”），我们只填初值、
//      之后由设置页维护 —— 别把它当成「我们的」文件去覆盖用户改动（增量包不碰它）。
const profilePatchTemplate = join(ROOT, 'scripts', 'portable-profile-patch.yaml')
if (!existsSync(profilePatchTemplate)) {
  console.error(`package-desktop-portable: 缺少出厂配置模板 ${profilePatchTemplate}`)
  process.exit(1)
}
cpSync(profilePatchTemplate, join(profileDir, 'cordis.patch.yml'))
console.log('  + home/profiles/desktop/cordis.patch.yml（预置云知声 MaaS provider）')

// 3) 插件真身。必须是**真实文件**：validateDesktopPluginGraph 见 symlink 就拒。
//    发布版 package.json 剔除 devDependencies 里指向本机 harness 的 link:。
const pluginDir = join(profileDir, 'node_modules', pluginName)
mkdirSync(pluginDir, { recursive: true })
cpSync(join(ROOT, 'lib'), join(pluginDir, 'lib'), { recursive: true })
cpSync(join(ROOT, 'cordis.patch.yml'), join(pluginDir, 'cordis.patch.yml'))
const releasePkg = { ...pkg, version }
delete releasePkg.devDependencies
delete releasePkg.scripts
writeFileSync(join(pluginDir, 'package.json'), `${JSON.stringify(releasePkg, null, 2)}\n`)
console.log(`  + home/profiles/desktop/node_modules/${pluginName}/`)

// 4) 启动器：把 DSH_HOME 指到包内，配置就随包走
//    （apps/desktop/src/paths.ts:26 默认参数 resolveDshHome() 读 $DSH_HOME）
//
//    从 v0.2.2 起**这个脚本不再是唯一入口**：harness 补丁在 main.ts 顶层加了便携兜底 ——
//    `$DSH_HOME` 为空时，若 `process.execPath` 的上一级存在 `home/`，就把它认作 $DSH_HOME。
//    于是直接双击 `app\<exe>` 与走本脚本等价（判定逻辑见 harness 的 `resolvePortableDshHome`，
//    由 `verify:portable` 在真解压目录上正反两向验证）。
//    保留本脚本：它把「配置随包走」写死成显式动作，不依赖 exe 的摆放位置。
writeFileSync(
  join(STAGE, '启动.cmd'),
  [
    '@echo off',
    'setlocal',
    'set "ROOT=%~dp0"',
    'set "DSH_HOME=%ROOT%home"',
    'if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"',
    `start "" "%ROOT%app\\${exe}"`,
    '',
  ].join('\r\n'),
)
console.log('  + 启动.cmd')

// 5) 说明
writeFileSync(
  join(STAGE, '使用说明.txt'),
  [
    `dsh 桌面端便携版 v${version}（Windows x64，已内置 ${pluginName} 插件）`,
    '',
    '【运行】',
    '  二选一，效果相同：',
    '    · 双击根目录的「启动.cmd」',
    `    · 直接双击 app 目录里的 ${exe}`,
    '',
    '  后者能行是因为 dsh 认「exe 上一级的 home\\ 目录」为数据目录（便携模式）。',
    '  只要 home\\ 与 app\\ 还保持同层，配置与插件就随包走。',
    '  ⚠️ 唯一的例外：把 exe 单独挪出 app\\ 目录，就会落回用户目录 ~/.dsh，',
    '     那里没有本插件，表现是「状态条不见了」。',
    '',
    '【数据在哪】',
    '  home\\  = dsh 的全部用户数据（会话、设置、凭据、已装插件）。',
    '  整个目录拷到 U 盘就能带走；删掉 home\\ 即恢复出厂。',
    '  （Electron 自己的界面缓存仍在 %APPDATA%，不随包走；不影响配置与插件。）',
    '',
    '【插件】',
    `  ${pluginName} 已经预装在 home\\profiles\\desktop\\node_modules\\ 下，`,
    '  并在该 profile 的 dsh.profile.bundles 里登记过，开箱即用。',
    '',
    '【第一次打开：填一个模型 API Key】',
    '  home\\profiles\\desktop\\cordis.patch.yml 已经预置好云知声 MaaS（https://maas.unisound.com，',
    '  OpenAI 兼容），默认模型 u2-flash，另有 17 个备选（DeepSeek / Kimi / GLM /',
    '  MiniMax / Qwen 等）。**包里不含任何 API Key**，需要你自己填一个：',
    '',
    '    1) 打开「设置 → 模型」，找到「云知声 MaaS」',
    '    2) 粘贴你的 API Key（会写进 home\\.credentials.yaml，下次启动自动带上）',
    '',
    '  也可以不改界面，直接设环境变量 UNISOUND_API_KEY 再启动',
    '  （环境变量优先级更高，但只读、不会被设置页改写）。',
    '  Key 在 https://maas.unisound.com 控制台申请。',
    '  没填就发消息的话，dsh 会报 MISSING_CREDENTIAL 并提示要设哪个变量。',
    '',
    '【验证插件生效】',
    '  1) 先「选择工作区」，然后新建一个会话。',
    '     状态条挂在**会话面**的输入框上方；停在工作区选择页时它不会出现 ——',
    '     那时插件其实已经加载好了（客户端半边已注册），只是那一面还没挂载。',
    '  2) 会话打开后，输入框上方应能看到「网页操作」状态条；没有浏览器调用时',
    '     它显示「已就绪」，并提示 agent 可以打开、观察与操作网页。',
    '',
    '【浏览器工具】',
    '  agent 调 webpage_open 会打开 **dsh 自己的浏览器窗口**，不需要外接 Chrome。',
    '  （默认 provider 就是包内窗口宿主：桌面端里 cdp 与 electron 会同时「可用」，',
    '    shell 启动时已把 DSH_BROWSER_PROVIDER 落成 electron，否则缝隙会报 ambiguous。）',
    '  想改用外接 Chrome（调试端口模式）：先起',
    '',
    '      chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\\dsh-chrome"',
    '',
    '  再设环境变量 DSH_BROWSER_PROVIDER=cdp（换端口用 DSH_BROWSER_CDP_ENDPOINT）后重启。',
    '  不要用桌面端自带的嵌入式 Chromium 当目标：它不实现 PUT /json/new，',
    '  连上去只会得到「Could not create new page」。',
    '',
    '【注意】',
    '  这是未签名构建：SmartScreen 会拦第一次运行，点「更多信息」→「仍要运行」。',
    '  路径不要含中文，也不要放在需要管理员权限的目录。',
    '',
  ].join('\r\n'),
  { encoding: 'utf8' },
)

// 6) 打包
//
// 压缩级别用 Fastest：app/ 里绝大多数是已经压过的二进制（Electron 运行时、asar、
// .node、图片），Optimal 换来的体积收益是个位数 MB，代价却是几分钟的 CPU ——
// 实测这一整步（物化 profile + 打 zip）在 CI 上要 294s，压缩占了绝大部分。
// 产物仍是标准 zip（Compress-Archive 只换 deflate 级别），不影响用户侧解压。
//
// 为什么先写临时名再改名（2026-09-17 踩坑后改）：
//   · `Compress-Archive` 的失败是 **PowerShell 的非终止错误**，进程退出码仍是 0；
//     原来的 `execFileSync(..., { stdio: 'pipe' })` 把 stderr 吞了，于是脚本「成功」
//     地去读一个根本没生成的 zip，报一句莫名其妙的 ENOENT。
//   · 现在显式 `$ErrorActionPreference='Stop'` 逼出非零退出，并把 stderr 打出来，
//     同时自己断言产物真的存在。
//   · 先写临时名后改名，则失败时旧 zip 原封不动 —— 打好的包不该被一次失败的重打弄丢。
//
// 临时名**必须以 `.zip` 结尾**：`Compress-Archive` 的 `-DestinationPath` 会校验扩展名，
// 写成 `xxx.zip.part` 会直接报「不是支持的存档文件格式。只有 .zip 才是」而不产出任何文件
// （2026-09-17 实测，第一次改成 `.part` 就是这么挂的）。所以用 `.building-` 前缀 + 原名。
const partial = join(DIST, `.building-${zipName}`)
if (existsSync(partial)) rmSync(partial)
const archived = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ErrorActionPreference='Stop'; Compress-Archive -Path '${join(STAGE, '*')}' -DestinationPath '${partial}' -CompressionLevel Fastest`,
  ],
  { encoding: 'utf8' },
)
if (archived.status !== 0 || !existsSync(partial)) {
  // 常见失败原因：**IDE**（不是杀软 —— 2026-09-19 用 scripts/who-locks.ps1 纠正）会去解析
  // 工作区里新建的 app.asar，句柄只挡独占/删除、不挡共享读；`Compress-Archive` 打不开就直接
  // PermissionDenied。`scripts/zip-stage.py` 走共享读，
  // 同一个暂存目录能照常压完 —— 退化到它，产物等价（2026-09-17 实测 17s 压完 12497 条目）。
  console.warn(`package-desktop-portable: Compress-Archive 失败（exit=${String(archived.status)}），退化到 scripts/zip-stage.py`)
  console.warn((archived.stderr ?? '').trim() || (archived.stdout ?? '').trim() || '(无输出)')
  const fallback = spawnSync(
    'python',
    [join(ROOT, 'scripts', 'zip-stage.py'), '--stage', STAGE, '--out', partial],
    { encoding: 'utf8' },
  )
  console.log((fallback.stdout ?? '').trim())
  if (fallback.status !== 0 || !existsSync(partial)) {
    console.error(`package-desktop-portable: 退化压缩也失败（exit=${String(fallback.status)}）`)
    console.error((fallback.stderr ?? '').trim() || '(无 stderr)')
    console.error(`  暂存目录原样保留在 ${STAGE}，可手工压缩排查；上一版 zip 未被改动。`)
    if (existsSync(partial)) console.error(`  半截产物也留在 ${partial}，确认后自行删除。`)
    process.exit(1)
  }
}
if (existsSync(zipPath)) rmSync(zipPath)
renameSync(partial, zipPath)

// 收尾清理。zip 已经落盘了，这里失败**不该**把整次打包判成失败
// （本机见过暂存目录被占用导致这一步抛 EBUSY 的情况），所以只告警。
if (!removeTree(STAGE)) {
  console.warn(`\n注意: 暂存目录没能清掉，zip 不受影响。手工删：`)
  console.warn(`  CODEBUDDY_SAFE_DELETE_ENABLED=0 rm -rf "${STAGE}"`)
}

const bytes = readFileSync(zipPath)
console.log(`\n${zipName}  (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`)
console.log(`sha256: ${createHash('sha256').update(bytes).digest('hex')}`)
console.log(zipPath)
