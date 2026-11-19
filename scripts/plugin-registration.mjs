/**
 * 出厂 profile 里「本插件怎么登记」的唯一真相源。
 *
 * 为什么需要它（2026-11-19 实测定位）：宿主的「安装插件」动作 `install_bundle` 就是
 * profile 目录里的 `pnpm add <spec>`，会**全量解析** profile 的 dependencies。本插件是
 * 本地构建产物、从未发布到 registry，所以登记写精确版本号（`"0.2.28"`）时，任何一次
 * 安装其它插件都会去 registry 拉它并 404。出厂登记因此改成 `file:` 相对路径，指向包根
 * `vendor\` 里那份不可变 tarball。
 *
 * 这段字面量原本散落在三个打包脚本、两个门禁脚本、单测和文档里共七八处，改一处漏三处
 * 的风险太高 —— 收敛到这里。**唯一允许拼接这条路径的地方就是本文件。**
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** profile 目录（`<包根>/home/profiles/desktop`）上三级回到包根，所以相对路径固定是这一段。 */
const SPEC_PREFIX = 'file:../../../vendor/'

export function pluginTarballName(pluginName, version) {
  return `${pluginName}-${version}.tgz`
}

export function pluginFileSpec(pluginName, version) {
  return `${SPEC_PREFIX}${pluginTarballName(pluginName, version)}`
}

/** 登记值是否是「本插件指向包内 tarball」的 file: 写法（不校验文件是否真的存在）。 */
export function isPluginFileSpec(spec, pluginName, version) {
  return spec === pluginFileSpec(pluginName, version)
}

/**
 * 用 Python 的 tarfile 读 tarball 元信息。node 没有内置 tar，而 CI 与本机都有 python
 * （unzip-portable.py 已依赖它）。返回 { version, hasIndex, hasPatch, hasFakeLlm, indexSha }。
 */
export function inspectPluginTarball(tarballPath) {
  const result = spawnSync('python', ['-c',
    'import hashlib,json,sys,tarfile\n'
    + 't = tarfile.open(sys.argv[1]); names = set(t.getnames())\n'
    + 'print(json.dumps({\n'
    + '  "version": json.loads(t.extractfile("package/package.json").read())["version"],\n'
    + '  "hasIndex": "package/lib/index.js" in names,\n'
    + '  "hasPatch": "package/cordis.patch.yml" in names,\n'
    + '  "hasFakeLlm": any(n.startswith("package/lib/fake-llm") for n in names),\n'
    + '  "indexSha": hashlib.sha256(t.extractfile("package/lib/index.js").read()).hexdigest(),\n'
    + '}))', tarballPath], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || (result.error instanceof Error ? result.error.message : '未知错误')
    throw Error(`插件 tarball 读不出来（${tarballPath}）：${detail}`)
  }
  return JSON.parse(result.stdout)
}

/**
 * 检查一个出厂包（解压后的便携目录）里本插件的登记与 tarball 是否自洽。
 * 不抛错，返回 problems 数组由调用方决定是 fail-fast 还是累计报告。
 *
 * `root` 是便携包根，`profileManifest` 是该包 `home/profiles/<name>/package.json` 的内容。
 * `profileDir` 可显式传入（`verify-portable --profile` 支持自定义 profile 名）。
 */
export function checkPluginRegistration({ root, pluginName, version, profileManifest, profileDir: explicitProfileDir }) {
  const problems = []
  const tarballName = pluginTarballName(pluginName, version)
  const tarballPath = join(root, 'vendor', tarballName)
  const expected = pluginFileSpec(pluginName, version)
  const registered = profileManifest?.dependencies?.[pluginName]
  const profileDir = explicitProfileDir ?? join(root, 'home', 'profiles', 'desktop')

  if (!existsSync(tarballPath)) {
    problems.push(`出厂包缺少插件 tarball：vendor/${tarballName}`)
    return { tarballName, tarballPath, expected, info: undefined, problems }
  }
  if (registered !== expected) {
    problems.push(`本插件登记必须是 ${expected}（实际：${String(registered)}）`)
    return { tarballName, tarballPath, expected, info: undefined, problems }
  }
  // 「字符串相等」不够：期望值与写入方用的是同一个字面量，一起写错会一起通过。
  // 再按 Node 的 path 语义解析一次，必须正好落在包内这份 tgz 上。
  const resolved = resolve(profileDir, registered.slice('file:'.length))
  if (resolved !== resolve(tarballPath)) {
    problems.push(`登记的相对路径没指到包内 tarball：解析为 ${resolved}，实际应为 ${resolve(tarballPath)}`)
  }

  let info
  try {
    info = inspectPluginTarball(tarballPath)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
    return { tarballName, tarballPath, expected, info: undefined, problems }
  }
  if (info.version !== version) problems.push(`tarball 内版本是 ${String(info.version)}，与发布版本 ${version} 不一致`)
  if (!info.hasIndex || !info.hasPatch) {
    problems.push('tarball 缺 lib/index.js 或 cordis.patch.yml（残包：装上去会缺 ptc patch）')
  }
  if (info.hasFakeLlm) problems.push('tarball 含 fake-llm 测试模块')

  // 两条独立生成路径（插件 ZIP → node_modules / tarball）必须同源：残包或分叉的后果是
  // 用户第一次 install_bundle 就把本来正常的插件覆盖成另一份代码。
  const shippedIndex = join(profileDir, 'node_modules', pluginName, 'lib', 'index.js')
  if (existsSync(shippedIndex)) {
    const sha = createHash('sha256').update(readFileSync(shippedIndex)).digest('hex')
    if (sha !== info.indexSha) {
      problems.push('tarball 与出厂 node_modules 的 lib/index.js 不一致（两条生成路径已分叉，重装会换掉插件代码）')
    }
  }

  return { tarballName, tarballPath, expected, info, problems }
}
