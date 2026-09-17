/*
 * 悬浮窗窗口管理（CommonJS）：创建/销毁/几何/缩放/向子窗推送数据。
 */
const { MIN_SCALE, MAX_SCALE, BASE_MIN, BASE_CAP, BASE_MAX, WIN_PAD } = require('./constants')
const { execFileSync } = require('child_process')
const { log, logErr } = require('./log')
const { clampNum, readConfig, readAnchor, writeAnchor, defaultAnchor, readTimer } = require('./store')
const { getCachedBalance, getModelsPayload } = require('./api')
const { getSoundData } = require('./sounds')
const { getSkinData } = require('./skins')
const { getBubbleData } = require('./bubbles')

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
// 显示器信息：workArea（当前可用区，任务栏占位时已排除它）与 bounds（整屏）
function displayInfo(x, y) {
  const fb = { x: 0, y: 0, width: 1280, height: 720 }
  try {
    const d = (typeof x === 'number' && typeof y === 'number')
      ? utools.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
      : utools.getPrimaryDisplay()
    if (d && d.workArea) {
      return {
        wa: d.workArea,
        bounds: d.bounds && d.bounds.width ? d.bounds : d.workArea,
        id: d.id,
        scaleFactor: d.scaleFactor > 0 ? d.scaleFactor : 1,
      }
    }
  } catch (err) {}
  return { wa: fb, bounds: fb, id: '', scaleFactor: 1 }
}
// 任务栏收起时 workArea == 整屏，看不出它在哪条边，只能问注册表：
// StuckRects3\Settings 里 byte[8] 低两位 = 0 左 / 1 上 / 2 右 / 3 下，后面还带任务栏矩形
const TASKBAR_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects3'
const TB_TTL = 60000 // 注册表结果缓存 60s：任务栏设置一般不会频繁改，也避免每次拖拽都起进程
let tbCache = { at: 0, edge: '', size: 0 }

function taskbarFromRegistry() {
  const now = Date.now()
  if (tbCache.at && now - tbCache.at < TB_TTL) return tbCache
  let edge = ''
  let size = 0
  try {
    const out = String(execFileSync('reg', ['query', TASKBAR_REG, '/v', 'Settings'], {
      timeout: 4000, windowsHide: true, encoding: 'utf8',
    }))
    const m = /REG_BINARY\s+([0-9A-Fa-f\s]+)/.exec(out)
    const hex = m ? m[1].replace(/\s+/g, '') : ''
    const bytes = []
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
    if (bytes.length >= 40) {
      edge = ['left', 'top', 'right', 'bottom'][bytes[8] & 0x03] || ''
      // 结构里带的矩形：[24..39] = left/top/right/bottom
      const u32 = (i) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)
      const l = u32(24), t = u32(28), r = u32(32), b = u32(36)
      const w = r - l, h = b - t
      if (w > 0 && h > 0 && w < 10000 && h < 10000) size = (edge === 'left' || edge === 'right') ? w : h
      if (!(size >= 8 && size <= 400)) size = 0
    }
  } catch (err) {
    // 读不到（权限/精简系统/非 Windows）→ 用兜底值
  }
  tbCache = { at: now, edge: edge, size: size }
  return tbCache
}

// 光标是否停在任务栏那条边的「条带」里（= 正压在任务栏上）、是否压到屏幕最边上（= 触发它弹出）
let cursorWarned = false
function cursorOnTaskbar(info, edge, thickness) {
  const b = info.bounds
  const slack = 3 // 贴边触发区（Windows 的鼠标触发区只有最边上 1~2px）
  let p = null
  try { p = utools.getCursorScreenPoint() } catch (err) {}
  if (!p || !isFinite(p.x) || !isFinite(p.y)) {
    if (!cursorWarned) {
      cursorWarned = true
      logErr('[whale][taskbar] 拿不到光标位置（utools.getCursorScreenPoint 不可用），无法识别任务栏显隐')
    }
    return { inStrip: false, atEdge: false }
  }
  const x = Number(p.x)
  const y = Number(p.y)
  const inX = x >= b.x && x < b.x + b.width
  const inY = y >= b.y && y < b.y + b.height
  if (edge === 'bottom') return { inStrip: inX && y >= b.y + b.height - thickness, atEdge: inX && y >= b.y + b.height - slack }
  if (edge === 'top') return { inStrip: inX && y < b.y + thickness, atEdge: inX && y < b.y + slack }
  if (edge === 'left') return { inStrip: inY && x < b.x + thickness, atEdge: inY && x < b.x + slack }
  return { inStrip: inY && x >= b.x + b.width - thickness, atEdge: inY && x >= b.x + b.width - slack }
}

// 「自动隐藏的任务栏此刻正弹出吗」—— 只能看光标：Windows 只在光标压到屏幕那条边时才把它
// 拉出来，拉出后光标就落在它的矩形里，光标一离开它又缩回去。不能直接拿 workArea 判断：
// Windows 上 Electron/uTools 的 workArea 不随任务栏显隐刷新，只反映进程启动时的状态
// （electron#6312：display-metrics-changed 也不响应任务栏变化）。
let tbPopped = false
let tbLastIn = 0
const TB_HOLD = 400 // 光标离开后仍按住一小会儿，避开任务栏收回动画
function liveTaskbarPopped(info, edge, thickness) {
  if (!thickness) return false
  const s = cursorOnTaskbar(info, edge, thickness)
  const now = Date.now()
  if (s.atEdge) tbPopped = true
  else if (!s.inStrip && tbPopped && now - tbLastIn > TB_HOLD) tbPopped = false
  if (s.inStrip) tbLastIn = now
  return tbPopped
}

function sameDisplay(a, b) {
  if (a.id != null && b.id != null) return a.id === b.id
  return a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y
}

// 主屏任务栏的基本情况：
//  常显 → workArea 已有内缩：edge/thickness 就是内缩量，popped 恒为 true（一直占位）
//  自动隐藏 → workArea 内缩为 0，方向/厚度读注册表，此刻是否弹出看光标
function taskbarBase() {
  const info = displayInfo()
  const b = info.bounds
  const wa = info.wa
  const insets = {
    left: Math.round(wa.x - b.x),
    top: Math.round(wa.y - b.y),
    right: Math.round((b.x + b.width) - (wa.x + wa.width)),
    bottom: Math.round((b.y + b.height) - (wa.y + wa.height)),
  }
  let edge = ''
  let thickness = 0
  for (const k of ['left', 'top', 'right', 'bottom']) {
    if (insets[k] > thickness) { edge = k; thickness = insets[k] }
  }
  if (edge) return { info: info, edge: edge, thickness: thickness, autoHide: false, popped: true }
  // 没内缩 → 任务栏不在可用区里（自动隐藏且已收起，或本机没有任务栏）：读注册表拿方向与厚度
  const tb = taskbarFromRegistry()
  if (!tb.edge) return { info: info, edge: '', thickness: 0, autoHide: false, popped: false }
  const t = tb.size ? Math.max(0, Math.round(tb.size / info.scaleFactor)) : 0
  return {
    info: info,
    edge: tb.edge,
    thickness: t,
    autoHide: t > 0,
    popped: liveTaskbarPopped(info, tb.edge, t),
  }
}

// 任务栏「当前」状态（供设置页展示）：visible = 正在占位（常显 / 自动隐藏已弹出）/ hidden = 已自动收起
function taskbarState() {
  const tb = taskbarBase()
  if (!tb.edge) return { state: 'none', edge: '', thickness: 0 }
  return { state: tb.popped ? 'visible' : 'hidden', edge: tb.edge, thickness: tb.thickness }
}

// 实际可用于摆放挂件的区域 = 系统工作区（常显任务栏已被排除）+ 四边「贴边间距」。
// 自动隐藏的任务栏 workArea 不会跟着变，所以它此刻正弹出时，这里自己按注册表厚度让位；
// 收起时不让位（挂件可以贴满边）。「自动避让任务栏」关掉则不跟随。
function usableArea(x, y) {
  const cfg = readConfig()
  const info = displayInfo(x, y)
  const wa = info.wa
  const m = {
    top: Math.max(0, Number(cfg.edgeTop) || 0),
    right: Math.max(0, Number(cfg.edgeRight) || 0),
    bottom: Math.max(0, Number(cfg.edgeBottom) || 0),
    left: Math.max(0, Number(cfg.edgeLeft) || 0),
  }
  if (cfg.avoidTaskbar !== false) {
    const tb = taskbarBase()
    if (tb.edge && tb.autoHide && tb.popped && sameDisplay(info, tb.info)) {
      m[tb.edge] = Math.max(m[tb.edge], tb.thickness)
    }
  }
  // 避让滚动条：只影响右边缘（最大化窗口的纵向滚动条在右侧），
  // 与手动 edgeRight 取较大值，不冲突
  if (cfg.scrollGapOn) {
    const gap = Math.max(0, Number(cfg.scrollGapPx) || 0)
    m.right = Math.max(m.right, gap)
  }
  if (!m.top && !m.right && !m.bottom && !m.left) return wa
  return {
    x: wa.x + m.left,
    y: wa.y + m.top,
    width: Math.max(1, wa.width - m.left - m.right),
    height: Math.max(1, wa.height - m.top - m.bottom),
  }
}
// 按当前锚点重新摆一次窗口（改开关/间距，或任务栏状态变化后立刻生效）
function repositionFromAnchor() {
  if (!winAlive()) return false
  try {
    const sz = win.getSize()
    const pos = win.getPosition()
    const winS = isFinite(sz[0]) ? sz[0] : WIN_PAD * 2 + BASE_MIN
    const wa = usableArea(pos[0] + winS / 2, pos[1] + winS / 2)
    const p = anchorToRect(wa, winS, readAnchor())
    win.setPosition(Math.round(p.x), Math.round(p.y))
    return true
  } catch (err) {
    logErr('[whale][anchor] 重新摆放挂件失败', err && err.message)
    return false
  }
}

// ── 任务栏 / 显示器变化监听 ──
// 每 250ms 采样一次「显示器 + 可用区 + 任务栏此刻是否弹出」，有变化就按锚点重摆。
// 任务栏那条边用 taskbarBase()（自动隐藏时看光标），可用区/显示器变化则覆盖改分辨率、
// 改缩放、换屏这些情况。「自动避让任务栏」关掉或挂件不存在时不轮询。
const WATCH_MS = 250
let watchTimer = null
let watchSig = ''
let watchPos = ''
function watchTick() {
  if (!winAlive()) return
  try {
    const sz = win.getSize()
    const pos = win.getPosition()
    const s = isFinite(sz[0]) ? sz[0] : WIN_PAD * 2 + BASE_MIN
    const x = isFinite(pos[0]) ? pos[0] : 0
    const y = isFinite(pos[1]) ? pos[1] : 0
    const info = displayInfo(x + s / 2, y + s / 2)
    const tb = taskbarBase()
    const sig = [info.id, info.bounds.x, info.bounds.y, info.bounds.width, info.bounds.height,
      info.wa.x, info.wa.y, info.wa.width, info.wa.height, tb.edge, tb.popped ? 1 : 0].join(',')
    const pkey = x + ',' + y
    const moved = !!watchPos && pkey !== watchPos
    watchPos = pkey
    if (sig === watchSig) return
    const first = !watchSig
    watchSig = sig
    // 首次只记基线；窗口位置刚变过（用户正在拖拽/缩放）时不抢位置，避免和操作打架
    if (first || moved) return
    log('[whale][taskbar] 可用区变化，按锚点重摆挂件', sig)
    clearLiveScaleCtx()
    repositionFromAnchor()
  } catch (err) {}
}
function syncTaskbarWatch() {
  const need = winAlive() && readConfig().avoidTaskbar !== false
  if (need && !watchTimer) {
    watchSig = ''
    watchPos = ''
    watchTimer = setInterval(watchTick, WATCH_MS)
    watchTick() // 立刻建立基线
  } else if (!need && watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
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

// 窗口尺寸 = 挂件本体 + 四周留白
function winSize(wa, scale) {
  return baseSize(wa, scale) + WIN_PAD * 2
}

// 挂件本体在窗口内居中：窗口左上角 -> 挂件本体左上角
function widgetOrigin(winX, winY) { return { x: winX + WIN_PAD, y: winY + WIN_PAD } }
// 挂件本体左上角 -> 窗口左上角
function winOrigin(wx, wy) { return { x: wx - WIN_PAD, y: wy - WIN_PAD } }
// 窗口边长 -> 挂件本体边长
function widgetSide(winS) { return winS - WIN_PAD * 2 }

// 挂件本体到工作区上/下边缘的空白（px）。窗口留白只有 WIN_PAD，超出的部分落在屏幕外、
// 菜单摆过去也看不见 —— 挂件贴屏幕上边时菜单必须改向下方展开（见 floating-page.js 的 positionMenu）
function spaceAround(wa, winX, winY, winS) {
  const s = widgetSide(winS)
  const wt = winY + WIN_PAD // 挂件本体上缘
  return {
    up: Math.max(0, Math.round(wt - wa.y)),
    down: Math.max(0, Math.round(wa.y + wa.height - (wt + s))),
  }
}
// 当前挂件四周的上下空白（随初始数据下发给页面）；窗口不存在时给 null，页面按旧行为兜底
function widgetSpace() {
  if (!winAlive()) return null
  try {
    const sz = win.getSize()
    const pos = win.getPosition()
    const winS = isFinite(sz[0]) ? sz[0] : WIN_PAD * 2 + BASE_MIN
    const x = isFinite(pos[0]) ? pos[0] : 0
    const y = isFinite(pos[1]) ? pos[1] : 0
    const s = widgetSide(winS)
    return spaceAround(usableArea(x + winS / 2, y + WIN_PAD + s / 2), x, y, winS)
  } catch (err) { return null }
}

// 把「挂件本体」矩形限制在工作区内（留白可越界）
function clampWidget(wa, wx, wy, s) {
  return {
    x: Math.min(Math.max(wx, wa.x), Math.max(wa.x, wa.x + wa.width - s)),
    y: Math.min(Math.max(wy, wa.y), Math.max(wa.y, wa.y + wa.height - s)),
  }
}

// 锚点 → 窗口左上角坐标（锚点净距离以「挂件本体」边缘为准）
function anchorToRect(wa, winS, anchor) {
  const s = widgetSide(winS) // 挂件本体边长
  const a = anchor || defaultAnchor()
  const wx = a.hAnchor === 'left' ? wa.x + a.hDist : wa.x + wa.width - s - a.hDist
  const wy = a.vAnchor === 'top' ? wa.y + a.vDist : wa.y + wa.height - s - a.vDist
  const c = clampWidget(wa, wx, wy, s)
  return winOrigin(c.x, c.y)
}

// 拖拽结束：中心点进入吸附区（默认各边 1/4 宽，设置页可调）→ 贴左/右、上/下（净距离 0）；
// 中间区域保留自由位（记录离最近边净距离）。横纵独立 → 四角可组合。
// 「关闭吸附」时两轴都走自由分支：位置照样以「最近边 + 净距离」记锚点，能原样还原，只是不再贴边。
// 入参/出参均为「窗口」坐标；内部换算到挂件本体做判定
function snapRect(wa, winX, winY, winW) {
  const cfg = readConfig()
  const snap = cfg.snapMode !== 'off'
  // 吸附区宽度占可用区的比例；异常值回默认 1/4
  const r = Number(cfg.snapRatio) / 100
  const zone = r > 0 && r < 0.5 ? r : 0.25
  const s = widgetSide(winW)
  const o = widgetOrigin(winX, winY)
  let x = o.x, y = o.y
  const cx = x + s / 2
  const cy = y + s / 2
  let hAnchor, hDist, nx = x
  if (snap && cx < wa.x + wa.width * zone) {
    hAnchor = 'left'; hDist = 0; nx = wa.x
  } else if (snap && cx > wa.x + wa.width * (1 - zone)) {
    hAnchor = 'right'; hDist = 0; nx = wa.x + wa.width - s
  } else {
    const leftDist = x - wa.x
    const rightDist = wa.x + wa.width - (x + s)
    if (leftDist <= rightDist) { hAnchor = 'left'; hDist = Math.round(leftDist) }
    else { hAnchor = 'right'; hDist = Math.round(rightDist) }
    nx = x
  }
  let vAnchor, vDist, ny = y
  if (snap && cy < wa.y + wa.height * zone) {
    vAnchor = 'top'; vDist = 0; ny = wa.y
  } else if (snap && cy > wa.y + wa.height * (1 - zone)) {
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

// 朝向（是否镜像）：锚在左 → 翻转，锚在右 → 不翻 —— 保证鲸鱼始终朝屏幕内侧。
// snapRect 的自由分支记的是「离最近的那条边」，所以 hAnchor 本身就编码了「挂件中心在中线的哪一侧」，
// 不必再算一次中线：自由摆放也能跟着位置翻转（关闭吸附后同样生效）。
// 另：缩放的不动点也用它选边（翻转侧保持挂件左缘不动、否则右缘），所以自由位缩放也不会朝边缘挤。
function flippedOf(anchor) {
  return !!anchor && anchor.hAnchor === 'left'
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

// 注意：窗口级 win.setOpacity() 在 Windows 上不能用于本挂件——本窗口是
// transparent:true 的分层透明窗，调用 setOpacity 会让渲染层失效（整窗不显示，
// 即使再设回 1.0 也不恢复，只能销毁重建）。透明度改为页面根元素 CSS opacity，
// 由 floating-page.js 的 applyConfig 消费。

// 显式放开窗口最小尺寸：Windows 无边框/不可调整窗可能被钳制在创建时尺寸，
// 导致 setSize 放大有效、缩小无效。窗口边长 = 挂件本体(base) + 四周留白(WIN_PAD)。
function applySizeBounds() {
  if (!winAlive()) return
  const minS = WIN_PAD * 2 + BASE_MIN - 40   // 允许缩到 base 下限以下一点（实际 base 已夹在 ≥122）
  const maxS = WIN_PAD * 2 + BASE_MAX + 80
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
  const w = ensureWidgetInner(opts)
  // 每次「确保显示」都对一次监听状态：窗口可能是上次就活着、没走 createWidget 的路径，
  // 不补这一次的话「自动避让任务栏」的轮询压根不会启动。
  syncTaskbarWatch()
  return w
}

function ensureWidgetInner(opts) {
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
  const wa = usableArea()
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
      // 表现为放大有效、缩小无效。窗口 = 挂件本体(base) + 四周留白(WIN_PAD)。
      minWidth: WIN_PAD * 2 + BASE_MIN - 40,
      minHeight: WIN_PAD * 2 + BASE_MIN - 40,
      maxWidth: WIN_PAD * 2 + BASE_MAX + 80,
      maxHeight: WIN_PAD * 2 + BASE_MAX + 80,
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
    syncTaskbarWatch() // 挂件就位后开始跟随任务栏显隐（「自动避让任务栏」关掉则不轮询）
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
  syncTaskbarWatch() // 窗口没了 → 停掉任务栏轮询
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
    // 挂件到工作区上下边缘的空白：页面据此决定菜单向上还是向下展开（屏幕外的留白放不下菜单）
    space: widgetSpace(),
    balance: getCachedBalance(),
    // 计时状态：仅当「计时保存」开启时恢复（关闭时不回推，页面按默认清空处理）
    timer: cfg.timerPersistOn ? readTimer() : null,
    // 自定义音效本体（base64 data URL；无自定义时两段均为 null）
    sounds: getSoundData(),
    // 自定义挂件形象本体（base64 data URL；未导入时为空串，页面回退内置形象）
    skin: getSkinData(),
    // 自定义气泡图片本体（base64 data URL 数组；空数组时页面回退内置 rua.gif）
    bubbles: getBubbleData(),
    // 多厂商模型列表（含内置 DeepSeek 那条）+ 主显示模型
    models: getModelsPayload(),
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
      let bx = 0, by = 0, bw = WIN_PAD * 2 + BASE_MIN
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
      const oldS = widgetSide(bw) // 旧挂件本体边长
      const wl = bx + WIN_PAD, wt = by + WIN_PAD // 旧挂件左上
      wa = usableArea(wl + oldS / 2, wt + oldS / 2)
      anchor = readAnchor()
      // 不动点：左吸附→挂件左缘 x，否则→挂件右缘 x；顶部→上缘 y，否则→下缘 y
      pivotX = flippedOf(anchor) ? wl : wl + oldS
      pivotY = anchor.vAnchor === 'top' ? wt : wt + oldS
    }
    const newWin = winSize(wa, scale)
    const newS = widgetSide(newWin)
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
    const rw = Math.round(isFinite(newWin) ? newWin : WIN_PAD * 2 + BASE_MIN)
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
  usableArea,
  taskbarState,
  repositionFromAnchor,
  syncTaskbarWatch,
  baseSize,
  winSize,
  widgetOrigin,
  winOrigin,
  widgetSide,
  spaceAround,
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
