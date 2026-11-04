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
import test, { after } from 'node:test'
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
// cleanup 只清「当前」那一座：换目录（下一条用例要全新 home）时旧的就留在 %TEMP% 里。
// 所以每造一座都记一笔，文末 after 统一删
const createdRoots = []
function makeHome() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-codex-'))
  createdRoots.push(tmpRoot)
  fs.mkdirSync(path.join(tmpRoot, 'sessions'), { recursive: true })
  return tmpRoot
}
function cleanup() {
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {} tmpRoot = '' }
}
after(() => {
  for (const dir of createdRoots) fs.rmSync(dir, { recursive: true, force: true })
})
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

test('指纹未变的文件复用缓存，不重复解析', async () => {
  freshStart()
  writeSession('rollout-a.jsonl', { turns: 2, step: 100 })
  writeSession('rollout-b.jsonl', { turns: 3, step: 100 })

  const first = await codex.codexSummary()
  assert.equal(first.ok, true)
  assert.equal(first.sessions, 2)
  assert.equal(first.changed, 2, '首轮两个文件都是新的')
  assert.equal(first.totalTokens, 500)
  assert.equal(first.skipped, 0)
  assert.equal(first.deferred, false)

  nextRound()
  const second = await codex.codexSummary()
  assert.equal(second.changed, 0, '指纹未变 → 一个都不重新解析')
  assert.equal(second.totalTokens, 500, '复用缓存后总额不变')
})

test('超单文件上限：跳过但把指纹落进缓存，下轮不再当"变更"', async () => {
  freshStart()
  writeSession('rollout-small.jsonl', { turns: 2, step: 100 })
  // 造一个超限文件（> 32MB）。内容本身合法，仅体积触发跳过
  const big = path.join(tmpRoot, 'sessions', '2026', '09', '19', 'rollout-big.jsonl')
  fs.writeFileSync(big, Buffer.alloc(33 * 1024 * 1024, 0x7b))

  const first = await codex.codexSummary()
  assert.equal(first.skipped, 1, '超大文件被跳过')
  assert.equal(first.totalTokens, 200, '超大文件不计入 token')
  assert.equal(first.changed, 1, '只有小文件被解析')

  // 关键：指纹必须已落缓存（否则该文件每轮都被判"变更"重读，错误发生在写缓存前 → 永久复发）
  const cache = store.get(K.codex)
  assert.ok(cache && cache.files[big], '超大文件的指纹已落缓存')
  assert.equal(cache.files[big].skipped, true, '缓存条目标了 skipped')

  nextRound()
  const second = await codex.codexSummary()
  assert.equal(second.skipped, 0, '指纹未变 → 不再重复判定为超大')
  assert.equal(second.changed, 0, '不再重复解析')
  assert.equal(second.totalTokens, 200)
})

test('单轮预算用尽：超出部分标 deferred、不落指纹，下轮续扫并累加', async () => {
  freshStart()
  // CODEX_MAX_ROUND_FILES = 400：造 401 个文件，真实触发「预算用尽」这条路径。
  // 首轮只有 400 个被解析、第 401 个被 deferred；下轮它仍在 fresh 桶里被优先处理。
  for (let i = 0; i < 401; i++) writeSession('rollout-' + String(i).padStart(3, '0') + '.jsonl', { turns: 1, step: 100 })

  const r1 = await codex.codexSummary()
  assert.equal(r1.sessions, 401)
  assert.equal(r1.changed, 400, '首轮只解析预算内的 400 个')
  assert.equal(r1.deferred, true, '预算用尽 → 标 deferred')
  assert.equal(r1.totalTokens, 40000, '未解析的那个不计入')
  // deferred 的文件不能落指纹（否则下轮被判"未变更"，永远补不上）
  const cache1 = store.get(K.codex)
  assert.equal(Object.keys(cache1.files).length, 400)

  nextRound()
  const r2 = await codex.codexSummary()
  assert.equal(r2.changed, 1, '下轮只补扫剩下那一个')
  assert.equal(r2.deferred, false, '补扫完不再 deferred')
  assert.equal(r2.totalTokens, 40100, '进度跨轮累加，与全量一致')

  nextRound()
  const r3 = await codex.codexSummary()
  assert.equal(r3.changed, 0, '全部落盘后进入稳定复用')
  assert.equal(r3.totalTokens, 40100)
})

test('新增文件后，下一轮只解析新增那个（增量而非全量）', async () => {
  freshStart()
  writeSession('rollout-1.jsonl', { turns: 1, step: 100 })
  writeSession('rollout-2.jsonl', { turns: 1, step: 100 })

  const r1 = await codex.codexSummary()
  assert.equal(r1.changed, 2)
  assert.equal(r1.totalTokens, 200)

  nextRound()
  writeSession('rollout-3.jsonl', { turns: 1, step: 500 })
  const r2 = await codex.codexSummary()
  assert.equal(r2.sessions, 3)
  assert.equal(r2.changed, 1, '只有新增的那个需要解析')
  assert.equal(r2.totalTokens, 700, '旧文件复用 + 新文件累加')
})

test('clearCodexCache 后重扫得到与增量结果一致的总额', async () => {
  freshStart()
  writeSession('rollout-1.jsonl', { turns: 4, step: 250 })
  writeSession('rollout-2.jsonl', { turns: 2, step: 300 })

  nextRound()
  const incremental = await codex.codexSummary()
  const before = incremental.totalTokens
  assert.equal(before, 1600)

  // 清缓存（设置页「刷新」按钮语义）→ 全量重扫
  codex.clearCodexCache()
  nextRound()
  const full = await codex.codexSummary()
  assert.equal(full.totalTokens, before, '增量与全量结果必须一致')
  assert.equal(full.changed, 2, '清缓存后两个文件都重新解析')
})

test('今日 / 本月 token 按本地时区归日', async () => {
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
  const r = await codex.codexSummary()
  assert.equal(r.totalTokens, 800, '总额含跨天文件')
  assert.equal(r.todayTokens, 300, '只有今天的那个计入今日')
  // days31 是按「今天 → 往前 30 天」push 的，首位才是今天（不是末位）
  assert.equal(r.days31[0].date, todayKey())
  assert.equal(r.days31[0].tokens, 300)
  assert.equal(r.days31.length, 31)
  // 昨天那 500 应落在 days31[1]
  assert.equal(r.days31[1].tokens, 500)
})

// ── 快照层 ──
// 所有 IPC handler 与 sendToWidget 都是同步的，所以 codex 对外必须是「同步入口 + 有界等待 + 直接扫描」
// 三种形态。这里盯的是快照层自身的两个坑：同步入口不能返回 Promise（调用方拿 Promise 会判成「统计失败」）、
// deferred 补扫必须真的自己再扫一轮（不能靠再次被调用）。

// 把 Date.now 固定在某一刻，用来验证快照 TTL（snapAt 与 Date.now 的比较）
function freezeClock() {
  const t = realNow()
  Date.now = () => t
}

// 等后台扫描真正收尾（不是「等几拍」）：快照要等 kickScan 的 Promise 全部链跑完才落。
// 用 codexSummaryCached 轮询最直接 —— 它同步、无副作用（有最新快照就立刻返回）。
// pred 可以额外指定「等到满足某个条件为止」（例如等补扫把 deferred 清掉）
async function waitSnap(ms = 5000, pred = () => true) {
  const t0 = realNow()
  while (realNow() - t0 < ms) {
    const s = codex.codexSummaryCached()
    if (s && s.ok && pred(s)) return s
    await new Promise((r) => setTimeout(r, 5))
  }
  return null
}

test('codexSummaryCached：首次同步返回 null，并在后台把快照补上', async () => {
  freshStart()
  writeSession('rollout-a.jsonl', { turns: 2, step: 100 })
  const got = []
  const off = codex.onCodexSnapshot((s) => got.push(s))
  try {
    const first = codex.codexSummaryCached()
    // 关键：必须是同步返回的「无快照」，不能是 Promise —— 同步调用方拿 Promise 会读到 undefined.ok
    assert.equal(first, null, '首帧没有快照就返回 null（不是 Promise）')
    const second = await waitSnap()
    assert.ok(second, '后台扫描完成后同步入口能拿到快照')
    assert.equal(second.totalTokens, 200)
    assert.equal(got.length >= 1, true, '快照更新触发了订阅回调')
    assert.equal(got[got.length - 1].totalTokens, 200)
  } finally {
    off()
  }
})

test('快照新鲜期（CODEX_SNAP_TTL_MS）内不再重复扫描', async () => {
  freshStart()
  writeSession('rollout-a.jsonl', { turns: 2, step: 100 })
  await codex.codexSummary()
  // TTL 内：即使底层 memo 已过期（时间往前拨），同步入口也不该发起扫描、直接给旧快照
  freezeClock()
  const before = codex.codexSummaryCached()
  nextRound()
  const after = codex.codexSummaryCached()
  assert.ok(before && after)
  assert.equal(after, before, 'TTL 内复用同一份快照对象')
})

test('codexSummaryEnsured：没快照时有界等待并拿到结果', async () => {
  freshStart()
  writeSession('rollout-a.jsonl', { turns: 2, step: 100 })
  const r = await codex.codexSummaryEnsured(2000)
  assert.ok(r && r.ok, '最多等 2s，扫描很快完成')
  assert.equal(r.totalTokens, 200)
})

test('codexSummaryEnsured：等不到就返回 null，不挂死', async () => {
  freshStart()
  writeSession('rollout-a.jsonl', { turns: 2, step: 100 })
  // 把「延迟执行」换成立刻触发 → 超时 Promise 先赢，模拟「扫描没赶上预算」
  const realLater = codex.later
  codex.later = (fn) => { fn(); return { unref() {} } }
  try {
    const r = await codex.codexSummaryEnsured(1)
    assert.equal(r, null, '超预算时返回 null（调用方据此走 transient 分支），而不是一直等')
  } finally {
    codex.later = realLater
  }
})

test('deferred 时自动补扫：不必等下一次调用', async () => {
  // 换一个全新的临时目录：上一条用例已把 401 个文件的指纹写进内存缓存，
  // 而 freshStart() 只清 dbStorage，fileCache 仍在，同路径同 size/mtime 会被判成「未变更」→ 不 deferred
  freshStart()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-codex-resume-'))
  createdRoots.push(tmpRoot)
  fs.mkdirSync(path.join(tmpRoot, 'sessions'), { recursive: true })
  process.env.CODEX_HOME = tmpRoot
  for (let i = 0; i < 401; i++) writeSession('rollout-' + String(i).padStart(3, '0') + '.jsonl', { turns: 1, step: 100 })
  // 等一拍再扫：文件 size/mtime 的精度不足时，新目录里的文件可能与上一条用例的指纹撞上
  // （同 size 同 mtime → 被判"未变更"，changed 变成 0）
  await new Promise((r) => setTimeout(r, 20))
  // 替换延迟执行：scheduleResume 的 5s 补扫立刻跑，验证「没人调也会自己补」。
  // 必须在 kickScan **之前**替换 —— laterOf() 是在 scheduleResume 调用时取实现的
  const realLater = codex.later
  const queued = []
  codex.later = (fn) => { queued.push(fn); return { unref() {} } }
  try {
    const r1 = await codex.codexSummary()
    assert.equal(r1.changed, 400)
    assert.equal(r1.deferred, true, '首轮预算用尽')
    assert.equal(queued.length, 1, 'deferred 时排了一次补扫')
    queued.shift()()
    // 补扫是异步 kickScan，轮询等它把 deferred 清掉（首帧可能是补扫前的旧快照）
    const r2 = await waitSnap(5000, (s) => !s.deferred)
    assert.ok(r2 && r2.ok, '补扫完成')
    assert.equal(r2.deferred, false, '补扫后不再 deferred')
    assert.equal(r2.totalTokens, 40100, '补扫把 deferred 的那个文件补上了')
  } finally {
    codex.later = realLater
  }
})

test('clearCodexCache 连快照一起清，下次同步入口回到 null', async () => {
  freshStart()
  writeSession('rollout-a.jsonl', { turns: 2, step: 100 })
  await codex.codexSummary()
  assert.ok(codex.codexSummaryCached())
  codex.clearCodexCache()
  assert.equal(codex.codexSummaryCached(), null, '快照也清了（不能只是清 dbStorage）')
})

test('onCodexSnapshot 退订后不再收到回调', async () => {
  freshStart()
  writeSession('rollout-a.jsonl', { turns: 2, step: 100 })
  let n = 0
  const off = codex.onCodexSnapshot(() => { n++ })
  off()
  await codex.codexSummary()
  assert.equal(n, 0)
})
