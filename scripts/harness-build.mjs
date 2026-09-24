/**
 * 本机重编桌面端（harness）的一键入口 —— 把两处「本机网络必然卡死」的坑挡在前面。
 *
 * ## 为什么要有它（两处坑都是实测出来的，不是猜的）
 *
 * 直接 `pnpm run package:win:x64:dir --unsigned` 在本机**必挂**，而且是**先跑 20 分钟再挂**：
 *
 * 1. **npm registry 被上游硬编码成 npmjs.org**。`apps/desktop/scripts/prepare-dsh.ts:77,89`
 *    把 registry 写死，并主动剥掉子进程环境里所有 `npm_*` / `pnpm_*` 变量、把
 *    `--config.userconfig` 指向一个空文件 —— 所以 **`~/.npmrc` 里配的镜像完全不起作用**，
 *    环境变量也注不进去。而本机直连 npmjs 只有 **11–31 KB/s**（实测 `node-pty` 7.15MB
 *    要 ~10 分钟）；该脚本每轮还用 `mkdtemp` 新建 BUILD_ROOT（pnpm store 就在里面）→
 *    **store 每轮都是冷的** → 大包必然撞 pnpm 的 60s `fetch-timeout`，报
 *    `[23] The operation was aborted due to timeout`。
 *    → 本脚本临时把那 2 处换成 `DSH_NPM_REGISTRY`（默认 npmmirror），实测 **1.8–2.5 MB/s**。
 *
 *    ⚠️ **2026-09-22 更新（dsh 0.1.7-alpha.1）：这个坑上游已经修了。** `prepare-dsh.ts`
 *    现在写的是 `resolveNpmRegistry(process.env)`（`desktop-release-environment.mjs` 的
 *    `NPM_REGISTRY_ENV` = **`DSH_DESKTOP_NPM_REGISTRY`**，默认值才是 npmjs），并把解析结果
 *    显式注入 pnpm 子进程的 `NPM_CONFIG_REGISTRY`。所以新版上游**不用再改文件**，
 *    直接注入环境变量即可。
 *    本脚本会自动判模式：上游能读环境变量就走 `env`（**一个字节都不动**），
 *    读不到才回落到旧的「改文件」路径（兼容旧 ref）。下面那套替换 / 无条件还原的防线
 *    只在回落路径上生效。
 * 2. **Electron 二进制下载**。`prepare:runtime` 要下 **157MB** 的
 *    `electron-v<版本>-win32-x64.zip`，直连 GitHub 实测 `TypeError: fetch failed`。
 *    → 注入 `ELECTRON_MIRROR`（默认 npmmirror 的 electron 镜像）。
 * 3. **`@deepseek-ai/node-addon-system` 的 `lib/` 不在 git 里**（dsh 0.1.7 起新出现）。
 *    `apps/desktop/scripts/macos-notarization-proxy.ts:8` 在 **import 期**就
 *    `import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'`，而
 *    `package-target.ts:26` 顶层导入该模块 → 链**一步都没进**就
 *    `ERR_MODULE_NOT_FOUND: …/node-addon-system/lib/flock.js`（3 秒即挂）。
 *    该 `lib/` 是 `tsc -b` 产物、被 `native/system/.gitignore` 的 `packages/<名>/lib/` 排除，
 *    所以**只在全新 checkout 上缺**；本机第一次撞到它是在 CI（v0.2.8，run 35952690821），
 *    本地因为留着旧产物而看不出来。
 *    → `runSteps` 先无条件跑一次 `pnpm --filter @deepseek-ai/node-addon-system run build:js`
 *    （`tsc -b` 增量，秒级）。**判据是「上游有没有自己挂」，不是「本机现在有没有」** ——
 *    根 `build:native-system` 只编 C 原生插件、非 linux/darwin 直接 exit 0，指望不上。
 *
 * ## 安全设计：临时替换**必须无条件还原**
 *
 * 被替换的 `prepare-dsh.ts` 是 `docs/harness-desktop-build.patch` 的**目标文件之一** ——
 * 替换一旦残留，就会随补丁出货到 CI。所以这里层层设防：
 *   · 替换前断言原文件里**恰好 2 处** `https://registry.npmjs.org/`（数量不对就拒绝动手）；
 *   · 备份到临时目录并记 sha256；
 *   · `finally` 里无条件还原，再断言「sha256 与备份一致」且「文件里 npmmirror 出现 0 次」；
 *   · 任一条不满足 → 非 0 退出 + 打出备份路径，让人手动覆盖回去。
 *
 * ## 用法
 *
 * ```bash
 * pnpm harness:build              # 跑 package:win:x64:dir（上游的完整链，见 buildSteps 说明）
 * pnpm harness:build --no-mirror  # 不换 registry（网络好时用，例如海外环境）
 * pnpm harness:build --dry-run    # 只打印模式判定（env / patch / off），不跑构建
 * ```
 *
 * （`--skip-prepare` 已于 2026-09-22 退役：链上只剩一步，没有「前置」可跳。）
 *
 * 成功后打出的 win-unpacked 路径直接喂：
 *   `node scripts/portable-dev.mjs set-app --from <它>`
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronMirror, harnessRoot, npmRegistry } from './local-env.mjs'

/** 上游写死的 registry 字面量（`prepare-dsh.ts` 里出现 2 次）。 */
export const UPSTREAM_REGISTRY = 'https://registry.npmjs.org/'
/** 期望的出现次数。上游改了就得同步改这里（脚本会拒绝在数量不符时动手）。 */
export const EXPECTED_UPSTREAM_COUNT = 2

/** harness 的桌面端工程目录。 */
export function harnessDesktopDir() {
  return join(harnessRoot(), 'apps', 'desktop')
}

/** 构建产物：`--unsigned` 会落到 `unsigned-artifacts/win-unpacked`（这就是 `set-app --from` 要的那份）。 */
export function harnessUnpackedDir() {
  return join(harnessDesktopDir(), '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts', 'win-unpacked')
}

/**
 * 要跑的步骤 —— 只有一步。
 *
 * ⚠️ **不要再手写「prepare:runtime → prepare:packages → prepare:dsh → package」那份子集。**
 * 2026-09-22 实测：那份子集**依赖 `.desktop-build/packed/` 的残留**才跑得起来 ——
 * `prepare:packages` 要读 `release:pack` 产出的 tarball（`packed/dsh`），而 `release:pack`
 * 只在 harness 的 `package-target.ts` 里被调用。跑一次 `pnpm clean` 把 `.desktop-build`
 * 删掉，它立刻变成 `ENOENT: no such file or directory, scandir '…\packed\dsh'`。
 *
 * 而上游的 `package:win:x64:dir` 内部**本来就是完整链**：
 * build:official → release:pack（dsh / desktop-host / vendor / landlock）→ prepare:runtime
 * → prepare:packages → prepare:dsh → electron-builder。CI（`release-desktop.yml`）也正是
 * 只跑这一条，且每次都是全新 checkout（没有任何残留）。
 *
 * 所以这里保持「一步」—— 上游将来加一个前置步骤，我们不会静默跑偏。
 */
export function buildSteps() {
  return ['package:win:x64:dir']
}

/* ---------- 上游没挂、但链的**入口**强制要求的前置 ---------- */

/** 提供 `…/flock` 的那个 workspace 包（`native/system/packages/entry`）。 */
export function nativeAddonPackage() {
  return '@deepseek-ai/node-addon-system'
}

/**
 * 编译 `@deepseek-ai/node-addon-system` 的 `lib/`。
 *
 * 为什么**必须显式做**，而不是「本机有就算了」：
 *   · 那个 `lib/` 是 `tsc -b` 产物，被 `native/system/.gitignore` 的 `packages/<名>/lib/` 排除
 *     → **只在全新 checkout 上缺**（CI 必缺，本机常因残留旧产物而看不出来）；
 *   · `package-target.ts:26` 顶层 import 的 `macos-notarization-proxy.ts:8` 在 **import 期**
 *     就要 `…/node-addon-system/lib/flock.js` → 缺它时链在**入口之前**就抛
 *     `ERR_MODULE_NOT_FOUND`，症状与「harness ref 取错了」几乎无法区分
 *     （v0.2.8 CI 实测：3 秒即挂，run 35952690821）。
 *
 * 无条件跑（而不是「不存在才跑」）：`tsc -b` 是增量的、秒级完成，而「存在就跳过」会把
 * 「上游改了 src、产物是旧的」这类问题静默留下来。
 */
function ensureNativeAddonLib(env) {
  const args = ['--filter', nativeAddonPackage(), 'run', 'build:js']
  console.log(`\n=== 前置 pnpm ${args.join(' ')} ===`)
  const result = spawnSync('pnpm', args, { cwd: harnessRoot(), env, stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    console.error(`harness-build: 前置 pnpm ${args.join(' ')} 失败（exit ${String(result.status)}）`)
    return false
  }
  return true
}

/* ---------- registry 注入模式 ---------- */

/**
 * 上游能否从环境变量读 registry（dsh 0.1.7-alpha.1 起）。
 *
 * 判据用 `resolveNpmRegistry` 这个标识，而不是数 `https://registry.npmjs.org/` 的出现次数 ——
 * 后者会随注释、示例、默认值挪动而变，而「能从环境变量读」这个能力必须有那个函数。
 */
export function supportsRegistryEnv() {
  const target = join(harnessDesktopDir(), 'scripts', 'prepare-dsh.ts')
  if (!existsSync(target)) fail(`找不到 ${target} —— DSH_HARNESS 指对了吗？`)
  return readFileSync(target, 'utf8').includes('resolveNpmRegistry')
}

/* ---------- 临时替换 / 无条件还原（只在旧上游回落路径上跑）---------- */

/** 还原凭据；`null` = 没替换过。 */
let swap = null

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function fail(message) {
  console.error(`harness-build: ${message}`)
  process.exit(1)
}

/**
 * 把 `prepare-dsh.ts` 里的 npmjs registry 临时换成镜像。
 * @param {string} mirror 以 `/` 结尾的 registry。
 */
function applyRegistryMirror(mirror) {
  const target = join(harnessDesktopDir(), 'scripts', 'prepare-dsh.ts')
  if (!existsSync(target)) fail(`找不到 ${target} —— DSH_HARNESS 指对了吗？`)
  const before = readFileSync(target, 'utf8')
  const count = before.split(UPSTREAM_REGISTRY).length - 1
  if (count !== EXPECTED_UPSTREAM_COUNT) {
    fail(`${target} 里 ${UPSTREAM_REGISTRY} 出现 ${count} 次（期望 ${EXPECTED_UPSTREAM_COUNT}）—— `
      + '上游可能改过。请先核对，或用 --no-mirror 跑。')
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-harness-build-'))
  const backup = join(dir, 'prepare-dsh.ts.bak')
  writeFileSync(backup, before)
  // 先登记再写：万一 writeFileSync 只写了一半就抛，`finally` 仍然会把它还原回去。
  swap = { target, backup, hash: sha256(before) }
  // 只做 URL 字面量替换，不碰引号/结构 —— 不会被引号转义类问题咬到。
  writeFileSync(target, before.split(UPSTREAM_REGISTRY).join(mirror))
  console.log(`registry 临时替换  ${UPSTREAM_REGISTRY} → ${mirror}`)
  console.log(`    备份 ${backup}`)
}

/** 还原并自证。**绝不静默失败** —— 残留会随补丁出货。 */
function restoreRegistry() {
  if (swap === null) return
  const { target, backup, hash } = swap
  swap = null
  try {
    copyFileSync(backup, target)
  } catch (error) {
    console.error(`harness-build: ✗ 还原 ${target} 时出错：${error.code ?? error.message}`)
    console.error(`  备份在 ${backup} —— 手动覆盖回去，别提交带镜像的版本。`)
    process.exitCode = 1
    return
  }
  const now = readFileSync(target)
  const problems = []
  if (sha256(now) !== hash) problems.push('sha256 与备份不一致')
  if (now.toString('utf8').includes('npmmirror')) problems.push('文件里仍有 npmmirror 字样')
  if (problems.length > 0) {
    console.error(`harness-build: ✗ 还原不干净：${problems.join('；')}`)
    console.error(`  备份在 ${backup} —— 手动覆盖回去，别提交带镜像的版本。`)
    process.exitCode = 1
    return
  }
  console.log(`registry 已还原  sha256 ${hash.slice(0, 12)}… 一致，无镜像残留`)
}

/* ---------- 跑构建 ---------- */

/**
 * 依次跑构建步骤。
 * @param {string|undefined} registryEnv 新版上游读的 registry 环境变量值；`undefined` = 不注入。
 */
function runSteps(registryEnv) {
  const desktop = harnessDesktopDir()
  const env = {
    ...process.env,
    // 本机必备（CI 不需要这两个）：
    //  · 安全删除垫片会把 harness 的每个步骤都拦成 SAFE_DELETE_BULK_CONFIRM_REQUIRED；
    //  · MSYS 的 GNU tar 会把 `D:` 当远程主机名（prepare:packages 读 tar -xOzf <绝对路径>）。
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
    TAR_OPTIONS: '--force-local',
    ELECTRON_MIRROR: electronMirror(),
    // ⚠️ 只对**新版上游**有效：它必须在子进程环境里（上游用 `process.env` 读，
    // 再显式写进 pnpm 子进程的 NPM_CONFIG_REGISTRY）。旧上游没有这个入口。
    ...(registryEnv === undefined ? {} : { DSH_DESKTOP_NPM_REGISTRY: registryEnv }),
  }
  if (!ensureNativeAddonLib(env)) return false
  for (const step of buildSteps()) {
    const extra = step === 'package:win:x64:dir' ? ['--unsigned'] : []
    console.log(`\n=== ${step}${extra.length > 0 ? ` ${extra.join(' ')}` : ''} ===`)
    const result = spawnSync('pnpm', ['run', step, ...extra], { cwd: desktop, env, stdio: 'inherit', shell: true })
    if (result.status !== 0) {
      console.error(`harness-build: ${step} 失败（exit ${String(result.status)}）`)
      return false
    }
  }
  return true
}

function reportNextSteps() {
  const unpacked = harnessUnpackedDir()
  if (!existsSync(join(unpacked, 'resources', 'app.asar'))) {
    console.error(`harness-build: 构建自称成功，但 ${unpacked} 不像一份完整 win-unpacked。`)
    process.exitCode = 1
    return
  }
  console.log(`
win-unpacked  ${unpacked}

放进固定测试目录（只换 app/，home/ 里的插件、会话、凭据都不动）：
  node scripts/portable-dev.mjs set-app --from "${unpacked}"

⚠️ 若那个目录里还起着桌面端，set-app 删旧 app/ 会报 EBUSY —— 先关掉它再跑。`)
}

/* ---------- 入口 ---------- */

const isEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isEntry) {
  const argv = process.argv.slice(2)
  // `--skip-prepare` 已退役（2026-09-22）：链上只剩一步（见 buildSteps 的说明），没有「前置」可跳。
  // 仍然传它会落到下面那句「未知参数」，fail-loud 而不是被静默忽略。
  const flags = new Set(['--no-mirror', '--dry-run'])
  const noMirror = argv.includes('--no-mirror')
  const dryRun = argv.includes('--dry-run')
  for (const flag of argv) {
    if (!flags.has(flag)) fail(`未知参数 ${JSON.stringify(flag)}（只认 ${[...flags].join(' / ')}）`)
  }

  console.log(`harness   ${harnessRoot()}`)
  console.log(`步骤      ${dryRun
    ? '（--dry-run：不跑构建）'
    : `前置 ${nativeAddonPackage()} build:js → ${buildSteps().join(' → ')}`}`)
  // registry 两条路：新版上游走环境变量（不动文件），旧上游回落到改文件。
  const registryMode = noMirror ? 'off' : supportsRegistryEnv() ? 'env' : 'patch'
  const registryValue = registryMode === 'off' ? undefined : npmRegistry()
  if (registryMode === 'off') {
    console.log('镜像      未启用（--no-mirror）—— 直连 npmjs 本机只有 11–31 KB/s，大概率超时')
  } else if (registryMode === 'env') {
    console.log(`registry  环境变量注入 ${registryValue}（上游原生支持，不改文件）`)
  } else {
    console.log('registry  上游没有环境变量入口 —— 回落到临时替换文件（用完无条件还原）')
    applyRegistryMirror(registryValue)
  }

  if (dryRun) {
    restoreRegistry()
    if (process.exitCode !== 1) {
      console.log(`\n✓ 模式判定完成（registry=${registryMode}），未跑构建`
        + (registryMode === 'patch' ? '；替换 / 还原往返正常' : ''))
    }
  } else {
    let ok = false
    try {
      ok = runSteps(registryMode === 'env' ? registryValue : undefined)
    } finally {
      restoreRegistry()
    }
    if (ok && process.exitCode !== 1) reportNextSteps()
    else process.exitCode = 1
  }
}
