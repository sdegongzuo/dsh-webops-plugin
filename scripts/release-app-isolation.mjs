/** 固定基包的最小桌面升级：所有替换先验证唯一目标，源码取已登记补丁。 */
import ts from 'typescript'

export function portableSource(patch) {
  const header = 'diff --git a/apps/desktop/src/portable-data.ts b/apps/desktop/src/portable-data.ts'
  const start = patch.indexOf(header)
  if (start < 0) throw Error('构建补丁缺少 portable-data 源码')
  const end = patch.indexOf('\ndiff --git ', start + header.length)
  const section = patch.slice(start, end < 0 ? undefined : end)
  const lines = section.split(/\r?\n/u).filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1))
  const count = Number(section.match(/@@ -0,0 \+1,(\d+) @@/u)?.[1])
  if (lines.length !== count) throw Error('portable-data 新文件补丁长度不符')
  return lines.join('\n') + '\n'
}

export function overlayPortableMain(original, source) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const helper = compiled.replace(/^import .*;\r?\n/gmu, '').replace('export function configurePortableData', 'function configurePortableData')
  if (!helper.includes('function configurePortableData(') || /^(?:import|export) /mu.test(helper)) throw Error('隔离模块含未处理的导入或导出')
  let main = original
  const replace = (before, after) => {
    if (main.split(before).length !== 2) throw Error(`桌面基包替换目标必须唯一：${before.slice(0, 90)}`)
    main = main.replace(before, after)
  }
  replace('import { basename, delimiter, dirname, extname, isAbsolute, join, normalize, resolve, sep, win32 } from "node:path";',
    'import { basename, delimiter, dirname, extname, isAbsolute, join, normalize, parse, resolve, sep, win32 } from "node:path";')
  replace('if ((process.env.DSH_HOME ?? "").trim() === "") {\n\tconst portableHome = resolvePortableDshHome(process.execPath);\n\tif (portableHome !== void 0) process.env.DSH_HOME = portableHome;\n}',
    `${helper}\nconst portableHome = configurePortableData(app, process.execPath, process.env);`)
  replace('app.setAppLogsPath();', 'if (portableHome === undefined) app.setAppLogsPath();')
  replace('const loginShell = readDesktopLoginShellEnvironment(process.env, resolveDesktopLoginShellConfig(process.env), { signal: loginShellRead.signal }).then',
    'const loginShell = (portableHome === undefined ? readDesktopLoginShellEnvironment(process.env, resolveDesktopLoginShellConfig(process.env), { signal: loginShellRead.signal }) : Promise.resolve({environment:process.env,failures:[]})).then')
  replace('if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1") app.setAsDefaultProtocolClient("dsh");',
    'if (portableHome === undefined && (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1")) app.setAsDefaultProtocolClient("dsh");')
  return { main, compiled }
}

export function portableWorkspaceModule(original, patch) {
  const header = 'diff --git a/packages/api/workspace-controller/src/default-directory.ts '
  const start = patch.indexOf(header)
  if (start < 0) throw Error('构建补丁缺少默认工作区修改')
  const end = patch.indexOf('\ndiff --git ', start + header.length)
  const section = patch.slice(start, end < 0 ? undefined : end)
  const line = prefix => {
    const matches = section.split(/\r?\n/u).filter(value => value.startsWith(prefix) && value.includes('let directory ='))
    if (matches.length !== 1) throw Error('默认工作区补丁赋值必须唯一')
    return ts.transpileModule(matches[0].slice(1), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.trim()
  }
  const before = line('-'), after = line('+')
  if (original.split(before).length !== 2) throw Error('默认工作区替换目标必须唯一')
  return original.replace(before, after)
}
