/*
 * 自定义音效（CommonJS）：导入/删除/读取按压与释放两段音频。
 *
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

// base64 data URL 缓存：导入/删除/重载插件前有效，元信息变化时置空
let dataCache = null

function soundsDir() {
  let base = ''
  try { base = utools.getPath('userData') } catch (err) {}
  if (!base) base = os.tmpdir()
  return path.join(base, 'whale-sounds')
}

function readMeta() {
  let raw = null
  try { raw = utools.dbStorage.getItem(K.sounds) } catch (err) {}
  const one = (v) => (v && typeof v === 'object' && typeof v.ext === 'string' && OK_EXT.indexOf(v.ext) >= 0
    ? { name: String(v.name || '').slice(0, 120), ext: v.ext, at: Number(v.at) || 0 }
    : null)
  return { press: one(raw && raw.press), release: one(raw && raw.release) }
}

function writeMeta(meta) {
  try { utools.dbStorage.setItem(K.sounds, meta) } catch (err) { logErr('[whale][sounds] 写音效信息失败', err && err.message) }
}

// 删除该角色下其它扩展名的旧文件（换格式重导后不留垃圾）
function clearRoleFiles(role, keepExt) {
  const dir = soundsDir()
  for (const ext of OK_EXT) {
    if (ext === keepExt) continue
    try { fs.unlinkSync(path.join(dir, role + '.' + ext)) } catch (err) {}
  }
}

// 打开系统文件选择框，校验后复制进 userData/whale-sounds/<role>.<ext>（同名覆盖）
function importSound(role) {
  if (role !== 'press' && role !== 'release') return { ok: false, error: '未知音效段' }
  let picked
  try {
    picked = utools.showOpenDialog({
      title: role === 'press' ? '选择按压音效' : '选择释放音效',
      buttonLabel: '导入',
      filters: [{ name: '音频文件', extensions: OK_EXT }],
      properties: ['openFile'],
    })
  } catch (err) {
    logErr('[whale][sounds] 打开选择框失败', err && err.message)
    return { ok: false, error: '无法打开文件选择框：' + ((err && err.message) || err) }
  }
  const filePath = Array.isArray(picked) ? picked[0] : picked
  if (!filePath) return { ok: false, canceled: true }
  const ext = String(path.extname(filePath) || '').replace(/^\./, '').toLowerCase()
  if (OK_EXT.indexOf(ext) < 0) return { ok: false, error: '只支持 ' + OK_EXT.join(' / ') + ' 格式' }
  let stat = null
  try { stat = fs.statSync(filePath) } catch (err) {
    return { ok: false, error: '读取文件失败：' + ((err && err.message) || err) }
  }
  if (!stat.isFile()) return { ok: false, error: '请选择一个音频文件' }
  if (stat.size > MAX_BYTES) return { ok: false, error: '文件过大（限 5MB），建议 1 秒左右的短音效' }
  const dir = soundsDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(filePath, path.join(dir, role + '.' + ext))
  } catch (err) {
    logErr('[whale][sounds] 复制失败', filePath, err && err.message)
    return { ok: false, error: '复制音效失败：' + ((err && err.message) || err) }
  }
  clearRoleFiles(role, ext)
  const meta = readMeta()
  meta[role] = { name: path.basename(filePath), ext: ext, at: Date.now() }
  writeMeta(meta)
  dataCache = null
  return { ok: true, role: role, name: meta[role].name, ext: ext }
}

// 删除某段音效（文件与元信息一并清掉）
function removeSound(role) {
  if (role !== 'press' && role !== 'release') return { ok: false, error: '未知音效段' }
  clearRoleFiles(role, '')
  const meta = readMeta()
  meta[role] = null
  writeMeta(meta)
  dataCache = null
  return { ok: true, role: role }
}

// 清除全部自定义音效：音频文件 + 元信息 + 读取缓存（供设置页「清除选中数据」调用）。
// 目录清空后再尝试删除，非空或有占用时忽略失败（不影响清除结果）。
function clearAll() {
  clearRoleFiles('press', '')
  clearRoleFiles('release', '')
  try { fs.rmdirSync(soundsDir()) } catch (err) {}
  try { utools.dbStorage.removeItem(K.sounds) } catch (err) { logErr('[whale][sounds] 清除音效信息失败', err && err.message) }
  dataCache = null
  return { ok: true }
}

// 音频本体 → base64 data URL（挂件 new Audio(dataURL) 直接可播）。
// 文件丢失（用户手动清理了 userData）时按缺失处理，挂件侧回退内置音色。
function getSoundData() {
  if (dataCache) return dataCache
  const meta = readMeta()
  const out = { press: null, release: null }
  for (const role of ['press', 'release']) {
    const m = meta[role]
    if (!m) continue
    try {
      const buf = fs.readFileSync(path.join(soundsDir(), role + '.' + m.ext))
      if (buf.length > MAX_BYTES * 2) continue
      out[role] = 'data:' + (MIME[m.ext] || 'audio/mpeg') + ';base64,' + buf.toString('base64')
    } catch (err) {
      logErr('[whale][sounds] 读取音效失败', role, err && err.message)
    }
  }
  dataCache = out
  return out
}

module.exports = { importSound, removeSound, clearAll, getSoundData, readMeta }
