# webpage_execute 序列化报错可行动化：实现与验证

| 项目 | 内容 |
|---|---|
| 日期 | 2026-11-27 |
| 状态 | 已结束（单测、类型检查、构建全绿；未做打包态真实对话验收） |
| 对象 | 工作副本 `D:/dev/cli/dsh-webops-plugin`（未提交），任务输入见 [修复 prompt](2026-11-27-webpage_execute序列化报错修复prompt.md) |
| 目的 | 让 `webpage_execute` 的返回值拒收报错自带「哪个字段 + 为什么 + 怎么改」，模型下一轮能改对 |

## 1. 结论

原 prompt 的两条必做改动已落地；复核时另发现三处同源缺口并一并修了：
`BROWSER_EXECUTE_RESULT_UNSERIALIZABLE` 的**回执尾部清单与成因无关**（`avoid DOM nodes, functions, cycles, accessors` 与「缺字段」无关，既在 `diagnostics.ts:504` 也在 `browser/types.ts:240` 的 `Recovery:` 里各出现一次），
以及 `BROWSER_EXECUTE_SCRIPT_ERROR`（即 prompt 表格里的第四种表现）**没有区分「页面抛错」与「工具故障」**。

## 2. 改动

| 位置 | 改动 |
|---|---|
| `src/tool-browser/tools/execute-script.ts` `__dshPack` | `undefined` 单列一条：带 JSON 路径 + 写明 `?? null`；只覆盖嵌套位置，顶层 `return undefined` 仍走 `has_value:false` 不报错 |
| 同上 | `is not a finite number` 补 `Number()` + `Number.isFinite`（页面用 `"-"`/`""` 表示缺失） |
| 同上 | 循环引用、非普通对象各补「返回按需字段的副本」；判据与错误码不变 |
| `src/tool-browser/tools/diagnostics.ts` | 拒收回执去掉与成因无关的 DOM/函数清单，保留「副作用不回滚」；运行时脚本错误改写成「页面自身的错误，不是工具故障」并列出常见成因（含 `"-"` 缺失值） |
| `src/browser/types.ts` | `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE` 的 `Recovery:` 改成指向消息里的具体字段 |
| `src/tool-browser/index.test.ts` | 测试台加 `executeEnvelope` 桩，新增两条工具层用例（回执编排、脚本错误措辞） |
| `src/tool-browser/tools/execute-script.test.ts` | 新增 5 条用例（undefined 字段、数组槽位、非有限数、函数/symbol/bigint 仍走原消息、循环与非普通对象） |

未改序列化语义（对象里的 `undefined` 不静默跳过、数组里不转 `null`），未改三个阈值与错误码字符串。

## 3. 改前 vs 改后（同一段包装器实测，绕开 CDP）

| 模型代码 | 改前 | 改后 |
|---|---|---|
| `const d = {}; return { eps: d.BASIC_EPS }` | `$.eps has unsupported type undefined` | `$.eps is undefined: … For optional fields use ?? null so the value survives JSON serialization` |
| `return [null, undefined]` | `$[1] has unsupported type undefined` | `$[1] is undefined: … ?? null …` |
| `return { n: Number("-") }` | `$.n is not a finite number` | `$.n is not a finite number: a page often uses "-" or "" … convert it with Number() and check Number.isFinite before returning` |
| `return { when: new Date(0) }` | `$.when is not a plain object or array` | 同上 + 「class instances / Map / Set 不能过桥，返回按需字段的普通对象」 |
| `v.self = v` | `$.self contains a circular reference` | 同上 + 「必须是树，返回按需字段的副本」 |
| `+d.X.toFixed(1)`（值是 `"-"`） | `TypeError: … toFixed is not a function` + 「fix the reported JavaScript syntax or runtime error」 | `… threw a JavaScript runtime error: … This is the page's own error, not a tool failure. Common causes: …（含 `"-"`、`typeof`/`Number()` 提示）` |

第 4 种仍是 `BROWSER_EXECUTE_SCRIPT_ERROR`（脚本错误路径），本轮只改措辞，不把它并进序列化错误码。

## 4. 验证

```
rtk pnpm vitest run src/tool-browser/tools/execute-script.test.ts   # 先红 4 条，实现后 15/15 绿
rtk pnpm vitest run src/tool-browser/index.test.ts -t "execute"     # 先红 2 条，实现后 14 通过
rtk pnpm typecheck                                                  # TypeScript: No errors found
rtk pnpm vitest run src/tool-browser src/browser src/browser-cdp    # 28 文件 / 946 通过 / 10 跳过
rtk pnpm build                                                      # Build complete, 10 files 593.12 kB
```

schema 预算：改动 3（工具描述补一句）**未做**。数字来自 `rtk pnpm vitest run src/tool-browser/index.test.ts -t "前缀成本守卫"` 的真实失败输出（2026-11-27 21:38，加了 50 字符描述后跑）：全集 14 034 > `SCHEMA_BUDGET` 14 000，基础组 9 045 > 9 000，加不下；随即回退描述，守卫恢复绿（全集 13 984，余量 16 字符）。基础组数字与「用脚本单独量 schema 字符数」的口径不同（后者 base ≈ 6 312，不含 mount 全量加载口径），以守卫测试的失败输出为准。未删系统提示里的安全声明。

## 5. 限制与后续

- 只验到单测与构建层。未做打包态真实对话验收（模型拿到新文案后是否一次改对，需要真实会话确认）。
- `+d.X.toFixed(1)` 这类写法仍会先抛 `TypeError`，报错能指路但不会自动兜底。
- 顶层 `return undefined` 仍是 `has_value:false` 不报错；若模型把派生字段写在顶层才会命中原分支，嵌套字段一律走新文案。