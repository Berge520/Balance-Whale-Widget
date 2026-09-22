/*
 * 跨模块通用小工具（CommonJS，叶子模块 / 依赖边界硬约束）。
 *
 * 存在的理由（D18）：dsh-usage.js 与 codex.js 原本各自实现了一份逐字相同的
 * dayKeyFromTs / dayAdd，dshHome / codexHome 也是同一个模式复制了两遍。
 * 诊断（diagnostics.js）还要用第三遍，所以一次性提取到这里。
 *
 * ⚠️ 依赖边界（D21，硬禁令）——违反会让单测在 require 阶段就崩，而构建不会拦下：
 *   1. 禁止 require('./log')      —— log.js 依赖 utools，require 即触碰宿主
 *   2. 禁止 require('utools')     —— 本模块必须能在纯 Node 下加载
 *   3. 禁止 require('./constants') —— PLUGIN_VERSION 由构建脚本写入，引入会形成耦合
 * 只允许 Node 内置模块（fs / path / os）。
 * 自检手段：`node --test test/util.test.mjs` 必须**不挂任何 utools 桩**即可通过。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

// ── 数值 ──
// 任何读进来的数都可能是 undefined / null / 'abc'，统一收敛成有限数值
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ── 日期 ──
// 时间戳 → 'YYYY-MM-DD'（本地时区，用户在 Asia/Shanghai）
function dayKeyFromTs(ts) {
  const d = new Date(Number(ts))
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}

// 日期字符串 ±天数 → 'YYYY-MM-DD'
function dayAdd(base, delta) {
  const d = new Date(base + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return dayKeyFromTs(d.getTime())
}

// ── 目录定位 ──
// 环境变量优先 + 回退，取第一个**实际存在**的候选目录；都不存在返回 ''
//
// target：唯一必需的参数，单目录场景直接传目录名，如 'DSH_HOME'
//   { env: 'DSH_HOME', fallback: '.dsh' }  等价写法（向后兼容）
//   { candidates: [绝对路径, ...] }         直接给候选，跳过 env 推导
//
// ⚠️ expand / relative（D22，保守合并）：
// dshHome() 原本支持 `~` 展开、且把相对路径按 cwd 解析；codexHome() 原本**都不支持**
// （相对路径直接拿去 existsSync，不命中就回退）。合并成一个函数时若统一按最全那套走，
// 等于**静默改变** codexHome 的行为（把 CODEX_HOME 设成相对路径或 `~` 的用户会突然命中别处）。
// 所以两者都做成可选，**默认一律 false**，由调用方各自 opt-in：
//   · expand   —— 是否展开开头的 `~` / `~/` / `~\`
//   · relative —— expand 展开后仍非绝对路径时，是否按 cwd 解析
// true（dshHome 显式传）沿用 dshHome 口径；false（默认，codexHome 不传）沿用 codexHome 口径：
// 原样丢给 existsSync。
function homeDir(target, opts) {
  // 两种调用形态：homeDir('DSH_HOME') 与 homeDir({ env: 'DSH_HOME', fallback: '.dsh' })。
  // 判据必须是 typeof —— 早期版本用 `opts && typeof opts === 'object'` 判断，
  // 结果 homeDir({env}) 走进 target 分支、把对象字符串化成 "[object Object]"，
  // 表现为「目录恒不存在」（codex 统计整卡失效且不报错）。
  const o = (target && typeof target === 'object') ? target : ((opts && typeof opts === 'object') ? opts : {})
  const cands = []
  if (Array.isArray(o.candidates)) {
    for (const c of o.candidates) cands.push(String(c || ''))
  } else {
    const envKey = String(o.env || '')
    const envVal = envKey ? String(process.env[envKey] || '').trim() : ''
    if (envVal) cands.push(expandHome(envVal, o))
    cands.push(path.join(os.homedir(), String(o.fallback || '')))
  }
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c } catch (_) {}
  }
  return ''
}

// `~` / `~/x` / `~\x` → 家目录；其余原样返回（相对路径按 relative 决定是否接 cwd）
//
// ⚠️ expand 的默认值是 **false**（不展开），不是「除显式 false 外都展开」。
// 原实现写成 `o.expand !== false`，于是「没传 expand」= 展开 —— 而 codexHome() 恰恰
// 是「不传 expand 且原本不展开」，两者语义正好相反：CODEX_HOME 设成 `~/x` 的用户
// 会从「读不到、回退 ~/.codex」变成「静默读到 ~/x」，是本模块最隐蔽的一处行为改变。
// 显式判 `=== true` 才能让「不传」与「传 false」等价。
function expandHome(raw, o) {
  let p = raw
  if (o.expand === true) {
    const home = os.homedir()
    if (p === '~') p = home
    else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2))
  }
  if (path.isAbsolute(p)) return p
  return o.relative === true ? path.join(process.cwd(), p) : p
}

// ── 文件读取 ──
// 安全读文本：读失败返回 fallback，不抛异常
//
// ⚠️ 错误分流（D23）：只有 ENOENT（文件不存在）是**预期分支**，静默即可 ——
// 「没配这个文件」在诊断里是正常状态，不该刷日志。
// 其余（EACCES / EISDIR / EMFILE / 超长等）是**真故障**，静默会把错误归因带偏
// （诊断报「缺失」实际是「读不到」），所以必须返回 reason 让调用方留痕。
// 本模块不 require log.js（D21），留痕责任在调用方。
function readTextSafe(file, fallback) {
  const fb = fallback === undefined ? null : fallback
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8'), reason: '' }
  } catch (err) {
    const code = String((err && err.code) || '')
    // ENOENT / ENOTDIR 都是「路径上压根没有」，属于预期分支
    const expected = code === 'ENOENT' || code === 'ENOTDIR'
    return { ok: false, text: fb, reason: expected ? '' : (code || String((err && err.message) || 'unknown')) }
  }
}

// 安全读 UTF-8 文本，失败直接给 fallback 字符串。适用于「读不到就当没有」的场景。
function readText(file, fallback) {
  try { return fs.readFileSync(file, 'utf8') } catch (_) { return fallback === undefined ? '' : fallback }
}

// 安全读 JSON：解析失败 / 读不到都返回 null
function readJsonSafe(file) {
  const r = readTextSafe(file)
  if (!r.ok) return null
  try {
    const o = JSON.parse(r.text)
    return o && typeof o === 'object' ? o : null
  } catch (_) { return null }
}

// ── 目录遍历 ──
// 递归列出文件，返回**绝对路径数组**
//
// match：可选，RegExp 或 (name) => boolean；不给则所有文件都收
// maxDepth：默认 6（沿用 codex.js 原有上限）
// opts.sort：默认 true。walk 依赖 readdirSync 的目录顺序，在不同文件系统上不稳定；
//   排序后同一批文件每轮顺序一致，「预算用尽时优先处理哪些」才有确定行为。
// opts.silent：默认 true（读不到的子目录直接跳过）。诊断场景需要区分 EACCES 与
//   「真的没有」，此时传 false，会收集 { dir, reason } 到返回值的 errors 里。
function walkDir(root, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const maxDepth = Number.isFinite(o.maxDepth) ? o.maxDepth : 6
  const match = o.match
  const silent = o.silent !== false
  const out = []
  const errors = []
  const hit = (name) => {
    if (!match) return true
    if (match instanceof RegExp) return match.test(name)
    if (typeof match === 'function') return !!match(name)
    return true
  }
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let ents = []
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (!silent) errors.push({ dir, reason: String((err && err.code) || (err && err.message) || 'unknown') })
      return
    }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (hit(e.name)) out.push(p)
    }
  }
  walk(root, 0)
  if (o.sort !== false) out.sort()
  return { files: out, errors }
}

// ── 路径展示 ──
// 仅用于**界面展示**的路径整形：统一分隔符、收敛多余的 `.` / `..`。
//
// ⚠️ 刻意**不**调用 fs.realpathSync（D25）：realpathSync 不归一化大小写，
// Windows（大小写不敏感 + junction + 8.3 短名）与 macOS（APFS 保留大小写）
// 下拿同一目录会得到不同字符串。任何「靠路径字符串相等来判断是不是同一个东西」
// 的判据在这两个平台上都会静默漏报，所以本项目的 C1 判据已改为包身份指纹。
function normalizePath(p) {
  const raw = String(p || '')
  if (!raw) return ''
  // path.resolve 在 Windows 上会统一成正斜杠前的反斜杠，但大小写保持原样（有意）
  return path.resolve(raw)
}

module.exports = {
  num,
  dayKeyFromTs,
  dayAdd,
  homeDir,
  readTextSafe,
  readText,
  readJsonSafe,
  walkDir,
  normalizePath,
}
