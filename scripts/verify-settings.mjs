/**
 * 验证便携包里预置的出厂 `settings.yaml` 在**真宿主**里真的生效。
 *
 * 为什么需要单独验这个：`home/settings.yaml` 是一份「裸 YAML」，它对不对只有 dsh
 * 自己的 schemastery 说了算。写错一个字段名（比如把 `baseURL` 写成 `baseUrl`、
 * 把 `providers` 写成数组）不会报错到脸上 —— 整段配置会被静默忽略，用户装完包打开
 * 设置页看不到任何 provider，只会觉得「这包有问题」。
 *
 * 断言链（全部离线，不发任何 HTTP）：
 *   settings.yaml 的 `llm-pi-ai:` 段落
 *     → `@deepseek-ai/dsh-llm-pi-ai` 注册 provider 路由
 *     → `ctx.llm.listModels(route)` 列出模型（pi-ai 的 listModels 是纯本地的）
 *     → `ctx.llm.resolveModelInfo(route, model)` 解析出上下文窗口
 *   `agent-default-model:` 段落 → `ctx.agentDefaultModel.currentSelection()`
 *
 * 用法：
 *   node scripts/verify-settings.mjs --dir <解压后的便携包根目录>
 *   node scripts/verify-settings.mjs --dir <包根> --route unisound --model u2-flash
 *   node scripts/verify-settings.mjs --dir <包根> --settings scripts/portable-home-settings.yaml
 *
 * `--settings` 覆盖「读哪份配置」（默认 `<包根>/home/settings.yaml`），用来在**还没打出包**
 * 的时候先验出厂模板本身：拿一个现成的 app 目录 + 模板跑这一遍，配置写错了当场就知道。
 *
 * 退出码 0 = 通过，1 = 失败。
 */

import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeRuntimeDir } from './desktop-runtime.mjs'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

if (readArg('dir') === undefined) {
  console.error('用法: node scripts/verify-settings.mjs --dir <解压后的便携包根目录> [--route unisound] [--model u2-flash]')
  process.exit(1)
}

const packageRoot = resolve(readArg('dir'))
const route = readArg('route') ?? 'unisound'
const modelId = readArg('model') ?? 'u2-flash'

const appRoot = join(packageRoot, 'app')
const settingsPath = resolve(readArg('settings') ?? join(packageRoot, 'home', 'settings.yaml'))
const failures = []

function check(ok, message) {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures.push(message)
}

// ---------------------------------------------------------------------------
// [1/3] 出厂配置的静态断言：先把「文件在不在、关键字段写没写对」证掉，
//       再看宿主那一层。两层分开，失败时能立刻判断是配置写错还是接线断了。
// ---------------------------------------------------------------------------

console.log('\n[1/3] 出厂 settings.yaml 的静态检查')

if (!existsSync(settingsPath)) {
  console.error(`\n找不到 ${settingsPath} —— 便携包没带出厂配置，后续无意义。`)
  process.exit(1)
}
const settingsText = readFileSync(settingsPath, 'utf8')

const valueOf = (key) => settingsText.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'mu'))?.[1]
// `models:` 下的 `- id: xxx` 就是这份配置声称提供的全部模型。
const declaredModels = [...settingsText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gmu)].map(match => match[1])

check(settingsText.includes('llm-pi-ai:'), '有 llm-pi-ai 段落')
check(settingsText.includes(`${route}:`), `有 provider 路由 ${route}`)
check(valueOf('api') === 'openai-completions', `api = openai-completions（实际 ${String(valueOf('api'))}）`)
check(
  valueOf('baseURL') === 'https://maas-api.unisound.com/v1',
  `baseURL 指向云知声（实际 ${String(valueOf('baseURL'))}）`,
)
check(valueOf('apiKeyEnv') === 'UNISOUND_API_KEY', `凭据引用名 = UNISOUND_API_KEY（实际 ${String(valueOf('apiKeyEnv'))}）`)
check(declaredModels.includes(modelId), `声明的模型里有 ${modelId}（共 ${declaredModels.length} 个）`)
// 默认模型是**两行**：provider 与 model，且必须指向本文件里声明过的那个模型，
// 否则用户开局第一句话就会被路由到一个不存在的模型上。
check(valueOf('provider') === route, `agent-default-model.provider = ${route}（实际 ${String(valueOf('provider'))}）`)
check(valueOf('model') === modelId, `agent-default-model.model = ${modelId}（实际 ${String(valueOf('model'))}）`)

// ---------------------------------------------------------------------------
// [2/3] 起真宿主，让 dsh 自己解析这份 YAML。
// ---------------------------------------------------------------------------

console.log('\n[2/3] 起宿主读这份配置，让 dsh 自己解析')

const materialized = materializeRuntimeDir(appRoot)
const runtimeDir = materialized.runtimeDir

const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-verify-settings-')))
const profileDir = join(home, 'profiles', 'desktop')
const probeDir = join(profileDir, 'node_modules', 'settings-probe')
const reportPath = join(home, 'report.json')
mkdirSync(probeDir, { recursive: true })

// 只把**出货的那份** settings.yaml 拷进来：验的就是包里那个文件，
// 但让它落在一个临时 home 上，避免把待验的包「启动过」（verify:portable 有同样要求）。
copyFileSync(settingsPath, join(home, 'settings.yaml'))

writeFileSync(join(probeDir, 'package.json'), `${JSON.stringify({
  name: 'settings-probe', version: '1.0.0', type: 'module', main: './index.js',
  exports: { '.': { default: './index.js' } },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)}\n`)
writeFileSync(join(probeDir, 'cordis.patch.yml'), [
  '- insert:',
  '    - id: settings-probe',
  "      name: 'settings-probe'",
  '      config:',
  `        report: '${reportPath.replace(/\\/g, '/')}'`,
  `        route: '${route}'`,
  `        model: '${modelId}'`,
  '',
].join('\n'))
writeFileSync(join(probeDir, 'index.js'), `
import { writeFileSync } from 'node:fs'

export const name = 'settings-probe'

export function apply(ctx, config) {
  const report = { injected: false }
  const flush = () => writeFileSync(config.report, JSON.stringify(report, null, 2))
  flush()

  // 三个服务都在 dsh-base 里：llm 是适配器运行时，settings 是用户配置文档，
  // agentDefaultModel 是默认模型选择。缺任何一个都会让 inject 永不回调。
  ctx.inject(['llm', 'settings', 'agentDefaultModel'], async (c) => {
    report.injected = true
    flush()
    try {
      // section() 返回的是**用户文档里的原始段落**，所以这里能顺带验「字段没被吞掉」。
      const section = c.get('settings').section('llm-pi-ai')
      report.userSection = section === undefined ? null : {
        routes: Object.keys(section.providers ?? {}),
        profile: section.providers?.[config.route] ?? null,
      }
    } catch (error) {
      report.sectionThrew = String(error?.message ?? error)
    }
    try {
      const llm = c.get('llm')
      // **必须轮询**：pi-ai 把适配器注册在它自己的 settings 注入回调里，与本回调
      // 之间没有任何先后保证（实测本回调先跑，此时路由还不存在）。等它几秒即可，
      // 一直等不到才是真问题。
      const deadline = Date.now() + 20000
      let lastError
      for (;;) {
        try {
          const models = await llm.listModels(config.route)
          report.models = models.map(model => model.id)
          report.modelNames = Object.fromEntries(models.map(model => [model.id, model.name]))
          const info = await llm.resolveModelInfo(config.route, config.model)
          report.resolved = { id: info.id, name: info.name, contextWindow: info.context?.contextWindow ?? null }
          break
        } catch (error) {
          lastError = String(error?.message ?? error)
          if (Date.now() > deadline) break
          await new Promise(resolve => setTimeout(resolve, 300))
        }
      }
      if (report.models === undefined) report.llmThrew = lastError
    } catch (error) {
      report.llmThrew = String(error?.stack ?? error?.message ?? error)
    }
    try {
      report.defaultSelection = c.get('agentDefaultModel').currentSelection()
    } catch (error) {
      report.defaultThrew = String(error?.message ?? error)
    }
    report.done = true
    flush()
  })
}
`.trim() + '\n')

writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: '@deepseek-ai/dsh-desktop-runtime',
  private: true,
  version: '0.0.0',
  dependencies: { 'settings-probe': '1.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'settings-probe'] } },
}, null, 2)}\n`)

process.env.DSH_HOME = home

const require = createRequire(join(runtimeDir, 'package.json'))
const { runDesktopHost } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-desktop-host')).href)

let host
try {
  host = await runDesktopHost(runtimeDir, profileDir, async () => {}, { allowLinkedPackages: true })
  check(true, `宿主启动成功（dsh ${host.dshVersion}）`)
} catch (error) {
  check(false, `宿主启动：${error instanceof Error ? error.message : String(error)}`)
}

let report
if (host !== undefined) {
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'))
      if (report.done === true) break
    } catch { /* 报告还没写 */ }
    if (Date.now() > deadline) break
    await new Promise(r => setTimeout(r, 500))
  }
}

// ---------------------------------------------------------------------------
// [3/3] 结论
// ---------------------------------------------------------------------------

console.log('\n[3/3] 结论')

check(report?.injected === true, '探针拿到 llm / settings / agentDefaultModel 三个服务')
if (report?.sectionThrew !== undefined) check(false, `读 settings 段落抛异常：${report.sectionThrew}`)
if (report?.llmThrew !== undefined) check(false, `llm 解析抛异常：${report.llmThrew}`)
if (report?.defaultThrew !== undefined) check(false, `读默认模型抛异常：${report.defaultThrew}`)

check(
  Array.isArray(report?.userSection?.routes) && report.userSection.routes.includes(route),
  `settings.yaml 原样带到了 llm-pi-ai.providers（实际 ${JSON.stringify(report?.userSection?.routes)}）`,
)

const gotModels = Array.isArray(report?.models) ? report.models : []
// 双向比较：少一个说明有模型没注册上，多一个说明配置里的模型被替换过。
const missing = declaredModels.filter(id => !gotModels.includes(id))
const extra = gotModels.filter(id => !declaredModels.includes(id))
check(
  missing.length === 0 && extra.length === 0,
  `注册的模型集合与出厂声明一致（声明 ${declaredModels.length} / 实得 ${gotModels.length}`
    + `${missing.length > 0 ? `，缺 ${missing.join(', ')}` : ''}${extra.length > 0 ? `，多 ${extra.join(', ')}` : ''}）`,
)

check(
  report?.resolved?.id === modelId && typeof report.resolved?.name === 'string' && report.resolved.name.length > 0,
  `resolveModelInfo(${route}, ${modelId}) 解析出模型名（实际 ${JSON.stringify(report?.resolved?.name)}）`,
)
check(
  typeof report?.resolved?.contextWindow === 'number' && report.resolved.contextWindow > 0,
  `解析出上下文窗口（实际 ${JSON.stringify(report?.resolved?.contextWindow)}）`,
)
check(
  report?.defaultSelection?.provider === route && report?.defaultSelection?.model === modelId,
  `默认模型 = ${route}/${modelId}（实际 ${JSON.stringify(report?.defaultSelection)}）`,
)

if (host !== undefined) await host.dispose()
materialized.cleanup()
rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n✗ verify:settings 未通过（${failures.length} 项）`)
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
console.log(`\n✓ verify:settings 通过：出厂配置在真宿主里注册了 ${route}，默认模型 ${route}/${modelId}`)
