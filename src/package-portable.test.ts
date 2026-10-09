/** 保留式打包实跑：只创建唯一测试目录，保留全部文件，不调用删除分支。 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/package-portable.mjs', import.meta.url))
const updateScript = fileURLToPath(new URL('../scripts/package-plugin-update.mjs', import.meta.url))
const zipper = fileURLToPath(new URL('../scripts/zip-stage.py', import.meta.url))
const desktopVersionScript = fileURLToPath(new URL('../scripts/desktop-release-version.mjs', import.meta.url))
const localPaths = await import(new URL('../scripts/local-env.mjs', import.meta.url).href) as {
  buildRoot(): string
}
const testRoot = join(localPaths.buildRoot(), 'package-test-evidence')
if (process.platform === 'win32' && !/^D:[\\/]/i.test(testRoot)) {
  throw new Error('保留式打包测试需要将 DSH_DESKTOP_BUILD_ROOT 配置到 D 盘，拒绝向其他盘写入测试文件')
}

function fixture(skipAsset?: string) {
  mkdirSync(testRoot, { recursive: true })
  const root = mkdtempSync(join(testRoot, 'webops-package-keep-'))
  const lib = join(root, 'lib')
  mkdirSync(join(lib, 'browser-electron'), { recursive: true })
  mkdirSync(join(lib, 'fake-llm'), { recursive: true })
  for (const name of ['index.js', 'client.js']) writeFileSync(join(lib, name), `// ${name}\n`)
  for (const name of ['host.cjs', 'action-overlay.cjs', 'action-overlay.html', 'tabbar.html', 'tabbar-preload.cjs']) {
    if (name === skipAsset) continue
    writeFileSync(join(lib, 'browser-electron', name), `测试资产 ${name}`)
  }
  writeFileSync(join(lib, 'fake-llm', 'index.js'), '测试模型不应出货')
  return { root, lib, stage: join(root, 'stage') }
}

function pack(lib: string, stage: string, out: string) {
  return spawnSync(process.execPath, [script, '0.2.13', '--lib-dir', lib,
    '--stage-root', stage, '--keep-stage', '--out', out], { encoding: 'utf8' })
}

describe('纯插件包保留模式的真实 ZIP', () => {
  it('桌面包版本读取实际 DSH 清单，错误预期与缺失版本均拒绝', () => {
    const data = fixture()
    const runtime = join(data.root, 'app', 'resources', 'dsh')
    mkdirSync(runtime, { recursive: true })
    const descriptor = join(runtime, 'desktop-runtime.json')
    writeFileSync(descriptor, JSON.stringify({ release: { version: '0.2.1-alpha.1' } }))
    const run = (expected: string) => spawnSync(process.execPath, [desktopVersionScript,
      '--app', join(data.root, 'app'), '--expected', expected], { encoding: 'utf8' })
    expect(run('0.2.15').status).toBe(1)
    const result = run('0.2.1-alpha.1')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('0.2.1-alpha.1')
    writeFileSync(descriptor, JSON.stringify({ release: {} }))
    expect(run('0.2.1-alpha.1').status).toBe(1)
    expect(run('0.2.1-alpha.1').stderr).toContain('拒绝回退到插件版本')
  })
  it.each([script, updateScript])('遗漏 --lib-dir 时写入前拒绝：%s', (target) => {
    const data = fixture()
    const before = readdirSync(data.root)
    const result = spawnSync(process.execPath, [target, '--stage-root', data.stage,
      '--keep-stage', '--out', join(data.root, '未执行.zip')], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--lib-dir 必须显式指定')
    expect(readdirSync(data.root)).toEqual(before)
  })

  it.each(['host.cjs', 'action-overlay.cjs', 'action-overlay.html', 'tabbar.html', 'tabbar-preload.cjs'])
  ('缺少 %s 时在打包前拒绝', (asset) => {
    const data = fixture(asset)
    const result = pack(data.lib, data.stage, join(data.root, 'incomplete.zip'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(asset)
    expect(readdirSync(data.root)).toEqual(['lib'])
  })
  it('创建缺失父目录，保留含单引号路径的完整生产载荷，并拒绝覆盖', () => {
    const data = fixture()
    const out = join(data.root, "新目录'带引号", 'plugin.zip')
    const result = pack(data.lib, data.stage, out)
    expect(result.status, result.stderr).toBe(0)
    const inspected = spawnSync('python', ['-c',
      'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({"bad":z.testzip(),"names":z.namelist(),"pkg":json.loads(z.read("package.json")),"asset":z.read("lib/browser-electron/tabbar.html").decode("utf-8")},ensure_ascii=True))',
      out], { encoding: 'utf8' })
    expect(inspected.status, inspected.stderr).toBe(0)
    const zip = JSON.parse(inspected.stdout) as {
      bad: string | null
      names: string[]
      pkg: { exports: Record<string, unknown>; devDependencies?: unknown; scripts?: unknown }
      asset: string
    }
    expect(zip.bad).toBeNull()
    expect(zip.names).toContain('INSTALL.md')
    expect(zip.names).toContain('package.json')
    expect(zip.names.some(name => name.startsWith('home/') || name.startsWith('app/'))).toBe(false)
    expect(zip.asset).toBe('测试资产 tabbar.html')
    expect(zip.names.some(name => name.startsWith('lib/fake-llm/'))).toBe(false)
    expect(zip.pkg.exports).not.toHaveProperty('./fake-llm')
    expect(zip.pkg.devDependencies).toBeUndefined()
    expect(zip.pkg.scripts).toBeUndefined()
    const installed = join(data.root, 'desktop', 'home', 'profiles', 'desktop', 'node_modules', 'dsh-webops-plugin')
    mkdirSync(join(installed, 'lib'), { recursive: true })
    const profile = join(data.root, 'desktop', 'home', 'profiles', 'desktop', 'package.json')
    writeFileSync(profile, '用户插件登记哨兵')
    writeFileSync(join(installed, 'lib', 'old-chunk.js'), '旧 chunk 保留哨兵')
    const extracted = spawnSync('python', ['-c',
      'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', out, installed], { encoding: 'utf8' })
    expect(extracted.status, extracted.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version).toBe('0.2.13')
    expect(readFileSync(profile, 'utf8')).toBe('用户插件登记哨兵')
    expect(readFileSync(join(installed, 'lib', 'old-chunk.js'), 'utf8')).toBe('旧 chunk 保留哨兵')
    const before = createHash('sha256').update(readFileSync(out)).digest('hex')
    const stages = readdirSync(data.stage)
    const refused = pack(data.lib, data.stage, out)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('目标已存在')
    expect(createHash('sha256').update(readFileSync(out)).digest('hex')).toBe(before)
    expect(readdirSync(data.stage)).toEqual(stages)
    expect(stages).toHaveLength(1)
  })

  it('缺少参数值时明确拒绝，不回退到旧 lib', () => {
    const result = spawnSync(process.execPath, [script, '--lib-dir', '--keep-stage'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--lib-dir 缺少路径值')
  })

  it('压缩器自身也保护既有 ZIP，不依赖上游预检查', () => {
    const data = fixture()
    const out = join(data.root, 'existing.zip')
    writeFileSync(out, '既有产物哨兵')
    const result = spawnSync('python', [zipper, '--stage', data.lib, '--out', out, '--no-overwrite'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('目标已存在')
    expect(readFileSync(out, 'utf8')).toBe('既有产物哨兵')
  })
})
