/*
 * assets.js 单测（node --test，零依赖）—— 只测容器层 parsePack 的清单解析。
 *
 * 只聚焦容器字节构造 + parsePack：schema 校验、三类内容（skins / sounds / bubbles）
 * 的原样透出与脏值容错。落库清洗归 store.test.mjs 管。
 *
 * 不测 exportAssets / pickAssets / applyAssets 全流程：它们要 utools.showSaveDialog /
 * showOpenDialog 桩与 skins/sounds/bubbles 真实目录，收益低于成本；容器字节构造 + parsePack
 * 已能钉死清单格式，风险集中在 parsePack 的缺省容错上。
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

test('parsePack：manifest 三类内容原样透出（skins / sounds / bubbles）', () => {
  const skins = [{ id: 'a', name: '甲', off: 0, len: 3 }]
  const sounds = [{ id: 's1', name: '音', off: 3, len: 2 }]
  const bubbles = [{ id: 'b1', name: '泡', off: 5, len: 1 }]
  const data = Buffer.alloc(6)
  const parsed = parsePack(makePack({ ...baseManifest(), skins, sounds, bubbles }, data))
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.manifest.skins, skins)
  assert.deepEqual(parsed.manifest.sounds, sounds)
  assert.deepEqual(parsed.manifest.bubbles, bubbles)
})

test('parsePack：老素材包缺键时三类都缺省空数组（schema 不升版）', () => {
  const parsed = parsePack(makePack({ kind: KIND, schema: 1 }, Buffer.alloc(0)))
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.manifest.skins, [])
  assert.deepEqual(parsed.manifest.sounds, [])
  assert.deepEqual(parsed.manifest.bubbles, [])
})

test('parsePack：脏包（非数组）按缺省空数组处理，不报错不透传脏值', () => {
  const parsed = parsePack(makePack({ ...baseManifest(), skins: '偷渡', sounds: 42, bubbles: {} }, Buffer.alloc(0)))
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.manifest.skins, [])
  assert.deepEqual(parsed.manifest.sounds, [])
  assert.deepEqual(parsed.manifest.bubbles, [])
})
