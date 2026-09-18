/**
 * 出货 patch 的守卫测试。
 *
 * 2026-09-14 事故：`cordis.patch.yml` 里带着 keyless 验证用的 `fake-llm` 行一起发版，
 * 而这个插件的 `llm/stream` 监听器在 waterfall 里不调 `next()` —— 装上它的每个用户的
 * 真实对话都会被替换成脚本回放。类型检查、单测、CI 构建**全都不会**发现这种事：
 * 那一行是「合法配置」，插件也是「合法加载」。
 *
 * 2026-09-15 又添一例同类事故：`browser-electron` 那一行**在**，但它该有的 `config`
 * 没了 —— provider 于是从不参与选择，`webpage_open` 落到桌面端的死路上，症状就是
 * 「没法打开新的窗口」。同样是「合法配置、合法加载、测试全绿」。
 *
 * 所以这里直接对**文件内容**断言三件事：
 *   1. 出货 patch 里绝不能出现会接管 llm/stream 的行；
 *   2. 开发专用 overlay 里必须还留着那一行 —— 否则 keyless 验证链路会静默失效；
 *   3. 关键行必须带齐它该有的 config（`rowBlock`，专治「行在、config 没了」）。
 *
 * 断言的是文本而不是「行为」，因为「行为」要跑起整个桌面端才能观察，而「文本」在
 * 每次 `pnpm test` 里就能拦住。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 会改变用户真实对话行为的插件名（不是「调试工具」，是「出厂即劫持」）。 */
const HIJACKERS = ['fake-llm', 'llm-replay', 'mock-llm']

function readRepoFile(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
}

/**
 * 去掉 YAML 注释行后的「有效内容」。
 *
 * 必须剥注释：出货 patch 的注释里**明确写着**「fake-llm 故意不在这里」，直接对全文断言
 * 会被这段解释误伤 —— 守卫测试自己先炸，是最容易被顺手删掉的那种测试。
 */
function yamlBody(text: string): string {
  return text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
}

/** 某一行是否存在于 YAML 有效内容里（整行匹配，避免 `id: browser` 命中 `id: browser-cdp`）。 */
function hasRow(body: string, id: string): boolean {
  return body.split('\n').some(line => line.trim().replace(/^-\s+/u, '') === `id: ${id}`)
}

/**
 * 取某个 `id:` 行的**完整块**（含它下面的 `config:` 子树），到下一个列表项为止。
 *
 * 用来断言「这一行不只存在，还带着该有的 config」—— 2026-09-15 的事故正是
 * 「行在、config 没了」：`hasRow` 是绿的，而窗口就是开不出来。
 */
function rowBlock(body: string, id: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex(line => line.trim().replace(/^-\s+/u, '') === `id: ${id}`)
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.trimStart().startsWith('- '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

describe('出货 patch（cordis.patch.yml）', () => {
  const body = yamlBody(readRepoFile('cordis.patch.yml'))

  it('install 的每一行都不是 llm/stream 劫持器', () => {
    for (const name of HIJACKERS) {
      expect(body, `出货 patch 里出现了 ${name}：它会接管 llm/stream，真实对话会被换成假回放`)
        .not.toContain(name)
    }
  })

  it('仍然挂着浏览器那一组行（防止上面那条断言被「整文件清空」蒙混过关）', () => {
    for (const id of ['browser', 'browser-cdp', 'browser-electron', 'tool-browser', 'browser-plugin']) {
      expect(hasRow(body, id), `出货 patch 少了 id: ${id}`).toBe(true)
    }
  })

  it('browser-electron 那行必须显式启用（2026-09-15 事故：行在、config 没了，窗口开不出来）', () => {
    const block = rowBlock(body, 'browser-electron')

    // 不写 enabled 的话 available() 恒为 false，webpage_open 会落到 browser-cdp ——
    // 而它在桌面端里是死路（内置 Chromium 不实现 PUT /json/new）。
    expect(block, '少了 enabled: true，provider 不会参与选择')
      .toContain('enabled: true')
    // 便携版包里没有独立的 electron.exe，宿主只能用桌面端主 exe 起第二个实例。
    expect(block, '少了 appMode: true，窗口宿主起不来')
      .toContain('appMode: true')
  })

  it('ptc-runtime 那行必须把 nodeExecutable 指到 DSH_PTC_NODE，并保留 process.execPath 兜底', () => {
    // 2026-09-18 的教训：这条原本写在 harness 的 `desktop-host/config/desktop.cordis.patch.yml` 里，
    // 0.1.6-alpha.2 把那个目录整个删掉之后，**没有任何源码再设置或读取 DSH_PTC_NODE** ——
    // `run_code` 会在打包态静默挂到超时（PTC 子进程被 Electron 当 GUI 起）。搬进本文件后，
    // 这条断言就是「下次它再被删掉」时的唯一警报。
    // 它必须留在**顶层**（不是 insert 里）：这是对 base bundle 已有那一行的 config 覆盖。
    expect(hasRow(body, 'ptc-runtime'), '出货 patch 少了 ptc-runtime 的 config 覆盖').toBe(true)
    const block = rowBlock(body, 'ptc-runtime')
    expect(block, '覆盖丢了，桌面端 run_code 会起不来').toContain('nodeExecutable:')
    // 兜底也必须留着：非桌面端没有这个变量，必须回落到 process.execPath（那本来就是 node）。
    expect(block, '少了 process.execPath 兜底，非桌面端会被写进一个不存在的路径')
      .toContain('process.env.DSH_PTC_NODE ?? process.execPath')
  })
})

describe('harness 补丁与插件之间的变量名约定', () => {
  const patch = readRepoFile('docs/harness-desktop-build.patch')

  it('补丁注入的主 exe 路径，插件用同一个名字去读', () => {
    // 两处不一致 = 静默失效：插件拿不到 electronPath，窗口开不出来，且没有任何报错。
    expect(patch, '补丁没注入主 exe 路径').toContain('process.env.DSH_APP_EXECUTABLE = process.execPath')
    expect(readRepoFile('src/browser-electron/index.ts'), '插件读的变量名和补丁对不上')
      .toContain("'DSH_APP_EXECUTABLE'")
  })

  it('补丁读的宿主脚本变量，插件用同一个名字去写', () => {
    expect(patch, '补丁没读宿主脚本变量').toContain('process.env.DSH_BROWSER_ELECTRON_HOST')
    expect(readRepoFile('src/browser-electron/bridge.ts'), '插件写的变量名和补丁对不上')
      .toContain("'DSH_BROWSER_ELECTRON_HOST'")
  })

  it('补丁注入的 PTC node 路径，出货 patch 用同一个名字去读', () => {
    // 这一对横跨两个文件（harness 侧 main.ts 写、我们的 cordis.patch.yml 读），
    // 任何一半掉了都是静默失效：run_code 起不来，但没有任何报错指向这里。
    expect(patch, '补丁没注入 DSH_PTC_NODE').toContain('process.env.DSH_PTC_NODE = join(')
    expect(patch, '补丁没把 DSH_PTC_NODE 指向包内自带的 node（resources/runtime/node）')
      .toContain("'runtime',")
    expect(yamlBody(readRepoFile('cordis.patch.yml')), '出货 patch 没读 DSH_PTC_NODE')
      .toContain('process.env.DSH_PTC_NODE ?? process.execPath')
  })

  it('两个变量名都不能带 DSH_DESKTOP_ 前缀', () => {
    // 名字本身要继续守（插件读的就是这两个名字），但**理由已经变了**：
    // 0.1.5 / 0.1.6-alpha.1 的 `host-process.ts` 会把 `DSH_DESKTOP_` 前缀整批过滤掉，
    // 当年是被迫绕开；0.1.6-alpha.2 起子进程环境改成 `{...environment}` 全量继承
    // （`apps/desktop/src/node-environment.ts`），这条限制没有了。保持不改名只是
    // 「插件侧读的也是这个名字」——重新命名没有任何收益。
    expect(patch).not.toContain('DSH_DESKTOP_APP_EXECUTABLE =')
    expect(readRepoFile('src/browser-electron/index.ts')).not.toContain("'DSH_DESKTOP_APP_EXECUTABLE'")
  })
})

describe('便携 home 兜底（双击 exe 也能自带配置）', () => {
  const patch = readRepoFile('docs/harness-desktop-build.patch')

  it('补丁在 main.ts 顶层把便携 home 认作 $DSH_HOME', () => {
    // 没有这段：双击 app\<exe> 会落回 ~/.dsh，那里没有本插件 ——
    // 症状是「打开了，但状态条不见了」，且不报任何错。
    expect(patch, '补丁没接便携 home 兜底')
      .toContain('resolvePortableDshHome(process.execPath)')
  })

  it('兜底只在 $DSH_HOME 为空时生效（显式设置永远优先）', () => {
    // 反例：无条件赋值会覆盖 `启动.cmd` / dev-desktop / CI 显式指定的 home，
    // 把「配置随包走」变成「配置永远在 exe 旁边」。
    expect(patch, '兜底条件丢了，会覆盖用户显式设置的 $DSH_HOME')
      .toContain("(process.env.DSH_HOME ?? '').trim() === ''")
  })

  it('判定逻辑实现于 harness 的 paths.ts，而不是在 main.ts 里手拼', () => {
    // 抽成导出函数是为了能被真跑：verify:portable 直接 import 它在真解压目录上验。
    expect(patch, 'paths.ts 里没有 resolvePortableDshHome 导出')
      .toContain('export function resolvePortableDshHome(executablePath: string)')
    expect(patch, '便携判定不再是「exe 上一级的 home」')
      .toContain("resolve(dirname(executablePath), '..', 'home')")
    expect(patch, 'main.ts 绕开了导出函数，自己拼路径')
      .not.toContain("const portableHome = resolve(dirname(process.execPath), '..', 'home')")
    expect(patch, 'main.ts 没从 paths.ts 引这个函数')
      .toContain("import { resolveDesktopPaths, resolvePortableDshHome } from './paths.ts'")
  })
})

describe('便携版使用说明（scripts/package-desktop-portable.mjs）', () => {
  const script = readRepoFile('scripts/package-desktop-portable.mjs')

  it('说明里不再要求「先起外接 Chrome」（v0.2.1 起 webpage_open 用 dsh 自己的窗口）', () => {
    // 旧文案让用户以为必须手起 Chrome，照着做反而误判功能坏了。
    expect(script).not.toContain('这个 Chrome 先起来')
    expect(script, '说明没告诉用户可以不外接 Chrome').toContain('不需要外接 Chrome')
  })

  it('说明里两种启动方式都写了（脚本 + 直接双击 exe）', () => {
    expect(script).toContain('· 双击根目录的「启动.cmd」')
    expect(script).toContain('· 直接双击 app 目录里的')
  })
})

describe('开发专用 overlay（cordis.fake-llm.patch.yml）', () => {
  const overlay = readRepoFile('cordis.fake-llm.patch.yml')

  it('保留 fake-llm 行，keyless 验证链路才有夹具', () => {
    expect(overlay).toContain('dsh-webops-plugin/fake-llm')
  })

  it('且它只在开发 overlay 里，不在出货白名单里', () => {
    const manifest = JSON.parse(readRepoFile('package.json')) as { files?: string[] }
    expect(manifest.files ?? []).not.toContain('cordis.fake-llm.patch.yml')
  })
})
