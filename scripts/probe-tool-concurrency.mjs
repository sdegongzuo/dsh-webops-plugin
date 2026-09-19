/**
 * 并发探针：宿主的工具调度器会不会把两个 `webpage_*` 调用并发跑？
 *
 * 要回答的是 `docs/多会话防冲突-实施方案.md` T1 的前提：「模型一轮里并行发多个
 * webpage_click，会在同一 session 上真正交错」。
 *
 * 判据不自己复刻：工具定义取自**本插件真实的** `apply()`（`src/tool-browser/index.ts`），
 * 并发档位取自**打包宿主里真的** `ToolRuntime.executionMode`（fail-closed：
 * `isConcurrencySafe` 缺失 / 抛错 / 返回非 `true` 一律 exclusive）。
 *
 * 跑法（仓库根）：
 *   node scripts/probe-tool-concurrency.mjs
 *   node scripts/probe-tool-concurrency.mjs --selftest=leaky   # 反向验证：判据必须翻成 parallel
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import * as localEnv from './local-env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
/**
 * 本体缓存所在的根。默认仓库根；`DSH_DESKTOP_BUILD_ROOT`（本机写在 `.env.local`）指到
 * 工作区外就跟着跑 —— 与 `package-desktop-portable.mjs` 的 `BUILD_ROOT` 同源，
 * 统一由 `local-env.mjs` 的 `buildRoot()` 解析。
 */
const buildRoot = localEnv.buildRoot()
const require = createRequire(import.meta.url)

/**
 * 找出本体缓存里那份 dsh 运行时的 `@deepseek-ai`。
 *
 * 2026-09-19 改：本体缓存从单坑 `.desktop-base/app` 改成了**按 dsh 版本分槽**
 * （`.desktop-base/<版本>/app`，见 `scripts/package-desktop-portable.mjs`），
 * 所以这里不能再写死老路径 —— 写死的结果是 `MODULE_NOT_FOUND`，
 * 而且老路径那份缓存本来就是 dsh 0.1.5-rc.2（比出货版本旧），即使不报错也验的是错的东西。
 * 按槽位名降序挑第一个真有 `resources/dsh/node_modules/@deepseek-ai` 的；
 * 找不到就明确报错，别拿旧路径兜底假装能跑。
 */
function findPackagedScope() {
  const candidates = readdirSync(join(buildRoot, '.desktop-base'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .reverse()
  for (const slot of candidates) {
    const scope = join(buildRoot, '.desktop-base', slot, 'app', 'resources', 'dsh', 'node_modules', '@deepseek-ai')
    if (existsSync(join(scope, 'dsh-tools', 'lib', 'index.js'))) return { scope, slot }
  }
  console.error(`找不到打包宿主运行时：${join(buildRoot, '.desktop-base')} 下没有含 resources/dsh/node_modules/@deepseek-ai 的版本槽。`)
  console.error('  先跑一次打包（node scripts/package-desktop-portable.mjs --app <win-unpacked> --cache-base），')
  console.error('  或加 --app 指一份 win-unpacked 后从它里面取。')
  process.exit(1)
}

const { scope: PACKAGED, slot: PACKAGED_SLOT } = findPackagedScope()
console.log(`打包宿主运行时来源（按版本槽解析）：.desktop-base/${PACKAGED_SLOT}/app/resources/dsh`)

/** 反向验证：给 webpage_click 假装加上 isConcurrencySafe，看真闸门会不会翻绿。 */
const SELFTEST = process.argv.includes('--selftest=leaky')

/* ---------- 1. 从插件真实 apply() 抓工具定义 ---------- */

const { tsImport } = await import('tsx/esm/api')
const toolBrowser = await tsImport(
  pathToFileURL(join(repoRoot, 'src/tool-browser/index.ts')).href,
  import.meta.url,
)

/** 注册表桩：只把 defineTool 产出的定义收下来。 */
const registered = new Map()
const noop = () => noop
const ctx = {
  tools: {
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => undefined
    },
    get: (name) => registered.get(name),
  },
  systemPrompt: { section: noop, tools: noop, getSectionOrder: () => 0 },
  attachments: {},
  browser: {},
}
toolBrowser.apply(ctx, {})

const browserTools = [...registered.values()].filter((t) => t.name.startsWith('webpage_'))
console.log(`\n[1/3] 插件注册了 ${browserTools.length} 个 webpage_* 工具`)
if (browserTools.length < 16) {
  console.error(`      只抓到 ${browserTools.length} 个（应为 16）—— 探针本身失效了，别把结论当真`)
  process.exit(1)
}

/* ---------- 2. 注册进打包宿主的真 ToolRuntime，过真闸门 ---------- */

const cordis = require(join(PACKAGED, 'cordis/lib/index.js'))
const packagedTools = require(join(PACKAGED, 'dsh-tools/lib/index.js'))

const base = new cordis.Context()
base.systemPrompt = { tools: (fn) => fn, section: noop, getSectionOrder: () => 0 }
const runtime = new packagedTools.ToolRuntime(base, {})
for (const definition of browserTools) {
  // 反向验证：把 webpage_click 换成「声明了并发安全」的版本注册进去。
  // 不能注册第二个同名 —— 宿主注册表会判 duplicate（这本身也是真代码在跑的证据）。
  if (SELFTEST && definition.name === 'webpage_click') {
    runtime.register({ ...definition, isConcurrencySafe: () => true })
    continue
  }
  runtime.register(definition)
}
if (SELFTEST) console.log('      [selftest=leaky] 已把 webpage_click 换成声明 isConcurrencySafe 的版本')

/** 每个工具按一组真实形状的参数过一次 executionMode。 */
const SAMPLE_ARGS = {
  webpage_open: { url: 'https://example.com' },
  webpage_navigate: { session_id: 'T1', url: 'https://example.com' },
  webpage_snapshot: { session_id: 'T1' },
  webpage_screenshot: { session_id: 'T1' },
  webpage_tabs: { action: 'list' },
  webpage_console: { session_id: 'T1' },
  webpage_network: { session_id: 'T1' },
  webpage_execute: { session_id: 'T1', method: 'Page.getLayoutMetrics' },
  webpage_find: { session_id: 'T1', query: '下一页' },
  webpage_locate: { session_id: 'T1', ref: 'e12' },
  webpage_revalidate: { session_id: 'T1', refs: ['e12'] },
  webpage_click: { session_id: 'T1', ref: 'e12' },
  webpage_fill: { session_id: 'T1', ref: 'e12', value: 'hi' },
  webpage_press: { session_id: 'T1', ref: 'e12', key: 'Enter' },
  webpage_scroll: { session_id: 'T1', deltaY: 600 },
  webpage_wait: { session_id: 'T1', until: 'stable' },
}

const modes = []
for (const definition of browserTools) {
  const exec = {
    callId: 'call-1',
    name: definition.name,
    arguments: SAMPLE_ARGS[definition.name] ?? { session_id: 'T1' },
    agent: undefined,
    signal: new AbortController().signal,
  }
  let mode
  try {
    mode = runtime.executionMode(exec).kind
  } catch (error) {
    mode = `抛错(${String(error instanceof Error ? error.message : error)})`
  }
  modes.push({ name: definition.name, mode, declared: definition.isConcurrencySafe !== undefined })
}

console.log('\n[2/3] 打包宿主 ToolRuntime.executionMode 判定（exclusive = 宿主逐个 await，永不并发）')
for (const item of modes) {
  console.log(`      ${String(item.mode).padEnd(9)} ${item.name}${item.declared ? ' [已声明 isConcurrencySafe]' : ''}`)
}

/* ---------- 3. 结论 ---------- */

const parallel = modes.filter((m) => m.mode === 'parallel')
console.log('\n[3/3] 结论')
console.log('      调度器：dsh-agent-loop/lib/index.js:529-530 —— 组内第一个调用是 exclusive 时 group = [first]')

if (SELFTEST) {
  const ok = parallel.length > 0
  console.log(ok
    ? '      反向验证：判据跟着 isConcurrencySafe 翻成 parallel ⇒ 确实在跑宿主真闸门'
    : '      反向验证失败：加了 isConcurrencySafe 仍判 exclusive ⇒ 判据是假的，上面的结论不可信')
  process.exit(ok ? 0 : 1)
}

console.log(parallel.length === 0
  ? '      ⇒ 全部 webpage_* 判 exclusive：经宿主 agent loop 派发，同一 session 的工具调用不会并发交错'
  : `      ⇒ ${parallel.map((p) => p.name).join(', ')} 判 parallel：会并发交错`)
process.exit(parallel.length === 0 ? 0 : 1)
