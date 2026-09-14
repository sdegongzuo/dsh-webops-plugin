/**
 * 出货 patch 的守卫测试。
 *
 * 2026-09-14 事故：`cordis.patch.yml` 里带着 keyless 验证用的 `fake-llm` 行一起发版，
 * 而这个插件的 `llm/stream` 监听器在 waterfall 里不调 `next()` —— 装上它的每个用户的
 * 真实对话都会被替换成脚本回放。类型检查、单测、CI 构建**全都不会**发现这种事：
 * 那一行是「合法配置」，插件也是「合法加载」。
 *
 * 所以这里直接对**文件内容**断言两件事：
 *   1. 出货 patch 里绝不能出现会接管 llm/stream 的行；
 *   2. 开发专用 overlay 里必须还留着那一行 —— 否则 keyless 验证链路会静默失效。
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
