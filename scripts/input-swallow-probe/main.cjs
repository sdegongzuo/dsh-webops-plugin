/**
 * §6.5 落地探针：`host.cjs` 里那段吞输入逻辑的真实行为。
 *
 * 跑法（仓库根，**经启动器** —— 这份东西必须在真 Electron 主进程里跑）：
 *   node scripts/probe-input-swallow.mjs
 *
 * 复刻生产代码（`host.cjs` 的 `openTab` 里那一处，逐字同步）：
 *
 *   view.webContents.on('before-input-event', (event, input) => {
 *     if (holder !== 'agent') return
 *     if (input.control || input.alt || input.meta) return
 *     if (input.type !== 'keyDown' && input.type !== 'char') return
 *     event.preventDefault()
 *   })
 *
 * 落地后的**默认状态就是 holder='agent'**（默认就在吞），所以真正要回答的是：
 *   ★ agent 自己的 CDP 键盘（`webpage_press` 走的就是 `Input.dispatchKeyEvent`）会不会被吞？
 *     会的话，默认状态下 agent 的按键就残了。
 *
 * 而 `webpage_press` 的形态是固定的两种（`provider.ts` 的 `press`）：
 *   - `type:'keyDown'`，可打印字符带 `text`（如 'b'）、命名键不带（如 ArrowDown）
 *   - `type:'keyUp'` 无条件发
 * 所以这里按这三个变体分别测，不能只测一个就下结论。
 *
 * 三条关于「怎么测」的教训（都是本轮踩到的，写下来免得下次重踩）：
 * 1. **前置判据必须是「窗口级」焦点 `win.isFocused()`，不能是 `webContents.isFocused()`。**
 *    后者在窗口没被操作系统激活时**也返回 true** —— 按它放行，整份探针会输出「基线全红 +
 *    agent 被吞」这种看着像结论、其实全是噪声的结果（本轮因此白跑了一轮）。拿不到窗口焦点就
 *    直接报错退出：`sendInputEvent` 只在窗口真的持焦时才会落到页面上，否则连 CDP 键盘一起哑火。
 * 2. **容器用 `BrowserWindow`。** `before-input-event` 是 **WebContents 级**事件、与容器无关，
 *    但 BaseWindow + WebContentsView 那个组合拿不到键盘焦点（实测基线恒 0）。
 *    抢焦点的手段：`win.setAlwaysOnTop(true)` + `app.focus({ steal: true })` + 轮询等 `win.isFocused()`。
 * 3. 固定 `delay` 读计数会 off-by-one（多数「不稳定」其实是读太早）；一律轮询到稳定再判。
 */
const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')

const FIXTURE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>input probe v3</title></head>
<body>
  <h1>输入探针 v3</h1>
  <button id="submit" type="button" style="width:200px;height:60px">提交</button>
  <input id="text" type="text" style="width:200px;height:30px" />
  <script>
    window.__clicks = 0
    window.__keys = []
    window.__ups = []
    window.__mods = []
    window.__text = []
    document.getElementById('submit').addEventListener('click', () => { window.__clicks += 1 })
    document.addEventListener('keydown', e => {
      window.__keys.push(e.key)
      if (e.ctrlKey || e.altKey || e.metaKey) window.__mods.push(e.key)
    })
    document.addEventListener('keyup', e => window.__ups.push(e.key))
    document.addEventListener('input', e => window.__text.push(e.target.value))
  </script>
</body></html>`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} —— ${detail}`)
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function settle(read) {
  let previous = await read()
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(60)
    const current = await read()
    if (current === previous) return current
    previous = current
  }
  return previous
}

let holder = 'agent'
/** `before-input-event` 的调用流水，用来区分「没触发」与「触发了但被吞」。 */
const diag = []

async function main() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(FIXTURE)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`

  const win = new BrowserWindow({
    width: 700,
    height: 520,
    show: true,
    // 后台窗口默认会被 Chromium 节流。这里全程要求它像前台一样处理输入 ——
    // 否则「页面收不到输入」这件事会被误读成「被吞了」。
    webPreferences: { backgroundThrottling: false },
  })
  await win.loadURL(url)

  // **前置自检**：`sendInputEvent` 只在窗口真的持有键盘焦点时才会落到页面上。
  // 拿不到焦点时它会**静默失效** —— 整份探针会输出「基线全红」这种看起来像结论、
  // 其实是噪声的东西（本轮踩了两次）。所以这里必须先确认，确认不了就明确报错退出，
  // 绝不能把「环境没就绪」当成「判据未达标」报出去。
  win.setAlwaysOnTop(true)
  app.focus({ steal: true })
  win.moveTop()
  win.focus()
  win.webContents.focus()
  await win.webContents.executeJavaScript('window.focus(); document.body.focus(); true').catch(() => undefined)
  for (let attempt = 0; attempt < 30 && !win.isFocused(); attempt += 1) {
    app.focus({ steal: true })
    win.focus()
    win.webContents.focus()
    await delay(100)
  }
  console.log(`[环境] window focused=${String(win.isFocused())} visible=${String(win.isVisible())} `
    + `alwaysOnTop=${String(win.isAlwaysOnTop())} / webContents focused=${String(win.webContents.isFocused())}`)
  if (!win.isFocused()) {
    console.error('\n前置失败：窗口拿不到键盘焦点 —— `sendInputEvent` 不会生效，后面所有判据都不可信。')
    console.error('把桌面切到这个窗口（或关掉正在抢前台的程序）再跑一次。')
    app.exit(1)
  }

  let swallowCalls = 0
  win.webContents.on('before-input-event', (event, input) => {
    diag.push({ type: input.type, key: String(input.key), ctrl: input.control === true, holder })
    if (holder !== 'agent') return
    if (input.control || input.alt || input.meta) return
    // 与 host.cjs 同步：只吞 keyDown / char。
    // （`rawKeyDown` 判不出来 —— 它在钩子里就报成 `keyDown`，见末尾的边界记录。）
    if (input.type !== 'keyDown' && input.type !== 'char') return
    swallowCalls += 1
    event.preventDefault()
  })

  const core = win.webContents.debugger
  core.attach('1.3')
  await core.sendCommand('Runtime.enable')
  const evaluate = async expression =>
    (await core.sendCommand('Runtime.evaluate', { expression, returnByValue: true })).result?.value

  const box = await evaluate(`(() => {
    const r = document.getElementById('submit').getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  const clicks = () => evaluate('window.__clicks')
  const keys = () => evaluate('window.__keys.length')
  const ups = () => evaluate('window.__ups.length')
  const mods = () => evaluate('window.__mods.length')
  const texts = () => evaluate('window.__text.length')

  const wc = win.webContents
  const humanKey = (modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers })
  }
  const humanClick = () => {
    wc.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }

  /**
   * 发一个 CDP 键盘变体（keyDown + keyUp，与 `provider.press` 同形），
   * 返回「before-input-event 触发了几次」与「页面收到了几个 keydown」。
   */
  const cdpKey = async (down, up) => {
    const keysBefore = await settle(keys)
    const upsBefore = await settle(ups)
    const diagBefore = diag.length
    await core.sendCommand('Input.dispatchKeyEvent', down)
    await core.sendCommand('Input.dispatchKeyEvent', up)
    const keysAfter = await settle(keys)
    const upsAfter = await settle(ups)
    await delay(150)
    return { pageKeys: keysAfter - keysBefore, pageUps: upsAfter - upsBefore, hookHits: diag.slice(diagBefore) }
  }

  // —— 基线：holder='human'（不吞）时，人工输入应当落地 ——
  holder = 'human'
  const k0 = await settle(keys)
  humanKey()
  const k1 = await settle(keys)
  check('基线① human 期间人工键盘照常落地', k1 === k0 + 1, `__keys ${k0} → ${k1}（应 +1）`)

  const c0 = await settle(clicks)
  humanClick()
  const c1 = await settle(clicks)
  check('基线② human 期间人工鼠标照常落地', c1 === c0 + 1, `__clicks ${c0} → ${c1}（应 +1）`)

  // —— ① holder='agent' 期间人工裸键被吞 ——
  holder = 'agent'
  const before = await settle(keys)
  humanKey()
  const after = await settle(keys)
  check('① agent 期间人工裸键被吞（A 档的核心）', after === before, `__keys=${after}（应仍是 ${before}）`)

  // —— ② 带修饰键的组合放行 ——
  const modsBefore = await settle(mods)
  humanKey(['control'])
  const modsAfter = await settle(mods)
  check('② agent 期间带 Ctrl 的组合放行（人不会被关在页面里）', modsAfter === modsBefore + 1,
    `__mods ${modsBefore} → ${modsAfter}（应 +1）`)

  // —— ③ agent 的 CDP 键盘：三个变体逐个测 ——
  const withText = await cdpKey(
    { type: 'keyDown', text: 'b', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66 },
    { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66 },
  )
  const namedKey = await cdpKey(
    { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
    { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  )
  const rawDown = await cdpKey(
    { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  )

  const describe = (probe) => `hook 触发 ${probe.hookHits.length} 次`
    + `（${probe.hookHits.map(h => h.type).join(',') || '无'}）/ 页面收到 keydown ${probe.pageKeys} 个 / keyup ${probe.pageUps} 个`

  check('③a agent 期间 CDP keyDown(text) 的键盘完整落地（含 keyup，webpage_press 的两条腿）',
    withText.pageKeys >= 1 && withText.pageUps >= 1, describe(withText))
  check('③b agent 期间 CDP keyDown(命名键) 的键盘完整落地',
    namedKey.pageKeys >= 1 && namedKey.pageUps >= 1, describe(namedKey))
  // ③c 不是判据，是**边界记录**：CDP 的 rawKeyDown 在钩子里报的 type 就是 `keyDown`，
  // 与人工按键无法区分，所以会被吞。它当前不可达（`webpage_execute` 明确拒绝 `Input.*`），
  // 因此只打印、不判定；哪天放开白名单，这条就要升级成 FAIL。
  console.log(`（已知边界）③c CDP rawKeyDown：${describe(rawDown)} —— 报成 keyDown 无法区分，`
    + '当前不可达（execute 拒绝 Input.*），放开白名单即成真缺陷')

  console.log('\n—— 三个 CDP 变体的 hook 流水 ——')
  for (const [label, probe] of [['keyDown+text', withText], ['keyDown(命名键)', namedKey], ['rawKeyDown', rawDown]]) {
    console.log(`  ${label}: ${probe.hookHits.map(h => `${h.type}/${h.key}`).join(' , ') || '（一次都没触发）'}`)
  }

  // —— ④ agent 的 CDP insertText 照常落地 ——
  const textBefore = await settle(texts)
  await core.sendCommand('Runtime.evaluate', { expression: "document.getElementById('text').focus()" })
  await core.sendCommand('Input.insertText', { text: 'abc' })
  const textAfter = await settle(texts)
  check('④ agent 期间 CDP insertText 照常落地', textAfter === textBefore + 1,
    `__text ${textBefore} → ${textAfter}（应 +1）`)

  // —— ⑤ 已知边界：鼠标不在 before-input-event 覆盖范围内 ——
  const clickBefore = await settle(clicks)
  humanClick()
  const clickAfter = await settle(clicks)
  check('⑤ 已知边界：agent 期间人工鼠标仍会落地（J4 因此改窄为「唯键盘」）',
    clickAfter === clickBefore + 1, `__clicks ${clickBefore} → ${clickAfter}（+1 = 吞不掉）`)

  console.log(`\n（参考）holder='agent' 期间 preventDefault 共被调用 ${swallowCalls} 次`)

  core.detach()
  win.destroy()
  server.close()

  const failed = results.filter(entry => !entry.ok)
  console.log(`\n合计 ${results.length} 项，未达标 ${failed.length} 项`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(main).catch(error => {
  console.error('探针自己跑崩了：', error)
  app.exit(1)
})
