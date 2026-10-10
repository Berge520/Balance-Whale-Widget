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
 * 只允许 Node 内置模块（fs / path / os / crypto）。
 * 自检手段：`node --test test/util.test.mjs` 必须**不挂任何 utools 桩**即可通过。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

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
    // ⚠️ os.homedir() 必须单独兜住，**不能**让异常混进「候选目录不存在」这条预期分支。
    // homedir() 在 Windows 上读 USERPROFILE / HOMEDRIVE+HOMEPATH，三者都被清掉时它会**抛错**
    // （Node 找不到家目录的行为）。早先这里裸调，异常被下面的 existsSync 循环整个吞掉 →
    // 候选表里少一项、函数返回 '' —— 而 '' 在全部调用方眼里等于「用户没配 DSH_HOME」，
    // 于是快照列表空、备份报「没有可备份的文件」、诊断假通过，全程零日志。
    // 这违反本模块的错误分流原则（D23 同款口径）：只有「目录确实不存在」能静默，
    // 「取不到家目录」是真故障。此处没法 require('./log')（D21 禁止），所以把兜底行为
    // 写死成「跳过这一项候选」—— 与原来相比行为不变，但候选表不再中途断掉。
    let home = ''
    try { home = os.homedir() } catch (_) { home = '' }
    if (home) cands.push(path.join(home, String(o.fallback || '')))
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
    // 与 homeDir 同款兜底：homedir() 可能抛（见上面 homeDir 里的注释）。
    // 取不到家目录就**不展开**，把 `~` 原样留着 —— 后续 existsSync 必然不命中，
    // 结果仍是「这个候选不可用」，但不会因为抛错掀掉整张候选表。
    let home = ''
    try { home = os.homedir() } catch (_) { home = '' }
    if (home) {
      if (p === '~') p = home
      else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2))
    }
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

// ── 文件写入 ──
// 原子写：同目录临时文件 → 写 → fsync → rename 覆盖目标。**失败时目标文件保持原样**。
//
// ⚠️ 为什么必须原子（2026-10-09）：本项目的三类写点都怕半写 ——
//   · dsh-backup 的 meta.json / manifest.json：半写 → 下一轮 listSnapshots 解析不出，
//     快照列表整体异常；
//   · settings.js 写 dsh 的 cordis.patch.yml：半写 = **用户的配置文件损坏**，
//     而 dsh 对读不懂的 patch 只往 stderr 打一行、退出码 0，不报错；
//   · dsh.js 的清单回滚：半写等于「回滚到一半」，配置比回滚前更坏。
//
// ⚠️ 三个实现要点，缺一个都不算原子（抄 dsh-export 的旧写法会漏掉前两点）：
//   1. 临时文件必须与目标**同目录** —— rename 跨卷会 EXDEV 失败；
//   2. 落盘前 fsync —— 只 rename 不 fsync 时，崩溃后目标可能是**空壳**
//      （目录项已指向新 inode，数据仍在页缓存里没落盘）；
//   3. 临时文件名要**进程内唯一** —— 只拼 pid 时同一进程并发两次写会互撞，
//      先写的被后写的截断。用 pid + 单调递增序号即可（无需随机数）。
//
// 失败路径必须清掉临时文件：否则 dsh-backup 目录里会积一堆
// `meta.json.<pid>.<n>.tmp`，还会被 listSnapshots 的目录扫描看到。
//
// 返回 { ok, error }；**不抛异常**，与 readTextSafe 同款口径（本模块不 require log，留痕在调用方）。
let atomicSeq = 0
// 临时文件名的构造**单独抽成一个函数并导出**：原子写把「写目标文件」换成了
// 「写临时文件 + rename」，于是**直接替换 fs.writeFileSync 的故障注入失效了**
// （测试再也拦不到主写，只会看到「成功」的假绿）。留这个接缝，测故障路径时替换它即可
// —— 比照 fs 内部成员构造可预测的失败靠谱得多。默认实现就是本文件要用的那条路径。
//
// ⚠️ 调用点必须走 `module.exports.atomicTmpPath(...)` 这个**间接层**，不能裸调本函数，
//    也不能走 `exports.`：本文件末尾是 `module.exports = {...}` **整体替换** ——
//    整体替换后模块内的 `exports` 仍指向被丢弃的旧对象，写 `exports.x` 在运行时拿到
//    undefined（实测报错 "exports.atomicTmpPath is not a function"）。而裸调又绑死在
//    定义时那个函数上，测试替换导出属性对它无效。改从 module.exports 上按调用时取一次：
//    导出对象是可变的，测试替换 `require('util').atomicTmpPath` 就真的改到主写的行为。
function atomicTmpPath(file) {
  return String(file) + '.' + process.pid + '.' + (atomicSeq++) + '.tmp'
}
function writeFileAtomicSync(file, data, encoding) {
  const target = String(file || '')
  if (!target) return { ok: false, error: 'no-path' }
  const enc = encoding || 'utf8'
  let tmp = ''
  let fd = -1
  try {
    // 从 module.exports 取（函数声明已被提升，此时导出对象已填好）—— 见上方注释
    tmp = module.exports.atomicTmpPath(target)
    fd = fs.openSync(tmp, 'w')
    fs.writeFileSync(fd, data, enc)
    // fsync 必须在 close 之前，且要和 rename 一起构成「要么全有要么全无」
    try { fs.fsyncSync(fd) } catch (_) { /* 部分文件系统/Node 版本上 fsync 不可用，不致命 */ }
    fs.closeSync(fd)
    fd = -1
    fs.renameSync(tmp, target)
    return { ok: true, error: '' }
  } catch (err) {
    if (fd >= 0) { try { fs.closeSync(fd) } catch (_) {} }
    if (tmp) { try { fs.unlinkSync(tmp) } catch (_) {} }
    return { ok: false, error: errMsg(err, 'unknown') }
  }
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

// ── 错误消息 ──
// 把各种形态的错误收敛成**可读的一行文案**，供日志 / 悬浮窗 / 设置页提示统一使用。
//
// ⚠️ 口径必须与项目里已有的 7 份本地拷贝（backup / assets / assets-packs / dsh-backup /
// dsh-market / dsh-export / skin-packs）逐字一致：err → err.message → 原值 → '未知错误'。
// 早先这 7 份 + 上百处内联 `(err && err.message) || err` 各自实现，出错文案在
// 「未知错误 / [object Object] / 空串」之间漂移，用户看不懂。提取到此处收口。
function errMsg(err, fallback) {
  return String((err && err.message) || err || (fallback === undefined ? '未知错误' : fallback))
}

// ── 哈希 ──
// ⚠️ 只做**字节版**（Buffer / 字符串按 utf8 交给 crypto）。
// dsh-backup 那份是**文本版**（内部先 String(text) 再算），语义不同，**保留在调用方**，
// 由它把 String(text) 之后的结果传进来 —— 不在这里加文本分支，否则同一个 sha256
// 出现两种行为，出问题时更难定位（备份去重会静默失准）。
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// ── 时间戳 ──
// 文件名用的紧凑时间戳，**三种精度**必须用参数区分（历史上分别是三份本地实现）：
//   'min'（默认）→ 20260922-2142     资产 / 备份 / 导出
//   'sec'        → 20260922-214243   快照（同一分钟内多次操作要能区分）
//   'day'        → 2026-09-22        仅日期，分隔符是 '-'（走 dayKeyFromTs 口径）
function stamp(ts, precision) {
  const d = ts === undefined ? new Date() : new Date(Number(ts))
  const p2 = (n) => String(n).padStart(2, '0')
  if (precision === 'day') return dayKeyFromTs(d.getTime())
  const ymd = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
  const hm = p2(d.getHours()) + p2(d.getMinutes())
  return precision === 'sec' ? ymd + '-' + hm + p2(d.getSeconds()) : ymd + '-' + hm
}

// ── 时间展示 ──
// 时间戳 → 'HH:mm'（本地时区）。设置页多处「条目/刷新时间」列都手写过 p2 拼装，
// 统一到这里。注意：只负责 HH:mm 这一段，调用方若要拼更长的格式（如 'M-D HH:mm'）
// 自行在两侧拼接，不要指望本函数带上日期。
function hhmm(ts) {
  const d = new Date(Number(ts))
  const p2 = (n) => String(n).padStart(2, '0')
  return p2(d.getHours()) + ':' + p2(d.getMinutes())
}

// atomicTmpPath 保持原样导出：主写是**按调用时从 module.exports 取**，
// 所以测试替换 `require('util').atomicTmpPath` 会紧接着影响下一次主写。
module.exports = {
  num,
  errMsg,
  sha256,
  stamp,
  hhmm,
  dayKeyFromTs,
  dayAdd,
  homeDir,
  readTextSafe,
  readText,
  readJsonSafe,
  writeFileAtomicSync,
  atomicTmpPath,
  walkDir,
  normalizePath,
}
