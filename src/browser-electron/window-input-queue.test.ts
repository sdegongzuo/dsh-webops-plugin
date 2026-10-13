import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queueModule: any = nodeRequire('./window-input-queue.cjs')
const { WindowInputQueue, PREPARING, QUEUED } = queueModule

/** 起一个队列；时间源可注入，撤销回调收集到数组里。 */
function makeQueue(options: Record<string, unknown> = {}) {
  const revoked: Record<string, unknown>[] = []
  const queue = new WindowInputQueue({
    onRevoke: (snapshot: Record<string, unknown>) => { revoked.push(snapshot) },
    ...options,
  })
  return { queue, revoked }
}

describe('窗口输入权：获取与释放', () => {
  it('空闲立即取得；第二个请求排队，释放后按 FIFO 唤醒', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    expect(first.status).toBe('acquired')

    const second = queue.acquire({ requestId: 'r2', tabId: 't2', budgetMs: 1000 })
    expect(queue.status().queued).toBe(1)

    queue.release(first.ticket!.ticketId as string)
    const secondResult = await second
    expect(secondResult.status).toBe('acquired')
    expect(secondResult.ticket!.tabId).toBe('t2')
    expect(queue.status().queued).toBe(0)
  })

  it('不同标签同一窗口也串行（窗口级互斥，不是标签级）', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const second = queue.acquire({ requestId: 'r2', tabId: 't2', budgetMs: 1000 })
    let secondDone = false
    void second.then(() => { secondDone = true })
    await Promise.resolve()
    expect(secondDone).toBe(false)
    queue.release(first.ticket!.ticketId as string)
    await second
    expect(secondDone).toBe(true)
  })

  it('迟到旧票的 release 被明确拒绝，不影响新票', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    queue.release(first.ticket!.ticketId as string)
    const second = await queue.acquire({ requestId: 'r2', tabId: 't1', budgetMs: 1000 })
    // 旧票再来一次 release：idle（已释放）与 stale（新票在位）都必须拒绝。
    expect(queue.release(first.ticket!.ticketId as string).ok).toBe(false)
    expect(queue.release('never-existed').ok).toBe(false)
    expect(second.status).toBe('acquired')
  })

  it('窗口级申请（空 tabId，open 展示段）：可取票；验票不按标签存在性拒绝', async () => {
    const { queue } = makeQueue()
    // open 的展示段先取票再建标签：tabId 为空串（宿主 acquire-input 不许把它当
    // unknown-tab，否则票永远拿不到、静默回退无票路径）。
    const first = await queue.acquire({ requestId: 'wi-window-1', tabId: '', budgetMs: 1000 })
    expect(first.status).toBe('acquired')
    expect(first.ticket!.tabId).toBe('')
    // 展示段是宿主写路径：验票不传 tabId（标签建好后才知 id）。
    expect(queue.verifyTicket(first.ticket, undefined)).toBe('ok')
    // 显式传了别的 tabId 仍然 tab-mismatch —— 窗口级票不冒领具体标签。
    expect(queue.verifyTicket(first.ticket, 'whatever-tab')).toBe('tab-mismatch')
  })
})

describe('窗口输入权：候补取消与超时', () => {
  it('取消候补（按 requestId）后，后续候补仍按序取得', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const second = queue.acquire({ requestId: 'r2', tabId: 't1', budgetMs: 1000 })
    const third = queue.acquire({ requestId: 'r3', tabId: 't1', budgetMs: 1000 })

    const cancelResult = await queue.cancel('r2')
    expect(cancelResult.status).toBe('cancelled')
    await expect(second).resolves.toEqual({ status: 'cancelled' })

    queue.release(first.ticket!.ticketId as string)
    const thirdResult = await third
    expect(thirdResult.status).toBe('acquired')
  })

  it('排队超时明确返回 timeout，且不影响后面的候补', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const impatient = queue.acquire({ requestId: 'r2', tabId: 't1', budgetMs: 5 })
    const patient = queue.acquire({ requestId: 'r3', tabId: 't1', budgetMs: 1000 })

    await expect(impatient).resolves.toEqual({ status: 'timeout' })
    expect(queue.status().queued).toBe(1)

    queue.release(first.ticket!.ticketId as string)
    await expect(patient).resolves.toMatchObject({ status: 'acquired' })
  })
})

describe('窗口输入权：撤销', () => {
  it('人工接管撤销当前票并通知；候补不撤销，仍按序取得', async () => {
    const { queue, revoked } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const second = queue.acquire({ requestId: 'r2', tabId: 't1', budgetMs: 1000 })

    queue.bumpControlEpoch()
    expect(revoked).toHaveLength(1)
    expect(revoked[0]).toMatchObject({ tabId: 't1', stage: PREPARING, dispatched: false })

    const secondResult = await second
    expect(secondResult.status).toBe('acquired')
    // 新票绑定新的控制代次。
    expect(secondResult.ticket!.controlEpoch).toBe(1)
  })

  it('已派发后撤销带 dispatched 事实，父进程不得自动重放', async () => {
    const { queue, revoked } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    queue.noteDispatched(first.ticket!.ticketId as string)
    expect(queue.status().current!.stage).toBe('dispatching')

    queue.revokeAll('human-takeover')
    expect(revoked[0]).toMatchObject({ stage: 'dispatching', dispatched: true })
  })

  it('blocked 中的票被撤销：照发通报、保持 blocked，只能靠证据恢复', async () => {
    const { queue, revoked } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const ticketId = first.ticket!.ticketId as string
    queue.noteDispatched(ticketId)
    await expect(queue.cancel(ticketId)).resolves.toEqual({ status: 'blocked', stage: 'dispatching' })

    queue.bumpControlEpoch()
    // 通报照发：blocked = 已派发、结果未知（方案 §6：保持 blocked 并报告状态未知）。
    expect(revoked).toHaveLength(1)
    expect(revoked[0]).toMatchObject({ stage: 'blocked', dispatched: true, reason: 'control-changed' })
    // 窗口保持暂停：旧输入可能还会落到人工接管的页面上，不交给下一动作。
    expect(queue.status().blocked).toBe(true)
    expect(queue.status().current!.stage).toBe('blocked')

    // 只有带证据的恢复命令能解除（撤销本身不放权）。
    expect(queue.resolveBlocked(ticketId, 'settled')).toBe(false)
    queue.noteSettled(ticketId)
    expect(queue.resolveBlocked(ticketId, 'settled')).toBe(true)
    expect(queue.status().blocked).toBe(false)
    const next = await queue.acquire({ requestId: 'r2', tabId: 't1', budgetMs: 1000 })
    expect(next.status).toBe('acquired')
  })

  it('窗口重建（epoch+1）后旧票 verifyTicket 一律 stale', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    expect(queue.verifyTicket(first.ticket, 't1')).toBe('ok')
    queue.bumpWindowEpoch()
    expect(queue.verifyTicket(first.ticket, 't1')).toBe('stale-ticket')
  })
})

describe('窗口输入权：投递门', () => {
  it('verifyTicket 拒绝缺票、错 tab、stale 与 blocked', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const ticket = first.ticket!
    expect(queue.verifyTicket(undefined, 't1')).toBe('missing-ticket')
    expect(queue.verifyTicket(ticket, 't2')).toBe('tab-mismatch')
    expect(queue.verifyTicket({ ticketId: 'bogus' }, 't1')).toBe('stale-ticket')
    expect(queue.verifyTicket(ticket, 't1')).toBe('ok')

    queue.noteDispatched(ticket.ticketId as string)
    // dispatching 中取消 → blocked；此时窗口暂停新的前台动作。
    await expect(queue.cancel(ticket.ticketId as string)).resolves.toEqual({
      status: 'blocked',
      stage: 'dispatching',
    })
    expect(queue.verifyTicket(ticket, 't1')).toBe('blocked')
    expect(queue.status().blocked).toBe(true)
  })

  it('人工切标签不废票（临界区结束后才应用）；控制代次变化才废', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const ticket = first.ticket!
    queue.noteHumanSelect()
    // 选择代次只栅自动展示，不栅输入派发（方案 §6：普通切换不是接管，
    // 在短临界区结束后才应用；宿主的写队列把人工选择排到当前输入权释放之后）。
    expect(queue.verifyTicket(ticket, 't1')).toBe('ok')
    expect(queue.autoDisplayEpochAllowed(ticket.selectEpoch as number)).toBe(false)
    // 控制代次变化（人工接管）才立即废票。
    queue.bumpControlEpoch()
    expect(queue.verifyTicket(ticket, 't1')).toBe('stale-ticket')
  })

  it('blocked 只能靠证据解除；换票 / 重连不足以恢复', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const ticketId = first.ticket!.ticketId as string
    queue.noteDispatched(ticketId)
    await queue.cancel(ticketId)
    expect(queue.status().blocked).toBe(true)

    // 无证据 / 假证据一律拒绝。
    expect(queue.resolveBlocked(ticketId, 'reconnected')).toBe(false)
    expect(queue.resolveBlocked(ticketId, '')).toBe(false)
    expect(queue.status().blocked).toBe(true)

    // 真证据：旧输入已 settle 且收尾完成。
    expect(queue.resolveBlocked(ticketId, 'settled')).toBe(false)
    queue.noteSettled(ticketId)
    expect(queue.resolveBlocked(ticketId, 'settled')).toBe(true)
    expect(queue.status().blocked).toBe(false)

    const next = await queue.acquire({ requestId: 'r2', tabId: 't1', budgetMs: 1000 })
    expect(next.status).toBe('acquired')
  })

  it('endpoint-destroyed 证据同样可解除（旧输入不可能再落地）', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const ticketId = first.ticket!.ticketId as string
    queue.noteDispatched(ticketId)
    await queue.cancel(ticketId)
    expect(queue.resolveBlocked(ticketId, 'endpoint-destroyed')).toBe(false)
    queue.confirmEndpointDestroyed('other-tab')
    expect(queue.status().blocked).toBe(true)
    queue.confirmEndpointDestroyed('t1')
    expect(queue.status().blocked).toBe(false)
  })
})

describe('窗口输入权：取消的准备阶段', () => {
  it('preparing 取消等窗口写排空后才确认，迟到写入被拒绝', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const ticketId = first.ticket!.ticketId as string

    const applied: string[] = []
    // 先让一个带票写实际执行完（取消前已完成，不该被追认作废）。
    const writeA = queue.enqueueWindowWrite(async () => { applied.push('a') }, { ticket: { ...first.ticket } })
    await writeA
    // 再排一个：取消后它必须被迟到栅栏拒绝，不能落地。
    const writeB = queue.enqueueWindowWrite(async () => { applied.push('b') }, { ticket: { ...first.ticket } })

    const cancelResult = await queue.cancel(ticketId)
    await writeB

    expect(cancelResult.status).toBe('cancelled')
    expect(applied).toEqual(['a'])
    // 取消返回后，同一张旧票再来写也无效（迟到授权明确拒绝）。
    const writeC = queue.enqueueWindowWrite(async () => { applied.push('c') }, { ticket: { ...first.ticket } })
    await writeC
    expect(applied).toEqual(['a'])
    // 取消后窗口空闲，下一动作能拿到权。
    const next = await queue.acquire({ requestId: 'r2', tabId: 't1', budgetMs: 1000 })
    expect(next.status).toBe('acquired')
  })

  it('finishing（派发已回包）取消等价于释放', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const ticketId = first.ticket!.ticketId as string
    queue.noteDispatched(ticketId)
    queue.noteSettled(ticketId)
    expect(queue.status().current!.stage).toBe('finishing')
    const result = await queue.cancel(ticketId)
    expect(result.status).toBe('cancelled')
    expect(queue.status().current).toBeNull()
  })
})

describe('窗口写队列：人工选择与自动展示', () => {
  it('无票写入等当前输入权释放后执行（人工切换在临界区结束后应用）', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const applied: string[] = []
    const write = queue.enqueueWindowWrite(async () => { applied.push('select') }, { kind: 'human' })
    await Promise.resolve()
    expect(applied).toEqual([])
    queue.release(first.ticket!.ticketId as string)
    await write
    expect(applied).toEqual(['select'])
  })

  it('人工持前台时，agent 的自动展示暂缓（不抢人工页面）', async () => {
    const { queue } = makeQueue({ humanForegroundAllows: () => true })
    const applied: string[] = []
    await queue.enqueueWindowWrite(async () => { applied.push('open') }, { kind: 'agent' })
    expect(applied).toEqual([])
  })

  it('人工自己的选择不受人工前台保护限制', async () => {
    const { queue } = makeQueue({ humanForegroundAllows: () => true })
    const applied: string[] = []
    await queue.enqueueWindowWrite(async () => { applied.push('select') }, { kind: 'human' })
    expect(applied).toEqual(['select'])
  })

  it('人工选择代次：旧代次的自动展示被取消', async () => {
    const { queue } = makeQueue()
    const captured = queue.selectEpoch
    expect(queue.autoDisplayEpochAllowed(captured)).toBe(true)
    queue.noteHumanSelect()
    expect(queue.autoDisplayEpochAllowed(captured)).toBe(false)
    expect(queue.autoDisplayEpochAllowed(queue.selectEpoch)).toBe(true)
  })

  it('窗口写串行：两个无票写入不会交叉执行', async () => {
    const { queue } = makeQueue()
    const order: string[] = []
    const first = queue.enqueueWindowWrite(async () => {
      order.push('first-start')
      await new Promise(resolve => setTimeout(resolve, 10))
      order.push('first-end')
    }, { kind: 'agent' })
    const second = queue.enqueueWindowWrite(async () => { order.push('second') }, { kind: 'agent' })
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })
})

describe('窗口输入权：状态推进', () => {
  it('queued → preparing → dispatching → finishing 全链路', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    expect(queue.status().current!.stage).toBe('preparing')
    const ticketId = first.ticket!.ticketId as string
    queue.noteDispatched(ticketId)
    expect(queue.status().current!.stage).toBe('dispatching')
    queue.noteSettled(ticketId)
    expect(queue.status().current!.stage).toBe('finishing')
    const released = queue.release(ticketId)
    expect(released.ok).toBe(true)
    expect(queue.status().current).toBeNull()
  })

  it('撤销后写队列等待者被唤醒并继续执行', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'r1', tabId: 't1', budgetMs: 1000 })
    const applied: string[] = []
    const write = queue.enqueueWindowWrite(async () => { applied.push('after-revoke') }, { kind: 'agent' })
    queue.bumpControlEpoch()
    await write
    expect(applied).toEqual(['after-revoke'])
    expect(first.status).toBe('acquired')
  })
})

describe('实测回归：窗口占用与终止事实', () => {
  it('人工持有前台时不颁票；后台读仍完成，交还后沿用候补', async () => {
    let human = true
    const { queue } = makeQueue({ humanForegroundAllows: () => human })
    const pending = queue.acquire({ requestId: 'human-wait', tabId: 't2', budgetMs: 1000 })
    expect(queue.status().current).toBeNull()
    const read: string[] = []
    await queue.enqueueWindowWrite(() => { read.push('snapshot') }, { kind: 'read' })
    expect(read).toEqual(['snapshot'])
    human = false
    queue.foregroundChanged()
    expect((await pending).status).toBe('acquired')
  })

  it('截图恢复尚未结束时，不能颁发输入票', async () => {
    const { queue } = makeQueue()
    let finish!: () => void
    const order: string[] = []
    const screenshot = queue.enqueueWindowWrite(async () => {
      order.push('visible')
      await new Promise<void>(resolve => { finish = resolve })
      order.push('restored')
    }, { kind: 'read' })
    await Promise.resolve()
    const pending = queue.acquire({ requestId: 'click', tabId: 't2', budgetMs: 1000 })
    expect(queue.status().current).toBeNull()
    finish()
    await screenshot
    await pending
    expect(order).toEqual(['visible', 'restored'])
  })

  it('准备取消不能等待反向依赖本票的无票截图', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'prep', tabId: 't1', budgetMs: 1000 })
    const screenshot = queue.enqueueWindowWrite(() => 'image', { kind: 'read' })
    await expect(queue.cancel(first.ticket.ticketId)).resolves.toMatchObject({ status: 'cancelled' })
    await expect(screenshot).resolves.toBe('image')
  })

  it('未结束的输入不能 release；第二次输入开始必须重新记在途', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'press', tabId: 't1', budgetMs: 1000 })
    const id = first.ticket.ticketId
    queue.noteDispatched(id)
    queue.noteSettled(id)
    queue.noteDispatched(id)
    expect(queue.release(id)).toMatchObject({ ok: false, reason: 'blocked' })
    expect(queue.resolveBlocked(id, 'settled')).toBe(false)
    queue.noteSettled(id)
    expect(queue.resolveBlocked(id, 'settled')).toBe(true)
  })

  it('按下状态在安全抬起前仍阻塞，不允许声称已 settle 来放权', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'click', tabId: 't1', budgetMs: 1000 })
    const id = first.ticket.ticketId
    queue.noteDispatched(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left' })
    queue.noteSettled(id)
    expect(queue.release(id).ok).toBe(false)
    expect(queue.resolveBlocked(id, 'settled')).toBe(false)
    queue.noteDispatched(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left' })
    queue.blockCurrent()
    queue.noteSettled(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left' })
    expect(queue.resolveBlocked(id, 'settled')).toBe(true)
  })

  it('临界区结束后只应用最后一次人工选择，先于下一张输入票', async () => {
    const { queue } = makeQueue()
    const first = await queue.acquire({ requestId: 'click', tabId: 't1', budgetMs: 1000 })
    const order: string[] = []
    const old = queue.enqueueWindowWrite(() => { order.push('old') }, { kind: 'human' })
    const latest = queue.enqueueWindowWrite(() => { order.push('latest') }, { kind: 'human' })
    const next = queue.acquire({ requestId: 'next', tabId: 't2', budgetMs: 1000 }).then(() => order.push('ticket'))
    queue.release(first.ticket.ticketId)
    await Promise.all([old, latest, next])
    expect(order).toEqual(['latest', 'ticket'])
  })
})
