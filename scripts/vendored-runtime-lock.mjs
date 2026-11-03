/** 读取 npm v3 锁中的完整依赖树；只消费已校验的本地 tarball，不安装或执行生命周期脚本。 */
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

function inside(root, relative) {
  const target = resolve(root, relative)
  if (!target.startsWith(resolve(root) + sep)) throw Error(`运行时依赖路径越界：${relative}`)
  return target
}

export function readVendoredRuntimeLock(vendorDir, lockFile, verifyTarball) {
  const lock = JSON.parse(readFileSync(inside(vendorDir, lockFile), 'utf8'))
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw Error(`不支持的运行时锁：${lockFile}`)
  const result = []
  // 限定 npm 的嵌套目录形状，保留同名依赖多版本，禁止任意路径和符号链接。
  const packagePath = /^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/u
  for (const [path, item] of Object.entries(lock.packages)) {
    if (path === '') continue
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    if (!packagePath.test(path) || item.link || item.name !== name || !item.version || !item.tarball
      || !item.integrity?.startsWith('sha512-')) throw Error(`运行时锁条目无效：${path}`)
    const body = verifyTarball(inside(vendorDir, item.tarball), item.integrity)
    result.push({ path, name, version: item.version, body })
  }
  for (const [name, version] of Object.entries(lock.packages[''].dependencies ?? {})) {
    if (!result.some(item => item.path === `node_modules/${name}` && item.version === version)) {
      throw Error(`运行时锁缺少固定的入口依赖：${name}@${version}`)
    }
  }
  if (result.length === 0) throw Error(`运行时锁为空：${lockFile}`)
  return result
}

export function materializeVendoredRuntime(pluginDir, entries, extractTarball) {
  for (const item of entries) {
    const meta = extractTarball(item.body, join(pluginDir, item.path))
    if (meta?.name !== item.name || meta?.version !== item.version) {
      throw Error(`运行时 tarball 身份对不上：期望 ${item.name}@${item.version}，实际 ${meta?.name}@${meta?.version}`)
    }
  }
}

/** 检查成品的依赖目录和版本；缺少间接依赖同样阻止验包。 */
export function verifyMaterializedRuntime(pluginDir, vendorDir, lockFile) {
  const entries = readVendoredRuntimeLock(vendorDir, lockFile, () => undefined)
  for (const item of entries) {
    const target = join(pluginDir, item.path)
    const info = lstatSync(target)
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error(`运行时依赖不是实际目录：${target}`)
    const meta = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    if (meta.name !== item.name || meta.version !== item.version) throw Error(`运行时依赖版本不符：${target}`)
  }
  return entries.length
}
