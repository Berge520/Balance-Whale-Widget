/*
 * 对外 API（CommonJS）：注入到主窗 window.services，供设置页调用。
 */
const fs = require('fs')
const { PLUGIN_VERSION, K } = require('./constants')
const { DEV, logErr, LOG_FILE } = require('./log')
const {
  clampNum, readConfig, patchConfig, readSecrets, writeSecrets, readLedger,
  resetAnchorCache, mergeLedgerHistory, clearTimer, calibrateTodayUsage,
} = require('./store')
const {
  fetchBalanceWith, fetchPlatformUsage, checkUpdate, resetBalanceCache,
} = require('./api')
const {
  ensureWidget, destroyWidget, winAlive, getWidgetError, getWindow,
  applyScaleToWindow, applyOnTop, pushConfig, queueLiveScale, repositionFromAnchor,
  taskbarState, syncTaskbarWatch, sendToWidget,
} = require('./widget')
const dsh = require('./dsh')
const backup = require('./backup')
const sounds = require('./sounds')

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
  // 今日被防误判拦下、未计入用量的余额变动（赠送额到期等），供设置页说明展示
  return {
    currency: led.lastCurrency || 'CNY',
    days: out,
    todayAdjust: typeof led.todayAdjust === 'number' ? led.todayAdjust : 0,
    lastAdjustWhy: led.lastAdjustWhy || '',
    lastAdjustAt: led.lastAdjustAt || '',
  }
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
  // 任务栏「当前」状态（设置页显示）：visible = 正在占位 / hidden = 已自动收起 / none = 未识别到
  getTaskbarState() {
    try { return taskbarState() } catch (err) { return { state: 'none', edge: '', thickness: 0 } }
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
      logErr('[whale][shell] 打开外链失败', url, err && err.message)
      return false
    }
  },
  // ──────────────────────────────────────────────
  // DeepSeek Harness（dsh，面向开发者用户）
  // ──────────────────────────────────────────────
  // 状态快照：运行中/pid/地址/模式/Node 目录与版本/错误/日志
  // 顺手触发一次端口探测（异步），这样「打开设置页/刷新状态」就能看到外部 dsh 的真实状态
  dshStatus() {
    try { dsh.probePort(() => {}) } catch (err) {}
    return dsh.snapshot()
  },
  dshStart() {
    return dsh.start()
  },
  dshStop() {
    return dsh.stop()
  },
  // 重启要等旧进程退出，结果通过回调异步更新（返回当前快照）
  dshRestart() {
    const cur = dsh.snapshot()
    dsh.restart(() => {})
    return cur
  },
  dshUpdate() {
    return dsh.update()
  },
  dshOpenWeb() {
    return dsh.openWeb()
  },
  // 查询可用版本列表（结果通过状态快照的 versions 字段回传，稍后刷新状态即可看到）
  dshListVersions() {
    return dsh.listVersions()
  },
  dshClearLog() {
    return dsh.clearLog()
  },
  // 删除插件目录里的那份 dsh（有全局安装时用不到它）
  dshRemovePlugin() {
    return dsh.removePluginDsh()
  },
  // 清理 npx 缓存里含 dsh 的历史副本（旧版本留下的）
  dshCleanNpxCache() {
    return dsh.cleanNpxCaches()
  },
  // 选择 Node.js 安装目录并校验（目录里必须有 node 可执行文件）
  dshPickNodeDir() {
    let picked
    try {
      picked = utools.showOpenDialog({
        title: '选择 Node.js 安装目录',
        buttonLabel: '选择',
        properties: ['openDirectory'],
      })
    } catch (err) {
      return { ok: false, error: '无法打开目录选择框：' + ((err && err.message) || err) }
    }
    const dir = Array.isArray(picked) ? picked[0] : picked
    if (!dir) return { ok: false, canceled: true }
    if (!dsh.nodeInDir(dir)) {
      return { ok: false, error: '该目录下没有 node 可执行文件，请选择 Node.js 的安装目录（如 D:\\nodejs）' }
    }
    return { ok: true, dir: dir }
  },
  saveConfig(patch) {
    // 设置页拖动滑块中的实时预览：只改窗口几何（rAF 合帧），不写存储、不广播
    if (patch && patch.__live) {
      queueLiveScale(patch.scale)
      return readConfig()
    }
    const prev = readConfig()
    const cfg = patchConfig(patch)
    // 关掉「计时保存」时顺手清掉已落库的计时状态，避免下次重建挂件又恢复
    if (cfg.timerPersistOn === false && prev.timerPersistOn !== false) clearTimer()
    if (cfg.scale !== prev.scale) applyScaleToWindow(cfg.scale, true)
    // 「自动避让任务栏」或四边间距变了：按当前锚点重摆一次，立刻能看到效果
    if (cfg.avoidTaskbar !== prev.avoidTaskbar
      || cfg.edgeTop !== prev.edgeTop || cfg.edgeRight !== prev.edgeRight
      || cfg.edgeBottom !== prev.edgeBottom || cfg.edgeLeft !== prev.edgeLeft) {
      repositionFromAnchor()
    }
    if (cfg.avoidTaskbar !== prev.avoidTaskbar) syncTaskbarWatch()
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
  // 手动校准今日已用（记账模式）：只改当天累计、留校准记录，不动余额基准
  calibrateTodayUsage(amount) {
    return calibrateTodayUsage(amount)
  },
  // —— 自定义音效 ——
  // 自定义音效元信息（按压/释放两段），供设置页展示当前文件名
  getSounds() {
    return sounds.readMeta()
  },
  // 导入（复制进 userData/whale-sounds）后推新音频数据给挂件
  importSound(role) {
    const r = sounds.importSound(role)
    if (r && r.ok) sendToWidget('whale:sounds', sounds.getSoundData())
    return r
  },
  removeSound(role) {
    const r = sounds.removeSound(role)
    if (r && r.ok) sendToWidget('whale:sounds', sounds.getSoundData())
    return r
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
  // 按项清除本地数据：opts = { secrets, config, ledger, window, sounds }，为 true 的项才会被清除。
  // 「窗口」项同时含窗口锚点与更新缓存。卸载 uTools 插件不会删除这些数据，需要彻底清除时由设置页调用。
  clearAllData(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const wasVisible = winAlive()
    if (o.secrets) { try { utools.dbCryptoStorage.removeItem(K.secrets) } catch (err) {} }
    if (o.config) {
      try { utools.dbStorage.removeItem(K.config) } catch (err) {}
      clearTimer() // 设置被重置，一并清掉已落库的计时状态
    }
    if (o.ledger) { try { utools.dbStorage.removeItem(K.ledger) } catch (err) {} }
    // 自定义音效：音频文件（userData/whale-sounds）+ 元信息，独立于「挂件设置」
    if (o.sounds) {
      try { sounds.clearAll() } catch (err) { logErr('[whale][settings] 清除自定义音效失败', err && err.message) }
      // 音效没了，音色还停在「自定义」就没有音源：顺带回退到内置「小黄鸭」
      // （连同 config 一起清除时不必处理 —— 整份配置已重置，soundSet 本就是默认值）
      if (!o.config) {
        try {
          if (readConfig().soundSet === 'custom') {
            patchConfig({ soundSet: 'duck' })
            pushConfig()
          }
        } catch (err) { logErr('[whale][settings] 回退音色失败', err && err.message) }
      }
    }
    if (o.window) {
      try { utools.dbStorage.removeItem(K.win) } catch (err) {}
      try { utools.dbStorage.removeItem(K.update) } catch (err) {}
      try { utools.dbStorage.removeItem(K.dshVersions) } catch (err) {}
      resetAnchorCache()
    }
    resetBalanceCache()
    // 配置或窗口锚点被清除后按默认值重建挂件（原本隐藏则保持隐藏）
    if (o.config || o.window) {
      destroyWidget()
      if (wasVisible) ensureWidget()
    }
    // 音效被清除后把「无自定义音效」推给挂件，正在用「自定义」的音色会立刻回退内置音
    if (o.sounds) {
      try { sendToWidget('whale:sounds', sounds.getSoundData()) } catch (err) {}
    }
    return {
      ok: true,
      cleared: { secrets: !!o.secrets, config: !!o.config, ledger: !!o.ledger, window: !!o.window, sounds: !!o.sounds },
    }
  },
  ensureWidget() {
    ensureWidget()
    return { ok: winAlive(), error: getWidgetError() }
  },
  // ── 备份 / 恢复 ──
  // 导出：设置 / 账本 / 窗口位置 / 计时；opts.secrets=true 时用 opts.password 加密后才写入凭据
  backupExport(opts) {
    return backup.exportBackup(opts)
  },
  // 选择备份文件并解析出预览（不写任何数据）
  backupPick() {
    return backup.pickBackup()
  },
  // 按勾选项恢复（同名覆盖）；设置或窗口位置被恢复后重建挂件，让它立刻生效
  backupApply(opts) {
    const r = backup.applyBackup(opts)
    const hit = r && r.applied && (r.applied.indexOf('config') >= 0 || r.applied.indexOf('window') >= 0)
    if (hit) {
      resetBalanceCache()
      const wasVisible = winAlive()
      destroyWidget()
      if (wasVisible) ensureWidget()
      return Object.assign({}, r, { widgetRebuilt: true })
    }
    return r
  },
  // 放弃本次选择
  backupCancel() {
    return backup.clearPending()
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
