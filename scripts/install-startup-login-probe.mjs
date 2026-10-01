/** 固定测试目录的主程序定点内容编辑：只关闭启动自动登录，不改手动入口。 */
import assert from 'node:assert/strict'
import { openSync, readFileSync, writeSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { extractFile, getRawHeader, statFile, uncache } from '@electron/asar'
import { portableTestDir } from './local-env.mjs'
const archive=join(portableTestDir(),'app/resources/app.asar')
const original=extractFile(archive,'lib/main.js')
const text=original.toString('utf8')
const before='if (app.isPackaged && state.error === "authentication-required" && !isQuitting()) queuePolicyAuthentication();'
const after=before.replace('app.isPackaged','false'.padEnd('app.isPackaged'.length))
assert.equal(Buffer.byteLength(before),Buffer.byteLength(after))
assert.equal(text.split(before).length,2,'启动登录分支必须唯一，拒绝猜测其他版本')
const at=text.indexOf(before)
assert.ok(text.slice(at-90,at).includes('mandatoryPolicy.check("launch")'),'目标必须是启动检查分支')
const edited=Buffer.from(text.replace(before,after))
assert.equal(edited.length,original.length)
const raw=getRawHeader(archive)
const entry=statFile(archive,'lib/main.js')
assert.ok(entry.integrity && entry.size < entry.integrity.blockSize,'本轮仅支持单块主程序')
const hash=createHash('sha256').update(edited).digest('hex')
const header=raw.headerString.replaceAll(entry.integrity.hash,hash)
assert.equal(Buffer.byteLength(header),Buffer.byteLength(raw.headerString))
const prefix=readFileSync(archive).subarray(0,8+raw.headerSize)
const headerAt=prefix.indexOf(Buffer.from(raw.headerString))
assert.ok(headerAt>=0,'找不到归档元数据，停止编辑')
const fd=openSync(archive,'r+')
try {
  writeSync(fd,edited,0,edited.length,8+raw.headerSize+Number(entry.offset))
  const headerBuffer=Buffer.from(header)
  writeSync(fd,headerBuffer,0,headerBuffer.length,headerAt)
} finally { closeSync(fd) }
uncache(archive)
assert.ok(extractFile(archive,'lib/main.js').equals(edited))
assert.equal(statFile(archive,'lib/main.js').integrity.hash,hash)
console.log('测试包已隐藏启动飞书弹窗；手动检查更新仍保留登录。主程序内容与归档 SHA256 已核对。')
