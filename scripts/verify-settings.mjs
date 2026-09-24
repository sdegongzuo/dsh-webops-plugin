/**
 * 验证便携包里预置的出厂模型配置在**真宿主**里真的生效。
 *
 * 为什么需要单独验这个：出厂配置是一份「裸 YAML」，它对不对只有 dsh 自己的
 * schemastery 说了算。写错一个字段名（比如把 `baseURL` 写成 `baseUrl`、把 `providers`
 * 写成数组）不会报错到脸上 —— `projectForm()` 只挑 schema 声明过的键，多出来的键
 * **静默丢掉**，整段配置就此作废，用户装完包打开设置页看不到任何 provider。
 * 静态检查拦不住这一类，所以 [2/3] 必须真起宿主。
 *
 * ⚠️ 配置的落点（2026-09-24 适配 dsh 0.1.7）：**不是 `home/settings.yaml`**。
 * 0.1.7 起上游把它退役了 —— `packages/settings/settings/src/index.ts` 的
 * `importLegacyDocument()` 只在启动时把 `home/settings.yaml` 一次性导入本 profile，
 * 然后改名成 `settings.yaml.imported`。设置现在的家是 **profile patch**：
 * `configEditor.documentPath` → `profileContext.patchPath` →
 * `home/profiles/desktop/cordis.patch.yml`（用户在「设置」页的每次改动也写这里，
 * 见 `packages/boot/config-editor/src/index.ts:34,49-58`）。出厂配置直接写在终点，
 * 才不必依赖一个上游明确标为「已移除」的迁移垫片。
 *
 * 断言链（全部离线，不发任何 HTTP）：
 *   profile patch 里 `llm-pi-ai` 项的 config
 *     → `@deepseek-ai/dsh-llm-pi-ai` 注册 provider 路由
 *     → `ctx.settings.describe()` 回吐「用户文档那份值」（projectForm 过了 schema，
 *        字段名写错会在这里消失 —— 这是静态检查拿不到的那一层）
 *     → `ctx.llm.listModels(route)` 列出模型（pi-ai 的 listModels 是纯本地的）
 *     → `ctx.llm.resolveModelInfo(route, model)` 解析出上下文窗口
 *   profile patch 里 `agent-default-model` 项 → `ctx.agentDefaultModel.currentSelection()`
 *
 * 用法：
 *   node scripts/verify-settings.mjs --dir <解压后的便携包根目录>
 *   node scripts/verify-settings.mjs --dir <包根> --route unisound --model u2-flash
 *   node scripts/verify-settings.mjs --dir <包根> --patch scripts/portable-profile-patch.yaml
 *
 * `--patch` 覆盖「读哪份配置」（默认 `<包根>/home/profiles/desktop/cordis.patch.yml`），
 * 用来在**还没打出包**的时候先验出厂模板本身：拿一个现成的 app 目录 + 模板跑这一遍，
 * 配置写错了当场就知道。
 *
 * 退出码 0 = 通过，1 = 失败。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { materializeRuntimeDir } from './desktop-runtime.mjs'
import { startPackagedDesktopHost } from './run-packaged-host.mjs'

const args = process.argv.slice(2)
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

if (readArg('dir') === undefined) {
  console.error('用法: node scripts/verify-settings.mjs --dir <解压后的便携包根目录> [--route unisound] [--model u2-flash] [--patch <出厂配置>]')
  process.exit(1)
}

const packageRoot = resolve(readArg('dir'))
const route = readArg('route') ?? 'unisound'
const modelId = readArg('model') ?? 'u2-flash'

const appRoot = join(packageRoot, 'app')
/**
 * profile patch 在**便携包**里的相对位置（相对包根）。
 * 便携版的 `DSH_HOME` = `<包根>/home`，所以文档落点是 `<包根>/home/profiles/desktop/cordis.patch.yml`。
 * ⚠️ 别把这个相对路径直接套到探测用的临时 home 上：那里的 `DSH_HOME` 就是临时根本身，
 * 落点是 `<临时根>/profiles/desktop/cordis.patch.yml` —— 差一层 `home/`，
 * 写错了 patch 根本不被读，症状是「配置全没生效」而不是「路径不存在」。
 */
const PACKAGE_PATCH_REL = join('home', 'profiles', 'desktop', 'cordis.patch.yml')
const patchPath = resolve(readArg('patch') ?? join(packageRoot, PACKAGE_PATCH_REL))
const failures = []

function check(ok, message) {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures.push(message)
}

// ---------------------------------------------------------------------------
// [1/3] 出厂配置的静态断言：先把「文件在不在、关键字段写没写对」证掉，
//       再看宿主那一层。两层分开，失败时能立刻判断是配置写错还是接线断了。
// ---------------------------------------------------------------------------

console.log('\n[1/3] 出厂 profile patch 的静态检查')

if (!existsSync(patchPath)) {
  console.error(`\n找不到 ${patchPath} —— 便携包没带出厂配置，后续无意义。`)
  process.exit(1)
}
const patchText = readFileSync(patchPath, 'utf8')

/** 第一个 `<key>: <scalar>` 的值。 */
const valueOf = (key) => patchText.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'mu'))?.[1]

/**
 * 取某个 `<key>:` 映射块**缩进范围内**的行。
 * @param key - 映射键名，如 `models`。
 * @returns 块内每一行原文（不含键行本身）。
 */
function blockLines(key) {
  const lines = patchText.split(/\r?\n/)
  const start = lines.findIndex(line => new RegExp(`^\\s*${key}:\\s*$`).test(line))
  if (start === -1) return []
  const indent = lines[start].match(/^\s*/)[0].length
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    if (lines[i].match(/^\s*/)[0].length <= indent) break
    out.push(lines[i])
  }
  return out
}

// 顶层 patch 项与被列出的模型**都**长成 `- id: xxx`，所以模型必须只在 `models:` 块内数，
// 否则会把 `- id: llm-pi-ai` 也算成一个模型。顶层项则反过来只认**零缩进**的。
const declaredModels = blockLines('models')
  .map(line => line.match(/^\s*-\s+id:\s*(\S+)\s*$/)?.[1])
  .filter(id => id !== undefined)
const patchEntries = [...patchText.matchAll(/^-\s+id:\s*(\S+)\s*$/gmu)].map(match => match[1])
const entryNames = new Map(
  // 允许 id 与 name 之间夹空行（dsh 自己重写过这份文件，布局不保证逐字一致）。
  [...patchText.matchAll(/^-\s+id:\s*(\S+)[^\n]*\n(?:\s*\n)*\s*name:\s*"?([^"\n]+?)"?\s*$/gmu)]
    .map(match => [match[1], match[2].trim()]),
)

check(patchEntries.includes('llm-pi-ai'), `顶层 patch 项里有 llm-pi-ai（实得 ${JSON.stringify(patchEntries)}）`)
check(patchEntries.includes('agent-default-model'), '顶层 patch 项里有 agent-default-model')
// `name` 必须带上：config-editor 按「id 相同且 name 相同」认行（`index.ts:105-107`），
// 少了 name 就会在用户第一次改设置时**另起一行**、留下两条同 id 的 patch。
check(
  (entryNames.get('llm-pi-ai') ?? '').includes('llm-pi-ai')
  && (entryNames.get('agent-default-model') ?? '').includes('agent-default-model'),
  `两个 patch 项都带 name（实得 ${JSON.stringify([...entryNames])}）`,
)
check(patchText.includes(`${route}:`), `有 provider 路由 ${route}`)
check(valueOf('api') === 'openai-completions', `api = openai-completions（实际 ${String(valueOf('api'))}）`)
check(
  valueOf('baseURL') === 'https://maas-api.unisound.com/v1',
  `baseURL 指向云知声（实际 ${String(valueOf('baseURL'))}）`,
)
check(valueOf('apiKeyEnv') === 'UNISOUND_API_KEY', `凭据引用名 = UNISOUND_API_KEY（实际 ${String(valueOf('apiKeyEnv'))}）`)
check(declaredModels.includes(modelId), `声明的模型里有 ${modelId}（共 ${declaredModels.length} 个）`)
// 默认模型是**两个字段**：provider 与 model，且必须指向本文件里声明过的那个模型，
// 否则用户开局第一句话就会被路由到一个不存在的模型上。
check(valueOf('provider') === route, `agent-default-model.provider = ${route}（实际 ${String(valueOf('provider'))}）`)
check(valueOf('model') === modelId, `agent-default-model.model = ${modelId}（实际 ${String(valueOf('model'))}）`)

// ---------------------------------------------------------------------------
// [2/3] 起真宿主，让 dsh 自己解析这份 patch。
// ---------------------------------------------------------------------------

console.log('\n[2/3] 起宿主读这份配置，让 dsh 自己解析')

const materialized = materializeRuntimeDir(appRoot)
const runtimeDir = materialized.runtimeDir

const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-verify-settings-')))
const profileDir = join(home, 'profiles', 'desktop')
const probeDir = join(profileDir, 'node_modules', 'settings-probe')
const reportPath = join(home, 'report.json')
mkdirSync(probeDir, { recursive: true })

// 只把**出货的那份** patch 拷进来：验的就是包里那个文件，但让它落在一个临时 home 上，
// 避免把待验的包「启动过」（verify:portable 有同样要求）。
// 落点是 `join(profileDir, 'cordis.patch.yml')`，**不是**包内那个相对路径 —— 临时 home 就是
// DSH_HOME，没有多出来的那层 `home/`。
copyFileSync(patchPath, join(profileDir, 'cordis.patch.yml'))

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

  /**
   * 轮询直到 \`fn\` 返回非 undefined，或超时。
   * @returns \`[值, 最后一次错误]\`；超时时值为 undefined。
   */
  const until = async (fn, ms) => {
    const deadline = Date.now() + ms
    let lastError
    for (;;) {
      try {
        const value = await fn()
        if (value !== undefined) return [value, undefined]
      } catch (error) { lastError = String(error?.message ?? error) }
      if (Date.now() > deadline) return [undefined, lastError]
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }

  // 三个服务都在 dsh-base 里：llm 是适配器运行时，settings 是用户配置文档，
  // agentDefaultModel 是默认模型选择。缺任何一个都会让 inject 永不回调。
  ctx.inject(['llm', 'settings', 'agentDefaultModel'], async (c) => {
    report.injected = true
    flush()

    try {
      // 落点先自证：0.1.7 的家就是 profile patch。上游若再挪家，这里会先红，
      // 而不是让「配置读不到」伪装成「配置写错了」。
      report.documentPath = c.get('settings').documentPath
    } catch (error) {
      report.describeThrew = String(error?.stack ?? error?.message ?? error)
    }

    // ① 模型注册。**必须轮询**：pi-ai 把适配器注册在它自己的 settings 注入回调里，
    //    与本回调之间没有任何先后保证（实测本回调先跑，此时路由还不存在）。
    const [models, modelError] = await until(async () => {
      const list = await c.get('llm').listModels(config.route)
      return list.length > 0 ? list : undefined
    }, 20000)
    if (models === undefined) {
      report.llmThrew = modelError ?? \`listModels(\${config.route}) 20s 内一直为空\`
    } else {
      report.models = models.map(model => model.id)
      report.modelNames = Object.fromEntries(models.map(model => [model.id, model.name]))
      try {
        const info = await c.get('llm').resolveModelInfo(config.route, config.model)
        report.resolved = { id: info.id, name: info.name, contextWindow: info.context?.contextWindow ?? null }
      } catch (error) {
        report.resolveThrew = String(error?.message ?? error)
      }
    }

    // ② 设置描述符。**顺序有讲究：必须在 pi-ai 起来之后再读。**
    //    describe() 只列「已 ACTIVE 且带 volatile 表单」的条目，而 llm-pi-ai 在这个
    //    树里是**最后**一批激活的（它自己 inject settings）—— 早读会拿到一份**没有它**
    //    的列表，症状是「配置明明生效了（18 个模型都注册了），描述符里却查无此条」。
    //    所以按同一个 20s 节奏轮询它出现，而不是读一次就走。
    const [descriptors, describeError] = await until(() => {
      const list = c.get('settings').describe()
      return list.some(row => row.ns === 'llm-pi-ai') ? list : undefined
    }, 20000)
    if (descriptors === undefined) {
      // 诊断：describe() 会**静默丢掉**不可寻址的条目（无 volatile 表单 / 未 ACTIVE /
      // id 在同一棵树里重复）。丢掉时症状只是「设置页里没有它」，所以把 loader 侧的真身
      // 一起报回来，免得下一次又要靠猜。
      const loaderSide = [...c.root.loader.entries()]
        .filter(entry => entry.options.id === 'llm-pi-ai')
        .map(entry => ({
          state: entry.fiber?.state ?? null,
          hasConfig: entry.fiber?.runtime?.Config !== undefined,
          parentEntryId: entry.parent?.tree?.ctx?.fiber?.entry?.id ?? null,
        }))
      report.describeThrew = \`\${describeError ?? 'no error'}\`
        + \`；loader 侧 llm-pi-ai 条目 \${JSON.stringify(loaderSide)}\`
        + \`；configEditor.entries() 命中 \${String(c.get('configEditor').entries().filter(entry => entry.options.id === 'llm-pi-ai').length)} 个（总条目 \${String([...c.root.loader.entries()].length)}）\`
    } else {
      report.namespaces = descriptors.map(row => row.ns)
      const llm = descriptors.find(row => row.ns === 'llm-pi-ai')
      // user = 用户文档那一层；value = 与内置层合并后的生效值。
      // 两个都取：user 证明「是我们那份文件给的值」，value 证明「真的进入了运行中的条目」。
      report.llmDescriptor = { user: llm.user, value: llm.value }
      const fallback = descriptors.find(row => row.ns === 'agent-default-model')
      if (fallback !== undefined) report.defaultDescriptor = fallback.user
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

const host = startPackagedDesktopHost({
  runtimeDir,
  profileDir,
  env: process.env,
})
let ready
try {
  ready = await host.ready
  check(true, `宿主启动成功（${ready.url}）`)
} catch (error) {
  check(false, `宿主启动：${error instanceof Error ? error.message : String(error)}`)
}

let report
if (ready !== undefined) {
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
if (report?.describeThrew !== undefined) check(false, `读 settings 描述符失败：${report.describeThrew}`)
if (report?.llmThrew !== undefined) check(false, `llm 解析抛异常：${report.llmThrew}`)
if (report?.resolveThrew !== undefined) check(false, `解析模型信息抛异常：${report.resolveThrew}`)
if (report?.defaultThrew !== undefined) check(false, `读默认模型抛异常：${report.defaultThrew}`)

// 上游若把设置的家再挪走，这里先红 —— 「配置读不到」不该伪装成「配置写错了」。
check(
  typeof report?.documentPath === 'string'
  && report.documentPath.replace(/\\/g, '/').endsWith('/profiles/desktop/cordis.patch.yml'),
  `settings 文档落点是 profile patch（实际 ${String(report?.documentPath)}）`,
)

const userRoutes = Object.keys(report?.llmDescriptor?.user?.providers ?? {})
check(
  userRoutes.includes(route),
  `profile patch 原样带到了 llm-pi-ai.providers（实得 ${JSON.stringify(userRoutes.length > 0 ? userRoutes : report?.namespaces)}）`,
)

// 这一段是**静态检查拿不到的那一层**：describe() 的 user 是过了 pi-ai Config schema 的
// projectForm 投影 —— 字段名写错就会在这里消失，而不是在启动日志里报错。
const userProfile = report?.llmDescriptor?.user?.providers?.[route]
check(userProfile?.api === 'openai-completions', `schema 收下了 api（实际 ${String(userProfile?.api)}）`)
check(
  userProfile?.baseURL === 'https://maas-api.unisound.com/v1',
  `schema 收下了 baseURL（实际 ${String(userProfile?.baseURL)}）`,
)
check(userProfile?.apiKeyEnv === 'UNISOUND_API_KEY', `schema 收下了 apiKeyEnv（实际 ${String(userProfile?.apiKeyEnv)}）`)
check(
  typeof userProfile?.displayName === 'string' && userProfile.displayName.length > 0,
  `schema 收下了 displayName（实际 ${String(userProfile?.displayName)}）`,
)
const userModels = Array.isArray(userProfile?.models) ? userProfile.models : []
check(
  userModels.length === declaredModels.length,
  `schema 收下了全部 ${declaredModels.length} 个模型（实得 ${userModels.length}）`,
)
check(
  userModels.every(model => typeof model?.contextWindow === 'number' && model.contextWindow > 0),
  '每个模型都带上了正整数 contextWindow',
)

// user 层有值只说明文件被读到了；value 层有值才说明 patch 真的作用到了运行中的条目。
const valueRoutes = Object.keys(report?.llmDescriptor?.value?.providers ?? {})
check(
  valueRoutes.includes(route),
  `运行中的 llm-pi-ai 条目里也有这个路由（实得 ${JSON.stringify(valueRoutes)}）`,
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

await host.stop()
materialized.cleanup()
rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n✗ verify:settings 未通过（${failures.length} 项）`)
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
console.log(`\n✓ verify:settings 通过：出厂配置在真宿主里注册了 ${route}，默认模型 ${route}/${modelId}`)
