/*
 * focus.js（会话为唯一事实源）的单测（node --test，零依赖，无需 utools 桩）。
 *
 * 这一层是「算」，出错会同时污染设置页的柱状图、待办的轮数和备份文件，
 * 而且天表一旦从明细派生错，用户重算不出来 —— 所以口径（什么算一轮、什么算分钟、
 * 跨零点归哪天、老数据怎么升级）和边界（非法日期 / 窗口两端 / 脏项）都要钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import focus from '../public/preload/lib/focus.js'

const {
  emptyFocus, withDerived, appendSession, deriveDays, isRound, pruneFocus,
  summarize, roundsByTodo, listSessions, normSessions, localKey, keyToMs, msToKey,
} = focus

// 固定「今天」，避免测试跨零点飘（focus.js 内部相差天数用 UTC 运算，键本身按本地日历取）
const TODAY = '2026-10-26'
// 本地时刻：只用来喂 appendSession 的起止，归属日由 localKey 判，测试不依赖具体时区
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

test('keyToMs / msToKey：合法日期往返，非法日期一律 NaN', () => {
  assert.equal(msToKey(keyToMs(TODAY)), TODAY)
  assert.equal(msToKey(keyToMs('2024-02-29')), '2024-02-29') // 闰日合法
  for (const bad of ['', null, undefined, '2026-2-3', '2026-02-31', '2023-02-29', '2026-13-01', 'abc', 20261026]) {
    assert.ok(Number.isNaN(keyToMs(bad)), `${String(bad)} 应判非法`)
  }
})

test('localKey：按本地日历取键（跨零点的轮次要归到结束那天，靠它而不是 UTC）', () => {
  assert.equal(localKey(at(2026, 10, 26, 9, 45)), TODAY)
  assert.equal(localKey(at(2026, 10, 26, 0, 0)), TODAY)
  assert.equal(localKey(at(2026, 10, 25, 23, 59)), '2026-10-25')
  assert.equal(localKey(at(2026, 2, 29, 12, 0)), '2026-03-01') // 2026 非闰年：Date 自己滚到 3/1，键依然合法
})

test('emptyFocus：v2 空壳，每次都是新对象（不能共享同一个 days / sessions）', () => {
  const a = emptyFocus()
  const b = emptyFocus()
  assert.deepEqual(a, { v: 2, days: {}, sessions: [] })
  a.days[TODAY] = { r: 1, m: 25 }
  a.sessions.push({ id: 'x', d: TODAY, s: 1, t: 2, m: 25, k: 'down' })
  assert.deepEqual(b, { v: 2, days: {}, sessions: [] })
})

// ──────────────────────────────────────────────
// 归一：老形状要能无迁移升级，脏数据要挡在门口
// ──────────────────────────────────────────────
test('normSessions：老形状 {d,t,m} 补成 v2（k=down、s 由结束-时长反推、id 稳定生成）', () => {
  const t = at(2026, 10, 26, 9, 45)
  const [one] = normSessions([{ d: TODAY, t, m: 25 }])
  assert.equal(one.d, TODAY)
  assert.equal(one.t, t)
  assert.equal(one.m, 25)
  assert.equal(one.k, 'down')
  assert.equal(one.s, t - 25 * 60000)
  assert.ok(one.id)
  // 同一条老数据再读一次要得到同一个 id：去重靠它，飘来飘去会让「删一条」变成删两条
  assert.deepEqual(normSessions([{ d: TODAY, t, m: 25 }]), [one])
  assert.equal(normSessions([{ d: TODAY, t, m: 25 }, { d: TODAY, t, m: 25 }]).length, 1)
  assert.equal(isRound(one), true) // 老数据没有休息/放弃标记，一律按合格轮
})

test('normSessions：脏项直接丢，缺日期 / 缺时刻 / 非正分钟都不留行', () => {
  const t = at(2026, 10, 26, 9, 45)
  const bad = [
    null, undefined, 'x', [],
    { d: '', t, m: 25 },            // 无归属日
    { d: '2026-02-31', t, m: 25 },  // 非法日期
    { d: TODAY, t: 0, m: 25 },      // 无结束时刻
    { d: TODAY, t: 'abc', m: 25 },
    { d: TODAY, t, m: 0 },          // 0 分钟：明细里是看不出意义的空行
    { d: TODAY, t, m: -5 },
    { d: TODAY, t, m: 'abc' },
  ]
  assert.deepEqual(normSessions(bad), [])
})

test('normSessions：分钟夹在 1–1440、模式非法回 down、起止倒挂用结束-时长补、文本折叠截断', () => {
  const t = at(2026, 10, 26, 9, 45)
  const one = normSessions([{ d: TODAY, t, m: 99999, k: 'sleep', s: t + 1000, todoId: ' t1 ', todoText: '  写   周报  ' }])[0]
  assert.equal(one.m, 1440)
  assert.equal(one.k, 'down')
  assert.equal(one.s, t - 1440 * 60000) // s 比 t 还晚 → 反推
  assert.equal(one.todoId, 't1')
  assert.equal(one.todoText, '写 周报')
  // 休息 / 放弃只在为真时落键（老数据形状不变、也省存储）
  assert.deepEqual(normSessions([{ d: TODAY, t, m: 5, b: true, a: 1 }])[0].b, 1)
  assert.equal(normSessions([{ d: TODAY, t, m: 5, b: false, a: 0 }])[0].b, undefined)
  assert.equal(normSessions([{ d: TODAY, t, m: 5 }])[0].todoId, undefined)
})

test('normSessions：按结束时刻升序、超上限只留最新，且与输入顺序无关', () => {
  const base = at(2026, 10, 26, 9, 0)
  const mk = (i) => ({ d: TODAY, t: base + i * 1000, m: 25 })
  const asc = normSessions([mk(2), mk(0), mk(1)])
  assert.deepEqual(asc.map((s) => s.t), [base, base + 1000, base + 2000])
  assert.deepEqual(normSessions([mk(1), mk(0), mk(2)]).map((s) => s.t), asc.map((s) => s.t))
  // 2001 条 → 掐头，留最新的 2000 条
  const many = []
  for (let i = 0; i < 2001; i++) many.push(mk(i))
  const kept = normSessions(many)
  assert.equal(kept.length, 2000)
  assert.equal(kept[0].t, base + 1000)
})

// ──────────────────────────────────────────────
// 派生：天表只能是明细的视图
// ──────────────────────────────────────────────
test('isRound：正计时 / 休息 / 放弃都不算一轮，倒计时走完才算', () => {
  const t = at(2026, 10, 26, 9, 45)
  const [down] = normSessions([{ d: TODAY, t, m: 25 }])
  const [up] = normSessions([{ d: TODAY, t: t + 1, m: 25, k: 'up' }])
  const [atMode] = normSessions([{ d: TODAY, t: t + 2, m: 25, k: 'at' }])
  const [brk] = normSessions([{ d: TODAY, t: t + 3, m: 5, b: 1 }])
  const [ab] = normSessions([{ d: TODAY, t: t + 4, m: 10, a: 1 }])
  assert.equal(isRound(down), true)
  assert.equal(isRound(up), false)
  assert.equal(isRound(atMode), false)
  assert.equal(isRound(brk), false)
  assert.equal(isRound(ab), false)
})

test('deriveDays：分钟算所有非休息会话，轮次只算合格轮', () => {
  const t = at(2026, 10, 26, 9, 0)
  const days = deriveDays([
    { d: TODAY, t: t, m: 25 },                        // 合格轮
    { d: TODAY, t: t + 60000, m: 25, k: 'up' },       // 正计时：只加分钟
    { d: TODAY, t: t + 120000, m: 10, a: 1 },         // 放弃：只加分钟
    { d: TODAY, t: t + 180000, m: 5, b: 1 },          // 休息：分钟和轮次都不加
  ], {})
  assert.deepEqual(days[TODAY], { r: 1, m: 60 })
})

test('deriveDays：老日子（只有天表、没有明细）原样保留；某天一旦有明细就以明细为准', () => {
  const t = at(2026, 10, 26, 9, 0)
  const days = deriveDays([{ d: TODAY, t, m: 25 }], {
    '2026-10-25': { r: 3, m: 75 },  // 没有明细 → 保留
    [TODAY]: { r: 9, m: 900 },      // 有明细 → 老聚合作废（否则图和列表永远对不上）
    '2026-02-31': { r: 1, m: 25 },  // 非法键
    '2026-10-24': null,             // 非对象
    '2026-10-23': { r: 0, m: 0 },   // 空壳
  })
  assert.deepEqual(days[TODAY], { r: 1, m: 25 })
  assert.deepEqual(days['2026-10-25'], { r: 3, m: 75 })
  assert.deepEqual(Object.keys(days).sort(), ['2026-10-25', TODAY])
})

test('withDerived：打 v2 标记、不改入参、脏 state 按空壳起步', () => {
  const t = at(2026, 10, 26, 9, 0)
  const src = { days: { [TODAY]: { r: 5, m: 125 } }, sessions: [{ d: TODAY, t, m: 25 }] }
  const out = withDerived(src)
  assert.equal(out.v, 2)
  assert.deepEqual(src, { days: { [TODAY]: { r: 5, m: 125 } }, sessions: [{ d: TODAY, t, m: 25 }] })
  assert.deepEqual(out.days[TODAY], { r: 1, m: 25 }) // 有明细就不认老聚合
  for (const dirty of [null, undefined, 'x', {}, { sessions: 'no' }, { days: [] }]) {
    assert.deepEqual(withDerived(dirty), { v: 2, days: {}, sessions: [] })
  }
})

// ──────────────────────────────────────────────
// 记录：会话是唯一入口
// ──────────────────────────────────────────────
test('appendSession：显式分钟 / 起止反推 / 真实短会话按 1 分钟，天表跟着派生', () => {
  const t = at(2026, 10, 26, 9, 45)
  const explicit = appendSession(emptyFocus(), { endAt: t, minutes: 25 })
  assert.deepEqual(explicit.days[TODAY], { r: 1, m: 25 })
  assert.deepEqual(explicit.sessions, [{
    id: explicit.sessions[0].id, d: TODAY, s: t - 25 * 60000, t, m: 25, k: 'down',
  }])
  const derived = appendSession(emptyFocus(), { endAt: t, startAt: t - 30 * 60000 })
  assert.equal(derived.sessions[0].m, 30)
  assert.equal(derived.sessions[0].s, t - 30 * 60000)
  // 30 秒也是一次真实投入：记 1 分钟而不是丢掉
  const short = appendSession(emptyFocus(), { endAt: t, startAt: t - 30000 })
  assert.equal(short.sessions.length, 1)
  assert.equal(short.sessions[0].m, 1)
})

test('appendSession：结束早于开始 / 没分钟又没起点 = 脏数据，不落会话也不动天表', () => {
  const t = at(2026, 10, 26, 9, 45)
  for (const input of [
    {}, null, undefined, 'x',
    { endAt: 0, minutes: 25 },
    { endAt: 'abc', minutes: 25 },
    { minutes: 25 },                       // 没有结束时刻
    { endAt: t, startAt: t, minutes: 0 },  // 起止相同且没分钟
    { endAt: t, startAt: t + 60000 },      // 结束早于开始
    { endAt: t },                          // 既没分钟也没起点
  ]) {
    const out = appendSession(emptyFocus(), input)
    assert.deepEqual(out.sessions, [], `${JSON.stringify(input)} 不该落会话`)
    assert.deepEqual(out.days, {})
  }
})

test('appendSession：正计时只加分钟不加轮，休息两头都不加，放弃加分钟不加轮', () => {
  const t = at(2026, 10, 26, 9, 0)
  let st = emptyFocus()
  st = appendSession(st, { endAt: t, minutes: 25 })                              // 一轮番茄
  st = appendSession(st, { endAt: t + 60000, minutes: 40, mode: 'up' })          // 正计时 40 分钟
  st = appendSession(st, { endAt: t + 120000, minutes: 5, isBreak: true })       // 休息 5 分钟
  st = appendSession(st, { endAt: t + 180000, minutes: 12, abandoned: true })    // 放弃 12 分钟
  assert.deepEqual(st.days[TODAY], { r: 1, m: 77 })
  assert.deepEqual(st.sessions.map((s) => [s.k, s.m, s.b, s.a]), [
    ['down', 25, undefined, undefined],
    ['up', 40, undefined, undefined],
    ['down', 5, 1, undefined],
    ['down', 12, undefined, 1],
  ])
})

test('appendSession：归属日按结束时刻 —— 跨零点的轮次记在结束那天', () => {
  const end = at(2026, 10, 26, 0, 1)   // 今天 00:01 结束
  const start = end - 25 * 60000       // 昨天 23:36 开始
  assert.equal(localKey(start), '2026-10-25')
  const out = appendSession(emptyFocus(), { endAt: end, startAt: start })
  assert.equal(out.sessions[0].d, TODAY)
  assert.deepEqual(Object.keys(out.days), [TODAY])
  // 显式 dateKey 优先（跨时区/补记场景由调用方定口径）
  const forced = appendSession(emptyFocus(), { endAt: end, minutes: 25, dateKey: '2026-10-25' })
  assert.equal(forced.sessions[0].d, '2026-10-25')
  assert.deepEqual(Object.keys(forced.days), ['2026-10-25'])
})

test('appendSession：不原地改入参，带任务快照，超上限掐头', () => {
  const t = at(2026, 10, 26, 9, 45)
  const src = emptyFocus()
  const out = appendSession(src, { endAt: t, minutes: 25, todoId: 't1', todoText: '写  周报' })
  assert.deepEqual(src, { v: 2, days: {}, sessions: [] })
  assert.equal(out.sessions[0].todoId, 't1')
  assert.equal(out.sessions[0].todoText, '写 周报')
  const many = { days: {}, sessions: [] }
  for (let i = 0; i < 2000; i++) many.sessions.push({ d: TODAY, t: t + i * 1000, m: 1 })
  const filled = appendSession(many, { endAt: t + 3000000, minutes: 25 })
  assert.equal(filled.sessions.length, 2000)
  assert.equal(filled.sessions[filled.sessions.length - 1].m, 25) // 留的是最新一条
})

test('appendSession：脏 state 按空壳起步，同 id 重复写入只算一条', () => {
  const t = at(2026, 10, 26, 9, 45)
  for (const dirty of [null, undefined, 'x', {}, { days: [] }]) {
    assert.deepEqual(appendSession(dirty, { endAt: t, minutes: 25 }).days[TODAY], { r: 1, m: 25 })
  }
  const one = appendSession(emptyFocus(), { endAt: t, minutes: 25, id: 'same' })
  const two = appendSession(one, { endAt: t + 1000, minutes: 25, id: 'same' })
  assert.equal(two.sessions.length, 1)
  assert.deepEqual(two.days[TODAY], { r: 1, m: 25 })
})

// ──────────────────────────────────────────────
// 裁剪
// ──────────────────────────────────────────────
test('pruneFocus：明细与老日子跟随同一窗口，越界 / 未来 / 脏项全裁掉，天表重新派生', () => {
  const t = at(2026, 10, 26, 9, 0)
  const state = {
    days: {
      '2026-10-25': { r: 2, m: 50 },   // 窗口内、没有明细 → 保留
      '2026-10-26': { r: 9, m: 900 },  // 有明细 → 以明细为准
      '2026-10-27': { r: 1, m: 25 },   // 未来（系统时间被改过）→ 裁
      '2026-07-29': { r: 1, m: 25 },   // 今天 - 89 天，90 天窗口最后一格 → 保留
      '2026-07-28': { r: 1, m: 25 },   // 今天 - 90 天 → 裁
      'abc': { r: 1, m: 25 },          // 非法键 → 裁
    },
    sessions: [
      { d: TODAY, t, m: 25 },
      { d: '2026-07-29', t: t - 1000, m: 25 }, // 窗口最后一格
      { d: '2026-07-28', t: t - 2000, m: 25 }, // 窗口外
      { d: '2026-10-27', t: t + 1000, m: 25 }, // 未来
      { d: 'bad', t: t + 3000, m: 25 },        // 非法日期
    ],
  }
  const out = pruneFocus(state, TODAY, 90)
  assert.equal(out.v, 2)
  assert.deepEqual(out.sessions.map((s) => s.d), ['2026-07-29', TODAY])
  assert.deepEqual(out.days, {
    '2026-07-29': { r: 1, m: 25 },
    '2026-10-25': { r: 2, m: 50 },
    [TODAY]: { r: 1, m: 25 },
  })
})

test('pruneFocus：keepDays 非法 / 0 按 90 处理、负数按 1 天下限', () => {
  const old = { days: { '2020-01-01': { r: 1, m: 25 } }, sessions: [] }
  assert.deepEqual(pruneFocus(old, TODAY, 'abc').days, {}) // 默认 90 天窗口，2020 年该裁
  assert.deepEqual(pruneFocus(old, TODAY, 0).days, {})     // 0 与非法同义，回 90 天窗口
  const two = {
    days: { [TODAY]: { r: 1, m: 25 }, '2026-10-25': { r: 1, m: 25 } },
    sessions: [],
  }
  assert.deepEqual(Object.keys(pruneFocus(two, TODAY, -5).days), [TODAY]) // 下限 1 天
})

test('pruneFocus：todayKey 非法时原样保留，不删历史', () => {
  const state = { days: { '2020-01-01': { r: 1, m: 25 } }, sessions: [{ d: '2020-01-01', t: 1, m: 25 }] }
  const out = pruneFocus(state, 'bad', 90)
  assert.equal(out.v, 2)
  assert.deepEqual(out.days, { '2020-01-01': { r: 1, m: 25 } })
  assert.equal(out.sessions.length, 1)
})

// ──────────────────────────────────────────────
// 汇总
// ──────────────────────────────────────────────
test('summarize：series 升序补零、today 取最后一格、total 只算窗口内', () => {
  const t = at(2026, 10, 26, 9, 0)
  const state = {
    days: {
      '2026-10-26': { r: 2, m: 50 },
      '2026-10-24': { r: 1, m: 25 },
      '2026-09-01': { r: 9, m: 900 }, // 窗口外，不计入 total
    },
    sessions: [{ d: TODAY, t, m: 25 }, { d: TODAY, t: t + 1000, m: 25 }],
  }
  const s = summarize(state, TODAY, 7)
  assert.equal(s.series.length, 7)
  assert.equal(s.series[0].date, '2026-10-20')
  assert.equal(s.series[6].date, TODAY)
  assert.deepEqual(s.today, { r: 2, m: 50 })
  assert.deepEqual(s.total, { r: 3, m: 75 })
  assert.deepEqual(s.series[4], { date: '2026-10-24', r: 1, m: 25 })
  assert.deepEqual(s.series[5], { date: '2026-10-25', r: 0, m: 0 })
})

test('summarize：连续天数 —— 今天没合格轮从昨天数，断档即停', () => {
  const t = at(2026, 10, 26, 9, 0)
  const state = {
    days: { '2026-10-23': { r: 1, m: 25 } },
    sessions: [
      { d: TODAY, t, m: 25 },
      { d: '2026-10-25', t: t - 1000, m: 25 },
      // 10-24 断档
    ],
  }
  assert.equal(summarize(state, TODAY, 7).streak, 2)
  // 今天还没开始专注（早上打开设置页）→ 从昨天数，不该显示 0
  const morning = { days: {}, sessions: [{ d: '2026-10-25', t, m: 25 }, { d: '2026-10-24', t: t - 1000, m: 25 }] }
  assert.equal(summarize(morning, TODAY, 7).streak, 2)
  assert.equal(summarize({ days: {}, sessions: [{ d: '2026-10-24', t, m: 25 }] }, TODAY, 7).streak, 0)
  // 今天只有正计时（没有合格轮）→ 不算断也不算数，从昨天开始
  const upOnly = { days: {}, sessions: [{ d: TODAY, t, m: 30, k: 'up' }, { d: '2026-10-25', t: t - 1000, m: 25 }] }
  assert.equal(summarize(upOnly, TODAY, 7).streak, 1)
})

test('summarize：days 夹在 1–366（0 / 非法回默认 7）；todayKey 非法时回空结果而不是抛错', () => {
  assert.equal(summarize(emptyFocus(), TODAY, 0).series.length, 7) // 0 与非法同义，回默认 7 天
  assert.equal(summarize(emptyFocus(), TODAY, 9999).series.length, 366)
  assert.equal(summarize(emptyFocus(), TODAY, 'abc').series.length, 7)
  assert.deepEqual(summarize({ days: { [TODAY]: { r: 1, m: 25 } }, sessions: [] }, 'bad', 7), {
    series: [], today: { r: 0, m: 0 }, total: { r: 0, m: 0 }, streak: 0, todayByTodo: {},
  })
})

test('summarize：todayByTodo 只数今天有 todoId 的合格轮（正计时 / 休息 / 放弃不计）', () => {
  const t = at(2026, 10, 26, 9, 0)
  const state = {
    days: {},
    sessions: [
      { d: TODAY, t, m: 25, todoId: 't1' },
      { d: TODAY, t: t + 1000, m: 25, todoId: 't1' },
      { d: TODAY, t: t + 2000, m: 25, todoId: 't2' },
      { d: TODAY, t: t + 3000, m: 25, todoId: 't1', k: 'up' },  // 正计时：有分钟没轮
      { d: TODAY, t: t + 4000, m: 5, todoId: 't1', b: 1 },      // 休息
      { d: TODAY, t: t + 5000, m: 10, todoId: 't1', a: 1 },     // 放弃
      { d: TODAY, t: t + 6000, m: 25 },                          // 没绑任务
      { d: '2026-10-25', t: t + 7000, m: 25, todoId: 't1' },     // 不是今天
    ],
  }
  assert.deepEqual(summarize(state, TODAY, 7).todayByTodo, { t1: 2, t2: 1 })
  assert.deepEqual(summarize(state, 'bad', 7).todayByTodo, {})
})

test('summarize：__proto__ 当任务 id 不能改掉返回值原型', () => {
  const t = at(2026, 10, 26, 9, 0)
  const s = summarize({ days: {}, sessions: [{ d: TODAY, t, m: 25, todoId: '__proto__' }] }, TODAY, 7)
  assert.deepEqual(s.todayByTodo, {})
  assert.equal({}.polluted, undefined)
})

// ──────────────────────────────────────────────
// 待办轮数：从会话派生，取代单独的累加计数器
// ──────────────────────────────────────────────
test('roundsByTodo：保留窗口内全量按任务统计合格轮，不看今天', () => {
  const t = at(2026, 10, 26, 9, 0)
  const state = {
    days: {},
    sessions: [
      { d: TODAY, t, m: 25, todoId: 't1' },
      { d: '2026-10-25', t: t - 86400000, m: 25, todoId: 't1' },
      { d: '2026-10-24', t: t - 2 * 86400000, m: 25, todoId: 't2' },
      { d: TODAY, t: t + 1000, m: 25, todoId: 't1', k: 'up' },  // 非合格轮
      { d: TODAY, t: t + 2000, m: 25, todoId: 't1', a: 1 },     // 放弃
      { d: TODAY, t: t + 3000, m: 25, todoId: '__proto__' },    // 守卫
      { d: TODAY, t: t + 4000, m: 25 },                          // 没绑任务
    ],
  }
  assert.deepEqual(roundsByTodo(state), { t1: 2, t2: 1 })
  assert.equal({}.polluted, undefined)
  assert.deepEqual(roundsByTodo(null), {})
})

test('listSessions：按最近 N 天过滤、按结束时间倒序、带 v2 形状，非法今天键回空', () => {
  const t = at(2026, 10, 26, 9, 0)
  const state = {
    days: {},
    sessions: [
      { d: '2026-10-20', t: t - 6 * 86400000, m: 25 }, // 7 天窗口第一天，保留
      { d: TODAY, t, m: 25, todoId: 't1', todoText: '写周报' },
      { d: '2026-10-25', t: t - 86400000 + 1000, m: 30 },
      { d: '2026-10-19', t: t - 7 * 86400000, m: 25 },  // 窗口外
    ],
  }
  const list = listSessions(state, TODAY, 7)
  assert.deepEqual(list.map((s) => s.t), [t, t - 86400000 + 1000, t - 6 * 86400000])
  assert.equal(list[0].todoText, '写周报')
  assert.equal(list[0].k, 'down')
  assert.ok(list[0].id)
  assert.equal(listSessions(state, TODAY, 0).length, 3) // 0 / 非法回默认 7 天
  assert.deepEqual(listSessions(state, 'bad', 7), [])
})

test('listSessions 带 round 投影：「算不算一轮」由宿主判，设置页只读不自己数', () => {
  const t = at(2026, 10, 26, 9, 0)
  const st = {
    days: {},
    sessions: [
      { d: TODAY, t, m: 25 }, // 倒计时走完 —— 一轮
      { d: TODAY, t: t + 1000, m: 12, k: 'up', a: 1 }, // 正计时中途放弃
      { d: TODAY, t: t + 2000, m: 5, k: 'down', b: 1 }, // 休息
      { d: TODAY, t: t + 3000, m: 30, k: 'at' }, // 定时到点
    ],
  }
  const list = listSessions(st, TODAY, 7)
  assert.deepEqual(list.map((s) => [s.k, !!s.round]), [
    ['at', false], ['down', false], ['up', false], ['down', true],
  ])
  // 同一口径：round 必须等价于 isRound，别在投影里再写一遍规则
  for (const s of list) assert.equal(s.round ? true : false, isRound(s))
  // 投影不改存储本体（withDerived 的结果不该被页面数据污染）
  const raw = st.sessions[0]
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'round'), false)
})
