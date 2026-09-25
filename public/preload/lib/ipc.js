/*
 * IPC 路由：悬浮窗 → 宿主（CommonJS）。
 */
const { ipcRenderer } = require('electron')
const { log, logErr } = require('./log')
const { getBalance, refreshModels, getModelsPayload } = require('./api')
const { readConfig, patchConfig, writeAnchor, writeTimer, clearTimer } = require('./store')
const { notify } = require('./notify')
const dsh = require('./dsh')
const {
  pushInit, sendToWidget, applyScaleToWindow, applyOnTop, pushConfig,
  winAlive, getWindow, clearLiveScaleCtx, queueLiveScale, widgetOrigin,
  winOrigin, widgetSide, spaceAround, clampWidget, usableArea, snapRect, flippedOf,
  syncTaskbarWatch, destroyWidget, ensureSkipTaskbar,
} = require('./widget')
// 挂件菜单改配置后，通知已打开的设置窗口同步刷新开关（详见 settings.js 的 onConfigChange）
const { emitConfigChange } = require('./settings')

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

  ipcRenderer.on('whale:drag-move', (event, data) => {
    if (!winAlive() || !data) return
    const w = getWindow()
    clearLiveScaleCtx() // 拖拽改变窗口位置，实时缩放缓存失效
    try {
      const sz = w.getSize()
      const winS = sz[0]
      const s = widgetSide(winS) // 挂件本体边长
      const x = Number(data.x), y = Number(data.y) // 目标窗口左上角
      if (!isFinite(x) || !isFinite(y)) return
      const wgt = widgetOrigin(x, y) // 目标挂件左上角
      const wa = usableArea(wgt.x + s / 2, wgt.y + s / 2)
      // 限制「挂件本体」在工作区内；透明留白可越界，不影响
      const c = clampWidget(wa, wgt.x, wgt.y, s)
      const wp = winOrigin(c.x, c.y)
      w.setPosition(Math.round(wp.x), Math.round(wp.y))
    } catch (err) {}
  })

  ipcRenderer.on('whale:drag-end', (event, data) => {
    if (!winAlive()) return
    const w = getWindow()
    clearLiveScaleCtx() // 吸附会改变窗口位置，实时缩放缓存失效
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
      w.setPosition(Math.round(r.x), Math.round(r.y))
      writeAnchor(r.anchor)
      sendToWidget('whale:snapped', {
        hAnchor: r.anchor.hAnchor,
        vAnchor: r.anchor.vAnchor,
        flipped: flippedOf(r.anchor),
        // 吸附后重算上下空白：页面据此决定菜单往上还是往下展开
        space: spaceAround(wa, r.x, r.y, width),
      })
    } catch (err) {}
  })

  // 穿透开关状态缓存：值没变就不调 setIgnoreMouseEvents（鼠标在挂件上移动时
  // 页面会高频上报，重复调用纯属浪费）。缓存按窗口实例失效 —— 窗口重建后新窗口
  // 默认不穿透，必须重新下发一次。
  let ignoreMouseWin = null
  let ignoreMouseVal = null
  ipcRenderer.on('whale:ignore-mouse', (event, data) => {
    if (!winAlive()) { ignoreMouseWin = null; ignoreMouseVal = null; return }
    const w = getWindow()
    if (w !== ignoreMouseWin) { ignoreMouseWin = w; ignoreMouseVal = null }
    const ignore = !!(data && data.ignore)
    if (ignore === ignoreMouseVal) return
    ignoreMouseVal = ignore
    try {
      w.setIgnoreMouseEvents(ignore, { forward: true })
    } catch (err) { ignoreMouseVal = null }
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
      ensureSkipTaskbar()
      // 留痕：这条路径是「挂件冒进任务栏」的主因，出问题时靠它判断走没走到、
      // 以及 setSkipTaskbar 到底可不可用（不可用时说明得换不切 focusable 的方案）
      log('[whale][ipc] 菜单输入焦点', want ? '借出' : '交还', 'skipTaskbar 已重申')
    } catch (err) {
      logErr('[whale][ipc] 切换输入焦点失败', err && err.message)
    }
  })

  // 挂件菜单请求唤出主窗（设置页）：「显示挂件」模式下唯一入口
  ipcRenderer.on('whale:open-settings', () => {
    // 1) 主窗还在（如 both/settings 模式，或设置窗已分离）→ 直接唤回
    let shown = false
    try { shown = !!utools.showMainWindow() } catch (err) { logErr('[whale][ipc] 显示主窗失败', err && err.message) }
    if (shown) return
    // 2) 主窗不存在（如「显示挂件」模式下挂件夺焦，uTools 已把插件收到后台）：
    //    showMainWindow 唤不回主窗，必须 redirect 重新「进入插件」（'余额挂件' 是 whale 的指令别名），
    //    由 onPluginEnter 的 redirect 分支显式 showMainWindow（重定向已让插件重新激活）。
    try { utools.redirect('余额挂件', '') } catch (err) { logErr('[whale][ipc] 跳转设置功能失败', err && err.message) }
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
    })
  })

  // 计时到点通知（页面对「到点通知」开关的判断在页面侧完成，并已在 text 为空时停发）
  ipcRenderer.on('whale:timer-done', (event, data) => {
    const text = String((data && data.text) || '').slice(0, 200)
    if (!text) return
    notify(text, readConfig())
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
        reply(Object.assign(dsh.snapshot(), { error: String((err && err.message) || err) }))
      }
    }
    try {
      dsh.probePort(() => act())
    } catch (err) { act() }
  })
}

module.exports = { registerIpc }
