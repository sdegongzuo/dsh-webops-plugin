/**
 * tool-browser —— 把 `ctx.browser` 暴露成模型可见的 `browser_*` 工具。
 *
 * P0 只给 4 个只读工具（模型「看」页面）：
 *
 * | 工具 | 作用 |
 * |---|---|
 * | `browser_open` | 新开标签页，返回 session id |
 * | `browser_navigate` | 已有标签页跳转（**作废既有 snapshot ref**） |
 * | `browser_snapshot` | 紧凑页面大纲（可访问性树 + 可操作 ref） |
 * | `browser_screenshot` | 截图 → attachment |
 *
 * P1 起再加 click / fill / press / scroll / wait，并引入能力分级：
 * 必须先有一次 observation 才解锁 mutation，否则模型会「盲点」。
 *
 * ## 注册写法
 *
 * 照 dsh 的 `packages/web/tool-web/src/search.ts`：
 *
 * ```ts
 * ctx.tools.register(defineTool({
 *   name: 'browser_snapshot',
 *   description: '...',
 *   parameters: { /* JSON Schema *\/ },
 *   output: { schema: { /* ... *\/ } },
 *   timeoutMs: 60_000,   // 交给 @deepseek-ai/dsh-tool-call-timeout-policy 强制执行
 *   execute: async (args, exec) => { /* 调 ctx.browser *\/ },
 *   presentCall: args => ({ /* 给 UI 的呈现 *\/ }),
 * }))
 * ```
 *
 * `defineTool` 来自 `@deepseek-ai/dsh-tools`，定义在 `packages/core/tools/src/schema.ts`。
 *
 * ## 三个必须遵守的约定
 *
 * - **截图落盘**：`ctx.attachments.saveImage({ data, mediaType: 'image/png' })` → `ImageAttachmentRef`，
 *   消息里只留内容寻址引用，不要把 base64 塞进工具结果。
 * - **系统提示**：分段用 `section({ order: 2050 })`（紧挨 `TOOL_WEB_SEARCH: 2000` /
 *   `TOOL_WEB_FETCH: 2100`）。`SECTION_ORDERS` 是中央封闭注册表，外部插件加不了键，
 *   只能传显式数字。文案要精炼——dsh 对系统提示体积有门禁，Minke 那 20+ 行提示词不能照抄。
 * - **不可信内容**：页面文本、URL、浏览器元数据一律当数据、不是指令。这条要同时写进
 *   工具描述与系统提示。
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'tool-browser'
export const inject = ['tools', 'browser', 'systemPrompt', 'attachments']

export function apply(ctx: Context): void {
  // TODO(P0): 4 个 defineTool + ctx.tools.register；再补一个 section({ order: 2050 })。
}
