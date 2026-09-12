/**
 * `browser_*` 工具的卡片视图。
 *
 * 认领 `tool.call.toolview` 的四个 key（open / navigate / snapshot / screenshot），
 * 让这四次调用不再落到通用兜底卡片上，而是显示：工具名 → 目标地址 → 结果正文或截图。
 *
 * 截图**不走** `tool.call.images` 子槽（那是 ui-attachment 的画廊，且一个子槽只能被
 * 一个条目声明）。这里直接用 owner 下发的 `loadImage` 拿授权 URL 自己渲染 `<img>`：
 * 组件因此不依赖任何附件展示插件，装不装 ui-attachment 都能看见画面。
 */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { BROWSER_NS } from './locales.ts'
import { callFromBlock, parseBrowserUrl, type WireImageRef } from './observation.ts'

/** 结果正文最多显示的行数与字符数，避免一次 `snapshot` 把卡片撑爆。 */
const OUTLINE_MAX_LINES = 60
const OUTLINE_MAX_CHARS = 6000

/**
 * `loadImage` 的结构面。dsh 的 `MessageImageLoader` 参数类型是 `ImageAttachmentRef`
 * （`mediaType` 是字面量联合），而这里只有 wire 后的结构副本；两者形状一致但名义类型
 * 不同，故按结构收口一次。
 */
export interface ImageLoaderFace {
  (attachment: WireImageRef): Promise<string>
  peek?: ((attachment: WireImageRef) => string | undefined) | undefined
}

/** 工具卡片视图的完整 props。 */
export type BrowserToolRowProps = ToolCallViewProps & PropsLocale<typeof BROWSER_NS>

/** 解析授权 URL：能同步拿到就先同步，否则异步取一次并在卸载后丢弃结果。 */
function useImageUrl(ref: WireImageRef | undefined, load: ImageLoaderFace): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)
  const attachmentId = ref?.attachmentId
  useEffect(() => {
    if (ref === undefined) {
      setUrl(undefined)
      return
    }
    const peeked = load.peek?.(ref)
    if (peeked !== undefined) {
      setUrl(peeked)
      return
    }
    let live = true
    load(ref).then(
      (resolved) => { if (live) setUrl(resolved) },
      () => { if (live) setUrl(undefined) },
    )
    return () => { live = false }
    // attachmentId 是引用身份：同一 id 的字节不可变，只按它重取即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId, load])
  return url
}

/** 截断结果正文，保留开头（大纲的根节点在最前）。 */
function outlineOf(text: string): string {
  const clipped = text.length > OUTLINE_MAX_CHARS ? `${text.slice(0, OUTLINE_MAX_CHARS)}\n…` : text
  const lines = clipped.split('\n')
  return lines.length > OUTLINE_MAX_LINES ? `${lines.slice(0, OUTLINE_MAX_LINES).join('\n')}\n…` : clipped
}

/**
 * 一次 `browser_*` 调用的卡片。
 * @param props - slot 运行时下发的 owner、Session 标准件与本地化。
 */
export function BrowserToolRow(props: BrowserToolRowProps) {
  const { block, toolName, loadImage, t } = props
  const call = callFromBlock(block, toolName)
  const url = parseBrowserUrl(call.argsRaw)
  const imageUrl = useImageUrl(call.image, loadImage as unknown as ImageLoaderFace)

  const state = !call.settled ? 'running' : call.isError ? 'error' : 'ok'
  const stateText = !call.settled ? t('active') : call.isError ? t('failed') : t('idle')

  return (
    <div
      data-dsh-browser-row={toolName}
      data-dsh-browser-state={state}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <code style={{ fontWeight: 600 }}>{toolName}</code>
        <span style={{ opacity: 0.7 }}>{stateText}</span>
      </div>
      {url === undefined ? null : (
        <div style={{ display: 'flex', gap: 6, opacity: 0.85 }}>
          <span>{t('url')}</span>
          <code data-dsh-browser-url style={{ wordBreak: 'break-all' }}>{url}</code>
        </div>
      )}
      {imageUrl === undefined ? null : (
        <img
          data-dsh-browser-shot=""
          src={imageUrl}
          alt={call.image?.name ?? t('screenshot')}
          style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)' }}
        />
      )}
      {call.settled && call.resultText !== '' ? (
        <pre
          data-dsh-browser-outline=""
          style={{
            margin: 0, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap',
            wordBreak: 'break-word', opacity: 0.9, fontSize: 11,
          }}
        >
          {outlineOf(call.resultText)}
        </pre>
      ) : null}
    </div>
  )
}
