/** 页面快照、区域筛选与截图；ref 发布及正文采集集中维护。 */

import {
  type BrowserObserveRequest,
  type BrowserSnapshot,
  BrowserError,
  type BrowserScreenshot,
} from '../browser/types.ts'
import {
  type AxNode,
  filterAxTreeByBackendIds,
  buildOutline,
  resolveSnapshotLimits,
  renderOutline,
  renderOverlayNotice,
  type BoxRect,
  boundsToBox,
  boxesIntersect,
} from './snapshot.ts'
import type { RefTarget } from './refs.ts'
import type {
  SessionState,
  AxTreeResult,
  OverlayProbe,
  EvaluateResult,
  ScreenshotClip,
  CaptureResult,
  CaptureSnapshotResult,
  LayoutMetricsResult,
} from './provider-session.ts'
import { PageNodes } from './page-nodes.ts'
import { PageNavigation } from './page-navigation.ts'
import { OVERLAY_PROBE_EXPRESSION } from './page-scripts.ts'
import { pngDimensions, viewportBoxFromMetrics } from './provider-helpers.ts'
import type { ResolvedConfig } from './provider-config.ts'

export class PageObservation {
  constructor(
    private readonly config: Pick<ResolvedConfig, 'commandTimeoutMs' | 'snapshotLimits'>,
    private readonly nodes: PageNodes,
    private readonly navigation: PageNavigation,
  ) {}

  /**
   * 观察：可访问性树 → 大纲 → 分配 ref（推进纪元）。
   *
   * `maxLines` 只有调用方显式给时才改限额（见 {@link resolveSnapshotLimits}：行数预算和字符
   * 预算一起抬，否则只抬一半会「我调大了还是截断」。长文页默认 800 行必截，这是报告 S3 的
   * 原始问题 —— 现在模型可以自己要求多看几屏）。
   */
  async snapshot(
    session: SessionState,
    signal?: AbortSignal,
    maxLines?: number,
    region?: Extract<BrowserObserveRequest, { kind: 'snapshot' }>['region'],
  ): Promise<BrowserSnapshot> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    const regionKinds = [
      region?.ref !== undefined,
      region?.viewport === true,
      region?.box !== undefined,
    ].filter(Boolean).length
    if (regionKinds > 1) {
      throw new BrowserError(
        'region.ref, region.viewport and region.box are mutually exclusive; pass exactly one',
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    const regional = regionKinds === 1
    let nodes: readonly AxNode[]
    let outsideRegion: number | undefined
    if (region?.ref !== undefined) {
      const target = session.refs.resolve(region.ref)
      const full = await session.connection.send<AxTreeResult>('Accessibility.getFullAXTree', {}, options)
      if (target.anchor === true) {
        // heading 本身的 partial AX 不含后续兄弟正文；按真实 DOM 章节范围筛完整 AX。
        const objectId = await this.nodes.resolveObjectId(session, region.ref, signal)
        try {
          const keep = await this.backendIdsInHeadingSection(session, target.backendNodeId, full.nodes ?? [], signal)
          nodes = filterAxTreeByBackendIds(full.nodes ?? [], keep)
        } finally {
          this.nodes.releaseObject(session, objectId, signal)
        }
      } else {
        const partial = await session.connection.send<AxTreeResult>(
          'Accessibility.getPartialAXTree', { backendNodeId: target.backendNodeId }, options,
        )
        nodes = partial.nodes ?? []
      }
      const fullRows = buildOutline(full.nodes ?? [], resolveSnapshotLimits(this.config.snapshotLimits, maxLines)).rows.length
      const partRows = buildOutline(nodes, resolveSnapshotLimits(this.config.snapshotLimits, maxLines)).rows.length
      outsideRegion = Math.max(0, fullRows - partRows)
    } else if (region?.viewport === true || region?.box !== undefined) {
      const full = await session.connection.send<AxTreeResult>('Accessibility.getFullAXTree', {}, options)
      const keep = await this.backendIdsInRegion(session, region, signal)
      nodes = filterAxTreeByBackendIds(full.nodes ?? [], keep)
      const limits = resolveSnapshotLimits(this.config.snapshotLimits, maxLines)
      const fullRows = buildOutline(full.nodes ?? [], limits).rows.length
      const partRows = buildOutline(nodes, limits).rows.length
      outsideRegion = Math.max(0, fullRows - partRows)
    } else {
      const tree = await session.connection.send<AxTreeResult>('Accessibility.getFullAXTree', {}, options)
      nodes = tree.nodes ?? []
    }
    const outline = buildOutline(nodes, resolveSnapshotLimits(this.config.snapshotLimits, maxLines))
    // 全页快照才查浮层：区域快照本来就是「只看这一块」，中心被别的块盖住不算异常。
    const overlay = regional ? undefined : await this.detectOverlay(session, signal)
    // 地址与 `loaderId` 必须**随这一份 ref 表一起落地**、不能延后再读（粗门比的就是「发布那一刻的地址」，
    // 晚一步会把人工之间的导航记成快照状态，方案 §5.1.1）。「一起」不是「同一瞬间」：粗门是启发式不是事务。
    const meta = await this.navigation.readPageMeta(session.connection, signal)
    const loaderId = regional ? undefined : await this.navigation.readMainLoaderId(session, signal)
    // 脏标记要在**建立新锚点之前**取：它说的是「上**一**次快照之后」，而下面这次 publish 就是新锚点。
    const changed = session.dirty.report()
    const publication = regional
      ? session.refs.adopt(outline.rows)
      : session.refs.publish(outline.rows, outline.truncated, loaderId, meta?.url)
    // 全页快照落地 = 锚点前移。**区域快照不清**：`adopt()` 不换表、旧 ref 继续有效，
    // 「页面在模型之外变过」这件事不会因为拍了一个角落就消失 —— D-5 那条静默改绑链正源于此。
    if (!regional) session.dirty.reset()
    if (meta !== undefined) {
      session.url = meta.url
      session.title = meta.title
    }
    return {
      kind: 'snapshot',
      sessionId: session.targetId,
      epoch: publication.epoch,
      url: session.url,
      title: session.title,
      outline: overlay === undefined
        ? renderOutline(outline, publication.refs)
        : `${renderOverlayNotice(overlay)}\n${renderOutline(outline, publication.refs)}`,
      // 折叠前的完整大纲：`webpage_find` 的检索底稿。折叠标记承诺「用 find 拿全部实例的 ref」，
      // 前提是 find 手上那份底稿里一个实例都不少（`rows` 本来就是全量的，这里只是把它渲染出来）。
      fullOutline: renderOutline(outline, publication.refs, { unfoldRepeats: true }),
      // 正文读取（项 3）：底稿行的未裁切全文与同级 statictext 块文本（稀疏 {行号, 文本}，
      // 行号与 fullOutline 逐行对齐）—— find(full_text=true) 按行号取用。原文可能含换行，
      // 不能 join 成字符串；不进模型上下文，只有 find 按需读取。
      // 空数组也声明正文已采集但无附加全文条目，不能误报缺少快照。
      fullTexts: outline.unfoldedLines
        .map((line, index) => ({ line: index, text: line.full ?? '' }))
        .filter(entry => entry.text !== ''),
      ...outline.unfoldedLines.some(line => line.block !== undefined)
        ? {
          textBlocks: outline.unfoldedLines
            .map((line, index) => ({ line: index, text: line.block ?? '' }))
            .filter(entry => entry.text !== ''),
        }
        : {},
      refs: session.refs.list(),
      truncated: publication.truncated,
      outlineLines: outline.lines.length,
      ...outline.truncated ? { droppedElements: outline.droppedElements } : {},
      ...outline.foldedRepeats > 0 ? { foldedRepeats: outline.foldedRepeats } : {},
      ...outline.dedupedLines > 0 ? { dedupedLines: outline.dedupedLines } : {},
      ...outsideRegion !== undefined ? { outsideRegion } : {},
      // 人工接管只加提示，**不动 epoch** —— 开合 DevTools 不该作废模型的 ref（[V31]）。
      ...session.takeover ? { takeover: true } : {},
      // P2：页面在本会话之外变过的分类计数（脏时才出现）。
      ...changed !== undefined ? { pageChanged: changed } : {},
      // D-5：本次区域快照把哪几个号的指针换到了别的节点上（只报不作废）。只有 `adopt()`
      // 那条路会产生它 —— 全页 `publish()` 一律发新号，恒为空。
      ...publication.rebound.length > 0 ? { reboundRefs: publication.rebound } : {},
    }
  }

  /**
   * 查「视口中心是不是被一层浮层盖着」（B2-d）。
   *
   * 为什么需要它：没有 `role=dialog` 的浮层在 AX 里排在 `<body>` **末尾**，而小 `max_lines`
   * 会把它整段截掉 —— 于是模型拿到的第一屏看起来「页面可以直接点正文」，一点才发现点在遮罩上。
   *
   * 判定用「命中链上有没有一个 fixed/absolute 且盖住视口 60% 以上的祖先」而不是方案原文写的
   * 「命中行是否在前 30 行」：后者要靠 `DOM.requestNode` + `DOM.describeNode` 把命中元素换成
   * `backendNodeId` 再查 ref 表（多两条命令），且对**已截断**的大纲仍只能靠文本猜行号 ——
   * 花三倍代价换一个更脆的信号，不值。定位覆盖判据是纯 CSS 事实，与大纲怎么切无关。
   *
   * 失败/查不出来一律当「没有浮层」：这是回执增强，不许把快照打成失败。
   */
  private async detectOverlay(session: SessionState, signal?: AbortSignal): Promise<OverlayProbe | undefined> {
    try {
      const evaluated = await session.connection.send<EvaluateResult>(
        'Runtime.evaluate',
        { expression: OVERLAY_PROBE_EXPRESSION, returnByValue: true },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      const value = evaluated.result?.value as Partial<OverlayProbe> | null | undefined
      if (value === null || typeof value !== 'object') return undefined
      // 页面里那份脚本的返回体是**不可信数据**（页面可以改写 `elementFromPoint` 之类的东西），
      // 字段一律按字符串收下；三项全空就当没查到。
      const role = typeof value.role === 'string' ? value.role : ''
      const name = typeof value.name === 'string' ? value.name : ''
      const hint = typeof value.hint === 'string' ? value.hint : ''
      if (role.length === 0 && name.length === 0 && hint.length === 0) return undefined
      return { role, name, hint }
    } catch {
      return undefined
    }
  }

  /** 观察：整页 / 视口 / 元素截图。元素级截图会先解析 ref，旧 ref 直接 `BROWSER_STALE_REF`。 */
  async screenshot(
    session: SessionState,
    ref: string | undefined,
    fullPage: boolean,
    signal?: AbortSignal,
  ): Promise<BrowserScreenshot> {
    let clip: ScreenshotClip | undefined
    if (ref !== undefined) {
      // 解析放在发命令之前：ref 失效时应当立刻失败，而不是先截一张错的图。
      const target: RefTarget = session.refs.resolve(ref)
      clip = await this.nodes.elementClip(session, ref, target.backendNodeId, signal)
    }
    // `fromSurface: false` 从渲染器取帧而不是合成器表面：默认的表面路径在
    // 「看不见的页面」上不出帧会**永久挂起** —— [V33] 的 show:false 窗口、以及
    // 多标签场景里 setVisible(false) 的后台标签（2026-09-13 多会话演示实测，
    // 30s 超时前不返回）。渲染器路径对前台/后台标签都强制出一帧，没有这个坑。
    const params: Record<string, unknown> = { format: 'png', fromSurface: false }
    if (clip !== undefined) {
      params['clip'] = clip
      params['captureBeyondViewport'] = true
    } else if (fullPage) {
      params['captureBeyondViewport'] = true
    }
    const captured = await session.connection.send<CaptureResult>(
      'Page.captureScreenshot',
      params,
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const encoded = captured.data
    if (encoded === undefined || encoded.length === 0) {
      throw new BrowserError('Page.captureScreenshot returned no image data', 'BROWSER_PROTOCOL_ERROR')
    }
    const data = Uint8Array.from(Buffer.from(encoded, 'base64'))
    const size = pngDimensions(data)
    return {
      kind: 'screenshot',
      sessionId: session.targetId,
      epoch: session.refs.currentEpoch,
      data,
      mediaType: 'image/png',
      width: size.width,
      height: size.height,
      ...ref !== undefined ? { ref } : {},
    }
  }

  /** 从标题到下一个同级/更高级标题，限制在最近 section/article/main/body 内；只读真实 DOM。 */
  private async backendIdsInHeadingSection(
    session: SessionState, backendNodeId: number, axNodes: readonly AxNode[], signal?: AbortSignal,
  ): Promise<Set<number>> {
    const captured = await session.connection.send<CaptureSnapshotResult>(
      'DOMSnapshot.captureSnapshot', { computedStyles: [] },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const levels = new Map<number, number>()
    for (const node of axNodes) {
      if (String(node.role?.value).toLowerCase() !== 'heading' || node.backendDOMNodeId === undefined) continue
      const level = node.properties?.find(property => property.name === 'level')?.value?.value
      levels.set(node.backendDOMNodeId, typeof level === 'number' ? level : 1)
    }
    for (const document of captured.documents ?? []) {
      const ids = document.nodes?.backendNodeId ?? []
      const start = ids.indexOf(backendNodeId)
      if (start < 0) continue
      const parents = document.nodes?.parentIndex ?? []
      const names = document.nodes?.nodeName ?? []
      const nameAt = (index: number): string => captured.strings?.[names[index] ?? -1]?.toUpperCase() ?? ''
      let scope = parents[start] ?? -1
      const seen = new Set<number>()
      while (scope >= 0 && !seen.has(scope)) {
        seen.add(scope)
        if (['SECTION', 'ARTICLE', 'MAIN', 'BODY'].includes(nameAt(scope))) break
        scope = parents[scope] ?? -1
      }
      const inScope = (index: number): boolean => {
        if (scope < 0) return true
        const visited = new Set<number>()
        for (let parent = index; parent >= 0 && !visited.has(parent); parent = parents[parent] ?? -1) {
          if (parent === scope) return true
          visited.add(parent)
        }
        return false
      }
      const keep = new Set<number>()
      const level = levels.get(backendNodeId) ?? (Number(nameAt(start).slice(1)) || 1)
      for (let index = start; index < ids.length && inScope(index); index += 1) {
        const id = ids[index]
        if (id === undefined) continue
        const nextLevel = levels.get(id)
        if (index > start && nextLevel !== undefined && nextLevel <= level) break
        keep.add(id)
      }
      return keep
    }
    throw new BrowserError('the heading anchor is absent from the current DOM; take a fresh snapshot', 'BROWSER_STALE_REF')
  }

  /** 视口 / 几何矩形：用一次 captureSnapshot 的布局盒与区域求交，得到 backendNodeId 集合。 */
  private async backendIdsInRegion(
    session: SessionState,
    region: { readonly viewport?: boolean; readonly box?: BoxRect },
    signal?: AbortSignal,
  ): Promise<Set<number>> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    const metrics = await session.connection.send<LayoutMetricsResult>('Page.getLayoutMetrics', {}, options)
    let area: BoxRect | undefined = region.box ?? viewportBoxFromMetrics(metrics)
    if (area === undefined) return new Set()
    // 高 DPI 的真实 Chrome 布局快照使用设备坐标，而区域参数使用 CSS 坐标。
    // 从同次布局指标取比例，不把系统缩放固定成 2；缺 CSS 指标时沿用旧协议坐标。
    const css = metrics.cssLayoutViewport ?? metrics.cssVisualViewport
    const layout = metrics.layoutViewport ?? metrics.visualViewport
    const scale = css?.clientWidth !== undefined && css.clientWidth > 0
      && layout?.clientWidth !== undefined && layout.clientWidth > 0
      ? layout.clientWidth / css.clientWidth : 1
    area = { x: area.x * scale, y: area.y * scale, width: area.width * scale, height: area.height * scale }
    const captured = await session.connection.send<CaptureSnapshotResult>(
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [] },
      options,
    )
    const keep = new Set<number>()
    for (const document of captured.documents ?? []) {
      const ids = document.nodes?.backendNodeId ?? []
      const indexes = document.layout?.nodeIndex ?? []
      const bounds = document.layout?.bounds ?? []
      for (let index = 0; index < indexes.length; index += 1) {
        const nodeIndex = indexes[index]
        const raw = bounds[index]
        const box = raw === undefined ? undefined : boundsToBox(raw)
        if (nodeIndex === undefined || box === undefined) continue
        if (!boxesIntersect(area, box)) continue
        const backend = ids[nodeIndex]
        if (typeof backend === 'number') keep.add(backend)
      }
    }
    return keep
  }

}
