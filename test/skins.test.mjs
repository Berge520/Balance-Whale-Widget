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

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })
