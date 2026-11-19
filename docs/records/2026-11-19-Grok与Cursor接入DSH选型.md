# Grok / Cursor 接入 DSH 的插件选型报告

- 日期：2026-11-19
- 对象：DSH（DeepSeek Harness）0.2.2 线。本机源码 `D:/dev/cli/deepseek-harness` 为 `0.2.2-rc.5`，便携桌面 `D:/dsh-build/portable-test` 为 `0.2.2-rc.5`，webops 插件 `0.2.27`。
- 问题：有代理 Cursor 或 Grok Build 模型的 DSH 插件吗？已有 Grok 订阅，想让 DSH 继续当 Agent，选哪个？

## 0. 结论

**选 `dsh-llm-xai-oauth`（0.3.1）。不要装 Cursor 订阅插件。** 原生 xAI 路由（不装插件）作为"账号安全优先"的兜底。

三条理由：

1. **它做的正是这件事**：把 SuperGrok / X Premium 的 OAuth 会话变成 DSH 的 `xai` 模型路由，DSH 仍然拥有 agent loop、工具、会话和权限。你的 `webpage_*` 工具链不受影响。
2. **版本对得上**：它的 peer 范围明确覆盖 `0.2.2-rc.1` 到 `0.2.2` 线，和本机 `0.2.2-rc.3 / rc.5` 匹配；2026-11-16 仍在发版，npm 周下载 1,394，是同类里最高。
3. **Cursor 插件不划算**：它逆向 Cursor 未公开的 Agent 协议，ToS 灰色，2026-09-30 后停更，周下载 169；而你从 Cursor 能拿到的 Grok 模型，走 Grok 路由同样能拿到。Cursor 唯一独有的是 Composer 2.5。

一句话的取舍：**用订阅池省钱，但走的是非官方端点；要绝对稳，就走官方 API 按 token 付费。**

---

## 1. 先把三个东西分开，否则一定选错

| 名词 | 它到底是什么 | 能不能直接当 DSH 的模型 |
|---|---|---|
| **Grok Build** | xAI 的开源终端编码 Agent（TUI / headless / ACP），Apache-2.0；模型本身是闭源服务 | 不能。它是"Agent"，不是"模型 API"；能复用的是它的 **OAuth 会话 + 订阅推理代理端点** |
| **Cursor** | IDE / Agent 平台，含本地与云端 Agent、Composer 模型 | 不能（官方）。官方明确没有 OpenAI 兼容的 `/v1/chat/completions`；`cursor-agent`、Agent SDK、Cloud Agents API 都跑 Cursor 自己的 harness，不给"裸模型" |
| **xAI API** | 真正的模型 API，OpenAI Responses 风格，按 token 计费 | 能。DSH 自带 `xai` provider 路由，填 key 即可 |

再补一个背景：DSH 的模型层是 `llm-pi-ai`，本身支持"内置提供商目录 + 自定义 OpenAI/Anthropic/Gemini 网关 + OAuth 登录"。**接一个标准 API，不需要写插件；只有要把非标准认证（比如订阅 OAuth）或非标准端点接进来，才需要插件。** 这就是为什么市面上的方案全是"OAuth 桥"，而不是"模型适配器"。

> 结论翻译成人话：你要的不是"Cursor 插件"，而是"把 Grok 订阅的登录态借给 DSH 用"。

---

## 2. 你这张 $30 的订阅，实际包含什么

根据你发的套餐页和 Cursor 官方定价页：

- **一个共享池**：Grok 聊天 / 语音 / 图像 / Grok Bot / Cursor / Grok Build 共用一个**每周**刷新的用量池。Premium 是 Plus 的 **4 倍**，Super 15 倍，Ultra 50 倍。
- **Cursor 的"包含用量"只覆盖 Grok 系模型 + Cursor 自家的 Composer 2.5**。Claude、GPT、Gemini 等第三方模型在 Cursor 里按 **API 列表价**另付，不占池子。
- 套餐卡上的 **"Grok API access" 是另一条账**：API 按标准 token 价单独计费，不从订阅池扣。

由此得到三个直接推论：

1. 想用 Grok 模型 → 走订阅池最划算；API 是另一笔钱。
2. 想用 Cursor 里的 Grok → 和直接接 Grok 是**同一个模型**，没有增量。
3. 想用 Cursor 里的 Claude/GPT → 本来就要按 API 价付，绕一圈接进 DSH 不会更便宜，只会多一层风险。

---

## 3. 候选方案总表

| # | 方案 | 在 DSH 里怎么落地 | 用谁的钱 | DSH 工具是否保留 | 维护 / 体量 | 主要风险 | 结论 |
|---|---|---|---|---|---|---|---|
| A | **原生 xAI 路由**（API key，或设置页里的 xAI OAuth） | 设置 → 模型 → 添加提供商 → `xai` | xAI API 按 token | 是 | DSH 官方 | 无第三方代码；按量计费 | **兜底方案** |
| B | **`dsh-llm-xai-oauth`** | 安装插件 → 设备码登录 → 选 `grok-4.7` | 订阅池（边际 0 元） | 是 | 1,394 次/周；11-16 更新；0.3.1 | 非官方端点、客户端指纹、ToS 灰色、token 1 小时 | **推荐主线** |
| C | **`dsh-coding-subscription-oauth`** | 安装插件 → 设置里登录 Grok / Codex / Kimi / Claude | 各自订阅池 | 是 | 802 次/周；11-17 更新；0.8.8；28 star | 面更大；Grok 走同一代理并加指纹头；0.2.2 未列入已验证 BOM | 需要多订阅时的备选 |
| D | **`dsh-cursor-subscription`** | 安装插件 → 浏览器 PKCE 登录 Cursor | Cursor 池 / 第三方按 API 价 | 是（工具请求转给 DSH） | 169 次/周；2026-09-30 后停更；0.6.12 | 逆向私有协议、ToS、双层 harness、重试可能重复计费 | **不推荐** |
| E | **CLI 委派**（`dsh-agent-conductor`、`dsh-model-router`） | DSH 调 `grok -p` / `cursor-agent -p` 当子 Agent | 各自订阅 | **否**（子 Agent 自己跑循环） | 社区插件 | 子 Agent 用不到你的 webops 工具；延迟高；会话难对齐 | 只适合纯编码任务 |
| F | 聚合网关（OpenRouter 等） | 自定义模型 API | 按 token，通常更贵 | 是 | 成熟 | 多一层加价与延迟 | 不解决"用已有订阅"的问题 |

### 3.1 为什么 B 是主线

它的机制很窄，正好只做一件事：

- 在 DSH 里注册一条 `xai` 路由，端点默认 `https://cli-chat-proxy.grok.com/v1`（**订阅推理代理**，不是 `api.x.ai`）。
- 复用 `~/.grok-bridge/auth.json` 或 `~/.grok/auth.json` 的 OAuth token；没有就开 xAI 设备码登录（`auth.x.ai`），Windows 桌面会弹一个本地授权页显示设备码。
- token 约 1 小时；DSH 运行时提前 5 分钟刷新，401 再刷一次。DSH 不在运行时，需要 `daemon` / 计划任务续期。
- 模型目录：`grok-4.7`（500K 上下文 / 64K 输出 / off–xhigh）、`grok-4.5`、`grok-4.3`；启动时会用 `/models` 拉一次实时目录。
- 带上下文预算投影：长会话剩余窗口放不下 `max_tokens` 时抛 `CONTEXT_WINDOW_EXCEEDED`，交给 DSH 的压缩流程，而不是直接 400。

**优点**：单职责、代码面小、MIT、凭据文件 0600、明确声明支持 0.2.2 线、README 把 401 / 过期 / 长上下文这些坑写清楚了。

**必须知道的坑**：

- 端点 `cli-chat-proxy.grok.com` 和客户端标识（`x-grok-client-version` / `x-grok-client-mode`）都不是公开 API，属于"借官方客户端通道"。xAI 改协议或收紧策略就会失效。
- plugin 的合规声明也承认：第三方 harness 使用编码订阅可能落在条款灰色区，可能触发配额、地区或账号风控；只支持自己的账号，不做多账号/转售/远程中继。
- README 让 `daemon --install` 写 **systemd** 用户单元；**Windows 没有 systemd**，需要改用计划任务（每 20 分钟 `refresh`），或者保持 DSH 常开靠进程内刷新。
- GitHub 仓库很新，**0 star**；周下载 1.4k 但缺少社交证明。安装前建议读一遍 `src/oauth.ts` / `src/adapter.ts`，并固定版本。
- 它和原生 `xai` 路由**不能同时配**：插件直接 `registerAdapter(['xai'])`。装它之前，把设置页里已有的 xAI 提供商删掉。
- 池子大小官方只给"Plus 的倍数"，不公布绝对值。**你无法精确预算还能跑多少**，这是订阅路线最大的不确定性。

### 3.2 为什么 C 只做备选

`dsh-coding-subscription-oauth`（前身 `dsh-grok-build`）功能更全：Grok Build + Codex + Kimi Code + Claude Code + Antigravity，五家订阅 OAuth，带设置页、配额页、本地 OpenAI/Anthropic 网关、Grok Imagine。

但它对你现在这个需求是**过度配置**：

- 它自己写"verified build/smoke BOM remains exact `0.1.1-rc.2`"，你的 `0.2.2-rc.3` 只在 `engines` 范围里，不在已验证清单里。
- 面大：五个 provider、本地网关、图片/视频能力开关，任何一处和 0.2.2 线不兼容，排查成本都高于单路由插件。
- Grok 侧同样走 `cli-chat-proxy.grok.com`，并显式发官方 CLI 指纹头（`X-XAI-Token-Auth`、`x-grok-client-identifier`、`x-grok-client-version`）——这比 B 更像"冒充官方客户端"，风控语义更重。

**什么时候换它**：你同时有 ChatGPT Plus（Codex）或 Claude Pro/Max，想把它们一起接进 DSH；或者 B 在你的版本上跑不起来。

### 3.3 为什么 D 不值得

- **官方没有裸模型入口**。Cursor 官方在论坛明确回复：目前没有公开的 OpenAI 兼容 `/v1/chat/completions`，官方外部用法只有 `cursor-agent` CLI、Agent SDK、Cloud Agents API，三者都跑 Cursor 自己的 harness。
- 该插件逆向的是 `agent.v1.AgentService/Run` 私有协议，README 自己写"Cursor 改服务端就可能失效"。
- 2026-09-30 之后没有新版本，周下载 169；DSH 已进到 0.2.2 线，兼容性没有新证据。
- 它把 Cursor 的工具请求翻译成 DSH 工具调用，等于在两套 harness 之间做协议桥；流式 POST 失败无法证明远端没处理，**开重试可能重复扣费**；默认每步重放完整历史（Cursor 没有服务端压缩），长会话成本会上去。
- 对你没有模型增量：Premium 的 Cursor 包含池只有 Grok 系 + Composer。Grok 你已经能用 B 拿到；**只有 Composer 2.5 是 Cursor 独有**。

**结论**：除非你明确要 Composer 2.5，否则不装。真要 Cursor 的云端 Agent / Bugbot，用官方 `cursor-agent` 或 SDK，以"子 Agent"方式接入（方案 E），不要让 DSH 去冒充 Cursor 客户端。

---

## 4. 费用测算：什么时候订阅真的省

假设 Grok 4.7 按官方价：**输入 $2 / 1M，输出 $6 / 1M**；每月按 30 天。这里的"请求"指一次模型调用，一个多步 Agent 任务通常包含 5–10 次。

| 使用强度 | 每天请求 | 平均输入/请求 | 平均输出/请求 | 月输入 | 月输出 | 月费（API） |
|---|---:|---:|---:|---:|---:|---:|
| 轻 | 20 | 15K | 1K | 9M | 0.6M | **$21.6** |
| 中 | 60 | 30K | 1.5K | 54M | 2.7M | **$124.2** |
| 重 | 150 | 40K | 2K | 180M | 9M | **$414** |

读法：

- 轻量使用，API 比 $30 订阅还便宜；但订阅已经买了，**边际成本是 0**，所以只要不挤爆池子，用 B 仍然更省。
- 中重度 Agent 使用，API 是订阅价的 4–14 倍；B 的优势非常明显。
- 上表没算 prompt caching（缓存输入有折扣）和"单次请求超 200K 后整单翻倍"的规则；DSH 会把历史、工具 schema、网页快照一起发，实际输入往往比假设更大。
- 真正的成本差不是钱，是**不确定性**：API 账单可预测；订阅池被 Cursor、Grok App、Grok Build 一起抢，而且官方不公布池子绝对值。

---

## 5. 六维对比（1–5 分，越高越好）

| 维度 | A 原生 API | B xai-oauth | C 多订阅 | D Cursor | E CLI 委派 |
|---|---:|---:|---:|---:|---:|
| 费用可预测 | 5 | 2 | 2 | 3 | 3 |
| 稳定性 | 5 | 3 | 3 | 2 | 3 |
| 账号 / 合规风险 | 5 | 2 | 2 | 1 | 4 |
| 维护活跃度 | 5 | 4 | 4 | 2 | 3 |
| 保留 DSH 工具与循环 | 5 | 5 | 5 | 5 | **1** |
| 模型独特性 | 4 | 4 | 5（多订阅） | 4（Composer） | 4 |

评分依据：A 官方直连；B 非官方端点但单职责、迭代快；C 功能强但面和未验证版本更大；D 逆向协议 + 停更；E 不保留 DSH 的工具循环，所以"保留工具"一项直接 1 分。

---

## 6. 给你的落地顺序

### 第 0 步：先花 5 分钟确认原生 OAuth 走哪条账

DSH 的 `llm-pi-ai` 在代码层已经注册了 xAI 的 OAuth 登录（pi-ai 1.3.0 的 `xaiOAuth`，登录标签就是 "Sign in with SuperGrok or X Premium"）。所以设置页**可能**直接能登。

但它的 `xai` provider 端点是 `https://api.x.ai/v1`——按插件作者的说明和订阅定价，这是**按量计费的 API 轨**，不是订阅池。试一次：

1. 设置 → 模型 → 添加模型提供商 → `xai`，看有没有 OAuth 登录入口。
2. 登录后选 `grok-4.7`，发一条短消息。
3. 去 xAI Console 看这次调用记在"API 用量"还是订阅池。

- 如果记在 API、而你能接受按量付费 → **停在这里，不用装插件**，这是最稳的方案。
- 如果它 401 / 403，或你不想另付 API 钱 → 进第 1 步。

> 注意：如果这里登录成功并保留了 `xai` 提供商，装 B 之前要把它删掉，否则两个适配器抢同一个路由。

### 第 1 步：备份（可回滚）

拷一份 `home/profiles/<profile>/package.json`、`cordis.patch.yml`，以及 `home/.credentials.yaml`。不要删任何已有文件。

### 第 2 步：先在独立 profile 验证，不要直接上生产桌面

```powershell
# 用 CLI 的 tui/web profile 先试，确认插件、登录、模型三步都通
dsh plugin --profile tui add dsh-llm-xai-oauth@0.3.1

npx dsh-llm-xai-oauth login
npx dsh-llm-xai-oauth status

dsh --profile tui --provider xai --model grok-4.7
```

验证点：

- `dsh --profile tui --dump-config | Select-String llm-xai-oauth` 能看到 `id: llm-xai-oauth`。
- 登录后 `status` 显示 token 还有多久过期。
- `/model` 里出现 `grok-4.7`，能正常回复。
- `/usage` 能看到订阅池剩余（如果 401，先 `npx dsh-llm-xai-oauth refresh --force`）。

### 第 3 步：Windows 的续期

- DSH 常开：进程内会在到期前 5 分钟刷新，401 再刷一次，基本够用。
- 不常开：建一个计划任务，每 20 分钟跑一次
  `npx --yes dsh-llm-xai-oauth refresh`。
- 不要照抄 README 的 `daemon --install`（那是 systemd，Windows 没有）。

### 第 4 步：装进桌面 profile（本机手工 vendoring 的临时做法；已改为出厂 bundle，见第 11 节）

**实测结论：这个便携包的插件市场装不了第三方包。** 原因是 desktop profile 的四个现有插件 `dsh-webops-plugin`、`dsh-context`、`dsh-better-sidebar`、`dsh-connect-workbuddy` 都不在 npmjs / npmmirror 上，而 `pnpm add dsh-llm-xai-oauth@0.3.1` 会连带解析全部直接依赖：

```text
[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-webops-plugin: Not Found - 404
```

切到 npmmirror 也一样（`registry.npmmirror.com/dsh-webops-plugin` 404）。所以桌面端改成与出厂插件一致的**文件级 vendoring**：

1. 从 `~/.dsh/profiles/web/node_modules` 复制 `dsh-llm-xai-oauth` 及其运行依赖 `undici`、`eventsource-parser`、`@standard-schema/spec`、`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 到 `home/profiles/desktop/node_modules`。
2. 在 `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里各加一条。
3. 在 `cordis.patch.yml` 里把 `agent-default-model` 改成 `xai / grok-4.7 / high`，并加 `llm-xai-oauth.clientVersion: "1.0.13"`。
4. 重启应用。

这样装出来的插件在插件页能正常列出，但**不是插件管理器装的状态**：以后更新/卸载它，插件管理器仍会走 `pnpm add` 并撞同一个 404。升级时最稳的做法是重新拷一份覆盖，或者重新打一个把该插件纳入出厂 bundle 的便携包。

装完重启，新会话的模型应显示 `Grok 4.7 / High`，然后跑一个真实动作（列目录、打开网页）确认工具调用正常。

### 第 5 步：观察与止损

- 每天看一次 `/usage`；连续两天掉得异常快，说明池子被 DSH 吃得太狠，切回 A 或降低推理档（`high` → `medium`）。
- 出现连续 401 → 先 `status` / `refresh --force`；仍失败就重新登录。
- 出现 403 或"at capacity" → 多半是端点策略变了，不要反复重试，先停用插件。
- 任何账号风控提示 → 立即卸载 B，改用 A，不要在同一个账号上继续试。

### 回滚

```powershell
dsh plugin --profile <profile> remove dsh-llm-xai-oauth
```

桌面版用插件管理器卸载；`~/.grok-bridge/auth.json` 是共享凭据文件，是否删除由你决定，不要顺手删。

---

## 7. 什么情况下改选

| 你的优先级 | 选 | 原因 |
|---|---|---|
| 账号安全 / 工作不能断 | **A 原生 xAI API** | 官方通道，出问题有账单和文档可查 |
| 省钱，且能接受灰色地带 | **B** | 订阅池边际成本 0，单职责插件 |
| 同时有 ChatGPT / Claude 订阅 | **C** | 一次接五家，省得装五个插件 |
| 必须要 Composer 2.5 | **D**，或直接在 Cursor 里用 | 只有 Cursor 提供；但接受逆向协议和 ToS 风险 |
| 只要写代码，不需要网页工具 | **E** / 直接用 Grok Build | 让专业编码 Agent 干专业事，别让 DSH 当壳 |

---

## 8. 这份报告没验证的部分

说清楚边界，避免把推断当实测：

1. **没有在你的账号上实际登录/调用**。B 的端点、计费归属、池子扣减，都是基于插件文档、源码和 xAI 定价页的推断；真正扣的是池子还是 API，登录后看一次 `/usage` 和 Console 才算数。
2. **原生 xAI OAuth 的 UI 入口没有实机点过**。代码层确定存在（pi-ai `xaiOAuth` + `llm-pi-ai` 注册所有 OAuth 流程），但设置页是否显示、登录后是否被 `api.x.ai` 接受，需要你点一次。
3. **订阅池没有绝对值**。官方只说"Plus 的倍数"，无法给出"还能跑多少任务"的确定数字。
4. **B 已在本机装好并实测**（web / headless / desktop 三处，见第 10 节）；C / D 仍未安装，兼容性与稳定性判断仍来自文档和版本信息，不等同于实机验证。
5. **Cursor 插件在 0.2.2 线的行为没有新证据**。它最后发布于 2026-09-30，之后 DSH 已换线。

---

## 9. 主要来源

| 用途 | 来源 | 日期 |
|---|---|---|
| 套餐内容、共享池、Cursor 只含 Grok + Composer | https://cursor.com/pricing ；https://cursor.com/docs/models-and-pricing | 2026-10 / 11 |
| X Subscription 发布说明 | https://forum.cursor.com/t/introducing-the-x-subscription/174450/2 | 2026-10-12 |
| Cursor 无 OpenAI 兼容端点、官方外部入口 | https://forum.cursor.com/t/does-using-oh-my-pi-s-cursor-provider-or-an-openai-compatible-proxy-to-the-same-endpoints-violate-cursor-s-tos/167778 | 2026-09-02 |
| Grok 4.7 价格与 500K 上下文 | https://docs.x.ai/docs/models | 2026-09-21 |
| Grok API 与订阅分开计费 | https://www.toolcolumn.com/learn/grok-subscription-vs-xai-api-pricing | 2026-11-09 |
| Grok Build 是开源 Agent / 不是模型 | https://grokai.org/open-sourcing-grok-build/ | 2026-09-30 |
| DSH 提供商配置机制 | https://deepseek-harness.github.io/deepseek-harness/guide/providers | 2026-11 |
| B 的机制、端点、限制 | https://www.npmjs.com/package/dsh-llm-xai-oauth | 2026-11-16 |
| C 的机制、BOM、合规声明 | https://www.npmjs.com/package/dsh-coding-subscription-oauth | 2026-11-17 |
| D 的逆向协议与 ToS 警告 | https://www.npmjs.com/package/dsh-cursor-subscription | 2026-09-30 |
| 插件信任分级 | https://www.dsh.so/about/ | 2026-11 |

---

## 10. 实测记录（2026-11-19 本机）

环境：Windows，DSH `0.2.2-rc.5`，便携 home `D:/dsh-build/portable-test/home`，系统代理 `127.0.0.1:7890`。

### 10.1 登录

- 本机已有 `~/.grok/auth.json`（Grok CLI 留下的旧 token，约 60 天前过期）。插件能识别并复用，但 `refresh --force` 返回 `invalid_grant: Invalid or unknown refresh token`，说明 refresh token 已被撤销。
- 改用 `login --force` 设备码登录，授权页 `https://accounts.x.ai/oauth2/device?user_code=...`，授权后写入 `~/.grok-bridge/auth.json`，`status` 显示 **6 小时**有效。
- Node 的 `undici` 不读 Windows 系统代理，必须显式设 `HTTPS_PROXY` / `HTTP_PROXY`；否则 `fetch failed` 或超时。

### 10.2 426 的真实原因

第一次请求返回 `HTTP 426`，响应体是：

```json
{"error":"Your Grok CLI version (1.0.0) is outdated. Please update to version 1.0.13 or later via `grok update` or the installation documentation."}
```

插件默认伪装成 Grok CLI `1.0.0`，服务端要求 `1.0.13+`。把配置改成：

```yaml
- id: llm-xai-oauth
  config:
    clientVersion: "1.0.13"
```

之后正常。这个值以后还会随官方 CLI 版本继续抬高，遇到 426 先看响应体里的目标版本。

### 10.3 CLI 链路

`web` 与 `headless` profile 都装了 `dsh-llm-xai-oauth@0.3.1`；`headless` 的默认模型设为 `xai / grok-4.7 / high`。一次真实请求：

```text
输入 13,099 tokens / 输出 6 tokens / cache read 1,152 tokens
回复：xai-config-ok
```

说明订阅 OAuth → DSH `xai` 路由 → 模型返回这条链路成立。

### 10.4 桌面链路

插件市场安装失败，原因见第 6 节第 4 步（现有插件不在公共 npm 源，`pnpm add` 连带解析 404）。改为文件级 vendoring 后重启，结果：

- 插件页「已安装插件」出现 `dsh-llm-xai-oauth`，描述正常。
- 新会话默认模型显示 `Grok 4.7 / High`。
- 简单对话：回复 `desktop-xai-ok`，用时 2 秒，约 2,000 tok/s。
- 工具调用：让它列当前工作区文件，17 秒完成并返回文件名，说明工具调用链路可用。输出把 `rc5-final.txt` 读成了 `src5-final.txt`，属于模型侧的小误差，不影响链路判断。

### 10.5 本机改动清单

| 位置 | 改动 | 备份 |
|---|---|---|
| `~/.dsh/profiles/web` | 装 `dsh-llm-xai-oauth@0.3.1`；patch 加 `clientVersion: 1.0.13` | `~/.dsh/profiles/.backup-20261119/web-*.yml/json` |
| `~/.dsh/profiles/headless` | 同上；默认模型改 `xai/grok-4.7/high` | 同目录 `headless-*.yml/json` |
| `D:/dsh-build/portable-test/home/profiles/desktop` | 手工 vendoring 插件与 5 个依赖；`package.json` 加 dependency + bundle；patch 改默认模型并加 `clientVersion` | 同目录 `.backup-20261119-desktop/*` |
| `D:/dsh-build/portable-test/启动.cmd` | 启动时设 `HTTPS_PROXY` / `HTTP_PROXY` = `127.0.0.1:7890` | `.backup-20261119-desktop/启动.cmd` |
| `~/.grok-bridge/auth.json` | 新的 OAuth token（6 小时） | 旧文件已被插件覆盖，未单独备份 |

### 10.6 仍未验证

- `/usage` 没成功读到（插件 README 提到可能 401）；订阅池剩余量、这次调用扣的是池子还是 API，都还没有账单侧证据。
- 没有跑真正的网页操作（打开页面 → 快照 → 点击）；只验证了普通工具调用。
- 手工 vendoring 的插件在插件管理器里的更新/卸载路径没有测试，预期会撞同一个 404。

---

## 11. 纳入出厂 bundle 与修复（2026-11-19 第二轮）

目标：把手工作坊式的 vendoring 改成打包脚本可复现的出厂插件，并修掉安装链路里暴露的问题。

### 11.1 改动

| 位置 | 改动 |
|---|---|
| `vendor/plugins/manifest.json` | 新增第 4 个 vendor 插件 `dsh-llm-xai-oauth@0.3.1`，tgz 的 sha512 与 npm registry `dist.integrity` 一致；`runtimeDependencies` 声明 `undici@7.30.2`、`eventsource-parser@3.1.1` |
| `vendor/plugins/*.tgz` | 新增 3 个官方 tarball（插件 + 两个依赖），`materialize-vendored-plugins.mjs --check` 通过「4 插件 + 5 依赖」 |
| `scripts/portable-profile-patch.yaml` | 固定 `llm-xai-oauth.clientVersion: "1.0.13"`，修 426；仍不预置任何 provider / API Key |
| `scripts/factory-default-model.mjs`（新） | 可选构建参数：`DSH_FACTORY_DEFAULT_MODEL=xai/grok-4.7/high` 时，才把 `agent-default-model` 追加进出厂 patch；不设则保持仓库「出厂不预置模型」的策略，`verify-settings` 的反向断言不受影响 |
| `scripts/package-desktop-portable.mjs` | 生成 `启动.cmd` 时读取 Windows WinINET 系统代理（仅处理简单 `host:port`），并支持包根 `proxy.txt` 覆盖；解决 Node 不读系统代理导致的 `fetch failed` |
| `scripts/package-release-portable.mjs` | 同一套代理启动器与可选默认模型，完整发布包与桌面便携包行为一致 |

### 11.2 产物与验证

- 产物：`dist/dsh-webops-desktop-v0.2.2-rc.5-win-x64-portable.zip`，413.1 MB，46,250 条目，`testzip=None`，sha256 `ececcb21745ec2f66ded63a4c427445d34a385ed81cc8f28be3251348293d22c`。
- 本包按 Grok 用途构建，设置了 `DSH_FACTORY_DEFAULT_MODEL=xai/grok-4.7/high`；默认包不设该变量时仍显示「请选择模型」。
- `verify-portable` 全部通过：4 个 vendor 插件都在 activePlugins、运行时依赖已嵌套物化、出货 patch 无 `llm/stream` 劫持、真宿主启动并注入 `__DSH_BOOT__`。
- 真机验收（用包内 `启动.cmd`，**不手工设 `HTTPS_PROXY`**）：默认模型 `Grok 4.7 / High`；回复 `desktop-xai-ok` 用时 2–5 秒、约 1,500–2,000 tok/s；工具调用 25 秒返回结果。说明代理自动读取与 426 修复都生效。
- 插件页显示 `dsh-llm-xai-oauth v0.3.1`「运行中」，无需手工改 profile。

### 11.3 发版代理补齐（同日第三轮）

第二轮的发版包只有「默认模型 = Grok」，但 zip 根没有 `proxy.txt`：第一次启动如果系统代理没开，插件拉不到 xAI 模型目录，Grok 分组就不出现。第三轮把这块补成可复现的出厂动作，而不是让用户自己找目录新建文件。

| 位置 | 改动 |
|---|---|
| `scripts/factory-proxy.mjs`（新） | 可选构建参数 `DSH_FACTORY_PROXY=http://127.0.0.1:7890`；显式设置时才写包根 `proxy.txt`，未设置不产生文件。只接受 `http/https`、必须带 `host:port`，拒绝 query/hash/路径 |
| `scripts/package-desktop-portable.mjs` | 生成 `启动.cmd` 后调用 `writeFactoryProxy(STAGE)`；`使用说明.txt` 按是否预置代理输出不同文案 |
| `scripts/package-release-portable.mjs` | 同一套出厂代理写入；`release-manifest.json` 增加 `factoryProxy` 字段（有值时） |
| 构建命令 | `DSH_FACTORY_DEFAULT_MODEL=xai/grok-4.7/high` + `DSH_FACTORY_PROXY=http://127.0.0.1:7890` |

重打产物：

- `dist/dsh-webops-desktop-v0.2.2-rc.5-win-x64-portable.zip`
- 432,148,904 bytes（412.1 MB），40,878 个条目
- sha256 `a14c2e3080438441609f1a4d7239b6637db744964b54560ecef04603e38e7ce2`
- zip 根含 `proxy.txt`，内容 `http://127.0.0.1:7890`
- `home/profiles/desktop/cordis.patch.yml` 仍为 `xai / grok-4.7 / high`
- `verify-portable --dir D:\dsh-build\verify-proxy-release` **全部通过**：20,583 个受校验文件 sha256 全匹配、4 个 vendor 插件都在 activePlugins、宿主真启动并注入 `__DSH_BOOT__`、客户端 bundle 可拉取

取舍：出厂代理是**构建参数**，不是仓库默认策略；默认包不设 `DSH_FACTORY_PROXY` 时仍然没有 `proxy.txt`。当前包的端口写死为 7890，换机器/换端口需要改 `proxy.txt` 第一行；自动探测本地代理端口尚未实现。

### 11.4 仍未闭合

- **桌面插件市场仍不能在线安装第三方插件**：profile 现有 4 个插件不在 npmjs / npmmirror，`pnpm add` 会连带解析并 404。本包通过出厂物化绕开；在线安装要改安装器或补本地解析，未在本次实现。
- `/usage` 未验，订阅池扣减仍无账单侧证据。
- 默认 Grok 是构建参数，不是仓库默认策略；普通发布不设该变量时不会自动切 Grok。

---

## 附录：术语翻译

- **provider / route**：DSH 里"某个模型来源"的配置项，比如 `xai`。一个 route 有端点、协议、凭据、模型列表。
- **OAuth 桥**：不复制密码，而是复用"你已在浏览器登录"的令牌，让第三方程序以你的身份调模型。方便，但令牌过期和条款风险都由你承担。
- **OpenAI 兼容**：请求格式长得像 OpenAI 的 `/v1/chat/completions`，所以任何支持自定义 base URL 的客户端都能接。Cursor 不提供这个。
- **harness**：Agent 的"外壳"——负责循环、工具调用、上下文管理。DSH、Cursor、Grok Build 各自是一套 harness。接模型是换"大脑"，接 CLI 是换"整台机器"。
