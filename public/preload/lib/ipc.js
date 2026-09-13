/*
 * IPC 路由：悬浮窗 → 宿主（CommonJS）。
 */
const { ipcRenderer } = require('electron')
const { WIN_PAD } = require('./constants')
const { log, logErr } = require('./log')
const { getBalance } = require('./api')
const { readConfig, patchConfig, writeAnchor, writeTimer, clearTimer } = require('./store')
const dsh = require('./dsh')
const {
  pushInit, sendToWidget, applyScaleToWindow, applyOnTop, pushConfig,
  winAlive, getWindow, clearLiveScaleCtx, queueLiveScale, widgetOrigin,
  winOrigin, clampWidget, usableArea, snapRect, flippedOf, syncTaskbarWatch,
} = require('./widget')
// 挂件菜单改配置后，通知已打开的设置窗口同步刷新开关（详见 settings.js 的 onConfigChange）
const { emitConfigChange } = require('./settings')

function registerIpc() {
  // dsh 异步状态变更（3080 就绪 / 进程退出 / 安装或版本查询完成 …）主动推给挂件：
  // 挂件菜单不像设置页那样每 4s 轮询，只在点击操作时收一次回复，没有这路广播就会
  // 一直停在「启动中…（3080 未就绪）」「正在结束…」，要点一下「打开页面」触发快照才刷新
  try {
    dsh.onChange((s) => {
      try { sendToWidget('whale:dsh', s) } catch (err) {}
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

  ipcRenderer.on('whale:config', (event, patch) => {
    if (patch && patch.__live) {
      queueLiveScale(patch.scale)
      // 透明度实时预览：不能用 win.setOpacity（transparent 窗口会整窗消失），
      // 只把数值推给挂件页面走 CSS opacity；不写存储、不回推设置页
      if (patch.opacity !== undefined) sendToWidget('whale:config', { opacity: patch.opacity })
      return
    }
    const prev = readConfig()
    const cfg = patchConfig(patch)
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
      const s = winS - WIN_PAD // 挂件本体边长
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
      const width = sz[0], height = sz[1]
      const x = data && isFinite(Number(data.x)) ? Number(data.x) : pos[0]
      const y = data && isFinite(Number(data.y)) ? Number(data.y) : pos[1]
      const s = width - WIN_PAD
      const wgt = widgetOrigin(x, y)
      const wa = usableArea(wgt.x + s / 2, wgt.y + s / 2)
      const r = snapRect(wa, x, y, width, height)
      w.setPosition(Math.round(r.x), Math.round(r.y))
      writeAnchor(r.anchor)
      sendToWidget('whale:snapped', {
        hAnchor: r.anchor.hAnchor,
        vAnchor: r.anchor.vAnchor,
        flipped: flippedOf(r.anchor),
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

  // 计时到点系统通知（页面对「到点通知」开关的判断在页面侧完成）
  ipcRenderer.on('whale:timer-done', (event, data) => {
    const text = String((data && data.text) || '').slice(0, 200)
    if (!text) return
    try { utools.showNotification(text, 'whale') } catch (err) { logErr('[whale][ipc] 计时通知失败', err && err.message) }
  })

  // DeepSeek Harness（dsh）控制：挂件菜单 → 宿主执行 → 回推状态快照。
  // 每次先探测 3080（识别「别的终端里跑的 dsh」），再执行/回报状态
  ipcRenderer.on('whale:dsh', (event, data) => {
    const action = String((data && data.action) || 'status')
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
