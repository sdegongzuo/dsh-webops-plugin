/**
 * 脚本化假模型（keyless 验证驱动）：把 `llm/stream` 整条拦下来，按预定脚本回放
 * 模型块流 —— 驱动真 agent loop 走完整条工具链，覆盖主上的真实任务流：
 *
 *   1. `webpage_open { url }`                 → 打开谷歌首页，拿 session_id
 *   2. `webpage_snapshot { session_id }`      → 拿 ref（纪元从这里开始）
 *   3. `webpage_find { query: AI 模式 }`      → 定位首页上的 AI 模式入口
 *   4. `webpage_click { session_id, ref }`    → 点进去
 *   5. `webpage_wait` + `webpage_snapshot`    → 等 AI 模式输入框出来
 *   6. `webpage_find { query: textbox }`      → 定位提问框
 *   7. `webpage_fill` + `webpage_press Enter` → 写入问题并发送
 *   8. `webpage_wait` + `webpage_snapshot`    → 等回答落在页面上
 *   9. 纯文本收尾（finish: stop）
 *
 * session_id 与 ref 从请求历史现抽：`session_id=<id>` 来自 open/snapshot 回显，
 * `[eN]` 来自 find 结果。抽不到就降级为兜底文本，绝不炸会话。
 *
 * 没有 LLM key 时走这条脚本。有 key 时（便携版 `app` 同级的 `home\.credentials.yaml`，
 * 或环境变量）可以关掉 `DSH_FAKE_LLM` 让真模型自己点 —— 那份 key **只在那份 home 里**，
 * 不进发版包，也不从 `~/.dsh` 捞。
 *
 * @module dsh-webops-plugin/fake-llm
 */

import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** 调试打点（DSH_BROWSER_PLUGIN_DEBUG=1 时落桌面端 stdout），用于诊断脚本降级路径。 */
function debugNote(scope: string, message: string): void {
  if (process.env.DSH_BROWSER_PLUGIN_DEBUG !== '1') return
  process.stdout.write(`[dsh-webops-plugin] fake-llm: ${scope}: ${message}\n`)
}

/** 插件配置。 */
export interface FakeLlmConfig {
  /** `webpage_open` 打开的地址。默认谷歌首页（中文界面，好点到「AI 模式」）。 */
  url?: string
  /** 填进 AI 模式提问框的问题。 */
  question?: string
  /** 收尾（脚本走完）的助手文本。 */
  text?: string
  /** 兜底文本（脚本降级或耗尽后的所有调用都回它）。 */
  fallbackText?: string
}

/**
 * 接管 `llm/stream` 的闸门环境变量。
 *
 * `llm/stream` 在 dsh 里是 **waterfall**（`dsh-llm`：`ctx.waterfall(this, 'llm/stream', …)`），
 * 监听器只要不调 `next()` 就直接短路掉真实模型。所以这个插件**默认必须是哑的**：
 * 出货包里它根本不该被挂载（见仓库根的 `cordis.patch.yml` 与 `cordis.fake-llm.patch.yml`），
 * 而这道闸是第二层保险 —— 万一那行被误加回出货 patch，用户看到的是「插件没反应」，
 * 而不是「我的对话被换成了假回放」。
 */
export const GATE_ENV = 'DSH_FAKE_LLM'

export const DEFAULT_URL = 'https://www.google.com/?hl=zh-CN'
export const DEFAULT_QUESTION = '为什么天空是蓝色的'
/** 首页上「AI 模式」入口的 find 查询（中文界面）。 */
export const AI_MODE_FIND_QUERY = 'AI 模式'
/** 点进 AI 模式后，提问框在大纲里是 textbox / searchbox。 */
export const PROMPT_FIND_QUERY = 'textbox'
const DEFAULT_TEXT = '已走完「打开谷歌首页 → 点击 AI 模式 → 提问」工具链，回答在轨迹的 snapshot 里。'
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

/**
 * 只从 `webpage_find` 渲染里抽 ref（`- [eN] role "name"`）。
 * 不回退到 snapshot 的 `[ref=eN]`：find 0 命中时点大纲最后一项会点错行。
 */
export function lastRef(history: string): string | undefined {
  return [...history.matchAll(/\[(e\d+)\]/gu)].at(-1)?.[1]
}

/** 抽出的「测试效果证据」。 */
export interface GoogleDigest {
  /** 打开的地址。 */
  url: string
  /** 写入提问框的问题。 */
  question: string
  /** 最后一次 snapshot 大纲摘录。 */
  outline: string
}

export type GoogleDigestResult = { ok: true; digest: GoogleDigest } | { ok: false; reason: string }

const TAIL_SNIPPET = 240

/**
 * 从历史里抽「打开谷歌 → AI 模式 → 提问」的证据。
 *
 * 不写死回答正文（谷歌生成是实时的）；只要 open 到了 google.com、fill 写进了问题、
 * 最后一次 snapshot 有大纲，就算链路走完。
 */
export function googleDigest(history: string, question: string): GoogleDigestResult {
  const openUrl = /https?:\/\/[^\s)]*google\.[^\s)]+/iu.exec(history)?.[0]
  if (openUrl === undefined) {
    return { ok: false, reason: `url: 历史里没有 google. 的打开地址，尾部=${JSON.stringify(history.slice(-TAIL_SNIPPET))}` }
  }
  if (!history.includes(question)) {
    return { ok: false, reason: `question: 历史里没有问题 ${JSON.stringify(question)}` }
  }
  const marker = 'webpage_snapshot'
  const lastIdx = history.lastIndexOf(marker)
  if (lastIdx < 0) {
    return { ok: false, reason: 'outline: 历史里没有 webpage_snapshot' }
  }
  let outline = history.slice(lastIdx)
  const notice = outline.indexOf('Everything the page reports')
  if (notice > 0) outline = outline.slice(0, notice)
  outline = outline.trim()
  if (outline.length > 600) outline = `${outline.slice(0, 600)}…`
  if (outline.length < 20) {
    return { ok: false, reason: `outline: 最后一次 snapshot 太短，URL=${JSON.stringify(openUrl)}` }
  }
  return { ok: true, digest: { url: openUrl, question, outline } }
}

/**
 * 安装脚本化模型回放。
 * @param ctx - cordis 上下文。
 * @param config - 地址与文本。
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context, config: FakeLlmConfig = {}): void {
  if (process.env[GATE_ENV] !== '1') {
    debugNote('gate', `${GATE_ENV} 未置 1（当前=${process.env[GATE_ENV] ?? '未设'}），不接管 llm/stream`)
    return
  }

  const url = config.url ?? DEFAULT_URL
  const question = config.question ?? DEFAULT_QUESTION
  const text = config.text ?? DEFAULT_TEXT
  const fallbackText = config.fallbackText ?? DEFAULT_FALLBACK_TEXT

  const script: ((request: unknown) => StreamChunk[] | undefined)[] = [
    () => toolCallTurn([{ id: 'c1', name: 'webpage_open', args: { url } }]),
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      return sessionId === undefined
        ? undefined
        : toolCallTurn([{ id: 'c2', name: 'webpage_snapshot', args: { session_id: sessionId } }])
    },
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      if (sessionId === undefined) return undefined
      return toolCallTurn([{
        id: 'c3',
        name: 'webpage_find',
        args: { session_id: sessionId, query: AI_MODE_FIND_QUERY },
      }])
    },
    (request) => {
      const history = historyText(request)
      const sessionId = firstSessionId(history)
      const ref = lastRef(history)
      if (sessionId === undefined || ref === undefined) return undefined
      return toolCallTurn([{ id: 'c4', name: 'webpage_click', args: { session_id: sessionId, ref } }])
    },
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      if (sessionId === undefined) return undefined
      return toolCallTurn([
        { id: 'c5a', name: 'webpage_wait', args: { session_id: sessionId, time_ms: 2000 } },
        { id: 'c5', name: 'webpage_snapshot', args: { session_id: sessionId } },
      ])
    },
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      if (sessionId === undefined) return undefined
      return toolCallTurn([{
        id: 'c6',
        name: 'webpage_find',
        args: { session_id: sessionId, query: PROMPT_FIND_QUERY },
      }])
    },
    (request) => {
      const history = historyText(request)
      const sessionId = firstSessionId(history)
      const ref = lastRef(history)
      if (sessionId === undefined || ref === undefined) return undefined
      return toolCallTurn([
        { id: 'c7', name: 'webpage_fill', args: { session_id: sessionId, ref, value: question } },
        { id: 'c8', name: 'webpage_press', args: { session_id: sessionId, ref, key: 'Enter' } },
      ])
    },
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      if (sessionId === undefined) return undefined
      return toolCallTurn([
        { id: 'c9a', name: 'webpage_wait', args: { session_id: sessionId, time_ms: 4000 } },
        { id: 'c9', name: 'webpage_snapshot', args: { session_id: sessionId } },
      ])
    },
    (request) => {
      const history = historyText(request)
      const result = googleDigest(history, question)
      if (!result.ok) {
        debugNote('digest', `动态证据抽取失败，降级静态文本；原因=${result.reason}；历史长度=${history.length}`)
        return textChunks(text)
      }
      const digest = result.digest
      return textChunks([
        '✅ 已完成「打开谷歌首页 → 点击 AI 模式 → 提问」全链路：',
        '',
        `打开：${digest.url}`,
        `问题：${digest.question}`,
        '',
        `页面摘录：${digest.outline}`,
        '',
        '（fake-llm 是脚本回放不会真的归纳；以上是从轨迹里抽出的原始证据。）',
      ].join('\n'))
    },
  ]
  let cursor = 0

  ctx.on('llm/stream', (options, _next: unknown): AsyncIterable<StreamChunk> => {
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
