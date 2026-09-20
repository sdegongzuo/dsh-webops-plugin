import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import {
  connectLoopback,
  isLoopbackHost,
  loopbackCandidates,
  withHost,
} from './loopback.ts'

describe('isLoopbackHost', () => {
  it('认三种回环写法，包括带方括号的 IPv6', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  it('不认 0.0.0.0 与外部主机', () => {
    for (const host of ['0.0.0.0', 'example.com', '10.0.0.1', '']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('loopbackCandidates', () => {
  it('把首选名排在最前，其余按默认顺序跟上', () => {
    expect(loopbackCandidates('127.0.0.1')).toEqual(['127.0.0.1', 'localhost'])
    expect(loopbackCandidates('localhost')).toEqual(['localhost', '127.0.0.1'])
  })

  it('首选是 ::1 时两个默认名都排在后面', () => {
    expect(loopbackCandidates('::1')).toEqual(['::1', '127.0.0.1', 'localhost'])
  })

  it('非回环主机不给兜底 —— 绝不把外部主机换成别的名字', () => {
    expect(loopbackCandidates('example.com')).toEqual(['example.com'])
  })
})

describe('withHost', () => {
  it('只换主机名，端口与路径不动', () => {
    expect(withHost('http://127.0.0.1:9222/json/list', 'localhost'))
      .toBe('http://localhost:9222/json/list')
  })

  it('换到 IPv6 字面量时补方括号', () => {
    expect(withHost('http://127.0.0.1:9222/x', '::1')).toBe('http://[::1]:9222/x')
  })
})

describe('connectLoopback', () => {
  let server: Server | undefined

  afterEach(async () => {
    const closing = server
    server = undefined
    if (closing === undefined) return
    await new Promise<void>(resolve => { closing.close(() => { resolve() }) })
  })

  /** 起一台只监听指定名字的 server。 */
  async function listen(host: string): Promise<number> {
    server = createServer(socket => { socket.destroy() })
    await new Promise<void>(resolve => { ;(server as Server).listen(0, host, resolve) })
    return (server.address() as AddressInfo).port
  }

  it('连上时回报真正用上的主机名', async () => {
    const port = await listen('127.0.0.1')
    const connection = await connectLoopback(port, { timeoutMs: 5_000 })

    expect(connection.host).toBe('127.0.0.1')
    connection.socket.destroy()
  })

  it('第一个名字解析不了时自动换下一个', async () => {
    const port = await listen('127.0.0.1')
    // `.invalid` 是保留 TLD，解析必失败 —— 这样「第一个候选失败」是确定的，
    // 不依赖本机把 `localhost` 解析成哪个地址。
    const connection = await connectLoopback(port, {
      hosts: ['no-such-host.invalid', '127.0.0.1'],
      timeoutMs: 5_000,
    })

    expect(connection.host).toBe('127.0.0.1')
    connection.socket.destroy()
  })

  it('所有候选都连不上时抛出', async () => {
    // 先拿一个确定没人听的端口（自己听完就关），比写死端口 1 稳。
    const port = await listen('127.0.0.1')
    const closing = server as Server
    server = undefined
    await new Promise<void>(resolve => { closing.close(() => { resolve() }) })

    await expect(connectLoopback(port, { timeoutMs: 2_000 })).rejects.toThrow()
  })
})
