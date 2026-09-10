/*
 * 对外 API（CommonJS）：注入到主窗 window.services，供设置页调用。
 */
const fs = require('fs')
const { PLUGIN_VERSION, K } = require('./constants')
const { DEV, logErr, LOG_FILE } = require('./log')
const {
  clampNum, readConfig, patchConfig, readSecrets, writeSecrets, readLedger,
  resetAnchorCache, mergeLedgerHistory,
} = require('./store')
const {
  fetchBalanceWith, fetchPlatformUsage, checkUpdate, resetBalanceCache,
} = require('./api')
const {
  ensureWidget, destroyWidget, winAlive, getWidgetError, getWindow,
  applyScaleToWindow, applyOnTop, pushConfig, queueLiveScale,
} = require('./widget')

// 近 N 天用量（含今日，缺失日期补 0），按日期升序
function usageDays(days) {
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
}

// 解析用量 CSV → { rows: [{ date, usage }], invalid }。
// 兼容导出格式「日期,用量[,币种]」：UTF-8 BOM、CRLF/LF、表头行、日期分隔符 - / . 均可。
function parseUsageCsv(text) {
  const rows = []
  let invalid = 0
  const p2 = (x) => String(x).padStart(2, '0')
  const lines = String(text == null ? '' : text).replace(/^\ufeff/, '').split(/\r?\n/)
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    const cells = s.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(cells[0] || '')
    if (!m) {
      // 表头（日期/date 开头）或注释行不计入非法行
      if (!/^(日期|date|时间)/i.test(cells[0] || '')) invalid++
      continue
    }
    const usage = Number(cells[1])
    if (!isFinite(usage) || usage < 0) { invalid++; continue }
    rows.push({ date: m[1] + '-' + p2(m[2]) + '-' + p2(m[3]), usage: usage })
  }
  return { rows, invalid }
}

// 配置变更订阅（设置页 ← 宿主）。挂件菜单改配置时，宿主 patchConfig 后调用 emitConfigChange，
// 让已打开的设置窗口同步刷新开关；否则设置页只在 onMounted 读一次，会与挂件菜单不一致。
const configListeners = []
function emitConfigChange() {
  if (!configListeners.length) return
  const cfg = readConfig()
  for (const cb of configListeners) {
    try { cb(cfg) } catch (err) { logErr('[whale][config] 订阅回调异常', err && err.message) }
  }
}

module.exports = {
  getConfig() {
    return readConfig()
  },
  // 订阅配置变更，返回退订函数（设置页 onMounted 订阅、onUnmounted 退订）
  onConfigChange(cb) {
    if (typeof cb !== 'function') return function () {}
    configListeners.push(cb)
    return function () {
      const i = configListeners.indexOf(cb)
      if (i >= 0) configListeners.splice(i, 1)
    }
  },
  emitConfigChange,
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
      logErr('[whale][shell] 打开外链失败', url, err && err.message)
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
    if (cfg.usageMode !== prev.usageMode) resetBalanceCache()
    pushConfig()
    return cfg
  },
  getSecrets() {
    return readSecrets()
  },
  saveSecrets(secrets) {
    const next = Object.assign(readSecrets(), secrets || {})
    writeSecrets(next)
    resetBalanceCache() // 密钥变更后强制重新拉取
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
    return usageDays(days)
  },
  // 导出近 N 天用量为 CSV（UTF-8 BOM，Excel 可直接打开）
  exportUsageCsv(days) {
    const { currency, days: rows } = usageDays(days)
    const lines = ['日期,用量,币种']
    for (const r of rows) lines.push(r.date + ',' + Number(r.usage || 0).toFixed(4) + ',' + currency)
    const csv = '\ufeff' + lines.join('\r\n') + '\r\n'
    let filePath
    try {
      filePath = utools.showSaveDialog({
        title: '导出账本用量',
        defaultPath: 'whale-usage-' + rows[rows.length - 1].date + '.csv',
        buttonLabel: '保存',
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
      })
    } catch (err) {
      logErr('[whale][csv] 打开保存框失败', err && err.message)
      return { ok: false, error: '无法打开保存对话框：' + ((err && err.message) || err) }
    }
    if (!filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(filePath, csv, 'utf8')
      return { ok: true, path: filePath }
    } catch (err) {
      logErr('[whale][csv] 写入失败', filePath, err && err.message)
      return { ok: false, error: '写入文件失败：' + ((err && err.message) || err) }
    }
  },
  // 导入用量 CSV（与导出格式一致：日期,用量[,币种]）：弹系统打开框 → 解析 → 合并进账本历史。
  // 同日以导入值覆盖；只保留最近 30 天；不影响当天实时记账基准。
  importUsageCsv() {
    let picked
    try {
      picked = utools.showOpenDialog({
        title: '导入账本用量',
        buttonLabel: '导入',
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
        properties: ['openFile'],
      })
    } catch (err) {
      logErr('[whale][csv] 打开选择框失败', err && err.message)
      return { ok: false, error: '无法打开文件选择框：' + ((err && err.message) || err) }
    }
    const filePath = Array.isArray(picked) ? picked[0] : picked
    if (!filePath) return { ok: false, canceled: true }
    let text
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      logErr('[whale][csv] 读取失败', filePath, err && err.message)
      return { ok: false, error: '读取文件失败：' + ((err && err.message) || err) }
    }
    const { rows, invalid } = parseUsageCsv(text)
    if (!rows.length) {
      return { ok: false, error: '未解析到有效数据：需要「日期,用量」两列，日期形如 2026-09-10' }
    }
    const r = mergeLedgerHistory(rows)
    return { ok: true, path: filePath, imported: r.imported, invalid: invalid, kept: r.kept, from: r.from, to: r.to }
  },
  // 清除本地数据：挂件设置、账本、窗口锚点、更新缓存。
  // 传 { keepSecrets: true } 时保留 API Key/平台 Token；否则一并清除（含凭据）。
  // 卸载 uTools 插件不会删除这些数据，需要彻底清除时由设置页调用本方法。
  clearAllData(opts) {
    const keepSecrets = !!(opts && opts.keepSecrets)
    const wasVisible = winAlive()
    try { utools.dbStorage.removeItem(K.config) } catch (err) {}
    try { utools.dbStorage.removeItem(K.ledger) } catch (err) {}
    try { utools.dbStorage.removeItem(K.win) } catch (err) {}
    try { utools.dbStorage.removeItem(K.update) } catch (err) {}
    if (!keepSecrets) { try { utools.dbCryptoStorage.removeItem(K.secrets) } catch (err) {} }
    resetAnchorCache()
    resetBalanceCache()
    // 重建挂件窗口，让默认配置与默认位置立即生效（原本隐藏则保持隐藏）
    destroyWidget()
    if (wasVisible) ensureWidget()
    return { ok: true, keepSecrets: keepSecrets }
  },
  ensureWidget() {
    ensureWidget()
    return { ok: winAlive(), error: getWidgetError() }
  },
  showWidget() {
    ensureWidget()
    return { ok: winAlive(), error: getWidgetError() }
  },
  getWidgetError() {
    return getWidgetError()
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
    try { return !!getWindow().isVisible() } catch (err) { return false }
  },
  // 诊断日志（dev 下同步落盘 %TEMP%\whale-debug.log，进程被 uTools 结束也不丢）。
  // 返回末尾部分即可，避免整份日志撑爆剪贴板/界面。
  isDev() { return DEV },
  getDebugLog() {
    if (!LOG_FILE) return { path: '', text: '' }
    let text = ''
    try { text = fs.readFileSync(LOG_FILE, 'utf8') } catch (err) { text = '' }
    return { path: LOG_FILE, text: text.slice(-20000) }
  },
  // 用系统默认程序打开日志文件（便于人工查看/另存）
  openLogFile() {
    if (!LOG_FILE) return { ok: false, path: '' }
    try {
      utools.shellOpenPath(LOG_FILE)
      return { ok: true, path: LOG_FILE }
    } catch (err) {
      logErr('[whale][log] 打开日志文件失败', err && err.message)
      return { ok: false, path: LOG_FILE }
    }
  },
}
