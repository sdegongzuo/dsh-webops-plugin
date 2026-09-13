/**
 * 脚本化假模型（keyless 验证驱动）：把 `llm/stream` 整条拦下来，按预定脚本回放
 * 模型块流 —— 驱动真 agent loop 走完整条 P1 工具链：
 *
 *   1. `browser_open { url }`                 → 开标签页，拿 session_id
 *   2. `browser_snapshot { session_id }`      → 拿 ref（纪元从这里开始）
 *   3. `browser_tabs { action: 'list' }` + `browser_click { session_id, ref }`
 *                                             → 同一轮发两个工具调用，验证
 *                                               标签页管理与按 ref 操作都真执行
 *   4. 纯文本收尾（finish: stop）
 *
 * session_id 与 ref 不写死：每轮发起前从请求历史（上一轮工具结果的渲染文本）里抽 ——
 * `session_id=<id>` 来自 open/snapshot 的回显，`[ref=eN]` 来自 snapshot 大纲。
 * 抽不到（比如工具执行失败）就降级为兜底文本，绝不炸会话。
 *
 * 用途只有一个：没有 `DEEPSEEK_API_KEY` 时也能跑通「真 agent loop → 真 browser_*
 * 工具执行 → 客户端真的渲染工具卡片」这条链。它不是 mock 测试基建 —— 那是官方
 * `@deepseek-ai/dsh-llm-replay` 的事；这个插件刻意极简，脚本写死、全局队列按序消费，
 * 脚本耗尽后的额外调用（比如标题生成）一律回一句兜底文本。
 *
 * @module dsh-webops-plugin/fake-llm
 */

import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** 插件配置。 */
export interface FakeLlmConfig {
  /** `browser_open` 打开的地址。默认 `https://example.com/`。 */
  url?: string
  /** 收尾（脚本走完）的助手文本。 */
  text?: string
  /** 兜底文本（脚本降级或耗尽后的所有调用都回它）。 */
  fallbackText?: string
}

const DEFAULT_URL = 'https://example.com/'
const DEFAULT_TEXT = '已走完 browser_open → snapshot → tabs+click 工具链，工具卡片应当已在本会话渲染。'
const DEFAULT_FALLBACK_TEXT = '（fake-llm：脚本已耗尽，这是兜底回复。）'

/** 一轮「发起若干工具调用」的模型块流；同一轮多个调用就是多个 tool-call 块。 */
function toolCallTurn(calls: { id: string; name: string; args: Record<string, unknown> }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    const args = JSON.stringify(call.args)
    chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
    chunks.push({ type: 'tool-call-delta', index, id: ToolCallId(call.id), name: call.name, argumentsDelta: args })
    chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: args } })
  })
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
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

/** 递归收集一个内容块（或块数组）里所有 text 文本；tool-result 的正文嵌在它的 content 里。 */
function collectText(block: unknown, out: string[]): void {
  if (typeof block === 'string') {
    out.push(block)
    return
  }
  if (Array.isArray(block)) {
    for (const item of block) collectText(item, out)
    return
  }
  if (block !== null && typeof block === 'object') {
    const shape = block as { type?: unknown; text?: unknown; content?: unknown }
    if (shape.type === 'text' && typeof shape.text === 'string') out.push(shape.text)
    if (shape.type === 'tool-result' && shape.content !== undefined) collectText(shape.content, out)
  }
}

/**
 * 从请求里抽取**非 system 消息**的文本（工具结果都在这里）。
 *
 * 只解析 `options.messages`、跳过 `role === 'system'`：系统提示的分段文本里就有
 * `[ref=e12]` 这个示例，整包 JSON.stringify 会把示例当成历史内容，click 必然
 * 拿示例 ref 去 `BROWSER_STALE_REF`。工具结果的结构是 message.content →
 * tool-result 块 → content → text 块，递归收集即可。
 */
function historyText(options: unknown): string {
  const messages = (options as { messages?: unknown } | undefined)?.messages
  if (!Array.isArray(messages)) return ''
  const out: string[] = []
  for (const message of messages) {
    const shape = message as { role?: unknown; content?: unknown }
    if (shape.role === 'system') continue
    collectText(shape.content, out)
  }
  return out.join('\n')
}

/** 从历史文本里抽出第一个 session id（来自 open/snapshot 的回显）。 */
function firstSessionId(history: string): string | undefined {
  return /session_id=([A-Za-z0-9._-]+)/u.exec(history)?.[1]
}

/** 从历史文本里抽出最新一个 `[ref=eN]`（最新 snapshot 的结果在历史末尾）。 */
function lastRef(history: string): string | undefined {
  return [...history.matchAll(/\[ref=(e\d+)\]/gu)].at(-1)?.[1]
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

  // 每轮按需从请求的非 system 消息里取参数；返回 undefined 表示「前置工具没成功」，
  // 降级为兜底文本。
  const script: ((request: unknown) => StreamChunk[] | undefined)[] = [
    () => toolCallTurn([{ id: 'c1', name: 'browser_open', args: { url } }]),
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      return sessionId === undefined
        ? undefined
        : toolCallTurn([{ id: 'c2', name: 'browser_snapshot', args: { session_id: sessionId } }])
    },
    (request) => {
      const history = historyText(request)
      const sessionId = firstSessionId(history)
      const ref = lastRef(history)
      if (sessionId === undefined || ref === undefined) return undefined
      return toolCallTurn([
        { id: 'c3', name: 'browser_tabs', args: { action: 'list' } },
        { id: 'c4', name: 'browser_click', args: { session_id: sessionId, ref } },
      ])
    },
    () => textChunks(text),
  ]
  let cursor = 0

  ctx.on('llm/stream', (options, _next: unknown): AsyncIterable<StreamChunk> => {
    // 标题生成等旁路调用带 purpose；只有主任务调用按序消费脚本，
    // 其余一律兜底 —— 否则标题调用会把脚本里那几条抢走。
    const purpose = (options as { purpose?: string } | undefined)?.purpose
    let entry: StreamChunk[] | undefined
    if (purpose === undefined) {
      entry = script[cursor]?.(options)
      cursor += 1
    }
    if (entry === undefined) entry = textChunks(fallbackText)
    return (async function* () {
      for (const chunk of entry as StreamChunk[]) yield chunk
    })()
  })
}

export const name = 'fake-llm'
