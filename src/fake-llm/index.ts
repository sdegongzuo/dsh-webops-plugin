/**
 * 脚本化假模型（keyless 验证驱动）：把 `llm/stream` 整条拦下来，按预定脚本回放
 * 模型块流 —— 第一轮回一个 `browser_open` 工具调用（finish: tool-calls），等工具
 * **真的执行完**，第二轮回一段文本收尾（finish: stop）。
 *
 * 用途只有一个：没有 `DEEPSEEK_API_KEY` 时也能跑通「真 agent loop → 真 browser_*
 * 工具执行 → 客户端真的渲染工具卡片」这条链。它不是 mock 测试基建 —— 那是官方
 * `@deepseek-ai/dsh-llm-replay` 的事；这个插件刻意极简，脚本写死、全局队列按序消费，
 * 脚本耗尽后的额外调用（比如标题生成）一律回一句兜底文本，绝不炸会话。
 *
 * @module dsh-webops-plugin/fake-llm
 */

import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** 插件配置。 */
export interface FakeLlmConfig {
  /** `browser_open` 打开的地址。默认 `https://example.com/`。 */
  url?: string
  /** 第二轮（收尾）的助手文本。 */
  text?: string
  /** 工具调用轮之后的兜底文本（脚本耗尽后的所有调用都回它）。 */
  fallbackText?: string
}

const DEFAULT_URL = 'https://example.com/'
const DEFAULT_TEXT = '已用 browser_open 打开页面，工具卡片应当已在本会话渲染。'
const DEFAULT_FALLBACK_TEXT = '（fake-llm：脚本已耗尽，这是兜底回复。）'

/** 一轮「发起 browser_open 工具调用」的模型块流。 */
function toolCallChunks(url: string): StreamChunk[] {
  const args = JSON.stringify({ url })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), name: 'browser_open', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'browser_open', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** 一轮「纯文本收尾」的模型块流。 */
function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * 安装脚本化模型回放。
 * @param ctx - cordis 上下文。
 * @param config - 地址与文本。
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context, config: FakeLlmConfig = {}): void {
  const url = config.url ?? DEFAULT_URL
  const text = config.text ?? DEFAULT_TEXT
  const fallbackText = config.fallbackText ?? DEFAULT_FALLBACK_TEXT
  const script: StreamChunk[][] = [toolCallChunks(url), textChunks(text)]
  let cursor = 0

  ctx.on('llm/stream', (options, _next: unknown): AsyncIterable<StreamChunk> => {
    // 标题生成等旁路调用带 purpose；只有主任务调用按序消费脚本，
    // 其余一律兜底 —— 否则标题调用会把「发起工具调用」那一条抢走。
    const purpose = (options as { purpose?: string } | undefined)?.purpose
    const entry = purpose === undefined ? script[cursor] ?? textChunks(fallbackText) : textChunks(fallbackText)
    if (purpose === undefined) cursor += 1
    return (async function* () {
      for (const chunk of entry) yield chunk
    })()
  })
}

export const name = 'fake-llm'
