/*
 * skins.js 的 importBuffer 单测（node --test，零依赖）。
 *
 * 为什么只测 importBuffer：素材包（.whaleassets）导入走的就是这一条 —— 它一次往里灌 12 张，
 * 而 addItem 的默认行为是「新增即切当前形象」。漏掉 keepCurrent 的后果是**静默的**：
 * 用户点了「导入素材包」，正用着的自定义形象被悄悄换成包里最后一张，挂件外观突然变了却没人提示。
 * 下载链路（installBuiltin）一直带 keepCurrent，两条路必须一致，这个测试把口径钉住。
 *
 * 另外覆盖 id / builtin 透传：素材包自带内置身份，importBuffer 不认它就会把这 12 张算成
 * 「用户自建」（占配额、builtinIds 认不出来 → 可被重复下载）。
 *
 * 环境：skins.js 依赖 utools.dbStorage 与 utools.getPath('userData')，这里用内存 dbStorage +
 * 指向临时目录的 getPath 桩顶掉，落的是临时目录下的 whale-skins/，不碰真实用户数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

// ── utools 桩：内存 dbStorage + userData 指向本次测试的临时目录 ──
const store = new Map()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-skins-test-'))
globalThis.utools = {
  getPath: () => TMP, // skinsDir() = <TMP>/whale-skins
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  },
}

const require = createRequire(import.meta.url)
const skins = require('../public/preload/lib/skins.js')
const { K } = require('../public/preload/lib/constants.js')

const { importBuffer, listSkins, builtinIds } = skins

// 一张最小合法 PNG 头（内容不重要，importBuffer 只校验扩展名与字节数）
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function reset() {
  store.delete(K.skins)
  fs.rmSync(path.join(TMP, 'whale-skins'), { recursive: true, force: true })
}

test('importBuffer 连续导入多张时不改动「当前形象」（导入是补充不是替换）', () => {
  reset()
  // 先有一张用户自己的形象，并被设为当前
  const first = importBuffer('mine.webp', 'webp', PNG, null)
  assert.equal(first.ok, true)
  assert.equal(listSkins().current, first.id)

  // 再导入素材包里的一批（模拟一次进好几张）
  const a = importBuffer('DSniang2.webp', 'webp', PNG, null, 0, 'DSniang2', true)
  const b = importBuffer('DSniang3.webp', 'webp', PNG, null, 0, 'DSniang3', true)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  // 关键断言：当前形象仍是第一张，没被后导入的顶掉
  assert.equal(listSkins().current, first.id)
})

test('importBuffer 在画廊原本为空时仍会落到第一项（无须特判 keepCurrent）', () => {
  reset()
  const a = importBuffer('DSniang2.webp', 'webp', PNG, null, 0, 'DSniang2', true)
  assert.equal(a.ok, true)
  // addItem 里 keepCurrent 只跳过 raw.current = id；空画廊时 readRaw 的兜底会把 current 指到首项
  assert.equal(listSkins().current, 'DSniang2')
})

test('importBuffer 透传 id 与 builtin：内置图带固定 id、被 builtinIds 认出、不占自建配额', () => {
  reset()
  importBuffer('DSniang2.webp', 'webp', PNG, null, 0, 'DSniang2', true)
  importBuffer('DSniang3.webp', 'webp', PNG, null, 0, 'DSniang3', true)
  // builtin 身份传下去 → builtinIds 才认得出来（设置页据此标「已下载」、避免重复下载）
  assert.deepEqual(builtinIds().sort(), ['DSniang2', 'DSniang3'])
  const items = listSkins().items
  assert.equal(items.filter((x) => x.id === 'DSniang2')[0].builtin, true)
  // 固定 id：重复导入同一个 id 不会新增一项（走 addItem 的 exist 复用分支）
  const again = importBuffer('DSniang2.webp', 'webp', PNG, null, 0, 'DSniang2', true)
  assert.equal(again.ok, true)
  assert.equal(again.existed, true)
  assert.equal(listSkins().items.length, 2)
})

test('importBuffer 拒绝不支持的格式与空数据', () => {
  reset()
  assert.equal(importBuffer('x.svg', 'svg', PNG, null).ok, false)
  assert.equal(importBuffer('x.png', 'png', Buffer.alloc(0), null).ok, false)
})

// ── 「参与随机」开关（setRandom）──────────────────────────────────────────
// 语义约定：random 字段缺失 = 参与（默认），只有显式关掉才存 false。
// 这样升级后老记录不会因为字段缺失而突然全部退出随机池（用户会以为随机坏了）。

test('setRandom：新装项默认参与随机（random 字段缺失即 true）', () => {
  reset()
  const a = importBuffer('mine.webp', 'webp', PNG, null)
  const item = listSkins().items.filter((x) => x.id === a.id)[0]
  assert.equal(item.random, true, '未设置过时应视为参与随机')
})

test('setRandom：关掉后存 false，listSkins 如实回报', () => {
  reset()
  const a = importBuffer('mine.webp', 'webp', PNG, null)
  const r = skins.setRandom(a.id, false)
  assert.equal(r.ok, true)
  assert.equal(r.random, false)
  assert.equal(listSkins().items.filter((x) => x.id === a.id)[0].random, false)
})

test('setRandom：重新打开时删掉字段（缺省即参与，存储保持精简）', () => {
  reset()
  const a = importBuffer('mine.webp', 'webp', PNG, null)
  skins.setRandom(a.id, false)
  // 直接从存储里看：关掉时应有 random:false
  assert.equal(store.get(K.skins).items[0].random, false)
  skins.setRandom(a.id, true)
  assert.equal('random' in store.get(K.skins).items[0], false, '打开时应把字段删掉而非存 true')
  assert.equal(listSkins().items.filter((x) => x.id === a.id)[0].random, true)
})

test('setRandom：改开关不影响「当前形象」，也不动其它项', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const curBefore = listSkins().current
  skins.setRandom(a.id, false)
  assert.equal(listSkins().current, curBefore, '改开关不该换掉当前使用的形象')
  assert.equal(listSkins().items.filter((x) => x.id === b.id)[0].random, true, '不该波及别的项')
})

test('setRandom：id 不存在时返回失败而非静默成功', () => {
  reset()
  importBuffer('mine.webp', 'webp', PNG, null)
  const r = skins.setRandom('no-such-id', false)
  assert.equal(r.ok, false)
  assert.match(r.error, /不存在/)
})

// ── 官方图显示名（installBuiltin 的 displayName）─────────────────────────
// 共享角色下载回来时带中文原名，画廊里应显示它而不是 id 短哈希（s34330e4aba 这种没人看得懂）。

test('installBuiltin：带 displayName 时画廊显示中文原名而非 id', () => {
  reset()
  const r = skins.installBuiltin('s34330e4aba', 'png', PNG, null, '神里绫华')
  assert.equal(r.ok, true)
  const item = listSkins().items.filter((x) => x.id === 's34330e4aba')[0]
  assert.equal(item.name, '神里绫华')
  assert.equal(item.builtin, true)
})

test('installBuiltin：不带 displayName 时回落到 id（内置包行为不变）', () => {
  reset()
  skins.installBuiltin('DSniang02', 'webp', PNG, null)
  assert.equal(listSkins().items.filter((x) => x.id === 'DSniang02')[0].name, 'DSniang02')
})

test('installBuiltin：重复下载同一 id 时把旧记录的 id 名补正为中文原名', () => {
  reset()
  // 模拟旧版本下载的项：只有 id 当名字，没有中文名
  skins.installBuiltin('s34330e4aba', 'png', PNG, null)
  assert.equal(listSkins().items[0].name, 's34330e4aba')
  // 新版重新下载同一张 → 名字被补正（不需要用户先删掉再下）
  skins.installBuiltin('s34330e4aba', 'png', PNG, null, '神里绫华')
  assert.equal(listSkins().items.filter((x) => x.id === 's34330e4aba')[0].name, '神里绫华')
  assert.equal(listSkins().items.length, 1, '补正不新增一项')
})

test('installBuiltin：重复下载不改动「当前形象」（仍在用自己那张）', () => {
  reset()
  const mine = importBuffer('mine.webp', 'webp', PNG, null)
  skins.installBuiltin('s34330e4aba', 'png', PNG, null, '神里绫华')
  assert.equal(listSkins().current, mine.id)
})

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })
