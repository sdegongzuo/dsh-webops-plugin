#!/usr/bin/env node
/**
 * 本会话 agent 接管浏览器：在当前 Node 进程里起 ElectronBrowserProvider。
 *
 *   node scripts/agent-drive.mjs serve
 *   node scripts/agent-drive.mjs open https://example.com/
 *   node scripts/agent-drive.mjs snapshot
 *   node scripts/agent-drive.mjs fill e5 hello
 *   node scripts/agent-drive.mjs press e5 Enter
 *   node scripts/agent-drive.mjs click e3
 *   node scripts/agent-drive.mjs scroll e1 0 800
 *   node scripts/agent-drive.mjs waitfor 2000
 *   node scripts/agent-drive.mjs waitfor text=Electron
 *   node scripts/agent-drive.mjs navigate https://example.org/
 *   node scripts/agent-drive.mjs screenshot out.png
 *   node scripts/agent-drive.mjs console
 *   node scripts/agent-drive.mjs network
 *   node scripts/agent-drive.mjs execute Runtime.evaluate document.title
 *   node scripts/agent-drive.mjs locate e3
 *   node scripts/agent-drive.mjs tabs
 *   node scripts/agent-drive.mjs activate t2
 *   node scripts/agent-drive.mjs use t2
 *   node scripts/agent-drive.mjs close-tab t2
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ElectronBrowserProvider, ElectronWindowTransport } from '../lib/browser-electron/index.js'

const DRIVE_PORT = Number(process.env.DRIVE_PORT ?? 9555)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const [command, ...rest] = process.argv.slice(2)

function resolveElectron() {
  if (process.env.DSH_BROWSER_ELECTRON_PATH) return process.env.DSH_BROWSER_ELECTRON_PATH
  const electron = createRequire(join(ROOT, '..', 'deepseek-harness', 'apps', 'desktop', 'package.json'))('electron')
  if (typeof electron !== 'string') throw new Error('找不到 electron 可执行文件')
  return electron
}

/** @type {{ provider: import('../lib/browser-electron/index.js').ElectronBrowserProvider, sessionId: string | null } | undefined} */
let drive

function getDrive() {
  if (drive !== undefined) return drive
  delete process.env.ELECTRON_RUN_AS_NODE
  const provider = new ElectronBrowserProvider(
    {},
    new ElectronWindowTransport({
      electronPath: resolveElectron(),
      hostScript: join(ROOT, 'lib', 'browser-electron', 'host.cjs'),
      keepAlive: true,
    }),
    true,
  )
  drive = { provider, sessionId: null }
  return drive
}

function sid(state, override) {
  const id = override || state.sessionId
  if (!id) throw new Error('还没 open')
  return id
}

function pickOutline(outline) {
  const lines = String(outline ?? '').split('\n')
  const interesting = lines.filter(line =>
    /\[ref=e\d+\]/.test(line)
    && /link |button |textbox |searchbox |combobox |checkbox |radio |slider |spinbutton |menuitem |tab /i.test(line)
  )
  return {
    lines: interesting.slice(0, 120),
    totalLines: lines.length,
    refLines: interesting.length,
  }
}

async function run(cmd, params) {
  const state = getDrive()
  const arg = params.arg ?? ''
  const arg2 = params.arg2 ?? ''
  const sessionOverride = params.session || ''

  if (cmd === 'ping') return { op: 'ping', sessionId: state.sessionId }
  if (cmd === 'open') {
    const session = await state.provider.open({ url: arg || 'https://example.com/' })
    state.sessionId = session.id
    return { op: 'open', session }
  }
  if (cmd === 'use') {
    sid(state, arg)
    state.sessionId = arg
    return { op: 'use', sessionId: state.sessionId }
  }

  const sessionId = sid(state, sessionOverride)

  if (cmd === 'snapshot') {
    const shot = await state.provider.observe({ sessionId, kind: 'snapshot' })
    const picked = pickOutline(shot.outline)
    return {
      op: 'snapshot',
      sessionId,
      epoch: shot.epoch,
      url: shot.url,
      title: shot.title,
      truncated: shot.truncated ?? false,
      refs: Array.isArray(shot.refs) ? shot.refs.length : 0,
      ...picked,
    }
  }
  if (cmd === 'screenshot') {
    const shot = await state.provider.observe({
      sessionId,
      kind: 'screenshot',
      ...(params.fullPage === '1' ? { fullPage: true } : {}),
      ...(arg && !arg.endsWith('.png') ? { ref: arg } : {}),
    })
    const out = arg.endsWith('.png') ? resolve(arg) : resolve(arg2 || 'screenshot.png')
    writeFileSync(out, shot.data)
    return {
      op: 'screenshot',
      sessionId,
      epoch: shot.epoch,
      bytes: shot.data.byteLength,
      width: shot.width,
      height: shot.height,
      out,
    }
  }
  if (cmd === 'click') {
    return { op: 'click', ref: arg, result: await state.provider.mutate({ kind: 'click', sessionId, ref: arg }) }
  }
  if (cmd === 'fill') {
    return {
      op: 'fill',
      ref: arg,
      value: arg2,
      result: await state.provider.mutate({ kind: 'fill', sessionId, ref: arg, value: arg2 }),
    }
  }
  if (cmd === 'press') {
    return {
      op: 'press',
      ref: arg,
      key: arg2 || 'Enter',
      result: await state.provider.mutate({ kind: 'press', sessionId, ref: arg, key: arg2 || 'Enter' }),
    }
  }
  if (cmd === 'scroll') {
    const deltaX = Number(arg2 || 0)
    const deltaY = Number(params.dy ?? params.arg3 ?? 600)
    return {
      op: 'scroll',
      ref: arg,
      deltaX,
      deltaY,
      result: await state.provider.mutate({ kind: 'scroll', sessionId, ref: arg, deltaX, deltaY }),
    }
  }
  if (cmd === 'wait') {
    const ms = Number(arg) || 2000
    await new Promise(resolve => setTimeout(resolve, ms))
    return { op: 'wait', ms }
  }
  if (cmd === 'waitfor') {
    const req = { kind: 'wait', sessionId }
    if (arg.startsWith('text=')) req.text = arg.slice(5)
    else if (arg.startsWith('ref=')) req.ref = arg.slice(4)
    else req.timeMs = Number(arg) || 2000
    return { op: 'waitfor', result: await state.provider.mutate(req) }
  }
  if (cmd === 'navigate') {
    const session = await state.provider.navigate({ sessionId, url: arg })
    state.sessionId = session.id
    return { op: 'navigate', session }
  }
  if (cmd === 'tabs') {
    return { op: 'tabs', result: await state.provider.tabs({ kind: 'list' }) }
  }
  if (cmd === 'activate') {
    return { op: 'activate', result: await state.provider.tabs({ kind: 'activate', sessionId: arg || sessionId }) }
  }
  if (cmd === 'close-tab') {
    const id = arg || sessionId
    const result = await state.provider.tabs({ kind: 'close', sessionId: id })
    if (state.sessionId === id) state.sessionId = result.tabs[0]?.sessionId ?? null
    return { op: 'close-tab', result }
  }
  if (cmd === 'console') {
    return {
      op: 'console',
      result: await state.provider.console({ sessionId, limit: Number(arg) || 50 }),
    }
  }
  if (cmd === 'network') {
    return {
      op: 'network',
      result: await state.provider.network({
        kind: 'list',
        sessionId,
        limit: Number(params.limit || 50),
        ...(arg ? { url: arg } : {}),
      }),
    }
  }
  if (cmd === 'execute') {
    const method = arg || 'Runtime.evaluate'
    const expression = arg2
    const result = await state.provider.execute({
      sessionId,
      method,
      params: method === 'Runtime.evaluate' ? { expression } : undefined,
    })
    return { op: 'execute', result }
  }
  if (cmd === 'locate') {
    return { op: 'locate', result: await state.provider.locate({ sessionId, ref: arg, highlight: params.highlight === '1' }) }
  }
  throw new Error(`unknown command ${cmd}`)
}

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(json)
}

function failBody(error) {
  const err = error instanceof Error ? error : new Error(String(error))
  return {
    error: err.message,
    code: 'code' in err ? err.code : undefined,
    name: err.name,
  }
}

async function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(DRIVE_PORT)}`)
    const cmd = url.pathname.replace(/^\//, '') || 'ping'
    const params = Object.fromEntries(url.searchParams.entries())
    if (!params.arg && url.searchParams.has('arg')) params.arg = ''
    void run(cmd, params).then(
      value => send(res, 200, value),
      error => send(res, 500, failBody(error)),
    )
  })
  await new Promise(resolve => server.listen(DRIVE_PORT, '127.0.0.1', resolve))
  console.log(`agent-drive: listening on http://127.0.0.1:${String(DRIVE_PORT)}`)
}

async function client(cmd, args) {
  const url = new URL(`http://127.0.0.1:${String(DRIVE_PORT)}/${cmd}`)
  if (args[0]) url.searchParams.set('arg', args[0])
  if (args[1]) url.searchParams.set('arg2', args[1])
  if (args[2]) url.searchParams.set('arg3', args[2])
  const response = await fetch(url)
  const text = await response.text()
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  if (!response.ok) process.exitCode = 1
}

if (!command) {
  console.error('usage: node scripts/agent-drive.mjs <serve|open|snapshot|...> [args]')
  process.exit(1)
} else if (command === 'serve') {
  await serve()
} else {
  await client(command, rest)
}
