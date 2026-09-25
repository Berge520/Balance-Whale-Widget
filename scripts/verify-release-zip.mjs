/*
 * Release zip 资产核对
 *
 * 用法：node scripts/verify-release-zip.mjs <下载目录> <zip 名> <期望版本>
 *
 * 由 scripts/release.mjs 在 Release 建好后调用，也可以手动跑（需要先 gh release download）。
 *
 * 核对三件事，任一不过退出码非 0：
 *   1. plugin.json 在 zip 顶层（uTools 开发者工具要入口目录指向解压后的目录）
 *   2. plugin.json 的 version 与本次发布的版本一致（防 prebuild 同步漏掉 / 拿错产物）
 *   3. preload 关键文件在位（preload 不参与 Vite 打包，原样复制，缺了插件起不来）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const [zipDir, zipName, expectVersion] = process.argv.slice(2)
if (!zipDir || !zipName || !expectVersion) {
  console.error('用法：node scripts/verify-release-zip.mjs <下载目录> <zip 名> <期望版本>')
  process.exit(1)
}

// 用 Node 内置能力解 zip 要走第三方库；这里改为「下载 + 解压」都交给 gh / 系统工具，
// 只用 Node 读解压后的文件，避免为一次校验引入依赖。
mkdirSync(zipDir, { recursive: true })

// gh 在 Windows 上是 .cmd，不带 shell 会 ENOENT；带上 shell 就不能再传参数数组
// （Node 24 起报 DEP0190），所以整条命令拼成字符串
const dl = spawnSync(
  ['gh', 'release', 'download', `v${expectVersion}`, '-p', '*.zip', '-D', `"${zipDir}"`, '--clobber'].join(' '),
  { stdio: 'inherit', shell: true }
)
if (dl.status !== 0) {
  console.error(`[verify-release-zip] ✗ 下载 v${expectVersion} 的 zip 失败`)
  process.exit(1)
}

const zipPath = path.join(zipDir, zipName)

// -p '*.zip' 会把 Release 上的**所有** zip 都拉下来；多出一个（发错资产 / 遗留旧包）时，
// 只按 zipName 取用会静默通过，而用户下到的可能是错的包。这里把实际拉到的 zip 列清楚比对。
const strayZips = readdirSync(zipDir).filter((f) => f.toLowerCase().endsWith('.zip') && f !== zipName)
if (strayZips.length) {
  console.error(`[verify-release-zip] ✗ Release 里除 ${zipName} 外还有其它 zip：${strayZips.join(', ')}；请确认资产是否正确`)
  process.exit(1)
}
if (!existsSync(zipPath)) {
  console.error(`[verify-release-zip] ✗ 下载目录里没有 ${zipName}`)
  process.exit(1)
}

// 解压优先 unzip，Windows 上没有就退回 tar（Win10+ 自带 bsdtar，能解 zip）。
// 两条都失败才报错 —— 单独试一条会在缺工具时打印刺眼的「不是内部或外部命令」。
const outDir = path.join(zipDir, 'extracted')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const extract = [
  ['unzip', ['-q', '-o', zipPath, '-d', outDir]],
  ['tar', ['-xf', zipPath, '-C', outDir]],
]
let extracted = false
for (const [cmd, args] of extract) {
  // stdio 全丢：工具不存在 / 解压失败都由这里吞掉，只看 exit code
  const r = spawnSync([cmd, ...args].join(' '), { stdio: 'ignore', shell: true })
  if (r.status === 0) { extracted = true; break }
}
if (!extracted) {
  console.error(`[verify-release-zip] ✗ unzip / tar 均无法解压 ${zipName}`)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const pluginPath = path.join(outDir, 'plugin.json')
// 缺文件 / JSON 坏时给出可操作的诊断，而不是裸的「Cannot find module」——
// 这条校验本身就是为了在产物不对时把话说清楚，报错本身先说清才有意义
if (!existsSync(pluginPath)) {
  console.error(`[verify-release-zip] ✗ 解压目录里没有 plugin.json（${pluginPath}）；zip 结构不对或解压不完整`)
  process.exit(1)
}
let plugin
try {
  plugin = require(pluginPath)
} catch (e) {
  console.error(`[verify-release-zip] ✗ plugin.json 无法解析：${(e && e.message) || e}`)
  process.exit(1)
}
const errors = []

if (plugin.version !== expectVersion) {
  errors.push(`plugin.json 版本是 ${plugin.version}，期望 ${expectVersion}`)
}

// preload 是插件跑起来的最小集合：入口 + 悬浮窗 preload + lib 下被 require 的实现
const mustHave = ['preload/services.js', 'preload/floating.js', 'preload/lib/hosts.js', 'index.html']
for (const rel of mustHave) {
  if (!existsSync(path.join(outDir, rel))) errors.push(`缺少 ${rel}`)
}

if (errors.length) {
  console.error('[verify-release-zip] ✗ 核对失败：')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`[verify-release-zip] ✓ plugin.json 顶层且版本 ${expectVersion}，${mustHave.length} 个关键文件在位`)
