/** 依赖锁契约：测试目录只新增，保留证据。 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const { buildRoot } = await import(new URL('../scripts/local-env.mjs', import.meta.url).href)
const { readVendoredRuntimeLock, verifyMaterializedRuntime } = await import(new URL('../scripts/vendored-runtime-lock.mjs', import.meta.url).href)
const vendor = fileURLToPath(new URL('../vendor/plugins/', import.meta.url))

function fixture(path = 'node_modules/example') {
  const root = mkdtempSync(join(buildRoot(), 'runtime-lock-test-'))
  const item = { name: 'example', version: '1.0.0', integrity: 'sha512-测试', tarball: 'example.tgz' }
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: { example: '1.0.0' } }, [path]: item } }
  writeFileSync(join(root, 'runtime.json'), JSON.stringify(lock))
  return { root, item, lock }
}

describe('随包插件完整运行时锁', () => {
  it('官方依赖树逐包校验，并保留同名依赖的嵌套版本', () => {
    const checked = readVendoredRuntimeLock(vendor, 'workbuddy-runtime.lock.json', (path: string, expected: string) => {
      const body = readFileSync(path)
      expect(`sha512-${createHash('sha512').update(body).digest('base64')}`).toBe(expected)
      return body
    })
    expect(checked.find((item: { name: string }) => item.name === '@earendil-works/pi-ai')?.version).toBe('1.3.0')
    expect(checked.filter((item: { name: string }) => item.name === 'https-proxy-agent').map((item: { version: string }) => item.version).sort())
      .toEqual(['7.0.6', '9.1.0'])
  })

  it.each(['node_modules/../example', 'node_modules/example/../../escape', 'elsewhere/example'])('写盘前拒绝越界路径：%s', path => {
    const { root } = fixture(path)
    expect(() => readVendoredRuntimeLock(root, 'runtime.json', () => Buffer.alloc(0))).toThrow('条目无效')
  })

  it('完整性校验失败立即停止，不忽略坏包', () => {
    const { root } = fixture()
    expect(() => readVendoredRuntimeLock(root, 'runtime.json', () => { throw Error('sha512 不匹配') })).toThrow('sha512 不匹配')
  })

  it('验包拒绝缺失或错误版本的实际依赖，正确版本通过', () => {
    const { root } = fixture()
    const plugin = join(root, 'plugin')
    expect(() => verifyMaterializedRuntime(plugin, root, 'runtime.json')).toThrow()
    const dependency = join(plugin, 'node_modules', 'example')
    mkdirSync(dependency, { recursive: true })
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'example', version: '0.9.0' }))
    expect(() => verifyMaterializedRuntime(plugin, root, 'runtime.json')).toThrow('版本不符')
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0' }))
    expect(verifyMaterializedRuntime(plugin, root, 'runtime.json')).toBe(1)
  })
})
