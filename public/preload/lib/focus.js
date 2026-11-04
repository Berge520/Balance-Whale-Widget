/*
 * 专注会话模型（纯函数叶子）：零依赖、无 IO、可在无 utools 桩下单测。
 *
 * 事实源只有一份 —— 会话明细 sessions；天表 days 永远由明细派生（deriveDays），
 * 不自己累加。早前两边各记各的（明细追加失败/被裁掉时天表照旧涨），
 * 于是「今日 5 轮」和记录列表里的 3 行对不上，这类偏差从结构上就不可能再出现。
 *
 * 状态形状：
 *   { v: 2, days: { 'YYYY-MM-DD': { r, m } }, sessions: [会话] }
 *   会话 = { id, d, s, t, m, k, b?, a?, todoId?, todoText? }
 *     d = 归属日（**按结束那一刻**算：跨零点的轮次记在它结束的那天）
 *     s/t = 开始/结束时刻（本地毫秒），m = 实际分钟（1–1440）
 *     k = 计时方式 'down' | 'up' | 'at'
 *     b = 休息轮、a = 中途放弃（只在为真时落键，省存储也让老数据形状不变）
 *
 * 口径（两条，全模块统一）：
 *   分钟 m —— 所有会话都算（含正计时/定时与放弃的），休息轮不算专注分钟；
 *   轮次 r —— 只数「倒计时 + 非休息 + 未放弃」：正计时没有目标时长，放弃没走完，
 *             把它们记成一轮会让「今日 N 轮」和番茄循环对不上。
 *
 * 刻意不引 constants：保留天数由调用方传（FOCUS_KEEP_DAYS），
 * 这样本模块既能被 ipc 用、也能被设置页侧的计算复用，且不会因为常量表变动而连带失效。
 */

const DAY_MS = 86400000
// 明细条数兜底：90 天 × 每天十几次也远不到这个量级；上限只防脏数据把存储撑爆。
const SESSION_MAX = 2000
// 与 constants.js 的 TODO_TEXT_MAX / 待办 id 限长同值（这里不引常量，保持纯函数叶子）
const SESSION_TEXT_MAX = 60
const SESSION_ID_MAX = 40
const MODES = { down: 1, up: 1, at: 1 }
// 一轮最长 1440 分钟（24h）：跨零点的长轮也够用，再长的一定是脏数据
const MINUTES_MAX = 1440

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
// 本地日历的日期键：归属日必须按用户所在时区判（msToKey 是 UTC 键，只用于「相差几天」的运算）
function localKey(ms) {
  const d = new Date(ms)
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}

function emptyFocus() {
  return { v: 2, days: {}, sessions: [] }
}

// 单条会话归一：归属日 / 结束时刻 / 分钟三者缺一不可，开始时刻与任务快照可缺。
// 脏数据直接丢 —— 记录列表里出现「--:--」或 0 分钟的行，比少一条更让人困惑。
// 老形状 { d, t, m } 自动补成 v2：k='down'、s 由「结束 - 时长」反推、id 用时刻兜底，
// 迁移不需要单独跑一遍写盘（读出来就是新形状，写回去自然升级）。
function normSession(s) {
  if (!s || typeof s !== 'object') return null
  const d = String(s.d == null ? '' : s.d)
  if (!isFinite(keyToMs(d))) return null
  const t = Number(s.t)
  if (!isFinite(t) || t <= 0) return null
  const m = Number(s.m)
  if (!isFinite(m) || m <= 0) return null
  const mins = Math.min(MINUTES_MAX, Math.max(1, Math.round(m)))
  const k = MODES[s.k] ? s.k : 'down'
  let start = Number(s.s)
  if (!isFinite(start) || start <= 0 || start > t) start = t - mins * 60000
  const id = String(s.id == null ? '' : s.id).trim().slice(0, SESSION_ID_MAX)
    || ('l' + Math.round(t).toString(36) + '-' + mins)
  const out = { id, d, s: Math.max(0, Math.round(start)), t: Math.round(t), m: mins, k }
  if (s.b === true || s.b === 1) out.b = 1
  if (s.a === true || s.a === 1) out.a = 1
  const todoId = String(s.todoId == null ? '' : s.todoId).trim().slice(0, SESSION_ID_MAX)
  const todoText = String(s.todoText == null ? '' : s.todoText).replace(/\s+/g, ' ').trim().slice(0, SESSION_TEXT_MAX)
  if (todoId) out.todoId = todoId
  if (todoText) out.todoText = todoText
  return out
}
// 归一 + 按结束时刻升序 + 同 id 去重（备份可被手工编辑，重复 id 会让「删一条」变成删两条）
// + 只留最新 SESSION_MAX 条。排序是为了让「超上限时保留最新的」有确定含义：输入顺序不该影响哪条被留下。
function normSessions(list) {
  const out = []
  if (!Array.isArray(list)) return out
  const seen = new Set()
  for (const s of list) {
    const one = normSession(s)
    if (!one) continue
    if (seen.has(one.id)) continue
    seen.add(one.id)
    out.push(one)
  }
  out.sort((a, b) => a.t - b.t)
  return out.length > SESSION_MAX ? out.slice(-SESSION_MAX) : out
}

// 一轮「番茄」的判定：倒计时、非休息、未放弃。全模块只有这一处口径。
function isRound(s) { return s.k === 'down' && !s.b && !s.a }

// 天表 = 明细的派生视图。legacy 是「只有天表、没有明细」的老日子（早期版本不记明细），
// 那些天没有可派生的依据，原样保留；一旦某天有了明细，就一律以明细为准。
function deriveDays(sessions, legacy) {
  const byDay = {}
  for (const s of normSessions(sessions)) {
    // 休息是两轮之间的缓冲，不是专注：分钟和轮数都不进天表，
    // 否则「专注 25 分钟 + 休息 5 分钟」会让今日时长虚高，用户看到的数字就不是专注。
    // 明细仍然保留休息行（设置页能看到它在休息），只是不参与聚合。
    if (s.b) continue
    const cur = byDay[s.d] || (byDay[s.d] = { r: 0, m: 0 })
    cur.m += s.m
    if (isRound(s)) cur.r += 1
  }
  const out = {}
  const src = legacy && typeof legacy === 'object' ? legacy : {}
  for (const k of Object.keys(src)) {
    if (byDay[k]) continue // 有明细的天不认老聚合
    if (!isFinite(keyToMs(k))) continue
    const d = src[k]
    if (!d || typeof d !== 'object') continue
    const r = Math.max(0, Math.round(Number(d.r) || 0))
    const m = Math.max(0, Math.round(Number(d.m) || 0))
    if (!r && !m) continue
    out[k] = { r, m }
  }
  for (const k of Object.keys(byDay)) out[k] = byDay[k]
  return out
}

// 整份状态过一遍派生：读盘后与写盘前都调它，保证「存储里的天表」永远不等于自己漂出来的值
function withDerived(state) {
  const base = state && typeof state === 'object' ? state : {}
  const sessions = normSessions(base.sessions)
  return { v: 2, days: deriveDays(sessions, base.days), sessions }
}

// 记一条会话。input = { endAt, startAt?, minutes?, mode?, isBreak?, abandoned?, todoId?, todoText?, dateKey? }
//   分钟：显式给了用显式的，否则按「结束 - 开始」算；真实但不足 1 分钟的按 1 分钟计
//   （30 秒放弃也是一次真实投入，记 0 分钟会让明细里出现看不出意义的空行）。
//   归属日：显式 dateKey 优先，否则取结束时刻的本地日 —— 跨零点的轮次记在结束那天。
// 返回新对象而不是原地改 —— 调用方拿到的是落库前的快照，原地改会让「写失败」时内存与存储不一致。
function appendSession(state, input) {
  const base = withDerived(state && typeof state === 'object' ? state : emptyFocus())
  const src = input && typeof input === 'object' ? input : {}
  const endAt = Number(src.endAt)
  if (!isFinite(endAt) || endAt <= 0) return base
  const startAt = Number(src.startAt)
  let mins = Math.round(Number(src.minutes))
  if (!isFinite(mins) || mins <= 0) {
    // 没给有效分钟，只能靠起止时刻反推：起止都合法才有「投入了多久」这件事
    if (!isFinite(startAt) || startAt <= 0 || endAt <= startAt) return base
    mins = Math.max(1, Math.round((endAt - startAt) / 60000))
  }
  const one = normSession({
    id: String(src.id == null ? '' : src.id),
    d: isFinite(keyToMs(src.dateKey)) ? String(src.dateKey) : localKey(endAt),
    s: Number(src.startAt),
    t: endAt,
    m: Math.min(MINUTES_MAX, Math.max(1, mins)),
    k: MODES[src.mode] ? src.mode : 'down',
    b: src.isBreak === true || src.isBreak === 1 ? 1 : 0,
    a: src.abandoned === true || src.abandoned === 1 ? 1 : 0,
    todoId: src.todoId,
    todoText: src.todoText,
  })
  if (!one) return base
  const sessions = base.sessions.slice()
  sessions.push(one)
  return { v: 2, days: deriveDays(sessions, state && state.days), sessions: normSessions(sessions) }
}

// 裁掉窗口外的日子：保留「今天往前 keepDays-1 天」这一段（含今天）。
// keepDays 非法时按 90 处理，避免调用方漏传参数把历史全删了。
// 先裁明细再派生天表：天表里那些「明细已被裁光」的老日子跟着窗口一起走，不会留下算不出来的孤数。
function pruneFocus(state, todayKey, keepDays) {
  const base = state && typeof state === 'object' ? state : {}
  const todayMs = keyToMs(todayKey)
  const keep = Math.max(1, Math.round(Number(keepDays) || 90))
  const all = normSessions(base.sessions)
  if (!isFinite(todayMs)) return { v: 2, days: deriveDays(all, base.days), sessions: all }
  const cutoff = todayMs - (keep - 1) * DAY_MS
  const keptSessions = []
  for (const s of all) {
    const ms = keyToMs(s.d)
    if (!isFinite(ms) || ms < cutoff || ms > todayMs) continue
    keptSessions.push(s)
  }
  const legacy = {}
  const src = base.days && typeof base.days === 'object' ? base.days : {}
  for (const k of Object.keys(src)) {
    const ms = keyToMs(k)
    if (!isFinite(ms) || ms < cutoff || ms > todayMs) continue
    legacy[k] = src[k]
  }
  return { v: 2, days: deriveDays(keptSessions, legacy), sessions: keptSessions }
}

// 汇总：给设置页出柱状图与三个数字。
//   series  —— 最近 days 天（含今天，按日期升序），没有记录的天补 0，方便直接画柱
//   today   —— 今天这一格
//   total   —— series 窗口内的合计（与图上看到的柱对得上，不会出现「图上 7 根柱、总数是 90 天」）
//   streak  —— 连续有记录的天数；今天还没记录时从昨天开始数（当天还没开始专注不算断）
//   todayByTodo —— 今天每条待办完成的轮数（只数合格轮：正计时/休息/放弃的不算「一轮」）
function summarize(state, todayKey, days) {
  const derived = withDerived(state)
  const src = derived.days
  const todayMs = keyToMs(todayKey)
  const n = Math.max(1, Math.min(366, Math.round(Number(days) || 7)))
  const series = []
  const total = { r: 0, m: 0 }
  const todayByTodo = {}
  if (!isFinite(todayMs)) return { series, today: { r: 0, m: 0 }, total, streak: 0, todayByTodo }
  for (const s of derived.sessions) {
    // 只数「今天 + 合格轮 + 绑定了待办」的会话：没绑任务的轮次已经在今日总数里，不该凭空多一条无主任务。
    // __proto__ 守卫：备份文件可被手工编辑，别让一个任务 id 改掉返回值原型。
    if (s.d !== todayKey || !s.todoId || s.todoId === '__proto__' || !isRound(s)) continue
    todayByTodo[s.todoId] = (todayByTodo[s.todoId] || 0) + 1
  }
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
  return { series, today: { r: today.r, m: today.m }, total, streak, todayByTodo }
}

// 每条待办的完成轮数（保留窗口内全量，不限今天）：待办上的「N 轮」由这里派生，
// 不再单独维护一个累加计数器 —— 那个计数器和明细各记各的，任务删了/裁剪了都不会回头。
function roundsByTodo(state) {
  const out = {}
  for (const s of withDerived(state).sessions) {
    if (!s.todoId || s.todoId === '__proto__' || !isRound(s)) continue
    out[s.todoId] = (out[s.todoId] || 0) + 1
  }
  return out
}

// 最近 N 天的会话明细（设置页「专注记录」列表用）：
// 与画图无关，单独列出来而不是塞进 summarize —— 挂件每次记一轮都会收一份 summary，
// 不需要跟着搬运最多几十条明细。
function listSessions(state, todayKey, days) {
  const todayMs = keyToMs(todayKey)
  if (!isFinite(todayMs)) return []
  const n = Math.max(1, Math.min(366, Math.round(Number(days) || 7)))
  const cutoff = todayMs - (n - 1) * DAY_MS
  const out = []
  for (const s of withDerived(state).sessions) {
    const ms = keyToMs(s.d)
    if (!isFinite(ms) || ms < cutoff || ms > todayMs) continue
    // round 是「这一条算不算一轮」的投影：口径只有 isRound 一处，页面读它渲染徽标即可。
    // 早先设置页按「明细条数 = 轮数」自己数，正计时 / 放弃 / 休息行一进明细就和柱状图打架。
    // 复制一份再挂：不把派生字段写回存储本体（withDerived 的结果会被别处复用）
    out.push(Object.assign({}, s, { round: isRound(s) ? 1 : 0 }))
  }
  // 设置页从上往下读：最新的一轮放最上面
  out.sort((a, b) => b.t - a.t)
  return out
}

// normSessions / withDerived 也导出：store.readFocus 读盘时要用同一份清洗与派生规则，
// 避免「写进去和读出来」两套口径
module.exports = {
  emptyFocus, withDerived, appendSession, deriveDays, isRound, pruneFocus,
  summarize, roundsByTodo, listSessions, normSessions, localKey, keyToMs, msToKey,
}
