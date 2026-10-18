import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const { prepareInstanceWritableDirectories } = await import(
  new URL('../scripts/instance-workspace-acl.mjs', import.meta.url).href
)

describe('新实例可写目录权限', () => {
  it('只向实例 documents/temp 授予当前 SID 的可继承权限', () => {
    const root = mkdtempSync(join(tmpdir(), 'mi-acl-'))
    const calls: Array<{ executable: string, args: string[] }> = []
    const result = prepareInstanceWritableDirectories(root, {
      platform: 'win32', systemRoot: 'C:\\Windows',
      run: (executable: string, args: string[]) => {
        calls.push({ executable, args })
        return { status: 0, stdout: '"域\\用户","S-1-5-21-123-456-789-1001"' }
      },
    })
    expect(result.granted).toBe(true)
    expect(calls.map(call => call.args)).toEqual([
      ['/user', '/fo', 'csv', '/nh'],
      [join(root, 'data', 'documents'), '/grant', '*S-1-5-21-123-456-789-1001:(OI)(CI)(F)'],
      [join(root, 'data', 'temp'), '/grant', '*S-1-5-21-123-456-789-1001:(OI)(CI)(F)'],
    ])
  })

  it('无法取得用户身份时拒绝授权，不猜用户名', () => {
    const root = mkdtempSync(join(tmpdir(), 'mi-acl-'))
    let calls = 0
    expect(() => prepareInstanceWritableDirectories(root, {
      platform: 'win32', systemRoot: 'C:\\Windows',
      run: () => { calls += 1; return { status: 0, stdout: '无 SID' } },
    })).toThrow('读取当前用户 SID 失败')
    expect(calls).toBe(1)
  })

  it('授权失败明确报错，不让装配写入完成标记', () => {
    const root = mkdtempSync(join(tmpdir(), 'mi-acl-'))
    expect(() => prepareInstanceWritableDirectories(root, {
      platform: 'win32', systemRoot: 'C:\\Windows',
      run: (executable: string) => executable.endsWith('whoami.exe')
        ? { status: 0, stdout: 'S-1-5-21-123-456-789-1001' }
        : { status: 5, stderr: 'Access is denied.' },
    })).toThrow('Access is denied.')
  })
})
