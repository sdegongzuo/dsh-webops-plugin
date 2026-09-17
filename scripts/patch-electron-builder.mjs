/**
 * 给 electron-builder 的 `extractArchive` 打补丁：解包后 rename 失败时重试。
 *
 * 为什么需要：`app-builder-lib/out/util/electronGet.js` 里 `extractZipStreaming()` 写完
 * 立刻 `fs.rename(tmpDir, dir)`，在 Windows 上常因句柄尚未释放报
 * `EPERM: operation not permitted, rename '...win-unpacked.tmp' -> '...win-unpacked'`。
 * 等一两秒再 rename 就一定成功（手动 `mv` 从来没失败过），所以补个重试循环。
 *
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
for (const file of targets) {
  const source = readFileSync(file, 'utf8')
  if (source.includes('Patched by dsh-webops-plugin')) {
    // 标记只能证明「曾经写过」，不能证明「写对了」—— 所以照样校验。
    assertParses(file, source)
    console.log(`已打过，跳过: ${file}`)
    continue
  }
  if (!source.includes(ORIGINAL)) {
    console.error(`片段不匹配（app-builder-lib 版本变了？）: ${file}`)
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

console.log(`完成，共 ${patched} 处`)
