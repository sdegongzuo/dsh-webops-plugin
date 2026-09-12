/**
 * 浏览器观察面板：挂在 `conversation.input.dock` 上，只要有会话就参与渲染，
 * 有浏览器活动时显示「状态 · 地址 · 快照/截图计数」，没有活动时完全不占位。
 *
 * 数据全部派生自对话快照（`ui-chat` 的 `ChatSnapshot`），**不新增任何 RPC**：
 * 浏览器调用本来就以工具调用节点的形式流经客户端，客户端收得到，面板跟着它走即可。
 *
 * `useChat` 由 ui-chat 通过 `SessionStandardProps` 合并进来。为了让「ui-chat 没被组合」
 * 时面板退化成不显示而不是崩掉，这里把 hook 的调用点固定在一个函数上（`readChat`），
 * 缺失时换成不读任何状态的常量实现——hook 调用次数因此恒定。
 */
import { useMemo } from 'react'
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
 * 订阅对话快照并抽出全部 `browser_*` 调用。
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
  const latest = observation.latest

  // 没有浏览器活动时不占位：dock 参与渲染，但渲染出空。
  if (latest === undefined) return null

  const state = observation.running ? 'running' : observation.failures > 0 ? 'error' : 'idle'
  const stateText = state === 'running' ? t('active') : state === 'error' ? t('failed') : t('idle')

  return (
    <div
      data-dsh-browser-dock=""
      data-dsh-browser-state={state}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '6px 10px', margin: '0 0 6px', fontSize: 12,
        border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8,
      }}
    >
      <span style={{ fontWeight: 600 }}>{t('title')}</span>
      <span style={{ opacity: 0.75 }}>{stateText}</span>
      {observation.url === undefined ? null : (
        <code data-dsh-browser-url style={{ wordBreak: 'break-all', opacity: 0.9 }}>
          {observation.url}
        </code>
      )}
      <span style={{ opacity: 0.6 }}>
        {`${t('snapshot')} ${String(observation.snapshots)} · ${t('screenshot')} ${String(observation.screenshots)}`}
      </span>
      {observation.failures === 0 ? null : (
        <span data-dsh-browser-failures style={{ opacity: 0.75 }}>
          {`${t('failure')} ${String(observation.failures)}`}
        </span>
      )}
    </div>
  )
}
