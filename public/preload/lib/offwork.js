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
  return '距周末 ' + fmtSpan(sat.getTime() - now.getTime())
}

function paydayInfo(now, day) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const thisTarget = new Date(now.getFullYear(), now.getMonth(), Math.min(day, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()))
  if (sameDay(today, thisTarget)) return '今天发薪'
  let target = thisTarget
  if (thisTarget.getTime() < today.getTime()) {
    const ny = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear()
    const nm = (now.getMonth() + 1) % 12
    const last = new Date(ny, nm + 1, 0).getDate()
    target = new Date(ny, nm, Math.min(day, last))
  }
  return '距发薪 ' + fmtSpan(target.getTime() - now.getTime())
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
  if (phase === 'before') {
    label = '距离上班'
    hint = cfg.start + ' 上班'
  } else if (phase === 'work') {
    label = '距离下班'
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
  _weekendInfo: weekendInfo,
  _paydayInfo: paydayInfo,
}
