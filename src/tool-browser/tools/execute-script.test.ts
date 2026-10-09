import { describe, expect, it } from 'vitest'
import { unwrapExecuteEnvelope, wrapExecuteFunctionBody } from './execute-script.ts'

class TestNode {}

async function run(code: string): Promise<unknown> {
  const scope = globalThis as unknown as Record<string, unknown>
  const original = scope['Node']
  scope['Node'] = TestNode
  const expression = wrapExecuteFunctionBody(code)
  const evaluate = new Function(`return ${expression}`) as () => Promise<unknown>
  try {
    return await evaluate()
  } finally {
    if (original === undefined) delete scope['Node']
    else scope['Node'] = original
  }
}

describe('webpage_execute async function body wrapper', () => {
  it('runs multi-statement async code once and awaits its return value', async () => {
    const result = await run('const value = await Promise.resolve(41); globalThis.counter = (globalThis.counter || 0) + 1; return { answer: value + 1 };')
    expect(unwrapExecuteEnvelope(result)).toEqual({ has_value: true, value: { answer: 42 } })
    expect((globalThis as { counter?: number }).counter).toBe(1)
    delete (globalThis as { counter?: number }).counter
    expect(unwrapExecuteEnvelope(await run('const value = await Promise.resolve(1); return value;'))).toEqual({ has_value: true, value: 1 })
  })

  it.each([
    ['return {};', {}],
    ['return [];', []],
    ['return null;', null],
  ])('preserves a legitimate JSON value %j', async (code, value) => {
    expect(unwrapExecuteEnvelope(await run(code))).toEqual({ has_value: true, value })
  })

  it('marks missing return as undefined without confusing it with null', async () => {
    expect(unwrapExecuteEnvelope(await run('const local = 1; void local;'))).toEqual({ has_value: false })
  })

  it('reports unsupported objects without returning a misleading empty value', async () => {
    const result = unwrapExecuteEnvelope(await run('const value = {}; value.self = value; Object.defineProperty(value, "secret", { enumerable: false, value: 7 }); return value;'))
    expect(result.has_value).toBe(false)
    expect(result.serialization_error).toContain('circular reference')
  })

  it('ignores non-enumerable data fields like JSON and preserves an empty object', async () => {
    const packed = await run('const value = {}; Object.defineProperty(value, "hidden", { enumerable: false, value: 7 }); return value;')
    expect(unwrapExecuteEnvelope(packed)).toEqual({ has_value: true, value: {} })
  })

  it('rejects DOM nodes and does not read accessors', async () => {
    expect(unwrapExecuteEnvelope(await run('return new Node();'))).toMatchObject({
      has_value: false,
      serialization_error: expect.stringContaining('DOM node'),
    })
    const result = unwrapExecuteEnvelope(await run('const value = {}; Object.defineProperty(value, "x", { enumerable: true, get(){ throw new Error("must not run"); } }); return value;'))
    expect(result.serialization_error).toContain('accessor')
  })

  it('limits result size before the provider can truncate the envelope', async () => {
    const text = '"\\\n\u0001'.repeat(8_000)
    const packed = await run(`return ${JSON.stringify(text)};`)
    const result = unwrapExecuteEnvelope(packed)
    expect(result.has_value).toBe(true)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(packed).length).toBeLessThanOrEqual(18_000)
  })

  it('captures syntax errors and runtime failures as typed envelope data', async () => {
    expect(unwrapExecuteEnvelope(await run('return ; const =;'))).toMatchObject({
      has_value: false,
      script_error: { name: 'SyntaxError' },
    })
    const thrown = unwrapExecuteEnvelope(await run('const value = 1; throw new TypeError("bad value");'))
    expect(thrown).toMatchObject({
      has_value: false,
      script_error: { name: 'TypeError', message: 'bad value' },
    })
    // 浏览器与测试 realm 的 Error.stack 可能是访问器，不能为诊断调用用户 getter。
    const accessorFailure = await run('const error = new Error("safe message"); Object.defineProperty(error, "stack", {get(){throw new Error("must not run");}}); throw error;')
    expect(unwrapExecuteEnvelope(accessorFailure).script_error?.message).toBe('safe message')
    expect(unwrapExecuteEnvelope(await run('throw "plain failure";'))).toMatchObject({
      script_error: { name: 'Error', message: 'plain failure', phase: 'runtime' },
    })
    const largeFailure = await run('const error = new Error("x".repeat(100000)); error.stack = "\\n".repeat(100000); throw error;')
    expect(JSON.stringify(largeFailure).length).toBeLessThanOrEqual(18_000)
    const escapedFailure = await run('const error = new Error("\\0".repeat(100000)); error.stack = "\\0".repeat(100000); throw error;')
    expect(JSON.stringify(escapedFailure).length).toBeLessThanOrEqual(18_000)
  })
})
