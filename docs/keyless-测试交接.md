# keyless（fake-llm）端到端测试 — 交接文档

> 交接日期：2026-09-13。读者：接手测试的 agent。本文自包含，无需前序会话上下文。

## 1. 这套测试在验什么

`dsh-webops-plugin` 的浏览器工具链（browser_open / snapshot / execute / find / click / tabs）在**真实网页**上跑通「弹窗转标签收编」全链路：

1. fake-llm（脚本回放，不花钱）驱动 agent 打开百度 → 读热搜榜 → **点击第五条**（target=_blank → 弹窗）
2. 宿主 host.cjs 把弹窗转成新标签（t2），dom-ready 后发 `{type:'opened'}` 通报
3. provider `adoptSession` 收编 t2 进会话注册表 → `browser_tabs list` 必须列出 `t2 [foreground]`
4. 在 t2 上读正文 → fake-llm 收尾轮从轨迹抽证据（第五条标题 / 详情页 URL / 正文摘录）拼成**可见回复**

## 2. 测试步骤（按顺序，一条别跳）

```bash
# ① 构建 + 单测（在 D:\dev\cli\dsh-webops-plugin）
pnpm run typecheck && pnpm test && pnpm run build

# ② 杀掉旧桌面端实例（如果有）——必须按端口找 PID，不能 taskkill /IM electron.exe
#    （屏幕上常有多个 electron 进程，按名字杀会误伤无关实例）
powershell: Get-NetTCPConnection -LocalPort 9222,9229,9230 -State Listen | 选出 OwningProcess → Stop-Process

# ③ 后台启动桌面端（bash）：
DSH_BROWSER_PLUGIN_DEBUG=1 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE pnpm run dev:desktop
#    （后台运行，记录任务 ID；日志在 <会话临时目录>/bg-tasks/<id>.stdout.log）

# ④ 等 renderer 调试端口就绪（最多 4 分钟）：
for i in $(seq 1 24); do curl -s --max-time 2 http://127.0.0.1:9222/json/version && break; sleep 10; done
#    就绪后再 sleep 15（等插件装配完成）

# ⑤ 跑端到端验证：
VERIFY_MESSAGE="打开百度，点击热搜榜第五条，读取详情内容" pnpm run verify:card
```

## 3. 判定标准（什么算 PASS）

verify:card 输出依次要看到：

```
verify-card: 工具卡片 browser_open → state=ok url=https://www.baidu.com/   ← URL 必须是 baidu
verify-card: 工具卡片 browser_snapshot → state=ok
verify-card: 工具卡片 browser_execute → state=ok
verify-card: 工具卡片 browser_find → state=ok                              ← 本轮应 >0 matches
verify-card: 工具卡片 browser_tabs → state=ok
verify-card: 工具卡片 browser_click → state=ok
verify-card: 弹窗标签已进 tabs 清单（结果含前台 t2）                        ← 收编链路硬证据
verify-card: PASS —— ...
```

辅助证据（不是必须，但出问题时要查）：

- **实例日志**（步骤③的 stdout.log）里必须有三连：
  `bridge: opened announcement tabId=t2 url=<详情页>` → `provider: adopting opened tab t2` → `provider: adopted t2`
- **轨迹视图**（UI 点「轨迹」）里 `2 controlled tab(s) ... session_id=t2 [foreground] — <百度详情页>`
- **聊天回复**里应有动态证据段（`✅ 已完成「打开百度 → 点击热搜第五条 → 读详情」全链路`+ 标题/URL/摘录）。

## 4. 铁律（踩过的坑，违背必炸）

1. **fake-llm 脚本每进程只消费一次。** 同一桌面端实例上重跑 verify:card，脚本已耗尽 → 只回兜底文本「（fake-llm：脚本已耗尽…）」，一张卡片都不会出。**每轮测试前必须回到步骤②③重启桌面端。**
2. **杀进程只按端口（9222/9229/9230）找 PID**，不要 `taskkill /IM electron.exe`——屏幕上有多个 electron，杀错会把无关窗口带走。杀完确认端口真的释放了。
3. **Windows 侧命令一律用 PowerShell 直调**，不要依赖它的 stdout 转发（会被吞）；要输出就 `Out-File` 落盘再读。`wmic` 在 Win11 已移除，用 `Get-CimInstance`。
4. **bash heredoc 偶发被咬**（Unterminated regexp literal）——复杂脚本用 Write 工具写 .mjs 文件再 `node` 跑，不要 heredoc。
5. **热搜榜是实时数据**，别对具体标题写死断言；第五条以榜单序号「5」为准（不是 DOM 第 5 个——置顶/推荐项会占住前排，2026-09-13 实测把第五条点成了第二条）。
6. **detailDigest 失败会降级成静态文本**「已走完…」。若聊天里只出现静态文本，看实例日志里的 `fake-llm: digest: 动态证据抽取失败` 打点（需 DSH_BROWSER_PLUGIN_DEBUG=1）定位哪一段没抽到。
7. verify:card **注入前会先点「新会话」**（已内建）——恢复的旧会话 DOM 里残留旧轮次卡片（t1/example.com），不切新会话轮询断言会被污染成假失败/假通过。
8. **fake-llm 只在开发态挂上，而且需要 `DSH_FAKE_LLM=1`。** 它的 patch 行**不在出货的 `cordis.patch.yml` 里** —— 那一行随包发出去，会把每个用户的真实对话都换成脚本回放（2026-09-14 的 v0.2.0 事故，见 README「发版」段）。它现在待在开发专用 overlay `cordis.fake-llm.patch.yml` 里，由 `pnpm run dev:desktop` 拼接写进开发态 profile **并同时置 `DSH_FAKE_LLM=1`**。所以：
   - 验证链路**必须走 `dev:desktop`**；手工装配 profile 时要自己把 overlay 拼进去、并置那个环境变量。
   - 症状对照：插件在图上、`llm/stream` 却没人接管（回复来自真模型或报缺 key）→ 先查 `DSH_FAKE_LLM` 与 overlay 在不在。
   - 排查时看实例日志的 `fake-llm: gate:` 打点（需 `DSH_BROWSER_PLUGIN_DEBUG=1`）：它会明确说闸门没开。

## 5. 相关文件

| 文件 | 作用 |
|---|---|
| `scripts/verify-card.mjs` | 端到端验证脚本（新会话→注入→轮询卡片→t2 断言→截图） |
| `src/fake-llm/index.ts` | 脚本化模型回放：8 轮真实任务流 + detailDigest 动态收尾 + digest 失败打点。**`apply` 有 `DSH_FAKE_LLM=1` 闸门，默认哑**；patch 行在开发专用 `cordis.fake-llm.patch.yml` |
| `src/browser-electron/host.cjs` | 弹窗 `openTab(url, undefined, { announce: true })` → opened 通报 |
| `src/browser-electron/bridge.ts` | `onTabOpened` 通报分发（无 command id 的 `{type:'opened'}` 分支） |
| `src/browser-electron/provider.ts` | `adoptSession` 收编（先登记后等加载，防 click→tabs 竞态） |
| `src/browser-cdp/provider.ts` | `adoptSession` 通用实现（基类） |
| `src/tool-browser/index.ts` | browser_find 空白归一化匹配（NBSP 坑的修复点） |
| `scripts/check-reply-visible.mjs` / `scripts/check-trajectory.mjs` | 只读辅助：查聊天回复 / 轨迹文本（连 9222，不改状态） |
| `scripts/check-execute-result.mjs` / `scripts/dump-hotsearch-evidence.mjs` | 只读辅助：抓 execute 返回的 `fifth` JSON / 抓 c3·c4·t2 证据，排查 `detailDigest` 降级时用 |
| `src/fake-llm/index.ts` 的 `detailDigest` | 收尾轮的证据抽取；失败分支都带 `reason` + 尾部快照，日志里一眼看得出是哪段没抽到 |

## 6. 当前状态与待办

- **已验证 PASS**（2026-09-13 23:33 一轮）：6 张卡片全 ok、open=baidu、t2 [foreground] 收编断言通过。仅截图步骤曾超时（已改为失败只警告不失败）。
- **已修复（2026-09-14）**：`detailDigest` 动态证据降级。**真因不是正文截断，是 URL 把整段挤没了** —— 详情页 URL 两三百字，工具结果进 llm 请求历史时被截断，断在 URL 中间，旧实现死等 `(at …) ` 里的 `) `，于是整段判死。打点原文：`原因=paren: "(at " 之后没有 ") "，尾部="(at https://www.baidu.com/s?wd=…&hisfilt"`。修法两条：① 锚点改为 `(at ` 之后到首个空白或逗号，不再要求其后有 `, ref epoch N) `；② 详情页正文表达式 4000 → 1200 字（摘录最多展示 600 字，取更多纯属浪费，且正文越长越容易把 URL 尾部一起挤掉）。复验：日志无降级打点，聊天回复里第五/URL/摘录三行齐全，URL 完整未截断。
- **click → tabs 的时序坑（2026-09-14，2026-09-17 结构性修掉）**：弹窗转标签是**异步**的（宿主发 opened 通报 → provider adoptSession 登记），click 返回时它可能还没进注册表。当时同一份代码两次跑，一次「tabs 清单里有 t2」一次「只有 t1」，脚本第 6 轮于是先发 `browser_wait(1.5s)` 再 `browser_tabs`。
  - **现在的机制**：`CdpBrowserProvider.mutate` 在动作前取会话台账快照，动作后取差集，把新收编的标签页写进回执的 `opened_tabs`（`TAB_OPEN_WATCH_MS = 250`，实测通报延迟中位 152ms）。不导航的点击本来就要跑满 800ms 导航轮询，天然覆盖；「导航且弹窗」那条早退路径由补观测窗口兜住。所以 `browser_wait(1.5s)` 已经不是必需的了（留着无害）。
  - 看到「弹窗标签没进 tabs 清单」仍然先怀疑时序/收编链路，别急着改 `adoptSession`；但**若 `opened_tabs` 也空**，那才是收编真出问题。
- **未提交**：无（adoptSession 收编链、client 15 视图、fake-llm 热搜流+动态收尾、find 空白归一化、verify-card 加固均已提交）。
- 单测基线：289 passed / 3 skipped（2026-09-14，含 `src/bundle-patch.test.ts` 出货 patch 守卫、fake-llm 闸门用例、5 条 `detailDigest` 抽取用例与 P2/P3 三组回归用例）。
- **发版前必过**：`pnpm run verify:portable -- --dir <解压后的便携版目录>`（可加 `--browser <chrome>`）。它先用 harness 真代码（`apps/desktop/src/{runtime-tree,profile-packages}.ts`，`--harness` 可指路径）走一遍桌面端启动准备 —— 全量 sha256 完整性、`state.runtimeId` / `nodeVersion` / `platform` / `arch` 逐项对齐、建 241 条宿主链接 + `validateDesktopPluginGraph` —— 再真起宿主读 boot graph、可选验浏览器信标。约 40 项断言，任一转红即 exit 1。
  - 2026-09-14 实测：**必须先确认解压产物没坏**。便携版真包首次自检时报 `Cannot find package '@deepseek-ai/dsh-client-ui-workflow-run'`，真因是解压产出 5160 个 NUL 文件（zip 的 11954 条 CRC 全绿，是我这边的解压方式坏了），一度被误读成「包有问题」。现在这条由 sha256 断言兜住。
  - 出厂态 `home/profiles/desktop/node_modules` 只有 `dsh-webops-plugin` 一个是**正常**的；241 条 `@deepseek-ai/*` 链接由桌面端首次启动建，不在 zip 里。
