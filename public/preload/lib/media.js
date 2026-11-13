/*
 * 背景 / 片头媒体库（CommonJS）。
 *
 * 用户在「资源 → 背景与片头」导入自己的图片或视频；文件复制进 userData/whale-media/，
 * 不引用源路径、不联网。只服务设置页：背景层与启动片头读它，挂件不读。
 *
 * 图片缩略图由设置页 canvas 生成后随导入传入（宿主没有 canvas / nativeImage）；
 * 视频不抽帧，列表里只显示类型与名字，避免在宿主里解码大视频。
 */
const fs = require('fs')
const path = require('path')
const { K } = require('./constants')
const { logErr } = require('./log')
const { errMsg, writeFileAtomicSync } = require('./util')
const { readConfig, patchConfig } = require('./store')
const { dataDir } = require('./data-dir')

const MAX_ITEMS = 20
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 10 * 1024 * 1024
const MAX_THUMB_BYTES = 512 * 1024
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif']
const VID_EXT = ['mp4', 'webm']
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm',
}
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

function dir() {
  return dataDir('whale-media')
}

function filePath(id, ext) {
  return path.join(dir(), id + '.' + ext)
}

function thumbPath(id, ext) {
  return path.join(dir(), id + '.thumb.' + ext)
}

function typeOf(ext) {
  if (IMG_EXT.indexOf(ext) >= 0) return 'image'
  if (VID_EXT.indexOf(ext) >= 0) return 'video'
  return ''
}

function extOf(name) {
  return String(name || '').split('.').pop().toLowerCase()
}

function fileSize(p) {
  try { return fs.statSync(p).size } catch (err) { return 0 }
}

function readFileUrl(p, mime) {
  try {
    const buf = fs.readFileSync(p)
    return buf.length ? 'data:' + mime + ';base64,' + buf.toString('base64') : ''
  } catch (err) { return '' }
}

function normItem(v) {
  if (!v || typeof v !== 'object') return null
  const id = String(v.id || '')
  if (!ID_RE.test(id)) return null
  const ext = String(v.ext || '').toLowerCase()
  const type = typeOf(ext)
  if (!type) return null
  const size = Number(v.size) || 0
  if (!size) return null
  return { id: id, name: String(v.name || '').slice(0, 120), ext: ext, type: type, size: size, at: Number(v.at) || 0 }
}

function readRaw() {
  let raw = null
  try { raw = utools.dbStorage.getItem(K.media) } catch (err) {}
  const items = []
  if (!raw || !Array.isArray(raw.items)) return items
  for (const it of raw.items) {
    const one = normItem(it)
    if (one && !items.some((x) => x.id === one.id)) items.push(one)
  }
  return items
}

// 返回是否真的写进去了：早先只 logErr 不返回，上层一律回 ok:true，
// 用户看到「已导入」、重启后（读存储读到的仍是旧内容）那项却不在列表里。
function writeRaw(items) {
  try {
    utools.dbStorage.setItem(K.media, { items: items })
    return true
  } catch (err) {
    logErr('[whale][media] 写入媒体信息失败', err && err.message)
    return false
  }
}

// 元信息没写进去时回滚已落盘的文件，避免留下打不开的孤儿文件
function discardFiles(id) {
  for (const ext of IMG_EXT.concat(VID_EXT)) {
    try { fs.unlinkSync(filePath(id, ext)) } catch (err) {}
  }
  for (const ext of ['webp', 'png']) {
    try { fs.unlinkSync(thumbPath(id, ext)) } catch (err) {}
  }
}

function readThumb(id) {
  for (const ext of ['webp', 'png']) {
    const url = readFileUrl(thumbPath(id, ext), 'image/' + ext)
    if (url) return url
  }
  return ''
}

function list() {
  const items = readRaw()
  const out = []
  for (const it of items) {
    const size = fileSize(filePath(it.id, it.ext))
    if (!size) continue
    out.push({
      id: it.id, name: it.name, ext: it.ext, type: it.type, size: size, at: it.at,
      thumb: it.type === 'image' ? readThumb(it.id) : '',
    })
  }
  return { ok: true, items: out }
}

// 弹选择框并做扩展名 / 文件 / 体积校验。图片额外回 data URL 供设置页生成缩略图；
// 视频不回内容，避免把 10MB 的字节搬进渲染进程后还得再搬回来。
function pick(kind) {
  const want = kind === 'video' ? 'video' : 'image'
  const exts = want === 'video' ? VID_EXT : IMG_EXT
  let picked
  try {
    picked = utools.showOpenDialog({
      title: want === 'video' ? '选择背景/片头视频' : '选择背景图片',
      buttonLabel: '导入',
      filters: [{ name: want === 'video' ? '视频文件' : '图片文件', extensions: exts }],
      properties: ['openFile'],
    })
  } catch (err) {
    logErr('[whale][media] 打开选择框失败', err && err.message)
    return { ok: false, error: '无法打开文件选择框：' + errMsg(err) }
  }
  const file = Array.isArray(picked) ? picked[0] : picked
  if (!file) return { ok: false, canceled: true }
  const ext = extOf(file)
  if (exts.indexOf(ext) < 0) return { ok: false, error: '只支持 ' + exts.join(' / ') + ' 格式' }
  let stat = null
  try { stat = fs.statSync(file) } catch (err) { return { ok: false, error: '读取文件失败：' + errMsg(err) } }
  if (!stat.isFile()) return { ok: false, error: '请选择一个文件' }
  const max = want === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
  if (stat.size > max) return { ok: false, error: `文件过大（限 ${max / 1024 / 1024}MB）` }
  const result = {
    ok: true, name: path.basename(file), ext: ext, type: want, size: stat.size, filePath: file,
  }
  if (want === 'image') {
    const url = readFileUrl(file, MIME[ext] || 'image/png')
    if (url) result.dataUrl = url
  }
  return result
}

function writeThumb(id, dataUrl) {
  const url = typeof dataUrl === 'string' ? dataUrl : ''
  const m = /^data:image\/(webp|png);base64,/.exec(url)
  if (!m) return
  const buf = Buffer.from(url.slice(m[0].length), 'base64')
  if (!buf.length || buf.length > MAX_THUMB_BYTES) return
  try { fs.mkdirSync(dir(), { recursive: true }) } catch (err) {
    logErr('[whale][media] 创建缩略图目录失败', err && err.message)
    return
  }
  // 原子写：缩略图写一半会让列表读出一张坏图
  const w = writeFileAtomicSync(thumbPath(id, m[1]), buf)
  if (!w.ok) logErr('[whale][media] 写缩略图失败', w.error)
}

// 导入已选好的文件：校验 -> 复制 -> 写元信息。thumb 只有图片会带（设置页 canvas 生成）。
function importFile(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const file = String(o.filePath || '')
  if (!file) return { ok: false, error: '缺少文件路径' }
  const ext = extOf(file)
  const type = typeOf(ext)
  if (!type) return { ok: false, error: '不支持的文件格式' }
  let stat = null
  try { stat = fs.statSync(file) } catch (err) { return { ok: false, error: '读取文件失败：' + errMsg(err) } }
  if (!stat.isFile()) return { ok: false, error: '请选择一个文件' }
  const max = type === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
  if (stat.size > max) return { ok: false, error: `文件过大（限 ${max / 1024 / 1024}MB）` }
  // 只把文件真实存在的条目计入配额：用户手动清空 whale-media 后，元数据里的「幽灵项」
  // 会让界面显示 0 项、导入却报「已满」；顺手把幽灵项清掉（读存储失败时保持原样）
  const rawItems = readRaw()
  const items = rawItems.filter((it) => {
    try { return fs.statSync(filePath(it.id, it.ext)).isFile() } catch (err) { return false }
  })
  if (items.length >= MAX_ITEMS) return { ok: false, error: `最多保留 ${MAX_ITEMS} 项媒体，请先删掉不用的` }
  if (items.length !== rawItems.length) {
    // 只是顺手清理「文件已不在」的幽灵记录，写失败不影响本次导入（下次导入再清一次）
    writeRaw(items)
  }
  const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  try {
    fs.mkdirSync(dir(), { recursive: true })
    fs.copyFileSync(file, filePath(id, ext))
  } catch (err) {
    logErr('[whale][media] 写入媒体失败', err && err.message)
    return { ok: false, error: '保存文件失败：' + errMsg(err) }
  }
  if (type === 'image') writeThumb(id, o.thumb)
  const item = {
    id: id, name: String(o.name || path.basename(file)).slice(0, 120), ext: ext,
    type: type, size: stat.size, at: Date.now(),
  }
  items.unshift(item)
  // 元信息写不进去就是「导入失败」：文件已在磁盘上但列表里没有它，
  // 不报错的话用户以为导进去了，重启后那项凭空消失。回滚已落盘的文件再按失败返回。
  if (!writeRaw(items)) {
    discardFiles(id)
    return { ok: false, error: '媒体信息保存失败（本地存储写入失败），请稍后重试' }
  }
  return { ok: true, item: item }
}

// 删除一项；如果它正被背景/片头引用，顺手把引用退回安全默认值。
// 返回 configChanged 供 settings.js 决定是否 pushConfig。
function remove(id) {
  const key = String(id || '')
  if (!ID_RE.test(key)) return { ok: false, error: '媒体不存在' }
  const items = readRaw()
  const idx = items.findIndex((x) => x.id === key)
  if (idx < 0) return { ok: false, error: '媒体不存在' }
  const it = items[idx]
  try { fs.unlinkSync(filePath(it.id, it.ext)) } catch (err) {}
  for (const ext of ['webp', 'png']) {
    try { fs.unlinkSync(thumbPath(it.id, ext)) } catch (err) {}
  }
  items.splice(idx, 1)
  // 元信息没删掉就是「删除失败」：文件已删、记录还在，读回时是一张打不开的坏图
  if (!writeRaw(items)) return { ok: false, error: '删除失败（本地存储写入失败），请稍后重试' }
  let configChanged = false
  try {
    const cfg = readConfig()
    const p = {}
    // 只有当前背景真的用着自定义媒体时才退回 off：bgMediaId 可能是历史引用，
    // 而 bgMode 已是 aurora / video，无条件置 off 会把用户正在用的背景误关
    if (cfg.bgMode === 'custom' && cfg.bgMediaId === key) { p.bgMode = 'off'; p.bgMediaId = ''; configChanged = true }
    if (cfg.bootIntroMediaId === key) { p.bootIntroSource = 'auto'; p.bootIntroMediaId = ''; configChanged = true }
    if (configChanged) patchConfig(p)
  } catch (err) { logErr('[whale][media] 回退媒体引用失败', err && err.message) }
  return { ok: true, configChanged: configChanged }
}

// 设置页背景层 / 片头用：读成 data URL。视频最大 10MB，转 base64 约 14MB，只按需读一次。
function data(id) {
  const key = String(id || '')
  if (!ID_RE.test(key)) return { ok: false, error: '媒体不存在' }
  const it = readRaw().filter((x) => x.id === key)[0]
  if (!it) return { ok: false, error: '媒体不存在' }
  const url = readFileUrl(filePath(it.id, it.ext), MIME[it.ext] || 'application/octet-stream')
  if (!url) return { ok: false, error: '媒体文件已丢失' }
  return { ok: true, dataUrl: url, type: it.type, size: it.size }
}

function clearAll() {
  const items = readRaw()
  for (const it of items) {
    try { fs.unlinkSync(filePath(it.id, it.ext)) } catch (err) {}
    for (const ext of ['webp', 'png']) { try { fs.unlinkSync(thumbPath(it.id, ext)) } catch (err) {} }
  }
  try { utools.dbStorage.removeItem(K.media) } catch (err) {}
  let configChanged = false
  try {
    const cfg = readConfig()
    const p = {}
    if (cfg.bgMode === 'custom' && cfg.bgMediaId) { p.bgMode = 'off'; p.bgMediaId = ''; configChanged = true }
    if (cfg.bootIntroMediaId) { p.bootIntroSource = 'auto'; p.bootIntroMediaId = ''; configChanged = true }
    if (configChanged) patchConfig(p)
  } catch (err) {}
  return { ok: true, configChanged: configChanged }
}

// 调试专用（只在设置页调试开关下经 settings.debugInjectLegacy 调用）：
// 往库里塞一条「元数据在、文件不在」的幽灵项，用来回归历史故障 —— 导入时报「已满」、
// 列表数与实际文件数对不上（见 importFile 里的清扫逻辑）。不写真文件，
// list() 会按文件存在性过滤掉它，下一次真实导入的清扫会把它从元数据里删掉。
function injectGhost() {
  const items = readRaw()
  const id = 'ghost' + Date.now().toString(36)
  items.push({ id: id, name: 'ghost.png', ext: 'png', type: 'image', size: 1, at: Date.now() })
  if (!writeRaw(items)) return ''
  return id
}

module.exports = {
  dir, list, pick, importFile, remove, data, clearAll, injectGhost,
  _normItem: normItem, _typeOf: typeOf,
}
