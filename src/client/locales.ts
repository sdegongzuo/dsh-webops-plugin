/**
 * 面板文案。走 dsh 的 locale 服务注册，命名空间合并进 `LocaleNamespaceMap`，
 * 组件侧就能拿到按 key 收窄过的 `t`。
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的文案命名空间。 */
export const BROWSER_NS = 'browser-plugin'

/** 中文文案（也是 key 的唯一来源）。 */
export const zh = {
  title: '浏览器',
  active: '浏览器操作中',
  idle: '浏览器已就绪',
  failed: '浏览器工具报错',
  idleHint: '等待 agent 操作浏览器',
  url: '地址',
  snapshot: '快照',
  screenshot: '截图',
  failure: '失败',
  untitled: '未命名页面',
} as const

/** 英文文案；键集与 {@link zh} 一致。 */
export const en: Record<BrowserKey, string> = {
  title: 'Browser',
  active: 'Browser busy',
  idle: 'Browser ready',
  failed: 'Browser tool failed',
  idleHint: 'Waiting for the agent to drive a browser',
  url: 'URL',
  snapshot: 'snapshots',
  screenshot: 'screenshots',
  failure: 'failures',
  untitled: 'untitled page',
}

/** 本命名空间的文案键。 */
export type BrowserKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 浏览器观察面板的文案。 */
    'browser-plugin': BrowserKey
  }
}
