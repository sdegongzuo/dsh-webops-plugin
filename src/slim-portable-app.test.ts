/**
 * 便携包瘦身脚本的守卫测试（scripts/slim-portable-app.mjs）。
 *
 * 2026-10-14 背景：便携包 1057MB 解压体积里，上游基包把同一份 pnpm 11.7.0 打在
 * `resources/runtime/pnpm/`（旧布局残留）与 `resources/runtime/primary-runtime/dependencies/pnpm/`
 * （现行布局，宿主实际使用）两处；Chromium 语言包 55 个 48MB 也全量发货。
 * 瘦身本身是「删文件」，所以这里重点守三件事：
 *   1. 该删的删干净（重复 pnpm 整树、非中英文语言包），该留的一根毛不少（现行布局、白名单语言包）；
 *   2. 证明不了逐字节相同就**必须中止**，且中止时旧布局那份必须**原样还在** ——
 *      静默删错就是用户运行时缺 pnpm，而这种包单测全绿、GUI 门禁也未必炸；
 *   3. 上游已修掉重复（只有一处 pnpm）时按「无可清理」正常结束，不把失败当成功也不把正常当失败。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { slimApp } from '../scripts/slim-portable-app.mjs'

const LEGACY_PNPM = join('resources', 'runtime', 'pnpm')
const CANONICAL_PNPM = join('resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slim-portable-app-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(rel: string, content: string) {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

/** 造一个最小 app 树：locales 全量 + 两份逐字节相同的 pnpm。 */
function seedApp() {
  write(join('locales', 'en-US.pak'), 'en-us')
  write(join('locales', 'zh-CN.pak'), 'zh-cn')
  write(join('locales', 'ja.pak'), 'ja')
  write(join('locales', 'de.pak'), 'de')
  for (const rel of ['dist/pnpm.mjs', 'dist/worker.js', 'package.json']) {
    write(join(CANONICAL_PNPM, rel), `pnpm-${rel}`)
    write(join(LEGACY_PNPM, rel), `pnpm-${rel}`)
  }
}

function exists(rel: string) {
  try {
    statSync(join(root, rel))
    return true
  } catch {
    return false
  }
}

describe('slimApp 语言包', () => {
  it('只保留白名单中英文，其余 pak 删掉', () => {
    seedApp()
    const result = slimApp(root)
    expect(result.locales.removed).toBe(2)
    expect(exists(join('locales', 'en-US.pak'))).toBe(true)
    expect(exists(join('locales', 'zh-CN.pak'))).toBe(true)
    expect(exists(join('locales', 'ja.pak'))).toBe(false)
    expect(exists(join('locales', 'de.pak'))).toBe(false)
  })

  it('白名单语言包缺失时中止，且不动任何文件', () => {
    write(join('locales', 'ja.pak'), 'ja')
    expect(() => slimApp(root)).toThrow(/zh-CN.pak/)
    expect(exists(join('locales', 'ja.pak'))).toBe(true)
  })
})

describe('slimApp 重复 pnpm', () => {
  it('两份逐字节相同时删旧布局，现行布局原样保留', () => {
    seedApp()
    const result = slimApp(root)
    expect(result.legacyPnpm.removed).toBe(true)
    expect(exists(LEGACY_PNPM)).toBe(false)
    expect(exists(join(CANONICAL_PNPM, 'dist/pnpm.mjs'))).toBe(true)
  })

  it('内容有一处不同就中止，且旧布局那份原样还在（反向验证：删错会静默缺件）', () => {
    seedApp()
    // 同长度不同字节：绕过大小检查，逼它走到 md5 那道关
    write(join(LEGACY_PNPM, 'dist/worker.js'), 'pnpm-dist/worker.jz')
    expect(() => slimApp(root)).toThrow(/md5/)
    expect(exists(join(LEGACY_PNPM, 'dist/worker.js'))).toBe(true)
    expect(exists(join(CANONICAL_PNPM, 'dist/worker.js'))).toBe(true)
  })

  it('文件集合不一致（旧布局多一个文件）就中止', () => {
    seedApp()
    write(join(LEGACY_PNPM, 'dist/extra.js'), 'extra')
    expect(() => slimApp(root)).toThrow(/文件集合不一致/)
    expect(exists(join(LEGACY_PNPM, 'dist/extra.js'))).toBe(true)
  })

  it('只有旧布局、没有现行布局时拒绝盲删', () => {
    for (const rel of ['dist/pnpm.mjs', 'package.json']) write(join(LEGACY_PNPM, rel), `pnpm-${rel}`)
    expect(() => slimApp(root)).toThrow(/拒绝盲删/)
    expect(exists(LEGACY_PNPM)).toBe(true)
  })

  it('上游已修掉重复（只有现行布局）时按无可清理正常结束', () => {
    write(join(CANONICAL_PNPM, 'dist/pnpm.mjs'), 'pnpm-dist/pnpm.mjs')
    write(join('locales', 'en-US.pak'), 'en-us')
    write(join('locales', 'zh-CN.pak'), 'zh-cn')
    const result = slimApp(root)
    expect(result.legacyPnpm.removed).toBe(false)
    expect(exists(join(CANONICAL_PNPM, 'dist/pnpm.mjs'))).toBe(true)
  })
})

describe('slimApp CLI 直跑', () => {
  it('node 直接执行脚本也能瘦身成功（vitest 会给 require 垫片，导入级测试抓不到 CLI 崩溃）', () => {
    seedApp()
    const script = fileURLToPath(new URL('../scripts/slim-portable-app.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, '--app', root], { encoding: 'utf8' })
    expect(result.status, `CLI 非零退出：${result.stderr}`).toBe(0)
    const summary = JSON.parse(result.stdout)
    expect(summary.locales.removed).toBe(2)
    expect(summary.legacyPnpm.removed).toBe(true)
    expect(exists(LEGACY_PNPM)).toBe(false)
    expect(exists(join(CANONICAL_PNPM, 'dist/pnpm.mjs'))).toBe(true)
  })
})
