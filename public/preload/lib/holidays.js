/*
 * 中国法定节假日表（CommonJS）—— 运行时「联网更新」覆盖层。
 *
 * 内置表 CN_HOLIDAYS 是手工抄的，且只有发版才能更新：官方次年安排在头一年 11 月前后才公布，
 * 跨年前后必然有「当年未收录」的空窗期。本模块让用户**手动点一下**就能从公开数据源拉取当年
 * （+ 次年）的放假日子，存进 dbStorage，判定时与内置表合并。
 *
 * 设计原则（与项目「离线优先」一致）：
 *   - **默认零网络**：不自动联网，只在用户点「更新节假日表」时才发请求；
 *   - **纯加法**：拉到的表只做「并集」，不删内置表里的日子，也不会把内置改坏；
 *   - **可回退**：拉取失败/清空后立刻回到内置表，插件照常可用。
 *
 * 数据源：vsme/chinese-days 的按年份 JSON（走 jsDelivr CDN，比 GitHub Raw 稳），字段：
 *   { holidays: { 'YYYY-MM-DD': '名称,别名,类型' }, workdays: {...}, inLieuDays: {...} }
 * 我们**只取 holidays**（放假日子，全天谷价）；workdays（调休补班）与 inLieuDays（调休借用）
 * 官方定价规则未明说，屯着不用（本模块只判放假）。
 *
 * 依赖方向：constants（内置表 / 存储键）→ log。绝不 require pricing（避免循环：pricing 依赖本模块）。
 */
const { CN_HOLIDAYS, K } = require('./constants')
const { log, logErr } = require('./log')

// 数据源：主源走 jsDelivr CDN，回退 GitHub Raw 与 ghproxy 加速（镜像多源，任一可用即可）。
// 顺序参考 lib/dsh-notes.js 的 SOURCES：先用最稳的 CDN，再退到 GitHub 直连/加速。
const SOURCES = [
  (y) => 'https://cdn.jsdelivr.net/npm/chinese-days/dist/years/' + y + '.json',
  (y) => 'https://fastly.jsdelivr.net/npm/chinese-days/dist/years/' + y + '.json',
  (y) => 'https://gh-proxy.com/https://raw.githubusercontent.com/vsme/chinese-days/main/dist/years/' + y + '.json',
]

// 单源超时；两年份 × 三源，总预算控制在可接受范围（用户主动触发，可多等一会儿）
const TIMEOUT_MS = 8000

// 拉取时一次覆盖的年份跨度：当年 + 次年。当年是刚需；次年随官方公布后一并拿到，
// 正是为了提前填掉「跨年空窗期」，不用等到元旦才发现没收录。
const SPAN = 2

let override = null // { fetchedAt, dates: Set<string>, years: Set<string> } | null（null = 未加载）

function readOverride() {
  try {
    const raw = utools.dbStorage.getItem(K.cnHolidays)
    if (!raw || !Array.isArray(raw.dates)) return null
    const dates = new Set()
    for (const d of raw.dates) {
      if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d)
    }
    const years = new Set()
    for (const d of dates) years.add(d.slice(0, 4))
    return { fetchedAt: Number(raw.fetchedAt) || 0, dates, years, sources: raw.sources || {} }
  } catch (err) {
    // 读存储失败属预期分支（首次无数据 / 被清过）：回退内置表，不值得刷错误日志
    return null
  }
}

// 惰性加载一次（挂件每次刷新都会走判定，不能每次都读存储）
function ensureLoaded() {
  if (override === null) override = readOverride()
  return override
}

// 单日是否法定节假日：内置表 ∪ 联网覆盖表。取不到（未加载）时只认内置表。
function isHoliday(dayKey) {
  if (CN_HOLIDAYS.has(dayKey)) return true
  const o = ensureLoaded()
  return o ? o.dates.has(dayKey) : false
}

// 节假日表覆盖的年份集合（内置 ∪ 覆盖层），供跨年兜底判断「当年是否已收录」
function coveredYears() {
  const set = new Set()
  for (const k of CN_HOLIDAYS) set.add(String(k).slice(0, 4))
  const o = ensureLoaded()
  if (o) for (const y of o.years) set.add(y)
  return set
}

// ──────────────────────────────────────────────
// 联网拉取
// ──────────────────────────────────────────────

// 从单源取某年份的放假日子列表；失败抛异常（由调用方回退下一源）。只认合法 JSON 结构。
async function fetchYear(url, budget) {
  const res = await fetch(url, { signal: AbortSignal.timeout(budget) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const data = await res.json()
  const holidays = data && data.holidays
  if (!holidays || typeof holidays !== 'object') throw new Error('返回结构缺少 holidays')
  const out = []
  for (const key of Object.keys(holidays)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) out.push(key)
  }
  if (!out.length) throw new Error('holidays 为空')
  return out
}

// 取一个年份：按 SOURCES 逐个回退，拿到合法结果就停（与 dsh-notes.load 同思路）
async function fetchYearAllSources(year) {
  const t0 = Date.now()
  let lastErr = null
  for (let i = 0; i < SOURCES.length; i++) {
    const left = TIMEOUT_MS - (Date.now() - t0)
    if (left <= 800) break
    // 均摊剩余预算给「还没试过的源」，避免第一个源白等超时后后面全饿死
    const budget = Math.max(800, Math.floor(left / (SOURCES.length - i)))
    try {
      const dates = await fetchYear(SOURCES[i](year), budget)
      if (i > 0) log('[whale][holidays] ' + year + '：前面的源不可用，已改用 SOURCES[' + i + ']')
      return { year: year, dates: dates, source: i }
    } catch (err) {
      lastErr = err
      // 回退属预期分支，用 log 不刷错误
      log('[whale][holidays] ' + year + ' 源 #' + (i + 1) + ' 失败:', (err && err.message) || err)
    }
  }
  throw new Error('所有源均不可用：' + ((lastErr && lastErr.message) || lastErr))
}

// 对外入口：拉当年 + 次年，与内置表**合并**后落盘。返回 { ok, added, years, error }，失败不抛。
// force 目前不影响行为（总是重新拉），保留形参只为将来做 TTL 缓存留口子。
async function update(timeSec) {
  const now = Number.isFinite(Number(timeSec)) ? Number(timeSec) : Math.floor(Date.now() / 1000)
  const bjYear = new Date(now * 1000 + 8 * 3600 * 1000).getUTCFullYear()
  const targets = []
  for (let i = 0; i < SPAN; i++) targets.push(bjYear + i)

  const collected = []
  const sources = {}
  const failed = []
  for (const y of targets) {
    try {
      const r = await fetchYearAllSources(y)
      collected.push(...r.dates)
      sources[y] = r.source
    } catch (err) {
      failed.push(y)
      logErr('[whale][holidays] 拉取 ' + y + ' 年失败', (err && err.message) || err)
    }
  }
  if (!collected.length) {
    return { ok: false, added: 0, years: [], sources: sources, error: '未能从数据源取到任何节假日（网络或数据源异常）' }
  }

  // 与内置表合并（并集）：拉到的不删内置，内置的本就不重复落盘
  const next = new Set(collected)
  const o = ensureLoaded()
  if (o) for (const d of o.dates) next.add(d) // 保留上次拉到但本次没覆盖的年份（如更早的年份）
  const dates = Array.from(next).sort()

  const years = Array.from(new Set(dates.map((d) => d.slice(0, 4)))).sort()
  const payload = { fetchedAt: now, dates: dates, years: years, sources: sources, failed: failed }
  try {
    utools.dbStorage.setItem(K.cnHolidays, payload)
  } catch (err) {
    logErr('[whale][holidays] 写存储失败', err && err.message)
    return { ok: false, added: 0, years: [], sources: sources, error: '写入本地存储失败' }
  }
  override = { fetchedAt: now, dates: next, years: new Set(years), sources: sources }

  const added = dates.filter((d) => !o || !o.dates.has(d)).length
  log('[whale][holidays] 已更新：' + dates.length + ' 天 / ' + years.join(',') + (failed.length ? '（' + failed.join(',') + ' 年失败）' : ''))
  return { ok: true, added: added, total: dates.length, years: years, sources: sources, failed: failed }
}

// 清除联网覆盖层，回到纯内置表
function clear() {
  try { utools.dbStorage.removeItem(K.cnHolidays) } catch (err) { logErr('[whale][holidays] 清除存储失败', err && err.message) }
  override = null
  return { ok: true }
}

// 当前状态快照（供设置页展示）：是否启用了覆盖层、覆盖了哪些年份、拉取时间、各年命中的源
function status() {
  const o = ensureLoaded()
  const builtinYears = Array.from(new Set(Array.from(CN_HOLIDAYS).map((d) => String(d).slice(0, 4)))).sort()
  if (!o) return { updated: false, fetchedAt: 0, total: 0, years: [], builtinYears: builtinYears, sources: {} }
  return {
    updated: true,
    fetchedAt: o.fetchedAt,
    total: o.dates.size,
    years: Array.from(o.years).sort(),
    builtinYears: builtinYears,
    sources: o.sources || {},
  }
}

// 单测用：清掉内存缓存，强制重新读存储
function _resetCache() { override = null }

// ── 备份 / 恢复（供 lib/backup.js 调用）──
// 导出：把覆盖层的原始载荷（落库那份结构）原样交出去；没有覆盖层时返回 null（备份里就不带这一项）
function snapshot() {
  try {
    const raw = utools.dbStorage.getItem(K.cnHolidays)
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.dates)) return null
    return raw
  } catch (err) { return null }
}

// 恢复：校验载荷结构后按原样写回，并刷新内存缓存。
// 校验口径与 readOverride 一致（dates 必须为 YYYY-MM-DD 字符串数组），挡掉手改坏 / 跨版本的脏数据
function restore(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.dates)) return false
  const dates = []
  for (const d of raw.dates) {
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) dates.push(d)
  }
  if (!dates.length) return false
  const sorted = dates.slice().sort()
  const years = Array.from(new Set(sorted.map((d) => d.slice(0, 4)))).sort()
  const payload = {
    fetchedAt: Number(raw.fetchedAt) || Date.now(),
    dates: sorted,
    years: years,
    sources: raw.sources && typeof raw.sources === 'object' ? raw.sources : {},
  }
  try {
    utools.dbStorage.setItem(K.cnHolidays, payload)
  } catch (err) {
    logErr('[whale][holidays] 恢复覆盖层写存储失败', err && err.message)
    return false
  }
  override = { fetchedAt: payload.fetchedAt, dates: new Set(sorted), years: new Set(years), sources: payload.sources }
  return true
}

module.exports = { isHoliday, coveredYears, update, clear, status, snapshot, restore, SOURCES, SPAN, _resetCache }
