/** 网页工具参数契约：按公开 schema 验证基础形状，再补少量跨字段与范围语义。 */

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { BrowserError } from '../browser/index.ts'
import { MAX_P2_LIMIT, MAX_WAIT_TIME_MS } from '../browser-cdp/provider-config.ts'
import { MAX_SNAPSHOT_LINES } from '../browser-cdp/snapshot.ts'
import { MAX_FIND_LIMIT } from './snapshot-cache.ts'

/** 在网页工具执行和任何浏览器服务调用前验证参数。 */
export function validateToolArguments(toolName: string, schema: Record<string, unknown>, args: unknown): void {
  const properties = schema['properties']
  if (args !== null && typeof args === 'object' && !Array.isArray(args)
    && properties !== null && typeof properties === 'object') {
    const allowed = Object.keys(properties)
    const unknown = Object.keys(args).filter(key => !Object.hasOwn(properties, key))
    if (unknown.length > 0) {
      const example = toolName === 'webpage_execute'
        ? ' 示例：{"session_id":"t1","code":"return { title: document.title };","timeout_ms":5000}。'
        : ''
      throwInvalidParams(toolName, `未知字段 ${unknown.map(key => `"${key}"`).join(', ')}；允许字段：${allowed.join(', ') || '(无)'}。${example}`)
    }
  }
  const violations = validateJsonSchemaValue(schema as never, args, '')
  if (violations.length > 0) throwInvalidParams(toolName, violations.join('; '))
  const errors = semanticParameterErrors(toolName, args as Record<string, unknown>)
  if (errors.length > 0) throwInvalidParams(toolName, errors.join('; '))
}

function throwInvalidParams(toolName: string, detail: string): never {
  throw new BrowserError(
    `${toolName} 参数无效：${detail}。请按工具参数 schema 修正输入；未派发任何浏览器操作。`,
    'BROWSER_INVALID_PARAMS',
  )
}

function semanticParameterErrors(toolName: string, args: Record<string, unknown>): string[] {
  const errors: string[] = []
  const nonEmpty = (...fields: string[]): void => {
    for (const field of fields) {
      const value = args[field]
      if (typeof value === 'string' && value.trim().length === 0) errors.push(`${field} 必须是非空字符串`)
    }
  }
  const range = (field: string, min: number, max: number): void => {
    const value = args[field]
    if (typeof value === 'number' && (!Number.isInteger(value) || value < min || value > max)) {
      errors.push(`${field} 必须是 ${min} 到 ${max} 之间的整数`)
    }
  }
  const httpUrl = (field: string): void => {
    const value = args[field]
    if (typeof value !== 'string' || value.length === 0) return
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme')
    } catch {
      errors.push(`${field} 必须是绝对 http(s) URL`)
    }
  }
  const onlyOne = (fields: string[]): void => {
    const present = fields.filter(field => args[field] !== undefined)
    if (present.length > 1) errors.push(`字段 ${present.join(', ')} 互斥；只能提供其中一个`)
  }
  const onlyWith = (field: string, parent: string, expected: unknown): void => {
    if (args[field] !== undefined && args[parent] !== expected) {
      errors.push(`${field} 仅在 ${parent}=${String(expected)} 时允许`)
    }
  }

  switch (toolName) {
    case 'webpage_open':
      nonEmpty('url')
      httpUrl('url')
      break
    case 'webpage_navigate':
      nonEmpty('session_id', 'url')
      httpUrl('url')
      onlyOne(['url', 'history'])
      if (args.url === undefined && args.history === undefined) errors.push('必须提供 url 或 history 之一')
      break
    case 'webpage_snapshot':
      nonEmpty('session_id', 'region_ref')
      range('max_lines', 1, MAX_SNAPSHOT_LINES)
      if ([args.region_ref !== undefined, args.region_viewport === true, args.region_box !== undefined].filter(Boolean).length > 1) {
        errors.push('region_ref、region_viewport=true、region_box 互斥；只能提供其中一个')
      }
      if (args.region_box !== undefined && args.region_box !== null && typeof args.region_box === 'object') {
        const box = args.region_box as Record<string, unknown>
        for (const field of ['x', 'y', 'width', 'height']) {
          const value = box[field]
          if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`region_box.${field} 必须是有限数值`)
        }
        for (const field of ['width', 'height']) {
          const value = box[field]
          if (typeof value === 'number' && value <= 0) errors.push(`region_box.${field} 必须大于 0`)
        }
      }
      break
    case 'webpage_screenshot':
      nonEmpty('session_id', 'ref')
      if (args.ref !== undefined && args.full_page === true) errors.push('ref 与 full_page=true 互斥')
      break
    case 'webpage_click':
    case 'webpage_fill':
    case 'webpage_press':
    case 'webpage_locate':
      nonEmpty('session_id', 'ref')
      if (toolName === 'webpage_click' || toolName === 'webpage_press') {
        nonEmpty('wait_text')
        nonEmpty('region_ref', 'observe_ref')
        onlyOne(['region_ref', 'observe_ref'])
        if (args.region_ref !== undefined && args.observe !== true && args.wait_text === undefined) errors.push('region_ref 必须与 observe=true 或 wait_text 同用')
        if (args.observe_ref !== undefined && args.observe !== true && args.wait_text === undefined) errors.push('observe_ref 必须与 observe=true 或 wait_text 同用')
        range('timeout_ms', 1, MAX_WAIT_TIME_MS)
        // timeout_ms 有两种合法用法：wait_text 的完成等待期限，或 observe=true 的「动作后等待页面安静」期限。
        // 既不等完成也不观察时单独的 timeout_ms 没有意义，也不静默忽略。
        if (args.timeout_ms !== undefined && args.wait_text === undefined && args.observe !== true) {
          errors.push('timeout_ms 仅在 wait_text（完成等待）或 observe=true（动作后等待页面安静）时允许')
        }
      }
      if (toolName === 'webpage_press') {
        const key = args.key
        const named = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space', ' ']
        if (typeof key === 'string' && key.length === 0) errors.push('key 不能为空；请使用命名键或单个可打印 ASCII 字符')
        if (typeof key === 'string' && !named.includes(key) && key.length !== 1) {
          errors.push('key 必须是支持的命名键（如 Enter、Tab、ArrowDown）或单个 ASCII 字符')
        }
        if (typeof key === 'string' && key.length === 1 && (key.charCodeAt(0) < 32 || key.charCodeAt(0) > 0x7e)) {
          errors.push('key 的单字符形式必须是可打印 ASCII 字符；空格请传 " " 或 "Space"')
        }
      }
      break
    case 'webpage_scroll':
      nonEmpty('session_id', 'ref')
      if (args.delta_x === undefined && args.delta_y === undefined) errors.push('必须提供 delta_x 或 delta_y')
      break
    case 'webpage_wait': {
      nonEmpty('session_id', 'text', 'ref', 'region_ref', 'observe_ref')
      onlyOne(['region_ref', 'observe_ref'])
      const conditions = ['time_ms', 'text', 'ref', 'until'].filter(field => args[field] !== undefined)
      if (conditions.length !== 1) errors.push('time_ms、text、ref、until 必须且只能提供一个')
      range('time_ms', 1, MAX_WAIT_TIME_MS)
      range('timeout_ms', 1, MAX_WAIT_TIME_MS)
      if (args.ref_state !== undefined && args.ref === undefined) errors.push('ref_state 必须与 ref 一起提供')
      if (args.time_ms !== undefined && args.timeout_ms !== undefined) errors.push('time_ms 是固定延时，不能与 timeout_ms 同时提供')
      break
    }
    case 'webpage_tabs':
      nonEmpty('session_id', 'handoff_code')
      if (args.action === 'list' && args.session_id !== undefined) errors.push('action=list 时省略 session_id')
      if (args.action !== 'list' && args.session_id === undefined) errors.push(`action=${String(args.action)} 必须提供 session_id`)
      onlyWith('scope', 'action', 'list')
      onlyWith('handoff_code', 'action', 'claim')
      break
    case 'webpage_console':
      nonEmpty('session_id')
      range('limit', 1, MAX_P2_LIMIT)
      break
    case 'webpage_network':
      nonEmpty('session_id', 'request_id')
      range('limit', 1, MAX_P2_LIMIT)
      if (args.action === 'body' && args.request_id === undefined) errors.push('action=body 必须提供非空 request_id')
      if (args.action === 'body' && (args.limit !== undefined || args.url !== undefined || args.all_documents !== undefined)) {
        errors.push('action=body 仅接受 request_id，不接受 limit、url 或 all_documents')
      }
      if (args.action === 'list' && args.request_id !== undefined) errors.push('request_id 仅用于 action=body')
      break
    case 'webpage_execute':
      nonEmpty('session_id')
      if (typeof args.code !== 'string' || args.code.trim().length === 0) errors.push('code 必须是非空 async 函数体，例如 return { title: document.title };')
      range('timeout_ms', 1, MAX_WAIT_TIME_MS)
      break
    case 'webpage_tools':
      if (!Array.isArray(args['tools']) || (args['tools'] as unknown[]).length === 0) {
        errors.push('tools 必须是至少一个工具名的数组，例如 ["webpage_find"]')
      }
      break
    case 'webpage_find':
      nonEmpty('session_id', 'query')
      range('limit', 1, MAX_FIND_LIMIT)
      if (args.read !== undefined && args.read !== null && typeof args.read === 'object') {
        if (args.full_text !== true) errors.push('read 续读仅在 full_text=true 时允许')
        const read = args.read as Record<string, unknown>
        for (const field of ['observation_id', 'line', 'offset']) {
          if (typeof read[field] !== 'number' || !Number.isSafeInteger(read[field]) || (read[field] as number) < (field === 'observation_id' ? 1 : 0)) {
            errors.push(`read.${field} 必须是合法非负整数，observation_id必须大于0`)
          }
        }
      }
      if (args.regex === true && typeof args.query === 'string') {
        try { new RegExp(args.query, 'i') } catch (error) { errors.push(`query 不是有效正则：${(error as Error).message}`) }
      }
      break

  }
  return errors
}
