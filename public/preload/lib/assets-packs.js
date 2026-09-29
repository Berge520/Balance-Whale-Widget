/*
 * 「共享素材」在线下载（CommonJS）：共享角色图（36 张）与音效库（45 个）。
 *
 * ── 与 skin-packs.js 的关系（为什么另外写一份而不是并进去）──
 * skin-packs.js 只服务「内置形象按需下载」这一件事：清单写死在 constants、按**文件名**匹配、
 * 只落形象。这里是「共享素材」，两类素材（形象 + 音效）、按 **id** 匹配、落两条不同链路
 * （skins.installBuiltin / sounds.installBuiltin），且两个包体积差着一个数量级
 * （形象 40MB vs 内置 0.9MB），上限与超时都得各算各的。硬合并会让两份清单与两条写入链路
 * 在同一函数里打架，分开更清爽。共用的只有容器解析（parsePack）与候选链 —— 那两个才是真能复用的。
 *
 * ── 素材包格式 ──
 * 与 assets.js / skin-packs.js 完全同源：[11 字节魔数][4 字节清单长度 uint32LE][JSON 清单][平铺字节]。
 * 由 scripts/build-assets-pack.py 生成（离线跑，产物挂 Release）。
 *
 * ── 校验 ──
 * ① 整包 sha256（SHARED_SKIN_PACK_SHA256 / SHARED_SOUND_PACK_SHA256）—— 防代理返残缺/被篡改的字节；
 * ② 逐项 sha256（清单里的 sha256 字段）—— 某项坏了只跳过它，不连累整包。
 *
 * ── 下载源（候选链）──
 * 与 skin-packs.js 同款：用户自填前缀 → 内置默认前缀（ghfast.top）→ 真源直连，逐个试、
 * 任一源取到合法包（含整包 sha256 过关）即停。
 */
const crypto = require('crypto')
const {
  SHARED_SKIN_PACK_ORIGIN, SHARED_SOUND_PACK_ORIGIN,
  SHARED_SKIN_PACK_RAW_MAIN, SHARED_SOUND_PACK_RAW_MAIN, SHARED_PACK_DEFAULT_PREFIX,
  SHARED_SKIN_PACK_SHA256, SHARED_SOUND_PACK_SHA256,
  SHARED_SKIN_PACK_SKINS, SHARED_SOUND_LIB, SHARED_PACK_TIMEOUT_MS, SHARED_PACK_MAX_BYTES,
} = require('./constants')
const { log, logErr } = require('./log')
const skins = require('./skins')
const sounds = require('./sounds')

const MAGIC = 'WHALEASSET1'
const KIND = 'balance-whale-widget-assets'
const HEAD_BYTES = MAGIC.length + 4

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

// 解析容器：只做结构与边界校验。返回 { manifest, dataStart } 或 { error }
function parsePack(buf) {
  if (!buf || buf.length <= HEAD_BYTES) return { error: '素材包太小，可能没下完整' }
  if (buf.slice(0, MAGIC.length).toString('latin1') !== MAGIC) {
    return { error: '这不是小鲸鱼素材包（可能是代理返回的错误页）' }
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
  const dataLen = buf.length - dataStart
  // 清单项写在 manifest.skins 里（与 assets.js / skin-packs.js 同源格式，由
  // scripts/build-assets-pack.py 的 pack() 生成）—— 形象包与音效包都用这一个字段承载，
  // 二者的区别只在每个 item 的 id 能匹配到哪份 constants 清单。
  const list = Array.isArray(manifest.skins) ? manifest.skins : []
  const bad = (it) => !it || !(Number(it.off) >= 0) || !(Number(it.len) > 0)
    || Number(it.off) + Number(it.len) > dataLen
  if (list.some(bad)) return { error: '素材包已损坏（文件数据越界）' }
  return { manifest: { items: list }, dataStart: dataStart }
}

// 候选下载源链：用户自填前缀（若有）→ 内置默认前缀 → 真源直连 → raw 及其加速 / 自填包装。
// 与 skin-packs.js#sourceChain 同规则，真源（origin）与兜底（rawMain）各随形象包 / 音效包传进来。
// raw 兜底同样是 github 域名、国内同样不稳，故也补「默认前缀 / 用户自填」包装的两条。
function sourceChain(prefix, origin, rawMain) {
  const out = []
  const push = (u) => { if (u && !out.includes(u)) out.push(u) }
  const p = typeof prefix === 'string' ? prefix.trim() : ''
  if (p) push(p + origin)
  push(SHARED_PACK_DEFAULT_PREFIX + origin)
  push(origin)
  if (rawMain) {
    push(rawMain)
    push(SHARED_PACK_DEFAULT_PREFIX + rawMain)
    if (p) push(p + rawMain)
  }
  return out
}

function labelOf(url, origin, rawMain) {
  if (rawMain && url === rawMain) return 'main 分支 raw 直连'
  if (url === origin) return '直连 github.com'
  if (rawMain && url.indexOf(rawMain) >= 0 && url.indexOf(SHARED_PACK_DEFAULT_PREFIX) === 0) return 'main 分支 raw 走默认加速 ghfast.top'
  if (url.indexOf(origin) >= 0 && url.indexOf(SHARED_PACK_DEFAULT_PREFIX) === 0) return '默认加速 ghfast.top'
  return '自定义加速源'
}

// 从单个源取包并做全部前置校验。任何一步不过都抛错（供候选链顺延到下一个源）。
async function fetchPackFrom(url, wantSha, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(SHARED_PACK_TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText || ''))
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('下载到空内容')
  if (buf.length > SHARED_PACK_MAX_BYTES) throw new Error('素材包异常大（' + buf.length + ' 字节）')

  const digest = sha256(buf)
  if (wantSha && digest !== wantSha) {
    logErr('[whale][assets-packs] 素材包校验失败', 'got ' + digest)
    throw new Error('素材包校验失败（内容与预期不符）')
  }
  const parsed = parsePack(buf)
  if (parsed.error) throw new Error(parsed.error)
  return { buf: buf, parsed: parsed }
}

// 走候选链取包。返回 { buf, parsed } 或抛错（错误里含每个源的失败原因）
async function fetchWithChain(prefix, origin, rawMain, wantSha, fetchImpl) {
  const chain = sourceChain(prefix, origin, rawMain)
  const attempts = []
  for (const url of chain) {
    const label = labelOf(url, origin, rawMain)
    try {
      const pack = await fetchPackFrom(url, wantSha, fetchImpl)
      attempts.push(label + '：成功')
      return { pack: pack, attempts: attempts }
    } catch (err) {
      const why = errMsg(err)
      attempts.push(label + '：' + why)
      logErr('[whale][assets-packs] 下载源失败，顺延下一个', label, why)
    }
  }
  throw new Error('所有下载源都失败 —— ' + attempts.join('；'))
}

// 下载并安装整包共享角色图。
// opts.fetchImpl 可注入（单测）；opts.prefix 是用户自填的加速前缀（'' = 只用内置链）。
// 已装的不重复写入（清单里对上的跳过）。
async function downloadSharedSkins(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (running) return { ok: false, error: '正在下载中，请稍候' }
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  running = true
  try {
    const res = await fetchWithChain(o.prefix, SHARED_SKIN_PACK_ORIGIN, SHARED_SKIN_PACK_RAW_MAIN, SHARED_SKIN_PACK_SHA256, fetchImpl)
    const buf = res.pack.buf
    const parsed = res.pack.parsed

    const byId = {}
    for (const s of SHARED_SKIN_PACK_SKINS) byId[s.id] = s
    const already = installedSkinIds()

    const installed = []
    const skipped = []
    const errors = []
    for (const it of parsed.manifest.items) {
      const meta = byId[String(it.id || '')]
      if (!meta) { skipped.push(String(it.id || '')); continue }
      if (already[meta.id]) { skipped.push(meta.id); continue }
      const data = buf.slice(parsed.dataStart + Number(it.off), parsed.dataStart + Number(it.off) + Number(it.len))
      const got = sha256(data)
      if (meta.sha256 && got !== meta.sha256) {
        logErr('[whale][assets-packs] 单张校验失败', meta.id + ': ' + got)
        errors.push(meta.id + '（校验失败）')
        continue
      }
      const ext = String(it.ext || 'png').toLowerCase()
      const r = skins.installBuiltin(meta.id, ext, data, null)
      if (r && r.ok) installed.push(meta.id)
      else {
        errors.push(meta.id + '（' + ((r && r.error) || '写入失败') + '）')
        if (r && r.error) logErr('[whale][assets-packs] 安装失败', meta.id + ': ' + r.error)
      }
    }
    log('[whale][assets-packs] 共享角色包已下载', {
      bytes: buf.length, installed: installed.length, skipped: skipped.length, errors: errors.length,
    })
    if (!installed.length && errors.length) {
      return { ok: false, error: '角色写入失败：' + errors[0], installed: installed, skipped: skipped }
    }
    return { ok: true, installed: installed, skipped: skipped, total: SHARED_SKIN_PACK_SKINS.length, errors: errors }
  } catch (err) {
    const why = errMsg(err)
    logErr('[whale][assets-packs] 下载共享角色包失败', why)
    return { ok: false, error: why }
  } finally {
    running = false
  }
}

// 下载并安装整包音效库（追加到 sounds 的 shared 槽位，同名覆盖）
async function downloadSharedSounds(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (running) return { ok: false, error: '正在下载中，请稍候' }
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  // o.wantSha 仅供单测注入小体积合成包时放宽整包校验；生产调用不传，仍以常量为准
  const wantSha = typeof o.wantSha === 'string' ? o.wantSha : SHARED_SOUND_PACK_SHA256
  running = true
  try {
    const res = await fetchWithChain(o.prefix, SHARED_SOUND_PACK_ORIGIN, SHARED_SOUND_PACK_RAW_MAIN, wantSha, fetchImpl)
    const buf = res.pack.buf
    const parsed = res.pack.parsed

    const byId = {}
    for (const s of SHARED_SOUND_LIB) byId[s.id] = s
    // 已装的跳过不重写：音效按「名」去重（落盘走 saveOne 的同名覆盖），与
    // listSharedSounds 的 installed 判据同源。漏了这条会让重复下载把 45 段的
    // 导入时间全部刷新、skipped 恒为空，状态显示与实际不符。
    const already = installedSoundNames()

    const installed = []
    const skipped = []
    const errors = []
    for (const it of parsed.manifest.items) {
      const meta = byId[String(it.id || '')]
      if (!meta) { skipped.push(String(it.id || '')); continue }
      if (already[meta.name]) { skipped.push(meta.name); continue }
      const data = buf.slice(parsed.dataStart + Number(it.off), parsed.dataStart + Number(it.off) + Number(it.len))
      const got = sha256(data)
      if (meta.sha256 && got !== meta.sha256) {
        logErr('[whale][assets-packs] 单个音效校验失败', meta.id + ': ' + got)
        errors.push(meta.name + '（校验失败）')
        continue
      }
      const ext = String(it.ext || meta.ext || 'mp3').toLowerCase()
      const r = sounds.installBuiltin(meta.name, ext, data)
      if (r && r.ok) installed.push(meta.id)
      else {
        errors.push(meta.name + '（' + ((r && r.error) || '写入失败') + '）')
        if (r && r.error) logErr('[whale][assets-packs] 安装音效失败', meta.name + ': ' + r.error)
      }
    }
    log('[whale][assets-packs] 共享音效包已下载', {
      bytes: buf.length, installed: installed.length, skipped: skipped.length, errors: errors.length,
    })
    if (!installed.length && errors.length) {
      return { ok: false, error: '音效写入失败：' + errors[0], installed: installed, skipped: skipped }
    }
    return { ok: true, installed: installed, skipped: skipped, total: SHARED_SOUND_LIB.length, errors: errors }
  } catch (err) {
    const why = errMsg(err)
    logErr('[whale][assets-packs] 下载共享音效包失败', why)
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
  listSharedSkins, listSharedSounds, downloadSharedSkins, downloadSharedSounds, readSharedSoundData,
  _parsePack: parsePack, _sourceChain: sourceChain,
}
