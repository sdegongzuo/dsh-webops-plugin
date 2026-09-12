# dsh-browser-plugin

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加**浏览器调试与操作**能力的插件。
能力形态对齐 [Minke](https://github.com/lencx/minke) 的 Agent Browser：模型可以打开页面、读取页面大纲、
按 ref 定位并操作元素、采集控制台与网络活动，并支持人工接管。

这是一个 **out-of-tree bundle**：不修改 deepseek-harness 仓库的任何文件，靠自己的 `cordis.patch.yml`
把插件行插进目标 profile。

> 完整设计（Minke 能力基线、dsh 插件机制、分阶段落地、风险与备选方案）见
> `D:\dev\cli\deepseek-harness\.workbuddy\design-browser-plugin.md`。

---

## 状态

**P0（只读）进行中。** 目标：模型能「看」页面。

| 阶段 | 内容 |
|---|---|
| **P0 只读** ← 当前 | `ctx.browser` + `browser-cdp` 的 connect / open / snapshot / screenshot + 4 个只读工具 |
| P1 操作 | click / fill / press / scroll / wait + ref 纪元 + `stale_ref` 恢复 |
| P2 调试 | console / network 采集 + 受限 `browser_execute` + 进度策略 |
| P3 协作 | 人工接管 / 回收 + `browser_find` / `browser_locate` + UI 渲染 |

## 结构

```
cordis.patch.yml        bundle 的配置层：把三行插进 profile（见下）
package.json            声明 dsh.bundle.patch；多入口导出
src/browser/            Service Definition —— ctx.browser 服务、provider 选择语义、错误类型
src/browser-cdp/        provider —— 通过 CDP 驱动浏览器
src/tool-browser/       工具消费者 —— 把能力暴露成 browser_* 工具给模型
```

为什么不分三个包：官方把能力拆成 `<capability>` / provider / `tool-<cap>` 三包，是为「能力可组合」
（换 provider 不用换工具层）。个人插件不需要这份弹性，单包多入口即可。

## 接进 dsh

### 为什么做成独立仓

| 证据 | 内容 |
|---|---|
| `CONTRIBUTING.md` | 「we cannot accept external pull requests at the moment」——官方现阶段**不收外部 PR** |
| GitHub API | 当前账号对 `deepseek-ai/deepseek-harness` 的权限是 `push: false` |
| `CONTRIBUTING.md` | 官方明确鼓励社区插件：独立建仓 + 给项目打 **`dsh-plugin`** topic 供他人发现 |

往官方仓库 `packages/` 里加代码，只会沉淀成一份永远无法提交的本地工作区——而
`packages/bundle/*/cordis.patch.yml` 与 preset 恰恰是上游每次 release 都会改动的文件，下轮拉取必冲突。

### 开发期（推荐）

官方 `docs/user/develop/basic/publish.md` 推荐的做法：**让插件目录出现在 dsh 源码 checkout 的根目录**，
命令统一用 `pnpm dsh ...` 跑，这样 Node 会向上解析到 dsh 自己的 `node_modules`（本地 workspace 链接、
版本 0.1.5-rc.2），而不是去 npm 拉旧版。

本仓位于 `D:\dev\cli\dsh-browser-plugin`，用一个**目录联接（junction）**把它挂进 checkout 即可，
不需要管理员权限、也不移动代码：

```cmd
mklink /J D:\dev\cli\deepseek-harness\dsh-browser-plugin D:\dev\cli\dsh-browser-plugin
```

再把它排除出 dsh 的 git status（`.git/info/exclude` 是本地文件，**不要动仓库的 `.gitignore`**）：

```gitignore
# .git/info/exclude
/dsh-browser-plugin
```

然后从 dsh 根目录验证层序：

```bash
cd /d/dev/cli/deepseek-harness
pnpm dsh --profile web --dump-config | grep -A2 -E "browser|tool-browser"
```

### 生产期

```sh
dsh plugin --profile <name> add D:\dev\cli\dsh-browser-plugin   # 本地目录
dsh plugin --profile <name> add github:sdegongzuo/dsh-browser-plugin#<sha>  # git（需 prepare + allowBuilds）
```

> git 安装需要本仓提供 self-contained 的 `prepare` 脚本，且用户要在 profile 的 `pnpm-workspace.yaml`
> 里 `allowBuilds: { dsh-browser-plugin: true }`。详见官方 `publish.md`。**待 P0 期间实测**。

## 依赖版本约束（重要）

| 包 | npm 上 | 本地 checkout |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.2 ✓ | 4.0.2 |
| `@deepseek-ai/dsh-tools` | **0.0.1-rc.1** | 0.1.5-rc.2 |
| `@deepseek-ai/dsh-subprocess` | **0.0.1-rc.1** | 0.1.5-rc.2 |

除了 cordis，**dsh 自己的包在 npm 上落后 5 个 minor，类型与接口都对不上**。
所以 `package.json` 把 dsh 包写成 `peerDependencies: "*"`，并用 `.npmrc` 关掉 `auto-install-peers`，
强制走本地 link。**不要**把它们改成 npm 版本号。

## 接线：全部落在 host 平面

`cordis.patch.yml` 的 `insert` 里有三行，都在 host 平面：

| 行 | 说明 |
|---|---|
| `browser` | `ctx.browser` 能力服务，跨会话共享，不能按 preset 分叉 |
| `browser-cdp` | provider，注册进 `ctx.browser` |
| `tool-browser` | 模型可见的工具 |

依据：host 平面的行在**所有** surface（TUI / headless / web / 桌面端）都会生效，除非该 surface 的 overlay
显式 `disabled: true`——这正是 `dsh-web-app` 必须写下 `disabled: true` 才能压掉 `tool-web` 的原因。

> **待 P0 实测**：host 平面 insert 的 `tool-browser` 在 `--profile web` / 桌面端下是否真对 agent 可见。
> 上面的推断来自 `dsh-web-app` 的注释（「a row absent from a surface overlay would silently reappear」），
> 是强线索但不是保证。若不生效，退路是把该行搬进 `$DSH_HOME/.agent-presets/<preset>/agent.cordis.yml`
>（preset 是用户资产，可写）。

**patch 语义**：命中某一行时是**整块替换 config**（非深合并），所以覆盖时要重述该行的所有 config 键。

## 实现指引（P0）

参照 dsh 仓库里的这些文件，别从零设计：

| 要做的事 | 照抄哪个 |
|---|---|
| Service Definition | `packages/web/web/src/index.ts` |
| provider 注册与选择语义 | `packages/web/web-fetch-http/src/` |
| 工具注册写法 | `packages/web/tool-web/src/search.ts` |
| 工具定义 API | `defineTool`，见 `packages/core/tools/src/schema.ts` |
| 截图落盘 | `ctx.attachments.saveImage({ data, mediaType })` |
| 起浏览器进程 | `ctx.subprocess`（`super(ctx, 'subprocess')`），**不要裸用 `child_process`** |
| 地址策略（只允许公网 HTTP(S)） | `packages/web/web-fetch-http/src/policy.ts` + `network.ts` |
| 系统提示分段 | `packages/core/system-prompt/src/index.ts` 的 `SECTION_ORDERS` |

两条硬约束：

- **`SECTION_ORDERS` 是中央封闭注册表**，外部插件加不了键，只能给 `section({ order: <number> })`
  传显式数字。建议 `2050`（紧挨 `TOOL_WEB_SEARCH: 2000` / `TOOL_WEB_FETCH: 2100`）。
- **注册即 effect**：所有贡献走 `ctx.effect()` / `ctx.on()`，`register()` 返回 disposer。

P0 的 provider 走「用户自己开着的 Chrome + 对接调试端口」这一形态：最贴近「调试」语义，
且完全绕开 Playwright 自带 Chromium 的下载与 `allowBuilds` 授权问题。

## 验证（P0 验收）

1. `pnpm dsh --profile web --dump-config` 能看到三行，层序正确。
2. 起一个带调试端口的 Chrome，跑通 open → snapshot → screenshot。
3. `browser_screenshot` 的图片在会话里以 attachment 引用出现。
4. 导航后使用旧 ref 必须拿到 `stale_ref`，而不是静默点错元素。
5. 关会话后浏览器进程树确实回收，无残留。

## 开发

```bash
pnpm install       # 只装工具链（typescript / vitest）；dsh 包靠 link
pnpm typecheck     # 需要先完成上面的 junction 步骤，否则找不到 dsh 类型
pnpm test
```

## License

MIT
