/*
 * bg-video.js 单测（node --test，零依赖）。
 *
 * 这份素材不随包（CC BY-NC-SA 4.0），宿主只负责按需下载、校验、落盘与读回。
 * 出错后果都比较安静：校验漏了会把代理错误页当视频、路径拼错会写不进去、
 * 已装判断漏了会反复重下 1.3MB —— 这里把这几条主分支钉住。
 *
 * 不读真实视频文件：下载全部走注入的 fetchImpl 桩；用与真实文件同体积的合成字节
 * （sha256 用 opts 注入）覆盖成功路径，CI 上同样跑。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bg-video-test-'))
after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })

globalThis.utools = {
  getPath: () => TMP,
  dbStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
}

const require = createRequire(import.meta.url)
const bgVideo = require('../public/preload/lib/bg-video.js')
const constants = require('../public/preload/lib/constants.js')
const dlp = require('../public/preload/lib/download-progress.js')
const { BG_VIDEO_BYTES, BG_VIDEO_URLS } = constants

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// 与真实视频同体积的合成内容：让 installed / readData 的体积判定走真实分支
const GOOD = Buffer.alloc(BG_VIDEO_BYTES, 7)
const GOOD_SHA = sha256(GOOD)

function resOf(buf, ok = true) {
  return {
    ok: ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'ERR',
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(buf.length) : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  }
}

function stubFetch(handler) {
  const urls = []
  const impl = async (url) => {
    urls.push(url)
    return handler(url, urls.length)
  }
  impl.urls = urls
  return impl
}

function cleanupFile() {
  try { fs.unlinkSync(bgVideo.filePath()) } catch (err) {}
  // remove 缓存里的 data URL，避免跨用例串状态
  bgVideo.remove()
}

test('初始状态：未下载、体积为 0，带署名与许可信息', () => {
  cleanupFile()
  const s = bgVideo.status()
  assert.equal(s.ok, true)
  assert.equal(s.installed, false)
  assert.equal(s.bytes, 0)
  assert.equal(s.legacy, false)
  assert.equal(s.size, BG_VIDEO_BYTES)
  assert.equal(s.license, 'CC BY-NC-SA 4.0')
  assert.equal(s.author, 'stushansusu')
  assert.match(s.source, /zhu1090093659\/dsh-web/)
  assert.match(s.licenseUrl, /creativecommons\.org/)
})

test('下载：命中首个源后落盘、状态变已装、readData 回 data URL', async () => {
  cleanupFile()
  const impl = stubFetch(() => resOf(GOOD))
  const r = await bgVideo.download({ fetchImpl: impl, sha256: GOOD_SHA })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.bytes, BG_VIDEO_BYTES)
  assert.equal(impl.urls.length, 1)
  assert.equal(impl.urls[0], BG_VIDEO_URLS[0])
  assert.equal(bgVideo.status().installed, true)
  assert.equal(fs.statSync(bgVideo.filePath()).size, BG_VIDEO_BYTES)

  const data = bgVideo.readData()
  assert.equal(data.ok, true)
  assert.ok(data.dataUrl.startsWith('data:video/mp4;base64,'))
  assert.equal(data.bytes, BG_VIDEO_BYTES)

  const snap = dlp.snapshot()
  assert.equal(snap.pack, 'bg-video')
  assert.equal(snap.phase, 'done')
  assert.equal(snap.bytes, BG_VIDEO_BYTES)
})

test('下载新版完整视频后清理旧版 1.3MB 缓存', async () => {
  cleanupFile()
  const legacy = path.join(path.dirname(bgVideo.filePath()), 'whale-blink-loop.mp4')
  fs.mkdirSync(path.dirname(legacy), { recursive: true })
  fs.writeFileSync(legacy, Buffer.alloc(1361232, 3))
  assert.equal(bgVideo.status().legacy, true)
  const impl = stubFetch(() => resOf(GOOD))
  const r = await bgVideo.download({ fetchImpl: impl, sha256: GOOD_SHA })
  assert.equal(r.ok, true, r.error)
  assert.equal(fs.existsSync(legacy), false)
  assert.equal(bgVideo.status().legacy, false)
})

test('已装时不重复下载：第二次调用 fetch 一个都不发', async () => {
  cleanupFile()
  const first = stubFetch(() => resOf(GOOD))
  const r1 = await bgVideo.download({ fetchImpl: first, sha256: GOOD_SHA })
  assert.equal(r1.ok, true, r1.error)

  const impl = stubFetch(() => resOf(GOOD))
  const r2 = await bgVideo.download({ fetchImpl: impl, sha256: GOOD_SHA })
  assert.equal(r2.ok, true)
  assert.equal(r2.skipped, true)
  assert.equal(impl.urls.length, 0)
})

test('首个源失败时顺延到下一个可用源', async () => {
  cleanupFile()
  const impl = stubFetch((url, n) => (n === 1 ? Promise.reject(new Error('reset')) : resOf(GOOD)))
  const r = await bgVideo.download({ fetchImpl: impl, sha256: GOOD_SHA })
  assert.equal(r.ok, true, r.error)
  assert.equal(impl.urls.length, 2)
  assert.equal(r.source, BG_VIDEO_URLS[1])
})

test('sha256 不符时所有源都不接受，不落盘', async () => {
  cleanupFile()
  const impl = stubFetch(() => resOf(Buffer.alloc(BG_VIDEO_BYTES, 9)))
  const r = await bgVideo.download({ fetchImpl: impl, sha256: GOOD_SHA })
  assert.equal(r.ok, false)
  assert.match(r.error, /所有下载源都失败/)
  assert.match(r.error, /校验失败/)
  assert.equal(impl.urls.length, BG_VIDEO_URLS.length)
  assert.equal(bgVideo.status().installed, false)
  assert.throws(() => fs.statSync(bgVideo.filePath()))
})

test('体积不符时直接拒绝（不把截断包当视频）', async () => {
  cleanupFile()
  const impl = stubFetch(() => resOf(Buffer.alloc(128, 1)))
  const r = await bgVideo.download({ fetchImpl: impl, sha256: GOOD_SHA })
  assert.equal(r.ok, false)
  assert.match(r.error, /体积不符/)
  assert.equal(bgVideo.status().installed, false)
})

test('删除：清掉本地文件，状态回到未下载；重复删除不报错', () => {
  const r1 = bgVideo.remove()
  assert.equal(r1.ok, true)
  assert.equal(bgVideo.status().installed, false)
  const r2 = bgVideo.remove()
  assert.equal(r2.ok, true)
})

test('未下载时 readData 返回失败而不是抛错', () => {
  cleanupFile()
  const d = bgVideo.readData()
  assert.equal(d.ok, false)
  assert.match(d.error, /尚未下载/)
})

test('目录与源标签：落在 userData/whale-bg，三个源可辨认', () => {
  assert.equal(path.dirname(bgVideo.filePath()), path.join(TMP, 'whale-bg'))
  assert.equal(bgVideo._labelOf(BG_VIDEO_URLS[0]), 'jsDelivr CDN')
  assert.equal(bgVideo._labelOf(BG_VIDEO_URLS[1]), '默认加速 ghfast.top')
  assert.equal(bgVideo._labelOf(BG_VIDEO_URLS[2]), '直连 raw.githubusercontent.com')
})
