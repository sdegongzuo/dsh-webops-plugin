/**
 * 从**便携版 app 同级的 home** 取出一份 LLM key，注入进程环境，**绝不写进发版包**。
 *
 * 便携布局是 `<root>\app\<exe>` + `<root>\home\.credentials.yaml`。
 * 只认这个 home，不认用户目录 `~/.dsh`。
 *
 * 查找顺序（环境变量赢）：
 *   1. 已经在 env 里的 UNISOUND_API_KEY / DEEPSEEK_API_KEY / …
 *   2. `DSH_PORTABLE_ROOT/home/.credentials.yaml`（根目录里同时有 `app\`）
 *   3. `$DSH_HOME/.credentials.yaml`，但仅当 `$DSH_HOME` 的上一级存在 `app\`
 *
 * 返回命中的引用名和来源；**不返回、不打印 key 本身**。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 出厂 settings 的引用名，以及便携 home 里实际会出现的引用名。 */
export const LOCAL_LLM_KEY_NAMES = ['UNISOUND_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'ARK_API_KEY'] as const

function unquote(raw: string): string {
  const text = raw.trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * 只解析 `refs:` 下的 `NAME: value` 行。不碰 `records:`（那是 grant，不是 apiKeyEnv）。
 */
export function parseCredentialRefs(text: string): Record<string, string> {
  const refs: Record<string, string> = {}
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/u.test(line)) { section = 'refs'; continue }
    if (/^[A-Za-z]/u.test(line)) { section = ''; continue }
    const match = /^  ([A-Za-z0-9_]+):\s*(.*)$/u.exec(line)
    if (section === 'refs' && match?.[1] !== undefined) {
      refs[match[1]] = unquote(match[2] ?? '')
    }
  }
  return refs
}

function isPortableRoot(root: string): boolean {
  return existsSync(join(root, 'app')) && existsSync(join(root, 'home'))
}

/**
 * 便携版根目录候选：显式 `DSH_PORTABLE_ROOT`，或 `$DSH_HOME` 的上一级（且那边真有 `app\`）。
 */
function portableRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = []
  const explicit = (env['DSH_PORTABLE_ROOT'] ?? '').trim()
  if (explicit !== '') roots.push(resolve(explicit))
  const dshHome = (env['DSH_HOME'] ?? '').trim()
  if (dshHome !== '') roots.push(resolve(dshHome, '..'))
  return [...new Set(roots)].filter(root => isPortableRoot(root))
}

function credentialFiles(env: NodeJS.ProcessEnv): string[] {
  return portableRoots(env)
    .map(root => join(root, 'home', '.credentials.yaml'))
    .filter(path => existsSync(path))
}

export interface LocalLlmKeyHit {
  readonly name: string
  readonly source: string
}

/**
 * 若 env 里还没有 LLM key，从 app 同级的 `home\.credentials.yaml` 补一份进去。
 */
export function applyLocalLlmKey(env: NodeJS.ProcessEnv = process.env): LocalLlmKeyHit | undefined {
  for (const name of LOCAL_LLM_KEY_NAMES) {
    if ((env[name] ?? '').trim() !== '') return { name, source: 'env' }
  }
  for (const file of credentialFiles(env)) {
    const refs = parseCredentialRefs(readFileSync(file, 'utf8'))
    for (const name of LOCAL_LLM_KEY_NAMES) {
      const value = refs[name]
      if (typeof value === 'string' && value.trim() !== '') {
        env[name] = value
        return { name, source: file }
      }
    }
  }
  return undefined
}
