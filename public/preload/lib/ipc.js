/*
 * IPC 路由：悬浮窗 → 宿主（CommonJS）。
 */
const { ipcRenderer } = require('electron')
const { log, logErr } = require('./log')
const { errMsg } = require('./util')
const { getBalance, refreshModels, getModelsPayload, notifyDaily } = require('./api')
const {
  readConfig, patchConfig, writeAnchor, writeTimer, clearTimer,
  readTodo, writeTodo, readFocus, writeFocus, syncTodoRounds, todayKey,
} = require('./store')
const { appendSession, pruneFocus } = require('./focus')
const { FOCUS_KEEP_DAYS, TODO_MAX, TODO_TEXT_MAX } = require('./constants')
const { notifyTimer } = require('./notify')
// 到点扫描的共用装配（与 services.js 的主窗表共用同一个去抖实例）。
// 本模块只被它引用，绝不反向 require ipc.js，无环。
const { runRemindTick } = require('./remind-tick')
// dsh 一族（dsh / dsh-market / dsh-export / dsh-backup / dsh-usage / ...）合计 300KB+。
// 顶层 require 会把它压进每次 preload 加载的求值阶段（本模块在启动路径上必加载），
// 而这里对 dsh 的引用全在运行时（菜单操作、状态广播），没有一处是模块求值期。
// 改成惰性：首次访问 dsh.xxx 时才 require，之后复用同一份。
let dshMod = null
function dshOf() {
  if (!dshMod) dshMod = require('./dsh')
  return dshMod
}
const dsh = new Proxy({}, {
  get(_t, key) { return dshOf()[key] },
})
const {
  pushInit, sendToWidget, applyScaleToWindow, applyOnTop, pushConfig, pushTodo, pushFocusStats,
  winAlive, getWindow, queueLiveScale, widgetOrigin,
  widgetSide, spaceAround, usableArea, snapRect, flippedOf, setWidgetPos,
  syncTaskbarWatch, destroyWidget, ensureWindowStyles, applyIgnoreMouse, show,
  beginDragSession, endDragSession, dragMoveTo, setPageHidden,
} = require('./widget')
// 共享角色图池的**单张**本体（randimg 段抽到才要，见 whale:randimg）。
// 顶层 require 不额外付代价：widget.js 已经在启动路径上把 skins.js 加载好了。
const { getSharedImage } = require('./skins')
// 挂件菜单改配置后，通知已打开的设置窗口同步刷新开关（详见 settings.js 的 onConfigChange）。
// settings.js(153KB) 连带其依赖树只在「设置窗开着」时才有订阅者；顶层 require 会把这一整片
// 压进启动求值阶段（本模块在启动路径上必加载）—— 这正好绕过了 services.js 里对它的惰性挂载。
// 这里只在真正要广播时才 require（emitConfigChange 只有 3 处调用，全在函数体内）。
function emitConfigChange() {
  try {
    require('./settings').emitConfigChange()
  } catch (err) { logErr('[whale][ipc] 通知设置窗刷新失败', err && err.message) }
}
// 待办 / 专注统计变更回推设置页。与 emitConfigChange 同款惰性 require：
// 设置窗没开时订阅者为空，emit 内部第一行就返回（这里仍会付一次 require 代价，
// 但 settings 若已因打开设置窗加载过则直接复用，且这两个事件只在用户操作时触发）。
function emitTodoChange() {
  try {
    require('./settings').emitTodoChange()
  } catch (err) { logErr('[whale][ipc] 通知设置窗刷新待办失败', err && err.message) }
}
function emitFocusChange() {
  try {
    require('./settings').emitFocusChange()
  } catch (err) { logErr('[whale][ipc] 通知设置窗刷新专注统计失败', err && err.message) }
}

// 把某个 scale 目标值落库 + 改窗口 + 全量广播。
// 用途：拖拽期间被冻结的实时缩放请求，在 drag-end 后补做一次。
// 复用 whale:config 的持久化分支，保证「写存储 / 改窗口尺寸 / 推页面 / 回推设置页」四件事
// 与用户手动拖滑块完全一致 —— 只调 applyScaleToWindow 会漏掉存储与广播，
// 那就又回到「窗口变大了、大小描述却不变」的老问题。
function syncScaleFromConfig(scale) {
  const prev = readConfig()
  let cfg
  try {
    cfg = patchConfig({ scale: scale })
  } catch (err) {
    logErr('[whale][ipc] 补做拖拽期缩放：保存失败', err && err.message)
    return
  }
  if (cfg.scale !== prev.scale) applyScaleToWindow(cfg.scale, true)
  pushConfig()
  emitConfigChange()
}

// ──────────────────────────────────────────────
// 挂件快捷指令队列
// ──────────────────────────────────────────────
// feature 快捷指令（计时器切换 / 专注统计 / 刷新余额）必须等页面 `whale:ready` 后才能送达。
// **不能只看 winAlive()**：ensureWidget 刚建窗时窗口对象已存在，但页面 preload 还没就绪，
// 这时发过去没人监听，指令会被静默丢掉（实测：第一次按快捷键经常「没反应」）。
// 故用「页面就绪」标志 + 待发队列，ready 时统一补发。
let widgetPageReady = false
let pendingWidgetCmds = []
function sendWidgetCmd(cmd, payload) {
  const msg = { cmd: cmd, payload: payload }
  if (winAlive() && widgetPageReady) {
    try { sendToWidget('whale:cmd', msg) } catch (err) {
      logErr('[whale][cmd] 发送失败', err && err.message)
    }
    return
  }
  // 页面未就绪：按指令名去重（同一指令连按多次只留最后一次，避免就绪后连播一串历史操作）
  pendingWidgetCmds = pendingWidgetCmds.filter((m) => m.cmd !== cmd)
  pendingWidgetCmds.push(msg)
  if (pendingWidgetCmds.length > 8) pendingWidgetCmds.shift()
}
function flushPendingWidgetCmds() {
  if (!pendingWidgetCmds.length) return
  const list = pendingWidgetCmds
  pendingWidgetCmds = []
  for (const msg of list) {
    try { sendToWidget('whale:cmd', msg) } catch (err) {
      logErr('[whale][cmd] 补发失败', err && err.message)
    }
  }
}

// 「页面已请求显示过」去重标志。声明在模块级而非 registerIpc 闭包内：窗口销毁重建后
// 页面会重新 do-init 并再发一次 whale:show，闭包里的标志无人复位，重复请求会被 if 挡掉，
// 挂件只能等满 WIDGET_AUTOSHOW_MS(3s) 兜底才显示。destroyWidget() 复位它（见 widget.js）。
// 同时复位就绪标志与待发指令：窗口都没了，旧指令补发到新窗口只会造成「意外的自动操作」。
let widgetShown = false
function resetWidgetShown() {
  widgetShown = false
  widgetPageReady = false
  pendingWidgetCmds = []
}

function registerIpc() {
  // dsh 异步状态变更（3080 就绪 / 进程退出 / 安装或版本查询完成 …）主动推给挂件：
  // 挂件菜单不像设置页那样每 4s 轮询，只在点击操作时收一次回复，没有这路广播就会
  // 一直停在「启动中…（3080 未就绪）」「正在结束…」，要点一下「打开页面」触发快照才刷新
  try {
    dsh.onChange((s) => {
      // sendToWidget 内部已对「窗口不存在」留痕，这里能捕获到的是它的意外异常
      try { sendToWidget('whale:dsh', s) } catch (err) { logErr('[whale][ipc] 推送 dsh 状态失败', err && err.message) }
    })
  } catch (err) { logErr('[whale][ipc] 订阅 dsh 状态失败', err && err.message) }

  ipcRenderer.on('whale:ready', () => {
    log('[whale][widget] 收到 whale:ready（子窗已就绪）')
    widgetPageReady = true
    pushInit()
    getBalance().then((payload) => {
      sendToWidget('whale:balance', payload)
    })
    // 补发 feature 快捷指令（可能在页面就绪前就已入队）
    flushPendingWidgetCmds()
    // 专注记录自动清理：移除超过保留天数的条目，减少存储膨胀。
    // 天表与会话明细都要看：只比天表的话，明细超窗而天表没变时永远不会落盘清理
    try {
      const before = readFocus()
      const after = pruneFocus(before, todayKey(), FOCUS_KEEP_DAYS)
      const beforeKeys = Object.keys(before.days || {}).length
      const afterKeys = Object.keys(after.days || {}).length
      const beforeSessions = (before.sessions || []).length
      const afterSessions = (after.sessions || []).length
      if (afterKeys < beforeKeys || afterSessions < beforeSessions) {
        writeFocus(after)
        log('[whale][focus] 自动清理：' + beforeKeys + ' → ' + afterKeys + ' 天、'
          + beforeSessions + ' → ' + afterSessions + ' 条记录')
      }
      // 待办轮数按明细自愈一次：老版本是「完成一轮 +1」的独立计数器，
      // 裁剪掉明细或上一版写漏时会对不上，开机校正比让用户看到错数字好
      if (syncTodoRounds()) { pushTodo(); emitTodoChange() }
    } catch (err) { logErr('[whale][focus] 开机自愈（裁剪 / 待办轮数）失败', err && err.message) }
  })

  // 页面把配置落地后请求显示窗口（窗口以 show:false 创建，防首帧露出随包内置形象）。
  // 页面 do-init 只会调一次；这里再挡一道重复，避免多开时反复置顶抢焦点
  ipcRenderer.on('whale:show', () => {
    if (widgetShown) return
    widgetShown = true
    try { show() } catch (err) { logErr('[whale][ipc] 显示挂件失败', err && err.message) }
  })

  ipcRenderer.on('whale:refresh', (event, data) => {
    const manual = !!(data && data.manual)
    getBalance(manual).then((payload) => {
      sendToWidget('whale:balance', payload)
    })
  })

  // 多厂商模型：挂件菜单打开时懒加载 / 点「刷新」时强制拉取。
  // 先推一次现有快照，菜单立刻能显示上次结果，不用等网络回来；
  // 刷新流程收尾（成功或失败）再推一次并带 refreshDone —— 挂件菜单「刷新全部」按钮靠它收尾，
  // 用定时器猜网络耗时不是提前解锁（慢了能连点）就是残留「刷新中…」
  ipcRenderer.on('whale:models-refresh', (event, data) => {
    const ids = data && Array.isArray(data.ids) && data.ids.length ? data.ids : null
    const force = !!(data && data.force)
    const push = (done) => {
      try {
        const payload = getModelsPayload()
        if (done) payload.refreshDone = true
        sendToWidget('whale:models', payload)
      } catch (err) { logErr('[whale][ipc] 推送模型快照失败', err && err.message) }
    }
    push(false)
    refreshModels(ids, force).then(() => push(true)).catch((err) => {
      logErr('[whale][ipc] 刷新模型余额失败', err && err.message)
      push(true) // 失败也要收尾，否则挂件按钮会一直停在「刷新中…」
    })
  })

  // 挂件菜单切换主显示模型（id 非法/不存在时 patchConfig 会回退内置 DeepSeek）
  ipcRenderer.on('whale:set-main-model', (event, data) => {
    try {
      patchConfig({ mainModelId: String((data && data.id) || '') })
      sendToWidget('whale:models', getModelsPayload())
      // 反向同步设置页的「主显示」单选，否则两处显示会不一致
      emitConfigChange()
    } catch (err) { logErr('[whale][ipc] 切换主显示模型失败', err && err.message) }
  })

  ipcRenderer.on('whale:config', (event, patch) => {
    if (patch && patch.__live) {
      queueLiveScale(patch.scale)
      // 透明度实时预览：不能用 win.setOpacity（transparent 窗口会整窗消失），
      // 只把数值推给挂件页面走 CSS opacity；不写存储、不回推设置页
      if (patch.opacity !== undefined) sendToWidget('whale:config', { opacity: patch.opacity })
      return
    }
    const prev = readConfig()
    // patchConfig 写失败会抛（见 store.js）—— 这个 handler 里除了赋值还有一串副作用
    // （改窗口尺寸 / 置顶 / 清计时 / 广播），全在 catch 外，所以必须自己兜住：
    // 抛出去会变成 Electron 事件回调里的未捕获异常，挂件侧看不到任何反馈
    let cfg
    try {
      cfg = patchConfig(patch)
    } catch (err) {
      logErr('[whale][ipc] 保存配置失败', err && err.message)
      return
    }
    // 关掉「计时保存」时顺手清掉已落库的计时状态
    if (cfg.timerPersistOn === false && prev.timerPersistOn !== false) clearTimer()
    if (cfg.scale !== prev.scale) applyScaleToWindow(cfg.scale, true)
    if (cfg.onTop !== prev.onTop) applyOnTop(cfg.onTop)
    if (cfg.avoidTaskbar !== prev.avoidTaskbar) syncTaskbarWatch()
    // opacity/passThrough 随 pushConfig 全量广播，由挂件页面以 CSS/命中测试消费
    pushConfig()
    // 反向同步：把新配置广播给主窗（设置页），否则设置窗口的开关仍是旧值
    emitConfigChange()
  })

  // 拖拽开始：立刻冻结缩放（含页面侧实时缩放请求），并作废拖拽期几何缓存。
  // 只靠 drag-move 首次到达才冻结是不够的 —— 页面 pointerdown 到第一次 move 之间
  // 若来一次滚轮/实时缩放，窗口尺寸仍会先被改掉。
  ipcRenderer.on('whale:drag-begin', () => {
    if (!winAlive()) return
    beginDragSession()
  })

  // 拖拽位置：页面已用 rAF 节流到「每帧最多一发」，宿主直接同步 setPosition。
  // 不要再加自驱循环或逐帧回执背压 —— 试过宿主 setTimeout 自驱（~120Hz）与「发一帧等 ack」
  // 两种方案，都会和页面的 rAF 形成第二条节奏源 / 把吞吐锁死在往返延迟上，实测更卡。
  ipcRenderer.on('whale:drag-move', (event, data) => {
    if (!winAlive() || !data) return
    dragMoveTo(data.x, data.y)
  })

  ipcRenderer.on('whale:drag-end', (event, data) => {
    if (!winAlive()) return
    const w = getWindow()
    // 先解冻（endDragSession 返回拖拽期间被冻结的最后一个缩放目标）
    const pendingScale = endDragSession()
    try {
      const pos = w.getPosition()
      const sz = w.getSize()
      const width = sz[0]
      const x = data && isFinite(Number(data.x)) ? Number(data.x) : pos[0]
      const y = data && isFinite(Number(data.y)) ? Number(data.y) : pos[1]
      const s = widgetSide(width)
      const wgt = widgetOrigin(x, y)
      const wa = usableArea(wgt.x + s / 2, wgt.y + s / 2)
      const r = snapRect(wa, x, y, width)
      setWidgetPos(r)
      writeAnchor(r.anchor)
      sendToWidget('whale:snapped', {
        hAnchor: r.anchor.hAnchor,
        vAnchor: r.anchor.vAnchor,
        flipped: flippedOf(r.anchor),
        // 吸附后重算上下空白：页面据此决定菜单往上还是往下展开
        space: spaceAround(wa, r.x, r.y, width),
      })
    } catch (err) {
      // 拖拽中吸附/写 anchor/推送都在这段：任一步失败会表现为「松手后位置没对齐且不落库」。
      // 拖拽期每帧都可能触发，靠 log.js 的 5s 同键去重折叠，不会刷屏。
      logErr('[whale][drag] 拖拽吸附处理失败', err && err.message)
    }
    // 拖拽中来的缩放请求：按吸附后的新位置把尺寸补做一次并持久化
    // （applyScaleToWindow 会以窗口真实状态重算不动点，所以不会跳位）。
    // 必须排在吸附之后：补做缩放会写 anchor、推配置，顺序颠倒会把吸附结果覆盖掉。
    // ⚠️ 不拿「记录值 ≠ 存储当前值」当判据：拖拽期进来的可能是 persist=true 的已落库请求
    //    （设置页滑块 / whale:config 广播），存储里那时已经是新值，用这个条件会把该补的缩放挡掉、
    //    窗口尺寸永远跟不上存储（用户拖完发现大小没变，而设置页显示的是新值）。
    //    这里记的就是拖拽期最后一个目标值，直接让它当最终值。
    //    syncScaleFromConfig 内部已判 `cfg.scale !== prev.scale`，值本就一致时不会白改尺寸。
    if (pendingScale != null && isFinite(pendingScale)) {
      try { syncScaleFromConfig(pendingScale) } catch (err) {
        logErr('[whale][drag] 补做拖拽期缩放失败', err && err.message)
      }
    }
  })

  // 页面可见态：子窗 preload 在 visibilitychange / pageshow / pagehide 时上报 document.hidden。
  // 宿主的任务栏轮询据此在挂件不可见（最小化 / 显示桌面 / 切虚拟桌面 / 被连带 hide）时跳过光标采样。
  // 原生 isVisible() / isMinimized() 只覆盖窗口自身显隐，页面级不可见由这条补齐。
  ipcRenderer.on('whale:widget-visibility', (event, data) => {
    setPageHidden(!!(data && data.hidden))
  })

  // 到点扫描的第二路驱动：挂件窗可见、不被 Chromium 后台节流，每 30s 补一拍。
  // 主窗（设置窗）被隐藏后它自己的 30s 表会被节流成 60s（真机日志实测），这条路用来补洞；
  // 挂件没建 / 已销毁 / 被隐藏时页面不发这条，自动回落到主窗兜底表。
  // 只认当前挂件窗口：重载 / 重建期间旧页面可能还在，它的上报不能叠加成双倍节奏。
  // 老 Electron 没有 event.senderId 时不拦，交给 remind-tick 的 20s 去抖兜底。
  ipcRenderer.on('whale:remind-tick', (event) => {
    if (!winAlive()) return
    try {
      const cur = getWindow()
      const sid = event && event.senderId
      if (cur && cur.webContents && sid && cur.webContents.id !== sid) return
    } catch (err) {}
    runRemindTick(sendWidgetCmd, 'widget')
  })

  // 光标探测：页面启动 / 挂件重建后问一次「指针现在在哪」。
  // 挂件窗口平时是 ignoreMouse（平时不挡下层应用），靠 pointermove 建立悬停才临时接管；
  // 但指针若本来就停在鲸鱼上（页面刚重建、挂件刚被拖到光标下），没有 pointermove，
  // 悬停永远建立不起来 —— 用户看到挂件就在手边，点一下却没反应（点击穿透到下层应用）。
  // 回包坐标是相对窗口左上角的 CSS 像素（窗口无边框，bounds 即内容区），页面用它补一次命中测试。
  ipcRenderer.on('whale:probe-cursor', () => {
    if (!winAlive()) return
    let p = null
    try { p = utools.getCursorScreenPoint() } catch (err) {}
    if (!p || !isFinite(p.x) || !isFinite(p.y)) { sendToWidget('whale:cursor', null); return }
    try {
      const b = getWindow().getBounds()
      sendToWidget('whale:cursor', { x: Math.round(p.x - b.x), y: Math.round(p.y - b.y) })
    } catch (err) {
      logErr('[whale][cursor] 光标探测失败', err && err.message)
    }
  })

  // 共享角色图池的单张取图：页面抽到 randimg 段时按 id 来要那一张本体。
  // 池子本体不再整池推给子窗（真机 39MB 原图 / 52MB base64，读盘 + 编码 + 跨进程克隆
  // 全压在「打开挂件」那一下，两个进程还各常驻一份）；init 只推清单，这里按需搬单张。
  // 无论取得到与否都回一条：页面记着「在途」，收不到回包就一直不敢再要同一张。
  // id 的字符集与「是不是官方图」都在 skins.getSharedImage 里判（子窗传来的值一律当外部输入）。
  ipcRenderer.on('whale:randimg', (event, data) => {
    if (!winAlive()) return
    const id = data && typeof data.id === 'string' ? data.id : ''
    let url = ''
    try { url = getSharedImage(id) } catch (err) { logErr('[whale][randimg] 取单张形象失败', err && err.message) }
    try { sendToWidget('whale:randimg-data', { id: id, url: url }) } catch (err) {
      logErr('[whale][randimg] 回包失败', err && err.message)
    }
  })

  // 穿透开关：交给 widget.js 的 applyIgnoreMouse（那里按值去重，且下发完会重申窗口样式
  // —— setIgnoreMouseEvents 本身就是会让 Windows 重新登记样式的那类调用之一，
  // 置顶位和任务栏位就是在这一步掉的）。
  ipcRenderer.on('whale:ignore-mouse', (event, data) => {
    applyIgnoreMouse(!!(data && data.ignore))
  })

  // 挂件菜单里要打字（留言、时长、定时）：窗口是以 focusable:false 建的，
  // 这类窗口在 Electron 里根本不接收键盘事件（点得进输入框却打不出字），
  // 光调 w.focus() 没用。focusable 虽说是创建期选项，但 Electron 的 setFocusable()
  // 可以在运行时改，所以打开菜单时置 true 并夺焦，关闭时置回 false 把焦点让出去。
  //
  // 注意：切 focusable 会让 Windows 重新登记窗口样式，创建期靠 focusable:false「隐含」
  // 的任务栏隐藏随之失效 —— 表现为打开菜单后挂件出现在任务栏（悬停可见缩略图）。
  // 故两个分支都要在切换后重新声明 skipTaskbar。
  //
  // 兜底顺序：setFocusable(true) → focus()（w.focus 不可用/抛错时退到 utools 侧）。
  // 关菜单时：setFocusable(false) 之后必须显式唤回 uTools 主窗，否则「设置窗」会
  // 因为刚被挂件抢过焦点而失焦，按 uTools 原生行为自动隐藏 —— 看起来就是设置窗莫名消失。
  ipcRenderer.on('whale:input-focus', (event, data) => {
    if (!winAlive()) return
    const w = getWindow()
    const want = !!(data && data.focus)
    try {
      if (want) {
        if (typeof w.setFocusable === 'function') w.setFocusable(true)
        // 置为可聚焦后还要主动取一次焦点，否则输入光标不会落到菜单输入框上
        try { w.focus() } catch (err) {}
      } else {
        try { w.blur() } catch (err) {}
        if (typeof w.setFocusable === 'function') w.setFocusable(false)
        // 交还焦点：唤回 uTools 主窗（设置页），避免它因失焦被自动隐藏
        try {
          if (typeof utools !== 'undefined' && utools && typeof utools.showMainWindow === 'function') {
            utools.showMainWindow()
          }
        } catch (err) {}
      }
      ensureWindowStyles()
      // 留痕：这条路径是「挂件冒进任务栏」和「置顶莫名失效」的共同主因（切 focusable 会让
      // Windows 重登记窗口样式，两个位一起掉），出问题时靠它判断走没走到、
      // 以及 setSkipTaskbar 到底可不可用（不可用时说明得换不切 focusable 的方案）
      log('[whale][ipc] 菜单输入焦点', want ? '借出' : '交还', '窗口样式已重申（置顶 + 任务栏）')
    } catch (err) {
      logErr('[whale][ipc] 切换输入焦点失败', err && err.message)
    }
  })

  // 挂件菜单请求唤出主窗（设置页）：「显示挂件」模式下唯一入口。
  // 可带 target（如 'appearance'）—— 菜单按钮用它直达对应卡片；无 target 时只唤窗落默认 Tab。
  // redirect 分支（主窗不存在）时页面全新加载，target 无法投递，落默认 Tab（与无载荷时一致）。
  ipcRenderer.on('whale:open-settings', (event, data) => {
    const target = (data && typeof data.target === 'string') ? data.target : ''
    // 1) 主窗还在（如 both/settings 模式，或设置窗已分离）→ 直接唤回并把导航指令投给设置页
    let shown = false
    try { shown = !!utools.showMainWindow() } catch (err) { logErr('[whale][ipc] 显示主窗失败', err && err.message) }
    if (shown) {
      // 窗口已存在的同步路径：先等一帧让设置页排到队列末尾，避免「唤回」与「切 Tab」在同一拍被后来的重渲染覆盖
      if (target) setTimeout(() => { try { require('./settings').emitNavigate(target) } catch (err) { logErr('[whale][ipc] 投递导航失败', err && err.message) } }, 0)
      return
    }
    // 2) 主窗不存在（如「显示挂件」模式下挂件夺焦，uTools 已把插件收到后台）：
    //    showMainWindow 唤不回主窗，必须 redirect 重新「进入插件」（'余额挂件' 是 whale 的指令别名），
    //    由 onPluginEnter 的 redirect 分支显式 showMainWindow（重定向已让插件重新激活）。
    try { utools.redirect('余额挂件', '') } catch (err) { logErr('[whale][ipc] 跳转设置功能失败', err && err.message) }
  })

  // 台词链接段点击：只认 http(s) —— file:/javascript: 等一律拒掉（shellOpenExternal 可执行任意协议 URL）
  ipcRenderer.on('whale:open-external', (event, data) => {
    const url = String(data && data.url || '').trim()
    if (!/^https?:\/\//i.test(url)) { logErr('[whale][ipc] 拒绝打开非 http(s) 链接', url.slice(0, 80)); return }
    try { utools.shellOpenExternal(url) } catch (err) { logErr('[whale][ipc] 打开外部链接失败', err && err.message) }
  })

  // 挂件菜单请求隐藏挂件：直接销毁窗口（与设置页「隐藏挂件」同一路径），
  // 下次显示时重建，保证加载的是最新的悬浮窗页面
  ipcRenderer.on('whale:hide-widget', () => {
    try { destroyWidget() } catch (err) { logErr('[whale][ipc] 隐藏挂件失败', err && err.message) }
  })

  // 计时状态落库（页面在开始/停止/到点时上报；state 为 null 表示清除）
  ipcRenderer.on('whale:timer', (event, state) => {
    if (!state || typeof state !== 'object') { clearTimer(); return }
    writeTimer({
      mode: state.mode === 'up' || state.mode === 'down' || state.mode === 'at' ? state.mode : 'off',
      running: state.running === true,
      paused: state.paused === true,
      startAt: Number(state.startAt) || 0,
      endAt: Number(state.endAt) || 0,
      elapsed: Math.max(0, Number(state.elapsed) || 0),
      remain: Math.max(0, Number(state.remain) || 0),
      arg: typeof state.arg === 'string' ? state.arg : '',
      // 休息轮与番茄循环状态：必须一起存，否则重载后专注/休息判断会错乱
      isBreak: state.isBreak === true,
      back: isFinite(Number(state.back)) ? Math.max(0, Number(state.back)) : 0,
      cycle: isFinite(Number(state.cycle)) ? Math.max(0, Math.round(Number(state.cycle))) : 0,
      cycleDate: typeof state.cycleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.cycleDate) ? state.cycleDate : '',
      // 「定时」模式的总跨度（毫秒）：环形进度条算比例要用，暂停/恢复后也不能丢
      span: isFinite(Number(state.span)) ? Math.max(0, Math.round(Number(state.span))) : 0,
    })
  })

  // 计时到点通知：页面把这一轮的 timerNotifyOn / timerMailOn 一起带上来，
  // 宿主再叠渠道总开关（notifySystemOn / notifyMailOn）—— 漏判任一层都会让
  // 「计时到点系统通知」这个开关形同虚设。
  ipcRenderer.on('whale:timer-done', (event, data) => {
    const text = String((data && data.text) || '').slice(0, 200)
    if (!text) return
    notifyTimer(text, readConfig(), data && data.channels)
  })

  // 待办轻操作：挂件页只有「勾选完成 / 设为当前专注 / 取消专注」三种（编辑一律在设置页做）。
  // 与 whale:todo 的下行推送同名不同向：这里是子→父，父处理完再 pushTodo 回推权威状态。
  // 操作被拒（条目已不存在 / 清单已满 / 写失败）时也要回推一次：挂件已经按乐观状态重画，
  // 静默 return 会让它停在错误状态上，直到下一次无关操作把它顶掉。
  ipcRenderer.on('whale:todo', (event, data) => {
    const op = String((data && data.op) || '')
    const id = String((data && data.id) || '')
    const resync = () => { pushTodo(); emitTodoChange() }
    if (op !== 'add' && op !== 'clearDone' && op !== 'toggle' && op !== 'focus' && op !== 'unfocus') return
    // add / clearDone 不需要 id，其余操作必须有
    if (op !== 'add' && op !== 'clearDone' && !id) { resync(); return }
    const st = readTodo()
    if (op === 'add') {
      const text = String((data && data.text) || '').replace(/\s+/g, ' ').trim().slice(0, TODO_TEXT_MAX)
      if (!text || st.items.length >= TODO_MAX) { resync(); return }
      const seen = new Set(st.items.map((x) => x.id))
      let newId
      do { newId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) } while (seen.has(newId))
      st.items.unshift({ id: newId, text: text, done: false, at: Date.now(), doneAt: 0 })
    } else if (op === 'clearDone') {
      // 清除所有已完成的待办项
      st.items = st.items.filter((x) => !x.done)
      // 如果当前专注目标已被清除，清空专注目标
      if (st.focusId && !st.items.find((x) => x.id === st.focusId)) {
        st.focusId = ''
      }
    } else {
      const it = st.items.find((x) => x.id === id)
      if (!it) { resync(); return }
      if (op === 'toggle') {
        it.done = !it.done
        it.doneAt = it.done ? Date.now() : 0
        // 勾完当前专注的那条：专注目标跟着清空，免得挂件一直显示「已完成的任务」
        if (it.done && st.focusId === id) st.focusId = ''
      } else if (op === 'focus') {
        if (it.done) { resync(); return } // 已完成的不给设为专注目标
        // 明确「设为」，不是开关：取消有独立的 unfocus，重复点击不该把目标点没
        st.focusId = id
      } else if (st.focusId === id) {
        st.focusId = ''
      }
    }
    if (!writeTodo(st)) { resync(); return }
    resync()
  })

  // 到点气泡回执：页面把气泡真正挂出来之后才回这条。
  // 两套幂等位里，notifiedFor（系统通知/邮件）由扫描侧按送达情况自己写；这里只写
  // remindedFor（气泡已展示）。气泡被计时气泡占位 / 被拦时页面回 shown=false，宿主不记账，
  // 下一个 tick 会继续补弹 —— 这就是「通知发过了不重发、气泡没弹出来继续补」的实现。
  // 气泡一旦展示，本轮就算完成：通知位也一并前进，避免免打扰结束后再补发一条迟到通知。
  // debug=true 是设置页调试入口触发的，纯投递演练，不许污染真实幂等位。
  ipcRenderer.on('whale:todo-due-ack', (event, data) => {
    const d = data && typeof data === 'object' ? data : {}
    if (d.shown !== true) return
    if (d.debug === true) return
    const id = String(d.id || '')
    const dueAt = Math.round(Number(d.dueAt)) || 0
    if (!id || !dueAt) return
    try {
      const st = readTodo()
      const it = st.items.find((x) => x.id === id)
      if (!it) return
      // 只前进不后退：这一轮可能已被系统通知写掉，或回执迟到（对应上一轮），都不能把幂等位往回拨
      if (dueAt <= (Math.round(Number(it.remindedFor)) || 0)) return
      it.remindedFor = dueAt
      if (dueAt > (Math.round(Number(it.notifiedFor)) || 0)) it.notifiedFor = dueAt
      writeTodo(st)
    } catch (err) { logErr('[whale][remind] 气泡回执写幂等位失败', err && err.message) }
  })

  // 专注会话上报（页面在计时到点 / 正计时结束 / 中途放弃时调用；不搭 whale:timer-done 的车 ——
  // 那条被通知开关门控，用户关了通知就统计不到，而统计与提醒是两件独立的事）
  // payload = { mode, startAt, endAt, minutes, isBreak, abandoned }
  // 页面只报「这段投入是多长、怎么计的、走完还是放弃」；什么算一轮由 focus.isRound 判，
  // 天表由会话派生 —— 这样挂件、设置页、待办上的轮数迟早都只会有一本账。
  ipcRenderer.on('whale:focus', (event, data) => {
    const input = data && typeof data === 'object' ? data : {}
    const key = todayKey()
    // 先读待办快照再记账：本轮完成时挂的是哪条任务，要与会话明细一起落库。
    // 不能只存 todoId 之后反查 —— 任务改名/删除后，历史记录就只剩一个看不懂的 id
    const todoState = readTodo()
    const focusItem = todoState.focusId
      ? todoState.items.find((x) => x.id === todoState.focusId)
      : null
    const prev = readFocus()
    const appended = appendSession(prev, {
      // 没给结束时刻就按「现在」算：归属日由结束那一刻决定（跨零点的轮次记在结束那天）
      endAt: Number(input.endAt) > 0 ? Number(input.endAt) : Date.now(),
      startAt: Number(input.startAt),
      minutes: Number(input.minutes),
      mode: input.mode,
      isBreak: input.isBreak === true,
      abandoned: input.abandoned === true,
      todoId: focusItem && focusItem.id,
      todoText: focusItem && focusItem.text,
    })
    const next = pruneFocus(appended, key, FOCUS_KEEP_DAYS)
    if (!writeFocus(next)) return
    // 待办的「N 轮」按会话回填（不再自己 +1）：写失败不假报，
    // 不推 Todo / 不通知设置页，用户看到的是「轮次没加」而不是幽灵更新
    if (syncTodoRounds()) { pushTodo(); emitTodoChange() }
    // 每日目标达成提醒：只在「今日轮数首次达到目标」时弹一次（notifyDaily 去重）
    const cfg = readConfig()
    const goal = cfg.focusGoal || 0
    if (goal > 0) {
      const roundsOf = (st) => {
        const e = st.days && st.days[key]
        return e ? Math.max(0, Math.round(Number(e.r) || 0)) : 0
      }
      const todayRounds = roundsOf(next)
      // 从「未达成」跨入「已达成」的那一刻才提醒：避免重复弹窗
      if (roundsOf(prev) < goal && todayRounds >= goal) {
        notifyDaily(`今日专注目标已达成！完成 ${todayRounds} 轮`, cfg, 'goal')
      }
    }
    emitFocusChange()
    pushFocusStats()
  })

  // 悬浮页把自身错误转交宿主落盘：页面侧的 logErr 只能打 console，
  // 打包版没有 DevTools 时用户无从取证，故经此通道写进 %TEMP%\whale-debug.log
  ipcRenderer.on('whale:page-log', (event, data) => {
    const msg = String((data && data.msg) || '').slice(0, 500)
    if (!msg) return
    const detail = String((data && data.detail) || '').slice(0, 500)
    logErr('[whale][page]', msg, detail || '')
  })

  // DeepSeek Harness（dsh）控制：挂件菜单 → 宿主执行 → 回推状态快照。
  // 每次先探测 3080（识别「别的终端里跑的 dsh」），再执行/回报状态
  ipcRenderer.on('whale:dsh', (event, data) => {
    const action = String((data && data.action) || 'status')
    // 此处失败不必留痕：act() 的 catch 已 logErr「dsh 操作失败」再走 reply 上报，
    // 这里再加一条只会把同一次失败记两遍
    const reply = (payload) => { try { sendToWidget('whale:dsh', payload) } catch (err) {} }
    const act = () => {
      try {
        if (action === 'start') reply(dsh.start())
        else if (action === 'stop') dsh.stop((s) => reply(s || dsh.snapshot()))
        else if (action === 'restart') dsh.restart((s) => reply(s || dsh.snapshot()))
        else if (action === 'update') reply(dsh.update())
        else if (action === 'versions') reply(dsh.listVersions())
        else if (action === 'open') { dsh.openWeb(); reply(dsh.snapshot()) }
        else reply(dsh.snapshot())
      } catch (err) {
        logErr('[whale][ipc] dsh 操作失败', action, err && err.message)
        reply(Object.assign(dsh.snapshot(), { error: errMsg(err) }))
      }
    }
    try {
      dsh.probePort(() => act())
    } catch (err) { act() }
  })
}

module.exports = { registerIpc, resetWidgetShown, sendWidgetCmd }
