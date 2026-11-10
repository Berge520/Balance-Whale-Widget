'use strict'

/*
 * 下班倒计时纯计算（零依赖叶子模块）。
 *
 * 为什么单独成模块：挂件页面（普通 script，不能用 ES module）与宿主（CommonJS）都要
 * 用同一套时间口径。构建期用 esbuild 把本文件打成 dist/offwork-core.js（全局
 * window.OffworkCore），挂件页与宿主共用这一份源码，避免两处各写一份时间算法后漂移。
 *
 * 约定：
 *   · 只用本地 Date 构造（new Date(y, m, d, h, min)），不做 UTC 偏移换算。国内无 DST，
 *     且每次 tick 都重算，系统时区变了下一轮自然跟上。
 *   · days 用 JS getDay() 口径：0=周日，1=周一 … 6=周六。
 *   · 跨日班（下班时间 <= 上班时间，如 22:00–06:00）按「次日下班」处理。
 *   · 不做 IO、不读配置、不依赖任何 lib 模块，可无 utools 桩单测。
 */

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const NEAR_SOON_MS = 30 * 60 * 1000
const NEAR_IMMINENT_MS = 10 * 60 * 1000
const DEFAULTS = Object.freeze({
  start: '09:00',
  end: '18:00',
  days: Object.freeze([1, 2, 3, 4, 5]),
  showSec: true,
  ring: true,
  weekendOn: false,
  paydayOn: false,
  paydayDay: 10,
})

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

// HH:MM 归一：接受 9:00 / 09:00，非法与越界一律回默认值
function normHm(v, dft) {
  const fallback = typeof dft === 'string' ? dft : DEFAULTS.start
  if (typeof v !== 'string') return fallback
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return fallback
  return pad2(h) + ':' + pad2(min)
}

// 工作日归一：只留 0–6 的整数、去重、升序；空数组回默认周一至周五
// （设置页不允许把七天全取消，这里也按「至少一天」兜底，避免倒计时永远找不到目标）
function normDays(v, dft) {
  const fallback = Array.isArray(dft) ? dft.slice() : DEFAULTS.days.slice()
  if (!Array.isArray(v)) return fallback
  const seen = new Set()
  const out = []
  for (const x of v) {
    const n = Number(x)
    if (!Number.isInteger(n) || n < 0 || n > 6 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  out.sort((a, b) => a - b)
  return out.length ? out : fallback
}

// 发薪日归一：1–31 的整数，其余回默认 10 号
function normPayday(v) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : DEFAULTS.paydayDay
}

// 兼容两种入参：配置对象（offworkStart…）与页面内部短名（start…）
function normCfg(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const pick = (short, long) => (p[short] !== undefined ? p[short] : p[long])
  return {
    start: normHm(pick('start', 'offworkStart'), DEFAULTS.start),
    end: normHm(pick('end', 'offworkEnd'), DEFAULTS.end),
    days: normDays(pick('days', 'offworkDays')),
    showSec: pick('showSec', 'offworkShowSec') !== false,
    ring: pick('ring', 'offworkRing') !== false, // 外圈工时进度环：默认开，关掉后圈只归计时
    weekendOn: pick('weekendOn', 'offworkWeekendOn') === true,
    paydayOn: pick('paydayOn', 'offworkPaydayOn') === true,
    paydayDay: normPayday(pick('paydayDay', 'offworkPaydayDay')),
  }
}

function parseHm(hm) {
  const m = /^(\d{2}):(\d{2})$/.exec(normHm(hm, DEFAULTS.start))
  return { h: Number(m[1]), m: Number(m[2]) }
}

function atTime(date, hm, dayOffset) {
  const t = parseHm(hm)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + (dayOffset || 0), t.h, t.m, 0, 0)
}

function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n)
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function isWorkday(date, days) {
  return days.indexOf(date.getDay()) >= 0
}

// 某一天的班次区间；下班 <= 上班视为跨日班（下班落到次日）
function shiftOf(date, cfg) {
  const start = atTime(date, cfg.start)
  let end = atTime(date, cfg.end)
  if (end.getTime() <= start.getTime()) end = atTime(date, cfg.end, 1)
  return { start: start, end: end }
}

// 昨天是工作日且跨日班还没结束（凌晨仍处在昨天的班上）
function carryShift(now, cfg) {
  const y = addDays(now, -1)
  if (!isWorkday(y, cfg.days)) return null
  const r = shiftOf(y, cfg)
  if (now.getTime() >= r.start.getTime() && now.getTime() < r.end.getTime()) return r
  return null
}

// 严格晚于 now 的下一个上班时刻（最多向后找 7 天；days 非空必有结果）
function nextStartAfter(now, cfg) {
  for (let i = 0; i <= 7; i++) {
    const d = addDays(now, i)
    if (!isWorkday(d, cfg.days)) continue
    const s = atTime(d, cfg.start)
    if (s.getTime() > now.getTime()) return s
  }
  return null
}

// 秒级倒计时文本：showSec 关时只到分钟；小时不折成「天」，跨日班直接显示 63:00:00
function fmtDuration(ms, showSec) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000)) || 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return pad2(h) + ':' + pad2(m) + (showSec ? ':' + pad2(s) : '')
}

function fmtSpan(ms) {
  if (!(ms > 0)) return '即将'
  const mins = Math.max(1, Math.floor(ms / 60000))
  if (mins < 60) return mins + '分钟'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return m ? h + '小时' + m + '分' : h + '小时'
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh ? d + '天' + hh + '小时' : d + '天'
}

/*
 * 「今天已过百分比」：分母固定为「今天上班时刻 → 今天下班时刻」这段当日区间。
 *   · 上班前 = 0%，下班后（含刚好到点）= 100%，区间内 = 已过时长 / 区间总长。
 *   · 只在工作日且**非跨日班**时返回；休息日、跨日班、非法时间一律返回 null（调用方隐藏进度条），
 *     不拿「昨天的班」或「次日下班」硬算出一个看着像真的百分比。
 *   · 早于上班时刻的时间算 0 而非负数；阶段判定与 display 的 phase 同口径（见上方 display）。
 * 返回 { pct: 0–100, phase: 'before' | 'work' | 'after' }。
 */
function dayProgress(nowMs, raw) {
  const cfg = normCfg(raw)
  const now = nowMs instanceof Date ? new Date(nowMs.getTime()) : new Date(nowMs)
  if (!Number.isFinite(now.getTime())) return null
  // 跨日班（下班 <= 上班）：当日区间不成立，隐藏进度
  const s = parseHm(cfg.start)
  const e = parseHm(cfg.end)
  if (e.h * 60 + e.m <= s.h * 60 + s.m) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!isWorkday(today, cfg.days)) return null
  const tr = shiftOf(today, cfg)
  const t = now.getTime()
  if (t < tr.start.getTime()) return { pct: 0, phase: 'before' }
  if (t >= tr.end.getTime()) return { pct: 100, phase: 'after' }
  const total = tr.end.getTime() - tr.start.getTime()
  const pct = ((t - tr.start.getTime()) / total) * 100
  return { pct: Math.min(100, Math.max(0, pct)), phase: 'work' }
}

// 时薪上限（元/小时）：纯防误填，不参与任何折算。设置页与宿主共用同一个数。
const WAGE_MAX = 100000
/*
 * 时薪归一（元/小时）。返回值语义：
 *   · 0     = 未配置（空 / 0），挂件不显示「今日已赚」；
 *   · > 0   = 合法时薪（最多两位小数）；
 *   · null  = 非法（负数、非数字、超过 WAGE_MAX、超过两位小数）。
 * 分开「0」与「null」是因为写配置时前者表示清空、后者必须保持原值不动；
 * 合成一个 0 会让用户误填一个字母就把已配好的时薪悄悄清掉。
 * 刻意不做月薪 / 年薪折算：口径越复杂越容易被当成真实工资。
 */
function normWage(v) {
  if (v === null || v === undefined) return 0
  const s = String(v).trim()
  if (!s) return 0
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  if (n === 0) return 0
  if (n < 0 || n > WAGE_MAX) return null
  // 最多两位小数：浮点误差容差 1e-6，避免 50.1 * 100 = 5010.0000000001 被判非法
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return null
  return Math.round(n * 100) / 100
}
/*
 * 「今日已赚」= 时薪 × 今日已工作小时数（估算，不是真实工资）。
 * 时间段判定**完全复用 dayProgress**：它返回 null（休息日 / 跨日班 / 非法时间）时这里同样返回 null，
 * 调用方隐藏这一项；上班前 pct=0 → 0 元，下班后 pct=100 → 按整段班时长封顶。
 * 只做「时薪 × 小时」，不做月薪折算、个税、社保、补贴等任何扣除。
 * 返回两位小数；未配置时薪返回 null（与「赚了 0 元」区分开）。
 */
function todayEarned(nowMs, raw, wage) {
  const w = normWage(wage)
  if (!w) return null
  const p = dayProgress(nowMs, raw)
  if (!p) return null
  const cfg = normCfg(raw)
  const s = parseHm(cfg.start)
  const e = parseHm(cfg.end)
  // dayProgress 已保证非跨日班，这里的区间一定是当日且 end > start
  const shiftHours = (e.h * 60 + e.m - (s.h * 60 + s.m)) / 60
  // 在「分」上四舍五入并加 1e-6 抵消浮点误差（33.33 × 4.5 = 149.985，JS 实际算成 149.98499999998，
  // 直接 Math.round 会错成 149.98）。1e-6 分远小于真实金额精度，不会把该舍的进位上去
  return Math.round(shiftHours * (p.pct / 100) * w * 100 + 1e-6) / 100
}

// 「今天 09:00」/「明天 09:00」/「周一 09:00」/「11 月 10 日 09:00」
function dayDesc(target, now) {
  const clock = pad2(target.getHours()) + ':' + pad2(target.getMinutes())
  if (sameDay(target, now)) return '今天 ' + clock
  const tomorrow = addDays(now, 1)
  if (sameDay(target, tomorrow)) return '明天 ' + clock
  const diff = Math.round((atTime(target, '00:00').getTime() - atTime(now, '00:00').getTime()) / 86400000)
  if (diff > 0 && diff < 7) return DAY_NAMES[target.getDay()] + ' ' + clock
  return (target.getMonth() + 1) + ' 月 ' + target.getDate() + ' 日 ' + clock
}

function weekendInfo(now) {
  const dow = now.getDay()
  if (dow === 6 || dow === 0) return '周末进行中'
  const delta = (6 - dow + 7) % 7 || 7
  const sat = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta, 0, 0, 0, 0)
  return spanInfo('周末', sat.getTime() - now.getTime())
}

// 「距周末」与「距发薪」共用：数值里已经带「距」了就不再重复（「周末 2天3小时」比「距周末 2天3小时」
// 少两字，说明行本来就只有两行宽）；当天用「就是今天」，说「发薪 就是今天」也成立（用户 2026-11-09 要求简洁明了）
function spanInfo(what, ms, today) {
  return what + ' ' + (today ? '就是今天' : fmtSpan(ms))
}

function paydayInfo(now, day) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const thisTarget = new Date(now.getFullYear(), now.getMonth(), Math.min(day, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()))
  if (sameDay(today, thisTarget)) return '发薪 就是今天'
  let target = thisTarget
  if (thisTarget.getTime() < today.getTime()) {
    const ny = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear()
    const nm = (now.getMonth() + 1) % 12
    const last = new Date(ny, nm + 1, 0).getDate()
    target = new Date(ny, nm, Math.min(day, last))
  }
  return spanInfo('发薪', target.getTime() - now.getTime())
}

/*
 * 出口：给定时间戳与配置，返回挂件要展示的一行状态。
 * phase：before（上班前）/ work（工作中）/ after（当天已下班）/ off（休息日）
 * main 恒为倒计时；after / off 时倒到下一次上班，hint 里点明「已下班 / 休息日」。
 */
function display(nowMs, raw) {
  const cfg = normCfg(raw)
  const now = nowMs instanceof Date ? new Date(nowMs.getTime()) : new Date(nowMs)
  if (!Number.isFinite(now.getTime())) return null

  const carry = carryShift(now, cfg)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayWork = isWorkday(today, cfg.days)
  const tr = shiftOf(today, cfg)
  let phase = ''
  let target = null
  if (carry) {
    phase = 'work'
    target = carry.end
  } else if (todayWork && now.getTime() < tr.start.getTime()) {
    phase = 'before'
    target = tr.start
  } else if (todayWork && now.getTime() < tr.end.getTime()) {
    phase = 'work'
    target = tr.end
  } else {
    phase = todayWork ? 'after' : 'off'
  }
  if (!target) target = nextStartAfter(now, cfg)
  if (!target) return null

  const remain = Math.max(0, target.getTime() - now.getTime())
  let label = ''
  let hint = ''
  // 标签只写「上班 / 下班」两个字：标题行是「下班 02:15:30 · 18:00」，
  // 前面的数字本身就是倒计时，「距离」二字只是每个字都在挤标题行的宽度（用户 2026-11-09 要求简洁明了）
  if (phase === 'before') {
    label = '上班'
    hint = cfg.start + ' 上班'
  } else if (phase === 'work') {
    label = '下班'
    // 「次日」按实际下班日期判（凌晨仍在昨天的跨日班上时，下班其实是今天，不是次日）
    hint = (sameDay(target, now) ? '' : '次日 ') + cfg.end + ' 下班'
  } else if (phase === 'after') {
    label = '已下班'
    hint = '距上班 ' + dayDesc(target, now)
  } else {
    label = '休息日'
    hint = '距上班 ' + dayDesc(target, now)
  }

  const extras = []
  if (cfg.weekendOn) extras.push(weekendInfo(now))
  if (cfg.paydayOn) extras.push(paydayInfo(now, cfg.paydayDay))
  if (extras.length) hint += ' · ' + extras.join(' · ')

  let near = null
  if (phase === 'work') {
    if (remain <= NEAR_IMMINENT_MS) near = 'imminent'
    else if (remain <= NEAR_SOON_MS) near = 'soon'
  }

  return {
    phase: phase,
    label: label,
    main: fmtDuration(remain, cfg.showSec),
    hint: hint,
    near: near,
    remainMs: remain,
    targetMs: target.getTime(),
  }
}

module.exports = {
  DEFAULTS: DEFAULTS,
  NEAR_SOON_MS: NEAR_SOON_MS,
  NEAR_IMMINENT_MS: NEAR_IMMINENT_MS,
  normHm: normHm,
  normDays: normDays,
  normPayday: normPayday,
  normCfg: normCfg,
  fmtDuration: fmtDuration,
  display: display,
  dayProgress: dayProgress,
  normWage: normWage,
  todayEarned: todayEarned,
  WAGE_MAX: WAGE_MAX,
  _weekendInfo: weekendInfo,
  _paydayInfo: paydayInfo,
}
