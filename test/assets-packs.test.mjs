/*
 * assets-packs.js 单测（node --test，零依赖）。
 *
 * 这个模块是「共享素材按需单张下载」的专职链路：拿远程单张素材（角色图 36 张 / 音效 45 个）
 * → 走候选链取单张字节 → 逐张 sha256 校验 → 落 skins / sounds 两条不同链路。
 * 它出错的后果都不显眼：校验写漏 = 代理返回的残缺字节被当正常安装；
 * 已装判断写漏 = 重复写覆盖用户素材；URL 拼错 = 全部下失败。
 *
 * 与 skin-packs.test.mjs 的分工：那边只测「内置形象」（整包下载、按文件名匹配、只落形象），
 * 这里测「共享素材」（单张下载、按 id 匹配、形象 + 音效两条链路）。候选链的失败分支
 * 两边各自钉一遍 —— 谁也不依赖谁的内部实现。
 *
 * 环境：落盘走 skins / sounds，两模块都依赖 utools.dbStorage 与 utools.getPath('userData')，
 * 这里用内存 dbStorage + 指向临时目录的 getPath 桩顶掉，不碰真实用户数据。
 *
 * 单张真源文件（public/shared/**）**随仓库提交**（见 .gitignore 的 !public/shared/**），
 * 但本测试不读本地文件 —— 下载链路全部走注入的 fetchImpl 桩，CI 上同样跑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

// ── utools 桩：内存 dbStorage + userData 指向本次测试的临时目录 ──
const store = new Map()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-assets-test-'))
globalThis.utools = {
  getPath: () => TMP,
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  },
}

const require = createRequire(import.meta.url)
const assetsPacks = require('../public/preload/lib/assets-packs.js')
const constants = require('../public/preload/lib/constants.js')
const sounds = require('../public/preload/lib/sounds.js')

const {
  _fileUrl: fileUrl, _sourceChain: sourceChain, listSharedSkins, listSharedSounds,
  downloadSharedSkin, downloadSharedSound,
} = assetsPacks
const {
  SHARED_SKIN_PACK_SKINS, SHARED_SOUND_LIB,
  SHARED_RAW_BASE, SHARED_PACK_DEFAULT_PREFIX,
} = constants

// ── URL 拼接（fileUrl）────────────────────────────────────────────────────
// 单张真源统一是 <基址><kind>/<id>.<ext>，id 是 ASCII 短名（原图中文名含全角括号，
// raw 直链需 percent-encode 且各 CDN 兼容性不一，故导出时按 id.ext 重命名）。
// 拼错一个字符 = 全部下失败，且报错只在「所有源都失败」里一行，所以要钉死。

test('fileUrl：角色拼成 <raw 基址>skins/<id>.png', () => {
  assert.equal(fileUrl('skins', 'shark', 'png'), SHARED_RAW_BASE + 'skins/shark.png')
})

test('fileUrl：音效拼成 <raw 基址>sounds/<id>.<ext>', () => {
  assert.equal(fileUrl('sounds', 'click', 'mp3'), SHARED_RAW_BASE + 'sounds/click.mp3')
})

test('fileUrl：基址以 / 结尾、kind 与 id 之间无多余斜杠', () => {
  const u = fileUrl('skins', 'a', 'png')
  assert.ok(u.indexOf('//skins') < 0, '不应出现双斜杠：' + u)
  assert.ok(u.endsWith('/skins/a.png'), '结尾应是 /skins/a.png：' + u)
  assert.ok(u.startsWith(SHARED_RAW_BASE), '应以 SHARED_RAW_BASE 开头：' + u)
})

test('fileUrl：清单一律以 .png 落角色、扩展名取自清单落音效', () => {
  for (const s of SHARED_SKIN_PACK_SKINS) {
    assert.equal(fileUrl('skins', s.id, 'png'), SHARED_RAW_BASE + 'skins/' + s.id + '.png', s.id)
  }
  for (const s of SHARED_SOUND_LIB) {
    assert.equal(fileUrl('sounds', s.id, s.ext), SHARED_RAW_BASE + 'sounds/' + s.id + '.' + s.ext, s.id)
  }
})

// ── 候选链（sourceChain）────────────────────────────────────────────────
// 顺序约定：用户自填（可选） → 内置默认前缀（ghfast.top） → 真源直连（raw.githubusercontent.com）。
// 单张链路只走 raw（不再有 Release 整包源），所以链条比整包版本短、且没有 raw 的额外包装项。
// jsDelivr 源待实测通过后再并入。

test('sourceChain：无自填时是「默认前缀 → 真源直连」两条，末位是直连', () => {
  const origin = fileUrl('skins', 'shark', 'png')
  const chain = sourceChain('', origin)
  assert.deepEqual(chain, [SHARED_PACK_DEFAULT_PREFIX + origin, origin])
  assert.equal(chain[chain.length - 1], origin, '末位应是真源直连，保证加速前缀全挂时还能拿到')
})

test('sourceChain：自填前缀排在最前', () => {
  const origin = fileUrl('sounds', 'click', 'mp3')
  const chain = sourceChain('https://my-proxy.example/', origin)
  assert.deepEqual(chain, [
    'https://my-proxy.example/' + origin,
    SHARED_PACK_DEFAULT_PREFIX + origin,
    origin,
  ])
})

test('sourceChain：自填与内置前缀相同时去重（不重复打同一个源）', () => {
  const origin = fileUrl('skins', 'shark', 'png')
  const chain = sourceChain(SHARED_PACK_DEFAULT_PREFIX, origin)
  assert.deepEqual(chain, [SHARED_PACK_DEFAULT_PREFIX + origin, origin])
})

test('sourceChain：空白 / 非字符串的自填被忽略，仍回落到内置链', () => {
  const origin = fileUrl('skins', 'shark', 'png')
  const expect = [SHARED_PACK_DEFAULT_PREFIX + origin, origin]
  for (const bad of ['   ', undefined, null, 42, {}]) {
    assert.deepEqual(sourceChain(bad, origin), expect)
  }
})

// ── 分块读取 + 进度上报（readBodyWithProgress）────────────────────────────
// 与 skin-packs 那份是同名实现但**刻意分开**（两条链路总量语义不同），这里同样钉住
// 「逐块累加」与「无流时退回一次性读取」两条分支。

const { _readBodyWithProgress: readBodyWithProgress } = assetsPacks

function streamRes(chunks, contentLength) {
  let i = 0
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? contentLength : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
      }),
    },
  }
}

test('assets readBodyWithProgress：逐块累加并拼回完整内容', async () => {
  const parts = [Buffer.from('aa'), Buffer.from('bbb'), Buffer.from('c')]
  const buf = await readBodyWithProgress(streamRes(parts, 6), null)
  assert.equal(buf.toString(), 'aabbbc')
})

test('assets readBodyWithProgress：每读一块回调一次，末次 received 等于总长', async () => {
  const parts = [Buffer.from('aa'), Buffer.from('bbb')]
  const seen = []
  await readBodyWithProgress(streamRes(parts, 5), (received, total) => seen.push([received, total]))
  assert.deepEqual(seen, [[2, 5], [5, 5]])
})

test('assets readBodyWithProgress：无 Content-Length 时 total 报 0', async () => {
  const seen = []
  await readBodyWithProgress(streamRes([Buffer.from('zz')], null), (received, total) => seen.push([received, total]))
  assert.deepEqual(seen, [[2, 0]])
})

test('assets readBodyWithProgress：拿不到可读流时退回一次性读取，仍回调一次', async () => {
  const junk = Buffer.from('fallback-path')
  const seen = []
  const res = {
    ok: true, status: 200,
    headers: { get: () => String(junk.length) },
    arrayBuffer: async () => junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.length),
  }
  const buf = await readBodyWithProgress(res, (received, total) => seen.push([received, total]))
  assert.equal(buf.toString(), 'fallback-path')
  assert.deepEqual(seen, [[junk.length, junk.length]])
})

// ── 清单（listSharedSkins / listSharedSounds）：与下载无关 ────────────────
// 两个清单都是从 constants 直接派生，不需要下载；这里钉住「覆盖全集 + 已装标记为布尔」

test('listSharedSkins：覆盖全部共享角色，字段类型与总字节数一致', () => {
  const r = listSharedSkins()
  assert.equal(r.ok, true)
  assert.equal(r.items.length, SHARED_SKIN_PACK_SKINS.length)
  assert.equal(r.totalSize, SHARED_SKIN_PACK_SKINS.reduce((n, s) => n + s.size, 0))
  for (const it of r.items) {
    assert.equal(typeof it.id, 'string')
    assert.equal(typeof it.name, 'string')
    assert.equal(typeof it.size, 'number')
    assert.equal(typeof it.installed, 'boolean')
  }
  assert.equal(r.installedCount, r.items.filter((x) => x.installed).length)
})

test('listSharedSounds：覆盖全部共享音效，字段类型与总字节数一致', () => {
  const r = listSharedSounds()
  assert.equal(r.ok, true)
  assert.equal(r.items.length, SHARED_SOUND_LIB.length)
  assert.equal(r.totalSize, SHARED_SOUND_LIB.reduce((n, s) => n + s.size, 0))
  for (const it of r.items) {
    assert.equal(typeof it.id, 'string')
    assert.equal(typeof it.name, 'string')
    assert.equal(typeof it.ext, 'string')
    assert.equal(typeof it.size, 'number')
    assert.equal(typeof it.installed, 'boolean')
  }
  assert.equal(r.installedCount, r.items.filter((x) => x.installed).length)
})

// ── 单张下载：downloadSharedSkin / downloadSharedSound ───────────────────
// 用注入的 fetchImpl 顶掉真实网络，覆盖成功 / 校验失败换源 / 未知 id / 已装跳过四条主分支。

const { createHash } = await import('node:crypto')
const sha = (b) => createHash('sha256').update(b).digest('hex')

// 下载链路会拿 constants 清单里的 sha256 逐张校验，桩返回的字节必须真的对得上，
// 才能走到成功分支。各用例的做法：临时把对应清单项的 sha256 改写成桩字节的摘要，
// 用完立刻还原（单测专用，不动仓库里的常量文件）。

// 造一个「返回指定字节」的 fetch 桩，并记录请求过的 URL。
// byUrl 的值可以是 Buffer（返回 200 + 该字节）、数字（返回该 HTTP 状态码）、或 null（404）。
function fetchStub(byUrl) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const hit = byUrl[url]
    if (hit === undefined || hit === null) return { ok: false, status: 404, statusText: 'Not Found' }
    if (typeof hit === 'number') return { ok: false, status: hit, statusText: 'HTTP ' + hit }
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(hit.length) : null) },
      body: streamRes([hit], hit.length).body,
    }
  }
  return { impl, calls }
}

test('downloadSharedSkin：单张成功后落进 skins 的 builtin 槽位', async () => {
  const meta = SHARED_SKIN_PACK_SKINS[1]
  const origin = fileUrl('skins', meta.id, 'png')
  const bytes = Buffer.alloc(Number(meta.size) || 8, 3)
  // 生产代码拿清单里的 sha256 逐张校验，桩字节对不上就永远走不到成功分支。
  // 临时改写清单项的 sha256 与桩字节一致，用完立刻还原（单测专用，不改仓库常量文件）。
  const saved = meta.sha256
  meta.sha256 = sha(bytes)
  try {
    const { impl } = fetchStub({ [origin]: bytes })
    const r = await downloadSharedSkin(meta.id, { fetchImpl: impl, prefix: '' })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.id, meta.id)
    assert.equal(r.bytes, bytes.length)
    assert.ok(r.source, '应回报命中的源 URL')
    assert.ok(listSharedSkins().items.find((x) => x.id === meta.id).installed, '应标记为已装')
  } finally {
    meta.sha256 = saved
  }
})

test('downloadSharedSkin：sha256 不符时顺延下一个源，命中可用源后成功', async () => {
  const meta = SHARED_SKIN_PACK_SKINS[2]
  const good = Buffer.alloc(Number(meta.size) || 8, 5)
  const origin = fileUrl('skins', meta.id, 'png')
  const badFromDefault = Buffer.alloc(good.length, 9) // 同长度但内容不同 → 校验必败
  const saved = meta.sha256
  meta.sha256 = sha(good)
  try {
    const { impl, calls } = fetchStub({
      [SHARED_PACK_DEFAULT_PREFIX + origin]: badFromDefault,
      [origin]: good,
    })
    const r = await downloadSharedSkin(meta.id, { fetchImpl: impl, prefix: '' })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.source, origin, '应命中真源直连')
    assert.equal(calls.length, 2, '应先试默认前缀再试直连')
  } finally {
    meta.sha256 = saved
  }
})

test('downloadSharedSkin：sha256 与内容不符时，所有源都不接受（校验真的生效）', async () => {
  const meta = SHARED_SKIN_PACK_SKINS[5]
  const origin = fileUrl('skins', meta.id, 'png')
  const bytes = Buffer.alloc(Number(meta.size) || 8, 4) // 与清单 sha256 必不符
  const { impl, calls } = fetchStub({
    [SHARED_PACK_DEFAULT_PREFIX + origin]: bytes,
    [origin]: bytes,
  })
  const r = await downloadSharedSkin(meta.id, { fetchImpl: impl, prefix: '' })
  assert.equal(r.ok, false)
  assert.match(r.error, /校验失败/)
  assert.equal(calls.length, 2, '两个源都应试过并因校验失败被拒')
  assert.ok(!listSharedSkins().items.find((x) => x.id === meta.id).installed, '校验失败不应落盘')
})

test('downloadSharedSkin：所有源都拿不到时返回 ok:false 且带失败原因', async () => {
  const meta = SHARED_SKIN_PACK_SKINS[3]
  const { impl } = fetchStub({}) // 全部 404
  const r = await downloadSharedSkin(meta.id, { fetchImpl: impl, prefix: '' })
  assert.equal(r.ok, false)
  assert.match(r.error, /所有下载源都失败/)
})

test('downloadSharedSkin：未知 id 直接拒绝，不发请求', async () => {
  let called = false
  const impl = async () => { called = true; return { ok: false, status: 404 } }
  const r = await downloadSharedSkin('no-such-skin', { fetchImpl: impl })
  assert.equal(r.ok, false)
  assert.match(r.error, /没有这个共享角色/)
  assert.equal(called, false, '未知 id 不应发起网络请求')
})

test('downloadSharedSkin：已装的不重下、不重写（回归：已装判断）', async () => {
  const meta = SHARED_SKIN_PACK_SKINS[4]
  const seed = require('../public/preload/lib/skins.js')
  const bytes = Buffer.alloc(Number(meta.size) || 8, 1)
  const seeded = seed.installBuiltin(meta.id, 'png', bytes, null)
  assert.ok(seeded && seeded.ok, '预置已装角色失败：' + ((seeded && seeded.error) || ''))

  let called = false
  const impl = async () => { called = true; return { ok: false, status: 404 } }
  const r = await downloadSharedSkin(meta.id, { fetchImpl: impl })
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true, '已装应走 skipped 分支')
  assert.equal(called, false, '已装不应发起网络请求')
})

test('downloadSharedSound：单段成功后落进 sounds 的 shared 槽位', async () => {
  const meta = SHARED_SOUND_LIB[1]
  const bytes = Buffer.alloc(Number(meta.size) || 8, 2)
  const origin = fileUrl('sounds', meta.id, meta.ext)
  const saved = meta.sha256
  meta.sha256 = sha(bytes)
  try {
    const { impl } = fetchStub({ [origin]: bytes })
    const r = await downloadSharedSound(meta.id, { fetchImpl: impl, prefix: '' })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.name, meta.name)
    assert.equal(r.bytes, bytes.length)
    const installed = sounds.readMeta().shared.find((x) => x.name === meta.name)
    assert.ok(installed, '应落进 sounds 的 shared 槽位')
  } finally {
    meta.sha256 = saved
  }
})

test('downloadSharedSound：已装的同名音效被跳过、不重写', async () => {
  const meta = SHARED_SOUND_LIB[2]
  const seed = sounds.installBuiltin(meta.name, meta.ext, Buffer.alloc(Number(meta.size) || 8, 7))
  assert.ok(seed && seed.ok, '预置已装音效失败：' + ((seed && seed.error) || ''))
  const before = sounds.readMeta().shared.find((x) => x.name === meta.name)

  let called = false
  const impl = async () => { called = true; return { ok: false, status: 404 } }
  const r = await downloadSharedSound(meta.id, { fetchImpl: impl })
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true, '已装音响应走 skipped')
  assert.equal(called, false, '已装不应发起网络请求')

  const after = sounds.readMeta().shared.find((x) => x.name === meta.name)
  assert.equal(after.file, before.file, '已装音效应保持原文件不动（未重写）')
  assert.equal(after.at, before.at, '已装音效的导入时间不应被刷新')
})

test('downloadSharedSound：未知 id 直接拒绝，不发请求', async () => {
  let called = false
  const impl = async () => { called = true; return { ok: false, status: 404 } }
  const r = await downloadSharedSound('no-such-sound', { fetchImpl: impl })
  assert.equal(r.ok, false)
  assert.match(r.error, /没有这个共享音效/)
  assert.equal(called, false)
})

// ── 清单自身约束（不读产物，CI 也跑）─────────────────────────────────────

test('共享角色清单：id 落在 skins.js 的 id 白名单内（^[A-Za-z0-9_-]{1,40}$）', () => {
  const re = /^[A-Za-z0-9_-]{1,40}$/
  const ids = new Set()
  for (const s of SHARED_SKIN_PACK_SKINS) {
    assert.match(s.id, re, 'id 不合规（skins.normItem 会拒）：' + s.id)
    assert.ok(!ids.has(s.id), 'id 重复：' + s.id)
    ids.add(s.id)
    assert.ok(s.sha256 && s.sha256.length === 64, '缺 sha256 或长度不对：' + s.id)
    assert.ok(Number(s.size) > 0, 'size 应大于 0：' + s.id)
  }
})

test('共享音效清单：id 唯一、扩展名在允许集合内、sha256 / size 齐备', () => {
  const okExt = ['mp3', 'wav', 'ogg', 'm4a', 'flac']
  const ids = new Set()
  const names = new Set()
  for (const s of SHARED_SOUND_LIB) {
    assert.ok(!ids.has(s.id), 'id 重复：' + s.id)
    ids.add(s.id)
    assert.ok(!names.has(s.name), 'name 重复（落盘按名去重会互相覆盖）：' + s.name)
    names.add(s.name)
    assert.ok(okExt.indexOf(String(s.ext).toLowerCase()) >= 0, '扩展名不被支持：' + s.ext)
    assert.ok(s.sha256 && s.sha256.length === 64, '缺 sha256 或长度不对：' + s.id)
    assert.ok(Number(s.size) > 0, 'size 应大于 0：' + s.id)
  }
})

test('单张共享角色不超过 skins 的单文件上限（5MB），否则下载必失败', () => {
  for (const s of SHARED_SKIN_PACK_SKINS) {
    assert.ok(Number(s.size) < 5 * 1024 * 1024, '超出 5MB 上限：' + s.id)
  }
})

test('单段共享音效不超过 sounds 的单文件上限（5MB）', () => {
  for (const s of SHARED_SOUND_LIB) {
    assert.ok(Number(s.size) < 5 * 1024 * 1024, '超出 5MB 上限：' + s.id)
  }
})

test('单张共享角色不超过 SHARED_PACK_MAX_BYTES（下载期硬上限）', () => {
  const { SHARED_PACK_MAX_BYTES } = constants
  for (const s of SHARED_SKIN_PACK_SKINS) {
    assert.ok(Number(s.size) <= SHARED_PACK_MAX_BYTES, '超出下载上限：' + s.id)
  }
  for (const s of SHARED_SOUND_LIB) {
    assert.ok(Number(s.size) <= SHARED_PACK_MAX_BYTES, '超出下载上限：' + s.id)
  }
})

// ── 真源文件（public/shared/**，入库；本地存在才校验）────────────────────
// 单张真源现已随仓库提交，本地 clone 就有一份。这里用 existsSync 兜底：
// 文件在就逐项校验 sha256 与 constants 一致（防止「改了图忘了更新清单」）。

const SHARED_DIR = path.join('public', 'shared')

test('真源目录里每张角色图的 sha256 / size 与 constants 清单一致', { skip: !fs.existsSync(SHARED_DIR) && '缺少 public/shared/（未跑导出脚本）' }, () => {
  for (const s of SHARED_SKIN_PACK_SKINS) {
    const f = path.join(SHARED_DIR, 'skins', s.id + '.png')
    assert.ok(fs.existsSync(f), '真源缺角色文件：' + f)
    const buf = fs.readFileSync(f)
    assert.equal(buf.length, Number(s.size), s.id + ' 字节数与清单不符')
    assert.equal(sha(buf), s.sha256, s.id + ' sha256 与清单不符')
  }
})

test('真源目录里每段音效的 sha256 / size 与 constants 清单一致', { skip: !fs.existsSync(SHARED_DIR) && '缺少 public/shared/（未跑导出脚本）' }, () => {
  for (const s of SHARED_SOUND_LIB) {
    const f = path.join(SHARED_DIR, 'sounds', s.id + '.' + s.ext)
    assert.ok(fs.existsSync(f), '真源缺音效文件：' + f)
    const buf = fs.readFileSync(f)
    assert.equal(buf.length, Number(s.size), s.id + ' 字节数与清单不符')
    assert.equal(sha(buf), s.sha256, s.id + ' sha256 与清单不符')
  }
})

test('真源目录里没有清单未收录的多余文件（防止改名后留下孤儿）', { skip: !fs.existsSync(SHARED_DIR) && '缺少 public/shared/' }, () => {
  const expectSkins = new Set(SHARED_SKIN_PACK_SKINS.map((s) => s.id + '.png'))
  for (const f of fs.readdirSync(path.join(SHARED_DIR, 'skins'))) {
    assert.ok(expectSkins.has(f), 'skins/ 里有清单未收录的文件：' + f)
  }
  const expectSounds = new Set(SHARED_SOUND_LIB.map((s) => s.id + '.' + s.ext))
  for (const f of fs.readdirSync(path.join(SHARED_DIR, 'sounds'))) {
    assert.ok(expectSounds.has(f), 'sounds/ 里有清单未收录的文件：' + f)
  }
})
