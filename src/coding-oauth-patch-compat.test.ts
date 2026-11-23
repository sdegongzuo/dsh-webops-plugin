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
const {
  applyCodingOAuthLibraryCompatibility,
  applyCodingOAuthPatchCompatibility,
  CODING_OAUTH_LIBRARY_COMPAT,
  CODING_OAUTH_PATCH_COMPAT,
  inlineRemovedLlmExports,
  routeRootAccessThroughSymbol,
  stripPresetDefaultModel,
} = await import(
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

/**
 * DSH 0.2.3-alpha.2 删了 dsh-llm 的 `assertUsableApiKey` / `normalizeApiKey` 导出，
 * 插件 0.8.8 的静态 import 因此整层导入失败（宿主照常 ready，只是设置页少一张卡片）。
 * 下面这组用例守两件事：正向能补上、形状变了必须拒绝。
 */
const LIB_IMPORT = 'import { assertUsableApiKey, RetryPolicySchema } from "@deepseek-ai/dsh-llm";'
const LIB_CALL = '  return assertUsableApiKey(resolved.value, "dsh-coding-subscription-oauth", XAI_API_KEY_CREDENTIAL);'
const LIB_ROOT = [
  'function resolveCodingOAuthScope(context) {',
  '  const root = context.root;',
  '  return root;',
  '}',
].join('\n')
const libSource = (...lines: string[]): string => lines.join('\n')
/** 两处都命中的完整夹具：apply 需要 import 行与取 root 行同时在场。 */
const LIB_FULL = libSource(LIB_IMPORT, '', LIB_ROOT, '', 'function f() {', LIB_CALL, '}')

describe('inlineRemovedLlmExports', () => {
  it('改写 import 并内联实现，调用点原样保留', () => {
    const { text, patched } = inlineRemovedLlmExports(libSource(LIB_IMPORT, '', 'function f() {', LIB_CALL, '}'))
    expect(patched).toBe(true)
    expect(text).not.toContain('import { assertUsableApiKey')
    expect(text).toContain('LlmError as __dshLlmError')
    expect(text).toContain('INVALID_CREDENTIAL_CODE as __dshInvalidCredentialCode')
    expect(text).toContain('function assertUsableApiKey(raw, pkg, ref)')
    // 调用点必须还在，否则就变成运行时 ReferenceError
    expect(text).toContain(LIB_CALL)
    expect(text).toContain('/^[\\x21-\\x7E]+$/')
  })

  it('已打过补丁（哨兵在场）时幂等返回，不重复插入', () => {
    const once = inlineRemovedLlmExports(libSource(LIB_IMPORT, '', 'function f() {', LIB_CALL, '}')).text
    const twice = inlineRemovedLlmExports(once)
    expect(twice.patched).toBe(false)
    expect(twice.text).toBe(once)
  })

  it('import 行出现两次时拒绝（形状变了不猜）', () => {
    const source = libSource(LIB_IMPORT, LIB_IMPORT, 'function f() {', LIB_CALL, '}')
    expect(() => inlineRemovedLlmExports(source)).toThrowError(/出现 2 次/)
  })

  it('import 行消失（上游改了写法）时拒绝，而不是静默放行', () => {
    const source = libSource('import { RetryPolicySchema } from "@deepseek-ai/dsh-llm";', 'function f() {', LIB_CALL, '}')
    expect(() => inlineRemovedLlmExports(source)).toThrowError(/出现 0 次/)
  })

  it('调用点消失时拒绝（只删 import 不补实现会更难查）', () => {
    const source = libSource(LIB_IMPORT, 'function f() {', '  return resolved.value;', '}')
    expect(() => inlineRemovedLlmExports(source)).toThrowError(/找不到原调用点/)
  })
})

describe('routeRootAccessThroughSymbol', () => {
  it('把 ctx.root 改成带兜底的符号读取', () => {
    const { text, patched } = routeRootAccessThroughSymbol(libSource(LIB_ROOT, '', 'function f() {', LIB_CALL, '}'))
    expect(patched).toBe(true)
    expect(text).toContain('try {')
    expect(text).toContain('root = context[Symbol.for("cordis.root")];')
    // 首选路径保留：老 cordis 仍走 context.root
    expect(text).toContain('root = context.root;')
  })

  it('已改过时幂等返回', () => {
    const once = routeRootAccessThroughSymbol(libSource(LIB_ROOT, 'function f() {}')).text
    const twice = routeRootAccessThroughSymbol(once)
    expect(twice.patched).toBe(false)
    expect(twice.text).toBe(once)
  })

  it('取 root 处消失或出现多次时拒绝', () => {
    expect(() => routeRootAccessThroughSymbol('function other() {}')).toThrowError(/出现 0 次/)
    const doubled = libSource(LIB_ROOT, LIB_ROOT)
    expect(() => routeRootAccessThroughSymbol(doubled)).toThrowError(/出现 2 次/)
  })
})

describe('applyCodingOAuthLibraryCompatibility', () => {
  const makeLibPlugin = (name: string, source: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-oauth-lib-'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.8.8' }))
    writeFileSync(join(dir, 'lib', 'index.js'), source)
    return dir
  }

  it('两处都改、留原文备份，回执与 strip 补丁合并共存', () => {
    const dir = makeLibPlugin('dsh-coding-subscription-oauth', LIB_FULL)
    // 先跑 strip 补丁，制造已有回执，验证合并而不是覆盖
    writeFileSync(join(dir, 'cordis.patch.yml'), HEADER)
    applyCodingOAuthPatchCompatibility(dir)
    const receipt = applyCodingOAuthLibraryCompatibility(dir)
    expect(receipt.changed).toBe(true)
    expect(receipt.libraryPatch).toBe(CODING_OAUTH_LIBRARY_COMPAT)
    expect(receipt.libraryPatches).toEqual(['inline-assert-usable-api-key', 'root-via-symbol'])
    expect(readFileSync(join(dir, 'lib', 'index.pre-inline-assert.js'), 'utf8')).toContain('import { assertUsableApiKey')
    const onDisk = JSON.parse(readFileSync(join(dir, 'dsh-host-compatibility.json'), 'utf8'))
    // strip 的字段不能被吃掉
    expect(onDisk.patch).toBe(CODING_OAUTH_PATCH_COMPAT)
    expect(onDisk.libraryPatch).toBe(CODING_OAUTH_LIBRARY_COMPAT)
    expect(onDisk.libraryOriginalSha256).not.toBe(onDisk.libraryAdaptedSha256)
  })

  it('已打过补丁时返回 unchanged 且不动文件', () => {
    const dir = makeLibPlugin('dsh-coding-subscription-oauth', LIB_FULL)
    applyCodingOAuthLibraryCompatibility(dir)
    const afterFirst = readFileSync(join(dir, 'lib', 'index.js'), 'utf8')
    const second = applyCodingOAuthLibraryCompatibility(dir)
    expect(second.unchanged).toBe(true)
    expect(readFileSync(join(dir, 'lib', 'index.js'), 'utf8')).toBe(afterFirst)
  })

  it('包名不符时拒绝', () => {
    const dir = makeLibPlugin('dsh-better-sidebar', LIB_FULL)
    expect(() => applyCodingOAuthLibraryCompatibility(dir)).toThrowError(/仅适用于 dsh-coding-subscription-oauth/)
  })
})
