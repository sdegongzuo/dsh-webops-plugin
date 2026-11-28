/**
 * 诊断报告的小号复制按钮：一次点击 → 写剪贴板 → 就地显示「已复制/复制失败」。
 *
 * 为什么是独立组件：面板上有两个入口（每条记录的「复制诊断信息」、汇总结论区的
 * 「复制失败详情」），而「点完给反馈、1.5 秒后复原」这套状态机只该写一次。
 *
 * 按钮**必须**吞掉点击事件：它现在挂在 `<details>` 的展开体里，但布局随时可能把它挪到
 * `<summary>` 或复选框的 `<label>` 里，那样一次复制会顺手把面板折叠起来或翻转筛选。
 * 阻止冒泡的代价为零，不做的代价是难查的交互 bug。
 *
 * 为什么这段只能靠打包态验证：仓库 `vitest.config.ts` 用 `environment: 'node'`，
 * `include` 只收 `src` 下的 `.test.ts`，没有 React 渲染环境，也不允许为此新增依赖，
 * 所以本文件不进单元测试。而要挡的三件事也都只在真实渲染进程里成立：
 * 1. Electron 44 里文档失焦时 `navigator.clipboard.writeText` 抛
 *    `NotAllowedError: Document is not focused`，兜底的 textarea + `execCommand('copy')`
 *    却返回 true，而 `document.hasFocus()` 是 false —— 复制其实没写进去，按钮却显示成功
 *    （判定见 `isDocumentFocusLost`）。
 * 2. 连续点击的定时器竞态只在真实点击节奏下出现。
 * 3. `role="status"` 是否真能播报，只有屏幕阅读器能回答。
 * 改动后请在桌面客户端（`DeepSeek Harness.exe`）里手动验：文档失焦时点按钮必须显示失败态。
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { copyText } from './diagnostics.ts'

/** 复制结果反馈：`idle` 显示原标签，`copied`/`failed` 显示对应结果。 */
type CopyState = 'idle' | 'copied' | 'failed'

/** 成功反馈停留时长：足够看清，又不至于一直占着按钮。 */
const COPIED_MS = 1600
/** 失败反馈更久一点——用户需要读清这句并决定手动选中文本。 */
const FAILED_MS = 3000

/**
 * 视觉隐藏但保留给屏幕阅读器的样式：不占布局、不触发页面滚动，也不为此新增 CSS 文件。
 * `position: 'absolute'` 让它在 flex 行里不成为影响布局的项（绝对定位子元素不参与 flex 布局）。
 */
const LIVE_REGION_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}

/**
 * 点击结算时文档是否明确失焦。
 *
 * `execCommand('copy')` 返回 true 只说明「复制命令被接受」，不说明内容进了剪贴板：
 * 渲染进程失焦时它照样返回 true，实际什么也没写。所以只在一种情况下把成功降级为失败 ——
 * 「有 document 且明确 `hasFocus()` 为 false」。没有 document 的环境（Node、SSR 预渲染）
 * 根本判断不了，保持 `copyText` 自己的结论，不凭空报失败。
 * @returns 文档存在且明确失焦时为 true。
 */
function isDocumentFocusLost(): boolean {
  if (typeof globalThis.document === 'undefined') return false
  return globalThis.document.hasFocus() === false
}

export interface CopyButtonProps {
  /** 空闲态标签。 */
  readonly label: string
  /** 复制成功后的标签。 */
  readonly copiedLabel: string
  /** 复制失败后的标签。 */
  readonly failedLabel: string
  /** 点击时才生成文本：报告要跟着面板最新状态走，不在渲染期拼字符串。 */
  readonly text: () => string
  /** 悬停提示，可选。 */
  readonly title?: string | undefined
  /** 位置类样式（如 `marginLeft: 'auto'`），不覆盖按钮自身的观感。 */
  readonly style?: CSSProperties | undefined
}

/**
 * 复制按钮。
 * @param props - 文案、文本生成器与可选位置样式。
 */
export function CopyButton(props: CopyButtonProps): ReactNode {
  const { label, copiedLabel, failedLabel, text, title, style } = props
  const [state, setState] = useState<CopyState>('idle')
  /** 有复制请求在飞：只用于 `aria-busy`，不改按钮的可点性与焦点。 */
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** 点击单调序号：只有最新一次点击的回调有资格改状态。 */
  const seq = useRef(0)
  /** 是否仍挂载：卸载后回调一律丢弃，不在已卸载组件上 setState。 */
  const mounted = useRef(true)

  useEffect(() => {
    // 面板会被反复展开/收起；StrictMode 开发态还会「挂载 → 清理 → 再挂载」，
    // 所以每次生效都把标记复位，清理时置 false 并清掉待执行的复原定时器。
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== undefined) {
        clearTimeout(timer.current)
        timer.current = undefined
      }
    }
  }, [])

  /**
   * 结算第 `id` 次点击。
   * 序号已不是当前值（被更新的点击顶掉）或组件已卸载时整段丢弃 —— 否则上一次点击的
   * 复原定时器会在这一次刚显示结果时把它提前抹掉。
   * @param id - 这次点击的序号。
   * @param ok - 这次复制是否算成功。
   */
  const settle = (id: number, ok: boolean): void => {
    if (!mounted.current || id !== seq.current) return
    setBusy(false)
    setState(ok ? 'copied' : 'failed')
    const delay = ok ? COPIED_MS : FAILED_MS
    timer.current = setTimeout(() => {
      timer.current = undefined
      if (!mounted.current || id !== seq.current) return
      setState('idle')
    }, delay)
  }

  const onClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    // 每次点击开新的一轮：顶掉旧序号、清掉旧定时器，让「最新一次点击」独占显示权。
    const id = ++seq.current
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    // 新一轮先复位到 idle：上一轮的「已复制」不能冒充这一轮的结果，进行中用 aria-busy 表示。
    setState('idle')
    setBusy(true)

    // `text()` 在同一表达式里同步拼完整份报告（`buildCallDiagnostic` /
    // `buildFailuresDiagnostic`），任何一次模型参数异常都会同步抛出；没接住就变成
    // 未处理的 rejection，按钮停在 idle 且没有任何反馈，用户以为没点到。
    let report: string
    try {
      report = text()
    } catch {
      settle(id, false)
      return
    }

    // `copyText` 现在是 async，同步抛错会转成 rejection；`.catch` 兜住将来改回同步实现
    // 或 `then` 回调自身抛错的情况，让两条失败路径都落到 failed 态。
    // 成功时再过一道 `isDocumentFocusLost`：失焦下 `execCommand` 的 true 不可信。
    void copyText(report)
      .then((ok) => settle(id, ok && !isDocumentFocusLost()))
      .catch(() => settle(id, false))
  }

  // 「正在复制」用 `aria-busy` 表达，而不是 `disabled`：
  // 1. 给已获焦的按钮设 disabled 会让 Chromium 把焦点丢给 `<body>`，那正是问题 3 里
  //    `execCommand('copy')` 返回 true 却没有写进剪贴板的成因之一；
  // 2. disabled 会把按钮移出 tab 序，键盘用户想重试还得重新找回来；
  // 3. 失败后立刻再点一次是合法操作，显示取舍已由上面的序号保证，不需要靠禁用来排队。
  const feedback = state === 'idle' ? '' : state === 'copied' ? copiedLabel : failedLabel
  const tone = state === 'copied'
    ? 'var(--dsw-alias-status-success, #2f8f4e)'
    : state === 'failed' ? 'var(--dsw-alias-status-error, #d04444)' : 'inherit'

  return (
    <>
      <button
        type="button"
        data-dsh-browser-copy={state}
        aria-busy={busy}
        title={title ?? label}
        onClick={onClick}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
          border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
          borderRadius: 6, padding: '0 6px', background: 'transparent',
          font: 'inherit', fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap',
          cursor: 'pointer', color: tone,
          ...style,
        }}
      >
        {state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : label}
      </button>
      {/* 状态变化只体现在按钮文字和 data 属性上，屏幕阅读器不会播报。这个 live region
          常驻渲染（挂载时内容为空），只在非 idle 时输出一次结果文案，回到 idle 时清空，
          避免重复播报；文案复用已传入的 copiedLabel / failedLabel，不新增 props。 */}
      <span role="status" aria-live="polite" style={LIVE_REGION_STYLE}>{feedback}</span>
    </>
  )
}
