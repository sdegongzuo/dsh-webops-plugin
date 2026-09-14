# dsh 桌面端便携版 —— 发版存档

> **v0.1.0 的 zip 是本机手打的**；自 `desktop-v0.2.0` 起 Release 说明由
> `.github/workflows/release-desktop.yml` 在 CI 里内联生成（含当场算出的 SHA-256 与体积）。
> 下面 v0.1.0 一节是历史存档，**v0.2.0 一节是重发后的验证结论**，留作后续发版的对照基线。

---

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
