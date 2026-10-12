/*
 * dsh-usage.js 的单测（node --test，零依赖）。
 *
 * 这个模块只读 $DSH_HOME 下的本地文件、不联网、不要凭据，所以测试里用 mkdtemp 造 fake home
 * + 覆盖 process.env.DSH_HOME 即可全流程跑通；utools 只需要 dbStorage（缓存）+ getPath（log.js）。
 *
 * 盯的是三处「写错不报错、只会把数字算歪」的静默逻辑：
 *   1. 两个数据源的口径互斥 —— 账本有数据就用账本、否则回落会话聚合，**绝不混加**
 *      （混加 = 同一批 token 被算两遍，总量翻倍且全程无日志）
 *   2. 会话缓存的增量指纹只绑 size/mtime 时，文件**被删除**要能清掉陈旧条目 ——
 *      否则旧会话的 token 会永远留在总量里（数字偏大且无从察觉）
 *   3. 近 31 天明细必须**新→旧**排在数组开头（索引 0 是今天），设置页靠 slice(0, N) 切档；
 *      写成 slice(-N) 会取到最旧的 N 天 —— 切档不重扫，用户看到的是「越选越回头」的曲线
 *
 * 时间相关：dayKeyFromTs 按本地时区归日，且 summary 有 5s memo。固定时间戳会跟机器时钟错位，
 * 所以全部用 Date.now() 相对值 + 「往前拨时钟」突破 memo（与 codex.test.mjs 同范式）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── utools 桩：dbStorage（缓存 whale:dshUsage）+ getPath（log.js 取临时目录）──
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
const usage = require('../public/preload/lib/dsh-usage.js')
const { K } = require('../public/preload/lib/constants.js')

// ── 夹具 ──
let tmpRoot = ''
function makeHome() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dshusage-'))
  return tmpRoot
}
function cleanup() {
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {} tmpRoot = '' }
}
// 本地时区的今天 / 任意相对天数（模块按本地归日，写死日期会跟机器时钟错位）
function localDay(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000)
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}
// 某本地日 12:00 的时间戳：保证 dayKeyFromTs(ts) 归到那一天（用 00:00 会被 ±12h 时区翻到前一天）
function noonTs(dayStr) {
  return new Date(dayStr + 'T12:00:00').getTime()
}
function writeLedger(home, days) {
  const dir = path.join(home, 'dsh-usage')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'usage-ledger.json'), JSON.stringify({ version: 1, days }))
}
function writeSnapshots(home, obj) {
  const dir = path.join(home, 'dsh-usage')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'provider-snapshots.json'), JSON.stringify(obj))
}
// 会话缓存文件：只造 record.rows.<k>.val 这几条模块真正读的路径，尽量贴近 dsh 真实结构
function writeSession(home, name, opts = {}) {
  const {
    at = Date.now(), lastUsedModel, pendingModel, cuModel, provider,
    uncachedInputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0,
    costInput, costCacheRead, costCacheWrite, costOutput, reasoning = 0, cost = 0, turns = 0,
  } = opts
  const rows = {
    tokenUsage: {
      val: {
        totals: {
          uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens,
        },
      },
    },
    costUsage: {
      val: {
        provider,
        model: cuModel,
        totals: {
          input: costInput, cacheRead: costCacheRead, cacheWrite: costCacheWrite,
          output: costOutput, reasoning, cost,
        },
      },
    },
    sessionStats: { val: { turns } },
  }
  if (lastUsedModel || pendingModel) {
    rows.modelSelection = { val: { lastUsed: lastUsedModel ? { model: lastUsedModel } : undefined, pending: pendingModel ? { model: pendingModel } : undefined } }
  }
  const rec = { identity: { createdAt: at }, rows }
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify({ record: rec }))
  return file
}
// 每个用例前清缓存 + 造新 home + 复位时钟；summary 有 5s memo，用「往前拨时钟」绕过
let clockOffset = 0
const realNow = Date.now.bind(Date)
function freshStart() {
  store.clear()
  usage.clearDshUsageCache()
  clockOffset = 0
  Date.now = () => realNow() + clockOffset
  process.env.DSH_HOME = makeHome()
}
function nextRound() {
  clockOffset += 6000
  Date.now = () => realNow() + clockOffset
}

test.afterEach(() => {
  Date.now = realNow
  delete process.env.DSH_HOME
  cleanup()
})

// ── 数据目录定位 ──
test('dshHome 认 $DSH_HOME；未设时回落到家目录下 .dsh（可能不存在则返回空串）', () => {
  process.env.DSH_HOME = os.tmpdir()
  assert.equal(usage.dshHome(), os.tmpdir())
})

// ── 空数据 ──
test('没有账本也没有会话缓存时返回 none，day31 全零', () => {
  freshStart()
  const r = usage.dshUsageSummary()
  assert.equal(r.ok, true)
  assert.equal(r.source, 'none')
  assert.equal(r.totalTokens, 0)
  assert.equal(r.todayTokens, 0)
  assert.equal(r.turns, 0)
  assert.equal(r.days31.length, 31)
  assert.equal(r.days31[0].date, localDay(0))
  assert.ok(r.days31.every((d) => d.tokens === 0 && d.cost === 0))
  assert.equal(Object.keys(r.byModel).length, 0)
  assert.match(r.note, /都没有用量记录/)
})

test('$DSH_HOME 指向不存在的目录时回落到家目录 .dsh（存在则用、不存在才 ok:false）', () => {
  freshStart()
  process.env.DSH_HOME = path.join(os.tmpdir(), 'whale-nonexistent-' + Date.now())
  const r = usage.dshUsageSummary()
  // 回落候选是 os.homedir()/.dsh：本机若装了 dsh 就存在（返回 ok:true），否则 ok:false。
  // 两条路径都合法，这里钉的是「不会因为 DSH_HOME 失效而抛错」这一契约。
  const realDsh = path.join(os.homedir(), '.dsh')
  if (fs.existsSync(realDsh)) {
    assert.equal(r.ok, true)
    assert.equal(r.home, realDsh)
  } else {
    assert.equal(r.ok, false)
    assert.match(r.error, /dsh 数据目录/)
  }
})

// ── 数据源 1：账本 ──
test('账本口径：按天×模型累加，turns 用 calls 且标签为「次调用」', () => {
  freshStart()
  const home = process.env.DSH_HOME
  const today = localDay(0)
  writeLedger(home, {
    [today]: {
      deepseek: {
        'deepseek-chat': { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 30, reasoningTokens: 7, calls: 3, cost: 1.5 },
        'deepseek-reasoner': { inputTokens: 10, outputTokens: 40, calls: 1, cost: 0.5 },
      },
    },
  })
  const r = usage.dshUsageSummary()
  assert.equal(r.source, 'ledger')
  assert.equal(r.turnsLabel, '次调用')
  // 总量 = 每个模型的 (input + cacheRead + cacheWrite + output)
  assert.equal(r.totalTokens, 100 + 20 + 5 + 30 + 10 + 40)
  assert.equal(r.todayTokens, r.totalTokens)
  assert.equal(r.monthTokens, r.totalTokens)
  assert.equal(r.turns, 4)
  assert.equal(r.inTokens, 110)
  assert.equal(r.cachedTokens, 25)
  assert.equal(r.outTokens, 70)
  assert.equal(r.reasonTokens, 7)
  assert.equal(r.costTotal, 2)
  assert.equal(r.costToday, 2)
  assert.equal(r.costCurrency, 'CNY')
  assert.equal(r.byModel['deepseek-chat'].tokens, 155)
  assert.equal(r.byModel['deepseek-chat'].reason, 7)
})

test('账本只有空 days 对象时视为无数据 → 回落 none（不误判为 ledger）', () => {
  freshStart()
  writeLedger(process.env.DSH_HOME, {})
  const r = usage.dshUsageSummary()
  assert.equal(r.source, 'none')
})

test('账本 JSON 损坏时静默回落（不抛错、不误当 ledger）', () => {
  freshStart()
  const dir = path.join(process.env.DSH_HOME, 'dsh-usage')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'usage-ledger.json'), '{ 这不是合法 JSON')
  const r = usage.dshUsageSummary()
  assert.equal(r.ok, true)
  assert.equal(r.source, 'none')
})

// ── 数据源 2：会话聚合 ──
test('会话口径：tokenUsage 有效时按会话创建日聚合，calls 取 sessionStats.turns', () => {
  freshStart()
  const home = process.env.DSH_HOME
  const yesterday = localDay(-1)
  writeSession(home, 's1.json', {
    at: noonTs(yesterday), lastUsedModel: 'deepseek-chat', provider: 'deepseek',
    uncachedInputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 80, reasoning: 9, cost: 1.25, turns: 4,
  })
  const r = usage.dshUsageSummary()
  assert.equal(r.source, 'sessions')
  assert.equal(r.turnsLabel, '轮')
  assert.equal(r.totalTokens, 200 + 50 + 80)
  assert.equal(r.todayTokens, 0) // 记在昨天
  assert.equal(r.monthTokens, 330)
  assert.equal(r.turns, 4)
  assert.equal(r.reasonTokens, 9)
  assert.match(r.note, /按会话缓存聚合/)
  assert.equal(r.sessions, 1)
  assert.equal(r.activeSessions, 1)
  assert.equal(r.days31.find((d) => d.date === yesterday).tokens, 330)
})

test('会话口径：tokenUsage 全 0 时退回 costUsage 的同类字段（兜底口径）', () => {
  freshStart()
  writeSession(process.env.DSH_HOME, 's1.json', {
    at: Date.now(), lastUsedModel: 'deepseek-chat',
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    costInput: 11, costCacheRead: 3, costCacheWrite: 2, costOutput: 5, turns: 2,
  })
  const r = usage.dshUsageSummary()
  assert.equal(r.totalTokens, 11 + 3 + 2 + 5)
  assert.equal(r.byModel['deepseek-chat'].in, 11)
  assert.equal(r.byModel['deepseek-chat'].cached, 5)
  assert.equal(r.byModel['deepseek-chat'].out, 5)
})

test('两源都在时账本优先，绝不混加（会话里的 token 被忽略）', () => {
  freshStart()
  const home = process.env.DSH_HOME
  const today = localDay(0)
  writeLedger(home, { [today]: { deepseek: { 'deepseek-chat': { inputTokens: 100, outputTokens: 0, calls: 1 } } } })
  writeSession(home, 's1.json', { at: Date.now(), lastUsedModel: 'deepseek-chat', uncachedInputTokens: 999, outputTokens: 999, turns: 1 })
  const r = usage.dshUsageSummary()
  assert.equal(r.source, 'ledger')
  assert.equal(r.totalTokens, 100) // 不是 100 + 1998
  assert.equal(r.sessions, 1) // 会话仍被扫描（只是不参与累加）
})

// ── 模型名回退链 ──
test('模型名：lastUsed 优先，其次 pending，再次 costUsage.model，全空/为 default 时回落 dsh', () => {
  freshStart()
  const home = process.env.DSH_HOME
  writeSession(home, 'a.json', { at: Date.now(), lastUsedModel: 'A', pendingModel: 'B', cuModel: 'C', uncachedInputTokens: 1 })
  writeSession(home, 'b.json', { at: Date.now(), pendingModel: 'B', cuModel: 'C', uncachedInputTokens: 1 })
  writeSession(home, 'c.json', { at: Date.now(), cuModel: 'C', uncachedInputTokens: 1 })
  writeSession(home, 'd.json', { at: Date.now(), lastUsedModel: 'default', uncachedInputTokens: 1 })
  writeSession(home, 'e.json', { at: Date.now(), uncachedInputTokens: 1 })
  const r = usage.dshUsageSummary()
  assert.ok(r.byModel.A)
  assert.ok(r.byModel.B)
  assert.ok(r.byModel.C)
  assert.ok(r.byModel.dsh) // 'default' 不采用 → dsh；无模型名也 → dsh
})

// ── 31 天明细方向 ──
test('days31 新→旧：索引 0 是今天，索引 1 是昨天，末位是 30 天前', () => {
  freshStart()
  const home = process.env.DSH_HOME
  writeLedger(home, {
    [localDay(0)]: { p: { m: { inputTokens: 10 } } },
    [localDay(-1)]: { p: { m: { inputTokens: 20 } } },
    [localDay(-30)]: { p: { m: { inputTokens: 30 } } },
    [localDay(-31)]: { p: { m: { inputTokens: 40 } } }, // 超出 31 天窗口，不进 days31
  })
  const r = usage.dshUsageSummary()
  assert.equal(r.days31[0].date, localDay(0))
  assert.equal(r.days31[0].tokens, 10)
  assert.equal(r.days31[1].date, localDay(-1))
  assert.equal(r.days31[1].tokens, 20)
  assert.equal(r.days31[30].date, localDay(-30))
  assert.equal(r.days31[30].tokens, 30)
  // 31 天窗口之外的仍进总量，只是不在明细里
  assert.equal(r.totalTokens, 100)
})

// ── 增量缓存 ──
test('两轮之间文件未变 → 复用缓存，changed 为 0', () => {
  freshStart()
  writeSession(process.env.DSH_HOME, 's1.json', { at: Date.now(), lastUsedModel: 'm', uncachedInputTokens: 5 })
  const r1 = usage.dshUsageSummary()
  assert.equal(r1.changed, 1)
  nextRound()
  const r2 = usage.dshUsageSummary()
  assert.equal(r2.changed, 0)
  assert.equal(r2.totalTokens, 5)
})

test('缓存指纹只绑 size/mtime：两者都相同就复用缓存 agg（不再重解析）', () => {
  freshStart()
  const home = process.env.DSH_HOME
  const file = writeSession(home, 's1.json', { at: Date.now(), lastUsedModel: 'm', uncachedInputTokens: 5 })
  const st = fs.statSync(file)
  // 塞一条「size/mtime 与真实文件一致、但 token 数不同」的缓存条目：实现只比 size/mtime，
  // 所以会把这个 agg 当缓存复用 —— 这是当前设计的既定行为（非内容哈希），此处钉住它。
  // 真实 dsh 写会话缓存是新文件/整体重写，size 或 mtime 必然变化，故不构成漏检。
  store.set(K.dshUsage, {
    version: 1,
    files: { [file]: { size: st.size, mtimeMs: st.mtimeMs, agg: { tokens: 9999, inTok: 9999, cached: 0, outTok: 0, reason: 0, turns: 0, cost: 0, at: 0, day: '2000-01-01', model: 'stale', provider: '' } } },
    builtAt: Date.now(),
  })
  const r = usage.dshUsageSummary()
  assert.equal(r.changed, 0) // 指纹命中 → 不重解析
  assert.equal(r.totalTokens, 9999) // 用的是缓存 agg，而非文件里的 5
})

test('文件被删除 → 缓存里的陈旧条目被清掉，不残留 tot alTokens', () => {
  freshStart()
  const home = process.env.DSH_HOME
  const f = writeSession(home, 's1.json', { at: Date.now(), lastUsedModel: 'm', uncachedInputTokens: 7 })
  assert.equal(usage.dshUsageSummary().totalTokens, 7)
  fs.rmSync(f)
  nextRound()
  const r = usage.dshUsageSummary()
  assert.equal(r.totalTokens, 0)
  assert.equal(r.sessions, 0)
})

// ── 余额快照（数据源 3，仅展示）──
test('余额快照取 updatedAt 最新的 provider，两者都没有则 balance 为 null', () => {
  freshStart()
  const home = process.env.DSH_HOME
  writeSnapshots(home, {
    providers: {
      deepseek: { balance: { currency: 'CNY', totalBalance: 10, updatedAt: 1700000000000 } },
      'deepseek-official': { balance: { currency: 'CNY', totalBalance: 20, updatedAt: 1700000001000 } },
    },
    spendWatch: { accruedCny: 3.5, since: 1690000000000, lastBalanceCny: 20 },
  })
  const r = usage.dshUsageSummary()
  assert.equal(r.balance.provider, 'deepseek-official')
  assert.equal(r.balance.amount, 20)
  assert.deepEqual(r.spendWatch, { accruedCny: 3.5, since: 1690000000000, lastBalanceCny: 20 })
})

test('余额快照为空/损坏 → balance 与 spendWatch 均为 null，不影响主统计', () => {
  freshStart()
  const home = process.env.DSH_HOME
  fs.mkdirSync(path.join(home, 'dsh-usage'), { recursive: true })
  fs.writeFileSync(path.join(home, 'dsh-usage', 'provider-snapshots.json'), 'not json at all')
  writeLedger(home, { [localDay(0)]: { p: { m: { inputTokens: 1 } } } })
  const r = usage.dshUsageSummary()
  assert.equal(r.source, 'ledger')
  assert.equal(r.totalTokens, 1)
  assert.equal(r.balance, null)
  assert.equal(r.spendWatch, null)
})

// ── memo 与清缓存 ──
test('5 秒内重复调用走 memo，不重扫文件（changed 不累加）', () => {
  freshStart()
  writeSession(process.env.DSH_HOME, 's1.json', { at: Date.now(), lastUsedModel: 'm', uncachedInputTokens: 3 })
  const r1 = usage.dshUsageSummary()
  assert.equal(r1.changed, 1)
  const r2 = usage.dshUsageSummary() // 同一 5s 窗口
  assert.equal(r2, r1) // 同一引用
})

test('clearDshUsageCache 清掉 memo 与 dbStorage 缓存，下一轮必重解析', () => {
  freshStart()
  writeSession(process.env.DSH_HOME, 's1.json', { at: Date.now(), lastUsedModel: 'm', uncachedInputTokens: 3 })
  usage.dshUsageSummary()
  assert.ok(store.has(K.dshUsage))
  usage.clearDshUsageCache()
  assert.equal(store.has(K.dshUsage), false)
  const r = usage.dshUsageSummary() // 不拨时钟，memo 已清
  assert.equal(r.changed, 1)
  assert.equal(r.totalTokens, 3)
})

// ── 脏数据不炸 ──
test('会话文件缺 record / JSON 损坏时跳过，不影响其它会话', () => {
  freshStart()
  const home = process.env.DSH_HOME
  writeSession(home, 'good.json', { at: Date.now(), lastUsedModel: 'm', uncachedInputTokens: 4 })
  fs.writeFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', 'broken.json'), '{oops')
  fs.writeFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', 'norec.json'), JSON.stringify({ foo: 1 }))
  const r = usage.dshUsageSummary()
  assert.equal(r.totalTokens, 4)
  assert.equal(r.sessions, 3) // 三个 json 文件都被列出
  assert.equal(r.activeSessions, 1)
})

test('账本里字段是字符串/缺字段时按 num() 收敛为 0，不产生 NaN', () => {
  freshStart()
  writeLedger(process.env.DSH_HOME, {
    [localDay(0)]: { p: { m: { inputTokens: 'abc', cacheReadTokens: null, outputTokens: undefined, calls: 'x' } } },
  })
  const r = usage.dshUsageSummary()
  assert.equal(r.totalTokens, 0)
  assert.equal(r.turns, 0)
  assert.ok(Number.isFinite(r.totalTokens))
})
