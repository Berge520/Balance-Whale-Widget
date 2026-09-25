/*
 * dsh profile 写锁的孤儿检测与清理（public/preload/lib/dsh.js 的 dshLockStale / dshLockClear）
 *
 * 背景：dsh 的 <profile>/package.json.lock 由 dsh-atomic-write 的 withFileLock 维护，
 * 它把 pid 写进锁却从不读，也没有过期检查；进程被强杀后 finally 不执行，锁永久残留，
 * 之后整个 profile 死锁（装/卸/更新/market 全部失败）。上游 26 个版本都不做回收，
 * 只能这边兜底 —— 所以这组判据必须有回归钉住。
 *
 * 重点是**边界**：这些用例挡的不是「能清理孤儿锁」，而是「不许误删活动锁」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── utools 桩（log.js 会取临时目录写 whale-debug.log）──
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}

const require = createRequire(import.meta.url)
const dsh = require('../public/preload/lib/dsh.js')

// ── 夹具：造一个假的 $DSH_HOME 并喂给模块（模块走 homeDir({env:'DSH_HOME'})）──
let tmpRoot = ''
const ENV_KEY = 'DSH_HOME'
const ENV_BAK = process.env[ENV_KEY]

function makeHome(files = {}) {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dshlock-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(tmpRoot, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  process.env[ENV_KEY] = tmpRoot
  return tmpRoot
}
function cleanup() {
  if (ENV_BAK === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = ENV_BAK
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {} tmpRoot = '' }
}
test.afterEach(() => cleanup())

const LOCK_REL = 'profiles/web/package.json.lock'
const lockAbs = () => path.join(tmpRoot, LOCK_REL)

// 挑一个**确定不存在**的 pid：从 999999 往下找一个 kill(pid,0) 抛 ESRCH 的。
// 直接用固定大数在不同机器/容器上未必安全（pid 上界各异），所以实测探测。
function deadPid() {
  for (let p = 999999; p > 900000; p--) {
    try { process.kill(p, 0) } catch (err) { if (err && err.code === 'ESRCH') return p }
  }
  throw new Error('找不到一个不存在的 pid 用于测试')
}

test('没有锁文件时判为 absent：ok=true / stale=false，且不报错', () => {
  makeHome({ 'profiles/web/package.json': '{}' })
  const r = dsh.dshLockStale('web')
  assert.equal(r.ok, true)
  assert.equal(r.stale, false)
  assert.equal(r.reason, 'absent')
  assert.equal(r.pid, 0)
})

test('锁里是已死进程的 pid → 判为孤儿（stale=true 且带 pid 与 age）', () => {
  const pid = deadPid()
  makeHome({ 'profiles/web/package.json': '{}', [LOCK_REL]: pid + '\n' })
  const r = dsh.dshLockStale('web')
  assert.equal(r.ok, true)
  assert.equal(r.stale, true)
  assert.equal(r.reason, 'orphan')
  assert.equal(r.pid, pid)
  assert.equal(r.lockPath, lockAbs())
  assert.ok(r.age >= 0, 'age 应为非负数')
})

test('锁里是当前活着的进程 pid → **不许**判孤儿（这是防误删活动锁的核心用例）', () => {
  makeHome({ 'profiles/web/package.json': '{}', [LOCK_REL]: String(process.pid) + '\n' })
  const r = dsh.dshLockStale('web')
  assert.equal(r.ok, true)
  assert.equal(r.stale, false)
  assert.equal(r.reason, 'alive')
  assert.equal(r.pid, process.pid)
})

test('锁内容不是纯数字 → 保守判非孤儿（bad-content），不猜、不清理', () => {
  makeHome({ 'profiles/web/package.json': '{}', [LOCK_REL]: 'holding...\n' })
  const r = dsh.dshLockStale('web')
  assert.equal(r.ok, true)
  assert.equal(r.stale, false)
  assert.equal(r.reason, 'bad-content')
})

test('锁文件为空 → bad-content（空串不是合法 pid）', () => {
  makeHome({ 'profiles/web/package.json': '{}', [LOCK_REL]: '' })
  const r = dsh.dshLockStale('web')
  assert.equal(r.stale, false)
  assert.equal(r.reason, 'bad-content')
})

test('pid 前后的空白与换行要宽容掉（上游写的是 "<pid>\\n"）', () => {
  const pid = deadPid()
  makeHome({ 'profiles/web/package.json': '{}', [LOCK_REL]: '  ' + pid + '  \n' })
  const r = dsh.dshLockStale('web')
  assert.equal(r.stale, true)
  assert.equal(r.pid, pid)
})

test('profile 名非法（含 @ 或 /）→ 直接拒绝，不落到任意路径', () => {
  makeHome({ 'profiles/web/package.json': '{}' })
  for (const bad of ['', '  ', '../web', 'a/b', '@scope/web', null, undefined]) {
    const r = dsh.dshLockStale(bad)
    assert.equal(r.ok, false, 'profile=' + String(bad) + ' 应被拒')
    assert.equal(r.stale, false)
  }
})

test('$DSH_HOME 指向不存在的目录 → 回退 ~/.dsh，仍不抛、不误报孤儿', () => {
  // ⚠️ 这里不能断言 reason==='no-profile-dir'：homeDir 的候选表是「env 优先 + 回退 ~/.dsh」，
  //    只有当**两个候选都不存在**时才会返回 ''。测试机上 ~/.dsh 通常真实存在（本机开发环境），
  //    所以该分支无法在单测里稳定构造。真正该钉住的是「不抛异常 + 不误报孤儿」。
  process.env[ENV_KEY] = path.join(os.tmpdir(), 'whale-nonexistent-' + Date.now())
  const r = dsh.dshLockStale('web')
  assert.equal(r.stale, false, '不存在的 DSH_HOME 绝不能报出孤儿锁')
  assert.equal(typeof r.ok, 'boolean')
  assert.ok(r.reason !== 'orphan')
})

test('清理孤儿锁：确实删除文件并回报 cleared=true', () => {
  const pid = deadPid()
  makeHome({ 'profiles/web/package.json': '{}', [LOCK_REL]: pid + '\n' })
  const r = dsh.dshLockClear('web')
  assert.equal(r.ok, true)
  assert.equal(r.cleared, true)
  assert.equal(r.pid, pid)
  assert.equal(fs.existsSync(lockAbs()), false, '锁文件应已被删除')
})

test('清理时锁已不在 → already=true（用户目标已达成，不算失败）', () => {
  makeHome({ 'profiles/web/package.json': '{}' })
  const r = dsh.dshLockClear('web')
  assert.equal(r.ok, true)
  assert.equal(r.cleared, false)
  assert.equal(r.already, true)
})

test('清理遇到活动锁 → 拒绝删除（重新校验，不信任调用方的旧结论）', () => {
  makeHome({ 'profiles/web/package.json': '{}', [LOCK_REL]: String(process.pid) + '\n' })
  const r = dsh.dshLockClear('web')
  assert.equal(r.ok, false)
  assert.equal(r.cleared, false)
  assert.equal(r.reason, 'alive')
  assert.equal(fs.existsSync(lockAbs()), true, '活动锁必须原样保留')
})

test('清理遇到内容读不懂的锁 → 拒绝删除，文件保留', () => {
  makeHome({ 'profiles/web/package.json': '{}', [LOCK_REL]: 'not-a-pid' })
  const r = dsh.dshLockClear('web')
  assert.equal(r.ok, false)
  assert.equal(r.cleared, false)
  assert.equal(r.reason, 'bad-content')
  assert.equal(fs.existsSync(lockAbs()), true)
})
