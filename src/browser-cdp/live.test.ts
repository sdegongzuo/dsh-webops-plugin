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

/**
 * SERP 形状的夹具：5 条结果，每条带同一组重复按钮（爬取类页面的通用形态）。
 *
 * 按钮里**一定要有可见文字**：真实树里 `<button aria-label="翻译此页">翻译此页</button>`
 * 会在按钮下面挂一行同名 StaticText —— 折叠的「实例 + 同名标签行」那套规则就是为它写的。
 */
const SERP_HTML = `<!doctype html>
<html lang="zh">
  <head><meta charset="utf-8"><title>SERP fixture</title></head>
  <body>
    <h1>搜索结果</h1>
    <div role="list">
      ${Array.from({ length: 5 }, (_unused, index) => `
      <div role="listitem">
        <h3><a href="https://example.com/${String(index)}">结果标题 ${String(index)}</a></h3>
        <p>结果摘要 ${String(index)}</p>
        <div>
          <button aria-label="翻译此页">翻译此页</button>
          <button aria-label="查看详细信息">查看详细信息</button>
          <button aria-label="分享">分享</button>
        </div>
      </div>`).join('')}
    </div>
  </body>
</html>
`

describe.runIf(PROBE.run)(`live Chrome at ${ENDPOINT}`, () => {
  let server: Server
  let pageUrl: string
  let provider: CdpBrowserProvider
  let home: string

  beforeAll(async () => {
    server = createServer((request, response) => {
      // `/serp` 走 SERP 夹具，其余走基础夹具（折叠那组用例要一张有重复控件的页面）。
      const html = request.url?.startsWith('/serp') === true ? SERP_HTML : FIXTURE_HTML
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
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

  it('folds repeated controls on a SERP-shaped page, keeping every instance addressable', async () => {
    // 这条是**形状契约**测试：折叠的整套设计都建立在「真实树里重复按钮长什么样」之上，
    // 而夹具是我按实测画的 —— Chrome 哪天改了按钮的树形状，只有对着真浏览器跑这条才会知道。
    // 2026-09-18 就是这么抓到一次：真实按钮下面挂着一行同名 `text`，按「有子行就不折」的规则，
    // 真实页面上一个都折不掉，而当时的夹具里没有这个子节点，单测全绿。
    const session = await provider.open({ url: `${pageUrl}serp` })
    try {
      const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')

      // 5 条结果 × 3 个重复按钮 → 每组折掉 4 个实例。
      expect(snapshot.foldedRepeats).toBe(12)
      expect(snapshot.outline).toContain('(folded) button "翻译此页"')
      // 折叠 ≠ 丢寻址：5 个实例的 ref 一个不少。
      expect(snapshot.refs.filter(ref => ref.name === '翻译此页')).toHaveLength(5)
      // 折叠前的底稿里 5 个实例都在（webpage_find 靠它拿回被折叠的 ref）。
      const full = snapshot.fullOutline ?? ''
      expect(full.split('\n').filter(line => line.includes('button "翻译此页"'))).toHaveLength(5)
      // 每个按钮下面那行同名 text 被一起收起（它不是独立元素，也不该继续占行）。
      expect(snapshot.outline).not.toContain('text "翻译此页"')
      // 底稿（find 的检索底稿）里也必须没有它 —— 否则 webpage_find 会为它冒出一条 ref 为空的
      // 幻影命中：模型手里的大纲没这行，find 却报了。这条只能对着真浏览器验。
      expect(full).not.toContain('text "翻译此页"')
      // 折叠后仍能看到正文（标题与摘要没被噪声挤掉）。
      expect(snapshot.outline).toContain('link "结果标题 0"')
      expect(snapshot.outline).toContain('text "结果摘要 0"')
    } finally {
      await provider.close(session.id)
    }
  })

  it('dedupes same-name ancestor chains on a SERP-shaped page without breaking indentation', async () => {
    // 第二条形状契约：真实 SERP 上每条结果是 `heading "X" > link "X" > text "X"` 三行同文，
    // 加上 `<h1>搜索结果</h1>` 的 `heading > text`。这套去重建立在**实测的树形状**上，
    // 夹具一旦和真浏览器漂移，这条就会红。
    const session = await provider.open({ url: `${pageUrl}serp` })
    try {
      const snapshot = await provider.observe({ kind: 'snapshot', sessionId: session.id })
      if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')

      // 5 条结果 × 2 行（heading + 其下同名 text）+ 页面标题那对 = 11。
      // 注意：被折叠实例、以及按钮下面那行同名 text，都算**折叠**的账，不能重复计进这里。
      expect(snapshot.dedupedLines).toBe(11)
      // 留下的必须是带 ref 的那行：`heading` 被抽掉，`link` 顶上。
      expect(snapshot.outline).toContain('link "结果标题 0"')
      expect(snapshot.outline).not.toMatch(/heading "结果标题/gu)
      // 但底稿里只留那行 `link` —— 被去重掉的 heading / text 不进底稿，否则 find 会为它们
      // 冒出一条 ref 为空的幻影命中（2026-09-18 真机全链路套出来的）。
      const full = snapshot.fullOutline ?? ''
      expect(full.split('\n').filter(line => line.includes('"结果标题 0"'))).toHaveLength(1)
      expect(full).not.toContain('text "结果标题 0"')

      // 缩进规范化：抽掉 heading 后不能留下断层，同属一个 listitem 的兄弟行要齐平。
      const depthOf = (line: string): number => Math.floor(((/^( *)- /u.exec(line)?.[1] ?? '').length) / 2)
      const lines = snapshot.outline.split('\n')
      const title = lines.find(line => line.includes('link "结果标题 0"')) ?? ''
      const summary = lines.find(line => line.includes('text "结果摘要 0"')) ?? ''
      expect(depthOf(title)).toBe(depthOf(summary))
      // 通用不变量：任何一行最多比上一行深一级。
      let previous = 0
      for (const line of lines) {
        const depth = depthOf(line)
        expect(depth).toBeLessThanOrEqual(previous + 1)
        previous = depth
      }
    } finally {
      await provider.close(session.id)
    }
  })
})
