/** 在真实便携版 exe 上运行本轮构建的 provider；不修改安装目录、不清理文件。 */
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'
import { portableTestDir } from './local-env.mjs'

const buildDir = resolve(process.argv[2] ?? '.action-probe-20261001/lib')
const out = resolve(process.argv[3] ?? '.action-probe-20261001/evidence')
const installed = process.argv.includes('--installed')
mkdirSync(out, { recursive: true })
for (const name of ['host.cjs', 'action-overlay.cjs', 'action-overlay.html', 'tabbar.html', 'tabbar-preload.cjs']) {
  const target = join(buildDir, 'browser-electron', name)
  const source = resolve('src/browser-electron', name)
  if (existsSync(target)) assert.ok(readFileSync(target).equals(readFileSync(source)), `实测资产与源码不一致，请使用新的构建目录：${target}`)
  else {
    assert.ok(!installed, `安装产物缺少资产：${target}`)
    copyFileSync(source, target)
  }
}
if (installed) {
  // 复刻打包宿主的共享依赖解析；只读安装目录，不增添软链或改 profile。
  const runtimeRequire = createRequire(join(portableTestDir(), 'app/resources/dsh/package.json'))
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(pathToFileURL(buildDir).href)) {
      return nextResolve(pathToFileURL(runtimeRequire.resolve(specifier)).href, context)
    }
    return nextResolve(specifier, context)
  } })
}
const { ElectronBrowserProvider, ElectronWindowTransport } = await import(pathToFileURL(join(buildDir, 'browser-electron/index.js')))
const exe = join(portableTestDir(), 'app', 'DeepSeek Harness.exe')
assert.ok(existsSync(exe), '固定目录没有便携版 exe')
const fixture = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Agent 效果层实测</title>
    <style>body{font:20px sans-serif;padding:40px}button,input{font:inherit;margin:20px;padding:12px}.long{height:2400px}</style>
    <h1>Agent 效果层实测</h1><button onclick="window.clicks=(window.clicks||0)+1;document.getElementById('count').textContent=window.clicks">点击计数</button><span id="count">0</span>
    <form onsubmit="event.preventDefault();window.submits=(window.submits||0)+1;document.getElementById('result').textContent=document.getElementById('query').value">
    <label>测试输入<input id="query"></label><button type="submit">提交查询</button></form><div id="result"></div><div class="long">滚动验收区域</div></html>`)
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const reservation = createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
process.env.DSH_ACTION_PROBE_PORT = String(port)
process.env.DSH_ACTION_PROBE_HOST = join(buildDir, 'browser-electron/host.cjs')
const transport = new ElectronWindowTransport({ electronPath: exe,
  hostScript: resolve('scripts/verify-action-host.cjs'), appMode: true, keepAlive: false,
  windowSize: { width: 1100, height: 860 } })
const provider = new ElectronBrowserProvider({}, transport, true)
const results = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const probeRequest = path => new Promise((resolve, reject) => {
  const request = get({ host: '127.0.0.1', port, path, agent: false }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => {
      const body = Buffer.concat(chunks)
      if (response.statusCode !== 200) reject(new Error(body.toString()))
      else resolve(body)
    })
  })
  request.on('error', reject)
  request.setTimeout(5000, () => request.destroy(new Error('诊断回包超时')))
})
const diagnostic = async (path = '/state') => {
  return JSON.parse((await probeRequest(path)).toString())
}
const record = (name, detail) => { results.push({ name, detail }); console.log(`通过：${name} ${detail ?? ''}`) }
let session
let connection
const read = async expression => (await connection.send('Runtime.evaluate', { expression, returnByValue: true })).result.value
const snap = () => provider.observe({ sessionId: session.id, kind: 'snapshot' })
const refOf = (snapshot, name) => {
  const item = snapshot.refs.find(item => item.name === name)
  assert.ok(item, `快照没有控件：${name}`)
  return item.ref
}
async function action(request, phase, shotName) {
  const operation = provider.mutate({ sessionId: session.id, ...request })
  // 注册拒绝处理，避免观察窗口期间把失败误报为未处理拒绝。
  operation.catch(() => {})
  await delay(240)
  const state = await diagnostic()
  assert.equal(state.visible, true, `${phase} 效果应可见：${JSON.stringify(state)}`)
  assert.equal(state.focused, false, '效果层不得抢焦点')
  assert.equal(state.parentFocused, true, '网页窗口应保持焦点')
  assert.equal(state.projection.phase, phase)
  assert.deepEqual([state.projection.wash.x,state.projection.wash.y,state.projection.wash.width,state.projection.wash.height], [0,0,state.projection.width,state.projection.height], '晕染必须覆盖整个网页视口')
  assert.ok(state.projection.wash.opacity > .1, '全页晕染应可见')
  assert.equal(state.projection.wash.animation, 'none', '只显示静态光晕')
  assert.equal(state.projection.wash.animations, 0, '页面效果层不得包含水波纹或动画')
  if (shotName) {
    writeFileSync(join(out, shotName), await probeRequest('/shot'))
  }
  await operation
  return state
}
try {
  session = await provider.open({ url: `http://127.0.0.1:${fixture.address().port}` })
  connection = await transport.connect(`electron-tab://${session.id}`)
  await delay(400)
  let snapshot = await snap()
  const button = refOf(snapshot, '点击计数')
  const state = await action({ kind: 'click', ref: button }, 'clicking', 'click-overlay.png')
  assert.equal(await read('window.clicks'), 1)
  const point = await read('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight}})()')
  assert.ok(Math.abs(state.projection.x / state.projection.width - point.x / point.width) < .005)
  assert.ok(Math.abs(state.projection.y / state.projection.height - point.y / point.height) < .005)
  record('click 实际计数与光标位置', '计数=1；投影误差小于视口的 0.5%')
  snapshot = await snap()
  let input = refOf(snapshot, '测试输入')
  await action({ kind: 'fill', ref: input, value: '浏览器工具测试' }, 'typing', 'typing-overlay.png')
  assert.equal(await read('document.getElementById("query").value'), '浏览器工具测试')
  record('fill 普通输入框', '字段值与输入完全一致；输入效果可见')
  await action({ kind: 'press', ref: input, key: 'Enter' }, 'typing')
  assert.equal(await read('window.submits'), 1)
  assert.equal(await read('document.getElementById("result").textContent'), '浏览器工具测试')
  record('press Enter 实际提交', '提交次数=1；接收值正确')
  const shot = await provider.observe({ sessionId: session.id, kind: 'screenshot' })
  writeFileSync(join(out, 'page.png'), shot.data)
  assert.ok(!snapshot.outline.includes('操作效果'))
  record('网页截图和 AX 快照', '截图正常；效果层不在网页快照中')
  await diagnostic('/resize')
  await delay(150)
  await action({ kind: 'fill', ref: input, value: '缩放后验证' }, 'typing')
  const resized = await diagnostic()
  assert.equal(resized.bounds.width, resized.content.width)
  assert.equal(resized.bounds.height, resized.content.height - 76)
  await diagnostic('/move')
  await delay(100)
  const moved = await diagnostic()
  assert.equal(moved.bounds.x, moved.content.x)
  assert.equal(moved.bounds.y, moved.content.y + 76)
  record('窗口缩放和移动', '效果层跟随网页内容区')
  await diagnostic('/minimize')
  await delay(100)
  assert.equal((await diagnostic()).visible, false)
  await diagnostic('/restore')
  await delay(200)
  await action({ kind: 'fill', ref: input, value: '恢复后验证' }, 'typing')
  record('最小化和恢复', '隐藏效果；恢复后再次显示正常')
  await transport.setControl(session.id, 'human')
  assert.equal((await diagnostic()).visible, false)
  await assert.rejects(provider.mutate({ sessionId: session.id, kind: 'fill', ref: input, value: '不应写入' }), /human|holding|接管/i)
  assert.equal(await read('document.getElementById("query").value'), '恢复后验证')
  await transport.setControl(session.id, 'agent')
  snapshot = await snap(); input = refOf(snapshot, '测试输入')
  await action({ kind: 'fill', ref: input, value: '交还后验证' }, 'typing')
  record('人工接管和交还', '接管隐藏、写入被拒绝；交还重拍后继续正常')
  const other = await provider.open({ url: 'about:blank' })
  assert.equal((await diagnostic()).projection.cursorHidden, true)
  await transport.setControl(session.id, 'human')
  await provider.navigate({ sessionId: other.id, url: `http://127.0.0.1:${fixture.address().port}` })
  const otherSnapshot = await provider.observe({sessionId:other.id,kind:'snapshot'})
  await provider.mutate({sessionId:other.id,kind:'fill',ref:refOf(otherSnapshot,'测试输入'),value:'另一标签仍可操作'})
  const otherConnection = await transport.connect(`electron-tab://${other.id}`)
  assert.equal((await otherConnection.send('Runtime.evaluate',{expression:'document.getElementById("query").value',returnByValue:true})).result.value,'另一标签仍可操作')
  await assert.rejects(provider.mutate({ sessionId: session.id, kind: 'fill', ref: input, value: '不应写入' }), /human|holding|接管/i)
  await transport.setControl(session.id, 'agent')
  record('接管单个标签', '接管首个标签时第二个标签仍可实际填入；首个标签写入被拒')
  await provider.activate(session.id)
  await action({ kind: 'scroll', deltaY: 500 }, 'scrolling', 'scroll-overlay.png')
  const scrollY = await read('scrollY')
  assert.ok(scrollY > 0, '页面应实际滚动')
  record('切标签和 scroll', `切换清除旧光标；实际 scrollY=${scrollY}`)
  await delay(1600)
  assert.equal((await diagnostic()).visible, true)
  assert.equal((await diagnostic()).projection.cursorHidden, true)
  record('持续全页晕染', '1.6 秒后光标隐藏；agent 控制时全页晕染持续可见')
  await diagnostic('/focus-other')
  await delay(120)
  const background = await diagnostic()
  assert.equal(background.parentFocused, false, '网页窗口应实际失焦')
  assert.equal(background.otherFocused, true, '焦点应保留在其他窗口')
  assert.equal(background.visible, true, '失焦后静态光晕必须保留')
  assert.equal(background.focused, false, '光晕不得抢回焦点')
  assert.equal(background.projection.wash.opacity, 1)
  writeFileSync(join(out,'focus-other-state.json'),JSON.stringify(background,null,2))
  await diagnostic('/focus-parent')
  record('切到其他 app 的输入框', '网页实际失焦、焦点保留在另一窗口，静态光晕仍可见')
  await provider.navigate({ sessionId: session.id, url: 'about:blank' })
  assert.equal((await diagnostic()).projection.cursorHidden, true)
  await provider.close(other.id)
  record('导航清除旧动作', '导航后旧光标隐藏，当前标签仍显示控制状态晕染')
  writeFileSync(join(out, 'results.json'), JSON.stringify({ exe, buildDir, installed, results }, null, 2))
  console.log(`真实便携版 exe + 本轮编译产物验收通过；证据：${out}`)
} finally {
  await provider.dispose()
  fixture.close()
}
