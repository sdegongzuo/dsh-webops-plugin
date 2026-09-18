/**
 * 按桌面端生产路径拉起 packaged `@deepseek-ai/dsh-desktop-host`。
 *
 * 0.1.6-alpha.2 起这个包不再导出 `runDesktopHost()`（`lib/index.js` 只剩 `export {}`），
 * 入口是 `import.meta.main` 的进程：argv = runtimeDir / profileDir / primaryRuntime /
 * profileResolution，就绪后走 IPC `{ type: 'ready', url }`。Electron 壳里对应
 * `apps/desktop/src/host-process.ts` 的 spawn。自检必须走同一条路，再 import 那个
 * 已删除的函数只会得到 `is not a function`。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {object} options
 * @param {string} options.runtimeDir
 * @param {string} options.profileDir
 * @param {string} [options.primaryRuntime]
 * @param {string} [options.node]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @returns {{ ready: Promise<{ url: string, injections?: unknown }>, stop: () => Promise<void> }}
 */
export function startPackagedDesktopHost(options) {
  const node = options.node ?? process.execPath
  const runtimeDir = options.runtimeDir
  const profileDir = options.profileDir
  const primaryRuntime = options.primaryRuntime
    ?? join(runtimeDir, '..', 'runtime', 'primary-runtime')
  const entry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  if (!existsSync(entry)) throw new Error(`找不到 desktop-host 入口：${entry}`)

  const child = spawn(node, [
    '--expose-internals',
    entry,
    runtimeDir,
    profileDir,
    primaryRuntime,
    'runtime',
  ], {
    cwd: profileDir,
    env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  let stderr = ''
  let stopping = false
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024) })
  child.stdout?.pipe(process.stdout)

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`desktop-host ${String(options.timeoutMs ?? 60_000)}ms 内没发 ready：${stderr.trim().slice(0, 400)}`))
      child.kill('SIGTERM')
    }, options.timeoutMs ?? 60_000)
    const fail = error => {
      clearTimeout(timer)
      reject(error)
    }
    child.on('message', message => {
      if (message?.type === 'ready' && typeof message.url === 'string') {
        clearTimeout(timer)
        resolve({ url: message.url, injections: message.injections })
      } else if (message?.type === 'fatal') {
        fail(new Error(String(message.message)))
      }
    })
    child.once('error', fail)
    child.once('exit', (code, signal) => {
      if (stopping) return
      fail(new Error(`desktop-host 在 ready 前退出 code=${String(code)} signal=${String(signal)}：${stderr.trim().slice(0, 400)}`))
    })
  })

  async function stop() {
    stopping = true
    if (child.exitCode !== null || child.signalCode !== null) return
    if (child.connected) child.send({ type: 'shutdown' })
    const exited = new Promise(resolve => { child.once('close', resolve) })
    const wait = ms => new Promise(resolve => { setTimeout(resolve, ms) })
    await Promise.race([exited, wait(10_000)])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([exited, wait(5_000)])
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.race([exited, wait(5_000)])
  }

  return { ready, stop, stderr: () => stderr }
}

/**
 * 从宿主 ready URL 拉一个路径。
 *
 * alpha.2 的 `authenticatedUrl` 把 process token 放在 `/?token=`：第一次 GET 会 303
 * 并 Set-Cookie，之后的请求必须带 cookie、且不能再带 token（`/index.html?token=`
 * 会 401）。这里先换 cookie，再按 pathname 取。
 *
 * @param {string} readyUrl
 * @param {string} pathname
 */
export async function fetchHostPath(readyUrl, pathname) {
  const base = new URL(readyUrl)
  const login = await fetch(base.href, { redirect: 'manual' })
  const setCookies = typeof login.headers.getSetCookie === 'function'
    ? login.headers.getSetCookie()
    : [login.headers.get('set-cookie')].filter(Boolean)
  const cookie = setCookies.map(entry => String(entry).split(';', 1)[0]).filter(Boolean).join('; ')
  if (login.status !== 303) {
    return { status: login.status, body: Buffer.from(await login.arrayBuffer()), url: base.href }
  }
  const path = pathname === '/index.html' ? '/' : pathname
  const url = new URL(path, base.origin)
  const response = await fetch(url, { headers: cookie === '' ? {} : { cookie } })
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()), url: url.href }
}
