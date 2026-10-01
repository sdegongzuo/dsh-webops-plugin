/** 实测专用入口：诊断仅绑定回环；生产宿主不包含这些观测和窗口操作。 */
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const assert = require('node:assert/strict')
const events = []
let observed = false
let focusWindow
assert.ok(process.env.DSH_ACTION_PROBE_HOST, '缺少实测宿主路径')
require(process.env.DSH_ACTION_PROBE_HOST)
app.whenReady().then(() => {
  const server = http.createServer(async (request, response) => {
    const requestAt = Date.now()
    try {
      const overlay = BrowserWindow.getAllWindows().find(window => window.getParentWindow())
      if (!overlay) throw new Error('效果窗口尚未创建')
      const parent = overlay.getParentWindow()
      if (!observed) {
        observed = true
        for (const event of ['blur', 'focus', 'hide', 'show']) {
          parent.on(event, () => events.push({ at: Date.now(), target: 'parent', event }))
          overlay.on(event, () => events.push({ at: Date.now(), target: 'overlay', event }))
        }
      }
      if (request.url === '/shot') {
        response.setHeader('Content-Type', 'image/png')
        response.end((await overlay.webContents.capturePage()).toPNG())
        return
      }
      if (request.url === '/resize') parent.setSize(960, 760)
      if (request.url === '/move') {
        const [x, y] = parent.getPosition()
        parent.setPosition(x + 20, y + 20)
      }
      if (request.url === '/minimize') parent.minimize()
      if (request.url === '/restore') { parent.restore(); parent.focus() }
      if (request.url === '/focus-other') {
        focusWindow ??= new BrowserWindow({width:400,height:240,show:true,webPreferences:{sandbox:true}})
        if (focusWindow.webContents.getURL() === '') await focusWindow.loadURL('data:text/html,<input aria-label="其他窗口输入框">')
        focusWindow.focus()
      }
      if (request.url === '/focus-parent') parent.focus()
      const arrivalVisible = overlay.isVisible()
      const projection = await overlay.webContents.executeJavaScript(`(()=>{
        const cursor=document.getElementById('cursor');const r=cursor.getBoundingClientRect();
        const wash=document.getElementById('wash');const w=wash.getBoundingClientRect();
        return {phase:cursor.className,cursorHidden:cursor.hidden,x:r.x,y:r.y,width:innerWidth,height:innerHeight,sequence:cursor.dataset.sequence,
          wash:{x:w.x,y:w.y,width:w.width,height:w.height,opacity:Number(getComputedStyle(wash).opacity),background:getComputedStyle(wash).backgroundImage,
            animation:getComputedStyle(wash).animationName,animations:document.getAnimations().length}}
      })()`)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ requestAt, replyAt: Date.now(), arrivalVisible, throttling: overlay.webContents.getLastWebPreferences().backgroundThrottling, events: events.slice(-12), visible: overlay.isVisible(), focused: overlay.isFocused(),
        parentFocused: parent.isFocused(), otherFocused: focusWindow?.isFocused() ?? false, bounds: overlay.getBounds(), content: parent.getContentBounds(), projection }))
    } catch (error) {
      response.statusCode = 500
      response.end(String(error.stack))
    }
  })
  server.listen(Number(process.env.DSH_ACTION_PROBE_PORT), '127.0.0.1')
  app.on('before-quit', () => server.close())
})
