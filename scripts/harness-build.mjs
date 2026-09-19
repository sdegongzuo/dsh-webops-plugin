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
 * 2. **Electron 二进制下载**。`prepare:runtime` 要下 **157MB** 的
 *    `electron-v<版本>-win32-x64.zip`，直连 GitHub 实测 `TypeError: fetch failed`。
 *    → 注入 `ELECTRON_MIRROR`（默认 npmmirror 的 electron 镜像）。
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
 * pnpm harness:build                 # 全链：prepare:runtime → prepare:packages → prepare:dsh → package
 * pnpm harness:build --skip-prepare  # 前 3 步已过，只重打 package
 * pnpm harness:build --no-mirror     # 不换 registry（网络好时用，例如海外环境）
 * pnpm harness:build --dry-run       # 只演练「临时替换 → 无条件还原」，不跑构建
 * ```
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

/** 按顺序跑的步骤（`--skip-prepare` 时只留最后一步）。 */
export function buildSteps(skipPrepare) {
  const all = ['prepare:runtime', 'prepare:packages', 'prepare:dsh', 'package:win:x64:dir']
  return skipPrepare ? all.slice(-1) : all
}

/* ---------- 临时替换 / 无条件还原 ---------- */

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

function runSteps(skipPrepare) {
  const desktop = harnessDesktopDir()
  const env = {
    ...process.env,
    // 本机必备（CI 不需要这两个）：
    //  · 安全删除垫片会把 harness 的每个步骤都拦成 SAFE_DELETE_BULK_CONFIRM_REQUIRED；
    //  · MSYS 的 GNU tar 会把 `D:` 当远程主机名（prepare:packages 读 tar -xOzf <绝对路径>）。
    CODEBUDDY_SAFE_DELETE_ENABLED: '0',
    TAR_OPTIONS: '--force-local',
    ELECTRON_MIRROR: electronMirror(),
  }
  for (const step of buildSteps(skipPrepare)) {
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
  const flags = new Set(['--skip-prepare', '--no-mirror', '--dry-run'])
  const skipPrepare = argv.includes('--skip-prepare')
  const noMirror = argv.includes('--no-mirror')
  const dryRun = argv.includes('--dry-run')
  for (const flag of argv) {
    if (!flags.has(flag)) fail(`未知参数 ${JSON.stringify(flag)}（只认 ${[...flags].join(' / ')}）`)
  }

  console.log(`harness   ${harnessRoot()}`)
  console.log(`步骤      ${dryRun ? '（--dry-run：不跑构建）' : buildSteps(skipPrepare).join(' → ')}`)
  if (noMirror) console.log('镜像      未启用（--no-mirror）—— 直连 npmjs 本机只有 11–31 KB/s，大概率超时')
  else applyRegistryMirror(npmRegistry())

  if (dryRun) {
    restoreRegistry()
    if (process.exitCode !== 1) console.log('\n✓ 替换 / 还原往返正常（未跑构建）')
  } else {
    let ok = false
    try {
      ok = runSteps(skipPrepare)
    } finally {
      restoreRegistry()
    }
    if (ok && process.exitCode !== 1) reportNextSteps()
    else process.exitCode = 1
  }
}
