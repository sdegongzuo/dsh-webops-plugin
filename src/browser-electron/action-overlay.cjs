/** 独立透明窗口：网页 DOM、AX 树与 Page.captureScreenshot 都不包含效果层。 */
function createActionOverlay(BrowserWindow, parent, file, topInset) {
  const window = new BrowserWindow({
    parent, show: false, frame: false, transparent: true, focusable: false,
    skipTaskbar: true, hasShadow: false, resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.setFocusable(false)
  window.setIgnoreMouseEvents(true)
  let ready = false
  let sequence = 0
  let timer
  let current
  let controlTab
  const refreshControl = () => {
    if (window.isDestroyed()) return
    if (controlTab === undefined || !parent.isVisible() || parent.isMinimized()) {
      window.setIgnoreMouseEvents(true)
      window.hide()
      return
    }
    // 独立原生窗口盖住网页内容区并接收人工鼠标输入；它不在页面 DOM/AX 树中。
    // showInactive + focusable:false 保持网页焦点，CDP 输入仍直接送给页面。
    window.setIgnoreMouseEvents(false)
    layout()
    window.showInactive()
    // 渲染层出错也保持原生窗口覆盖并接收鼠标；隐藏会让输入穿透到 agent 页面。
    if (ready) void window.webContents.executeJavaScript('window.setAgentControl(true)').catch(() => {})
  }
  const clear = () => {
    sequence++
    current = undefined
    clearTimeout(timer)
    if (!window.isDestroyed()) {
      void window.webContents.executeJavaScript('window.clearAction?.()').catch(() => {})
      if (controlTab === undefined || !parent.isVisible() || parent.isMinimized()) window.hide()
    }
  }
  const layout = () => {
    if (window.isDestroyed() || parent.isDestroyed()) return
    if (!parent.isVisible() || parent.isMinimized()) {
      clear()
      return
    }
    const bounds = parent.getContentBounds()
    if (bounds.width <= 0 || bounds.height <= topInset) return
    window.setBounds({ x: bounds.x, y: bounds.y + topInset, width: bounds.width, height: bounds.height - topInset })
  }
  window.webContents.on('did-finish-load', () => { ready = true; refreshControl() })
  void window.loadFile(file).catch(() => clear())
  for (const event of ['move', 'resize']) parent.on(event, layout)
  for (const event of ['restore', 'show']) parent.on(event, refreshControl)
  for (const event of ['blur', 'hide', 'minimize']) parent.on(event, clear)
  parent.on('focus', refreshControl)
  parent.on('closed', () => { clearTimeout(timer); if (!window.isDestroyed()) window.destroy() })
  return {
    clear, layout,
    setControl(tabId, holder) {
      controlTab = holder === 'agent' ? tabId : undefined
      clear()
      refreshControl()
    },
    project(tabId, point, phase, viewport) {
      if (!ready || !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || viewport.width <= 0 || viewport.height <= 0) return
      layout()
      if (!parent.isVisible() || parent.isMinimized()) return
      const projection = {
        x: Math.max(0, Math.min(100, point.x / viewport.width * 100)),
        y: Math.max(0, Math.min(100, point.y / viewport.height * 100)),
        phase, sequence: ++sequence,
      }
      current = tabId
      void window.webContents.executeJavaScript('window.setAgentControl(true)').catch(() => {})
      window.showInactive()
      void window.webContents.executeJavaScript(`window.projectAction(${JSON.stringify(projection)})`).catch(() => clear())
      clearTimeout(timer)
      timer = setTimeout(clear, 1400)
    },
    get currentTab() { return current },
  }
}
module.exports = { createActionOverlay }
