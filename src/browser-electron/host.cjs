/**
 * Electron 窗口宿主：开真正的 `BrowserWindow`，把它的 `webContents.debugger`（就是 CDP）
 * 桥给插件 host 进程。
 *
 * ## 为什么要有这么一个子进程
 *
 * dsh 桌面端的 host 平面跑在**纯 Node** 子进程里（`node.exe .../dsh-desktop-host/lib/index.js`），
 * 它拿不到 Electron 的 `BrowserWindow`，所以插件无法在 host 进程里直接开窗口。
 * 这个文件由插件在需要时 `spawn` 成 **Electron 应用**，窗口由它创建，
 * `webContents.debugger` 让插件继续用同一套 CDP 命令驱动页面 ——
 * `Page.navigate` / `Runtime.evaluate` / `Accessibility.getFullAXTree` / `Page.captureScreenshot`
 * 一个都不用改。
 *
 * ## 通道：TCP，不是 stdio
 *
 * 踩过的坑：Electron（Windows）主进程的 `process.stdin` **会立刻 EOF**，
 * 一旦 `on('end')` 里收尾就把 app 关了，表现是「窗口刚建好就自己没了」。
 * stdout 是通的，所以反向来：子进程监听 `127.0.0.1:0`，把端口号从 stdout 宣布出来。
 *
 * ## 另两个必须踩准的时机（都表现为「命令发出去永远不回」）
 *
 * - 窗口 `new` 出来就 `debugger.attach()` → 命令挂住。要等 `dom-ready`。
 * - 建窗口后不显式 `loadURL()` → 浏览器不发起导航，`dom-ready` 永远不来。哪怕加载 `about:blank`。
 *
 * ## 协议（一条 TCP 连接，JSON Lines）
 *
 * 父 → 子：
 * - `{ op: 'open', id, url, size? }`
 * - `{ op: 'cdp', id, windowId, method, params }`
 * - `{ op: 'close', id, windowId }`
 * - `{ op: 'list', id }`
 * - `{ op: 'dispose', id }`
 *
 * 子 → 父：
 * - `{ type: 'listening', port }`
 * - `{ type: 'opened', id, windowId, url, title }`
 * - `{ type: 'cdp', id, result | error }`
 * - `{ type: 'closed', id?, windowId }`（无 `id` 表示用户自己关了窗口）
 * - `{ type: 'list', id, windows }`
 * - `{ type: 'event', windowId, method, params }`
 * - `{ type: 'error', id?, message }`
 *
 * @module dsh-browser-plugin/browser-electron/host
 */

const { app, BrowserWindow } = require('electron')
const net = require('node:net')

/** 受控窗口；`null` 表示宿主已开始收摊。 */
const windows = new Map()
let sequence = 0
let connection

/** 往父进程写一条消息（连接已断时静默丢弃）。 */
function send(message) {
  if (connection === undefined || connection.destroyed) return
  connection.write(`${JSON.stringify(message)}\n`)
}

/**
 * 建一个受控窗口并挂上 debugger。
 * @param url - 初始地址；空值按 `about:blank` 处理。
 * @param size - 窗口尺寸。
 * @returns 描述这条受控窗口的记录。
 */
function openWindow(url, size) {
  const id = `w${++sequence}`
  const window = new BrowserWindow({
    width: size?.width ?? 1100,
    height: size?.height ?? 820,
    show: true,
    title: `dsh browser ${id}`,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })

  const entry = { id, window, ready: undefined }
  entry.ready = new Promise((resolveReady) => {
    window.webContents.once('dom-ready', () => {
      const debugger_ = window.webContents.debugger
      try {
        debugger_.attach('1.3')
      } catch (error) {
        send({ type: 'error', message: `debugger.attach failed: ${String(error?.message ?? error)}` })
      }
      debugger_.on('message', (_event, method, params) => {
        send({ type: 'event', windowId: id, method, params })
      })
      debugger_.on('detach', (_event, reason) => {
        send({ type: 'event', windowId: id, method: 'Inspector.detached', params: { reason } })
      })
      entry.debugger = debugger_
      resolveReady()
    })
    window.webContents.once('render-process-gone', (_event, details) => {
      send({ type: 'error', windowId: id, message: `renderer gone: ${JSON.stringify(details)}` })
    })
  })

  windows.set(id, entry)
  window.on('closed', () => {
    windows.delete(id)
    send({ type: 'closed', windowId: id })
  })

  // 必须显式加载：不加载就没有导航，`dom-ready` 不会来，`entry.ready` 永远挂起。
  void window.loadURL(url === undefined || url === '' ? 'about:blank' : url)
  return entry
}

/** 处理一条来自父进程的命令。 */
async function handle(command) {
  switch (command.op) {
    case 'open': {
      const entry = openWindow(command.url, command.size)
      await entry.ready
      send({
        type: 'opened',
        id: command.id,
        windowId: entry.id,
        url: entry.window.webContents.getURL(),
        title: entry.window.webContents.getTitle(),
      })
      return
    }
    case 'cdp': {
      const entry = windows.get(command.windowId)
      if (entry === undefined) {
        send({ type: 'cdp', id: command.id, error: { message: `unknown window ${String(command.windowId)}` } })
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
    case 'close': {
      const entry = windows.get(command.windowId)
      if (entry !== undefined) entry.window.destroy()
      send({ type: 'closed', id: command.id, windowId: command.windowId })
      return
    }
    case 'list': {
      send({
        type: 'list',
        id: command.id,
        windows: [...windows.values()].map(entry => ({
          id: entry.id,
          url: entry.window.webContents.getURL(),
          title: entry.window.webContents.getTitle(),
        })),
      })
      return
    }
    case 'dispose': {
      send({ type: 'disposed', id: command.id })
      for (const entry of [...windows.values()]) entry.window.destroy()
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
  // 父进程还在的时候不自行退出：它可能马上又要开一个窗口。
  // 父进程断连（进程没了）时才收摊。
  if (connection === undefined) app.quit()
})

app.whenReady().then(() => {
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
      // 父进程走了：这个宿主没有任何存在意义了。
      app.quit()
    })
  })

  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    // 端口只能从 stdout 出去 —— 这条路是通的，stdin 不是。
    process.stdout.write(`${JSON.stringify({ type: 'listening', port: address.port })}\n`)
  })
})
