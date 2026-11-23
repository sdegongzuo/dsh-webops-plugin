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
 *
 * ## 为什么 count===0 不能直接放行
 *
 * 精确块匹配只在「上游一字未改」时命中。若上游把 `model: grok-4.6` 抬成
 * `grok-4.7`（或改动缩进、加字段），精确块失配 → 原实现走 fail-open 返回
 * `stripped: false`，物化照常成功、打包照常通过，而 `provider: grok-build`
 * 已经悄悄回到出厂组合里。这比一开始就没做剥除更糟：回执会显示「无需改动」，
 * 没人会去查。
 *
 * 所以 count===0 时追加一条**排除式断言**：剥除目标的招牌标记不得再出现。
 * 命中即「上游换了写法」→ 抛错拒绝，让升级必须有人看一眼。这样「上游真的
 * 不再写默认模型」（良性）与「上游换了版本号但仍写默认模型」（需处理）就被
 * 区分开了。
 *
 * @param {string} source - 插件 `cordis.patch.yml` 原文。
 * @returns {{ text: string, stripped: boolean }}
 */
export function stripPresetDefaultModel(source) {
  const count = source.split(PRESET_DEFAULT_MODEL_BLOCK).length - 1
  if (count === 0) {
    // fail-closed：没有精确块，但仍有 agent-default-model 条目 → 上游改了写法。
    const hasRow = /^\s*-\s+id:\s*agent-default-model\s*$/mu.test(source)
    const hasGrokProvider = /provider:\s*["']?grok-build["']?\s*$/mu.test(source)
    if (hasRow || hasGrokProvider) {
      throw new Error(
        '编码订阅插件的默认模型段形状已变化（精确块未命中，但仍检测到 agent-default-model / grok-build）：'
          + '拒绝静默跳过，否则预设默认模型会重新污染出厂组合。请核对上游 cordis.patch.yml 并更新 '
          + 'PRESET_DEFAULT_MODEL_BLOCK。',
      )
    }
    return { text: source, stripped: false }
  }
  if (count > 1) {
    throw new Error(`编码订阅插件的默认模型段出现 ${count} 次（期望 1 次），拒绝自动改写；请核对上游 patch 形状。`)
  }
  const text = source.replace(PRESET_DEFAULT_MODEL_BLOCK, '')
  if (!text.includes(REQUIRED_INSERT_MARKER)) {
    throw new Error(`剥离默认模型段后 ${REQUIRED_INSERT_MARKER} 挂载行消失，拒绝写入；请核对上游 patch 形状。`)
  }
  // 剥完再确认目标确实消失，防止 replace 匹配到别处却漏掉真正那行。
  if (/provider:\s*["']?grok-build["']?\s*$/mu.test(text)) {
    throw new Error('剥离后仍残留 grok-build 默认模型行，拒绝写入；请核对上游 patch 形状。')
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

/**
 * ## 第二个补丁：抵消上游删除 `assertUsableApiKey` 导出
 *
 * DSH 0.2.3-alpha.2 的 `@deepseek-ai/dsh-llm` 把 `assertUsableApiKey` 与
 * `normalizeApiKey` 一并删了（旧基线 `packages/llm/llm/src/index.ts:166`，新基线零命中），
 * 也没有替代导出。插件 0.8.8 的 bundle 顶部是静态 `import { assertUsableApiKey, ... }`，
 * ESM 在**实例化阶段**就校验导出名，于是整层导入失败：
 *
 *   llm-grok-build-oauth (dsh-coding-subscription-oauth): failed to import:
 *   SyntaxError: The requested module '@deepseek-ai/dsh-llm' does not provide an export named
 *   'assertUsableApiKey'
 *
 * 症状极具误导性 —— 宿主照常 ready、界面照常起来，只是设置页少一张「账户与模型」卡片。
 *
 * 做法：把 import 那一行的 `assertUsableApiKey` 换成两个仍在导出的依赖
 * （`LlmError`、`INVALID_CREDENTIAL_CODE`，`index.ts` 里 `export * from './error.ts'`），
 * 并在 import 之后内联一个等价实现；**调用点一个不改**（函数声明提升，本地同名函数直接接住）。
 * 内联实现照抄上游语义：trim 后必须是非空、且只含可打印 ASCII（空格除外），否则抛
 * `LlmError(..., INVALID_CREDENTIAL_CODE)`，报错文案与上游逐字一致。
 *
 * 边界：判据是那一行 import 的**精确文本必须出现且仅出现一次**；插件换了写法、或已经
 * 打过本补丁（哨兵注释在场）就走 `unchanged`，绝不猜。原始文件留一份
 * `lib/index.pre-inline-assert.js` 便于核对与回滚。
 */
export const CODING_OAUTH_LIBRARY_COMPAT = 'dsh-0.2.3-compat-v1'

const LLM_IMPORT_EXPECTED = 'import { assertUsableApiKey, RetryPolicySchema } from "@deepseek-ai/dsh-llm";'
const LLM_IMPORT_PATCHED = 'import { INVALID_CREDENTIAL_CODE as __dshInvalidCredentialCode, LlmError as __dshLlmError, RetryPolicySchema } from "@deepseek-ai/dsh-llm";'
const INLINE_SENTINEL = '/* dsh-webops: inline-assert-usable-api-key-v1 */'
/** 调用点必须仍在：只删 import 不补实现会变成运行时 ReferenceError，比导入失败更难查。 */
const REQUIRED_CALL_SITE = 'return assertUsableApiKey('

const INLINE_DEFINITION = [
  INLINE_SENTINEL,
  'function assertUsableApiKey(raw, pkg, ref) {',
  '  const value = String(raw ?? "").trim();',
  '  if (value.length > 0 && /^[\\x21-\\x7E]+$/.test(value)) return value;',
  '  throw new __dshLlmError(',
  '    value.length === 0',
  '      ? pkg + ": the API key resolved from " + ref + " is blank; set " + ref + " to the raw key (the web Models page writes it) or export it in the launching environment"',
  '      : pkg + ": the API key resolved from " + ref + " contains characters no HTTP header can carry; set " + ref + " to the raw key alone (the web Models page writes it)",',
  '    __dshInvalidCredentialCode,',
  '  );',
  '}',
].join('\n')

/**
 * 在插件 bundle 源码上做替换（纯函数，便于单测）。
 * @param {string} source - `lib/index.js` 原文。
 * @returns {{ text: string, patched: boolean }}
 */
export function inlineRemovedLlmExports(source) {
  if (source.includes(INLINE_SENTINEL)) return { text: source, patched: false }
  const occurrences = source.split(LLM_IMPORT_EXPECTED).length - 1
  if (occurrences !== 1) {
    throw new Error(`编码订阅插件的 dsh-llm 导入行出现 ${occurrences} 次（期望 1 次），拒绝自动改写；请核对上游 bundle 形状。`)
  }
  const patched = source.replace(LLM_IMPORT_EXPECTED, `${LLM_IMPORT_PATCHED}\n${INLINE_DEFINITION}`)
  if (!patched.includes(REQUIRED_CALL_SITE)) {
    throw new Error('内联 assertUsableApiKey 后找不到原调用点，拒绝写入；请核对上游 bundle 形状。')
  }
  if (patched.split('assertUsableApiKey(').length - 1 < 2) {
    throw new Error('内联后没有形成「定义 + 调用」两处，拒绝写入。')
  }
  return { text: patched, patched: true }
}

/**
 * ## 第二处替换：cordis 4.2 不再允许未声明 inject 就读 `ctx.root`
 *
 * 0.2.3 把 cordis 从 4.1.0 升到 4.2.0-alpha.1，context 的属性访问改成 Proxy 拦截：
 * 既不是自有属性、又没在 `inject` 里声明过，读 `ctx.root` 直接抛
 * `cannot get property "root" without inject`（`cordis/lib/index.js` 的 ReflectService.handler）。
 * 插件 `resolveCodingOAuthScope()` 第一行就是 `const root = context.root;`，于是挂载失败 ——
 * 症状与上一处一样隐蔽：宿主 ready、界面正常，只是这条路由没上。
 *
 * 应用根 context 在 cordis 里以 `Symbol.for("cordis.root")` 作为**自有属性**挂在自己身上
 * （`Context.root` 就是同一个符号，`this[symbols.root] = self`），按符号读等价、且不经拦截。
 * 保留 `context.root` 作首选：老宿主（cordis 4.1）没有这个符号键，但那条路径本来是通的。
 */
const ROOT_ACCESS_EXPECTED = 'function resolveCodingOAuthScope(context) {\n  const root = context.root;'
const ROOT_ACCESS_PATCHED = [
  'function resolveCodingOAuthScope(context) {',
  '  let root;',
  '  try {',
  '    root = context.root;',
  '  } catch {',
  '    /* dsh-webops: cordis 4.2 未声明 inject 时拦截 ctx.root，改按符号读自有属性 */',
  '    root = context[Symbol.for("cordis.root")];',
  '  }',
].join('\n')
const ROOT_SYMBOL_SENTINEL = 'Symbol.for("cordis.root")'

/**
 * @param {string} source - 插件 bundle 源码。
 * @returns {{ text: string, patched: boolean }}
 */
export function routeRootAccessThroughSymbol(source) {
  if (source.includes(ROOT_SYMBOL_SENTINEL)) return { text: source, patched: false }
  const occurrences = source.split(ROOT_ACCESS_EXPECTED).length - 1
  if (occurrences !== 1) {
    throw new Error(`编码订阅插件的 resolveCodingOAuthScope 取 root 处出现 ${occurrences} 次（期望 1 次），拒绝自动改写；请核对上游 bundle 形状。`)
  }
  return { text: source.replace(ROOT_ACCESS_EXPECTED, ROOT_ACCESS_PATCHED), patched: true }
}

/**
 * 物化阶段就地适配插件 bundle，并把结果合并进同一份回执文件。
 * @param {string} pluginDir - 已解包插件目录。
 * @returns {{ changed: boolean, unchanged?: boolean, plugin?: string }} 回执摘要。
 */
export function applyCodingOAuthLibraryCompatibility(pluginDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  if (pkg.name !== 'dsh-coding-subscription-oauth') {
    throw new Error(`该 bundle 兼容补丁仅适用于 dsh-coding-subscription-oauth，收到 ${pkg.name}`)
  }
  const entry = join(pluginDir, 'lib', 'index.js')
  const before = readFileSync(entry, 'utf8')

  // 依次应用两处替换；各自 fail-closed、各自幂等。任一命中即视为改过。
  const applied = []
  let after = before
  const inline = inlineRemovedLlmExports(after)
  if (inline.patched) { after = inline.text; applied.push('inline-assert-usable-api-key') }
  const root = routeRootAccessThroughSymbol(after)
  if (root.patched) { after = root.text; applied.push('root-via-symbol') }
  if (applied.length === 0) return { changed: false, unchanged: true }

  const backup = join(pluginDir, 'lib', 'index.pre-inline-assert.js')
  if (existsSync(backup)) {
    if (readFileSync(backup, 'utf8') !== before) throw new Error('已有备份与当前 lib 不一致，拒绝覆盖。')
  } else writeFileSync(backup, before, { flag: 'wx' })
  writeFileSync(entry, after)

  const sha256 = (value) => createHash('sha256').update(value).digest('hex')
  // 与 strip 补丁共用同一份回执：合并写入，不覆盖已有字段。
  const receiptPath = join(pluginDir, 'dsh-host-compatibility.json')
  const existing = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : {}
  const receipt = {
    ...existing,
    libraryPatch: CODING_OAUTH_LIBRARY_COMPAT,
    libraryPatches: applied,
    libraryOriginalSha256: sha256(before),
    libraryAdaptedSha256: sha256(after),
    libraryNote: 'DSH 0.2.3 删除 dsh-llm 的 assertUsableApiKey/normalizeApiKey 导出、且 cordis 4.2 拦截未声明 inject 的 ctx.root；import 改指仍在导出的 LlmError 与 INVALID_CREDENTIAL_CODE 并内联等价实现，root 改按 Symbol.for("cordis.root") 读取。调用点不变。',
  }
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  return { changed: true, plugin: `${pkg.name}@${pkg.version}`, ...receipt }
}

