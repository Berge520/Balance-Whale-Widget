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

// ── 「参与随机」开关（setRandomBatch）──────────────────────────────────
// 语义约定：random 字段缺失 = 参与（默认），只有显式关掉才存 false。
// 这样升级后老记录不会因为字段缺失而突然全部退出随机池（用户会以为随机坏了）。

test('参与随机：新装项默认参与（random 字段缺失即 true）', () => {
  reset()
  const a = importBuffer('mine.webp', 'webp', PNG, null)
  const item = listSkins().items.filter((x) => x.id === a.id)[0]
  assert.equal(item.random, true, '未设置过时应视为参与随机')
})

// ── 批量改「参与随机」（setRandomBatch）──────────────────────────────────
// 存在的意义：整张清单只读改写盘一次。逐张改会做 N 次 readRaw+writeRaw。

test('setRandomBatch：按 map 逐项设置，未知 id 静默跳过', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const c = importBuffer('c.webp', 'webp', PNG, null)
  const r = skins.setRandomBatch({ [a.id]: false, [b.id]: true, 'no-such-id': false })
  assert.equal(r.ok, true)
  assert.equal(r.changed, 2, '只统计清单里真实存在的项')
  const byId = {}
  for (const it of listSkins().items) byId[it.id] = it.random
  assert.equal(byId[a.id], false)
  assert.equal(byId[b.id], true)
  assert.equal(byId[c.id], true, '未出现在 map 里的项不动')
})

test('setRandomBatch：一次写盘（不会逐项落盘 N 次）', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  let writes = 0
  const rawSet = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = (k, v) => { if (k === K.skins) writes++; return rawSet(k, v) }
  try {
    skins.setRandomBatch({ [a.id]: false, [b.id]: false })
  } finally {
    globalThis.utools.dbStorage.setItem = rawSet
  }
  assert.equal(writes, 1, '批量只应触发一次存储写入')
})

test('setRandomBatch：空 map / 非布尔值都不落盘', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  assert.equal(skins.setRandomBatch({}).changed, 0)
  const r = skins.setRandomBatch({ [a.id]: 'yes' })
  assert.equal(r.changed, 0)
  assert.equal(listSkins().items[0].random, true, '非布尔值被跳过，不改存储')
})

// ── 画廊排序（moveSkin）──────────────────────────────────────────────────
// 取代旧的 pinSkin：旧接口只能置顶、再点无反馈。moveSkin 支持 top / up / down。

test('moveSkin：top 把指定项移到最前，其它项相对顺序不变', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const c = importBuffer('c.webp', 'webp', PNG, null)
  // 依次导入 → unshift → 顺序 [c, b, a]
  assert.deepEqual(listSkins().items.map((x) => x.id), [c.id, b.id, a.id])
  const r = skins.moveSkin(a.id, 'top')
  assert.equal(r.ok, true)
  assert.equal(r.moved, true)
  assert.deepEqual(listSkins().items.map((x) => x.id), [a.id, c.id, b.id])
})

test('moveSkin：up / down 上下挪一格', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const c = importBuffer('c.webp', 'webp', PNG, null)
  // 初始 [c, b, a]
  skins.moveSkin(a.id, 'up')                    // a 上移一格 → [c, a, b]
  assert.deepEqual(listSkins().items.map((x) => x.id), [c.id, a.id, b.id])
  skins.moveSkin(a.id, 'down')                  // a 下移一格 → [c, b, a]
  assert.deepEqual(listSkins().items.map((x) => x.id), [c.id, b.id, a.id])
})

test('moveSkin：已在边界时 moved=false 且不回错、不动顺序', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  // 新导入的项 unshift 到最前，所以此刻顺序是 [b, a]：b 已在最前、a 已在最后
  assert.deepEqual(listSkins().items.map((x) => x.id), [b.id, a.id])
  const top = skins.moveSkin(b.id, 'up')
  assert.equal(top.ok, true, '已是最前不该当错误')
  assert.equal(top.moved, false)
  const bottom = skins.moveSkin(a.id, 'down')
  assert.equal(bottom.moved, false)
  assert.deepEqual(listSkins().items.map((x) => x.id), [b.id, a.id], '边界操作不改顺序')
})

test('moveSkin：id 不存在时返回失败', () => {
  reset()
  importBuffer('a.webp', 'webp', PNG, null)
  const r = skins.moveSkin('no-such-id', 'top')
  assert.equal(r.ok, false)
  assert.match(r.error, /不存在/)
})

// ── 拖拽落点（moveSkin 'to' + index）──────────────────────────────────────
// 设置页拖拽排序时把「插到第几个位置」算好传进来，宿主只负责搬运。

test("moveSkin：to 把指定项搬到目标下标，其它项相对顺序不变", () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const c = importBuffer('c.webp', 'webp', PNG, null)
  // 初始 [c, b, a]
  const r = skins.moveSkin(a.id, 'to', 1)       // a 搬到下标 1 → [c, a, b]
  assert.equal(r.ok, true)
  assert.equal(r.moved, true)
  assert.equal(r.index, 1)
  assert.deepEqual(listSkins().items.map((x) => x.id), [c.id, a.id, b.id])
  const r2 = skins.moveSkin(c.id, 'to', 2)      // c 搬到下标 2 → [a, b, c]
  assert.equal(r2.index, 2)
  assert.deepEqual(listSkins().items.map((x) => x.id), [a.id, b.id, c.id])
})

test("moveSkin：to 落点越界自动夹到合法范围", () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  // 初始 [b, a]
  const tooBig = skins.moveSkin(a.id, 'to', 99) // 夹到末尾 → 已在末尾，moved=false
  assert.equal(tooBig.ok, true)
  assert.equal(tooBig.moved, false, '夹回后即原位，不该真移动')
  const neg = skins.moveSkin(a.id, 'to', -5)    // 夹到 0 → [a, b]
  assert.equal(neg.ok, true)
  assert.equal(neg.moved, true)
  assert.deepEqual(listSkins().items.map((x) => x.id), [a.id, b.id])
})

test("moveSkin：to 与当前下标相同则 moved=false（拖到原位）", () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  // 初始 [b, a]
  const r = skins.moveSkin(b.id, 'to', 0)
  assert.equal(r.ok, true)
  assert.equal(r.moved, false)
  assert.deepEqual(listSkins().items.map((x) => x.id), [b.id, a.id], '原位拖动不改顺序')
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

// ── 缩略图（webp 落盘 / 懒补 setThumb）──────────────────────────────────
// 回归背景：v1.9.x 早先版本下载共享角色时没落缩略图，listSkins 只能回落读原图
// （0.9~2.7MB 一张，8MB 回落预算撑不过 4 张），后面的项全显示「无预览」。
// 现在缩略图由设置页读打包资源 resources/thumbs/<id>.webp 后传下来（宿主定位不到插件目录）。

// 最小合法 WebP 头（RIFF....WEBP），writeThumb 只校验前缀与实际字节数
const WEBP = Buffer.from('524946460000000057454250', 'hex')
function webpUrl() { return 'data:image/webp;base64,' + WEBP.toString('base64') }

test('listSkins：缩略图优先 .thumb.png，缺失时回落到 .thumb.webp（共享角色落的是 webp）', () => {
  reset()
  skins.installBuiltin('s1', 'png', PNG, webpUrl(), '角色一')
  const item = listSkins().items.filter((x) => x.id === 's1')[0]
  assert.match(item.thumb, /^data:image\/webp;base64,/, 'webp 缩略图必须能被读回（老代码只认 .thumb.png）')
})

test('setThumb：已有缩略图时跳过（不重复写盘）', () => {
  reset()
  skins.installBuiltin('s1', 'png', PNG, webpUrl(), '角色一')
  const r = skins.setThumb('s1', webpUrl())
  assert.equal(r.ok, true)
  assert.equal(r.skipped, true)
})

test('setThumb：老数据缺缩略图时补上，listSkins 立刻能读到（不再回落读原图）', () => {
  reset()
  skins.installBuiltin('s1', 'png', PNG, '', '角色一')
  // 没有缩略图文件时 listSkins 会回落读原图（塞进来的是 PNG 原图，体积 = 原图），
  // 这正是「回落」的痕迹 —— 缩略图文件真的不存在，不是设了空串。
  assert.equal(fs.existsSync(path.join(TMP, 'whale-skins', 's1.thumb.png')), false)
  assert.match(listSkins().items[0].thumb, /^data:image\/png;base64,/)
  const r = skins.setThumb('s1', webpUrl())
  assert.equal(r.ok, true)
  assert.equal(r.skipped, undefined)
  assert.equal(fs.existsSync(path.join(TMP, 'whale-skins', 's1.thumb.webp')), true)
  assert.match(listSkins().items[0].thumb, /^data:image\/webp;base64,/, '补上后应走缩略图而不是原图回落')
})

test('setThumb：id 不存在时返回失败而非静默成功', () => {
  reset()
  const r = skins.setThumb('no-such-id', webpUrl())
  assert.equal(r.ok, false)
  assert.match(r.error, /不存在/)
})

test('setThumb：数据不是合法图片 data URL 时返回失败，不写坏文件', () => {
  reset()
  skins.installBuiltin('s1', 'png', PNG, '', '角色一')
  const r = skins.setThumb('s1', 'not-a-data-url')
  assert.equal(r.ok, false)
  assert.equal(fs.existsSync(path.join(TMP, 'whale-skins', 's1.thumb.png')), false)
  assert.equal(fs.existsSync(path.join(TMP, 'whale-skins', 's1.thumb.webp')), false)
})

test('removeSkin：两种格式的缩略图都清掉（png 与 webp 都不留垃圾）', () => {
  reset()
  skins.installBuiltin('s1', 'png', PNG, webpUrl(), '角色一')
  const dir = path.join(TMP, 'whale-skins')
  assert.equal(fs.existsSync(path.join(dir, 's1.thumb.webp')), true)
  skins.removeSkin('s1')
  assert.equal(fs.existsSync(path.join(dir, 's1.thumb.webp')), false)
  assert.equal(fs.existsSync(path.join(dir, 's1.thumb.png')), false)
  assert.equal(fs.existsSync(path.join(dir, 's1.png')), false)
})

// ── 批量搬动（moveSkins）────────────────────────────────────────────────
// 设置页「选中操作 → 置顶」与拖拽落点都走这条：选中几张一起搬到最前 / 某处，
// 被搬的那批要保持原来的相对顺序。逐张调 moveSkin 会写盘 N 次，且先搬走的项会让后面
// 算好的落点整体偏移一格，所以批量必须是一趟完成的独立接口。

test('moveSkins：多张一起搬到最前，保持它们在原列表里的相对顺序', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const c = importBuffer('c.webp', 'webp', PNG, null)
  const d = importBuffer('d.webp', 'webp', PNG, null)
  // 初始 [d, c, b, a]；把 b、d 置顶 → 按原相对顺序（d 在 b 前）排到最前 → [d, b, c, a]
  const r = skins.moveSkins([b.id, d.id], 0)
  assert.equal(r.ok, true)
  assert.equal(r.moved, true)
  assert.equal(r.index, 0)
  assert.deepEqual(listSkins().items.map((x) => x.id), [d.id, b.id, c.id, a.id])
})

test('moveSkins：落点是非 0 时插到剩余项的第 index 个之前', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const c = importBuffer('c.webp', 'webp', PNG, null)
  // 初始 [c, b, a]；把 a 搬到剩项 [c, b] 的下标 1 前 → [c, a, b]
  const r = skins.moveSkins([a.id], 1)
  assert.equal(r.index, 1)
  assert.deepEqual(listSkins().items.map((x) => x.id), [c.id, a.id, b.id])
})

test('moveSkins：落点越界自动夹到合法范围（只在剩余项之间）', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const c = importBuffer('c.webp', 'webp', PNG, null)
  // 初始 [c, b, a]；把 a 搬到 99 → 夹到剩项 [c, b] 的末尾 → [c, b, a] 即原位，moved=false
  const far = skins.moveSkins([a.id], 99)
  assert.equal(far.ok, true)
  assert.equal(far.moved, false)
  assert.deepEqual(listSkins().items.map((x) => x.id), [c.id, b.id, a.id])
  // 负数夹到 0 → [a, c, b]
  const neg = skins.moveSkins([a.id], -5)
  assert.equal(neg.moved, true)
  assert.deepEqual(listSkins().items.map((x) => x.id), [a.id, c.id, b.id])
})

test('moveSkins：顺序没变（落点即原位）时 moved=false 且不写盘', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  // 初始 [b, a]；把 a 搬到剩项 [b] 的下标 1 → [b, a] 即原位
  const r = skins.moveSkins([a.id], 1)
  assert.equal(r.ok, true)
  assert.equal(r.moved, false)
  assert.deepEqual(listSkins().items.map((x) => x.id), [b.id, a.id])
})

test('moveSkins：全被选中时无插入位置，moved=false 且不动顺序', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const r = skins.moveSkins([a.id, b.id], 0)
  assert.equal(r.ok, true)
  assert.equal(r.moved, false)
  assert.deepEqual(listSkins().items.map((x) => x.id), [b.id, a.id])
})

test('moveSkins：脏 id 被静默滤掉，其余项照常搬运', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  // 初始 [b, a]；「no-such-id」不在列表里，只搬 a
  const r = skins.moveSkins(['no-such-id', a.id], 0)
  assert.equal(r.ok, true)
  assert.equal(r.moved, true)
  assert.deepEqual(listSkins().items.map((x) => x.id), [a.id, b.id])
})

test('moveSkins：空数组 / 全脏 id 时不动也不写盘', () => {
  reset()
  importBuffer('a.webp', 'webp', PNG, null)
  assert.equal(skins.moveSkins([], 0).moved, false)
  assert.equal(skins.moveSkins(['nope'], 0).moved, false)
  assert.equal(listSkins().items.length, 1)
})

test('moveSkins：不夹带「当前形象」的改动（搬顺序不等于换图）', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  // importBuffer 不切当前形象：空画廊导入第一张时 current 落到它，第二张不再顶替
  const cur = listSkins().current
  assert.equal(cur, a.id, '当前形象 = 第一张（后续导入不顶替）')
  skins.moveSkins([b.id], 0)   // 把第二张搬到最前
  assert.equal(listSkins().current, cur, '当前形象不受顺序调整影响')
  assert.deepEqual(listSkins().items.map((x) => x.id), [b.id, a.id], '顺序确实变了')
})

// ── 批量删除（removeSkins）──────────────────────────────────────────────
// 设置页「选中操作 → 删除」一次可能删十几张，走这条一趟读改写盘删完。

test('removeSkins：一次删掉多张，文件与元信息都清干净', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  const c = importBuffer('c.webp', 'webp', PNG, null)
  const r = skins.removeSkins([a.id, c.id])
  assert.equal(r.ok, true)
  assert.equal(r.removed, 2)
  assert.equal(r.failed, 0)
  assert.equal(r.left, 1)
  assert.deepEqual(listSkins().items.map((x) => x.id), [b.id])
  const dir = path.join(TMP, 'whale-skins')
  assert.equal(fs.existsSync(path.join(dir, a.id + '.webp')), false)
  assert.equal(fs.existsSync(path.join(dir, c.id + '.webp')), false)
  assert.equal(fs.existsSync(path.join(dir, b.id + '.webp')), true)
})

test('removeSkins：删掉当前形象时把当前位交给剩下的第一张', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const b = importBuffer('b.webp', 'webp', PNG, null)
  // importBuffer 不切当前形象（keepCurrent 语义）：current 停在第一张 a
  assert.equal(listSkins().current, a.id)
  const r = skins.removeSkins([a.id])
  assert.equal(r.current, b.id, '当前位交给剩下的第一张 b')
  assert.equal(listSkins().current, b.id)
})

test('removeSkins：删光了则 current 置空（由设置页回退内置形象）', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const r = skins.removeSkins([a.id])
  assert.equal(r.left, 0)
  assert.equal(r.current, '')
})

test('removeSkins：未知 id 计入 failed 且不影响其余项', () => {
  reset()
  const a = importBuffer('a.webp', 'webp', PNG, null)
  const r = skins.removeSkins(['no-such-id', a.id])
  assert.equal(r.ok, true)
  assert.equal(r.removed, 1)
  assert.equal(r.failed, 1)
  assert.equal(r.left, 0)
})

test('removeSkins：全是未知 id 时不动也不写盘', () => {
  reset()
  importBuffer('a.webp', 'webp', PNG, null)
  const r = skins.removeSkins(['x', 'y'])
  assert.equal(r.removed, 0)
  assert.equal(r.failed, 2)
  assert.equal(listSkins().items.length, 1)
})

test('removeSkins：空数组直接返回，不误清数据', () => {
  reset()
  importBuffer('a.webp', 'webp', PNG, null)
  const r = skins.removeSkins([])
  assert.equal(r.ok, true)
  assert.equal(r.removed, 0)
  assert.equal(listSkins().items.length, 1)
})

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })
