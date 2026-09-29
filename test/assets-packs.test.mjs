/*
 * assets-packs.js 单测（node --test，零依赖）。
 *
 * 这个模块是「共享素材按需下载」的专职链路：拿远程素材包（角色图 36 张 / 音效 45 个）
 * → 解析容器 → 双重 sha256 校验 → 落 skins / sounds 两条不同链路。它出错的后果都不显眼：
 * 校验写漏 = 代理返回的半截包被当正常安装；边界写漏 = 越界切片读到别人的字节；
 * 已装判断写漏 = 重复写覆盖用户素材。
 *
 * 与 skin-packs.test.mjs 的分工：那边只测「内置形象」（按文件名匹配、只落形象），
 * 这里测「共享素材」（按 id 匹配、形象 + 音效两条链路）。容器格式与候选链同源，
 * 解析 / 候选链的失败分支两边各自钉一遍 —— 谁也不依赖谁的内部实现。
 *
 * 环境：落盘走 skins / sounds，两模块都依赖 utools.dbStorage 与 utools.getPath('userData')，
 * 这里用内存 dbStorage + 指向临时目录的 getPath 桩顶掉，不碰真实用户数据。
 *
 * 大件产物（resources/*.whaleassets，各 40MB / 2.7MB）**不随仓库提交**（见 .gitignore），
 * 所以「吃真实产物」的那几组断言用 existsSync 兜底：本地跑过 build-assets-pack.py 才执行，
 * CI 上没有这两份包就跳过（其余解析 / 候选链 / 清单断言与包无关，始终执行）。
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

const { _parsePack: parsePack, _sourceChain: sourceChain, listSharedSkins, listSharedSounds, downloadSharedSounds } = assetsPacks
const {
  SHARED_SKIN_PACK_SKINS, SHARED_SOUND_LIB,
  SHARED_SKIN_PACK_SHA256, SHARED_SOUND_PACK_SHA256,
  SHARED_SKIN_PACK_ORIGIN, SHARED_SOUND_PACK_ORIGIN, SHARED_PACK_DEFAULT_PREFIX,
  SHARED_SKIN_PACK_RAW_MAIN, SHARED_SOUND_PACK_RAW_MAIN,
} = constants

const SKIN_PACK_PATH = path.join('resources', 'assets-skins.whaleassets')
const SOUND_PACK_PATH = path.join('resources', 'assets-sounds.whaleassets')
const MANIFEST_PATH = path.join('resources', 'manifest.json')
const hasSkinPack = fs.existsSync(SKIN_PACK_PATH)
const hasSoundPack = fs.existsSync(SOUND_PACK_PATH)
const hasManifest = fs.existsSync(MANIFEST_PATH)

const MAGIC = 'WHALEASSET1'
const KIND = 'balance-whale-widget-assets'
// 与 assets-packs.js 内部一致：魔数(11) + 清单长度 uint32(4)
const HEAD_BYTES = MAGIC.length + 4

// 造一个最小合法容器：[魔数][长度][清单][数据]
function makePack(items, data) {
  const manifest = { kind: KIND, schema: 1, skins: items || [], sounds: [], bubbles: [] }
  const json = Buffer.from(JSON.stringify(manifest), 'utf8')
  const head = Buffer.alloc(HEAD_BYTES)
  head.write(MAGIC, 0, 'latin1')
  head.writeUInt32LE(json.length, MAGIC.length)
  return Buffer.concat([head, json, data])
}

// ── 解析：失败分支（与包是否在仓库无关，CI 也跑）────────────────────────

test('parsePack 拒绝过小 / 空 / 非 Buffer', () => {
  assert.ok(parsePack(null).error)
  assert.ok(parsePack(Buffer.alloc(0)).error)
  assert.ok(parsePack(Buffer.from('short')).error)
  // 恰好等于头长度（无清单无数据）也要拒
  assert.ok(parsePack(Buffer.alloc(HEAD_BYTES)).error)
})

test('parsePack 拒绝魔数不符（代理错误页 / 别的文件）', () => {
  const html = Buffer.concat([Buffer.from('<html>404</html>'.padEnd(20)), Buffer.alloc(20)])
  assert.ok(parsePack(html).error)
})

test('parsePack 拒绝清单长度越界与非法 JSON', () => {
  const head = Buffer.alloc(HEAD_BYTES)
  head.write(MAGIC, 0, 'latin1')
  head.writeUInt32LE(99999, MAGIC.length)
  assert.ok(parsePack(Buffer.concat([head, Buffer.alloc(8)])).error)

  const zero = Buffer.alloc(HEAD_BYTES)
  zero.write(MAGIC, 0, 'latin1')
  zero.writeUInt32LE(0, MAGIC.length)
  assert.ok(parsePack(Buffer.concat([zero, Buffer.alloc(4)])).error)

  const badHead = Buffer.alloc(HEAD_BYTES)
  badHead.write(MAGIC, 0, 'latin1')
  const bad = Buffer.from('{not json', 'utf8')
  badHead.writeUInt32LE(bad.length, MAGIC.length)
  assert.ok(parsePack(Buffer.concat([badHead, bad, Buffer.alloc(4)])).error)
})

test('parsePack 拒绝 kind 不符（不是小鲸鱼素材包）', () => {
  const json = Buffer.from(JSON.stringify({ kind: 'something-else', skins: [] }), 'utf8')
  const head = Buffer.alloc(HEAD_BYTES)
  head.write(MAGIC, 0, 'latin1')
  head.writeUInt32LE(json.length, MAGIC.length)
  assert.ok(parsePack(Buffer.concat([head, json, Buffer.from('xx')])).error)
})

test('parsePack 拒绝清单项越界（off/len 超数据区、负数、零长）', () => {
  const data = Buffer.from('0123456789') // dataLen = 10
  const cases = [
    { off: 0, len: 11 },   // 超出数据区
    { off: 5, len: 6 },    // 起点合法但末尾越界
    { off: -1, len: 2 },   // 负偏移
    { off: 0, len: 0 },    // 零长度
    { off: 0 },            // 缺 len
    null,                  // 空项
  ]
  for (const c of cases) {
    assert.ok(parsePack(makePack([c], data)).error, '应拒绝清单项：' + JSON.stringify(c))
  }
  // 合法项（off 0 len 10 正好铺满数据区）不报错
  const ok = parsePack(makePack([{ name: 'a.png', ext: 'png', off: 0, len: 10 }], data))
  assert.equal(ok.error, undefined)
})

// ── 候选链（sourceChain）────────────────────────────────────────────────
// 顺序约定：用户自填（可选） → 内置默认前缀（ghfast.top） → 真源直连（github.com）
//   → raw 直连 → raw 走默认前缀 → raw 走用户自填。
// raw 指向 main 分支（与 Release 走不同 CDN 路由），且 raw 本身也能被加速前缀包装。

test('sourceChain：无自填时是「默认前缀 → 真源 → raw 直连 → raw 走默认前缀」四条，末尾必是 raw 相关', () => {
  const chain = sourceChain('', SHARED_SKIN_PACK_ORIGIN, SHARED_SKIN_PACK_RAW_MAIN)
  assert.deepEqual(chain, [
    SHARED_PACK_DEFAULT_PREFIX + SHARED_SKIN_PACK_ORIGIN,
    SHARED_SKIN_PACK_ORIGIN,
    SHARED_SKIN_PACK_RAW_MAIN,
    SHARED_PACK_DEFAULT_PREFIX + SHARED_SKIN_PACK_RAW_MAIN,
  ])
  assert.equal(chain[chain.length - 1], SHARED_PACK_DEFAULT_PREFIX + SHARED_SKIN_PACK_RAW_MAIN, '末位应是 raw 走默认加速，保证 raw 也被代理覆盖')
})

test('sourceChain：自填前缀排在最前，真源与 raw 各有一条被它包装的候选', () => {
  const chain = sourceChain('https://my-proxy.example/', SHARED_SOUND_PACK_ORIGIN, SHARED_SOUND_PACK_RAW_MAIN)
  assert.equal(chain[0], 'https://my-proxy.example/' + SHARED_SOUND_PACK_ORIGIN)
  assert.deepEqual(chain.slice(1), [
    SHARED_PACK_DEFAULT_PREFIX + SHARED_SOUND_PACK_ORIGIN,
    SHARED_SOUND_PACK_ORIGIN,
    SHARED_SOUND_PACK_RAW_MAIN,
    SHARED_PACK_DEFAULT_PREFIX + SHARED_SOUND_PACK_RAW_MAIN,
    'https://my-proxy.example/' + SHARED_SOUND_PACK_RAW_MAIN,
  ])
})

test('sourceChain：自填与内置前缀相同时去重（不重复打同一个源）', () => {
  const chain = sourceChain(SHARED_PACK_DEFAULT_PREFIX, SHARED_SKIN_PACK_ORIGIN, SHARED_SKIN_PACK_RAW_MAIN)
  assert.deepEqual(chain, [
    SHARED_PACK_DEFAULT_PREFIX + SHARED_SKIN_PACK_ORIGIN,
    SHARED_SKIN_PACK_ORIGIN,
    SHARED_SKIN_PACK_RAW_MAIN,
    SHARED_PACK_DEFAULT_PREFIX + SHARED_SKIN_PACK_RAW_MAIN,
  ])
})

test('sourceChain：空白 / 非字符串的自填被忽略，仍回落到内置链', () => {
  const expect = [
    SHARED_PACK_DEFAULT_PREFIX + SHARED_SKIN_PACK_ORIGIN,
    SHARED_SKIN_PACK_ORIGIN,
    SHARED_SKIN_PACK_RAW_MAIN,
    SHARED_PACK_DEFAULT_PREFIX + SHARED_SKIN_PACK_RAW_MAIN,
  ]
  for (const bad of ['   ', undefined, null]) {
    assert.deepEqual(sourceChain(bad, SHARED_SKIN_PACK_ORIGIN, SHARED_SKIN_PACK_RAW_MAIN), expect)
  }
})

test('sourceChain：raw 兜底缺失（未配置）时不产生空洞项', () => {
  const chain = sourceChain('', SHARED_SKIN_PACK_ORIGIN, '')
  assert.deepEqual(chain, [SHARED_PACK_DEFAULT_PREFIX + SHARED_SKIN_PACK_ORIGIN, SHARED_SKIN_PACK_ORIGIN])
})

// ── 清单（listSharedSkins / listSharedSounds）：与包是否在仓库无关 ────────
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

// ── 重复下载：已装的必须跳过、不重写（回归：曾漏查已装判断）─────────────
// 造一个含单段音效的合法包，先用「已装该音效」的桩跑一次，断言它被归入 skipped、
// 且没有走 installBuiltin 重写。不依赖真实大件产物，CI 也跑。

test('downloadSharedSounds：已装的同名音效被跳过、不重写', async () => {
  const { createHash } = await import('node:crypto')
  const first = SHARED_SOUND_LIB[0]
  // 先用真实 sounds 链路把它装进 shared 槽位（落在本测试的临时 userData 里）
  const seed = sounds.installBuiltin(first.name, first.ext, Buffer.alloc(first.size, 7))
  assert.ok(seed && seed.ok, '预置已装音效失败：' + ((seed && seed.error) || ''))
  const before = sounds.readMeta().shared.find((x) => x.name === first.name)

  // 造一个含该段音效的合法包再下一次：字节与原包不同，若仍重写则 file / at 会变化
  const data = Buffer.alloc(first.size, 9)
  const buf = makePack([{ id: first.id, name: first.name, ext: first.ext, off: 0, len: data.length }], data)
  const r = await downloadSharedSounds({
    // 合成包体积小、不可能等于真实整包 sha，用 wantSha 放宽这一道（单测专用）
    wantSha: createHash('sha256').update(buf).digest('hex'),
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => buf }),
  })

  assert.ok(r.skipped.indexOf(first.name) >= 0, '已装音响应进 skipped')
  assert.ok(r.installed.indexOf(first.id) < 0, '已装音响应不进 installed')
  const after = sounds.readMeta().shared.find((x) => x.name === first.name)
  assert.equal(after.file, before.file, '已装音效应保持原文件不动（未重写）')
  assert.equal(after.at, before.at, '已装音效的导入时间不应被刷新')
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

// ── 真实产物（本地跑过 build-assets-pack.py 才执行）──────────────────────

test('真实共享角色包：逐项 sha256 与 constants 记录一致', { skip: !hasSkinPack && '缺少 resources/assets-skins.whaleassets（未跑打包脚本）' }, async () => {
  const { createHash } = await import('node:crypto')
  const buf = fs.readFileSync(SKIN_PACK_PATH)
  const parsed = parsePack(buf)
  assert.equal(parsed.error, undefined)
  for (const it of parsed.manifest.items) {
    const meta = SHARED_SKIN_PACK_SKINS.find((s) => s.id === it.id)
    assert.ok(meta, '素材包里有 constants 未收录的 id：' + it.id)
    assert.equal(Number(it.len), meta.size, meta.id)
    const data = buf.slice(parsed.dataStart + Number(it.off), parsed.dataStart + Number(it.off) + Number(it.len))
    assert.equal(createHash('sha256').update(data).digest('hex'), meta.sha256, meta.id)
  }
})

test('真实共享角色包：整体 sha256 与 constants 的 SHARED_SKIN_PACK_SHA256 一致', { skip: !hasSkinPack && '缺少 resources/assets-skins.whaleassets' }, async () => {
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(fs.readFileSync(SKIN_PACK_PATH)).digest('hex')
  assert.equal(digest, SHARED_SKIN_PACK_SHA256)
})

test('真实共享音效包：逐项 sha256 与 constants 记录一致', { skip: !hasSoundPack && '缺少 resources/assets-sounds.whaleassets（未跑打包脚本）' }, async () => {
  const { createHash } = await import('node:crypto')
  const buf = fs.readFileSync(SOUND_PACK_PATH)
  const parsed = parsePack(buf)
  assert.equal(parsed.error, undefined)
  for (const it of parsed.manifest.items) {
    const meta = SHARED_SOUND_LIB.find((s) => s.id === it.id)
    assert.ok(meta, '素材包里有 constants 未收录的 id：' + it.id)
    assert.equal(Number(it.len), meta.size, meta.id)
    const data = buf.slice(parsed.dataStart + Number(it.off), parsed.dataStart + Number(it.off) + Number(it.len))
    assert.equal(createHash('sha256').update(data).digest('hex'), meta.sha256, meta.id)
  }
})

test('真实共享音效包：整体 sha256 与 constants 的 SHARED_SOUND_PACK_SHA256 一致', { skip: !hasSoundPack && '缺少 resources/assets-sounds.whaleassets' }, async () => {
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(fs.readFileSync(SOUND_PACK_PATH)).digest('hex')
  assert.equal(digest, SHARED_SOUND_PACK_SHA256)
})

test('manifest.json 的 sha256 / size 与 constants 同步', { skip: !hasManifest && '缺少 resources/manifest.json（未跑打包脚本）' }, () => {
  const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  for (const s of SHARED_SKIN_PACK_SKINS) {
    assert.ok(m.skins?.[s.id], '构建清单缺角色 ' + s.id)
    assert.equal(m.skins[s.id].sha256, s.sha256, s.id)
    assert.equal(m.skins[s.id].size, s.size, s.id)
  }
  for (const s of SHARED_SOUND_LIB) {
    assert.ok(m.sounds?.[s.id], '构建清单缺音效 ' + s.id)
    assert.equal(m.sounds[s.id].sha256, s.sha256, s.id)
    assert.equal(m.sounds[s.id].size, s.size, s.id)
  }
})
