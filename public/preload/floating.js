/*
 * 小鲸鱼余额挂件 · 悬浮窗 preload（CommonJS，不可压缩混淆）
 *
 * 悬浮窗（floating.html）与主窗宿主（services.js）之间的薄桥接层：
 *  - 接收宿主推送：whale:init / whale:balance / whale:config / whale:snapped / whale:sounds
 *              / whale:skin / whale:bubbles / whale:shared-skins（共享角色池清单）
 *              / whale:randimg-data（清单里某一张的本体，whale:randimg 的答复）
 *              / whale:models / whale:todo / whale:focus-stats
 *              / whale:bubble-preview（设置页按压气泡试播）
 *              （另有本地推送 dark：preload 轮询 utools.isDarkColors() 检测 uTools 深浅色变化）
 *  - 向宿主上报：whale:ready / whale:show / whale:refresh / whale:config / whale:timer / whale:timer-done
 *              / whale:todo / whale:focus
 *              / whale:drag-begin / whale:drag-move / whale:drag-end / whale:ignore-mouse
 *              / whale:probe-cursor（问一次光标位置，答复走本地推送 whale:cursor）
 *              / whale:randimg（要共享角色池里某一张的本体，答复走 whale:randimg-data）
 *              / whale:open-settings（可带 { target } 直达某张设置卡，无载荷则只唤出主窗）
 *              / whale:models-refresh / whale:set-main-model / whale:hide-widget / whale:open-external
 *              / whale:widget-visibility（页面可见态上报，宿主据此跳过隐藏态的光标采样）
 *              / whale:remind-tick（可见时每 30s 向宿主补一拍到点扫描，兜住主窗被节流后的 60s）
 *
 * 页面侧统一通过 window.whale 调用，不直接碰 electron / utools。
 */
const electron = require('electron')
const { ipcRenderer, contextBridge } = electron

// 调试日志：dev 下同时同步落盘 %TEMP%\whale-debug.log（窗口/进程被 uTools 关闭也不丢），
// DEV 同时暴露给页面（window.whale.dev）做页面侧门控
const { DEV, LOG_FILE, log, logErr } = require('./lib/log')

log('[whale][floating] preload 已加载', {
  windowType: (function () { try { return utools.getWindowType() } catch (err) { return 'unknown' } })(),
  contextIsolated: !!process.contextIsolated,
  logFile: LOG_FILE || '(仅控制台)',
})

// 关掉 Chromium 自带的缩放通道：挂件尺寸只由宿主 setBounds（scale）控制，
// 整页视觉缩放会让窗口尺寸与 scale 读数都不变、画面却变大（触控板捏合后还会一直保持），
// 用户观感就是「拖动之后变大了」。业务滚轮缩放在 floating-page.js 里接管，
// 这里只锁视觉缩放与布局缩放级别；API 缺失时静默跳过（uTools 版本差异）。
try {
  if (electron.webFrame) {
    electron.webFrame.setVisualZoomLevelLimits(1, 1)
    if (typeof electron.webFrame.setLayoutZoomLevelLimits === 'function') {
      electron.webFrame.setLayoutZoomLevelLimits(0, 0)
    }
  }
} catch (err) { logErr('[whale] 禁止页面缩放失败', err && err.message) }

const handlers = { init: [], balance: [], config: [], snapped: [], dsh: [], sounds: [], skin: [], bubbles: [], sharedSkins: [], randimgData: [], models: [], dark: [], bubblePreview: [], todo: [], todoDue: [], focusStats: [], cmd: [], cursor: [] }

function on(name, cb) {
  if (handlers[name] && typeof cb === 'function') handlers[name].push(cb)
}
function emit(name, data) {
  const list = handlers[name]
  if (!list) return
  for (const cb of list) {
    try { cb(data) } catch (err) { logErr('[whale] 页面回调异常', err && err.message) }
  }
}

ipcRenderer.on('whale:init', (event, data) => emit('init', data))
ipcRenderer.on('whale:balance', (event, data) => emit('balance', data))
ipcRenderer.on('whale:config', (event, data) => emit('config', data))
ipcRenderer.on('whale:snapped', (event, data) => emit('snapped', data))
// dsh（DeepSeek Harness）操作结果/状态快照回推
ipcRenderer.on('whale:dsh', (event, data) => emit('dsh', data))
// 自定义音效本体（base64 data URL；导入/删除后宿主重推）
ipcRenderer.on('whale:sounds', (event, data) => emit('sounds', data))
// 自定义挂件形象本体（base64 data URL；导入/删除后宿主重推，空串表示无自定义形象）
ipcRenderer.on('whale:skin', (event, data) => emit('skin', data))
// 自定义气泡图片本体（base64 data URL 数组；导入/删除后宿主重推，空数组表示回退内置 rua.webp）
ipcRenderer.on('whale:bubbles', (event, data) => emit('bubbles', data))
// 已装「官方可下载形象」的**清单**（[{ id, ext, size }]，不含本体）：台词 v2 randimg 段的共享角色图池。
// 整池本体当年是一次性推过来的（52MB base64），把「打开挂件」卡住；现在本体按需在下面那条通道取。
ipcRenderer.on('whale:shared-skins', (event, data) => emit('sharedSkins', data))
// 单张共享角色本体（页面 whale:randimg 的答复）：{ id, url }，url 为空串 = 那张取不到
ipcRenderer.on('whale:randimg-data', (event, data) => emit('randimgData', data))
// 多厂商模型列表（含内置 DeepSeek 那条）+ 主显示模型
ipcRenderer.on('whale:models', (event, data) => emit('models', data))
// 设置页「按压气泡试播」：把设置页当前编辑的泡泡队列发来真弹一次（items 已在宿主侧归一化）
ipcRenderer.on('whale:bubble-preview', (event, data) => emit('bubblePreview', data))
// 待办清单（权威状态由宿主维护：设置页增删改、挂件页勾选/设专注，改完都回推一份完整清单）
ipcRenderer.on('whale:todo', (event, data) => emit('todo', data))
// 专注统计与每日目标（宿主 whale:focus-stats 推送：{ summary, goal }）
ipcRenderer.on('whale:focus-stats', (event, data) => emit('focusStats', data))
// 快捷指令（宿主 feature 入口触发：计时器切换、专注统计显示等）
// 待办到点提醒也走这条队列（宿主 sendWidgetCmd 会包成 whale:cmd），这里译成 todoDue 事件，
// 页面只处理一种形态；队列机制顺带解决「页面还没 ready 时推送丢失」。
ipcRenderer.on('whale:cmd', (event, data) => {
  emit('cmd', data)
  if (data && data.cmd === 'todo-due') emit('todoDue', data.payload)
})
// 光标探测回包（页面 whale:probe-cursor 的答复）：{ x, y } 相对挂件窗口左上角。
// 用途见 api.probeCursor —— 指针静止时没有 pointermove，悬停判定建立不起来
ipcRenderer.on('whale:cursor', (event, data) => emit('cursor', data))

// —— 深浅色跟随 uTools ——
// 菜单/计时条等 UI 的深浅形态挂在 <html> 的 dark 类上（floating.css 消费）。判定源是
// utools.isDarkColors()，uTools 没有主题变更事件，只能在 preload 里轮询（同步布尔读，开销可忽略）。
// 菜单面板等控件不跟配置里的 theme（那是气泡配色主题），两者是两回事。
// 优化：5s 轮询（原 1s）+ 窗口获焦时立即检测。缓存上次值，仅变化时才推送，
// 避免页面每秒做一次无意义的 DOM classList.toggle。
function isDark() {
  try { return !!utools.isDarkColors() } catch (err) { return false }
}
var lastDark = null
function pushDark() {
  var d = isDark()
  if (d !== lastDark) { lastDark = d; emit('dark', d) }
}
pushDark() // 首次立即给一版，页面 onInit 前也能拿到正确形态
setInterval(pushDark, 5000)
// 窗口获焦时立即检测：用户切回挂件时主题可能已变，不等 5s 轮询
try { window.addEventListener('focus', pushDark) } catch (_) {}

// 悬浮窗 → 主窗。sendToParent 仅在 createBrowserWindow 创建的窗口中有效。
function send(channel) {
  const args = Array.prototype.slice.call(arguments, 1)
  try {
    if (typeof utools !== 'undefined' && typeof utools.sendToParent === 'function') {
      utools.sendToParent(channel, ...args)
    }
  } catch (err) { logErr('[whale] sendToParent 失败', channel, err && err.message) }
}

// 页面可见态上报：宿主的任务栏轮询（widget.js watchTick）要靠它跳过隐藏态的光标采样。
// 为什么不用原生 isVisible() / isMinimized() 就够：那两个只反映窗口自身的显隐，
// 「切虚拟桌面 / 显示桌面」这类页面级不可见在 Windows 上不一定让 isVisible() 翻 false；
// document.hidden 由 Chromium 直接按页面是否真正可见维护，二者叠加才不漏判。
// 初始推一次，之后由 visibilitychange（最小化 / 显示桌面 / 虚拟桌面切换）维护；
// pageshow / pagehide 兜住页面被冻结、恢复的极端时序，避免宿主停在旧状态。
function pushVisibility() {
  try { send('whale:widget-visibility', { hidden: !!window.document.hidden }) } catch (err) {}
}
try {
  window.document.addEventListener('visibilitychange', pushVisibility)
  window.addEventListener('pageshow', pushVisibility)
  window.addEventListener('pagehide', pushVisibility)
} catch (err) {}
pushVisibility()

// —— 待办到点扫描的第二路驱动 ——
// 主窗（设置窗）一关就隐藏，它的 30s 表会被 Chromium 后台节流拉成 60s（真机日志实测：
// onPluginOut(isKill:false) 后约 2 分钟，节奏从 30.000s 变成 60.000s）。
// 挂件窗常驻桌面且可见，渲染进程不被节流，这里按同一节拍向宿主补一拍；宿主 lib/remind-tick.js
// 有 20s 去抖（与主窗表共用同一实例），两路不会在同一秒重复跑。
// 挂件不可见（最小化 / 显示桌面 / 切虚拟桌面）时主动停发：隐藏态下本窗同样会被节流，
// 再发只是把 60s 的拍子叠上去，交给主窗兜底表即可。
function remindTick() {
  try {
    if (window.document.hidden) return
    send('whale:remind-tick')
  } catch (err) { logErr('[whale][remind] 挂件驱动上报失败', err && err.message) }
}
try {
  remindTick() // 建窗 / 重载后先补一拍（与主窗启动补扫重叠时由宿主去抖挡掉）
  setInterval(remindTick, 30000)
  // 从隐藏恢复可见时立刻补一拍，隐藏期间漏掉的到点不用再等下个 30s
  window.document.addEventListener('visibilitychange', function () { if (!window.document.hidden) remindTick() })
} catch (err) { logErr('[whale][remind] 启动挂件驱动失败', err && err.message) }

const api = {
  // —— 接收宿主推送（floating.html 注册回调） ——
  onInit(cb) { on('init', cb) },
  onBalance(cb) { on('balance', cb) },
  onConfig(cb) { on('config', cb) },
  onSnapped(cb) { on('snapped', cb) },
  onDsh(cb) { on('dsh', cb) },
  onSounds(cb) { on('sounds', cb) },
  onSkin(cb) { on('skin', cb) },
  onBubbles(cb) { on('bubbles', cb) },
  onSharedSkins(cb) { on('sharedSkins', cb) },
  // 单张共享角色本体的回包（宿主 whale:randimg-data：{ id, url }，url 空串 = 取不到）
  onRandimgData(cb) { on('randimgData', cb) },
  onModels(cb) { on('models', cb) },
  // 设置页「按压气泡试播」：真弹一次设置页正在编辑的泡泡队列（宿主 whale:bubble-preview 推送）
  onBubblePreview(cb) { on('bubblePreview', cb) },
  // 待办清单（宿主 whale:todo 推送：整份 { items, focusId }，页面不做增量合并）
  onTodo(cb) { on('todo', cb) },
  // 待办到点提醒（宿主经 whale:cmd 队列送来的 todo-due：{ id, text, dueAt }）
  onTodoDue(cb) { on('todoDue', cb) },
  // 专注统计与每日目标（宿主 whale:focus-stats 推送：{ summary, goal }）
  onFocusStats(cb) { on('focusStats', cb) },
  // 快捷指令（宿主 feature 入口触发：{ cmd, payload }）
  onCmd(cb) { on('cmd', cb) },
  // 光标探测回包（宿主 whale:cursor 推送：{ x, y } 相对窗口左上角，拿不到时为 null）
  onCursor(cb) { on('cursor', cb) },
  // 复制文本到剪贴板：页面侧没有 utools 全局（它只在 preload 里），统一由这里代劳。
  // 同步返回是否成功，页面据此给出「已复制 / 复制失败」回执
  copyText(text) {
    try { return !!utools.copyText(String(text == null ? '' : text)) } catch (err) { return false }
  },
  // uTools 深浅色变化（preload 轮询检测后本地推送，不经主窗）
  onDark(cb) { on('dark', cb) },
  // 同步读取当前深浅态：preload 的首条 dark 推送早于页面注册回调，页面启动时用这里补齐初值
  isDark() { return isDark() },

  // —— 向宿主上报 ——
  ready() { send('whale:ready') },
  // 首帧就绪后请求显示挂件窗口：窗口以 show:false 创建（防首帧露出随包内置形象，见 lib/widget.js），
  // 页面把配置（含自定义形象本体）落地后再调这里。宿主对重复/异常调用做了兜底，可放心调
  show() { send('whale:show') },
  refresh(manual) { send('whale:refresh', { manual: !!manual }) },
  saveConfig(patch) { send('whale:config', patch || {}) },
  // 计时状态落库（state 传 null 表示清除）；宿主 pushInit 时回推给页面恢复
  saveTimer(state) { send('whale:timer', state || null) },
  // 计时到点通知（channels = 计时页的「系统通知 / 邮件」两个开关；宿主再叠渠道总开关）
  notifyTimerDone(text, channels) {
    const ch = channels && typeof channels === 'object' ? channels : null
    const payload = { text: String(text || '') }
    if (ch) payload.channels = { system: ch.system === true, mail: ch.mail === true }
    send('whale:timer-done', payload)
  },
  // 待办轻操作：op = toggle（勾选/取消完成）| focus（设为当前专注）| unfocus（取消专注），带 id
  todoSend(payload) {
    const p = payload && typeof payload === 'object' ? payload : {}
    send('whale:todo', { op: String(p.op || ''), id: String(p.id || ''), text: String(p.text || '') })
  },
  // 到点气泡回执：shown=true 表示气泡真的挂出来了，宿主据此才写幂等位（remindedFor）。
  // 计时气泡占位 / 免打扰被拦时回 shown=false，提醒保留待投递状态，下一个 tick 还会再试。
  // debug=true：设置页调试入口触发的演练，宿主不记账（否则会把真实幂等位改脏）
  todoDueAck(payload) {
    const p = payload && typeof payload === 'object' ? payload : {}
    send('whale:todo-due-ack', {
      id: String(p.id || ''),
      dueAt: Number(p.dueAt) || 0,
      shown: p.shown === true,
      debug: p.debug === true,
    })
  },
  // 专注会话上报：payload = { mode, startAt, endAt, minutes, isBreak, abandoned }
  // 页面只报「这段投入多长、怎么计的、走完还是放弃」；什么算一轮、归哪天由宿主派生
  focusSession(payload) {
    const p = payload && typeof payload === 'object' ? payload : {}
    send('whale:focus', {
      mode: String(p.mode || 'down'),
      startAt: Number(p.startAt) || 0,
      endAt: Number(p.endAt) || 0,
      minutes: Number(p.minutes) || 0,
      isBreak: p.isBreak === true,
      abandoned: p.abandoned === true,
    })
  },
  // dsh（DeepSeek Harness）控制：action = status | start | stop | restart | update | open
  dsh(payload) {
    send('whale:dsh', typeof payload === 'string' ? { action: payload } : (payload || {}))
  },
  // 拖拽开始：宿主据此冻结缩放，避免「拖一半窗口突然变大、大小描述还不变」
  dragBegin() { send('whale:drag-begin', {}) },
  dragMove(x, y) { send('whale:drag-move', { x: Number(x), y: Number(y) }) },
  dragEnd() { send('whale:drag-end', {}) },
  setIgnoreMouse(ignore) { send('whale:ignore-mouse', { ignore: !!ignore }) },
  // 问宿主「光标此刻在哪」（相对窗口左上角）：挂件窗口平时是 ignoreMouse，指针若本来就停在
  // 鲸鱼上（页面刚重建 / 挂件刚被拖到光标下），没有 pointermove 就建立不了悬停判定，
  // 用户直接点会被穿透到下层应用。页面拿到坐标后自己补一次命中测试（见 hoverAt）
  probeCursor() { send('whale:probe-cursor', {}) },
  // 要共享角色池里的某一张本体（答复走本地推送 whale:randimg-data）。宿主推来的清单只有
  // id/ext/size，图片是抽到才来要的 —— 一次一张，避免整池搬进挂件
  requestRandimg(id) { send('whale:randimg', { id: String(id || '') }) },
  // 菜单里的输入框要打字：窗口是 focusable:false 建的，键盘事件进不到页面，
  // 打开菜单时让宿主把焦点给挂件，关闭时交还（详见 preload/lib/ipc.js 的 whale:input-focus）
  setInputFocus(focus) { send('whale:input-focus', { focus: !!focus }) },
  // 多厂商模型：ids 省略 = 全部；force=false 时宿主按 5 分钟节流跳过（菜单打开时懒加载用）
  refreshModels(ids, force) {
    send('whale:models-refresh', { ids: Array.isArray(ids) ? ids : null, force: !!force })
  },
  // 切换挂件主显示的模型（'deepseek' 为内置）
  setMainModel(id) { send('whale:set-main-model', { id: String(id || '') }) },
  // 请求宿主唤出 uTools 主窗（设置页）。target 可选（如 'appearance' 直达对应卡片）；省略/传 null 只唤窗
  openSettings(target) { send('whale:open-settings', target ? { target: String(target) } : null) },
  // 台词链接段点击：宿主校验 http(s) 后交给系统浏览器开（utools.shellOpenExternal）
  openExternal(url) { send('whale:open-external', { url: String(url || '') }) },
  // 请求宿主隐藏挂件（销毁悬浮窗；下次「显示挂件」重新创建，加载最新页面）
  hideWidget() { send('whale:hide-widget') },
  // 把页面错误转交宿主落盘：页面侧只能打 console，此处让它进 %TEMP%\whale-debug.log
  reportError(msg, detail) {
    send('whale:page-log', { msg: String(msg || ''), detail: String(detail == null ? '' : detail) })
  },

  // 标记真实桥接已加载（页面据此区分空实现）
  __bridge: true,
  // 开发者模式标志：页面侧据此决定是否打印调试日志
  dev: DEV,
}

// createBrowserWindow 默认开启 contextIsolation：此时 preload 的 window 与页面隔离，
// 必须用 contextBridge 暴露；contextIsolation 关闭时直接挂 window。
try {
  if (process.contextIsolated && contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
    contextBridge.exposeInMainWorld('whale', api)
    log('[whale] 已通过 contextBridge 暴露 window.whale')
  } else {
    window.whale = api
    log('[whale] 已直接挂载 window.whale（contextIsolation 关闭）')
  }
} catch (err) {
  try { window.whale = api } catch (e) { logErr('[whale] 回退挂载 window.whale 失败', e && e.message) }
  logErr('[whale] 暴露 window.whale 失败:', err && err.message)
}
