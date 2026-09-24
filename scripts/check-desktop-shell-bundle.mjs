#!/usr/bin/env node
/**
 * 守卫：桌面端本体的产物（`apps/desktop/lib/main.js`）里**不能留下运行时解析不到的裸 import**。
 *
 * ## 为什么要有它（机制，不是症状）
 *
 * `build:official` 链里的 `build:lib:host` 是
 *
 *     tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host
 *
 * —— **一次 rolldown 批构建**：它把 `apps/desktop` 和它依赖的 workspace 包（`packages/<组>/<包>`、
 * `apps/cli`、`apps/desktop-host`）放在**同一个进程**里构建（根 `tsdown.config.ts` 的
 * `workspace:` 字段）。而 entries 是 `tsc -b` 的产物 `lib/types/<入口>.js`，
 * 各包 `package.json` 的 `exports` 却指向 **tsdown 自己的产物** `lib/index.js`。
 *
 * 于是当桌面端本体 import 一个 workspace **devDependency** 时（`@deepseek-ai/dsh-home-paths`、
 * `dsh-app-boot`、`dsh-deepseek-account` 都是 `apps/desktop/package.json` 的 devDependencies），
 * rolldown 要解析的是 `packages/<组>/<包>/lib/index.js` —— **正是这一轮自己才要写出来的文件**。
 * 全新 checkout 上它还不存在，于是 rolldown 只打一行警告：
 *
 *     [UNRESOLVED_IMPORT] Could not resolve '@deepseek-ai/dsh-home-paths' in lib/types/paths.js
 *       ╰──────────────── Module not found, treating it as an external dependency
 *
 * 然后**照常构建成功**，把那个 devDependency 当裸 import 留在产物里。
 *
 * ## 为什么必须有人来拦（症状与原因完全不相干，且本机看不出来）
 *
 * · 本机永远看不出来：`packages/<组>/<包>/lib/` 是 gitignore 的构建产物，重复构建的机器上**一直存在**，
 *   所以解析永远成功、代码被内联。只有**全新 checkout**（CI）才暴露。
 * · 打包后症状离得极远：`app.asar` 里 Electron 主进程解析不到 → 未捕获异常
 *   `ERR_MODULE_NOT_FOUND` → Electron **只弹一个模态框、stderr 一个字节都不写** →
 *   `verify:browser-host` 等满 20 秒超时，报 `the host never announced a port`。
 *   那句话里没有任何线索指向「少了个 workspace 包」。
 * · 构建日志里它只是一行 warning，混在 11K 行输出中，**exit code 仍是 0**。
 *
 * ## 判据（为什么是 `dependencies`）
 *
 * 打包后该文件位于 `resources/app.asar/lib/main.js`，Node 的解析只会走到
 * `app.asar/node_modules`（electron-builder 只把 `dependencies` 装进去；`devDependencies`
 * 一个都不装）。所以：
 *
 *     裸 import 的包名 ∈ { apps/desktop/package.json 的 dependencies 键 }
 *
 * 例外只有 `node:`/`electron`/`electron-updater` 之类的非 workspace 依赖 —— 它们同样在
 * `dependencies` 里，所以同一条规则覆盖，不需要单独白名单。
 *
 * ## 用法
 *
 * ```
 * node scripts/check-desktop-shell-bundle.mjs --harness <harness 根>
 * node scripts/check-desktop-shell-bundle.mjs --selftest     # 双向自证，不碰真实产物
 * ```
 *
 * 退出码：0 = 干净；1 = 有解析不到的裸 import（顺便把是哪个包、为什么会被丢说出来）；
 * 2 = 用法错误。
 *
 * 修法不在本脚本里，在 workflow：**构建前先 `pnpm run build:lib:host` 预热一遍**，让
 * `packages/<组>/<包>/lib/index.js` 先落盘，正式那一轮就能全部内联。为什么这是确定性的而不是碰运气：
 * 根 `tsdown.config.ts` 是 `clean: false`，预热产物不会被这一轮清掉。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 本脚本认的裸 import 前缀 —— 只盯 workspace 包，第三方包不在守卫范围。 */
export const PACKAGE_SCOPE = '@deepseek-ai/'

/**
 * 纯函数：从一个 ESM 文本里挑出**运行时可能解析不到**的裸 import。
 *
 * 只认静态与动态的裸说明符（`from "@scope/name..."` / `import("@scope/name...")`），
 * 子路径（`@deepseek-ai/dsh-api-gateway/stream-protocol`）按**包名**判定。
 *
 * @param {{ text: string, dependencies: readonly string[] }} input
 * @returns {{ specifier: string, pkg: string }[]} 违规清单（按出现顺序去重）
 */
export function findUnresolvableImports({ text, dependencies }) {
  const allowed = new Set(dependencies)
  const pattern = new RegExp(
    `(?:from\\s*|import\\s*\\(\\s*)["'](${PACKAGE_SCOPE.replace('/', '\\/')}[^"']+)["']`,
    'gu',
  )
  const seen = new Set()
  const violations = []
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1]
    const pkg = specifier.split('/').slice(0, 2).join('/')
    if (allowed.has(pkg) || seen.has(pkg)) continue
    seen.add(pkg)
    violations.push({ specifier, pkg })
  }
  return violations
}

/** 桌面端工程目录（相对 harness 根）。 */
function desktopDir(harnessRoot) {
  return join(harnessRoot, 'apps', 'desktop')
}

/** 真实检查：读 package.json 的 `main` 与 `dependencies`，再扫那个产物。 */
function check(harnessRoot) {
  const manifestPath = join(desktopDir(harnessRoot), 'package.json')
  if (!existsSync(manifestPath)) {
    console.error(`✗ 找不到 ${manifestPath} —— --harness 指对了 harness 根吗？`)
    return 2
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const devDependencies = manifest.devDependencies ?? {}
  // 产物名从上游自己的 `main` 字段取，避免上游换文件名时守成一个假判据。
  const entry = join(desktopDir(harnessRoot), String(manifest.main ?? 'lib/main.js'))
  if (!existsSync(entry)) {
    console.error(`✗ 找不到桌面端本体产物 ${entry}`)
    console.error('  正常流程里它由「构建桌面端应用目录」产出；缺它说明那一步没跑或上游改了 main 字段。')
    return 1
  }
  const violations = findUnresolvableImports({
    text: readFileSync(entry, 'utf8'),
    dependencies,
  })
  console.log(`产物            ${entry}`)
  console.log(`允许的运行时依赖 ${dependencies.join(', ')}`)
  if (violations.length === 0) {
    console.log('✓ 没有解析不到的裸 import —— app.asar 里这个文件的每个 import 都装得进 app.asar/node_modules。')
    return 0
  }
  console.error(`\n✗ ${violations.length} 个裸 import 在打包后解析不到：`)
  for (const { specifier, pkg } of violations) {
    const declared = Object.hasOwn(devDependencies, pkg)
    console.error(`  · ${specifier}${declared ? '   ← 声明在 devDependencies' : ''}`)
    if (declared) {
      console.error('      这就是「workspace devDependency 被静默 external 化」：构建时 packages/*/lib/index.js')
      console.error('      还没落盘，rolldown 把它当 external 留在产物里，而 electron-builder 不会装 devDependency。')
    }
  }
  console.error('\n  打包后的症状：Electron 主进程 ERR_MODULE_NOT_FOUND → **只弹模态框、stderr 为空** →')
  console.error('  verify:browser-host 等满 20 秒，报 `the host never announced a port`（与真因毫无关联）。')
  console.error('\n  改法：构建前先预热一遍 workspace 产物（release-desktop.yml 的「预热 workspace 的 lib 产物」）：')
  console.error('      Set-Location $env:HARNESS_ROOT; pnpm run build:lib:host')
  return 1
}

/**
 * 双向自证：不碰真实产物，只用合成文本证明「该报的报、不该报的不报」。
 * 断言转红的理由不是「跑起来没报错」，而是注入一条已知违规后必须 exit 1。
 */
function selftest() {
  const dependencies = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-gateway']
  const cases = [
    {
      name: '干净产物（真实 inlined 形态：只有 dependencies 里的裸 import）',
      text: 'import { Context } from "@deepseek-ai/cordis";\nimport { parse } from "@deepseek-ai/dsh-api-gateway/stream-protocol";\n',
      expected: 0,
    },
    {
      name: '注入一条 devDependency 裸 import（CI 真实形态）',
      text: 'import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";\n',
      expected: 1,
    },
    {
      name: '子路径按包名判定（dsh-api-gateway 在 dependencies 里 -> 不该报）',
      text: 'import { REMOTE_STREAM_MUX_PATH } from "@deepseek-ai/dsh-api-gateway/stream-protocol";\n',
      expected: 0,
    },
    {
      name: '动态 import 也要抓',
      text: 'const m = await import("@deepseek-ai/dsh-app-boot");\n',
      expected: 1,
    },
    {
      name: '非 @deepseek-ai 作用域不管（第三方由 dependencies 自己保证）',
      text: 'import WebSocket from "ws";\nimport electronUpdater from "electron-updater";\n',
      expected: 0,
    },
  ]
  let failed = 0
  for (const { name, text, expected } of cases) {
    const actual = findUnresolvableImports({ text, dependencies }).length > 0 ? 1 : 0
    const ok = actual === expected
    if (!ok) failed += 1
    console.log(`${ok ? '✓' : '✗'} ${name} -> 期望 ${expected}，实得 ${actual}`)
  }
  if (failed > 0) {
    console.error(`\n✗ 自证失败 ${failed} 条`)
    return 1
  }
  console.log('\n✓ 双向自证通过（干净放行 / 违规拦下 / 子路径与动态 import 口径正确）')
  return 0
}

function main() {
  if (process.argv.includes('--selftest')) process.exit(selftest())
  const flag = process.argv.indexOf('--harness')
  const harnessRoot = flag >= 0 ? process.argv[flag + 1] : undefined
  if (harnessRoot === undefined || harnessRoot.length === 0) {
    console.error('用法：node scripts/check-desktop-shell-bundle.mjs --harness <harness 根>')
    console.error('      node scripts/check-desktop-shell-bundle.mjs --selftest')
    process.exit(2)
  }
  process.exit(check(harnessRoot))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
