/**
 * `TargetStateRegistry` 的单测：钉住方案 2.3.1 的冲突判定三情形 + `force` + 接管窗口。
 *
 * 这是骨架（阶段 A 没有工具真的写 target 级状态），所以这里只测分类与回执语义，
 * 不涉及任何 CDP 命令。
 */

import { describe, expect, it } from 'vitest'
import { TargetStateRegistry } from './state.ts'

describe('TargetStateRegistry', () => {
  it('情形三：从没被 agent 写过 —— 允许写，但标注来源未知', () => {
    const registry = new TargetStateRegistry()

    const claim = registry.claim('s1', 'Emulation.setUserAgentOverride', 'AGENT-UA', { previous: 'human-ish' })

    expect(claim.previousUnknown).toBe(true)
    expect(claim.previous).toBe('human-ish')
    expect(registry.get('s1', 'Emulation.setUserAgentOverride')).toEqual({
      owner: 'agent',
      at: claim.at,
      applied: 'AGENT-UA',
      previous: 'human-ish',
    })
  })

  it('情形二：接管窗口内整体让渡 —— 任何 key 都抛 BROWSER_STATE_CONTENDED', () => {
    const registry = new TargetStateRegistry()
    registry.markTakeover('s1', true)

    expect(() => registry.claim('s1', 'Emulation.setDeviceMetricsOverride', { width: 400 }))
      .toThrow(expect.objectContaining({ code: 'BROWSER_STATE_CONTENDED' }))
  })

  it('错误消息带上 stateKey / holder / at，并写明不可重试与 force 恢复路径', () => {
    const registry = new TargetStateRegistry()
    registry.markTakeover('s1', true)

    let caught: unknown
    try {
      registry.claim('s1', 'Emulation.setUserAgentOverride', 'AGENT-UA')
    } catch (error: unknown) {
      caught = error
    }
    const message = (caught as Error).message
    expect(message).toContain('Emulation.setUserAgentOverride') // stateKey
    expect(message).toContain('human') // holder
    expect(message).toMatch(/since \d+/u) // at（毫秒时间戳）
    expect(message).toContain('NOT retryable')
    expect(message).toContain('force: true')
  })

  it('情形一：agent 写过、但延迟回读探测到被外部改写 —— 再写就抛', () => {
    const registry = new TargetStateRegistry()
    registry.claim('s1', 'Emulation.setUserAgentOverride', 'AGENT-UA')
    // 其它 key 不受影响：这次改写只针对这一个 key。
    registry.claim('s1', 'Emulation.setDeviceMetricsOverride', { width: 400 })

    registry.reportExternalRewrite('s1', 'Emulation.setUserAgentOverride', 'HUMAN-UA')

    expect(registry.get('s1', 'Emulation.setUserAgentOverride')).toMatchObject({
      owner: 'human',
      applied: 'HUMAN-UA',
    })
    expect(() => registry.claim('s1', 'Emulation.setUserAgentOverride', 'AGENT-UA-2'))
      .toThrow(expect.objectContaining({ code: 'BROWSER_STATE_CONTENDED' }))
    // 未被外部改写的 key 照常可写（agent 在更新自己的状态）。
    expect(() => registry.claim('s1', 'Emulation.setDeviceMetricsOverride', { width: 600 })).not.toThrow()
  })

  it('agent 更新自己写过的 key 不算争用（owner 仍是 agent）', () => {
    const registry = new TargetStateRegistry()
    registry.claim('s1', 'Emulation.setDeviceMetricsOverride', { width: 400 })

    const second = registry.claim('s1', 'Emulation.setDeviceMetricsOverride', { width: 600 })

    expect(second.previousUnknown).toBe(false)
    expect(registry.get('s1', 'Emulation.setDeviceMetricsOverride')?.applied).toEqual({ width: 600 })
  })

  it('force: true 是唯一允许的「抢」——接管窗口内也能覆盖，并把 previous 写进回执', () => {
    const registry = new TargetStateRegistry()
    registry.claim('s1', 'Emulation.setUserAgentOverride', 'AGENT-UA', { previous: 'REAL-UA' })
    registry.reportExternalRewrite('s1', 'Emulation.setUserAgentOverride', 'HUMAN-UA')
    registry.markTakeover('s1', true)

    const claim = registry.claim('s1', 'Emulation.setUserAgentOverride', 'AGENT-UA-2', { force: true })

    expect(claim.overwritten).toMatchObject({ owner: 'human', applied: 'HUMAN-UA', previous: 'REAL-UA' })
    expect(registry.get('s1', 'Emulation.setUserAgentOverride')).toMatchObject({ owner: 'agent', applied: 'AGENT-UA-2' })
  })

  it('接管窗口关闭后恢复正常写入（active 是幂等状态位）', () => {
    const registry = new TargetStateRegistry()
    registry.markTakeover('s1', true)
    registry.markTakeover('s1', true) // 重复通知不去重、不累加

    expect(() => registry.claim('s1', 'Page.bringToFront', 'front'))
      .toThrow(expect.objectContaining({ code: 'BROWSER_STATE_CONTENDED' }))

    registry.markTakeover('s1', false)
    expect(registry.isTakeover('s1')).toBe(false)
    expect(() => registry.claim('s1', 'Page.bringToFront', 'front')).not.toThrow()
  })

  it('release 摘掉记录（不是还原状态）后该 key 重新变成「来源未知」', () => {
    const registry = new TargetStateRegistry()
    registry.claim('s1', 'Network.setExtraHTTPHeaders', { 'x-probe': 'A' })

    const released = registry.release('s1', 'Network.setExtraHTTPHeaders')

    expect(released).toMatchObject({ owner: 'agent' })
    expect(registry.get('s1', 'Network.setExtraHTTPHeaders')).toBeUndefined()
    // 再 release 一次是幂等的。
    expect(registry.release('s1', 'Network.setExtraHTTPHeaders')).toBeUndefined()
    // 释放之后重新写：来源又回到「未知」。
    expect(registry.claim('s1', 'Network.setExtraHTTPHeaders', { 'x-probe': 'B' }).previousUnknown).toBe(true)
  })

  it('会话之间 / key 之间互不串扰', () => {
    const registry = new TargetStateRegistry()
    registry.markTakeover('s1', true)
    registry.claim('s2', 'Emulation.setUserAgentOverride', 'UA')

    expect(registry.isTakeover('s1')).toBe(true)
    expect(registry.isTakeover('s2')).toBe(false)
    expect(() => registry.claim('s2', 'Emulation.setUserAgentOverride', 'UA-2')).not.toThrow()

    registry.forget('s1')
    expect(registry.isTakeover('s1')).toBe(false)
  })
})
