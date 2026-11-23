/** 出厂代理 URL 校验：带账号密码的代理必须被拒绝，凭据不得明文落盘或进分发 zip。 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const factoryProxy = await import(new URL('../scripts/factory-proxy.mjs', import.meta.url).href) as {
  normalizeFactoryProxy(raw: string | undefined): string | undefined
  writeFactoryProxy(stageDir: string, raw?: string): string | undefined
  renderNoProxyValue(hosts?: string[]): string
  launcherNoProxyLines(): string[]
  LOOPBACK_DIRECT_HOSTS: string[]
  DOMESTIC_DIRECT_HOSTS: string[]
}

const readRepoFile = (name: string): string => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')

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

/**
 * 2026-11-20：本机 FlClash 在 7890 时，用户要求 DeepSeek 官方与 WorkBuddy 走直连、只让 Grok 走代理。
 * 启动器里加 `NO_PROXY` 白名单，两个打包脚本必须共用同一份渲染结果，否则迟早各写一份、口径漂移。
 */
describe('启动器 NO_PROXY 白名单', () => {
  it('覆盖 DeepSeek 与 WorkBuddy 国内网关', () => {
    const value = factoryProxy.renderNoProxyValue()
    for (const host of ['deepseek.com', 'copilot.tencent.com', 'tencentbuddy.com', 'workbuddy.cn', 'codebuddy.cn']) {
      expect(value.split(','), `白名单缺 ${host}`).toContain(host)
    }
    // WorkBuddy 国际版故意不列：国内直连国际站通常更慢甚至不通，仍让它们走代理。
    expect(value).not.toContain('workbuddy.ai')
  })

  it('裸域名口径：不带通配符、不带空格、不重复', () => {
    const value = factoryProxy.renderNoProxyValue()
    expect(value).not.toContain('*')
    expect(value).not.toMatch(/\s/u)
    const entries = value.split(',')
    expect(new Set(entries).size).toBe(entries.length)
  })

  it('去重、去空白，遇到分隔符直接报错', () => {
    expect(factoryProxy.renderNoProxyValue(['A.com', ' a.com ', ''])).toBe('a.com')
    expect(() => factoryProxy.renderNoProxyValue(['a.com b'])).toThrowError(/分隔符/)
    expect(() => factoryProxy.renderNoProxyValue([])).toThrowError(/不能为空/)
  })

  it('两个打包脚本共用同一份启动器片段，不各自抄一份域名列表', () => {
    const lines = factoryProxy.launcherNoProxyLines()
    expect(lines.at(-1)).toBe(
      'set "NO_PROXY=localhost,127.0.0.1,::1,deepseek.com,copilot.tencent.com,tencentbuddy.com,workbuddy.cn,codebuddy.cn"',
    )
    expect(lines.slice(0, -1).every((line) => line.startsWith('rem '))).toBe(true)
    for (const script of ['scripts/package-desktop-portable.mjs', 'scripts/package-release-portable.mjs']) {
      const body = readRepoFile(script)
      expect(body, `${script} 没把 NO_PROXY 写进启动器`).toContain('...launcherNoProxyLines()')
      expect(body, `${script} 自己抄了一份域名列表`).not.toContain('set "NO_PROXY=localhost')
      expect(body, `${script} 的启动器里仍残留旧写法`).not.toContain('${renderNoProxyValue()}')
    }
  })
})
