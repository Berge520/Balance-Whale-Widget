/*
 * 余额 / 用量拉取与更新检查（CommonJS）。
 */
// 强制 IPv4 优先：部分用户的 IPv6 不通（如只配了 IPv4 DNS），
// 智谱 open.bigmodel.cn 等域名有 AAAA 记录，Node fetch 会优先走 IPv6 导致连接超时
try { require('dns').setDefaultResultOrder('ipv4first') } catch (_) {}

const {
  BALANCE_URL, USAGE_URL, BALANCE_TTL_MS, FETCH_TIMEOUT_MS,
  UPDATE_CHECK_URL, PLUGIN_VERSION, UPDATE_TTL_MS, K,
  MODEL_FETCH_TIMEOUT_MS, MODEL_STALE_MS, MODEL_MONEY_PREFIX,
} = require('./constants')
const { logErr } = require('./log')
const {
  readSecrets, sanitizeKey, recordLedgerUsage, keyFingerprint, readConfig, setTodayUsage,
  claimDailyNotice, readModelState, writeModelState, todayKey, alertFor, alertOneLine,
} = require('./store')
const { isPeakTime, nextPeakChangeAt, priceFor, customPriceTable, customModelPrice } = require('./pricing')
const codex = require('./codex')

// ──────────────────────────────────────────────
// 余额
// ──────────────────────────────────────────────
function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null
  const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
  return (
    infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
    infos.find((x) => num(x) > 0) ||
    infos.find((x) => x && x.currency === 'CNY') ||
    infos[0]
  )
}

async function fetchBalanceWith(rawKey) {
  const apiKey = sanitizeKey(rawKey)
  if (!apiKey) return { ok: false, code: 'NO_KEY', error: '未配置 DeepSeek API Key' }
  if (!/^sk-[A-Za-z0-9_-]+$/.test(apiKey)) {
    return {
      ok: false,
      code: 'BAD_KEY',
      transient: false,
      error: 'API Key 格式不正确：应以 sk- 开头且不含空格/中文（请填写 api.deepseek.com 的 API Key，不是「平台 Token」）',
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue }
      return {
        ok: false, code: 'HTTP', transient: true,
        error: '网络请求失败（超时或无法连接 api.deepseek.com），请检查网络/代理后重试',
      }
    }
    if (!res.ok) {
      // 读取 DeepSeek 返回的具体错误：{"error":{"message":"...","type":"authentication_error"}}
      let serverMsg = ''
      try {
        const j = await res.json()
        serverMsg = (j && j.error && j.error.message) ? String(j.error.message) : ''
      } catch (err) {
        try { serverMsg = (await res.text()).slice(0, 160) } catch (e2) {}
      }
      if (res.status === 401) {
        return {
          ok: false, code: 'AUTH', transient: false,
          error: 'API Key 无效或已过期（401）。请确认填的是 platform.deepseek.com「API keys」里 sk- 开头的密钥，而不是「平台 Token」；若刚复制请重新完整复制后再保存。' +
                 (serverMsg ? '（服务器：' + serverMsg.slice(0, 120) + '）' : ''),
        }
      }
      if (res.status < 500) {
        return {
          ok: false, code: 'HTTP', transient: false,
          error: '余额接口返回 HTTP ' + res.status + (serverMsg ? '：' + serverMsg : ''),
        }
      }
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue }
      return {
        ok: false, code: 'HTTP', transient: true,
        error: '余额接口暂时不可用（HTTP ' + res.status + (serverMsg ? '：' + serverMsg : '') + '）',
      }
    }
    let data
    try { data = await res.json() } catch (err) {
      return { ok: false, code: 'PARSE', transient: false, error: '余额接口返回不是合法 JSON' }
    }
    const info = pickBalanceInfo(data && data.balance_infos)
    if (!info || info.total_balance === undefined) {
      return { ok: false, code: 'SHAPE', transient: false, error: '余额接口返回结构异常' }
    }
    // 赠送/充值分项余额：赠送额可能整块到期被收回，记账时要与真实消费区分开
    const numOrNull = (v) => {
      const n = Number(v)
      return v !== undefined && v !== null && v !== '' && isFinite(n) ? n : null
    }
    return {
      ok: true,
      totalBalance: Number(info.total_balance),
      grantedBalance: numOrNull(info.granted_balance),
      toppedUpBalance: numOrNull(info.topped_up_balance),
      currency: String(info.currency || 'CNY'),
      updatedAt: new Date().toISOString(),
    }
  }
  return { ok: false, code: 'HTTP', transient: true, error: '余额接口请求失败，请稍后重试' }
}

// ──────────────────────────────────────────────
// 平台用量（token 模式）
// ──────────────────────────────────────────────
function computeTodayUsage(data, custom) {
  // data.data.biz_data.series[]: [{model, buckets:[{time, usage:{RESPONSE_TOKEN, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN}}]}]
  let d = data
  if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
  else if (d && d.data && Array.isArray(d.data.series)) d = d.data
  const series = Array.isArray(d.series) ? d.series : null
  if (!series || series.length === 0) return null
  // 自定义单价的取价顺序：按模型覆盖（tokenPrice.models）→ 全局覆盖（tokenPrice.on）→ 内置价目表。
  // 只想改某几档模型的价时，只加条目、不勾全局开关，其余模型照旧用内置表
  const customPr = customPriceTable(custom)
  let cost = 0
  let tokens = 0
  let found = false
  // 按模型聚合金额（设置页「今日模型占比」用），model 缺失时归到空名一组由前端显示「未知模型」
  const byModel = new Map()
  for (const s of series) {
    if (!s || typeof s !== 'object') continue
    const pr = customModelPrice(custom, s.model) || customPr || priceFor(s.model)
    const name = s.model == null ? '' : String(s.model)
    const buckets = Array.isArray(s.buckets) ? s.buckets : []
    for (const b of buckets) {
      const u = b && b.usage
      if (!u || typeof u !== 'object') continue
      const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
      const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
      const out = Number(u.RESPONSE_TOKEN) || 0
      if (hit + miss + out === 0) continue
      found = true
      tokens += hit + miss + out
      const pi = isPeakTime(b.time) ? 1 : 0
      const c = (hit / 1e6) * pr.hit[pi] + (miss / 1e6) * pr.miss[pi] + (out / 1e6) * pr.out[pi]
      cost += c
      const m = byModel.get(name) || { model: name, amount: 0, tokens: 0 }
      m.amount += c
      m.tokens += hit + miss + out
      byModel.set(name, m)
    }
  }
  if (!found) return null
  const models = Array.from(byModel.values()).sort((a, b) => b.amount - a.amount)
  return { amount: cost, tokens, byModel: models }
}

async function fetchPlatformUsage(platformToken, custom) {
  const token = String(platformToken || '').replace(/^Bearer\s+/i, '')
  if (!token) return { error: 'no platform token' }
  const now = new Date()
  const tz = -now.getTimezoneOffset() * 60
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
  const end = start + 86400
  const url = USAGE_URL + '?start=' + start + '&end=' + end + '&tz=' + tz
  try {
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { error: 'http ' + res.status }
    const data = await res.json()
    const u = computeTodayUsage(data, custom)
    if (u && isFinite(u.amount)) return { amount: u.amount, tokens: u.tokens, byModel: u.byModel }
    return { error: 'no usage' }
  } catch (err) {
    return { error: String((err && err.message) || err) }
  }
}

// ──────────────────────────────────────────────
// 多厂商模型：余额 / 额度查询
// ──────────────────────────────────────────────
// 按 'a.b[0].c' 取 JSON 路径；数组段也可按字段挑条目：'balance_infos[currency=CNY].total_balance'。
// 任一段缺失返回 undefined（与「取到 null」区分开）
function pickPath(obj, path) {
  const p = String(path == null ? '' : path).trim()
  if (!p) return undefined
  let cur = obj
  for (const seg of p.split('.')) {
    if (!seg || cur === null || cur === undefined) return undefined
    const m = /^([^[\]]*)((?:\[[^[\]]+\])*)$/.exec(seg)
    if (!m) return undefined
    if (m[1]) {
      if (typeof cur !== 'object') return undefined
      cur = cur[m[1]]
    }
    for (const raw of m[2] ? m[2].match(/\[[^[\]]+\]/g) || [] : []) {
      if (!Array.isArray(cur)) return undefined
      const key = raw.slice(1, -1).trim()
      const eq = key.indexOf('=')
      if (eq < 0) {
        if (!/^\d+$/.test(key)) return undefined
        cur = cur[Number(key)]
        continue
      }
      // 按字段挑条目：DeepSeek 的 balance_infos 会带多条币种、顺序不固定，按下标取可能拿到
      // 另一种币种的余额 —— 金额取错不会报错，只会把钱显示错
      const field = key.slice(0, eq).trim()
      const want = key.slice(eq + 1).trim()
      cur = cur.find((it) => it && typeof it === 'object' && String(it[field]) === want)
    }
  }
  return cur
}
// 数值化取路径：null/undefined/空串一律当「没取到」——Number('') 是 0，直接用会把空值误判成 0
function pathNum(obj, path) {
  const v = pickPath(obj, path)
  if (v === undefined || v === null || v === '') return NaN
  const n = Number(v)
  return isFinite(n) ? n : NaN
}
// 重置时刻：接口可能给秒 / 毫秒 / 微秒时间戳或 ISO 字符串，统一归一到毫秒
function normResetAt(v) {
  if (v === undefined || v === null || v === '') return 0
  const s = String(v)
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (!isFinite(n) || n <= 0) return 0
    if (n > 1e15) return Math.round(n / 1000) // 微秒
    return n > 1e12 ? Math.round(n) : Math.round(n * 1000) // 毫秒 / 秒
  }
  const t = Date.parse(s)
  return isFinite(t) ? t : 0
}
// 金额文案：CNY → '¥ 12.34'，USD → '$12.34'，其它币种 → '12.34 XXX'
function modelMoney(v, currency) {
  const fixed = (Number(v) || 0).toFixed(2)
  const pre = MODEL_MONEY_PREFIX[currency]
  return pre ? pre + fixed : fixed + ' ' + String(currency || '')
}
function modelAuthHeaders(model, key) {
  // 智谱那类接口不带 Bearer，Authorization 里直接放密钥
  return { Authorization: model.auth === 'raw' ? key : 'Bearer ' + key }
}
function resolveModelUrl(u, base) {
  return String(u || '').replace('{base}', String(base || '').replace(/\/+$/, ''))
}
async function fetchModelJson(url, model, key) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(url, {
        headers: modelAuthHeaders(model, key),
        signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue }
      return { ok: false, error: '网络请求失败（超时或无法连接），请检查网络/代理' }
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'API Key 无效或无权限（HTTP ' + res.status + '）' }
      }
      if (res.status >= 500 && attempt === 0) { await new Promise((r) => setTimeout(r, 500)); continue }
      return { ok: false, error: '接口返回 HTTP ' + res.status }
    }
    try {
      return { ok: true, data: await res.json() }
    } catch (err) {
      return { ok: false, error: '接口返回不是合法 JSON' }
    }
  }
  return { ok: false, error: '接口请求失败，请稍后重试' }
}
// 余额：优先用「余额字段」；若配了「已用字段」再相减（OpenRouter 只给总额度与已用）
async function parseModelBalance(model, data, key) {
  const raw = pathNum(data, model.path)
  if (!isFinite(raw)) {
    return { ok: false, error: model.path ? '字段路径取不到数值：' + model.path : '请填写余额字段路径' }
  }
  let amount = raw * model.scale
  if (model.usedPath) {
    let src = data
    if (model.usedUrl) {
      const u = resolveModelUrl(model.usedUrl, model.baseUrl)
      if (!/^https?:\/\//i.test(u)) return { ok: false, error: '已用额度接口地址无效' }
      const r2 = await fetchModelJson(u, model, key)
      if (!r2.ok) return r2
      src = r2.data
    }
    const used = pathNum(src, model.usedPath)
    if (isFinite(used)) amount -= used * model.usedScale
  }
  return { ok: true, balance: Math.round(amount * 10000) / 10000, currency: model.currency }
}
// 单个额度窗口：三种接口形态统一归一成「已用百分比 + 重置时刻」。
// spec 既可以是模型的顶层字段，也可以是 windows[] 里的一项 —— 两者字段名相同
function quotaWindow(spec, data) {
  let usedPct = NaN
  if (spec.usedPctPath) usedPct = pathNum(data, spec.usedPctPath)
  else if (spec.remainPctPath) usedPct = 100 - pathNum(data, spec.remainPctPath)
  else if (spec.remainPath && spec.totalPath) {
    const r = pathNum(data, spec.remainPath)
    const t = pathNum(data, spec.totalPath)
    if (isFinite(r) && isFinite(t) && t > 0) usedPct = 100 - (r / t) * 100
  }
  if (!isFinite(usedPct)) return null
  return {
    usedPct: Math.max(0, Math.min(100, Math.round(usedPct * 10) / 10)),
    resetAt: spec.resetPath ? normResetAt(pickPath(data, spec.resetPath)) : 0,
  }
}
// 订阅额度。多窗口接口（OpenCode Go 的 5h/周/月、MiniMax 的 5h/周）走 model.windows；
// 此时首个窗口的值同时写到顶层 usedPct/resetAt —— 挂件主显示与低额度预警都按单窗口取值，
// 不改成「多窗口」的话这些既有链路都不用动。
function parseModelQuota(model, data) {
  const specs = Array.isArray(model.windows) && model.windows.length ? model.windows : [model]
  const windows = []
  for (const s of specs) {
    const w = quotaWindow(s, data)
    if (w) windows.push({ key: String(s.key || ''), label: String(s.label || ''), usedPct: w.usedPct, resetAt: w.resetAt })
  }
  if (!windows.length) return { ok: false, error: '额度字段取不到数值，请检查「高级」里的字段路径' }
  return {
    ok: true,
    usedPct: windows[0].usedPct,
    resetAt: windows[0].resetAt,
    windows: windows,
    currency: model.currency,
  }
}
// Codex 本地会话统计（kind='codex'）：值来自 lib/codex.js 解析 ~/.codex 的会话日志，
// 不查接口也不要密钥。复用「余额」那套运行时状态，只是把金额换成 token 数
function parseModelCodex() {
  const r = codex.codexSummary()
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Codex 会话统计失败' }
  // codexWindows 单独取名，不与额度型的 windows（QuotaWindow[]）混用
  return { ok: true, tokens: r.todayTokens, monthTokens: r.monthTokens, codexWindows: r.windows || null }
}
// 查询单个模型：纯查询、不写任何状态（设置页「测试」与批量刷新共用同一条路径）
async function fetchModelBalance(model, rawKey) {
  if (model.kind === 'codex') return parseModelCodex()
  const key = sanitizeKey(rawKey)
  if (!key) return { ok: false, error: '未配置 API Key' }
  const url = resolveModelUrl(model.url, model.baseUrl)
  if (/\{base\}/.test(url)) return { ok: false, error: '请先填写 Base URL' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '接口地址需以 http(s):// 开头' }
  const r = await fetchModelJson(url, model, key)
  if (!r.ok) return r
  return model.kind === 'quota' ? parseModelQuota(model, r.data) : parseModelBalance(model, r.data, key)
}

// 低余额系统通知（每模型每天最多一次）。与 DeepSeek 的 maybeNotifyLow 同口径：
// 免打扰时段内不占用当天名额（不写标记），出时段后仍会补发。
function notifyModelLow(model, balance, threshold, cfg) {
  if (inQuietHours(cfg)) return false
  const text = model.name + ' 余额仅剩 ' + modelMoney(balance, model.currency) +
    '，已低于预警阈值 ' + modelMoney(threshold, model.currency)
  try { utools.showNotification(text, 'whale') } catch (err) { logErr('[whale][notify] 系统通知失败', err && err.message) }
  return true
}

// 刷新一批模型的运行时状态：查询 → 余额差估算今日已用 → 低余额预警 → 落库。
// ids 省略 = 全部；force=false 时距上次拉取不足 MODEL_STALE_MS 的跳过（挂件菜单打开时的懒加载）。
// 内置 DeepSeek 不在这里 —— 它走原有的 getBalance 链路。
async function refreshModels(ids, force) {
  const cfg = readConfig()
  const list = Array.isArray(cfg.models) ? cfg.models : []
  const want = Array.isArray(ids) && ids.length ? ids : null
  const secrets = readSecrets()
  const st = readModelState()
  const today = todayKey()
  for (const m of list) {
    if (want && want.indexOf(m.id) < 0) continue
    const cur = st[m.id] && typeof st[m.id] === 'object' ? st[m.id] : {}
    const at = typeof cur.at === 'number' ? cur.at : 0
    if (!force && at && Date.now() - at < MODEL_STALE_MS) continue
    const r = await fetchModelBalance(m, secrets.models[m.id])
    const next = Object.assign({}, cur, { at: Date.now(), currency: m.currency, date: today })
    if (!r.ok) {
      next.error = r.error
      st[m.id] = next
      continue
    }
    next.error = ''
    if (r.tokens !== undefined) {
      // Codex 本地会话统计：没有金额与额度，只存 token 数（今日 / 本月）
      next.tokens = r.tokens
      next.monthTokens = r.monthTokens
      // 订阅窗口（5h / 周）：跟着本地统计一起刷新，挂件说明行与设置页模型行都要用；
      // 换成 API-key 计费后日志里不再有快照，这里要清掉旧值，否则挂件会一直显示过期的窗口
      if (r.codexWindows) next.codexWindows = r.codexWindows
      else delete next.codexWindows
      delete next.balance
      delete next.todayUsage
      delete next.prevBalance
      delete next.usedPct
      delete next.resetAt
      delete next.windows
    } else if (r.balance !== undefined) {
      // 今日已用：本插件拦不到对话，只能按余额差估算（挂件上带 ~ 标记）
      let used = cur.date === today && typeof cur.todayUsage === 'number' ? cur.todayUsage : 0
      if (cur.date === today && typeof cur.prevBalance === 'number' && cur.prevBalance > r.balance) {
        used += cur.prevBalance - r.balance
      }
      next.balance = r.balance
      next.todayUsage = Math.round(used * 10000) / 10000
      next.prevBalance = r.balance
      delete next.usedPct
      delete next.resetAt
      delete next.windows
      const th = Number(m.lowAlertAmount) || 0
      if (m.lowAlertOn && th > 0 && r.balance < th && cur.lowNotifiedOn !== today &&
          notifyModelLow(m, r.balance, th, cfg)) {
        next.lowNotifiedOn = today
      }
    } else {
      next.usedPct = r.usedPct
      next.resetAt = r.resetAt
      if (Array.isArray(r.windows)) next.windows = r.windows
      else delete next.windows
      delete next.balance
      delete next.todayUsage
      delete next.prevBalance
    }
    st[m.id] = next
  }
  writeModelState(st)
  return st
}

// 组装给挂件 / 设置页的模型列表。内置 DeepSeek 那条从全局余额与全局配置取（只读），
// 其余从各自条目 + 运行时状态取 —— 差异只在这一个装配函数里。
// 状态里的 windows 来自 dbStorage，可能被旧版本或手工改坏，取用前按形状过滤一遍
function normStateWindows(v) {
  if (!Array.isArray(v)) return null
  const out = []
  for (const w of v) {
    if (!w || typeof w !== 'object') continue
    const pct = Number(w.usedPct)
    if (!isFinite(pct)) continue
    out.push({ key: String(w.key || ''), label: String(w.label || ''), usedPct: pct, resetAt: Number(w.resetAt) || 0 })
  }
  return out.length ? out : null
}
// Codex 订阅窗口：同样来自 dbStorage，取用前按形状过滤（两个窗口都空就当没有）
function normStateCodexWindows(v) {
  if (!v || typeof v !== 'object') return null
  const one = (w) => {
    if (!w || typeof w !== 'object') return null
    const pct = w.usedPct === null || w.usedPct === undefined ? null : Number(w.usedPct)
    return {
      usedPct: isFinite(pct) ? pct : null,
      resetAt: Number(w.resetAt) || null,
      windowMinutes: Number(w.windowMinutes) || null,
      label: String(w.label || ''),
    }
  }
  const primary = one(v.primary)
  const secondary = one(v.secondary)
  if (!primary && !secondary) return null
  return {
    primary, secondary,
    planType: String(v.planType || ''),
    limitName: String(v.limitName || ''),
    reached: String(v.reached || ''),
  }
}
function getModelsPayload() {
  const cfg = readConfig()
  const st = readModelState()
  const bal = getCachedBalance()
  const list = [{
    id: 'deepseek', name: 'DeepSeek', kind: 'balance', currency: (bal && bal.currency) || 'CNY',
    builtin: true,
    balance: bal && bal.ok && typeof bal.totalBalance === 'number' ? bal.totalBalance : null,
    todayUsage: bal && bal.ok && typeof bal.todayUsage === 'number' ? bal.todayUsage : null,
    usedPct: null, resetAt: 0, windows: null, at: 0,
    tokens: null, monthTokens: null, codexWindows: null,
    error: bal && !bal.ok ? String(bal.error || '') : '',
    lowAlertOn: cfg.lowAlertOn, lowAlertAmount: cfg.lowAlertAmount,
  }]
  for (const m of cfg.models) {
    const s = st[m.id] && typeof st[m.id] === 'object' ? st[m.id] : {}
    list.push({
      id: m.id, name: m.name, kind: m.kind, currency: m.currency, builtin: false,
      balance: typeof s.balance === 'number' ? s.balance : null,
      todayUsage: typeof s.todayUsage === 'number' ? s.todayUsage : null,
      usedPct: typeof s.usedPct === 'number' ? s.usedPct : null,
      resetAt: typeof s.resetAt === 'number' ? s.resetAt : 0,
      windows: normStateWindows(s.windows),
      tokens: typeof s.tokens === 'number' ? s.tokens : null,
      monthTokens: typeof s.monthTokens === 'number' ? s.monthTokens : null,
      codexWindows: normStateCodexWindows(s.codexWindows),
      at: typeof s.at === 'number' ? s.at : 0,
      error: String(s.error || ''),
      lowAlertOn: m.lowAlertOn, lowAlertAmount: m.lowAlertAmount,
    })
  }
  return { list: list, mainModelId: cfg.mainModelId }
}

// ──────────────────────────────────────────────
// 检查更新
// ──────────────────────────────────────────────
function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function isNewerVersion(latest, current) {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

let updateInFlight = null
// force=false 时命中 12 小时缓存直接返回（fresh=false）；force=true 强制联网检查
function checkUpdate(force) {
  const now = Date.now()
  if (!force) {
    try {
      const cached = utools.dbStorage.getItem(K.update)
      if (cached && typeof cached.at === 'number' && now - cached.at < UPDATE_TTL_MS) {
        return Promise.resolve(Object.assign({}, cached, { fresh: false }))
      }
    } catch (err) {}
  }
  if (updateInFlight) return updateInFlight
  updateInFlight = fetch(UPDATE_CHECK_URL, { signal: AbortSignal.timeout(15000) })
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    })
    .then((data) => {
      const latest = String((data && data.version) || '').trim()
      if (!parseVersion(latest)) throw new Error('远端未提供有效版本号')
      const result = {
        ok: true,
        fresh: true,
        at: now,
        current: PLUGIN_VERSION,
        latest,
        hasUpdate: isNewerVersion(latest, PLUGIN_VERSION),
      }
      try { utools.dbStorage.setItem(K.update, result) } catch (err) { logErr('[whale][update] 写更新缓存失败', err && err.message) }
      return result
    })
    .catch((err) => ({
      ok: false,
      at: now,
      current: PLUGIN_VERSION,
      error: String((err && err.message) || err),
    }))
    .finally(() => { updateInFlight = null })
  return updateInFlight
}

// ──────────────────────────────────────────────
// 余额缓存 / 去重
// ──────────────────────────────────────────────
let balanceCache = null // { at, payload }
let balanceInFlight = null

// 金额文案（跟随当前币种）
function moneyText(v, payload) {
  const cur = payload && payload.currency && payload.currency !== 'CNY' ? payload.currency + ' ' : '¥'
  return cur + (Number(v) || 0).toFixed(2)
}
// 免打扰时段（本地时间，支持跨午夜如 23:00–07:00）：时段内不弹系统通知，挂件气泡照常。
// 静默三类自动通知（今日预算 / 低余额 / 余额大幅波动）；计时到点是用户主动设定的一次性提醒，不受影响。
function inQuietHours(cfg) {
  if (!cfg || cfg.quietOn !== true) return false
  const re = /^(\d{1,2}):(\d{2})$/
  const a = re.exec(String(cfg.quietFrom || ''))
  const b = re.exec(String(cfg.quietTo || ''))
  if (!a || !b) return false
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const from = Number(a[1]) * 60 + Number(a[2])
  const to = Number(b[1]) * 60 + Number(b[2])
  if (from === to) return false // 起止相同视为未开启
  return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to)
}
// 自动提醒的统一出口：免打扰时段直接跳过（不占用当天名额，出时段后仍会补发），
// 否则每天最多发一次（去重标记落账本）。
function notifyDaily(text, cfg, kind) {
  if (inQuietHours(cfg)) return
  if (!claimDailyNotice(kind)) return // 今天已提醒过
  try { utools.showNotification(text, 'whale') } catch (err) { logErr('[whale][notify] 系统通知失败', err && err.message) }
}
// 即时通知出口：只受免打扰时段约束，不占用「每天一次」的名额。
// 用于「余额大幅波动」这类一次性事件——每次发生都值得知道，不该被当天已发过的通知挡掉。
function notifyNow(text, cfg) {
  if (inQuietHours(cfg)) return
  try { utools.showNotification(text, 'whale') } catch (err) { logErr('[whale][notify] 系统通知失败', err && err.message) }
}
// 今日预算：用量超过预算额时弹一次系统通知（同一天只弹一次）。
// 挂件气泡侧另有一条「超预算」提示，两者互不依赖：气泡可能正被计时/峰谷占用。
// 文案取设置页的「提醒文案」模板（与气泡同一份），换行合并成一行。
function maybeNotifyBudget(payload, cfg) {
  const budget = Number(cfg && cfg.budgetAmount) || 0
  const used = Number(payload && payload.todayUsage)
  if (!cfg || !cfg.budgetOn || budget <= 0) return
  if (!isFinite(used) || used <= budget) return
  notifyDaily(alertOneLine(alertFor(cfg, 'budget'), {
    used: moneyText(used, payload),
    budget: moneyText(budget, payload),
    over: moneyText(used - budget, payload),
  }), cfg, 'budget')
}
// 低余额预警：余额低于阈值时弹一次系统通知（同一天只弹一次）。
// 阈值 0 视为未设置；挂件侧同一条件还会变红并弹一次提醒气泡。文案同样取设置页模板。
function maybeNotifyLow(payload, cfg) {
  const th = Number(cfg && cfg.lowAlertAmount) || 0
  const bal = Number(payload && payload.totalBalance)
  if (!cfg || !cfg.lowAlertOn || th <= 0) return
  if (!isFinite(bal) || bal >= th) return
  notifyDaily(alertOneLine(alertFor(cfg, 'low'), {
    balance: moneyText(bal, payload),
    threshold: moneyText(th, payload),
  }), cfg, 'low')
}
// 余额大幅波动：单次采样余额下降 ≥ 阈值就通知。
// 不做「每天一次」去重——每次下降只会被采样到一次（基准随即更新），不会重复刷屏。
// 计不计入今日用量都通知，但文案区分：正常消费报今日已用，被防误判拦下的说明原因。
function maybeNotifyDrop(payload, cfg, drop, adjust) {
  const th = Number(cfg && cfg.dropAlertAmount) || 0
  const d = Number(drop) || 0
  if (!cfg || cfg.dropAlertOn !== true || th <= 0) return
  if (!(d >= th)) return
  const tail = adjust && adjust.why
    ? '（' + adjust.why + '，未计入今日用量）'
    : '，今日已用 ' + moneyText(payload && payload.todayUsage, payload)
  notifyNow('余额下降 ' + moneyText(d, payload) + tail, cfg)
}
// 每次成功采样后统一判定三类自动提醒（预算、低余额、大幅波动）
function maybeNotifyAlerts(payload, cfg, drop, adjust) {
  maybeNotifyBudget(payload, cfg)
  maybeNotifyLow(payload, cfg)
  maybeNotifyDrop(payload, cfg, drop, adjust)
}

async function getBalancePayload() {
  const secrets = readSecrets()
  const payload = await fetchBalanceWith(secrets.apiKey)
  if (!payload.ok) return payload
  // 无论哪种用量模式，都先把余额观测记入账本（含赠送额/Key 指纹的防误判）
  const rec = recordLedgerUsage(Number(payload.totalBalance), payload.currency, {
    granted: payload.grantedBalance,
    toppedUp: payload.toppedUpBalance,
    keyId: keyFingerprint(secrets.apiKey),
  })
  const led = rec.ledger
  const cfg = readConfig()
  const full = Object.assign({}, payload)
  const nowSec = Math.floor(Date.now() / 1000)
  full.isPeak = isPeakTime(nowSec)
  // 下次峰谷切换的绝对时刻（挂件按它显示「距峰时/谷时」倒计时，避免页面自己再实现一套时段规则）
  full.peakNextAt = nextPeakChangeAt(nowSec)
  if (cfg.usageMode === 'token' && secrets.platformToken) {
    const u = await fetchPlatformUsage(secrets.platformToken, cfg.tokenPrice)
    if (u && u.amount !== undefined) {
      full.todayUsage = u.amount
      full.usageMode = 'token'
      // 令牌模式今日已用以平台返回为准，不弹「这笔没算用量」
      full.adjust = null
      setTodayUsage(u.amount) // 同步进账本，趋势图/导出与挂件显示保持一致
      maybeNotifyAlerts(full, cfg, rec.drop, null)
      return full
    }
    // 平台令牌失败：回落记账
  }
  full.todayUsage = led.todayUsage
  full.todayAdjust = led.todayAdjust || 0
  full.usageMode = 'ledger'
  // adjust 只在「本次新采样判定出非消费下降」时非空，挂件气泡解释用
  full.adjust = rec.adjust
  maybeNotifyAlerts(full, cfg, rec.drop, rec.adjust)
  return full
}

function getBalance(force) {
  const now = Date.now()
  // force=true（手动点击刷新）跳过缓存，但仍在请求进行中时复用同一个 Promise
  if (!force && balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
    return Promise.resolve(balanceCache.payload)
  }
  if (balanceInFlight) return balanceInFlight
  balanceInFlight = getBalancePayload()
    .then((payload) => {
      if (payload.ok) {
        // 「未计入用量」提示只在真实新采样那一刻下发；缓存副本剥掉，
        // 避免 TTL 内复用/挂件重建推快照时重复弹气泡
        const cached = Object.assign({}, payload)
        delete cached.adjust
        balanceCache = { at: now, payload: cached }
        return payload
      }
      if (payload.transient && balanceCache) {
        return Object.assign({}, balanceCache.payload, { stale: true, error: payload.error })
      }
      return payload
    })
    .catch((err) => ({
      ok: false,
      code: 'ERROR',
      error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200),
    }))
    .finally(() => { balanceInFlight = null })
  return balanceInFlight
}

// 最近一次成功的余额 payload（供挂件初始化时立即渲染）
function getCachedBalance() {
  return balanceCache ? balanceCache.payload : null
}
// 密钥/用量模式变更后强制重新拉取
function resetBalanceCache() {
  balanceCache = null
  balanceInFlight = null
}

module.exports = {
  fetchBalanceWith,
  fetchPlatformUsage,
  fetchModelBalance,
  refreshModels,
  getModelsPayload,
  modelMoney,
  checkUpdate,
  getBalance,
  getCachedBalance,
  resetBalanceCache,
  // 纯函数，仅导出给单测：这几处取错值不会抛错，只会把余额显示错（见 test/api.test.mjs）
  pickBalanceInfo,
  pickPath,
  pathNum,
}
