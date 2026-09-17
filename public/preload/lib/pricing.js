/*
 * 峰谷时段判定与模型定价（CommonJS）。
 */
const { PEAK_HOURS, PRICING, WEEKEND_VALLEY_FROM_SEC } = require('./constants')
const { logErr } = require('./log')

function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // 0=周日 6=周六
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

// 下一个峰谷切换时刻（epoch 秒），取不到返回 0。
// 峰谷边界都落在整点，所以从下一个整点起按小时向后探测：周末全天谷价，最长要跨到周一 9:00，
// 留 8 天余量兜底。判定复用 isPeakTime，避免两处各写一套时段规则。
function nextPeakChangeAt(timeSec) {
  const n = Number(timeSec)
  if (!isFinite(n)) return 0
  const cur = isPeakTime(n)
  let t = Math.floor(n / 3600) * 3600 + 3600
  for (let i = 0; i < 24 * 8; i++, t += 3600) {
    if (isPeakTime(t) !== cur) return t
  }
  return 0
}

// 未命中价目表的模型名只记一次（同一模型每次刷新都会走到这里，不去重会把 dev 日志刷满）
const warnedModels = new Set()

function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  // 官方上新/改名时会落到这里：静默按 Flash 价回落会把 Pro 少算一半，留条日志便于发现
  if (m && !warnedModels.has(m)) {
    warnedModels.add(m)
    logErr('价目表未收录该模型，按默认（Flash）价计费：' + m)
  }
  return PRICING._default
}

// 自定义单价的币种换算倍率（把填的数折成人民币）：非 USD 恒为 1，USD 取 rate。
// 拿不到可用汇率时返回 0，调用方据此判定「这份自定义价不可用」——
// 宁可回落内置价目表，也不能把美元数额当人民币记进账本。
function customRate(p) {
  if (p.cur !== 'USD') return 1
  const rate = Number(p.rate)
  return isFinite(rate) && rate > 0 ? rate : 0
}

// 一份自定义单价（填的是谷价）→ 与内置表同结构的 [谷价, 峰价]。
// 峰价沿用官方规则（恰为谷价 2 倍）；单价填 0 表示该项不收费，属合法值。
function customPair(src, rate) {
  const pair = (v) => {
    const n = Number(v)
    const base = isFinite(n) && n > 0 ? n * rate : 0
    return [base, base * 2]
  }
  return { hit: pair(src.hit), miss: pair(src.miss), out: pair(src.out) }
}

// 全局自定义单价（设置页「用量与账本」的「自定义单价」开关）：返回与内置表同结构的 [谷价, 峰价]，
// 对平台返回的所有模型整表覆盖。开关关着、或填的币种是 USD 却没有可用汇率时返回 null。
function customPriceTable(custom) {
  const p = custom && custom.on ? custom : null
  if (!p) return null
  const rate = customRate(p)
  return rate > 0 ? customPair(p, rate) : null
}

// 「按模型覆盖」的单价：从 tokenPrice.models 里取第一条子串命中的条目（与内置表同匹配规则），
// 命中返回与内置表同结构的 [谷价, 峰价]，没配 / 没命中返回 null ——
// 调用方继续看全局覆盖，最后回落内置价目表。币种与汇率与全局覆盖共用一份。
function customModelPrice(custom, model) {
  const p = custom && typeof custom === 'object' ? custom : null
  if (!p || !Array.isArray(p.models) || !p.models.length) return null
  const m = String(model || '').toLowerCase()
  if (!m) return null
  const rate = customRate(p)
  if (rate <= 0) return null
  for (const it of p.models) {
    if (!it || typeof it !== 'object') continue
    const key = String(it.name || '').trim().toLowerCase()
    if (key && m.indexOf(key) !== -1) return customPair(it, rate)
  }
  return null
}

module.exports = { isPeakTime, nextPeakChangeAt, priceFor, customPriceTable, customModelPrice }
