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
  // 缺 model 段（例如只写 `xai`）必须当场报错：否则 JSON.stringify(undefined) 的结果是
  // 值 `undefined`，模板串会把它写成字面量 `undefined`，宿主的模型名就成了 "undefined"，
  // 只能等运行时请求失败才发现；verify-settings 虽然是最后一道门，但构建期报错更省事。
  if (!provider || !model || rest.length > 0) {
    throw new Error(`DSH_FACTORY_DEFAULT_MODEL 需要 provider/model[/effort]（例如 xai/grok-4.7/high），实际：${raw}`)
  }
  // `xai/grok-4.7/` 这种尾随斜杠：默认值只在 undefined 时生效，空串会写进 `reasoningEffort: ""`。
  if (reasoningEffort === '') {
    throw new Error(`DSH_FACTORY_DEFAULT_MODEL 的 effort 段不能为空，省略即默认 high，实际：${raw}`)
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
