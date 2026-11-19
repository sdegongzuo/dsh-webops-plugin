/**
 * 出厂默认模型注入：`DSH_FACTORY_DEFAULT_MODEL` 的解析必须当场拦住写错的写法。
 *
 * 关键回归点：只写 `xai`（缺 model 段）原本能通过校验，`JSON.stringify(undefined)`
 * 会得到 JS 值 undefined，模板串把它变成字面量 `undefined` 写进 YAML —— 宿主的模型名
 * 就成了 "undefined"，要到运行时请求失败才暴露。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const factoryDefault = await import(new URL('../scripts/factory-default-model.mjs', import.meta.url).href) as {
  appendFactoryDefaultModel(
    patchPath: string,
    raw?: string,
  ): { provider: string, model: string, reasoningEffort: string } | undefined
  formatFactoryDefaultModel(config: { provider: string, model: string, reasoningEffort: string }): string
}

/** 造一个只有表头的 patch 文件，避免依赖真实产物。 */
function makePatch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-default-model-test-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, '# head\n', 'utf8')
  return file
}

describe('出厂默认模型注入', () => {
  it('未设置变量时不写任何内容', () => {
    const file = makePatch()
    expect(factoryDefault.appendFactoryDefaultModel(file, undefined)).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('# head\n')
  })

  it('空字符串视同未设置', () => {
    const file = makePatch()
    expect(factoryDefault.appendFactoryDefaultModel(file, '')).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('# head\n')
  })

  it('缺 model 段（只有 provider）必须报错，不得写入字面量 undefined', () => {
    const file = makePatch()
    expect(() => factoryDefault.appendFactoryDefaultModel(file, 'xai')).toThrowError(/provider\/model/)
    expect(readFileSync(file, 'utf8')).toBe('# head\n')
  })

  it('provider 为空（`/model`）必须报错', () => {
    const file = makePatch()
    expect(() => factoryDefault.appendFactoryDefaultModel(file, '/grok-4.7')).toThrowError(/provider\/model/)
  })

  it('尾随斜杠导致 effort 为空串必须报错', () => {
    const file = makePatch()
    expect(() => factoryDefault.appendFactoryDefaultModel(file, 'xai/grok-4.7/')).toThrowError(/effort/)
  })

  it('超过三段必须报错', () => {
    const file = makePatch()
    expect(() => factoryDefault.appendFactoryDefaultModel(file, 'xai/grok-4.7/high/extra')).toThrowError(/provider\/model/)
  })

  it('完整写法写入一条格式正确的 agent-default-model', () => {
    const file = makePatch()
    const result = factoryDefault.appendFactoryDefaultModel(file, 'xai/grok-4.7/high')
    expect(result).toEqual({ provider: 'xai', model: 'grok-4.7', reasoningEffort: 'high' })
    const text = readFileSync(file, 'utf8')
    expect(text.match(/id: agent-default-model/g)).toHaveLength(1)
    expect(text).toContain('provider: "xai"')
    expect(text).toContain('model: "grok-4.7"')
    expect(text).toContain('reasoningEffort: "high"')
    // 任何情况下都不该出现 JS 的 undefined 字面量
    expect(text).not.toMatch(/\bundefined\b/)
  })

  it('省略 effort 默认 high', () => {
    const file = makePatch()
    expect(factoryDefault.appendFactoryDefaultModel(file, 'xai/grok-4.7')).toEqual({
      provider: 'xai',
      model: 'grok-4.7',
      reasoningEffort: 'high',
    })
    expect(readFileSync(file, 'utf8')).toContain('reasoningEffort: "high"')
  })

  it('界面文案：Grok 4.7 走专用写法，其余走通用写法', () => {
    expect(factoryDefault.formatFactoryDefaultModel({ provider: 'xai', model: 'grok-4.7', reasoningEffort: 'high' }))
      .toBe('Grok 4.7 / High')
    expect(factoryDefault.formatFactoryDefaultModel({ provider: 'unisound', model: 'x', reasoningEffort: 'low' }))
      .toBe('unisound / x / Low')
  })
})
