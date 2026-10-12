/*
 * assets.js 全流程单测（node --test，零依赖）—— 导出 / 选择解析 / 导入写入。
 *
 * 与 assets.test.mjs 分工：那个只钉容器层 parsePack 的清单解析（纯函数，无桩）；
 * 这里钉 exportAssets → pickAssets → applyAssets 这条真实链路：
 *   - 导出要拿三个资源模块（skins / sounds / bubbles）的字节平铺进自造容器；
 *   - 选择要读回文件、解析出预览，且**不写任何数据**；
 *   - 导入要按勾选项切片写回，只写勾选的类别、补充语义不动已有项、失败项去重报错。
 *
 * 桩：utools.{getPath, dbStorage, showSaveDialog, showOpenDialog}。
 * 三个资源模块的落盘目录都随 getPath('userData') 走（各自再拼 whale-skins / whale-sounds /
 * whale-bubbles），所以只要把 userData 指到临时目录，整条链路就走真实文件系统、
 * 不碰真实用户数据。showSaveDialog / showOpenDialog 用可编程的桩控制「保存到哪 / 选哪个文件 / 取消」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

// ── utools 桩 ──
// savePath / openPath 是「对话框返回什么」的可控开关；null 代表用户点了取消。
let savePath = null
let openPath = null
const store = new Map()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-assets-flow-'))
globalThis.utools = {
  getPath: () => TMP,
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  },
  showSaveDialog: () => savePath,
  showOpenDialog: () => (openPath ? [openPath] : null),
}

const require = createRequire(import.meta.url)
const assets = require('../public/preload/lib/assets.js')
const skins = require('../public/preload/lib/skins.js')
const sounds = require('../public/preload/lib/sounds.js')
const bubbles = require('../public/preload/lib/bubbles.js')

const MAGIC = 'WHALEASSET1'
const KIND = 'balance-whale-widget-assets'
const HEAD_BYTES = MAGIC.length + 4
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-assets-out-'))

// 造一张最小合法 PNG 字节（内容无关，只要非空、格式在 skins 白名单里）
const pngBytes = (n) => Buffer.alloc(n, 0x89)
// 造一段最小合法 mp3 字节
const mp3Bytes = (n) => Buffer.alloc(n, 0x11)

function resetAll() {
  skins.clearAll()
  sounds.clearAll()
  bubbles.clearAll()
  assets.clearPending()
  store.clear()
  savePath = null
  openPath = null
}
const outFile = (name) => path.join(outDir, name)

// ──────────────────────────────────────────────
// 导出：无素材拒绝；有素材写出可解析容器
// ──────────────────────────────────────────────
test('exportAssets：一个素材都没有时直接拒绝，不弹保存框', () => {
  resetAll()
  const r = assets.exportAssets()
  assert.equal(r.ok, false)
  assert.match(r.error, /还没有可导出的素材/)
})

test('exportAssets：用户取消保存框 → canceled，不写文件', () => {
  resetAll()
  assert.ok(skins.importBuffer('甲.png', 'png', pngBytes(10), null, 0).ok)
  savePath = null // 取消
  const r = assets.exportAssets()
  assert.equal(r.ok, false)
  assert.equal(r.canceled, true)
  assert.equal(r.error, '')
})

test('exportAssets：把三类素材打成可解析容器，字节按偏移对得上', () => {
  resetAll()
  assert.ok(skins.importBuffer('甲.png', 'png', pngBytes(10), null, 0).ok)
  assert.ok(sounds.importBuffer('press', 'p.mp3', 'mp3', mp3Bytes(6), 0).ok)
  assert.ok(bubbles.importBuffer('泡.png', 'png', pngBytes(4), null, 0).ok)
  savePath = outFile('pack1.whaleassets')

  const r = assets.exportAssets()
  assert.equal(r.ok, true, r.error)
  assert.equal(r.skins, 1)
  assert.equal(r.sounds, 1)
  assert.equal(r.bubbles, 1)
  assert.ok(fs.existsSync(savePath))

  // 用 _parsePack（纯函数）复核写出的容器结构，并确认切片字节与源一致
  const buf = fs.readFileSync(savePath)
  const parsed = assets._parsePack(buf)
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.manifest.skins[0].ext, 'png')
  assert.equal(parsed.manifest.sounds[0].role, 'press')
  const sk = parsed.manifest.skins[0]
  const got = buf.slice(parsed.dataStart + sk.off, parsed.dataStart + sk.off + sk.len)
  assert.equal(got.length, 10)
  assert.deepEqual([...got], [...pngBytes(10)])
})

test('exportAssets：容器魔数与清单头就位（kind / schema / 长度字段）', () => {
  resetAll()
  assert.ok(sounds.importBuffer('low', 'x.mp3', 'mp3', mp3Bytes(3), 0).ok)
  savePath = outFile('pack2.whaleassets')
  assert.ok(assets.exportAssets().ok)

  const buf = fs.readFileSync(savePath)
  assert.equal(buf.slice(0, MAGIC.length).toString('latin1'), MAGIC)
  const jsonLen = buf.readUInt32LE(MAGIC.length)
  const manifest = JSON.parse(buf.slice(HEAD_BYTES, HEAD_BYTES + jsonLen).toString('utf8'))
  assert.equal(manifest.kind, KIND)
  assert.equal(manifest.schema, 1)
  assert.ok(manifest.exportedAt)
})

// ──────────────────────────────────────────────
// 选择解析：读回文件、出预览，且不写任何数据
// ──────────────────────────────────────────────
test('pickAssets：取消选择 → canceled', () => {
  resetAll()
  openPath = null
  const r = assets.pickAssets()
  assert.equal(r.ok, false)
  assert.equal(r.canceled, true)
})

test('pickAssets：文件不存在（读失败）→ 报读取失败', () => {
  resetAll()
  openPath = path.join(outDir, '不存在.whaleassets')
  const r = assets.pickAssets()
  assert.equal(r.ok, false)
  assert.match(r.error, /读取素材包失败/)
})

test('pickAssets：给出预览（各类数量 + 名字），此时尚未写任何数据', () => {
  resetAll()
  assert.ok(skins.importBuffer('甲.png', 'png', pngBytes(10), null, 0).ok)
  assert.ok(sounds.importBuffer('press', 'p.mp3', 'mp3', mp3Bytes(6), 0).ok)
  savePath = outFile('pick.whaleassets')
  assert.ok(assets.exportAssets().ok)

  // 清空现有素材，模拟「换机器导入」——选择阶段不该把它们写回来
  skins.clearAll()
  sounds.clearAll()
  openPath = savePath
  const r = assets.pickAssets()
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.has, { skins: 1, sounds: 1, bubbles: 0 })
  assert.deepEqual(r.skinNames, ['甲.png'])
  assert.deepEqual(r.soundRoles, ['press'])
  // 预览阶段不落库
  assert.equal(skins.listSkins().items.length, 0)
  assert.equal(sounds.readMeta().press.length, 0)
})

test('pickAssets：坏包（魔数不对）→ 解析报错，不进入待写状态', () => {
  resetAll()
  openPath = outFile('bad.whaleassets')
  fs.writeFileSync(openPath, Buffer.concat([Buffer.from('NOTWHALE!!!'), Buffer.alloc(8)]))
  const r = assets.pickAssets()
  assert.equal(r.ok, false)
  assert.match(r.error, /不是小鲸鱼素材包/)
  // 没 pending → applyAssets 拒绝
  assert.equal(assets.applyAssets({ skins: true }).ok, false)
})

// ──────────────────────────────────────────────
// 导入写入：按勾选项切片写回
// ──────────────────────────────────────────────
test('applyAssets：没先选包 → 拒绝', () => {
  resetAll()
  const r = assets.applyAssets({ skins: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /请先选择素材包/)
})

test('applyAssets：三类全勾 → 全部写回（补充语义，不动已有项）', () => {
  resetAll()
  // 先造一份包
  assert.ok(skins.importBuffer('甲.png', 'png', pngBytes(10), null, 0).ok)
  assert.ok(sounds.importBuffer('press', 'p.mp3', 'mp3', mp3Bytes(6), 0).ok)
  assert.ok(bubbles.importBuffer('泡.png', 'png', pngBytes(4), null, 0).ok)
  savePath = outFile('all.whaleassets')
  assert.ok(assets.exportAssets().ok)
  skins.clearAll(); sounds.clearAll(); bubbles.clearAll()

  openPath = savePath
  assert.ok(assets.pickAssets().ok)
  const r = assets.applyAssets({ skins: true, sounds: true, bubbles: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.skins.added, 1)
  assert.equal(r.sounds.applied, 1)
  assert.equal(r.bubbles.added, 1)
  assert.equal(skins.listSkins().items.length, 1)
  assert.equal(sounds.readMeta().press.length, 1)
  assert.equal(bubbles.listBubbles().items.length, 1)
  // 导入成功即清 pending（同一包不能反复套用）
  assert.equal(assets.applyAssets({ skins: true }).ok, false)
})

test('applyAssets：只勾 sounds → 只写音效，形象/气泡图不动', () => {
  resetAll()
  assert.ok(skins.importBuffer('甲.png', 'png', pngBytes(10), null, 0).ok)
  assert.ok(sounds.importBuffer('press', 'p.mp3', 'mp3', mp3Bytes(6), 0).ok)
  savePath = outFile('only-sound.whaleassets')
  assert.ok(assets.exportAssets().ok)
  skins.clearAll(); sounds.clearAll()

  openPath = savePath
  assert.ok(assets.pickAssets().ok)
  const r = assets.applyAssets({ sounds: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.skins.added, 0)
  assert.equal(r.sounds.applied, 1)
  assert.equal(skins.listSkins().items.length, 0, '没勾形象就不该写')
  assert.equal(sounds.readMeta().press.length, 1)
})

test('applyAssets：一个都不勾 → ok=false（无写入），pending 保留可再试', () => {
  resetAll()
  assert.ok(sounds.importBuffer('press', 'p.mp3', 'mp3', mp3Bytes(6), 0).ok)
  savePath = outFile('none.whaleassets')
  assert.ok(assets.exportAssets().ok)
  sounds.clearAll()

  openPath = savePath
  assert.ok(assets.pickAssets().ok)
  const r = assets.applyAssets({})
  assert.equal(r.ok, false)
  assert.equal(sounds.readMeta().press.length, 0)
  // 没写入就不清 pending：用户改主意勾上再导仍然有效
  const r2 = assets.applyAssets({ sounds: true })
  assert.equal(r2.ok, true)
  assert.equal(sounds.readMeta().press.length, 1)
})

test('applyAssets：坏包切片（off/len 越界）→ parsePack 挡下，不崩溃', () => {
  resetAll()
  // 造一个 sounds 项 off/len 指向数据区之外的容器：parsePack 的 bad() 应拒（越界）
  const packNoData = { kind: KIND, schema: 1, sounds: [{ role: 'press', name: 'p.mp3', ext: 'mp3', at: 0, off: 0, len: 5 }], skins: [], bubbles: [], exportedAt: '', appVersion: '' }
  const json2 = Buffer.from(JSON.stringify(packNoData), 'utf8')
  const head2 = Buffer.alloc(HEAD_BYTES)
  head2.write(MAGIC, 0, 'latin1')
  head2.writeUInt32LE(json2.length, MAGIC.length)
  // 故意少给数据：len=5 但数据区为 0 → off+len > dataLen，parsePack 拒绝
  openPath = outFile('badslice.whaleassets')
  fs.writeFileSync(openPath, Buffer.concat([head2, json2, Buffer.alloc(0)]))
  const picked = assets.pickAssets()
  assert.equal(picked.ok, false, '越界清单应被 parsePack 挡下')
  assert.match(picked.error, /越界|损坏/)
})

test('clearPending：清掉待写包后再 apply 被拒绝', () => {
  resetAll()
  assert.ok(sounds.importBuffer('press', 'p.mp3', 'mp3', mp3Bytes(6), 0).ok)
  savePath = outFile('clr.whaleassets')
  assert.ok(assets.exportAssets().ok)
  openPath = savePath
  assert.ok(assets.pickAssets().ok)
  assert.deepEqual(assets.clearPending(), { ok: true })
  assert.equal(assets.applyAssets({ sounds: true }).ok, false)
})

test('applyAssets：失败项错误去重（同一类失败只提示一次）', () => {
  resetAll()
  // 造两个不合法 ext 的 sound 项（ext 不在白名单）→ importBuffer 两次都失败且错误文案相同
  const manifest = {
    kind: KIND, schema: 1, exportedAt: '', appVersion: '',
    skins: [], bubbles: [],
    sounds: [
      { role: 'press', name: 'a.xyz', ext: 'xyz', at: 0, off: 0, len: 2 },
      { role: 'low', name: 'b.xyz', ext: 'xyz', at: 0, off: 2, len: 2 },
    ],
  }
  const json = Buffer.from(JSON.stringify(manifest), 'utf8')
  const head = Buffer.alloc(HEAD_BYTES)
  head.write(MAGIC, 0, 'latin1')
  head.writeUInt32LE(json.length, MAGIC.length)
  openPath = outFile('dup-err.whaleassets')
  fs.writeFileSync(openPath, Buffer.concat([head, json, Buffer.alloc(4)]))
  assert.ok(assets.pickAssets().ok)
  const r = assets.applyAssets({ sounds: true })
  assert.equal(r.ok, false)
  assert.equal(r.errors.length, 1, '同一类失败去重后只留一条')
  // 但两条都试过了（applied 计成功数，这里是 0）
  assert.equal(r.sounds.applied, 0)
})
