/**
 * 加载诊断。
 *
 * host 半边跑在桌面端自己的子进程里，没有 UI 可以看「插件到底装上没有」。
 * 打开 `DSH_BROWSER_PLUGIN_DEBUG=1` 时，各半边各输出一行到 stderr —— 这是从外部
 * 判断 host 半边是否被 Loader 真实加载过、其依赖是否都在的唯一直接证据。
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
  process.stderr.write(`[dsh-browser-plugin] ${face}: ${detail}\n`)
}
