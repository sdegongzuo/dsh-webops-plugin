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
const releasePortableScript = fileURLToPath(new URL('../scripts/package-release-portable.mjs', import.meta.url))
const verifyReleaseScript = fileURLToPath(new URL('../scripts/verify-release-portable.mjs', import.meta.url))

describe('便携实例的构建接线', () => {
  it('两个出货入口都限定环境作用域并转发 exe 参数，构建补丁包含全局目录隔离', () => {
    for (const file of ['package-desktop-portable.mjs', 'package-release-portable.mjs']) {
      const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8')
      expect(source).toContain("'setlocal'")
      expect(source).toContain(' %*')
    }
    const patch = readFileSync(new URL('../docs/harness-desktop-build.patch', import.meta.url), 'utf8')
    expect(patch).toContain('configurePortableData(app, process.execPath, process.env)')
    for (const key of ['DSH_AGENTS_HOME', 'sessionData', 'LOCALAPPDATA', 'TMPDIR', 'npm_config_prefix']) {
      expect(patch).toContain(`${key}:`)
    }
  })
})
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

describe('每次发布的完整便携包', () => {
  it('发布门禁实际拒绝错版本、损坏运行时和出厂用户凭据', () => {
    const data = fixture()
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const runtime = join(data.root, 'app', 'resources', 'dsh')
    mkdirSync(runtime, { recursive: true })
    mkdirSync(join(data.root, 'home'), { recursive: true })
    const manifest = join(data.root, 'release-manifest.json')
    writeFileSync(manifest, JSON.stringify({ pluginVersion: '错误版本', dshVersion: '0.2.1-alpha.2' }))
    const bytes = Buffer.from('原始内容')
    writeFileSync(join(runtime, 'entry.js'), '损坏内容')
    writeFileSync(join(runtime, 'desktop-runtime.json'), JSON.stringify({
      platform: 'win32', arch: 'x64', release: { version: '0.2.1-alpha.2' },
      files: [{ path: 'entry.js', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
    }))
    const run = () => spawnSync(process.execPath, [verifyReleaseScript, '--dir', data.root], { encoding: 'utf8' })
    const version = run()
    expect(version.status).toBe(1)
    expect(version.stderr).toContain('插件版本与发布源码不一致')
    writeFileSync(manifest, JSON.stringify({ pluginVersion: pkg.version, dshVersion: '0.2.1-alpha.2' }))
    const corrupt = run()
    expect(corrupt.status).toBe(1)
    expect(corrupt.stderr).toContain('运行时完整性失败')
    writeFileSync(join(runtime, 'entry.js'), bytes)
    writeFileSync(join(data.root, 'home', '.credentials.yaml'), '测试凭据不能进入出厂包')
    const credentials = run()
    expect(credentials.status).toBe(1)
    expect(credentials.stderr).toContain('出厂包含用户数据')
  })
  it('真实组装三个生产插件和出厂 home，拒绝覆盖与宿主版本不匹配', () => {
    const data = fixture()
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const pluginZip = join(data.root, 'current-plugin.zip')
    const packed = spawnSync(process.execPath, [script, pkg.version, '--lib-dir', data.lib,
      '--stage-root', data.stage, '--keep-stage', '--out', pluginZip], { encoding: 'utf8' })
    expect(packed.status, packed.stderr).toBe(0)
    const app = join(data.root, 'app')
    const runtime = join(app, 'resources', 'dsh')
    mkdirSync(runtime, { recursive: true })
    const descriptor = join(runtime, 'desktop-runtime.json')
    const startup = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'lib')
    mkdirSync(startup, { recursive: true })
    writeFileSync(join(startup, 'startup.js'), 'const WEB_STARTUP_SERVICE = "webStartup";\n')
    writeFileSync(descriptor, JSON.stringify({ release: { version: '0.2.1-alpha.2' } }))
    writeFileSync(join(app, 'DeepSeek Harness.exe'), '测试本体')
    writeFileSync(join(app, 'debug.log'), '运行时日志不出货')
    const out = join(data.root, 'full.zip')
    const run = (target: string) => spawnSync(process.execPath, [releasePortableScript,
      '--app', app, '--plugin-zip', pluginZip, '--version', pkg.version,
      '--stage-root', data.stage, '--out', target], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } })
    const result = run(out)
    expect(result.status, result.stderr).toBe(0)
    const inspected = spawnSync('python', ['-c',
      'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({"bad":z.testzip(),"names":z.namelist(),"manifest":json.loads(z.read("release-manifest.json")),"profile":json.loads(z.read("home/profiles/desktop/package.json"))}))', out], { encoding: 'utf8' })
    expect(inspected.status, inspected.stderr).toBe(0)
    const zip = JSON.parse(inspected.stdout)
    expect(zip.bad).toBeNull()
    expect(zip.manifest).toEqual({ pluginVersion: pkg.version, dshVersion: '0.2.1-alpha.2' })
    expect(zip.profile.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      'dsh-webops-plugin', 'dsh-context', 'dsh-better-sidebar'])
    expect(zip.profile.dependencies['dsh-better-sidebar']).toBe('0.25.0')
    const adapted = spawnSync('python', ['-c',
      'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read("home/profiles/desktop/node_modules/dsh-better-sidebar/lib/index.js").decode())', out], { encoding: 'utf8' })
    expect(adapted.status, adapted.stderr).toBe(0)
    expect(adapted.stdout).toContain('ctx.get("connection")')
    expect(adapted.stdout).toContain('ctx.get("webRuntime")?.trustedHosts ?? []')
    expect(adapted.stdout).not.toContain('ctx.webRuntime.trustedHosts')
    expect(zip.names).toContain('home/profiles/desktop/node_modules/dsh-better-sidebar/dsh-host-compatibility.json')
    for (const name of ['dsh-webops-plugin', 'dsh-context', 'dsh-better-sidebar']) {
      expect(zip.names).toContain(`home/profiles/desktop/node_modules/${name}/package.json`)
    }
    expect(zip.names.some((name: string) => /fake-llm|debug\.log|credentials|conversations/.test(name))).toBe(false)
    const digest = () => createHash('sha256').update(readFileSync(out)).digest('hex')
    const before = digest()
    expect(run(out).status).toBe(1)
    expect(digest()).toBe(before)
    writeFileSync(descriptor, JSON.stringify({ release: { version: '0.2.1-alpha.1' } }))
    const wrong = run(join(data.root, 'incompatible.zip'))
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain('peerDependencies')
    expect(readdirSync(data.root)).not.toContain('incompatible.zip')
  }, 20_000)
})

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
