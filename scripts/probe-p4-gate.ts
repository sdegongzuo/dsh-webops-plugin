/**
 * P4 门禁探针：对给定页面**连拍两次全量 snapshot**，量 §4 的第 2、3 个数。
 *
 * ## 为什么需要它
 *
 * §4 把这两个数归在「scripted 走查」那一档，而 D-7=B 的自计（`src/browser-cdp/metrics.ts`）
 * **只覆盖 `BROWSER_STALE_REF` 的分桶**，不记快照体积。没有这个脚本，P4 的裁决就永远缺依据
 * —— §8 的两道门禁（收益上限、行文本不变率 ≥80%）都算不出来（见方案 §13 D-15）。
 *
 * ## 量的两个数
 *
 * 1. **单次全量 snapshot 的模型可见体积** —— 取 `BrowserSnapshot.outline` 的字符数与行数。
 *    用**字符数**而不是「token 数」：精确 token 要目标模型的 tokenizer，而 P4 的收益上限要的是
 *    **可比体积**（§4：页面本身只有 3KB 级 → P4 直接出局），字符数够用且零依赖。
 *    ⚠️ `fullOutline` **不算体积** —— 它不进模型上下文（见 `BrowserSnapshot` 的字段注释）。
 * 2. **连拍两次的行文本不变率** —— 两次 `outline` 的行**多重集合**交集 ÷ 第一次行数。
 *    用行文本而不是 `backendNodeId` 存活率：改 `value` 时后者存活、前者已变
 *    （`snapshot.ts:338` 把 `value="…"` 印进行文本）。这是 §4 的纪律 —— 口径混报本仓库付过两次代价。
 *    ⚠️ 比较前**必须剥掉行尾的 `[ref=eN]`**（见 `stripRefMarks`）：每次全量 snapshot 都重编纪元，
 *    ref 号天然每次都变，不剥会把一个毫秒级没变的静态页量成 66.7% —— 实测踩过。
 *
 * ## 跑法（端点必须是一台**能开标签页的真 Chrome**）
 *
 *   "<真 Chrome>" --headless=new --remote-debugging-port=9444 \
 *     --user-data-dir=<工作区外的一次性目录> about:blank &
 *   DSH_CDP_ENDPOINT=http://127.0.0.1:9444 node node_modules/tsx/dist/cli.mjs \
 *     scripts/probe-p4-gate.ts <url> [<url>...]
 *
 *   可选：`--wait=1500`（两次快照的间隔毫秒，默认 1500）或 `P4_WAIT_MS`。
 *
 * ## 两条纪律
 *
 * - **公开页面跑出来的数只能当工具的体检，不得用来裁决 P4** —— 它没有目标站点的代表性。
 *   §4 的裁决只认主上给的目标站点 URL。
 * - 与 `probe-gate-live.ts` 同一个坑：本机 9222/9333 常年被桌面端 Electron 占着，它
 *   `/json/version` 同样回 200 却**不实现** `PUT /json/new` —— 拿它当端点会跑出一个看着
 *   可信、其实无意义的结果。**别把那种端点当真 Chrome。**
 */

import { CdpBrowserProvider } from '../src/browser-cdp/provider.ts'
import { validateEndpoint } from '../src/browser-cdp/url-policy.ts'

const rawEndpoint = process.env['DSH_CDP_ENDPOINT']
if (rawEndpoint === undefined || rawEndpoint.length === 0) {
  console.error('缺 DSH_CDP_ENDPOINT：指向一台能开标签页的真 Chrome，例如 '
    + 'DSH_CDP_ENDPOINT=http://127.0.0.1:9444 node node_modules/tsx/dist/cli.mjs scripts/probe-p4-gate.ts <url>')
  process.exit(1)
}
const ENDPOINT = validateEndpoint(rawEndpoint)

const argv = process.argv.slice(2)
const URLs = argv.filter(arg => !arg.startsWith('--'))
const waitFlag = argv.find(arg => arg.startsWith('--wait='))
const WAIT_MS = waitFlag === undefined
  ? Number(process.env['P4_WAIT_MS'] ?? 1500)
  : Number(waitFlag.slice('--wait='.length))

if (URLs.length === 0) {
  console.error('缺 URL：至少要给一个页面。'
    + 'DSH_CDP_ENDPOINT=... node node_modules/tsx/dist/cli.mjs scripts/probe-p4-gate.ts https://example.com/')
  process.exit(1)
}
if (!Number.isFinite(WAIT_MS) || WAIT_MS < 0) {
  console.error(`--wait 不是合法毫秒数：${waitFlag ?? process.env['P4_WAIT_MS']}`)
  process.exit(1)
}

/** §8 的第二道门禁：行文本不变率 ≥ 80% 才值得做 diff。 */
const STABILITY_TARGET = 0.8
/** §4 的体积参考线：页面本身只有 3KB 级 → P4 直接出局（单位：outline 字符数）。 */
const SIZE_FLOOR_CHARS = 3000

interface SnapshotSize {
  readonly chars: number
  readonly lines: number
  readonly refs: number
  readonly truncated: boolean
  readonly dropped: number
}

interface Measurement {
  readonly url: string
  readonly ok: boolean
  readonly error?: string
  readonly first?: SnapshotSize
  readonly second?: SnapshotSize
  readonly stability?: number
}

const results: Measurement[] = []

for (const url of URLs) {
  const provider = new CdpBrowserProvider({ endpoint: ENDPOINT })
  try {
    results.push(await measure(provider, url))
  } finally {
    await provider.dispose().catch(() => undefined)
  }
}

report(results)
process.exit(results.every(result => result.ok) ? 0 : 1)

/** 一次完整测量：开页面 → 拍两次 → 关页面。**单次失败不中断其余的 URL**。 */
async function measure(provider: CdpBrowserProvider, url: string): Promise<Measurement> {
  console.log(`\n[测量] ${url}`)
  try {
    const session = await provider.open({ url })
    try {
      const first = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (first.kind !== 'snapshot') throw new Error(`期望 snapshot，拿到 ${first.kind}`)
      await delay(WAIT_MS)
      const second = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (second.kind !== 'snapshot') throw new Error(`期望 snapshot，拿到 ${second.kind}`)
      return {
        url,
        ok: true,
        first: sizeOf(first.outline, first.refs.length, first.truncated, first.droppedElements ?? 0),
        second: sizeOf(second.outline, second.refs.length, second.truncated, second.droppedElements ?? 0),
        stability: lineStability(first.outline, second.outline),
      }
    } finally {
      await provider.close(session.id).catch(() => undefined)
    }
  } catch (error) {
    // 单个页面挂了不该把整轮测量带走 —— 记下原文，继续下一个。
    return { url, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function sizeOf(outline: string, refs: number, truncated: boolean, dropped: number): SnapshotSize {
  return {
    chars: outline.length,
    lines: outline.split('\n').filter(line => line.trim().length > 0).length,
    refs,
    truncated,
    dropped,
  }
}

/**
 * 行文本不变率。用**多重集合**而不是集合：重复行（列表、同名控件）本身是信息，
 * 折成集合会把「少了 5 个重复行」看成没变。
 */
function lineStability(first: string, second: string): number {
  const before = countLines(stripRefMarks(first))
  const after = countLines(stripRefMarks(second))
  let total = 0
  let stable = 0
  for (const [line, count] of before) {
    total += count
    stable += Math.min(count, after.get(line) ?? 0)
  }
  // 两边都空（空白页）时算「没变化」而不是 NaN —— 分母为零不该被读成「不稳定」。
  return total === 0 ? 1 : stable / total
}

/**
 * 剥掉行尾的 `[ref=eN]` 标记。
 *
 * ⚠️ **这一步不能省**，实测（2026-09-19）：`example.com` 这种纯静态页两次快照的 outline
 * 唯一差异就是 ref 号 —— `[ref=e1]` → `[ref=e2]`，因为**每次全量 snapshot 都重编纪元**
 * （那次实测 epoch 1 → 2）。不剥的话，一个毫秒级没变的页面会被量成 **66.7%**
 * （3 行里 1 行不同），把不变率压低一个恒定噪声底，P4 的门禁就直接被判成不达标。
 *
 * §4 要量的是**内容**变没变，而 ref 号是定位标记、天然每次都变 —— 它属于「指哪儿」，
 * 不属于「长什么样」。形态来自 `snapshot.ts:732`：
 * ``${indent}- ${line.text} [ref=${target.ref}]``。
 */
function stripRefMarks(outline: string): string {
  return outline.replaceAll(/ \[ref=[^\]]*\]/g, '')
}

function countLines(outline: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const raw of outline.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

function report(measured: readonly Measurement[]): void {
  console.log(`\n=== P4 门禁测量（方案 §4 的数 2、数 3）===`)
  console.log(`端点 ${ENDPOINT}    两次快照间隔 ${WAIT_MS}ms    门禁 不变率 ≥ ${(STABILITY_TARGET * 100).toFixed(0)}% / 体积参考线 ${SIZE_FLOOR_CHARS} 字符`)

  for (const result of measured) {
    if (!result.ok) {
      console.log(`\nFAIL ${result.url}\n     ${result.error ?? '未知错误'}`)
      continue
    }
    const first = result.first as SnapshotSize
    const second = result.second as SnapshotSize
    const stability = result.stability as number
    const truncatedNote = first.truncated ? `，**被截断**，另有 ${first.dropped} 个元素没输出` : ''
    console.log(`\nPASS ${result.url}`)
    console.log(`     单次快照：${first.chars} 字符 / ${first.lines} 行 / ${first.refs} 个 ref${truncatedNote}`)
    console.log(`     第二次：  ${second.chars} 字符 / ${second.lines} 行 / ${second.refs} 个 ref`)
    console.log(`     行文本不变率 ${(stability * 100).toFixed(1)}%`
      + `（${Math.round(stability * first.lines)}/${first.lines} 行，按多重集合）`)
    console.log(`     门禁读数：体积 ${first.chars} 字符`
      + `（${first.chars < SIZE_FLOOR_CHARS ? '低于' : '高于'} §4 的 ${SIZE_FLOOR_CHARS} 字符参考线）`
      + `；不变率 ${stability >= STABILITY_TARGET ? '达标' : '未达标'}`)
  }

  const ok = measured.filter(result => result.ok)
  const sizes = ok.map(result => (result.first as SnapshotSize).chars).sort((a, b) => a - b)
  const stabilities = ok.map(result => result.stability as number).sort((a, b) => a - b)
  console.log(`\n=== 汇总（成功 ${ok.length} / 共 ${measured.length}）===`)
  if (ok.length === 0) {
    console.log('没有一次测量成功 —— 先查端点和网络，这里的「没数据」不能读成「P4 该砍」。')
  } else {
    console.log(`     体积中位数 ${median(sizes)} 字符（min ${sizes[0]} / max ${sizes[sizes.length - 1]}）`)
    console.log(`     不变率中位数 ${(median(stabilities) * 100).toFixed(1)}%`
      + `（最低 ${(stabilities[0] * 100).toFixed(1)}%）`)
  }
  console.log('\n⚠️ 这些数**只在目标站点上取才有裁决力**。公开页面（example.com 之类）只算工具体检。')
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
