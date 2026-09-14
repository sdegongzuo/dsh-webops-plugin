# dsh 桌面端便携版 —— 发版存档

> **v0.1.0 的 zip 是本机手打的**；自 `desktop-v0.2.0` 起 Release 说明由
> `.github/workflows/release-desktop.yml` 在 CI 里内联生成（含当场算出的 SHA-256 与体积）。
> 下面 v0.1.0 一节是历史存档，**v0.2.0 一节是重发后的验证结论**，留作后续发版的对照基线。

---


---

## 发版必读：三个坑（都踩过，都会静默）

#### 坑：profile 光写 `package.json` 不够，插件会被静默抹掉

`scripts/package-desktop-portable.mjs` 手工物化 `home/profiles/desktop/`。但只写
`package.json`（登记 `dependencies` + `dsh.profile.bundles`）**不能生效**：

`DesktopProjectManager.applyRelease()`（`apps/desktop/src/project-manager.ts:306`）第一步是
`previous = readDesktopProfileState(profile)`，读的是 profile 下的 `desktop-runtime-state.json`；
`previous === undefined`（文件不存在）时它会调 `createPluginProfile()`，而那个函数
（同文件 `:604`）把 `package.json` **整个重写**成 `dependencies: {}` +
`bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]` —— 登记的插件被冲掉，
接着 `prepareProfile()` 拿空的 activePlugins 校验，直接返回，**不报错、不提示**。
表现就是：双击启动、界面正常、什么插件都没有。

所以打包脚本会额外写一份 `desktop-runtime-state.json`，三个取值有硬约束：

| 字段 | 约束 | 踩错的后果 |
|---|---|---|
| `nodeVersion` / `platform` / `arch` | 必须与 `app/resources/dsh/desktop-runtime.json` 完全一致 | 不一致 → `reconcileProfile` 判定 `rebuild=true` → **删掉整个 `node_modules`** 再跑 `pnpm install --frozen-lockfile`（插件不在 registry，必挂） |
| `runtimeId` | `sha256(JSON.stringify(descriptor))`，键序照抄 `runtime-tree.ts:150` 的构造 | 不一致 → **起宿主之前** `assertProfileRuntime`（`main.ts:204`）就抛 `profile does not match this application runtime`，用户看到的是启动错误页（**不是无害的**，2026-09-14 实测纠正了先前「只是走不到快速返回分支」的误记） |
| `links` | 给 `[]` | 真实 junction 的 target 是**用户机器上的绝对路径**，打包时无从得知；给空数组让桌面端自己建链并回写 |

校验这三条不靠肉眼：`pnpm run verify:portable` 会用 harness 真代码（`readDesktopRuntime` +
`desktopRuntimeId`）重算一遍并逐项对照。

> 这个坑 v0.1.0 和 v0.2.0 都有 —— 两个包发出去后插件都没加载过，因为从来没人真的双击起过它。

#### 坑：keyless 验证夹具 `fake-llm` 曾经随包发出去

v0.2.0 的 `cordis.patch.yml` 里带着 `fake-llm` 行。它**不是**一个无害的调试开关：

```js
ctx.on('llm/stream', (options, _next) => { /* 直接 return 自己的流，从不调 _next() */ })
```

`llm/stream` 在 dsh 里是 **waterfall**（`dsh-llm/lib/index.js`：`ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(...))`），
监听器只要不调 `next()` 就短路掉真实模型。所以装了 v0.2.0 的用户，**任何真实对话都会被换成
「打开百度 → 读热搜第五条」的脚本回放**。（对照官方写法的正确姿势：`dsh-llm/lib/invariant.js:63`
的 `(_options, next) => validateStream(next(), fail)` —— 它调了 `next()`。）

现在这三道防线同时存在：

| 防线 | 位置 |
|---|---|
| 那一行不在出货 patch 里 | `cordis.patch.yml`（随 `package.json#files` 进便携版） |
| 开发/验证专用 overlay 单独一个文件，且不在出货白名单 | `cordis.fake-llm.patch.yml`（由 `dev-desktop.mjs` 拼接写进开发态 profile） |
| `apply` 有闸门，默认哑 | `src/fake-llm/index.ts` 的 `GATE_ENV = 'DSH_FAKE_LLM'`，只有 `=1` 才注册监听器 |

`src/bundle-patch.test.ts` 会把前两条钉死在 `pnpm test` 里（它按 YAML 有效行断言，注释里
解释「为什么不在」不会误伤自己）。

#### 发版前必做：`pnpm run verify:portable`

上面两个坑**都不会**被 `pnpm typecheck` / `pnpm test` / CI 构建拦住 —— 那一行是合法配置，
插件也是合法加载。所以发便携版之前必须真的把**打包产物**起一次：

```bash
# 1) 解压便携版（zip 解开，或 CI 产出的目录）
# 2) 自检（先用 harness 真代码走桌面端启动准备，再真起宿主读 boot graph）
pnpm run verify:portable -- --dir /path/to/解压后的目录
# 3) 想在真浏览器里再确认客户端注册，就多给一个 Chrome：
pnpm run verify:portable -- --dir /path/to/解压后的目录 \
    --browser "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

`--harness` 指向 deepseek-harness 源码（默认 `$DSH_HARNESS` 或 `D:/dev/cli/deepseek-harness`），
前几条断言靠它的 `apps/desktop/src/*.ts` 真代码 —— 不是脚本自己复刻的逻辑。

它分两段：**先把桌面端的启动准备走一遍**（`readDesktopRuntime` → `desktopRuntimeId` →
`verifyDesktopRuntime` → `linkDesktopHostPackages` → `validateDesktopPluginGraph`，
即 Electron 里 `applyRelease()` 串起来的那几步）；**再复刻 Electron 壳对宿主做的前两件事**
（给 fd3/fd4 管道、转发 `dsh-app://app/*` 请求）。拿到的 `/index.html` 与真启动同源，
验证的是**产物本身**：

| 断言 | 挡住的失败 |
|---|---|
| `app/resources/dsh` 全量 sha256 对齐 `desktop-runtime.json#files` | 解压损坏 / 打包截断 |
| `state.runtimeId` 与本包 runtime 一致 | 起宿主前被 `assertProfileRuntime` 拦到错误页 |
| `state.nodeVersion` / `platform` / `arch` 与 runtime 一致 | `reconcileProfile` 走 `rebuild` → `pnpm install --frozen-lockfile` → 插件不在 registry，必挂 |
| 能建出 241 条宿主链接，且 `validateDesktopPluginGraph` 通过 | 插件依赖没本地化 / 共享宿主实例被顶替 / peer 版本不满足 |
| 出货 patch 里没有 `llm/stream` 劫持行、profile 里没有越权 overlay | `fake-llm` 这类夹具随包出货 |
| `desktop-runtime-state.json` 在位、无遗留 `desktop-packages-pending` | 插件登记被 `createPluginProfile` 静默抹掉 |
| `__DSH_BOOT__` 里有插件的客户端行，bundle 能 200 拉取且是合法客户端模块 | 客户端半边没被发现 |
| 给了 `--browser` 时 `<html>` 信标 `dshBrowserPluginDock≥1`、`dshBrowserPluginToolViews≥15` | bundle 拉到了但注册失败 |

脚本在 profile 的**工作副本**上建链，不动 `--dir` 里那份，所以可以反复跑（每次都从出厂态验）。

`release-desktop.yml` 里也内置了这一步（「发版前自检」），跑在「打好 zip」之后、「发布 Release」之前，
直接验 `.desktop-stage`（zip 的内容源，不必先解压）——**不过就不发 Release**。
所以以后坏包不会再出现在 Release 上，不必靠把 237 MB 拖回本地才验得动。

> 它**不断言状态条出现在 DOM 里**：状态条挂在会话面的 `conversation.input.dock` 上，而
> `ui-conversation` 只在会话存在时才渲染那个 slot（`const zone = session === undefined ? undefined : {…}`）——
> 空 home 会停在「选择工作区」页，那一面根本没挂载。这是**预期行为**，不是插件没加载
> （2026-09-14 就是在这里误会过一次：用户还没选工作区，以为插件没装上）。

##### 自检本身踩过的坑：解压产物损坏会被误读成「包坏了」

2026-09-14 对便携版真包做自检时，`runDesktopHost` 报
`Cannot find package '@deepseek-ai/dsh-client-ui-workflow-run'`，看着像包不完整 —— 其实是
**解压那一步坏了**：`D:/tmp/dsh-v021-run` 的 14071 个文件里 **5160 个是 NUL 填充**
（大小对、内容全 `\x00`；`使用说明.txt`、`dsh-desktop-host/lib/index.js` 全中招），
而 zip 自己的 CRC 校验 **11954 个条目全绿**。

所以第一条断言就是全量 sha256 —— 它把「包到底好不好」变成证据，而不是靠「起不来 → 包坏了」猜。
再遇到同类报错，先验 zip（`python -c "import zipfile;print(zipfile.ZipFile(p).testzip())"`），
再验解压产物；**换一种解压方式**即可（Python 的 `zipfile.read()` 逐条写盘是好的）。

另：**出厂态 `profile/node_modules` 只有 `dsh-webops-plugin` 一个条目**是正常的 ——
241 条 `@deepseek-ai/*` 链接由桌面端首次启动时 `linkDesktopHostPackages` 建立，
zip 里没有它们、`state.links` 是空数组，**这是设计如此**（链接目标在用户机器上无从预知）。

## v0.2.0（2026-09-14 重发，CI 构建 run `34857849891`）

v0.2.0 第一次发出去是坏的：打包时漏写 `home\profiles\desktop\desktop-runtime-state.json`，
桌面端 `applyRelease()` 在 `previous === undefined` 时会调 `createPluginProfile()` 把
profile 的 `package.json` 重写成空插件列表 —— **插件登记被静默抹掉，不报错也不提示**。
修复后决定**原地覆盖 v0.2.0**（`package.json` 的 version 从 0.2.1 回退到 0.2.0 与 tag 对齐）。

### 资产

| 项 | 值 |
|---|---|
| 文件 | `dsh-webops-desktop-v0.2.0-win-x64-portable.zip` |
| 大小 | 237,431,549 字节 |
| SHA-256 | `1b9b3868b6787586b72ad408f17711e4f8822629dd5712a3d1c5386c9e429607` |

⚠️ **不要用字节数判断包的好坏**：这次的资产 237,431,549、坏掉的旧资产 237,429,790、
本地构建 237,414,706 —— 三个都不同，CI 构建与本地构建本就有差异。只认内容断言。

### 验证结论（`pnpm run verify:portable`，33 项全绿）

| 段 | 结论 |
|---|---|
| ① zip 完整性 | 11,887 条 CRC 全绿；逐条 `read()` 写盘 11,762 个文件；无一命中 NUL 填充 |
| ② 产物完整性 + runtime 身份 | 11,218 个受校验文件 sha256 全部匹配；`state.runtimeId` / `nodeVersion` / `platform` / `arch` 四项与包内 runtime 一致 |
| ③ 复刻启动准备 | 241/241 条宿主包链接建成；`validateDesktopPluginGraph` 通过；`activePlugins=["dsh-webops-plugin"]` |
| ④ 生产路径起宿主 | `/index.html` 200、`__DSH_BOOT__` 已注入、boot graph 52 行且含 `dsh-webops-plugin`、客户端 bundle 可拉取且合法 |
| ⑤ 真浏览器信标 | `dshBrowserPlugin=1`、dock 已注册、15 个工具视图全部注册 |
| ⑥ 出货 patch 守卫 | 不含 `fake-llm` / `llm-replay` / `mock-llm`（v0.2.0 事故点），含 browser-cdp / browser-electron / tool-browser 与裸包名行 |

关键修复点在包里已经能直接看到：`home\profiles\desktop\package.json` 的
`dsh.profile.bundles` 含 `dsh-webops-plugin`，`desktop-runtime-state.json` 的
`runtimeId` 非空、`links` 为 `[]`。

**唯一机器验不了的环节**：双击 `启动.cmd` 后输入框上方是否出现「网页操作」状态条。
本环境起不了 Electron GUI（宿主能在纯 node 里驱动，真实窗口渲染只能人眼确认），
需要使用者确认。

---

## v0.1.0（历史存档，本机手打）

**已内置 `dsh-webops-plugin@0.1.0`**，解压即用：不需要 Node、不需要 pnpm、不需要联网装插件、不需要签名证书。

## 怎么用

1. 下载下面的 `dsh-webops-desktop-v0.1.0-win-x64-portable.zip`（226 MB）。
2. **解压到不含中文、不需要管理员权限的路径**（例如 `D:\dsh\`）。
3. 双击 **`启动.cmd`**。

> 一定走 `启动.cmd`，不要直接点 `app\` 里的 exe。
> 直接点 exe 时 `$DSH_HOME` 会落回 `C:\Users\<你>\.dsh`，配置就不随包走了，预装的插件也不在生效的 profile 里。

## 目录结构

```
启动.cmd                 ← 双击这个（把 DSH_HOME 指到包内 home\）
使用说明.txt
app\                     ← dsh 桌面端本体（Electron，611 MB 展开后）
home\                    ← 全部用户数据：会话、设置、凭据、已装插件
  profiles\desktop\
    package.json         ← profile manifest，bundles 里已登记本插件
    node_modules\dsh-webops-plugin\
```

整个目录拷进 U 盘就能带走；删掉 `home\` 即恢复出厂。

## 验证插件生效

启动后在输入框上方应能看到「网页操作」状态条；让 agent 调用 `browser_open` 能开页面。

## 已知事项

- **未签名**：SmartScreen 会拦第一次运行，点「更多信息」→「仍要运行」。
- **运行时未在本机验证过**：构建机是无桌面会话的 shell，Electron GUI 起不来。
  包体结构、`home\profiles\desktop` 的 manifest 与插件文件都已逐一核对，
  但「双击后看到状态条」这一步需要你在本机确认。
- **zip 内路径分隔符是反斜杠**（PowerShell `Compress-Archive` 的行为）。
  Windows 资源管理器解压正常；用 7-Zip / Linux `unzip` 解会提示路径分隔符警告，内容不受影响。

## 校验

```
sha256: 7c799bc8c4bb7368f94277cfed33387f0dc52fd69c752dd089a79e9c80bd5b91
```

## 这个包是怎么来的

`dsh-webops-plugin` 是 out-of-tree 插件，打包态桌面端装插件只能走 UI 插件管理器，
CLI 没有任何「预装」入口。所以这里按官方 `project-manager.ts:604 createPluginProject`
的模板手工物化了 `home\profiles\desktop\`，让桌面端启动时认为插件本来就是装好的
（`applyRelease()` 状态自洽时不会重装）。

dsh 本体来自 `deepseek-harness` 的 `pnpm run package:win:x64:dir --unsigned`，
产物是 `win-unpacked` 目录（即便携形态，不是 NSIS 安装器）。
