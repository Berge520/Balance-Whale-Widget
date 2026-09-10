/*
 * 悬浮窗窗口管理（CommonJS）：创建/销毁/几何/缩放/向子窗推送数据。
 */
const { MIN_SCALE, MAX_SCALE, BASE_MIN, BASE_CAP, BASE_MAX, WIN_PAD } = require('./constants')
const { log, logErr } = require('./log')
const { clampNum, readConfig, readAnchor, writeAnchor, defaultAnchor } = require('./store')
const { getCachedBalance } = require('./api')

let win = null
let winCreatedAt = 0 // 窗口创建时刻（ms），用于区分「刚创建尚未显示」与「被隐藏」
let winFocusable = false // 当前窗口的 focusable 设置（仅创建时可指定，切换需重建）

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
// 暴露当前窗口实例（供 IPC 层做几何读写；调用前先用 winAlive() 判断）
function getWindow() { return win }

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
  if (msg) logErr('[whale][widget]', msg)
  else log('[whale][widget] floating page loaded OK')
}
function getWidgetError() { return lastWidgetError || null }

// 确保挂件可见：
//  - 无存活窗口 → 创建
//  - 引用存活但窗口实际不可见 → 销毁重建。hideMainWindow() 会连带隐藏本插件用
//    createBrowserWindow 创建的窗口，且隐藏是异步的；若此时只调 show() 未必能恢复
//    （窗口引用仍「存活」，但已被 uTools 层面隐藏），故必须重建。
//  - focusable 与期望不一致 → 销毁重建（该选项只能在创建时指定）
//  - 已可见 → 置顶；focus 模式额外 show() 抢回前台焦点，让 uTools 主窗失焦自动隐藏
// opts.focus：是否要求挂件夺焦（true=「显示挂件」模式；false=设置窗需同时可见）；
//            不传则沿用当前窗口的 focusable，供 toggleWidget 等内部调用。
function ensureWidget(opts) {
  const wantFocus = opts && typeof opts.focus === 'boolean' ? opts.focus : winFocusable
  if (winAlive()) {
    if (winFocusable !== wantFocus) {
      log('[whale][widget] 焦点需求变化，重建挂件窗口', winFocusable, '->', wantFocus)
      destroyWidget()
      return createWidget(wantFocus)
    }
    let visible = null // null = 无法探知可见性
    try { if (typeof win.isVisible === 'function') visible = !!win.isVisible() } catch (err) { visible = null }
    if (visible !== false) {
      // 已可见：默认仅置顶（避免抢走设置窗口焦点）；focus 模式或无法探知时补 show()
      if (wantFocus || visible === null) { try { win.show() } catch (err) {} }
      try { if (win.moveTop) win.moveTop() } catch (err) {}
      return win
    }
    // 刚创建不久：可能仍在显示过程中，先 show() 一次，避免误判为「被隐藏」而重建
    if (Date.now() - winCreatedAt < 300) {
      try { win.show() } catch (err) {}
      try { if (win.moveTop) win.moveTop() } catch (err) {}
      return win
    }
    log('[whale][widget] 挂件引用存活但不可见，销毁重建')
    destroyWidget()
  }
  return createWidget(wantFocus)
}

// 创建挂件窗口（调用方需保证当前无存活窗口）
// focusable：true = 挂件显示时抢走前台焦点（供「显示挂件」模式，靠 uTools 原生
//            「主窗失焦自动隐藏」把设置窗收起）；false = 挂件只显示不夺焦（设置窗需同时可见）
function createWidget(focusable) {
  const wantFocus = !!focusable
  const cfg = readConfig()
  const wa = primaryWorkArea()
  const size = winSize(wa, cfg.scale)
  const anchor = readAnchor()
  const pos = anchorToRect(wa, size, anchor)
  const url = floatingUrl()
  const onTop = cfg.onTop !== false
  log('[whale][widget] createBrowserWindow', { url, size, x: pos.x, y: pos.y, preload: 'preload/floating.js', onTop })
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
      // 关键：挂件窗口的可聚焦性按进入方式决定 ——
      //  - false（both/settings）：挂件只显示、不抢焦点，uTools 主窗（设置窗口）保有焦点，
      //    不会被自动隐藏，避免「设置窗口闪一下消失」；Windows 下亦隐含 skipTaskbar。
      //  - true（widget）：挂件一显示就抢走前台焦点，uTools 主窗随即失焦并按原生行为自动隐藏
      //    （不需要 outPlugin()/hideMainWindow() —— outPlugin 会把插件退出到后台致
      //    「打开设置」唤不回，hideMainWindow 会连带隐藏本窗口）。
      focusable: wantFocus,
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
      log('[whale][widget] createBrowserWindow callback: 页面加载完成')
      try { applySizeBounds() } catch (err) {}
      try { win.show() } catch (err) {}
      try { applyOnTop(readConfig().onTop !== false) } catch (err) {}
      // 兜底：即使子窗 ready 消息丢失，加载完成后也推一次初始数据
      setTimeout(function () { try { pushInit() } catch (err) {} }, 300)
    })
    created = true // 窗口已成功创建，后续设置失败不应丢弃该引用
    winFocusable = wantFocus
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
    logErr('[whale][widget] sendToWidget 失败:', channel, err && err.message)
    return false
  }
}

function pushInit() {
  const cfg = readConfig()
  const anchor = readAnchor()
  sendToWidget('whale:init', {
    config: cfg,
    anchor: { hAnchor: anchor.hAnchor, vAnchor: anchor.vAnchor, flipped: flippedOf(anchor) },
    balance: getCachedBalance(),
  })
}

function pushConfig() {
  sendToWidget('whale:config', readConfig())
}

// 实时缩放上下文：连续 __live 调用间缓存，避免每帧同步 IPC 读窗口状态
// （getPosition/getSize/getDisplayNearestPoint 在 uTools 中都是同步往返，高频下卡顿）
let liveScaleCtx = null // { pivotX, pivotY, wa, anchor }
function clearLiveScaleCtx() { liveScaleCtx = null }

// 拖动滑块时的实时缩放：页面侧已用 rAF 合并 IPC（每帧最多一次），
// 宿主侧直接同步执行 applyScaleToWindow，避免主窗不可见时 rAF 被节流导致延迟。
// 优化后 applyScaleToWindow 实时路径只做一次 setBounds，无同步读 IPC，可扛 60fps。
function queueLiveScale(s) {
  const n = Number(s)
  if (!isFinite(n)) return
  applyScaleToWindow(n, false)
}

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
      } catch (err) { logErr('[whale][scale] 读取窗口几何异常', err && err.message) }
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
      if (Math.abs(aw - rw) > 2) logErr('[whale][scale] resize 未生效！期望', rw, '实际', aw)
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
    logErr('[whale][scale] applyScaleToWindow 异常:', err && err.message, err && err.stack)
  }
}

module.exports = {
  primaryWorkArea,
  workAreaNear,
  baseSize,
  winSize,
  widgetOrigin,
  winOrigin,
  clampWidget,
  anchorToRect,
  snapRect,
  flippedOf,
  winAlive,
  getWindow,
  applyOnTop,
  applySizeBounds,
  getWidgetError,
  ensureWidget,
  destroyWidget,
  toggleWidget,
  sendToWidget,
  pushInit,
  pushConfig,
  clearLiveScaleCtx,
  queueLiveScale,
  applyScaleToWindow,
}
