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

// 单项归一化：id 只允许安全字符（会拼进文件名），扩展名必须在白名单内。
// builtin 标记：内置可下载形象落进画廊时带 true（见 lib/skin-packs.js），用于
// ① 不计入 MAX_ITEMS 配额（用户自己导入 20 张不该被官方图挤掉）② 展示时区分「官方」角标。
// 用户自己导入的项没有这个字段，一律按 false 处理。
// random 标记：是否参与「随机」抽签。**缺省视为 true**（老记录 / 新装项默认都参与），
// 只有用户显式关掉时才是 false —— 这样「随机」不会因为升级后字段缺失而突然抽不到东西。
function normItem(v) {
  if (!v || typeof v !== 'object') return null
  const id = String(v.id || '')
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null
  if (typeof v.ext !== 'string' || OK_EXT.indexOf(v.ext) < 0) return null
  const one = { id: id, name: String(v.name || '').slice(0, 120), ext: v.ext, at: Number(v.at) || 0 }
  if (v.builtin === true) one.builtin = true
  if (v.random === false) one.random = false
  return one
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
  // 配额只数「用户自己导入的」（builtin 不算）：官方可下载形象（内置包 + 共享角色）全落这里，
  // 若计入配额，用户导入几张就装不下官方图了。总量仍受数组长度保护（不会无限增长）。
  let own = 0
  for (const it of raw.items) {
    const one = normItem(it)
    if (one && !items.some((x) => x.id === one.id)) {
      if (!one.builtin && own >= MAX_ITEMS) continue
      if (!one.builtin) own++
      items.push(one)
    }
  }
  const current = items.some((x) => x.id === raw.current) ? String(raw.current) : (items[0] ? items[0].id : '')
  return { items: items, current: current }
}

function writeRaw(raw) {
  try { utools.dbStorage.setItem(K.skins, raw) } catch (err) { logErr('[whale][skins] 写形象信息失败', err && err.message) }
}

// 缩略图读取：优先 png（用户导入时设置页 canvas 生成），其次 webp（共享角色 / 内置包打包时生成）。
// 两者互斥 —— writeThumb 落盘时会清掉另一格式，这里按序探测只是兼容历史数据。
function readThumb(id) {
  return readFileUrl(id + '.thumb.png', 'png') || readFileUrl(id + '.thumb.webp', 'webp')
}

// 缩略图「文件是否存在」—— 注意不能用 readThumb(id) 非空来判断：listSkins 的 thumb 字段带回落
// （没有缩略图时会塞回原图 data URL），光看列表分不出「真没有缩略图」还是「回落来的」。
// 用途：setThumb 判断要不要补，以及导出（exportItems）时区分「真没有」与「回落显示」。
function hasThumbFile(id) {
  const dir = skinsDir()
  for (const ext of ['png', 'webp']) {
    try { if (fs.statSync(path.join(dir, id + '.thumb.' + ext)).size > 0) return true } catch (err) {}
  }
  return false
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
      let thumb = readThumb(it.id)
      if (!thumb && size > 0 && size <= fallbackBudget) {
        thumb = readFileUrl(it.id + '.' + it.ext, it.ext)
        if (thumb) fallbackBudget -= size
      }
      return {
        id: it.id, name: it.name, ext: it.ext, at: it.at, size: size, thumb: thumb,
        builtin: it.builtin === true,
        // 缺省 true：老记录没有该字段时，设置页应显示为「参与随机」
        random: it.random !== false,
      }
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

// 缩略图落盘：设置页 canvas 生成，格式固定 PNG（网格里等比居中，透明留白）。
// 也接受 webp —— 共享角色/内置包的缩略图是打包时生成好的 .webp（体积比 PNG 小一半），
// 没必要在宿主里解码重压。扩展名按实际字节走，读回时按同名探测（见 listSkins）。
function writeThumb(id, dataUrl) {
  const url = typeof dataUrl === 'string' ? dataUrl : ''
  const m = /^data:image\/(png|webp);base64,/.exec(url)
  if (!m) return false
  const ext = m[1]
  const buf = Buffer.from(url.slice(m[0].length), 'base64')
  if (!buf.length || buf.length > THUMB_MAX_BYTES) return false
  const dir = skinsDir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch (err) {}
  // 清掉另一格式的旧缩略图，避免 png/webp 两份并存时读回取到过期的那份
  for (const other of ['png', 'webp']) {
    if (other === ext) continue
    try { fs.unlinkSync(path.join(dir, id + '.thumb.' + other)) } catch (err) {}
  }
  try { fs.writeFileSync(path.join(dir, id + '.thumb.' + ext), buf) } catch (err) {
    logErr('[whale][skins] 写缩略图失败', err && err.message)
    return false
  }
  return true
}

// 新增一项并把「当前形象」切过去（导了图却还在用内置形象会很困惑）。
// write 由各导入路径提供：有的复制文件，有的写内存里的字节。
// opts.keepCurrent：true 时不切「当前形象」（素材包/官方图导入用 —— 会在画廊里一次进好几张，
//   不该把用户正在用的那张顶掉）。opts.id / opts.builtin：官方可下载形象用固定 id 落盘
//   （id = 形象名，保证「已下载」判定与去重），并打上官方标记。
function addItem(name, ext, write, thumb, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const raw = readRaw()
  // 固定 id：已存在同 id 的项时直接复用（重复下载），不新增
  if (o.id) {
    const exist = raw.items.filter((x) => x.id === o.id)[0]
    if (exist) {
      try { write(o.id) } catch (err) {
        logErr('[whale][skins] 覆盖形象失败', o.id, err && err.message)
        return { ok: false, error: '保存图片失败：' + ((err && err.message) || err) }
      }
      writeThumb(o.id, thumb)
      // 重复下载官方图时补正元信息：名字从 id 短哈希升成中文原名（旧记录），或补上 builtin 标记
      let dirty = false
      if (o.builtin === true && exist.builtin !== true) { exist.builtin = true; dirty = true }
      if (o.displayName && exist.name !== o.displayName) { exist.name = String(o.displayName).slice(0, 120); dirty = true }
      if (dirty) writeRaw(raw)
      dataCache = null
      return { ok: true, id: o.id, name: exist.name, ext: ext, existed: true }
    }
  }
  // 配额只数「用户自己导入的」：官方图不算，否则用户导入几张就装不下官方那 12 张
  const ownCount = raw.items.filter((x) => x.builtin !== true).length
  if (!o.id && ownCount >= MAX_ITEMS) {
    return { ok: false, error: '最多保留 ' + MAX_ITEMS + ' 张形象，请先删掉不用的' }
  }
  const dir = skinsDir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch (err) {}
  const id = o.id || newId()
  try {
    write(id)
  } catch (err) {
    logErr('[whale][skins] 写入形象失败', err && err.message)
    return { ok: false, error: '保存图片失败：' + ((err && err.message) || err) }
  }
  writeThumb(id, thumb)
  const safeName = String(name || ('形象.' + ext)).slice(0, 120)
  const item = { id: id, name: safeName, ext: ext, at: Date.now() }
  if (o.builtin === true) item.builtin = true
  raw.items.unshift(item)
  if (o.keepCurrent !== true) raw.current = id
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

// 移动某张在画廊里的位置（数组顺序即展示顺序），当前形象不受影响。
// to: 'top' = 移到最前；'up' / 'down' = 上下挪一格；'to' = 移到指定下标（配合拖拽落点）。
// 旧接口叫 pinSkin（只能置顶、且再点无反馈），v1.9.x 换成能上下调的 moveSkin：
// 用户既能微调相邻顺序，也能一键置顶，「置顶」不再是「点了没反应」的黑洞。
function moveSkin(id, to, index) {
  const raw = readRaw()
  const idx = raw.items.findIndex((x) => x.id === id)
  if (idx < 0) return { ok: false, error: '形象不存在' }
  let want
  if (to === 'to') {
    // 拖拽落点：先把目标夹到合法范围（前端算出的 index 可能因为列表刚变而越界）
    want = Math.max(0, Math.min(Number(index) || 0, raw.items.length - 1))
  } else {
    want = to === 'top' ? 0 : to === 'up' ? idx - 1 : to === 'down' ? idx + 1 : idx
  }
  if (want === idx) return { ok: true, moved: false }   // 已在边界：不回错，让设置页据此提示「已是最前 / 最后」
  if (want < 0 || want >= raw.items.length) return { ok: true, moved: false }
  const one = raw.items.splice(idx, 1)[0]
  raw.items.splice(want, 0, one)
  writeRaw(raw)
  return { ok: true, moved: true, index: want }
}

// 一次把多张整体搬走（设置页选中一批后「置顶」/ 拖拽落点）：搬到 index 位置，
// 被搬的那批保持它们在原列表里的相对顺序，当前形象不受影响。**一趟写盘**。
// 与 moveSkin 的关系：moveSkin 是单张的通用接口（还带 'up'/'down'），本函数是它的批量版；
// 批量调用 moveSkin N 次会写盘 N 次，且先搬走的项会让后面算好的落点整体偏移一格，越搬越乱。
function moveSkins(ids, index) {
  const raw = readRaw()
  const set = Object.create(null)
  // 允许传进已被删掉的 id，静默滤掉即可（否则一次脏 id 会让整批都不动）
  for (const id of Array.isArray(ids) ? ids : []) {
    if (raw.items.some((x) => x.id === id)) set[id] = true
  }
  const moving = raw.items.filter((x) => set[x.id])
  if (!moving.length) return { ok: true, moved: false }
  const rest = raw.items.filter((x) => !set[x.id])
  if (!rest.length) return { ok: true, moved: false }   // 全被选中：没有可插入的位置
  // 落点先夹到合法范围（前端算出的 index 可能因为列表刚变而越界）
  const want = Math.max(0, Math.min(Number(index) || 0, rest.length))
  const next = rest.slice(0, want).concat(moving, rest.slice(want))
  // 顺序没变就别白写盘（如单张已在该位置）
  if (next.every((x, i) => x.id === raw.items[i].id)) return { ok: true, moved: false }
  raw.items = next
  writeRaw(raw)
  return { ok: true, moved: true, index: want }
}

// 批量改「是否参与随机」：map = { id: boolean }。
// 存在的意义是**只读改写盘一次** —— 设置页的「全部启用 / 全停用 / 只留当前那张」若挨个改
// 会做 N 次 readRaw + writeRaw（37 张 = 37 次全量序列化落盘）。未知 id 静默跳过（列表可能刚被删）。
function setRandomBatch(map) {
  const ids = Object.keys(map || {})
  if (!ids.length) return { ok: true, changed: 0 }
  const raw = readRaw()
  let changed = 0
  for (const one of raw.items) {
    if (!Object.prototype.hasOwnProperty.call(map, one.id)) continue
    const on = map[one.id]
    if (typeof on !== 'boolean') continue
    if (on === false) one.random = false
    else delete one.random
    changed++
  }
  if (changed) writeRaw(raw)
  return { ok: true, changed: changed }
}

// 删除一张（文件与元信息一并清掉）。删的是当前形象时，当前位交给剩下的第一张；
// 一张都不剩则 current 置空，由设置页把配置里的形象回退成内置
function removeSkin(id) {
  const raw = readRaw()
  const idx = raw.items.findIndex((x) => x.id === id)
  if (idx < 0) return { ok: false, error: '形象不存在' }
  const it = raw.items[idx]
  clearSkinFiles(it.id, '')
  // 两种格式都要清：老数据是 .thumb.png，共享角色/内置包是 .thumb.webp，漏一种就在磁盘留垃圾
  for (const ext of ['png', 'webp']) {
    try { fs.unlinkSync(path.join(skinsDir(), it.id + '.thumb.' + ext)) } catch (err) {}
  }
  raw.items.splice(idx, 1)
  if (raw.current === id) raw.current = raw.items[0] ? raw.items[0].id : ''
  writeRaw(raw)
  dataCache = null
  return { ok: true, current: raw.current, left: raw.items.length }
}

// 一次删掉多张（设置页选中一批后点「删除」）：**一趟读改写盘删完**。
// 逐张调 removeSkin 会做 N 次 readRaw + writeRaw（删 10 张 = 10 次全量序列化落盘），
// 而且每趟都把 current 重算一遍，中间态还可能落到一张马上要被删的图上。
// 未知 id 在下面按「不存在」计入 failed（列表可能刚被删空过一次）。
function removeSkins(ids) {
  const list = Array.isArray(ids) ? ids : []
  if (!list.length) return { ok: true, removed: 0, failed: 0 }
  const raw = readRaw()
  let removed = 0
  let failed = 0
  for (const id of list) {
    const idx = raw.items.findIndex((x) => x.id === id)
    if (idx < 0) { failed++; continue }
    const it = raw.items[idx]
    clearSkinFiles(it.id, '')
    // 两种格式都要清：老数据是 .thumb.png，共享角色/内置包是 .thumb.webp，漏一种就在磁盘留垃圾
    for (const ext of ['png', 'webp']) {
      try { fs.unlinkSync(path.join(skinsDir(), it.id + '.thumb.' + ext)) } catch (err) {}
    }
    raw.items.splice(idx, 1)
    removed++
  }
  if (!removed) return { ok: true, removed: 0, failed: failed }
  // 当前形象被删掉了才重算：只有当它已不在列表里，才把当前位交给剩下的第一张
  if (!raw.items.some((x) => x.id === raw.current)) raw.current = raw.items[0] ? raw.items[0].id : ''
  writeRaw(raw)
  dataCache = null
  return { ok: true, removed: removed, failed: failed, current: raw.current, left: raw.items.length }
}

// 已装的内置可下载形象 id 列表（供设置页判断「哪些已下载」，避免重复下载）
function builtinIds() {
  return readRaw().items.filter((x) => x.builtin === true).map((x) => x.id)
}

// 装一个内置形象（供 lib/skin-packs.js / lib/assets-packs.js 调用）：固定 id、打官方标记、不动当前形象。
// thumb 是缩略图的 data URL（webp / png），由设置页从打包资源读好传来（宿主定位不到插件目录）。
// displayName：共享角色带中文原名（如「神里绫华」），画廊里显示它而不是 id 短哈希；
//   内置包不带则回落到 id。已存在同 id 的项时，一并把名字补正（旧记录当时只存了 id）。
function installBuiltin(id, ext, buf, thumb, displayName) {
  const name = String(displayName || id).slice(0, 120)
  return addItem(name, ext, (fid) => fs.writeFileSync(path.join(skinsDir(), fid + '.' + ext), buf),
    typeof thumb === 'string' ? thumb : '',
    { id: id, builtin: true, keepCurrent: true, displayName: name })
}

// 补写某张的缩略图（设置页懒补用）：共享角色/内置包在早先的版本里下载时没落缩略图，
// 升级后画廊只能回落读原图 —— 原图 0.9~2.7MB 一张，listSkins 的 8MB 回落预算撑不过几张，
// 后面的全显示「无预览」。设置页手上有打包好的 resources/thumbs/<id>.webp，
// 打开画廊时发现哪张缺就补哪张（只补一次，落盘后 readThumb 就能直接读到）。
// 只服务「已装的官方图」：用户自己导入的项本该在导入时就带缩略图，缺了是用户删了文件，不该瞎补。
function setThumb(id, dataUrl) {
  const one = readRaw().items.filter((x) => x.id === id)[0]
  if (!one) return { ok: false, error: '形象不存在' }
  if (hasThumbFile(id)) return { ok: true, skipped: true }
  return writeThumb(id, dataUrl) ? { ok: true } : { ok: false, error: '缩略图数据不可用' }
}

// 清除全部自定义形象（供设置页「清除选中数据」调用）
function clearAll() {
  try { fs.rmdirSync(skinsDir()) } catch (err) {}
  try { utools.dbStorage.removeItem(K.skins) } catch (err) { logErr('[whale][skins] 清除形象信息失败', err && err.message) }
  dataCache = null
  return { ok: true }
}

// 导出用：画廊每张的原图与缩略图字节（素材包打包用）。文件缺失的项跳过，
// 不因一张坏图让整包导不出去；current 一并带上，导入方可据此把「正在用的那张」置前。
// builtin 也要带上：内置可下载形象（有固定 id）在别的机器导入后仍是「内置」，
// 否则会被当成用户自建图占配额（见 addItem 的 ownCount）
function exportItems() {
  const raw = readRaw()
  const out = []
  for (const it of raw.items) {
    let data = null
    try { data = fs.readFileSync(path.join(skinsDir(), it.id + '.' + it.ext)) } catch (err) { continue }
    // 缩略图两种格式都要试：用户导入的是 .thumb.png，共享角色/内置包带的是 .thumb.webp
    let thumb = null
    for (const ext of ['png', 'webp']) {
      try { thumb = fs.readFileSync(path.join(skinsDir(), it.id + '.thumb.' + ext)); break } catch (err) {}
    }
    out.push({ id: it.id, name: it.name, ext: it.ext, at: it.at, data: data, thumb: thumb, current: it.id === raw.current, builtin: it.builtin === true })
  }
  return out
}

// 素材包导入：字节直接落成一个**新**画廊项（id 重新生成，不覆盖已有形象 ——
// 素材包是「补充」而不是「替换」）。keepCurrent:true 让导入不改变正在用的那张 ——
// 与下载链路（installBuiltin）一致：一次导入会进好几张，把用户当前形象顶掉很突兀
// （画廊原本为空时 addItem 仍会自然落到第一项，无须特判）。
// id 与 builtin 透传：内置可下载形象是固定 id，带上才能在导入侧识别成「内置」、不占自建配额
function importBuffer(name, ext, buf, thumbBuf, at, id, builtin) {
  if (OK_EXT.indexOf(ext) < 0) return { ok: false, error: '不支持的图片格式：' + ext }
  if (!buf || !buf.length) return { ok: false, error: '图片数据为空' }
  if (buf.length > MAX_BYTES) return { ok: false, error: '图片过大（限 5MB）' }
  const thumb = thumbBuf && thumbBuf.length ? 'data:image/png;base64,' + thumbBuf.toString('base64') : ''
  const r = addItem(name || ('形象.' + ext), ext,
    (iid) => fs.writeFileSync(path.join(skinsDir(), iid + '.' + ext), buf), thumb,
    { id: id, builtin: builtin === true, keepCurrent: true })
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
  removeSkin, removeSkins, setCurrent, moveSkin, moveSkins, setRandomBatch, clearAll, getSkinData, listSkins, readMeta,
  // 内置可下载形象（lib/skin-packs.js）用
  builtinIds, installBuiltin,
  // 设置页把共享角色的打包缩略图补落盘用（老数据没有缩略图时懒补）
  setThumb,
  // 素材包（assets.js）用
  exportItems, importBuffer,
  // 设置页「打开数据目录」用
  dir: skinsDir,
}
