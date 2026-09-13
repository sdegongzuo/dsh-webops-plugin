# dsh 桌面端便携版 v0.1.0（Windows x64）

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
