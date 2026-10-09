/*
 * holidays.js 单测（node --test，零依赖）。
 *
 * 这个模块是节假日的「运行时联网覆盖层」：内置表 CN_HOLIDAYS ∪ 用户手动拉取的覆盖层。
 * 判定错一天的后果不显眼 —— 只会把某天的钱按峰价/谷价算错，不报错：
 *   · isHoliday 写漏覆盖层 → 用户点了「更新」也不生效（白拉）
 *   · update 合并写错（覆盖而非并集）→ 拉到次年天数把当年内置日子顶掉，判定倒退
 *   · 失败分支吞掉了却返回 ok:true → 设置页显示「已更新」实际没辙
 *
 * 环境：落盘走 utools.dbStorage（内存桩）。联网走注入的 globalThis.fetch 桩，CI 上同样跑，
 * 不碰真实网络与真实用户数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// ── utools 桩：内存 dbStorage ──
const store = new Map()
globalThis.utools = {
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  },
}

const require = createRequire(import.meta.url)
const holidays = require('../public/preload/lib/holidays.js')
const { K, CN_HOLIDAYS } = require('../public/preload/lib/constants.js')

const { isHoliday, coveredYears, update, clear, status, snapshot, restore, SOURCES, SPAN, _resetCache } = holidays

// 每个用例前后都清内存缓存 + 存储，避免相互串味
function reset() {
  store.clear()
  _resetCache()
}
test.beforeEach(reset)
test.afterEach(reset)

// 造一个「某年放假日子」的源响应体（结构对齐 vsme/chinese-days 的 years/*.json）
function yearBody(dates) {
  const obj = {}
  for (const d of dates) obj[d] = '假,holiday,holiday'
  return { holidays: obj, workdays: {}, inLieuDays: {} }
}

// 用一次 in-memory fetch 桩包住一段逻辑，跑完还原真实 fetch
async function withFetch(fn, impl) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

// ── isHoliday：内置 ∪ 覆盖层 ────────────────────────────────────────────────

test('isHoliday：内置表内的日子直接命中（无需任何存储/网络）', () => {
  const someBuiltin = [...CN_HOLIDAYS][0]
  assert.equal(isHoliday(someBuiltin), true)
  assert.equal(isHoliday('1999-01-01'), false, '表外日子不该误判为节假日')
})

test('isHoliday：覆盖层里的日子也算节假日（用户点了更新要生效）', async () => {
  store.set(K.cnHolidays, { fetchedAt: 1, dates: ['2030-01-01', '2030-01-02'] })
  _resetCache()
  assert.equal(isHoliday('2030-01-01'), true)
  assert.equal(isHoliday('2030-01-03'), false)
})

test('isHoliday：覆盖层存的是垃圾（非数组）时退化为只认内置表，不抛', () => {
  store.set(K.cnHolidays, { dates: 'not-an-array' })
  _resetCache()
  const someBuiltin = [...CN_HOLIDAYS][0]
  assert.equal(isHoliday(someBuiltin), true)
  assert.equal(isHoliday('2030-01-01'), false)
})

test('isHoliday：覆盖层日期格式非法的条目被丢弃（防止脏数据参与判定）', () => {
  store.set(K.cnHolidays, { fetchedAt: 1, dates: ['2030-1-1', 'garbage', '2030-01-01'] })
  _resetCache()
  assert.equal(isHoliday('2030-01-01'), true, '合法条目照常生效')
  assert.equal(isHoliday('2030-1-1'), false, '非法格式不参与判定')
})

// ── coveredYears：跨年兜底判据 ──────────────────────────────────────────────

test('coveredYears：覆盖层里的年份被并进集合（跨年兜底看的就是它）', () => {
  store.set(K.cnHolidays, { fetchedAt: 1, dates: ['2031-02-01', '2031-02-02'] })
  _resetCache()
  assert.equal(coveredYears().has('2031'), true)
})

// ── update：联网拉取 ───────────────────────────────────────────────────────

test('update：主源可用时不惊动备源，落盘并进入覆盖层', async () => {
  const tried = []
  const r = await withFetch(async () => {
    return update(Date.UTC(2030, 0, 15, 0, 0) / 1000)
  }, async (url) => {
    tried.push(url)
    return { ok: true, json: async () => yearBody(['2030-01-01', '2030-05-01']) }
  })
  assert.equal(r.ok, true)
  assert.ok(r.total >= 2)
  assert.equal(tried[0], SOURCES[0](2030), '必须按序先试主源')
  assert.equal(tried.filter((u) => u === SOURCES[0](2030)).length, 1, '主源成功，当年只打一次')
  assert.ok(isHoliday('2030-01-01'), '拉到的日子要生效')
})

test('update：主源失败时回退备源，结果不受影响', async () => {
  const tried = []
  const r = await withFetch(async () => {
    return update(Date.UTC(2030, 0, 15, 0, 0) / 1000)
  }, async (url) => {
    tried.push(url)
    if (url === SOURCES[0](2030) || url === SOURCES[0](2031)) throw new Error('fetch failed')
    return { ok: true, json: async () => yearBody(['2030-01-01']) }
  })
  assert.equal(r.ok, true)
  assert.ok(tried.includes(SOURCES[1](2030)), '主源失败后要换到备源')
})

test('update：全部源失败时 ok:false 且不抛（设置页据此提示失败）', async () => {
  const r = await withFetch(async () => {
    return update(Date.UTC(2030, 0, 15, 0, 0) / 1000)
  }, async () => { throw new Error('fetch failed') })
  assert.equal(r.ok, false)
  assert.ok(r.error, '失败要带原因，不能静默')
  assert.equal(isHoliday('2030-01-01'), false, '没拉到就什么都别写')
})

test('update：HTTP 非 2xx 视为该源失败（5xx 不能被当成成功）', async () => {
  let hits = 0
  const r = await withFetch(async () => {
    return update(Date.UTC(2030, 0, 15, 0, 0) / 1000)
  }, async (url) => {
    hits++
    if (url.startsWith('https://cdn.jsdelivr.net')) return { ok: false, status: 503, json: async () => ({}) }
    return { ok: true, json: async () => yearBody(['2030-01-01']) }
  })
  assert.equal(r.ok, true, '备源可用时仍要成功')
  assert.ok(hits >= 2, '503 不该被当成成功而短路')
})

test('update：返回结构缺 holidays 时视为该源失败，不把空表写进去', async () => {
  const r = await withFetch(async () => {
    return update(Date.UTC(2030, 0, 15, 0, 0) / 1000)
  }, async () => ({ ok: true, json: async () => ({ foo: 1 }) }))
  assert.equal(r.ok, false)
})

// ── 合并语义：纯加法（并集），不反向删 ──────────────────────────────────────

test('update：与已有覆盖层是并集（本次没覆盖到的旧年份不被顶掉）', async () => {
  // 先塞一条「更早年份」的旧记录
  store.set(K.cnHolidays, { fetchedAt: 1, dates: ['2029-01-01'] })
  _resetCache()

  const r = await withFetch(async () => {
    return update(Date.UTC(2030, 0, 15, 0, 0) / 1000)
  }, async () => ({ ok: true, json: async () => yearBody(['2030-01-01']) }))

  assert.equal(r.ok, true)
  assert.ok(isHoliday('2029-01-01'), '旧年份条目必须保留（纯加法，不反向删）')
  assert.ok(isHoliday('2030-01-01'), '本次拉到的也要在')
})

test('update：拉到的年份进入覆盖层，coveredYears 随之上账', async () => {
  await withFetch(async () => {
    return update(Date.UTC(2030, 0, 15, 0, 0) / 1000)
  }, async () => ({ ok: true, json: async () => yearBody(['2030-01-01', '2031-01-01']) }))
  assert.equal(coveredYears().has('2030'), true)
  assert.equal(coveredYears().has('2031'), true)
})

// ── clear / status ─────────────────────────────────────────────────────────

test('clear：清掉覆盖层后回到纯内置表', async () => {
  await withFetch(async () => {
    return update(Date.UTC(2030, 0, 15, 0, 0) / 1000)
  }, async () => ({ ok: true, json: async () => yearBody(['2030-01-01']) }))
  assert.ok(isHoliday('2030-01-01'))

  clear()
  assert.equal(isHoliday('2030-01-01'), false, '清空后拉到的日子不再算节假日')
  const someBuiltin = [...CN_HOLIDAYS][0]
  assert.equal(isHoliday(someBuiltin), true, '内置表不受清除影响')
  assert.equal(status().updated, false)
})

test('status：无覆盖层时 updated:false 并带出内置年份', () => {
  const s = status()
  assert.equal(s.updated, false)
  assert.ok(Array.isArray(s.builtinYears) && s.builtinYears.length > 0)
})

test('status：有覆盖层时带出年份、总数与拉取时间', async () => {
  await withFetch(async () => {
    return update(Date.UTC(2030, 0, 15, 0, 0) / 1000)
  }, async () => ({ ok: true, json: async () => yearBody(['2030-01-01', '2030-01-02']) }))
  const s = status()
  assert.equal(s.updated, true)
  assert.ok(s.total >= 2)
  assert.ok(s.years.includes('2030'))
  assert.ok(s.fetchedAt > 0)
})

// ── snapshot / restore：备份与恢复用 ────────────────────────────────────────
//
// 这两个接口只服务于「备份 / 恢复」链路：snapshot 把覆盖层原样带出去，restore 把备份里的
// 覆盖层写回。它们的坑都落在「形状校验」上 —— 备份文件可能来自旧版本或被手改过，脏数据
// 一旦写进覆盖层，会静默污染峰谷判定，所以 restore 必须「校验不过就返回 false、不落盘」。

test('snapshot：无覆盖层时返回 null（备份据此标注不含此项）', () => {
  assert.equal(snapshot(), null)
})

test('snapshot：有覆盖层时原样带出存储里的载荷', () => {
  const payload = { fetchedAt: 123, dates: ['2030-01-01', '2030-01-02'], years: ['2030'] }
  store.set(K.cnHolidays, payload)
  _resetCache()
  assert.deepEqual(snapshot(), payload)
})

test('restore：合法载荷写回存储并立即可判（备份恢复要立刻生效）', () => {
  const ok = restore({ fetchedAt: 456, dates: ['2031-01-01', '2030-12-31'] })
  assert.equal(ok, true)
  assert.equal(isHoliday('2031-01-01'), true, '恢复后拉到日子应立刻算节假日')
  assert.equal(isHoliday('2030-12-31'), true)
  // 落盘为规范化后的载荷：日期升序、年份去重升序
  const raw = store.get(K.cnHolidays)
  assert.deepEqual(raw.dates, ['2030-12-31', '2031-01-01'])
  assert.deepEqual(raw.years, ['2030', '2031'])
  assert.equal(raw.fetchedAt, 456)
})

test('restore：非法载荷返回 false 且不落盘（脏备份不能污染判定）', () => {
  for (const bad of [null, undefined, {}, { dates: 'x' }, { dates: [] }, { dates: [123] }, { dates: ['not-a-date'] }]) {
    store.clear()
    _resetCache()
    assert.equal(restore(bad), false, `非法载荷应被拒：${JSON.stringify(bad)}`)
    assert.equal(store.has(K.cnHolidays), false, '拒绝时必须不写存储')
    assert.equal(isHoliday('2031-01-01'), false, '拒绝后覆盖层不应被污染')
  }
})

test('restore：混入非法日期时丢弃脏条目、只保留合法日期', () => {
  const ok = restore({ fetchedAt: Date.now(), dates: ['2031-01-01', 'not-a-date', 42, '2031-01-02'] })
  assert.equal(ok, true)
  const raw = store.get(K.cnHolidays)
  assert.deepEqual(raw.dates, ['2031-01-01', '2031-01-02'])
})

// ── 默认零网络：被动路径绝不触网 ────────────────────────────────────────────
//
// 「默认零网络」是本模块对用户的承诺（README / 设置页都这么写），只能靠「没人调用 update」
// 来保证 —— 一旦哪天有人在启动路径 / 判定路径上顺手加了 update()，用户会在毫不知情时被联网。
// 所以这里不看源码，而是把 fetch 换成「一被调就抛」的哨兵，跑一遍所有被动入口：
// 加载模块、判日、问年份、查状态、写脏存储后重读 —— 全程不该有任何一次请求。
test('零网络：被动路径（加载/判定/status）一次 fetch 都不发', () => {
  const real = globalThis.fetch
  const sentinel = new Proxy(real, {
    apply() { throw new Error('被动路径触网了（默认零网络被破坏）') },
  })
  // 模块已在文件顶部 require 过，这里再 require 一次拿缓存引用，验证「加载即定义」不触网
  globalThis.fetch = sentinel
  try {
    const again = require('../public/preload/lib/holidays.js')
    assert.equal(again, holidays, 'require 只加载定义、不发请求')

    // 判定：内置命中 / 表外 / 覆盖层命中，三种都不该联网
    _resetCache()
    const someBuiltin = [...CN_HOLIDAYS][0]
    assert.equal(again.isHoliday(someBuiltin), true)
    assert.equal(again.isHoliday('1999-01-01'), false)

    store.set(K.cnHolidays, { fetchedAt: 1, dates: ['2030-01-01'] })
    _resetCache()
    assert.equal(again.isHoliday('2030-01-01'), true)

    // 年份覆盖 / 状态查询：纯读，也不该联网
    assert.equal(typeof again.coveredYears().has, 'function')
    assert.doesNotThrow(() => again.status())

    // 脏存储（非数组）触发的退化分支同样走不到网络
    store.set(K.cnHolidays, { dates: 'garbage' })
    _resetCache()
    assert.equal(again.isHoliday(someBuiltin), true)
    assert.doesNotThrow(() => again.status())
  } finally {
    globalThis.fetch = real
  }
})

test('零网络：clear 只清本地，不发请求', () => {
  store.set(K.cnHolidays, { fetchedAt: 1, dates: ['2030-01-01'] })
  _resetCache()
  let called = 0
  return withFetch(() => {
    const r = clear()
    assert.equal(r.ok, true)
    assert.equal(called, 0, 'clear 是纯本地操作，不该发任何请求')
    assert.equal(isHoliday('2030-01-01'), false)
  }, async () => { called++; throw new Error('clear 不该触网') })
})

// ── 源码常量契约 ───────────────────────────────────────────────────────────

test('SOURCE / SPAN 契约：至少两个源、跨度覆盖「当年 + 次年」', () => {
  assert.ok(SOURCES.length >= 2, '单源抖动就整条废，至少要有主源 + 备源')
  assert.equal(typeof SOURCES[0], 'function', '源是函数（按年份拼 URL）')
  assert.equal(SPAN, 2, '拉取跨度固定为当年 + 次年，用于提前填跨年空窗')
})
