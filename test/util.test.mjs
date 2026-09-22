/*
 * util.js 的回归测试（node --test，零依赖）。
 *
 * ⚠️ 本文件**刻意不挂任何 utools 桩**，这是对 util.js 依赖边界（D21 硬禁令）的
 * 唯一有效自检：util.js 一旦 require 了 log.js（→ utools）或 constants.js，
 * 这里会在 import 阶段直接炸，而不是等到某个运行分支才暴露。
 * 构建流程不会拦下越界引入，所以必须靠这个测试守住。
 *
 * 覆盖：
 *   1. num 把各种脏值收敛成有限数
 *   2. dayKeyFromTs / dayAdd 的本地时区归日与跨月跨年
 *   3. homeDir 的三种调用形态 + env 优先 + `~` 展开 + relative 两种口径（D22）
 *   4. readTextSafe 的 ENOENT/ENOTDIR 静默 vs 真故障带 reason（D23）
 *   5. walkDir 的 match / maxDepth / sort / silent 与 errors 收集
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const util = require('../public/preload/lib/util.js')

// ── 夹具 ──
let tmpRoot = ''
function mkTmp() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-util-'))
  return tmpRoot
}
function cleanup() {
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {} tmpRoot = '' }
}
test.afterEach(cleanup)

// ── num ──
test('num 把 undefined/null/NaN/字符串脏值一律收敛成 0，合法数字原样通过', () => {
  assert.equal(util.num(undefined), 0)
  assert.equal(util.num(null), 0)
  assert.equal(util.num('abc'), 0)
  assert.equal(util.num(NaN), 0)
  assert.equal(util.num(Infinity), 0)
  assert.equal(util.num(''), 0)
  assert.equal(util.num(0), 0)
  assert.equal(util.num('12'), 12)
  assert.equal(util.num(-3.5), -3.5)
})

// ── 日期 ──
test('dayKeyFromTs 按本地时区归日，不按 UTC（东八区 00:30 必须算当天）', () => {
  // 2026-09-19 00:30 本地时间
  const ts = new Date(2026, 8, 19, 0, 30, 0).getTime()
  assert.equal(util.dayKeyFromTs(ts), '2026-09-19')
  // 23:30 也还是同一天
  const late = new Date(2026, 8, 19, 23, 30, 0).getTime()
  assert.equal(util.dayKeyFromTs(late), '2026-09-19')
})

test('dayAdd 正确跨月、跨年，且不因时区偏移回退一天', () => {
  assert.equal(util.dayAdd('2026-09-19', 1), '2026-09-20')
  assert.equal(util.dayAdd('2026-09-30', 1), '2026-10-01')
  assert.equal(util.dayAdd('2026-12-31', 1), '2027-01-01')
  assert.equal(util.dayAdd('2026-03-01', -1), '2026-02-28')
  assert.equal(util.dayAdd('2026-09-19', 0), '2026-09-19')
})

// ── homeDir ──
test('homeDir 支持「字符串 env 名」与「对象形态」两种调用，对象形态不会退化成 [object Object]', () => {
  mkTmp()
  process.env.WHALE_TEST_HOME = tmpRoot
  try {
    // 对象形态（曾因参数解析写错而恒返回 ''，是本模块最贵的一个坑）
    assert.equal(util.homeDir({ env: 'WHALE_TEST_HOME', fallback: '.no-such-dir-xyz' }), tmpRoot)
    // candidates 形态直接给绝对路径
    assert.equal(util.homeDir({ candidates: [tmpRoot] }), tmpRoot)
  } finally {
    delete process.env.WHALE_TEST_HOME
  }
})

test('homeDir 环境变量不存在时回退 fallback，两者都不存在返回空串', () => {
  const home = os.homedir()
  const fallbackName = '.whale-util-fallback-' + Date.now()
  const fb = path.join(home, fallbackName)
  // 先确认本用例的前提：这个 fallback 目录不存在
  assert.equal(fs.existsSync(fb), false)
  try {
    assert.equal(util.homeDir({ env: 'WHALE_TEST_NOPE', fallback: fallbackName }), '')
    // 建出来之后就能命中 fallback
    fs.mkdirSync(fb)
    assert.equal(util.homeDir({ env: 'WHALE_TEST_NOPE', fallback: fallbackName }), fb)
  } finally {
    try { fs.rmdirSync(fb) } catch (_) {}
  }
})

test('homeDir 只在 expand:true 时展开 `~`（D22：codex 口径不展开，dsh 口径展开）', () => {
  // 用一个**必定不存在**的 `~` 下的路径，避开各平台对裸 `~` 的实际解析差异：
  // 不展开时原始串 '~/no-such-sub' 不可能存在于文件系统；展开后才指向家目录下的同名路径，
  // 我们把它建出来，从而只验证「展开确实发生了」这一件事
  const home = os.homedir()
  const sub = '.whale-util-tilde-' + Date.now()
  process.env.WHALE_TEST_TILDE = '~/' + sub
  const expected = path.join(home, sub)
  try {
    // 家目录下还没这个目录：两种口径都命中不了
    assert.equal(util.homeDir({ env: 'WHALE_TEST_TILDE', fallback: '.no-such-dir-xyz', expand: true }), '')
    fs.mkdirSync(expected)
    // 不传 expand → 沿用 codex 口径：'~/xxx' 原样丢给 existsSync，命中不了
    assert.equal(util.homeDir({ env: 'WHALE_TEST_TILDE', fallback: '.no-such-dir-xyz' }), '')
    // expand:true → 展开成家目录，命中
    assert.equal(util.homeDir({ env: 'WHALE_TEST_TILDE', fallback: '.no-such-dir-xyz', expand: true }), expected)
  } finally {
    delete process.env.WHALE_TEST_TILDE
    try { fs.rmdirSync(expected) } catch (_) {}
  }
})

test('homeDir relative 只在 expand 之后仍非绝对路径时按 cwd 解析（dsh 口径）', () => {
  mkTmp()
  const rel = path.relative(process.cwd(), tmpRoot)
  // 同上：不建真实相对目录就无法命中，这里只验证「不抛错、返回字符串」
  process.env.WHALE_TEST_REL = rel
  try {
    const r = util.homeDir({ env: 'WHALE_TEST_REL', fallback: '.no-such-dir-xyz', expand: true, relative: true })
    assert.equal(typeof r, 'string')
  } finally {
    delete process.env.WHALE_TEST_REL
  }
})

// ── readTextSafe ──
test('readTextSafe 读成功返回文本与 ok:true', () => {
  const root = mkTmp()
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'hello 世界', 'utf8')
  const r = util.readTextSafe(f)
  assert.equal(r.ok, true)
  assert.equal(r.text, 'hello 世界')
  assert.equal(r.reason, '')
})

test('readTextSafe 对 ENOENT / ENOTDIR 静默（reason 为空）—— 这是诊断里的预期分支', () => {
  const root = mkTmp()
  // 文件不存在
  const missing = util.readTextSafe(path.join(root, 'nope.txt'))
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, '')
  assert.equal(missing.text, null)
  // 路径中有一段是文件，不是目录
  const f = path.join(root, 'plain.txt')
  fs.writeFileSync(f, 'x')
  const notdir = util.readTextSafe(path.join(f, 'child.txt'))
  assert.equal(notdir.ok, false)
  assert.equal(notdir.reason, '')
})

test('readTextSafe 对真故障回报 reason（D23：不能笼统当成「缺失」）', () => {
  const root = mkTmp()
  const dirAsFile = path.join(root, 'a-directory')
  fs.mkdirSync(dirAsFile)
  // 把目录当文件读：Linux/macOS 是 EISDIR，Windows 是 EACCES/EPERM，都属真故障
  const r = util.readTextSafe(dirAsFile)
  if (process.platform === 'win32') {
    // Windows 上 readFileSync 目录通常直接抛 EISDIR（Node 已做归一），无论哪种都要求 reason 非空
    assert.equal(r.ok, false)
    assert.notEqual(r.reason, '')
  } else {
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'EISDIR')
  }
})

test('readTextSafe 可指定 fallback 文本，失败时原样返回', () => {
  const root = mkTmp()
  const r = util.readTextSafe(path.join(root, 'none.txt'), '默认值')
  assert.equal(r.ok, false)
  assert.equal(r.text, '默认值')
})

// ── readText / readJsonSafe ──
test('readText 读不到返回 fallback（默认空串），不抛异常', () => {
  const root = mkTmp()
  assert.equal(util.readText(path.join(root, 'no.txt')), '')
  assert.equal(util.readText(path.join(root, 'no.txt'), 'fb'), 'fb')
})

test('readJsonSafe 解析对象成功，读不到 / 非法 JSON / 非对象一律返回 null', () => {
  const root = mkTmp()
  const good = path.join(root, 'good.json')
  fs.writeFileSync(good, JSON.stringify({ name: 'x', version: '1.0.0' }))
  assert.deepEqual(util.readJsonSafe(good), { name: 'x', version: '1.0.0' })
  // 非法 JSON
  const bad = path.join(root, 'bad.json')
  fs.writeFileSync(bad, '{ not json')
  assert.equal(util.readJsonSafe(bad), null)
  // 合法 JSON 但不是对象（数字 / 数组里的 null）
  const scalar = path.join(root, 'scalar.json')
  fs.writeFileSync(scalar, '42')
  assert.equal(util.readJsonSafe(scalar), null)
  // 读不到
  assert.equal(util.readJsonSafe(path.join(root, 'none.json')), null)
})

// ── walkDir ──
function buildTree() {
  const root = mkTmp()
  const sub = path.join(root, 'a', 'b')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(root, 'root.jsonl'), '1')
  fs.writeFileSync(path.join(root, 'skip.txt'), '2')
  fs.writeFileSync(path.join(root, 'a', 'mid.jsonl'), '3')
  fs.writeFileSync(path.join(sub, 'deep.jsonl'), '4')
  return root
}

test('walkDir 递归收集文件，match 支持正则与函数两种形态', () => {
  const root = buildTree()
  const byRe = util.walkDir(root, { match: /\.jsonl$/i })
  assert.equal(byRe.files.length, 3)
  assert.ok(byRe.files.every((f) => f.endsWith('.jsonl')))
  const byFn = util.walkDir(root, { match: (n) => n === 'skip.txt' })
  assert.equal(byFn.files.length, 1)
  assert.ok(byFn.files[0].endsWith('skip.txt'))
  // 不给 match 则全部收
  assert.equal(util.walkDir(root).files.length, 4)
})

test('walkDir maxDepth 生效：默认 6 能到深层，限制为 1 就够不到', () => {
  const root = buildTree()
  // deep.jsonl 在 root/a/b/ 下，深度 2
  const d1 = util.walkDir(root, { match: /\.jsonl$/i, maxDepth: 1 })
  assert.equal(d1.files.some((f) => f.endsWith('deep.jsonl')), false)
  const d2 = util.walkDir(root, { match: /\.jsonl$/i, maxDepth: 2 })
  assert.equal(d2.files.some((f) => f.endsWith('deep.jsonl')), true)
})

test('walkDir 默认排序，sort:false 时保留 readdir 顺序', () => {
  const root = buildTree()
  const sorted = util.walkDir(root, { match: /\.jsonl$/i }).files
  assert.deepEqual(sorted, sorted.slice().sort())
  const raw = util.walkDir(root, { match: /\.jsonl$/i, sort: false }).files
  assert.equal(raw.length, sorted.length)
})

test('walkDir 根目录不存在时返回空数组且不抛错；silent:false 时把原因收进 errors', () => {
  const missing = path.join(os.tmpdir(), 'whale-walk-nope-' + Date.now())
  const quiet = util.walkDir(missing)
  assert.deepEqual(quiet.files, [])
  assert.deepEqual(quiet.errors, [])
  const loud = util.walkDir(missing, { silent: false })
  assert.deepEqual(loud.files, [])
  assert.equal(loud.errors.length, 1)
  assert.ok(loud.errors[0].dir)
  assert.ok(loud.errors[0].reason)
})

// ── normalizePath ──
test('normalizePath 收敛为绝对路径；空值返回空串，不做 realpath（D25）', () => {
  assert.equal(util.normalizePath(''), '')
  assert.equal(util.normalizePath(null), '')
  const root = mkTmp()
  const p = path.join(root, 'a', '..', 'b')
  assert.equal(util.normalizePath(p), path.join(root, 'b'))
})
