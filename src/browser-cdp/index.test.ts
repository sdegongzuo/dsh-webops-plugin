/**
 * 插件入口的接线测试：`apply()` 是否把 provider 注册进 `ctx.browser`，
 * 以及 `DSH_BROWSER_CDP_ENDPOINT` 是否真的能盖掉 profile 里的配置。
 *
 * 为什么这条 env 覆盖值得单测：桌面端的 profile 目录由应用独占并每次重建，
 * 往里写 `config.endpoint` 活不过一次重启；一旦这条覆盖断了，桌面端里的
 * 浏览器工具就会去连桌面端自己的渲染进程（嵌入式 Chromium，不实现
 * `PUT /json/new`），表现为 `webpage_open` 报「Could not create a new tab」。
 * 这是个只在真机上才看得见的故障，所以把判据钉在单测里。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, CDP_ENDPOINT_ENV } from './index.ts'
import type { CdpBrowserProvider } from './provider.ts'
import type { Context } from '@deepseek-ai/cordis'

/** 记录注册与副作用的最小假上下文。 */
function fakeContext(registered: CdpBrowserProvider[]): Context {
  return {
    browser: {
      registerProvider: (provider: CdpBrowserProvider): void => {
        registered.push(provider)
      },
    },
    effect: (): void => undefined,
  } as unknown as Context
}

/** 跑一次 `apply()` 并把注册进来的 provider 交回。 */
function applyOnce(config: Parameters<typeof apply>[1] = {}): CdpBrowserProvider {
  const registered: CdpBrowserProvider[] = []
  apply(fakeContext(registered), config)
  const provider = registered[0]
  if (provider === undefined) throw new Error('apply() 没有注册 provider')
  return provider
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('browser-cdp 入口', () => {
  it('把 provider 注册进 ctx.browser，并带上配置里的端点', () => {
    const provider = applyOnce({ endpoint: 'http://127.0.0.1:9333' })

    expect(provider).toBeDefined()
    // provider 把配置收在私有字段里，只看得出「注册了」；端点取值由下一条用例钉住。
    expect(Object.keys(provider)).toContain('config')
  })

  it('让环境变量盖掉配置里的端点', () => {
    vi.stubEnv(CDP_ENDPOINT_ENV, 'http://127.0.0.1:9444')
    const provider = applyOnce({ endpoint: 'http://127.0.0.1:9222' })

    expect(configOf(provider).endpoint).toBe('http://127.0.0.1:9444')
  })

  it('环境变量为空串时按「没设」处理，仍然用配置里的端点', () => {
    vi.stubEnv(CDP_ENDPOINT_ENV, '')
    const provider = applyOnce({ endpoint: 'http://127.0.0.1:9222' })

    expect(configOf(provider).endpoint).toBe('http://127.0.0.1:9222')
  })

  it('既没配端点也没设环境变量时，落到默认端点', () => {
    vi.stubEnv(CDP_ENDPOINT_ENV, '')
    const provider = applyOnce({})

    expect(configOf(provider).endpoint).toBe('http://127.0.0.1:9222')
  })
})

/** 取出 provider 内部解析后的配置。 */
function configOf(provider: CdpBrowserProvider): { endpoint: string } {
  return (provider as unknown as { config: { endpoint: string } }).config
}
