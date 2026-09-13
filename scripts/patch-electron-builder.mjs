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
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

let patched = 0
for (const file of targets) {
  const source = readFileSync(file, 'utf8')
  if (source.includes('Patched by dsh-webops-plugin')) {
    console.log(`已打过，跳过: ${file}`)
    continue
  }
  if (!source.includes(ORIGINAL)) {
    console.error(`片段不匹配（app-builder-lib 版本变了？）: ${file}`)
    process.exit(1)
  }
  rmSync(file)
  writeFileSync(file, source.replace(ORIGINAL, PATCHED))
  patched += 1
  console.log(`已打补丁: ${file}`)
}

console.log(`完成，共 ${patched} 处`)
