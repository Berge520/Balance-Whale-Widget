/*
 * 峰谷时段判定与模型定价（CommonJS）。
 *
 * 峰谷判据以 DeepSeek 官方定价页为准（api-docs.deepseek.com/zh-cn/quick_start/pricing/），原文：
 *   「北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；
 *     其余时段，包括周末及中国法定节假日全天均为空闲时段。」
 * 注意判据是「周一至周五」而不是「工作日」：只认星期几 + 法定节假日两条，与调休 / 补班无关。
 */
const { PEAK_HOURS, PRICING } = require('./constants')
const { logErr } = require('./log')
// 节假日判定收进 holidays 模块（内置 CN_HOLIDAYS ∪ 用户手动联网更新的覆盖层）。
// 只 require holidays，不直接碰 CN_HOLIDAYS —— 否则「联网更新」对判定无效。
const holidays = require('./holidays')

// 北京时间 YYYY-MM-DD（isPeakTime 与节假日表都用这一格式）
function bjDayKey(timeSec) {
  const bj = new Date(Number(timeSec) * 1000 + 8 * 3600 * 1000)
  const p2 = (n) => String(n).padStart(2, '0')
  return bj.getUTCFullYear() + '-' + p2(bj.getUTCMonth() + 1) + '-' + p2(bj.getUTCDate())
}

function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  // 法定节假日全天谷价：放假日常落在工作日，只看星期几会把它们当峰时按双倍价记账。
  if (holidays.isHoliday(bjDayKey(n))) return false
  // 周末全天谷价。官方判据是「周一至周五」而非「工作日」——只认星期几与法定节假日两条，
  // 与调休 / 补班无关。所以补班日即便要上班也仍是谷：它落在周六周日，星期几这条就不满足。
  // 反过来说，若哪天把补班日（源里的 workdays）当工作日算，反而会给周六的 9-12 点算出峰价，
  // 与官方口径相反。这一层不要接 workdays。
  const dow = bj.getUTCDay() // 0=周日 6=周六
  if (dow === 0 || dow === 6) return false
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

// 节假日表覆盖的年份集合（内置 ∪ 联网更新层，见 holidays.coveredYears）。
// 官方次年安排一般头一年 11 月前后才公布，跨年前后必然有一段空窗期：空窗期内当年日期查不到，
// 放假的工作日会被按峰时高估。这里不改变判定（仍按普通工作日算），只在「当年未被覆盖」时
// 记一次日志、便于发现「该更新表了」，而不是让用户以为算错了。
// 当前时间所属年份是否已收录在节假日表里。取不到时间（无效入参）当作已覆盖，不误报。
function holidayCalendarCovers(timeSec) {
  const n = Number(timeSec)
  if (!isFinite(n)) return true
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  return holidays.coveredYears().has(String(bj.getUTCFullYear()))
}

// 未覆盖年份只提示一次（每次刷新都会走到，不去重会把 dev 日志刷满）
let warnedHolidayYear = ''

function warnIfHolidayCalendarStale(timeSec) {
  const n = Number(timeSec)
  if (!isFinite(n)) return
  if (holidayCalendarCovers(n)) return
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  const y = String(bj.getUTCFullYear())
  if (warnedHolidayYear === y) return
  warnedHolidayYear = y
  logErr('节假日表未覆盖 ' + y + ' 年，该年的法定节假日将按普通工作日判定（可能把放假日子按峰时高估）；可在设置页「外观与形象」点「更新节假日表」拉取')
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

module.exports = { isPeakTime, nextPeakChangeAt, holidayCalendarCovers, warnIfHolidayCalendarStale, priceFor, customPriceTable, customModelPrice }
