/**
 * coding-oauth-patch-compat 的单测：正向剥除 + 三个必须拒绝/放过的反向场景。
 *
 * 反向验证是这里的重点 —— 该补丁直接改写第三方包的 bundle patch，判据写松了会
 * 在插件升级后悄悄改坏别的 YAML；写紧了又会让正常升级整包打包失败。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 与其他独立脚本单测一致：用 URL 动态导入，免掉 `.mjs` 的类型声明需求。
const { applyCodingOAuthPatchCompatibility, CODING_OAUTH_PATCH_COMPAT, stripPresetDefaultModel } = await import(
  new URL('../scripts/coding-oauth-patch-compat.mjs', import.meta.url).href
)

const HEADER = `# Optional coding-subscription routes over the base composition.
- id: agent-default-model
  config:
    provider: grok-build
    model: grok-4.6

- insert:
    - id: llm-grok-build-oauth
      name: dsh-coding-subscription-oauth
`

const WITHOUT_PRESET = `# Optional coding-subscription routes over the base composition.
- insert:
    - id: llm-grok-build-oauth
      name: dsh-coding-subscription-oauth
`

describe('stripPresetDefaultModel', () => {
  it('剥掉预设默认模型段并保留挂载行', () => {
    const { text, stripped } = stripPresetDefaultModel(HEADER)
    expect(stripped).toBe(true)
    expect(text).not.toContain('provider: grok-build')
    expect(text).not.toContain('model: grok-4.6')
    expect(text).toContain('llm-grok-build-oauth')
    expect(text).toContain('- insert:')
  })

  it('上游已不写默认模型时原样返回、不报错', () => {
    const { text, stripped } = stripPresetDefaultModel(WITHOUT_PRESET)
    expect(stripped).toBe(false)
    expect(text).toBe(WITHOUT_PRESET)
  })

  it('同一段出现两次时拒绝（形状变了不猜）', () => {
    const doubled = HEADER + HEADER.split('\n').slice(1, 5).join('\n') + '\n'
    expect(() => stripPresetDefaultModel(doubled)).toThrowError(/出现 2 次/)
  })

  it('剥离后挂载行消失时拒绝（改坏了不写盘）', () => {
    const noInsert = `- id: agent-default-model
  config:
    provider: grok-build
    model: grok-4.6
`
    expect(() => stripPresetDefaultModel(noInsert)).toThrowError(/挂载行消失/)
  })

  // 2026-11-19 审查发现的 fail-open：精确块失配时原实现直接放行，预设默认模型
  // 会悄悄回到出厂组合，且回执显示「无需改动」。这两条把这个口子焊死。
  it('上游把 model 版本号抬上去（精确块失配）时拒绝，不静默放行', () => {
    const bumped = `- id: agent-default-model
  config:
    provider: grok-build
    model: grok-4.7

- insert:
    - id: llm-grok-build-oauth
      name: dsh-coding-subscription-oauth
`
    expect(() => stripPresetDefaultModel(bumped)).toThrowError(/形状已变化/)
  })

  it('上游只改 provider 名（仍写默认模型条目）时同样拒绝', () => {
    const renamed = `- id: agent-default-model
  config:
    provider: another-route
    model: whatever

- insert:
    - id: llm-grok-build-oauth
      name: dsh-coding-subscription-oauth
`
    expect(() => stripPresetDefaultModel(renamed)).toThrowError(/形状已变化/)
  })
})

describe('applyCodingOAuthPatchCompatibility', () => {
  const makePlugin = (name: string, patch: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-oauth-compat-'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.8.8' }))
    writeFileSync(join(dir, 'cordis.patch.yml'), patch)
    return dir
  }

  it('就地改写并留下原文件备份与回执', () => {
    const dir = makePlugin('dsh-coding-subscription-oauth', HEADER)
    const receipt = applyCodingOAuthPatchCompatibility(dir)
    expect(receipt.changed).toBe(true)
    expect(receipt.patch).toBe(CODING_OAUTH_PATCH_COMPAT)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).not.toContain('provider: grok-build')
    // 官方原文必须留档，便于核对与回滚
    expect(readFileSync(join(dir, 'cordis.preset-default-model.yml'), 'utf8')).toBe(HEADER)
    const onDisk = JSON.parse(readFileSync(join(dir, 'dsh-host-compatibility.json'), 'utf8'))
    expect(onDisk.originalSha256).not.toBe(onDisk.adaptedSha256)
  })

  it('上游已去掉默认模型时返回 unchanged 且不写回执', () => {
    const dir = makePlugin('dsh-coding-subscription-oauth', WITHOUT_PRESET)
    const receipt = applyCodingOAuthPatchCompatibility(dir)
    expect(receipt.unchanged).toBe(true)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(WITHOUT_PRESET)
  })

  it('包名不符时拒绝（防止误用到其他插件）', () => {
    const dir = makePlugin('dsh-context', HEADER)
    expect(() => applyCodingOAuthPatchCompatibility(dir)).toThrowError(/仅适用于 dsh-coding-subscription-oauth/)
  })
})
