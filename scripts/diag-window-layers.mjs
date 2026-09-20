/**
 * 列出 Electron 应用的全部窗口层，找出「盖在主窗口上吃掉鼠标点击」的空壳窗口。
 *
 * 为什么需要它（2026-09-19 真机事故）：主窗口界面正常、按钮 `disabled: false`、
 * `elementFromPoint` 命中的就是按钮本身、用 JS `.click()` 一点就通 —— **但手点没反应**。
 * 真凶是另一个窗口：透明、无内容（39 字节的空文档）、与主窗口同尺寸、还抢了焦点。
 *
 * **命中测试（`elementFromPoint` / `:hover`）只在同一个文档内做，跨窗口的遮挡它看不见** ——
 * 所以「DOM 检查全绿 + 手点无效」这个组合，只能靠列窗口来查。
 *
 * 用法：
 *   # 先带调试端口起应用（打包态主 exe、开发态 electron 都行）
 *   node scripts/diag-window-layers.mjs --port 9333
 *   node scripts/diag-window-layers.mjs --port 9333 --close-suspect   # 关掉可疑窗口（立即恢复可点）
 *
 * 注意：本机 shell 自带 `ELECTRON_RUN_AS_NODE=1`，起应用时要 `env -u`（见 AGENTS.md）。
 */

import { fetchLoopback } from './loopback.mjs'
const portArg = process.argv.indexOf('--port')
const port = portArg === -1 ? 9333 : Number(process.argv[portArg + 1])
const closeSuspect = process.argv.includes('--close-suspect')

if (!Number.isInteger(port) || port <= 0) {
  console.error('--port 需要一个正整数')
  process.exit(2)
}

const endpointLabel = `http://localhost:${String(port)}/json/list`

/** 连到一个 target 并返回一个最小的 CDP 客户端。 */
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let sequence = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const settle = pending.get(message.id)
    if (settle !== undefined) {
      pending.delete(message.id)
      settle(message)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => { reject(new Error(`连不上 ${target.url}`)) })
  })
  return {
    evaluate(expression) {
      const id = ++sequence
      return new Promise((resolve) => {
        pending.set(id, resolve)
        ws.send(JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }))
      }).then((reply) => reply.result?.result?.value)
    },
    dispose() { ws.close() },
  }
}

const describeWindow = `({
  innerW: window.innerWidth, innerH: window.innerHeight,
  screenX: window.screenX, screenY: window.screenY,
  visibility: document.visibilityState,
  hasFocus: document.hasFocus(),
  bodyText: (document.body?.innerText ?? '').length,
  htmlLen: document.documentElement.outerHTML.length,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  children: document.body?.childElementCount ?? -1,
})`

let targets
try {
  targets = await (await fetchLoopback(port, '/json/list')).json()
} catch (error) {
  console.error(`取不到 ${endpointLabel} —— 应用起了吗？带 --remote-debugging-port=${String(port)} 了吗？`)
  console.error(String(error?.message ?? error))
  process.exit(1)
}

const pages = targets.filter((t) => t.type === 'page')
if (pages.length === 0) {
  console.error(`${endpointLabel} 里没有任何 page target`)
  process.exit(1)
}

const rows = []
for (const target of pages) {
  const client = await connect(target)
  const info = await client.evaluate(describeWindow)
  rows.push({ target, info, client })
}

const area = (row) => (row.info?.innerW ?? 0) * (row.info?.innerH ?? 0)
const maxArea = Math.max(...rows.map(area))

// 「主窗口」按**内容量**认，不按面积 —— 遮挡窗口常常和主窗口一样大，
// 面积分不出胜负（反向验证时正是踩了这个坑：把空壳当成了主窗口，判据整条失效）。
const contentWeight = (row) => row.info?.htmlLen ?? 0
const main = rows.reduce(
  (best, row) => (contentWeight(row) > contentWeight(best) ? row : best),
  rows[0],
)

/** 可疑 = 可见 + 自己几乎是空文档 + 却占着接近满屏的尺寸（会吃掉所有鼠标事件）。 */
function isSuspect(row) {
  const i = row.info
  if (i?.visibility !== 'visible') return false
  if ((i?.htmlLen ?? 0) > 400) return false
  if ((i?.bodyText ?? 0) > 0) return false
  return area(row) >= maxArea * 0.9
}

console.log(`共 ${String(rows.length)} 个窗口（${endpointLabel}）\n`)
for (const row of rows) {
  const i = row.info
  const suspect = isSuspect(row)
  const empty = (i?.bodyText ?? 1) === 0 && (i?.htmlLen ?? 0) <= 400

  console.log(`${suspect ? '⚠ ' : '  '}${row.target.url}${row === main ? '   ← 主窗口' : ''}`)
  console.log(`    位置 (${String(i?.screenX)},${String(i?.screenY)})  尺寸 ${String(i?.innerW)}×${String(i?.innerH)}`)
  console.log(`    可见=${String(i?.visibility)}  焦点=${String(i?.hasFocus)}  ` +
    `正文=${String(i?.bodyText)} 字节  HTML=${String(i?.htmlLen)} 字节  body 子元素=${String(i?.children)}`)
  console.log(`    背景=${String(i?.bodyBg)}${empty ? '   ← 窗口里没有内容' : ''}\n`)
}

const suspects = rows.filter(isSuspect)

if (suspects.length === 0) {
  console.log('没有发现「空白且与主窗口等大」的可见窗口。')
  if (main.info?.hasFocus !== true) {
    console.log('⚠ 但主窗口没有焦点 —— 手点可能仍然不生效，检查是不是别的前台窗口抢了。')
  }
} else {
  console.log(`⚠ 发现 ${String(suspects.length)} 个可疑窗口：它们透明且没有内容，` +
    '但可见、和主窗口一样大 —— 会吃掉所有鼠标事件。')
  if (main.info?.hasFocus !== true) console.log('   （主窗口 hasFocus=false，和这个判断吻合）')
  if (closeSuspect) {
    for (const row of suspects) {
      await row.client.evaluate('window.close()')
      console.log(`   已关掉 ${row.target.url}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const after = await (await fetchLoopback(port, '/json/list')).json()
    console.log(`   关闭后剩余窗口：${after.map((t) => t.url).join(', ')}`)
  } else {
    console.log('   加 --close-suspect 可以直接关掉它们（遮挡会立刻解除）。')
  }
}

for (const row of rows) row.client.dispose()
