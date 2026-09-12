/**
 * 加载诊断。
 *
 * host 半边跑在桌面端自己的子进程里，没有 UI 可以看「插件到底装上没有」。
 * 打开 `DSH_BROWSER_PLUGIN_DEBUG=1` 时，各半边各输出一行 —— 这是从外部判断
 * host 半边是否被 Loader 真实加载过、其依赖是否都在的唯一直接证据。
 *
 * **必须写 stdout，不能写 stderr**：桌面端的 `DesktopHostProcess` 把子进程的
 * stderr 攒在内存里，只在失败时才随错误一起抛出；stdout 则被 `pipe` 到
 * Electron 的 stdout，能实时看到。写 stderr 等于什么都不写。
 *
 * 默认关闭：正常运行时插件不该往 stdout/stderr 写东西。
 *
 * @module dsh-browser-plugin/debug
 */

/** 打开诊断输出的环境变量名。 */
export const DEBUG_ENV = 'DSH_BROWSER_PLUGIN_DEBUG'

/**
 * 按需输出一行加载诊断。
 * @param face - 哪个半边（`browser` / `browser-cdp` / `tool-browser`）。
 * @param detail - 这一行的细节。
 */
export function noteLoaded(face: string, detail: string): void {
  if (process.env[DEBUG_ENV] !== '1') return
  process.stdout.write(`[dsh-browser-plugin] ${face}: ${detail}\n`)
}
