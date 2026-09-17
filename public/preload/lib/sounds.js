/*
 * 自定义音效（CommonJS）：导入/删除/读取按压、释放两段交互音，以及四类提醒各自的提醒音。
 *
 * 每个槽位是「音效组」——可以导入多段，挂件每次随机播一条（听久了不腻）。
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
const ROLES = ['press', 'release', 'low', 'budget', 'peak', 'pass']
const ROLE_LABEL = {
  press: '按压音效', release: '释放音效',
  low: '低余额提醒音', budget: '预算提醒音', peak: '峰谷提醒音', pass: '穿透提醒音',
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
  return {
    name: String(v.name || file).slice(0, 120),
    ext: ext,
    at: Number(v.at) || 0,
    file: file,
    size: fileSize(file),
  }
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

// 写盘 + 落元信息：所有导入路径（选文件 / 裁剪回传 / 素材包）共用。
// opts.at 记导入时间，opts.replace 为真时按同名覆盖（素材包导入用，见 importBuffer）
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
  const dup = o.replace ? list.findIndex((x) => x.name === item.name) : -1
  const old = dup >= 0 ? list[dup] : null
  // 同名替换且扩展名没变时直接复用原文件名，免得每次导入都换一个名字
  item.file = old && old.ext === ext ? old.file : nextFile(role, ext, old && old.file)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, item.file), buf)
  } catch (err) {
    logErr('[whale][sounds] 写入音效失败', role, err && err.message)
    return { ok: false, error: '保存音效失败：' + ((err && err.message) || err) }
  }
  if (old && old.file !== item.file) { try { fs.unlinkSync(path.join(dir, old.file)) } catch (err) {} }
  if (dup >= 0) list[dup] = item
  else list.push(item)
  meta[role] = list
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
  for (const role of ROLES) {
    for (const m of meta[role]) {
      let data = null
      try { data = fs.readFileSync(path.join(soundsDir(), m.file)) } catch (err) { continue }
      out.push({ role: role, name: m.name, ext: m.ext, at: m.at, data: data })
    }
  }
  return out
}

// 素材包导入：同名覆盖、其余追加。同名覆盖是为了让「导入素材包」可重复执行
// （同一个包导两遍不该翻倍）；文件名不同则视为新增一段
function importBuffer(role, name, ext, buf, at) {
  if (ROLES.indexOf(role) < 0) return { ok: false, error: '未知音效段' }
  const e = String(ext || '').toLowerCase()
  if (OK_EXT.indexOf(e) < 0) return { ok: false, error: '不支持的音频格式：' + ext }
  if (!buf || !buf.length) return { ok: false, error: '音频数据为空' }
  if (buf.length > MAX_BYTES) return { ok: false, error: '音频过大（限 5MB）' }
  return saveOne(role, name || (role + '.' + e), e, buf, { at: at, replace: true })
}

// 音频本体 → base64 data URL 数组（挂件随机取一条 new Audio(dataURL) 播放）。
// 文件丢失（用户手动清理了 userData）时按缺失处理，挂件侧回退内置音色 / 提醒音静音。
function getSoundData() {
  if (dataCache) return dataCache
  const meta = readMeta()
  const out = {}
  for (const role of ROLES) {
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
  removeSound, clearAll, getSoundData, readMeta, ROLES,
  // 素材包（assets.js）用
  exportItems, importBuffer,
}
