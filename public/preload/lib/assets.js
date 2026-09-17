/*
 * 素材包（形象 + 音效 + 气泡图）导出 / 导入（CommonJS）。
 *
 *  - 导出：把 whale-skins / whale-sounds / whale-bubbles 三个目录里的文件打成一个单文件包
 *    （.whaleassets），换机器或重装时一次带走，不用逐项重导。
 *  - 导入：先解析出预览（几张形象 / 几段音效 / 几张气泡图 / 导出时间），由设置页勾选后再写入。
 *
 * 为什么不用 zip：宿主 preload 跑在渲染进程，能用的只有 Node 内置模块，
 * 自己写 zip 要处理 CRC32 与中央目录，出错面比收益大。这里用最简单的自定义容器：
 *   [11 字节魔数][4 字节清单长度(uint32LE)][JSON 清单][各文件字节按顺序拼接]
 * 清单里每项记 off/len，读的时候按偏移切片。不压缩 —— 图片与音频本身已是压缩格式。
 */
const fs = require('fs')
const path = require('path')
const { PLUGIN_VERSION } = require('./constants')
const { log, logErr } = require('./log')
const skins = require('./skins')
const sounds = require('./sounds')
const bubbles = require('./bubbles')

const KIND = 'balance-whale-widget-assets'
const SCHEMA = 1
const MAGIC = 'WHALEASSET1'
const EXT = 'whaleassets'
const HEAD_BYTES = MAGIC.length + 4

let pending = null // 已解析、等待确认写入的素材包（避免重复读文件）

function errMsg(err) { return String((err && err.message) || err || '未知错误') }

function stamp() {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes())
}

// ── 导出 ──
function exportAssets() {
  const skinItems = skins.exportItems()
  const soundItems = sounds.exportItems()
  const bubbleItems = bubbles.exportItems()
  if (!skinItems.length && !soundItems.length && !bubbleItems.length) {
    return { ok: false, error: '还没有导入任何素材，先在「资源」页导入形象、音效或气泡图' }
  }
  let filePath = ''
  try {
    filePath = utools.showSaveDialog({
      title: '导出小鲸鱼素材包',
      defaultPath: path.join(String(utools.getPath('downloads') || ''), 'whale-assets-' + stamp() + '.' + EXT),
      filters: [{ name: '小鲸鱼素材包', extensions: [EXT] }],
    })
  } catch (err) {
    return { ok: false, error: '无法打开保存对话框：' + errMsg(err) }
  }
  if (!filePath) return { ok: false, canceled: true, error: '' }

  // 所有文件字节平铺进 blobs，清单里只记偏移；文件缺失的项（读不出来）直接跳过
  const blobs = []
  let off = 0
  const push = (buf) => {
    if (!buf || !buf.length) return -1
    const at = off
    blobs.push(buf)
    off += buf.length
    return at
  }
  const skinList = []
  for (const it of skinItems) {
    const at = push(it.data)
    if (at < 0) continue
    const thumbAt = push(it.thumb)
    skinList.push({
      name: it.name, ext: it.ext, at: it.at, current: it.current === true,
      off: at, len: it.data.length,
      thumbOff: thumbAt < 0 ? 0 : thumbAt, thumbLen: thumbAt < 0 ? 0 : it.thumb.length,
    })
  }
  const soundList = []
  for (const it of soundItems) {
    const at = push(it.data)
    if (at < 0) continue
    soundList.push({ role: it.role, name: it.name, ext: it.ext, at: it.at, off: at, len: it.data.length })
  }
  const bubbleList = []
  for (const it of bubbleItems) {
    const at = push(it.data)
    if (at < 0) continue
    const thumbAt = push(it.thumb)
    bubbleList.push({
      name: it.name, ext: it.ext, at: it.at,
      off: at, len: it.data.length,
      thumbOff: thumbAt < 0 ? 0 : thumbAt, thumbLen: thumbAt < 0 ? 0 : it.thumb.length,
    })
  }
  const manifest = {
    kind: KIND,
    schema: SCHEMA,
    appVersion: PLUGIN_VERSION,
    exportedAt: new Date().toISOString(),
    skins: skinList,
    sounds: soundList,
    bubbles: bubbleList,
  }
  const jsonBuf = Buffer.from(JSON.stringify(manifest), 'utf8')
  const head = Buffer.alloc(HEAD_BYTES)
  head.write(MAGIC, 0, 'latin1')
  head.writeUInt32LE(jsonBuf.length, MAGIC.length)
  try {
    fs.writeFileSync(filePath, Buffer.concat([head, jsonBuf].concat(blobs)))
  } catch (err) {
    logErr('[whale][assets] 写入素材包失败', filePath, err && err.message)
    return { ok: false, error: '写入素材包失败：' + errMsg(err) }
  }
  log('[whale][assets] 导出素材包', { filePath: filePath, skins: skinList.length, sounds: soundList.length, bubbles: bubbleList.length })
  return {
    ok: true, path: filePath, exportedAt: manifest.exportedAt,
    skins: skinList.length, sounds: soundList.length, bubbles: bubbleList.length,
  }
}

// 解析容器：只做结构与边界校验，不碰存储。返回 { manifest, dataStart } 或 { error }
function parsePack(buf) {
  if (!buf || buf.length <= HEAD_BYTES) return { error: '不是有效的素材包（文件太小）' }
  if (buf.slice(0, MAGIC.length).toString('latin1') !== MAGIC) {
    return { error: '这不是小鲸鱼素材包' }
  }
  const jsonLen = buf.readUInt32LE(MAGIC.length)
  const jsonStart = HEAD_BYTES
  const dataStart = jsonStart + jsonLen
  if (jsonLen <= 0 || dataStart > buf.length) return { error: '素材包已损坏（清单长度异常）' }
  let manifest = null
  try {
    manifest = JSON.parse(buf.slice(jsonStart, dataStart).toString('utf8'))
  } catch (err) {
    return { error: '素材包已损坏（清单解析失败）：' + errMsg(err) }
  }
  if (!manifest || manifest.kind !== KIND) return { error: '这不是小鲸鱼素材包' }
  if (Number(manifest.schema) > SCHEMA) {
    return { error: '素材包来自更新的插件版本（schema ' + manifest.schema + '），请先升级插件' }
  }
  const dataLen = buf.length - dataStart
  const bad = (it) => !it || !(Number(it.off) >= 0) || !(Number(it.len) > 0)
    || Number(it.off) + Number(it.len) > dataLen
    || (Number(it.thumbLen) > 0 && Number(it.thumbOff) + Number(it.thumbLen) > dataLen)
  const skinList = Array.isArray(manifest.skins) ? manifest.skins : []
  const soundList = Array.isArray(manifest.sounds) ? manifest.sounds : []
  // bubbles 是后加的清单项：老素材包里没有，缺省即空数组（schema 不必升版 —— 老版本读新包时
  // 只校验 skins/sounds，多出来的 bubbles 会被它忽略）
  const bubbleList = Array.isArray(manifest.bubbles) ? manifest.bubbles : []
  if (skinList.some(bad) || soundList.some(bad) || bubbleList.some(bad)) {
    return { error: '素材包已损坏（文件数据越界）' }
  }
  return {
    manifest: {
      exportedAt: String(manifest.exportedAt || ''),
      appVersion: String(manifest.appVersion || ''),
      skins: skinList,
      sounds: soundList,
      bubbles: bubbleList,
    },
    dataStart: dataStart,
  }
}

// ── 选择素材包并解析出预览（不写任何数据）──
function pickAssets() {
  let picked
  try {
    picked = utools.showOpenDialog({
      title: '选择小鲸鱼素材包',
      buttonLabel: '导入',
      filters: [{ name: '小鲸鱼素材包', extensions: [EXT] }],
      properties: ['openFile'],
    })
  } catch (err) {
    return { ok: false, error: '无法打开文件对话框：' + errMsg(err) }
  }
  const filePath = Array.isArray(picked) ? picked[0] : picked
  if (!filePath) return { ok: false, canceled: true, error: '' }
  let buf = null
  try {
    buf = fs.readFileSync(filePath)
  } catch (err) {
    return { ok: false, error: '读取素材包失败：' + errMsg(err) }
  }
  const parsed = parsePack(buf)
  if (parsed.error) return { ok: false, error: parsed.error }
  pending = { buf: buf, manifest: parsed.manifest, dataStart: parsed.dataStart }
  return {
    ok: true,
    path: filePath,
    exportedAt: parsed.manifest.exportedAt,
    appVersion: parsed.manifest.appVersion,
    has: {
      skins: parsed.manifest.skins.length,
      sounds: parsed.manifest.sounds.length,
      bubbles: parsed.manifest.bubbles.length,
    },
    skinNames: parsed.manifest.skins.map((x) => String(x.name || '')).slice(0, 40),
    soundRoles: parsed.manifest.sounds.map((x) => String(x.role || '')),
    bubbleNames: parsed.manifest.bubbles.map((x) => String(x.name || '')).slice(0, 40),
  }
}

function clearPending() { pending = null; return { ok: true } }

// ── 导入：按勾选项写入 ──
// opts = { skins: boolean, sounds: boolean, bubbles: boolean }
// 形象与气泡图是「补充」（每张都生成新 id，不动已有的）；音效是「同槽位覆盖」
function applyAssets(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (!pending) return { ok: false, error: '请先选择素材包' }
  const m = pending.manifest
  const slice = (off, len) => (Number(len) > 0 ? pending.buf.slice(pending.dataStart + Number(off), pending.dataStart + Number(off) + Number(len)) : null)
  const errors = []
  let skinAdded = 0
  let skinSkipped = 0
  let soundApplied = 0
  let bubbleAdded = 0
  let bubbleSkipped = 0

  if (o.skins === true) {
    for (const it of m.skins) {
      const r = skins.importBuffer(it.name, String(it.ext || '').toLowerCase(), slice(it.off, it.len), slice(it.thumbOff, it.thumbLen), it.at)
      if (r && r.ok) skinAdded++
      else {
        skinSkipped++
        if (r && r.error) errors.push(r.error)
      }
    }
  }
  if (o.sounds === true) {
    for (const it of m.sounds) {
      const r = sounds.importBuffer(it.role, it.name, String(it.ext || '').toLowerCase(), slice(it.off, it.len), it.at)
      if (r && r.ok) soundApplied++
      else if (r && r.error) errors.push(r.error)
    }
  }
  if (o.bubbles === true) {
    for (const it of m.bubbles) {
      const r = bubbles.importBuffer(it.name, String(it.ext || '').toLowerCase(), slice(it.off, it.len), slice(it.thumbOff, it.thumbLen), it.at)
      if (r && r.ok) bubbleAdded++
      else {
        bubbleSkipped++
        if (r && r.error) errors.push(r.error)
      }
    }
  }
  log('[whale][assets] 导入素材包', {
    skins: skinAdded, skipped: skinSkipped, sounds: soundApplied, bubbles: bubbleAdded, errors: errors.length,
  })
  // 同一类失败（如「最多保留 20 张形象」）会重复几十遍，去重后只提示一次
  const uniq = []
  for (const e of errors) if (uniq.indexOf(e) < 0) uniq.push(e)
  const ok = skinAdded + soundApplied + bubbleAdded > 0
  if (ok) pending = null
  return {
    ok: ok,
    skins: { added: skinAdded, skipped: skinSkipped },
    sounds: { applied: soundApplied },
    bubbles: { added: bubbleAdded, skipped: bubbleSkipped },
    errors: uniq,
    error: uniq[0] || '',
  }
}

module.exports = { exportAssets, pickAssets, applyAssets, clearPending }
