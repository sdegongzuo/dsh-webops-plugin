/** 发布复制路径不删除输入；测试目录与全部证据保留在D盘构建根。 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planSlimAppCopy } from '../scripts/slim-portable-app.mjs'
const { buildRoot } = await import(new URL('../scripts/local-env.mjs', import.meta.url).href)
const base = join(buildRoot(), 'slim-copy-test-evidence')
mkdirSync(base, { recursive: true })
function fixture(different = false) {
  const root = mkdtempSync(join(base, 'copy-'))
  const app = join(root, 'input')
  const files = {
    'locales/en-US.pak': 'english', 'locales/zh-CN.pak': '中文', 'locales/ja.pak': '日本語',
    'resources/runtime/pnpm/index.js': different ? 'pnpm-b' : 'pnpm-a',
    'resources/runtime/primary-runtime/dependencies/pnpm/index.js': 'pnpm-a',
    'main.exe': '主程序',
  }
  for (const [path, text] of Object.entries(files)) {
    const full = join(app, path)
    mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, text)
  }
  return { root, app, files }
}
describe('发布包的保留式瘦身复制', () => {
  it('只复制所需文件，全部输入逐字节保留，现行pnpm与中英文完整', () => {
    const { root, app, files } = fixture(), output = join(root, 'output')
    const plan = planSlimAppCopy(app)
    expect(plan.excluded).toHaveLength(2)
    cpSync(app, output, { recursive: true, filter: plan.filter })
    for (const [path, text] of Object.entries(files)) expect(readFileSync(join(app, path), 'utf8')).toBe(text)
    for (const path of ['main.exe', 'locales/en-US.pak', 'locales/zh-CN.pak', 'resources/runtime/primary-runtime/dependencies/pnpm/index.js']) {
      expect(readFileSync(join(output, path), 'utf8')).toBe(files[path as keyof typeof files])
    }
    expect(existsSync(join(output, 'locales/ja.pak'))).toBe(false)
    expect(existsSync(join(output, 'resources/runtime/pnpm'))).toBe(false)
  })
  it('两份pnpm有差异时拒绝计划，输入和语言包全部保留', () => {
    const { app, files } = fixture(true)
    expect(() => planSlimAppCopy(app)).toThrow(/md5/)
    for (const [path, text] of Object.entries(files)) expect(readFileSync(join(app, path), 'utf8')).toBe(text)
  })
})
