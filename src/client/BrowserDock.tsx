/**
 * 浏览器观察面板：挂在 `conversation.input.dock` 上，**常驻显示**。
 *
 * ## 观感对齐「任务」行
 *
 * 面板与对话里的 `todo_write` 行（「任务 N 已完成」）同处一屏，两者此前是两种视觉：
 * 本面板是 12px、加粗标题、外层一张带边框的大卡片；任务行是 13px 次级色、单行 24px、
 * 右侧 chevron，展开体另起一个内嵌面板。并排看就是「两个东西」。现在头部复刻官方
 * `DisclosureRow` 的度量（[16px 图标] gap6 [标题 13/24] … 右侧 chevron，色阶
 * tertiary → hover secondary），展开体复刻 `ToolDetails` 的内嵌面板（0.5px 边框 +
 * `--dsw-radius-lg` + code-block 底色），于是两处读起来是同一套行。
 *
 * 用的是**同样的 CSS 变量**而不是 import 官方组件：`@deepseek-ai/dsh-client-ui-primitives`
 * 虽然在浏览器模块表里，但本仓没有把它列为依赖 —— 为一个行高去改 peerDependencies
 * 会牵动打包门禁（peer 版本必须与运行时同源），不值得。变量是稳定的公开面。
 *
 * 数据全部派生自对话快照（`ui-chat` 的 `ChatSnapshot`），**不新增任何 RPC**：
 * 浏览器调用本来就以工具调用节点的形式流经客户端，客户端收得到，面板跟着它走即可。
 *
 * `useChat` 由 ui-chat 通过 `SessionStandardProps` 合并进来。为了让「ui-chat 没被组合」
 * 时面板退化成不显示而不是崩掉，这里把 hook 的调用点固定在一个函数上（`readChat`），
 * 缺失时换成不读任何状态的常量实现——hook 调用次数因此恒定。
 */
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 类型上把 ui-chat / ui-conversation 的 SlotMap 与 SessionStandardProps 合并拉进来。
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BROWSER_NS } from './locales.ts'
import { browserCallsFrom, observeBrowser, visitedPages, type BrowserCall } from './observation.ts'
import {
  buildCallDiagnostic,
  buildFailuresDiagnostic,
  clientEnvironment,
  PLUGIN_VERSION,
  type DiagnosticInput,
  type DiagnosticLabels,
} from './diagnostics.ts'
import { CopyButton } from './CopyButton.tsx'

/** 面板的完整 props：input.dock 的 owner + Session 标准件（含 `useChat`）+ 文案。 */
export type BrowserDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof BROWSER_NS>

/** 选择器形状，与 `ui-chat` 的 `UseChat` 结构一致。 */
type ChatSelector = (selector: (state: unknown) => unknown) => unknown

/** 恒等选择器：模块级常量，保证跨渲染稳定。 */
const identity = (state: unknown): unknown => state

/** ui-chat 缺席时的兜底：不订阅任何东西，面板自然显示为空。 */
const constantChat: ChatSelector = () => undefined

/** 官方行的字号阶梯：次级一档（比正文小，与 think 文本同档）。 */
const ROW_FONT: CSSProperties = {
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
}

/** 行内图标尺寸：与 `DisclosureRow` 的 leading 一致，随字号偏好一起缩放。 */
const LEADING_SIZE = 'calc(16px + var(--dsh-content-font-delta, 0px))'

/** 展开体的容器样式，逐项对齐 `ToolDetails.module.css` 的 `.root`。 */
const PANEL: CSSProperties = {
  margin: '4px 0 4px 4px',
  border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
  borderRadius: 'var(--dsw-radius-lg, 8px)',
  background: 'var(--dsw-alias-markdown-code-block, transparent)',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  overflow: 'hidden',
}

/**
 * 订阅对话快照并抽出全部 `webpage_*` 调用。
 * @param useChat - slot 标准件里的 chat 选择器 hook。
 */
function useBrowserCalls(useChat: unknown): readonly BrowserCall[] {
  const readChat = (typeof useChat === 'function' ? useChat : constantChat) as ChatSelector
  const snapshot = readChat(identity)
  return useMemo(() => browserCallsFrom(snapshot), [snapshot])
}

/** 摘要只保留错误码和首句；完整错误始终留在单条记录的原始回执里。 */
function failureSummary(text: string): string {
  const firstLine = (text.split('\n')[0] ?? '').replace(/^Error:\s*/, '').trim()
  const sentence = firstLine.split(/(?<=[。！？])|[.!?]\s/)[0] ?? firstLine
  return sentence.length > 100 ? `${sentence.slice(0, 100)}…` : sentence
}

/**
 * 行首图标：一个窗口/地球轮廓，14px 描边。
 *
 * 自绘而不是引官方图标集，理由同文件头：不为一枚图标增加依赖。
 * @returns 与行内文字同色的内联 SVG。
 */
function BrowserGlyph(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"
      style={{ flexShrink: 0, display: 'block' }}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.75 8h12.5M8 1.75c1.9 1.9 1.9 10.6 0 12.5M8 1.75c-1.9 1.9-1.9 10.6 0 12.5"
        stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 行尾 chevron：展开时朝上、收起时朝下，与对话里的折叠行同向。
 * @param props - 是否展开。
 * @returns 内联 SVG。
 */
function Chevron({ open }: { readonly open: boolean }): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"
      style={{
        flexShrink: 0, display: 'block',
        transform: open ? 'rotate(180deg)' : 'none',
        transition: 'transform 120ms ease',
      }}>
      <path d="M4 6.5 8 10.5l4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * 常驻的浏览器状态条。
 * @param props - slot 运行时下发的 owner、Session 标准件与本地化。
 */
export function BrowserDock(props: BrowserDockProps) {
  const { useChat, t } = props
  const calls = useBrowserCalls(useChat)
  const observation = observeBrowser(calls)
  const state = observation.running ? 'running' : observation.failures > 0 ? 'error' : 'idle'
  const idle = observation.calls === 0
  const [failuresOnly, setFailuresOnly] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const recordsId = useId()
  // 访问列表同样只从快照派生：一次遍历得到「本次会话到过的页面」，不新增 state 或请求。
  const visits = useMemo(() => visitedPages(calls), [calls])
  // 标题里的「N 个页面」只数确认到达的：失败行只是目标地址，算进 N 就等于虚报访问。
  const reachedPages = visits.filter(visit => visit.ok).length
  const runningCall = calls.findLast(call => !call.settled)
  // 一行摘要：与任务行的「N 已完成」同构 —— 只有一段文字，调用次数就在里面。
  // 旧版把「操作记录 N」另挂到右端，等于给同一行配了两个标题，视觉上和任务行不是一类。
  const summary = observation.running
    ? `${t('active')}${runningCall ? ` · ${runningCall.toolName}` : ''}`
    : observation.failures > 0
      ? `${String(observation.failures)} ${t('failedCalls')}`
      : idle ? t('idle') : `${String(calls.length)} ${t('completedCalls')}`
  const visibleCalls = [...calls].reverse().filter(call => !failuresOnly || (call.settled && call.isError))

  // 诊断报告的材料：面板当前页 + 渲染进程 UA + 一套本地化标签。报告在点击时才拼，
  // 这里只准备输入 —— 面板每帧都在渲染，没必要每次渲染都把全部失败调用的回执拼一遍。
  const diagnosticPage = { url: observation.url, title: observation.title, sessionId: observation.sessionId }
  const environment = clientEnvironment()
  // 标题也走同一套插值：汇总按钮填失败条数，单条按钮填 1；报告层不再二次替换 {count}。
  const diagnosticLabels: Omit<DiagnosticLabels, 'heading'> = {
    page: t('diagnosticPage'),
    // 参数里的目标地址（未确认到达）与「连地址都没有」是两条不同的标签，不能混用 page。
    target: t('diagnosticTarget'),
    pageUnknown: t('diagnosticPageUnknown'),
    currentPage: t('diagnosticCurrentPage'),
    pageTitle: t('diagnosticTitle'),
    tab: t('diagnosticTab'),
    environment: t('diagnosticEnvironment'),
    plugin: t('diagnosticPlugin'),
    stats: t('diagnosticStats'),
    failedTools: t('diagnosticFailedTools'),
    sequence: t('diagnosticSequence'),
    errorCode: t('diagnosticErrorCode'),
    argsCheck: t('diagnosticArgsCheck'),
    argsJson: t('diagnosticArgsJson'),
    argsNotJson: t('diagnosticArgsNotJson'),
    // 空参数不等于「参数不合法」，报告里要分开说。
    argsMissing: t('diagnosticArgsMissing'),
    retry: t('diagnosticRetry'),
    arguments: t('arguments'),
    receipt: t('receipt'),
    noReceipt: t('emptyReceipt'),
    failure: t('diagnosticFailed'),
    succeeded: t('diagnosticSucceeded'),
    active: t('diagnosticActive'),
  }
  /** 会话全量调用始终传给报告：序号与「上一次失败」都要靠它算。 */
  const diagnosticFor = (heading: string): DiagnosticInput => ({
    labels: { ...diagnosticLabels, heading },
    current: diagnosticPage,
    environment,
    pluginVersion: PLUGIN_VERSION,
    sessionCalls: calls,
  })

  return (
    <div
      data-dsh-browser-dock=""
      data-dsh-browser-state={state}
      style={{
        // column-reverse 是**位置决定的**，不是风格：dock 紧贴输入框上方，展开时内容要向上长，
        // 否则每次展开都把输入框往下推。任务行在对话流里没有这个约束，两者的「展开方向」
        // 不同不影响它们读起来是同一套行。
        display: 'flex', flexDirection: 'column-reverse',
        boxSizing: 'border-box', flex: 'none', minWidth: 0,
        width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))',
        maxWidth: 'var(--dsh-composer-card-max-width, calc(var(--dsh-chat-content-width, 748px) + 32px))',
        margin: '0 auto 4px',
        ...ROW_FONT,
        // 行本身不着色块：颜色交给行内元素，hover 时整体从 tertiary 提到 secondary，
        // 与 `DisclosureRow .row` 的过渡一致。
        color: expanded ? 'var(--dsw-alias-label-secondary, inherit)' : 'var(--dsw-alias-label-tertiary, #81858c)',
        transition: 'color 100ms ease',
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={recordsId}
        data-dsh-browser-header=""
        onClick={() => {
          if (!expanded) setFailuresOnly(observation.failures > 0)
          setExpanded(value => !value)
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          cursor: 'pointer', border: 0, padding: 0, background: 'transparent',
          color: 'inherit', font: 'inherit', textAlign: 'left', width: '100%', minWidth: 0,
          // 8px 圆角与对话里的折叠行一致：它没有可见底色时看不出来，但一旦 hover/聚焦
          // 有了背景，圆角就是那条行唯一能跟周围区分开的形状信息。
          borderRadius: 8,
        }}
      >
        <span style={{ width: LEADING_SIZE, height: LEADING_SIZE, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <BrowserGlyph />
        </span>
        <span style={{ flexShrink: 0 }}>{t('title')}</span>
        {/* 摘要段：等宽 gap 之后，允许被挤压省略；chevron 永不被裁掉。
            刻意**不加**右侧独立计数 —— 任务行是「任务 10 已完成」这种单段摘要，
            多挂一个右对齐数字就变成两种视觉。调用次数已经在摘要里。 */}
        <span data-dsh-browser-failures={!observation.running && observation.failures > 0 ? '' : undefined}
          title={summary}
          style={{
            marginLeft: 8, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: state === 'error' ? 'var(--dsw-alias-status-error, #d04444)' : 'inherit',
          }}>
          {summary}
        </span>
        <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'inline-flex' }}>
          <Chevron open={expanded} />
        </span>
      </button>
      <div id={recordsId} hidden={!expanded} data-dsh-browser-records style={{ ...PANEL, minWidth: 0 }}>
        <div style={{ maxHeight: 'min(320px, 40vh)', overflowY: 'auto', padding: '4px 12px 8px' }}>
          {idle ? <p data-dsh-browser-hint style={{ margin: '8px 0', opacity: 0.75 }}>{t('idleHint')}</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0', opacity: 0.8 }}>
              {observation.url === undefined ? null : (
                <>
                  <span data-dsh-browser-title style={{ overflowWrap: 'anywhere' }}>{observation.title ?? t('untitled')}</span>
                  <code data-dsh-browser-url style={{ overflowWrap: 'anywhere' }}>{observation.url}</code>
                </>
              )}
              <span>
                {`${t('snapshot')} ${String(observation.snapshots)} · ${t('screenshot')} ${String(observation.screenshots)}`}
              </span>
            </div>
          )}
          {/* 本会话访问列表：与下方每条操作记录同用一层 disclosure（<details>），
              没有访问记录时整块不渲染，连标题都不占位。 */}
          {visits.length === 0 ? null : (
            <details data-dsh-browser-visits={String(visits.length)}
              style={{ borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))' }}>
              <summary style={{ cursor: 'pointer', padding: '6px 0', ...ROW_FONT, color: 'var(--dsw-alias-label-secondary, inherit)' }}>
                {reachedPages === 0 ? t('visitedNone') : t('visitedTitle', { count: reachedPages })}
              </summary>
              <ol style={{ listStyle: 'none', margin: '0 0 8px', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {visits.map((visit, index) => (
                  <li key={`${visit.url}:${String(index)}`} data-dsh-browser-visit={visit.ok ? 'ok' : 'failed'}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, fontSize: 12,
                      // 失败行的地址只是「参数里的目标地址」，并未确认到达，整行标红以示区别。
                      color: visit.ok ? undefined : 'var(--dsw-alias-status-error, #d04444)',
                    }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
                      <code style={{ wordBreak: 'break-all', overflowWrap: 'anywhere', minWidth: 0 }}>{visit.url}</code>
                      {visit.ok ? null : (
                        <span data-dsh-browser-visit-target style={{ flexShrink: 0, padding: '0 4px', borderRadius: 4, border: '1px solid currentColor', opacity: 0.85 }}>
                          {t('visitedTarget')}
                        </span>
                      )}
                    </span>
                    <span style={{ opacity: 0.75, overflowWrap: 'anywhere' }}>
                      {visit.title ?? (visit.ok ? t('untitled') : t('visitedFailed'))}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {/* 过滤开关与空态只在**有调用**时才出现：会话还没用过网页工具时，展开面板
              应该只有一句说明，而不是「只看失败」复选框加一条「暂无符合条件的操作记录」——
              那两句在没有记录可言的时候纯属自说自话。 */}
          {idle ? null : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={failuresOnly} onChange={event => setFailuresOnly(event.target.checked)} />
                {t('failuresOnly')}
              </label>
              {/* 汇总入口只在真有失败时出现：没有失败可复制时摆一个按钮，等于承诺一份空报告。
                  它复制的是**全部**失败调用，不受「只看失败」过滤影响 —— 用户要的是完整现场。 */}
              {observation.failures > 0 ? (
                <CopyButton
                  label={t('copyFailureReport')}
                  copiedLabel={t('copied')}
                  failedLabel={t('copyError')}
                  title={t('copyFailureHint')}
                  text={() => buildFailuresDiagnostic(calls, diagnosticFor(t('diagnosticHeading', { count: observation.failures })))}
                  style={{ marginLeft: 'auto' }}
                />
              ) : null}
            </div>
          )}
          {!idle && visibleCalls.length === 0 ? <p style={{ opacity: 0.75 }}>{t('noRecords')}</p> : null}
          {visibleCalls.map((call, index) => (
            <details key={call.callId || `${call.toolName}:${String(index)}`}
              data-dsh-browser-call-state={!call.settled ? 'running' : call.isError ? 'error' : 'success'}
              style={{ borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))' }}>
              <summary style={{ cursor: 'pointer', padding: '6px 0', overflowWrap: 'anywhere' }}>
                <span style={{ color: call.settled && call.isError ? 'var(--dsw-alias-status-error, #d04444)' : undefined }}>
                  {!call.settled ? t('active') : call.isError ? t('failure') : t('succeeded')}
                </span>{' · '}<code>{call.toolName}</code>
                {call.isError && call.resultText ? <span>{' · '}{failureSummary(call.resultText)}</span> : null}
              </summary>
              <div style={{ padding: '4px 0 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 4px' }}>
                  <strong>{t('arguments')}</strong>
                  {/* 每条都带复制入口：成功调用的参数/回执同样可能是「结果不对」的证据。 */}
                  <CopyButton
                    label={t('copyDiagnostic')}
                    copiedLabel={t('copied')}
                    failedLabel={t('copyError')}
                    title={t('copyDiagnosticHint')}
                    text={() => buildCallDiagnostic(call, diagnosticFor(t('diagnosticCallHeading', { count: 1 })))}
                    style={{ marginLeft: 'auto' }}
                  />
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 8px', fontSize: 12 }}>{call.argsRaw || '—'}</pre>
                <strong>{t('receipt')}</strong>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0', fontSize: 12 }}>
                  {call.resultText || (!call.settled ? t('active') : call.image ? t('imageReceipt') : t('emptyReceipt'))}
                </pre>
              </div>
            </details>
          ))}
        </div>
      </div>
    </div>
  )
}
