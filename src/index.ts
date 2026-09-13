/**
 * 包根的 host 半边：**故意是空的**。
 *
 * 这不是偷懒，是 dsh 客户端插件的既定形态 —— 参见 dsh 自己的
 * `packages/client/ui-brand-official/src/index.ts`：
 *
 * > The empty apply gives Loader a host-side row while the browser half ships
 * > through `exports["./client"]`.
 *
 * 原因在 `packages/client/modules/src/index.ts` 的 `locatePkgJson()`：客户端模块表
 * 判断「某个 Loader 行是不是客户端包」时，先调
 * `exactPackageSpecifier(name)` 取包名，而该函数对**非 scoped 且带 `/`** 的
 * specifier（本插件的三个 host 行 `dsh-webops-plugin/browser` 等）直接返回
 * `undefined`，于是整行被判为「永久不是客户端行」。只有**裸包名**行
 * （`dsh-webops-plugin`）才会继续解析 `dsh.client` 与 `exports["./client"]`。
 *
 * 所以：三个 host 行负责能力，这一行（裸包名）只负责让浏览器那半边被发现和加载。
 *
 * @module dsh-webops-plugin
 */

import { noteLoaded } from './debug.ts'

/** Host 插件入口。本包在 host 侧没有需要注册的服务，浏览器那半边才是主体。 */
export function apply(): void {
  noteLoaded('root', 'client row registered')
}
