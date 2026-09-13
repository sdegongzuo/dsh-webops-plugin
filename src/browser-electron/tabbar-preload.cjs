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
})
