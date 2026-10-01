/** 复制式增量安装：不删除旧 chunk，不改 profile 或用户存储。 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { portableTestDir } from './local-env.mjs'
const source = resolve(process.argv[2] ?? '.action-probe-20261001/lib')
const testDir = portableTestDir()
const target = join(testDir, 'home/profiles/desktop/node_modules/dsh-webops-plugin')
assert.ok(existsSync(join(source, 'browser-electron/action-overlay.html')), '缺少本轮效果层资产')
assert.ok(existsSync(join(target, 'package.json')), '目标不是已安装的插件目录')
function fingerprint(dir) {
  const hashes = new Map()
  if (!existsSync(dir)) return hashes
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) for (const [path, hash] of fingerprint(file)) hashes.set(path, hash)
    else if (entry.isFile()) hashes.set(file, createHash('sha256').update(readFileSync(file)).digest('hex'))
  }
  return hashes
}
const before = fingerprint(join(testDir, 'home/storages'))
const profile = join(testDir, 'home/profiles/desktop/package.json')
const profileBefore = readFileSync(profile)
mkdirSync(join(target, 'lib'), { recursive: true })
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (entry.name === 'fake-llm') continue
  cpSync(join(source, entry.name), join(target, 'lib', entry.name), { recursive: true })
}
for (const name of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) cpSync(resolve(name), join(target, name))
assert.deepEqual(fingerprint(join(testDir, 'home/storages')), before, '用户存储发生变化')
assert.ok(readFileSync(profile).equals(profileBefore), 'profile package.json 发生变化')
const files = fingerprint(source)
for (const [file, hash] of files) {
  const rel = file.slice(source.length + 1)
  if (rel.startsWith('fake-llm')) continue
  assert.equal(createHash('sha256').update(readFileSync(join(target, 'lib', rel))).digest('hex'), hash, `安装字节不一致：${rel}`)
}
console.log(`增量安装完成：${target}\n用户存储 ${before.size} 个文件与 profile package.json 保持不变；产物逐文件 SHA256 一致。`)
