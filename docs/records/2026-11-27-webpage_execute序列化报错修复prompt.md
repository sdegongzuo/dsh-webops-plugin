# Prompt：让 `webpage_execute` 的序列化报错自带修法

> 用途：交给执行者（或另一个会话）落地本次修复。工作目录 `D:/dev/cli/dsh-webops-plugin`，
> 规则见 `AGENTS.md`、`docs/agent-rules/开发.md`、`docs/agent-rules/文件规模.md`。

````markdown
请修复 `dsh-webops-plugin` 里 `webpage_execute` 返回值校验的报错可读性。工作目录 `D:/dev/cli/dsh-webops-plugin`，
先读 `AGENTS.md` 与 `docs/agent-rules/{开发,文件规模}.md`。允许改代码，但只改下面列出的范围。

## 一、要解决的问题（已实测，不要重新论证）

真实失败：模型写的代码是 `eps: d.BASIC_EPS`，东财那份数据第一行没有 `BASIC_EPS` 字段，
于是 `d.BASIC_EPS` 是 `undefined`，整份结果被拒：

```
Error: [BROWSER_EXECUTE_RESULT_UNSERIALIZABLE] webpage_execute ran once but could not serialize
the returned value: $[0].eps has unsupported type undefined. Return only ordinary JSON data and
avoid DOM nodes, functions, cycles, accessors, and deep objects. Any side effects are not rolled back.
```

问题不在「拒绝 undefined」这个策略，而在**报错不告诉模型怎么改**。模型改了一处之后还会撞下一处，
因为同一个根因有四种表现（全部已用包装器实测）：

| 模型代码写法 | 实际报错 | 模型容易误判成 |
|---|---|---|
| `eps: d.BASIC_EPS`（字段缺失） | `$[0].eps has unsupported type undefined` | 不知道缺字段该用 `?? null` |
| `nbvRate: d.NBV_RATE`（同上） | `$.nbvRate has unsupported type undefined` | 以为只修 eps 就够了 |
| `nbv: d.NBV_LIFE ? … : null`（值是 `"-"`） | `$.nbv is not a finite number` | 以为 `?` 兜底已经安全 |
| `revYoY: +d.TOTALOPERATEREVETZ.toFixed(1)`（值是 `"-"`） | `TypeError: …toFixed is not a function` | 报了另一个错误码，像另一个 bug |

关键代码：`src/tool-browser/tools/execute-script.ts:13-34` 的 `__dshPack` 是**整份全通才收**，
任何一个字段不合格就丢弃整份结果。`undefined` 落在第 20 行 `if (typeof item !== 'object')` 上，
和 `function` / `symbol` / `bigint` 共用同一条消息，所以只说类型不说修法。

## 二、目标（只做这一件事）

让上述四类报错**自带「哪个字段 + 为什么 + 怎么改」**，模型下一轮就能改对。**不改序列化语义。**

## 三、改动清单

### 1（必做）`undefined` 单独一条带修法的消息

文件 `src/tool-browser/tools/execute-script.ts`，在 `visit` 里 `if (typeof item !== 'object')`（第 20 行）
**之前**插入专门分支：

- 必须带 JSON 路径，沿用现有 `path` 变量（形如 `$[0].eps` / `$.rows[2].rd`）
- 必须出现字面量 `?? null`，这是模型要照抄的修法
- 文案英文（面向模型），示例：

```
path + ' is undefined: the page object has no such property, or the property is not set. For optional fields use `x ?? null` so the value survives JSON serialization.'
```

- 只在**嵌套位置**触发；顶层 `return undefined` 走第 35 行 `value === undefined` 分支（`has_value:false` 不报错），
  这是既有语义，保持不变，不要顺手改成报错。
- 第 20 行原分支保留给 `function` / `symbol` / `bigint`，消息不动。

**坑（务必注意）**：`__dshPack` 整段是用模板字符串拼进页面表达式的（`+ \`…\``），
新增文案里**不能出现裸反引号**（会截断模板）、**不能出现 `${`**（会被当插值求值）。
需要引号就用单引号；要写 `?? null` 时不要包反引号。

### 2（必做）非有限数的消息指向页面占位符

同文件第 19 行 `is not a finite number` 后面补一句修法，说明页面对缺失数值常返回 `"-"` / `""`，
要先 `Number()` 再验证：

```
path + ' is not a finite number (the page often uses "-" or "" for missing numbers; convert with Number() and check Number.isFinite before returning)'
```

判据不变：仍然 `throw new TypeError`，仍然 `has_value:false`，错误码仍是 `BROWSER_EXECUTE_RESULT_UNSERIALIZABLE`。

### 3（可选，受预算约束）工具描述补一句

`src/tool-browser/tools/diagnostics.ts:456` 的 `description` 是模型每步都在付的固定成本，
`src/tool-browser/index.test.ts:2473` 的守卫是 `SCHEMA_BUDGET = 14_000`，当前实际约 13 713，**余量约 287 字符**。

- 想加就加一句中文：`返回的对象里任何字段为 undefined 都会让整份结果被拒，可选字段用 ?? null。`
  （约 44 字符，含 `code` 参数描述里更合适也可以）
- 加完必须跑 `rtk pnpm vitest run src/tool-browser/index.test.ts -t "前缀成本守卫"`，
  把三个预算的实际数字贴进报告。
- **加不下就跳过本条**，在报告里写明「余量不足 N 字符」——不要为了加这句话去删系统提示里的
  安全声明（`untrusted external data`、`副作用不会回滚` 等有断言守着）。

### 4（必做）反向用例，且必须先红后绿

`src/tool-browser/tools/execute-script.test.ts` 的 `describe('webpage_execute async function body wrapper')`
里新增用例，**先只写测试跑一次，贴出红的结果，再改实现转绿**。断言不要写成「包含某个完整长句」，
否则以后改文案就红；按语义断言：

- `return { a: 1, b: undefined };` → `serialization_error` 含 `$.b` 且含 `?? null`
- `return [null, undefined];` → 含 `$[1]` 且含 `?? null`
- `const rows = [{ rd: 'x' }]; return rows.map(d => ({ rd: d.missing }));` → 含 `$[0].rd`
- `return { n: NaN };` → 含 `is not a finite number` 且含 `Number.isFinite`
- 现有 `preserves a legitimate JSON value` 三条（`{}` / `[]` / `null`）必须保持绿 —— `null` 不能误伤

## 四、明确不做

- **不改序列化语义**：对象里的 `undefined` 不静默跳过、数组里的不转 `null`。那会放弃
  「DOM 节点静默变成 `{}`」这条防线的一部分，需要另立议题讨论。
- 不动其余 15 个 `webpage_*` 工具：它们回执是工具自己拼的字符串，不经过 `__dshPack`。
- 不改 `RESULT_TEXT_LIMIT`（18 000）、深度 40、节点 10 000 三个阈值。
- 不改错误码字符串（`BROWSER_EXECUTE_RESULT_UNSERIALIZABLE` / `BROWSER_EXECUTE_SCRIPT_ERROR`），
  客户端诊断面板按 `BROWSER_` 前缀和这两个码分流。
- 不要顺手把 `has_value:false` 的回执文案（`formatExecuteOutput`）改写 —— 与本议题无关。

## 五、验证（全部要贴原始输出）

```
rtk pnpm typecheck
rtk pnpm vitest run src/tool-browser/tools/execute-script.test.ts
rtk pnpm vitest run src/tool-browser
rtk pnpm build
```

再加一段**手工实测**（Node 直接跑包装器，绕开 CDP），贴真实回执证明文案到位：

```js
import { wrapExecuteFunctionBody, unwrapExecuteEnvelope } from 'file:///D:/dev/cli/dsh-webops-plugin/src/tool-browser/tools/execute-script.ts'
for (const code of ['return { a: 1, b: undefined };', 'return [null, undefined];', 'return { n: NaN };',
                    'const d = {}; return { eps: d.BASIC_EPS };']) {
  const envelope = await new Function(`return ${wrapExecuteFunctionBody(code)}`)()
  console.log(code, '=>', JSON.stringify(unwrapExecuteEnvelope(envelope).serialization_error))
}
```

`lib/` 在 `.gitignore` 里（未入库），构建只为验证能产出，不要提交产物。

## 六、交付格式

1. `git diff --stat` + 每个文件的改动要点（不要贴整段代码）。
2. 每个改动对应一条「测试先红 → 实现后绿」的证据。
3. schema 预算三个实际数字（若做了改动 3）；没做则写余量与原因。
4. 一份「改后报错长什么样」的对照：改前 vs 改后，四条各一行。
5. 未做项与残留风险：明确写出「这四处文案改了，但模型仍可能写 `+d.X.toFixed(1)` 这类 TypeError，
   那属于脚本错误路径，本次未处理」。
6. 注释用中文，面向模型的文案用英文；`execute-script.ts` 目前 80 行，改完仍须远低于 2000 行。
````
