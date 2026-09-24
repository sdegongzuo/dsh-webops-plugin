#!/usr/bin/env node
/**
 * 前置检查：**打包出来的** LibreOffice 载荷，最深那条文件的绝对路径会不会越过 MAX_PATH。
 *
 * 为什么要有这条：dsh 0.1.7 给打包链最后一步加了 Office→PDF 冒烟。它把 LibreOffice 载荷
 * （2053 个文件 / 325 MB）放在
 *
 *   <harness>\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\
 *            win-unpacked\resources\dsh\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\
 *
 * 之下，里面相对最长的一条是 84 字符（`program\share\config\soffice.cfg\...`）。窗口
 * `GITHUB_WORKSPACE = D:\a\dsh-webops-plugin\dsh-webops-plugin` 时，如果 harness 放在
 * 旁边（`..\deepseek-harness`）载荷根就是 181 字符、最深文件 266 —— **越过 Windows 的
 * MAX_PATH(260)**。LibreOffice 是原生程序、不做长路径处理，于是：
 *
 *   · docx（Writer）能过 —— 它恰好不需要任何超过 260 的文件；
 *   · xlsx（Calc）报 `loadComponentFromURL returned an empty reference`；
 *   · pptx（Impress）helper 直接原生崩溃（0xC0000005 / 0xC0000409）。
 *
 * 「Writer 能过」这一点极具误导性：报错指向 Calc/Impress 的过滤器，看起来像字体、内存或
 * 载荷损坏，实测全都不是（载荷 sha256 与上游 `prebuilds.json` 全量一致、本机同载荷全过）。
 * 本机只改路径长度即可复现同样的三连：`scripts/probe-deep-path.mjs`。
 *
 * 本脚本**只做判据**：量真实载荷里最长的那条相对路径，投影到打包位置，跟 259 比。
 * 259 而不是 260 —— MAX_PATH 的 260 含结尾 NUL，能用的是 259 字符。
 *
 * 用法：
 *   node scripts/check-office-payload-path.mjs --harness <harness 根>
 * 退出码：0 = 有余量；1 = 会越界（顺便把该怎么改说出来）；0 = 找不到载荷（不拦，只提示）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Windows MAX_PATH 含结尾 NUL，能用的路径长度上限。 */
export const LIMIT = 259
/** 打包后那份载荷在 harness 里的位置（相对 harness 根）。 */
const PACKAGED_SUFFIX = 'apps\\desktop\\.desktop-build\\targets\\win-x64\\unsigned-artifacts\\win-unpacked\\resources\\dsh\\node_modules\\@deepseek-ai\\libreoffice-kit-win32-x64'
const PACKAGE = '@deepseek-ai/libreoffice-kit-win32-x64'

/** 载荷在源码树里可能出现的位置（pnpm 平铺 / 未提升到 .pnpm 两种布局都认）。 */
function findPayload(harnessRoot) {
  const direct = [
    join(harnessRoot, 'apps', 'desktop', 'node_modules', ...PACKAGE.split('/')),
    join(harnessRoot, 'node_modules', ...PACKAGE.split('/')),
  ]
  for (const dir of direct) if (existsSync(dir)) return dir

  const store = join(harnessRoot, 'node_modules', '.pnpm')
  if (!existsSync(store)) return undefined
  const slot = readdirSync(store)
    .filter(name => name.startsWith('@deepseek-ai+libreoffice-kit-win32-x64@'))
    .sort()
    .pop()
  if (slot === undefined) return undefined
  const dir = join(store, slot, 'node_modules', ...PACKAGE.split('/'))
  return existsSync(dir) ? dir : undefined
}

/** 载荷里最长的那条相对路径（相对载荷根，反斜杠形式）。 */
export function longestRelativePath(root) {
  let longest = ''
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      const relative = full.slice(root.length + 1)
      if (relative.length > longest.length) longest = relative
    }
  }
  walk(root)
  return longest
}

/** 打包后最深那条文件的绝对路径长度。 */
export function projectedLength(harnessRoot, relative) {
  return join(harnessRoot, PACKAGED_SUFFIX, relative).length
}

function main() {
  const flag = process.argv.indexOf('--harness')
  const harnessRoot = flag >= 0 ? process.argv[flag + 1] : undefined
  if (harnessRoot === undefined || harnessRoot.length === 0) {
    console.error('用法：node scripts/check-office-payload-path.mjs --harness <harness 根>')
    process.exit(2)
  }
  const payload = findPayload(harnessRoot)
  if (payload === undefined) {
    // 不拦：上游换个位置/换命名就找不到。这里只提示，免得把一个「搜不到」演成「发不出去」。
    console.log(`⚠️ 没在 ${harnessRoot} 下找到 LibreOffice 载荷（${PACKAGE}），跳过路径长度检查。`)
    console.log('   若上游改了布局，请更新本脚本的 findPayload()。')
    process.exit(0)
  }
  const relative = longestRelativePath(payload)
  const projected = projectedLength(harnessRoot, relative)
  const headroom = LIMIT - projected
  console.log(`载荷          ${payload}`)
  console.log(`最长相对路径  ${relative.length} 字符  ${relative}`)
  console.log(`打包后最长    ${projected} 字符（上限 ${LIMIT}，余量 ${headroom}）`)
  if (headroom >= 0) {
    console.log(`✓ harness 根 ${harnessRoot.length} 字符 —— 余量 ${headroom} 字符`)
    process.exit(0)
  }
  console.error(`\n✗ 打包后最长路径 ${projected} 超过 ${LIMIT}（MAX_PATH 含 NUL 是 260）。`)
  console.error('  症状：Office→PDF 冒烟里 docx 能过、xlsx 报 "loadComponentFromURL returned an')
  console.error('  empty reference"、pptx helper 原生崩溃 —— 报错完全指不到路径上。')
  console.error(`  改法：把 harness 放在更短的路径下（当前根 ${harnessRoot}，`)
  console.error(`  需要再省 ${-headroom} 个字符）。CI 里见 release-desktop.yml 的「取 deepseek-harness 源码」。`)
  process.exit(1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
