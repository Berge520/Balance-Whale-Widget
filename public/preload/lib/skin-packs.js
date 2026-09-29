/*
 * 内置形象「按需下载」（CommonJS）。
 *
 * ── 为什么要有这个模块 ──
 * 13 张内置形象原先全部随包分发（约 1.07MB，占插件包 39%）。v1.7.x 起只留默认那张
 * （DSniang1，约 39KB）随包，其余打成一个素材包挂在 GitHub Release 上，
 * 用户按需下载 —— 目的是把插件包从约 2.7MB 压到约 1.7MB。v1.9.0 起该可下载包再从
 * 12 张精简为 1 张（DSniang02）：原 12 张里 11 张与「共享角色包」同图，改由后者提供。
 *
 * ── 素材包格式 ──
 * 复用 assets.js 的自定义容器格式（魔数 + JSON 清单 + 平铺字节），**不是 zip**：
 * 宿主 preload 跑在渲染进程，只有 Node 内置模块，解 zip 要自己写 CRC32 与中央目录
 * （见 assets.js 文件头记的坑），而容器解析已现成。素材包由
 * scripts/build-skin-pack.py 生成（离线跑，产物挂 Release）。
 *
 * ── 下载回来的形象落在哪 ──
 * 落进**自定义画廊**（lib/skins.js，带 builtin 标记），不放进浮动页的相对路径表 ——
 * 挂件读不到插件包外的 file:// 资源（见 skins.js 文件头），只能走 data URL 推送，
 * 而那条链路自定义画廊已经完整具备。这样就不用动 floating-page.js / normSkin / IPC。
 *
 * ── 下载源（候选链）──
 * 单源不稳：内置 ghfast.top 代理抖一下用户就只能干等重试。改成候选链逐个试 ——
 * 用户自填前缀（设置页「形象下载源」，可选）→ 内置默认前缀 → 真源直连兜底，
 * 前一个失败顺延下一个，**任一源取到合法包即停**。取包这一层就把 sha256 校验过掉，
 * 代理返 HTML / 半截包会被判失败并顺延，而不是把「校验失败」这种无可操作性的错退给用户。
 *
 * ── 校验 ──
 * 两道：① 素材包整体 sha256（SKIN_PACK_SHA256）—— 挡住代理返回残缺/被篡改的字节；
 * ② 逐张 sha256（SKIN_PACK_SKINS）—— 包里某张坏了只跳过那张，不至于整包作废。
 *
 * ── 与 assets.js 的关系 ──
 * 这里是「按 id 取远程包 → 落画廊」的专用链路，与 assets.js 的「用户自选文件 → 勾选导入」
 * 是两条独立链路（出入口不同、用户交互不同）。共用的只有容器格式本身，解析逻辑刻意各写一份：
 * assets.js 那份要保留 raw 供设置页预览勾选，这里则直接落盘，硬合并反而要多绕一层。
 */
const crypto = require('crypto')
const {
  SKIN_PACK_URL, SKIN_PACK_ORIGIN, SKIN_PACK_DEFAULT_PREFIX, SKIN_PACK_RAW_MAIN,
  SKIN_PACK_SHA256, SKIN_PACK_TIMEOUT_MS, SKIN_PACK_MAX_BYTES, SKIN_PACK_SKINS,
} = require('./constants')
const { log, logErr } = require('./log')
const skins = require('./skins')

const MAGIC = 'WHALEASSET1'
const KIND = 'balance-whale-widget-assets'
const HEAD_BYTES = MAGIC.length + 4

// 内存状态：进行中的下载（防重复点击，也让设置页能显示「正在下」）。
// 只存内存 —— 重载插件即中断，符合预期（下载是一次性的短操作）。
let running = false

function errMsg(err) { return String((err && err.message) || err || '未知错误') }

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// 可下载形象清单 + 已装状态：设置页资源页据此渲染「哪些能下、哪些已下」。
// 返回 { ok, items: [{ id, size, installed }], url, totalSize } —— 不含缩略图
// （缩略图是前端内嵌的静态资源，不从这里搬，避免一次 IPC 带 50KB base64）。
function listSkinPacks() {
  const have = {}
  for (const id of skins.builtinIds()) have[id] = true
  const items = SKIN_PACK_SKINS.map((s) => ({
    id: s.id,
    size: s.size,
    installed: have[s.id] === true,
  }))
  return {
    ok: true,
    items: items,
    totalSize: SKIN_PACK_SKINS.reduce((n, s) => n + (s.size || 0), 0),
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
  const skinList = Array.isArray(manifest.skins) ? manifest.skins : []
  const bad = (it) => !it || !(Number(it.off) >= 0) || !(Number(it.len) > 0)
    || Number(it.off) + Number(it.len) > dataLen
  if (skinList.some(bad)) return { error: '素材包已损坏（文件数据越界）' }
  return { manifest: { skins: skinList }, dataStart: dataStart }
}

// 候选下载源链：用户自填前缀（若有）→ 内置默认前缀 → 真源直连 → raw 及其加速 / 自填包装。
// 逐个尝试、前一个失败顺延下一个。raw 兜底（main 分支）与 Release 走不同 CDN 路由，
// 但它同样是 github 域名、国内同样不稳，所以**它也要能走加速**：除裸链外再补两条被前缀
// 包装的 raw（默认前缀 / 用户自填），这样「Release 被墙 + raw 直连也不通」时仍有代理这条路。
// 去重：用户填的就是默认前缀（或等价）时不会把同一个 URL 试两遍。
function sourceChain(prefix) {
  const out = []
  const push = (u) => { if (u && !out.includes(u)) out.push(u) }
  const p = typeof prefix === 'string' ? prefix.trim() : ''
  if (p) push(p + SKIN_PACK_ORIGIN)
  push(SKIN_PACK_URL) // = SKIN_PACK_DEFAULT_PREFIX + SKIN_PACK_ORIGIN
  push(SKIN_PACK_ORIGIN)
  if (SKIN_PACK_RAW_MAIN) {
    push(SKIN_PACK_RAW_MAIN)
    push(SKIN_PACK_DEFAULT_PREFIX + SKIN_PACK_RAW_MAIN)
    if (p) push(p + SKIN_PACK_RAW_MAIN)
  }
  return out
}

// 给日志 / 报错用的源标签：用户看报错时得知道是哪个源挂了（否则只看到「失败」没处下手）
function labelOf(url) {
  if (url === SKIN_PACK_RAW_MAIN) return 'main 分支 raw 直连'
  if (url === SKIN_PACK_ORIGIN) return '直连 github.com'
  if (url.indexOf(SKIN_PACK_RAW_MAIN) >= 0 && url.indexOf(SKIN_PACK_DEFAULT_PREFIX) === 0) return 'main 分支 raw 走默认加速 ghfast.top'
  if (url.indexOf(SKIN_PACK_ORIGIN) >= 0 && url.indexOf(SKIN_PACK_DEFAULT_PREFIX) === 0) return '默认加速 ghfast.top'
  return '自定义加速源'
}

// 从单个源取包并做全部前置校验。任何一步不过都抛错（供候选链顺延到下一个源）。
// 返回 { buf, parsed }。
async function fetchPackFrom(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(SKIN_PACK_TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText || ''))
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('下载到空内容')
  if (buf.length > SKIN_PACK_MAX_BYTES) throw new Error('素材包异常大（' + buf.length + ' 字节）')

  // ① 整包校验：代理返回 HTML 错误页 / 截断都能在这里被挡下
  const digest = sha256(buf)
  if (SKIN_PACK_SHA256 && digest !== SKIN_PACK_SHA256) {
    logErr('[whale][skin-packs] 素材包校验失败', 'got ' + digest)
    throw new Error('素材包校验失败（内容与预期不符）')
  }

  const parsed = parsePack(buf)
  if (parsed.error) throw new Error(parsed.error)
  return { buf: buf, parsed: parsed }
}

// 下载并安装整个素材包。返回：
//   { ok: true, installed: [id…], skipped: [id…], total }
//   { ok: false, error }
//
// opts.fetchImpl 可注入（单测用）；opts.prefix 是用户在设置页自填的加速前缀（'' = 只用内置链）。
// 已装的不重复下载解析 —— 但**仍会下整包**（包是一个整体，没法只下其中几张；清单里已装的跳过写入）。
async function downloadSkinPacks(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (running) return { ok: false, error: '正在下载中，请稍候' }
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  const chain = sourceChain(o.prefix)
  running = true
  try {
    // ── 取包：候选链逐个试，任一源取到合法包即停 ──
    // 「合法」含 sha256 过关 —— 代理返 HTML / 半截包会在 fetchPackFrom 里被判失败并顺延下一源，
    // 而不是退给用户一个「校验失败」（那条报错对用户毫无可操作性）
    let pack = null
    const attempts = []
    for (const url of chain) {
      const label = labelOf(url)
      try {
        pack = await fetchPackFrom(url, fetchImpl)
        attempts.push(label + '：成功')
        break
      } catch (err) {
        const why = errMsg(err)
        attempts.push(label + '：' + why)
        logErr('[whale][skin-packs] 下载源失败，顺延下一个', label, why)
      }
    }
    if (!pack) return { ok: false, error: '所有下载源都失败 —— ' + attempts.join('；') }
    const buf = pack.buf
    const parsed = pack.parsed

    // 逐张落盘：按清单里 name 主干匹配 SKIN_PACK_SKINS 拿 id 与 sha256
    const byFile = {}
    for (const s of SKIN_PACK_SKINS) byFile[s.file] = s
    const already = {}
    for (const id of skins.builtinIds()) already[id] = true

    const installed = []
    const skipped = []
    const errors = []
    for (const it of parsed.manifest.skins) {
      const name = String(it.name || '')
      const meta = byFile[name]
      if (!meta) { skipped.push(name); continue }
      if (already[meta.id]) { skipped.push(meta.id); continue }
      const data = buf.slice(parsed.dataStart + Number(it.off), parsed.dataStart + Number(it.off) + Number(it.len))
      // ② 逐张校验：一张坏只跳过它，不连累整包
      const got = sha256(data)
      if (meta.sha256 && got !== meta.sha256) {
        logErr('[whale][skin-packs] 单张校验失败', meta.id + ': ' + got)
        errors.push(meta.id + '（校验失败）')
        continue
      }
      const ext = String(it.ext || 'webp').toLowerCase()
      const r = skins.installBuiltin(meta.id, ext, data, null)
      if (r && r.ok) installed.push(meta.id)
      else {
        errors.push(meta.id + '（' + ((r && r.error) || '写入失败') + '）')
        if (r && r.error) logErr('[whale][skin-packs] 安装失败', meta.id + ': ' + r.error)
      }
    }
    log('[whale][skin-packs] 素材包已下载', {
      bytes: buf.length, installed: installed.length, skipped: skipped.length, errors: errors.length,
    })
    if (!installed.length && errors.length) {
      return { ok: false, error: '形象写入失败：' + errors[0], installed: installed, skipped: skipped }
    }
    return {
      ok: true,
      installed: installed,
      skipped: skipped,
      total: SKIN_PACK_SKINS.length,
      errors: errors,
    }
  } catch (err) {
    const why = errMsg(err)
    logErr('[whale][skin-packs] 下载素材包失败', why)
    return { ok: false, error: why }
  } finally {
    running = false
  }
}

module.exports = { listSkinPacks, downloadSkinPacks, _parsePack: parsePack, _sourceChain: sourceChain }
