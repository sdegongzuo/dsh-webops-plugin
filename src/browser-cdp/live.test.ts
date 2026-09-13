/**
 * 对着**真实 Chrome** 跑一遍 P0 的链路。
 *
 * 整组用例只在「端点确实是一个能开的 Chrome」时才跑，否则带原因跳过 —— 所以 `pnpm test`
 * 在没开浏览器的机器上依然是绿的，它只是少跑这一组。要真正执行：
 *
 * ```bash
 * "C:\Program Files\Google\Chrome\Application\chrome.exe" \
 *   --remote-debugging-port=9333 --user-data-dir=%TEMP%\dsh-cdp-profile
 * DSH_CDP_ENDPOINT=http://127.0.0.1:9333 pnpm test
 * ```
 *
 * 判定不是「端口有没有人应答」而是「应答的是不是真 Chrome」：本机 9222 常被 dsh 桌面端的
 * Electron 占着，它同样会 `/json/version` 200，却**不实现** `PUT /json/new` —— 只看可达性的话
 * 这组会带着一个假前提去跑，然后以两条与实现无关的失败收场（这个坑真踩过）。
 *
 * 它验证的是「provider + 真实浏览器」这一段；attachment 落盘用真实的 LocalAttachmentStore，
 * 所以「截图能不能被会话接受」这件事也有实证，而不是只有桩。
 *
 * @module dsh-webops-plugin/browser-cdp/live
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { CdpBrowserProvider } from './provider.ts'
import { validateEndpoint } from './url-policy.ts'

/** 调试端点，可用 `DSH_CDP_ENDPOINT` 覆盖。默认 9222 —— 本机那个端口属于桌面端，见文件头。 */
const ENDPOINT = validateEndpoint(process.env['DSH_CDP_ENDPOINT'] ?? 'http://127.0.0.1:9222')

/** 这组用例跑不跑的判定结果；跳过时带一句人话原因，免得日志里只留一个沉默的 skip。 */
type EndpointProbe = { run: true } | { run: false; reason: string }

/**
 * 探一次端点：能应答 **且** 是真 Chrome 才跑。
 *
 * 嵌入式 Chromium（Electron 系）不实现 `PUT /json/new`，对它跑这组只会得到与实现无关的失败，
 * 所以要先认出来。判据是 `/json/version` 的 `User-Agent`：Electron 一定在里面署名，
 * 而被它包着的 Chrome 版本号看不出区别 —— 只认 `Chrome/` 是不够的。
 */
async function probeEndpoint(): Promise<EndpointProbe> {
  let version: Record<string, unknown>
  try {
    const response = await fetch(`${ENDPOINT}/json/version`, { signal: AbortSignal.timeout(1_000) })
    if (!response.ok) return { run: false, reason: `answered HTTP ${response.status}` }
    version = (await response.json()) as Record<string, unknown>
  } catch {
    return { run: false, reason: 'nothing listening' }
  }

  const userAgent = typeof version['User-Agent'] === 'string' ? version['User-Agent'] : ''
  if (/Electron\//i.test(userAgent)) {
    return { run: false, reason: 'embedded Chromium (Electron), which cannot create tabs' }
  }
  if (!/Chrome\//.test(userAgent)) {
    return { run: false, reason: `not a Chrome DevTools endpoint (User-Agent: ${userAgent || 'absent'})` }
  }
  return { run: true }
}

const PROBE = await probeEndpoint()
if (!PROBE.run) {
  console.info(`[live] skipping the real-browser group: ${PROBE.reason} at ${ENDPOINT}.`)
}

/** 一页有标题、有输入框、有按钮的固定夹具，够验证大纲与 ref。 */
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Browser plugin fixture</title></head>
  <body>
    <h1>Fixture page</h1>
    <form>
      <label for="email">Email</label>
      <input id="email" type="email" name="email" placeholder="you@example.com">
      <button id="submit" type="submit">Submit</button>
    </form>
    <p><a id="link" href="https://example.com/">A link</a></p>
  </body>
</html>
`

describe.runIf(PROBE.run)(`live Chrome at ${ENDPOINT}`, () => {
  let server: Server
  let pageUrl: string
  let provider: CdpBrowserProvider
  let home: string

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FIXTURE_HTML)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    pageUrl = `http://127.0.0.1:${port}/`

    provider = new CdpBrowserProvider({ endpoint: ENDPOINT })
    home = await mkdtemp(join(tmpdir(), 'dsh-browser-live-'))
  })

  afterAll(async () => {
    await provider.dispose()
    // 浏览器对夹具保持 keep-alive，直接 close 会一直等到超时。
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await rm(home, { recursive: true, force: true })
  })

  it('reports the endpoint as available', () => {
    expect(provider.available()).toBe(true)
  })

  it('drives open → snapshot → screenshot → navigate → stale ref → close', async () => {
    const session = await provider.open({ url: pageUrl })
    expect(session.id.length).toBeGreaterThan(0)
    expect(session.url).toContain(`:${new URL(pageUrl).port}`)
    expect(session.title).toBe('Browser plugin fixture')
    expect(session.epoch).toBe(0)

    const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(snapshot.epoch).toBe(1)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.outline).toContain('button "Submit"')
    expect(snapshot.outline).toContain('textbox "Email"')
    // 可操作元素必须有 ref；标题不是可操作元素，所以不该有。
    const button = snapshot.refs.find(ref => ref.role === 'button')
    const textbox = snapshot.refs.find(ref => ref.role === 'textbox')
    const heading = snapshot.refs.find(ref => ref.role === 'heading')
    expect(button?.name).toBe('Submit')
    expect(textbox?.name).toBe('Email')
    expect(heading).toBeUndefined()
    expect(snapshot.outline).toContain(`[ref=${button?.ref as string}]`)

    const viewport = await provider.observe({ kind: 'screenshot', sessionId: session.id })
    if (viewport.kind !== 'screenshot') throw new Error('expected a screenshot')
    expect(viewport.mediaType).toBe('image/png')
    expect(viewport.width).toBeGreaterThan(100)
    expect(viewport.height).toBeGreaterThan(100)
    expect(viewport.ref).toBeUndefined()

    const element = await provider.observe({
      kind: 'screenshot',
      sessionId: session.id,
      ref: button?.ref as string,
    })
    if (element.kind !== 'screenshot') throw new Error('expected a screenshot')
    expect(element.ref).toBe(button?.ref)
    expect(element.width).toBeGreaterThan(0)
    expect(element.height).toBeGreaterThan(0)

    // 导航作废既有 ref（验收第 4 条）。
    const navigated = await provider.navigate({ sessionId: session.id, url: `${pageUrl}?v=2` })
    expect(navigated.epoch).toBe(2)
    await expect(provider.observe({ kind: 'screenshot', sessionId: session.id, ref: button?.ref as string }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_STALE_REF' }))

    const refreshed = await provider.observe({ kind: 'snapshot', sessionId: session.id })
    if (refreshed.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect(refreshed.epoch).toBe(3)
    // 序号跨 snapshot 单调递增，所以新 ref 不可能与旧 ref 同号。
    expect(refreshed.refs.map(ref => ref.ref)).not.toContain(button?.ref)

    const targetId = session.id
    await provider.close(targetId)
    expect(provider.sessionCount).toBe(0)
    // 标签页确实被关掉了，而不是只断开了 WebSocket（验收第 5 条的一半）。
    const listed = await fetch(`${ENDPOINT}/json/list`).then(response => response.json()) as { id: string }[]
    expect(listed.some(target => target.id === targetId)).toBe(false)
  })

  it('stores a real screenshot through the real attachment store', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    const store = ctx.attachments

    const session = await provider.open({ url: pageUrl })
    try {
      const shot = await provider.observe({ kind: 'screenshot', sessionId: session.id })
      if (shot.kind !== 'screenshot') throw new Error('expected a screenshot')

      const ref = await store.saveImage({ data: shot.data, mediaType: shot.mediaType, name: 'browser-screenshot.png' })
      expect(ref.mediaType).toBe('image/png')
      expect(ref.width).toBe(shot.width)
      expect(ref.height).toBe(shot.height)
      expect(ref.bytes).toBeGreaterThan(0)

      const stored = await store.readImage(ref)
      expect(Buffer.from(stored.data)).toEqual(Buffer.from(shot.data))
      const hostPath = store.imageHostPath(ref)
      if (hostPath !== undefined) await expect(stat(hostPath)).resolves.toBeDefined()
    } finally {
      await provider.close(session.id)
    }
  })
})
