/*
 * 对外 API（CommonJS）：注入到主窗 window.services，供设置页调用。
 */
const fs = require('fs')
const { PLUGIN_VERSION, K, MODEL_TEMPLATES, MODEL_MAX, DEFAULT_MAIN_MODEL } = require('./constants')
const { DEV, logErr, LOG_FILE } = require('./log')
const {
  clampNum, readConfig, patchConfig, readSecrets, writeSecrets, readLedger, historyKeepDays,
  resetAnchorCache, mergeLedgerHistory, clearTimer, calibrateTodayUsage,
  defaultAnchor, writeAnchor, normModelId, normModel, sanitizeKey, dropModelState,
} = require('./store')
const {
  fetchBalanceWith, fetchPlatformUsage, checkUpdate, resetBalanceCache,
  fetchModelBalance, refreshModels: refreshModelsApi, getModelsPayload,
} = require('./api')
const {
  ensureWidget, destroyWidget, winAlive, getWidgetError, getWindow,
  applyScaleToWindow, applyOnTop, pushConfig, queueLiveScale, repositionFromAnchor,
  taskbarState, syncTaskbarWatch, sendToWidget,
} = require('./widget')
const dsh = require('./dsh')
const backup = require('./backup')
const assets = require('./assets')
const sounds = require('./sounds')
const skins = require('./skins')
const bubbles = require('./bubbles')
const codex = require('./codex')
const dshUsage = require('./dsh-usage')

// 近 N 天用量（含今日，缺失日期补 0），按日期升序。
// 上限 = 配置的账本保留天数（默认 365，最低 35）：设置页要算「本月汇总」，31 号那天窗口必须能回溯到 1 号。
function usageDays(days) {
  const n = clampNum(days, 1, historyKeepDays(), 7)
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
    // 额度「不重置」口径的累计已用（归档累计 + 今天）
    cumUsed: (typeof led.quotaUsed === 'number' ? led.quotaUsed : 0)
      + (typeof led.todayUsage === 'number' ? led.todayUsage : 0),
  }
}

// 账本明细：区间内每日用量 + 当天「未计入用量的余额变动」与「手动校准」记录，供设置页按日展开。
// 明细日志（adjustLog / calibrateLog）由宿主跨天保留配置的保留天数，区间外查不到。
// 检索交给设置页本地做（数据一次拿全，输入即过滤，不用每次按键都过一次 IPC）。
function usageDetail(days) {
  const n = clampNum(days, 1, historyKeepDays(), 7)
  const led = readLedger()
  const p2 = (x) => String(x).padStart(2, '0')
  // 两条日志都带 ISO 时间戳，取前 10 位即日期
  const byDate = {}
  const collect = (list, build) => {
    for (const e of Array.isArray(list) ? list : []) {
      const at = e && typeof e.at === 'string' ? e.at : ''
      if (!at) continue
      const d = at.slice(0, 10)
      if (!byDate[d]) byDate[d] = []
      byDate[d].push(build(e, at))
    }
  }
  collect(led.adjustLog, (e, at) => ({
    at: at, kind: 'adjust', amount: Number(e.amount) || 0, why: String(e.why || ''),
  }))
  collect(led.calibrateLog, (e, at) => ({
    at: at, kind: 'calibrate', from: Number(e.from) || 0, to: Number(e.to) || 0,
  }))
  const now = new Date()
  const out = []
  let total = 0
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate())
    let usage = 0
    if (key === led.date) usage = typeof led.todayUsage === 'number' ? led.todayUsage : 0
    else if (typeof led.history[key] === 'number') usage = led.history[key]
    out.push({
      date: key,
      usage: usage,
      entries: (byDate[key] || []).sort((a, b) => (a.at < b.at ? -1 : 1)),
    })
    total += usage
  }
  return {
    currency: led.lastCurrency || 'CNY',
    days: out,
    total: Math.round(total * 10000) / 10000,
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

// 模型列表/主显示变化后推给挂件（挂件菜单里的「模型」分组要立即跟着变）
function pushModels() {
  sendToWidget('whale:models', getModelsPayload())
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
      || cfg.edgeBottom !== prev.edgeBottom || cfg.edgeLeft !== prev.edgeLeft
      || cfg.scrollGapOn !== prev.scrollGapOn || cfg.scrollGapPx !== prev.scrollGapPx) {
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
    return fetchPlatformUsage(String(platformToken || '').trim(), readConfig().tokenPrice).then((r) => {
      // 「今日无用量」说明接口已连通，不算失败
      if (r && r.error === 'no usage') return { amount: 0, tokens: 0, empty: true }
      return r
    })
  },
  // 近 N 天用量（含今日，缺失日期补 0），供设置页趋势图
  getUsageHistory(days) {
    return usageDays(days)
  },
  // 账本明细（近 N 天每日用量 + 当天的异常变动/校准记录），供设置页「账本明细」展开查看
  getUsageDetail(days) {
    return usageDetail(days)
  },
  // 今日各模型金额占比（按金额降序），供设置页「今日模型占比」。只走令牌模式：
  // 记账模式只有总额没有模型明细（余额接口不给），返回 error 由页面提示。
  getTodayModels() {
    const token = readSecrets().platformToken
    if (!token) return Promise.resolve({ ok: false, error: '未配置平台 Token' })
    return fetchPlatformUsage(token, readConfig().tokenPrice).then((r) => {
      if (r && r.error) return { ok: false, error: r.error }
      return {
        ok: true,
        models: (r && r.byModel) || [],
        amount: (r && r.amount) || 0,
        tokens: (r && r.tokens) || 0,
      }
    })
  },
  // 手动校准今日已用（记账模式）：只改当天累计、留校准记录，不动余额基准
  calibrateTodayUsage(amount) {
    return calibrateTodayUsage(amount)
  },
  // —— 多厂商模型（余额 / 额度）——
  // 列表（含内置 DeepSeek 那条）+ 当前主显示模型，供设置页与挂件菜单渲染
  getModels() {
    return getModelsPayload()
  },
  // 厂商模板表：设置页「添加模型」时按模板预填字段路径与接口地址
  getModelTemplates() {
    return { templates: MODEL_TEMPLATES, max: MODEL_MAX, mainModelId: DEFAULT_MAIN_MODEL }
  },
  // 完整模型配置（含接口地址与字段路径）：设置页行内编辑要原样回填。
  // getModels() 的载荷是给挂件显示用的，只有余额/额度几个字段，回填会丢配置。
  getModelsConfig() {
    return readConfig().models
  },
  // 新增 / 编辑一个模型。key 传 undefined 表示「不动密钥」（编辑时用户可能不改）；
  // 传空串表示清空该模型的密钥。
  saveModel(model, key) {
    const m = normModel(model)
    if (!m) return { ok: false, error: '模型 ID 无效' }
    const cfg = readConfig()
    const list = cfg.models.slice()
    const i = list.map((x) => x.id).indexOf(m.id)
    if (i < 0 && list.length >= MODEL_MAX) {
      return { ok: false, error: '最多添加 ' + MODEL_MAX + ' 个模型' }
    }
    if (i < 0) list.push(m)
    else list[i] = m
    patchConfig({ models: list })
    if (key !== undefined) {
      // writeSecrets 是「整体重建」，这里必须带上原有 apiKey/platformToken，
      // 否则只改一个模型密钥会把 DeepSeek 的密钥一起清掉
      const cur = readSecrets()
      const models = Object.assign({}, cur.models)
      const k = sanitizeKey(key)
      if (k) models[m.id] = k
      else delete models[m.id]
      writeSecrets({ apiKey: cur.apiKey, platformToken: cur.platformToken, models: models })
    }
    pushModels()
    return { ok: true, id: m.id, hasKey: !!readSecrets().models[m.id] }
  },
  // 删除模型：同时清掉运行时状态与密钥槽位；被删的是主显示时回退 DeepSeek
  removeModel(id) {
    const mid = normModelId(id)
    if (!mid) return { ok: false, error: '模型 ID 无效' }
    const cfg = readConfig()
    // models 先于 mainModelId 处理：列表里已没有这个 id，主显示会自动回退
    patchConfig({ models: cfg.models.filter((m) => m.id !== mid), mainModelId: cfg.mainModelId })
    dropModelState(mid)
    const cur = readSecrets()
    const models = Object.assign({}, cur.models)
    delete models[mid]
    writeSecrets({ apiKey: cur.apiKey, platformToken: cur.platformToken, models: models })
    pushModels()
    return { ok: true }
  },
  // 切换挂件主显示的模型（'deepseek' 为内置）
  setMainModel(id) {
    const cfg = readConfig()
    const mid = normModelId(id) || DEFAULT_MAIN_MODEL
    if (mid !== DEFAULT_MAIN_MODEL && !cfg.models.some((m) => m.id === mid)) {
      return { ok: false, error: '模型不存在' }
    }
    patchConfig({ mainModelId: mid })
    pushModels()
    return { ok: true, mainModelId: readConfig().mainModelId }
  },
  // 用给定条目直接验证（不落库）：key 省略时取该模型已保存的密钥
  testModel(model, key) {
    const m = normModel(model)
    if (!m) return Promise.resolve({ ok: false, error: '模型 ID 无效' })
    const k = sanitizeKey(key) || readSecrets().models[m.id] || ''
    return fetchModelBalance(m, k)
  },
  // 刷新模型余额/额度（ids 省略 = 全部），结果落运行时状态并推给挂件
  refreshModels(ids, force) {
    return refreshModelsApi(ids, force).then(() => {
      pushModels()
      return { ok: true }
    })
  },
  // —— 自定义音效 ——
  // 自定义音效元信息（每槽位一个数组），供设置页展示已导入的段落
  getSounds() {
    return sounds.readMeta()
  },
  // 音效本体（base64 data URL），供设置页试听（元信息只有文件名，播不了）
  getSoundData() {
    return sounds.getSoundData()
  },
  // 导入（复制进 userData/whale-sounds）后推新音频数据给挂件
  importSound(role) {
    const r = sounds.importSound(role)
    if (r && r.ok) sendToWidget('whale:sounds', sounds.getSoundData())
    return r
  },
  // 选音频但先不落盘：设置页拿到 data URL 后弹波形裁剪，确认了才走 importSoundFromData
  pickSoundFile() {
    return sounds.pickSoundFile()
  },
  // 写入裁剪后的 WAV（前端已转成 16-bit PCM）并推给挂件
  importSoundFromData(role, name, dataUrl) {
    const r = sounds.importSoundFromData(role, name, dataUrl)
    if (r && r.ok) sendToWidget('whale:sounds', sounds.getSoundData())
    return r
  },
  // 删一段（给 file）或清空整个槽位（不给 file，设置页的批量清除走这条）
  removeSound(role, file) {
    const r = sounds.removeSound(role, file)
    if (r && r.ok) sendToWidget('whale:sounds', sounds.getSoundData())
    return r
  },
  // —— 自定义挂件形象（画廊） ——
  // 画廊列表：每项的元信息 + 缩略图 data URL（current = 挂件当前用的那张的 id）
  listSkins() {
    return skins.listSkins()
  },
  // 当前形象元信息（画廊为空时返回 null），供设置页展示当前文件名
  getSkin() {
    return skins.readMeta()
  },
  // 当前形象本体（base64 data URL，挂件 img.src 直接用）；空串表示无自定义形象
  getSkinData() {
    return skins.getSkinData()
  },
  // 导入/删除/切换后推新形象数据给挂件（空串表示无自定义形象，页面回退内置形象）
  importSkin() {
    const r = skins.importSkin()
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // 选图片但先不落盘：设置页拿到 data URL 后弹裁剪框，确认了才走 importSkinFromData
  pickImageFile() {
    return skins.pickImageFile()
  },
  // 已选好的文件直接复制（不裁剪）：动图走这条路径保留动画。thumb 是设置页 canvas 生成的缩略图
  importSkinFromPath(filePath, name, thumb) {
    const r = skins.importSkinFromPath(filePath, name, thumb)
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // 写入裁剪后的 PNG（保留透明通道）并推给挂件
  importSkinFromData(name, dataUrl, thumb) {
    const r = skins.importSkinFromData(name, dataUrl, thumb)
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // 换用画廊里的某一张
  setSkinCurrent(id) {
    const r = skins.setCurrent(id)
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // 把某一张移到画廊最前（不改变当前使用的那张）
  pinSkin(id) {
    return skins.pinSkin(id)
  },
  removeSkin(id) {
    const r = skins.removeSkin(id)
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // —— 自定义气泡图片（点鲸鱼时随机显示一张，无「当前用哪张」概念） ——
  // 列表：元信息 + 缩略图 data URL，供设置页网格展示
  listBubbles() {
    return bubbles.listBubbles()
  },
  // 选图片但先不落盘：设置页拿到 data URL 后生成缩略图，确认了才走 importBubbleFromData
  pickBubbleFile() {
    return bubbles.pickBubbleFile()
  },
  // 原图原样落盘（不裁剪不重编码，保住动图帧）并推给挂件
  importBubbleFromData(name, dataUrl, thumb) {
    const r = bubbles.importBubbleFromData(name, dataUrl, thumb)
    if (r && r.ok) sendToWidget('whale:bubbles', bubbles.getBubbleData())
    return r
  },
  removeBubble(id) {
    const r = bubbles.removeBubble(id)
    if (r && r.ok) sendToWidget('whale:bubbles', bubbles.getBubbleData())
    return r
  },
  // —— 素材包（形象 + 音效 + 气泡图打包带走） ——
  // 导出成一个 .whaleassets 单文件
  assetsExport() {
    return assets.exportAssets()
  },
  // 选择素材包并解析出预览（不写任何数据）
  assetsPick() {
    return assets.pickAssets()
  },
  // 按勾选项写入（形象/气泡图补充、音效同槽位覆盖），写完把新素材推给挂件
  assetsApply(opts) {
    const r = assets.applyAssets(opts)
    if (r && r.ok) {
      if (r.skins && r.skins.added > 0) sendToWidget('whale:skin', skins.getSkinData())
      if (r.sounds && r.sounds.applied > 0) sendToWidget('whale:sounds', sounds.getSoundData())
      if (r.bubbles && r.bubbles.added > 0) sendToWidget('whale:bubbles', bubbles.getBubbleData())
    }
    return r
  },
  // 放弃本次选择
  assetsCancel() {
    return assets.clearPending()
  },
  // Codex 本地会话统计：读 ~/.codex/sessions 下的 rollout JSONL，按天/模型聚合
  codexSummary() {
    return codex.codexSummary()
  },
  clearCodexCache() {
    return codex.clearCodexCache()
  },
  // dsh 本地用量统计：读 $DSH_HOME（默认 ~/.dsh）下 dsh-usage 的账本与会话投影缓存，按天/模型聚合
  dshUsageSummary() {
    return dshUsage.dshUsageSummary()
  },
  clearDshUsageCache() {
    return dshUsage.clearDshUsageCache()
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
  // 按项清除本地数据：opts = { secrets, config, ledger, window, sounds, skins, bubbles }，为 true 的项才会被清除。
  // 「窗口」项同时含窗口锚点与更新缓存。卸载 uTools 插件不会删除这些数据，需要彻底清除时由设置页调用。
  clearAllData(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const wasVisible = winAlive()
    if (o.secrets) { try { utools.dbCryptoStorage.removeItem(K.secrets) } catch (err) {} }
    if (o.config) {
      try { utools.dbStorage.removeItem(K.config) } catch (err) {}
      // 模型列表随配置一起没了，运行时快照（余额/额度）留着只会在下次同名重建时冒充新数据
      try { utools.dbStorage.removeItem(K.models) } catch (err) {}
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
    if (o.skins) {
      try { skins.clearAll() } catch (err) { logErr('[whale][settings] 清除自定义形象失败', err && err.message) }
      // 同音效：自定义形象没了，形象还停在「自定义」就无图可显示，回退到默认内置形象
      if (!o.config) {
        try {
          if (readConfig().skin === 'custom') {
            patchConfig({ skin: 'DSniang1' })
            pushConfig()
          }
        } catch (err) { logErr('[whale][settings] 回退形象失败', err && err.message) }
      }
    }
    if (o.bubbles) {
      // 气泡图没有「当前用哪张」的概念，删光即自动回退内置 rua.gif，不必改配置
      try { bubbles.clearAll() } catch (err) { logErr('[whale][settings] 清除自定义气泡图失败', err && err.message) }
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
    // 同理：自定义形象被清除后推空串，挂件立刻回退内置形象
    if (o.skins) {
      try { sendToWidget('whale:skin', skins.getSkinData()) } catch (err) {}
    }
    // 同理：气泡图被清除后推空数组，挂件立刻回退内置 rua.gif
    if (o.bubbles) {
      try { sendToWidget('whale:bubbles', bubbles.getBubbleData()) } catch (err) {}
    }
    return {
      ok: true,
      cleared: {
        secrets: !!o.secrets, config: !!o.config, ledger: !!o.ledger, window: !!o.window,
        sounds: !!o.sounds, skins: !!o.skins, bubbles: !!o.bubbles,
      },
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
  // 把挂件位置复位到默认锚点（右下角、紧贴边缘）并立即重摆。
  // 换显示器 / 改分辨率 / 误拖到角落之后，靠它一键找回，不必手动拖拽。
  resetWidgetPosition() {
    writeAnchor(defaultAnchor())
    const ok = repositionFromAnchor()
    return { ok: ok, error: ok ? '' : '挂件窗口未显示，请先唤出挂件' }
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
