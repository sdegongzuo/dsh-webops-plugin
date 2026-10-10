/** 使用正式 vendor 产物验证服务缺失及保留式迁移，不依赖本机安装目录。 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const { adaptSidebarHostSource, applySidebarHostCompatibility } = await import(
  new URL('../scripts/sidebar-host-compatibility.mjs', import.meta.url).href
)
const { buildRoot } = await import(new URL('../scripts/local-env.mjs', import.meta.url).href)
const body = gunzipSync(readFileSync(new URL('../vendor/plugins/dsh-better-sidebar-0.25.0.tgz', import.meta.url)))
let official = ''
for (let offset = 0; offset + 512 <= body.length;) {
  const header = body.subarray(offset, offset + 512)
  const name = header.subarray(0, 100).toString().replace(/\0.*$/, '')
  const size = parseInt(header.subarray(124, 136).toString().replace(/[\0 ]+$/, ''), 8) || 0
  offset += 512
  if (name === 'package/lib/index.js') official = body.subarray(offset, offset + size).toString('utf8')
  offset += Math.ceil(size / 512) * 512
}
if (!official) throw new Error('正式侧边栏 tarball 缺少 lib/index.js')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function fixture(version = '0.25.0') {
  const parent = join(buildRoot(), 'sidebar-compatibility-test')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'keep-'))
  const plugin = join(root, 'plugin')
  mkdirSync(join(plugin, 'lib'), { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-better-sidebar', version }))
  writeFileSync(join(plugin, 'lib', 'index.js'), official)
  return { plugin }
}

describe('侧边栏宿主服务迁移', () => {
  it('正式产物旧必需服务确实缺失，适配后全部服务可满足且信任来源随服务迁移', () => {
    const dependencies = (source: string): string[] => {
      const declaration = source.match(/const inject = \[[\s\S]*?\];/)?.[0]
      if (!declaration) throw new Error('正式模块缺少 inject 声明')
      return runInNewContext(`${declaration}\ninject`)
    }
    const available = new Set(['webServer', 'sessions', 'tools'])
    expect(dependencies(official).filter(service => !available.has(service))).toEqual(['webRuntime'])
    const adapted = adaptSidebarHostSource(official)
    expect(dependencies(adapted).filter(service => !available.has(service))).toEqual([])
    expect(adapted).toContain('isTrustedApiRequest(req, ctx.get("webRuntime")?.trustedHosts ?? [])')
    expect(adapted).toContain('if (!fence(req))')
    expect(adaptSidebarHostSource(adapted)).toBe(adapted)
  })

  it('保留正式原模块与完整哈希回执，重复调用不改备份', () => {
    const { plugin } = fixture()
    const receipt = applySidebarHostCompatibility(plugin)
    expect(receipt.changed).toBe(true)
    expect(receipt.originalSha256).toBe(sha(official))
    const backup = readFileSync(join(plugin, 'lib', 'index.web-runtime-original.js'), 'utf8')
    expect(backup).toBe(official)
    expect(receipt.adaptedSha256).toBe(sha(readFileSync(join(plugin, 'lib', 'index.js'), 'utf8')))
    expect(applySidebarHostCompatibility(plugin).changed).toBe(false)
    expect(readFileSync(join(plugin, 'lib', 'index.web-runtime-original.js'), 'utf8')).toBe(backup)
  })

  it('插件版本未核对时写入前拒绝', () => {
    const { plugin } = fixture('0.26.0')
    expect(() => applySidebarHostCompatibility(plugin)).toThrow('仅适用于')
    expect(readFileSync(join(plugin, 'lib', 'index.js'), 'utf8')).toBe(official)
  })

  it('消费点缺失或重复时拒绝猜测替换', () => {
    expect(() => adaptSidebarHostSource(official.replace('ctx.webRuntime.trustedHosts', 'ctx.other.trustedHosts'))).toThrow('兼容点已变化')
    expect(() => adaptSidebarHostSource(official + '\nctx.webRuntime.trustedHosts')).toThrow('兼容点已变化')
  })

  it('从上一版 webStartup 补丁迁移时保留正式原模块和迁移前版本', () => {
    const { plugin } = fixture()
    const previous = official.replace('\t"webRuntime",', '\t"webStartup",')
      .replace('ctx.webRuntime.trustedHosts', 'ctx.webStartup.trustedHosts')
    writeFileSync(join(plugin, 'lib', 'index.web-runtime-original.js'), official)
    writeFileSync(join(plugin, 'lib', 'index.js'), previous)
    expect(applySidebarHostCompatibility(plugin).changed).toBe(true)
    expect(readFileSync(join(plugin, 'lib', 'index.web-startup-v1.js'), 'utf8')).toBe(previous)
    expect(readFileSync(join(plugin, 'lib', 'index.web-runtime-original.js'), 'utf8')).toBe(official)
  })
})

/** 执行正式产物的栅栏函数，而非只检查替换字符串。 */
function fence(get: (key: string) => unknown) {
  const adapted = adaptSidebarHostSource(official)
  const trust = official.split('//#region src/trust-fence.ts\n')[1]?.split('//#endregion')[0]
  const declaration = adapted.match(/const fence = \(req\) => \{[\s\S]*?\n\t\};/)?.[0]
  if (!trust || !declaration) throw new Error('正式产物栅栏结构变化')
  return runInNewContext(`${trust}\n${declaration}\nfence`, { URL, ctx: { get } }) as (req: unknown) => boolean
}
const remote = { method: 'POST', url: '/sidebar/api/fs.read', headers: { host: 'example.com', origin: 'https://example.com' } }

describe('PR905 的实际栅栏行为', () => {
  it.each([undefined, 401, 403])('宿主 verdict=%s：401 放行，403 拒绝，并传入原请求头', verdict => {
    let received
    const fn = fence(key => key === 'connection' ? { requestRejection: (req: unknown) => { received = req; return verdict } } : undefined)
    expect(fn(remote)).toBe(verdict !== 403)
    expect(received).toEqual({ headers: remote.headers })
  })
  it('每次请求读取当前服务，服务缺席时远端拒绝', () => {
    let connection: unknown
    const fn = fence(key => key === 'connection' ? connection : undefined)
    expect(fn(remote)).toBe(false)
    connection = { requestRejection: () => 401 }
    expect(fn(remote)).toBe(true)
    connection = { requestRejection: () => 403 }
    expect(fn(remote)).toBe(false)
  })
  it('旧宿主的 webRuntime 白名单继续生效且不受 connection 收紧', () => {
    const fn = fence(key => key === 'webRuntime' ? { trustedHosts: ['example.com'] } : { requestRejection: () => { throw new Error('不应调用补充判定') } })
    expect(fn(remote)).toBe(true)
  })
  it.each([
    { method: 'POST', url: '/sidebar/api/fs.read', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1' } },
    { method: 'POST', url: '/sidebar/api/fs.read', headers: { host: '127.0.0.1:3080', origin: 'dsh-app://app' } },
    { method: 'GET', url: '/sidebar/file?path=shot.png', headers: { host: '127.0.0.1:3080', referer: 'http://127.0.0.1:3080/', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } },
  ])('无旧服务时保留侧边栏特例：$headers', req => {
    const fn = fence(key => key === 'connection' ? { requestRejection: () => 403 } : undefined)
    expect(fn(req)).toBe(true)
  })
})
