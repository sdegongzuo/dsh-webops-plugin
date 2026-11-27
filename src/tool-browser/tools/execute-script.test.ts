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

  it('names the undefined field and the fix so the next attempt can succeed', async () => {
    const topLevelField = unwrapExecuteEnvelope(await run('return { a: 1, b: undefined };'))
    expect(topLevelField.has_value).toBe(false)
    expect(topLevelField.serialization_error).toContain('$.b')
    expect(topLevelField.serialization_error).toContain('?? null')

    // 真实失败形状（东财行情）：第一行没有 BASIC_EPS 字段，模型照抄 d.BASIC_EPS。
    const fromPageRows = unwrapExecuteEnvelope(await run(
      "const rows = [{ rd: 'x' }]; return rows.map(d => ({ rd: d.rd, eps: d.BASIC_EPS }));",
    ))
    expect(fromPageRows.serialization_error).toContain('$[0].eps')
    expect(fromPageRows.serialization_error).toContain('?? null')
  })

  it('reports an undefined array slot by index instead of a bare type name', async () => {
    const result = unwrapExecuteEnvelope(await run('return [null, undefined];'))
    expect(result.has_value).toBe(false)
    expect(result.serialization_error).toContain('$[1]')
    expect(result.serialization_error).toContain('?? null')
  })

  it('points a non-finite number at Number() before Number.isFinite', async () => {
    const result = unwrapExecuteEnvelope(await run('return { n: NaN };'))
    expect(result.has_value).toBe(false)
    expect(result.serialization_error).toContain('$.n is not a finite number')
    expect(result.serialization_error).toContain('Number.isFinite')
  })

  it('keeps functions, symbols and bigints on the generic unsupported-type message', async () => {
    const fn = unwrapExecuteEnvelope(await run('return { fmt: () => 1 };'))
    expect(fn.serialization_error).toContain('$.fmt has unsupported type function')
    expect(unwrapExecuteEnvelope(await run('return { tag: Symbol("s") };')).serialization_error)
      .toContain('has unsupported type symbol')
    expect(unwrapExecuteEnvelope(await run('return { n: 1n };')).serialization_error)
      .toContain('has unsupported type bigint')
  })

  it('tells the model how to fix a cycle and a non-plain object', async () => {
    const cyclic = unwrapExecuteEnvelope(await run('const value = { rd: "x" }; value.self = value; return value;'))
    expect(cyclic.serialization_error).toContain('$.self contains a circular reference')
    expect(cyclic.serialization_error).toContain('return a copy')

    const notPlain = unwrapExecuteEnvelope(await run('return { when: new Date(0) };'))
    expect(notPlain.serialization_error).toContain('$.when is not a plain object or array')
    expect(notPlain.serialization_error).toContain('built from the fields you need')
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
