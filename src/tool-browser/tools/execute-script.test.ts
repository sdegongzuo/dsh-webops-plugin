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
    // 路径必须和措辞连在一起断：只查 '$.b' 时把字段写成 $.bx 也照样绿。
    expect(topLevelField.serialization_error).toContain('$.b is undefined')
    expect(topLevelField.serialization_error).toContain('?? null')

    // 真实失败形状（东财行情）：第一行没有 BASIC_EPS 字段，模型照抄 d.BASIC_EPS。
    const fromPageRows = unwrapExecuteEnvelope(await run(
      "const rows = [{ rd: 'x' }]; return rows.map(d => ({ rd: d.rd, eps: d.BASIC_EPS }));",
    ))
    // 同上：路径 + 措辞一起断，错字段（$[0].epsx）或换掉措辞都会红。
    expect(fromPageRows.serialization_error).toContain('$[0].eps is undefined')
    expect(fromPageRows.serialization_error).toContain('?? null')
  })

  it('reports an undefined array slot by index instead of a bare type name', async () => {
    const result = unwrapExecuteEnvelope(await run('return [null, undefined];'))
    expect(result.has_value).toBe(false)
    // 下标必须和措辞一起断：只查 '$[1]' 时错成 $[10] / $[1].x 也照样绿。
    expect(result.serialization_error).toContain('$[1] is undefined')
    expect(result.serialization_error).toContain('?? null')
  })

  it('points a non-finite number at Number() before Number.isFinite', async () => {
    const result = unwrapExecuteEnvelope(await run('return { n: NaN };'))
    expect(result.has_value).toBe(false)
    expect(result.serialization_error).toContain('$.n is not a finite number')
    expect(result.serialization_error).toContain('Number.isFinite')
    // 非有限数的修法必须同时给「兜底值」和「Number("") 是 0」两点：只留 Number.isFinite
    // 会让模型以为 Number("") 没取到值。不钉整句，只钉这两条语义。
    expect(result.serialization_error).toContain('return null')
    expect(result.serialization_error).toContain('Number("") is 0')
  })

  it('keeps the fix from being truncated under a 1900-character field path', async () => {
    // 1900 字符的键让路径 + 提示超过 2000 字符上限：旧实现按整串 slice(0, 2000)，
    // 路径先吃满预算，把 ?? null 这段修法截掉；现在只截路径、提示全长保留。
    const longKey = 'k'.repeat(1900)
    const result = unwrapExecuteEnvelope(await run('return { ' + longKey + ': undefined };'))
    expect(result.has_value).toBe(false)
    expect(result.serialization_error).toContain('?? null')
    // 提示本身完整：路径可截，措辞不可截。
    expect(result.serialization_error).toContain(' is undefined')
    expect((result.serialization_error ?? '').length).toBeLessThanOrEqual(2_000)
  })

  it('tells the model how to fix a sparse slot and an accessor separately', async () => {
    // 稀疏槽位与访问器原来共用 'is an accessor or a sparse slot' 一条提示，
    // 现在必须分别点名，并给出能直接照做的修法。
    const sparse = unwrapExecuteEnvelope(await run('return { a: [1, , 3] };'))
    expect(sparse.has_value).toBe(false)
    expect(sparse.serialization_error).toContain('$.a[1] is a sparse slot')
    expect(sparse.serialization_error).toContain('Array.from')

    const accessor = unwrapExecuteEnvelope(await run('return { get x(){ return 1 } };'))
    expect(accessor.has_value).toBe(false)
    expect(accessor.serialization_error).toContain('$.x is an accessor')
    expect(accessor.serialization_error).toContain('Object.getOwnPropertyDescriptor')

    const arrayAccessor = unwrapExecuteEnvelope(await run('const value = [1]; Object.defineProperty(value, "0", { enumerable: true, get(){ return 2 } }); return value;'))
    expect(arrayAccessor.serialization_error).toContain('$[0] is an accessor')
    expect(arrayAccessor.serialization_error).toContain('Object.getOwnPropertyDescriptor')
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

/**
 * `unwrapExecuteEnvelope` 是唯一把页面回传值当协议信封校验的地方：provider 的
 * 任何返回值都先过它。两条 throw 一旦被删，非法信封就会被当成「没有值」静默放行 ——
 * 所以这里直接按入参形状逐条钉住拒绝行为，不依赖工具层的编排。
 */
describe('unwrapExecuteEnvelope envelope validation', () => {
  const INVALID = 'The page returned an invalid execute result envelope.'

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    // 版本 key 缺失：只按 has_value 判定的实现会把它当合法信封。
    ['an object without the version key', { has_value: true }],
    // 版本 key 在、值不对（不是 1）。
    ['a wrong version value', { __dsh_webpage_execute_result_v1__: 2, has_value: true }],
    // 版本 key 在、has_value 不是布尔。
    ['a non-boolean has_value', { __dsh_webpage_execute_result_v1__: 1, has_value: 'yes' }],
    // 空对象：两条 throw 里那条版本校验必须命中。
    ['an empty object', {}],
  ])('rejects %s', (_label, value) => {
    expect(() => unwrapExecuteEnvelope(value)).toThrow(INVALID)
  })

  it('rejects an array even when it carries the version key', () => {
    // 数组也是对象；不拦会把 0 号元素当成信封，协议形状就被放宽了。
    expect(() => unwrapExecuteEnvelope([{ __dsh_webpage_execute_result_v1__: 1, has_value: true }]))
      .toThrow(INVALID)
  })

  it('accepts a legal envelope with and without a value', () => {
    expect(unwrapExecuteEnvelope({ __dsh_webpage_execute_result_v1__: 1, has_value: true, value: 7 }))
      .toEqual({ has_value: true, value: 7 })
    // has_value:false 不带 value 也必须过 —— 拒绝范围不能扩大成「必须有 value」。
    expect(unwrapExecuteEnvelope({ __dsh_webpage_execute_result_v1__: 1, has_value: false }))
      .toEqual({ has_value: false })
  })
})
