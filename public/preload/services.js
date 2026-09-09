/*
 * 小鲸鱼余额挂件 · 主窗宿主 preload（CommonJS，不可压缩混淆）
 *
 * 职责：
 *  1. 创建/管理透明无边框置顶悬浮窗（utools.createBrowserWindow）
 *  2. DeepSeek 余额拉取（api.deepseek.com）+ 平台用量（platform.deepseek.com，token 模式）
 *  3. 本地账本（余额差值记账，跨天归档保留 30 天，币种感知）
 *  4. 配置/密钥/窗口锚点持久化（dbStorage / dbCryptoStorage）
 *  5. 悬浮窗 ↔ 宿主 IPC 路由
 *  6. 对外 window.services 供设置页调用
 */
const { ipcRenderer } = require('electron')
const path = require('path')

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'
const BALANCE_TTL_MS = 25000
const FETCH_TIMEOUT_MS = 20000

// 检查更新：拉取远端 package.json（经 ghfast 加速），只取 version 字段做比对
const UPDATE_CHECK_URL = 'https://ghfast.top/https://raw.githubusercontent.com/Berge520/Balance-Whale-Widget/refs/heads/main/package.json'
// 当前插件版本。uTools 未提供读取插件自身版本的 API，此处需与 package.json / plugin.json 的 version 保持一致
const PLUGIN_VERSION = '1.0.0'
const UPDATE_TTL_MS = 12 * 3600 * 1000

const MIN_SCALE = 0.6
const MAX_SCALE = 2.5
const BASE_MIN = 122   // 挂件基准尺寸下限 px
const BASE_CAP = 250   // 视口相关基准上限 px
const BASE_MAX = 625   // 挂件基准尺寸硬上限 px
// 窗口比挂件本体多出的透明留白 px：汉堡菜单在按钮上方展开，窗口必须大于挂件本体，
// 否则菜单会被窗口边缘裁掉。留白区全透明，靠 setIgnoreMouseEvents 点击穿透。
// 必须与 floating.html 里的 --whale-pad 保持一致。
const WIN_PAD = 200

// DeepSeek CNY 价格（每百万 token）：[空闲时段价, 高峰时段价]
// 高峰：工作日 9:00–12:00、14:00–18:00（北京时间）；2026-08-23 起周末全天谷价
const PEAK_HOURS = [[9, 12], [14, 18]]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}
// = 北京时间 2026-08-23 00:00
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

const K = {
  secrets: 'whale:secrets', // dbCryptoStorage：{ apiKey, platformToken }
  config: 'whale:config',   // dbStorage：挂件配置
  ledger: 'whale:ledger',   // dbStorage：本地账本
  win: 'whale:window',      // dbStorage：窗口锚点
  update: 'whale:update',   // dbStorage：上次检查更新结果缓存
}

// ──────────────────────────────────────────────
// 峰谷 / 定价
// ──────────────────────────────────────────────
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
function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

// ──────────────────────────────────────────────
// 存储
// ──────────────────────────────────────────────
function readSecrets() {
  try {
    const s = utools.dbCryptoStorage.getItem(K.secrets)
    if (s && typeof s === 'object') return { apiKey: String(s.apiKey || ''), platformToken: String(s.platformToken || '') }
  } catch (err) {}
  return { apiKey: '', platformToken: '' }
}
function sanitizeKey(s) {
  // 密钥只允许字母数字及常见符号；粘贴常带入空格/换行/制表符，统一剔除
  return String(s == null ? '' : s).replace(/\s+/g, '')
}
function writeSecrets(secrets) {
  utools.dbCryptoStorage.setItem(K.secrets, {
    apiKey: sanitizeKey(secrets.apiKey),
    platformToken: sanitizeKey(secrets.platformToken),
  })
}

function defaultConfig() {
  return { scale: 1.5, vol: 0.9, soundOn: true, soundSet: 'duck', usageMode: 'ledger', peakMode: 'default', bubbleOn: true, menuBtn: true, onTop: true, lowAlertOn: true, lowAlertAmount: 10, timeBubbleOn: true, updateCheckOn: true }
}
function clampNum(v, lo, hi, dft) {
  const n = Number(v)
  if (!isFinite(n)) return dft
  return Math.min(hi, Math.max(lo, n))
}
function readConfig() {
  const dft = defaultConfig()
  let p = null
  try { p = utools.dbStorage.getItem(K.config) } catch (err) {}
  if (!p || typeof p !== 'object') return dft
  return {
    scale: clampNum(p.scale, MIN_SCALE, MAX_SCALE, dft.scale),
    vol: clampNum(p.vol, 0, 1, dft.vol),
    soundOn: p.soundOn !== false,
    soundSet: p.soundSet === 'fx1' ? 'fx1' : 'duck',
    usageMode: p.usageMode === 'token' ? 'token' : 'ledger',
    peakMode: p.peakMode === 'liangwen' || p.peakMode === 'qiangqiang' ? p.peakMode : 'default',
    bubbleOn: p.bubbleOn !== false,
    menuBtn: p.menuBtn !== false,
    onTop: p.onTop !== false,
    lowAlertOn: p.lowAlertOn !== false,
    lowAlertAmount: clampNum(p.lowAlertAmount, 0, 1e9, dft.lowAlertAmount),
    timeBubbleOn: p.timeBubbleOn !== false,
    updateCheckOn: p.updateCheckOn !== false,
  }
}
function writeConfig(cfg) {
  utools.dbStorage.setItem(K.config, {
    scale: cfg.scale,
    vol: cfg.vol,
    soundOn: cfg.soundOn !== false,
    soundSet: cfg.soundSet,
    usageMode: cfg.usageMode,
    peakMode: cfg.peakMode,
    bubbleOn: !!cfg.bubbleOn,
    menuBtn: cfg.menuBtn !== false,
    onTop: cfg.onTop !== false,
    lowAlertOn: cfg.lowAlertOn !== false,
    lowAlertAmount: cfg.lowAlertAmount,
    timeBubbleOn: cfg.timeBubbleOn !== false,
    updateCheckOn: cfg.updateCheckOn !== false,
    updatedAt: new Date().toISOString(),
  })
}
function patchConfig(patch) {
  const cfg = readConfig()
  const p = patch && typeof patch === 'object' ? patch : {}
  if (p.scale !== undefined) cfg.scale = Math.round(clampNum(p.scale, MIN_SCALE, MAX_SCALE, cfg.scale) * 10) / 10
  if (p.vol !== undefined) cfg.vol = clampNum(p.vol, 0, 1, cfg.vol)
  if (p.soundOn !== undefined) cfg.soundOn = !!p.soundOn
  if (p.soundSet !== undefined) cfg.soundSet = p.soundSet === 'fx1' ? 'fx1' : 'duck'
  if (p.usageMode !== undefined) cfg.usageMode = p.usageMode === 'token' ? 'token' : 'ledger'
  if (p.peakMode !== undefined) cfg.peakMode = (p.peakMode === 'liangwen' || p.peakMode === 'qiangqiang') ? p.peakMode : 'default'
  if (p.bubbleOn !== undefined) cfg.bubbleOn = !!p.bubbleOn
  if (p.menuBtn !== undefined) cfg.menuBtn = !!p.menuBtn
  if (p.onTop !== undefined) cfg.onTop = !!p.onTop
  if (p.lowAlertOn !== undefined) cfg.lowAlertOn = !!p.lowAlertOn
  if (p.lowAlertAmount !== undefined) cfg.lowAlertAmount = clampNum(p.lowAlertAmount, 0, 1e9, cfg.lowAlertAmount)
  if (p.timeBubbleOn !== undefined) cfg.timeBubbleOn = !!p.timeBubbleOn
  if (p.updateCheckOn !== undefined) cfg.updateCheckOn = !!p.updateCheckOn
  writeConfig(cfg)
  return cfg
}

function todayKey() {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}
function readLedger() {
  try {
    const led = utools.dbStorage.getItem(K.ledger)
    if (led && typeof led === 'object' && typeof led.date === 'string') {
      return {
        date: led.date,
        lastBalance: typeof led.lastBalance === 'number' ? led.lastBalance : null,
        lastCurrency: typeof led.lastCurrency === 'string' ? led.lastCurrency : '',
        todayUsage: typeof led.todayUsage === 'number' ? led.todayUsage : 0,
        history: led.history && typeof led.history === 'object' ? led.history : {},
      }
    }
  } catch (err) {}
  return { date: todayKey(), lastBalance: null, lastCurrency: '', todayUsage: 0, history: {} }
}
// 记账：余额正差值累计当天用量；跨天归档（保留 30 天）；币种切换只重置基准不记差值
function recordLedgerUsage(currentBalance, currency) {
  const t = todayKey()
  const led = readLedger()
  const cur = String(currency || '')
  const currencyChanged =
    led.lastCurrency !== '' && cur !== '' && led.lastCurrency !== cur
  if (led.date !== t) {
    if (led.date && typeof led.todayUsage === 'number') led.history[led.date] = led.todayUsage
    led.date = t
    led.lastBalance = currentBalance
    led.lastCurrency = cur
    led.todayUsage = 0
  } else if (currencyChanged) {
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
    if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
      led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
    }
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  }
  const keys = Object.keys(led.history).sort()
  while (keys.length > 30) delete led.history[keys.shift()]
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) {}
  return led
}

function defaultAnchor() {
  return { hAnchor: 'right', hDist: 0, vAnchor: 'bottom', vDist: 0 }
}
// 内存缓存：拖动滑块/拖拽时每帧都会读锚点，避免高频同步 dbStorage 读取
let anchorCache = null
function readAnchor() {
  if (anchorCache) return anchorCache
  const dft = defaultAnchor()
  try {
    const a = utools.dbStorage.getItem(K.win)
    if (a && typeof a === 'object' &&
        (a.hAnchor === 'left' || a.hAnchor === 'right') && typeof a.hDist === 'number' &&
        (a.vAnchor === 'top' || a.vAnchor === 'bottom') && typeof a.vDist === 'number') {
      anchorCache = { hAnchor: a.hAnchor, hDist: Math.max(0, Math.round(a.hDist)),
                      vAnchor: a.vAnchor, vDist: Math.max(0, Math.round(a.vDist)) }
      return anchorCache
    }
  } catch (err) {}
  anchorCache = dft
  return dft
}
function writeAnchor(a) {
  anchorCache = a
  try { utools.dbStorage.setItem(K.win, a) } catch (err) {}
}

// ──────────────────────────────────────────────
// 余额 / 用量拉取
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
    return {
      ok: true,
      totalBalance: Number(info.total_balance),
      currency: String(info.currency || 'CNY'),
      updatedAt: new Date().toISOString(),
    }
  }
  return { ok: false, code: 'HTTP', transient: true, error: '余额接口请求失败，请稍后重试' }
}

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
      try { utools.dbStorage.setItem(K.update, result) } catch (err) {}
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

let balanceCache = null // { at, payload }
let balanceInFlight = null

async function getBalancePayload() {
  const secrets = readSecrets()
  const payload = await fetchBalanceWith(secrets.apiKey)
  if (!payload.ok) return payload
  // 无论哪种用量模式，都先把余额观测记入账本
  const led = recordLedgerUsage(Number(payload.totalBalance), payload.currency)
  const cfg = readConfig()
  const full = Object.assign({}, payload)
  full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
  if (cfg.usageMode === 'token' && secrets.platformToken) {
    const u = await fetchPlatformUsage(secrets.platformToken)
    if (u && u.amount !== undefined) {
      full.todayUsage = u.amount
      full.usageMode = 'token'
      return full
    }
    // 平台令牌失败：回落记账
  }
  full.todayUsage = led.todayUsage
  full.usageMode = 'ledger'
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
        balanceCache = { at: now, payload }
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

// ──────────────────────────────────────────────
// 悬浮窗管理
// ──────────────────────────────────────────────
let win = null

function floatingUrl() {
  // uTools createBrowserWindow 的 url 必须是「插件包内的本地 html 相对路径」，
  // 它按插件根目录（dev=public/，打包=dist/）做文件存在性校验；
  // 传 dev-server 的 http://localhost 地址会被判为「html 文件不存在」。
  // floating.html 位于插件根目录，其相对资源 ./whale/... 也随包存在，直接用相对路径。
  return 'floating.html'
}

function primaryWorkArea() {
  try {
    const d = utools.getPrimaryDisplay()
    if (d && d.workArea) return d.workArea
  } catch (err) {}
  return { x: 0, y: 0, width: 1280, height: 720 }
}
function workAreaNear(x, y) {
  try {
    const d = utools.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
    if (d && d.workArea) return d.workArea
  } catch (err) {}
  return primaryWorkArea()
}

// 挂件基准尺寸：clamp(122, min(250, min(workW,workH)*0.28) * scale, 625)
function baseSize(wa, scale) {
  const s = clampNum(scale, MIN_SCALE, MAX_SCALE, 1.5)
  let base = Math.min(BASE_CAP, Math.min(wa.width, wa.height) * 0.28) * s
  base = Math.min(BASE_MAX, Math.max(BASE_MIN, base))
  // 挂件本体不能超出屏幕工作区（窗口留白可越界，透明且点击穿透，不影响）
  const maxFit = Math.min(wa.width, wa.height) - 8
  return Math.round(Math.min(base, Math.max(BASE_MIN, maxFit)))
}

// 窗口尺寸 = 挂件本体 + 透明留白
function winSize(wa, scale) {
  return baseSize(wa, scale) + WIN_PAD
}

// 挂件本体在窗口内右下对齐：窗口左上角 -> 挂件本体左上角
function widgetOrigin(winX, winY) { return { x: winX + WIN_PAD, y: winY + WIN_PAD } }
// 挂件本体左上角 -> 窗口左上角
function winOrigin(wx, wy) { return { x: wx - WIN_PAD, y: wy - WIN_PAD } }

// 把「挂件本体」矩形限制在工作区内（留白可越界）
function clampWidget(wa, wx, wy, s) {
  return {
    x: Math.min(Math.max(wx, wa.x), Math.max(wa.x, wa.x + wa.width - s)),
    y: Math.min(Math.max(wy, wa.y), Math.max(wa.y, wa.y + wa.height - s)),
  }
}

// 锚点 → 窗口左上角坐标（锚点净距离以「挂件本体」边缘为准）
function anchorToRect(wa, winS, anchor) {
  const s = winS - WIN_PAD // 挂件本体边长
  const a = anchor || defaultAnchor()
  const wx = a.hAnchor === 'left' ? wa.x + a.hDist : wa.x + wa.width - s - a.hDist
  const wy = a.vAnchor === 'top' ? wa.y + a.vDist : wa.y + wa.height - s - a.vDist
  const c = clampWidget(wa, wx, wy, s)
  return winOrigin(c.x, c.y)
}

// 拖拽结束：中心点 1/4 区吸附；中间区域保留自由位（记录离最近边净距离）
// 入参/出参均为「窗口」坐标；内部换算到挂件本体做判定
function snapRect(wa, winX, winY, winW, winH) {
  const s = winW - WIN_PAD
  const o = widgetOrigin(winX, winY)
  let x = o.x, y = o.y
  const cx = x + s / 2
  const cy = y + s / 2
  let hAnchor, hDist, nx = x
  if (cx < wa.x + wa.width / 4) {
    hAnchor = 'left'; hDist = 0; nx = wa.x
  } else if (cx > wa.x + wa.width * 3 / 4) {
    hAnchor = 'right'; hDist = 0; nx = wa.x + wa.width - s
  } else {
    const leftDist = x - wa.x
    const rightDist = wa.x + wa.width - (x + s)
    if (leftDist <= rightDist) { hAnchor = 'left'; hDist = Math.round(leftDist) }
    else { hAnchor = 'right'; hDist = Math.round(rightDist) }
    nx = x
  }
  let vAnchor, vDist, ny = y
  if (cy < wa.y + wa.height / 4) {
    vAnchor = 'top'; vDist = 0; ny = wa.y
  } else if (cy > wa.y + wa.height * 3 / 4) {
    vAnchor = 'bottom'; vDist = 0; ny = wa.y + wa.height - s
  } else {
    const topDist = y - wa.y
    const bottomDist = wa.y + wa.height - (y + s)
    if (topDist <= bottomDist) { vAnchor = 'top'; vDist = Math.round(topDist) }
    else { vAnchor = 'bottom'; vDist = Math.round(bottomDist) }
    ny = y
  }
  const c = clampWidget(wa, nx, ny, s)
  const wp = winOrigin(c.x, c.y)
  return { x: wp.x, y: wp.y, anchor: { hAnchor, hDist, vAnchor, vDist } }
}

// 仅左吸附（贴左缘）时镜像翻转
function flippedOf(anchor) {
  return !!anchor && anchor.hAnchor === 'left' && anchor.hDist === 0
}

function winAlive() {
  try { return !!win && !win.isDestroyed() } catch (err) { return false }
}

function applyOnTop(onTop) {
  if (!winAlive()) return
  try { win.setAlwaysOnTop(!!onTop, 'screen-saver') } catch (err) {}
  try { if (onTop && win.moveTop) win.moveTop() } catch (err) {}
}

// 显式放开窗口最小尺寸：Windows 无边框/不可调整窗可能被钳制在创建时尺寸，
// 导致 setSize 放大有效、缩小无效。窗口边长 = 挂件本体(base) + 留白(WIN_PAD)。
function applySizeBounds() {
  if (!winAlive()) return
  const minS = WIN_PAD + BASE_MIN - 40   // 允许缩到 base 下限以下一点（实际 base 已夹在 ≥122）
  const maxS = WIN_PAD + BASE_MAX + 80
  try { if (typeof win.setMinimumSize === 'function') win.setMinimumSize(Math.round(minS), Math.round(minS)) } catch (err) {}
  try { if (typeof win.setMaximumSize === 'function') win.setMaximumSize(Math.round(maxS), Math.round(maxS)) } catch (err) {}
}

let lastWidgetError = ''
function setWidgetError(msg) {
  lastWidgetError = msg ? String(msg) : ''
  try {
    if (msg) console.error('[whale][widget]', msg)
    else console.log('[whale][widget] floating page loaded OK')
  } catch (err) {}
}

function ensureWidget() {
  if (winAlive()) {
    try { win.show() } catch (err) {}
    try { if (win.moveTop) win.moveTop() } catch (err) {}
    return win
  }
  const cfg = readConfig()
  const wa = primaryWorkArea()
  const size = winSize(wa, cfg.scale)
  const anchor = readAnchor()
  const pos = anchorToRect(wa, size, anchor)
  const url = floatingUrl()
  const onTop = cfg.onTop !== false
  console.log('[whale][widget] createBrowserWindow', { url, size, x: pos.x, y: pos.y, preload: 'preload/floating.js', onTop })
  let created = false
  try {
    win = utools.createBrowserWindow(url, {
      width: size,
      height: size,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      thickFrame: false,
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      fullscreenable: false,
      enableLargerThanScreen: true, // 透明留白允许越出屏幕
      // 显式给最小/最大尺寸：否则 Windows 下无边框窗可能被钳制在“创建时尺寸”，
      // 表现为放大有效、缩小无效。窗口 = 挂件本体(base) + 留白(WIN_PAD)。
      minWidth: WIN_PAD + BASE_MIN - 40,
      minHeight: WIN_PAD + BASE_MIN - 40,
      maxWidth: WIN_PAD + BASE_MAX + 80,
      maxHeight: WIN_PAD + BASE_MAX + 80,
      skipTaskbar: true,
      alwaysOnTop: onTop,
      alwayOnTop: onTop, // uTools 类型里的拼写，两个都给
      show: true,
      title: '小鲸鱼余额挂件',
      autoHideMenuBar: true,
      webPreferences: {
        // uTools 要求 preload 也是「相对于插件根目录」的路径（dev=public/，打包=dist/）
        preload: 'preload/floating.js',
        zoomFactor: 1,
        devTools: utools.isDev(),
      },
    }, function () {
      console.log('[whale][widget] createBrowserWindow callback: 页面加载完成')
      try { applySizeBounds() } catch (err) {}
      try { win.show() } catch (err) {}
      try { applyOnTop(readConfig().onTop !== false) } catch (err) {}
      // 兜底：即使子窗 ready 消息丢失，加载完成后也推一次初始数据
      setTimeout(function () { try { pushInit() } catch (err) {} }, 300)
    })
    created = true // 窗口已成功创建，后续设置失败不应丢弃该引用
    try { applySizeBounds() } catch (err) {}
    try { win.show() } catch (err) {}
    try { applyOnTop(onTop) } catch (err) {}
    setWidgetError('')
    // 注意：uTools 返回的定制窗口「不包含 BrowserWindow / webContents 实例事件」，
    // 因此这里不能用 win.webContents.on('did-fail-load') 等；错误只能靠创建回调与 try/catch。
  } catch (err) {
    if (!created) { win = null }
    setWidgetError('createBrowserWindow 抛出异常: ' + ((err && err.message) || err))
  }
  return win
}

// 销毁挂件窗口：真正销毁，下次「显示」会重新从磁盘加载最新 floating.html 并重新初始化
function destroyWidget() {
  if (winAlive()) {
    // 仅 hide 会复用旧页面；销毁可让挂件页面/配置改动即时生效
    try { if (typeof win.destory === 'function') win.destory(); else if (typeof win.close === 'function') win.close(); } catch (err) {}
    try { win.hide() } catch (err) {}
  }
  win = null
  clearLiveScaleCtx()
}

// 切换挂件显隐（供「切换挂件」指令 / 全局快捷键调用），返回切换后的可见状态
function toggleWidget() {
  if (winAlive()) {
    try {
      if (win.isVisible()) { destroyWidget(); return false }
    } catch (err) {}
  }
  ensureWidget()
  return true
}

function sendToWidget(channel) {
  if (!winAlive()) return false
  try {
    const args = Array.prototype.slice.call(arguments, 1)
    // uTools 官方约定：主窗口 → 独立窗口只能用 win.webContents.send
    win.webContents.send(channel, ...args)
    return true
  } catch (err) {
    console.error('[whale][widget] sendToWidget 失败:', channel, err && err.message)
    return false
  }
}

function pushInit() {
  const cfg = readConfig()
  const anchor = readAnchor()
  sendToWidget('whale:init', {
    config: cfg,
    anchor: { hAnchor: anchor.hAnchor, vAnchor: anchor.vAnchor, flipped: flippedOf(anchor) },
    balance: balanceCache ? balanceCache.payload : null,
  })
}

function pushConfig() {
  sendToWidget('whale:config', readConfig())
}

// 实时缩放上下文：连续 __live 调用间缓存，避免每帧同步 IPC 读窗口状态
// （getPosition/getSize/getDisplayNearestPoint 在 uTools 中都是同步往返，高频下卡顿）
let liveScaleCtx = null // { pivotX, pivotY, wa, anchor }
function clearLiveScaleCtx() { liveScaleCtx = null }

// 缩放：以鲸鱼角为不动点重算窗口尺寸/位置（判定均基于挂件本体矩形）
// persist=false（实时拖动）：复用 liveScaleCtx，只做一次 setBounds，不写存储
// persist=true（松手提交）：从窗口读真实状态，写 anchor
function applyScaleToWindow(scale, persist) {
  if (!winAlive()) return
  try {
    let pivotX, pivotY, wa, anchor
    if (!persist && liveScaleCtx) {
      // 实时模式：复用缓存的不动点、workArea、anchor（缩放过程中都不变）
      pivotX = liveScaleCtx.pivotX
      pivotY = liveScaleCtx.pivotY
      wa = liveScaleCtx.wa
      anchor = liveScaleCtx.anchor
    } else {
      // 持久化模式或首次实时：从窗口读取真实状态
      // 优先 getBounds（{x,y,width,height}），回退 getPosition+getSize（[x,y] / [w,h]）
      let bx = 0, by = 0, bw = WIN_PAD + BASE_MIN
      try {
        if (typeof win.getBounds === 'function') {
          const b = win.getBounds()
          bx = isFinite(b.x) ? b.x : bx
          by = isFinite(b.y) ? b.y : by
          bw = isFinite(b.width) ? b.width : bw
        } else {
          const pos = win.getPosition()
          const sz = win.getSize()
          bx = isFinite(pos[0]) ? pos[0] : bx
          by = isFinite(pos[1]) ? pos[1] : by
          bw = isFinite(sz[0]) ? sz[0] : bw
        }
      } catch (err) { console.error('[whale][scale] 读取窗口几何异常', err && err.message) }
      const oldS = bw - WIN_PAD // 旧挂件本体边长
      const wl = bx + WIN_PAD, wt = by + WIN_PAD // 旧挂件左上
      wa = workAreaNear(wl + oldS / 2, wt + oldS / 2)
      anchor = readAnchor()
      // 不动点：左吸附→挂件左缘 x，否则→挂件右缘 x；顶部→上缘 y，否则→下缘 y
      pivotX = flippedOf(anchor) ? wl : wl + oldS
      pivotY = anchor.vAnchor === 'top' ? wt : wt + oldS
    }
    const newWin = winSize(wa, scale)
    const newS = newWin - WIN_PAD
    // 基于不动点反算挂件左上角
    const nwl = flippedOf(anchor) ? pivotX : pivotX - newS
    const nwt = anchor.vAnchor === 'top' ? pivotY : pivotY - newS
    const c = clampWidget(wa, nwl, nwt, newS)
    const wp = winOrigin(c.x, c.y)
    // uTools createBrowserWindow 的窗口在 resizable:false 时，运行时 setSize/setBounds
    // 可能被底层忽略（表现为拖动滑块无反应、只能重启生效）。临时放开 resizable，
    // 改完再锁回，避免用户手动拖拽边缘 resize。
    try { if (typeof win.setResizable === 'function') win.setResizable(true) } catch (err) {}
    const hasSetBounds = typeof win.setBounds === 'function'
    const rx = Math.round(isFinite(wp.x) ? wp.x : 0)
    const ry = Math.round(isFinite(wp.y) ? wp.y : 0)
    const rw = Math.round(isFinite(newWin) ? newWin : WIN_PAD + BASE_MIN)
    if (hasSetBounds) {
      try {
        win.setBounds({ x: rx, y: ry, width: rw, height: rw })
      } catch (err) {
        win.setSize(rw, rw)
        win.setPosition(rx, ry)
      }
    } else {
      win.setSize(rw, rw)
      win.setPosition(rx, ry)
    }
    try { if (typeof win.setResizable === 'function') win.setResizable(false) } catch (err) {}
    // 读回校验：尺寸未按预期变化时报警（历史上曾因 setBounds 参数 NaN 静默失败）
    try {
      const after = win.getBounds()
      const aw = isFinite(after.width) ? after.width : 0
      if (Math.abs(aw - rw) > 2) console.error('[whale][scale] resize 未生效！期望', rw, '实际', aw)
    } catch (err) {}
    if (!persist) {
      // 实时模式：更新缓存不动点为 clamp 后的实际边缘
      liveScaleCtx = {
        pivotX: flippedOf(anchor) ? c.x : c.x + newS,
        pivotY: anchor.vAnchor === 'top' ? c.y : c.y + newS,
        wa, anchor,
      }
    } else {
      // 持久化模式：清除实时缓存，写 anchor
      liveScaleCtx = null
      const nextAnchor = {
        hAnchor: anchor.hAnchor,
        hDist: anchor.hAnchor === 'left' ? Math.round(c.x - wa.x) : Math.round(wa.x + wa.width - (c.x + newS)),
        vAnchor: anchor.vAnchor,
        vDist: anchor.vAnchor === 'top' ? Math.round(c.y - wa.y) : Math.round(wa.y + wa.height - (c.y + newS)),
      }
      writeAnchor(nextAnchor)
    }
  } catch (err) {
    console.error('[whale][scale] applyScaleToWindow 异常:', err && err.message, err && err.stack)
  }
}

// ──────────────────────────────────────────────
// IPC：悬浮窗 → 宿主
// ──────────────────────────────────────────────
ipcRenderer.on('whale:ready', () => {
  console.log('[whale][widget] 收到 whale:ready（子窗已就绪）')
  pushInit()
  getBalance().then((payload) => {
    sendToWidget('whale:balance', payload)
  })
})

ipcRenderer.on('whale:refresh', (event, data) => {
  const manual = !!(data && data.manual)
  getBalance(manual).then((payload) => {
    sendToWidget('whale:balance', payload)
  })
})

// 拖动滑块时的实时缩放：页面侧已用 rAF 合并 IPC（每帧最多一次），
// 宿主侧直接同步执行 applyScaleToWindow，避免主窗不可见时 rAF 被节流导致延迟。
// 优化后 applyScaleToWindow 实时路径只做一次 setBounds，无同步读 IPC，可扛 60fps。
function queueLiveScale(s) {
  const n = Number(s)
  if (!isFinite(n)) return
  applyScaleToWindow(n, false)
}

ipcRenderer.on('whale:config', (event, patch) => {
  if (patch && patch.__live) {
    queueLiveScale(patch.scale)
    return
  }
  const prev = readConfig()
  const cfg = patchConfig(patch)
  if (cfg.scale !== prev.scale) applyScaleToWindow(cfg.scale, true)
  if (cfg.onTop !== prev.onTop) applyOnTop(cfg.onTop)
  pushConfig()
})

ipcRenderer.on('whale:drag-move', (event, data) => {
  if (!winAlive() || !data) return
  clearLiveScaleCtx() // 拖拽改变窗口位置，实时缩放缓存失效
  try {
    const sz = win.getSize()
    const winS = sz[0]
    const s = winS - WIN_PAD // 挂件本体边长
    const x = Number(data.x), y = Number(data.y) // 目标窗口左上角
    if (!isFinite(x) || !isFinite(y)) return
    const wgt = widgetOrigin(x, y) // 目标挂件左上角
    const wa = workAreaNear(wgt.x + s / 2, wgt.y + s / 2)
    // 限制「挂件本体」在工作区内；透明留白可越界，不影响
    const c = clampWidget(wa, wgt.x, wgt.y, s)
    const wp = winOrigin(c.x, c.y)
    win.setPosition(Math.round(wp.x), Math.round(wp.y))
  } catch (err) {}
})

ipcRenderer.on('whale:drag-end', (event, data) => {
  if (!winAlive()) return
  clearLiveScaleCtx() // 吸附会改变窗口位置，实时缩放缓存失效
  try {
    const pos = win.getPosition()
    const sz = win.getSize()
    const w = sz[0], h = sz[1]
    const x = data && isFinite(Number(data.x)) ? Number(data.x) : pos[0]
    const y = data && isFinite(Number(data.y)) ? Number(data.y) : pos[1]
    const s = w - WIN_PAD
    const wgt = widgetOrigin(x, y)
    const wa = workAreaNear(wgt.x + s / 2, wgt.y + s / 2)
    const r = snapRect(wa, x, y, w, h)
    win.setPosition(Math.round(r.x), Math.round(r.y))
    writeAnchor(r.anchor)
    sendToWidget('whale:snapped', {
      hAnchor: r.anchor.hAnchor,
      vAnchor: r.anchor.vAnchor,
      flipped: flippedOf(r.anchor),
    })
  } catch (err) {}
})

ipcRenderer.on('whale:ignore-mouse', (event, data) => {
  if (!winAlive()) return
  try {
    const ignore = !!(data && data.ignore)
    win.setIgnoreMouseEvents(ignore, { forward: true })
  } catch (err) {}
})

// ──────────────────────────────────────────────
// 对外 API（设置页）
// ──────────────────────────────────────────────
window.services = {
  getConfig() {
    return readConfig()
  },
  getVersion() {
    return PLUGIN_VERSION
  },
  // force=false 命中缓存；force=true 立即联网检查
  checkUpdate(force) {
    return checkUpdate(!!force)
  },
  // 系统默认浏览器打开外链（用于跳转下载页）
  openExternal(url) {
    try {
      utools.shellOpenExternal(String(url || ''))
      return true
    } catch (err) {
      return false
    }
  },
  saveConfig(patch) {
    // 设置页拖动滑块中的实时预览：只改窗口几何（rAF 合帧），不写存储、不广播
    if (patch && patch.__live) {
      queueLiveScale(patch.scale)
      return readConfig()
    }
    const prev = readConfig()
    const cfg = patchConfig(patch)
    if (cfg.scale !== prev.scale) applyScaleToWindow(cfg.scale, true)
    if (cfg.onTop !== prev.onTop) applyOnTop(cfg.onTop)
    if (cfg.usageMode !== prev.usageMode) balanceCache = null
    pushConfig()
    return cfg
  },
  getSecrets() {
    return readSecrets()
  },
  saveSecrets(secrets) {
    const next = Object.assign(readSecrets(), secrets || {})
    writeSecrets(next)
    balanceCache = null // 密钥变更后强制重新拉取
    return { hasApiKey: !!next.apiKey, hasPlatformToken: !!next.platformToken }
  },
  // 用给定 API Key 直接验证（不落库）
  testApiKey(apiKey) {
    return fetchBalanceWith(String(apiKey || '').trim())
  },
  // 用给定平台 Token 直接验证用量接口（不落库）：成功返回 { amount, tokens }，失败返回 { error }
  testPlatformToken(platformToken) {
    return fetchPlatformUsage(String(platformToken || '').trim()).then((r) => {
      // 「今日无用量」说明接口已连通，不算失败
      if (r && r.error === 'no usage') return { amount: 0, tokens: 0, empty: true }
      return r
    })
  },
  // 近 N 天用量（含今日，缺失日期补 0），供设置页趋势图
  getUsageHistory(days) {
    const n = clampNum(days, 1, 30, 7)
    const led = readLedger()
    const out = []
    const now = new Date()
    const p2 = (x) => String(x).padStart(2, '0')
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate())
      let usage = 0
      if (key === led.date) usage = typeof led.todayUsage === 'number' ? led.todayUsage : 0
      else if (typeof led.history[key] === 'number') usage = led.history[key]
      out.push({ date: key, usage: usage })
    }
    return { currency: led.lastCurrency || 'CNY', days: out }
  },
  ensureWidget() {
    ensureWidget()
    return { ok: winAlive(), error: lastWidgetError || null }
  },
  showWidget() {
    ensureWidget()
    return { ok: winAlive(), error: lastWidgetError || null }
  },
  getWidgetError() {
    return lastWidgetError || null
  },
  hideWidget() {
    destroyWidget()
    return true
  },
  // 复制文本到剪贴板（用于引导用户把指令名粘贴到 uTools「全局功能」）
  copyText(text) {
    try {
      utools.copyText(String(text || ''))
      return true
    } catch (err) {
      return false
    }
  },
  // 跳转 uTools「全局功能」并为指令新增一条待绑定项（快捷键被删除后可用它重新添加）
  // 注意：每次调用都会新增一条待绑定项，uTools 无「只跳转不新增」的接口
  redirectHotKeySetting(cmdLabel) {
    try {
      utools.redirectHotKeySetting(String(cmdLabel || '显示/隐藏挂件'))
      return true
    } catch (err) {
      return false
    }
  },
  isWidgetVisible() {
    if (!winAlive()) return false
    try { return !!win.isVisible() } catch (err) { return false }
  },
}

// ──────────────────────────────────────────────
// 插件生命周期
// ──────────────────────────────────────────────
try {
  utools.onPluginEnter((action) => {
    const code = action && action.code
    // 「切换挂件」指令：通常由全局快捷键触发（feature.mainHide 使搜索框不弹出）
    if (code === 'whale-toggle') {
      toggleWidget()
      return
    }
    // 默认功能（whale）：任何进入方式都确保挂件存在
    ensureWidget()
    // 自动检查更新：开关关闭时跳过；仅新拉取到的结果触发一次系统通知
    try {
      if (readConfig().updateCheckOn) {
        checkUpdate(false).then((r) => {
          if (r && r.ok && r.fresh && r.hasUpdate) {
            try {
              utools.showNotification('小鲸鱼余额挂件有新版本 v' + r.latest + '（当前 v' + r.current + '）', 'whale')
            } catch (err) {}
          }
        })
      }
    } catch (err) {}
  })
} catch (err) {}
