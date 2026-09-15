/**
 * 出货 patch 的守卫测试。
 *
 * 2026-09-14 事故：`cordis.patch.yml` 里带着 keyless 验证用的 `fake-llm` 行一起发版，
 * 而这个插件的 `llm/stream` 监听器在 waterfall 里不调 `next()` —— 装上它的每个用户的
 * 真实对话都会被替换成脚本回放。类型检查、单测、CI 构建**全都不会**发现这种事：
 * 那一行是「合法配置」，插件也是「合法加载」。
 *
 * 2026-09-15 又添一例同类事故：`browser-electron` 那一行**在**，但它该有的 `config`
 * 没了 —— provider 于是从不参与选择，`browser_open` 落到桌面端的死路上，症状就是
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

    // 不写 enabled 的话 available() 恒为 false，browser_open 会落到 browser-cdp ——
    // 而它在桌面端里是死路（内置 Chromium 不实现 PUT /json/new）。
    expect(block, '少了 enabled: true，provider 不会参与选择')
      .toContain('enabled: true')
    // 便携版包里没有独立的 electron.exe，宿主只能用桌面端主 exe 起第二个实例。
    expect(block, '少了 appMode: true，窗口宿主起不来')
      .toContain('appMode: true')
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

  it('两个变量名都不能带 DSH_DESKTOP_ 前缀（host 子进程会把该前缀全部过滤掉）', () => {
    expect(patch).not.toContain('DSH_DESKTOP_APP_EXECUTABLE =')
    expect(readRepoFile('src/browser-electron/index.ts')).not.toContain("'DSH_DESKTOP_APP_EXECUTABLE'")
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
