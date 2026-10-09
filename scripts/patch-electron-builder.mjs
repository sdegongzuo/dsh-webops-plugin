/**
 * 核验 electron-builder 解包 rename 的 EPERM 防护；旧版 app-builder-lib 则补上重试。
 *
 * ## 26.17.0 起上游已原生修复（2026-10-09 升级 alpha.2 时核对）
 *
 * `app-builder-lib/out/util/electronGet.js` 的 `extractArchive` 把
 * `await fs.rename(tmpDir, dir)` 换成了 `await moveDirAtomic(tmpDir, dir)`：
 * 对 `TRANSIENT_RENAME_CODES = {ENOENT, EPERM, EBUSY, EXDEV}` 重试 5 次
 * （250–1000ms 退避），重试穷尽再回落 copy+delete。我们当年的 EPERM 场景被覆盖，
 * 旧补丁的匹配片段在新版里已不存在 —— 所以脚本改成三态：
 *
 *   1. 检测到 `moveDirAtomic` → 上游原生修复在位，放行（exit 0），不打补丁；
 *   2. 检测到旧片段 `fs.rename(tmpDir, dir)` → 旧版 ref，打我们的重试补丁；
 *   3. 两者都没有 → 版本又变了且没带修复，明确失败（不许静默跳过）。
 *
 * 为什么需要防 EPERM：`extractZipStreaming()` 写完立刻 rename，Windows 上常因句柄
 * 尚未释放报 `EPERM: operation not permitted, rename '...win-unpacked.tmp' -> ...`。
 * 等一两秒再 rename 就一定成功（手动 `mv` 从来没失败过）。
 * 与杀软无关：Defender 实时保护关着也一样复现。
 *
 * 用法：
 *   node scripts/patch-electron-builder.mjs <harness 根目录>
 *
 * 产物在 `node_modules/.pnpm/` 下，是硬链接到 pnpm store 的 —— 所以这里用
 * 「先 unlink 再写入」而不是原地改写，避免把 store 里的原件也改掉。
 *
 * **每一步都做语法校验**（2026-09-17 补）。起因：本机 `.pnpm` 里那份文件被某个更早的
 * 版本就地改坏（多了一个 `}`），但它带着 `Patched by` 标记 —— 于是本脚本判定「已打过」
 * 直接跳过，坏内容一直留在那儿。症状要到十几分钟后的 `build:official` 才炸出来：
 * `esbuild: ERROR: Expected "finally" but found "}"`，看着像上游挂了。
 * 现在标记只用来省事，**不再是信任依据**：无论跳过还是新打，都要能过 `vm.Script`。
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'

const harnessRoot = process.argv[2]
if (harnessRoot === undefined) {
  console.error('用法: node scripts/patch-electron-builder.mjs <harness 根目录>')
  process.exit(1)
}

const pnpmDir = join(harnessRoot, 'node_modules', '.pnpm')
if (!existsSync(pnpmDir)) {
  console.error(`找不到 ${pnpmDir}，harness 依赖装了吗？`)
  process.exit(1)
}

const targets = readdirSync(pnpmDir)
  .filter(name => name.startsWith('app-builder-lib@'))
  .map(name => join(pnpmDir, name, 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js'))
  .filter(path => existsSync(path))

if (targets.length === 0) {
  console.error('没找到 app-builder-lib 的 electronGet.js')
  process.exit(1)
}

const ORIGINAL = [
  '        await fs.rm(dir, { recursive: true, force: true });',
  '        await fs.rename(tmpDir, dir);',
].join('\n')

/** 上游 26.17.0 原生修复的标志（见文件头）。有它就不需要我们的补丁。 */
const NATIVE = 'function moveDirAtomic(src, dest)'

const PATCHED = [
  '        await fs.rm(dir, { recursive: true, force: true });',
  '        // Patched by dsh-webops-plugin/scripts/patch-electron-builder.mjs',
  '        // Windows: 解包完立即 rename 常因句柄未释放报 EPERM，重试即可。',
  '        for (let i = 0; ; i++) {',
  '            try {',
  '                await fs.rename(tmpDir, dir);',
  '                break;',
  '            }',
  '            catch (e) {',
  "                if (e.code !== 'EPERM' || i >= 60) { throw e; }",
  '                await new Promise(r => setTimeout(r, 1000));',
  '            }',
  '        }',
].join('\n')

/**
 * 断言一份 JS 源码能通过解析。解析不过就说明产物是坏的 —— 与其等十分钟后 esbuild 报
 * 一个「Expected "finally" but found "}"」，不如在这里当场死掉。
 * @param file - 报错里显示的文件名（用于定位）。
 * @param source - 待校验的源码。
 */
function assertParses(file, source) {
  try {
    new Script(source, { filename: file })
  } catch (error) {
    console.error(`${file} 语法不合法：${error.message}`)
    console.error('  该文件已被改坏且带着补丁标记，本脚本不会覆盖它。修复办法：')
    console.error('    1) 删掉这个文件（pnpm store 里是干净的，不会污染别人）')
    console.error('    2) pnpm install --force   # 从 store 重新链接出干净副本')
    console.error('    3) 重跑本脚本')
    process.exit(1)
  }
}

let patched = 0
let nativeFixed = 0
for (const file of targets) {
  const source = readFileSync(file, 'utf8')
  if (source.includes(NATIVE)) {
    // 上游原生修复在位：确认重试码集合确实包含 EPERM（就在 Set 字面量附近），再放行。
    const marker = source.indexOf('TRANSIENT_RENAME_CODES')
    if (marker === -1 || !source.slice(marker, marker + 200).includes('EPERM')) {
      console.error(`检测到 moveDirAtomic，但重试码集合里没看到 EPERM，需人工核对: ${file}`)
      process.exit(1)
    }
    console.log(`上游已原生重试（moveDirAtomic），无需补丁: ${file}`)
    nativeFixed += 1
    continue
  }
  if (source.includes('Patched by dsh-webops-plugin')) {
    // 标记只能证明「曾经写过」，不能证明「写对了」—— 所以照样校验。
    assertParses(file, source)
    console.log(`已打过，跳过: ${file}`)
    continue
  }
  if (!source.includes(ORIGINAL)) {
    console.error(`片段不匹配，也没检测到上游原生修复（app-builder-lib 版本变了？）: ${file}`)
    console.error('  需要人工核对新版 electronGet.js 的 rename 行为，再决定补丁形状。')
    process.exit(1)
  }
  const next = source.replace(ORIGINAL, PATCHED)
  // 先校验再落盘：坏内容一个字节都不写进去。
  assertParses(file, next)
  rmSync(file)
  writeFileSync(file, next)
  patched += 1
  console.log(`已打补丁: ${file}`)
}

console.log(`完成：${patched} 处补丁，${nativeFixed} 处原生修复`)
