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

// 快照根目录名（放在 $DSH_HOME 下，用户能自己找到；也让「一起删掉」变简单）
const BACKUP_DIR_NAME = 'whale-dsh-backup'
// manifest 文件名（每份快照目录里）
const MANIFEST_NAME = 'manifest.json'
// 快照保留份数上限：超过了从最旧的开始删。
// E4 会带「留 N 份」的配置，E1 先用一个保守默认值把「无限增长」这件事堵住
const MAX_SNAPSHOTS = 20
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

// ── 快照 ──
// opts = { profile?: string, reason?: string }
//   reason：为什么建这份快照（'manual' / 'before-disable' / ...），只写进 manifest 供界面展示，
//           本模块不解读它的值 —— 加新 reason 不需要改这里
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

  const at = new Date()
  // 同一秒内连建两份会撞名（目录已存在 → mkdir 抛错）。加毫秒后缀兜一层，
  // 保证「连点两次手动备份」不会因为撞名失败
  let dirName = stampOf(at)
  if (fs.existsSync(path.join(root, dirName))) dirName = dirName + '-' + String(at.getMilliseconds()).padStart(3, '0')
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
  // 建完就轮转，避免无限增长（失败不影响本次快照 —— 它已经写好了）
  try { pruneSnapshots() } catch (err) { logErr('[whale][dsh-backup] 轮转旧快照失败', errMsg(err)) }
  return { ok: true, dir: dir, dirName: dirName, at: manifest.at, profile: profile, files: files, missing: missing }
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
    out.push({
      dirName: String(m.dirName || n),
      at: String(m.at || ''),
      profile: String(m.profile || ''),
      reason: String(m.reason || ''),
      total: files.length,
      present: files.filter((f) => f && f.ok).length,
      // 空集合也算「完好」—— 没文件可备不叫损坏，叫这份快照没内容
      intact: true,
    })
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
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
  const dirName = String(o.dirName || '')
  if (!dirName) return { ok: false, error: '未指定要还原的快照' }
  const root = backupRoot()
  if (!root) return { ok: false, error: '找不到 dsh 配置目录' }
  // 防目录穿越：dirName 必须是一个**纯目录名**（用户可手改 manifest，不能让它写到外面去）
  if (dirName !== path.basename(dirName) || dirName === '.' || dirName === '..') {
    return { ok: false, error: '快照名不合法' }
  }
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
// opts = { keep?: number }  默认 MAX_SNAPSHOTS
// 返回被删掉的快照目录名数组（按删除顺序）
function pruneSnapshots(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const keep = Number.isFinite(o.keep) && o.keep >= 0 ? Math.floor(o.keep) : MAX_SNAPSHOTS
  const list = listSnapshots() // 已按时间倒序
  const doomed = list.slice(keep)
  const root = backupRoot()
  const removed = []
  for (const s of doomed) {
    try {
      fs.rmSync(path.join(root, s.dirName), { recursive: true, force: true })
      removed.push(s.dirName)
    } catch (err) {
      logErr('[whale][dsh-backup] 删除旧快照失败', s.dirName + ': ' + errMsg(err))
    }
  }
  if (removed.length) log('[whale][dsh-backup] 已清理旧快照', { removed: removed.join(',') })
  return removed
}

// 删单个快照（界面上的「删除这一份」）
function removeSnapshot(dirName) {
  const name = String(dirName || '')
  if (!name) return { ok: false, error: '未指定快照' }
  if (name !== path.basename(name) || name === '.' || name === '..') return { ok: false, error: '快照名不合法' }
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

module.exports = {
  BACKUP_DIR_NAME,
  MAX_SNAPSHOTS,
  dshHome,
  backupRoot,
  targetFiles,
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  pruneSnapshots,
  removeSnapshot,
  // 供测试/排查用
  _stampOf: stampOf,
  _sha256: sha256,
}
