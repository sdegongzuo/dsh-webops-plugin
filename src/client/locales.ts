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
  // ── 诊断报告复制 ─────────────────────────────────────────────
  // 两个入口共用一套结果反馈：单条记录复制的是那一条，汇总按钮复制的是全部失败调用。
  copyDiagnostic: '复制诊断信息',
  copyFailureReport: '复制失败详情',
  copied: '已复制',
  copyError: '复制失败',
  copyDiagnosticHint: '复制工具名、调用参数、原始回执与页面身份，便于排查',
  copyFailureHint: '复制全部失败调用的原始信息，可直接粘贴给模型或同事分析',
  // 报告标题里的 {count} 由面板用 t 的插值填；buildFailuresDiagnostic 不再二次替换。
  diagnosticHeading: '网页操作失败诊断（{count} 条）',
  diagnosticCallHeading: '网页操作调用诊断（{count} 条）',
  diagnosticPage: '页面',
  // 参数里的目标地址：这条调用**没有确认到达**，不能说成页面。
  diagnosticTarget: '目标地址',
  // 连目标地址都没有（如失败的 execute），也不拿面板当前页冒充本次调用的地址。
  diagnosticPageUnknown: '地址未知（本条调用没有留下地址证据，见上方当前页面）',
  diagnosticCurrentPage: '当前页面',
  diagnosticTitle: '标题',
  diagnosticTab: '标签',
  diagnosticEnvironment: '环境',
  // 报告里每条记录的状态词：不复用面板的 'failure'/'succeeded'，那里是给人扫一眼的
  // 短语（「调用成功」），这里是 Markdown 小标题的一部分，要短。
  diagnosticFailed: '失败',
  diagnosticSucceeded: '成功',
  diagnosticActive: '进行中',
  diagnosticPlugin: '插件',
  // 统计行三个占位：{total} 是全部调用（含进行中），{running} 单列进行中，{failed} 只数已结算的失败。
  // 失败工具另起一行（没有失败时不出现）。
  diagnosticStats: '会话统计: 网页调用 {total} 次（进行中 {running} 次），失败 {failed} 次',
  diagnosticFailedTools: '失败工具',
  diagnosticSequence: '会话内序号',
  diagnosticErrorCode: '错误码',
  diagnosticArgsCheck: '参数检查',
  diagnosticArgsJson: '合法 JSON',
  diagnosticArgsNotJson: '不是合法 JSON（参数按原文保留，未做任何修补）',
  // 空参数与「参数不合法」是两件事：前者是模型根本没发参数，后者是发了但解析不了。
  diagnosticArgsMissing: '未提供参数',
  diagnosticRetry: '与前一次失败参数完全相同（疑似重试）',
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
  copyDiagnostic: 'Copy diagnostics',
  copyFailureReport: 'Copy failure details',
  copied: 'Copied',
  copyError: 'Copy failed',
  copyDiagnosticHint: 'Copy the tool name, arguments, original result, and page identity for troubleshooting',
  copyFailureHint: 'Copy the raw details of every failed call to paste into an analysis',
  diagnosticHeading: 'Web ops failure diagnostics ({count})',
  diagnosticCallHeading: 'Web ops call diagnostics ({count})',
  diagnosticPage: 'page',
  diagnosticTarget: 'target URL',
  diagnosticPageUnknown: 'address unknown (this call left no address evidence; see the current page above)',
  diagnosticCurrentPage: 'current page',
  diagnosticTitle: 'title',
  diagnosticTab: 'tab',
  diagnosticEnvironment: 'environment',
  diagnosticFailed: 'failed',
  diagnosticSucceeded: 'succeeded',
  diagnosticActive: 'running',
  diagnosticPlugin: 'plugin',
  diagnosticStats: '{total} web calls ({running} running), {failed} failed',
  diagnosticFailedTools: 'failed tools',
  diagnosticSequence: 'call #',
  diagnosticErrorCode: 'error code',
  diagnosticArgsCheck: 'arguments check',
  diagnosticArgsJson: 'valid JSON',
  diagnosticArgsNotJson: 'not valid JSON (copied verbatim, nothing repaired)',
  diagnosticArgsMissing: 'no arguments given',
  diagnosticRetry: 'identical arguments to the previous failure (likely a retry)',
}

/** 本命名空间的文案键。 */
export type BrowserKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 浏览器观察面板的文案。 */
    'webops-plugin': BrowserKey
  }
}
