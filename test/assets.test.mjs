/*
 * assets.js 单测（node --test，零依赖）—— 只测「台词组随包往返」这条第 5 期新增链路。
 *
 * 台词组进素材包是纯 JSON（不占 blob），往返链路是：
 * exportAssets(settings 传入组) → manifest.quotes → parsePack → pickAssets.has.quotes
 * → applyAssets({quotes:true}) 返回 quoteGroups → settings.js patchConfig 落库清洗。
 *
 * 本文件聚焦容器层：组原样进、原样出（含 sound / cond 字段），老包没有 quotes 键时
 * 缺省空数组（schema 不升版，对齐 bubbles 先例）。落库清洗（normQuotes）归 store.test.mjs 管。
 *
 * 不测 exportAssets / pickAssets / applyAssets 全流程：它们要 utools.showSaveDialog /
 * showOpenDialog 桩与 skins/sounds/bubbles 真实目录，收益低于成本；容器字节构造 + parsePack
 * 已能钉死清单格式，applyAssets 的 quotes 分支用 pending 无法从外部注入（模块私有），
 * 返回值拼装逻辑简单（spread 三元），风险集中在 parsePack 的缺省容错上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assets = require('../public/preload/lib/assets.js')

const parsePack = assets._parsePack
const MAGIC = 'WHALEASSET1'
const KIND = 'balance-whale-widget-assets'
const HEAD_BYTES = MAGIC.length + 4

// 造一个最小合法容器：[魔数][清单长度][清单][数据]
function makePack(manifest, data) {
  const json = Buffer.from(JSON.stringify(manifest), 'utf8')
  const head = Buffer.alloc(HEAD_BYTES)
  head.write(MAGIC, 0, 'latin1')
  head.writeUInt32LE(json.length, MAGIC.length)
  return Buffer.concat([head, json, data])
}

function baseManifest() {
  return { kind: KIND, schema: 1, skins: [], sounds: [], bubbles: [] }
}

test('parsePack：manifest.quotes 原样透出（含组级 sound 与行条件 cond）', () => {
  const groups = [
    { kind: 'card', w: 3, sound: '来财' },
    { kind: 'text', w: 5, rows: [{ segs: [{ type: 'text', t: '余额见底', fz: 11 }], cond: { type: 'balanceBelow', value: 10 } }] },
  ]
  const parsed = parsePack(makePack({ ...baseManifest(), quotes: groups }, Buffer.alloc(0)))
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.manifest.quotes, groups)
})

test('parsePack：老素材包没有 quotes 键时缺省空数组（schema 不升版，对齐 bubbles 先例）', () => {
  const parsed = parsePack(makePack(baseManifest(), Buffer.alloc(0)))
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.manifest.quotes, [])
})

test('parsePack：quotes 非数组（脏包）按缺省空数组处理，不报错不透传脏值', () => {
  const parsed = parsePack(makePack({ ...baseManifest(), quotes: '偷渡' }, Buffer.alloc(0)))
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.manifest.quotes, [])
})

test('parsePack：quotes 不占 blob、不做越界校验——组旁没有文件字节也合法', () => {
  // 数据区为空但 quotes 非空：与 skins 项不同（off/len 必须落在数据区），quotes 是纯 JSON
  const parsed = parsePack(makePack({ ...baseManifest(), quotes: [{ kind: 'image', w: 1 }] }, Buffer.alloc(0)))
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.manifest.quotes.length, 1)
})
