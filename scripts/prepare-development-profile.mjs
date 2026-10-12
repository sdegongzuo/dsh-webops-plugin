/** 在全新目录装配开发 profile；预先合并链接优先级，不删除或替换任何路径。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function prepareDevelopmentProfile(options) {
  const { projectDir, dependencyDir, cliDir, hostDir, release, platform, metadata, excluded = [] } = options
  const links = new Map()
  const skipped = []
  const manifest = directory => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const remember = (name, path) => {
    if (excluded.includes(name)) return
    try { links.set(name, realpathSync(path)) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      skipped.push({ name, path })
    }
  }
  for (const entry of readdirSync(dependencyDir, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const path = join(dependencyDir, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isDirectory() || scoped.isSymbolicLink()) remember(`${entry.name}/${scoped.name}`, join(path, scoped.name))
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) remember(entry.name, path)
  }
  const visited = new Set()
  const visit = directory => {
    const path = realpathSync(directory)
    if (visited.has(path)) return
    visited.add(path)
    for (const [name, specifier] of Object.entries(manifest(path).dependencies ?? {})) {
      if (!specifier.startsWith('workspace:') || excluded.includes(name)) continue
      const dependency = realpathSync(join(path, 'node_modules', ...name.split('/')))
      links.set(name, dependency)
      visit(dependency)
    }
  }
  for (const [name, path] of [['@deepseek-ai/dsh', cliDir], ['@deepseek-ai/dsh-desktop-host', hostDir]]) {
    const value = manifest(path)
    if (value.name !== name || value.version !== release.version) throw Error(`开发装配：${name} 版本或身份不符`)
    visit(path)
    links.set(name, realpathSync(path))
  }
  // exclusive mkdir：拒绝现有目标，保证 metadata 与所有链接都只写新目录。
  mkdirSync(projectDir)
  metadata(projectDir, release)
  const sharedPackages = []
  for (const [name, source] of links) {
    const destination = join(projectDir, 'node_modules', ...name.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
    const value = manifest(source)
    if (typeof value.version === 'string') sharedPackages.push({ name, version: value.version, path: `node_modules/${name}` })
  }
  writeFileSync(join(projectDir, 'desktop-runtime.json'), JSON.stringify({ schemaVersion: 1, release, ...platform, sharedPackages, files: [] }, null, 2), { flag: 'wx' })
  return { projectDir, linked: links.size, skipped }
}

/** 注册实际 home profile；runtime project 不是用户插件配置的消费点。 */
export function registerDevelopmentPlugin(profileDir, plugin, baseBundles, fakeOverlay = '') {
  mkdirSync(profileDir, { recursive: true })
  const packagePath = join(profileDir, 'package.json')
  const manifest = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')) : { name: 'dsh-profile-desktop', private: true }
  const profile = manifest.dsh?.profile ?? {}
  const next = { ...manifest, dependencies: { ...manifest.dependencies, [plugin.name]: plugin.version },
    dsh: { ...manifest.dsh, profile: { ...profile, bundles: [...new Set([...baseBundles, ...(profile.bundles ?? []), plugin.name])] } } }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const begin = '# dsh-webops 开发配置开始', end = '# dsh-webops 开发配置结束'
  const start = patch.indexOf(begin)
  if (start >= 0) {
    const finish = patch.indexOf(end, start)
    if (finish < 0 || patch.indexOf(begin, start + begin.length) >= 0) throw Error('开发配置标记不完整或重复，未修改 profile')
    patch = patch.slice(0, start) + patch.slice(finish + end.length)
  }
  const content = patch.split(/\r?\n/u).filter(line => line.trim() && !line.trim().startsWith('#')).join('\n').trim()
  if (content === '[]') patch = patch.replace(/^\s*\[\]\s*$/mu, '')
  const overlay = `${begin}\n- id: browser-electron\n  config:\n    enabled: true\n    appMode: false\n${fakeOverlay}\n${end}\n`
  writeFileSync(packagePath, JSON.stringify(next, null, 2) + '\n')
  writeFileSync(patchPath, `${patch.trimEnd()}\n\n${overlay}`)
}
