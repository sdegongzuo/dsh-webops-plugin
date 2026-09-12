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
 * ## 窗口结构：一个壳 + 若干 `WebContentsView`
 *
 * ```
 * ┌─ BrowserWindow（壳）───────────────────────────┐
 * │ 主 webContents：tabbar.html  （顶部 40px 标签条） │
 * │ ┌─ WebContentsView（当前标签）────────────────┐ │
 * │ │ 页面内容，attach 了 debugger                 │ │
 * │ └─────────────────────────────────────────────┘ │
 * └─────────────────────────────────────────────────┘
 * ```
 *
 * Electron 没有原生标签页，所以标签条自己画：壳的主 `webContents` 加载
 * `tabbar.html`，点击通过 preload 的 IPC 回到主进程。标签内容用
 * `WebContentsView`（`BrowserView` 已废弃）—— 它是被 embed 的 `webContents`，
 * 因此和单窗口时代一样能 attach debugger。
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
 * - `{ op: 'close', id, tabId }`
 * - `{ op: 'list', id }`
 * - `{ op: 'bar', id }`
 * - `{ op: 'dispose', id }`
 *
 * 子 → 父：
 * - `{ type: 'listening', port }`
 * - `{ type: 'opened', id, tabId, url, title }`
 * - `{ type: 'cdp', id, result | error }`
 * - `{ type: 'closed', id?, tabId }`（无 `id` 表示用户自己关的）
 * - `{ type: 'list', id, tabs }`
 * - `{ type: 'bar', id, tabs, rendered, active }`（`rendered` 是标签条 DOM 里的 `.tab` 数，`-1` = 没画出来）
 * - `{ type: 'event', tabId, method, params }`
 * - `{ type: 'error', id?, message }`
 *
 * @module dsh-browser-plugin/browser-electron/host
 */

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron')
const net = require('node:net')
const path = require('node:path')

/** 标签条高度（像素）；标签内容区从这条线开始。 */
const TAB_BAR_HEIGHT = 40

/** 标签页；`debugger` 在 `dom-ready` 之后才有。 */
const tabs = new Map()
let shell
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

/** 把当前标签列表推给标签条页面。 */
function sendTabBar() {
  if (shell === undefined || shell.isDestroyed() || shell.webContents.isDestroyed()) return
  shell.webContents.send('dsh-tabs', [...tabs.values()].map(tab => ({
    id: tab.id,
    title: tab.view.webContents.getTitle(),
    url: tab.view.webContents.getURL(),
    active: tab.id === activeTabId,
  })))
}

/**
 * 重算所有标签的位置：内容区从标签条下面开始，只有活动标签可见。
 *
 * 用 `setVisible` 而不是把非活动标签从视图树上摘下来 —— 摘下来的 `webContents`
 * 尺寸会变成 0，之后再对它 `Page.captureScreenshot` 会拿到空白或报错。
 */
function layout() {
  if (shell === undefined || shell.isDestroyed()) return
  const [width, height] = shell.getContentSize()
  const contentHeight = Math.max(0, height - TAB_BAR_HEIGHT)
  for (const tab of tabs.values()) {
    tab.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: contentHeight })
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
  shell = new BrowserWindow({
    width: size?.width ?? 1200,
    height: size?.height ?? 860,
    show: true,
    title: 'dsh browser',
    backgroundColor: '#f2f3f5',
    webPreferences: {
      preload: path.join(__dirname, 'tabbar-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  shell.loadFile(path.join(__dirname, 'tabbar.html'))
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

  const entry = { id, view, debugger: undefined, ready: undefined }
  entry.ready = new Promise((resolveReady) => {
    view.webContents.once('dom-ready', () => {
      const debugger_ = view.webContents.debugger
      try {
        debugger_.attach('1.3')
      } catch (error) {
        send({ type: 'error', tabId: id, message: `debugger.attach failed: ${String(error?.message ?? error)}` })
      }
      debugger_.on('message', (_event, method, params) => {
        send({ type: 'event', tabId: id, method, params })
      })
      debugger_.on('detach', (_event, reason) => {
        send({ type: 'event', tabId: id, method: 'Inspector.detached', params: { reason } })
      })
      entry.debugger = debugger_
      resolveReady()
    })
    view.webContents.once('render-process-gone', (_event, details) => {
      send({ type: 'error', tabId: id, message: `renderer gone: ${JSON.stringify(details)}` })
    })
  })

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
        const result = await entry.debugger.sendCommand(command.method, command.params ?? {})
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
      const rendered = shell === undefined || shell.isDestroyed()
        ? -1
        : await shell.webContents.executeJavaScript('document.querySelectorAll(".tab").length').catch(() => -1)
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
