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
  // 状态词与 title 拼在一起显示（「浏览器 · 已就绪」），所以这里不要重复「浏览器」。
  active: '操作中',
  idle: '已就绪',
  failed: '有调用失败',
  idleHint: 'agent 可用 browser_* 工具打开、观察与操作页面',
  url: '地址',
  snapshot: '快照',
  screenshot: '截图',
  failure: '失败',
  untitled: '未命名页面',
} as const

/** 英文文案；键集与 {@link zh} 一致。 */
export const en: Record<BrowserKey, string> = {
  title: 'Browser',
  active: 'busy',
  idle: 'ready',
  failed: 'call failed',
  idleHint: 'The agent can open, inspect, and drive pages via browser_* tools',
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
