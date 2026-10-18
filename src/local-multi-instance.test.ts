/**
 * 本地多实例测试调度的回归（方案 §5：身份、失败与并发、启动与冲突）。
 *
 * 全部用**临时目录里的小 fixture** 跑真实代码路径：manifest 构建与核验、完成标记绑定、
 * 实例装配（含拒绝分支）、输入身份解析、netstat/进程清单解析、端点发现的归属核验，
 * 以及 CLI 的 artifact→assemble→status 端到端。不起 GUI、不碰 D 盘真实布局
 * （CLI 子进程用 DSH_DESKTOP_BUILD_ROOT 指到临时目录）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const lib = await import(new URL('../scripts/local-multi-instance-lib.mjs', import.meta.url).href) as {
  hashTree(root: string, options?: { ignore?: (rel: string) => boolean }): { files: Map<string, string>, bytes: number, count: number }
  treeDigest(files: Map<string, string>): string
  sha256File(path: string): string
  buildArtifactManifest(input: Record<string, unknown>): Record<string, any>
  verifyArtifact(dir: string): { manifest: Record<string, any> | undefined, problems: string[] }
  writeCompletion(dir: string, payload: Record<string, unknown>): void
  readCompletion(dir: string): Record<string, any> | undefined
  verifyCompletion(dir: string, expectedDigest?: string, kind?: string): string[]
  treeDigestOfManifestFiles(manifest: Record<string, any>): string
  assembleInstance(options: { buildRoot: string, artifactId: string, instanceId: string }): {
    instanceDir: string
    instance: Record<string, any>
    ms: number
  }
  verifyInstanceForLaunch(dir: string): { instance: Record<string, any> | undefined, problems: string[] }
  injectCredentials(dir: string, credentialsPath: string): string
  artifactDir(buildRoot: string, artifactId: string): string
  instanceDir(buildRoot: string, instanceId: string): string
  instancePluginDir(root: string): string
  instancesRoot(buildRoot: string): string
  parsePorcelain(stdout: string, repoRoot: string, hashOf: (abs: string) => string | null): Array<{ path: string, status: string, sha256: string | null }>
  gitState(repoRoot: string): { commit: string, dirty: Array<{ path: string, status: string, sha256: string | null }> }
  productionPackageJson(pkg: Record<string, any>, version: string): Record<string, any>
  materializeSource(source: { kind: string, path: string }, targetDir: string, prefix: string, scriptsRoot: string): void
  findInstanceProcesses(exePath: string, processes?: Array<{ pid: number, ppid: number, name: string, commandLine: string }>): {
    main?: { pid: number, commandLine: string }
    host?: { pid: number, commandLine: string }
    others: Array<{ pid: number }>
    cdpPort?: number
  }
  parseNetstatListening(stdout: string): Map<number, number[]>
  listenPortsOf(pid: number, byPid?: Map<number, number[]>): number[]
  discoverInstanceEndpoints(options: Record<string, any>): Promise<Record<string, any>>
}

const cliScript = fileURLToPath(new URL('../scripts/local-multi-instance.mjs', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), 'mi-lib-test-'))
}

/** 造一份「已完成」的假产物（不跑真实构建：app/home/plugin 都是小 fixture）。 */
function makeArtifact(root: string, id = 'art-1', pluginVersion = '9.9.9') {
  const dir = lib.artifactDir(root, id)
  mkdirSync(join(dir, 'app', 'resources'), { recursive: true })
  writeFileSync(join(dir, 'app', 'DeepSeek Harness.exe'), 'exe-bytes')
  writeFileSync(join(dir, 'app', 'resources', 'app.asar'), 'asar-bytes')
  mkdirSync(join(dir, 'home', 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(dir, 'home', 'profiles', 'desktop', 'package.json'), '{"dependencies":{}}')
  mkdirSync(join(dir, 'plugin', 'browser-electron'), { recursive: true })
  writeFileSync(join(dir, 'plugin', 'index.js'), 'plugin-index')
  writeFileSync(join(dir, 'plugin', 'browser-electron', 'host.cjs'), 'host')
  writeFileSync(join(dir, 'plugin', 'package.json'), JSON.stringify({ name: 'dsh-webops-plugin', version: pluginVersion }))
  const outputs: Record<string, { files: Record<string, string>, count: number, bytes: number, digest: string }> = {}
  for (const part of ['app', 'home', 'plugin']) {
    const hashed = lib.hashTree(join(dir, part))
    outputs[part] = { files: Object.fromEntries(hashed.files), count: hashed.count, bytes: hashed.bytes, digest: lib.treeDigest(hashed.files) }
  }
  const manifest = lib.buildArtifactManifest({
    artifactId: id,
    repo: { root: 'x', commit: 'a'.repeat(40), dirty: [], pluginVersion },
    source: { kind: 'zip', path: 'x.zip', sha256: 'b'.repeat(64) },
    build: {},
    outputs,
  })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const manifestFiles = new Map<string, string>()
  for (const part of ['app', 'home', 'plugin']) {
    for (const [rel, hash] of Object.entries(outputs[part]?.files ?? {})) manifestFiles.set(`${part}/${rel}`, hash)
  }
  lib.writeCompletion(dir, { kind: 'artifact', id, digest: lib.treeDigest(manifestFiles) })
  return dir
}

/** 把一棵树复制到新位置（可带 filter）—— 测试不删文件，变体都靠复制构造。rel 判据用 POSIX 风格。 */
function copyTree(from: string, to: string, filter?: (rel: string) => boolean) {
  cpSync(from, to, {
    recursive: true,
    filter: filter === undefined ? undefined : (src) => filter(relative(from, src).replaceAll('\\', '/')),
  })
}

describe('逐文件哈希与树摘要', () => {
  it('POSIX 相对路径、排序稳定、ignore 生效、字节数正确', () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'x.js'), 'xxx')
    writeFileSync(join(root, 'a', 'y.js'), 'y')
    writeFileSync(join(root, 'skip.me'), 'skip')
    const hashed = lib.hashTree(root, { ignore: (rel) => rel === 'skip.me' })
    expect([...hashed.files.keys()]).toEqual(['a/b/x.js', 'a/y.js'])
    expect(hashed.count).toBe(2)
    expect(hashed.bytes).toBe(4)
    expect(hashed.files.get('a/b/x.js')).toBe(lib.sha256File(join(root, 'a', 'b', 'x.js')))
  })

  it('摘要与键顺序无关、与内容相关', () => {
    const left = new Map([['b', 'h2'], ['a', 'h1']])
    const right = new Map([['a', 'h1'], ['b', 'h2']])
    expect(lib.treeDigest(left)).toBe(lib.treeDigest(right))
    expect(lib.treeDigest(new Map([['a', 'h1'], ['b', 'h3']]))).not.toBe(lib.treeDigest(left))
  })

  it('符号链接/junction 拒绝作为快照内容（方案禁用共享链接）', () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'real'), { recursive: true })
    writeFileSync(join(root, 'real', 'a.txt'), 'x')
    symlinkSync(join(root, 'real'), join(root, 'link'), 'junction')
    expect(() => lib.hashTree(root)).toThrow(/符号链接/)
  })
})

describe('产物 manifest 与完成标记', () => {
  it('即使完成标记与摘要匹配，带凭据的模板仍拒绝消费', () => {
    const root = fixtureRoot()
    const dir = makeArtifact(root)
    writeFileSync(join(dir, 'home', '.credentials.yaml'), '仅测试占位')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    manifest.outputs.home.files['.credentials.yaml'] = lib.sha256File(join(dir, 'home', '.credentials.yaml'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    lib.writeCompletion(dir, { kind: 'artifact', digest: lib.treeDigestOfManifestFiles(manifest) })
    expect(lib.verifyArtifact(dir).problems).toContain('产物含实例凭据，拒绝消费；凭据只能在实例装配后注入')
    expect(() => lib.assembleInstance({ buildRoot: root, artifactId: 'art-1', instanceId: 'blocked' })).toThrow('产物含实例凭据')
  })
  it('完整产物通过；缺文件/多文件/内容变化分别拒绝', () => {
    const root = fixtureRoot()
    const dir = makeArtifact(root)
    expect(lib.verifyArtifact(dir).problems).toEqual([])

    const missing = join(root, 'missing')
    copyTree(dir, missing, (rel) => rel !== 'app/DeepSeek Harness.exe')
    const missingProblems = lib.verifyArtifact(missing).problems
    expect(missingProblems.some((problem) => problem.includes('缺文件'))).toBe(true)

    const extra = join(root, 'extra')
    copyTree(dir, extra)
    writeFileSync(join(extra, 'app', 'sneaky.txt'), 'x')
    expect(lib.verifyArtifact(extra).problems.some((problem) => problem.includes('多出文件'))).toBe(true)

    const changed = join(root, 'changed')
    copyTree(dir, changed)
    writeFileSync(join(changed, 'plugin', 'index.js'), 'tampered')
    expect(lib.verifyArtifact(changed).problems.some((problem) => problem.includes('内容变化'))).toBe(true)
  })

  it('完成标记缺失或绑定不一致都拒绝消费', () => {
    const root = fixtureRoot()
    const dir = makeArtifact(root)

    const noMarker = join(root, 'no-marker')
    copyTree(dir, noMarker, (rel) => rel !== '.mi-complete')
    expect(lib.verifyArtifact(noMarker).problems.some((problem) => problem.includes('完成标记缺失'))).toBe(true)

    // manifest 被改（哈希对不上）→ 完成标记绑定的摘要失配 → 拒绝。
    const tampered = join(root, 'tampered-manifest')
    copyTree(dir, tampered)
    const manifest = JSON.parse(readFileSync(join(tampered, 'manifest.json'), 'utf8'))
    manifest.outputs.app.files['DeepSeek Harness.exe'] = 'f'.repeat(64)
    writeFileSync(join(tampered, 'manifest.json'), JSON.stringify(manifest, null, 2))
    const problems = lib.verifyArtifact(tampered).problems
    expect(problems.some((problem) => problem.includes('内容变化'))).toBe(true)
    expect(problems.some((problem) => problem.includes('摘要'))).toBe(true)
  })

  it('manifest 缺失或损坏时明确拒绝，不猜内容', () => {
    const root = fixtureRoot()
    const dir = makeArtifact(root)
    const broken = join(root, 'broken')
    copyTree(dir, broken)
    writeFileSync(join(broken, 'manifest.json'), '{ not json')
    const problems = lib.verifyArtifact(broken).problems
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('manifest')
  })
})

describe('实例装配', () => {
  it('同一 artifact 装配 A/B：安装哈希一致，各带完成标记', () => {
    const root = fixtureRoot()
    makeArtifact(root)
    const a = lib.assembleInstance({ buildRoot: root, artifactId: 'art-1', instanceId: 'A' })
    const b = lib.assembleInstance({ buildRoot: root, artifactId: 'art-1', instanceId: 'B' })
    expect(a.instance.artifactId).toBe('art-1')
    expect(b.instance.artifactId).toBe('art-1')
    expect(a.instance.plugin.digest).toBe(b.instance.plugin.digest)
    expect(a.instance.app.digest).toBe(b.instance.app.digest)
    expect(lib.readCompletion(a.instanceDir)?.kind).toBe('instance')
    expect(lib.readCompletion(b.instanceDir)?.kind).toBe('instance')
    expect(lib.verifyInstanceForLaunch(a.instanceDir).problems).toEqual([])
    expect(lib.verifyInstanceForLaunch(b.instanceDir).problems).toEqual([])
    // 实例里的 app 与产物逐文件一致（装配即复制，不重新生成）。
    expect(lib.hashTree(join(a.instanceDir, 'app')).files.get('DeepSeek Harness.exe'))
      .toBe(lib.sha256File(join(a.instanceDir, 'app', 'DeepSeek Harness.exe')))
  })

  it('已存在实例目录直接拒绝；两个装配者竞争同一实例只有一个成功', async () => {
    const root = fixtureRoot()
    makeArtifact(root)
    lib.assembleInstance({ buildRoot: root, artifactId: 'art-1', instanceId: 'A' })
    expect(() => lib.assembleInstance({ buildRoot: root, artifactId: 'art-1', instanceId: 'A' }))
      .toThrow(/已存在/)

    // 真并发：两个 CLI 装配者抢同一个实例目录，只能一个成功（mkdir 独占创建是原子判据）。
    const run = () => new Promise<{ status: number | null, stderr: string }>((resolveRace) => {
      const child = spawn(process.execPath, [cliScript, 'assemble', '--artifact', 'art-1', '--instance', 'C'], {
        env: { ...process.env, DSH_DESKTOP_BUILD_ROOT: root },
      })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
      child.on('close', (status: number | null) => resolveRace({ status, stderr }))
    })
    const results = await Promise.all([run(), run()])
    const ok = results.filter((result) => result.status === 0)
    const refused = results.filter((result) => result.status !== 0)
    expect(ok).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0]?.stderr).toContain('已存在')
  }, 30_000)

  it('产物被篡改时拒绝装配，且不创建实例目录', () => {
    const root = fixtureRoot()
    const dir = makeArtifact(root)
    writeFileSync(join(dir, 'app', 'sneaky.txt'), 'x')
    expect(() => lib.assembleInstance({ buildRoot: root, artifactId: 'art-1', instanceId: 'A' }))
      .toThrow(/校验不通过/)
    expect(() => lib.hashTree(lib.instancesRoot(root))).toThrow() // 实例根目录根本没被创建
  })

  it('装配后 app/插件被改动则启动门禁拒绝（标记在也不放行）', () => {
    const root = fixtureRoot()
    makeArtifact(root)
    const { instanceDir } = lib.assembleInstance({ buildRoot: root, artifactId: 'art-1', instanceId: 'A' })
    writeFileSync(join(lib.instancePluginDir(instanceDir), 'index.js'), 'tampered')
    const problems = lib.verifyInstanceForLaunch(instanceDir).problems
    expect(problems.some((problem) => problem.includes('插件'))).toBe(true)

    const root2 = fixtureRoot()
    makeArtifact(root2)
    const second = lib.assembleInstance({ buildRoot: root2, artifactId: 'art-1', instanceId: 'A' })
    writeFileSync(join(second.instanceDir, 'app', 'resources', 'app.asar'), 'tampered')
    expect(lib.verifyInstanceForLaunch(second.instanceDir).problems.some((problem) => problem.includes('app/'))).toBe(true)
  })

  it('凭据按实例注入：不覆盖、不进启动门禁哈希', () => {
    const root = fixtureRoot()
    makeArtifact(root)
    const { instanceDir } = lib.assembleInstance({ buildRoot: root, artifactId: 'art-1', instanceId: 'A' })
    const credentials = join(root, 'credentials.yaml')
    writeFileSync(credentials, 'token: 测试占位\n')
    const injected = lib.injectCredentials(instanceDir, credentials)
    expect(injected).toBe(join(instanceDir, 'home', '.credentials.yaml'))
    expect(readFileSync(injected, 'utf8')).toContain('测试占位')
    expect(() => lib.injectCredentials(instanceDir, credentials)).toThrow(/已注入过/)
    // 凭据在 home 下，而门禁只验 app 与插件 → 注入不影响放行。
    expect(lib.verifyInstanceForLaunch(instanceDir).problems).toEqual([])
  })
})

describe('输入身份解析', () => {
  it('porcelain 解析覆盖修改/未跟踪/改名/引号路径', () => {
    const stdout = [
      ' M src/a.ts',
      '?? untracked.txt',
      'R  old-name.ts -> new-name.ts',
      'M  "weird name.ts"',
      'D  gone.ts',
    ].join('\n')
    const dirty = lib.parsePorcelain(stdout, 'C:/repo', () => 'hash-of-file')
    expect(dirty.map((entry) => entry.path)).toEqual(['src/a.ts', 'untracked.txt', 'new-name.ts', 'weird name.ts', 'gone.ts'])
    expect(dirty.map((entry) => entry.status)).toEqual(['M', '??', 'R', 'M', 'D'])
    expect(dirty.every((entry) => entry.sha256 === 'hash-of-file')).toBe(true)
    const withMissing = lib.parsePorcelain(' D gone.ts', 'C:/repo', () => null)
    expect(withMissing[0]?.sha256).toBeNull()
  })

  it('gitState 对真实仓库：commit 40 位，脏文件哈希与磁盘一致', () => {
    const state = lib.gitState(repoRoot)
    expect(state.commit).toMatch(/^[0-9a-f]{40}$/)
    for (const entry of state.dirty) {
      if (entry.sha256 === null) continue
      expect(entry.sha256).toBe(lib.sha256File(join(repoRoot, entry.path.split('/').join('\\'))))
    }
  })

  it('生产 package.json 剔除 devDeps/scripts 与 fake-llm 导出', () => {
    const pkg = { name: 'x', version: '1.0.0', exports: { '.': './lib/index.js', './fake-llm': './lib/fake-llm/index.js' }, devDependencies: { a: '1' }, scripts: { build: 'x' } }
    const release = lib.productionPackageJson(pkg, '2.0.0')
    expect(release.version).toBe('2.0.0')
    expect(release.devDependencies).toBeUndefined()
    expect(release.scripts).toBeUndefined()
    expect(release.exports).toEqual({ '.': './lib/index.js' })
  })
})

describe('进程与端口解析', () => {
  const exe = 'D:/instances/A/app/DeepSeek Harness.exe'

  it('按 exe 路径区分主进程/宿主子进程/其他，并解析 CDP 端口', () => {
    const processes = [
      { pid: 10, ppid: 1, name: 'DeepSeek Harness.exe', commandLine: `"${exe}" --remote-debugging-port=9333` },
      { pid: 11, ppid: 10, name: 'DeepSeek Harness.exe', commandLine: `"${exe}" --type=gpu-process --user-data-dir="D:/instances/A/data/electron"` },
      { pid: 12, ppid: 10, name: 'DeepSeek Harness.exe', commandLine: `"${exe}" --expose-internals D:/instances/A/app/resources/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js D:/instances/A/app/resources/dsh D:/instances/A/home/profiles/desktop` },
      { pid: 99, ppid: 1, name: 'DeepSeek Harness.exe', commandLine: '"D:/instances/B/app/DeepSeek Harness.exe" --remote-debugging-port=9334' },
      { pid: 98, ppid: 1, name: 'node.exe', commandLine: 'node something' },
    ]
    const found = lib.findInstanceProcesses(exe, processes)
    expect(found.main?.pid).toBe(10)
    expect(found.host?.pid).toBe(12)
    expect(found.cdpPort).toBe(9333)
    expect(found.others.map((entry) => entry.pid)).toEqual([11])
  })

  it('netstat LISTENING 行解析出 PID→端口，忽略非 LISTENING 与 IPv6 之外的噪声', () => {
    const stdout = [
      '  TCP    127.0.0.1:50158        0.0.0.0:0              LISTENING       3764',
      '  TCP    0.0.0.0:9333          0.0.0.0:0              LISTENING       51908',
      '  TCP    127.0.0.1:50158        127.0.0.1:50159        ESTABLISHED     3764',
      '  UDP    0.0.0.0:5353          0.0.0.0:0                           1234',
    ].join('\r\n')
    const byPid = lib.parseNetstatListening(stdout)
    expect(lib.listenPortsOf(3764, byPid)).toEqual([50158])
    expect(lib.listenPortsOf(51908, byPid)).toEqual([9333])
    expect(lib.listenPortsOf(1234, byPid)).toEqual([])
  })
})

describe('端点发现与归属核验', () => {
  const exe = 'D:/instances/A/app/DeepSeek Harness.exe'
  const hostCommand = `"${exe}" --expose-internals D:/instances/A/app/resources/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`
  const mainCommand = `"${exe}" --remote-debugging-port=9333`

  it('宿主动态端口按子进程归属发现，CDP 监听者必须是主 exe', async () => {
    const discovery = await lib.discoverInstanceEndpoints({
      exePath: exe,
      cdpPort: 9333,
      timeoutMs: 8000,
      listProcesses: () => [
        { pid: 100, ppid: 1, name: 'DeepSeek Harness.exe', commandLine: mainCommand },
        { pid: 101, ppid: 100, name: 'DeepSeek Harness.exe', commandLine: hostCommand },
      ],
      listenPortsOf: (pid: number) => (pid === 101 ? [50158] : []),
      probeHttp: async (port: number) => port === 50158,
      portListener: (port: number) => (port === 9333 ? { pid: 100, name: 'DeepSeek Harness.exe' } : undefined),
      fetchImpl: async () => ({ json: async () => [{ type: 'page', url: 'dsh-app://app/' }] }),
    })
    expect(discovery.ok).toBe(true)
    expect(discovery.endpoint).toBe('http://127.0.0.1:50158')
    expect(discovery.hostPid).toBe(101)
    expect(discovery.exePid).toBe(100)
    expect(discovery.cdpReady).toBe(true)
    expect(discovery.problems).toEqual([])
  })

  it('CDP 端口被其他进程占用：明确失败，不连接其他实例充数', async () => {
    const discovery = await lib.discoverInstanceEndpoints({
      exePath: exe,
      cdpPort: 9333,
      timeoutMs: 8000,
      listProcesses: () => [
        { pid: 100, ppid: 1, name: 'DeepSeek Harness.exe', commandLine: mainCommand },
        { pid: 101, ppid: 100, name: 'DeepSeek Harness.exe', commandLine: hostCommand },
      ],
      listenPortsOf: (pid: number) => (pid === 101 ? [50158] : []),
      probeHttp: async () => true,
      portListener: (port: number) => (port === 9333 ? { pid: 999, name: 'other.exe' } : undefined),
      fetchImpl: async () => ({ json: async () => [] }),
    })
    expect(discovery.ok).toBe(false)
    expect(discovery.problems.join('\n')).toContain('被其他进程占用')
    expect(discovery.cdpReady).toBe(false)
    // 宿主端点与 CDP 竞争无关，仍然如实发现。
    expect(discovery.endpoint).toBe('http://127.0.0.1:50158')
  })

  it('宿主子进程不出现/无监听端口/探活失败都明确报错', async () => {
    const noHost = await lib.discoverInstanceEndpoints({
      exePath: exe,
      timeoutMs: 1200,
      listProcesses: () => [{ pid: 100, ppid: 1, name: 'DeepSeek Harness.exe', commandLine: mainCommand }],
      listenPortsOf: () => [],
      probeHttp: async () => false,
    })
    expect(noHost.ok).toBe(false)
    expect(noHost.problems.join('\n')).toContain('desktop-host 子进程')

    const noPort = await lib.discoverInstanceEndpoints({
      exePath: exe,
      timeoutMs: 1200,
      listProcesses: () => [
        { pid: 100, ppid: 1, name: 'DeepSeek Harness.exe', commandLine: mainCommand },
        { pid: 101, ppid: 100, name: 'DeepSeek Harness.exe', commandLine: hostCommand },
      ],
      listenPortsOf: () => [],
      probeHttp: async () => false,
    })
    expect(noPort.ok).toBe(false)
    expect(noPort.problems.join('\n')).toContain('LISTENING')

    const deadPort = await lib.discoverInstanceEndpoints({
      exePath: exe,
      timeoutMs: 1200,
      listProcesses: () => [
        { pid: 100, ppid: 1, name: 'DeepSeek Harness.exe', commandLine: mainCommand },
        { pid: 101, ppid: 100, name: 'DeepSeek Harness.exe', commandLine: hostCommand },
      ],
      listenPortsOf: (pid: number) => (pid === 101 ? [50158] : []),
      probeHttp: async () => false,
    })
    expect(deadPort.ok).toBe(false)
    expect(deadPort.problems.join('\n')).toContain('desktop-host')
  })

  it('主进程始终不出现：超时明确失败', async () => {
    const discovery = await lib.discoverInstanceEndpoints({
      exePath: exe,
      timeoutMs: 800,
      listProcesses: () => [],
      listenPortsOf: () => [],
      probeHttp: async () => false,
    })
    expect(discovery.ok).toBe(false)
    expect(discovery.problems.join('\n')).toContain('没找到实例主进程')
  })
})

describe('来源物化', () => {
  it('目录来源按前缀复制；zip 来源只解指定前缀', () => {
    const root = fixtureRoot()
    const source = join(root, 'source')
    mkdirSync(join(source, 'app', 'resources'), { recursive: true })
    writeFileSync(join(source, 'app', 'DeepSeek Harness.exe'), 'exe')
    mkdirSync(join(source, 'home', 'profiles'), { recursive: true })
    writeFileSync(join(source, 'home', 'profiles', 'package.json'), '{}')
    const target = join(root, 'target')
    lib.materializeSource({ kind: 'dir', path: source }, target, 'app/', repoRoot)
    expect(lib.hashTree(join(target, 'app')).files.get('DeepSeek Harness.exe')).toBe(lib.sha256File(join(source, 'app', 'DeepSeek Harness.exe')))
    expect(() => lib.hashTree(join(target, 'home'))).toThrow()

    // zip 来源：python 造一个只含 app/ 与 home/ 前缀的小包，只解 app/。
    const zip = join(root, 'mini.zip')
    const packed = spawnSync('python', ['-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("app/DeepSeek Harness.exe","exe"); z.writestr("home/profiles/package.json","{}"); z.writestr("other/x.txt","x"); z.close()',
      zip], { encoding: 'utf8' })
    expect(packed.status, packed.stderr).toBe(0)
    const zipTarget = join(root, 'zip-target')
    lib.materializeSource({ kind: 'zip', path: zip }, zipTarget, 'app/', join(repoRoot, 'scripts'))
    expect(lib.hashTree(join(zipTarget, 'app')).files.get('DeepSeek Harness.exe')).toBe(lib.sha256File(join(source, 'app', 'DeepSeek Harness.exe')))
    expect(() => lib.hashTree(join(zipTarget, 'home'))).toThrow()
  })
})

describe('CLI 端到端（artifact → assemble → status，DSH_DESKTOP_BUILD_ROOT 指到临时目录）', () => {
  function runCli(buildRootDir: string, cliArgs: string[]) {
    return spawnSync(process.execPath, [cliScript, ...cliArgs], {
      encoding: 'utf8',
      env: { ...process.env, DSH_DESKTOP_BUILD_ROOT: buildRootDir },
    })
  }

  /** 假来源：整包形状（app/ + home/ 含自带插件）+ 假构建目录（含应被剔除的 fake-llm）。 */
  function makeSourceAndLib(root: string) {
    const source = join(root, 'source')
    mkdirSync(join(source, 'app', 'resources'), { recursive: true })
    writeFileSync(join(source, 'app', 'DeepSeek Harness.exe'), 'exe-bytes')
    writeFileSync(join(source, 'app', 'resources', 'app.asar'), 'asar')
    mkdirSync(join(source, 'home', 'profiles', 'desktop', 'node_modules', 'dsh-webops-plugin', 'lib'), { recursive: true })
    writeFileSync(join(source, 'home', 'profiles', 'desktop', 'package.json'), '{"dependencies":{"dsh-webops-plugin":"9.9.9"}}')
    writeFileSync(join(source, 'home', 'profiles', 'desktop', 'node_modules', 'dsh-webops-plugin', 'package.json'), '{"version":"9.9.9"}')
    writeFileSync(join(source, 'home', 'profiles', 'desktop', 'node_modules', 'dsh-webops-plugin', 'lib', 'index.js'), 'zip-baked-plugin')
    const libDir = join(root, 'lib-build')
    mkdirSync(join(libDir, 'browser-electron'), { recursive: true })
    mkdirSync(join(libDir, 'fake-llm'), { recursive: true })
    writeFileSync(join(libDir, 'index.js'), 'built-index')
    writeFileSync(join(libDir, 'client.js'), 'built-client')
    writeFileSync(join(libDir, 'browser-electron', 'host.cjs'), 'built-host')
    writeFileSync(join(libDir, 'fake-llm', 'index.js'), '不应出货')
    return { source, libDir }
  }

  it('env/list/未知命令的行为', () => {
    const root = fixtureRoot()
    const env = runCli(root, ['env'])
    expect(env.status, env.stderr).toBe(0)
    expect(env.stdout).toContain('多实例布局')
    const list = runCli(root, ['list'])
    expect(list.status, list.stderr).toBe(0)
    const bad = runCli(root, ['nope'])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('用法')
  })

  it('artifact 复用已构建目录：剥掉模板自带插件、剔除 fake-llm、写 manifest 与完成标记', () => {    const root = fixtureRoot()
    const { source, libDir } = makeSourceAndLib(root)
    const result = runCli(root, ['artifact', '--id', 't1', '--source', source, '--lib-dir', libDir, '--note', '回归 fixture'])
    expect(result.status, result.stderr).toBe(0)
    const dir = join(root, 'local-tests', 'artifacts', 't1')
    expect(lib.readCompletion(dir)?.kind).toBe('artifact')
    expect(lib.verifyArtifact(dir).problems).toEqual([])
    // 出厂模板里不自带插件（装配时统一安装本产物构建）。
    expect(() => lib.hashTree(join(dir, 'home', 'profiles', 'desktop', 'node_modules', 'dsh-webops-plugin'))).toThrow()
    // 生产载荷不含 fake-llm，且是本轮构建的内容。
    const plugin = lib.hashTree(join(dir, 'plugin'))
    expect(plugin.files.has('lib/index.js')).toBe(true)
    expect([...plugin.files.keys()].some((rel) => rel.startsWith('lib/fake-llm/'))).toBe(false)
    const pkg = JSON.parse(readFileSync(join(dir, 'plugin', 'package.json'), 'utf8'))
    expect(readFileSync(join(dir, 'plugin', pkg.main), 'utf8')).toBe('built-index')
    expect(readFileSync(join(dir, 'plugin', pkg.exports['./client'].default), 'utf8')).toBe('built-client')
    expect(readFileSync(join(dir, 'plugin', 'lib', 'browser-electron', 'host.cjs'), 'utf8')).toBe('built-host')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.inputs.repo.pluginVersion).toBe(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version)
    expect(manifest.build.reused).toBe(true)
    expect(manifest.inputs.source.note).toBe('回归 fixture')
    // 同名产物已存在 → 拒绝重建。
    const again = runCli(root, ['artifact', '--id', 't1', '--source', source, '--lib-dir', libDir])
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('已存在')
  }, 30_000)

  it('assemble A/B 安装哈希一致；重复装配拒绝；status 可见', () => {
    const root = fixtureRoot()
    const { source, libDir } = makeSourceAndLib(root)
    expect(runCli(root, ['artifact', '--id', 't1', '--source', source, '--lib-dir', libDir]).status).toBe(0)
    const a = runCli(root, ['assemble', '--artifact', 't1', '--instance', 'A'])
    expect(a.status, a.stderr).toBe(0)
    expect(a.stdout).toContain('实例完成')
    const b = runCli(root, ['assemble', '--artifact', 't1', '--instance', 'B'])
    expect(b.status, b.stderr).toBe(0)
    const digestA = lib.treeDigest(lib.hashTree(lib.instancePluginDir(lib.instanceDir(root, 'A'))).files)
    const digestB = lib.treeDigest(lib.hashTree(lib.instancePluginDir(lib.instanceDir(root, 'B'))).files)
    expect(digestA).toBe(digestB)
    expect(readFileSync(join(lib.instancePluginDir(lib.instanceDir(root, 'A')), 'lib', 'index.js'), 'utf8')).toBe('built-index')

    const again = runCli(root, ['assemble', '--artifact', 't1', '--instance', 'A'])
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('已存在')

    const status = runCli(root, ['status'])
    expect(status.status, status.stderr).toBe(0)
    expect(status.stdout).toContain('A')
    expect(status.stdout).toContain('B')
  }, 30_000)

  it('launch 对未装配实例与 CDP 占用分别明确拒绝', async () => {
    const root = fixtureRoot()
    const missing = runCli(root, ['launch', '--instance', 'NOPE'])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('不存在')

    // 已装配但占用一个真实在听的端口 → CDP 预检失败（用本测试进程临时监听占用）。
    const { source, libDir } = makeSourceAndLib(root)
    expect(runCli(root, ['artifact', '--id', 't1', '--source', source, '--lib-dir', libDir]).status).toBe(0)
    expect(runCli(root, ['assemble', '--artifact', 't1', '--instance', 'A']).status).toBe(0)
    const server = createServer()
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const port = (server.address() as { port: number }).port
    try {
      const blocked = runCli(root, ['launch', '--instance', 'A', '--cdp', String(port)])
      expect(blocked.status).toBe(1)
      expect(blocked.stderr).toContain('已被占用')
      // 被拒后没有起任何进程：实例目录里没有 runs.jsonl。
      expect(() => readFileSync(join(lib.instanceDir(root, 'A'), 'runs.jsonl'), 'utf8')).toThrow()
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  }, 30_000)
})
