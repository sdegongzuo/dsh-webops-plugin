/**
 * 浏览器观察面板：挂在 `conversation.input.dock` 上，**常驻显示**。
 *
 * 为什么无活动也要占位：这个插件要「装完在界面里看得见」。只在模型真的调用过
 * `webpage_*` 之后才出现的话，用户装完插件打开会话什么也看不到，等于没有证据表明
 * 客户端半边活了。所以无活动时显示一行「网页操作 · 已就绪 / agent 可打开、观察与操作网页」。
 * 这一行同时也是 `scripts/check-desktop.mjs` 的第四项硬证据。
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

/**
 * 常驻的浏览器状态条。
 * @param props - slot 运行时下发的 owner、Session 标准件与本地化。
 */
export function BrowserDock(props: BrowserDockProps) {
  const { useChat, t } = props
  const calls = useBrowserCalls(useChat)
  const observation = observeBrowser(calls)
  const state = observation.running ? 'running' : observation.failures > 0 ? 'error' : 'idle'
  const stateText = state === 'running' ? t('active') : state === 'error' ? t('failed') : t('idle')
  const idle = observation.calls === 0
  const [failuresOnly, setFailuresOnly] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const recordsId = useId()
  const visibleCalls = [...calls].reverse().filter(call => !failuresOnly || (call.settled && call.isError))

  return (
    <div
      data-dsh-browser-dock=""
      data-dsh-browser-state={state}
      style={{
        display: 'flex', flexDirection: 'column-reverse',
        padding: '6px 10px', margin: '0 0 6px', fontSize: 12,
        border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8,
      }}
    >
      <button type="button" aria-expanded={expanded} aria-controls={recordsId} onClick={() => setExpanded(value => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', cursor: 'pointer', border: 0, padding: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', width: '100%' }}>
      <span style={{ fontWeight: 600 }}>{t('title')}</span>
      <span style={{ opacity: 0.75 }}>{stateText}</span>
      {/* 无活动时给一句说明，否则这行就只剩「网页操作 · 已就绪」，看不出在等什么。 */}
      {idle ? (
        <span data-dsh-browser-hint style={{ opacity: 0.6 }}>{t('idleHint')}</span>
      ) : (
        <>
          {observation.url === undefined ? null : (
            <>
              <code data-dsh-browser-url style={{ wordBreak: 'break-all', opacity: 0.9 }}>
                {observation.url}
              </code>
              {/* 标题与地址同源（回执自报），必须跟当前页面一致；缺标题时明示「未命名页面」。 */}
              <span
                data-dsh-browser-title
                title={observation.title ?? t('untitled')}
                style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.9 }}
              >
                {observation.title ?? t('untitled')}
              </span>
            </>
          )}
          <span style={{ opacity: 0.6 }}>
            {`${t('snapshot')} ${String(observation.snapshots)} · ${t('screenshot')} ${String(observation.screenshots)}`}
          </span>
          {observation.failures === 0 ? null : (
            <span data-dsh-browser-failures style={{ opacity: 0.75 }}>
              {`${t('failure')} ${String(observation.failures)}`}
            </span>
          )}
        </>
      )}
      <span style={{ marginLeft: 'auto', opacity: 0.65 }}>{t('records')} {calls.length} {expanded ? '▾' : '▴'}</span>
      </button>
      <div id={recordsId} hidden={!expanded} data-dsh-browser-records style={{ maxHeight: 'min(360px, 45vh)', overflowY: 'auto', marginBottom: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0' }}>
          <input type="checkbox" checked={failuresOnly} onChange={event => setFailuresOnly(event.target.checked)} />
          {t('failuresOnly')}
        </label>
        {visibleCalls.length === 0 ? <p style={{ opacity: 0.65 }}>{t('noRecords')}</p> : null}
        {visibleCalls.map((call, index) => (
          <details key={`${call.callId}:${index}`} data-dsh-browser-call-state={!call.settled ? 'running' : call.isError ? 'error' : 'success'}
            style={{ borderTop: '1px solid rgba(127,127,127,0.25)', padding: '6px 0' }}>
            <summary style={{ cursor: 'pointer', overflowWrap: 'anywhere' }}>
              <span style={{ color: call.settled && call.isError ? '#d04444' : undefined }}>
                {!call.settled ? t('active') : call.isError ? t('failure') : t('succeeded')}
              </span>{' · '}<code>{call.toolName}</code>
              {call.isError && call.resultText ? <span>{' · '}{call.resultText.split('\n')[0]}</span> : null}
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
