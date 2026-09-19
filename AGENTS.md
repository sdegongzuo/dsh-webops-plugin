# AGENTS.md — 本项目的做事规则

规则手册，不是待办清单。历史坑速查：`.workbuddy/memory/MEMORY.md`、`docs/实现与踩坑.md`；
打包/发版/自检的命令与原理：`docs/打包与发版.md`。新增文档前先看这两处有没有覆盖，
别造第二份真相。

---

## 语言与沟通

- 全中文：文档、注释、提交说明、lint 提示，一律中文。
- 结论先行，然后给证据：具体路径、行号、命令、对照表。不写「好问题」「我很乐意」这类铺垫。
- 汇报失败要给完整链路：哪一步失败、原文报错、根因、怎么修、修完怎么验证。

## 动手之前

- 先 `git status`。本仓库有并行会话在改（代码、文档、乃至 `.workbuddy/memory/MEMORY.md` 都会被并行整理），
  判断「某功能有没有实现」前先看 mtime 与 `git status`，别拿旧认知当现状。
- 改配置/脚本后必须做回归验证 —— 改 A 顺手弄坏 B 是最没品的失误。
- 破坏性操作（删文件、杀进程、强推、reset）先确认；结束后要报备改了/杀了什么。
- 引用他人（或 agent）报告的数字与行号前，回源码核对其语义。

## 本机路径：一律走 `.env.local`（2026-09-19 定）

**脚本里不许出现写死的本机绝对路径。** 所有本机目录（harness 源码根、打包大件根、固定测试目录、
Electron 可执行文件）统一经 `scripts/local-env.mjs` 取；值写在仓库根的 **`.env.local`**
（**已进 `.gitignore`，不要提交**；模板 `.env.local.example` 入库）。原因很实际：以前这些路径散在
7 个脚本里，换机器/换盘要满地改，**漏一处就会安静地跑一个不存在的目录**。

三条语义（动 `local-env.mjs` 前先读它的文件头）：

1. **文件只提供默认值** —— 命令行前缀（`FOO=bar node scripts/x.mjs`）优先级更高，临时换目录不用改文件。
2. **文件不存在不是错误**。CI 没有它，靠 workflow 显式传值。
3. **缺键要报得可操作**：说清缺哪个键、去哪加、示例长什么样。**绝不静默退回某个 `D:` 盘默认值** ——
   静默的默认值会把「没配」伪装成「配好了」，这正是要根除的东西。

加新键**三处同步**（漏一处就会出现「配了不生效」或「不配也能跑」）：`local-env.mjs` 的
`KNOWN_KEYS` → `.env.local.example` → 本节。

排查「我配了怎么没生效」：`pnpm portable:env` 打每个键的**来源**（文件 / 环境 / 未设）。

例外（**别跟着改**）：文档里的举例、以及**给终端用户的占位路径** —— 例如更新包说明里的
`Expand-Archive … -DestinationPath D:\dsh-webops`，那是用户自己的解压目录，不是本机配置。

## 本地真机测试：固定目录（2026-09-19 起按这个来）

以前每轮真机测试都解压一份新整包（1.2G），测完就扔。现在固定一个目录
（`DSH_PORTABLE_TEST_DIR`，本机 `D:/dsh-build/portable-test`）：**一次铺底，此后只做增量覆盖**。

| 场景 | 命令 | 动了什么 |
| --- | --- | --- |
| 只改了插件代码 | `pnpm portable:refresh` | build → 打增量包 → **只覆盖插件那一层**（~10s） |
| 重编了桌面端（harness `main.ts` 等） | `pnpm harness:build` → `pnpm portable:set-app --from <win-unpacked>` | 编译 harness（见下「本机环境」的镜像说明）+ **只换 `app/`** |
| 看现状 | `pnpm portable:status` | 只读 |
| 真机自检（三轮起宿主） | `pnpm portable:verify` | 只读，不动目录 |
| 起 GUI（要 CDP 就加 `--cdp 9333`） | `pnpm portable:launch` | 只启动 |

- `set-app` 不给 `--from` 就从 `<BUILD_ROOT>/.desktop-base` 挑**版本最高且可用**的槽（判据：
  有 `cache.json` + 真是一份完整 win-unpacked）；`--move` 让同盘改名瞬时完成（但会**搬走**构建产物，
  想留着 win-unpacked 就别加）。
- **`refresh` 和 `set-app` 对「实例在不在跑」的要求不同**（2026-09-19 实测）：

  | 命令 | 换的是 | 要不要先停实例 | 为什么 |
  | --- | --- | --- | --- |
  | `portable:refresh` | 插件那一层（`home/.../dsh-webops-plugin/`） | **不用** | 跑着的实例**不持有**插件任何 `lib/*.js`（`who-locks.ps1` 报全部 `(无持有者)`）。实测**连着两次不杀直接 refresh 都成功**，PID 不变、实例照活 |
  | `portable:set-app` | `app/`（含主 exe 与 `app.asar`） | **必须** | 那两个文件被运行中的实例占着 → 删旧 `app/` 报 `EBUSY` |

  ⚠️ 但 **refresh 完必须重启实例，新代码才生效**：宿主在**启动时**就把插件清单/模块读进内存了。
  实测塞一个探针进 `package.json` 的 `description`、refresh 完**不重启**去读插件页 —— 显示的仍是**旧文案**。
  （所以「不用停」只省一次操作，不等于「能热更新」。）
  另一个**未实测**的风险：refresh 后若在旧实例里手动重载渲染进程（Ctrl+R），客户端 bundle 可能与宿主里的旧插件版本对不上 —— 别这么干，直接重启。
- ⚠️ **`set-app` 前必须先关掉那个目录里的桌面端**，否则删旧 `app/` 报
  `EBUSY: resource busy or locked, rmdir '…\portable-test\app'`。`portable:launch` 走 WMI 起的进程
  是**故意脱离 job 存活**的，所以它会一直在 —— 先找再杀（`tasklist | grep -i deepseek`，
  或按端口查：19387 是 dsh 宿主、CDP 端口是你自己传的），然后
  `MSYS_NO_PATHCONV=1 taskkill /PID <父PID> /T /F`。注意 Git Bash 里 `taskkill //PID` 可能被原样传下去
  而报 `Invalid argument/option - '//PID'`，要么带 `MSYS_NO_PATHCONV=1`，要么用 PowerShell 工具。
- ✅ **这个目录可以喂 `verify:portable`，而且会全绿**（2026-09-19 实测；早先两句「必挂 / 会假红」都已证伪）：
  ①「启动过的目录必报 `refusing to replace unowned package @deepseek-ai/cordis` + `Cannot find
  package 'js-yaml'`」—— 0.1.6-alpha.2 起上游把 link 模式**整套退役**、宿主包改由运行时目录直接
  供给（profile 里**不建链**），所以那套连锁报错不会发生；
  ② 那条 `profile 里没有越权 overlay` 原先**只看文件在不在**，而宿主首次启动会在 profile 根写两个
  **出厂空模板** `cordis.yml` / `cordis.patch.yml`（内容只有注释 + `[]`）→ 对复用过的目录**恒红**。
  已改成**按内容判**（`isStockEmptyPatch`：空模板放行，**有内容的 patch 照样红**，反向验证过）。
  → **结论：一个固定目录就够，别为自检再解压第二份 1.2G。**
- 目录必须在**工作区外**：工作区内的 `app.asar` 被 IDE 持句柄 → 删不掉、改不了名（见下「本机环境」）。

## 自检纪律（每条都栽过）

- **自检通过 ≠ 可发版**。四道自检只证「包结构 + 生产链」，证不了状态条可见 / 模型真回话 / 真去调工具。
  没在真机点过一遍，别提发版。
- **只在打包态复现的 bug，自检必须跑打包态运行时**；开发态跑绿不算数。
- **新断言必须反向验证**：故意改坏一处，确认 `exit=1`，再改回并复验绿。装饰性的断言等于没有。
- **判「开发态脚本设的变量 → 打包态必然 bug」**：翻 `scripts/dev-desktop.mjs` 的每行 `environment.X`，
  问「`main.ts` 顶层兜底在不在」。修法一律落 `main.ts` 的判空兜底，**不能只写 `启动.cmd`**
  （已踩 `ELECTRON_RUN_AS_NODE` / `DSH_PTC_NODE` / `DSH_BROWSER_PROVIDER`）。
- **写 AX 树夹具必须照实测画**，别凭想象；live 组（`DSH_CDP_ENDPOINT` + 无头 Chrome）是形状契约唯一防线。
- **比 bundle 字节前先剥 `&rev=`**：`sourceMappingURL=...&rev=<每次启动现生成>` 每次都变，
  不剥就证明不了任何事（同一份代码连起两次也不一样）。
- **起宿主类自检前，先确认 19387 没被别的 dsh 实例占着**。端口写死在
  `apps/desktop-host/src/index.ts:24`；被占时表现是 `N required plugins did not activate`
  （webserver `EADDRINUSE` → 一串插件等它的服务），**极易误判成包坏了**。
  这条已内建：`scripts/run-packaged-host.mjs` 的 `assertHostPortFree()` 在所有起宿主的自检之前跑，
  用 `netstat -ano` 的 LISTENING 行查占用者并给出 `taskkill /PID …`，还带 5s 重试窗口
  （上一个宿主刚停、端口未释放属正常）。**自己写端口探测不要用「bind 127.0.0.1」**——
  Windows 上会假阴性，要 `listen(port)` 不带 host，或者直接查 netstat。
  真要人肉诊断跑 `verify-portable`（会打 `Failed plugins / Plugins waiting for services` 明细）。

## 打包与发版

- 本体不必每次重编，但 **zip 每次要重打**：`app/`（解压 1.2G）只在升级 dsh 时重建，插件侧真变化
  只有 overlay 的几百 KB，却要重新压缩 + 上传 + 用户重下 —— 所以日常更新走下面的增量包。
- **本体缓存按 dsh 版本分槽**：`.desktop-base/<版本>/app`，槽位里**必须**有一份 `cache.json`
  完成标记才算数（拷贝中断会留下「文件看着都在、其实少了几个」的目录，顶层完整性断言拦不住）。
  不带 `--app` 跑就自动挑版本最高且四项校验全过的槽；选不出就明确报错，**绝不静默降级**。
  入库**不许用「拷到 `.new` 再改名」**：本机安全软件给每个新 `app.asar` 挂独占句柄，
  而 Windows 不允许改名含此种句柄的目录 → 恒 `EPERM`。要改就改 `installBaseCache`，
  保持「无需改名/删除」的写路径（`mkdir` → `cpSync` → 校验 → 写标记）。
- **插件更新走增量包**：`scripts/package-plugin-update.mjs`（npm 别名 `package:plugin-update`）→
  约 159KB 的 overlay zip，用户解压到便携包根目录覆盖即生效（启动时 `applyRelease()` 不跑包管理器、
  不联网校验版本，`initProfile()` 是「不存在才写」，实测无 bundle 缓存）。自检 `scripts/verify-plugin-update.mjs`
  （`--in-place` 走真实 `Expand-Archive` 覆盖并断言 home 数据 byte-for-byte 不变）。
  ⚠️ **两个打包脚本的覆盖策略相反**（2026-09-19 review）：`package-plugin-update` 对已存在的
  `--out` **默认拒绝**（exit 1，防误冲验证过的更新包），加 `--force` 才删旧重写；
  `package-desktop-portable` 则直接删旧覆盖（5 分钟的大件，重跑即覆盖）。
  **别裸敲 `node scripts/package-desktop-portable.mjs`** —— 有别名 `package:desktop`；
  同理注意 `package:portable`（纯插件 zip，给 `dsh plugin add` 用）与 `portable:*`
  （固定测试目录操作）是**两个不同前缀**，别混。`portable-dev clean` 的别名是 `portable:clean`。
  **CI 验不了它的生效性**（需要一个已解压的完整便携版才能真正起宿主三轮），
  所以推 tag 前**必须本地对一份真实便携版跑过它**。
- **增量包默认不动 `home/profiles/desktop/package.json`**：那份是用户的，可能登记了他自己装的插件。
  插件版本号与 bundle 判定都读插件自身目录（`packages/boot/app-boot/src/profile-plugins.ts:64-77`），
  所以不动它没有任何代价。
- 改 `packages/*` 必须先 `build:lib:host`，否则打出来的是旧 lib（且不会报错）。
- 出货 patch 只留两条（`install --prod` 去 `--frozen-lockfile`、跳过 `checkFsExt()`），
  **绝不能含 fake-llm** —— 它会接管 `llm/stream`，把真实对话换成假回放。
- 打 zip 前先 `testzip()` 验 zip、解压后验前 32 字节无 NUL；解压固定用 `scripts/unzip-portable.py`。
- **发版版本显式传**：`--version`（整包）/ `--version`（增量包）一律取自 tag，不靠 `package.json` 兜底。
  两个 workflow 第一步都断言 **tag 版本 == `package.json` 的 version**，不一致直接失败 ——
  因为 `--version` 同时决定 zip 名、profile 里登记的插件版本、随包插件 `package.json` 的 version，
  不一致不会报错，只会产出一个「自称新版本、里面是旧版本」的包。
- **取产物文件按确定的文件名取**，不用 `Get-ChildItem dist/*.zip | Select-Object -First 1`：
  `dist/` 里同时躺着三种 zip，`-First 1` 取到哪个看目录枚举顺序，sha256 会贴到别的文件上而附件是对的。
  同理找 win-unpacked 要 `Sort-Object LastWriteTime -Descending` 取最新，不要 `-First 1`。
- 三种 zip 的分工（整包 / 插件便携包 / 增量包）见 `docs/打包与发版.md` §10，别混。
- 重指已发布的 tag：删 release + tag → 新提交重打 → push，别原地覆盖。

## 代码

- **绝不用正则批量改字符串字面量的引号**：会把反引号塞进别的字符串内部 —— 语法、tsc、测试全绿，
  但回执里 `session_id`/`url` 变成字面量 `${...}`。逐处 Edit，并补「断言输出文本完整内容」的测试。
- **同一个文件不要并行发多个 Edit**：工具会返回「Successfully edited」但**改动会被悄悄吞掉**
  （2026-09-19 同一轮里连丢三处：常量声明、函数调用参数、错误分支）。改同一文件必须逐个 Edit，
  改完立刻 `grep` 复核关键标识确实在位，再往下走。
- 打包态 `process.execPath` 是主 exe，不是 node。`DSH_DESKTOP_` 前缀会被 `host-process.ts:119` 过滤，
  自定义变量只能用其它 `DSH_*`。
- 判断运行时布局与解析模式是两件事：布局看有没有 `resources/dsh`，解析模式看 `main.ts` 里有没有
  `profileResolution: 'runtime'`。找运行时目录统一走 `scripts/desktop-runtime.mjs`。
- 新增/修改 `scripts/*.mjs` 时保持自足：能独立跑（`node scripts/xxx.mjs --dir ...`），
  参数缺省给可读用法提示，失败给 `exit=1`。**本机绝对路径不放脚本里** —— 一律经
  `scripts/local-env.mjs` 取（见上面「本机路径」一节）。

## 本机环境（都不进生产，但会浪费半天）

- `shell env` 自带 `ELECTRON_RUN_AS_NODE=1`，起桌面端前先 `env -u`。
- harness 的 `tsx` 只在**仓库根** `node_modules/.bin/tsx`，且要用
  `<node.exe> <harness>/node_modules/tsx/dist/cli.mjs <script>` 的形式跑：
  传 `/d/dev/...` 会被 MSYS 转成 `D:\d\dev\...` 而 `MODULE_NOT_FOUND`。
  直接用 tsx 入口也顺带**绕开 `pnpm run` 的隐式 install**（白加约 10 分钟）。
- `package-target.ts` 要求 `process.env.npm_execpath` 非空（否则报
  「invoke this script through a pnpm package command」）；设成 pnpm 的 `pnpm.mjs` 即可绕过 pnpm run。
- `prepare:runtime` 下载 Electron 必须带代理：
  `ELECTRON_GET_USE_PROXY=true HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890`
  （本机 7890 在监听但没进环境变量；`%LOCALAPPDATA%\electron\Cache` 里那几个 hash 目录不含目标版本，别指望命中）。
  **优先改用镜像**（见下条，不必开代理）。
- **本机重编桌面端一律走 `pnpm harness:build`**（2026-09-19 实测：直跑 `package:win:x64:dir` 必挂，
  而且是**先跑 20 分钟再挂**）。两处坑都是「上游写死 + 本机网速」，`scripts/harness-build.mjs` 已挡掉：
  1. **registry 被上游硬编码成 npmjs.org**（`apps/desktop/scripts/prepare-dsh.ts:77,89`），而且该脚本
     主动剥掉子进程里所有 `npm_*`/`pnpm_*` 变量、把 `--config.userconfig` 指向一个空文件
     → **`~/.npmrc` 里配的镜像完全无效，环境变量也注不进去**，只能临时改文件。
     本机直连 npmjs 只有 **11–31 KB/s**（实测 `node-pty` 7.15MB 要 ~10 分钟），而它每轮用 `mkdtemp`
     新建 BUILD_ROOT（pnpm store 就在里面）→ **store 每轮都是冷的** → 大包必然撞 pnpm 的 60s
     `fetch-timeout`，报 `[23] The operation was aborted due to timeout`。
     换 npmmirror（`DSH_NPM_REGISTRY`）实测 **1.8–2.5 MB/s（约 100 倍）**。
     产物不受影响：pnpm 按 lockfile 校验 `integrity`，镜像有出入会直接失败，不会静默换包。
  2. **`prepare:runtime` 要下 157MB 的 `electron-v<版本>-win32-x64.zip`**，直连 GitHub 实测
     `TypeError: fetch failed`。设 `ELECTRON_MIRROR`（`DSH_ELECTRON_MIRROR`）指 npmmirror 的
     electron 镜像即可（URL 形如 `<镜像><版本>/electron-v<版本>-win32-x64.zip`）。
  ⚠️ 该脚本会**临时替换** `prepare-dsh.ts` 再**无条件还原** —— 它是
  `docs/harness-desktop-build.patch` 的目标文件，替换残留会随补丁出货到 CI。所以还原带 sha256 自证
  （不一致 → 非 0 退出 + 打出备份路径）。自测用 `pnpm harness:build --dry-run`（只演练替换/还原）。
  两个镜像值都在 `.env.local`。
- 火绒按 exe 路径放行：新目录里的副本出不去网（看着像包坏）。换目录先用
  `ELECTRON_RUN_AS_NODE=1 <exe> D:/Temp/net-check2.mjs` 验出网。
- `app.asar` 的独占句柄有三条后果，全都实测过（2026-09-18/19）：① 删除报 `EBUSY`；
  ② **改名报 `EPERM`，连它所在目录一起改名也报 `EPERM`**（Windows 不允许改名含
  无 `FILE_SHARE_DELETE` 句柄文件的目录）；③ **共享读和原地位写都通畅** ——
  所以 `Compress-Archive` 失败时退化用 `scripts/zip-stage.py`（走共享读）能照常压完，
  而任何「先拷到暂存名再改名」的写路径在本机必然失败。
- **锁的真凶是 IDE，不是杀毒软件**（2026-09-19 实测纠正 —— 此前一直误记成「常驻安全软件套件
  给每个新出现的 `app.asar` 挂独占句柄」）。用 Windows Restart Manager（`rstrtmgr.dll` 的
  `RmRegisterResources` + `RmGetList`）点名持有者，拿到的是 **`WorkBuddy.exe`（PID 22952）**
  和 **`Qoder CN`（PID 19880）** —— 五个杀软进程（火绒 `HipsDaemon`、`qaxdefender`、
  `MBAAntiVirus`、`MsMpEng`、`trantorAgent`）**一个都没出现**。
  点名工具已入库：`powershell -File scripts/who-locks.ps1 -Path '<glob>' [-OutFile <路径>]`
  （本机 PowerShell 工具 stdout 恒为空，所以要 `-OutFile` 落盘再读）。
  ⚠️ 语义：**「被列出来」≠「它阻止了删除」** —— Restart Manager 报的是所有持有句柄的进程，
  不管共享模式；真正锁死的是**不带 `FILE_SHARE_DELETE`** 那个。
- **触发条件（对照实验：6 组文件 × 180 秒逐秒探测 + 全量扫描）**：只有**工作区内**、且
  **内容真能被解析成 asar 归档**的 `.asar` 会被锁。
  · 工作区**外**（`D:\tmp-lockprobe-*`）：6 个文件（app.asar 的内容换个后缀叫
    `.asar`/`.zip`/`.bin`/`.asar.new` + 2 个全零文件）**180 秒全程未锁**，Restart Manager
    也报「无持有者」。
  · 工作区**内**：`probe.asar`（装的是 app.asar 内容）**第 2 秒起 `EBUSY`**、180 秒不解；
    而 `probe.zip` / `probe.bin` / `probe.asar.new`（同内容、换后缀）和 **`zeros.asar`**
    （.asar 后缀但内容是 2.7MB 全零、解析不成归档）—— **全部未锁**。
  · 全量扫描：工作区内 40 个 `.asar` **锁住 39 个**，唯一没锁的就是那个 `zeros.asar`。
  → 机制：VS Code 系 IDE 把 asar 当**可解析的归档格式**，会去**打开并解析**工作区里的归档；
  打开用的句柄**不带 `FILE_SHARE_DELETE`**，**而且不释放**（跟 IDE 进程同生共死）。
  这也解释了「截断成 0 字节也不释放」：锁来自那个已经打开的 fd，跟内容校验无关。
- **锁是「异步加上、且不会自己松开」的**：刚复制出来的 `app.asar` 立刻可以改名，
  **2 秒后就被锁住**（IDE 的文件监视发现新文件 → 去解析它）；存量被锁文件已经挂了 5 天。
  所以别指望「等一等」或「清空内容」——`app.asar` 一旦被锁，本机就**永远**删不掉、改不了名。
  **推论**：任何「覆盖式更新同一个目录」的写路径都不要设计，要么换新目录，要么先算好能不能只做「加文件」。
- **绕法已经落地：把大件挪出工作区**（2026-09-19 实测通过）。本机写在 `.env.local` 的
  `DSH_DESKTOP_BUILD_ROOT` 里（模板 `.env.local.example`），**默认值不变**（仍是仓库根 ——
  CI 的 `actions/cache` 按相对路径缓存 `.desktop-base`，改默认会让缓存永远不命中）。
  临时换一次就带前缀：
  ```
  DSH_DESKTOP_BUILD_ROOT=<工作区外的目录> node scripts/package-desktop-portable.mjs
  DSH_DESKTOP_BUILD_ROOT=<工作区外的目录> node scripts/clean-build-residue.mjs --yes
  ```
  `.desktop-base` / `.desktop-stage` 会跟着搬过去，`probe-tool-concurrency.mjs` 也认这个变量。
  **实测结论**：工作区外的 4 个 asar（缓存槽 + 暂存目录，含正在被压缩的那个）
  锁住 **0/4**、Restart Manager 报无持有者；工作区内是 **39/40 锁住**。
  连收尾删暂存目录都干净了（工作区内那一步从来失败）。
  次选是把 `.desktop-*` 加进两个 IDE 的 `files.watcherExclude` / `search.exclude` / 索引排除 ——
  但**没验过**，而且要两个 IDE 都配。**不要**为了这个去改「不打包 asar」（那是上游 harness 的
  构建配置，代价远大于收益）。
- **残留目录只能「瘦身」，不能「删干净」**：跑 `node scripts/clean-build-residue.mjs --yes`
  会把每棵残留里**除那个被锁 `app.asar` 以外的一切**收回来，从 GB 级降到 MB 级
  （2026-09-19 实测：22 棵残留瘦身后按字节合计只剩 58.0MB，每棵基本就剩
  `resources/app.asar` + `resources/default_app.asar` 两个被锁文件）。
  想彻底清掉只能在**重启 IDE 后立刻**跑（趁它还没解析到这些 asar）。
  该脚本的 `.desktop-base` 是拆成子项处理的，且用「有 `cache.json` **或** `app/` 下真有主 exe」
  双判据保护本体缓存槽 —— 动它的目标收集逻辑前先想清楚「误判成该清 = 收走 1.2G 缓存」。
  脚本在 `--yes` 下会**自己关掉安全删除垫片并重跑**（见下条），所以直接跑就行，不用手动加前缀。
- 抓持有者别用 `tasklist //FO CSV` + grep（CSV 引号会骗过 grep），也别用
  `Get-CimInstance … CommandLine -like '*xxx*'` —— **你的过滤串本身就在自己进程的命令行里，会自匹配**。
- 本机的安全软件套件是常驻的：火绒 `HipsDaemon`、奇安信 `qaxdefender`、`MBAAntiVirus`、
  `sandbox-center`、`herdr`、`trantorAgent`。别指望能关，改设计绕开它们（见上面的缓存写路径）。
  ⚠️ 但**别把「asar 被锁」赖到它们头上** —— 见上面那条，真凶是 IDE。
- **安全删除垫片会把批量删除拖成「假卡死」**（2026-09-19 实测，必读）：
  `CODEBUDDY_SAFE_DELETE_ENABLED=1`（WorkBuddy CLI 经 `NODE_OPTIONS=--require=…node-language-shim.cjs`
  注入）时，**每个** `unlink` 要 **450ms** —— 同一批 30 个文件的对照：新建 0.5ms/个、
  读取 0.1ms/个、**删除 452ms/个**；置 `0` 后同一批 **0.4ms/个（1130 倍）**。
  于是删两万个文件要几小时，中途目标目录的文件数看着一动不动，极易误判成脚本卡死
  （我第一次就误判了，白查一轮）。**只有删除慢 → 是删除专属钩子，不是磁盘、不是杀软。**
  两个连带事实：① 垫片在 **require 期**读 env，进程内 `process.env.X='0'` **无效**
  （实测仍 470ms/个），只能换进程；② 它还会拦大目录 `rmSync`
  （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。  所以 `clean-build-residue.mjs --yes` 的做法是
  **`spawnSync` 自己、带上 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 重跑**（并打一行说明）。
  别的脚本内清理一律写成 best-effort 只告警。
- **垫片还有第二种表现：对「大目录」的 `rmSync({recursive})` 直接抛错，且 `error.code` 是空的**
  （2026-09-19 实测复现）：它把删除改成「丢回收站」，而回收站助手
  `resources/vendor/genie-trash/win32-x64.exe` **只有 5 秒超时**，1.2G 的暂存目录搬不完 →
  `Error: [safe-delete] 操作失败: spawnSync … ETIMEDOUT` —— **普通 `Error`，没有 `.code`**。
  所以任何 `（${error.code ?? ''}）` 这种日志都会打出一对空括号，看着像「莫名其妙的失败」，
  极易误判成文件被锁（我就误判了一轮）。**判据**：合成目录（3000 / 21000 个文件、600MB / 1.3G）
  都删得掉，只有「真实形态的 1.2G 暂存树」会挂 → 是**条目数 × 深度**撑爆那 5 秒。
  对策同前：换一个 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 的子进程删
  （`package-desktop-portable.mjs` 的 `removeTree()` 已内建）。
- PowerShell 工具输出恒为空：让 ps 把结果 `Out-File` 到仓库内临时文件，再用 Read 读，别反复试。
- Bash 的 `cat >>` 有重复执行现象：追加后 `grep -c` 确认份数；优先用 Edit 工具。
- 临时脚本放项目根、用相对导入（放 `D:/tmp` 会被当 CJS，ESM 拒绝 `D:/` scheme）。
- 截图在本会话不可用，产物截图让脚本写文件（`--out dist/x.png`）。

## 与并行会话共存

- 别人的未跟踪文件（如根目录 `.unpack-*`、`_tmp_*`、`docs/` 下新增文档）不要动、不要删、不要「顺手整理」。
- 改共享文件（`package.json`、`docs/交接-待办任务.md`、`cordis.patch.yml`）前先看现状，改完立刻复验。
- 需要新增文档时先找有没有同名职责的现存文档，避免造第二份真相。
