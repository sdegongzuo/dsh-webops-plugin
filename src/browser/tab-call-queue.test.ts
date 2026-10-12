import { describe, expect, it } from 'vitest'
import { TabCallQueue } from './tab-call-queue.ts'

describe('同标签排队', () => {
  it('取消候补后，第三个调用仍等待前任；不同标签不等待', async () => {
    const queue = new TabCallQueue()
    const release = await queue.acquire('a')
    const controller = new AbortController()
    const second = Promise.resolve(queue.acquire('a', controller.signal))
    const cancelled = expect(second).rejects.toThrow('取消候补')
    controller.abort(new Error('取消候补'))
    await cancelled
    let entered = false
    const third = Promise.resolve(queue.acquire('a')).then(done => { entered = true; return done })
    const other = await queue.acquire('b')
    await Promise.resolve()
    expect(entered).toBe(false)
    other()
    release()
    const finish = await third
    expect(entered).toBe(true)
    finish()
  })
})
