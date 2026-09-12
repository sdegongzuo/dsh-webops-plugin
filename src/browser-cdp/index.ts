/**
 * browser-cdp —— 用 Chrome DevTools Protocol 驱动浏览器的 provider。
 *
 * P0 形态：连接**用户自己开着的** Chrome（`--remote-debugging-port=<port>`），
 * 不自己下载 Chromium，也不依赖 Playwright —— 既拿到用户真实登录态，又绕开
 * 浏览器下载与构建脚本授权（pnpm 的 allowBuilds 是默认拒绝的白名单制）。
 *
 * ## 实现指引
 *
 * - 发现 target：`GET http://127.0.0.1:<port>/json/list`
 * - 新开标签页：`PUT http://127.0.0.1:<port>/json/new?<url>`
 * - 驱动页面：WebSocket 连 `webSocketDebuggerUrl`，发 `{ id, method, params }`
 * - 观察：`Accessibility.getFullAXTree` → 裁剪成紧凑大纲 + ref 分配
 * - 截图：`Page.captureScreenshot` → base64 → `Uint8Array`
 * - 调试采集（P2）：`Runtime.consoleAPICalled` / `Network.*`
 * - 地址策略：复用 `packages/web/web-fetch-http/src/policy.ts` + `network.ts` 的思路，
 *   不要重写「只允许公网 HTTP(S)、禁止内嵌凭据」那一套校验
 *
 * 若要拉起浏览器进程，走 `ctx.subprocess`（`super(ctx, 'subprocess')`），
 * 不要裸用 `child_process` —— 进程树回收与 Windows Job 语义由能力层统一。
 *
 * ## 工作量提醒
 *
 * Minke 的 `desktop/main/agent-browser/cdp.ts` 是 5219 行，snapshot 与定位是硬骨头。
 * 参照目录：`D:\dev\cli\Minke\desktop\main\agent-browser\`。
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'browser-cdp'
export const inject = ['browser']

export function apply(ctx: Context): void {
  // TODO(P0): 构造 CdpBrowserProvider，并 ctx.browser.registerProvider(provider)。
  //   - provider.id 用 'cdp'
  //   - available() 探测调试端口是否在监听（不要假设已连接）
  //   - open() 优先接管既有 target，而不是无脑新开
  //   - observe({kind:'snapshot'}) 负责 epoch 递增与 ref 表
}
