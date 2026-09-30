/*
 * Release zip 资产核对
 *
 * 用法：node scripts/verify-release-zip.mjs <下载目录> <zip 名> <期望版本>
 *
 * 由 scripts/release.mjs 在 Release 建好后调用，也可以手动跑（需要先 gh release download）。
 *
 * 核对四件事，任一不过退出码非 0：
 *   1. plugin.json 在 zip 顶层（uTools 开发者工具要入口目录指向解压后的目录）
 *   2. plugin.json 的 version 与本次发布的版本一致（防 prebuild 同步漏掉 / 拿错产物）
 *   3. preload 关键文件在位（preload 不参与 Vite 打包，原样复制，缺了插件起不来）
 *   4. 内置形象素材包（skins-pack.whaleassets）在 Release 资产里
 *      （已移出插件包，靠它按需下载；漏了 = 下载形象功能 404）
 *      注：共享角色 / 音效自 v1.9.0 起改为 public/shared/ 单张直链（入库），不再是 Release 资产
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
// （Node 24 起报 DEP0190），所以整条命令拼成字符串。
// 同时拉 zip 与素材包（两个 -p）：素材包也是要核对的资产，见下方 packName。
const dl = spawnSync(
  ['gh', 'release', 'download', `v${expectVersion}`, '-p', '*.zip', '-p', '*.whaleassets', '-D', `"${zipDir}"`, '--clobber'].join(' '),
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

// 内置形象素材包：插件包内已不含那些可下载形象（v1.8.0 起仅 1 张），用户点「下载形象」时是从
// releases/latest/download/skins-pack.whaleassets 拉的。这个资产漏传 / 名字写错，
// 功能会整体 404，而 zip 本身完全正常 —— 所以必须单独核对它与那份 sha256。
const packNames = ['skins-pack.whaleassets']
for (const name of packNames) {
  if (!existsSync(path.join(zipDir, name))) {
    console.error(`[verify-release-zip] ✗ Release 里没有素材包 ${name}；对应下载功能会 404`)
    process.exit(1)
  }
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

// 内置资源缩略图必须随包（设置页按 './whale-pack/thumbs/<id>.webp' 加载）。
// 曾因整目录排除 whale-pack/ 导致这批缩略图 404 —— 但设置页与它不在同一个 chunk，
// zip 本身依然「结构正确」，所以专门钉一条。
if (!existsSync(path.join(outDir, 'whale-pack', 'thumbs'))) {
  errors.push('缺少 whale-pack/thumbs/；设置页「内置资源」缩略图会显示不出来')
}
// 反过来：那 0.94MB 的素材包本体与构建中间产物不该被塞回插件包（否则瘦身白做）
for (const rel of ['whale-pack/skins-pack.whaleassets', 'whale-pack/manifest.json']) {
  if (existsSync(path.join(outDir, rel))) errors.push(`不该随包：${rel}`)
}

// 全量扫垃圾文件。上面几条都是「点名式」检查，只能拦住写死的路径；这条是兜底。
//
// 为什么需要：打包是 `cd dist && zip -qr ... .`（release.yml），**dist 里有什么就打什么**；
// 而 dist 的内容由 vite.config.js 的 copyPublicExceptSkip 从 public/ 递归原样拷贝，
// 排除清单里只有 2 个文件 + 1 个目录，**没有任何「排除垃圾文件」的规则**。于是路径是：
// 在 public/preload/lib/ 下留一个 api.js.bak → 原样进 dist/ → 打进 zip → 用户包里带着它。
// .gitignore 里的 *.bak 挡不住这条路（它只管 git 层，dist/ 是构建产物、不进 git）。
// 上游 DeepSeek-Balance-Whale-Widget 正是这么翻车的（lib/index.js.bak-devpaths 被打进包）。
//
// 用后缀黑名单而非白名单：产物核对宁可多报，漏放一个备份文件进发行版是实打实的泄底。
// .map 一并纳入 —— 当前 vite 生产构建不产 sourcemap（实测 dist 里 0 个），
// 所以这条是零成本的哨兵：谁哪天开了 build.sourcemap，这里当场红。
const JUNK_SUFFIXES = ['.bak', '.orig', '.tmp', '.log', '.swp', '.map', '~']
const JUNK_NAMES = new Set(['thumbs.db', '.ds_store', 'desktop.ini'])
const junk = []
const scanJunk = (dir, rel) => {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) { scanJunk(path.join(dir, ent.name), childRel); continue }
    const lower = ent.name.toLowerCase()
    if (JUNK_SUFFIXES.some((s) => lower.endsWith(s)) || JUNK_NAMES.has(lower)) junk.push(childRel)
  }
}
scanJunk(outDir, '')
if (junk.length) {
  errors.push(`zip 里混入了本机垃圾文件（多半是 public/ 下的残留被原样拷进了 dist/）：${junk.join(', ')}`)
}

if (errors.length) {
  console.error('[verify-release-zip] ✗ 核对失败：')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`[verify-release-zip] ✓ plugin.json 顶层且版本 ${expectVersion}，${mustHave.length} 个关键文件在位，素材包 ${packNames.join(' / ')} 在 Release 里`)
