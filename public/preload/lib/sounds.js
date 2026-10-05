/*
 * 自定义音效（CommonJS）：导入/删除/读取按压、释放两段交互音，以及四类提醒各自的提醒音。
 * 另有 shared 槽位承载「共享音效库」（从 Release 下载的公共素材，见 ROLES 注释）。
 *
 * 每个实播槽位是「音效组」——可以导入多段，挂件每次随机播一条（听久了不腻）。
 * 文件复制进 uTools 用户数据目录（userData/whale-sounds/），不存源路径——
 * 源文件被删/移动就失效（桌面端踩过这个坑），这里以复制为准。
 * 元信息落 dbStorage（K.sounds），音频本体在推给挂件时读成 base64 data URL
 * （挂件页面无法可靠加载插件包外的 file:// 资源）。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { K } = require('./constants')
const { logErr } = require('./log')

// Chromium 可直接解码的音频格式；flac/m4a 也支持但对话框里主要引导 mp3/wav/ogg
const OK_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac']
const MAX_BYTES = 5 * 1024 * 1024
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac' }

// 音效槽位。press / release 是「音色」的两段（有内置回落，见挂件页 SOUND_FILES）；
// low / budget / peak / pass 是四类提醒各自的提醒音 —— **没有内置回落，留空即静音**，
// 不打扰是默认，想要声音才去导一段。
// shared 是「共享音效库」的落地槽位：从 Release 下载的全集音效都进这里，**不直接作为上述
// 任一实播槽位**（否则一装就是几十段，随机播到哪段全看运气）。用户在设置页从这里「选用」到
// press/release/… 某个槽位，才真正参与播放（见 useSharedSound）。
const ROLES = ['press', 'release', 'low', 'budget', 'peak', 'pass', 'shared']
// 实播槽位：与「音色 / 提醒」直接挂钩的那六个（shared 只是素材库，不算）
const PLAY_ROLES = ['press', 'release', 'low', 'budget', 'peak', 'pass']
const ROLE_LABEL = {
  press: '按压音效', release: '释放音效',
  low: '低余额提醒音', budget: '预算提醒音', peak: '峰谷提醒音', pass: '穿透提醒音',
  shared: '共享音效库',
}

// base64 data URL 缓存：导入/删除/重载插件前有效，元信息变化时置空
let dataCache = null

function soundsDir() {
  let base = ''
  try { base = utools.getPath('userData') } catch (err) {}
  if (!base) base = os.tmpdir()
  return path.join(base, 'whale-sounds')
}

// 音频体积（读取时派生，不落存储）：设置页「自定义素材」卡片要显示占多大；文件缺失回 0
function fileSize(file) {
  try { return fs.statSync(path.join(soundsDir(), file)).size } catch (err) { return 0 }
}

// 扩展名 → MIME（试听 data URL 用）。未知扩展名回 mp3，与 getSoundData 同口径
function mimeOf(ext) {
  return MIME[String(ext || '').toLowerCase()] || 'audio/mpeg'
}

// 按文件名读一段音频字节（供 lib/assets-packs.js 试听共享音效用；文件缺失回 null）。
// 不缓存：试听是低频动作，缓存反而会在下载 / 选用后变脏
function readSoundBuffer(file) {
  try { return fs.readFileSync(path.join(soundsDir(), file)) } catch (err) { return null }
}

// 文件名必须落在本槽位的命名空间内：老结构是 <role>.<ext>，音效组追加的是 <role>-<n>.<ext>。
// 元信息是存储里的普通数据，可能被外部改写，不能拿它当路径直接读/删
function isRoleFile(role, file) {
  const m = /^([a-z]+)(?:-(\d+))?\.([a-z0-9]+)$/.exec(String(file || '').toLowerCase())
  return !!m && m[1] === role && OK_EXT.indexOf(m[3]) >= 0
}

// 单条归一化：扩展名与文件名都要过关，否则按「没导入」处理（文件缺失时 size 为 0）
function oneItem(v, role) {
  if (!v || typeof v !== 'object') return null
  const ext = typeof v.ext === 'string' ? v.ext.toLowerCase() : ''
  if (OK_EXT.indexOf(ext) < 0) return null
  // 老结构没有 file 字段，按单段命名 <role>.<ext> 推出来
  const file = typeof v.file === 'string' && v.file ? v.file : role + '.' + ext
  if (!isRoleFile(role, file)) return null
  const out = {
    name: String(v.name || file).slice(0, 120),
    ext: ext,
    at: Number(v.at) || 0,
    file: file,
    size: fileSize(file),
  }
  // 必须原样带出 from（「这段是从共享库哪一段选用来的」）：readMeta 是**归一化**写入，
  // 不带出的字段会在下一次 writeMeta 时被静默抹掉 —— 删除共享库那段的连带清理就失效了，
  // 表现成「删了池里那段、槽位上的副本照旧在响」。
  if (typeof v.from === 'string' && v.from) out.from = v.from
  return out
}

// 元信息一律读成「每槽位一个数组」：老结构（一个槽位一个对象）在读取时就地升级，
// 下一次写入自然落成新结构，不做单独的迁移步骤
function readMeta() {
  let raw = null
  try { raw = utools.dbStorage.getItem(K.sounds) } catch (err) {}
  const out = {}
  for (const role of ROLES) {
    const v = raw && raw[role]
    const arr = Array.isArray(v) ? v : (v ? [v] : [])
    const list = []
    for (const one of arr) {
      const it = oneItem(one, role)
      if (it) list.push(it)
    }
    out[role] = list
  }
  return out
}

function writeMeta(meta) {
  try { utools.dbStorage.setItem(K.sounds, meta) } catch (err) { logErr('[whale][sounds] 写音效信息失败', err && err.message) }
}

// 新段落的文件名 <role>-<n>.<ext>：<role>.<ext> 留给老结构那条，不参与编号。
// 编号取目录里的最小空位（删掉一段后编号能复用，不会越攒越大）
function nextFile(role, ext, except) {
  const used = {}
  let names = []
  try { names = fs.readdirSync(soundsDir()) } catch (err) {}
  for (const n of names) {
    const m = new RegExp('^' + role + '-(\\d+)\\.[a-z0-9]+$').exec(String(n).toLowerCase())
    if (m) used[m[1]] = true
  }
  if (except && used[String(except)]) delete used[String(except)]
  for (let i = 1; i < 1000; i++) if (!used[String(i)]) return role + '-' + i + '.' + ext
  return role + '-' + Date.now() + '.' + ext
}

// 写盘 + 落元信息。
//
// append 为假（默认，实播槽位 press/release/low/budget/peak/pass）：
//   每个槽位**只保留一段**，新导入的直接顶掉旧的（整条列表替换，不是追加）。
//   早先的设计是可叠加多段、挂件每次随机播一条，但设置页上会显示成「来财 等 2 段」
//   这种读不通的概览，用户也无法分辨哪个是刚导入的 —— 语义改回「一段一槽位」。
// append 为真（shared 素材库）：按同名覆盖、其余保留 —— 素材池本来就要装很多段，
//   且「导入素材包」要可重复执行（同一个包导两遍不该翻倍）。
//
// 落盘文件名一律走 nextFile 取空位、不复用旧名：新文件写成功后旧文件才 unlink，
// 这样即使写入过程被打断，旧的也还完整可用，不会出现半新半旧的文件。
function saveOne(role, name, ext, buf, opts) {
  const o = opts || {}
  const dir = soundsDir()
  const item = {
    name: String(name || (role + '.' + ext)).slice(0, 120),
    ext: ext,
    at: Number(o.at) || Date.now(),
    file: '',
  }
  const meta = readMeta()
  const list = meta[role]
  // 这段是从共享库哪一段「选用」过来的（源段落盘文件名）。只有走 useSharedSound 才有；
  // 直接导入 / 素材包导入都不带，删除池里那段时也就不会误伤用户自己的音效。
  if (o.from) item.from = String(o.from)
  // 同名命中（仅在 append 模式下有意义）：覆盖它就复用其文件名，避免素材库里越攒越多
  const dup = o.append ? list.findIndex((x) => x.name === item.name) : -1
  const reused = dup >= 0 ? list[dup] : null
  item.file = reused && reused.ext === ext ? reused.file : nextFile(role, ext, reused && reused.file)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, item.file), buf)
  } catch (err) {
    logErr('[whale][sounds] 写入音效失败', role, err && err.message)
    return { ok: false, error: '保存音效失败：' + ((err && err.message) || err) }
  }
  if (o.append) {
    // 素材库：只删被同名顶掉的那一个（若换了文件名）
    if (reused && reused.file !== item.file) {
      try { fs.unlinkSync(path.join(dir, reused.file)) } catch (err) {}
    }
    if (dup >= 0) list[dup] = item
    else list.push(item)
    meta[role] = list
  } else {
    // 实播槽位：新文件已落盘，再清掉该槽位原有的全部旧段
    for (const old of list) {
      if (old.file && old.file !== item.file) {
        try { fs.unlinkSync(path.join(dir, old.file)) } catch (err) {}
      }
    }
    meta[role] = [item]
  }
  writeMeta(meta)
  dataCache = null
  return { ok: true, role: role, name: item.name, ext: ext }
}

// 弹选择框并做「扩展名 + 是否文件 + 大小」校验，只回文件路径与扩展名。
// 「直接导入」与「先裁剪再导入」只差拿到文件后的处理，选择与校验共用这一份，避免两处规则跑偏。
// 返回 { filePath, ext } / { canceled: true } / { error }
function pickAudioFile(title) {
  let picked
  try {
    picked = utools.showOpenDialog({
      title: title,
      buttonLabel: '导入',
      filters: [{ name: '音频文件', extensions: OK_EXT }],
      properties: ['openFile'],
    })
  } catch (err) {
    logErr('[whale][sounds] 打开选择框失败', err && err.message)
    return { error: '无法打开文件选择框：' + ((err && err.message) || err) }
  }
  const filePath = Array.isArray(picked) ? picked[0] : picked
  if (!filePath) return { canceled: true }
  const ext = String(path.extname(filePath) || '').replace(/^\./, '').toLowerCase()
  if (OK_EXT.indexOf(ext) < 0) return { error: '只支持 ' + OK_EXT.join(' / ') + ' 格式' }
  let stat = null
  try { stat = fs.statSync(filePath) } catch (err) {
    return { error: '读取文件失败：' + ((err && err.message) || err) }
  }
  if (!stat.isFile()) return { error: '请选择一个音频文件' }
  if (stat.size > MAX_BYTES) return { error: '文件过大（限 5MB），建议 1 秒左右的短音效' }
  return { filePath: filePath, ext: ext }
}

// 打开系统文件选择框，校验后复制进 userData/whale-sounds/（追加为该槽位的一段，不覆盖已有的）
function importSound(role) {
  if (ROLES.indexOf(role) < 0) return { ok: false, error: '未知音效段' }
  const picked = pickAudioFile('选择' + (ROLE_LABEL[role] || '音效'))
  if (picked.error) return { ok: false, error: picked.error }
  if (picked.canceled) return { ok: false, canceled: true }
  let buf = null
  try { buf = fs.readFileSync(picked.filePath) } catch (err) {
    logErr('[whale][sounds] 读取失败', picked.filePath, err && err.message)
    return { ok: false, error: '读取文件失败：' + ((err && err.message) || err) }
  }
  return saveOne(role, path.basename(picked.filePath), picked.ext, buf)
}

// 选择音频并读成 base64 data URL 返回，**不落盘**：设置页要先用它解码出波形让用户裁剪，
// 确认后才由 importSoundFromData 写盘（用户中途取消不该在本地留半成品）。
function pickSoundFile() {
  const picked = pickAudioFile('选择音效（可裁剪）')
  if (picked.error) return { ok: false, error: picked.error }
  if (picked.canceled) return { ok: false, canceled: true }
  let buf = null
  try { buf = fs.readFileSync(picked.filePath) } catch (err) {
    logErr('[whale][sounds] 读取失败', picked.filePath, err && err.message)
    return { ok: false, error: '读取文件失败：' + ((err && err.message) || err) }
  }
  const mime = MIME[picked.ext] || 'audio/mpeg'
  return {
    ok: true,
    name: path.basename(picked.filePath),
    ext: picked.ext,
    dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'),
  }
}

// 前端「裁剪 + 试听」后回传的 WAV data URL：裁剪结果只有 wav 一种格式，所以这里只认 audio/wav 前缀
function importSoundFromData(role, name, dataUrl) {
  if (ROLES.indexOf(role) < 0) return { ok: false, error: '未知音效段' }
  const PREFIX = 'data:audio/wav;base64,'
  const url = typeof dataUrl === 'string' ? dataUrl : ''
  if (url.indexOf(PREFIX) !== 0) return { ok: false, error: '音频数据格式不对（需要 WAV）' }
  // 按解码后的字节数校验大小：base64 字符串长度不可信（填充与字符集差异会让它偏离实际体积）
  const buf = Buffer.from(url.slice(PREFIX.length), 'base64')
  if (!buf.length) return { ok: false, error: '音频数据为空' }
  if (buf.length > MAX_BYTES) return { ok: false, error: '音频过大（限 5MB），请缩短选区' }
  return saveOne(role, name || (role + '.wav'), 'wav', buf)
}

// 删除音效：给了 file 只删那一段，不给就清空该槽位（设置页的「清除未使用 / 全部素材」按整段删）
function removeSound(role, file) {
  if (ROLES.indexOf(role) < 0) return { ok: false, error: '未知音效段' }
  const dir = soundsDir()
  const meta = readMeta()
  const list = meta[role]
  for (const it of list) {
    if (file && it.file !== file) continue
    try { fs.unlinkSync(path.join(dir, it.file)) } catch (err) {}
  }
  meta[role] = file ? list.filter((x) => x.file !== file) : []
  writeMeta(meta)
  dataCache = null
  return { ok: true, role: role }
}

// 从共享库删掉一段时，一并清掉从它「选用」过去的实播槽位副本。
// 背景：选用是另存一份拷贝，两份之间没有文件级关联。用户删了池里那段，实播槽位那份照旧在响，
// 看着就是「删了没删干净」—— 因此这里按 from 标记反查并清掉。
// 只删 from === file 的项：用户自己导入的音效没有 from（或指向别的段），不会被误伤。
// 返回清掉的槽位名数组，供设置页在提示里说明「顺带清掉了哪个槽位」。
function removeDerivedFrom(file) {
  if (!file) return []
  const meta = readMeta()
  const dir = soundsDir()
  const hitRoles = []
  for (const role of PLAY_ROLES) {
    const list = meta[role]
    const keep = list.filter((x) => x.from !== file)
    if (keep.length === list.length) continue
    for (const it of list) {
      if (it.from === file && it.file) {
        try { fs.unlinkSync(path.join(dir, it.file)) } catch (err) {}
      }
    }
    meta[role] = keep
    hitRoles.push(role)
  }
  if (hitRoles.length) {
    writeMeta(meta)
    dataCache = null
  }
  return hitRoles
}

// 清除全部自定义音效：音频文件 + 元信息 + 读取缓存（供设置页「清除选中数据」调用）。
// 整个目录一并删掉（含改名遗留的旧文件），删不动（被占用）也不影响清除结果
function clearAll() {
  try { fs.rmSync(soundsDir(), { recursive: true, force: true }) } catch (err) {}
  try { utools.dbStorage.removeItem(K.sounds) } catch (err) { logErr('[whale][sounds] 清除音效信息失败', err && err.message) }
  dataCache = null
  return { ok: true }
}

// 导出用：每段音效的音频字节（素材包打包用）。文件缺失的项跳过，
// 不因一段坏音频让整包导不出去
function exportItems() {
  const meta = readMeta()
  const out = []
  // 只导出实播槽位：shared 素材池是「可重新下载的公共素材」，跟着用户素材包走会平白胖 2.7MB
  for (const role of PLAY_ROLES) {
    for (const m of meta[role]) {
      let data = null
      try { data = fs.readFileSync(path.join(soundsDir(), m.file)) } catch (err) { continue }
      out.push({ role: role, name: m.name, ext: m.ext, at: m.at, data: data })
    }
  }
  return out
}

// 素材包导入：落进**实播槽位**。实播槽位现在是「一段一槽位」，saveOne 默认即整条替换，
// 不再需要 replace 选项（素材包可重复执行，结果同样是该槽位只剩这一段，不会翻倍）。
function importBuffer(role, name, ext, buf, at) {
  if (ROLES.indexOf(role) < 0) return { ok: false, error: '未知音效段' }
  const e = String(ext || '').toLowerCase()
  if (OK_EXT.indexOf(e) < 0) return { ok: false, error: '不支持的音频格式：' + ext }
  if (!buf || !buf.length) return { ok: false, error: '音频数据为空' }
  if (buf.length > MAX_BYTES) return { ok: false, error: '音频过大（限 5MB）' }
  return saveOne(role, name || (role + '.' + e), e, buf, { at: at })
}

// 装一段「共享音效库」音效（供 lib/assets-packs.js 调用）：落进 shared 素材池、同名覆盖。
// 必须 append：shared 是素材池，要装很多段；若走「一段一槽位」的替换语义，
// 下载第二段就会把第一段抹掉。
function installBuiltin(name, ext, buf) {
  const e = String(ext || '').toLowerCase()
  if (OK_EXT.indexOf(e) < 0) return { ok: false, error: '不支持的音频格式：' + ext }
  if (!buf || !buf.length) return { ok: false, error: '音频数据为空' }
  if (buf.length > MAX_BYTES) return { ok: false, error: '音频过大（限 5MB）' }
  return saveOne('shared', name, e, buf, { append: true })
}

// 把共享库里的一段「选用」到某个实播槽位（press/release/low/budget/peak/pass）：
// 读共享库那段音频字节，按实播槽位再存一份（追加、不改动共享库本身）。
// 这样共享库是「素材池」、实播槽位是「已选」，两者互不干扰 —— 删除实播槽位那段不影响素材池。
// 写入时带 from: 源段文件名。实播槽位是**另存一份拷贝**，与素材池那段没有文件级关联；
// 用户删掉池里那段时，要靠这个标记才认得出「实播槽位这份是从它抄来的」（见 removeSharedSound）。
function useSharedSound(file, role) {
  if (PLAY_ROLES.indexOf(role) < 0) return { ok: false, error: '未知音效段' }
  const meta = readMeta()
  const src = meta.shared.filter((x) => x.file === file)[0]
  if (!src) return { ok: false, error: '共享库中没有这段音效' }
  let buf = null
  try { buf = fs.readFileSync(path.join(soundsDir(), src.file)) } catch (err) {
    logErr('[whale][sounds] 读取共享音效失败', src.file, err && err.message)
    return { ok: false, error: '读取音效失败：' + ((err && err.message) || err) }
  }
  return saveOne(role, src.name, src.ext, buf, { from: file })
}

// 音频本体 → base64 data URL 数组（挂件随机取一条 new Audio(dataURL) 播放）。
// 文件丢失（用户手动清理了 userData）时按缺失处理，挂件侧回退内置音色 / 提醒音静音。
function getSoundData() {
  if (dataCache) return dataCache
  const meta = readMeta()
  const out = {}
  // 只推「实播槽位」：shared 是素材池（几十段），全推给挂件等于每次都搬几 MB 无用 base64
  for (const role of PLAY_ROLES) {
    const list = []
    for (const m of meta[role]) {
      try {
        const buf = fs.readFileSync(path.join(soundsDir(), m.file))
        if (buf.length > MAX_BYTES * 2) continue
        list.push('data:' + (MIME[m.ext] || 'audio/mpeg') + ';base64,' + buf.toString('base64'))
      } catch (err) {
        logErr('[whale][sounds] 读取音效失败', m.file, err && err.message)
      }
    }
    out[role] = list
  }
  dataCache = out
  return out
}

module.exports = {
  importSound, pickSoundFile, importSoundFromData,
  removeSound, clearAll, getSoundData, readMeta, ROLES, PLAY_ROLES, ROLE_LABEL,
  // 共享音效库（lib/assets-packs.js / 设置页「选用」用）
  installBuiltin, useSharedSound, readSoundBuffer, mimeOf, removeDerivedFrom,
  // 素材包（assets.js）用
  exportItems, importBuffer,
  // 设置页「打开数据目录」用
  dir: soundsDir,
}
