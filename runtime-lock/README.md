# 生产运行时锁

`pnpm-lock.yaml` 是桌面端**生产运行时**（`resources/dsh/node_modules`）唯一的依赖解析输入。
构建只读它，不重新解析版本；升级依赖必须显式重新生成并提交。

## 为什么需要外部锁

上游 `prepare-dsh.ts` 每轮在 `mkdtemp` 出来的新目录里跑 `install --lockfile-only`。0.2.1 时代安装那步
在本机带 `--frozen-lockfile` 会卡在 `added 241/507`（download 恒为 0），本仓补丁因此一度去掉这两个
标志；后果是只要不喂外部锁，同一份源码在两次构建里会各自解析到「当时最新的满足范围版本」——
**传递依赖**没有任何东西钉住。

2026-10-19 实测（0.2.20）：本机包 `execa` 10.1.1、公开包 10.2.0，共 16 项文件内容不同；
两端各自的清单完整性都通过，所以只看「清单对得上」发现不了这个问题。

0.2.2-alpha.2 起上游把 pnpm store 从一次性的 `BUILD_ROOT` 挪到持久的 `BUILD_PATHS.pnpmStore`，
并加了 `--config.verify-store-integrity=true` 与 `--config.package-import-method=copy` —— 正是当年
「store 每轮冷 + 跨盘 hardlink」那两个条件。所以补丁已**回到上游原样的 frozen 安装**，与外部锁
叠加：锁是输入、解析前后各断言一次哈希，frozen 不会触发重解析。若哪天又卡在 added 计数上，
先查 store 是否命中，别直接删 frozen。

## 契约（由 `docs/harness-desktop-build.patch` 的 `prepare-dsh.ts` hunk 强制）

| 阶段 | 行为 |
|---|---|
| `runtime:lock` | 把 `DSH_DESKTOP_RUNTIME_LOCK` 指向的锁拷进一次性构建目录 |
| `runtime:lockfile` | `pnpm install --lockfile-only` |
| `runtime:pin-lock` | 断言锁文件 SHA256 与输入一致；不一致直接失败并列出增删样例 |
| `runtime:install` | `pnpm install --prod --frozen-lockfile --trust-lockfile`（上游原样） |
| `runtime:verify-lock` | 再断言一次 SHA256 未变 —— 证明安装没有触发重新解析 |

没有 `DSH_DESKTOP_RUNTIME_LOCK` 也没有 `DSH_DESKTOP_RUNTIME_LOCK_WRITE` 时构建**直接失败**，
避免回落到「静默重新解析」。两个 workflow 的本体构建步骤都已注入该变量；本机入口
`scripts/harness-build.mjs` 自己按本文件路径注入。

## 重新生成

只在**有意升级依赖**时做：

```bash
pnpm harness:build --refresh-runtime-lock
```

它等价于给上游传 `DSH_DESKTOP_RUNTIME_LOCK_WRITE=<本文件>`：照常解析、安装、冒烟，并把解析
结果覆盖写回本文件。之后必须：

1. `git diff runtime-lock/pnpm-lock.yaml` 逐条核对版本变化，确认是想要的升级；
2. 重跑一次普通构建（`pnpm harness:build`），确认锁哈希在解析与安装前后都不变；
3. 把锁文件和验收记录一起提交 —— 只改锁不重编不算验证。

## 与根 `pnpm-lock.yaml` 的关系

两者无关，不要互相复制。根锁固定的是仓库开发依赖（插件自身的构建与测试）；本文件固定的是
**打包进便携包的 DSH 运行时**依赖树，由上游 `readDesktopCorePackageSet` 生成的项目元数据解析而来。
