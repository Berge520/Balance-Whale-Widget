/*
 * dsh 配置备份 / 可撤销机制（CommonJS）—— 计划书 §6.2 E1。
 *
 * 定位：这是**所有写入操作的前置设施**（E2 禁用/启用、E3 一键隔离、E4 快照回滚都依赖它）。
 * 本模块只做「文件系统层面的快照 / 列表 / 还原 / 清理」，不含任何业务判断，
 * 也不知道「某个插件的 id 是什么」—— 那是 E2 的事。
 *
 * ── 为什么不复用 lib/backup.js ──
 * 那个模块导出的是**挂件自身数据**（设置/账本/窗口位置），面向用户手选的 .json 路径；
 * 这里备的是**用户 ~/.dsh 下的配置文件**，面向固定目录 + 多份轮转。两者受众、
 * 生命周期、失败影响面都不同，合并只会让任一侧的改动波及另一侧。
 *
 * ── 三个必须记住的实测结论（spec §10.3 第 ⑤ 段，v1.6.2 V1–V4 核验）──
 *   V2：写入不存在的 id 时 dsh **只往 stderr 打一行 `patch: entry "X" not found`**，
 *       退出码 0、启动照常 —— 即「写坏了也不会报错」。所以备份必须能被**独立校验**
 *       （manifest 里的 sha256 就是干这个的），不能指望 dsh 兜底。
 *   V4：dsh 的 patchReload 是**单向**的 —— 加 `disabled` 即时生效，**删掉不恢复**。
 *       所以「撤销」必须走**整文件覆盖还原**，而不是「把某一行删掉」。
 *   V3：用户层 patch 是**行级追加**（`- id: X` + `disabled: true`）。整文件覆盖
 *       天然兼容行级改动 —— 因为覆盖回去的就是改动前的完整内容。
 *
 * ── 安全边界（E4 同款硬约束）──
 * 快照**绝不包含** `.credentials.yaml` 等凭据文件。本模块用**白名单**（BACKUP_FILES）
 * 而不是黑名单：dsh 目录下未来新增什么敏感文件，只要不在白名单里就不会被备走。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { log, logErr } = require('./log')
const { homeDir, readTextSafe } = require('./util')
// 只读配置（取保留份数）。store 不 require 本模块，无循环引用
const { readConfig } = require('./store')

// 快照根目录名（放在 $DSH_HOME 下，用户能自己找到；也让「一起删掉」变简单）
const BACKUP_DIR_NAME = 'whale-dsh-backup'

// 用户给快照加的「标记」单独存一个文件，**不写进 manifest**。
// why：manifest 是建快照那一刻的事实记录（谁建的、备了什么、校验值多少），必须保持只读语义；
// 命名和 known-good 是用户事后追加的意见，混进去会让「这份快照到底是不是完整的」变得可疑。
const META_NAME = 'meta.json'
// manifest 文件名（每份快照目录里）
const MANIFEST_NAME = 'manifest.json'
// 快照保留份数上限（E4 起可由用户配置，这里是回落默认值）。
const MAX_SNAPSHOTS = 20
const KEEP_MIN = 1
const KEEP_MAX = 200
// manifest schema：将来字段变了，旧快照仍能被识别出来（不至于当成损坏）
const SCHEMA = 1

// 白名单：只备这三个（与 v1.6.2 V-gate 核验时手动备份的完全一致）。
// 相对 $DSH_HOME 的路径 —— 前两个在 profiles/<profile>/ 下，第三个在 $DSH_HOME 根下。
// why 白名单而非「整个 profile 目录」：node_modules 动辄上万文件，E4 要留 N 份会迅速吃盘；
// 而真正会被 E2/E3 改动的只有 cordis.patch.yml 一个文件。
const PROFILE_FILES = ['cordis.patch.yml', 'package.json']
const HOME_FILES = ['settings.yaml']

function errMsg(err) { return String((err && err.message) || err || '未知错误') }

// ── 路径 ──

// $DSH_HOME 定位（与 diagnostics.js / dsh-dump.js 同一口径：env 优先 + 回退 ~/.dsh，都要实际存在）
function dshHome() {
  return homeDir({ env: 'DSH_HOME', fallback: '.dsh' })
}

function backupRoot() {
  const home = dshHome()
  return home ? path.join(home, BACKUP_DIR_NAME) : ''
}

// 时间戳目录名：20260922-214243（可排序，同年月日的按字典序 = 按时间序）
function stampOf(d) {
  const t = d instanceof Date ? d : new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return String(t.getFullYear()) + p2(t.getMonth() + 1) + p2(t.getDate())
    + '-' + p2(t.getHours()) + p2(t.getMinutes()) + p2(t.getSeconds())
}

// 本次要备的**绝对路径清单**（含尚不存在的 —— 存在性由调用处判断）
// 返回 [{ rel, abs }]，rel 形如 'profiles/web/cordis.patch.yml' / 'settings.yaml'
function targetFiles(profile) {
  const home = dshHome()
  if (!home) return []
  const pf = String(profile || 'web')
  const out = []
  for (const f of PROFILE_FILES) {
    out.push({ rel: 'profiles/' + pf + '/' + f, abs: path.join(home, 'profiles', pf, f) })
  }
  for (const f of HOME_FILES) {
    out.push({ rel: f, abs: path.join(home, f) })
  }
  return out
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// ── 元信息（命名 / known-good 标记）──
// meta.json 是**用户意见**，读不出来（没写过 / 手删了 / JSON 坏了）一律当「没标记」，
// 不算错误也不留痕 —— 它不影响快照本身能不能还原，为它报错只会制造噪音。
const NAME_MAX = 40

function normName(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

function metaPath(dirName) {
  return path.join(backupRoot(), dirName, META_NAME)
}

function readMeta(dirName) {
  const empty = { name: '', knownGood: false, at: '' }
  const r = readTextSafe(metaPath(dirName))
  if (!r.ok) return empty
  let m = null
  try { m = JSON.parse(r.text) } catch (_) { return empty }
  if (!m || typeof m !== 'object') return empty
  return {
    name: normName(m.name),
    knownGood: m.knownGood === true,
    at: String(m.at || ''),
  }
}

// dirName 必须已经过合法化校验（调用处负责）；这里只写文件
function writeMeta(dirName, meta) {
  const m = { name: normName(meta && meta.name), knownGood: !!(meta && meta.knownGood), at: new Date().toISOString() }
  // 两项都空 = 等价于「没有标记」，直接删掉 meta.json，别留一个 {} 让列表以为有东西
  if (!m.name && !m.knownGood) {
    try { fs.rmSync(metaPath(dirName), { force: true }) } catch (_) { /* 删不掉也没关系，读回来仍是「无标记」 */ }
    return m
  }
  try {
    fs.writeFileSync(metaPath(dirName), JSON.stringify(m, null, 2), 'utf8')
  } catch (err) {
    logErr('[whale][dsh-backup] 写快照标记失败', dirName + ': ' + errMsg(err))
    return null
  }
  return m
}

// 纯目录名校验（防目录穿越：用户可手改任何东西，不能让它读写到快照根之外）
function safeDirName(dirName) {
  const name = String(dirName || '')
  if (!name) return ''
  if (name !== path.basename(name) || name === '.' || name === '..') return ''
  return name
}

// 决定一份快照对外用哪个目录名（列表 / 还原 / 删除 / 清理都走它的结果）。
// 正常情况就是磁盘上的目录名 n。仅当 manifest 记的 m.dirName 与 n 不同、**且那个目录真的
// 存在于快照根下、且里面真的放着 manifest** 时才采用它 —— 这覆盖「快照目录被手工重命名、
// 但 manifest 里的旧名字还指向一个仍然存在的目录」这一种历史情形，让改名后的快照仍能被删除。
// ⚠️ m.dirName 绝不能无条件采信：它会进 path.join 与 rmSync，等于把「manifest 里一个字段」
// 变成「删除任意路径」。这三个条件（纯目录名 / 存在 / 有 manifest）是它能被采信的全部理由。
function resolveDirName(diskName, manifestName) {
  const m = safeDirName(manifestName)
  if (!m || m === diskName) return diskName
  try {
    if (fs.existsSync(path.join(backupRoot(), m, MANIFEST_NAME))) return m
  } catch (_) { /* 探测失败就退回磁盘目录名，宁可删不掉也不删错 */ }
  return diskName
}

// ── 快照 ──
// opts = { profile?: string, reason?: string, name?: string, knownGood?: boolean, at?: Date }
//   reason：为什么建这份快照（'manual' / 'before-disable' / ...），只写进 manifest 供界面展示，
//           本模块不解读它的值 —— 加新 reason 不需要改这里
//   name / knownGood：用户标记，写进 meta.json（不进 manifest，见 META_NAME 的说明）
//   at：快照时间戳，默认「此刻」，允许调用方注入（回归测试需要造出确定的时间序）
//
// 返回 { ok, dir, at, profile, files: [{rel, ok, sha256?, bytes?, reason?}], missing: n, error? }
//   files[].ok=false 表示该文件**当时就不存在**（如本机 home 层 cordis.patch.yml 不存在），
//   这不是失败 —— 还原时也不会去创建它（见 restore 的说明）。
function createSnapshot(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const root = backupRoot()
  if (!root) return { ok: false, error: '找不到 dsh 配置目录（$DSH_HOME 与 ~/.dsh 都不存在）' }
  const profile = String(o.profile || 'web')
  const targets = targetFiles(profile)
  if (!targets.length) return { ok: false, error: '没有可备份的文件' }

  // 允许注入时间戳（测试用）。只用 getTime() 是否为 NaN 做校验：Date 之外的可转换值
  // （毫秒数、可解析的字符串）也一并接受，不为此引入更多约定
  const rawAt = o.at instanceof Date ? o.at : new Date(o.at)
  const at = Number.isNaN(rawAt.getTime()) ? new Date() : rawAt
  // 同一时刻连建多份会撞名。dirName 的构成是「秒级时间戳」+「同秒内才补的毫秒后缀」，
  // 而 mkdir 用的是 recursive:true —— 它对**已存在**的目录不报错、直接复用，
  // 于是同毫秒连建的两份会落进同一个目录：后者把前者的快照文件与 manifest 覆盖掉，
  // 表现为「建了 N 份，列表里只有 1 份」（E1 回归实测：同毫秒连建 4 份只活下 2 份）。
  // 所以这里必须**自己保证目录名唯一**：同毫秒被占用就往后递增毫秒，直到找到一个不存在的。
  // why 不用时间戳直接重取：at 允许注入（测试要造确定的时间序），重取会破坏这个契约
  let dirName = stampOf(at)
  if (fs.existsSync(path.join(root, dirName))) {
    let ms = at.getMilliseconds()
    do {
      ms = (ms + 1) % 1000
      dirName = stampOf(at) + '-' + String(ms).padStart(3, '0')
    } while (fs.existsSync(path.join(root, dirName)) && ms !== at.getMilliseconds())
  }
  const dir = path.join(root, dirName)

  const files = []
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    logErr('[whale][dsh-backup] 创建快照目录失败', errMsg(err))
    return { ok: false, error: '创建快照目录失败：' + errMsg(err) }
  }

  let missing = 0
  for (const t of targets) {
    const r = readTextSafe(t.abs)
    if (!r.ok) {
      // ENOENT（reason 为空）是预期分支：该文件本来就没有，记 ok:false 即可。
      // 其余（EACCES 等）是真故障 —— 必须留痕，否则用户会以为「备份成功了，
      // 其实有个文件因为权限没被备走」，还原时才发现缺东西（D23 的分流约定）
      if (r.reason) logErr('[whale][dsh-backup] 备份时读文件失败', t.rel + ': ' + r.reason)
      files.push({ rel: t.rel, ok: false, reason: r.reason || '' })
      missing++
      continue
    }
    // 快照文件用「把路径分隔符换成 __」的扁平名，避免在快照目录里再造一层 profiles/web/
    // （还原时按 manifest 的 rel 反推原路径，不依赖文件名可逆）
    const flat = t.rel.replace(/[\\/]/g, '__')
    try {
      fs.writeFileSync(path.join(dir, flat), r.text, 'utf8')
    } catch (err) {
      logErr('[whale][dsh-backup] 写快照文件失败', t.rel + ': ' + errMsg(err))
      return { ok: false, error: '写快照文件失败（' + t.rel + '）：' + errMsg(err) }
    }
    files.push({ rel: t.rel, ok: true, flat: flat, sha256: sha256(r.text), bytes: Buffer.byteLength(r.text, 'utf8') })
  }

  const manifest = {
    kind: 'whale-dsh-backup',
    schema: SCHEMA,
    at: at.toISOString(),
    dirName: dirName,
    profile: profile,
    reason: String(o.reason || 'manual'),
    dshHome: dshHome(),
    files: files,
  }
  try {
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8')
  } catch (err) {
    logErr('[whale][dsh-backup] 写 manifest 失败', errMsg(err))
    return { ok: false, error: '写快照清单失败：' + errMsg(err) }
  }

  log('[whale][dsh-backup] 已建快照', { dirName: dirName, files: files.length, missing: missing })
  // 用户标记（命名 / known-good）：只在真的给了才写，否则不落 meta.json
  const meta = writeMeta(dirName, { name: o.name, knownGood: o.knownGood === true })
  // 建完就轮转，避免无限增长（失败不影响本次快照 —— 它已经写好了）
  try { pruneSnapshots({ keep: retentionKeep() }) } catch (err) { logErr('[whale][dsh-backup] 轮转旧快照失败', errMsg(err)) }
  return {
    ok: true, dir: dir, dirName: dirName, at: manifest.at, profile: profile,
    files: files, missing: missing,
    name: meta ? meta.name : '', knownGood: meta ? meta.knownGood : false,
  }
}

// ── 列表 ──
// 返回按时间**倒序**（最新在前）的快照摘要数组；读不出 manifest 的目录会被跳过（不是错误 —— 
// 可能是用户手动塞进去的目录），但**会留痕**，否则「快照列表莫名少一份」无法排查
function listSnapshots() {
  const root = backupRoot()
  if (!root) return []
  let names = []
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (_) {
    return [] // 根目录还不存在 = 从没建过快照，是预期状态
  }
  const out = []
  for (const n of names) {
    const mp = path.join(root, n, MANIFEST_NAME)
    const r = readTextSafe(mp)
    if (!r.ok) {
      if (r.reason) logErr('[whale][dsh-backup] 读快照清单失败', n + ': ' + r.reason)
      continue
    }
    let m = null
    try { m = JSON.parse(r.text) } catch (err) {
      logErr('[whale][dsh-backup] 快照清单解析失败', n + ': ' + errMsg(err))
      continue
    }
    if (!m || m.kind !== 'whale-dsh-backup') continue
    const files = Array.isArray(m.files) ? m.files : []
    const meta = readMeta(n)
    // dirName 一律取**目录名**而不是 manifest 里的 m.dirName：manifest 是用户可手改的，
    // 而 dirName 到了 pruner 会被拼成路径去 rmSync —— 信 manifest 就等于让「手改一个
    // 字段」变成「删掉快照根之外的任意目录」（E4 复查实测：填 '../evil' 能越过根；
    // 填一个真实同级目录名会把那份**完好的快照**连带删掉）。磁盘上的目录名才是事实。
    out.push({
      dirName: resolveDirName(n, m.dirName),
      at: String(m.at || ''),
      profile: String(m.profile || ''),
      reason: String(m.reason || ''),
      total: files.length,
      present: files.filter((f) => f && f.ok).length,
      name: meta.name,
      knownGood: meta.knownGood,
      // 空集合也算「完好」—— 没文件可备不叫损坏，叫这份快照没内容
      intact: true,
    })
  }
  // 已知良好的排最前（回滚时第一眼要看到的就是它），其余按时间倒序
  out.sort((a, b) => {
    if (a.knownGood !== b.knownGood) return a.knownGood ? -1 : 1
    return a.at < b.at ? 1 : a.at > b.at ? -1 : 0
  })
  return out
}

// ── 还原 ──
// opts = { dirName: string, dryRun?: boolean }
//
// ⚠️ 为什么是**整文件覆盖**而不是「按行撤销」：V4 实测 dsh 的 patchReload 是单向的
// （加 disabled 即时生效、删掉不恢复），所以「撤销」必须让文件内容真正回到改动前，
// 只删行达不到目的。整文件覆盖的副作用是「会一并回退这份文件上其他无关改动」——
// 这是有意的取舍：备份的价值就是拿到一个**已知良好**的状态。
//
// dryRun=true 只校验不写（界面可以先让用户看清「会覆盖什么」）。
// 校验项：① 快照存在且 manifest 可解析 ② 每个 ok 的文件的 sha256 与磁盘上快照文件一致
//        （防「备份自己就坏了」—— V2 的教训：dsh 不会告诉你写坏了，只能自己校验）
function restoreSnapshot(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const dirName = safeDirName(o.dirName)
  if (!dirName) return { ok: false, error: '未指定要还原的快照' }
  const root = backupRoot()
  if (!root) return { ok: false, error: '找不到 dsh 配置目录' }
  const dir = path.join(root, dirName)
  const r = readTextSafe(path.join(dir, MANIFEST_NAME))
  if (!r.ok) return { ok: false, error: '读不到该快照的清单（' + (r.reason || 'ENOENT') + '）' }
  let m = null
  try { m = JSON.parse(r.text) } catch (err) { return { ok: false, error: '快照清单解析失败：' + errMsg(err) } }
  if (!m || m.kind !== 'whale-dsh-backup') return { ok: false, error: '这不是本插件建的 dsh 快照' }
  if (Number(m.schema) > SCHEMA) return { ok: false, error: '该快照来自更新的插件版本（schema ' + m.schema + '）' }

  const home = dshHome()
  if (!home) return { ok: false, error: '找不到 dsh 配置目录' }

  const files = Array.isArray(m.files) ? m.files : []
  const plan = []
  for (const f of files) {
    if (!f || !f.rel) continue
    if (!f.ok) { plan.push({ rel: f.rel, action: 'skip', why: '建快照时该文件就不存在' }); continue }
    const flat = String(f.flat || String(f.rel).replace(/[\\/]/g, '__'))
    const sp = path.join(dir, flat)
    const sr = readTextSafe(sp)
    if (!sr.ok) { return { ok: false, error: '快照内的文件读不到：' + f.rel + '（' + (sr.reason || 'ENOENT') + '）' } }
    const got = sha256(sr.text)
    if (f.sha256 && got !== f.sha256) {
      return { ok: false, error: '快照已损坏（' + f.rel + ' 的校验值不符），拒绝还原' }
    }
    plan.push({ rel: f.rel, action: 'write', abs: path.join(home, f.rel), text: sr.text })
  }
  if (o.dryRun === true) {
    return { ok: true, dryRun: true, dirName: dirName, at: String(m.at || ''), plan: plan.map((p) => ({ rel: p.rel, action: p.action })) }
  }

  const written = []
  const skipped = []
  for (const p of plan) {
    if (p.action === 'skip') { skipped.push(p.rel); continue }
    try {
      // 确保父目录在（profile 目录可能被用户删过；整文件覆盖的语义不该包含「创建目录树」，
      // 但目录都不在了还原必然失败，不如直接建好）
      fs.mkdirSync(path.dirname(p.abs), { recursive: true })
      fs.writeFileSync(p.abs, p.text, 'utf8')
      written.push(p.rel)
    } catch (err) {
      logErr('[whale][dsh-backup] 还原写文件失败', p.rel + ': ' + errMsg(err))
      return { ok: false, error: '还原失败（' + p.rel + '）：' + errMsg(err), written: written }
    }
  }
  log('[whale][dsh-backup] 已还原快照', { dirName: dirName, written: written.length, skipped: skipped.length })
  return { ok: true, dirName: dirName, at: String(m.at || ''), written: written, skipped: skipped }
}

// ── 清理 ──
// opts = { keep?: number, protectPinned?: boolean }   keep 默认 MAX_SNAPSHOTS（调用方可传用户配置值）
// 返回被删掉的快照目录名数组（按删除顺序）
//
// 两条保护规则（E4）：
//   ① **known-good 永不轮转**：它是用户明确指认的「已知良好」，被自动清理掉等于把回滚目标弄丢；
//   ② 带名字且不是 before-* 的**手动备份也不轮转**：手动备份是用户主动存的，与写入前自动建的不是一回事。
//      why 排除 before-*：那些是写入的副产物、量最大，如果手动改名就能免死，改两下就绕过了上限。
// 两者都只是「免于自动清理」，手动删除仍可以删（用户点删除是明确意图）。
function isPinned(s) {
  return s.knownGood === true || (!!s.name && !/^before-/.test(String(s.reason || '')))
}

function pruneSnapshots(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const keep = Number.isFinite(o.keep) && o.keep >= 0 ? Math.floor(o.keep) : MAX_SNAPSHOTS
  const protect = o.protectPinned !== false
  const list = listSnapshots() // 已按 known-good 优先 + 时间倒序
  const root = backupRoot()
  const removed = []
  // ⚠️ keep 只统计**未固定**的快照：固定的那几份不占配额。
  // why：known-good 是用户指认的回滚目标，如果它把 keep 的名额吃掉，
  // 「保留 1 份」就会变成「只留 known-good、普通快照全删」—— 与用户设的份数含义不符。
  let keptNormal = 0
  for (const s of list) {
    // dirName 正常来自 readdir（磁盘事实），这里再校验一次是**纵深防御**：
    // 本函数会 rmSync 拼出来的路径，多一道纯目录名校验，代价为零、出事时却是唯一那道闸
    const name = safeDirName(s.dirName)
    if (!name) {
      logErr('[whale][dsh-backup] 跳过目录名不合法的快照', String(s.dirName))
      continue
    }
    if (protect && isPinned(s)) continue
    if (keptNormal < keep) { keptNormal++; continue }
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
      removed.push(name)
    } catch (err) {
      logErr('[whale][dsh-backup] 删除旧快照失败', name + ': ' + errMsg(err))
    }
  }
  if (removed.length) log('[whale][dsh-backup] 已清理旧快照', { removed: removed.join(',') })
  return removed
}

// 删单个快照（界面上的「删除这一份」）
function removeSnapshot(dirName) {
  const name = safeDirName(dirName)
  if (!name) return { ok: false, error: '未指定快照' }
  const root = backupRoot()
  if (!root) return { ok: false, error: '找不到 dsh 配置目录' }
  const dir = path.join(root, name)
  if (!fs.existsSync(dir)) return { ok: false, error: '该快照不存在' }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    logErr('[whale][dsh-backup] 删除快照失败', name + ': ' + errMsg(err))
    return { ok: false, error: '删除失败：' + errMsg(err) }
  }
  log('[whale][dsh-backup] 已删除快照', name)
  return { ok: true, dirName: name }
}

// 给快照命名 / 打（取消）known-good 标记。
// opts = { dirName: string, name?: string, knownGood?: boolean }
//   name 传空串 = 清掉名字；knownGood 传 false = 取消标记；两者都空 = 删掉 meta.json
// 只改 meta.json，**不碰快照内容** —— 标记错了重标即可，不会影响可还原性
function setMeta(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const dirName = safeDirName(o.dirName)
  if (!dirName) return { ok: false, error: '未指定快照' }
  const root = backupRoot()
  if (!root) return { ok: false, error: '找不到 dsh 配置目录' }
  if (!fs.existsSync(path.join(root, dirName, MANIFEST_NAME))) {
    return { ok: false, error: '该快照不存在' }
  }
  // 上面的 existsSync 走的是「按 dirName 拼出来的路径」，meta 写入跟着同一个路径走，
  // 两者必须是同一个来源（都是校验过的纯目录名），否则会出现
  // 「查的是 A 却写了 B」这种看似成功实则写错目录的情况
  const cur = readMeta(dirName)
  const next = {
    name: o.name === undefined ? cur.name : normName(o.name),
    knownGood: o.knownGood === undefined ? cur.knownGood : o.knownGood === true,
  }
  const meta = writeMeta(dirName, next)
  if (!meta) return { ok: false, error: '写快照标记失败（目录不可写？）' }
  log('[whale][dsh-backup] 已更新快照标记', { dirName: dirName, name: meta.name, knownGood: meta.knownGood })
  return { ok: true, dirName: dirName, name: meta.name, knownGood: meta.knownGood }
}

// 当前生效的保留份数：读用户配置，读不出来回落默认值（配置读写由 store 负责，这里只管兜底）
function retentionKeep() {
  let n = MAX_SNAPSHOTS
  try {
    const cfg = readConfig()
    if (cfg && cfg.dshBackupKeep !== undefined) n = cfg.dshBackupKeep
  } catch (err) {
    logErr('[whale][dsh-backup] 读保留份数配置失败，用默认值', errMsg(err))
  }
  if (!Number.isFinite(Number(n))) return MAX_SNAPSHOTS
  return Math.min(KEEP_MAX, Math.max(KEEP_MIN, Math.floor(Number(n))))
}

module.exports = {
  BACKUP_DIR_NAME,
  META_NAME,
  MAX_SNAPSHOTS,
  KEEP_MIN,
  KEEP_MAX,
  dshHome,
  backupRoot,
  targetFiles,
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  pruneSnapshots,
  removeSnapshot,
  setMeta,
  retentionKeep,
  // 供测试/排查用
  _stampOf: stampOf,
  _sha256: sha256,
  _isPinned: isPinned,
}
