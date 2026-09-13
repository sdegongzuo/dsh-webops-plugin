/**
 * 标签栏页面的 preload：在隔离的世界里给页面开三个口子，别的什么也不给。
 *
 * 刻意**不开 nodeIntegration**：这个页面只是 UI，不需要 Node；`sandbox: true` 下
 * `contextBridge` 依然可用，所以走它。
 *
 * @module dsh-webops-plugin/browser-electron/tabbar-preload
 */

const { contextBridge, ipcRenderer } = require('electron')

/** 一个标签的摘要；字段与主进程 `sendTabBar()` 发的一致。 */
/** @typedef {{ id: string, title: string, url: string, active: boolean }} TabSummary */

/** 最近一次收到的标签列表；页面脚本可能比主进程的第一次推送晚注册，靠它补一次。 */
let latest = []

/** 最近一次收到的地址栏状态；快照补发的模式与 `latest` 相同。 */
let latestNavState = { url: '', canGoBack: false, canForward: false }

contextBridge.exposeInMainWorld('dshTabBar', {
  /**
   * 订阅标签列表变化；注册时会立刻用最近一次快照回调一次。
   * @param {(tabs: TabSummary[]) => void} listener - 每次列表变化时调用。
   * @returns {() => void} 退订函数。
   */
  onTabs: (listener) => {
    const handler = (_event, tabs) => {
      latest = tabs
      listener(tabs)
    }
    ipcRenderer.on('dsh-tabs', handler)
    listener(latest)
    return () => { ipcRenderer.removeListener('dsh-tabs', handler) }
  },
  /** 切到某个标签。 */
  select: (id) => { ipcRenderer.send('dsh-tab-select', id) },
  /** 关掉某个标签。 */
  close: (id) => { ipcRenderer.send('dsh-tab-close', id) },
  /** 新建一个标签。 */
  create: () => { ipcRenderer.send('dsh-tab-create') },
  /**
   * 地址栏导航指令：`action ∈ 'back' | 'forward' | 'reload' | 'navigate'`，
   * `navigate` 时带 `url`（页面侧已做过最小规范化，主进程会再兜底一次）。
   */
  nav: (action, url) => { ipcRenderer.send('dsh-nav', { action, url }) },
  /**
   * 订阅地址栏状态变化（`{ url, canGoBack, canForward }`）；注册时会立刻用
   * 最近一次快照回调一次，模式与 `onTabs` 相同。
   * @param {(state: { url: string, canGoBack: boolean, canForward: boolean }) => void} listener - 每次状态变化时调用。
   * @returns {() => void} 退订函数。
   */
  onNavState: (listener) => {
    const handler = (_event, state) => {
      latestNavState = state
      listener(state)
    }
    ipcRenderer.on('dsh-nav-state', handler)
    listener(latestNavState)
    return () => { ipcRenderer.removeListener('dsh-nav-state', handler) }
  },
})
