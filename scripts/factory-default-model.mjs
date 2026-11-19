/**
 * 可选：给便携包的出厂 profile patch 追加一个默认模型。
 *
 * 默认不写任何模型 provider —— 这是出厂策略，`scripts/verify-settings.mjs` 有反向断言守着。
 * 有的构建面向单一订阅（例如本机 Grok 包），可以在打包时设：
 *
 *   DSH_FACTORY_DEFAULT_MODEL=xai/grok-4.7/high
 *
 * 只有显式设置该环境变量才会追加 `agent-default-model`，CI 与普通发布不受影响。
 */
import { appendFileSync } from 'node:fs'

/** 把 provider/model/effort 变成界面同款文案，供使用说明和构建日志复用。 */
export function formatFactoryDefaultModel(config) {
  const effort = { low: 'Low', medium: 'Medium', high: 'High' }[config.reasoningEffort] ?? config.reasoningEffort
  if (config.provider === 'xai' && config.model === 'grok-4.7') return `Grok 4.7 / ${effort}`
  return `${config.provider} / ${config.model} / ${effort}`
}

export function appendFactoryDefaultModel(patchPath, raw = process.env.DSH_FACTORY_DEFAULT_MODEL) {
  if (raw === undefined || raw === '') return undefined
  const [provider, model, reasoningEffort = 'high', ...rest] = raw.split('/')
  if (provider === '' || model === '' || rest.length > 0) {
    throw new Error(`DSH_FACTORY_DEFAULT_MODEL 需要 provider/model[/effort]，实际：${raw}`)
  }
  const block = [
    '',
    '# 本次构建显式指定默认模型（DSH_FACTORY_DEFAULT_MODEL）。',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
    `    reasoningEffort: ${JSON.stringify(reasoningEffort)}`,
    '',
  ].join('\n')
  appendFileSync(patchPath, block, 'utf8')
  return { provider, model, reasoningEffort }
}
