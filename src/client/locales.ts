/**
 * 面板文案。走 dsh 的 locale 服务注册，命名空间合并进 `LocaleNamespaceMap`，
 * 组件侧就能拿到按 key 收窄过的 `t`。
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的文案命名空间。 */
export const BROWSER_NS = 'webops-plugin'

/** 中文文案（也是 key 的唯一来源）。 */
export const zh = {
  title: '网页操作',
  // 状态词与 title 拼在一起显示（「网页操作 · 已就绪」），所以这里不要重复「网页操作」。
  active: '操作中',
  idle: '已就绪',
  failed: '有调用失败',
  idleHint: 'agent 可打开、观察与操作网页',
  url: '地址',
  snapshot: '快照',
  screenshot: '截图',
  failure: '失败',
  untitled: '未命名页面',
  failuresOnly: '只看失败',
  noRecords: '暂无符合条件的操作记录',
  succeeded: '调用成功',
  arguments: '调用参数',
  receipt: '原始回执',
  imageReceipt: '回执包含图片，可在对话工具卡片中查看',
  emptyReceipt: '无文本回执',
  failedCalls: '次调用失败',
  completedCalls: '次调用完成',
  // 「本会话访问列表」区块：标题自带数量占位，{count} 由面板填（只数确认到达的）。
  visitedTitle: '访问过 {count} 个页面',
  // 一条都没确认到达（只有失败的目标地址）时的标题，避免出现「访问过 0 个页面」。
  visitedNone: '没有确认到达的页面',
  // 失败行的小标：说明这一行是「想去的地址」，不代表真的到过。
  visitedTarget: '目标',
  // 失败行的第二行：与「未命名页面」区分开，避免把没到达的地址说成页面。
  visitedFailed: '未确认到达',
} as const

/** 英文文案；键集与 {@link zh} 一致。 */
export const en: Record<BrowserKey, string> = {
  title: 'Web ops',
  active: 'busy',
  idle: 'ready',
  failed: 'call failed',
  idleHint: 'The agent can open, inspect, and drive web pages',
  url: 'URL',
  snapshot: 'snapshots',
  screenshot: 'screenshots',
  failure: 'failures',
  untitled: 'untitled page',
  failuresOnly: 'Failures only',
  noRecords: 'No matching operations',
  succeeded: 'Call succeeded',
  arguments: 'Arguments',
  receipt: 'Original result',
  imageReceipt: 'Image result available in the conversation tool card',
  emptyReceipt: 'No text result',
  failedCalls: 'calls failed',
  completedCalls: 'calls completed',
  visitedTitle: 'Visited {count} pages',
  visitedNone: 'No confirmed page visits',
  visitedTarget: 'target',
  visitedFailed: 'arrival not confirmed',
}

/** 本命名空间的文案键。 */
export type BrowserKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 浏览器观察面板的文案。 */
    'webops-plugin': BrowserKey
  }
}
