/*
 * 自定义气泡图片（CommonJS）：导入多张图片，点鲸鱼时气泡里随机显示一张。
 *
 * 与 skins.js 同一套路：文件复制进 uTools 用户数据目录（userData/whale-bubbles/），
 * 不存源路径（源文件被删/移动就失效）；元信息落 dbStorage（K.bubbles）。
 * 挂件页面加载不了插件包外的 file:// 资源，所以推给挂件时读成 base64 data URL。
 *
 * 每张两个文件：<id>.<ext>（原图，推给挂件用）与 <id>.thumb.png（缩略图，设置页网格用）。
 * 缩略图由设置页用 canvas 生成后传进来 —— 宿主 preload 跑在渲染进程，没有 canvas 可用。
 * 与形象不同，气泡图**一律原样落盘**（不裁剪、不重编码）：气泡里放的多是动图或整图，
 * 裁剪没意义，canvas 重编码还会丢掉动画帧。
 *
 * 与形象 / 音效的又一处不同：这里没有「当前用哪张」的概念 —— 有图就随机抽一张显示，
 * 一张都没有时挂件回退内置的 rua.webp（所以也没有开关，想恢复内置图删掉即可）。
 */
const fs = require('fs')
const path = require('path')
const { K, MEDIA_IMPORT_MAX_BYTES: MAX_BYTES, MEDIA_LIMIT_TEXT } = require('./constants')
const { logErr } = require('./log')
const { errMsg, writeFileAtomicSync } = require('./util')
const { dataDir } = require('./data-dir')

// Chromium 能直接渲染的位图格式（不要 SVG：外部 SVG 可带脚本，且挂件是本地页面，没必要开这个口子）
// apng 的 MIME 与签名都是 image/png，Chromium 原生播放动画
const OK_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng']
// 单文件上限与文案都来自 constants，别在这里再写死字节数或「5MB」字样
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', apng: 'image/png' }
// 导入时按 data URL 的 MIME 定扩展名（apng 的 MIME 就是 image/png，落成 .png 不影响播放）
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
// 缩略图上限（PNG data URL 解码后的字节数）：128px 方图正常只有几 KB，这里只是防异常输入
const THUMB_MAX_BYTES = 256 * 1024
// 最多几张：每张都要原样推给挂件，太多既慢也占内存
const MAX_ITEMS = 8
// 推给挂件的总预算（解码后字节）：挂件要一次拿到全部图片才好随机抽，
// 超预算的跳过并留日志 —— 气泡图正常几百 KB，撞到这个上限只可能是误导入了大图
const PUSH_BUDGET = 20 * 1024 * 1024

// 推送缓存：整池 base64 只在内容变化时重读重编码。
// pushInit 在开窗冷启动的同步链路上，不缓存就是每次打开挂件都把图池重搬一遍。
// 失效点必须覆盖「池子内容会变」的每一条 —— 写路径都经 writeRaw，clearAll 另走 removeItem，
// 所以只有这两处需要作废；缩略图单独写（writeThumb）不改图片本体，不作废。
let pushCache = null

function bubblesDir() {
  return dataDir('whale-bubbles')
}

// 图片体积（读取时派生，不落存储）：设置页要显示占多大；文件缺失回 0
function fileSize(file) {
  try { return fs.statSync(path.join(bubblesDir(), file)).size } catch (err) { return 0 }
}

function readFileUrl(file, ext) {
  let buf = null
  try { buf = fs.readFileSync(path.join(bubblesDir(), file)) } catch (err) { return '' }
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

function readRaw() {
  let raw = null
  try { raw = utools.dbStorage.getItem(K.bubbles) } catch (err) {}
  if (!Array.isArray(raw)) return []
  const out = []
  for (const it of raw) {
    const one = normItem(it)
    if (one && !out.some((x) => x.id === one.id)) out.push(one)
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

function writeRaw(items) {
  pushCache = null
  try {
    utools.dbStorage.setItem(K.bubbles, items)
    return true
  } catch (err) {
    logErr('[whale][bubbles] 写气泡图信息失败', err && err.message)
    return false
  }
}

// 元信息没写进去时回滚已落盘的文件，避免留下孤儿图
function discardFiles(id) {
  for (const ext of OK_EXT) { try { fs.unlinkSync(path.join(bubblesDir(), id + '.' + ext)) } catch (err) {} }
  try { fs.unlinkSync(path.join(bubblesDir(), id + '.thumb.png')) } catch (err) {}
}

// 列表：元信息 + 缩略图 data URL（缩略图缺失时给空串，网格显示占位）
function listBubbles() {
  return {
    items: readRaw().map((it) => ({
      id: it.id, name: it.name, ext: it.ext, at: it.at,
      size: fileSize(it.id + '.' + it.ext),
      thumb: readFileUrl(it.id + '.thumb.png', 'png'),
    })),
  }
}

function pickBubbleFile() {
  let picked
  try {
    picked = utools.showOpenDialog({
      title: '选择气泡图片',
      buttonLabel: '导入',
      filters: [{ name: '图片文件', extensions: OK_EXT }],
      properties: ['openFile'],
    })
  } catch (err) {
    logErr('[whale][bubbles] 打开选择框失败', err && err.message)
    return { ok: false, error: '无法打开文件选择框：' + errMsg(err) }
  }
  const filePath = Array.isArray(picked) ? picked[0] : picked
  if (!filePath) return { ok: false, canceled: true }
  const ext = String(path.extname(filePath) || '').replace(/^\./, '').toLowerCase()
  if (OK_EXT.indexOf(ext) < 0) return { ok: false, error: '只支持 ' + OK_EXT.join(' / ') + ' 格式' }
  let stat = null
  try { stat = fs.statSync(filePath) } catch (err) {
    return { ok: false, error: '读取文件失败：' + errMsg(err) }
  }
  if (!stat.isFile()) return { ok: false, error: '请选择一张图片' }
  if (stat.size > MAX_BYTES) return { ok: false, error: '文件过大（限 ' + MEDIA_LIMIT_TEXT + '）' }
  let buf = null
  try { buf = fs.readFileSync(filePath) } catch (err) {
    logErr('[whale][bubbles] 读取失败', filePath, err && err.message)
    return { ok: false, error: '读取文件失败：' + errMsg(err) }
  }
  // 只回 data URL、不落盘：设置页要先用它生成缩略图，确认后才由 importBubbleFromData 写盘
  return {
    ok: true,
    name: path.basename(filePath),
    ext: ext,
    dataUrl: 'data:' + (MIME[ext] || 'image/png') + ';base64,' + buf.toString('base64'),
  }
}

function newId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
}

// 缩略图落盘：设置页 canvas 生成，格式固定 PNG
function writeThumb(id, dataUrl) {
  const PREFIX = 'data:image/png;base64,'
  const url = typeof dataUrl === 'string' ? dataUrl : ''
  if (url.indexOf(PREFIX) !== 0) return
  const buf = Buffer.from(url.slice(PREFIX.length), 'base64')
  if (!buf.length || buf.length > THUMB_MAX_BYTES) return
  // 原子写：缩略图写一半会让设置页网格读出一张坏图
  const w = writeFileAtomicSync(path.join(bubblesDir(), id + '.thumb.png'), buf)
  if (!w.ok) logErr('[whale][bubbles] 写缩略图失败', w.error)
}

// 原图落盘：走原子写（先写临时文件再 rename），断点 / 磁盘满不会留下半张图被气泡抽中。
// writeFileAtomicSync 不抛错、只返回 {ok,error}，而 addItem 靠 try/catch 转 {ok:false}，
// 所以这里失败要显式抛出，保持「保存图片失败：…」的统一提示口径。
function writeImage(file, buf) {
  const w = writeFileAtomicSync(file, buf)
  if (!w.ok) throw new Error(w.error)
}

// 新增一项（追加到末尾：抽取是随机的，顺序不影响显示，列表按导入先后排更直观）
function addItem(name, ext, write, thumb) {
  const items = readRaw()
  if (items.length >= MAX_ITEMS) {
    return { ok: false, error: '最多保留 ' + MAX_ITEMS + ' 张气泡图，请先删掉不用的' }
  }
  try { fs.mkdirSync(bubblesDir(), { recursive: true }) } catch (err) {}
  const id = newId()
  try {
    write(id)
  } catch (err) {
    logErr('[whale][bubbles] 写入气泡图失败', err && err.message)
    return { ok: false, error: '保存图片失败：' + errMsg(err) }
  }
  writeThumb(id, thumb)
  const safeName = String(name || ('气泡图.' + ext)).slice(0, 120)
  items.push({ id: id, name: safeName, ext: ext, at: Date.now() })
  // 元信息写不进去就是「导入失败」：图已落盘但池子里没有它，不报错用户以为导进去了，
  // 重启后（读存储读到的仍是旧池子）那张图凭空消失。回滚已落盘的图再按失败返回。
  if (!writeRaw(items)) {
    discardFiles(id)
    return { ok: false, error: '气泡图信息保存失败（本地存储写入失败），请稍后重试' }
  }
  return { ok: true, id: id, name: safeName, ext: ext }
}

// 设置页已选好文件（pickBubbleFile 给的 data URL）后写盘：字节原样落盘，不重编码
function importBubbleFromData(name, dataUrl, thumb) {
  const url = typeof dataUrl === 'string' ? dataUrl : ''
  const m = /^data:([a-z0-9/+.-]+);base64,([\s\S]+)$/i.exec(url)
  if (!m) return { ok: false, error: '图片数据格式不对' }
  const ext = EXT_BY_MIME[String(m[1]).toLowerCase()]
  if (!ext) return { ok: false, error: '只支持 ' + OK_EXT.join(' / ') + ' 格式' }
  // 按解码后的字节数校验大小：base64 字符串长度不可信（填充与字符集差异会让它偏离实际体积）
  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length) return { ok: false, error: '图片数据为空' }
  if (buf.length > MAX_BYTES) return { ok: false, error: '图片过大（限 ' + MEDIA_LIMIT_TEXT + '）' }
  return addItem(name || ('气泡图.' + ext), ext,
    (id) => writeImage(path.join(bubblesDir(), id + '.' + ext), buf), thumb)
}

function removeBubble(id) {
  const items = readRaw()
  const idx = items.findIndex((x) => x.id === id)
  if (idx < 0) return { ok: false, error: '气泡图不存在' }
  const it = items[idx]
  // 逐扩展名删：早期版本可能因换格式留下过同 id 的其它后缀文件
  for (const ext of OK_EXT) { try { fs.unlinkSync(path.join(bubblesDir(), it.id + '.' + ext)) } catch (err) {} }
  try { fs.unlinkSync(path.join(bubblesDir(), it.id + '.thumb.png')) } catch (err) {}
  items.splice(idx, 1)
  // 元信息没删掉就是「删除失败」：图已删、记录还在，读回时是一张打不开的坏图
  if (!writeRaw(items)) return { ok: false, error: '删除失败（本地存储写入失败），请稍后重试' }
  return { ok: true, left: items.length }
}

// 清除全部气泡图（供设置页「清除选中数据」/「清除全部素材」调用）。
// 删不动（被占用）不影响清除结果，但必须 logErr 留痕（与 skins.js / sounds.js 对齐）
function clearAll() {
  pushCache = null
  try { fs.rmSync(bubblesDir(), { recursive: true, force: true }) } catch (err) {
    logErr('[whale][bubbles] 清除气泡图文件失败', err && err.message)
  }
  try { utools.dbStorage.removeItem(K.bubbles) } catch (err) { logErr('[whale][bubbles] 清除气泡图信息失败', err && err.message) }
  return { ok: true }
}

// 推给挂件的全部图片（base64 data URL 数组）：挂件点气泡时随机抽一张。
// 文件缺失（用户手动清理了 userData）的项直接跳过，页面拿到几张用几张
function getBubbleData() {
  if (pushCache !== null) return pushCache
  const out = []
  let budget = PUSH_BUDGET
  for (const it of readRaw()) {
    let buf = null
    try { buf = fs.readFileSync(path.join(bubblesDir(), it.id + '.' + it.ext)) } catch (err) { continue }
    if (!buf.length) continue
    if (buf.length > budget) {
      logErr('[whale][bubbles] 超出推送预算，已跳过', it.id + '.' + it.ext, buf.length)
      continue
    }
    budget -= buf.length
    out.push('data:' + (MIME[it.ext] || 'image/png') + ';base64,' + buf.toString('base64'))
  }
  pushCache = out
  return out
}

// 导出用：每张的原图与缩略图字节（素材包打包用）。文件缺失的项跳过，
// 不因一张坏图让整包导不出去
function exportItems() {
  const out = []
  for (const it of readRaw()) {
    let data = null
    try { data = fs.readFileSync(path.join(bubblesDir(), it.id + '.' + it.ext)) } catch (err) { continue }
    let thumb = null
    try { thumb = fs.readFileSync(path.join(bubblesDir(), it.id + '.thumb.png')) } catch (err) {}
    out.push({ name: it.name, ext: it.ext, at: it.at, data: data, thumb: thumb })
  }
  return out
}

// 素材包导入 / 恢复备份共用的可写性校验：格式、空数据、体积。
// 备份恢复前要先用它整体过一遍（提前筛掉坏项，避免「清空了现有图却一张也写不进去」），
// 口径必须与真正落盘时一致，所以只在这里判一处。
function checkImport(ext, buf) {
  if (OK_EXT.indexOf(ext) < 0) return { ok: false, error: '不支持的图片格式：' + ext }
  if (!buf || !buf.length) return { ok: false, error: '图片数据为空' }
  if (buf.length > MAX_BYTES) return { ok: false, error: '图片过大（限 ' + MEDIA_LIMIT_TEXT + '）' }
  return { ok: true, error: '' }
}

// 素材包导入：字节直接落成一项（与形象一样是「补充」，不动已有图片）
function importBuffer(name, ext, buf, thumbBuf, at) {
  const bad = checkImport(ext, buf)
  if (!bad.ok) return bad
  const thumb = thumbBuf && thumbBuf.length ? 'data:image/png;base64,' + thumbBuf.toString('base64') : ''
  const r = addItem(name || ('气泡图.' + ext), ext,
    (id) => writeImage(path.join(bubblesDir(), id + '.' + ext), buf), thumb)
  if (r.ok && Number(at) > 0) {
    // addItem 里写的是当下时间，导入素材包时沿用原导入时间（展示更真实）
    const items = readRaw()
    const one = items.filter((x) => x.id === r.id)[0]
    if (one) { one.at = Number(at); writeRaw(items) }
  }
  return r
}

module.exports = {
  listBubbles, pickBubbleFile, importBubbleFromData, removeBubble, clearAll, getBubbleData,
  // 素材包（assets.js）用
  exportItems, importBuffer,
  // 恢复备份前的可写性预检（backup.js 用，与 importBuffer 同一把尺子）
  checkImport,
  // 设置页「打开数据目录」用
  dir: bubblesDir,
}
