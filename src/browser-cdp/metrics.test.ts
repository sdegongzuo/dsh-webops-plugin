import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { METRICS_ENV, StaleRefMetrics } from './metrics.ts'
import { RefRegistry } from './refs.ts'

/** 每个用例自己的落盘目录；用完删掉，别把临时文件留成下一轮的假阳性。 */
const directories: string[] = []

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-metrics-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop() as string, { recursive: true, force: true })
})

describe('StaleRefMetrics', () => {
  it('is a no-op for an empty directory — 不建目录、不写文件、不抛错', async () => {
    const sink = new StaleRefMetrics('')
    expect(sink.active).toBe(false)

    sink.noteRefCall('tab-1')
    sink.noteStale('tab-1', 'stale_document')
    // 没有会话计数时 flush 也没什么可写 —— 关键是**不是**「写了一个空文件」。
    expect(await sink.flush('tab-1', 3)).toBeUndefined()
  })

  it('treats an unset env var as off (旧环境变量没设就是默认关)', async () => {
    const saved = process.env[METRICS_ENV]
    delete process.env[METRICS_ENV]
    try {
      // 缺省实参走的是环境变量，所以这里断的正是「没设 = 关」这条纪律本身。
      expect(new StaleRefMetrics().active).toBe(false)
    } finally {
      if (saved !== undefined) process.env[METRICS_ENV] = saved
    }
  })

  it('buckets stale hits per session and appends one JSONL line per flush', async () => {
    const directory = await tempDirectory()
    const sink = new StaleRefMetrics(directory)

    sink.noteRefCall('tab-1')
    sink.noteRefCall('tab-1')
    sink.noteStale('tab-1', 'stale_document')
    sink.noteStale('tab-1', 'detached')
    sink.noteStale('tab-1', 'detached')
    // 另一个会话必须分开记 —— 「跨会话共用标签页」才看得出区别。
    sink.noteStale('tab-2', 'obsolete_epoch')

    const record = await sink.flush('tab-1', 7)
    expect(record).toMatchObject({
      sessionId: 'tab-1',
      refCalls: 2,
      stale: { stale_document: 1, detached: 2 },
      staleTotal: 3,
      epoch: 7,
    })

    const file = join(directory, 'tab-1.jsonl')
    expect(existsSync(file)).toBe(true)
    const first = (await readFile(file, 'utf8')).trim().split('\n')
    expect(first).toHaveLength(1)
    expect(JSON.parse(first[0] as string)).toMatchObject({ refCalls: 2, staleTotal: 3 })

    // 追加语义：第二次 flush 是第二行，不是覆盖。
    await sink.flush('tab-1', 8)
    const second = (await readFile(file, 'utf8')).trim().split('\n')
    expect(second).toHaveLength(2)
    expect(JSON.parse(second[1] as string)).toMatchObject({ epoch: 8, refCalls: 2 })
  })

  it('never writes a file for a session that only had other sessions' , async () => {
    const directory = await tempDirectory()
    const sink = new StaleRefMetrics(directory)
    sink.noteStale('tab-2', 'detached')

    expect(await sink.flush('tab-1')).toBeUndefined()
    expect(existsSync(join(directory, 'tab-1.jsonl'))).toBe(false)
  })

  it('sanitises the session id into a filename (targetId 里不该有路径分隔符)', async () => {
    const directory = await tempDirectory()
    const sink = new StaleRefMetrics(directory)
    sink.noteStale('a/b:c', 'detached')

    await sink.flush('a/b:c')
    expect(existsSync(join(directory, 'a_b_c.jsonl'))).toBe(true)
  })
})

describe('RefRegistry · P0 分桶钩子', () => {
  it('reports obsolete_epoch through the hook, and still throws the same error', () => {
    const seen: string[] = []
    const registry = new RefRegistry({ onStale: reason => { seen.push(reason) } })
    registry.publish([{ role: 'button', name: 'Save', backendNodeId: 11 }], false)
    registry.invalidate()

    expect(() => registry.resolve('e1')).toThrow(
      expect.objectContaining({ code: 'BROWSER_STALE_REF', reason: 'obsolete_epoch' }),
    )
    expect(seen).toEqual(['obsolete_epoch'])
  })

  it('stays silent for a form that never asked to be counted', () => {
    // 不传钩子就是完全无副作用的默认形态（除 revalidate 之外的所有既有调用方都这么用）。
    const registry = new RefRegistry()
    registry.publish([{ role: 'button', name: 'Save', backendNodeId: 11 }], false)
    registry.invalidate()

    expect(() => registry.resolve('e1')).toThrow(expect.objectContaining({ reason: 'obsolete_epoch' }))
  })
})
