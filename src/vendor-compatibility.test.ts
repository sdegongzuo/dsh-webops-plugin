/**
 * 出厂 profile 的精确版本豁免（胶水层）。
 *
 * 边界：判定语义在**宿主**里（`evaluatePluginCompatibility` 的 includePrerelease、
 * engines 优先于 peers 等细节），单测不该复刻。这里用一份桩 app-boot 替掉那一跳，
 * 只守我们新增的胶水：谁被豁免、键怎么拼、文件写不写、格式与宿主读入端一致、
 * 缺包时说不说得清。语义层由 `verify-release-portable` 用**真** app-boot 验
 * （2026-11-04 就是它替我们抓到「不兼容的 bundle 被静默跳过」）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const { buildRoot } = await import(new URL('../scripts/local-env.mjs', import.meta.url).href)
const { COMPATIBILITY_FILE, loadHostCompatibility, planVersionExemptions, writeProfileExemptions } =
  await import(new URL('../scripts/vendor-compatibility.mjs', import.meta.url).href)

/** 桩 app-boot：`fixtureUnmet` 决定「不满足」，键格式按宿主的精确版规则校验。 */
const STUB = `
export function validatePluginVersionExemption(packageVersion, runtimeVersion) {
  const separator = packageVersion.lastIndexOf('@')
  const exact = /^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/
  if (separator <= 0 || !exact.test(packageVersion.slice(separator + 1)) || !exact.test(runtimeVersion)) {
    throw new Error('Version exemptions require an exact npm package-name@version and an exact DSH runtime version')
  }
}
export function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion) {
  const unmet = manifest.fixtureUnmet
  if (unmet === undefined) return undefined
  const key = manifest.name + '@' + manifest.version
  const exempted = (exemptions[key] ?? []).includes(runtimeVersion)
  return { name: manifest.name, version: manifest.version, runtimeVersion, requirements: unmet, exempted }
}
`

function fixture(plugins: Record<string, { version: string; unmet?: Record<string, string> }>) {
  const root = mkdtempSync(join(buildRoot(), 'vendor-compat-test-'))
  const appDir = join(root, 'app')
  const appBoot = join(appDir, 'resources', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib')
  mkdirSync(appBoot, { recursive: true })
  writeFileSync(join(appBoot, 'index.js'), STUB)
  const profileDir = join(root, 'home', 'profiles', 'desktop')
  for (const [name, spec] of Object.entries(plugins)) {
    const dir = join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: spec.version,
      ...spec.unmet === undefined ? {} : { fixtureUnmet: spec.unmet },
    }))
  }
  return { root, appDir, profileDir, names: Object.keys(plugins) }
}

describe('出厂 profile 的精确版本豁免', () => {
  it('只豁免判不满足的插件，键是 包名@精确版本 → 精确 DSH 版本', async () => {
    const { appDir, profileDir, names } = fixture({
      'dsh-workbuddy-connect': { version: '0.7.9', unmet: { '@deepseek-ai/dsh-llm': '0.2.1-rc.2' } },
      'dsh-context': { version: '0.73.0' },
    })
    const planned = await planVersionExemptions({ appDir, profileDir, runtimeVersion: '0.2.2-alpha.3', names })
    expect(planned.exemptions).toEqual({ 'dsh-workbuddy-connect@0.7.9': ['0.2.2-alpha.3'] })
    expect(planned.issues.map((issue: { name: string }) => issue.name)).toEqual(['dsh-workbuddy-connect'])
  })

  it('写出的文件与宿主读入端同形：JSON、2 空格缩进、结尾换行，且不碰满足的插件', async () => {
    const { appDir, profileDir, names } = fixture({
      'dsh-workbuddy-connect': { version: '0.7.9', unmet: { '@deepseek-ai/dsh-llm': '0.2.1-rc.2' } },
      'dsh-context': { version: '0.73.0' },
    })
    await writeProfileExemptions({ appDir, profileDir, runtimeVersion: '0.2.2-alpha.3', names })
    const text = readFileSync(join(profileDir, COMPATIBILITY_FILE), 'utf8')
    expect(text).toBe('{\n  "dsh-workbuddy-connect@0.7.9": [\n    "0.2.2-alpha.3"\n  ]\n}\n')
    expect(JSON.parse(text)).toEqual({ 'dsh-workbuddy-connect@0.7.9': ['0.2.2-alpha.3'] })
  })

  it('全都满足时不创建文件 —— 别让「有豁免文件」变成默认状态', async () => {
    const { appDir, profileDir, names } = fixture({ 'dsh-context': { version: '0.73.0' } })
    expect(await writeProfileExemptions({ appDir, profileDir, runtimeVersion: '0.2.2-alpha.3', names })).toEqual({})
    expect(existsSync(join(profileDir, COMPATIBILITY_FILE))).toBe(false)
  })

  it('bundles 登记了却没物化：当场说清楚，别拖到宿主静默跳过', async () => {
    const { appDir, profileDir } = fixture({ 'dsh-context': { version: '0.73.0' } })
    await expect(writeProfileExemptions({
      appDir, profileDir, runtimeVersion: '0.2.2-alpha.3', names: ['dsh-workbuddy-connect'],
    })).rejects.toThrow(/没有它的 package\.json/u)
  })

  it('app 目录里没有随包运行时：明确报缺，不回退到「当成全都满足」', async () => {
    // fixture() 总会造桩，这里单独造一个只有 app 壳、没有 resources/dsh 的目录。
    const root = mkdtempSync(join(buildRoot(), 'vendor-compat-test-'))
    await expect(loadHostCompatibility(join(root, 'app'))).rejects.toThrow(/缺少 app-boot/u)
  })
})
