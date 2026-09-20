/*
 * 对外 API（CommonJS）：注入到主窗 window.services，供设置页调用。
 */
const fs = require('fs')
const { PLUGIN_VERSION, K, MODEL_TEMPLATES, MODEL_MAX, DEFAULT_MAIN_MODEL } = require('./constants')
const { log, logErr, LOG_FILE } = require('./log')
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
const hosts = require('./hosts')
const { sendMail, mailSubject, notifySystem, sendMailAsync } = require('./notify')
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

// GitHub 加速操作的统一包装：开 op 日志 → 跑任务 → 按「结论函数」定终态与摘要。
// 五个操作（开启/关闭/刷新/校验/检测）原本各写一遍 then/catch 样板，既要重复 opEnd，
// 又要手写「什么算成功/取消」—— 抽成一处，新增操作只需给 run + verdict 两个函数。
// verdict(res) 返回 [state, summary]，state 取 ok / fail / cancel；抛错一律记 fail。
function runGhAccelOp(title, run, verdict) {
  const op = hosts.opStart(title)
  return Promise.resolve()
    .then(() => run(op))
    .then((res) => {
      const v = verdict(res) || ['ok', '']
      if (v[0] === 'fail') logErr('[whale][ghaccel] ' + title + '失败', v[1] || '')
      else log('[whale][ghaccel] ' + title + (v[0] === 'cancel' ? '已取消' : '成功'), v[1] || '')
      hosts.opEnd(op, v[0], v[1])
      return res
    })
    .catch((err) => {
      logErr('[whale][ghaccel] ' + title + '异常', err && err.message)
      hosts.opEnd(op, 'fail', String((err && err.message) || err))
      throw err
    })
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
  // 让 uTools 底座跳到「插件应用市场」并搜索指定关键词：
  // redirect(label) 传入非本插件指令的名称时，底座查不到已装插件会降级为「跳市场并搜索该名称」。
  // 之所以不直接用「小鲸鱼余额挂件」：用户很可能已装本插件，为避免命中自己的指令而直接打开自身，
  // 用「不可作为指令命中」的词去触发市场搜索分支。失败返回 false，由设置页兜底走浏览器详情页。
  redirectToMarket(keyword) {
    try {
      return !!utools.redirect(String(keyword || ''))
    } catch (err) {
      logErr('[whale][market] 跳转插件市场失败', keyword, err && err.message)
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
  // ──────────────────────────────────────────────
  // GitHub 加速（hosts 方案，见 lib/hosts.js；纯设置页功能，不做新 IPC）
  // ──────────────────────────────────────────────
  // 实际状态：读 hosts 文件现算（块存在 = 生效），不依赖配置里的开关意图
  ghAccelStatus() {
    return hosts.ghAccelStatus()
  },
  // 可选的社区源表清单（含默认顺序）：设置页要按这份清单渲染「自定义源表优先级」，
  // 不能在前端再抄一份 URL —— 源清单是 hosts 模块的领域知识，抄一份必然随版本漂移
  ghAccelSources() {
    return hosts.ghAccelSources()
  },
  // 最近一次 IP 获取的来源追踪（内存态）：每个域名最终 IP 从哪来（DoH/社区源表/当前表/兜底）
  ghAccelTrace() {
    return hosts.ghAccelTrace()
  },
  // 操作日志（内存态，最多 50 条）：一次操作 = 一条，含步骤与结果，供设置页「GitHub 加速日志」回看
  ghAccelOpLogs() {
    return hosts.ghAccelOpLogs()
  },
  // 清空操作日志（返回清掉的条数）。不写成一次 op：清日志本身记进日志会立刻又冒出一条，自相矛盾
  ghAccelClearOpLogs() {
    return { cleared: hosts.clearGhAccelOpLogs() }
  },
  // 块外已存在的目标域名条目（其它工具也写 hosts 时会覆盖本插件）
  ghAccelScanConflicts() {
    return hosts.scanConflicts()
  },
  // 开启/关闭：写标记块要 UAC 提权，返回 Promise；refresh=true 时开启前先静默刷新 GitHub520 并探测只写可达 IP
  ghAccelEnable(ips, refresh) {
    // 来源开关与优先级顺序随开启一起下发：用户在「获取方式」里改过设置后就该本次生效，不必重新勾选。
    // 读的是当前配置（cfg.ghAccelSrc），而非前端传参 —— 前端只负责改配置，hosts 写块时以配置为准，
    // 避免前端漏传导致「开关关了但没生效」
    const src = (readConfig().ghAccelSrc) || {}
    return runGhAccelOp(
      // 标题不再写「先刷新 IP 表」：刷新现在与探测**并行**跑，源只作补测，不再是前置串行步骤
      refresh ? '开启 GitHub 加速（并行刷新 IP 表）' : '开启 GitHub 加速 / 重新写入 hosts',
      (op) => hosts.enable(ips, { refresh: refresh, src: src }, op),
      (res) => {
        if (!res.ok) return res.canceled ? ['cancel', 'UAC 弹窗被取消，hosts 未改动'] : ['fail', res.error]
        // r.ips 是回写入配置的「用户表内」IP 条数，与真正写进 hosts 的行数不同
        // （hosts 里有同域名多行的备用 IP 与兜底候选），文案按域名数说更贴近用户认知
        const n = res.ips ? new Set(res.ips.map((it) => it.domain)).size : 0
        const rows = res.ips ? res.ips.length : 0
        return ['ok', n + ' 个域名已写入 hosts（共 ' + rows + ' 条，含备用 IP 回退），浏览器 / git / 下载立即生效']
      }
    )
  },
  ghAccelDisable() {
    return runGhAccelOp('关闭 GitHub 加速（移除 hosts 标记块）', (op) => hosts.disable(op), (res) => {
      if (!res.ok) return res.canceled ? ['cancel', 'UAC 弹窗被取消，标记块仍在'] : ['fail', res.error]
      return ['ok', res.already ? 'hosts 里本就没有本插件的块，无需改动' : '标记块已移除，hosts 还原为开启前的内容']
    })
  },
  // 一键刷新 IP 表（走与开启同一套候选链：DoH 实时解析 + 社区源）；current 传当前表。
  // 候选链给的 IP 探测不通时，**当前表的旧值也要复验一遍**：旧值同样可能是失效死地址，
  // 复验通过才沿用，不通过就**不写这个域名**（宁可让系统回落到 DNS 真实解析，也不写一条死映射）。
  // src.sources 与 src.order 都必须从配置读后传入：不传则 hosts 内部退回内置默认顺序，
  // 用户在「来源优先级 / 社区源表优先级」里排的序就白设了 —— 而「开启加速」走 hosts.enable
  // 是传了的，两条路径行为不一致会让用户以为「优先级时灵时不灵」
  // （旧版的坑更隐蔽：这里从不传 order，refreshIps 也从不解析 DoH，用户把 DoH 排第一
  // 却看到日志只报「拉取社区源 … 成功」，设置完全没生效）
  ghAccelRefreshIps(current) {
    const src = (readConfig().ghAccelSrc) || {}
    // 标题里的来源链**按用户实际设置动态生成**：原来写死「DoH 实时解析 + 社区源」，
    // 用户关掉 DoH 或调换顺序后标题仍照旧，等于在日志里误导「这一步做了什么」
    return runGhAccelOp('刷新 IP 表（按来源优先级取 ' + hosts.srcChainLabel(src.order, src) + '）',
      (op) => hosts.refreshIps(current, op, src.sources, src.order, src.customSources), (res) => {
      if (!res.ok) return ['fail', res.error]
      return ['ok', 'IP 表已更新为 ' + res.updated.length + ' 条'
        + (res.unreachable ? '，其中 ' + res.unreachable + ' 个候选 IP 探测不通' : '')
        + (res.dropped ? '、' + res.dropped + ' 个旧值复验也不通已放弃写入' : '')
        + '；需点「重新写入 hosts」才会对系统生效']
    })
  },
  // 校验当前 IP 表：逐条探测，返回 { results, bad, stale }。只给结论不删表，删除由设置页确认后走 saveConfig
  ghAccelVerifyIps(ips) {
    return runGhAccelOp('校验 IP 表可用性', (op) => hosts.verifyIps(ips, op), (res) => {
      const good = res.results.length - res.bad.length - res.stale.length
      return ['ok', '共 ' + res.results.length + ' 条：可用 ' + good + ' 条，不可用 ' + res.bad.length
        + ' 条' + (res.stale.length ? '，待复查 ' + res.stale.length + ' 条（探测失败但仍是当前 DNS 解析结果）' : '')]
    })
  },
  // 连通性自检（HEAD https://github.com），开启前后各测一次做对比
  ghAccelProbe() {
    return runGhAccelOp('检测 GitHub 连接', (op) => hosts.probeConnectivity(op), (res) =>
      res.ok
        ? ['ok', 'github.com 可达，HTTP ' + res.status + '，耗时 ' + res.ms + 'ms']
        : ['fail', '无法访问 github.com：' + (res.error || '未知错误')])
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
    // 反向回推给设置页：saveConfig 是设置页自己调的，但设置页的 cfg 不一定等于落库结果 ——
    // 宿主 patchConfig 会做归一化（补齐 / 钳范围 / 清洗），不回推的话设置页手里的还是它自己拼的
    // 那份「未归一化」的值。取消订阅后再回推会打断「配置 → 订阅 → 回推」的闭环
    emitConfigChange()
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
  // 邮件通知的凭据（SMTP 服务器/端口/账号/授权码）：单独一个入口，因为它进的是加密存储，
  // 而 saveSecrets 的调用方（备份恢复/DeepSeek 密钥卡）只会传 apiKey/platformToken。
  // 另外 notifyMail 传 undefined 会被 writeSecrets 判为「沿用现值」—— 设置页每次提交的是完整对象，不受影响。
  saveMailSecrets(mail) {
    const cur = readSecrets()
    const m = mail && typeof mail === 'object' ? mail : {}
    // 授权码留空 = 沿用已保存的（设置页回填的是掩码，用户没重新输入时不能当成「清空」）
    if (m.mailPass === undefined || m.mailPass === '') m.mailPass = cur.notifyMail.mailPass
    writeSecrets(Object.assign({}, cur, { notifyMail: m }))
    return readSecrets().notifyMail
  },
  // 发一封测试邮件：直接使用传入的 SMTP 配置（设置页「保存前先测一下」的场景），
  // 不落库、不动余额缓存。返回 { ok } 或 { ok:false, error }，错误原样给用户看
  async sendTestMail(mail) {
    const cur = readSecrets()
    const m = Object.assign({}, mail || {})
    if (m.mailPass === undefined || m.mailPass === '') m.mailPass = cur.notifyMail.mailPass
    // 发件人/收件人来自配置（非明文凭据区）。设置页会随参数带过来；这里退回读配置，
    // 免得「表单填了但漏传」时只得到一句「发件邮箱格式不正确」，看不出该去哪儿补
    if (!m.mailFrom) m.mailFrom = readConfig().mailFrom
    if (!m.mailTo) m.mailTo = readConfig().mailTo
    if (!String(m.mailFrom || '').trim()) return { ok: false, error: '还没填「发件人」，请在下方配置区补上（一般与账号一致）' }
    if (!String(m.mailTo || '').trim()) return { ok: false, error: '还没填「收件人」，请在下方配置区补上' }
    const body = '这是一封来自小鲸鱼余额挂件的测试邮件。\n\n收到它说明邮件通知已配置成功，' +
      '之后低余额、今日预算、余额大幅波动、计时到点等提醒都会发到这里。'
    return sendMail(m, mailSubject(body), body)
  },
  // 通知渠道自测：按当前开着的渠道各送一条，让用户确认「开关 + 配置」真的能送达。
  // 系统通知走同一条 notifySystem（同步），邮件走 sendMailAsync（异步、要等服务器回包），
  // 因此两者分开回执。刻意不做 notify 那套「每天一次」去重 —— 点一下就该有一条
  async testNotify() {
    const cfg = readConfig()
    const body = '这是一条来自小鲸鱼余额挂件的测试通知。\n\n看到它说明通知渠道配置成功，' +
      '之后低余额、今日预算、余额大幅波动、计时到点等提醒都会从这里送达。'
    if (cfg.notifyMailOn === true && (!String(cfg.mailFrom || '').trim() || !String(cfg.mailTo || '').trim())) {
      return { ok: false, on: [], error: '邮件通知已开，但「发件人 / 收件人」还没填，请先在下方补上' }
    }
    // 邮件走 sendMailAsync —— 与自动提醒**同一条**路径，这样测通了就一定能收到真实提醒。
    // 早先这里另拼一份参数，结果漏了收件人，测出来「失败」而实际配置是好的
    let mail = null
    if (cfg.notifyMailOn === true) {
      mail = sendMailAsync(cfg, body)
    }
    const on = []
    let sysOk = false
    if (cfg.notifySystemOn !== false) {
      try { sysOk = notifySystem('测试通知：通知渠道正常') === true } catch (err) { sysOk = false }
      on.push('系统通知')
    }
    if (mail) on.push('邮件')
    if (!on.length) return { ok: false, on, error: '系统通知与邮件通知都关着，没有可测试的渠道' }
    if (mail) {
      const r = await mail
      if (!r.ok) return { ok: false, on, system: sysOk, error: r.error }
    }
    return { ok: true, on, system: sysOk }
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
  // 诊断日志（同步落盘 %TEMP%\whale-debug.log，进程被 uTools 结束也不丢）。
  // 返回末尾部分即可，避免整份日志撑爆剪贴板/界面。
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
