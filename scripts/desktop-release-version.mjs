/** 桌面发布身份取自实际本体，插件版本由插件清单单独提供。 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeDescriptor } from './desktop-runtime.mjs'

export function desktopReleaseVersion(appDir, expected) {
  const version = readRuntimeDescriptor(appDir).descriptor.release?.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    throw new Error('DSH 运行时清单缺少合法 release.version，拒绝回退到插件版本')
  }
  if (expected !== undefined && expected !== version) {
    throw new Error(`桌面版本不一致：期望 ${expected}，实际 DSH ${version}`)
  }
  return version
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const arg = name => args[args.indexOf(name) + 1]
  try {
    if (!args.includes('--app') || !arg('--app') || arg('--app').startsWith('--')) {
      throw new Error('用法：node scripts/desktop-release-version.mjs --app <本体目录> [--expected <DSH版本>]')
    }
    const expected = args.includes('--expected') ? arg('--expected') : undefined
    if (args.includes('--expected') && (!expected || expected.startsWith('--'))) throw new Error('--expected 缺少版本值')
    console.log(desktopReleaseVersion(resolve(arg('--app')), expected))
  } catch (error) {
    console.error(`desktop-release-version: ${error.message}`)
    process.exitCode = 1
  }
}
