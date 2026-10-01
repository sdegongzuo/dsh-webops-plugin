import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
const { createActionOverlay } = createRequire(import.meta.url)('./action-overlay.cjs')

describe('独立操作效果层', () => {
  function fixture() {
    const handlers = new Map<string, () => void>()
    const scripts: string[] = []
    let visible = false
    let focused = true
    let parentVisible = true
    let ignored = false
    let bounds: unknown
    class Window {
      webContents = {
        on: (event: string, handler: () => void) => { if (event === 'did-finish-load') handler() },
        executeJavaScript: async (script: string) => { scripts.push(script) },
      }
      setIgnoreMouseEvents(value: boolean) { ignored = value }
      isDestroyed() { return false }
      hide() { visible = false }
      showInactive() { visible = true }
      setBounds(value: unknown) { bounds = value }
      loadFile() { return Promise.resolve() }
      destroy() {}
    }
    const parent = {
      on: (event: string, handler: () => void) => handlers.set(event, handler),
      isDestroyed: () => false, isVisible: () => parentVisible, isMinimized: () => false,
      isFocused: () => focused,
      getContentBounds: () => ({ x: 20, y: 30, width: 800, height: 676 }),
    }
    const overlay = createActionOverlay(Window, parent, '效果.html', 76)
    return { overlay, handlers, scripts, blur: () => { focused = false },
      show: (value: boolean) => { parentVisible = value; handlers.get(value ? 'show' : 'hide')?.() },
      state: () => ({ visible, ignored, bounds }) }
  }
  it('按 CSS 视口投影、穿透鼠标且不抢焦点；接管清除效果', () => {
    const f = fixture()
    f.overlay.project('t1', { x: 200, y: 150 }, 'clicking', { width: 400, height: 300 })
    expect(f.scripts.join('\n')).toContain('"x":50,"y":50')
    expect(f.state()).toEqual({ visible: true, ignored: true, bounds: { x: 20, y: 106, width: 800, height: 600 } })
    f.overlay.clear()
    expect(f.state().visible).toBe(false)
    expect(f.overlay.currentTab).toBeUndefined()
  })
  it('切到其他 app 后保留 agent 控制光晕，不抢回焦点', () => {
    const f = fixture()
    f.overlay.setControl('t1', 'agent')
    f.overlay.project('t1', { x: 10, y: 10 }, 'typing', { width: 400, height: 300 })
    f.blur()
    f.handlers.get('blur')?.()
    f.overlay.project('t1', { x: 20, y: 20 }, 'typing', { width: 400, height: 300 })
    expect(f.state().visible).toBe(true)
    expect(f.scripts.filter(script => script.includes('window.projectAction'))).toHaveLength(2)
    f.overlay.clear()
  })
  it('agent 控制光晕不受窗口焦点影响，人工接管才隐藏', () => {
    const f = fixture()
    f.overlay.setControl('t1', 'agent')
    f.overlay.clear()
    expect(f.state().visible).toBe(true)
    f.blur(); f.handlers.get('blur')?.()
    expect(f.state().visible).toBe(true)
    f.overlay.setControl('t1', 'human')
    expect(f.state().visible).toBe(false)
  })
  it('后台隐藏后再次显示和恢复，无需新工具调用也恢复光晕', () => {
    const f = fixture()
    f.overlay.setControl('t1', 'agent')
    f.blur()
    f.show(false)
    expect(f.state().visible).toBe(false)
    f.show(true)
    expect(f.state().visible).toBe(true)
    f.show(false)
    f.show(true)
    f.handlers.get('restore')?.()
    expect(f.state().visible).toBe(true)
    f.overlay.setControl('t1', 'human')
    f.show(false); f.show(true)
    expect(f.state().visible).toBe(false)
  })
})
