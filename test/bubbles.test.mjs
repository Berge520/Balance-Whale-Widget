/*
 * bubbles.js 的推送缓存单测（node --test，零依赖）。
 *
 * 为什么要测：getBubbleData 把整池气泡图读成 base64 推给挂件，且原先**每次推送都重读重编码**。
 * 真机打开挂件时这条落在 pushInit 的同步链路上（同批次的共享角色池有 52MB base64），
 * 缓存能把它从「每次打开都付」降成「首次付一次」。
 * 但缓存一旦漏掉某个失效点，用户在设置页删图后挂件还在抽旧图 —— 静默的错误，
 * 所以失效路径必须逐条钉住。
 *
 * 环境：与 skins.test.mjs 同一范式，内存 dbStorage + getPath 指向本次测试的临时目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const store = new Map()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bubbles-test-'))
globalThis.utools = {
  getPath: () => TMP,
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  },
}

const require = createRequire(import.meta.url)
const bubbles = require('../public/preload/lib/bubbles.js')
const { K } = require('../public/preload/lib/constants.js')

// 一张最小合法 PNG 头（getBubbleData 只按字节读，内容不参与校验）
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function reset() {
  store.delete(K.bubbles)
  fs.rmSync(path.join(TMP, 'whale-bubbles'), { recursive: true, force: true })
}

test('getBubbleData 第二次调用走缓存，不再读盘', () => {
  reset()
  bubbles.importBuffer('a.png', 'png', PNG, null)
  bubbles.importBuffer('b.png', 'png', PNG, null)
  const first = bubbles.getBubbleData()
  assert.equal(first.length, 2)

  const real = fs.readFileSync
  let reads = 0
  fs.readFileSync = function (...args) { reads++; return real.apply(fs, args) }
  try {
    assert.deepEqual(bubbles.getBubbleData(), first)
    assert.equal(reads, 0, '第二次调用一次盘都不该读')
  } finally {
    fs.readFileSync = real
  }
})

test('新增气泡图后 getBubbleData 立刻含新那张', () => {
  reset()
  bubbles.importBuffer('a.png', 'png', PNG, null)
  assert.equal(bubbles.getBubbleData().length, 1)
  bubbles.importBuffer('b.png', 'png', PNG, null)
  assert.equal(bubbles.getBubbleData().length, 2, '刚导入的图要马上进池')
})

test('删除气泡图后 getBubbleData 立刻不含它', () => {
  reset()
  const a = bubbles.importBuffer('a.png', 'png', PNG, null)
  bubbles.importBuffer('b.png', 'png', PNG, null)
  assert.equal(bubbles.getBubbleData().length, 2)
  bubbles.removeBubble(a.id)
  assert.equal(bubbles.getBubbleData().length, 1, '删掉的图不该还能被抽到')
})

test('清除全部气泡图后 getBubbleData 返回空池', () => {
  reset()
  bubbles.importBuffer('a.png', 'png', PNG, null)
  assert.equal(bubbles.getBubbleData().length, 1)
  bubbles.clearAll()
  assert.deepEqual(bubbles.getBubbleData(), [])
})

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })
