/*
 * 本地持久化（CommonJS）：密钥 / 配置 / 账本 / 窗口锚点。
 */
const { K, MIN_SCALE, MAX_SCALE } = require('./constants')
const { logErr } = require('./log')

// ──────────────────────────────────────────────
// 密钥
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

// ──────────────────────────────────────────────
// 配置
// ──────────────────────────────────────────────
function defaultConfig() {
  return { scale: 1.5, vol: 0.9, soundOn: true, soundSet: 'duck', usageMode: 'ledger', peakMode: 'default', peakRemindOn: true, bubbleOn: true, menuBtn: true, onTop: true, lowAlertOn: true, lowAlertAmount: 10, timeBubbleOn: true, updateCheckOn: true, dragLock: false, enterMode: 'both' }
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
    peakRemindOn: p.peakRemindOn !== false,
    bubbleOn: p.bubbleOn !== false,
    menuBtn: p.menuBtn !== false,
    onTop: p.onTop !== false,
    lowAlertOn: p.lowAlertOn !== false,
    lowAlertAmount: clampNum(p.lowAlertAmount, 0, 1e9, dft.lowAlertAmount),
    timeBubbleOn: p.timeBubbleOn !== false,
    updateCheckOn: p.updateCheckOn !== false,
    dragLock: p.dragLock === true,
    enterMode: p.enterMode === 'widget' || p.enterMode === 'settings' ? p.enterMode : 'both',
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
    peakRemindOn: cfg.peakRemindOn !== false,
    bubbleOn: !!cfg.bubbleOn,
    menuBtn: cfg.menuBtn !== false,
    onTop: cfg.onTop !== false,
    lowAlertOn: cfg.lowAlertOn !== false,
    lowAlertAmount: cfg.lowAlertAmount,
    timeBubbleOn: cfg.timeBubbleOn !== false,
    updateCheckOn: cfg.updateCheckOn !== false,
    dragLock: cfg.dragLock === true,
    enterMode: cfg.enterMode === 'widget' || cfg.enterMode === 'settings' ? cfg.enterMode : 'both',
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
  if (p.peakRemindOn !== undefined) cfg.peakRemindOn = !!p.peakRemindOn
  if (p.bubbleOn !== undefined) cfg.bubbleOn = !!p.bubbleOn
  if (p.menuBtn !== undefined) cfg.menuBtn = !!p.menuBtn
  if (p.onTop !== undefined) cfg.onTop = !!p.onTop
  if (p.lowAlertOn !== undefined) cfg.lowAlertOn = !!p.lowAlertOn
  if (p.lowAlertAmount !== undefined) cfg.lowAlertAmount = clampNum(p.lowAlertAmount, 0, 1e9, cfg.lowAlertAmount)
  if (p.timeBubbleOn !== undefined) cfg.timeBubbleOn = !!p.timeBubbleOn
  if (p.updateCheckOn !== undefined) cfg.updateCheckOn = !!p.updateCheckOn
  if (p.dragLock !== undefined) cfg.dragLock = !!p.dragLock
  if (p.enterMode !== undefined) cfg.enterMode = p.enterMode === 'widget' || p.enterMode === 'settings' ? p.enterMode : 'both'
  writeConfig(cfg)
  return cfg
}

// ──────────────────────────────────────────────
// 账本
// ──────────────────────────────────────────────
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
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) { logErr('[whale][ledger] 写账本失败', err && err.message) }
  return led
}
// 导入：把 [{ date, usage }] 合并进账本历史（同日覆盖），按日期升序只保留最近 30 天。
// 当天（led.date）需同步写入 todayUsage，否则趋势图的当天柱仍取实时累计值，导入的当天行会被忽略；
// lastBalance/lastCurrency 基准不动，实时记账仍在其上累加。
function mergeLedgerHistory(entries) {
  const led = readLedger()
  const hist = led.history && typeof led.history === 'object' ? led.history : {}
  let imported = 0
  for (const e of entries || []) {
    if (!e || typeof e.date !== 'string' || !isFinite(Number(e.usage))) continue
    const v = Math.max(0, Number(e.usage))
    hist[e.date] = v
    if (e.date === led.date) led.todayUsage = v
    imported++
  }
  // 只保留最近 30 天（history 按日期字符串升序即时间升序）
  const all = Object.keys(hist).sort()
  for (let i = 0; i < all.length - 30; i++) delete hist[all[i]]
  led.history = hist
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) { logErr('[whale][ledger] 导入写账本失败', err && err.message) }
  const kept = Object.keys(hist).sort()
  return { imported, kept: kept.length, from: kept[0] || '', to: kept[kept.length - 1] || '' }
}

// ──────────────────────────────────────────────
// 窗口锚点
// ──────────────────────────────────────────────
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
  try { utools.dbStorage.setItem(K.win, a) } catch (err) { logErr('[whale][anchor] 写窗口锚点失败', err && err.message) }
}
// 清除锚点内存缓存（clearAllData 后重新从存储读取）
function resetAnchorCache() { anchorCache = null }

module.exports = {
  readSecrets,
  sanitizeKey,
  writeSecrets,
  defaultConfig,
  clampNum,
  readConfig,
  writeConfig,
  patchConfig,
  todayKey,
  readLedger,
  recordLedgerUsage,
  mergeLedgerHistory,
  defaultAnchor,
  readAnchor,
  writeAnchor,
  resetAnchorCache,
}
