/*
 * 「共享素材」在线下载（CommonJS）：共享角色图（36 张）与音效库（45 个），**按需单张**。
 *
 * ── 为什么单张而不是整包（v1.9.0 起）──
 * 原先整包（形象 40.6MB / 音效 2.7MB）挂 GitHub Release 下载，国内经代理仍慢得离谱，
 * 而用户多半只要其中几张。改为：源图由 scripts/export-shared-assets.mjs 按 `id.ext` 重命名
 * 导出到 public/shared/（入库），走 raw 直链按需取单张（最大约 2.6MB），点哪张下哪张。
 * 整包链路（容器解析 / 整包 sha256）随之删除。
 *
 * ── 与 skin-packs.js 的关系（为什么另外写一份而不是并进去）──
 * skin-packs.js 只服务「内置形象按需下载」：清单写死、按**文件名**匹配、只落形象。
 * 这里是「共享素材」，两类素材（形象 + 音效）、按 **id** 匹配、落两条不同链路
 * （skins.installBuiltin / sounds.installBuiltin）。共用的只有候选链与流式读体。
 *
 * ── 校验 ──
 * 逐张 sha256（constants 清单里的 sha256 字段）—— 防代理返残缺/被篡改的字节，
 * 也防「下到一半被截断」的单张。整包级校验已随整包链路一并去掉。
 *
 * ── 下载源（候选链）──
 * 用户自填前缀 → 内置默认前缀（ghfast.top）→ raw 直连，逐个试、任一源取到合法字节即停。
 * jsDelivr 源待实测通过后再并入（见 sourceChain 注释）。
 */
const crypto = require('crypto')
const {
  SHARED_RAW_BASE, SHARED_PACK_DEFAULT_PREFIX,
  SHARED_SKIN_PACK_SKINS, SHARED_SOUND_LIB,
  SHARED_PACK_TIMEOUT_MS, SHARED_PACK_MAX_BYTES,
} = require('./constants')
const { log, logErr } = require('./log')
const skins = require('./skins')
const sounds = require('./sounds')
const dlp = require('./download-progress')

// 内存状态：进行中的下载（防重复点击，也让设置页能显示「正在下」）。重载插件即中断。
let running = false

function errMsg(err) { return String((err && err.message) || err || '未知错误') }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }

// 已有共享形象 id（从画廊里带 builtin 标记的项取）
function installedSkinIds() {
  const have = {}
  for (const id of skins.builtinIds()) have[id] = true
  return have
}

// 已有共享音效名（音效以「名」为去重键：落盘走 sounds.installBuiltin 的同名覆盖）
function installedSoundNames() {
  const meta = sounds.readMeta()
  const out = {}
  for (const it of meta.shared || []) out[it.name] = true
  return out
}

// 可下载的共享角色清单 + 已装状态。不含缩略图（缩略图是设置页内嵌静态资源）。
function listSharedSkins() {
  const have = installedSkinIds()
  const items = SHARED_SKIN_PACK_SKINS.map((s) => ({
    id: s.id, name: s.name, size: s.size, installed: have[s.id] === true,
  }))
  return {
    ok: true,
    items: items,
    totalSize: SHARED_SKIN_PACK_SKINS.reduce((n, s) => n + (Number(s.size) || 0), 0),
    installedCount: items.filter((x) => x.installed).length,
  }
}

// 可下载的音效库清单 + 已装状态（按名去重）
function listSharedSounds() {
  const have = installedSoundNames()
  const items = SHARED_SOUND_LIB.map((s) => ({
    id: s.id, name: s.name, ext: s.ext, size: s.size, installed: have[s.name] === true,
  }))
  return {
    ok: true,
    items: items,
    totalSize: SHARED_SOUND_LIB.reduce((n, s) => n + (Number(s.size) || 0), 0),
    installedCount: items.filter((x) => x.installed).length,
  }
}

// 单张文件的真源 URL：<基址><kind>/<id>.<ext>。kind 为 'skins' | 'sounds'，
// id 是 ASCII 短名（中文原名含全角括号，raw 直链需 percent-encode 且各 CDN 兼容性不一，
// 故导出时按 id.ext 重命名，清单里的 name 仅作展示）。
function fileUrl(kind, id, ext) {
  return SHARED_RAW_BASE + kind + '/' + id + '.' + ext
}

// 候选下载源链：用户自填前缀（若有）→ 内置默认前缀 → 真源直连。
// 与 skin-packs.js#sourceChain 同规则，只是目标是单张文件而非整包。
// jsDelivr 源（cdn.jsdelivr.net/gh/<owner>/<repo>@main/public/shared/...）待实测通过后再并入。
function sourceChain(prefix, origin) {
  const out = []
  const push = (u) => { if (u && !out.includes(u)) out.push(u) }
  const p = typeof prefix === 'string' ? prefix.trim() : ''
  if (p) push(p + origin)
  push(SHARED_PACK_DEFAULT_PREFIX + origin)
  push(origin)
  return out
}

function labelOf(url, origin) {
  if (url === origin) return '直连 raw.githubusercontent.com'
  if (url.indexOf(origin) >= 0 && url.indexOf(SHARED_PACK_DEFAULT_PREFIX) === 0) return '默认加速 ghfast.top'
  return '自定义加速源'
}

// 流式读取响应体，边读边把字节数写进进度。
// ⚠️ 与 skin-packs.js#readBodyWithProgress 是同一份逻辑的两份拷贝 —— 刻意不抽公共模块：
//    两条链路的进度「总量语义」不同（这里用 Content-Length，那边用清单预期字节），
//    抽出来反而要传一堆开关。真要合并时注意别把上限校验（SHARED_PACK_MAX_BYTES）弄丢。
async function readBodyWithProgress(res, onChunk) {
  const lenHeader = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0)
  const total = lenHeader > 0 ? lenHeader : 0
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (onChunk) onChunk(buf.length, total)
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let received = 0
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    const c = Buffer.from(step.value)
    chunks.push(c)
    received += c.length
    if (onChunk) onChunk(received, total)
  }
  return Buffer.concat(chunks)
}

// 从单个源取单张字节并校验。任何一步不过都抛错（供候选链顺延到下一个源）。
async function fetchFrom(url, wantSha, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(SHARED_PACK_TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText || ''))
  const buf = await readBodyWithProgress(res, (received, total) => dlp.progress(received, total))
  if (!buf.length) throw new Error('下载到空内容')
  if (buf.length > SHARED_PACK_MAX_BYTES) throw new Error('文件异常大（' + buf.length + ' 字节）')

  dlp.phase('verify')
  const digest = sha256(buf)
  if (wantSha && digest !== wantSha) {
    logErr('[whale][assets-packs] 单张校验失败', url, 'got ' + digest)
    throw new Error('校验失败（内容与预期不符）')
  }
  return { buf: buf, url: url }
}

// 走候选链取单张。返回 { buf, url } 或抛错（错误里含每个源的失败原因）
async function fetchWithChain(prefix, origin, wantSha, fetchImpl) {
  const chain = sourceChain(prefix, origin)
  const attempts = []
  for (const url of chain) {
    const label = labelOf(url, origin)
    try {
      dlp.source(url, label)
      const got = await fetchFrom(url, wantSha, fetchImpl)
      attempts.push(label + '：成功')
      return { item: got, attempts: attempts }
    } catch (err) {
      const why = errMsg(err)
      attempts.push(label + '：' + why)
      logErr('[whale][assets-packs] 下载源失败，顺延下一个', label, why)
    }
  }
  throw new Error('所有下载源都失败 —— ' + attempts.join('；'))
}

// 下载并安装单张共享角色图。已装的不重复写入。
// opts.fetchImpl 可注入（单测）；opts.prefix 是用户自填的加速前缀（'' = 只用内置链）。
async function downloadSharedSkin(id, opts) {
  const meta = SHARED_SKIN_PACK_SKINS.filter((s) => s.id === id)[0]
  if (!meta) return { ok: false, error: '没有这个共享角色：' + String(id || '') }
  if (installedSkinIds()[meta.id]) return { ok: true, id: meta.id, name: meta.name, skipped: true }

  const o = opts && typeof opts === 'object' ? opts : {}
  if (running) return { ok: false, error: '正在下载中，请稍候' }
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  running = true
  dlp.begin('shared-skins', Number(meta.size) || 0)
  dlp.phase('connect', { label: '正在连接下载源…' })
  try {
    const origin = fileUrl('skins', meta.id, 'png')
    const res = await fetchWithChain(o.prefix, origin, meta.sha256, fetchImpl)
    dlp.phase('install', { label: '正在写入角色…', total: res.item.buf.length })
    const r = skins.installBuiltin(meta.id, 'png', res.item.buf, null)
    if (!r || !r.ok) {
      const why = (r && r.error) || '写入失败'
      dlp.end(false, res.item.buf.length)
      logErr('[whale][assets-packs] 安装共享角色失败', meta.id + ': ' + why)
      return { ok: false, error: '角色写入失败：' + why }
    }
    log('[whale][assets-packs] 共享角色已下载', { id: meta.id, bytes: res.item.buf.length, source: res.item.url })
    dlp.end(true, res.item.buf.length)
    return { ok: true, id: meta.id, name: meta.name, source: res.item.url, bytes: res.item.buf.length }
  } catch (err) {
    const why = errMsg(err)
    dlp.end(false, 0)
    logErr('[whale][assets-packs] 下载共享角色失败', meta.id + ': ' + why)
    return { ok: false, error: why }
  } finally {
    running = false
  }
}

// 下载并安装单个共享音效（追加到 sounds 的 shared 槽位，同名覆盖）。
async function downloadSharedSound(id, opts) {
  const meta = SHARED_SOUND_LIB.filter((s) => s.id === id)[0]
  if (!meta) return { ok: false, error: '没有这个共享音效：' + String(id || '') }
  if (installedSoundNames()[meta.name]) return { ok: true, id: meta.id, name: meta.name, skipped: true }

  const o = opts && typeof opts === 'object' ? opts : {}
  if (running) return { ok: false, error: '正在下载中，请稍候' }
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  running = true
  dlp.begin('shared-sounds', Number(meta.size) || 0)
  dlp.phase('connect', { label: '正在连接下载源…' })
  try {
    const origin = fileUrl('sounds', meta.id, meta.ext)
    const res = await fetchWithChain(o.prefix, origin, meta.sha256, fetchImpl)
    dlp.phase('install', { label: '正在写入音效…', total: res.item.buf.length })
    const r = sounds.installBuiltin(meta.name, meta.ext, res.item.buf)
    if (!r || !r.ok) {
      const why = (r && r.error) || '写入失败'
      dlp.end(false, res.item.buf.length)
      logErr('[whale][assets-packs] 安装共享音效失败', meta.name + ': ' + why)
      return { ok: false, error: '音效写入失败：' + why }
    }
    log('[whale][assets-packs] 共享音效已下载', { id: meta.id, bytes: res.item.buf.length, source: res.item.url })
    dlp.end(true, res.item.buf.length)
    return { ok: true, id: meta.id, name: meta.name, source: res.item.url, bytes: res.item.buf.length }
  } catch (err) {
    const why = errMsg(err)
    dlp.end(false, 0)
    logErr('[whale][assets-packs] 下载共享音效失败', meta.id + ': ' + why)
    return { ok: false, error: why }
  } finally {
    running = false
  }
}

// 试听共享库里的一段：读它落盘的音频字节 → data URL。
// 为什么不复用 sounds.getSoundData：那边只推「实播槽位」（shared 是几十段的素材池，
// 全推给挂件等于每次搬几 MB 无用 base64），所以这里按「名」临时读一段给设置页试听用。
// 返回值不缓存 —— 试听是低频动作，缓存反而会在下载 / 选用后变脏
function readSharedSoundData(name) {
  const meta = sounds.readMeta()
  const src = (meta.shared || []).filter((x) => x.name === name)[0]
  if (!src) return { ok: false, error: '共享库里没有这段音效' }
  try {
    const buf = sounds.readSoundBuffer(src.file)
    if (!buf) return { ok: false, error: '音频文件已丢失' }
    return { ok: true, url: 'data:' + (sounds.mimeOf(src.ext)) + ';base64,' + buf.toString('base64') }
  } catch (err) {
    logErr('[whale][assets-packs] 读取共享音效试听失败', src.file, errMsg(err))
    return { ok: false, error: errMsg(err) }
  }
}

module.exports = {
  listSharedSkins, listSharedSounds, downloadSharedSkin, downloadSharedSound, readSharedSoundData,
  _fileUrl: fileUrl, _sourceChain: sourceChain, _readBodyWithProgress: readBodyWithProgress,
}
