/**
 * Electron 窗口宿主：开**一个真正的窗口**，里面承载多个标签页。
 *
 * ## 为什么要有这么一个子进程
 *
 * dsh 桌面端的 host 平面跑在**纯 Node** 子进程里（`node.exe .../dsh-desktop-host/lib/index.js`），
 * 它拿不到 Electron 的 `BrowserWindow`，所以插件无法在 host 进程里直接开窗口。
 * 这个文件由插件在需要时 `spawn` 成 **Electron 应用**，窗口由它创建，
 * 每个标签页的 `webContents.debugger`（就是 CDP）让插件继续用同一套 CDP 命令驱动页面 ——
 * `Page.navigate` / `Runtime.evaluate` / `Accessibility.getFullAXTree` / `Page.captureScreenshot`
 * 一个都不用改。
 *
 * ## 窗口结构：`BaseWindow` + 两个 `WebContentsView`
 *
 * ```
 * ┌─ BaseWindow（壳）──────────────────────────────┐
 * │ WebContentsView #1：tabbar.html（顶部 76px 标签条）│
 * │  ├ 标签行 40px（+ 号、标签、hint）                 │
 * │  └ 地址栏行 36px（←/→/⟳ + URL 输入框）            │
 * │ WebContentsView #2：当前标签（z 序在标签条之下）    │
 * │  └ 页面内容，attach 了 debugger                  │
 * └─────────────────────────────────────────────────┘
 * ```
 *
 * Electron 没有原生标签页，所以标签条自己画。**为什么用 `BaseWindow` 而不是
 * `BrowserWindow`**：`BrowserWindow` 自带的主 `webContents` 是一块全窗口的合成层，
 * 实测（Electron 44 / Windows）它会盖住 `contentView.addChildView` 加进来的子视图 ——
 * 表现是「标签条画出来了、页面内容永远灰屏」。`BaseWindow` 没有主 webContents，
 * 标签条和页面内容都是显式定界的 `WebContentsView`，层级只由插入顺序决定：
 * 标签条永远最后插入（最顶层）。点击通过 preload 的 IPC 回到主进程。
 * 标签内容用 `WebContentsView` —— 它是被 embed 的 `webContents`，
 * 因此和单窗口时代一样能 attach debugger。
 *
 * ## 主进程 ↔ tabbar 页的 IPC 约定
 *
 * - 主进程 `webContents.send('dsh-tabs', tabs)` → tabbar 页重画标签行；
 *   tabbar 页 `window.dshTabBar.{select,close,create}` → `ipcMain.on('dsh-tab-*')`。
 * - 主进程 `webContents.send('dsh-nav-state', state)` → tabbar 页同步地址栏
 *   （`{ url, canGoBack, canForward }`）；tabbar 页 `window.dshTabBar.nav(action, url?)`
 *   → `ipcMain.on('dsh-nav')`，`action ∈ 'back' | 'forward' | 'reload' | 'navigate'`。
 *
 * ## 通道：TCP，不是 stdio
 *
 * 踩过的坑：Electron（Windows）主进程的 `process.stdin` **会立刻 EOF**，
 * 一旦 `on('end')` 里收尾就把 app 关了，表现是「窗口刚建好就自己没了」。
 * stdout 是通的，所以反向来：子进程监听 `127.0.0.1:0`，把端口号从 stdout 宣布出来。
 *
 * ## 另三个必须踩准的时机（都表现为「命令发出去永远不回」或窗口自己消失）
 *
 * - 窗口 `new` 出来就 `debugger.attach()` → 命令挂住。要等 `dom-ready`。
 * - 建页面后不显式 `loadURL()` → 不发起导航，`dom-ready` 永远不来。哪怕加载 `about:blank`。
 * - 父进程一断连就 `app.quit()` → 演示时窗口根本留不下来。见 `keepAlive`。
 *
 * ## 协议（一条 TCP 连接，JSON Lines）
 *
 * 父 → 子：
 * - `{ op: 'open', id, url, size?, keepAlive? }`
 * - `{ op: 'cdp', id, tabId, method, params }`
 * - `{ op: 'activate', id, tabId }`
 * - `{ op: 'devtools', id }`（切换活动标签的开发者工具；等状态落定才回）
 * - `{ op: 'close', id, tabId }`
 * - `{ op: 'list', id }`
 * - `{ op: 'bar', id }`
 * - `{ op: 'dispose', id }`
 *
 * 子 → 父：
 * - `{ type: 'listening', port }`
 * - `{ type: 'opened', id, tabId, url, title }`
 * - `{ type: 'cdp', id, result | error }`
 * - `{ type: 'devtools', id, tabId, action, isOpen }`（`isOpen` 是**真实**状态，用来把
 *   `openDevTools` 的静默失败暴露给调用方）
 * - `{ type: 'closed', id?, tabId }`（无 `id` 表示用户自己关的）
 * - `{ type: 'list', id, tabs }`
 * - `{ type: 'bar', id, tabs, rendered, active }`（`rendered` 是标签条 DOM 里的 `.tab` 数，`-1` = 没画出来）
 * - `{ type: 'event', tabId, method, params }`（其中 `Inspector.detached` 是**宿主合成**的让位
 *   信号，`reason` 为 `'devtools-opened'`，与 Electron 原生恒为 `'target closed'` 的 reason 区分；
 *   父进程不得据此推进会话失效）
 * - `{ type: 'takeover', tabId, active }`（人工**或** agent 开合 DevTools；`active` 是**幂等状态位**，
 *   不是计数器 —— agent 自己 toggle 也会收到，父进程无需去重。见方案 4.1.1）
 * - `{ type: 'error', id?, message }`
 *
 * @module dsh-webops-plugin/browser-electron/host
 */

const { app, BaseWindow, WebContentsView, ipcMain, Menu } = require('electron')
const net = require('node:net')
const path = require('node:path')

/** 标签行高度（像素）。 */
const TAB_STRIP_HEIGHT = 40
/** 地址栏行高度（像素）。 */
const ADDRESS_BAR_HEIGHT = 36
/** 顶部两行（标签行 + 地址栏）合计高度；标签内容区从这条线开始。 */
const TAB_BAR_HEIGHT = TAB_STRIP_HEIGHT + ADDRESS_BAR_HEIGHT
/** 等 `devtools-opened` / `devtools-closed` 落定的上限；超时一律按「没开成」处理。 */
const DEVTOOLS_SETTLE_TIMEOUT_MS = 3000
/**
 * 单条 CDP 命令的等待上限（与父进程 bridge 的默认 `commandTimeoutMs` 对齐）。
 * 超时照样回错误，别让宿主里的 await 永远悬着（`[V33]` 的挂死形态：`Page.captureScreenshot`
 * 在异常路径可能永久不返回；父进程超时后 pending 已删，宿主侧必须自己有终点）。
 */
const CDP_COMMAND_TIMEOUT_MS = 30000

/** 标签页；`debugger` 在 `dom-ready` 之后才有。 */
const tabs = new Map()
let shell
/** 标签条视图：独立 `WebContentsView`，永远保持最顶层。 */
let tabBar
let activeTabId
let sequence = 0
let connection

/** 父进程断连后是否继续活着（演示用：让窗口留在屏幕上）。 */
let keepAlive = process.env['DSH_BROWSER_WINDOW_KEEP_ALIVE'] === '1'

/** 往父进程写一条消息（连接已断时静默丢弃）。 */
function send(message) {
  if (connection === undefined || connection.destroyed) return
  connection.write(`${JSON.stringify(message)}\n`)
}

/** 往标签条页面推当前标签列表；顺带把地址栏状态一并推过去。 */
function sendTabBar() {
  sendNavState()
  if (tabBar === undefined || tabBar.webContents.isDestroyed()) return
  tabBar.webContents.send('dsh-tabs', [...tabs.values()].map(tab => ({
    id: tab.id,
    title: tab.view.webContents.getTitle(),
    url: tab.view.webContents.getURL(),
    active: tab.id === activeTabId,
  })))
}

/**
 * 往标签条页面推地址栏状态（只看活动标签）。
 *
 * 没有活动标签时推一份空快照，让输入框清空、前进/后退按钮置灰。
 */
function sendNavState() {
  if (tabBar === undefined || tabBar.webContents.isDestroyed()) return
  const entry = activeTabId !== undefined ? tabs.get(activeTabId) : undefined
  if (entry === undefined) {
    tabBar.webContents.send('dsh-nav-state', { url: '', canGoBack: false, canForward: false })
    return
  }
  const wc = entry.view.webContents
  tabBar.webContents.send('dsh-nav-state', {
    url: wc.getURL(),
    canGoBack: wc.canGoBack(),
    canForward: wc.canGoForward(),
  })
}

/**
 * 地址栏输入的最小规范化：`trim()` 后若不含 `://` 就补 `https://` 前缀。
 * 空串原样返回（调用方按「忽略」处理）。
 */
function normalizeAddress(input) {
  const trimmed = String(input ?? '').trim()
  if (trimmed === '' || trimmed.includes('://')) return trimmed
  return `https://${trimmed}`
}

/**
 * 处理地址栏的导航指令；没有活动标签时忽略。
 *
 * 导航是异步的：committed 后 `did-navigate` 会再推一次状态，这里在动作之后
 * `setTimeout(0)` 补一次 —— 让输入框 / 按钮先动起来，两道保险。
 */
function handleNav(action, url) {
  const entry = activeTabId !== undefined ? tabs.get(activeTabId) : undefined
  if (entry === undefined) return
  const wc = entry.view.webContents
  if (action === 'back') wc.goBack()
  else if (action === 'forward') wc.goForward()
  else if (action === 'reload') wc.reload()
  else if (action === 'navigate') {
    const target = normalizeAddress(url)
    if (target === '') return
    void wc.loadURL(target)
  } else return
  setTimeout(() => {
    if (!tabs.has(entry.id)) return
    sendTabBar()
  }, 0)
}

/**
 * 重算所有视图的位置：标签行 + 地址栏占顶部 76px，内容区从这条线开始，只有活动标签可见。
 *
 * 用 `setVisible` 而不是把非活动标签从视图树上摘下来 —— 摘下来的 `webContents`
 * 尺寸会变成 0，之后再对它 `Page.captureScreenshot` 会拿到空白或报错。
 *
 * 标签条每次都重新插入到末尾（最顶层）：`addChildView` 是「追加到顶」语义，
 * 新开的标签视图会盖住它，不重排的话标签条就被页面盖住了。
 */
function layout() {
  if (shell === undefined || shell.isDestroyed()) return
  const bounds = shell.getContentBounds()
  const contentHeight = Math.max(0, bounds.height - TAB_BAR_HEIGHT)
  tabBar.setBounds({ x: 0, y: 0, width: bounds.width, height: TAB_BAR_HEIGHT })
  const container = shell.contentView
  container.removeChildView(tabBar)
  container.addChildView(tabBar)
  for (const tab of tabs.values()) {
    tab.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: bounds.width, height: contentHeight })
    if (typeof tab.view.setVisible === 'function') tab.view.setVisible(tab.id === activeTabId)
  }
}

/**
 * 建壳窗口（只建一次）。
 * @param size - 首次开窗的尺寸。
 * @returns 壳窗口。
 */
function ensureShell(size) {
  if (shell !== undefined && !shell.isDestroyed()) {
    shell.focus()
    return shell
  }
  shell = new BaseWindow({
    width: size?.width ?? 1200,
    height: size?.height ?? 860,
    show: true,
    title: 'dsh browser',
    backgroundColor: '#f2f3f5',
  })
  tabBar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'tabbar-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  shell.contentView.addChildView(tabBar)
  layout()
  void tabBar.webContents.loadFile(path.join(__dirname, 'tabbar.html'))
  shell.on('resize', layout)
  shell.on('closed', () => {
    shell = undefined
    // 壳没了，标签页跟着全没；把剩下的一并通报给父进程。
    for (const id of [...tabs.keys()]) {
      tabs.delete(id)
      send({ type: 'closed', tabId: id })
    }
  })
  return shell
}

/**
 * 开一个标签页。
 * @param url - 初始地址；空值按 `about:blank` 处理。
 * @param size - 首次开窗的尺寸。
 * @returns 描述这个标签的记录。
 */
function openTab(url, size) {
  const window = ensureShell(size)
  const id = `t${++sequence}`
  const view = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.contentView.addChildView(view)

  const entry = {
    id,
    view,
    debugger: view.webContents.debugger,
    ready: undefined,
    debuggerAttached: false,
    // 「这次 detach 是我们自己为了开 DevTools 让位」—— 见下面的监听器与 `toggleDevTools`。
    // 用状态位区分，不靠 reason（Electron 给的 reason 恒为 `target closed`）。
    lettingGo: false,
  }
  // 调试器的监听只注册一次（对象与 view 同生命周期），attach/detach 可反复。
  entry.debugger.on('message', (_event, method, params) => {
    send({ type: 'event', tabId: id, method, params })
  })
  entry.debugger.on('detach', (_event, reason) => {
    entry.debuggerAttached = false
    // 人为让位时由 `toggleDevTools` 补发一条 reason 更准的事件 —— 两条都发只会互相矛盾。
    if (entry.lettingGo) {
      entry.lettingGo = false
      return
    }
    send({ type: 'event', tabId: id, method: 'Inspector.detached', params: { reason } })
  })
  // 页面发起的弹窗（window.open / target=_blank）：Electron 默认放行成原生新窗口，
  // 这里拦下并转成我们标签系统里的**新标签页**——与真浏览器行为一致。
  // 只放行 http(s)；about:blank 与自定义 scheme 一律拒绝（防 javascript: 注入）。
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url ?? '')) return { action: 'deny' }
    try {
      openTab(url)
    } catch {
      // 开不出来就只拒绝：页面侧表现为 window.open 返回 null，与弹窗拦截一致。
    }
    return { action: 'deny' }
  })
  entry.ready = new Promise((resolveReady) => {
    view.webContents.once('dom-ready', () => {
      attachDebugger(entry)
      resolveReady()
    })
    view.webContents.once('render-process-gone', (_event, details) => {
      send({ type: 'error', tabId: id, message: `renderer gone: ${JSON.stringify(details)}` })
    })
  })
  // 兜底：正常情况下 `toggleDevTools` 在 `devtools-opened` 时就把调试器接回来了，
  // 这一条只保证「关掉 DevTools 之后一定还连着」（`attachDebugger` 是幂等的）。
  view.webContents.on('devtools-closed', () => { attachDebugger(entry) })

  // 「观察失效」的通知通道（方案 4.1.1）。这两个事件对「agent 触发」与「人工走菜单 / 快捷键 触发」
  // 一视同仁 —— 正是 `toggleDevTools()` 返回值覆盖不到的缺口。必须是**持久**的 `on`（不是 `once`）：
  // 每次开 / 关都要报，`active` 是幂等状态位而非计数器。
  // 与 `waitForDevTools` 里那两个 `once` 并存不冲突 —— `once` 只消费它自己那一次。
  view.webContents.on('devtools-opened', () => { send({ type: 'takeover', tabId: id, active: true }) })
  view.webContents.on('devtools-closed', () => { send({ type: 'takeover', tabId: id, active: false }) })

  // 标题与地址随时会变，标签条要跟着变。
  view.webContents.on('page-title-updated', () => { sendTabBar() })
  view.webContents.on('did-navigate', () => { sendTabBar() })
  view.webContents.on('did-navigate-in-page', () => { sendTabBar() })
  view.webContents.on('did-finish-load', () => { sendTabBar() })

  tabs.set(id, entry)
  activeTabId = id
  layout()
  sendTabBar()

  // 必须显式加载：不加载就没有导航，`dom-ready` 不会来，`entry.ready` 永远挂起。
  void view.webContents.loadURL(url === undefined || url === '' ? 'about:blank' : url)
  return entry
}

/**
 * 切到某个标签页。
 * @param id - 标签 id。
 */
function activateTab(id) {
  if (!tabs.has(id)) return
  activeTabId = id
  layout()
  sendTabBar()
}

/**
 * 关掉一个标签页。
 * @param id - 标签 id。
 */
function closeTab(id) {
  const entry = tabs.get(id)
  if (entry === undefined) return
  tabs.delete(id)
  if (activeTabId === id) {
    const next = [...tabs.keys()].at(-1)
    activeTabId = next
  }
  try {
    if (shell !== undefined && !shell.isDestroyed()) shell.contentView.removeChildView(entry.view)
  } catch {
    // 壳可能已经在关的过程中。
  }
  // `close()` 走的是「页面请求关闭」的路径，比直接 destroy 温和；关不掉再强杀。
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
  layout()
  sendTabBar()
  send({ type: 'closed', tabId: id })
}

/**
 * 给标签接上 CDP 调试器（幂等）。
 *
 * 消息/分离监听在 `openTab` 里注册一次 —— `debugger` 对象与 view 同生命周期，
 * detach 后再 attach 不需要重复注册。
 *
 * 与 DevTools 的关系**不是互斥**：只在「打开 DevTools 那一瞬」让位，随后立刻接回，
 * 详见 `toggleDevTools`。
 *
 * ⚠ **re-attach 不保证之前 enable 过的 domain 还在**（实测：每次 attach 后要重新
 * `Runtime.enable` 才能收到 console 事件）。当前工具面不依赖任何 enable 过的 domain，
 * 所以这里没做额外的事；P2 的 console / network 采集器一旦接上，**必须在这里补一次
 * re-enable**，否则人工开关一次 DevTools 就会漏消息。
 */
function attachDebugger(entry) {
  if (entry.debuggerAttached) return
  try {
    entry.debugger.attach('1.3')
    entry.debuggerAttached = true
  } catch (error) {
    send({ type: 'error', tabId: entry.id, message: `debugger.attach failed: ${String(error?.message ?? error)}` })
  }
}

/**
 * 等一次 DevTools 状态事件。
 *
 * 必须带超时：`openDevTools` 静默失败时不抛错、事件也不来，没有超时就会永远挂住
 * （`[V3]` 那个坑在调用方一侧的形态）。
 *
 * @param wc - 目标标签的 webContents。
 * @param event - `devtools-opened` 或 `devtools-closed`。
 */
function waitForDevTools(wc, event) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, DEVTOOLS_SETTLE_TIMEOUT_MS)
    wc.once(event, () => { clearTimeout(timer); resolve() })
  })
}

/**
 * 切换活动标签的开发者工具，等状态落定才返回。
 *
 * 实测（Electron 44）拿到两条硬结论：
 *
 * 1. **打开前必须先 detach**：插件调试器还 attach 着时调 `openDevTools` 会**静默失败**
 *    —— 不抛错，但 `isDevToolsOpened()` 保持 false。所以让位这一步不可省，而且**只能靠
 *    校验 `isDevToolsOpened()` 判成败**，`try/catch` 什么也抓不到。
 * 2. **打开后可以立刻接回**：DevTools 打开之后，这个 target 就不再排斥第二个调试
 *    客户端了，`devtools-opened` 一落定就 `attach` 即成功（连延迟都不需要）；此后人工
 *    在 DevTools 里操作期间，agent 的 snapshot / 截图 / evaluate 全部照常返回。
 *
 * 所以「让位」只发生在打开那一瞬，不是整个查看期。这推翻了本文件早先版本
 * （`6a0dc8b`）的写法 —— 那里要等到 `devtools-closed` 才接回，等于人工看 DevTools
 * 的全程 agent 都是瞎的。
 *
 * @returns `{ entry, action, isOpen }`；没有活动标签时 `undefined`。
 *   `isOpen` 是宿主的**真实**状态 —— `action: 'opened'` 却带 `isOpen: false` 就是
 *   「让位没成功」，调用方据此报警，而不是当成成功。
 */
async function toggleDevTools() {
  const entry = activeTabId !== undefined ? tabs.get(activeTabId) : undefined
  if (entry === undefined) return undefined
  const wc = entry.view.webContents

  if (wc.isDevToolsOpened()) {
    const settled = waitForDevTools(wc, 'devtools-closed')
    wc.closeDevTools()
    await settled
    return { entry, action: 'closed', isOpen: wc.isDevToolsOpened() }
  }

  // 让位。失败必须报出来 —— 吞掉它就等于让随后的 `openDevTools` 静默失败且无从查起。
  if (entry.debuggerAttached) {
    try {
      entry.lettingGo = true
      entry.debugger.detach()
      entry.debuggerAttached = false
      // reason 实测恒为 `target closed`（主动 detach 也是），区分不出「人为让位」，
      // 所以由这边补一条语义明确的事件；`openTab` 里的监听器会因为 `lettingGo` 让路。
      send({ type: 'event', tabId: entry.id, method: 'Inspector.detached', params: { reason: 'devtools-opened' } })
    } catch (error) {
      entry.lettingGo = false
      send({ type: 'error', tabId: entry.id, message: `debugger.detach failed: ${String(error?.message ?? error)}` })
    }
  }

  // 先把等待挂上再触发动作，否则事件可能在我们开始等之前就过去了。
  const settled = waitForDevTools(wc, 'devtools-opened')
  wc.openDevTools({ mode: 'undocked' })
  await settled

  if (wc.isDestroyed() || !wc.isDevToolsOpened()) {
    // 静默失败：不抛错、也没打开。窗口已经关了的话就不用再报。
    if (!wc.isDestroyed()) {
      send({
        type: 'error',
        tabId: entry.id,
        message: 'openDevTools did not open (the CDP debugger was probably still attached)',
      })
    }
    return { entry, action: 'opened', isOpen: false }
  }

  // 接回来：DevTools 打开之后 target 不再排斥第二个 client。
  attachDebugger(entry)
  return { entry, action: 'opened', isOpen: true }
}

/** 处理一条来自父进程的命令。 */
async function handle(command) {
  switch (command.op) {
    case 'open': {
      if (command.keepAlive === true) keepAlive = true
      const entry = openTab(command.url, command.size)
      await entry.ready
      send({
        type: 'opened',
        id: command.id,
        tabId: entry.id,
        url: entry.view.webContents.getURL(),
        title: entry.view.webContents.getTitle(),
      })
      return
    }
    case 'cdp': {
      const entry = tabs.get(command.tabId)
      if (entry === undefined) {
        send({ type: 'cdp', id: command.id, error: { message: `unknown tab ${String(command.tabId)}` } })
        return
      }
      try {
        await entry.ready
        // 给命令包一层超时：超时与真正的命令失败走同一个 catch，复用 cdp 错误消息。
        // timer 必须在 promise settle 后 clearTimeout，别留悬挂的 setTimeout；
        // 否则 [V33]（命令永久挂起）会让宿主里的 await 永远悬着，父进程侧 pending 已删也没用。
        let timer
        const timeout = new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`cdp command timed out after ${CDP_COMMAND_TIMEOUT_MS}ms: ${command.method}`))
          }, CDP_COMMAND_TIMEOUT_MS)
        })
        let result
        try {
          result = await Promise.race([entry.debugger.sendCommand(command.method, command.params ?? {}), timeout])
        } finally {
          clearTimeout(timer)
        }
        send({ type: 'cdp', id: command.id, result: result === undefined ? {} : result })
      } catch (error) {
        send({ type: 'cdp', id: command.id, error: { message: String(error?.message ?? error) } })
      }
      return
    }
    case 'activate': {
      activateTab(command.tabId)
      send({ type: 'activated', id: command.id, tabId: command.tabId })
      return
    }
    case 'devtools': {
      // 切换活动标签的开发者工具。
      //
      // 存在意义有二：让端到端脚本能验证「DevTools 打开后 agent 仍可用」，以及 P3 的
      // 人工接管需要这条通道 —— 菜单里那条只能靠模拟按键触发，验证不了。
      //
      // `toggleDevTools` 落定才回，并把**真实**的 `isOpen` 一起带回：`openDevTools` 会
      // 静默失败（不抛错、`isDevToolsOpened()` 保持 false），回一个说谎的 ack 就是把这个
      // 坑盖住。
      const result = await toggleDevTools()
      if (result === undefined) {
        send({ type: 'devtools', id: command.id, error: { message: 'no active tab to toggle devtools on' } })
        return
      }
      send({
        type: 'devtools',
        id: command.id,
        tabId: result.entry.id,
        action: result.action,
        isOpen: result.isOpen,
      })
      return
    }
    case 'close': {
      closeTab(command.tabId)
      send({ type: 'closed', id: command.id, tabId: command.tabId })
      return
    }
    case 'list': {
      send({
        type: 'list',
        id: command.id,
        tabs: [...tabs.values()].map(entry => ({
          id: entry.id,
          url: entry.view.webContents.getURL(),
          title: entry.view.webContents.getTitle(),
          active: entry.id === activeTabId,
        })),
      })
      return
    }
    case 'bar': {
      // 「标签条到底画出来没有」必须可断言：它是这个宿主唯一一块自己写的 UI，
      // 而宿主没有 stdout 之外的人能看见它。数一下 DOM 里的 `.tab` 节点即可。
      const rendered = tabBar === undefined || !tabBar.webContents || tabBar.webContents.isDestroyed()
        ? -1
        : await tabBar.webContents.executeJavaScript('document.querySelectorAll(".tab").length').catch(() => -1)
      send({
        type: 'bar',
        id: command.id,
        tabs: tabs.size,
        rendered: typeof rendered === 'number' ? rendered : -1,
        active: activeTabId,
      })
      return
    }
    case 'dispose': {
      send({ type: 'disposed', id: command.id })
      for (const id of [...tabs.keys()]) closeTab(id)
      if (shell !== undefined && !shell.isDestroyed()) shell.destroy()
      // 先让响应出网卡再退；立刻 quit 会把还没 flush 的字节一起带走。
      if (connection !== undefined) connection.end()
      setTimeout(() => { app.quit() }, 100)
      return
    }
    default:
      send({ type: 'error', id: command.id, message: `unknown op ${String(command.op)}` })
  }
}

app.on('window-all-closed', () => {
  // keepAlive 时窗口就是全部意义所在：用户关了窗口才算完。
  // 否则父进程还在的话也不自行退出，它可能马上又要开一个窗口。
  if (connection === undefined || keepAlive) app.quit()
})

app.whenReady().then(() => {
  ipcMain.on('dsh-tab-select', (_event, id) => { activateTab(id) })
  ipcMain.on('dsh-tab-close', (_event, id) => { closeTab(id) })
  ipcMain.on('dsh-tab-create', () => { void openTab('about:blank') })
  ipcMain.on('dsh-nav', (_event, payload) => {
    const { action, url } = payload ?? {}
    handleNav(action, url)
  })

  // BaseWindow 没有 webContents，默认菜单的「切换开发者工具」打在空处。
  // 这里显式接管：指向活动标签的 webContents。与插件 CDP 调试器**不是互斥** ——
  // 只在打开那一瞬让位，见 `toggleDevTools`。
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'forceReload' },
        { label: '切换开发者工具', accelerator: 'Ctrl+Shift+I', click: () => { void toggleDevTools() } },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ]))

  const server = net.createServer((socket) => {
    connection = socket
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() === '') continue
        let command
        try {
          command = JSON.parse(line)
        } catch {
          send({ type: 'error', message: 'malformed command line' })
          continue
        }
        void handle(command)
      }
    })
    socket.on('error', () => { connection = undefined })
    socket.on('close', () => {
      connection = undefined
      // 父进程走了。keepAlive 时把窗口留给用户，否则这个宿主没有存在意义了。
      if (!keepAlive) app.quit()
    })
  })

  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    // 端口只能从 stdout 出去 —— 这条路是通的，stdin 不是。
    process.stdout.write(`${JSON.stringify({ type: 'listening', port: address.port })}\n`)
  })
})

// 供单测使用：地址规范化与导航处理不依赖 Electron 运行时，导出后单测可以直接钉住
// 「规范化补 https://」与「无活动标签时忽略」；作为 Electron 入口运行时无副作用。
module.exports = { normalizeAddress, handleNav }
