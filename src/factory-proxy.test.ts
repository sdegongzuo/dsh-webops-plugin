/** 出厂代理 URL 校验：带账号密码的代理必须被拒绝，凭据不得明文落盘或进分发 zip。 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const factoryProxy = await import(new URL('../scripts/factory-proxy.mjs', import.meta.url).href) as {
  normalizeFactoryProxy(raw: string | undefined): string | undefined
  writeFactoryProxy(stageDir: string, raw?: string): string | undefined
}

describe('出厂代理 URL 校验', () => {
  it('带用户名密码的 http 代理应被拒绝', () => {
    expect(() => factoryProxy.normalizeFactoryProxy('http://user:pass@127.0.0.1:7890'))
      .toThrowError(/不能带账号密码/)
  })

  it('带用户名密码的 https 代理应被拒绝', () => {
    expect(() => factoryProxy.normalizeFactoryProxy('https://user:pass@proxy.example.com:8080'))
      .toThrowError(/不能带账号密码/)
  })

  it('只带用户名（无密码）的代理同样应被拒绝', () => {
    expect(() => factoryProxy.normalizeFactoryProxy('http://user@127.0.0.1:7890'))
      .toThrowError(/不能带账号密码/)
  })

  it('不带账号密码的合法代理不回归', () => {
    expect(factoryProxy.normalizeFactoryProxy('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(factoryProxy.normalizeFactoryProxy('https://proxy.example.com:8080')).toBe('https://proxy.example.com:8080')
    // 自动补协议与 host:port 的既有行为保持不变
    expect(factoryProxy.normalizeFactoryProxy('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('writeFactoryProxy 拒绝带凭据的代理时不落盘 proxy.txt', () => {
    const stage = mkdtempSync(join(tmpdir(), 'factory-proxy-test-'))
    expect(() => factoryProxy.writeFactoryProxy(stage, 'http://user:pass@127.0.0.1:7890'))
      .toThrowError(/不能带账号密码/)
    expect(() => readFileSync(join(stage, 'proxy.txt'))).toThrow()
  })
})
