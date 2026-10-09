/** 节点身份复核、写前门、几何测量、命中检测及高亮。 */

import {
  type BrowserLocateRequest,
  type BrowserLocateResult,
  BrowserError,
  type BrowserRevalidateFailure,
} from '../browser/types.ts'
import type { RefTarget } from './refs.ts'
import { sameDocumentIdentity } from './dirty.ts'
import type { StaleRefMetrics } from './metrics.ts'
import {
  type EvaluateResult,
  type SessionState,
  type AxTreeResult,
  type ResolveNodeResult,
  noteDocumentChange,
  type HitTestOutcome,
  type ScreenshotClip,
  type BoxModelResult,
} from './provider-session.ts'
import {
  boxCenteredInViewport,
  axIdentity,
  boxIntersectsViewport,
  sleepForRetry,
} from './provider-helpers.ts'
import { LOCATE_MEASURE_SNIPPET, HIT_TEST_FUNCTION } from './page-scripts.ts'
import type { ResolvedConfig } from './provider-config.ts'

export class PageNodes {
  constructor(
    private readonly config: Pick<ResolvedConfig, 'commandTimeoutMs'>,
    private readonly metrics: StaleRefMetrics,
  ) {}

  /**
   * P3：按 ref 现算元素的视口坐标盒（方案 4.3 / 4.4）。
   *
   * 定位链路照 `[V36]` 实测：`refs.resolve(ref)`（纪元校验沿用既有路径，从不绕开）→
   * `backendNodeId` → `DOM.resolveNode`（无需 `DOM.enable`）→ `Runtime.callFunctionOn`
   * 现算 rect。**不用 nodeId**（`[V19]` 实测重复 `getDocument` 后重新分配），**不引
   * selector**（重构后可能静默命中另一个元素；backendNodeId 是「指向」语义，失败可检出）。
   *
   * ## 三道失效守卫（方案 4.4 + `[V36]`，缺一不可）
   *
   * 1. `DOM.resolveNode` 抛错 / 拿不到 objectId → `BROWSER_STALE_REF`（节点彻底没了）；
   * 2. resolve 成功但 `this.isConnected === false` → `BROWSER_STALE_REF` —— **`[V36]` 实测
   *    `replaceWith` 换掉元素后 resolveNode 仍然成功**，只查 resolveNode 会漏这一档；
   * 3. rect 宽高为 0 → `BROWSER_PROTOCOL_ERROR`。理由：节点还在文档里、只是没布局
   *    （`display:none` / 未渲染），ref 并没有失效，所以不报 `BROWSER_STALE_REF`；沿用
   *    click 路径对「元素没有可用布局盒」的既有错误码，并绝不拿 0 坐标假装成功。
   *
   * **每次调用都现算 rect，绝不缓存 snapshot 时的几何**（方案 4.4 的硬要求）：snapshot
   * 之后的几何大概率已变，「现算」是 isConnected 之外唯一的兜底，缓存等于把兜底拆掉。
   * 已知的剩余漏报区间：节点还在且 connected，但被页面复用显示另一条数据 —— 没有廉价
   * 检测手段，坐标对不对要由调用方按业务语义判断（注释别写成「兜底完备」）。
   *
   * **不滚动视口**（`scroll` 默认 false，2026-09-14 改）：默认 `scrollIntoView` 会让 locate
   * 既验证不了「刚才那次 scroll 生效没有」，又悄悄改掉用户看到的画面。要看元素当下的位置就
   * 保持默认；确实需要把它挪到视口中央再量时才传 `scroll: true`。
   */
  async locate(session: SessionState, request: BrowserLocateRequest, signal?: AbortSignal): Promise<BrowserLocateResult> {
    this.metrics.noteRefCall(session.targetId)
    // 纪元校验走既有 resolve 路径：从未观察 → BROWSER_SNAPSHOT_REQUIRED，旧纪元 → BROWSER_STALE_REF。
    const target = session.refs.resolve(request.ref)
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    // 映射统一走 `resolveBackendNodeId`（detach / 连接丢失照原码上抛，其余算 ref 失效）——
    // 这里原本自己写了一份，抽出去之后 mutate 与 elementClip 才用得上同一个口径。
    const objectId = await this.resolveBackendNodeId(session, request.ref, target.backendNodeId, signal)
    if (objectId === undefined) {
      this.metrics.noteStale(session.targetId, 'node_gone')
      throw new BrowserError(
        `the element for ref "${request.ref}" is no longer attached to the document; run webpage_snapshot again`,
        'BROWSER_STALE_REF',
        { reason: 'node_gone' },
      )
    }
    try {
      // 守卫 2（[V36]）：resolveNode 成功 ≠ 节点还连在文档上，量 rect 之前先查 isConnected。
      const connected = await session.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: 'function () { return this.isConnected; }', returnByValue: true },
        options,
      )
      if (connected.result?.value !== true) {
        this.metrics.noteStale(session.targetId, 'detached')
        throw new BrowserError(
          `the element for ref "${request.ref}" was removed from the document (the page may have `
          + 're-rendered); run webpage_snapshot again',
          'BROWSER_STALE_REF',
          { reason: 'detached' },
        )
      }
      const scroll = request.scroll ?? false
      // 守卫 3 落在 elementViewportBox 的零尺寸校验里（见上，选 BROWSER_PROTOCOL_ERROR 的理由）。
      // locate 是只读观察：零布局失败要和「可能已派发的动作失败」分开描述（2026-10-07 计划项 5），
      // 明确告诉模型页面上什么都没改过，避免它把定位失败当成一次已生效的写操作。
      let box
      try {
        box = await this.elementViewportBox(session, objectId, signal, scroll, scroll ? 'centred' : 'visible')
      } catch (error) {
        if (error instanceof BrowserError && error.code === 'BROWSER_PROTOCOL_ERROR'
          && error.message.includes('layout box')) {
          throw new BrowserError(
            `the element for ref "${request.ref}" has no usable layout box (display:none or not laid out); `
            + 'this was a read-only measurement and NOTHING was changed on the page',
            'BROWSER_PROTOCOL_ERROR',
            { cause: error.cause },
          )
        }
        throw error
      }
      if (request.highlight === true) await this.paintHighlight(session, objectId, signal)
      else if (session.highlightPainted) await this.clearHighlight(session, signal)
      const inViewport = box.viewportWidth === undefined || box.viewportHeight === undefined
        ? undefined
        : box.x + box.width > 0 && box.y + box.height > 0
          && box.x < box.viewportWidth && box.y < box.viewportHeight
      // centered 是**测得事实**不是请求回显（2026-10-07 独立验收）：scroll=true 且最终一次
      // 测量「元素中心对齐视口中心」才算居中成功 —— 「元素中心落在视口内」只是看得见，
      // smooth 动画刚进视口的中间帧会被它谎报成已居中。测不到视口尺寸（undefined）或视口
      // 为零时无法证明居中，一律 false，绝不默认成功（旧实现 `?? true` 正是漏报口）。
      const centered = scroll ? boxCenteredInViewport(box) === true : false
      return {
        kind: 'locate',
        sessionId: session.targetId,
        epoch: session.refs.currentEpoch,
        ref: request.ref,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        centered,
        scrollRequested: scroll,
        ...inViewport !== undefined ? { inViewport } : {},
      }
    } finally {
      this.releaseObject(session, objectId, signal)
    }
  }

  /**
   * 恢复一条 ref。当前表命中直接算成功；归档命中才走 loaderId → resolveNode → role/name。
   */
  async revalidateOne(
    session: SessionState,
    ref: string,
    loaderId: string | undefined,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; target: RefTarget; restore: boolean }
    | { ok: false; reason: BrowserRevalidateFailure['reason'] }
  > {
    try {
      const current = session.refs.resolve(ref)
      return { ok: true, target: current, restore: false }
    } catch (error: unknown) {
      if (error instanceof BrowserError && error.code === 'BROWSER_SNAPSHOT_REQUIRED') throw error
      if (!(error instanceof BrowserError) || error.code !== 'BROWSER_STALE_REF') throw error
    }
    const archived = session.refs.archived(ref)
    if (archived === undefined) return { ok: false, reason: 'not_archived' }
    // 文档身份是第一道门：对不上就停，不看 backendNodeId。
    if (archived.loaderId === undefined || loaderId === undefined || archived.loaderId !== loaderId) {
      return { ok: false, reason: 'document_changed' }
    }
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    let objectId: string | undefined
    try {
      objectId = await this.resolveNodeObjectId(session, archived.target.backendNodeId, signal)
    } catch (error: unknown) {
      if (error instanceof BrowserError
        && (error.code === 'BROWSER_DEBUGGER_DETACHED' || error.code === 'BROWSER_CONNECTION_LOST')) {
        throw error
      }
      this.metrics.noteStale(session.targetId, 'node_gone')
      return { ok: false, reason: 'node_gone' }
    }
    if (objectId === undefined) {
      this.metrics.noteStale(session.targetId, 'node_gone')
      return { ok: false, reason: 'node_gone' }
    }
    try {
      const connected = await session.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: 'function () { return this.isConnected; }', returnByValue: true },
        options,
      )
      if (connected.result?.value !== true) {
        this.metrics.noteStale(session.targetId, 'detached')
        return { ok: false, reason: 'node_gone' }
      }
    } finally {
      this.releaseObject(session, objectId, signal)
    }
    const partial = await session.connection.send<AxTreeResult>(
      'Accessibility.getPartialAXTree',
      { backendNodeId: archived.target.backendNodeId },
      options,
    )
    const live = axIdentity(partial.nodes ?? [], archived.target.backendNodeId)
    if (live === undefined
      || live.role !== archived.target.role
      || live.name !== archived.target.name) {
      this.metrics.noteStale(session.targetId, 'identity_mismatch')
      return { ok: false, reason: 'identity_mismatch' }
    }
    return { ok: true, target: archived.target, restore: true }
  }

  /**
   * `DOM.resolveNode({ backendNodeId })` → 远端对象句柄（`[V36]`：无需 `DOM.enable`）。
   *
   * 节点已销毁时 Chrome 回 CDP 错误（原样上抛，由调用方决定映射）；返回体里缺
   * `objectId` 时返回 `undefined` —— 两种「拿不到句柄」的形态要分开处理。
   */
  private async resolveNodeObjectId(
    session: SessionState,
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const resolved = await session.connection.send<ResolveNodeResult>(
      'DOM.resolveNode',
      { backendNodeId },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    return resolved.object?.objectId
  }

  /**
   * 按 `backendNodeId` 取句柄，并**把「节点没了」统一映射成 `BROWSER_STALE_REF`**。
   *
   * 为什么需要这一步（`resolveNodeObjectId` 的契约把映射留给调用方，而三个调用方里
   * 只有 `locate` 做了 —— 另两个漏了，于是模型收到的是一个**没有恢复指引的裸协议错误**）：
   *
   * - CDP 对不存在的节点走的是**抛错**，不是「成功返回但没带 `object`」。实测两种话术：
   *   `No node with given id found`（会话 f6b89609 的 `[4.1]`）与
   *   `Node with given id does not belong to the document`（`scripts/probe-stale-node.ts` 重放，
   *   同 URL 整页刷新后再用旧 ref）。两条都是 `-32000`，都带 `BROWSER_PROTOCOL_ERROR`。
   * - 所以 `resolveNodeObjectId` 里那个 `objectId === undefined` 分支**兜不住它们**，
   *   异常直接穿透到工具层 → 模型看到 `CDP error: …`，既不知道页面变了、也不知道该重拍。
   *   这正是 §5.1 注释里「地址不变的整页刷新已由 resolveNode 兜成 BROWSER_STALE_REF」
   *   那句话的**反面**：当初 22/22 量的是「解析失败与否」，没量「失败翻成什么码」。
   *
   * **会话级失败照原码上抛**：detach（`[V16]`）与连接丢失不是 ref 失效，
   * 让模型「重拍快照」是错的指引（`locate` 早已按这个分寸写，这里保持一致）。
   */
  async resolveBackendNodeId(
    session: SessionState,
    ref: string,
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return await this.resolveNodeObjectId(session, backendNodeId, signal)
    } catch (error: unknown) {
      if (error instanceof BrowserError
        && (error.code === 'BROWSER_DEBUGGER_DETACHED' || error.code === 'BROWSER_CONNECTION_LOST')) throw error
      this.metrics.noteStale(session.targetId, 'node_gone')
      throw new BrowserError(
        `the element for ref "${ref}" is gone from the document; run webpage_snapshot again`,
        'BROWSER_STALE_REF',
        { cause: error, reason: 'node_gone' },
      )
    }
  }

  /**
   * 把 ref 解析成远端对象句柄。
   *
   * **第一步**就是查纪元表：ref 失效（或从未 snapshot）时这里直接抛
   * `BROWSER_STALE_REF` / `BROWSER_SNAPSHOT_REQUIRED`，后面的 CDP 命令一条都
   * 不会发 —— 这就是「写前检查纪元」。
   *
   * `allowDetached`：`webpage_wait` 的 hidden 分支**以「元素消失」为成功条件**，
   * 细门在这里不能拦（否则永远等不到 satisfied）。粗门照查。
   */
  async resolveObjectId(
    session: SessionState,
    ref: string,
    signal?: AbortSignal,
    options?: { allowDetached?: boolean },
  ): Promise<string> {
    const target = session.refs.resolve(ref)
    // 走 `resolveBackendNodeId` 而不是裸调 `resolveNodeObjectId`：后者把「节点没了」的
    // 两种形态分开处理，映射交给调用方 —— 这一处以前漏了，裸协议错误会一路穿透到模型。
    const objectId = await this.resolveBackendNodeId(session, ref, target.backendNodeId, signal)
    if (objectId === undefined) {
      this.metrics.noteStale(session.targetId, 'node_gone')
      throw new BrowserError(
        'the observed element is no longer attached to the document; run webpage_snapshot again',
        'BROWSER_STALE_REF',
        { reason: 'node_gone' },
      )
    }
    await this.assertPreActionGate(session, ref, objectId, signal, options?.allowDetached === true)
    return objectId
  }

  /**
   * **写前门**（方案 §5.1）：动作派发之前，拿手上的句柄核一次「页面还是不是我拍快照那一刻」。
   *
   * 为什么必须有它：`refs.resolve` 只保证「ref 属于当前纪元」，而当前纪元可能在模型
   * 决策期间就被人工换成了另一份文档 —— 同文档 SPA 路由连 `backendNodeId` 都不重编
   * （方案 §1.4），于是旧 ref 会静默命中新页面上的另一个元素。这里是**唯一还来得及拦**的时刻。
   *
   * 三档的实际落点（都比 D-3 批的「+1 次往返」不多花）：
   * - **粗门 `url`**：与 `refs.publishedUrl` 比**文档身份**（D-6=B 按纪元存一条 + D-19 只比
   *   `scheme+host+path`）。身份变了才作废；只有 query / hash 变时放过这一次动作、记一笔脏 ——
   *   理由与代价见下面那段注释。
   * - **细门 `isConnected`**：`[V36]` 实测「resolveNode 成功 ≠ 节点还在文档里」，
   *   这一档此前只有 `locate` 查，mutate 路径是漏的。
   * - **中门 `loaderId` 不单独花一次往返**，因为它能抓到而粗门抓不到的只有一类
   *   （地址不变的整页刷新），而那一类新文档会让旧 `backendNodeId` 解析失败 ——
   *   上面 `resolveNodeObjectId` 已经把它兜成 `BROWSER_STALE_REF`（实测 22/22 失败，方案 §10.4）。
   *   **它兜不住的是同文档重排**：role/name 档才管得到，那是已知剩余漏报区间，
   *   与 `locate` 的口径一致（见该方法的注释），不在本轮补。
   *
   * 读不到值（页面上下文异常、evaluate 抛错）时**放行**：门只负责「证据确凿就拦」，
   * 拿不到证据不该把一次正常操作变成失败 —— 交给既有守卫和动作后的 `detectNavigation`。
   *
   * @throws `BROWSER_STALE_REF` —— 此时**一个输入事件都还没派发**。
   */
  private async assertPreActionGate(
    session: SessionState,
    ref: string,
    objectId: string,
    signal?: AbortSignal,
    allowDetached = false,
  ): Promise<void> {
    const publishedUrl = session.refs.publishedUrl
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.callFunctionOn',
      {
        objectId,
        // 比对的是「纪元记录的地址 vs 当下**顶层文档**的地址」：纪元地址出自顶层的
        // `readPageMeta`，而 `location.href` 取的是元素自己那个文档 —— 直接比它会让 iframe 里的元素
        // 必然「地址变了」。读 `window.top.location.href` 对同文档子 frame 仍然有效。
        // 那个 try 不是为了让粗门多覆盖一档（跨源读不到照样放行），而是为了**同一次往返仍带回
        // `isConnected`**：不兜住异常，跨源 frame 里连细门都会一起静默。
        functionDeclaration: 'function () { let top = null; try { top = window.top.location.href; } catch (e) { top = null; } return { url: top, connected: this.isConnected }; }',
        returnByValue: true,
      },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    ).catch(() => undefined)
    const value = evaluated?.result?.value
    if (typeof value !== 'object' || value === null) return
    const { url, connected } = value as Record<string, unknown>
    if (publishedUrl !== undefined && typeof url === 'string' && url !== '') {
      if (!sameDocumentIdentity(url, publishedUrl)) {
        // 文档身份（scheme + host + path）变了：整个纪元的 ref 都不该再用，作废它并让模型重拍。
        session.refs.invalidate()
        noteDocumentChange(session)
        // 句柄是自己拿的，抛错前必须还 —— 调用方还没拿到 objectId，它的 finally 释放不到。
        this.metrics.noteStale(session.targetId, 'stale_document')
        this.releaseObject(session, objectId, signal)
        throw new BrowserError(
          `ref "${ref}" points at a stale document: the page moved from ${publishedUrl} to ${url} `
          + 'since the snapshot; the action was NOT dispatched; run webpage_snapshot again',
          'BROWSER_STALE_REF',
          { reason: 'stale_document' },
        )
      }
      // D-19：同一份文档，只有 query / hash 变了 —— **不作废纪元、也不拦这次动作**。
      //
      // 为什么放开：Google 类页面每交互一次就换一批遥测令牌（`sxsrf=` / `sca_esv=` / `ei=` …），
      // 全文全等比较会把每次抖动都判成「换文档」，于是模型手上 ref 全废、必须重拍一次
      // （§5.1.2 ① 实测 17 次检出里 5 次是纯抖动；一次重拍中位 ≈5500 字符）。
      //
      // 为什么敢放开：① 同 path 换 query 在搜索结果页确实可能是**真变化**，所以这里不作废、
      // 但照样如实标脏，把判断交回模型；② 真换掉文档的那一类仍有兜底 —— `backendNodeId`
      // 随文档重新编号，`DOM.resolveNode` 会解析失败，翻成更熟悉的那条
      // `BROWSER_STALE_REF(node_gone)`（§10.4 实测 22/22 失败），只是晚了一次往返。
      if (url !== publishedUrl) session.dirty.noteAddressDrift(publishedUrl, url)
    }
    if (connected === false && !allowDetached) {
      this.metrics.noteStale(session.targetId, 'detached')
      this.releaseObject(session, objectId, signal)
      throw new BrowserError(
        `the element for ref "${ref}" was removed from the document (the page may have re-rendered); `
        + 'the action was NOT dispatched; run webpage_snapshot again',
        'BROWSER_STALE_REF',
        { reason: 'detached' },
      )
    }
  }

  /** 释放远端对象句柄（尽力而为；释放失败不影响主流程）。 */
  releaseObject(session: SessionState, objectId: string, signal?: AbortSignal): void {
    void session.connection
      .send('DOM.releaseObject', { objectId }, { signal })
      .catch(() => undefined)
  }

  /**
   * 取元素的视口坐标盒（`scroll=true` 时先滚动到视口中央再量）。
   *
   * 用 `Runtime.callFunctionOn` + `getBoundingClientRect` 而不是 `DOM.getBoxModel`：
   * 后者给的是文档坐标，而 `Input.dispatchMouseEvent` 吃的是视口坐标；
   * 元素在视口外时文档坐标直接把事件点到看不见的地方去。
   *
   * `scroll=false` 跳过 `scrollIntoView`（`webpage_locate` 的默认路径）：只读坐标、不动视口。
   * 零尺寸在此统一拒绝 —— click 的落点与 locate 的「不可见」判定都不能建立在 0 宽高的盒子上。
   *
   * 同一次调用顺带把视口尺寸带回来（`webpage_locate` 判 `in_viewport` 用，省一次往返）；
   * 老实现没有这两个字段，所以按可选读，读不到就是 `undefined`。
   *
   * `waitGoal` 决定 smooth 滚动重测的**停止条件**（2026-10-07 独立验收）：
   * `'centred'`（locate scroll=true）等到「元素真居中」为止；`'visible'`（click / scroll）
   * 只要元素与视口有交集就够 —— 动作只要求打得中，等居中是白付 600ms。
   */
  async elementViewportBox(
    session: SessionState,
    objectId: string,
    signal?: AbortSignal,
    scroll = true,
    waitGoal: 'visible' | 'centred' = 'visible',
  ): Promise<{ x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }> {
    const measure = LOCATE_MEASURE_SNIPPET
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: scroll
          ? `function () { this.scrollIntoView({ block: "center", inline: "center" });${measure}`
          : `function () {${measure}`,
        returnByValue: true,
      },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    let value = evaluated.result?.value
    if (typeof value !== 'object' || value === null) {
      throw new BrowserError('could not read the element box for interaction', 'BROWSER_PROTOCOL_ERROR')
    }
    let box = value as Record<string, unknown>
    const x = box['x']
    const y = box['y']
    const width = box['width']
    const height = box['height']
    if (
      typeof x !== 'number' || typeof y !== 'number'
      || typeof width !== 'number' || typeof height !== 'number'
      || !(width > 0) || !(height > 0)
    ) {
      throw new BrowserError('the element has no usable layout box to interact with', 'BROWSER_PROTOCOL_ERROR')
    }
    let result = {
      x,
      y,
      width,
      height,
      ...typeof box['viewportWidth'] === 'number' ? { viewportWidth: box['viewportWidth'] as number } : {},
      ...typeof box['viewportHeight'] === 'number' ? { viewportHeight: box['viewportHeight'] as number } : {},
    }
    // 零视口守卫（2026-10-07 独立验收）：窗口最小化 / 隐藏时 innerWidth/innerHeight = 0，
    // 量到的坐标全是负数、后续的命中测试与鼠标派发都落不到真实内容上 —— 必须在这里
    // 明确拒绝，不许把「量到了一串负数」当成可用的落点继续走。
    this.assertUsableViewport(result.viewportWidth, result.viewportHeight)
    if (scroll) {
      // 2026-10-07 实测（Google locate y=5171 仍报「已居中」）：`scrollIntoView` 后**立即**
      // 量到的是滚动前的旧布局 —— CSS `scroll-behavior: smooth` 的动画在渲染进程里推进，
      // 同一次 evaluate 里的 getBoundingClientRect 不会等它。于是做**有界重测**，每次间隔
      // 150ms，最多 4 次（总预算 ≤600ms），动画推进或提前到位都会提前结束。重测只读 rect，
      // 不再触发 scrollIntoView。
      // 停止条件（2026-10-07 独立验收修复）：`waitGoal='centred'` 时等到「真居中」为止 ——
      // 旧条件「与视口无交集才重测」会在 smooth 动画刚把元素送进视口边缘时就停表，把
      // 「看得见」谎报成「已居中」。`waitGoal='visible'` 维持「有交集即停」，click / scroll
      // 只需要打得中，等居中是白付预算。
      for (let attempt = 0; attempt < 4; attempt++) {
        const settled = waitGoal === 'centred'
          ? boxCenteredInViewport(result) !== false
          : boxIntersectsViewport(result)
        if (settled) break
        await sleepForRetry(150, signal)
        result = await this.measureViewportBox(session, objectId, signal)
      }
    }
    return result
  }

  /** 只读一次 rect，不滚动（smooth 滚动重测用）。 */
  private async measureViewportBox(
    session: SessionState,
    objectId: string,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number }> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: `function () {${LOCATE_MEASURE_SNIPPET}`, returnByValue: true },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    )
    const value = evaluated.result?.value
    if (typeof value !== 'object' || value === null) {
      throw new BrowserError('could not read the element box for interaction', 'BROWSER_PROTOCOL_ERROR')
    }
    const box = value as Record<string, unknown>
    const x = box['x']
    const y = box['y']
    const width = box['width']
    const height = box['height']
    if (
      typeof x !== 'number' || typeof y !== 'number'
      || typeof width !== 'number' || typeof height !== 'number'
      || !(width > 0) || !(height > 0)
    ) {
      throw new BrowserError('the element has no usable layout box to interact with', 'BROWSER_PROTOCOL_ERROR')
    }
    const remeasured = {
      x,
      y,
      width,
      height,
      ...typeof box['viewportWidth'] === 'number' ? { viewportWidth: box['viewportWidth'] as number } : {},
      ...typeof box['viewportHeight'] === 'number' ? { viewportHeight: box['viewportHeight'] as number } : {},
    }
    // 重测路径同样过零视口守卫：窗口可能在首测与重测之间被最小化，不守卫会把
    // 零视口下的负坐标盒当作「重测结果」返回给 click / locate。
    this.assertUsableViewport(remeasured.viewportWidth, remeasured.viewportHeight)
    return remeasured
  }

  /**
   * 读一次视口尺寸（CSS 像素）。`webpage_scroll` 不带 ref 时用它算落点（视口中心）。
   * 读不到时退到 400×300 —— 滚轮事件落在视口内的任意一点都行，只有「落在视口外」才无效。
   * 但**读到零**不是「读不到」：那是窗口最小化 / 不可见的测得事实，回落 400×300 会把滚轮
   * 派发到虚构的视口中心制造假成功 —— 明确拒绝（2026-10-07 独立验收）。
   */
  private async viewportSize(session: SessionState, signal?: AbortSignal): Promise<{ width: number; height: number }> {
    const evaluated = await session.connection.send<EvaluateResult>(
      'Runtime.evaluate',
      { expression: '({ width: window.innerWidth, height: window.innerHeight })', returnByValue: true },
      { signal, timeoutMs: this.config.commandTimeoutMs },
    ).catch(() => undefined)
    const value = evaluated?.result?.value
    if (typeof value === 'object' && value !== null) {
      const size = value as Record<string, unknown>
      const width = size['width']
      const height = size['height']
      if (typeof width === 'number' && typeof height === 'number') {
        this.assertUsableViewport(width, height)
        if (width > 0 && height > 0) return { width, height }
      }
    }
    return { width: 400, height: 300 }
  }

  /**
   * 零视口守卫（2026-10-07 独立验收：最小化窗口假成功）。
   *
   * 窗口最小化 / 隐藏时 `innerWidth`/`innerHeight` 报 0：布局坐标失去意义（实测全是负数）、
   * 命中测试与鼠标派发都落不到真实内容上 —— click 曾回「成功」但页面计数不增，locate 拿
   * 负坐标声称 in viewport。宿主在最小化期间刻意不跑 layout（host.cjs 退化读数守卫），
   * 插件侧没有安全的恢复路径（切标签正是当年白屏事故的触发条件），所以只**明确拒绝** +
   * 指路，绝不代恢复。视口尺寸缺读（`undefined`）不在此判 —— 那是「不知道」，不是「知道坏了」。
   */
  private assertUsableViewport(viewportWidth: number | undefined, viewportHeight: number | undefined): void {
    if (viewportWidth === undefined || viewportHeight === undefined) return
    if (viewportWidth > 0 && viewportHeight > 0) return
    throw new BrowserError(
      `the browser window currently reports a zero-size viewport (innerWidth=${String(viewportWidth)}, `
      + `innerHeight=${String(viewportHeight)}) — the window is most likely minimized or hidden. `
      + 'Layout coordinates, hit-testing and input dispatch are all meaningless in this state, and '
      + 'NOTHING was sent to the page.',
      'BROWSER_WINDOW_NOT_VISIBLE',
    )
  }

  /**
   * 在元素上画一层高亮（方案 4.3，`webpage_locate` 的 `highlight: true`）。
   *
   * 两道门缺一不可（`[V15][V20]`）：本 session 必须先 `DOM.enable` 才能成功
   * `Overlay.enable`，必须先 `Overlay.enable` 才能调 `Overlay.highlightNode`。
   * **每次都补发这两条 enable**：re-attach 后 domain enable 状态不保证还在
   * （与 console / network 采集读取前补发 enable 同一条理由）。
   *
   * 只用 `highlightNode` + `highlightConfig`（contentColor 填色 + borderColor 边框），
   * **绝不用 `Overlay.highlightRect`** —— `[V32]` 实测后者会把传入 rect 之外的整个视口
   * 染色。高亮是本 client 自己的一层，与人工 DevTools / 其它 client 的高亮互不取消
   * （`[V31]`），无需协商；它会保持到 `Overlay.hideHighlight` 或页面导航。
   */
  private async paintHighlight(session: SessionState, objectId: string, signal?: AbortSignal): Promise<void> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    await session.connection.send('DOM.enable', {}, options)
    await session.connection.send('Overlay.enable', {}, options)
    await session.connection.send('Overlay.highlightNode', {
      objectId,
      highlightConfig: {
        contentColor: { r: 250, g: 200, b: 60, a: 0.5 },
        borderColor: { r: 220, g: 120, b: 0, a: 1 },
      },
    }, options)
    session.highlightPainted = true
  }

  /**
   * 弹掉本 client 画的那层高亮（`webpage_locate` 的 `highlight: false` 且此前画过时调用）。
   * `hideHighlight` 只弹自己那层（`[V31]`）；enable 门与 paint 相同，防止 re-attach 后
   * Overlay 未 enable 时 hide 直接失败。
   */
  private async clearHighlight(session: SessionState, signal?: AbortSignal): Promise<void> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    await session.connection.send('DOM.enable', {}, options)
    await session.connection.send('Overlay.enable', {}, options)
    await session.connection.send('Overlay.hideHighlight', {}, options)
    session.highlightPainted = false
  }

  /**
   * 落点命中校验：这个点上最顶层的元素是不是目标（或其子孙）。
   *
   * 判据用 `document.elementFromPoint` —— 它就是浏览器自己派发鼠标事件时用的那套命中测试，
   * 比「比较 rect 有没有重叠」更贴近真实（重叠不等于遮挡：祖先、负 z-index、`pointer-events:none`
   * 都会让重叠但**打得中**）。
   *
   * **失败不影响动作**：这是回执增强，不是动作本身 —— 页面在极端情况下（跨源 iframe 里的
   * 元素、evaluate 被 CSP 拦）查不出来时，宁可少报一条遮挡，也不许把 click 打成失败。
   */
  async hitTest(
    session: SessionState,
    objectId: string,
    point: { x: number; y: number },
    signal?: AbortSignal,
  ): Promise<HitTestOutcome | undefined> {
    try {
      const outcome = await session.connection.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: HIT_TEST_FUNCTION,
          arguments: [{ value: { x: point.x, y: point.y } }],
          returnByValue: true,
        },
        { signal, timeoutMs: this.config.commandTimeoutMs },
      )
      const value = outcome.result?.value as HitTestOutcome | undefined
      return value?.hit === undefined ? undefined : value
    } catch {
      return undefined
    }
  }

  /** 视口中心（CSS 像素）：不带 ref 的 scroll 的落点。 */
  async viewportCenter(session: SessionState, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const size = await this.viewportSize(session, signal)
    return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) }
  }

  /** 取一个元素的裁剪区域；元素已经从文档里消失时报 `BROWSER_STALE_REF`。 */
  async elementClip(
    session: SessionState,
    ref: string,
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<ScreenshotClip> {
    const options = { signal, timeoutMs: this.config.commandTimeoutMs }
    // 与 mutate 同一口径：`DOM.resolveNode` 对已消失的节点是**抛错**，
    // 这里以前只兜「返回体缺 objectId」，同样会漏成裸协议错误。
    const objectId = await this.resolveBackendNodeId(session, ref, backendNodeId, signal)
    if (objectId === undefined) {
      this.metrics.noteStale(session.targetId, 'node_gone')
      throw new BrowserError(
        'the observed element is no longer attached to the document; run webpage_snapshot again',
        'BROWSER_STALE_REF',
        { reason: 'node_gone' },
      )
    }
    try {
      const box = await session.connection.send<BoxModelResult>('DOM.getBoxModel', { objectId }, options)
      const quad = box.model?.border ?? box.model?.content
      if (quad === undefined || quad.length < 8) {
        throw new BrowserError('the element has no layout box to capture', 'BROWSER_PROTOCOL_ERROR')
      }
      const xs = [quad[0], quad[2], quad[4], quad[6]] as number[]
      const ys = [quad[1], quad[3], quad[5], quad[7]] as number[]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const width = Math.max(...xs) - x
      const height = Math.max(...ys) - y
      if (!(width > 0) || !(height > 0)) {
        throw new BrowserError('the element has a zero-sized layout box', 'BROWSER_PROTOCOL_ERROR')
      }
      return { x, y, width, height, scale: 1 }
    } finally {
      // 释放远端对象句柄，别让 V8 侧攒下一堆没人用的对象。
      await session.connection.send('DOM.releaseObject', { objectId }, { signal }).catch(() => undefined)
    }
  }

}
