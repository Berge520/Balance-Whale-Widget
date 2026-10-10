/*
 * 内置形象「按需下载」（CommonJS）。
 *
 * ── 为什么要有这个模块 ──
 * 13 张内置形象原先全部随包分发（约 1.07MB，占插件包 39%）。v1.7.x 起只留默认那张
 * （DSniang1，约 39KB）随包，其余打成一个素材包挂在 GitHub Release 上，
 * 用户按需下载 —— 目的是把插件包从约 2.7MB 压到约 1.7MB。v1.8.0 起该可下载包再从
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
const {
  SKIN_PACK_URL, SKIN_PACK_ORIGIN, SKIN_PACK_DEFAULT_PREFIX, SKIN_PACK_RAW_MAIN,
  SKIN_PACK_RAW_ITEM_BASE,
  SKIN_PACK_SHA256, SKIN_PACK_TIMEOUT_MS, SKIN_PACK_MAX_BYTES, SKIN_PACK_SKINS,
} = require('./constants')
const { log, logErr } = require('./log')
const { errMsg, sha256 } = require('./util')
const skins = require('./skins')
const dlp = require('./download-progress')

const MAGIC = 'WHALEASSET1'
const KIND = 'balance-whale-widget-assets'
const HEAD_BYTES = MAGIC.length + 4

// 内存状态：进行中的下载（防重复点击，也让设置页能显示「正在下」）。
// 只存内存 —— 重载插件即中断，符合预期（下载是一次性的短操作）。
let running = false

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

// 把响应体流式读成 Buffer，边读边累加字节数。
//
// ── 为什么不用 `res.arrayBuffer()` ──
// 那样一次性读完，中间没有任何可上报的时点，设置页只能干显「正在下载…」（用户实测反馈：
// 「看不见下载进度，一直显示正在下载」）。改成读 res.body 的 reader 逐块累加，
// 才有 received / total 可报。整包 0.9MB 不大，但链路一致更重要。
//
// ── 为什么 Content-Length 缺失也要能跑 ──
// 走加速代理时响应可能被重新分块（Transfer-Encoding: chunked），拿不到 Content-Length。
// 这时 total 记 0、由读侧显示「不确定进度条」，而不是谎报百分比。
async function readBodyWithProgress(res, onChunk) {
  const lenHeader = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0)
  const total = lenHeader > 0 ? lenHeader : 0
  // 没有可读流（单测注入的假响应 / 老实现）时退回一次性读取，保证兼容
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

// 从单个源取包并做全部前置校验。任何一步不过都抛错（供候选链顺延到下一个源）。
// 返回 { buf, parsed }。
async function fetchPackFrom(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(SKIN_PACK_TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText || ''))
  const buf = await readBodyWithProgress(res, (received, total) => dlp.progress(received, total))
  if (!buf.length) throw new Error('下载到空内容')
  if (buf.length > SKIN_PACK_MAX_BYTES) throw new Error('素材包异常大（' + buf.length + ' 字节）')

  // ① 整包校验：代理返回 HTML 错误页 / 截断都能在这里被挡下
  dlp.phase('verify')
  const digest = sha256(buf)
  if (SKIN_PACK_SHA256 && digest !== SKIN_PACK_SHA256) {
    logErr('[whale][skin-packs] 素材包校验失败', 'got ' + digest)
    throw new Error('素材包校验失败（内容与预期不符）')
  }

  dlp.phase('install', { label: '正在解包…' })
  const parsed = parsePack(buf)
  if (parsed.error) throw new Error(parsed.error)
  return { buf: buf, parsed: parsed, url: url }
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
  // 进度起始总量取「清单里这批的预期字节」——比 Content-Length 更贴近用户预期
  // （用户要下的是「剩余 N 张」，不是「这个容器文件多大」），服务端给了真值会覆盖它
  dlp.begin('skins', SKIN_PACK_SKINS.reduce((n, s) => n + (Number(s.size) || 0), 0))
  try {
    // ── 取包：候选链逐个试，任一源取到合法包即停 ──
    // 「合法」含 sha256 过关 —— 代理返 HTML / 半截包会在 fetchPackFrom 里被判失败并顺延下一源，
    // 而不是退给用户一个「校验失败」（那条报错对用户毫无可操作性）
    let pack = null
    const attempts = []
    for (const url of chain) {
      const label = labelOf(url)
      try {
        dlp.source(url, label)
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
    // 取包阶段（含校验 / 解包）已过，接下来是逐张写盘：进度条在这段不再涨字节，
    // 故把阶段改写出来，免得用户看着 100% 的条以为卡死
    dlp.phase('install', { label: '正在写入形象…', total: buf.length })

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
      // 缩略图：manifest 的每项带 thumbOff / thumbLen（导出时由 assets.js 一并写进容器，
      // 见 scripts/build-skin-pack.py）。两者为 0 表示这个包没带缩略图 —— 那就传空串，
      // 宿主定位不到插件目录，设置页也没有共享角色那条「懒补」后路，只能回落读原图。
      let thumb = ''
      const thumbLen = Number(it.thumbLen) || 0
      if (thumbLen > 0) {
        const to = Number(it.thumbOff) || 0
        const tb = buf.slice(parsed.dataStart + to, parsed.dataStart + to + thumbLen)
        if (tb.length) thumb = 'data:image/webp;base64,' + tb.toString('base64')
      }
      const r = skins.installBuiltin(meta.id, ext, data, thumb)
      if (r && r.ok) installed.push(meta.id)
      else {
        errors.push(meta.id + '（' + ((r && r.error) || '写入失败') + '）')
        if (r && r.error) logErr('[whale][skin-packs] 安装失败', meta.id + ': ' + r.error)
      }
    }
    log('[whale][skin-packs] 素材包已下载', {
      bytes: buf.length, source: pack.url, installed: installed.length, skipped: skipped.length, errors: errors.length,
    })
    dlp.end(true, buf.length)
    if (!installed.length && errors.length) {
      return { ok: false, error: '形象写入失败：' + errors[0], installed: installed, skipped: skipped }
    }
    return {
      ok: true,
      installed: installed,
      skipped: skipped,
      total: SKIN_PACK_SKINS.length,
      errors: errors,
      // 回传实际命中的源与落地字节：设置页结果提示里能写明「经 ghfast.top 下载 0.9 MB」，
      // 用户遇到「慢 / 下不动」时立刻知道该换哪个源
      source: pack.url,
      bytes: buf.length,
    }
  } catch (err) {
    const why = errMsg(err)
    dlp.end(false, 0)
    logErr('[whale][skin-packs] 下载素材包失败', why)
    return { ok: false, error: why }
  } finally {
    running = false
  }
}

// ── 单张下载（v1.9.0 起）──
// 设置页点「随包内置」里的某张缩略图 = 只下这一张。走向与整包**不同**：
// 整包走 Release 上的 .whaleassets 容器（一次拿全、含整体 sha256），这里走 public/whale-pack/
// 下的单张原图 raw 直链（该目录随仓入库，见 scripts/build-skin-pack.py 的导出）。
// 为什么不复用整包链路：包只剩 1 张时「单张」与「整包」等价，但语义上要与「共享角色点一张下一张」
// 对齐 —— 用户不该记「这张卡点缩略图会连带下别的」。且单张失败面更小（不必解容器）
// 与共享角色同一套候选链 / 单张 sha256。
// 缩略图由设置页从打包资源读好后经 opts.thumb 传入（宿主定位不到插件目录，见 skins.installBuiltin）。
async function downloadSkinPackItem(id, opts) {
  const meta = SKIN_PACK_SKINS.filter((s) => s.id === id)[0]
  if (!meta) return { ok: false, error: '没有这个内置形象：' + String(id || '') }
  if (skins.builtinIds().indexOf(meta.id) >= 0) return { ok: true, id: meta.id, name: meta.id, skipped: true }

  const o = opts && typeof opts === 'object' ? opts : {}
  if (running) return { ok: false, error: '正在下载中，请稍候' }
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  running = true
  dlp.begin('skins', Number(meta.size) || 0)
  dlp.phase('connect', { label: '正在连接下载源…' })
  try {
    const origin = SKIN_PACK_RAW_ITEM_BASE + meta.file
    const chain = itemSourceChain(o.prefix, origin)
    const attempts = []
    let got = null
    for (const url of chain) {
      const label = itemLabelOf(url, origin)
      try {
        dlp.source(url, label)
        got = await fetchItemFrom(url, meta.sha256, fetchImpl)
        attempts.push(label + '：成功')
        break
      } catch (err) {
        const why = errMsg(err)
        attempts.push(label + '：' + why)
        logErr('[whale][skin-packs] 单张下载源失败，顺延下一个', label, why)
      }
    }
    if (!got) throw new Error('所有下载源都失败 —— ' + attempts.join('；'))

    dlp.phase('install', { label: '正在写入形象…', total: got.buf.length })
    const ext = (meta.file.split('.').pop() || 'webp').toLowerCase()
    const r = skins.installBuiltin(meta.id, ext, got.buf, o.thumb || '', meta.id)
    if (!r || !r.ok) {
      const why = (r && r.error) || '写入失败'
      dlp.end(false, got.buf.length)
      logErr('[whale][skin-packs] 安装内置形象失败', meta.id + ': ' + why)
      return { ok: false, error: '形象写入失败：' + why }
    }
    log('[whale][skin-packs] 内置形象已下载', { id: meta.id, bytes: got.buf.length, source: got.url })
    dlp.end(true, got.buf.length)
    return { ok: true, id: meta.id, name: meta.id, source: got.url, bytes: got.buf.length }
  } catch (err) {
    const why = errMsg(err)
    dlp.end(false, 0)
    logErr('[whale][skin-packs] 下载内置形象失败', meta.id + ': ' + why)
    return { ok: false, error: why }
  } finally {
    running = false
  }
}

// 单张原图的候选链：用户自填前缀（若有）→ 内置默认前缀 → 真源直连。
// 与 assets-packs.js#sourceChain 同构，只是目标是 public/whale-pack/ 下的单张原图。
function itemSourceChain(prefix, origin) {
  const out = []
  const push = (u) => { if (u && !out.includes(u)) out.push(u) }
  const p = typeof prefix === 'string' ? prefix.trim() : ''
  if (p) push(p + origin)
  push(SKIN_PACK_DEFAULT_PREFIX + origin)
  push(origin)
  return out
}

function itemLabelOf(url, origin) {
  if (url === origin) return '直连 raw.githubusercontent.com'
  if (url.indexOf(origin) >= 0 && url.indexOf(SKIN_PACK_DEFAULT_PREFIX) === 0) return '默认加速 ghfast.top'
  return '自定义加速源'
}

// 从单个源取单张原图并逐张 sha256 校验。任何一步不过都抛错（供候选链顺延）。
async function fetchItemFrom(url, wantSha, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(SKIN_PACK_TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText || ''))
  const buf = await readBodyWithProgress(res, (received, total) => dlp.progress(received, total))
  if (!buf.length) throw new Error('下载到空内容')
  if (buf.length > SKIN_PACK_MAX_BYTES) throw new Error('文件异常大（' + buf.length + ' 字节）')
  dlp.phase('verify')
  const digest = sha256(buf)
  if (wantSha && digest !== wantSha) {
    logErr('[whale][skin-packs] 单张校验失败', url, 'got ' + digest)
    throw new Error('校验失败（内容与预期不符）')
  }
  return { buf: buf, url: url }
}

module.exports = {
  listSkinPacks, downloadSkinPacks, downloadSkinPackItem,
  _parsePack: parsePack, _sourceChain: sourceChain, _readBodyWithProgress: readBodyWithProgress,
  _itemSourceChain: itemSourceChain, _labelOf: labelOf, _itemLabelOf: itemLabelOf,
}
