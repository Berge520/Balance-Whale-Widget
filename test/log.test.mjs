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

// ── 11. sanitize：敏感凭据落盘前被掩码 ──
//
// ⚠️ 为什么单独的 sanitize 用例必须挑**几种不同形态**而不是只测一个 sk-：
//    掩码规则是逐条正则，任何一条写错（漏了长度下限 / 分隔符集合不全 / 大小写没覆盖）
//    都只在对应形态上暴露。日志是用户会主动贴给我们取证的东西，漏一个 token 就是真泄露。
test('sanitize：sk- / gh_ / npm_ / Bearer / 键值对五类凭据都被掩码', () => {
  const { sanitize } = loadLog(mkTmp())
  assert.equal(sanitize('key=sk-abcdefghijklmn'), 'key=sk-***')
  assert.equal(sanitize('ghp_0123456789abcdefghij'), 'gh*_***')
  // ⚠️ 结果是 `token ***` 而不是 `token npm_***`：键值对规则比 `npm_` 规则更宽，先把整段值吃掉了。
  //    掩码以**更宽的规则**为准——能到达终点的前提下，掩码覆盖得越多越安全（log.js 的 write() 里
  //    注释也记了同一结论）。这里断言最终形态，别改回 `npm_***`。
  assert.equal(sanitize('token npm_0123456789abcdefghij'), 'token ***')
  // 同理：键值对规则把 `Bearer` 当成值的第一段也掩掉了 —— 连着 `Bearer` 一起变 `*** ***`。
  //    纯 `Bearer xxx` 的形态由下面独立一条覆盖，用来单独验证 Bearer 规则本身生效。
  assert.equal(sanitize('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9'), 'Authorization: *** ***')
  assert.equal(sanitize('Bearer eyJhbGciOiJIUzI1NiJ9'), 'Bearer ***')
  // 键值对形态（含不同分隔符与大小写）
  assert.equal(sanitize('apikey: secretvalue123'), 'apikey: ***')
  assert.equal(sanitize('PASSWORD="hunter2"'), 'PASSWORD="***')
  assert.equal(sanitize('token=abcdef'), 'token=***')
})

test('sanitize：长度不够的短串不误伤（宁可漏杀不可错杀）', () => {
  const { sanitize } = loadLog(mkTmp())
  // `sk-` 后不足 8 位：是普通词或版本号，不该被吃掉
  assert.equal(sanitize('sk-short'), 'sk-short')
  // `npm_` 后不足 16 位同理
  assert.equal(sanitize('npm_abc'), 'npm_abc')
})

// ── 12. sanitize：控制字符剔除（防日志注入）──
//
// ⚠️ 一条消息里夹 `\n` 会把单条日志伪造成多行 —— 读日志时无法分辨哪行是插件真写的。
//    这是「日志注入」：一个能控制输入的人（如插件名带换行）就能往日志里塞假行。
//    控制字符必须**在写入前**被替换成空格，且不影响正常的多字节字符。
test('sanitize：换行 / 回车 / 制表等控制字符被替换成空格（防伪造成多行）', () => {
  const { sanitize } = loadLog(mkTmp())
  assert.equal(sanitize('a\nb'), 'a b')
  assert.equal(sanitize('a\r\nb'), 'a  b')
  assert.equal(sanitize('a\tb'), 'a b')
  // 0x7f（DEL）同样在剔除范围
  assert.equal(sanitize('a\u007fb'), 'a b')
  // 中文字符是多字节，码点远大于 0x1f，必须原样保留（别把「剔除控制字符」写成了「只留 ASCII」）
  assert.equal(sanitize('中文消息'), '中文消息')
})

test('sanitize：正常文本与非字符串输入原样返回', () => {
  const { sanitize } = loadLog(mkTmp())
  assert.equal(sanitize('普通日志 without secrets'), '普通日志 without secrets')
  // 空串与 null / undefined 直接返回，不该变成 'null' / 'undefined' 字符串
  assert.equal(sanitize(''), '')
  assert.equal(sanitize(null), null)
  assert.equal(sanitize(undefined), undefined)
})

// ── 13. sanitize 与落盘链路的串接：写进去的就已经是脱敏后的 ──
//
// ⚠️ 单测 sanitize 通过 ≠ 落盘就脱敏了 —— 顺序若被改回「先落盘后 sanitize」，
//    单测全绿但日志里照样是明文。这里从**磁盘文件**回读，钉死端到端效果。
test('端到端：log() 落盘的凭据已被掩码，磁盘上看不到明文', () => {
  const dir = mkTmp()
  const { log } = loadLog(dir)
  // 注意这条命中的是**键值对规则**（token=… 会把整段值吃掉，包括 sk- 前缀）——
  // 多条规则都可能命中，掩码结果以更宽的那条为准，这里只钉「明文没了」这个结果
  log('调用失败，token=sk-abcdefghijklmn 请检查')
  const txt = readLog(dir)
  assert.match(txt, /token=\*\*\*/)
  assert.doesNotMatch(txt, /sk-abcdefghijklmn/, '磁盘上不能留明文 token')
  // 单独出现（非键值对形态）时也要被 sk- 规则吃掉，不能只靠键值对兜底
  log('裸 token 形式 sk-abcdefghijklmn 出现')
  assert.doesNotMatch(readLog(dir), /sk-abcdefghijklmn/, '裸形态的 sk- 也必须被掩码')
})
