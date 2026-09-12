import { describe, expect, it } from 'vitest'
import { BrowserError } from '../browser/types.ts'
import { BROWSER_MAX_URL_LENGTH, validateEndpoint, validateTargetUrl } from './url-policy.ts'

describe('validateTargetUrl', () => {
  it('normalizes an http(s) target and keeps about:blank as-is', () => {
    expect(validateTargetUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(validateTargetUrl('  about:blank ')).toBe('about:blank')
  })

  it('rejects every non-http(s) scheme with BROWSER_URL_BLOCKED', () => {
    for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'ws://127.0.0.1:9222']) {
      expect(() => validateTargetUrl(value)).toThrow(expect.objectContaining({ code: 'BROWSER_URL_BLOCKED' }))
    }
  })

  it('rejects embedded credentials so a URL can never smuggle a secret', () => {
    expect(() => validateTargetUrl('https://user:pass@example.com'))
      .toThrow(expect.objectContaining({ code: 'BROWSER_URL_BLOCKED' }))
  })

  it('rejects a blank or oversized target', () => {
    expect(() => validateTargetUrl('   ')).toThrow(expect.objectContaining({ code: 'BROWSER_URL_BLOCKED' }))
    const long = `https://example.com/${'a'.repeat(BROWSER_MAX_URL_LENGTH)}`
    expect(() => validateTargetUrl(long)).toThrow(expect.objectContaining({ code: 'BROWSER_URL_BLOCKED' }))
  })

  it('reports malformed input instead of letting URL throw a raw TypeError', () => {
    expect(() => validateTargetUrl('not a url')).toThrow(BrowserError)
  })
})

describe('validateEndpoint', () => {
  it('accepts loopback endpoints and strips trailing slashes', () => {
    expect(validateEndpoint('http://127.0.0.1:9222/')).toBe('http://127.0.0.1:9222')
    expect(validateEndpoint('http://localhost:9222')).toBe('http://localhost:9222')
    expect(validateEndpoint('http://[::1]:9222')).toBe('http://[::1]:9222')
  })

  it('refuses a non-loopback endpoint: the debugging port has no authentication', () => {
    expect(() => validateEndpoint('http://192.168.1.10:9222')).toThrow(/loopback/u)
    expect(() => validateEndpoint('ws://127.0.0.1:9222')).toThrow(/http or https/u)
    expect(() => validateEndpoint('nonsense')).toThrow(/valid URL/u)
  })
})
