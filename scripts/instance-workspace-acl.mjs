/** 仅为本轮新建测试实例的可写目录补当前用户显式权限，不改变系统目录权限。 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function prepareInstanceWritableDirectories(root, options = {}) {
  const directories = ['documents', 'temp'].map(name => join(root, 'data', name))
  return prepareFreshWritableDirectories(directories, options)
}

/** 调用方只传本轮新建的测试目录；不递归修改已有用户目录。 */
export function prepareFreshWritableDirectories(directories, options = {}) {
  const platform = options.platform ?? process.platform
  const run = options.run ?? spawnSync
  for (const directory of directories) mkdirSync(directory, { recursive: true })
  if (platform !== 'win32') return { directories, granted: false }
  const system = options.systemRoot ?? process.env.SystemRoot
  if (!system) throw Error('无法确定 Windows 系统目录，未授予实例权限')
  const identity = run(join(system, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true })
  const sid = String(identity.stdout ?? '').match(/\bS-1-\d+(?:-\d+)+\b/u)?.[0]
  if (identity.status !== 0 || !sid) throw Error('读取当前用户 SID 失败，未授予实例权限')
  for (const directory of directories) {
    const result = run(join(system, 'System32', 'icacls.exe'), [directory, '/grant', `*${sid}:(OI)(CI)(F)`],
      { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) {
      throw Error(`实例目录授权失败：${directory}；${String(result.stderr ?? '').trim() || `exit ${result.status}`}`)
    }
  }
  return { directories, granted: true, sid }
}
