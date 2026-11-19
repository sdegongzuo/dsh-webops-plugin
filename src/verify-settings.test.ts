/**
 * verify-settings 的 agent-default-model 条件化断言（评审 P1-3）。
 *
 * 背景：scripts/verify-settings.mjs 原来只有一条**无条件**反向断言「出厂 patch 不预置
 * 默认模型」，但仓库支持 DSH_FACTORY_DEFAULT_MODEL —— 设置它时打包脚本会向
 * cordis.patch.yml 追加一段 agent-default-model（scripts/factory-default-model.mjs）。
 * 于是「预置了默认模型的包」跑 verify:settings 必红，且注入格式没有任何正向断言兜底：
 * patch 字段名写错不会报错、整段会被宿主静默丢掉（scripts/portable-profile-patch.yaml
 * 顶注说明的就是这一族风险）。
 *
 * 这里对导出的 checkAgentDefaultModelPatch 直接断言，覆盖注入态与不注入态；假 patch
 * 落进临时目录再读回（与被测脚本同一读取方式，顺带兜住换行/编码差异）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 与 src/factory-proxy.test.ts / src/desktop-build-identity.test.ts 同一做法：动态 import；
// verify-settings.mjs 只在被直接执行时才跑主流程（文件尾 isMain 判定），import 无副作用。
const { checkAgentDefaultModelPatch } = await import(new URL('../scripts/verify-settings.mjs', import.meta.url).href) as {
  checkAgentDefaultModelPatch(patchText: string, raw?: string): { ok: boolean, message: string }[]
}

/** 假的出厂 patch 基底：只含与 agent-default-model 断言无关的最小内容。 */
const BASE_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '- id: permission',
  '  name: "@deepseek-ai/dsh-permission-presets"',
  '  config:',
  '    defaultPreset: auto',
  '',
].join('\n')

/** 照抄 scripts/factory-default-model.mjs 注入模板的追加段（字段名/引号形态逐字一致）。 */
const INJECTED = [
  '',
  '# 本次构建显式指定默认模型（DSH_FACTORY_DEFAULT_MODEL）。',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: "xai"',
  '    model: "grok-4.7"',
  '    reasoningEffort: "high"',
  '',
].join('\n')

/** 假 patch 落进临时目录再读回：与被测脚本同一读取路径（utf8 全文）。 */
function fixture(patchText: string): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-settings-test-'))
  const path = join(root, 'cordis.patch.yml')
  writeFileSync(path, patchText, 'utf8')
  return readFileSync(path, 'utf8')
}

/** 失败消息列表（空 = 全绿）。 */
const failuresOf = (patchText: string, raw: string | undefined) =>
  checkAgentDefaultModelPatch(patchText, raw).filter(result => !result.ok).map(result => result.message)

describe('verify-settings：agent-default-model 条件化断言', () => {
  it('不注入态不回归：无 agent-default-model 的 patch 通过原反向断言', () => {
    // 显式传 '' 而不是 undefined：undefined 会触发默认参数去读 process.env，
    // 测试进程万一带着 DSH_FACTORY_DEFAULT_MODEL 就不稳了。
    expect(checkAgentDefaultModelPatch(fixture(BASE_PATCH), ''))
      .toEqual([{ ok: true, message: '出厂 patch 不预置默认模型' }])
  })

  it('不注入态：patch 里出现 agent-default-model 仍要红', () => {
    expect(failuresOf(BASE_PATCH + INJECTED, '')).toEqual(['出厂 patch 不预置默认模型'])
  })

  it('不注入态：表头注释提到 agent-default-model 不误伤（P2-10 口径，剥注释判正文）', () => {
    // 另一评审项（P2-10）给模板表头加了「设置 DSH_FACTORY_DEFAULT_MODEL 时会追加一条
    // agent-default-model」的说明注释 —— 注释不是预置条目，不该让反向断言转红。
    const withDocComment = ['# 设置 DSH_FACTORY_DEFAULT_MODEL 时会追加一条 agent-default-model 默认模型（不含任何凭据）。', BASE_PATCH].join('\n')
    expect(failuresOf(fixture(withDocComment), '')).toEqual([])
  })

  it('注入态：注入模板原样落盘后全绿（计数恰一 + 四字段 + config 子树）', () => {
    const results = checkAgentDefaultModelPatch(fixture(BASE_PATCH + INJECTED), 'xai/grok-4.7/high')
    expect(results.filter(result => !result.ok)).toEqual([])
    expect(results).toHaveLength(6)
  })

  it('注入态：env 省略 effort 时与注入侧一样默认 high', () => {
    expect(failuresOf(BASE_PATCH + INJECTED, 'xai/grok-4.7')).toEqual([])
  })

  it('注入态：显式 effort 透传核对', () => {
    const swapped = (BASE_PATCH + INJECTED).replace('reasoningEffort: "high"', 'reasoningEffort: "medium"')
    expect(failuresOf(swapped, 'xai/grok-4.7/medium')).toEqual([])
    expect(failuresOf(BASE_PATCH + INJECTED, 'xai/grok-4.7/medium'))
      .toContain('agent-default-model 块缺 reasoningEffort: medium')
  })

  it('注入态：整段缺失 → 计数报 0 且逐字段报缺', () => {
    const failures = failuresOf(fixture(BASE_PATCH), 'xai/grok-4.7/high')
    expect(failures).toContain('注入态 patch 恰好一条 id: agent-default-model（实际 0 条）')
    for (const field of ['name', 'provider', 'model', 'reasoningEffort']) {
      expect(failures.some(message => message.includes(`块缺 ${field}`)), `没报缺 ${field}`).toBe(true)
    }
    expect(failures).toContain('agent-default-model 块缺 config: 子树')
  })

  it('注入态：字段名拼错（reasoning_effort）会被正向断言拦下（静默丢字段风险）', () => {
    const typo = (BASE_PATCH + INJECTED).replace('reasoningEffort:', 'reasoning_effort:')
    expect(failuresOf(fixture(typo), 'xai/grok-4.7/high'))
      .toEqual(['agent-default-model 块缺 reasoningEffort: high'])
  })

  it('注入态：name 字段丢了会被拦下（config-editor 按 id+name 认行）', () => {
    const noName = (BASE_PATCH + INJECTED).replace('  name: "@deepseek-ai/dsh-agent-default-model"\n', '')
    expect(failuresOf(noName, 'xai/grok-4.7/high'))
      .toContain('agent-default-model 块缺 name: @deepseek-ai/dsh-agent-default-model')
  })

  it('注入态：provider / model 与 env 不一致时分别报缺', () => {
    const failures = failuresOf(BASE_PATCH + INJECTED, 'deepseek/deepseek-chat')
    expect(failures).toContain('agent-default-model 块缺 provider: deepseek')
    expect(failures).toContain('agent-default-model 块缺 model: deepseek-chat')
  })

  it('注入态：注入段被追加两次（两条 id）由计数拦下，报「多」', () => {
    expect(failuresOf(fixture(BASE_PATCH + INJECTED + INJECTED), 'xai/grok-4.7/high'))
      .toEqual(['注入态 patch 恰好一条 id: agent-default-model（实际 2 条）'])
  })

  it('注入态：env 格式非法直接红并指明原因', () => {
    for (const raw of ['xai', 'xai/', '/grok-4.7', 'xai/grok-4.7/high/extra']) {
      expect(checkAgentDefaultModelPatch(BASE_PATCH + INJECTED, raw))
        .toEqual([{ ok: false, message: `DSH_FACTORY_DEFAULT_MODEL 需要 provider/model[/effort]，实际：${raw}` }])
    }
  })

  it('不传 raw 时默认读 process.env.DSH_FACTORY_DEFAULT_MODEL', () => {
    const previous = process.env.DSH_FACTORY_DEFAULT_MODEL
    process.env.DSH_FACTORY_DEFAULT_MODEL = 'xai/grok-4.7/high'
    try {
      expect(checkAgentDefaultModelPatch(fixture(BASE_PATCH + INJECTED)).filter(result => !result.ok))
        .toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_FACTORY_DEFAULT_MODEL
      else process.env.DSH_FACTORY_DEFAULT_MODEL = previous
    }
  })
})
