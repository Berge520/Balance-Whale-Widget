/*
 * 文档↔代码引用体检：文档里写 `focus.recordRound` / `store.readFoo` 这类「模块.符号」时，
 * 那个符号必须真的还在 public/preload/lib/<模块>.js 里导出或声明。
 *
 * 为什么需要：专注账本从「倒计时走完记一轮」改成会话模型（v2）时，`focus.recordRound` 已经删掉，
 * 但 README、docs/spec/*、.trae/rules 里还留着它和 `whale:focus {minutes}` 的旧契约 ——
 * 照着文档改代码的人会去找一个不存在的函数。这类漂移没有报错，只能靠门禁拦住。
 *
 * 判据只认「声明」：module.exports 的键、`exports.X =`、顶层 `function X(` / `const X` / `let X`。
 * 注释里提一次不算存在，否则文档可以靠抄注释混过去。
 *
 * 已知会误报的形态，都在 scan 里跳过：`focus.js` / `store.mjs` 这类文件名（后面跟扩展名）、
 * `x.y` 里 y 不是驼峰/下划线函数名的情况不特殊处理 —— 命中即查，查不到就报，宁可多看一眼。
 *
 * 用法：node scripts/check-doc-refs.mjs          # 只打印，不拦（exit 0）
 *       node scripts/check-doc-refs.mjs --fail   # 有失效引用则 exit 1（已挂 prebuild）
 * 自检：test/check-doc-refs.test.mjs（纯函数直调，不读真实仓库）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(process.env.DR_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const LIB_DIR = path.join('public', 'preload', 'lib')
const DOC_FILES = [
  'README.md',
  '.trae/rules/project_rules.md',
  '.trae/market/utools-market.md',
]

function docMdFiles(dir) {
  const out = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...docMdFiles(full))
    else if (e.name.endsWith('.md')) out.push(full)
  }
  return out
}

// 模块源里「真实存在」的符号名
function declaredNames(src) {
  const names = new Set()
  for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1])
  for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  for (const m of src.matchAll(/exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1])
  // module.exports = { a, b, c } / { a: fn } —— 只在块内取键
  const me = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/)
  if (me) {
    for (const m of me[1].matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*(?::|,|\s|$)/gm)) names.add(m[1])
  }
  return names
}

const EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'mts', 'vue', 'md', 'json', 'css', 'html', 'py', 'yml', 'yaml'])

// 只查这几个模块：文档里写 `focus.X` / `store.X` / `ipc.X` 就是在指「这个 lib 导出的符号」。
// 其余模块名同时是别的名词（`dsh.port` 是状态字段、`api.deepseek` 是厂商、`skins.test.mjs` 是文件名），
// 一并扫会刷出一片误报，噪声 gate 会被下一个改文档的人直接关掉 —— 宁可窄而准。
const CHECKED = ['focus', 'store', 'ipc']

// 文件名 / 路径先抹掉：`store.test.mjs`、`focus.js`、`docs/spec/06-storage.md` 都不算符号引用
function scrub(text) {
  return text.replace(/[\w./-]*\.[A-Za-z][A-Za-z0-9]*/g, (m) =>
    EXT.has(m.split('.').pop()) ? ' ' : m)
}

// 从文档正文里抽「模块.符号」引用
function docRefs(text, modules) {
  const hits = []
  const seen = new Set()
  for (const m of scrub(text).matchAll(/(^|[^\w$.])([a-z][\w-]*)\.([A-Za-z_$][\w$]*)/gm)) {
    const mod = m[2]
    const sym = m[3]
    if (!modules.has(mod)) continue
    if (EXT.has(sym)) continue
    const key = `${mod}.${sym}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push({ mod, sym, at: m.index })
  }
  return hits
}

function loadModules() {
  const mods = new Map()
  const dir = path.join(root, LIB_DIR)
  let files = []
  try { files = fs.readdirSync(dir) } catch { return mods }
  for (const f of files) {
    if (!f.endsWith('.js')) continue
    const name = f.slice(0, -3)
    if (!CHECKED.includes(name)) continue
    mods.set(name, declaredNames(fs.readFileSync(path.join(dir, f), 'utf8')))
  }
  return mods
}

function collectDocs() {
  const files = DOC_FILES.map((f) => path.join(root, f))
  files.push(...docMdFiles(path.join(root, 'docs')))
  return files.filter((f) => fs.existsSync(f))
}

const fail = process.argv.includes('--fail')
const mods = loadModules()
if (!mods.size) {
  console.warn('[doc-refs] ⚠ 拿不到 public/preload/lib，本关跳过')
  process.exit(0)
}

const missing = []
for (const f of collectDocs()) {
  const text = fs.readFileSync(f, 'utf8')
  for (const r of docRefs(text, new Set(mods.keys()))) {
    if (!mods.get(r.mod).has(r.sym)) {
      missing.push({ rel: path.relative(root, f), ref: `${r.mod}.${r.sym}` })
    }
  }
}

if (!missing.length) {
  console.log('[doc-refs] 文档里的「模块.符号」引用全部对得上')
  process.exit(0)
}

const uniq = [...new Set(missing.map((x) => `${x.ref}（${x.rel}）`))]
console.error(`[doc-refs] ${fail ? '✗' : '⚠'} ${uniq.length} 处引用在代码里不存在：`)
for (const u of uniq) console.error(`  - ${u}`)
console.error('  要么文档写的是已退役的名字（改文档），要么符号被删/改名（改代码或补引用）。')
process.exit(fail ? 1 : 0)
