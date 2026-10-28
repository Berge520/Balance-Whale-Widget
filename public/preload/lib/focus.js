/*
 * 专注轮次统计（纯函数叶子）：零依赖、无 IO、可在无 utools 桩下单测。
 *
 * 状态形状由 store.readFocus / writeFocus 负责落库与形状归一，这里只做「算」：
 *   { days: { 'YYYY-MM-DD': { r, m } } }  r = 完成轮次，m = 专注分钟
 *
 * 刻意不引 constants：保留天数由调用方传（FOCUS_KEEP_DAYS），
 * 这样本模块既能被 ipc 用、也能被设置页侧的计算复用，且不会因为常量表变动而连带失效。
 */

const DAY_MS = 86400000

// 严格校验 YYYY-MM-DD 并转成 UTC 零点毫秒。用 UTC 而不是本地时间：
// 只做「相差几天」的整数运算，UTC 不受夏令时/时区偏移影响，跨时区也不会多算或少算一天。
function keyToMs(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!m) return NaN
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  // 反向校验：Date.UTC 会把 2 月 31 日滚到 3 月，滚过的不是合法日期
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN
  return ms
}
function msToKey(ms) {
  const d = new Date(ms)
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
}

function emptyFocus() {
  return { days: {} }
}

// 记一轮：r +1、m 累加（分钟取整，非法值按 0 计）。
// 返回新对象而不是原地改 —— 调用方拿到的是落库前的快照，原地改会让「写失败」时内存与存储不一致。
function recordRound(state, dateKey, minutes) {
  const base = state && typeof state === 'object' && state.days && typeof state.days === 'object'
    ? state : emptyFocus()
  const ms = keyToMs(dateKey)
  if (!isFinite(ms)) return { days: Object.assign({}, base.days) }
  const add = Math.max(0, Math.min(1440, Math.round(Number(minutes) || 0)))
  const days = Object.assign({}, base.days)
  const cur = days[dateKey] && typeof days[dateKey] === 'object' ? days[dateKey] : { r: 0, m: 0 }
  days[dateKey] = {
    r: Math.max(0, Math.round(Number(cur.r) || 0)) + 1,
    m: Math.max(0, Math.round(Number(cur.m) || 0)) + add,
  }
  return { days }
}

// 裁掉窗口外的日子：保留「今天往前 keepDays-1 天」这一段（含今天）。
// keepDays 非法时按 90 处理，避免调用方漏传参数把历史全删了。
function pruneFocus(state, todayKey, keepDays) {
  const days = state && typeof state === 'object' && state.days && typeof state.days === 'object'
    ? state.days : {}
  const todayMs = keyToMs(todayKey)
  const keep = Math.max(1, Math.round(Number(keepDays) || 90))
  if (!isFinite(todayMs)) return { days: Object.assign({}, days) }
  const cutoff = todayMs - (keep - 1) * DAY_MS
  const out = {}
  for (const k of Object.keys(days)) {
    const ms = keyToMs(k)
    if (!isFinite(ms) || ms < cutoff || ms > todayMs) continue
    const d = days[k]
    if (!d || typeof d !== 'object') continue
    const r = Math.max(0, Math.round(Number(d.r) || 0))
    const m = Math.max(0, Math.round(Number(d.m) || 0))
    if (!r && !m) continue
    out[k] = { r, m }
  }
  return { days: out }
}

// 汇总：给设置页出柱状图与三个数字。
//   series  —— 最近 days 天（含今天，按日期升序），没有记录的天补 0，方便直接画柱
//   today   —— 今天这一格
//   total   —— series 窗口内的合计（与图上看到的柱对得上，不会出现「图上 7 根柱、总数是 90 天」）
//   streak  —— 连续有记录的天数；今天还没记录时从昨天开始数（当天还没开始专注不算断）
function summarize(state, todayKey, days) {
  const src = state && typeof state === 'object' && state.days && typeof state.days === 'object'
    ? state.days : {}
  const todayMs = keyToMs(todayKey)
  const n = Math.max(1, Math.min(366, Math.round(Number(days) || 7)))
  const series = []
  const total = { r: 0, m: 0 }
  if (!isFinite(todayMs)) return { series, today: { r: 0, m: 0 }, total, streak: 0 }
  for (let i = n - 1; i >= 0; i--) {
    const key = msToKey(todayMs - i * DAY_MS)
    const d = src[key] && typeof src[key] === 'object' ? src[key] : null
    const r = d ? Math.max(0, Math.round(Number(d.r) || 0)) : 0
    const m = d ? Math.max(0, Math.round(Number(d.m) || 0)) : 0
    series.push({ date: key, r, m })
    total.r += r
    total.m += m
  }
  const today = series[series.length - 1] || { r: 0, m: 0 }
  let streak = 0
  // 今天没记录就从昨天开始数：用户早上打开设置页时不该显示「连续 0 天」
  let cursor = today.r > 0 ? todayMs : todayMs - DAY_MS
  for (;;) {
    const key = msToKey(cursor)
    const d = src[key]
    if (!d || !(Math.max(0, Math.round(Number(d.r) || 0)) > 0)) break
    streak++
    cursor -= DAY_MS
    if (streak > 3660) break // 防御：脏数据里日期全都有记录时也不无限循环
  }
  return { series, today: { r: today.r, m: today.m }, total, streak }
}

module.exports = { emptyFocus, recordRound, pruneFocus, summarize, keyToMs, msToKey }
