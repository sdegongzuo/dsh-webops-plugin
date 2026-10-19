import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { buildRoot } = await import(new URL('../scripts/local-env.mjs', import.meta.url).href) as { buildRoot(): string }
const script = new URL('../scripts/desktop-build-identity.mjs', import.meta.url).href
type Identity = { harnessCommit: string; patchSha256: string; dshVersion: string; asarSha256: string; runtimeSha256: string }
const load = async () => await import(script) as {
  createDesktopBuildIdentity(app: string, source: Pick<Identity, 'harnessCommit' | 'patchSha256'>): Identity
  verifyDesktopBuildIdentity(app: string, receipt: string): Identity
}
const source = { harnessCommit: 'a'.repeat(40), patchSha256: 'b'.repeat(64) }
function fixture() {
  const root = mkdtempSync(join(buildRoot(), 'desktop-build-identity-'))
  mkdirSync(join(root, 'resources', 'dsh'), { recursive: true })
  writeFileSync(join(root, 'resources', 'app.asar'), '已编译的桌面入口')
  writeFileSync(join(root, 'resources', 'dsh', 'desktop-runtime.json'), JSON.stringify({ release: { version: '0.2.1-rc.2' }, files: [] }))
  return root
}

describe('桌面构建回执绑定实际 app', () => {
  it('源提交、补丁摘要与实际归档和运行时摘要一起进入回执', async () => {
    const api = await load(), app = fixture()
    const identity = api.createDesktopBuildIdentity(app, source)
    expect(identity).toMatchObject({ ...source, dshVersion: '0.2.1-rc.2' })
    expect(identity.asarSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(identity.runtimeSha256).toMatch(/^[a-f0-9]{64}$/)
    const receipt = join(app, 'build.json')
    writeFileSync(receipt, JSON.stringify(identity))
    expect(api.verifyDesktopBuildIdentity(app, receipt)).toEqual(identity)
  })

  it.each(['resources/app.asar', 'resources/dsh/desktop-runtime.json'])('替换 %s 后拒绝旧回执', async path => {
    const api = await load(), app = fixture(), receipt = join(app, 'build.json')
    writeFileSync(receipt, JSON.stringify(api.createDesktopBuildIdentity(app, source)))
    writeFileSync(join(app, path), path.endsWith('.json')
      ? JSON.stringify({ release: { version: '0.2.1-rc.2' }, files: ['变动'] }) : '另一个桌面入口')
    expect(() => api.verifyDesktopBuildIdentity(app, receipt)).toThrow('桌面构建回执与实际 app 不一致')
  })

  it('拒绝缺少确定源码身份的回执，不以版本号相同代替来源', async () => {
    const api = await load(), app = fixture()
    expect(() => api.createDesktopBuildIdentity(app, { ...source, harnessCommit: 'main' })).toThrow('完整提交 SHA')
    expect(() => api.createDesktopBuildIdentity(app, { ...source, patchSha256: '' })).toThrow('补丁 SHA256')
  })
})
