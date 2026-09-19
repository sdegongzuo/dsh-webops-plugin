# dsh-webops-plugin 便携版 · 安装说明

便携版 = **已经编译好的插件目录**。解压即可用，不需要 Node 工具链，也不需要
DeepSeek Harness 的源码 checkout。

## 一、解压

解压到任意位置，路径里**不要有中文或空格**（Windows 上 dsh 的 profile 依赖解析对
非 ASCII 路径不友好）。例如：

```
D:\tools\dsh-webops-plugin\
```

目录结构：

```
dsh-webops-plugin/
  lib/                 编译产物（host 四面 + 客户端 bundle + Electron 窗口宿主）
  cordis.patch.yml     bundle 配置层：把五行插进目标 profile
  package.json         声明 exports / dsh.bundle.patch / dsh.client
  INSTALL.md           本文件
  README.md
  LICENSE
```

## 二、装进 profile

```bat
dsh plugin --profile <你的 profile 名> add D:\tools\dsh-webops-plugin
```

`<profile>` 不存在时 dsh 会自动初始化。

> **注意**：`add` 之后不要再移动或删除这个目录 —— dsh 是把它 link 进 profile 的。

## 三、验证

```bat
dsh --profile <你的 profile 名> --dump-config
```

在输出里找到这一段，五行齐全即为装好：

```
# == dsh-webops-plugin
- dsh-webops-plugin/browser
- dsh-webops-plugin/browser-cdp
- dsh-webops-plugin/browser-electron
- dsh-webops-plugin/tool-browser
- dsh-webops-plugin
```

打开 `DSH_BROWSER_PLUGIN_DEBUG=1` 启动，能看到加载诊断：

```
[dsh-webops-plugin] root: client row registered
[dsh-webops-plugin] browser-cdp: endpoint=http://127.0.0.1:9333
[dsh-webops-plugin] browser-electron: enabled=true
[dsh-webops-plugin] webpage-tools: registered webpage_open, webpage_navigate, webpage_snapshot, webpage_screenshot, ...（共 16 个，前缀统一 `webpage_`）
```

## 四、选 provider

| provider | 环境变量 | 开的是什么 |
|---|---|---|
| `electron` | `DSH_BROWSER_PROVIDER=electron` | 桌面端自己的 `BrowserWindow` |
| `cdp` | `DSH_CDP_ENDPOINT=http://127.0.0.1:9333` | 你**自己开的**外部 Chrome 的标签页。⚠️ **出货默认关闭**（`cordis.patch.yml` 里 `browser-cdp: disabled: true`）：桌面端用 `electron` 就够，不装它。要连外部 Chrome，在插件页把 `browser-cdp` 那行开关打开（profile 层覆盖默认值） |

用 `cdp` 前必须先起一个带调试端口的 Chrome，**且必须用独立的 user-data-dir**，
否则它会复用你日常那个实例，而那个实例不会开调试端口：

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9333 --user-data-dir="%TEMP%\dsh-cdp-profile"
```

端口**别用 9222**：dsh 桌面端开发态的 Electron renderer 调试端口占着它，插件会连上
那个 Electron 而不是 Chrome，`/json/new` 必然失败。

## 五、卸载

```bat
dsh plugin --profile <你的 profile 名> remove dsh-webops-plugin
```
