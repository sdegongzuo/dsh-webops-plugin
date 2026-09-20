#!/usr/bin/env node
/**
 * 通过 CDP 对**正在跑的**桌面端做一次真实动作 —— 只为验证「看得见的东西点得动」。
 *
 * 为什么不能只用 `Runtime.evaluate` + `element.click()`：那是**脚本调用**，绕过命中测试。
 * 2026-09-19 那个「界面正常但鼠标完全点不动」的事故里，DOM 层是**全绿**的 ——
 * `elementFromPoint` 命中的就是按钮、`.click()` 一点就通 —— 真凶是另一个空白窗口盖在上面。
 * 所以这里的 `click` 一律走 `Input.dispatchMouseEvent`（按下 + 抬起，带坐标），
 * 让它经过渲染器的真实输入管线，而不是直接调 DOM 方法。
 *
 * 用法（`--target` 按 target URL 子串匹配；缺省匹配 `dsh-app://app/` 主窗口）：
 *
 *   node scripts/cdp-act.mjs list  [--port 9333]
 *   node scripts/cdp-act.mjs text  --target shell        [--port 9333]
 *   node scripts/cdp-act.mjs click --target shell --text 继续   [--port 9333]
 *   node scripts/cdp-act.mjs type  --text "帮我看下当前页面"  [--into <CSS 选择器>] [--submit]  [--port 9333]
 *   node scripts/cdp-act.mjs eval  --target shell --js "location.href"  [--port 9333]
 *   node scripts/cdp-act.mjs shot  --target app --out docs/x.png        [--port 9333]
 *   node scripts/cdp-act.mjs shot  --target app --out docs/x.png --clip "300,120,780,40,3"
 *                                      # 只截 x,y,w,h 那一块并放大 scale 倍（默认 2）—— 核对小字号文案用
 *
 * `click` 先问元素在哪（`getBoundingClientRect` 中心），再在那个坐标发鼠标事件；
 * 元素不存在、不可见、或坐标落在视口外都会**报错退出**，而不是静默成功 ——
 * 「点了个不存在的东西然后说通过了」是这类脚本最容易犯的错。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const command = args[0]
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const PORT = Number(readArg('port') ?? 9333)
const TARGET = readArg('target') ?? 'dsh-app://app/'

/** 一条 CDP 连接上发一次请求。 */
function send(socket, method, params) {
  return new Promise((resolvePromise, reject) => {
    const id = Math.floor(Math.random() * 1e6)
    const timer = setTimeout(() => reject(new Error(`cdp-act: ${method} 超时`)), 20_000)
    const listener = (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      if (message.error !== undefined) reject(new Error(`CDP 错误：${JSON.stringify(message.error)}`))
      else resolvePromise(message.result)
    }
    socket.addEventListener('message', listener)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function targets() {
  const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)
  return await response.json()
}

function pick(list, wanted) {
  const matched = list.filter(item => item.type === 'page' && typeof item.url === 'string' && item.url.includes(wanted))
  if (matched.length === 0) {
    const seen = list.map(item => `    ${item.type}  ${item.url}`).join('\n')
    throw new Error(`cdp-act: 端口 ${String(PORT)} 上没有 URL 含 ${JSON.stringify(wanted)} 的页面。现有：\n${seen}`)
  }
  if (matched.length > 1) {
    throw new Error(`cdp-act: ${JSON.stringify(wanted)} 匹配到 ${String(matched.length)} 个页面，请给更具体的 --target`)
  }
  return matched[0]
}

async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', () => reject(new Error('cdp-act: CDP 连接失败')), { once: true })
  })
  return socket
}

const evaluate = async (socket, expression) => {
  const result = await send(socket, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`cdp-act: 页面里抛异常 —— ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails)}`)
  }
  return result?.result?.value
}

/**
 * 在目标元素的**中心坐标**发真实鼠标事件（`mouseMoved` + `mousePressed` + `mouseReleased`）。
 *
 * 走渲染器的真实输入管线，而不是直接调 DOM 方法 —— 「元素被别的东西盖住」这类问题只有真实
 * 事件才看得见。元素不存在 / 不可见 / 中心落在视口外一律**报错退出**，不静默成功。
 *
 * `click` 与 `type` 共用它：`type` 也要先真实点一下输入框（见那里的注释）。
 *
 * @param socket - 已连上的 target 会话。
 * @param probe - `{ mode: 'text', value }` 按按钮文案找（先精确、再包含），`{ mode: 'selector', value }` 按 CSS 选择器找。
 */
const clickLocated = async (socket, probe) => {
  const located = await evaluate(socket, `(() => {
    const probe = ${JSON.stringify(probe)};
    let el;
    if (probe.mode === 'selector') el = document.querySelector(probe.value);
    else el = [...document.querySelectorAll('button, [role="button"], a')]
      .find(c => c.textContent.trim() === probe.value)
      ?? [...document.querySelectorAll('button, [role="button"], a')]
        .find(c => c.textContent.trim().includes(probe.value));
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { found: true, tag: el.tagName, label: el.textContent.trim(), disabled: el.disabled === true,
      visible: style.visibility !== 'hidden' && style.display !== 'none' && r.width > 0 && r.height > 0,
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      viewport: [innerWidth, innerHeight] };
  })()`)
  if (located.found !== true) throw new Error(`cdp-act: 没找到要点的元素（${JSON.stringify(probe)}）`)
  console.log(`命中   <${String(located.tag)}> ${JSON.stringify(located.label)}  中心 (${String(located.x)}, ${String(located.y)})  视口 ${String(located.viewport[0])}×${String(located.viewport[1])}`)
  if (located.disabled === true) throw new Error('cdp-act: 元素是 disabled，点了也不会响应')
  if (located.visible !== true) throw new Error('cdp-act: 元素不可见（display/visibility 或尺寸为 0）')
  if (located.inViewport !== true) throw new Error('cdp-act: 元素中心不在视口内，真实鼠标点不到')
  // 真实输入：先移动再按下、抬起（部分组件只在拖动/悬停后有响应）。
  const point = { x: located.x, y: located.y, button: 'left', clickCount: 1, buttons: 1 }
  await send(socket, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 })
  await send(socket, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point })
  await send(socket, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, buttons: 0 })
}

/** `type` 的默认输入目标：聊天输入框是一个 `contenteditable`，备用 `textarea`。 */
const DEFAULT_TYPE_INTO = '[contenteditable="true"], textarea'

async function main() {
  const list = await targets()

  if (command === 'list' || command === undefined) {
    console.log(`共 ${String(list.length)} 个 target（http://127.0.0.1:${String(PORT)}/json/list）`)
    for (const item of list) console.log(`  ${item.type.padEnd(8)} ${(item.title || '(无标题)')}  ←  ${item.url}`)
    if (command === undefined) process.exitCode = 1
    return
  }

  const page = pick(list, TARGET)
  const socket = await connect(page)
  try {
    if (command === 'eval') {
      const js = readArg('js')
      if (js === undefined) throw new Error('cdp-act: eval 需要 --js <表达式>')
      const value = await evaluate(socket, js)
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
      return
    }

    if (command === 'text') {
      const value = await evaluate(socket, '({ title: document.title, text: document.body.innerText, html: document.documentElement.outerHTML.length, buttons: [...document.querySelectorAll("button")].map(b => b.textContent.trim()) })')
      console.log(`URL    ${page.url}`)
      console.log(`标题   ${value.title}`)
      console.log(`HTML   ${String(value.html)} 字节`)
      console.log(`按钮   ${value.buttons.length === 0 ? '(无)' : value.buttons.map(b => JSON.stringify(b)).join(' ')}`)
      console.log('--- 正文 ---')
      console.log(value.text)
      return
    }

    if (command === 'shot') {
      const out = resolve(readArg('out') ?? 'docs/_cdp-shot.png')
      // `--clip "x,y,w,h[,scale]"`：只截一块并放大（`scale` 默认 2）。整图截图在小字号文案上
      // 常常糊到读不出字，裁到那一行再放大才看得清 —— 核对 UI 文案时很需要。
      const clipArg = readArg('clip')
      const clip = clipArg === undefined ? undefined : (() => {
        const [x, y, width, height, scale] = clipArg.split(',').map(Number)
        if ([x, y, width, height].some(value => !Number.isFinite(value))) {
          throw new Error('cdp-act: --clip 需要 "x,y,w,h[,scale]"，例如 --clip "300,120,780,40,3"')
        }
        return { x, y, width, height, scale: Number.isFinite(scale) ? scale : 2 }
      })()
      const { data } = await send(socket, 'Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false, ...clip === undefined ? {} : { clip },
      })
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, Buffer.from(data, 'base64'))
      console.log(`cdp-act: 已写出 ${out}`)
      return
    }

    if (command === 'click') {
      const text = readArg('text')
      const selector = readArg('selector')
      if (text === undefined && selector === undefined) throw new Error('cdp-act: click 需要 --text <按钮文案> 或 --selector <CSS 选择器>')
      await clickLocated(socket, text === undefined
        ? { mode: 'selector', value: selector }
        : { mode: 'text', value: text })
      console.log('cdp-act: 已发出真实鼠标事件（mousePressed + mouseReleased）')
      return
    }

    if (command === 'type') {
      const text = readArg('text')
      if (text === undefined) throw new Error('cdp-act: type 需要 --text <要输入的文字>')
      // 先**真实点一下**输入框再 insertText：insertText 只认「当前聚焦的元素」，而聊天输入框
      // 这类富文本要先拿到焦点才挂上编辑态。
      await clickLocated(socket, { mode: 'selector', value: readArg('into') ?? DEFAULT_TYPE_INTO })
      await send(socket, 'Input.insertText', { text })
      console.log(`cdp-act: 已输入 ${String(text.length)} 个字符`)
      if (args.includes('--submit')) {
        // Enter 拆 keyDown / keyUp 两次发；`text` 只在 keyDown 上给（真实按键的 char 部分）。
        const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
        await send(socket, 'Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r' })
        await send(socket, 'Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
        console.log('cdp-act: 已发 Enter 提交')
      }
      return
    }

    throw new Error(`cdp-act: 未知子命令 ${JSON.stringify(command)}（list|text|click|type|eval|shot）`)
  } finally {
    socket.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
