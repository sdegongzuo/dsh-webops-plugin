import { describe, expect, it } from 'vitest'
import { BrowserError } from '../browser/types.ts'
import {
  assertExecuteAllowed,
  BROWSER_EXECUTE_ALLOWED,
  extractEvaluateException,
  extractEvaluateValue,
  translateEvaluateError,
} from './execute.ts'

/** 方案 3.3 点名必须拒绝的命令（前缀类 + 单条类），外加一个完全未知的命令。 */
const DENIED_METHODS = [
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setUserAgentOverride',
  'Target.attachToTarget',
  'Browser.close',
  'Fetch.enable',
  'Overlay.highlightNode',
  'Input.dispatchMouseEvent',
  'Network.emulateNetworkConditions',
  'Network.setExtraHTTPHeaders',
  'Network.setCacheDisabled',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Page.setBypassCSP',
  'Debugger.enable',
  'completely.unknown.command',
]

describe('assertExecuteAllowed', () => {
  it('rejects every denied command with the full method name in the message', () => {
    for (const method of DENIED_METHODS) {
      try {
        assertExecuteAllowed(method)
        throw new Error(`expected "${method}" to be rejected`)
      } catch (error: unknown) {
        // 循环体内部的哨兵错误要重新抛出，别把它当成「被正确拒绝」。
        if (!(error instanceof BrowserError)) throw error
        expect(error.code, method).toBe('BROWSER_EXECUTE_NOT_ALLOWED')
        expect(error.message, method).toContain(method)
      }
    }
  })

  it('points Input.* denials at the dedicated tools instead of leaving the model stuck (2026-09-18)', () => {
    // 模型想绕过分级去发 Input.insertText / Input.dispatchKeyEvent 时，必须知道该用什么，
    // 否则会以为「这个插件不能模拟按键」。
    try {
      assertExecuteAllowed('Input.insertText')
      throw new Error('expected Input.insertText to be rejected')
    } catch (error: unknown) {
      if (!(error instanceof BrowserError)) throw error
      expect(error.code).toBe('BROWSER_EXECUTE_NOT_ALLOWED')
      expect(error.message).toContain('webpage_press')
      expect(error.message).toContain('webpage_fill')
    }
  })

  it('accepts exactly the allow-listed commands and nothing else', () => {

    for (const method of BROWSER_EXECUTE_ALLOWED) {
      expect(() => assertExecuteAllowed(method), method).not.toThrow()
    }
    // 未列入名单的新命令默认拒 —— 这条是白名单制的立身之本。
    expect(() => assertExecuteAllowed('Network.setBlockedURLs')).toThrow(BrowserError)
  })
})

describe('extractEvaluateValue', () => {
  it('rejects a DOM node that silently serializes to {} ([V22])', () => {
    for (const remote of [
      { type: 'object', subtype: 'node', value: {} },
      { type: 'object', subtype: 'node' },
      { type: 'object', value: {} },
    ]) {
      try {
        extractEvaluateValue({ result: remote })
        throw new Error('expected an unserializable rejection')
      } catch (error: unknown) {
        if (!(error instanceof BrowserError)) throw error
        expect(error.code).toBe('BROWSER_EXECUTE_RESULT_UNSERIALIZABLE')
        expect(error.message).toContain('JSON string')
      }
    }
  })

  it('passes plain values through unchanged', () => {
    expect(extractEvaluateValue({ result: { type: 'number', value: 2 } })).toBe(2)
    expect(extractEvaluateValue({ result: { type: 'string', value: 'ok' } })).toBe('ok')
    expect(extractEvaluateValue({ result: { type: 'object', value: { a: 1 } } })).toEqual({ a: 1 })
    expect(extractEvaluateValue({ result: { type: 'object', value: [1, 2] } })).toEqual([1, 2])
    expect(extractEvaluateValue({ result: { type: 'undefined' } })).toBeUndefined()
    expect(extractEvaluateValue({ result: { type: 'boolean', value: null } })).toBeNull()
  })

  it('stays a rejection for an empty object, but says what to do about it (2026-09-18)', () => {
    // 为什么不是放行：`document.body` 在 returnByValue 下静默变成 `{}`，与真心返回的空对象
    // **无法区分** —— 放行会让模型拿到一个看着有值、其实是垃圾的 `{}` 并当成成功。
    // 所以维持拒绝，只把出路写清楚。
    try {
      extractEvaluateValue({ result: { type: 'object', value: {} } })
      throw new Error('expected a rejection for an empty object')
    } catch (error: unknown) {
      if (!(error instanceof BrowserError)) throw error
      expect(error.code).toBe('BROWSER_EXECUTE_RESULT_UNSERIALIZABLE')
      expect(error.message).toContain('JSON.stringify({})')
      expect(error.message).toContain('JSON string')
      expect(error.message).toContain('NOT rolled back')
    }
    // DOM 节点走的是另一条更有针对性的文案（它本来就不该被 returnByValue 返回）。
    try {
      extractEvaluateValue({ result: { type: 'object', subtype: 'node' } })
      throw new Error('expected a rejection for a DOM node')
    } catch (error: unknown) {
      if (!(error instanceof BrowserError)) throw error
      expect(error.message).toContain('DOM node')
      expect(error.message).toContain('JSON string')
    }
  })

  it('rejects function and symbol results that cannot cross the CDP boundary', () => {
    for (const type of ['function', 'symbol']) {
      expect(() => extractEvaluateValue({ result: { type } }))
        .toThrow(expect.objectContaining({ code: 'BROWSER_EXECUTE_RESULT_UNSERIALIZABLE' }))
    }
  })

  it('rejects a malformed CDP result body', () => {
    expect(() => extractEvaluateValue(undefined))
      .toThrow(expect.objectContaining({ code: 'BROWSER_EXECUTE_RESULT_UNSERIALIZABLE' }))
    expect(() => extractEvaluateValue({}))
      .toThrow(expect.objectContaining({ code: 'BROWSER_EXECUTE_RESULT_UNSERIALIZABLE' }))
  })

  it('an unawaited Promise says the expression already ran instead of pretending nothing happened ([V22]/S5)', () => {
    // 报告 S5：`fetch('/get').then(r => r.status)` 报了「不可序列化」，可副作用已经发生。
    try {
      extractEvaluateValue({ result: { type: 'object', subtype: 'promise', description: 'Promise' } })
      throw new Error('expected an unserializable rejection')
    } catch (error: unknown) {
      if (!(error instanceof BrowserError)) throw error
      expect(error.code).toBe('BROWSER_EXECUTE_RESULT_UNSERIALIZABLE')
      expect(error.message).toContain('Promise')
      expect(error.message).toContain('already run')
      expect(error.message).toContain('NOT rolled back')
    }
  })
})

describe('extractEvaluateException', () => {
  it('surfaces the real exception when the expression throws or an awaited promise rejects', () => {
    expect(extractEvaluateException({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: {
        text: 'Uncaught (in promise)',
        exception: { description: 'Error: ENOENT\n    at <anonymous>:1:1' },
      },
    })).toBe('Error: ENOENT\n    at <anonymous>:1:1')

    // 没有 exceptionDetails 就不是异常 —— 千万别把正常返回当成抛错。
    expect(extractEvaluateException({ result: { type: 'number', value: 1 } })).toBeUndefined()
    expect(extractEvaluateException(undefined)).toBeUndefined()
    // exception 没有 description / value 时退到 text，再退到一句兜底。
    expect(extractEvaluateException({ exceptionDetails: { text: 'Uncaught' } })).toBe('Uncaught')
    expect(extractEvaluateException({ exceptionDetails: {} })).toContain('unknown error')
  })
})

describe('translateEvaluateError', () => {
  it('maps both [V22] serialization error messages to the unserializable code', () => {
    for (const message of [
      'Object reference chain is too long',
      "Object couldn't be returned by value",
    ]) {
      const mapped = translateEvaluateError(new BrowserError(`CDP error: ${message}`, 'BROWSER_PROTOCOL_ERROR'))
      expect(mapped).toBeInstanceOf(BrowserError)
      expect((mapped as BrowserError).code).toBe('BROWSER_EXECUTE_RESULT_UNSERIALIZABLE')
    }
  })

  it('passes unrelated errors through untouched', () => {
    const protocol = new BrowserError('CDP error: something else', 'BROWSER_PROTOCOL_ERROR')
    expect(translateEvaluateError(protocol)).toBe(protocol)

    const detached = new BrowserError('the CDP debugger is detached', 'BROWSER_DEBUGGER_DETACHED')
    expect(translateEvaluateError(detached)).toBe(detached)

    const plain = new Error('not ours')
    expect(translateEvaluateError(plain)).toBe(plain)
  })
})
