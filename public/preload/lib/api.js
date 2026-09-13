/*
 * 余额 / 用量拉取与更新检查（CommonJS）。
 */
const {
  BALANCE_URL, USAGE_URL, BALANCE_TTL_MS, FETCH_TIMEOUT_MS,
  UPDATE_CHECK_URL, PLUGIN_VERSION, UPDATE_TTL_MS, K,
} = require('./constants')
const { logErr } = require('./log')
const { readSecrets, sanitizeKey, recordLedgerUsage, keyFingerprint, readConfig, setTodayUsage } = require('./store')
const { isPeakTime, priceFor } = require('./pricing')

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
  if (!/^sk-[A-Za-z0-9_\-]+$/.test(apiKey)) {
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
function computeTodayUsage(data) {
  // data.data.biz_data.series[]: [{model, buckets:[{time, usage:{RESPONSE_TOKEN, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN}}]}]
  let d = data
  if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
  else if (d && d.data && Array.isArray(d.data.series)) d = d.data
  const series = Array.isArray(d.series) ? d.series : null
  if (!series || series.length === 0) return null
  let cost = 0
  let tokens = 0
  let found = false
  for (const s of series) {
    if (!s || typeof s !== 'object') continue
    const pr = priceFor(s.model)
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
      cost += (hit / 1e6) * pr.hit[pi] + (miss / 1e6) * pr.miss[pi] + (out / 1e6) * pr.out[pi]
    }
  }
  return found ? { amount: cost, tokens } : null
}

async function fetchPlatformUsage(platformToken) {
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
    const u = computeTodayUsage(data)
    if (u && isFinite(u.amount)) return { amount: u.amount, tokens: u.tokens }
    return { error: 'no usage' }
  } catch (err) {
    return { error: String((err && err.message) || err) }
  }
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
  full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
  if (cfg.usageMode === 'token' && secrets.platformToken) {
    const u = await fetchPlatformUsage(secrets.platformToken)
    if (u && u.amount !== undefined) {
      full.todayUsage = u.amount
      full.usageMode = 'token'
      // 令牌模式今日已用以平台返回为准，不弹「这笔没算用量」
      full.adjust = null
      setTodayUsage(u.amount) // 同步进账本，趋势图/导出与挂件显示保持一致
      return full
    }
    // 平台令牌失败：回落记账
  }
  full.todayUsage = led.todayUsage
  full.todayAdjust = led.todayAdjust || 0
  full.usageMode = 'ledger'
  // adjust 只在「本次新采样判定出非消费下降」时非空，挂件气泡解释用
  full.adjust = rec.adjust
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
  checkUpdate,
  getBalance,
  getCachedBalance,
  resetBalanceCache,
}
