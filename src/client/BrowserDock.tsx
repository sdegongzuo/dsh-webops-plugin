/**
 * 浏览器观察面板：挂在 `conversation.input.dock` 上，**常驻显示**。
 *
 * 无活动时保留轻量入口，收起时只显示调用状态；页面信息与回执在上方按需展开。
 * 宽度复用宿主输入框的 CSS 变量，随会话列宽与用户宽度设置一起变化。
 *
 * 数据全部派生自对话快照（`ui-chat` 的 `ChatSnapshot`），**不新增任何 RPC**：
 * 浏览器调用本来就以工具调用节点的形式流经客户端，客户端收得到，面板跟着它走即可。
 *
 * `useChat` 由 ui-chat 通过 `SessionStandardProps` 合并进来。为了让「ui-chat 没被组合」
 * 时面板退化成不显示而不是崩掉，这里把 hook 的调用点固定在一个函数上（`readChat`），
 * 缺失时换成不读任何状态的常量实现——hook 调用次数因此恒定。
 */
import { useId, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 类型上把 ui-chat / ui-conversation 的 SlotMap 与 SessionStandardProps 合并拉进来。
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BROWSER_NS } from './locales.ts'
import { browserCallsFrom, observeBrowser, type BrowserCall } from './observation.ts'

/** 面板的完整 props：input.dock 的 owner + Session 标准件（含 `useChat`）+ 文案。 */
export type BrowserDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof BROWSER_NS>

/** 选择器形状，与 `ui-chat` 的 `UseChat` 结构一致。 */
type ChatSelector = (selector: (state: unknown) => unknown) => unknown

/** 恒等选择器：模块级常量，保证跨渲染稳定。 */
const identity = (state: unknown): unknown => state

/** ui-chat 缺席时的兜底：不订阅任何东西，面板自然显示为空。 */
const constantChat: ChatSelector = () => undefined

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
  const runningCall = calls.findLast(call => !call.settled)
  const stateText = observation.running
    ? `${t('active')}${runningCall ? ` · ${runningCall.toolName}` : ''}`
    : observation.failures > 0
      ? `${observation.failures} ${t('failedCalls')}`
      : idle ? t('idle') : `${calls.length} ${t('completedCalls')}`
  const visibleCalls = [...calls].reverse().filter(call => !failuresOnly || (call.settled && call.isError))

  return (
    <div
      data-dsh-browser-dock=""
      data-dsh-browser-state={state}
      style={{
        display: 'flex', flexDirection: 'column-reverse',
        boxSizing: 'border-box', flex: 'none', minWidth: 0,
        width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))',
        maxWidth: 'var(--dsh-composer-card-max-width, calc(var(--dsh-chat-content-width, 748px) + 32px))',
        padding: '6px 10px', margin: '0 auto 6px', fontSize: 12,
        border: expanded ? '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))' : '1px solid transparent',
        borderRadius: 10, color: 'var(--dsw-alias-label-primary, inherit)',
        background: expanded ? 'var(--dsw-specific-menu, Canvas)' : 'transparent',
      }}
    >
      <button type="button" aria-expanded={expanded} aria-controls={recordsId} onClick={() => {
        if (!expanded) setFailuresOnly(observation.failures > 0)
        setExpanded(value => !value)
      }} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', border: 0, padding: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', width: '100%', minWidth: 0 }}>
        <span style={{ fontWeight: 600, flexShrink: 0, opacity: idle ? 0.65 : 1 }}>{t('title')}</span>
        <span data-dsh-browser-failures={!observation.running && observation.failures > 0 ? '' : undefined}
          style={{ opacity: 0.75, color: state === 'error' ? 'var(--dsw-alias-status-error, #d04444)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={stateText}>{stateText}</span>
        {observation.running && observation.failures > 0 ? <span data-dsh-browser-failures style={{ color: 'var(--dsw-alias-status-error, #d04444)', flexShrink: 0 }}>
          {`${observation.failures} ${t('failedCalls')}`}
        </span> : null}
        <span style={{ marginLeft: 'auto', opacity: 0.65, flexShrink: 0 }}>
          {t('records')}{idle ? '' : ` ${calls.length}`} {expanded ? '▾' : '▴'}
        </span>
      </button>
      <div id={recordsId} hidden={!expanded} data-dsh-browser-records style={{ maxHeight: 'min(320px, 40vh)', overflowY: 'auto', marginBottom: 8, minWidth: 0 }}>
        {idle ? <p data-dsh-browser-hint style={{ opacity: 0.65 }}>{t('idleHint')}</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0', opacity: 0.7 }}>
            {observation.url === undefined ? null : (
              <>
                <span data-dsh-browser-title style={{ overflowWrap: 'anywhere' }}>
                  {observation.title ?? t('untitled')}
                </span>
                <code data-dsh-browser-url style={{ overflowWrap: 'anywhere' }}>{observation.url}</code>
              </>
            )}
            <span>
              {`${t('snapshot')} ${String(observation.snapshots)} · ${t('screenshot')} ${String(observation.screenshots)}`}
            </span>
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0' }}>
          <input type="checkbox" checked={failuresOnly} onChange={event => setFailuresOnly(event.target.checked)} />
          {t('failuresOnly')}
        </label>
        {visibleCalls.length === 0 ? <p style={{ opacity: 0.65 }}>{t('noRecords')}</p> : null}
        {visibleCalls.map((call, index) => (
          <details key={call.callId || `${call.toolName}:${index}`} data-dsh-browser-call-state={!call.settled ? 'running' : call.isError ? 'error' : 'success'}
            style={{ borderTop: '1px solid rgba(127,127,127,0.25)', padding: '6px 0' }}>
            <summary style={{ cursor: 'pointer', overflowWrap: 'anywhere' }}>
              <span style={{ color: call.settled && call.isError ? '#d04444' : undefined }}>
                {!call.settled ? t('active') : call.isError ? t('failure') : t('succeeded')}
              </span>{' · '}<code>{call.toolName}</code>
              {call.isError && call.resultText ? <span>{' · '}{failureSummary(call.resultText)}</span> : null}
            </summary>
            <div style={{ padding: '6px 10px' }}>
              <strong>{t('arguments')}</strong>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 8px' }}>{call.argsRaw || '—'}</pre>
              <strong>{t('receipt')}</strong>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0' }}>
                {call.resultText || (!call.settled ? t('active') : call.image ? t('imageReceipt') : t('emptyReceipt'))}
              </pre>
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}
