/**
 * 两条独立的构建产物，对应 dsh 客户端插件的「双面」形态：
 *
 * 1. **Node half**（`lib/{browser,browser-cdp,tool-browser}/index.js`）——被 host 的
 *    cordis Loader 直接 import。ESM，`@deepseek-ai/*` 一律保持外部引用：桌面端会把这些
 *    包 link 进 profile，由宿主提供同一份实例（写死内联会造出重复的服务单例）。
 *
 * 2. **Client bundle**（`lib/client.js`）——被浏览器里的模块加载器接管。CJS，外面裹一层
 *    `window.__ModuleLoader__.load({ id, factory: (require) => … })`，外部依赖只能从 loader
 *    的模块表里 require（`react` 等），其余一律内联。这三行 banner/footer/intro 与
 *    `dsh` 自己的 `packages/client/tsdown.client.ts` 对齐，不一致加载器会解析不了。
 */
import { defineConfig } from 'tsdown'

/** 插件 id：既写进 `__ModuleLoader__.load` 的握手，也是 client 入口的构建名。 */
const PLUGIN_ID = 'dsh-browser-plugin'

/**
 * 浏览器模块表里**本来就有的**共享模块（源自 `packages/client/web/src/platform.ts`
 * 的 `PLATFORM_MODULES`）。这些必须以 `require(...)` 的形式留在外部；表里没有的
 * specifier 一旦出现在产物里，运行时会直接抛「模块表答不出这个请求」。
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const isClientExternal = (specifier: string): boolean => CLIENT_EXTERNALS.includes(specifier)
const isFirstParty = (specifier: string): boolean =>
  specifier.startsWith('@deepseek-ai/') || specifier.startsWith('node:')

/** 浏览器产物里 `zustand` 一类依赖会读的构建期常量。 */
const clientDefines = {
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
}

export default defineConfig([
  {
    name: PLUGIN_ID,
    entry: ['src/browser/index.ts', 'src/browser-cdp/index.ts', 'src/tool-browser/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: {
      neverBundle: isFirstParty,
      alwaysBundle: (specifier: string) => !isFirstParty(specifier),
    },
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    // 与 Node half 共用 lib/：clean 必须关掉，否则会把上面那半的产物擦掉。
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: isClientExternal,
      alwaysBundle: (specifier: string) => !isClientExternal(specifier),
    },
    define: clientDefines,
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
    },
  },
])
