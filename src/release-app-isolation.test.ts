/** 基包升级必须来自补丁源码，拒绝未知入口，保留显式工作区设置。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 独立 Node 脚本没有声明文件。
import { portableSource, overlayPortableMain, portableWorkspaceModule } from '../scripts/release-app-isolation.mjs'

const patch = readFileSync(new URL('../docs/harness-desktop-build.patch', import.meta.url), 'utf8')
describe('发布基包的目录隔离升级', () => {
  it('提取实际补丁源码，损坏的长度与未知基包明确拒绝', () => {
    const source = portableSource(patch)
    expect(source).toContain('DSH_PORTABLE_DOCUMENTS_DIR:')
    expect(source).toContain('realpathSync(detected)')
    expect(() => portableSource(patch.replace('@@ -0,0 +1,69 @@', '@@ -0,0 +1,70 @@'))).toThrow('长度不符')
    expect(() => overlayPortableMain('未知桌面入口', source)).toThrow('替换目标必须唯一')
  })
  it('默认工作区使用包内目录，显式设置仍优先，已修改输入不会再次处理', () => {
    const original = 'function f(documentsDirectory, internals){let directory = documentsDirectory;return directory;}'
    const updated = portableWorkspaceModule(original, patch)
    const evaluate = new Function(`${updated};return f`)()
    expect(evaluate('指定目录', { environment: { DSH_PORTABLE_DOCUMENTS_DIR: '包内目录' } })).toBe('指定目录')
    expect(evaluate(undefined, { environment: { DSH_PORTABLE_DOCUMENTS_DIR: '包内目录' } })).toBe('包内目录')
    expect(() => portableWorkspaceModule(updated, patch)).toThrow('替换目标必须唯一')
  })
})
