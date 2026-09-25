/*
 * log.js 的回归测试（node --test，零依赖）。
 *
 * 这里测的是本轮新增的两条「日志自我管理」能力，都是纯逻辑、不依赖 Electron 窗口：
 *   1. 体积超限后的**轮转**（改成 .1 再重建主文件，而不是截断只留末尾）
 *   2. 同一键的**重复抑制**（窗口内只写首条，窗口过后补一行重复计数）
 *
 * ⚠️ 为什么必须用 loadLog() 反复重建模块，而不是顶部 require 一次：
 *    log.js 在**模块加载时**就用 utools.getPath('temp') 算死 LOG_FILE，并把
 *    bytesWritten / suppressed 存成模块级状态。要测「换一个空临时目录」「让计数
 *    从 0 开始」，只能清掉 require.cache 重新加载，否则第二个用例会沿用第一个
 *    用例的目录与写入计数，测出来的东西自己都不信。
 *
 * ⚠️ 只在每个用例内部**临时**把 utools.getPath 指到本次的 mkdtemp 目录，
 *    加载完立刻还原 —— getPath 是共享桩，下一个用例还要换目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const LOG_PATH = require.resolve('../public/preload/lib/log.js')

// ── utools 桩：只需 getPath（log.js 用）──
// log.js 还会 require('fs') / require('path')，那两项是 Node 内置，无需桩
let tmpDir = ''
globalThis.utools = {
  isDev: () => true,
  getPath: () => tmpDir,
}

let dirs = []
// 造一个干净的临时目录当「%TEMP%」，返回它的路径
function mkTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-log-'))
  dirs.push(tmpDir)
  return tmpDir
}
function cleanup() {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch (_) {} }
  dirs = []
}
// 清缓存后重新加载 log.js：让 LOG_FILE / bytesWritten / suppressed 全部回到初始态
function loadLog(dir) {
  tmpDir = dir
  delete require.cache[LOG_PATH]
  return require(LOG_PATH)
}
function logPath(dir) { return path.join(dir, 'whale-debug.log') }
function readLog(dir) { try { return fs.readFileSync(logPath(dir), 'utf8') } catch (_) { return '' } }

test.after(() => cleanup())

// ── 1. 基础：写日志落到临时目录、格式带时间戳与级别 ──
test('log / logErr 把行写入 temp 下的 whale-debug.log', () => {
  const dir = mkTmp()
  const { log, logErr } = loadLog(dir)
  log('hello', 42)
  logErr('boom', { code: 'E1' })
  const txt = readLog(dir)
  assert.match(txt, /\[LOG\] hello 42/)
  assert.match(txt, /\[ERR\] boom/)
  // stringify 对非字符串走 JSON.stringify，对象要被序列化进去
  assert.match(txt, /"code":"E1"/)
  // 每条独立成行
  assert.equal(txt.trimEnd().split('\n').length, 2)
})

// ── 2. stringify 对 Error 取 stack、对循环引用兜底 ──
test('stringify 对 Error 展开 stack，循环引用不抛', () => {
  const dir = mkTmp()
  const { logErr } = loadLog(dir)
  logErr(new Error('inner-fail'))
  const circular = {}
  circular.self = circular
  logErr('bad', circular) // JSON.stringify 会抛 → 必须回落到 String()
  const txt = readLog(dir)
  assert.match(txt, /inner-fail/)
  assert.match(txt, /\[object Object\]/)
})

// ── 3. 重复抑制：同键在窗口内只落首条 ──
test('同一键在抑制窗口内只写首条，控制台不受影响', () => {
  const dir = mkTmp()
  const { logErr } = loadLog(dir)
  // 连续 30 次同一错误：行数必须是 1（其余被折叠）
  for (let i = 0; i < 30; i++) logErr('[whale][ipc] 推送失败')
  const txt = readLog(dir)
  const hits = txt.split('\n').filter((l) => l.includes('推送失败'))
  assert.equal(hits.length, 1, '窗口内同键应只落一行，实际 ' + hits.length)
})

// ── 4. 抑制键的归一化：数字 / 时间戳不同也算同一键 ──
test('消息里的数字与时间戳被归一化，不同耗秒数仍是同一键', () => {
  const dir = mkTmp()
  const { logErr } = loadLog(dir)
  // 模拟「同一处失败但耗时不同」：若不归一化，30 条会被当成 30 个不同键，抑制失效
  for (let i = 0; i < 30; i++) logErr('[whale][net] 请求超时 duration_ms=' + i)
  const txt = readLog(dir)
  const hits = txt.split('\n').filter((l) => l.includes('请求超时'))
  assert.equal(hits.length, 1, '归一化后应折叠成 1 行，实际 ' + hits.length)
})

// ── 5. level 参与键：同消息既 LOG 又 ERR 不得互相折叠 ──
test('键含 level：同一条消息的 LOG 与 ERR 不折叠', () => {
  const dir = mkTmp()
  const { log, logErr } = loadLog(dir)
  log('same message')
  logErr('same message')
  const txt = readLog(dir)
  assert.match(txt, /\[LOG\] same message/)
  assert.match(txt, /\[ERR\] same message/)
})

// ── 6. 轮转：主文件超限后改名成 .1，主文件只留轮转头 ──
// 触发条件：写在超限文件之后（append 使 bytesWritten 超 MAX_BYTES），
// 故 .1 里是「旧内容 + 触发那一行」—— 断言只钉「旧内容整份还在」，不钉精确字节数
test('体积超限时轮转成 .1，主文件重建为轮转头', () => {
  const dir = mkTmp()
  const p = logPath(dir)
  const OLD = 'x'.repeat(1024 * 1024 + 10)
  fs.writeFileSync(p, OLD)
  const { log } = loadLog(dir)
  log('trigger-rotate')
  // 主文件被重建：只剩轮转头（不应再有那一大堆 x）
  const main = readLog(dir)
  assert.ok(main.includes('已轮转'), '主文件首行应是轮转头')
  assert.ok(!main.includes('xxxx'), '主文件不应残留旧内容')
  // 历史落在 .1 里，旧内容整份保留（这是轮转相对截断的核心价值）
  const prev = fs.readFileSync(p + '.1', 'utf8')
  assert.ok(prev.startsWith(OLD), '.1 应完整保留旧内容')
})

// ── 7. 轮转可重复：第二次轮转覆盖旧的 .1（Windows 下 rename 到已存在目标会失败）──
test('连续两次轮转不报错，.1 被新历史覆盖', () => {
  const dir = mkTmp()
  const p = logPath(dir)
  // 第一次：造大文件后触发
  fs.writeFileSync(p, 'A'.repeat(1024 * 1024 + 10))
  let mod = loadLog(dir)
  mod.log('first')
  assert.ok(fs.readFileSync(p + '.1', 'utf8').startsWith('A'))
  // 第二次：重新加载模块让 bytesWritten 从磁盘实际值重算（否则计数已被第一次轮转重置，
  // 再写一行不会超限、根本不触发轮转），再造大文件触发，.1 应被第二次的历史覆盖
  fs.writeFileSync(p, 'B'.repeat(1024 * 1024 + 10))
  mod = loadLog(dir)
  mod.log('second')
  const prev = fs.readFileSync(p + '.1', 'utf8')
  assert.ok(prev.startsWith('B'), '.1 应被新历史覆盖，实际开头：' + prev.slice(0, 8))
  assert.ok(!prev.startsWith('A'))
})

// ── 8. 未超限不轮转：不该出现 .1 ──
test('未超限时不做轮转，不产生 .1 文件', () => {
  const dir = mkTmp()
  const { log } = loadLog(dir)
  for (let i = 0; i < 50; i++) log('line ' + i)
  assert.equal(fs.existsSync(logPath(dir) + '.1'), false)
})

// ── 9. 启动清理：陈旧日志（mtime 超 KEEP_DAYS）被清空 ──
test('模块加载时清空超过 7 天的陈旧日志', () => {
  const dir = mkTmp()
  const p = logPath(dir)
  fs.writeFileSync(p, 'old stuff\n')
  // 把 mtime 推到 8 天前
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000)
  fs.utimesSync(p, old, old)
  loadLog(dir)
  assert.equal(readLog(dir), '', '陈旧日志应被清空')
})

// ── 10. 启动清理的反向：未过期不清 ──
test('模块加载时不清空未过期的日志', () => {
  const dir = mkTmp()
  const p = logPath(dir)
  fs.writeFileSync(p, 'recent stuff\n')
  loadLog(dir)
  assert.match(readLog(dir), /recent stuff/)
})
