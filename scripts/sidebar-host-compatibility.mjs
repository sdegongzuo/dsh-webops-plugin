/** 按上游 PR #905 适配侧边栏 0.25.0；官方 tgz 保持原样。 */
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
  if (pkg.name !== 'dsh-better-sidebar' || pkg.version !== '0.25.0') {
    throw new Error('该宿主兼容补丁仅适用于 dsh-better-sidebar@0.25.0。')
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
