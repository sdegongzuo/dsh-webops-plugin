/**
 * 剥掉 dsh-coding-subscription-oauth 自带 bundle patch 里的 `agent-default-model` 段。
 *
 * ## 为什么必须剥
 *
 * 该插件的 `cordis.patch.yml`（官方 tgz 原样）写死了：
 *
 *   - id: agent-default-model
 *     config:
 *       provider: grok-build
 *       model: grok-4.6
 *
 * 它是**bundle patch**，在 profile 组合顺序里排在用户 patch **之前**（见 dsh-app-boot
 * 的 `profile.ts` 文件头：bundles 按 dsh.profile.bundles 顺序叠加 → 再 profile 自己的
 * cordis.patch.yml → 再 launcher 层）。实测 `--dump-config`：即使出厂 patch 完全不写模型，
 * 组合结果仍带 `provider: grok-build / model: grok-4.6`。
 *
 * 这与仓库的出厂策略直接冲突：**公开包不预置任何模型 provider**（AGENTS/验收记录口径，
 * `scripts/verify-settings.mjs` 有反向断言守着，`src/verify-settings.test.ts` 覆盖）。
 * 不处理的话，每个装了本包的机器首启默认模型都会被指向一条尚未登录的订阅路由。
 *
 * ## 做法与边界
 *
 * 只删那一段 YAML 条目，**保留 `insert: llm-grok-build-oauth`**（插件本体挂载靠它）。
 * 与 `sidebar-host-compatibility.mjs` 同思路：官方 tgz 不改，物化阶段就地改写并留回执；
 * 判据是「那一段的精确文本必须出现且仅出现一次」，插件升级换了写法就**拒绝**而不是猜。
 *
 * ## 升级注意
 *
 * 插件新版本若仍在 patch 里写死默认模型，剥除继续有效；若上游改成不写（更好），
 * `applyCodingOAuthPatchCompatibility` 会返回 `unchanged: true` 且不报错 —— 这是允许的，
 * 因为「没有那一段」本来就是我们想要的结果。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 已知的、需要剥除的默认模型段（含插件注释行；精确匹配，不猜）。 */
const PRESET_DEFAULT_MODEL_BLOCK = `- id: agent-default-model
  config:
    provider: grok-build
    model: grok-4.6
`

/** 必须保留的挂载行：剥离后若它消失，说明改坏了，当场失败。 */
const REQUIRED_INSERT_MARKER = 'llm-grok-build-oauth'

export const CODING_OAUTH_PATCH_COMPAT = 'strip-preset-default-model-v1'

/**
 * 从 patch 文本里删掉预设默认模型段。
 * @param {string} source - 插件 `cordis.patch.yml` 原文。
 * @returns {{ text: string, stripped: boolean }}
 */
export function stripPresetDefaultModel(source) {
  const count = source.split(PRESET_DEFAULT_MODEL_BLOCK).length - 1
  if (count === 0) return { text: source, stripped: false }
  if (count > 1) {
    throw new Error(`编码订阅插件的默认模型段出现 ${count} 次（期望 1 次），拒绝自动改写；请核对上游 patch 形状。`)
  }
  const text = source.replace(PRESET_DEFAULT_MODEL_BLOCK, '')
  if (!text.includes(REQUIRED_INSERT_MARKER)) {
    throw new Error(`剥离默认模型段后 ${REQUIRED_INSERT_MARKER} 挂载行消失，拒绝写入；请核对上游 patch 形状。`)
  }
  return { text, stripped: true }
}

/**
 * 物化阶段就地适配插件 patch，并写回执文件。
 * @param {string} pluginDir - 已解包插件目录。
 * @returns {{ changed: boolean, unchanged?: boolean, patch?: string, plugin?: string, originalSha256?: string, adaptedSha256?: string }}
 */
export function applyCodingOAuthPatchCompatibility(pluginDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  if (pkg.name !== 'dsh-coding-subscription-oauth') {
    throw new Error(`该 patch 兼容补丁仅适用于 dsh-coding-subscription-oauth，收到 ${pkg.name}`)
  }
  const entry = join(pluginDir, 'cordis.patch.yml')
  const before = readFileSync(entry, 'utf8')
  const { text: after, stripped } = stripPresetDefaultModel(before)
  if (!stripped) return { changed: false, unchanged: true }

  const backup = join(pluginDir, 'cordis.preset-default-model.yml')
  if (existsSync(backup)) {
    if (readFileSync(backup, 'utf8') !== before) throw new Error('已有备份与当前 patch 不一致，拒绝覆盖。')
  } else writeFileSync(backup, before, { flag: 'wx' })
  writeFileSync(entry, after)

  const sha256 = (value) => createHash('sha256').update(value).digest('hex')
  const receipt = {
    patch: CODING_OAUTH_PATCH_COMPAT,
    plugin: `${pkg.name}@${pkg.version}`,
    originalSha256: sha256(before),
    adaptedSha256: sha256(after),
    note: '出厂策略不预置模型：剥除插件自带 agent-default-model 段，保留 llm-grok-build-oauth 挂载。',
  }
  writeFileSync(join(pluginDir, 'dsh-host-compatibility.json'), JSON.stringify(receipt, null, 2) + '\n')
  return { changed: true, ...receipt }
}
