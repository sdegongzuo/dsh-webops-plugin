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

/** 取 `spawn(node, [...], {…})` 的实参数组原文（截到 `], {` 为止，不含选项对象）。 */
function spawnArgvBlock(source: string, near: string): string {
  const at = source.indexOf(near)
  if (at === -1) return ''
  const open = source.indexOf('[', at)
  if (open === -1) return ''
  const close = source.indexOf('], {', open)
  if (close === -1) return ''
  return source.slice(open, close)
}

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

/**
 * 取出 `near` 附近那个 `join(...)` 里的字符串字面量参数。
 *
 * 只认引号段、不认注释：注释里写 `primary-runtime` 不能让这条变绿。
 * 优先取锚点**之后**的 join（赋值即 join 的写法）；没有再回看锚点之前
 * （join 赋给临时变量、再写 `DSH_PTC_NODE = existsSync(...)` 的写法）。
 */
function joinStringArgs(source: string, near: string): string[] {
  const at = source.indexOf(near)
  if (at === -1) return []
  const forward = source.slice(at, at + 800)
  const backward = source.slice(Math.max(0, at - 800), at)
  // 补丁文件每行带 `+` 前缀，剥掉再找 join，否则 `,` 和引号被 `+` 隔开。
  const window = (/join\s*\(/.test(forward) ? forward : backward).replace(/^\+/gm, '')
  const joinAt = window.search(/join\s*\(/)
  if (joinAt === -1) return []
  let depth = 0
  let end = joinAt
  for (let i = joinAt; i < window.length; i++) {
    if (window[i] === '(') depth += 1
    else if (window[i] === ')') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = window.slice(joinAt, end + 1)
  // 只收 join 的参数位（前面是 `,` 或 `(`），丢掉 ternary 里的 `'win32'` / `'node.exe'`。
  return [...body.matchAll(/[,(]\s*'([^']+)'/g)].flatMap(match => match[1] === undefined ? [] : [match[1]])
}

function joinCallBody(source: string, near: string): string {
  const at = source.indexOf(near)
  if (at === -1) return ''
  const forward = source.slice(at, at + 800)
  const backward = source.slice(Math.max(0, at - 800), at)
  const window = (/join\s*\(/.test(forward) ? forward : backward).replace(/^\+/gm, '')
  const joinAt = window.search(/join\s*\(/)
  if (joinAt === -1) return ''
  let depth = 0
  for (let i = joinAt; i < window.length; i++) {
    if (window[i] === '(') depth += 1
    else if (window[i] === ')') {
      depth -= 1
      if (depth === 0) return window.slice(joinAt, i + 1)
    }
  }
  return ''
}

function sliceAround(source: string, near: string, radius = 700): string {
  const at = source.indexOf(near)
  if (at === -1) return ''
  return source.slice(Math.max(0, at - radius), at + radius)
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
  // 同一 id 可能出现两次（insert 里的行 + 后面的顶层覆盖条目），config 断言要的是
  // **最后**那个 —— 顶层覆盖永远写在文件更靠后的位置（本文件自己的惯例，上游也是）。
  const start = lines.findLastIndex(line => line.trim().replace(/^-\s+/u, '') === `id: ${id}`)
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
    for (const id of ['browser', 'browser-cdp', 'browser-electron', 'webpage-tools', 'webops-plugin']) {
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

  it('browser-cdp 必须默认停用（2026-09-19 主上定：桌面端用 electron provider 就够）', () => {
    // 必须是**顶层**条目 + disabled: true（与上游 dsh-acp-app 关 session-title-llm/hmr 同款，
    // 也是插件页手动关开关时 writePluginEnabled 写回的同构形态）——用户想连外部 Chrome
    // 时在插件页把那行开关打开，profile 层会覆盖这里的默认值。
    expect(hasRow(body, 'browser-cdp'), '出货 patch 少了 browser-cdp 的默认停用条目').toBe(true)
    const block = rowBlock(body, 'browser-cdp')
    expect(block, 'browser-cdp 没带 disabled: true，会白白在每个用户机器上跑一个外部 Chrome provider')
      .toContain('disabled: true')
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
    expect(patch, '补丁没注入 DSH_PTC_NODE').toContain('process.env.DSH_PTC_NODE =')
    // 断言的是 join 的**参数段**，不是注释里的路径词：alpha.2 把实体从
    // resources/runtime/node 搬到 primary-runtime/dependencies/node/bin。
    // 旧 join（runtime + node）会让这条转红；改指 runtime/bin/node.cmd 那个
    // shim 也会（shim 依赖被 PTC 子进程清掉的两个环境变量）。
    expect(
      joinStringArgs(patch, 'process.env.DSH_PTC_NODE'),
      'DSH_PTC_NODE 的 join 没指向 primary-runtime 下的真 node',
    ).toEqual(['runtime', 'primary-runtime', 'dependencies', 'node', 'bin'])
    const ptcRegion = sliceAround(patch, 'process.env.DSH_PTC_NODE')
    expect(ptcRegion, '打包态缺文件时必须回落 process.execPath').toContain('existsSync')
    expect(joinCallBody(patch, 'process.env.DSH_PTC_NODE'), '不能改指 runtime/bin/node.cmd 那个 shim')
      .not.toContain('node.cmd')
    expect(yamlBody(readRepoFile('cordis.patch.yml')), '出货 patch 没读 DSH_PTC_NODE')
      .toContain('process.env.DSH_PTC_NODE ?? process.execPath')
  })

  it('沙箱 runnerExecutable 与 PTC 注入走同一份包内真 node', () => {
    expect(
      joinStringArgs(patch, 'function runnerExecutable'),
      'runnerExecutable 的 join 没指向 primary-runtime 下的真 node',
    ).toEqual(['runtime', 'primary-runtime', 'dependencies', 'node', 'bin'])
    const region = sliceAround(patch, 'function runnerExecutable')
    expect(region, '打包态缺文件时必须回落 process.execPath').toContain('existsSync')
    expect(region, '回落丢了，开发态会指到一个不存在的路径').toContain('process.execPath')
    expect(joinCallBody(patch, 'function runnerExecutable'), '不能改指 runtime/bin/node.cmd 那个 shim')
      .not.toContain('node.cmd')
  })

  it('两个变量名都不能带 DSH_DESKTOP_ 前缀', () => {
    // 名字本身要继续守（插件读的就是这两个名字），但**理由已经变了**：
    // 0.1.5 / 0.1.6-alpha.1 的 `host-process.ts` 会把 `DSH_DESKTOP_` 前缀整批过滤掉，
    // 当年是被迫绕开；0.1.6-alpha.2 起子进程环境改成 `{...environment}` 全量继承
    // （`apps/desktop/src/node-environment.ts`），这条限制没有了。保持不改名只是
    // 「插件侧读的也是这个名字」——重新命名没有任何收益。
    expect(patch).not.toContain('DSH_DESKTOP_APP_EXECUTABLE =')
    expect(readRepoFile('src/browser-electron/index.ts')).not.toContain("'DSH_DESKTOP_APP_EXECUTABLE'")
    // 标题说的是「两个变量名」，那第二个也得真断言 —— 否则标题比断言宽，读者会以为守住了一对。
    expect(patch).not.toContain('DSH_DESKTOP_BROWSER_ELECTRON_HOST =')
    expect(readRepoFile('src/browser-electron/bridge.ts')).not.toContain("'DSH_DESKTOP_BROWSER_ELECTRON_HOST'")
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

  it('不把本机 .credentials.yaml 拷进便携包', () => {
    expect(script, '打包脚本不能 cpSync 凭据文件').not.toMatch(/cpSync\([^)]*credentials/u)
    expect(script).not.toMatch(/writeFileSync\([^)]*\.credentials\.yaml/u)
  })
})

describe('出厂模型配置：落点与凭据卫生', () => {
  const patch = readRepoFile('scripts/portable-profile-patch.yaml')

  it('只写凭据引用名 apiKeyEnv，正文里没有 sk- 形态的 secret', () => {
    expect(patch).toContain('apiKeyEnv: UNISOUND_API_KEY')
    expect(patch, '出厂 YAML 混进了 sk- 开头的 key').not.toMatch(/sk-[A-Za-z0-9]{8,}/u)
  })

  it('落点是 profile patch，不是被 0.1.7 退役的 home/settings.yaml', () => {
    // 0.1.7 起 settings.yaml 只被一次性导入本 profile 再改名（importLegacyDocument），
    // 源码注释称其为 the **removed** settings.yaml。出厂配置写在终点
    // home/profiles/desktop/cordis.patch.yml，才不必依赖一个上游明确标为已移除的垫片。
    expect(
      () => readRepoFile('scripts/portable-home-settings.yaml'),
      '旧模板还在：它只会让下一个人以为出厂配置仍写 settings.yaml',
    ).toThrow()
    const packager = readRepoFile('scripts/package-desktop-portable.mjs')
    expect(packager, '打包脚本没读新的出厂模板').toContain("'scripts', 'portable-profile-patch.yaml'")
    expect(packager, '新模板没落到 home/profiles/desktop').toContain("join(profileDir, 'cordis.patch.yml')")
    expect(packager, '打包脚本还在写出厂 settings.yaml').not.toMatch(/cpSync\([^)]*'settings\.yaml'/u)
  })

  it('模板带 dsh 自己的 PROFILE_PATCH_TEMPLATE 表头', () => {
    // 用户看到的就是同一份文件该有的样子：表头逐字取自上游 profile.ts。
    expect(patch).toContain('# Your patch layer for this dsh profile, applied after every bundle layer:')
  })
})

describe('alpha.2 宿主入口（desktop-host 不再导出 runDesktopHost）', () => {
  const scripts = [
    'scripts/verify-portable.mjs',
    'scripts/verify-ptc.mjs',
    'scripts/verify-settings.mjs',
  ]

  it('自检走 packaged desktop-host 的 IPC 启动，不再 import 已删除的 runDesktopHost', () => {
    const helper = readRepoFile('scripts/run-packaged-host.mjs')
    expect(helper, 'helper 没 spawn packaged desktop-host').toContain('dsh-desktop-host')
    expect(helper, 'helper 没走 IPC').toContain("'ipc'")
    expect(helper).not.toContain('await runDesktopHost(')
    for (const file of scripts) {
      const body = readRepoFile(file)
      expect(body, `${file} 还在调用已删除的 runDesktopHost`).not.toContain('await runDesktopHost(')
      expect(body, `${file} 还在 destructure 已删除的 runDesktopHost`).not.toContain('{ runDesktopHost }')
      expect(body, `${file} 没改走 startPackagedDesktopHost`).toContain('startPackagedDesktopHost')
    }
  })

  it('argv 按 0.1.7 契约排：runtimeDir / projectDir / primaryRuntime / [pnpm, nodeBin]', () => {
    const argv = spawnArgvBlock(readRepoFile('scripts/run-packaged-host.mjs'), 'const child = spawn(node,')
    expect(argv, 'helper 里找不到 spawn 的 argv 数组').not.toBe('')
    // 0.1.7 之前这里的第 5 位是 profileResolution 的 'runtime'。概念已退役（上游
    // grep profileResolution 零命中），而字面量原地留着会被宿主当成 **pnpm 路径**，
    // 把 `packageManager` 设成假值、盖掉 plugin-manager 自己的 pnpm 兜底 ——
    // 传个错的值比不传更糟，所以这一条必须是「有断言」而不是「有注释」。
    expect(argv, 'argv 里还留着已退役的 profileResolution 字面量').not.toContain("'runtime'")
    expect(argv, 'argv 没成对带上 pnpm/nodeBin').toContain('...packageManager')
    const order = ['runtimeDir', 'profileDir', 'primaryRuntime', '...packageManager']
      .map(token => argv.indexOf(token))
    expect(order.every(index => index >= 0), `argv 缺项：${argv}`).toBe(true)
    expect([...order].sort((left, right) => left - right), `argv 顺序不对：${argv}`).toEqual(order)
  })

  it('pnpm / nodeBin 按打包布局探测，且成对（缺一不传）', () => {
    const helper = readRepoFile('scripts/run-packaged-host.mjs')
    expect(helper, 'resources 根不是从 runtimeDir 推的')
      .toContain("const resources = join(runtimeDir, '..')")
    expect(helper, 'pnpm 探测路径与 resources 布局不符')
      .toContain("join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')")
    expect(helper, 'nodeBin 探测路径与 resources 布局不符')
      .toContain("join(resources, 'runtime', 'bin')")
    expect(helper, 'packageManager 不是「存在才成对给」（宿主只看 argv[5] 是否为 undefined）')
      .toContain('const packageManager = existsSync(pnpm) ? [pnpm, nodeBin] : []')
  })
})

describe('verify-ptc 的包内真 node 探针', () => {
  const script = readRepoFile('scripts/verify-ptc.mjs')

  it('[1/4] 按 primary-runtime 布局找 node，而不是已搬家的 runtime/node', () => {
    expect(
      joinStringArgs(script, 'const nodePath'),
      'verify-ptc [1/4] 还在旧路径 resources/runtime/node 上找',
    ).toEqual(['resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin'])
    expect(joinCallBody(script, 'const nodePath'), '不能改指 runtime/bin/node.cmd 那个 shim')
      .not.toContain('node.cmd')
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
