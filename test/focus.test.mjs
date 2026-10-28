/*
 * focus.js 的单测（node --test，零依赖，无需 utools 桩）。
 *
 * 这里全是「不抛错的算」：日期键非法只会让这一轮静默丢掉，裁剪写错会抹掉用户的专注历史，
 * 汇总写错会让设置页的柱状图与总数对不上。所以边界（非法日期 / 跨天 / 窗口两端 / 连续天数）都要钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import focus from '../public/preload/lib/focus.js'

const { emptyFocus, recordRound, pruneFocus, summarize, keyToMs, msToKey } = focus

// 固定「今天」，避免测试跨零点飘（UTC 运算，与 focus.js 内部口径一致）
const TODAY = '2026-10-26'

test('keyToMs / msToKey：合法日期往返，非法日期一律 NaN', () => {
  assert.equal(msToKey(keyToMs(TODAY)), TODAY)
  assert.equal(msToKey(keyToMs('2024-02-29')), '2024-02-29') // 闰日合法
  for (const bad of ['', null, undefined, '2026-2-3', '2026-02-31', '2023-02-29', '2026-13-01', 'abc', 20261026]) {
    assert.ok(Number.isNaN(keyToMs(bad)), `${String(bad)} 应判非法`)
  }
})

test('emptyFocus：每次都是新的空壳（不能共享同一个 days 对象）', () => {
  const a = emptyFocus()
  const b = emptyFocus()
  assert.deepEqual(a, { days: {} })
  a.days['2026-10-26'] = { r: 1, m: 25 }
  assert.deepEqual(b, { days: {} })
})

test('recordRound：同一天累加，分钟取整并夹在 0–1440', () => {
  const one = recordRound(emptyFocus(), TODAY, 25)
  assert.deepEqual(one.days[TODAY], { r: 1, m: 25 })
  const two = recordRound(one, TODAY, 25)
  assert.deepEqual(two.days[TODAY], { r: 2, m: 50 })
  // 非法分钟按 0 记，轮次照样 +1（用户确实完成了一轮，只是没拿到时长）
  const bad = recordRound(two, TODAY, 'abc')
  assert.deepEqual(bad.days[TODAY], { r: 3, m: 50 })
  assert.deepEqual(recordRound(emptyFocus(), TODAY, -10).days[TODAY], { r: 1, m: 0 })
  assert.deepEqual(recordRound(emptyFocus(), TODAY, 99999).days[TODAY], { r: 1, m: 1440 })
  assert.deepEqual(recordRound(emptyFocus(), TODAY, 24.6).days[TODAY], { r: 1, m: 25 })
})

test('recordRound：不原地改入参；非法日期键只回拷贝、不加新键', () => {
  const src = emptyFocus()
  const out = recordRound(src, TODAY, 25)
  assert.deepEqual(src, { days: {} }) // 写失败时内存与存储不能不一致
  assert.notEqual(out, src)
  const bad = recordRound({ days: { [TODAY]: { r: 1, m: 10 } } }, '2026-02-31', 25)
  assert.deepEqual(bad.days, { [TODAY]: { r: 1, m: 10 } })
})

test('recordRound：state 是脏数据时按空壳起步', () => {
  for (const dirty of [null, undefined, 'x', {}, { days: [] }, { days: null }]) {
    assert.deepEqual(recordRound(dirty, TODAY, 10).days[TODAY], { r: 1, m: 10 })
  }
  // 某天存的是非对象（历史脏数据）→ 当天从 0 起算，不炸
  const fixed = recordRound({ days: { [TODAY]: 42 } }, TODAY, 10)
  assert.deepEqual(fixed.days[TODAY], { r: 1, m: 10 })
})

test('pruneFocus：保留含今天的 keepDays 天窗口，越界 / 未来 / 脏项全裁掉', () => {
  const state = {
    days: {
      '2026-10-26': { r: 1, m: 25 }, // 今天，保留
      '2026-10-27': { r: 1, m: 25 }, // 未来（系统时间被改过），裁
      '2026-10-20': { r: 2, m: 50 }, // 窗口内，保留
      '2026-07-29': { r: 1, m: 25 }, // 今天 - 89 天，保留（90 天窗口的最后一格）
      '2026-07-28': { r: 1, m: 25 }, // 今天 - 90 天，裁
      'abc': { r: 1, m: 25 },        // 非法键，裁
      '2026-10-19': null,            // 非对象，裁
      '2026-10-18': { r: 0, m: 0 },  // 空壳，裁
      '2026-10-17': { r: 'x', m: -5 }, // 归零后是空壳，裁
    },
  }
  const out = pruneFocus(state, TODAY, 90)
  assert.deepEqual(Object.keys(out.days).sort(), ['2026-07-29', '2026-10-20', '2026-10-26'])
})

test('pruneFocus：keepDays 非法 / 0 按 90 处理、负数按 1 天下限；todayKey 非法时原样拷贝不删历史', () => {
  const old = { days: { '2020-01-01': { r: 1, m: 25 } } }
  assert.deepEqual(pruneFocus(old, TODAY, 'abc'), { days: {} }) // 默认 90 天窗口，2020 年该裁
  assert.deepEqual(pruneFocus(old, TODAY, 0), { days: {} })     // 0 与非法同义，回 90 天窗口
  const two = { days: { [TODAY]: { r: 1, m: 25 }, '2026-10-25': { r: 1, m: 25 } } }
  assert.deepEqual(Object.keys(pruneFocus(two, TODAY, -5).days), [TODAY]) // 下限 1 天
  const keep = pruneFocus({ days: { '2020-01-01': { r: 1, m: 25 } } }, 'bad', 90)
  assert.deepEqual(keep.days, { '2020-01-01': { r: 1, m: 25 } }) // 判不了「今天」就别删
})

test('summarize：series 升序补零、today 取最后一格、total 只算窗口内', () => {
  const state = {
    days: {
      '2026-10-26': { r: 2, m: 50 },
      '2026-10-24': { r: 1, m: 25 },
      '2026-09-01': { r: 9, m: 900 }, // 窗口外，不计入 total
    },
  }
  const s = summarize(state, TODAY, 7)
  assert.equal(s.series.length, 7)
  assert.equal(s.series[0].date, '2026-10-20')
  assert.equal(s.series[6].date, TODAY)
  assert.deepEqual(s.today, { r: 2, m: 50 })
  assert.deepEqual(s.total, { r: 3, m: 75 })
  // 中间没记录的天补 0
  assert.deepEqual(s.series[4], { date: '2026-10-24', r: 1, m: 25 })
  assert.deepEqual(s.series[5], { date: '2026-10-25', r: 0, m: 0 })
})

test('summarize：连续天数 —— 今天没记录从昨天数，断档即停', () => {
  const state = {
    days: {
      '2026-10-26': { r: 1, m: 25 },
      '2026-10-25': { r: 1, m: 25 },
      '2026-10-23': { r: 1, m: 25 }, // 10-24 断档
    },
  }
  assert.equal(summarize(state, TODAY, 7).streak, 2)
  // 今天还没开始专注（早上打开设置页）→ 从昨天数，不该显示 0
  const morning = { days: { '2026-10-25': { r: 1, m: 25 }, '2026-10-24': { r: 1, m: 25 } } }
  assert.equal(summarize(morning, TODAY, 7).streak, 2)
  // 昨天也没有 → 0
  assert.equal(summarize({ days: { '2026-10-24': { r: 1, m: 25 } } }, TODAY, 7).streak, 0)
})

test('summarize：days 夹在 1–366（0 / 非法回默认 7）；todayKey 非法时回空结果而不是抛错', () => {
  assert.equal(summarize(emptyFocus(), TODAY, 0).series.length, 7) // 0 与非法同义，回默认 7 天
  assert.equal(summarize(emptyFocus(), TODAY, 9999).series.length, 366)
  assert.equal(summarize(emptyFocus(), TODAY, 'abc').series.length, 7)
  assert.deepEqual(summarize({ days: { [TODAY]: { r: 1, m: 25 } } }, 'bad', 7), {
    series: [], today: { r: 0, m: 0 }, total: { r: 0, m: 0 }, streak: 0,
  })
})
