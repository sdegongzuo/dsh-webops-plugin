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
import type {
  SessionState,
  AxTreeResult,
  OverlayProbe,
  EvaluateResult,
  ScreenshotClip,
  CaptureResult,
  CaptureSnapshotResult,
  LayoutMetricsResult,
  CallFunctionResult,
  DescribeNodeResult,
} from './provider-session.ts'
import { PageNodes } from './page-nodes.ts'
import { PageNavigation } from './page-navigation.ts'
import { OVERLAY_PROBE_EXPRESSION, ENCLOSING_BLOCK_FUNCTION } from './page-scripts.ts'
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
   *
   * 四种范围：全页（`publish`，推进纪元）/ `region.ref`（给定 ref 的子树或标题章节）/
   * `region.viewport`·`region.box`（几何区域）/ `region.enclosing`（**动作后默认**：
   * 被操作元素所在的区块，见 {@link enclosingAnchor}）。后三种都走 `adopt`（不换表），
   * 并且 `enclosing` 解析不出来时静默降级成全页。
   */
  async snapshot(
    session: SessionState,
    signal?: AbortSignal,
    maxLines?: number,
    region?: Extract<BrowserObserveRequest, { kind: 'snapshot' }>['region'],
    guardGlobal = false,
  ): Promise<BrowserSnapshot> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    const regionKinds = [
      region?.ref !== undefined,
      region?.enclosing !== undefined,
      region?.viewport === true,
      region?.box !== undefined,
    ].filter(Boolean).length
    if (regionKinds > 1) {
      throw new BrowserError(
        'region.ref, region.enclosing, region.viewport and region.box are mutually exclusive; pass exactly one',
        'BROWSER_PROTOCOL_ERROR',
      )
    }
    let regional = regionKinds === 1
    let nodes: readonly AxNode[]
    let outsideRegion: number | undefined
    let globalNodes: readonly AxNode[] | undefined
    if (region?.enclosing !== undefined) {
      // 动作驱动的默认观察：区域 = 被操作元素所在的区块（见 ENCLOSING_BLOCK_FUNCTION）。
      // 三种「不可用」都回退全页，且**不报错** —— 这是一次附带的观察，不能因为点了导航链接
      // 把元素点没了就让「点击已派发」的调用方收到一个观察失败：
      //   ① 元素已经不在了（`enclosingAnchor` 返回 undefined）；
      //   ② 区块在 DOM 里找得到、但 AX 里没有可呈现内容（`keep` 为空）。
      // 这里取全页 AX 是**必须**的：既用来过滤区块，也用来算区域外条目数（与 region.ref 同口径）。
      const full = await session.connection.send<AxTreeResult>('Accessibility.getFullAXTree', {}, options)
      globalNodes = full.nodes ?? []
      const anchor = await this.enclosingAnchor(session, region.enclosing, signal)
      const keep = anchor === undefined ? undefined : await this.backendIdsInSubtree(session, anchor, signal)
      const filtered = keep === undefined ? [] : filterAxTreeByBackendIds(full.nodes ?? [], keep)
      if (filtered.length === 0) {
        regional = false
        globalNodes = undefined
        nodes = full.nodes ?? []
      } else {
        nodes = filtered
        const limits = resolveSnapshotLimits(this.config.snapshotLimits, maxLines)
        const fullRows = buildOutline(full.nodes ?? [], limits).rows.length
        const partRows = buildOutline(nodes, limits).rows.length
        outsideRegion = Math.max(0, fullRows - partRows)
      }
    } else if (region?.ref !== undefined) {
      const target = session.refs.resolve(region.ref)
      const full = await session.connection.send<AxTreeResult>('Accessibility.getFullAXTree', {}, options)
      globalNodes = full.nodes ?? []
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
      globalNodes = full.nodes ?? []
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
    const guardedOverlay = regional && guardGlobal ? await this.detectOverlay(session, signal) : undefined
    if (regional && guardGlobal && (guardedOverlay !== undefined || globalNodes?.some(node => ['dialog', 'alertdialog', 'alert'].includes(String(node.role?.value).toLowerCase())))) {
      nodes = globalNodes ?? nodes
      regional = false
      outsideRegion = undefined
    }
    const outline = buildOutline(nodes, resolveSnapshotLimits(this.config.snapshotLimits, maxLines))
    // 全页快照才查浮层：区域快照本来就是「只看这一块」，中心被别的块盖住不算异常。
    const overlay = regional ? undefined : guardedOverlay ?? await this.detectOverlay(session, signal)
    // 地址与 `loaderId` 必须**随这一份 ref 表一起落地**、不能延后再读（粗门比的就是「发布那一刻的地址」，
    // 晚一步会把人工之间的导航记成快照状态，方案 §5.1.1）。「一起」不是「同一瞬间」：粗门是启发式不是事务。
    const meta = await this.navigation.readPageMeta(session.connection, signal)
    const loaderId = regional ? undefined : await this.navigation.readMainLoaderId(session, signal)
    // 超时/取消后不可发布新纪元，否则模型收到失败却丢掉手上的 ref。
    signal?.throwIfAborted()
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
    const observedRefs = new Set(publication.refs.map(ref => ref.ref))
    const liveRefs = session.refs.list().filter(ref => observedRefs.has(ref.ref))
    return {
      kind: 'snapshot',
      // `enclosing` 沿用 `ref:` 前缀（读作「包含该 ref 的区块」）：模型侧与 find 缓存只区分
      // 「是不是全页」，多造一个前缀只会让两处判据各写一遍。
      scope: !regional ? 'full' : region?.ref !== undefined ? `ref:${region.ref}`
        : region?.enclosing !== undefined ? `ref:${region.enclosing}`
        : region?.viewport === true ? 'viewport'
          : `box:${region!.box!.x},${region!.box!.y},${region!.box!.width},${region!.box!.height}`,
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
        .map((line, index) => ({ line: index, text: line.full ?? '', ...line.fullLength !== undefined ? { sourceLength: line.fullLength, sourceTruncated: line.fullLength > (line.full?.length ?? 0) } : {} }))
        .filter(entry => entry.text !== ''),
      ...outline.unfoldedLines.some(line => line.block !== undefined)
        ? {
          textBlocks: outline.unfoldedLines
            .map((line, index) => ({ line: index, text: line.block ?? '', ...line.blockId !== undefined ? { blockId: line.blockId } : {}, ...line.blockLength !== undefined ? { sourceLength: line.blockLength, sourceTruncated: line.blockLength > (line.block?.length ?? 0) } : {} }))
            .filter(entry => entry.text !== ''),
        }
        : {},
      // 回执只计本次观察发布的引用；区域外旧引用仍保留在 registry，可正常解析。
      refs: liveRefs,
      truncated: regional ? outline.truncated || liveRefs.length < observedRefs.size : publication.truncated,
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
      clip = await this.nodes.elementClip(session, ref, signal)
    }
    // 视口走 renderer；元素裁剪与整页必须走 surface，否则 Chromium 忽略范围。
    // Electron 后台 surface 的出帧由窗口宿主处理，不切活动标签。
    const params: Record<string, unknown> = { format: 'png', fromSurface: clip !== undefined || fullPage }
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

  /**
   * 把「被操作的元素」换算成它所在区块的 `backendNodeId`（动作后默认观察）。
   *
   * 每一步失败都返回 `undefined`，**绝不抛**：这条链跑在动作**之后**，元素被这次点击
   * 换掉（SPA 重渲染是常态）时 `resolveNode` / `callFunctionOn` 都会失败，而那时动作已经
   * 派发、页面已经变了 —— 把观察打成 `observationError` 是对调用方撒谎。找不到区块的语义
   * 就是「回退全页」，由 `snapshot()` 统一处理。
   *
   * 走 `resolveBackendNodeId` 而不是 `resolveObjectId`：后者带**写前门**，而这里是只读观察，
   * 拿不到「同一份文档」的证据时也该照常拍（门是给输入事件用的）。
   */
  private async enclosingAnchor(session: SessionState, ref: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
      const target = session.refs.resolve(ref)
      const objectId = await this.nodes.resolveBackendNodeId(session, ref, target.backendNodeId, signal)
      if (objectId === undefined) return undefined
      try {
        const found = await session.connection.send<CallFunctionResult>(
          'Runtime.callFunctionOn',
          // 返回 DOM 节点本身（不是值）：对象形态才能拿到 objectId，再换 backendNodeId。
          { objectId, functionDeclaration: ENCLOSING_BLOCK_FUNCTION },
          { signal, timeoutMs: this.config.commandTimeoutMs },
        )
        const containerId = found.result?.objectId
        if (containerId === undefined) return undefined
        try {
          const described = await session.connection.send<DescribeNodeResult>(
            'DOM.describeNode',
            { objectId: containerId },
            { signal, timeoutMs: this.config.commandTimeoutMs },
          )
          const backendNodeId = described.node?.backendNodeId
          return typeof backendNodeId === 'number' ? backendNodeId : undefined
        } finally {
          this.nodes.releaseObject(session, containerId, signal)
        }
      } finally {
        this.nodes.releaseObject(session, objectId, signal)
      }
    } catch {
      return undefined
    }
  }

  /**
   * DOM 子树（含给定节点自身）→ AX 过滤用的 `backendNodeId` 集合。
   *
   * 用 DOM 快照的 `parentIndex` 走一遍而不是查 AX 的父子链：区块元素在 AX 里可能被折叠
   * （`display: contents`、被 `aria-hidden` 包着），而它在 DOM 里一定在 —— 拿 DOM 子树做
   * 判据，AX 侧只负责「谁在树上」。找不到该节点（已脱离文档）时返回空集，调用方据此回退全页。
   */
  private async backendIdsInSubtree(
    session: SessionState, backendNodeId: number, signal?: AbortSignal,
  ): Promise<Set<number>> {
    const captured = await session.connection.send<CaptureSnapshotResult>(
      'DOMSnapshot.captureSnapshot', { computedStyles: [] },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    for (const document of captured.documents ?? []) {
      const ids = document.nodes?.backendNodeId ?? []
      const start = ids.indexOf(backendNodeId)
      if (start < 0) continue
      const parents = document.nodes?.parentIndex ?? []
      const children = new Map<number, number[]>()
      for (let index = 0; index < ids.length; index += 1) {
        const parent = parents[index]
        if (parent === undefined || parent < 0) continue
        const siblings = children.get(parent) ?? []
        siblings.push(index)
        children.set(parent, siblings)
      }
      const keep = new Set<number>()
      const visited = new Set<number>()
      const stack = [start]
      while (stack.length > 0) {
        const index = stack.pop() as number
        if (visited.has(index)) continue
        visited.add(index)
        const id = ids[index]
        if (typeof id === 'number') keep.add(id)
        for (const child of children.get(index) ?? []) stack.push(child)
      }
      return keep
    }
    return new Set()
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
