/**
 * 把 `src/` 下的非 TS 运行时资产复制到 `lib/`。
 *
 * 目前只有一件：`src/browser-electron/host.cjs`。它是**被 spawn 的 Electron 应用入口**，
 * 必须与 `lib/browser-electron/index.js` 同目录 —— `index.ts` 用
 * `new URL('./host.cjs', import.meta.url)` 找它，而发布产物里只有 `lib/`。
 *
 * 不放进 tsdown 的 entry：它不是模块，不该被打包/转译。
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--out-dir')
if (at !== -1 && !process.argv[at + 1]) throw new Error('copy-assets: --out-dir 需要目标目录')
const outDir = resolve(at === -1 ? join(ROOT, 'lib') : process.argv[at + 1])

/** 需要原样搬运的资产：源路径 → 产物路径（都相对仓库根）。 */
const ASSETS = [
  ['src/browser-electron/action-overlay.cjs', 'lib/browser-electron/action-overlay.cjs'],
  ['src/browser-electron/action-overlay.html', 'lib/browser-electron/action-overlay.html'],
  ['src/browser-electron/host.cjs', 'lib/browser-electron/host.cjs'],
  ['src/browser-electron/tabbar.html', 'lib/browser-electron/tabbar.html'],
  ['src/browser-electron/tabbar-preload.cjs', 'lib/browser-electron/tabbar-preload.cjs'],
]

for (const [from, to] of ASSETS) {
  const target = join(outDir, to.slice('lib/'.length))
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(ROOT, from), target)
  console.log(`copy-assets: ${from} → ${target}`)
}
