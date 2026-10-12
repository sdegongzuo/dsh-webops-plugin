/** 保留式开发装配的真实文件行为：优先级、既有目标拒绝及旧数据保留。 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// 脚本由 Node 直接运行，测试也通过相同入口调用。
// @ts-expect-error 独立脚本没有 TypeScript 声明文件。
import { prepareDevelopmentProfile, registerDevelopmentPlugin } from '../scripts/prepare-development-profile.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'webops-dev-profile-'))
  const packageAt = (path: string, name: string, dependencies = {}) => {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }))
  }
  const cliDir = join(root, 'cli')
  const hostDir = join(root, 'host')
  const dependencyDir = join(root, 'hoist')
  const shared = join(root, 'workspace-shared')
  packageAt(shared, 'shared')
  packageAt(cliDir, '@deepseek-ai/dsh', { shared: 'workspace:*' })
  packageAt(hostDir, '@deepseek-ai/dsh-desktop-host')
  packageAt(join(dependencyDir, 'shared'), 'shared')
  packageAt(join(dependencyDir, 'dsh-webops-plugin'), 'dsh-webops-plugin')
  mkdirSync(join(cliDir, 'node_modules'))
  symlinkSync(shared, join(cliDir, 'node_modules', 'shared'), process.platform === 'win32' ? 'junction' : 'dir')
  const options = {
    projectDir: join(root, 'project'), dependencyDir, cliDir, hostDir,
    release: { version: '1.0.0' }, platform: { platform: 'win32', arch: 'x64' }, excluded: ['dsh-webops-plugin'],
    metadata: (directory: string) => writeFileSync(join(directory, 'package.json'), '{"private":true}', { flag: 'wx' }),
  }
  return { root, shared, options }
}

describe('开发 profile 保留式装配', () => {
  it('workspace 覆盖 hoist 规划，物化一次且保留旧数据', () => {
    const { root, shared, options } = fixture()
    const sentinel = join(root, '旧数据.txt')
    writeFileSync(sentinel, '保留')
    const receipt = prepareDevelopmentProfile(options)
    expect(realpathSync(join(options.projectDir, 'node_modules', 'shared'))).toBe(realpathSync(shared))
    expect(receipt.linked).toBe(3)
    expect(readFileSync(sentinel, 'utf8')).toBe('保留')
    const before = readFileSync(join(options.projectDir, 'package.json'), 'utf8')
    expect(() => prepareDevelopmentProfile(options)).toThrow()
    expect(readFileSync(join(options.projectDir, 'package.json'), 'utf8')).toBe(before)
    const runtime = JSON.parse(readFileSync(join(options.projectDir, 'desktop-runtime.json'), 'utf8'))
    expect(runtime.sharedPackages.map((value: { name: string }) => value.name)).toEqual(expect.arrayContaining(['shared', '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']))
  })

  it('拒绝核心包版本不符，不替换已有路径', () => {
    const { options } = fixture()
    expect(() => prepareDevelopmentProfile({ ...options, release: { version: '2.0.0' } })).toThrow('版本或身份不符')
  })

  it('插件登记写到实际 home profile，保留用户配置且重复运行不叠加', () => {
    const { root } = fixture()
    const profile = join(root, 'home-profile')
    mkdirSync(profile)
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: '保留名称', dependencies: { other: '1.0.0' }, dsh: { profile: { bundles: ['other'], custom: true } } }))
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: 用户配置\n  config:\n    value: 17\n')
    const plugin = { name: 'dsh-webops-plugin', version: '0.2.17' }
    registerDevelopmentPlugin(profile, plugin, ['base'])
    registerDevelopmentPlugin(profile, plugin, ['base'])
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('保留名称')
    expect(manifest.dependencies).toEqual({ other: '1.0.0', 'dsh-webops-plugin': '0.2.17' })
    expect(manifest.dsh.profile).toEqual({ bundles: ['base', 'other', 'dsh-webops-plugin'], custom: true })
    const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: 用户配置')
    expect(patch.match(/- id: browser-electron/gu)).toHaveLength(1)
    expect(patch).toContain('appMode: false')
    expect(patch).not.toContain('fake-llm')
  })
})
