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
  return { scale: 1.5, vol: 0.9, soundOn: true, soundSet: 'duck', usageMode: 'ledger', peakMode: 'default', peakRemindOn: true, bubbleOn: true, menuBtn: true, onTop: true, lowAlertOn: true, lowAlertAmount: 10, timeBubbleOn: true, updateCheckOn: true, dragLock: false, enterMode: 'both', timerNotifyOn: true, timerPersistOn: true, timerMode: 'off', timerMin: 25, timerAt: '07:30', timerRemindSec: 8, timerBubblePin: true, timerBubbleOnly: true, dshNodeDir: '', dshKeepAlive: false, dshRegistry: '', dshVersion: '', dshReinstall: false, dshNoOpen: true, avoidTaskbar: true, edgeTop: 0, edgeRight: 0, edgeBottom: 0, edgeLeft: 0, opacity: 100, passThrough: false }
}
// dsh 注册源：只接受 http(s) 或空（默认官方源）
function normRegistry(v) {
  const s = String(v == null ? '' : v).trim()
  return /^https?:\/\//i.test(s) ? s.slice(0, 200) : ''
}
// dsh 版本：'' = 自动（安装/更新时取 latest）；否则固定版本号
function normVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^@/, '')
  if (!s || s === 'latest') return ''
  return /^[0-9A-Za-z][0-9A-Za-z.\-+]*$/.test(s) ? s.slice(0, 40) : ''
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
    soundSet: p.soundSet === 'fx1' ? 'fx1' : p.soundSet === 'custom' ? 'custom' : 'duck',
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
    timerNotifyOn: p.timerNotifyOn !== false,
    timerPersistOn: p.timerPersistOn !== false,
    timerMode: p.timerMode === 'up' || p.timerMode === 'down' || p.timerMode === 'at' ? p.timerMode : 'off',
    timerMin: Math.round(clampNum(p.timerMin, 1, 1440, dft.timerMin)),
    timerAt: /^\d{1,2}:\d{2}$/.test(String(p.timerAt || '')) ? String(p.timerAt) : dft.timerAt,
    timerRemindSec: p.timerRemindSec === 0 || p.timerRemindSec === 5 || p.timerRemindSec === 8 || p.timerRemindSec === 15 ? p.timerRemindSec : dft.timerRemindSec,
    timerBubblePin: p.timerBubblePin !== false,
    timerBubbleOnly: p.timerBubbleOnly !== false,
    dshNodeDir: typeof p.dshNodeDir === 'string' ? p.dshNodeDir.slice(0, 260) : dft.dshNodeDir,
    dshKeepAlive: p.dshKeepAlive === true,
    dshRegistry: normRegistry(p.dshRegistry),
    dshVersion: normVersion(p.dshVersion),
    dshReinstall: p.dshReinstall === true,
    dshNoOpen: p.dshNoOpen !== false,
    avoidTaskbar: p.avoidTaskbar !== false,
    edgeTop: Math.round(clampNum(p.edgeTop, 0, 400, dft.edgeTop)),
    edgeRight: Math.round(clampNum(p.edgeRight, 0, 400, dft.edgeRight)),
    edgeBottom: Math.round(clampNum(p.edgeBottom, 0, 400, dft.edgeBottom)),
    edgeLeft: Math.round(clampNum(p.edgeLeft, 0, 400, dft.edgeLeft)),
    opacity: Math.round(clampNum(p.opacity, 20, 100, 100)),
    passThrough: p.passThrough === true,
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
    timerNotifyOn: cfg.timerNotifyOn !== false,
    timerPersistOn: cfg.timerPersistOn !== false,
    timerMode: cfg.timerMode === 'up' || cfg.timerMode === 'down' || cfg.timerMode === 'at' ? cfg.timerMode : 'off',
    timerMin: Math.round(clampNum(cfg.timerMin, 1, 1440, 25)),
    timerAt: /^\d{1,2}:\d{2}$/.test(String(cfg.timerAt || '')) ? String(cfg.timerAt) : '07:30',
    timerRemindSec: cfg.timerRemindSec === 0 || cfg.timerRemindSec === 5 || cfg.timerRemindSec === 8 || cfg.timerRemindSec === 15 ? cfg.timerRemindSec : 8,
    timerBubblePin: cfg.timerBubblePin !== false,
    timerBubbleOnly: cfg.timerBubbleOnly !== false,
    dshNodeDir: typeof cfg.dshNodeDir === 'string' ? cfg.dshNodeDir.slice(0, 260) : '',
    dshKeepAlive: cfg.dshKeepAlive === true,
    dshRegistry: normRegistry(cfg.dshRegistry),
    dshVersion: normVersion(cfg.dshVersion),
    dshReinstall: cfg.dshReinstall === true,
    dshNoOpen: cfg.dshNoOpen !== false,
    avoidTaskbar: cfg.avoidTaskbar !== false,
    edgeTop: Math.round(clampNum(cfg.edgeTop, 0, 400, 0)),
    edgeRight: Math.round(clampNum(cfg.edgeRight, 0, 400, 0)),
    edgeBottom: Math.round(clampNum(cfg.edgeBottom, 0, 400, 0)),
    edgeLeft: Math.round(clampNum(cfg.edgeLeft, 0, 400, 0)),
    opacity: Math.round(clampNum(cfg.opacity, 20, 100, 100)),
    passThrough: cfg.passThrough === true,
    updatedAt: new Date().toISOString(),
  })
}
function patchConfig(patch) {
  const cfg = readConfig()
  const p = patch && typeof patch === 'object' ? patch : {}
  if (p.scale !== undefined) cfg.scale = Math.round(clampNum(p.scale, MIN_SCALE, MAX_SCALE, cfg.scale) * 10) / 10
  if (p.vol !== undefined) cfg.vol = clampNum(p.vol, 0, 1, cfg.vol)
  if (p.soundOn !== undefined) cfg.soundOn = !!p.soundOn
  if (p.soundSet !== undefined) cfg.soundSet = (p.soundSet === 'fx1' || p.soundSet === 'custom') ? p.soundSet : 'duck'
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
  if (p.timerNotifyOn !== undefined) cfg.timerNotifyOn = !!p.timerNotifyOn
  if (p.timerPersistOn !== undefined) cfg.timerPersistOn = !!p.timerPersistOn
  if (p.timerMode !== undefined) cfg.timerMode = p.timerMode === 'up' || p.timerMode === 'down' || p.timerMode === 'at' ? p.timerMode : 'off'
  if (p.timerMin !== undefined) cfg.timerMin = Math.round(clampNum(p.timerMin, 1, 1440, cfg.timerMin))
  if (p.timerAt !== undefined) {
    const s = String(p.timerAt)
    if (/^\d{1,2}:\d{2}$/.test(s)) cfg.timerAt = s
  }
  if (p.timerRemindSec !== undefined) {
    const n = Number(p.timerRemindSec)
    if (n === 0 || n === 5 || n === 8 || n === 15) cfg.timerRemindSec = n
  }
  if (p.timerBubblePin !== undefined) cfg.timerBubblePin = !!p.timerBubblePin
  if (p.timerBubbleOnly !== undefined) cfg.timerBubbleOnly = !!p.timerBubbleOnly
  if (p.dshNodeDir !== undefined) cfg.dshNodeDir = String(p.dshNodeDir || '').trim().slice(0, 260)
  if (p.dshKeepAlive !== undefined) cfg.dshKeepAlive = !!p.dshKeepAlive
  if (p.dshRegistry !== undefined) cfg.dshRegistry = normRegistry(p.dshRegistry)
  if (p.dshVersion !== undefined) cfg.dshVersion = normVersion(p.dshVersion)
  if (p.dshReinstall !== undefined) cfg.dshReinstall = !!p.dshReinstall
  if (p.dshNoOpen !== undefined) cfg.dshNoOpen = p.dshNoOpen !== false
  if (p.avoidTaskbar !== undefined) cfg.avoidTaskbar = !!p.avoidTaskbar
  // 贴边间距（上/右/下/左，px）：0 = 紧贴该边（以系统当前可用区为准）
  if (p.edgeTop !== undefined) cfg.edgeTop = Math.round(clampNum(p.edgeTop, 0, 400, cfg.edgeTop))
  if (p.edgeRight !== undefined) cfg.edgeRight = Math.round(clampNum(p.edgeRight, 0, 400, cfg.edgeRight))
  if (p.edgeBottom !== undefined) cfg.edgeBottom = Math.round(clampNum(p.edgeBottom, 0, 400, cfg.edgeBottom))
  if (p.edgeLeft !== undefined) cfg.edgeLeft = Math.round(clampNum(p.edgeLeft, 0, 400, cfg.edgeLeft))
  // 窗口透明度（20–100%）与鼠标穿透总开关
  if (p.opacity !== undefined) cfg.opacity = Math.round(clampNum(p.opacity, 20, 100, cfg.opacity))
  if (p.passThrough !== undefined) cfg.passThrough = !!p.passThrough
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
// 记账防误判阈值（判据在桌面端被真实事故验证过：赠送额度 271 元整块到期曾被误记为用量）
const USAGE_JUMP_LIMIT = 20 // 元：间隔再短，一次下降超过 20 元即判为非消费
const USAGE_JUMP_RATE = 5   // 元/小时：距上次采样越久，容忍上限越宽
const ADJUST_LOG_KEEP = 20
const CALIBRATE_LOG_KEEP = 20

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000
}
// API Key 指纹：只留 sha1 前 8 位用于判断「是不是同一本账」，不落任何可还原密钥的信息
function keyFingerprint(key) {
  const s = String(key || '')
  if (!s) return ''
  try {
    return require('crypto').createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 8)
  } catch (err) { return '' }
}
function freshLedger() {
  return {
    date: todayKey(), lastBalance: null, lastCurrency: '', todayUsage: 0, history: {},
    // 赠送/充值分项余额与上次采样时间：识别赠送额度整块到期用
    lastGranted: null, lastToppedUp: null, lastSampleAt: '',
    // 当前账本绑定的 Key 指纹：换 Key 只重置基准，不把两边差额记成用量
    lastKeyId: '',
    // 判定为「非消费」的余额变动：今日合计 + 明细（at/amount/why）
    todayAdjust: 0, adjustLog: [], lastAdjustWhy: '', lastAdjustAt: '',
    // 手动校准记录
    calibrateLog: [],
  }
}
function readLedger() {
  let raw = null
  try {
    const led = utools.dbStorage.getItem(K.ledger)
    if (led && typeof led === 'object' && typeof led.date === 'string') raw = led
  } catch (err) {}
  if (!raw) return freshLedger()
  const numOr = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)
  return {
    date: String(raw.date),
    lastBalance: typeof raw.lastBalance === 'number' ? raw.lastBalance : null,
    lastCurrency: typeof raw.lastCurrency === 'string' ? raw.lastCurrency : '',
    todayUsage: numOr(raw.todayUsage, 0),
    history: raw.history && typeof raw.history === 'object' ? raw.history : {},
    lastGranted: typeof raw.lastGranted === 'number' ? raw.lastGranted : null,
    lastToppedUp: typeof raw.lastToppedUp === 'number' ? raw.lastToppedUp : null,
    lastSampleAt: typeof raw.lastSampleAt === 'string' ? raw.lastSampleAt : '',
    lastKeyId: typeof raw.lastKeyId === 'string' ? raw.lastKeyId : '',
    todayAdjust: numOr(raw.todayAdjust, 0),
    adjustLog: Array.isArray(raw.adjustLog) ? raw.adjustLog.slice(-ADJUST_LOG_KEEP) : [],
    lastAdjustWhy: typeof raw.lastAdjustWhy === 'string' ? raw.lastAdjustWhy : '',
    lastAdjustAt: typeof raw.lastAdjustAt === 'string' ? raw.lastAdjustAt : '',
    calibrateLog: Array.isArray(raw.calibrateLog) ? raw.calibrateLog.slice(-CALIBRATE_LOG_KEEP) : [],
  }
}
// 余额下降是否「不像用掉的」：1) 赠送额度整块消失（到期/平台收回）；2) 短时间异常大跳变。
// 返回原因字符串；'' 表示正常消费，计入今日已用。
function balanceDropReason(led, delta, granted, gapSec) {
  const pg = typeof led.lastGranted === 'number' ? led.lastGranted : null
  if (pg !== null && granted !== null && delta >= 0.5) {
    const gone = pg - granted
    if (gone > 0 && gone >= delta - 0.05 && granted <= Math.max(0.05, pg * 0.02)) {
      return '赠送额度到期/被收回'
    }
  }
  const limit = Math.max(USAGE_JUMP_LIMIT, USAGE_JUMP_RATE * Math.max(0, gapSec) / 3600)
  if (delta > limit) return '余额下降超过可信上限'
  return ''
}
// 记账：余额正差值累计当天用量；跨天归档（保留 30 天）；换币种/换 Key 只重置基准不记差值。
// extra = { granted, toppedUp, keyId }：赠送/充值分项与 Key 指纹，用于防误判。
// 返回 { ledger, adjust }；adjust 非空表示本轮下降未计入用量（气泡向用户解释）。
function recordLedgerUsage(currentBalance, currency, extra) {
  const ex = extra && typeof extra === 'object' ? extra : {}
  const granted = isFinite(Number(ex.granted)) && Number(ex.granted) >= 0 ? round4(Number(ex.granted)) : null
  const toppedUp = isFinite(Number(ex.toppedUp)) && Number(ex.toppedUp) >= 0 ? round4(Number(ex.toppedUp)) : null
  const keyId = ex.keyId ? String(ex.keyId) : ''
  const nowIso = new Date().toISOString()

  const t = todayKey()
  const led = readLedger()
  const cur = String(currency || '')
  const currencyChanged =
    led.lastCurrency !== '' && cur !== '' && led.lastCurrency !== cur
  const keyChanged = !!(led.lastKeyId && keyId && led.lastKeyId !== keyId)
  let adjust = null

  if (led.date !== t) {
    if (led.date) led.history[led.date] = led.todayUsage
    led.date = t
    led.todayUsage = 0
    led.todayAdjust = 0
    led.adjustLog = []
    led.lastAdjustWhy = ''
    led.lastAdjustAt = ''
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else if (currencyChanged || keyChanged) {
    // 换币种/换 Key：两边余额不可比，只重置基准
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else if (typeof currentBalance === 'number' && isFinite(currentBalance)) {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : null
    if (prev !== null && currentBalance < prev) {
      const delta = round4(prev - currentBalance)
      // 老账本没有采样时间，按一轮刷新间隔（60s）从严判定
      let gap = 60
      if (led.lastSampleAt) {
        const g = (Date.parse(nowIso) - Date.parse(led.lastSampleAt)) / 1000
        if (isFinite(g) && g >= 0) gap = g
      }
      const why = balanceDropReason(led, delta, granted, gap)
      if (why) {
        led.todayAdjust = round4((led.todayAdjust || 0) + delta)
        led.adjustLog.push({ at: nowIso, amount: delta, why: why })
        if (led.adjustLog.length > ADJUST_LOG_KEEP) led.adjustLog = led.adjustLog.slice(-ADJUST_LOG_KEEP)
        led.lastAdjustWhy = why
        led.lastAdjustAt = nowIso
        adjust = { amount: delta, why: why }
      } else {
        led.todayUsage = round4((led.todayUsage || 0) + delta)
      }
    }
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  }
  // 分项余额/Key 指纹/采样时间无论计不计差都更新，作为下一轮比较基准
  if (granted !== null) led.lastGranted = granted
  if (toppedUp !== null) led.lastToppedUp = toppedUp
  if (keyId) led.lastKeyId = keyId
  led.lastSampleAt = nowIso

  const keys = Object.keys(led.history).sort()
  while (keys.length > 30) delete led.history[keys.shift()]
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) { logErr('[whale][ledger] 写账本失败', err && err.message) }
  return { ledger: led, adjust: adjust }
}
// 手动校准今日已用：只改当天累计值，不动余额基准（后续记账仍按真实余额差值累加）。
// 令牌模式下平台今日总量是权威值、会覆盖校准结果，因此该入口只对记账模式有意义。
function calibrateTodayUsage(amount) {
  const n = Number(amount)
  if (!isFinite(n) || n < 0) return { ok: false, error: '请输入不小于 0 的金额' }
  const led = readLedger()
  const from = round4(led.todayUsage || 0)
  const to = round4(n)
  if (to === from) return { ok: true, from: from, to: to, todayAdjust: led.todayAdjust || 0 }
  led.todayUsage = to
  led.calibrateLog = Array.isArray(led.calibrateLog) ? led.calibrateLog : []
  led.calibrateLog.push({ at: new Date().toISOString(), from: from, to: to })
  if (led.calibrateLog.length > CALIBRATE_LOG_KEEP) led.calibrateLog = led.calibrateLog.slice(-CALIBRATE_LOG_KEEP)
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) {
    logErr('[whale][ledger] 校准写账本失败', err && err.message)
    return { ok: false, error: '校准写入失败：' + ((err && err.message) || err) }
  }
  return { ok: true, from: from, to: to, todayAdjust: led.todayAdjust || 0 }
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

// 令牌模式：平台返回的今日总量是权威值，直接写入账本当天用量。
// 不写的话趋势图/导出仍取记账累计值，会与挂件显示的「今日已用」对不上。
function setTodayUsage(amount) {
  const led = readLedger()
  led.todayUsage = Math.max(0, Number(amount) || 0)
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) { logErr('[whale][ledger] 写今日用量失败', err && err.message) }
  return led
}

// ──────────────────────────────────────────────
// 计时状态（正计时/倒计时/定时）
// ──────────────────────────────────────────────
// 由悬浮窗在开始/停止/到点时上报；宿主只做落库，重建挂件后回推给页面恢复。
// 传 null 表示清除（用户关掉「计时保存」开关时）。
function readTimer() {
  const dft = { mode: 'off', running: false, paused: false, startAt: 0, endAt: 0, elapsed: 0, remain: 0, arg: '' }
  try {
    const t = utools.dbStorage.getItem(K.timer)
    if (t && typeof t === 'object') {
      return {
        mode: t.mode === 'up' || t.mode === 'down' || t.mode === 'at' ? t.mode : 'off',
        running: t.running === true,
        paused: t.paused === true,
        startAt: isFinite(Number(t.startAt)) ? Number(t.startAt) : 0,
        endAt: isFinite(Number(t.endAt)) ? Number(t.endAt) : 0,
        elapsed: isFinite(Number(t.elapsed)) ? Math.max(0, Number(t.elapsed)) : 0,
        remain: isFinite(Number(t.remain)) ? Math.max(0, Number(t.remain)) : 0,
        arg: typeof t.arg === 'string' ? t.arg : '',
      }
    }
  } catch (err) {}
  return dft
}
function writeTimer(state) {
  try { utools.dbStorage.setItem(K.timer, state) } catch (err) { logErr('[whale][timer] 写计时状态失败', err && err.message) }
}
function clearTimer() {
  try { utools.dbStorage.removeItem(K.timer) } catch (err) {}
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
  calibrateTodayUsage,
  keyFingerprint,
  mergeLedgerHistory,
  setTodayUsage,
  readTimer,
  writeTimer,
  clearTimer,
  defaultAnchor,
  readAnchor,
  writeAnchor,
  resetAnchorCache,
}
