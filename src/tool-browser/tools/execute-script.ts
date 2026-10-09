/** 把模型提供的 async 函数体包装为一次页面求值，并校验跨 CDP 边界的数据。 */

const ENVELOPE_KEY = '__dsh_webpage_execute_result_v1__'
const RESULT_TEXT_LIMIT = 18_000

/** 页面内封装只接受无副作用可读取的普通 JSON 数据，不调用 getter 或 toJSON。 */
export function wrapExecuteFunctionBody(code: string): string {
  return `(()=>{\n`
    + `const __dshSet=Set, __dshGetOwn=Object.getOwnPropertyDescriptor, __dshGetProto=Object.getPrototypeOf, __dshOwnKeys=Reflect.ownKeys, __dshIsArray=Array.isArray, __dshFinite=Number.isFinite, __dshStringify=JSON.stringify, __dshDefine=Object.defineProperty, __dshNodeCtor=globalThis.Node, __dshAsyncFunction=Object.getPrototypeOf(async function(){}).constructor;\n`
    + `const __dshErrorCtors=[Error,EvalError,RangeError,ReferenceError,SyntaxError,TypeError,URIError]; const __dshStackGetters=new __dshSet(__dshErrorCtors.map(Ctor=>__dshGetOwn(Ctor.prototype,'stack')?.get).filter(getter=>typeof getter==='function'));\n`
    + `const __dshCapture = (error, phase) => { const read = (object, key) => { try { for (let item = object; item != null; item = __dshGetProto(item)) { const descriptor = __dshGetOwn(item, key); if (descriptor) { if ('value' in descriptor) return descriptor.value; if (key === 'stack' && typeof descriptor.get === 'function' && __dshStackGetters.has(descriptor.get)) return descriptor.get.call(object); return undefined; } } } catch {} return undefined; }; const name = typeof error === 'string' ? 'Error' : read(error, 'name'); const message = typeof error === 'string' ? error : (error === null || (typeof error !== 'object' && typeof error !== 'function') ? String(error) : read(error, 'message')); const stack = read(error, 'stack'); let detail = {name:(typeof name === 'string' ? name : 'Error').slice(0, 100), message:(typeof message === 'string' ? message : 'The async function body threw.').slice(0, 2000), phase, ...(typeof stack === 'string' ? {stack:stack.slice(0, 6000)} : {})}; let envelope = {${JSON.stringify(ENVELOPE_KEY)}:1, has_value:false, script_error:detail}; while (__dshStringify(envelope).length > ${RESULT_TEXT_LIMIT} && detail.stack && detail.stack.length > 0) { detail = {...detail, stack:detail.stack.slice(0, Math.floor(detail.stack.length / 2))}; envelope = {${JSON.stringify(ENVELOPE_KEY)}:1, has_value:false, script_error:detail}; } while (__dshStringify(envelope).length > ${RESULT_TEXT_LIMIT} && detail.message.length > 0) { detail = {...detail, message:detail.message.slice(0, Math.floor(detail.message.length / 2))}; envelope = {${JSON.stringify(ENVELOPE_KEY)}:1, has_value:false, script_error:detail}; } return __dshStringify(envelope).length <= ${RESULT_TEXT_LIMIT} ? envelope : {${JSON.stringify(ENVELOPE_KEY)}:1, has_value:false, script_error:{name:'Error', message:'The function body failed; diagnostic text was too large.', phase}}; };\n`
    + `let __dshRun; try { __dshRun = new __dshAsyncFunction(${JSON.stringify(code)}); } catch(error) { return Promise.resolve(__dshCapture(error, 'compile')); }\n`
    + `const __dshPack = value => {\n`
    + `  const seen = new Set();\n`
    + `  let nodes = 0;\n`
    + `  const visit = (item, path, depth) => {\n`
    + `    if (item === null || typeof item === 'boolean') return item;\n`
    + `    if (typeof item === 'string') return item;\n`
    + `    if (typeof item === 'number') { if (!__dshFinite(item)) throw new TypeError(path + ' is not a finite number'); return item; }\n`
    + `    if (typeof item !== 'object') throw new TypeError(path + ' has unsupported type ' + typeof item);\n`
    + `    if (typeof __dshNodeCtor === 'function' && item instanceof __dshNodeCtor) throw new TypeError(path + ' is a DOM node; return the fields you need');\n`
    + `    if (depth > 40 || ++nodes > 10000) throw new TypeError(path + ' exceeds the JSON result limit');\n`
    + `    if (seen.has(item)) throw new TypeError(path + ' contains a circular reference');\n`
    + `    const proto = __dshGetProto(item);\n`
    + `    if (!__dshIsArray(item) && proto !== Object.prototype && proto !== null) throw new TypeError(path + ' is not a plain object or array');\n`
    + `    seen.add(item);\n`
    + `    let out;\n`
    + `    if (__dshIsArray(item)) { out = []; for (let i = 0; i < item.length; i++) { const d = __dshGetOwn(item, String(i)); if (!d || !('value' in d)) throw new TypeError(path + '[' + i + '] is an accessor or a sparse slot'); out.push(visit(d.value, path + '[' + i + ']', depth + 1)); } }\n`
    + `    else { out = {}; for (const key of __dshOwnKeys(item)) { const d = __dshGetOwn(item, key); if (!d || !d.enumerable) continue; if (typeof key !== 'string') throw new TypeError(path + ' has an enumerable symbol key'); if (!('value' in d)) throw new TypeError(path + '.' + key + ' is an accessor'); __dshDefine(out, key, {value: visit(d.value, path + '.' + key, depth + 1), enumerable: true, configurable: true, writable: true}); } }\n`
    + `    seen.delete(item); return out;\n`
    + `  };\n`
    + `  try { const packed = visit(value, '$', 0); let envelope = {${JSON.stringify(ENVELOPE_KEY)}:1, has_value:true, value:packed}; if (__dshStringify(envelope).length > ${RESULT_TEXT_LIMIT}) { if (typeof packed !== 'string') throw new TypeError('the structured result exceeds ${RESULT_TEXT_LIMIT} serialized characters; return only the fields or slice you need'); let low = 0, high = packed.length; while (low < high) { const mid = Math.ceil((low + high) / 2); const candidate = {${JSON.stringify(ENVELOPE_KEY)}:1, has_value:true, value:packed.slice(0, mid), truncated:true}; if (__dshStringify(candidate).length <= ${RESULT_TEXT_LIMIT}) low = mid; else high = mid - 1; } envelope = {${JSON.stringify(ENVELOPE_KEY)}:1, has_value:true, value:packed.slice(0, low), truncated:true}; } return envelope; }\n`
    + `  catch (error) { const descriptor = error && (typeof error === 'object' || typeof error === 'function') ? __dshGetOwn(error, 'message') : undefined; const detail = descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : 'the result is not supported JSON data'; return {${JSON.stringify(ENVELOPE_KEY)}:1, has_value:false, serialization_error:detail.slice(0, 2000)}; }\n`
    + `};\n`
    + `return Promise.resolve().then(() => __dshRun()).then(value => value === undefined ? {${JSON.stringify(ENVELOPE_KEY)}:1, has_value:false} : __dshPack(value), error => __dshCapture(error, 'runtime'));\n`
    + `})()`
}

export interface ExecuteEnvelope {
  readonly has_value: boolean
  readonly value?: unknown
  readonly serialization_error?: string
  readonly truncated?: boolean
  readonly script_error?: { readonly name: string; readonly message: string; readonly phase: 'compile' | 'runtime'; readonly stack?: string }
}


/** 只接受本模块生成的结果信封，避免把协议对象误当页面结果。 */
export function unwrapExecuteEnvelope(value: unknown): ExecuteEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The page returned an invalid execute result envelope.')
  }
  const record = value as Record<string, unknown>
  if (record[ENVELOPE_KEY] !== 1 || typeof record['has_value'] !== 'boolean') {
    throw new Error('The page returned an invalid execute result envelope.')
  }
  if (typeof record['serialization_error'] === 'string') {
    return { has_value: false, serialization_error: record['serialization_error'] }
  }
  const scriptError = record['script_error']
  if (scriptError !== null && typeof scriptError === 'object') {
    const failure = scriptError as Record<string, unknown>
    if (typeof failure['name'] === 'string' && typeof failure['message'] === 'string'
      && (failure['phase'] === 'compile' || failure['phase'] === 'runtime')) {
      return {
        has_value: false,
        script_error: {
          name: failure['name'],
          message: failure['message'],
          phase: failure['phase'],
          ...(typeof failure['stack'] === 'string' ? { stack: failure['stack'] } : {}),
        },
      }
    }
  }
  return record['has_value']
    ? { has_value: true, value: record['value'], ...(record['truncated'] === true ? { truncated: true } : {}) }
    : { has_value: false }
}
