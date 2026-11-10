/*
 * 下班倒计时的纯计算与接线单测（node --test，零依赖）。
 *
 * 时间算法只在 public/preload/lib/offwork.js 一处：挂件页用的是构建期打出来的
 * dist/offwork-core.js（同一份源码），所以这里测的就是线上那一份。
 * 覆盖：上班前 / 工作中 / 下班后 / 跨日班 / 非工作日 / 最后一分钟 / 最后 30 与 10 分钟 /
 *     显示秒开关 / 周末与发薪附加；末尾再断言「关闭开关不渲染」的页面接线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const O = require('../public/preload/lib/offwork.js')

// 2026-11-04 是周三（本地时区），2026-11-06 周五、11-07 周六、11-09 周一。
// 全部用 new Date(y, m, d, h, min, sec) 构造本地时间，避免测试机时区影响。
const at = (month, day, h, min, sec) => new Date(2026, month - 1, day, h || 0, min || 0, sec || 0, 0)

function cfg(extra) {
  return Object.assign({
    start: O.DEFAULTS.start,
    end: O.DEFAULTS.end,
    days: O.DEFAULTS.days.slice(),
    showSec: O.DEFAULTS.showSec,
    weekendOn: O.DEFAULTS.weekendOn,
    paydayOn: O.DEFAULTS.paydayOn,
    paydayDay: O.DEFAULTS.paydayDay,
  }, extra || {})
}

test('normHm：接受 9:00 / 09:00，越界与非法回默认值', () => {
  assert.equal(O.normHm('9:00', '09:00'), '09:00')
  assert.equal(O.normHm(' 09:05 ', '09:00'), '09:05')
  assert.equal(O.normHm('23:59', '09:00'), '23:59')
  assert.equal(O.normHm('24:00', '09:00'), '09:00')
  assert.equal(O.normHm('09:60', '09:00'), '09:00')
  assert.equal(O.normHm('', '09:00'), '09:00')
  assert.equal(O.normHm(null, '09:00'), '09:00')
})

test('normDays：0–6 去重升序；空数组回默认周一至周五', () => {
  assert.deepEqual(O.normDays([1, 3, 3]), [1, 3])
  assert.deepEqual(O.normDays([6, 0]), [0, 6])
  assert.deepEqual(O.normDays([]), [1, 2, 3, 4, 5])
  assert.deepEqual(O.normDays([7, -1, 2]), [2])
  assert.deepEqual(O.normDays('1,2'), [1, 2, 3, 4, 5])
})

test('normPayday：1–31 的整数，其余回默认 10 号', () => {
  assert.equal(O.normPayday(1), 1)
  assert.equal(O.normPayday(31), 31)
  assert.equal(O.normPayday(0), 10)
  assert.equal(O.normPayday(32), 10)
  assert.equal(O.normPayday('abc'), 10)
})

test('上班前：倒到上班时刻', () => {
  const r = O.display(at(11, 4, 8, 30), cfg())
  assert.equal(r.phase, 'before')
  assert.equal(r.label, '上班')
  assert.equal(r.main, '00:30:00')
  assert.equal(r.hint, '09:00 上班')
  assert.equal(r.near, null)
})

test('工作中：倒到下班时刻，最后 30 / 10 分钟给 near 档位', () => {
  const plain = O.display(at(11, 4, 10, 0), cfg())
  assert.equal(plain.phase, 'work')
  assert.equal(plain.label, '下班')
  assert.equal(plain.main, '08:00:00')
  assert.equal(plain.hint, '18:00 下班')
  assert.equal(plain.near, null)

  assert.equal(O.display(at(11, 4, 17, 20), cfg()).near, null)       // 40 分钟
  assert.equal(O.display(at(11, 4, 17, 30), cfg()).near, 'soon')     // 恰好 30 分钟
  assert.equal(O.display(at(11, 4, 17, 40), cfg()).near, 'soon')     // 20 分钟
  assert.equal(O.display(at(11, 4, 17, 50), cfg()).near, 'imminent') // 恰好 10 分钟
  assert.equal(O.display(at(11, 4, 17, 55), cfg()).near, 'imminent') // 5 分钟
})

test('最后一分钟：秒级倒计时边界（含 18:00 整点切换）', () => {
  assert.equal(O.display(at(11, 4, 17, 59, 0), cfg()).main, '00:01:00')
  assert.equal(O.display(at(11, 4, 17, 59, 30), cfg()).main, '00:00:30')
  assert.equal(O.display(at(11, 4, 17, 59, 59), cfg()).main, '00:00:01')
  // 18:00:00 起算「已下班」，目标变成下一次上班
  const end = O.display(at(11, 4, 18, 0), cfg())
  assert.equal(end.phase, 'after')
  assert.equal(end.label, '已下班')
  assert.equal(end.main, '15:00:00')
  assert.equal(end.hint, '距上班 明天 09:00')
})

test('下班后 / 周五晚：倒到下一次上班，跨周末', () => {
  const wed = O.display(at(11, 4, 18, 30), cfg())
  assert.equal(wed.phase, 'after')
  assert.equal(wed.main, '14:30:00')
  assert.equal(wed.hint, '距上班 明天 09:00')

  const fri = O.display(at(11, 6, 19, 0), cfg())
  assert.equal(fri.phase, 'after')
  assert.equal(fri.main, '62:00:00') // 周五 19:00 → 周一 09:00
  assert.equal(fri.hint, '距上班 周一 09:00')
})

test('非工作日：休息日 + 倒到下一次上班', () => {
  const sat = O.display(at(11, 7, 12, 0), cfg())
  assert.equal(sat.phase, 'off')
  assert.equal(sat.label, '休息日')
  assert.equal(sat.main, '45:00:00') // 周六 12:00 → 周一 09:00
  assert.equal(sat.hint, '距上班 周一 09:00')
})

test('跨日班（22:00–06:00）：凌晨仍算昨天那一班，下班不写「次日」', () => {
  const night = cfg({ start: '22:00', end: '06:00' })
  // 周三 23:00：今天的班，下班在次日 06:00
  const late = O.display(at(11, 4, 23, 0), night)
  assert.equal(late.phase, 'work')
  assert.equal(late.main, '07:00:00')
  assert.equal(late.hint, '次日 06:00 下班')

  // 周四 02:00：仍在周三夜班，下班其实是今天 06:00
  const early = O.display(at(11, 5, 2, 0), night)
  assert.equal(early.phase, 'work')
  assert.equal(early.main, '04:00:00')
  assert.equal(early.hint, '06:00 下班')

  // 周四 06:00 整点：交班后进入「上班前」
  const handover = O.display(at(11, 5, 6, 0), night)
  assert.equal(handover.phase, 'before')
  assert.equal(handover.main, '16:00:00')

  // 周六 02:00：周五的夜班还没结束（carry 跨工作日）
  const satNight = O.display(at(11, 7, 2, 0), night)
  assert.equal(satNight.phase, 'work')
  assert.equal(satNight.main, '04:00:00')
  assert.equal(satNight.hint, '06:00 下班')
})

test('显示秒关闭：主体只到分钟', () => {
  const r = O.display(at(11, 4, 10, 0), cfg({ showSec: false }))
  assert.equal(r.main, '08:00')
})

test('说明行附加项：周末 / 发薪（含短月按月末截断）', () => {
  const weekend = O.display(at(11, 6, 10, 0), cfg({ weekendOn: true }))
  assert.equal(weekend.hint, '18:00 下班 · 周末 14小时')
  // 周六属于非工作日：主体倒到周一上班，附加信息是「周末进行中」
  assert.equal(O.display(at(11, 7, 10, 0), cfg({ weekendOn: true })).hint, '距上班 周一 09:00 · 周末进行中')

  const payday = O.display(at(11, 4, 10, 0), cfg({ paydayOn: true, paydayDay: 10 }))
  assert.equal(payday.hint, '18:00 下班 · 发薪 5天14小时')
  assert.equal(O.display(at(11, 10, 10, 0), cfg({ paydayOn: true, paydayDay: 10 })).hint, '18:00 下班 · 发薪 就是今天')

  // 11 月没有 31 日：发薪日 31 按 11-30 截断
  const shortMonth = O.display(at(11, 4, 10, 0), cfg({ paydayOn: true, paydayDay: 31 }))
  assert.match(shortMonth.hint, /· 发薪 /)
  assert.match(O.display(at(11, 30, 10, 0), cfg({ paydayOn: true, paydayDay: 31 })).hint, /· 发薪 就是今天/)
})

test('关闭开关不渲染：页面侧有 offworkOn 守卫，默认配置为关闭', () => {
  const page = readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')
  const storeSrc = readFileSync(new URL('../public/preload/lib/store.js', import.meta.url), 'utf8')

  // 默认关闭：空配置不会占标题行、也不追加说明行附加项
  assert.match(storeSrc, /offworkOn: false/)
  // 所有展示路径都先过 offworkCanRender()（offworkOn 为 false 时恒假）
  assert.match(page, /function offworkCanRender\(\)/)
  // 自定义泡泡不再整体压掉倒计时：只有临时接管 / 翻到自定义页才隐藏（同队列共存，见 floating-bubble-queue.test.mjs）
  assert.match(page, /return !!offworkOn && !bubbleTimerActive && !bubbleRemindActive && !bubblePreviewActive && !bubbleRandomActive &&/)
  assert.match(page, /\(!bubbleActive \|\| bubbleQueue\(\)\[bubbleIdx\] === OFFWORK_PAGE\)/)
  // tick 复用既有每秒巡检；计时在跑时它同时是计时圈的每秒刷新入口，不能只按 offworkOn 跳
  assert.match(page, /function bubbleTtlSweep\(\) \{[\s\S]*?if \(offworkOn \|\| timerRunning\) offworkStep\(\)/)
  // 气泡没开时 offworkStep 直接返回、不碰文案（圈在此之前已由 updateTimerRing 刷过）
  assert.match(page, /function offworkStep\(\) \{[\s\S]*?if \(!bubbleShown && !timerRunning\) return;[\s\S]*?if \(!bubbleActive\) updateTimerRing\(\);/)
})

// 「今天已过百分比」：分母 = 当日「上班 → 下班」区间；上班前 0%、下班后 100%，
// 休息日与跨日班一律返回 null（页面侧据此隐藏进度条，不硬凑数字）
test('dayProgress：上班前 / 工作中 / 下班后的边界', () => {
  const before = O.dayProgress(at(11, 4, 8, 0), cfg())
  assert.deepEqual(before, { pct: 0, phase: 'before' })
  // 09:00–18:00，13:30 正好过半
  const mid = O.dayProgress(at(11, 4, 13, 30), cfg())
  assert.equal(mid.phase, 'work')
  assert.equal(Math.round(mid.pct), 50)
  const atEnd = O.dayProgress(at(11, 4, 18, 0), cfg())
  assert.deepEqual(atEnd, { pct: 100, phase: 'after' })
  const after = O.dayProgress(at(11, 4, 19, 0), cfg())
  assert.deepEqual(after, { pct: 100, phase: 'after' })
})

test('dayProgress：休息日 / 跨日班 / 非法时间返回 null', () => {
  // 11-07 是周六，不在默认工作日
  assert.equal(O.dayProgress(at(11, 7, 13, 30), cfg()), null)
  // 跨日班（22:00–06:00）当日区间不成立：凌晨、白天都不显示
  const night = cfg({ start: '22:00', end: '06:00', days: [0, 1, 2, 3, 4, 5, 6] })
  assert.equal(O.dayProgress(at(11, 4, 23, 0), night), null)
  assert.equal(O.dayProgress(at(11, 5, 2, 0), night), null)
  // 非法时间戳
  assert.equal(O.dayProgress(new Date('x'), cfg()), null)
})

// 「今日已赚」= 时薪 × 今日已工作小时数；时间段判定必须与 dayProgress 同口径。
// 09:00–18:00 共 9 小时：08:00 上班前 0、12:00 已工作 3 小时、13:30 已工作 4.5 小时、18:00 起封顶 9 小时。
test('todayEarned：金额算式与上班前 / 工作中 / 下班后边界', () => {
  assert.equal(O.todayEarned(at(11, 4, 8, 0), cfg(), 50), 0)
  assert.equal(O.todayEarned(at(11, 4, 12, 0), cfg(), 50), 150) // 3 小时 × 50 = 150.00
  assert.equal(O.todayEarned(at(11, 4, 13, 30), cfg(), 50), 225) // 4.5 小时 × 50 = 225.00
  assert.equal(O.todayEarned(at(11, 4, 18, 0), cfg(), 50), 450) // 满档 9 小时 × 50 = 450.00
  assert.equal(O.todayEarned(at(11, 4, 19, 0), cfg(), 50), 450) // 下班后不继续累加
  // 两位小数：33.33 × 4.5 = 149.985 → 149.99
  assert.equal(O.todayEarned(at(11, 4, 13, 30), cfg(), 33.33), 149.99)
})

test('todayEarned：时薪空 / 0 / 负数 / 非数字 / 超上限一律不显示（null）', () => {
  const t = at(11, 4, 13, 30)
  assert.equal(O.todayEarned(t, cfg(), 0), null)
  assert.equal(O.todayEarned(t, cfg(), ''), null)
  assert.equal(O.todayEarned(t, cfg(), null), null)
  assert.equal(O.todayEarned(t, cfg(), -1), null)
  assert.equal(O.todayEarned(t, cfg(), 'abc'), null)
  assert.equal(O.todayEarned(t, cfg(), O.WAGE_MAX + 1), null)
  assert.equal(O.todayEarned(t, cfg(), 50.123), null)
})

test('todayEarned：dayProgress 为 null（休息日 / 跨日班 / 非法时间）时同样不显示', () => {
  assert.equal(O.todayEarned(at(11, 7, 13, 30), cfg(), 50), null)
  const night = cfg({ start: '22:00', end: '06:00', days: [0, 1, 2, 3, 4, 5, 6] })
  assert.equal(O.todayEarned(at(11, 4, 23, 0), night, 50), null)
  assert.equal(O.todayEarned(at(11, 5, 2, 0), night, 50), null)
  assert.equal(O.todayEarned(new Date('x'), cfg(), 50), null)
})

test('normWage：0 / 空视为未配置，非法返回 null，合法值最多两位小数', () => {
  assert.equal(O.normWage(0), 0)
  assert.equal(O.normWage(''), 0)
  assert.equal(O.normWage(null), 0)
  assert.equal(O.normWage(-5), null)
  assert.equal(O.normWage('abc'), null)
  assert.equal(O.normWage(100001), null)
  assert.equal(O.normWage(50.123), null)
  assert.equal(O.normWage(50), 50)
  assert.equal(O.normWage('50.5'), 50.5)
  assert.equal(O.normWage(100000), 100000)
})

