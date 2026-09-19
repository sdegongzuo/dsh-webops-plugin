/**
 * §6.5「吞输入」探针的启动器：把 `scripts/input-swallow-probe/` 当一个 Electron 应用跑起来。
 *
 * 为什么要有启动器（而不是直接 `node …/main.cjs`）：这份探针必须跑在**真 Electron 主进程**里
 * —— `before-input-event` 是 Electron 的 API，纯 Node 下根本不存在。启动器负责三件事：
 * 找到 Electron 二进制、清掉会把 Electron 退化成纯 Node 的环境变量、把退出码原样透传。
 *
 * 跑法（仓库根）：
 *   node scripts/probe-input-swallow.mjs
 *
 * 退出码：0 = 全部判据通过；1 = 有判据未达标（或探针自己跑崩）。
 * 判据、实测数据与由此得出的两条实现约束，见 `docs/多会话防冲突-实施方案.md` 的 §6.5。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as localEnv from './local-env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, 'input-swallow-probe')

const electron = process.env['DSH_ELECTRON_BIN'] ?? localEnv.harnessElectronBin()
if (!existsSync(electron)) {
  console.error(`找不到 Electron 二进制：${electron}`)
  console.error('用 DSH_ELECTRON_BIN 指一个，或先按 docs/portable-install.md 把 harness 准备好。')
  process.exit(1)
}

const environment = { ...process.env }
// 带着它 Electron 会退化成纯 Node：`app` 不存在，探针第一行就崩（这个坑本轮踩过一次）。
delete environment['ELECTRON_RUN_AS_NODE']

const child = spawn(electron, ['.'], { cwd: appDir, env: environment, stdio: 'inherit' })
child.on('error', (error) => {
  console.error(`起 Electron 失败：${error.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`探针被信号 ${signal} 打断`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
