/**
 * 按桌面端生产路径拉起 packaged `@deepseek-ai/dsh-desktop-host`。
 *
 * 0.1.6-alpha.2 起这个包不再导出 `runDesktopHost()`（`lib/index.js` 只剩 `export {}`），
 * 入口是 `import.meta.main` 的进程，就绪后走 IPC `{ type: 'ready', url }`。
 * Electron 壳里对应 `apps/desktop/src/host-process.ts` 的 spawn。自检必须走同一条路，
 * 再 import 那个已删除的函数只会得到 `is not a function`。
 *
 * **argv 契约**（0.1.7-alpha.2 的 `apps/desktop-host/src/index.ts:21-38`，子进程视角）：
 * `[1]=entry`、`[2]=runtimeDir`、`[3]=projectDir`、`[4]=primaryRuntime`，
 * `[5]=pnpm 入口文件`、`[6]=nodeBin 目录`。末两项**成对**：宿主写的是
 * `...(process.argv[5] === undefined ? {} : { packageManager: { command: process.execPath,
 * args: ['--expose-internals', process.argv[5]], …PATH: argv[6] + delimiter + PATH } })`。
 *
 * ⚠️ 0.1.7 之前 `[5]` 是 `profileResolution`（`'runtime'`），这个概念上游 0.1.7 已整删
 * （`grep profileResolution --include=*.ts packages/ apps/ | grep -v /lib/` 零命中）。
 * 我们曾只把那个字面量原地留着 —— 结果它落进 `[5]`，被当成 **pnpm 路径**：宿主的
 * `packageManager` 因此被设成一个假值，**盖掉** plugin-manager 自己的兜底
 * （`packages/boot/plugin-manager/src/index.ts:287` 的
 * `...this.profile.packageManager ?? { command: this.pnpmCommand }`），
 * 装插件时会去跑 `node --expose-internals runtime`。传个错的值比不传更糟 ——
 * 不传（`undefined`）至少会退回 `pnpmCommand`。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 桌面端宿主**写死**的端口（`apps/desktop-host/src/index.ts:24` 的 `--port 19387`）。
 *
 * 它被别的实例占着时，新宿主照样能起、照样发 ready，但插件永远上不来，报出来的是
 * `N required plugins did not activate` —— 看着像包坏了，实际跟包一点关系没有。
 * 2026-09-18 真踩过：一台没关的旧宿主占着它，所有自检同时转红。
 */
export const HOST_PORT = 19387

/** 平台系统目录里的 exe —— 不靠 PATH（Node 的 cwd/PATH 可能被调用方改过）。 */
function systemExe(name) {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name)
}

/** 同步 sleep：预检要在同步 API 里等端口释放，不能把 startPackagedDesktopHost 改成 async。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 查谁在 LISTEN 这个端口。只认 `netstat -ano` 的 LISTENING 行 ——
 * 不用「绑一下试试」那套：在 Windows 上绑 `127.0.0.1:<port>` 与占用者绑 `0.0.0.0:<port>`
 * **不冲突**，会得到「端口空闲」的假阴性（2026-09-18 实测）。
 *
 * @param port - 待查端口。
 * @returns `{ pid?, name? }`；没人监听则 `undefined`。非 Windows 一律返回 `undefined`。
 */
export function findPortListener(port = HOST_PORT) {
  if (process.platform !== 'win32') return undefined
  const netstat = spawnSync(systemExe('netstat.exe'), ['-ano'], { encoding: 'utf8', windowsHide: true })
  if (netstat.error !== undefined || netstat.stdout === null) return undefined
  for (const line of String(netstat.stdout).split(/\r?\n/)) {
    if (!/\bLISTENING\b/iu.test(line)) continue
    // 字段固定为：Proto / 本地地址 / 外部地址 / 状态 / PID。
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 4) continue
    if (!fields[1].endsWith(`:${String(port)}`)) continue
    const pid = Number.parseInt(fields[fields.length - 1], 10)
    if (Number.isNaN(pid)) return {}
    const tasklist = spawnSync(systemExe('tasklist.exe'), ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    // CSV 里第一列就是镜像名；这里在 Node 里解析，不受「grep 被 CSV 引号骗过」那个坑影响。
    const name = String(tasklist.stdout ?? '').trim().replace(/^"/u, '').split('","', 1)[0]
    return { pid, name: name === '' ? undefined : name }
  }
  return undefined
}

/**
 * 起宿主前的端口预检：占用则抛，并把「谁占着 + 怎么清」写进消息。
 *
 * 给一小段重试窗口（默认 5s）：上一个宿主刚 `stop()` 完、端口还没释放是常见情形，
 * 那种情况等一下就好了，不该报错。
 *
 * @param options - `port` / `timeoutMs` / `label`。
 */
export function assertHostPortFree(options = {}) {
  const port = options.port ?? HOST_PORT
  const deadline = Date.now() + (options.timeoutMs ?? 5_000)
  const label = options.label ?? 'desktop-host'
  for (;;) {
    const holder = findPortListener(port)
    if (holder === undefined) return
    if (Date.now() >= deadline) {
      const who = holder.pid === undefined
        ? ''
        : ` —— PID ${String(holder.pid)}${holder.name === undefined ? '' : `（${holder.name}）`}`
      throw Object.assign(
        new Error(
          `${label}: 端口 ${String(port)} 已被占用${who}。\n`
          + `  这个端口是桌面端宿主写死的（apps/desktop-host/src/index.ts 的 --port），被占着时\n`
          + '  新宿主的插件永远激活不了，报出来的却是「N required plugins did not activate」，\n'
          + '  看着像包坏了 —— 2026-09-18 就被这一条骗过一整轮。\n'
          + `  清掉占用者：关掉那个 dsh 桌面端窗口，或 taskkill /PID ${String(holder.pid ?? '<pid>')} /F`,
        ),
        { code: 'EADDRINUSE' },
      )
    }
    sleepSync(200)
  }
}

/**
 * @param {object} options
 * @param {string} options.runtimeDir
 * @param {string} options.profileDir
 * @param {string} [options.primaryRuntime]
 * @param {string} [options.node]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.label] 端口被占时报告里用的调用方名字。
 * @param {boolean} [options.skipPortCheck] 调用方自己已经等过端口释放时跳过预检。
 * @returns {{ ready: Promise<{ url: string, injections?: unknown }>, stop: () => Promise<void> }}
 *
 * pnpm 入口 / nodeBin 由本函数按打包布局自动探测（存在才成对传），调用方无需关心。
 */
export function startPackagedDesktopHost(options) {
  // 先过端口：这是「包看着好好的但插件就是不上来」的头号真凶，且在同步阶段就能诊断完，
  // 不必先花几十秒起一个注定起不来的宿主、再从 stderr 里反推。
  if (options.skipPortCheck !== true) assertHostPortFree({ label: options.label ?? 'desktop-host' })
  const node = options.node ?? process.execPath
  const runtimeDir = options.runtimeDir
  const profileDir = options.profileDir
  const primaryRuntime = options.primaryRuntime
    ?? join(runtimeDir, '..', 'runtime', 'primary-runtime')
  const entry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
  if (!existsSync(entry)) throw new Error(`找不到 desktop-host 入口：${entry}`)

  // 打包布局：runtimeDir 就是 `resources/dsh`，所以 `runtimeDir/..` 即 `resources`。
  // 与 `primaryRuntime` 的默认值同源（`resources/runtime/primary-runtime`）。
  const resources = join(runtimeDir, '..')
  const pnpm = join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const nodeBin = join(resources, 'runtime', 'bin')
  // 成对传，缺一不传：宿主只看 `argv[5] === undefined` 决定要不要建 packageManager 对象，
  // 给半个反而会造出「paths 是空串的 pnpm」。
  const packageManager = existsSync(pnpm) ? [pnpm, nodeBin] : []

  const child = spawn(node, [
    '--expose-internals',
    entry,
    runtimeDir,
    profileDir,
    primaryRuntime,
    ...packageManager,
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
