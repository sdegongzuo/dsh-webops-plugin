/**
 * 本机路径的**唯一来源** —— 仓库根的 `.env.local`（不进库；模板见 `.env.local.example`）。
 *
 * ## 为什么要有它
 *
 * 脚本里原本散着一串本机绝对路径：`D:/dsh-build`（构建根）、`D:/dev/cli/deepseek-harness`
 * （harness 源码）、`…/node_modules/electron/dist/electron.exe`（smoke 脚本的 electron）……
 * 换机器、换盘、挪目录就得满地改，而且**很容易漏一处**（漏了的那处会安静地跑一个不存在的路径）。
 * 现在全部收敛到一个文件，脚本只认环境变量。
 *
 * ## 三条语义（改动前先想清楚）
 *
 * 1. **文件只提供默认值**。进程环境里已经有的（包括命令行前缀 `FOO=bar node …`）优先，**不被覆盖** ——
 *    所以「临时指到别的目录」永远是最高的优先级，不用去改文件。
 * 2. **文件不存在不是错误**。CI 没有这个文件，靠 workflow 显式传值；本机第一次 clone 也没它，
 *    此时缺哪个键就报哪个键。
 * 3. **缺键要报得可操作**：说清「缺哪个键、去哪个文件加、示例长什么样」，**不要**静默退回某个
 *    `D:` 盘默认值 —— 那正是这次要根除的东西（静默的默认值会把「没配」伪装成「配好了」）。
 *
 * ## 用法
 *
 * ```js
 * import { loadLocalEnv, envOrDie, harnessRoot, buildRoot } from './local-env.mjs'
 * loadLocalEnv()                       // 幂等；不调用也不会崩（下面每个 getter 内部都会先调）
 * const harness = harnessRoot()
 * ```
 *
 * 本模块**只被命令行脚本用**，所以 `envOrDie` 直接 `process.exit(1)` 而不是抛异常 ——
 * 免得用户看到一坨栈。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ENV_FILE = join(ROOT, '.env.local')
export const ENV_EXAMPLE = join(ROOT, '.env.local.example')

/** 本文件认识的键。加新键时**同时**补 `.env.local.example` 与 `AGENTS.md`。 */
export const KNOWN_KEYS = [
  'DSH_HARNESS',
  'DSH_DESKTOP_BUILD_ROOT',
  'DSH_PORTABLE_TEST_DIR',
  'DSH_ELECTRON_BIN',
  'DSH_NPM_REGISTRY',
  'DSH_ELECTRON_MIRROR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ELECTRON_GET_USE_PROXY',
]

/** 本机装 npm 包默认走 `~/.npmrc` 的 registry；这里给的是**重编桌面端**时临时替换用的那一个。 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com/'

/** Electron 二进制的镜像（`@electron/get` 认 `ELECTRON_MIRROR`，URL 形如 <镜像><版本>/electron-v<版本>-win32-x64.zip）。 */
export const DEFAULT_ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

/** 缺键时的统一引导语（每次都要带上，别让用户去猜）。 */
const HOW_TO_FIX = `在 ${ENV_FILE} 里加上它（模板见 .env.local.example）`

/**
 * 解析 KEY=VALUE 文本。够用就行：支持 `#` 注释、空行、两侧空白、
 * 以及成对的单/双引号（Windows 路径里的反斜杠**不做转义处理**，原样保留）。
 */
function parse(text) {
  const entries = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) value = value.slice(1, -1)
    entries.push([key, value])
  }
  return entries
}

let applied

/**
 * 把 `.env.local` 里**本进程尚未设置**的键写进 `process.env`。
 * 幂等，只读一次文件；返回本次真正生效的键名（诊断用）。重复调用返回首次的结果。
 * @returns {readonly string[]}
 */
export function loadLocalEnv() {
  if (applied !== undefined) return applied
  const done = []
  applied = done
  if (!existsSync(ENV_FILE)) return done
  let text
  try {
    text = readFileSync(ENV_FILE, 'utf8')
  } catch (error) {
    console.error(`local-env: 读不了 ${ENV_FILE}（${error.code ?? '未知'}），按「没配」继续`)
    return done
  }
  for (const [key, value] of parse(text)) {
    // 空串视为「没设」—— 命令行里写 `FOO= node …` 的本意就是这个。
    if ((process.env[key] ?? '') !== '') continue
    process.env[key] = value
    done.push(key)
  }
  return done
}

/**
 * 取一个必需的环境变量；缺了就打印可操作的提示并退出。
 * @param {string} name - 变量名。
 * @param {{ why?: string, example?: string }} [hint] - 「它是干什么的」与一个可直接抄的示例值。
 * @returns {string}
 */
export function envOrDie(name, hint = {}) {
  loadLocalEnv()
  const value = (process.env[name] ?? '').trim()
  if (value !== '') return value
  const lines = [`local-env: 缺 ${name}`]
  if (hint.why !== undefined) lines.push(`  它是：${hint.why}`)
  lines.push(`  怎么修：${HOW_TO_FIX}`)
  if (hint.example !== undefined) lines.push(`  示例：${name}=${hint.example}`)
  for (const line of lines) console.error(line)
  process.exit(1)
}

/** 取一个可选的环境变量；没设返回 undefined。 */
export function envOrUndefined(name) {
  loadLocalEnv()
  const value = (process.env[name] ?? '').trim()
  return value === '' ? undefined : value
}

/**
 * harness（deepseek-harness）源码根。
 * @returns {string}
 */
export function harnessRoot() {
  return resolve(envOrDie('DSH_HARNESS', {
    why: 'deepseek-harness 源码根（桌面端打包链在它里面跑，verify:portable 也要读它的 apps/desktop/src）',
    example: 'D:/dev/cli/deepseek-harness',
  }))
}

/**
 * 打包大件（`.desktop-base` / `.desktop-stage`）的根。
 *
 * ⚠️ **缺省必须留在仓库根** —— CI（`release-desktop.yml`）的 `actions:cache` 就是按相对路径
 * `.desktop-base` 缓存的，改默认会让缓存永远不命中。本机在 `.env.local` 里指到工作区外
 * （工作区内的 `app.asar` 会被 IDE 持句柄，见 `docs/打包与发版.md` §2）。
 * @returns {string}
 */
export function buildRoot() {
  return resolve(envOrUndefined('DSH_DESKTOP_BUILD_ROOT') ?? ROOT)
}

/**
 * 真机测试的固定便携版目录（`scripts/portable-dev.mjs` 的工作对象）。
 * @returns {string}
 */
export function portableTestDir() {
  return resolve(envOrDie('DSH_PORTABLE_TEST_DIR', {
    why: '真机测试用的固定便携版目录（portable-dev.mjs 在它上面 refresh / set-app）',
    example: 'D:/dsh-build/portable-test',
  }))
}

/**
 * harness 装的那份 electron 可执行文件（`smoke:*` 脚本直接起它）。
 * 允许用 `DSH_ELECTRON_BIN` 覆盖（比如换了一份独立下载的 electron）。
 * @returns {string}
 */
export function harnessElectronBin() {
  const explicit = envOrUndefined('DSH_ELECTRON_BIN')
  if (explicit !== undefined) return resolve(explicit)
  return join(harnessRoot(), 'apps', 'desktop', 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron')
}

/**
 * harness 的**开发态**桌面工程目录（`window-in-host.mjs` 拿它当默认工作区）。
 * @returns {string}
 */
export function harnessDevProject() {
  return join(harnessRoot(), 'apps', 'desktop', '.desktop-build', 'development', 'project')
}

/** 拼 URL 前统一补齐结尾斜杠（registry 与 Electron 镜像都按「前缀」用）。 */
const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`)

/**
 * 重编桌面端时给 `prepare-dsh.ts` **临时替换**用的 npm registry。
 *
 * 为什么需要它（2026-09-19 实测，别删）：harness 的 `apps/desktop/scripts/prepare-dsh.ts`
 * 把 registry **硬编码**成 `https://registry.npmjs.org/`（第 77、89 两行），并主动剥掉子进程
 * 环境里所有 `npm_*` / `pnpm_*` 变量、把 `--config.userconfig` 指向一个空文件 —— 所以
 * **`~/.npmrc` 里配的镜像完全不起作用**，也没法用环境变量注入。
 * 而本机直连 npmjs 只有 **11–31 KB/s**（实测 `node-pty` 7.15MB 要 ~10 分钟），且该脚本每轮
 * 用 `mkdtemp` 新建 BUILD_ROOT（pnpm store 就在里面）→ **store 每轮都是冷的** → 大包必然
 * 撞 pnpm 的 60s `fetch-timeout`。改走 npmmirror 实测 **1.8–2.5 MB/s（~100 倍）**。
 * 临时替换由 `scripts/harness-build.mjs` 负责，用完必还原。
 * @returns {string} 以 `/` 结尾。
 */
export function npmRegistry() {
  return withSlash(envOrUndefined('DSH_NPM_REGISTRY') ?? DEFAULT_NPM_REGISTRY)
}

/**
 * Electron 二进制镜像（`@electron/get` 认的 `ELECTRON_MIRROR`）。
 *
 * `prepare:runtime` 要下 **157MB** 的 `electron-v<版本>-win32-x64.zip`，从 GitHub releases 直连
 * 实测 `TypeError: fetch failed`。npmmirror 有官方 Electron 镜像（`<镜像><版本>/electron-v<版本>-win32-x64.zip`），
 * 实测可达且是真 zip（前 4 字节 `PK\x03\x04`）。
 * @returns {string} 以 `/` 结尾。
 */
export function electronMirror() {
  return withSlash(envOrUndefined('DSH_ELECTRON_MIRROR') ?? DEFAULT_ELECTRON_MIRROR)
}

/**
 * 打印一次「本机路径从哪来」，给诊断用（脚本带 `--show-env` 时可调）。
 */
export function describeLocalEnv() {
  const appliedKeys = loadLocalEnv()
  const rows = [
    ['DSH_HARNESS', process.env.DSH_HARNESS],
    ['DSH_DESKTOP_BUILD_ROOT', process.env.DSH_DESKTOP_BUILD_ROOT],
    ['DSH_PORTABLE_TEST_DIR', process.env.DSH_PORTABLE_TEST_DIR],
    ['DSH_ELECTRON_BIN', process.env.DSH_ELECTRON_BIN],
    ['DSH_NPM_REGISTRY', process.env.DSH_NPM_REGISTRY],
    ['DSH_ELECTRON_MIRROR', process.env.DSH_ELECTRON_MIRROR],
  ]
  console.log(`本机路径来源  ${existsSync(ENV_FILE) ? ENV_FILE : `${ENV_FILE}（不存在）`}`)
  if (appliedKeys.length === 0) console.log('  文件没有贡献任何键（不存在，或全都已被环境覆盖）')
  else console.log(`  文件生效的键：${appliedKeys.join('、')}`)
  for (const [key, value] of rows) {
    const from = appliedKeys.includes(key) ? '文件' : ((value ?? '') === '' ? '未设' : '环境')
    console.log(`  ${key.padEnd(24)} ${(value ?? '(未设)').padEnd(46)} [${from}]`)
  }
}
