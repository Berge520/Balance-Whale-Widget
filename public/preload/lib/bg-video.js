/*
 * 「未至之境」鲸鱼娘视频壁纸（CommonJS）：按需下载 + 本地缓存。
 *
 * ── 为什么单独一条链路 ──
 * 这份素材是 CC BY-NC-SA 4.0（作者 stushansusu），**不随插件包分发**；用户在外观页
 * 主动点「下载视频壁纸」时才取，落在 userData/whale-bg/。它只服务设置页的背景层，
 * 挂件页完全不读 —— 挂件是常驻透明小窗，视频既挡内容又白占内存。
 * 内容为原始 25.5s 完整循环（含线条构建 / 眨眼 / 雨滴），比上游裁出的 2.58s 眨眼片段
 * 有更明显的动态；代价是约 6.4MB，仍按需下载。
 *
 * ── 校验 ──
 * 落盘前逐字节 sha256 + 体积双校验：代理返回 HTML 错误页、截断包都能拦住；
 * 状态判定也认“体积等于预期”，手改/损坏的文件会被当成未下载，允许重新取。
 *
 * ── 下载源 ──
 * jsDelivr → ghfast 加速 → raw 直连，逐个试；任一源拿到合法字节即停。与
 * assets-packs.js 同思路，但目标只有这一个文件，不引入共享素材那套清单。
 */
const fs = require('fs')
const path = require('path')
const {
  BG_VIDEO_URLS, BG_VIDEO_SHA256, BG_VIDEO_BYTES, BG_VIDEO_MAX_BYTES,
  BG_VIDEO_TIMEOUT_MS, BG_VIDEO_LICENSE, BG_VIDEO_AUTHOR, BG_VIDEO_SOURCE,
  BG_VIDEO_LICENSE_URL,
} = require('./constants')
const { log, logErr } = require('./log')
const { errMsg, readBodyWithProgress, sha256 } = require('./util')
const dlp = require('./download-progress')
const { dataDir } = require('./data-dir')

const FILE = 'whale-fantasy-loop.mp4'
// 上一版（2.58s 眨眼片段）的落盘名：只清不读，避免升级后 userData 里留一份 1.3MB 垃圾。
// 旧文件体积/哈希都与当前期望不符，status 会自然显示「未下载」，用户点一次下载即覆盖。
const LEGACY_FILE = 'whale-blink-loop.mp4'
const MIME = 'video/mp4'
const PACK = 'bg-video'

let running = false

function dir() {
  return dataDir('whale-bg')
}

function filePath() {
  return path.join(dir(), FILE)
}

function legacyPath() {
  return path.join(dir(), LEGACY_FILE)
}

function removeLegacy() {
  try { fs.unlinkSync(legacyPath()) } catch (err) {}
}

function fileBytes() {
  try { return fs.statSync(filePath()).size } catch (err) { return 0 }
}

function legacyBytes() {
  try { return fs.statSync(legacyPath()).size } catch (err) { return 0 }
}

function installed() {
  return fileBytes() === BG_VIDEO_BYTES
}

function status() {
  const bytes = fileBytes()
  return {
    ok: true,
    installed: bytes === BG_VIDEO_BYTES,
    bytes: bytes,
    size: BG_VIDEO_BYTES,
    // 上一版 2.58s 短片段还在：设置页据此提示「更新为完整版」，而不是谎称「尚未下载」
    legacy: legacyBytes() > 0,
    license: BG_VIDEO_LICENSE,
    author: BG_VIDEO_AUTHOR,
    source: BG_VIDEO_SOURCE,
    licenseUrl: BG_VIDEO_LICENSE_URL,
  }
}

function labelOf(url) {
  if (url.indexOf('cdn.jsdelivr.net') >= 0) return 'jsDelivr CDN'
  if (url.indexOf('ghfast.top') >= 0) return '默认加速 ghfast.top'
  return '直连 raw.githubusercontent.com'
}

// 单源取体并校验；任何一步不过都抛错，供候选链顺延
async function fetchFrom(url, expectSha, expectBytes, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(BG_VIDEO_TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText || ''))
  const buf = await readBodyWithProgress(res, (received, total) => dlp.progress(received, total))
  if (!buf.length) throw new Error('下载到空内容')
  if (buf.length > BG_VIDEO_MAX_BYTES) throw new Error('文件异常大（' + buf.length + ' 字节）')
  if (expectBytes && buf.length !== expectBytes) {
    throw new Error('体积不符（期望 ' + expectBytes + '，实际 ' + buf.length + '）')
  }
  dlp.phase('verify')
  const digest = sha256(buf)
  if (expectSha && digest !== expectSha) {
    logErr('[whale][bg-video] 校验失败', url, 'got ' + digest)
    throw new Error('校验失败（内容与预期不符）')
  }
  return { buf: buf, url: url }
}

async function fetchWithChain(fetchImpl, expectSha, expectBytes) {
  const attempts = []
  for (const url of BG_VIDEO_URLS) {
    const label = labelOf(url)
    try {
      dlp.source(url, label)
      const got = await fetchFrom(url, expectSha, expectBytes, fetchImpl)
      attempts.push(label + '：成功')
      return { item: got, attempts: attempts }
    } catch (err) {
      const why = errMsg(err)
      attempts.push(label + '：' + why)
      logErr('[whale][bg-video] 下载源失败，顺延下一个', label, why)
    }
  }
  throw new Error('所有下载源都失败 —— ' + attempts.join('；'))
}

// 下载并落盘。opts.fetchImpl / opts.sha256 / opts.bytes 供单测注入（生产不传）。
async function download(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (running) return { ok: false, error: '正在下载中，请稍候' }
  if (installed()) return { ok: true, skipped: true, bytes: fileBytes() }

  const expectSha = typeof o.sha256 === 'string' && o.sha256 ? o.sha256 : BG_VIDEO_SHA256
  const expectBytes = Number(o.bytes) > 0 ? Number(o.bytes) : BG_VIDEO_BYTES
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch

  running = true
  dlp.begin(PACK, expectBytes)
  dlp.phase('connect', { label: '正在连接下载源…' })
  try {
    const res = await fetchWithChain(fetchImpl, expectSha, expectBytes)
    dlp.phase('install', { label: '正在写入视频…', total: res.item.buf.length })
    const dirPath = dir()
    const target = filePath()
    const tmp = target + '.part'
    try {
      fs.mkdirSync(dirPath, { recursive: true })
      fs.writeFileSync(tmp, res.item.buf)
      try { fs.unlinkSync(target) } catch (err) {}
      fs.renameSync(tmp, target)
    } catch (err) {
      try { fs.unlinkSync(tmp) } catch (e) {}
      throw new Error('写入视频失败：' + errMsg(err), { cause: err })
    }
    removeLegacy()
    log('[whale][bg-video] 视频壁纸已下载', { bytes: res.item.buf.length, source: res.item.url })
    dlp.end(true, res.item.buf.length)
    return { ok: true, bytes: res.item.buf.length, source: res.item.url }
  } catch (err) {
    const why = errMsg(err)
    dlp.end(false, 0)
    logErr('[whale][bg-video] 下载视频壁纸失败', why)
    return { ok: false, error: why }
  } finally {
    running = false
  }
}

// 设置页背景层用：读成 data URL 交给渲染进程转 blob。文件缺失 / 体积不符回空。
// 不做内存缓存：设置页只在切到 video 时读一次，1.8MB base64 常驻 preload 不划算。
function readData() {
  if (!installed()) return { ok: false, error: '视频壁纸尚未下载' }
  let buf = null
  try { buf = fs.readFileSync(filePath()) } catch (err) {
    logErr('[whale][bg-video] 读取视频失败', errMsg(err))
    return { ok: false, error: '读取视频失败：' + errMsg(err) }
  }
  if (buf.length !== BG_VIDEO_BYTES) return { ok: false, error: '视频文件不完整，请重新下载' }
  return { ok: true, dataUrl: 'data:' + MIME + ';base64,' + buf.toString('base64'), bytes: buf.length }
}

function remove() {
  removeLegacy()
  try { fs.unlinkSync(filePath()) } catch (err) {
    if (err && err.code !== 'ENOENT') {
      logErr('[whale][bg-video] 删除视频失败', errMsg(err))
      return { ok: false, error: '删除失败：' + errMsg(err) }
    }
  }
  return { ok: true }
}

module.exports = {
  dir, filePath, status, download, readData, remove,
  // 单测用
  _installed: installed, _labelOf: labelOf,
}
