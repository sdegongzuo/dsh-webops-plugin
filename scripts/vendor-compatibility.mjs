/**
 * 出厂 profile 的「精确版本豁免」（`compatibility.json`）。
 *
 * 背景（2026-11-04，v0.2.23 CI 首次暴露）：`dsh-workbuddy-connect@0.7.9` 在 package.json
 * 里把 6 个 `@deepseek-ai/dsh-*` peer **钉成精确版 `0.2.1-rc.2`**，而随包运行时是
 * `0.2.2-alpha.3`。宿主的 `evaluatePluginCompatibility` 判不满足 → `loadProfileDirectory`
 * 把这个 bundle **静默跳过**（只进 `skippedBundles`，不抛错）。症状不是启动失败，而是：
 * 插件功能整块消失、`window.__DSH_BOOT__` 里没有它的 client row —— 我们的
 * `verify-release-portable` 最后是靠「客户端加载图缺少 dsh-workbuddy-connect」才发现的。
 *
 * 上游给的正规出路就是 profile 目录下的 `compatibility.json`：把
 * `<包名@精确版本>` 映射到允许的**精确 DSH 版本**，等于显式承认「这个组合我担风险」。
 * 这不是绕过判据 —— 判据照旧执行，豁免是上游设计的数据面。
 *
 * 判定**必须**用宿主自己的实现：这里动态 import 随包运行时里的
 * `@deepseek-ai/dsh-app-boot`，不自己复刻 semver 语义（`includePrerelease: true`、
 * `engines.dsh` 优先于 peers、`workspace:` 前缀替换等细节，复刻一遍就等于埋分叉）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 与宿主 `PROFILE_COMPATIBILITY_FILENAME` 同名；写错名字等于没写。 */
export const COMPATIBILITY_FILE = 'compatibility.json'

/** 随包运行时里 app-boot 的入口；宿主判定与它同一份字节。 */
function appBootEntry(appDir) {
  return join(appDir, 'resources', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
}

/**
 * 载入随包运行时的兼容性判定实现。
 * @param appDir - 已组装好的 `app/` 目录（含 `resources/dsh`）。
 * @returns app-boot 的具名导出集合。
 * @throws 当 `app/` 里没有随包运行时（打包顺序错，或路径传成了源码目录）。
 */
export async function loadHostCompatibility(appDir) {
  const entry = appBootEntry(appDir)
  if (!existsSync(entry)) throw Error(`随包运行时缺少 app-boot：${entry}`)
  return import(pathToFileURL(entry).href)
}

/**
 * 算出这些插件里哪些需要精确版本豁免（只读，不落盘）。
 * @param options.appDir - 已组装的 `app/` 目录。
 * @param options.profileDir - 出厂 profile 目录（插件必须已 materialize）。
 * @param options.runtimeVersion - 随包 DSH 版本，如 `0.2.2-alpha.3`。
 * @param options.names - 待检查的包名（profile 里 `dsh.profile.bundles` 的厂商行）。
 * @returns `exemptions` 为需要写入的记录（空对象＝全都满足）；`issues` 为每处不满足的明细。
 * @throws 当某包在 profile 里没有 package.json（bundles 登记了却没物化，属组装缺陷）。
 */
export async function planVersionExemptions({ appDir, profileDir, runtimeVersion, names }) {
  const { evaluatePluginCompatibility, validatePluginVersionExemption } = await loadHostCompatibility(appDir)
  const exemptions = {}
  const issues = []
  for (const name of names) {
    const manifestPath = join(profileDir, 'node_modules', name, 'package.json')
    if (!existsSync(manifestPath)) throw Error(`bundles 登记了 ${name}，但 profile 里没有它的 package.json：${manifestPath}`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion)
    if (issue === undefined) continue
    const key = `${issue.name}@${issue.version}`
    // 用宿主自己的校验器验键形状：它读回来时用的是同一套规则。
    validatePluginVersionExemption(key, runtimeVersion)
    exemptions[key] = [runtimeVersion]
    issues.push(issue)
  }
  return { exemptions, issues }
}

/**
 * 把需要的豁免写进出厂 profile（没有需要的时候**不创建文件**）。
 * @param options - 同 {@link planVersionExemptions}。
 * @returns 写入的记录；空对象表示没写文件。
 */
export async function writeProfileExemptions(options) {
  const { exemptions, issues } = await planVersionExemptions(options)
  if (issues.length === 0) return exemptions
  const filename = join(options.profileDir, COMPATIBILITY_FILE)
  // 格式与宿主 `setProfileVersionExemption` 落盘一致（2 空格缩进 + 结尾换行），
  // 免得同一份语义在两种排版之间来回改写。
  writeFileSync(filename, `${JSON.stringify(exemptions, undefined, 2)}\n`)
  for (const issue of issues) {
    console.log(`  + ${COMPATIBILITY_FILE}: ${issue.name}@${issue.version} 豁免到 DSH ${issue.runtimeVersion}`
      + `（要求 ${JSON.stringify(issue.requirements)}，插件 peer 钉死精确版，不豁免会被宿主静默跳过）`)
  }
  return exemptions
}
