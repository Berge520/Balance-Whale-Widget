/*
 * 自定义挂件形象画廊（CommonJS）：导入多张图片，选一张作为挂件形象，可置顶/删除。
 *
 * 与 sounds.js 同一套路：文件复制进 uTools 用户数据目录（userData/whale-skins/），
 * 不存源路径（源文件被删/移动就失效）；元信息落 dbStorage（K.skins）。
 * 挂件页面无法可靠加载插件包外的 file:// 资源，所以推给挂件时读成 base64 data URL。
 *
 * 每张形象两个文件：<id>.<ext>（原图，推给挂件用）与 <id>.thumb.png（缩略图，画廊网格用）。
 * 缩略图由设置页用 canvas 生成后传进来 —— 网格里要同时显示多张，直接读原图（动图可能好几 MB）
 * 既慢又占内存；宿主侧没有 canvas / nativeImage 可用（preload 跑在渲染进程）。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { K } = require('./constants')
const { logErr } = require('./log')

// Chromium 能直接渲染的位图格式（不要 SVG：外部 SVG 可带脚本，且挂件是本地页面，没必要开这个口子）
// apng 的 MIME 与签名都是 image/png，Chromium 原生播放动画
const OK_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng']
const MAX_BYTES = 5 * 1024 * 1024
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', apng: 'image/png' }
// 缩略图上限（PNG data URL 解码后的字节数）：128px 方图正常只有几 KB，这里只是防异常输入
const THUMB_MAX_BYTES = 256 * 1024
// 画廊最多保留几张：元信息与缩略图都要跟着走 IPC，太多既慢也没人翻
const MAX_ITEMS = 20
// v1.5.0 及更早只有一张，文件固定叫 skin.<ext>，迁移成画廊的第一项时沿用这个 id 与文件名
const LEGACY_ID = 'skin'

// base64 data URL 缓存（只缓存「当前形象」这一张）：导入/删除/切换/重载插件前有效
let dataCache = null

function skinsDir() {
  let base = ''
  try { base = utools.getPath('userData') } catch (err) {}
  if (!base) base = os.tmpdir()
  return path.join(base, 'whale-skins')
}

// 图片体积（读取时派生，不落存储）：设置页「自定义素材」卡片要显示占多大；文件缺失回 0
function fileSize(file) {
  try { return fs.statSync(path.join(skinsDir(), file)).size } catch (err) { return 0 }
}

function readFileUrl(file, ext) {
  let buf = null
  try { buf = fs.readFileSync(path.join(skinsDir(), file)) } catch (err) { return '' }
  if (!buf.length || buf.length > MAX_BYTES * 2) return ''
  return 'data:' + (MIME[ext] || 'image/png') + ';base64,' + buf.toString('base64')
}

// 单项归一化：id 只允许安全字符（会拼进文件名），扩展名必须在白名单内
function normItem(v) {
  if (!v || typeof v !== 'object') return null
  const id = String(v.id || '')
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null
  if (typeof v.ext !== 'string' || OK_EXT.indexOf(v.ext) < 0) return null
  return { id: id, name: String(v.name || '').slice(0, 120), ext: v.ext, at: Number(v.at) || 0 }
}

// 读存储并归一化。老格式（单张 { name, ext, at }）在这里就地迁移成一项 ——
// 不单独写回存储：下次真正发生增删改时才会落盘，避免「只是打开设置页就改数据」
function readRaw() {
  let raw = null
  try { raw = utools.dbStorage.getItem(K.skins) } catch (err) {}
  if (!raw || typeof raw !== 'object') return { items: [], current: '' }
  if (!Array.isArray(raw.items)) {
    const one = normItem({ id: LEGACY_ID, name: raw.name, ext: raw.ext, at: raw.at })
    return one ? { items: [one], current: LEGACY_ID } : { items: [], current: '' }
  }
  const items = []
  for (const it of raw.items) {
    const one = normItem(it)
    if (one && !items.some((x) => x.id === one.id)) items.push(one)
    if (items.length >= MAX_ITEMS) break
  }
  const current = items.some((x) => x.id === raw.current) ? String(raw.current) : (items[0] ? items[0].id : '')
  return { items: items, current: current }
}

function writeRaw(raw) {
  try { utools.dbStorage.setItem(K.skins, raw) } catch (err) { logErr('[whale][skins] 写形象信息失败', err && err.message) }
}

// 画廊列表：元信息 + 缩略图 data URL。缩略图缺失（老格式迁移过来的那张 / 生成失败）时回落到原图：
// 老格式只可能有一张，新导入的都会带缩略图，所以给回落总量设个上限兜底，
// 避免万一多张都缺缩略图时一次 IPC 搬几十 MB
function listSkins() {
  const raw = readRaw()
  let fallbackBudget = 8 * 1024 * 1024
  return {
    current: raw.current,
    items: raw.items.map((it) => {
      const size = fileSize(it.id + '.' + it.ext)
      let thumb = readFileUrl(it.id + '.thumb.png', 'png')
      if (!thumb && size > 0 && size <= fallbackBudget) {
        thumb = readFileUrl(it.id + '.' + it.ext, it.ext)
        if (thumb) fallbackBudget -= size
      }
      return { id: it.id, name: it.name, ext: it.ext, at: it.at, size: size, thumb: thumb }
    }),
  }
}

// 兼容旧调用方：只要「当前这张」的元信息
function readMeta() {
  const raw = readRaw()
  const cur = raw.items.filter((x) => x.id === raw.current)[0] || null
  if (!cur) return null
  return { id: cur.id, name: cur.name, ext: cur.ext, at: cur.at, size: fileSize(cur.id + '.' + cur.ext) }
}

// 删除该 id 下其它扩展名的旧文件（换格式重导后不留垃圾）
function clearSkinFiles(id, keepExt) {
  const dir = skinsDir()
  for (const ext of OK_EXT) {
    if (ext === keepExt) continue
    try { fs.unlinkSync(path.join(dir, id + '.' + ext)) } catch (err) {}
  }
}

// 弹选择框并做「扩展名 + 是否文件 + 大小」校验，只回文件路径与扩展名。
// 「直接导入」与「先裁剪再导入」只差拿到文件后的处理，选择与校验共用这一份，避免两处规则跑偏。
// 返回 { filePath, ext } / { canceled: true } / { error }
function pickImage(title) {
  let picked
  try {
    picked = utools.showOpenDialog({
      title: title,
      buttonLabel: '导入',
      filters: [{ name: '图片文件', extensions: OK_EXT }],
      properties: ['openFile'],
    })
  } catch (err) {
    logErr('[whale][skins] 打开选择框失败', err && err.message)
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
  if (!stat.isFile()) return { error: '请选择一张图片' }
  if (stat.size > MAX_BYTES) return { error: '文件过大（限 5MB），建议方形透明底 PNG' }
  return { filePath: filePath, ext: ext }
}

function newId() {
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
}

// 缩略图落盘：设置页 canvas 生成，格式固定 PNG（网格里等比居中，透明留白）
function writeThumb(id, dataUrl) {
  const PREFIX = 'data:image/png;base64,'
  const url = typeof dataUrl === 'string' ? dataUrl : ''
  if (url.indexOf(PREFIX) !== 0) return
  const buf = Buffer.from(url.slice(PREFIX.length), 'base64')
  if (!buf.length || buf.length > THUMB_MAX_BYTES) return
  try { fs.writeFileSync(path.join(skinsDir(), id + '.thumb.png'), buf) } catch (err) {
    logErr('[whale][skins] 写缩略图失败', err && err.message)
  }
}

// 新增一项并把「当前形象」切过去（导了图却还在用内置形象会很困惑）。
// write 由各导入路径提供：有的复制文件，有的写内存里的字节
function addItem(name, ext, write, thumb) {
  const raw = readRaw()
  if (raw.items.length >= MAX_ITEMS) {
    return { ok: false, error: '最多保留 ' + MAX_ITEMS + ' 张形象，请先删掉不用的' }
  }
  const dir = skinsDir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch (err) {}
  const id = newId()
  try {
    write(id)
  } catch (err) {
    logErr('[whale][skins] 写入形象失败', err && err.message)
    return { ok: false, error: '保存图片失败：' + ((err && err.message) || err) }
  }
  writeThumb(id, thumb)
  const safeName = String(name || ('形象.' + ext)).slice(0, 120)
  raw.items.unshift({ id: id, name: safeName, ext: ext, at: Date.now() })
  raw.current = id
  writeRaw(raw)
  dataCache = null
  return { ok: true, id: id, name: safeName, ext: ext }
}

// 打开系统文件选择框，校验后复制进 userData/whale-skins/<新 id>.<ext>
function importSkin() {
  const picked = pickImage('选择挂件形象')
  if (picked.error) return { ok: false, error: picked.error }
  if (picked.canceled) return { ok: false, canceled: true }
  return addItem(path.basename(picked.filePath), picked.ext,
    (id) => fs.copyFileSync(picked.filePath, path.join(skinsDir(), id + '.' + picked.ext)), '')
}

// 已选好的文件直接复制（不裁剪）：动图（gif/apng）走这条路径以保留动画，
// canvas 对动图只取首帧，裁剪路径会丢掉动画帧
function importSkinFromPath(filePath, name, thumb) {
  const ext = String(path.extname(filePath) || '').replace(/^\./, '').toLowerCase()
  if (OK_EXT.indexOf(ext) < 0) return { ok: false, error: '只支持 ' + OK_EXT.join(' / ') + ' 格式' }
  return addItem(name || path.basename(filePath), ext,
    (id) => fs.copyFileSync(filePath, path.join(skinsDir(), id + '.' + ext)), thumb)
}

// 选择图片并读成 base64 data URL 返回，**不落盘**：设置页要先用它显示裁剪框，
// 确认后才由 importSkinFromData 写盘（用户中途取消不该在本地留半成品）。
function pickImageFile() {
  const picked = pickImage('选择挂件形象（可裁剪）')
  if (picked.error) return { ok: false, error: picked.error }
  if (picked.canceled) return { ok: false, canceled: true }
  let buf = null
  try { buf = fs.readFileSync(picked.filePath) } catch (err) {
    logErr('[whale][skins] 读取失败', picked.filePath, err && err.message)
    return { ok: false, error: '读取文件失败：' + ((err && err.message) || err) }
  }
  const mime = MIME[picked.ext] || 'image/png'
  return {
    ok: true,
    name: path.basename(picked.filePath),
    ext: picked.ext,
    filePath: picked.filePath,
    dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'),
  }
}

// 前端裁剪后回传的 PNG data URL：裁剪结果统一导出 PNG（要保留透明通道），所以这里只认 image/png 前缀
function importSkinFromData(name, dataUrl, thumb) {
  const PREFIX = 'data:image/png;base64,'
  const url = typeof dataUrl === 'string' ? dataUrl : ''
  if (url.indexOf(PREFIX) !== 0) return { ok: false, error: '图片数据格式不对（需要 PNG）' }
  // 按解码后的字节数校验大小：base64 字符串长度不可信（填充与字符集差异会让它偏离实际体积）
  const buf = Buffer.from(url.slice(PREFIX.length), 'base64')
  if (!buf.length) return { ok: false, error: '图片数据为空' }
  if (buf.length > MAX_BYTES) return { ok: false, error: '图片过大（限 5MB），请裁剪小一些' }
  return addItem(name || 'skin.png', 'png',
    (id) => fs.writeFileSync(path.join(skinsDir(), id + '.png'), buf), thumb)
}

// 切换「当前形象」：挂件用哪张由它决定（配置里的 skin='custom' 只表示「用自定义」）
function setCurrent(id) {
  const raw = readRaw()
  if (!raw.items.some((x) => x.id === id)) return { ok: false, error: '形象不存在' }
  raw.current = id
  writeRaw(raw)
  dataCache = null
  return { ok: true, current: id }
}

// 置顶：把该项移到画廊最前（数组顺序即展示顺序），当前形象不受影响
function pinSkin(id) {
  const raw = readRaw()
  const idx = raw.items.findIndex((x) => x.id === id)
  if (idx < 0) return { ok: false, error: '形象不存在' }
  const one = raw.items.splice(idx, 1)[0]
  raw.items.unshift(one)
  writeRaw(raw)
  return { ok: true }
}

// 删除一张（文件与元信息一并清掉）。删的是当前形象时，当前位交给剩下的第一张；
// 一张都不剩则 current 置空，由设置页把配置里的形象回退成内置
function removeSkin(id) {
  const raw = readRaw()
  const idx = raw.items.findIndex((x) => x.id === id)
  if (idx < 0) return { ok: false, error: '形象不存在' }
  const it = raw.items[idx]
  clearSkinFiles(it.id, '')
  try { fs.unlinkSync(path.join(skinsDir(), it.id + '.thumb.png')) } catch (err) {}
  raw.items.splice(idx, 1)
  if (raw.current === id) raw.current = raw.items[0] ? raw.items[0].id : ''
  writeRaw(raw)
  dataCache = null
  return { ok: true, current: raw.current, left: raw.items.length }
}

// 清除全部自定义形象（供设置页「清除选中数据」调用）
function clearAll() {
  try { fs.rmdirSync(skinsDir()) } catch (err) {}
  try { utools.dbStorage.removeItem(K.skins) } catch (err) { logErr('[whale][skins] 清除形象信息失败', err && err.message) }
  dataCache = null
  return { ok: true }
}

// 导出用：画廊每张的原图与缩略图字节（素材包打包用）。文件缺失的项跳过，
// 不因一张坏图让整包导不出去；current 一并带上，导入方可据此把「正在用的那张」置前
function exportItems() {
  const raw = readRaw()
  const out = []
  for (const it of raw.items) {
    let data = null
    try { data = fs.readFileSync(path.join(skinsDir(), it.id + '.' + it.ext)) } catch (err) { continue }
    let thumb = null
    try { thumb = fs.readFileSync(path.join(skinsDir(), it.id + '.thumb.png')) } catch (err) {}
    out.push({ name: it.name, ext: it.ext, at: it.at, data: data, thumb: thumb, current: it.id === raw.current })
  }
  return out
}

// 素材包导入：字节直接落成一个**新**画廊项（id 重新生成，不覆盖已有形象 ——
// 素材包是「补充」而不是「替换」）。导入前正在用的那张保持不动，除非画廊原本是空的。
function importBuffer(name, ext, buf, thumbBuf, at) {
  if (OK_EXT.indexOf(ext) < 0) return { ok: false, error: '不支持的图片格式：' + ext }
  if (!buf || !buf.length) return { ok: false, error: '图片数据为空' }
  if (buf.length > MAX_BYTES) return { ok: false, error: '图片过大（限 5MB）' }
  const before = readRaw().current
  const thumb = thumbBuf && thumbBuf.length ? 'data:image/png;base64,' + thumbBuf.toString('base64') : ''
  const r = addItem(name || ('形象.' + ext), ext,
    (id) => fs.writeFileSync(path.join(skinsDir(), id + '.' + ext), buf), thumb)
  if (r.ok && before) setCurrent(before)
  if (r.ok && Number(at) > 0) {
    // addItem 里写的是当下时间，导入素材包时沿用原导入时间（展示更真实）
    const raw = readRaw()
    const one = raw.items.filter((x) => x.id === r.id)[0]
    if (one) { one.at = Number(at); writeRaw(raw) }
  }
  return r
}

// 当前形象的本体 → base64 data URL（挂件 img.src 直接可用）。
// 文件丢失（用户手动清理了 userData）时按缺失处理，挂件侧回退内置形象。
function getSkinData() {
  if (dataCache !== null) return dataCache
  const raw = readRaw()
  const cur = raw.items.filter((x) => x.id === raw.current)[0]
  dataCache = cur ? readFileUrl(cur.id + '.' + cur.ext, cur.ext) : ''
  if (cur && !dataCache) logErr('[whale][skins] 读取形象失败', cur.id + '.' + cur.ext)
  return dataCache
}

module.exports = {
  importSkin, importSkinFromPath, pickImageFile, importSkinFromData,
  removeSkin, setCurrent, pinSkin, clearAll, getSkinData, listSkins, readMeta,
  // 素材包（assets.js）用
  exportItems, importBuffer,
}
