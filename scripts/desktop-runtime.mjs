/**
 * 定位 dsh 桌面端的「不可变运行时目录」（就是放 `desktop-runtime.json` 的那棵树）。
 *
 * 这套东西有两代布局，必须两种都认：
 *   · flat（0.1.5 及更早，以及**我们打补丁之后的所有版本**）：`dsh` 是 electron-builder 的
 *     extraResources，产物里 `resources\dsh\` 就是真目录，直接读就行。
 *   · asar（0.1.6 起的**上游原样**）：上游把它挪进 `files`（当时在
 *     `apps/desktop/electron-builder.config.mjs`，0.1.6-alpha.2 起该文件变成 5 行 shim、
 *     真配置在 `apps/desktop/scripts/electron-builder-config.mjs`），于是运行时落在
 *     **app.asar 归档里**，磁盘上只有 `resources\app.asar` 一个文件，外加
 *     `resources\app.asar.unpacked\dsh\` 里那些被 `asarUnpack` 挑出来的 `.node/.dll/.exe`。
 *     Electron 自己能读 asar，所以上游跑得通 —— 但我们的 Node 脚本读不了，得先解出来。
 *
 * 我们出货的包**永远是 flat**：出桌面补丁把这两条 `{from: dsh...}` 从 `files` 挪回
 * `extraResources`（进了 app 目录会被 electron-builder 当生产依赖剪裁，`desktop-runtime.json`
 * 的 files 清单随之对不上）。保留 asar 分支是为了**上游升级后的第一次自检**能给出可读诊断，
 * 而不是让我们跑 asar。
 * 注意：布局与解析模式（`profileResolution`）是两件事，别混 —— 见 `verify-portable.mjs`。
 *
 * 上层两个消费者：
 *   · `package-desktop-portable.mjs` 只要 descriptor（一个 JSON，用 extractFile 取，很便宜）；
 *   · `verify-portable.mjs` 要整棵树做 sha256 全量校验和依赖图校验（得 extractAll + 合入 unpacked）。
 */

import { extractAll, extractFile } from '@electron/asar'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 运行时树的清单文件名，与 `runtime-tree.ts` 的 `DESKTOP_RUNTIME_FILE` 一致。 */
export const RUNTIME_DESCRIPTOR = 'desktop-runtime.json'

/**
 * 判断一个 win-unpacked 用的是哪代布局。
 * @param appDir - win-unpacked 目录（含 `resources\`）。
 * @returns 布局描述；`layout` 为 `'missing'` 表示两边都没有，app 目录不完整。
 */
export function detectRuntimeLayout(appDir) {
  const resources = join(appDir, 'resources')
  const flat = join(resources, 'dsh', RUNTIME_DESCRIPTOR)
  if (existsSync(flat)) return { layout: 'flat', resources, runtimeDir: join(resources, 'dsh') }
  const asarPath = join(resources, 'app.asar')
  if (existsSync(asarPath)) return { layout: 'asar', resources, asarPath }
  return { layout: 'missing', resources }
}

/**
 * 读取运行时清单 `desktop-runtime.json`。
 * @param appDir - win-unpacked 目录。
 * @returns `{ layout, descriptor, ... }`，asar 布局下额外带 `asarPath`。
 */
export function readRuntimeDescriptor(appDir) {
  const info = detectRuntimeLayout(appDir)
  if (info.layout === 'flat') {
    return { ...info, descriptor: JSON.parse(readFileSync(join(info.runtimeDir, RUNTIME_DESCRIPTOR), 'utf8')) }
  }
  if (info.layout === 'asar') {
    let body
    try {
      body = extractFile(info.asarPath, `dsh/${RUNTIME_DESCRIPTOR}`)
    } catch (error) {
      throw new Error(`从 app.asar 取 dsh/${RUNTIME_DESCRIPTOR} 失败：${error.message}`)
    }
    if (body === undefined || body === null) {
      throw new Error(`app.asar 里没有 dsh/${RUNTIME_DESCRIPTOR}（上游布局又变了？）`)
    }
    return { ...info, descriptor: JSON.parse(body.toString('utf8')) }
  }
  throw new Error(`既没有 resources\\dsh\\${RUNTIME_DESCRIPTOR} 也没有 resources\\app.asar（app 目录不完整？）`)
}

/**
 * 把运行时树物化成**真实目录**，好让纯 Node 脚本能按普通文件系统读它。
 *
 * asar 布局下：整包解到临时目录，再把 `app.asar.unpacked\dsh` 合进去 ——
 * 被 `asarUnpack` 挑走的 `.node/.dll/.exe` 不在归档里，却是 `files` 清单的一部分，
 * 少合就会在完整性校验时「缺文件」。
 *
 * @param appDir - win-unpacked 目录。
 * @returns `{ layout, runtimeDir, cleanup }`；`cleanup()` 只会删临时解出来的那份，
 *   flat 布局下是空操作（那份是产物自带的，不能删）。
 */
export function materializeRuntimeDir(appDir) {
  const info = detectRuntimeLayout(appDir)
  if (info.layout === 'flat') return { layout: 'flat', runtimeDir: info.runtimeDir, cleanup: () => undefined }
  if (info.layout === 'missing') {
    throw new Error(`既没有 resources\\dsh 也没有 resources\\app.asar（app 目录不完整？）`)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-runtime-asar-'))
  extractAll(info.asarPath, scratch)
  const runtimeDir = join(scratch, 'dsh')
  if (!existsSync(join(runtimeDir, RUNTIME_DESCRIPTOR))) {
    throw new Error(`app.asar 解出来没有 dsh/${RUNTIME_DESCRIPTOR}（上游布局又变了？）`)
  }
  const unpacked = join(info.resources, 'app.asar.unpacked', 'dsh')
  if (existsSync(unpacked)) cpSync(unpacked, runtimeDir, { recursive: true })
  return {
    layout: 'asar',
    runtimeDir,
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  }
}
