# dsh 桌面端便携版 —— 发版存档

> **v0.1.0 的 zip 是本机手打的**；自 `desktop-v0.2.0` 起 Release 说明由
> `.github/workflows/release-desktop.yml` 在 CI 里内联生成（含当场算出的 SHA-256 与体积）。
> 下面 v0.1.0 一节是历史存档，**v0.2.0 一节是重发后的验证结论**，留作后续发版的对照基线。

---


---

## v0.2.6（2026-09-17 本机手打，未上 CI）

**包里变了什么**：全部工具更名 `browser_*` → `webpage_*`（15 个：open / navigate / snapshot /
find / locate / click / fill / press / scroll / wait / screenshot / console / network / execute /
tabs）。动机：`browser_` 让 agent 以为要「调用浏览器软件」而不是「操作网页」，实践中反复产生
误会。选 `webpage_` 而不是 `web_`：dsh 内置已有 `web_search` / `web_fetch`，`web_` 会撞车；
`webpage_` 与状态条文案「网页操作」同语义。客户端半边按前缀认领工具的逻辑（`BROWSER_TOOL_PREFIX`）
同步改为 `webpage_`，状态条观察不受影响。**错误码仍是 `BROWSER_*`**（协议不变量，不随工具名走）。
上一版的上下文预算硬化全部随包携带。

| 项 | 值 |
|---|---|
| 产物 | `dist/dsh-webops-desktop-v0.2.6-win-x64-portable.zip` |
| 体积 | 250.0 MB / 10469 个条目 |
| sha256 | `612331a584db97fc5c10807e429d3170d39d2150e45e505a9e2bc1b50a7d4a6b` |

**验证**（解压到 `D:\dsh-v0.2.6-verify`，10358 个文件 / 0 个 NUL 污染）：

| 自检 | 结论 |
|---|---|
| `verify:portable --dir` | 全部通过 |
| `verify:settings --dir` | 通过（unisound / u2-flash） |
| `verify:ptc --dir` | 通过（Electron 运行时下 sandbox runner 用包内真 node） |
| `verify:browser-host --dir` | 通过（真开窗口 → 快照 → 截图） |
| 工具名抽查 | 包内 15 个工具全部 `webpage_*`，0 处 `browser_` 残留 |

**迁移注意**：引用过旧工具名的自定义提示词要同步改名；dsh 无内置 `browser_*` 工具，改名无冲突。

---

## v0.2.5（2026-09-17 本机手打，未上 CI；当晚重打一次，见下）

**包里变了什么**：结构性修掉「模型看不见新标签页」这个盲区（`browser_click` 等 mutation
回执新增 `opened_tabs`），加上上一轮的窗口空白修复（`layout()` 守卫 + `restore/show` 补跑）
与 `browser_click` 描述同步。链路与验证见 `docs/实现与踩坑.md`「窗口空白」那一节。

**2026-09-17 晚重打**（同名 v0.2.5，sha256 见下）：包进上下文预算硬化
（commit `f2d0e1a`）—— `limit` 硬上限 500→150、console/network 各加 4 万字符总量闸门、
base64 正文上限单独压到 2000、新增 `truncated_by_budget` 且两类截断给**不同**建议。
`app/` 本体没变，只有插件 overlay 换了。打包时 `Compress-Archive` 被火绒扫描句柄挡住，
退化到 `scripts/zip-stage.py`（共享读）压完。

| 项 | 值 |
|---|---|
| 产物 | `dist/dsh-webops-desktop-v0.2.5-win-x64-portable.zip` |
| 体积 | 250.4 MB / 12497 个条目（10358 文件 + 2139 目录） |
| sha256 | `146330e118ee4a723566ead9e581926811e32221c7857d1db6dd3d0f047370e8` |

**验证**（解压到 `D:\dsh-v0.2.5-verify2`，10358 个文件 / 0 个 NUL 污染）：

| 自检 | 结论 |
|---|---|
| `verify:portable --dir` | 全部通过（含窗口标题、`layout()` 守卫与 restore/show 钩子、asar 内四处注入的源码级断言） |
| `verify:ptc --dir` | 通过（真跑 PTC，Electron 运行时下 sandbox runner 用的是包内真 node） |
| `verify:settings --dir` | 通过（出厂配置注册 unisound，默认模型 unisound/u2-flash） |
| `verify:browser-host --dir` | 通过（包内产物在打包 exe 上开真窗口 → 快照 → 截图 27705 字节） |
| 插件内容抽查 | 包内 `lib/tool-browser/index.js` 含 `1-150`、`truncated_by_budget` 与两条新建议措辞（确认本次硬化真进了包） |

**仍未覆盖**：模型真的调 `browser_open`（要 API key）、窗口外观与「双击后的状态条」（要人眼）。

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

#### 坑：「配置随包走」原本只能靠启动脚本（v0.2.2 补上）

`resolveDshHome()`（`@deepseek-ai/dsh-home-paths/lib/index.js`）的取值优先级是
**显式参数 → `$DSH_HOME` → `~/.dsh`**，**没有**「exe 旁边有 `home\` 就用它」这种便携兜底。
于是 v0.1.0–v0.2.1 的包只有一条路能拿到包内配置：双击 `启动.cmd`（它 `set "DSH_HOME=%ROOT%home"`）。
直接点 `app\<exe>` 会落回 `C:\Users\<你>\.dsh` —— 界面照常起来，**插件却不在生效的 profile 里**，
症状是「状态条不见了」，不报任何错。

v0.2.2 起 harness 补丁在 `main.ts` **顶层**（早于任何 `resolveDesktopPaths()`，全仓只在
`main()` 里调用它）补了便携兜底：

```ts
if ((process.env.DSH_HOME ?? '').trim() === '') {
  const portableHome = resolvePortableDshHome(process.execPath)   // <exe 上一级>\home
  if (portableHome !== undefined) process.env.DSH_HOME = portableHome
}
```

判定抽成 `paths.ts` 的 `resolvePortableDshHome(executablePath)` 导出 —— 不是为了好看，抽出来
才能被 `verify:portable` 拿**真代码**在真解压目录上正反两向验证（命中 `<root>\home` / 没有兄弟
`home\` 时必须返回 `undefined`）。两条断言各自都验过能转红（把 `home\` 改名即 ✗）。

只兜底空值：`启动.cmd`、`scripts/dev-desktop.mjs`、CI 的显式 `$DSH_HOME` 永远优先。
`启动.cmd` 继续保留 —— 它把这件事写死成显式动作，不依赖 exe 的摆放位置，两条路等价。

> 已知边界：Electron 自己的 `userData`（渲染缓存、Local Storage）仍在 `%APPDATA%\<productName>`，
> harness 不调 `app.setPath('userData')`，所以那部分不随包走 —— 不影响配置与插件，但「整个目录
> 拷到 U 盘」的便携程度以 `home\` 为界。

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
>
> （这条只对 v0.1.0–v0.2.1 成立。v0.2.2 起两种启动方式等价，见上面「配置随包走」那节。）

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
