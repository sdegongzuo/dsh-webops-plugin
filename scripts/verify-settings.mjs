/**
 * 验证便携包里预置的出厂配置在**真宿主**里真的生效。
 *
 * 出厂配置不再预置任何模型 provider —— 模型接入由用户在「设置 → 模型」里自行添加。
 * 这里验证两件事：
 *   1. 出厂 patch 没有偷偷预置模型 provider / 默认模型 / 凭据引用（反向断言）；
 *   2. 剩下的权限配置在真宿主里过了 schema、确实作用到运行中的条目。
 *
 * 为什么权限配置也要单独验：出厂配置是一份「裸 YAML」，它对不对只有 dsh 自己的
 * schemastery 说了算。写错一个字段名不会报错到脸上 —— `projectForm()` 只挑 schema
 * 声明过的键，多出来的键**静默丢掉**。尤其 patch 命中一行时 config 是**整块替换**，
 * 只写 defaultPreset 会把 base 层的 presets 冲成 schema 默认的两项。静态检查拦不住
 * 这一类，所以 [2/3] 必须真起宿主。
 *
 * ⚠️ 配置的落点（2026-09-24 适配 dsh 0.1.7）：**不是 `home/settings.yaml`**。
 * 0.1.7 起上游把它退役了 —— `importLegacyDocument()` 只在启动时把 `home/settings.yaml`
 * 一次性导入本 profile，然后改名成 `settings.yaml.imported`。设置现在的家是 **profile
 * patch**：`configEditor.documentPath` → `profileContext.patchPath` →
 * `home/profiles/desktop/cordis.patch.yml`。
 *
 * 断言链（全部离线，不发任何 HTTP）：
 *   profile patch 静态断言（无 provider、权限段完整）
 *     → 起真宿主解析这份 patch，`ctx.settings.describe()` 回吐权限描述符
 *     → `ctx.agentDefaultModel.currentSelection()` 不应被出厂 patch 强行指定
 *
 * 用法：
 *   node scripts/verify-settings.mjs --dir <解压后的便携包根目录>
 *   node scripts/verify-settings.mjs --dir <包根> --patch scripts/portable-profile-patch.yaml
 *
 * `--patch` 覆盖「读哪份配置」（默认 `<包根>/home/profiles/desktop/cordis.patch.yml`），
 * 用来在**还没打出包**的时候先验出厂模板本身。
 *
 * 退出码 0 = 通过，1 = 失败。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { materializeRuntimeDir } from './desktop-runtime.mjs'
import { startPackagedDesktopHost } from './run-packaged-host.mjs'

const args = process.argv.slice(2)
const keepTemp = args.includes('--keep-temp')
const readArg = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

if (readArg('dir') === undefined) {
  console.error('用法: node scripts/verify-settings.mjs --dir <解压后的便携包根目录> [--patch <出厂配置>] [--keep-temp]')
  process.exit(1)
}

const packageRoot = resolve(readArg('dir'))
const appRoot = join(packageRoot, 'app')
/**
 * profile patch 在**便携包**里的相对位置（相对包根）。
 * 便携版的 `DSH_HOME` = `<包根>/home`，所以文档落点是 `<包根>/home/profiles/desktop/cordis.patch.yml`。
 * ⚠️ 别把这个相对路径直接套到探测用的临时 home 上：那里的 `DSH_HOME` 就是临时根本身，
 * 落点是 `<临时根>/profiles/desktop/cordis.patch.yml` —— 差一层 `home/`。
 */
const PACKAGE_PATCH_REL = join('home', 'profiles', 'desktop', 'cordis.patch.yml')
const patchPath = resolve(readArg('patch') ?? join(packageRoot, PACKAGE_PATCH_REL))
const failures = []

function check(ok, message) {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures.push(message)
}

// ---------------------------------------------------------------------------
// [1/3] 出厂配置的静态断言：确认没有预置模型、权限段完整。
// ---------------------------------------------------------------------------

console.log('\n[1/3] 出厂 profile patch 的静态检查')

if (!existsSync(patchPath)) {
  console.error(`\n找不到 ${patchPath} —— 便携包没带出厂配置，后续无意义。`)
  process.exit(1)
}
const patchText = readFileSync(patchPath, 'utf8')

/** 第一个 `<key>: <scalar>` 的值。 */
const valueOf = (key) => patchText.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'mu'))?.[1]

// 顶层 patch 项与模型曾经用的 `models` 项都长成 `- id: xxx`，所以顶层项只认零缩进的。
const patchEntries = [...patchText.matchAll(/^-\s+id:\s*(\S+)\s*$/gmu)].map(match => match[1])
const entryNames = new Map(
  // 允许 id 与 name 之间夹空行（dsh 自己重写过这份文件，布局不保证逐字一致）。
  [...patchText.matchAll(/^-\s+id:\s*(\S+)[^\n]*\n(?:\s*\n)*\s*name:\s*"?([^"\n]+?)"?\s*$/gmu)]
    .map(match => [match[1], match[2].trim()]),
)

check(patchEntries.includes('permission'), `顶层 patch 项里有 permission（实得 ${JSON.stringify(patchEntries)}）`)
// `name` 必须带上：config-editor 按「id 相同且 name 相同」认行，少了 name 就会在
// 用户第一次改设置时另起一行、留下两条同 id 的 patch。
check(
  (entryNames.get('permission') ?? '').includes('dsh-permission-presets'),
  `permission 项带 name 且指向 dsh-permission-presets（实得 ${JSON.stringify([...entryNames])}）`,
)

// 反向断言：不预置任何模型 provider / 默认模型 / 凭据引用。
// 模型接入交给用户在「设置 → 模型」里自行添加，出厂 patch 不该替用户决定。
check(!patchText.includes('llm-pi-ai'), '出厂 patch 不含 llm-pi-ai provider')
check(!/^\s*providers:/mu.test(patchText), '出厂 patch 不预置 provider 路由')
check(!patchText.includes('agent-default-model'), '出厂 patch 不预置默认模型')
check(!patchText.includes('apiKeyEnv'), '出厂 patch 不写 apiKeyEnv')
check(!/unisound|maas-api/u.test(patchText), '出厂 patch 不含任何云知声残留')

// 出厂默认权限 = 自动审查（实验）。patch 命中一行时 config 是**整块替换**，所以
// presets 必须跟着重述；只写 defaultPreset 会把 base 层的三项冲成 schema 默认的两项。
check(patchText.includes('defaultPreset: auto'), `出厂默认权限 = auto（实际 ${String(valueOf('defaultPreset'))}）`)
check(/presets:\s*\n\s*read-only:/u.test(patchText), 'permission 段重述了 presets（含 read-only）')

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
        lastError = 'condition not met yet'
      } catch (error) { lastError = String(error?.message ?? error) }
      if (Date.now() > deadline) return [undefined, lastError]
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }

  // settings 服务来自 dsh-base；agentDefaultModel 用于确认出厂 patch 没有强行指定默认模型。
  ctx.inject(['settings', 'agentDefaultModel'], async (c) => {
    report.injected = true
    flush()

    // 落点先自证：0.1.7 的家就是 profile patch。上游若再挪家，这里会先红。
    try {
      report.documentPath = c.get('settings').documentPath
    } catch (error) {
      report.describeThrew = String(error?.stack ?? error?.message ?? error)
    }

    // describe() 只列「已 ACTIVE 且带 volatile 表单」的条目，且权限条目在这一批里
    // 出现得偏晚 —— 早读会拿到不完整的列表。不必等模型，但按 20s 节奏轮询
    // permission 出现，避免捕获到刚开始那一份不完整描述符。
    const [descriptors, describeError] = await until(() => {
      const list = c.get('settings').describe()
      return list.some(row => row.ns === 'permission') ? list : undefined
    }, 20000)
    if (descriptors === undefined) {
      report.describeThrew = \`\${describeError ?? 'no error'}\`
    } else {
      report.namespaces = descriptors.map(row => row.ns)
      const permission = descriptors.find(row => row.ns === 'permission')
      // user = 用户文档那一层；value = 与内置层合并后的生效值。两个都取：user 证明
      // 是出厂文件给的值，value 证明真的作用到了运行中的条目。
      if (permission !== undefined) report.permissionDescriptor = { user: permission.user, value: permission.value }
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
  gracefulOnly: keepTemp,
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

check(report?.injected === true, '探针拿到 settings / agentDefaultModel 服务')
if (report?.describeThrew !== undefined) check(false, `读 settings 描述符失败：${report.describeThrew}`)
if (report?.defaultThrew !== undefined) check(false, `读默认模型抛异常：${report.defaultThrew}`)

// 上游若把设置的家再挪走，这里先红 —— 「配置读不到」不该伪装成「配置写错了」。
check(
  typeof report?.documentPath === 'string'
  && report.documentPath.replace(/\\/g, '/').endsWith('/profiles/desktop/cordis.patch.yml'),
  `settings 文档落点是 profile patch（实际 ${String(report?.documentPath)}）`,
)

// describe() 的 user 是过了 permission Config 的 schema 投影 —— 字段名写错或 presets
// 被整块冲掉，都会在这里显形。
const permissionUser = report?.permissionDescriptor?.user
check(
  permissionUser?.defaultPreset === 'auto',
  `schema 收下了 permission.defaultPreset = auto（实际 ${String(permissionUser?.defaultPreset)}）`,
)
// presets 不是 volatile 字段：describe 的 user 只投影 volatile 表单时它本就不出现，
// 那时这条断言无从谈起（静态检查已兜底）。它一旦出现，就必须仍是完整三项。
if (permissionUser?.presets !== undefined) {
  check(
    Object.keys(permissionUser.presets).length === 3,
    `permission.presets 仍是三项（实际 ${JSON.stringify(Object.keys(permissionUser.presets))}）`,
  )
}

// user 层有值只说明文件被读到了；value 层有值才说明 patch 真的作用到了运行中的条目。
check(
  report?.permissionDescriptor?.value?.defaultPreset === 'auto',
  `运行中的 permission 条目 defaultPreset = auto（实际 ${String(report?.permissionDescriptor?.value?.defaultPreset)}）`,
)

// 出厂 patch 不该替用户指定默认模型：currentSelection 可能是 null（未指定），
// 但若非 null，就绝不能指向被移除的 unisound 路由。
const selection = report?.defaultSelection
check(
  selection === null || selection === undefined || selection?.provider !== 'unisound',
  `默认模型未被出厂 patch 指向 unisound（实际 ${JSON.stringify(selection)}）`,
)

await host.stop()
if (keepTemp) console.log(`临时目录保留：${home}`)
else {
  materialized.cleanup()
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\n✗ verify:settings 未通过（${failures.length} 项）`)
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
console.log('\n✓ verify:settings 通过：出厂配置无预置模型，权限配置在真宿主里生效')
