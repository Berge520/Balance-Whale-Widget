/*
 * codex.js 增量扫描的回归测试（node --test，零依赖）。
 *
 * 这里盯的是「异常路径」而不是正常解析 —— 正常解析写错一眼能看出来，
 * 而扫描上限相关的错误是静默的：文件被跳过却不落指纹会每轮重读、
 * 预算用尽却不留待下轮会让进度永远停在原地，两者都不会报错。
 *
 * 覆盖：
 *   1. 指纹未变的文件走复用，不重复解析
 *   2. 超单文件上限（CODEX_MAX_FILE_BYTES）→ 跳过但**指纹落缓存**（否则永久复发）
 *   3. 单轮预算（文件数 / 字节数）→ 超出部分标 deferred、不落指纹，下轮续扫
 *   4. 多轮累加后总额与全量扫描一致（进度能跨轮前进）
 *
 * codex.js 是 CommonJS 且直接读全局 utools / fs，所以先在全局挂桩再 import。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── utools 桩：只需 dbStorage（缓存）+ getPath（log.js 用）──
const store = new Map()
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  },
}

const require = createRequire(import.meta.url)
const codex = require('../public/preload/lib/codex.js')
const { K } = require('../public/preload/lib/constants.js')

// ── 夹具：造一个假的 $CODEX_HOME，内含 sessions/YYYY/MM/DD/rollout-*.jsonl ──
let tmpRoot = ''
function makeHome() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-codex-'))
  fs.mkdirSync(path.join(tmpRoot, 'sessions'), { recursive: true })
  return tmpRoot
}
function cleanup() {
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {} tmpRoot = '' }
}
// 本地时区的今天（dayKeyFromTs 按本地归日，用固定日期会与机器时钟错位）
function todayKey() {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}
// 生成一个会话文件：turns 轮，每轮 total 递增 step；totalTokens = turns * step
function writeSession(name, { turns = 2, step = 100, model = 'gpt-5', ts = Date.now() } = {}) {
  const iso = new Date(ts).toISOString()
  const lines = []
  let total = 0
  lines.push(JSON.stringify({ type: 'turn_context', timestamp: iso, payload: { model } }))
  for (let i = 0; i < turns; i++) {
    total += step
    lines.push(JSON.stringify({
      type: 'event_msg',
      timestamp: iso,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: total },
          last_token_usage: { total_tokens: step, input_tokens: step, output_tokens: 0 },
        },
      },
    }))
  }
  const dir = path.join(tmpRoot, 'sessions', '2026', '09', '19')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}
// 每个用例前清缓存 + 造新 home；codex.js 的 memo 有 5s TTL，用「往前拨时钟」绕过
let clockOffset = 0
const realNow = Date.now.bind(Date)
function freshStart() {
  store.clear()
  codex.clearCodexCache()
  clockOffset = 0
  Date.now = () => realNow() + clockOffset
  process.env.CODEX_HOME = makeHome()
}
// 模拟 5s 后再次调用（memo 过期），但保持同一次测试内的相对顺序
function nextRound() {
  clockOffset += 6000
  Date.now = () => realNow() + clockOffset
}

test.afterEach(() => {
  Date.now = realNow
  delete process.env.CODEX_HOME
  cleanup()
})

test('指纹未变的文件复用缓存，不重复解析', () => {
  freshStart()
  writeSession('rollout-a.jsonl', { turns: 2, step: 100 })
  writeSession('rollout-b.jsonl', { turns: 3, step: 100 })

  const first = codex.codexSummary()
  assert.equal(first.ok, true)
  assert.equal(first.sessions, 2)
  assert.equal(first.changed, 2, '首轮两个文件都是新的')
  assert.equal(first.totalTokens, 500)
  assert.equal(first.skipped, 0)
  assert.equal(first.deferred, false)

  nextRound()
  const second = codex.codexSummary()
  assert.equal(second.changed, 0, '指纹未变 → 一个都不重新解析')
  assert.equal(second.totalTokens, 500, '复用缓存后总额不变')
})

test('超单文件上限：跳过但把指纹落进缓存，下轮不再当"变更"', () => {
  freshStart()
  writeSession('rollout-small.jsonl', { turns: 2, step: 100 })
  // 造一个超限文件（> 32MB）。内容本身合法，仅体积触发跳过
  const big = path.join(tmpRoot, 'sessions', '2026', '09', '19', 'rollout-big.jsonl')
  fs.writeFileSync(big, Buffer.alloc(33 * 1024 * 1024, 0x7b))

  const first = codex.codexSummary()
  assert.equal(first.skipped, 1, '超大文件被跳过')
  assert.equal(first.totalTokens, 200, '超大文件不计入 token')
  assert.equal(first.changed, 1, '只有小文件被解析')

  // 关键：指纹必须已落缓存（否则该文件每轮都被判"变更"重读，错误发生在写缓存前 → 永久复发）
  const cache = store.get(K.codex)
  assert.ok(cache && cache.files[big], '超大文件的指纹已落缓存')
  assert.equal(cache.files[big].skipped, true, '缓存条目标了 skipped')

  nextRound()
  const second = codex.codexSummary()
  assert.equal(second.skipped, 0, '指纹未变 → 不再重复判定为超大')
  assert.equal(second.changed, 0, '不再重复解析')
  assert.equal(second.totalTokens, 200)
})

test('单轮预算用尽：超出部分标 deferred、不落指纹，下轮续扫并累加', () => {
  freshStart()
  // CODEX_MAX_ROUND_FILES = 400：造 401 个文件，真实触发「预算用尽」这条路径。
  // 首轮只有 400 个被解析、第 401 个被 deferred；下轮它仍在 fresh 桶里被优先处理。
  for (let i = 0; i < 401; i++) writeSession('rollout-' + String(i).padStart(3, '0') + '.jsonl', { turns: 1, step: 100 })

  const r1 = codex.codexSummary()
  assert.equal(r1.sessions, 401)
  assert.equal(r1.changed, 400, '首轮只解析预算内的 400 个')
  assert.equal(r1.deferred, true, '预算用尽 → 标 deferred')
  assert.equal(r1.totalTokens, 40000, '未解析的那个不计入')
  // deferred 的文件不能落指纹（否则下轮被判"未变更"，永远补不上）
  const cache1 = store.get(K.codex)
  assert.equal(Object.keys(cache1.files).length, 400)

  nextRound()
  const r2 = codex.codexSummary()
  assert.equal(r2.changed, 1, '下轮只补扫剩下那一个')
  assert.equal(r2.deferred, false, '补扫完不再 deferred')
  assert.equal(r2.totalTokens, 40100, '进度跨轮累加，与全量一致')

  nextRound()
  const r3 = codex.codexSummary()
  assert.equal(r3.changed, 0, '全部落盘后进入稳定复用')
  assert.equal(r3.totalTokens, 40100)
})

test('新增文件后，下一轮只解析新增那个（增量而非全量）', () => {
  freshStart()
  writeSession('rollout-1.jsonl', { turns: 1, step: 100 })
  writeSession('rollout-2.jsonl', { turns: 1, step: 100 })

  const r1 = codex.codexSummary()
  assert.equal(r1.changed, 2)
  assert.equal(r1.totalTokens, 200)

  nextRound()
  writeSession('rollout-3.jsonl', { turns: 1, step: 500 })
  const r2 = codex.codexSummary()
  assert.equal(r2.sessions, 3)
  assert.equal(r2.changed, 1, '只有新增的那个需要解析')
  assert.equal(r2.totalTokens, 700, '旧文件复用 + 新文件累加')
})

test('clearCodexCache 后重扫得到与增量结果一致的总额', () => {
  freshStart()
  writeSession('rollout-1.jsonl', { turns: 4, step: 250 })
  writeSession('rollout-2.jsonl', { turns: 2, step: 300 })

  nextRound()
  const incremental = codex.codexSummary()
  const before = incremental.totalTokens
  assert.equal(before, 1600)

  // 清缓存（设置页「刷新」按钮语义）→ 全量重扫
  codex.clearCodexCache()
  nextRound()
  const full = codex.codexSummary()
  assert.equal(full.totalTokens, before, '增量与全量结果必须一致')
  assert.equal(full.changed, 2, '清缓存后两个文件都重新解析')
})

test('今日 / 本月 token 按本地时区归日', () => {
  freshStart()
  writeSession('rollout-today.jsonl', { turns: 3, step: 100, ts: Date.now() })
  // 昨天：取「本地今天 00:00」再往前 1 小时，必落在昨天。
  // 不能写 Date.now() - 26h —— 凌晨运行时回拨会跨到前天，days7[1] 就空了（曾因此在 CI 偶发失败）。
  const d0 = new Date()
  d0.setHours(0, 0, 0, 0)
  writeSession('rollout-old.jsonl', { turns: 5, step: 100, ts: d0.getTime() - 3600 * 1000 })

  // 注意：这里不能调 nextRound()（会拨时钟），todayKey 必须与 codex 内部看到的「今天」同源。
  // 上一个用例可能改过 clockOffset，故先归零
  clockOffset = 0
  Date.now = () => realNow()
  const r = codex.codexSummary()
  assert.equal(r.totalTokens, 800, '总额含跨天文件')
  assert.equal(r.todayTokens, 300, '只有今天的那个计入今日')
  // days7 是按「今天 → 往前 6 天」push 的，首位才是今天（不是末位）
  assert.equal(r.days7[0].date, todayKey())
  assert.equal(r.days7[0].tokens, 300)
  assert.equal(r.days7.length, 7)
  // 昨天那 500 应落在 days7[1]
  assert.equal(r.days7[1].tokens, 500)
})
