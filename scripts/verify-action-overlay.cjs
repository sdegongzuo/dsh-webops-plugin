/** 用真实 Electron 验证宿主效果层；由本机配置指定的 Electron 执行，不清理文件。 */
const { app, BrowserWindow } = require('electron')
const net = require('node:net')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
let socket
let nextId = 0
const pending = new Map()
const originalWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...args) => {
  const line = String(chunk)
  try {
    const message = JSON.parse(line)
    if (message.type === 'listening') void run(message).catch(error => {
      originalWrite(`${String(error.stack)}\n`)
      app.exit(1)
    })
  } catch { /* 诊断行原样输出。 */ }
  return originalWrite(chunk, ...args)
}
require('../src/browser-electron/host.cjs')
function request(command) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`验证超时：${command.method ?? command.op}`)), 5000)
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message) })
    socket.write(`${JSON.stringify({ ...command, id })}\n`)
  })
}
async function run(address) {
  socket = net.connect(address.port, address.host)
  await new Promise(resolve => socket.once('connect', resolve))
  let buffer = ''
  socket.on('data', data => {
    buffer += data.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
      if (pending.has(message.id)) { const callback = pending.get(message.id); pending.delete(message.id); callback(message) }
    }
  })
  const page = '<button style="margin:100px;width:140px;height:60px" onclick="window.count=(window.count||0)+1">点击验证</button><input id="input">'
  const fixture = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(page)
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  app.on('before-quit', () => fixture.close())
  const opened = await request({ op: 'open', url: `http://127.0.0.1:${fixture.address().port}/` })
  const tabId = opened.tabId
  await request({ op: 'activate', tabId })
  const cdp = async (method, params) => (await request({ op: 'cdp', tabId, method, params })).result
  const evaluate = async expression => (await cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value
  // 与 provider 初始化一致，明确网页视口，避免原始 CDP 夹具停在 0×0。
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 784, deviceScaleFactor: 1, mobile: false })
  await new Promise(resolve => setTimeout(resolve, 400))
  const overlay = BrowserWindow.getAllWindows().find(window => window.getParentWindow())
  const parent = overlay.getParentWindow()
  for (let attempt = 0; overlay.webContents.isLoading() && attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  parent.show()
  await request({ op: 'activate', tabId })
  await request({ op: 'control', tabId, holder: 'human' })
  await request({ op: 'control', tabId, holder: 'agent' })
  parent.focus()
  await cdp('Page.enable', {})
  await cdp('Runtime.enable', {})
  const point = await evaluate('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 240))
  assert.equal(await evaluate('window.count'), 1)
  assert.ok(overlay?.isVisible(), '透明效果窗口应可见')
  assert.equal(overlay.isFocused(), false, '效果窗口不得抢焦点')
  assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("cursor").className'), 'clicking')
  const image = await overlay.webContents.capturePage()
  assert.ok(image.toBitmap().some(byte => byte !== 0), '效果窗口应实际绘制像素')
  if (process.env.DSH_ACTION_SHOT) fs.writeFileSync(process.env.DSH_ACTION_SHOT, image.toPNG())
  const input = await cdp('Runtime.evaluate', { expression: 'document.getElementById("input")' })
  await cdp('Runtime.callFunctionOn', { objectId: input.result.objectId, functionDeclaration: 'function(){this.focus()}' })
  await cdp('Dsh.projectTyping', { objectId: input.result.objectId })
  await cdp('Input.insertText', { text: '验证输入' })
  assert.equal(await evaluate('document.getElementById("input").value'), '验证输入')
  assert.equal(await overlay.webContents.executeJavaScript('document.getElementById("cursor").className'), 'typing')
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' })
  assert.ok(screenshot.data.length > 0, '网页截图应正常返回')
  await request({ op: 'control', tabId, holder: 'human' })
  assert.equal(overlay.isVisible(), false, '接管应清除效果')
  await request({ op: 'control', tabId, holder: 'agent' })
  await cdp('Dsh.projectTyping', { objectId: input.result.objectId })
  await cdp('Page.navigate', { url: 'about:blank' })
  assert.equal(overlay.isVisible(), true, '导航期间应保留 agent 控制光晕')
  originalWrite('效果验收通过：真实点击、输入、可见像素、焦点、网页截图、接管和导航。\n')
  await request({ op: 'dispose' })
}
