/** scripts/slim-portable-app.mjs 的类型声明（该文件是 ESM 脚本，由 src/slim-portable-app.test.ts 导入）。 */

/**
 * 对一个 app 目录执行瘦身：删旧布局重复 pnpm、语言包只留中英文（zh-CN / en-US）。
 * 中止条件（抛错）：locales 缺白名单语言包、两份 pnpm 文件集合或内容不一致、app 目录不存在。
 */
export function slimApp(app: string): {
  locales: { removed: number; bytes: number; missing: never[] }
  legacyPnpm: { removed: boolean; reason: string; bytes: number }
}

/** 只读核验并生成复制过滤器，输入目录始终保留。 */
export function planSlimAppCopy(app: string): {
  excluded: string[]
  skippedBytes: number
  filter: (path: string) => boolean
}
