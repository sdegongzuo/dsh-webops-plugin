/**
 * 脚本化假模型（keyless 验证驱动）：把 `llm/stream` 整条拦下来，按预定脚本回放
 * 模型块流 —— 驱动真 agent loop 走完整条工具链，覆盖主上的真实任务流：
 *
 *   1. `browser_open { url }`                    → 打开百度，拿 session_id
 *   2. `browser_snapshot { session_id }`         → 拿 ref（纪元从这里开始）
 *   3. `browser_execute`（Runtime.evaluate）     → 读热搜榜，返回 `{ fifth, list }`
 *   4. `browser_find { query: 第五条标题 }`      → 在大纲里确定性拿到热搜链接的 ref
 *   5. `browser_click { session_id, ref }`       → 真实点击（target=_blank → 弹窗转新标签页）
 *   6. `browser_wait`(1.5s) + `browser_tabs`      → 弹窗标签必须已收编且在前台（[foreground]）
 *   7. `browser_execute`（在前台新标签上）       → 读详情页正文
 *   8. 纯文本收尾（finish: stop）
 *
 * 热搜榜是实时数据：第五条标题从第 3 轮 execute 的结果文本里现抽（`"fifth":"…"`），
 * 详情页的 session id 从第 6 轮 tabs 清单的 `[foreground]` 标记里现抽 —— 全都不写死。
 * session_id 与 ref 的抽取来自请求历史（上一轮工具结果的渲染文本）：`session_id=<id>`
 * 来自 open/snapshot 的回显，`[ref=eN]` 来自 snapshot 大纲、`[eN]` 来自 find 结果。
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

/** 调试打点（DSH_BROWSER_PLUGIN_DEBUG=1 时落桌面端 stdout），用于诊断脚本降级路径。 */
function debugNote(scope: string, message: string): void {
  if (process.env.DSH_BROWSER_PLUGIN_DEBUG !== '1') return
  process.stdout.write(`[dsh-webops-plugin] fake-llm: ${scope}: ${message}\n`)
}

/** 插件配置。 */
export interface FakeLlmConfig {
  /** `browser_open` 打开的地址。默认 `https://example.com/`。 */
  url?: string
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

const DEFAULT_URL = 'https://www.baidu.com/'
const DEFAULT_TEXT = '已走完「打开百度 → 热搜第五条 → 点击 → 读详情」工具链，热搜详情页的正文在轨迹里，工具卡片应当已在本会话渲染。'
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
 * 只从 `browser_find` 渲染里抽 ref（`- [eN] role "name"`）。
 * 不回退到 snapshot 的 `[ref=eN]`：find 0 命中时点大纲最后一项会点错行。
 */
export function lastRef(history: string): string | undefined {
  return [...history.matchAll(/\[(e\d+)\]/gu)].at(-1)?.[1]
}

/** 热搜第五条在 snapshot 大纲里的可访问名以 `5 ` 开头，形如 `link "5 标题"`。 */
export const HOTSEARCH_FIND_QUERY = 'link "5 '

/** 从序号标文本抽出纯数字排名（`5新` → `5`）。 */
export function parseHotSearchRank(raw: string): string {
  return /^\d+/u.exec(raw.trim().replace(/\s+/gu, ''))?.[0] ?? ''
}

/**
 * 按榜单序号 5 取标题。DOM 顺序 ≠ 排名（置顶/推荐会插在前面），
 * 禁止回退到 `items[4]`——2026-09-13 实测那会点到第二条。
 */
export function pickFifthTitle(items: readonly { rank: string; title: string }[]): string | undefined {
  const hit = items.find(item => parseHotSearchRank(item.rank) === '5')
  const title = hit?.title.trim() ?? ''
  return title.length > 0 ? title : undefined
}

/**
 * 从 `browser_execute` 的结果文本里抽「热搜第五条」标题。
 *
 * execute 的表达式返回 `{"fifth":"…","list":[…]}`（JSON 字符串），渲染进历史后
 * 按键名捞值即可；标题里的引号按 JSON 转义还原。
 */
function fifthHotSearch(history: string): string | undefined {
  const match = /"fifth"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(history)
  if (match === null) return undefined
  try {
    const value = JSON.parse(`"${match[1]}"`) as unknown
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** 从 `browser_tabs(list)` 的结果文本里抽**最后**一个前台标签的 session id（弹窗标签）。 */
function foregroundSessionId(history: string): string | undefined {
  return [...history.matchAll(/- session_id=([A-Za-z0-9._-]+) \[foreground\]/gu)].at(-1)?.[1]
}

/** 抽出的「测试效果证据」。 */
export interface DetailDigest {
  /** 热搜榜第五条标题。 */
  fifth: string
  /** 详情页 URL。 */
  url: string
  /** 详情页正文摘录。 */
  excerpt: string
}

/**
 * 抽取结果：成功带证据，失败带**定位用**的理由。
 *
 * 失败理由里附带上百字的尾部快照 —— 2026-09-14 的降级排查踩过：只知道「抽不到」
 * 完全没法定位，得看到历史里那段到底长什么样（是被截断、还是格式变了）。
 */
export type DetailDigestResult = { ok: true; digest: DetailDigest } | { ok: false; reason: string }

/** 失败理由里带的尾部快照长度。 */
const TAIL_SNIPPET = 240

/**
 * 从历史里抽「测试效果证据」：第五条标题 + 详情页 URL + 正文摘录。
 *
 * 详情正文取自最后一轮 execute（在弹窗标签上）的渲染结果——`Runtime.evaluate on
 * session_id=… (at <URL>, ref epoch N) <正文>`，正文到工具结果的 UNTRUSTED 提示为止。
 */
export function detailDigest(history: string): DetailDigestResult {
  const fifth = fifthHotSearch(history)
  if (fifth === undefined) {
    return { ok: false, reason: `fifth: 历史里没有 "fifth":"…" 段（热搜榜 execute 结果没进历史或被截断）` }
  }
  const marker = 'Runtime.evaluate on session_id='
  const lastIdx = history.lastIndexOf(marker)
  if (lastIdx < 0) {
    return { ok: false, reason: `marker: 历史里没有 "${marker}"（详情页 execute 结果没进历史）` }
  }
  const atIdx = history.indexOf('(at ', lastIdx)
  if (atIdx < 0) {
    return { ok: false, reason: `at: marker 之后没有 "(at "，尾部=${JSON.stringify(history.slice(lastIdx, lastIdx + TAIL_SNIPPET))}` }
  }
  // URL 取 `(at ` 之后到第一个空白或逗号为止（`,` 是 URL 与 `, ref epoch N)` 的分隔，
  // 紧跟没有空格，必须排除）。**不要求它后面还有 `, ref epoch N) `**：详情页 URL 动辄
  // 两三百字，而工具结果进入 llm 请求历史时会被截断——2026-09-14 的降级真因就是整条
  // 结果断在 URL 中间，锚点死等 `) ` 从而整段判死。
  const url = /[^\s,]+/u.exec(history.slice(atIdx + 4))?.[0] ?? ''
  if (url === '') {
    return { ok: false, reason: `url: "(at " 之后取不到 URL，尾部=${JSON.stringify(history.slice(atIdx, atIdx + TAIL_SNIPPET))}` }
  }
  const rest = history.slice(atIdx + 4 + url.length)
  const head = /^,\s*ref epoch \d+\)\s*/u.exec(rest)
  if (head === null) {
    return {
      ok: false,
      // URL 已经抽到了，这里单独报「正文段不在」——定位时看得到 URL 就好判断是不是截断。
      reason: `body: URL 之后不是 ", ref epoch N) "（结果被截断则整段正文不在历史里），URL=${JSON.stringify(url)}，其后=${JSON.stringify(rest.slice(0, TAIL_SNIPPET))}`,
    }
  }
  let excerpt = rest.slice(head[0].length)
  const notice = excerpt.indexOf('Everything the page reports')
  if (notice > 0) excerpt = excerpt.slice(0, notice)
  excerpt = excerpt.trim()
  if (excerpt.length > 600) excerpt = `${excerpt.slice(0, 600)}…`
  if (excerpt === '') {
    return { ok: false, reason: `excerpt: 正文段为空，URL=${JSON.stringify(url)}` }
  }
  return { ok: true, digest: { fifth, url, excerpt } }
}

/** 读热搜榜：返回 JSON（`fifth` = 序号 5 的标题，`list` = 全部标题）。 */
// 排名标常在 `li` 上、不在 `a` 里；`[class*="index"]` 会命中空节点导致 rank 全空，
// 再 `items[4]` 回退就会点到第二条。与 pickFifthTitle 同语义：只认序号 5。
const HOTSEARCH_EXPRESSION = "JSON.stringify((() => { const lis = [...document.querySelectorAll('#hotsearch-content-wrapper > li, .s-hotsearch-content li, #hotsearch li')]; const items = lis.map(li => { const idxEl = li.querySelector('.title-content-index'); const titleEl = li.querySelector('.title-content-title'); const link = li.querySelector('a'); const raw = ((idxEl && idxEl.innerText) || '').replace(/\\s+/g, ''); const rank = (raw.match(/^\\d+/) || [''])[0]; let title = ((titleEl && titleEl.innerText) || (link && link.innerText) || li.innerText || '').trim(); if (!titleEl) title = title.replace(/^\\d+\\s*/, ''); return { rank, title }; }).filter(i => i.title.length > 1); const hit = items.find(i => i.rank === '5'); return { fifth: (hit && hit.title) || '', list: items.map(i => (i.rank || '-') + ' ' + i.title) }; })())"

/**
 * 读弹窗标签（热搜详情页）的正文文本。
 *
 * 只取前 1200 字：收尾回复里摘录最多展示 600 字（`detailDigest` 会再截一次），
 * 取更多纯属浪费——而且工具结果进 llm 请求历史时会被截断，正文越长越容易把
 * `(at <URL>, ref epoch N) ` 这一整段连同 URL 尾部一起砍掉（2026-09-14 的降级真因）。
 */
const CONTENT_EXPRESSION = "document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 1200) : ''"

/**
 * 安装脚本化模型回放。
 * @param ctx - cordis 上下文。
 * @param config - 地址与文本。
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context, config: FakeLlmConfig = {}): void {
  // 闸门：没显式开启就什么都不做（`apply` 仍然会被调用，只是不注册监听器）。
  if (process.env[GATE_ENV] !== '1') {
    debugNote('gate', `${GATE_ENV} 未置 1（当前=${process.env[GATE_ENV] ?? '未设'}），不接管 llm/stream`)
    return
  }

  const url = config.url ?? DEFAULT_URL
  const text = config.text ?? DEFAULT_TEXT
  const fallbackText = config.fallbackText ?? DEFAULT_FALLBACK_TEXT

  // 每轮按需从请求的非 system 消息里取参数；返回 undefined 表示「前置工具没成功」，
  // 降级为兜底文本。
  //
  // 2026-09-13 起脚本驱动**真实任务流**（主上的原始需求）：
  // 打开百度 → 读热搜榜 → 真实点击第五条（target=_blank → 弹窗转新标签页，宿主通报 +
  // provider adoptSession 收编）→ tabs(list) 确认弹窗标签在前台 → 在**新标签**上读正文。
  // 热搜榜是实时数据，第五条标题从 execute 结果里现抽（`"fifth":"…"`），不写死。
  const script: ((request: unknown) => StreamChunk[] | undefined)[] = [
    () => toolCallTurn([{ id: 'c1', name: 'browser_open', args: { url } }]),
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      return sessionId === undefined
        ? undefined
        : toolCallTurn([{ id: 'c2', name: 'browser_snapshot', args: { session_id: sessionId } }])
    },
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      if (sessionId === undefined) return undefined
      return toolCallTurn([{
        id: 'c3',
        name: 'browser_execute',
        args: { session_id: sessionId, method: 'Runtime.evaluate', params: { expression: HOTSEARCH_EXPRESSION } },
      }])
    },
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      if (sessionId === undefined) return undefined
      return toolCallTurn([{
        id: 'c4',
        name: 'browser_find',
        // 大纲可访问名是 `link "5 标题"`；用这个前缀定位序号 5，
        // 不拿 execute 抽到的标题去 find（标题抽错就会点到第二条）。
        args: { session_id: sessionId, query: HOTSEARCH_FIND_QUERY },
      }])
    },
    (request) => {
      const history = historyText(request)
      const sessionId = firstSessionId(history)
      const ref = lastRef(history)
      if (sessionId === undefined || ref === undefined) return undefined
      return toolCallTurn([{ id: 'c5', name: 'browser_click', args: { session_id: sessionId, ref } }])
    },
    (request) => {
      const sessionId = firstSessionId(historyText(request))
      if (sessionId === undefined) return undefined
      // 先睡一拍再列标签：弹窗是**异步**转标签的（宿主发 opened 通报 → provider
      // adoptSession 登记），click 返回时它可能还没进注册表。不睡会偶发「tabs 里只有
      // t1」（2026-09-14 实测：同一份代码两次跑，一次收编一次没收编）。
      return toolCallTurn([
        { id: 'c6a', name: 'browser_wait', args: { session_id: sessionId, time_ms: 1500 } },
        { id: 'c6', name: 'browser_tabs', args: { action: 'list' } },
      ])
    },
    (request) => {
      const detailSession = foregroundSessionId(historyText(request))
      if (detailSession === undefined) return undefined
      return toolCallTurn([{
        id: 'c7',
        name: 'browser_execute',
        args: { session_id: detailSession, method: 'Runtime.evaluate', params: { expression: CONTENT_EXPRESSION } },
      }])
    },
    (request) => {
      // 收尾不是写死文本：从轨迹历史里抽出「测试效果证据」（第五条标题 / 详情页 URL /
      // 正文摘录）拼成可见回复 —— 否则聊天里只有一句干巴巴的「走完了」，效果看不见。
      const history = historyText(request)
      const result = detailDigest(history)
      if (!result.ok) {
        debugNote('digest', `动态证据抽取失败，降级静态文本；原因=${result.reason}；历史长度=${history.length}`)
        return textChunks(text)
      }
      const digest = result.digest
      return textChunks([
        '✅ 已完成「打开百度 → 点击热搜第五条 → 读详情」全链路（7 次工具调用）：',
        '',
        `热搜第五条：${digest.fifth}`,
        `详情页：${digest.url}`,
        '',
        `正文摘录：${digest.excerpt}`,
        '',
        '（fake-llm 是脚本回放不会真的归纳；以上是从轨迹里抽出的原始证据。）',
      ].join('\n'))
    },
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
