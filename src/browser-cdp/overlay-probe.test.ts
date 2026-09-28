/**
 * 浮层取名 —— P0-a 的判据所在的那一层。
 *
 * ## 为什么单独一个文件
 *
 * `provider.test.ts` 的假 Chrome 把 `Runtime.evaluate` 的结果直接写成 `this.overlay`
 * （见那里 `expression.includes('elementFromPoint')` 那一分支）——**页面脚本从未被执行**。
 * 那里验的是「回执怎么拼」，验不了「脚本读出什么」。而 P0-a 的缺陷**只存在于脚本里**
 *（`name` 在「不是 dialog」时一律空串），所以在那里补多少用例都不会红。
 * ⇒ 这里在 Node 侧用 `new Function` 把两条脚本**真跑一遍**。
 *
 * ## 为什么手写 DOM
 *
 * 没有 jsdom（也不需要）：这两条脚本只用到 `elementFromPoint` / `getComputedStyle` /
 * `getAttribute` / `textContent` / `parentElement` / `closest` / `getBoundingClientRect`
 * 这几个成员，全给出假实现即可。
 *
 * ## 形状照真站画，不照想象画
 *
 * 尺寸与层叠关系取自 `docs/上下文膨胀-实施方案.md` §5.2 在知乎问答页
 * （`question/267059317`，未登录，视口 1582×804）的实测读数：
 *
 * | 层 | position | z-index | 面积 | 文本 |
 * |---|---|---|---|---|
 * | `DIV.Modal-wrapper` | fixed | 203 | 99.1% | 有（登录框全文） |
 * | `DIV.Modal-backdrop` | absolute | 0 | 99.1% | **无** |
 * | `DIV.Modal-inner` | static | auto | 32.1% | 有 |
 * | `FORM.SignFlow.Login-content` | static | auto | 10.0% | **视口中心命中的就是它** |
 *
 * ⚠️ 初版 P0 被推翻两次，两次的病根都是「靶子不是真的」。改这里之前先回 §5.2 看那张表。
 */

import { describe, expect, it } from 'vitest'

import { HIT_TEST_FUNCTION, OVERLAY_PROBE_EXPRESSION } from './provider.ts'

/** 一条盒子的几何。脚本用它算「可见面积」。 */
interface Rect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

interface ElInit {
  readonly tag?: 'DIV' | 'FORM' | 'DIALOG'
  readonly id?: string
  readonly className?: string
  readonly attrs?: Record<string, string>
  readonly text?: string
  readonly position?: string
  readonly zIndex?: string
  readonly rect?: Rect
}

const VIEW = { width: 1582, height: 804 }

/** 纸片 DOM：只实现这几条脚本真正碰到的成员。 */
class FakeEl {
  readonly nodeType = 1
  readonly tagName: string
  readonly id: string
  readonly className: string
  readonly style: { position: string; zIndex: string }
  readonly children: FakeEl[] = []
  parentElement: FakeEl | null = null

  private readonly attrs: Record<string, string>
  private readonly ownText: string
  private readonly rect: Rect

  constructor(init: ElInit = {}) {
    this.tagName = init.tag ?? 'DIV'
    this.id = init.id ?? ''
    this.className = init.className ?? ''
    this.attrs = init.attrs ?? {}
    this.ownText = init.text ?? ''
    this.style = { position: init.position ?? 'static', zIndex: init.zIndex ?? 'auto' }
    this.rect = init.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }
  }

  /** 挂子节点，返回自己方便链式搭树。 */
  add(...kids: FakeEl[]): this {
    for (const kid of kids) kid.parentElement = this, this.children.push(kid)
    return this
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null
  }

  get textContent(): string {
    return this.ownText + this.children.map(child => child.textContent).join('')
  }

  getBoundingClientRect(): Rect {
    return this.rect
  }

  contains(other: unknown): boolean {
    return other === this || this.children.some(child => child.contains(other))
  }

  /** 只支持脚本里那一个选择器表：`[role="dialog"], [aria-modal="true"], dialog`。 */
  closest(selector: string): FakeEl | null {
    const parts = selector.split(',').map(part => part.trim()).filter(part => part.length > 0)
    for (let node: FakeEl | null = this; node !== null; node = node.parentElement) {
      if (parts.some(part => FakeEl.matches(node as FakeEl, part))) return node
    }
    return null
  }

  private static matches(node: FakeEl, selector: string): boolean {
    const attr = /^\[([a-zA-Z-]+)="([^"]+)"\]$/.exec(selector)
    if (attr !== null) return node.getAttribute(attr[1] ?? '') === attr[2]
    return node.tagName.toLowerCase() === selector.toLowerCase()
  }
}

interface FakePage {
  readonly body: FakeEl
  /** `elementFromPoint` 的返回值；`null` = 落点上什么都没有。 */
  readonly topAtCenter: FakeEl | null
}

/** 把页面脚本放进受控的 `window` / `document` / `getComputedStyle` 里求值。 */
function runOverlayScript(page: FakePage): { role: string; name: string; hint: string } | null {
  const body = page.body
  const document = {
    body,
    elementFromPoint: () => page.topAtCenter,
  }
  const window = { innerWidth: VIEW.width, innerHeight: VIEW.height }
  const script = new Function(
    'window',
    'document',
    'getComputedStyle',
    `return ${OVERLAY_PROBE_EXPRESSION};`,
  )
  return script(window, document, (el: FakeEl) => el.style) as { role: string; name: string; hint: string } | null
}

interface HitOutcome {
  href?: string | null
  hit?: 'target' | 'other' | 'none'
  node?: { role: string; name: string; hint: string } | null
}

/** `@param element` 就是脚本里的 `this`（要点的那个元素）。 */
function runHitTestScript(element: FakeEl, page: FakePage, point = { x: 400, y: 300 }): HitOutcome {
  const body = page.body
  const document = {
    body,
    elementFromPoint: () => page.topAtCenter,
  }
  const script = new Function('document', `return ${HIT_TEST_FUNCTION};`)
  return script(document).call(element, point) as HitOutcome
}

/** 全屏盒子（99.1% 视口 ≥ 60% 阈值）。 */
const FULL_RECT: Rect = { left: 7, top: 3, right: VIEW.width - 7, bottom: VIEW.height - 4 }

/**
 * 知乎登录浮层（照 §5.2 的实测读数）。
 *
 * 关键点是两层难点同时存在：① 它**不是** `[role=dialog]`（`closest` 命中数实测为 0）；
 * ② 视口中心命中的元素（form）与最终判定的浮层（wrapper）**不是同一个**。
 */
function zhihuLikeOverlay(overrides: ElInit = {}): FakeEl {
  const wrapper = new FakeEl({
    tag: 'DIV',
    className: 'Modal-wrapper Modal-enter-done',
    position: 'fixed',
    zIndex: '203',
    rect: FULL_RECT,
    ...overrides,
  })
  const backdrop = new FakeEl({
    tag: 'DIV',
    className: 'Modal-backdrop',
    position: 'absolute',
    zIndex: '0',
    rect: FULL_RECT,
  })
  const form = new FakeEl({
    tag: 'FORM',
    className: 'SignFlow Login-content',
    text: '密码登录 短信登录 登录',
    rect: { left: 691, top: 300, right: 891, bottom: 420 },
  })
  const inner = new FakeEl({
    tag: 'DIV',
    className: 'Modal-inner',
    rect: { left: 591, top: 250, right: 991, bottom: 520 },
  }).add(form)
  return wrapper.add(backdrop, inner)
}

/** 页面壳：body 下挂一个浮层浮层 + 一段正文。 */
function pageWith(overlay: FakeEl, hitTarget: FakeEl | null = null): FakePage {
  const body = new FakeEl({ tag: 'DIV' }).add(overlay)
  return { body, topAtCenter: hitTarget }
}

describe('浮层取名（P0-a）', () => {
  it('知乎那种「不是 dialog、也没 aria-label」的浮层，名字要从文本读出来', () => {
    const overlay = zhihuLikeOverlay()
    // 视口中心命中的是那个 form（这是真站读数，不是想象出来的）。
    const probe = runOverlayScript(pageWith(overlay, overlay.children[1]?.children[0] ?? null))

    expect(probe).not.toBeNull()
    expect(probe?.role).toBe('div')
    expect(probe?.hint).toBe('.Modal-wrapper')
    // 修之前这里会是空串 —— 模型只能看到 `div .Modal-wrapper`，看不出「这是个登录框」。
    expect(probe?.name).toContain('登录')
  })

  it('盖住落点的遮罩自己没文本时，`occluded_by` 也要有名字', () => {
    const overlay = zhihuLikeOverlay()
    const backdrop = overlay.children[0] as FakeEl
    // 模型点的是浮层**下面**的正文链接，命中测试落到无文本的遮罩上。
    const target = new FakeEl({ tag: 'DIV', className: 'ContentItem-title' })

    const outcome = runHitTestScript(target, pageWith(overlay, backdrop))

    expect(outcome.hit).toBe('other')
    expect(outcome.node?.hint).toBe('.Modal-backdrop')
    expect(outcome.node?.name).toContain('登录')
  })

  it('有 aria-label 时仍以它为准（不被整段文本盖过）', () => {
    const overlay = zhihuLikeOverlay({ attrs: { 'aria-label': '请登录后查看' } })
    const probe = runOverlayScript(pageWith(overlay, overlay.children[1]?.children[0] ?? null))

    expect(probe?.name).toBe('请登录后查看')
  })

  it('命中 `[role=dialog]` 时，名字取 dialog 那一层', () => {
    const dialogInner = new FakeEl({
      tag: 'DIV',
      className: 'Modal-wrapper',
      position: 'fixed',
      rect: FULL_RECT,
      attrs: { role: 'dialog' },
      text: '登录后查看全部回答',
    })
    const probe = runOverlayScript(pageWith(dialogInner, dialogInner))

    expect(probe?.role).toBe('dialog')
    expect(probe?.name).toBe('登录后查看全部回答')
  })

  it('确实没有可读文本时空串（不捏造、不把整页正文当前缀）', () => {
    const mute = new FakeEl({
      tag: 'DIV',
      className: 'Overlay-silent',
      position: 'fixed',
      rect: FULL_RECT,
    })
    const probe = runOverlayScript(pageWith(mute, mute))

    expect(probe?.name).toBe('')
  })

  it('名字截断在 60 字以内（回执体积纪律）', () => {
    const chatty = new FakeEl({
      tag: 'DIV',
      className: 'Overlay-chatty',
      position: 'fixed',
      rect: FULL_RECT,
      text: '登录'.repeat(200),
    })
    const probe = runOverlayScript(pageWith(chatty, chatty))

    expect(probe?.name.length).toBeGreaterThan(0)
    expect(probe?.name.length).toBeLessThanOrEqual(60)
  })

  it('没有浮层时不误报（反向验证 · 不误伤正常页面）', () => {
    const article = new FakeEl({
      tag: 'DIV',
      className: 'Article',
      text: '正文',
      rect: { left: 0, top: 0, right: VIEW.width, bottom: VIEW.height },
    })
    const body = new FakeEl({ tag: 'DIV' }).add(article)

    // 无定位祖先 → while 会爬到 body 然后 `return null`。
    expect(runOverlayScript({ body, topAtCenter: article })).toBeNull()
  })
})
