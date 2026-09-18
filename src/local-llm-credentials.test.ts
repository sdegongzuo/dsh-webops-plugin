import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyLocalLlmKey, parseCredentialRefs } from './local-llm-credentials.ts'

describe('parseCredentialRefs', () => {
  it('reads refs and ignores records', () => {
    const refs = parseCredentialRefs([
      'version: 1',
      'refs:',
      '  UNISOUND_API_KEY: sk-local-only',
      '  ARK_API_KEY: "quoted"',
      'records:',
      '  llm-pi-ai/openai-codex:',
      '    kind: grant',
    ].join('\n'))
    expect(refs).toEqual({ UNISOUND_API_KEY: 'sk-local-only', ARK_API_KEY: 'quoted' })
  })
})

function portableTree(keyName: string, keyValue: string): { root: string; home: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-portable-'))
  const home = join(root, 'home')
  mkdirSync(join(root, 'app'))
  mkdirSync(home)
  const file = join(home, '.credentials.yaml')
  writeFileSync(file, `version: 1\nrefs:\n  ${keyName}: ${keyValue}\n`)
  return { root, home, file }
}

describe('applyLocalLlmKey', () => {
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.UNISOUND_API_KEY
    delete process.env.DSH_PORTABLE_ROOT
  })

  it('prefers an already-set env var over a file', () => {
    const env: NodeJS.ProcessEnv = { UNISOUND_API_KEY: 'from-env' }
    expect(applyLocalLlmKey(env)).toEqual({ name: 'UNISOUND_API_KEY', source: 'env' })
    expect(env.UNISOUND_API_KEY).toBe('from-env')
  })

  it('reads home/.credentials.yaml next to app/ (portable root)', () => {
    const tree = portableTree('UNISOUND_API_KEY', 'sk-from-portable')
    const env: NodeJS.ProcessEnv = { DSH_PORTABLE_ROOT: tree.root }
    const hit = applyLocalLlmKey(env)
    expect(hit).toEqual({ name: 'UNISOUND_API_KEY', source: tree.file })
    expect(env.UNISOUND_API_KEY).toBe('sk-from-portable')
  })

  it('reads DSH_HOME only when it is the sibling of app/', () => {
    const tree = portableTree('UNISOUND_API_KEY', 'sk-from-home')
    const env: NodeJS.ProcessEnv = { DSH_HOME: tree.home }
    const hit = applyLocalLlmKey(env)
    expect(hit).toEqual({ name: 'UNISOUND_API_KEY', source: tree.file })
  })

  it('does not read a DSH_HOME that is not next to app/ (so ~/.dsh never qualifies)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-user-home-'))
    writeFileSync(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-user-dir\n')
    const env: NodeJS.ProcessEnv = { DSH_HOME: dir }
    expect(applyLocalLlmKey(env)).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
  })

  it('does not fall back to the user-profile ~/.dsh store', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyLocalLlmKey(env)).toBeUndefined()
  })

  it('picks UNISOUND_API_KEY from a real portable root when that tree exists', () => {
    const root = 'D:/dsh-v0.2.5-verify3'
    if (!existsSync(join(root, 'app')) || !existsSync(join(root, 'home', '.credentials.yaml'))) return
    const env: NodeJS.ProcessEnv = { DSH_PORTABLE_ROOT: root }
    const hit = applyLocalLlmKey(env)
    expect(hit?.name).toBe('UNISOUND_API_KEY')
    expect(hit?.source.replaceAll('\\', '/')).toContain('dsh-v0.2.5-verify3/home/.credentials.yaml')
    expect((env.UNISOUND_API_KEY ?? '').length).toBeGreaterThan(0)
  })
})
