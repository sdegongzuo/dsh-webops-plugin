/**
 * 按上游 PR #905 适配侧边栏 0.25.0 / 0.26.0 / 0.26.1；官方 tgz 保持原样。
 * 上游 PR #905 尚未合入这两个正式版本，升新版本后先核对 lib/index.js 的
 * inject 与 fence 形状仍匹配 adaptSidebarHostSource 判据，再登记进下方集合。
 *
 * 0.28.0 起上游原生 inject「connection」，栅栏直接用
 * `(req) => ctx.connection.requestRejection(req) === void 0`，与宿主提供的
 * connection.requestRejection（401/403/undefined）一致，无需补丁、不进下方集合。
 * 0.28.2（2026-11-04 升级）复核：OLD_INJECT / OLD_FENCE / PREVIOUS_* 计数均为 0、
 * `ctx.connection.requestRejection` 消费点 1 处，且 cordis.patch.yml 与 0.28.0 逐字节相同，
 * 故同样不进下方集合、manifest 不启用 hostCompatibility。
 * 0.32.1（2026-11-18 升级）复核：OLD_INJECT / OLD_FENCE / PREVIOUS_* 计数均为 0、
 * `const fence = (req) => ctx.connection.requestRejection(req) === void 0;` 消费点 1 处，
 * cordis.patch.yml 与 0.28.2 逐字节相同（isTrustedApiRequest 辅助函数已在上游删掉，
 * 与本补丁无关）；peer 只是从 ^0.2.1-rc.1 抬到 ^0.2.2-rc.2，同样不进下方集合。
 * 0.33.0（2026-11-27 升级）复核：上游自己把 0.2.3 的 `requestRejection` 缺失处理掉了 ——
 * 栅栏改成依次尝试 `requestRejection` → `connection.authentication` 的 `admit` →
 * `connection.admit`，三者都没有才抛 TypeError。于是 **manifest 不再启用
 * connection-fence-cordis42-v1**（下方集合仍只登记 0.32.1：该补丁的唯一判据是那条单行
 * 栅栏，0.33.0 命中 0 次，误开会在版本白名单处直接抛错）。cordis.patch.yml 与 0.32.1
 * 逐字节相同。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OLD_INJECT = '\t"webRuntime",'
const PREVIOUS_INJECT = '\t"webStartup",'
const OLD_FENCE = 'const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);'
const PREVIOUS_FENCE = 'const fence = (req) => isTrustedApiRequest(req, ctx.webStartup.trustedHosts);'
const NEW_FENCE = `const fence = (req) => {
\t\tif (isTrustedApiRequest(req, ctx.get("webRuntime")?.trustedHosts ?? [])) return true;
\t\tconst connection = ctx.get("connection");
\t\treturn connection !== void 0
\t\t\t&& typeof connection.requestRejection === "function"
\t\t\t&& connection.requestRejection({ headers: req.headers }) !== 403;
\t};`
export const SIDEBAR_COMPATIBILITY_PATCH = 'connection-fence-pr905-v1'
const UPSTREAM_COMMIT = '8f521f4f2aed9e64b1637c512bde9833f22e6219'
/** 官方 tgz 中 inject/fence 消费点形状与 0.25.0 一致、可直接适配的版本。 */
export const SIDEBAR_COMPATIBLE_VERSIONS = ['0.25.0', '0.26.0', '0.26.1']

/** 保留插件原栅栏，以宿主 connection 补充；接受上一版本的已知补丁。 */
export function adaptSidebarHostSource(source) {
  const count = token => source.split(token).length - 1
  if (count(NEW_FENCE) === 1 && count(OLD_INJECT) === 0 && count(PREVIOUS_INJECT) === 0) return source
  const original = count(OLD_INJECT) === 1 && count(OLD_FENCE) === 1
    && count(PREVIOUS_INJECT) === 0 && count(PREVIOUS_FENCE) === 0 && count('ctx.webRuntime.trustedHosts') === 1
  const previous = count(PREVIOUS_INJECT) === 1 && count(PREVIOUS_FENCE) === 1
    && count(OLD_INJECT) === 0 && count(OLD_FENCE) === 0
  if ((!original && !previous) || count(NEW_FENCE) !== 0) {
    throw new Error('侧边栏宿主兼容点已变化，拒绝自动修改；请重新核对 inject 与信任主机来源。')
  }
  return source.replace(original ? OLD_INJECT + '\n' : PREVIOUS_INJECT + '\n', '')
    .replace(original ? OLD_FENCE : PREVIOUS_FENCE, NEW_FENCE)
}

/** 保留原模块和迁移前版本；不要求新旧宿主的可选服务一定存在。 */
export function applySidebarHostCompatibility(pluginDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  if (pkg.name !== 'dsh-better-sidebar' || !SIDEBAR_COMPATIBLE_VERSIONS.includes(pkg.version)) {
    throw new Error(`该宿主兼容补丁仅适用于 dsh-better-sidebar@${SIDEBAR_COMPATIBLE_VERSIONS.join(' / ')}。`)
  }
  const entry = join(pluginDir, 'lib', 'index.js')
  const before = readFileSync(entry, 'utf8')
  const after = adaptSidebarHostSource(before)
  if (before === after) return { changed: false }
  const backup = join(pluginDir, 'lib', 'index.web-runtime-original.js')
  if (existsSync(backup)) {
    const original = readFileSync(backup, 'utf8')
    if (adaptSidebarHostSource(original) !== after) throw new Error('已有侧边栏备份与当前原模块不一致。')
    const previous = join(pluginDir, 'lib', 'index.web-startup-v1.js')
    if (before.includes(PREVIOUS_FENCE) && !existsSync(previous)) writeFileSync(previous, before, { flag: 'wx' })
  } else writeFileSync(backup, before, { flag: 'wx' })
  writeFileSync(entry, after)
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const receipt = {
    patch: SIDEBAR_COMPATIBILITY_PATCH, plugin: `${pkg.name}@${pkg.version}`,
    upstreamCommit: UPSTREAM_COMMIT,
    originalSha256: sha256(readFileSync(backup, 'utf8')), adaptedSha256: sha256(after),
  }
  writeFileSync(join(pluginDir, 'dsh-host-compatibility.json'), JSON.stringify(receipt, null, 2) + '\n')
  return { changed: true, ...receipt }
}

/**
 * ## 第二处宿主兼容：cordis 4.2 / DSH 0.2.3 删掉了 `connection.requestRejection`
 *
 * 0.32.1 的栅栏是单行 `const fence = (req) => ctx.connection.requestRejection(req) === void 0;`。
 * 0.2.3 把准入搬进了 webServer：`connection` 服务改为 `admit()` / `authenticate()`
 * （`packages/client/connection/src/rpc.ts`），`requestRejection` **零命中**。
 * 于是每个 `/sidebar/api/*` 请求都抛 TypeError，被宿主兜底成 **400 空 body** ——
 * 侧边栏看着加载了（客户端半在 boot graph 里），文件树/编辑器/任务面板却全废。
 *
 * 判据与安全性：插件 `inject` 里本来就有 `"connection"`，所以 `ctx.connection` 合法；
 * 缺的只是那个方法。新宿主对未声明 `auth` 的路由默认 `required`（`authPolicy()` 的
 * `auth ?? 'required'`），请求进 handler 前已经过 `authorize()` —— 认证准入由宿主负责，
 * 插件这道栅栏在新宿主上是冗余的第二道。故：方法在就照旧校验，不在就交还宿主。
 */
export const SIDEBAR_CORDIS42_PATCH = 'connection-fence-cordis42-v1'
/** 官方 tgz 里栅栏为上述单行、可直接适配的版本。 */
export const SIDEBAR_CORDIS42_VERSIONS = ['0.32.1']
const CURRENT_FENCE = 'const fence = (req) => ctx.connection.requestRejection(req) === void 0;'
const CORDIS42_FENCE = [
  'const fence = (req) => {',
  '\t\tconst connection = ctx.connection;',
  '\t\tconst requestRejection = connection == null ? void 0 : connection.requestRejection;',
  '\t\t// dsh-webops: DSH 0.2.3 的 connection 不再提供 requestRejection；',
  '\t\t// 宿主已在 webserver 层按 auth 策略（未声明时默认 required）完成准入。',
  '\t\tif (typeof requestRejection !== "function") return true;',
  '\t\treturn requestRejection.call(connection, req) === void 0;',
  '\t};',
].join('\n')
/** 已打补丁的判据：出现这行调用即视为改过。 */
const CORDIS42_SENTINEL = 'requestRejection.call(connection, req)'

/** @param {string} source @returns {string} */
export function adaptSidebarCordis42Source(source) {
  if (source.includes(CORDIS42_SENTINEL)) return source
  const count = source.split(CURRENT_FENCE).length - 1
  if (count !== 1) {
    throw new Error(`侧边栏 requestRejection 栅栏出现 ${count} 次（期望 1 次），拒绝自动修改；请核对上游 lib/index.js 形状。`)
  }
  return source.replace(CURRENT_FENCE, CORDIS42_FENCE)
}

/** @param {string} pluginDir @returns {{ changed: boolean, unchanged?: boolean }} */
export function applySidebarCordis42Compatibility(pluginDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  if (pkg.name !== 'dsh-better-sidebar' || !SIDEBAR_CORDIS42_VERSIONS.includes(pkg.version)) {
    throw new Error(`该补丁仅适用于 dsh-better-sidebar@${SIDEBAR_CORDIS42_VERSIONS.join(' / ')}。`)
  }
  const entry = join(pluginDir, 'lib', 'index.js')
  const before = readFileSync(entry, 'utf8')
  const after = adaptSidebarCordis42Source(before)
  if (before === after) return { changed: false, unchanged: true }

  const backup = join(pluginDir, 'lib', 'index.pre-cordis42.js')
  if (existsSync(backup)) {
    if (readFileSync(backup, 'utf8') !== before) throw new Error('已有侧边栏 cordis42 备份与当前模块不一致。')
  } else writeFileSync(backup, before, { flag: 'wx' })
  writeFileSync(entry, after)

  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const receipt = {
    patch: SIDEBAR_CORDIS42_PATCH, plugin: `${pkg.name}@${pkg.version}`,
    originalSha256: sha256(before), adaptedSha256: sha256(after),
    note: 'DSH 0.2.3 的 connection 服务不再提供 requestRejection；栅栏改为「有则照旧校验、无则交给宿主 webserver 的 auth 准入」。',
  }
  writeFileSync(join(pluginDir, 'dsh-host-compatibility.json'), JSON.stringify(receipt, null, 2) + '\n')
  return { changed: true, ...receipt }
}
