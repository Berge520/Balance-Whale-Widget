/*
 * 小鲸鱼余额挂件 · 悬浮窗 preload（CommonJS，不可压缩混淆）
 *
 * 悬浮窗（floating.html）与主窗宿主（services.js）之间的薄桥接层：
 *  - 接收宿主推送：whale:init / whale:balance / whale:config / whale:snapped / whale:sounds
 *              / whale:quote-sounds / whale:skin / whale:bubbles / whale:models
 *              / whale:quote-preview
 *              （另有本地推送 dark：preload 轮询 utools.isDarkColors() 检测 uTools 深浅色变化）
 *  - 向宿主上报：whale:ready / whale:refresh / whale:config / whale:timer / whale:timer-done
 *              / whale:drag-begin / whale:drag-move / whale:drag-end / whale:ignore-mouse
 *              / whale:open-settings（无载荷，只负责唤出主窗；不再带 target 导航）
 *              / whale:models-refresh / whale:set-main-model / whale:hide-widget / whale:open-external
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

const handlers = { init: [], balance: [], config: [], snapped: [], dsh: [], sounds: [], quoteSounds: [], skin: [], bubbles: [], models: [], dark: [], quotePreview: [] }

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
// 组级台词音效本体（name→dataURL，只含被台词组引用的段；配置/音效库变化后宿主重推）
ipcRenderer.on('whale:quote-sounds', (event, data) => emit('quoteSounds', data))
// 自定义挂件形象本体（base64 data URL；导入/删除后宿主重推，空串表示无自定义形象）
ipcRenderer.on('whale:skin', (event, data) => emit('skin', data))
// 自定义气泡图片本体（base64 data URL 数组；导入/删除后宿主重推，空数组表示回退内置 rua.webp）
ipcRenderer.on('whale:bubbles', (event, data) => emit('bubbles', data))
// 多厂商模型列表（含内置 DeepSeek 那条）+ 主显示模型
ipcRenderer.on('whale:models', (event, data) => emit('models', data))
// 设置页「在挂件上试播」：把设置页当前编辑的组台词发来真弹一次（lines 已在宿主侧清洗过）
ipcRenderer.on('whale:quote-preview', (event, data) => emit('quotePreview', data))

// —— 深浅色跟随 uTools ——
// 菜单/计时条等 UI 的深浅形态挂在 <html> 的 dark 类上（floating.css 消费）。判定源是
// utools.isDarkColors()，uTools 没有主题变更事件，只能在 preload 里轮询（同步布尔读，开销可忽略）。
// 菜单面板等控件不跟配置里的 theme（那是气泡配色主题），两者是两回事。
function isDark() {
  try { return !!utools.isDarkColors() } catch (err) { return false }
}
function pushDark() { emit('dark', isDark()) }
pushDark() // 首次立即给一版，页面 onInit 前也能拿到正确形态
setInterval(pushDark, 1000)

// 悬浮窗 → 主窗。sendToParent 仅在 createBrowserWindow 创建的窗口中有效。
function send(channel) {
  const args = Array.prototype.slice.call(arguments, 1)
  try {
    if (typeof utools !== 'undefined' && typeof utools.sendToParent === 'function') {
      utools.sendToParent(channel, ...args)
    }
  } catch (err) { logErr('[whale] sendToParent 失败', channel, err && err.message) }
}

const api = {
  // —— 接收宿主推送（floating.html 注册回调） ——
  onInit(cb) { on('init', cb) },
  onBalance(cb) { on('balance', cb) },
  onConfig(cb) { on('config', cb) },
  onSnapped(cb) { on('snapped', cb) },
  onDsh(cb) { on('dsh', cb) },
  onSounds(cb) { on('sounds', cb) },
  onQuoteSounds(cb) { on('quoteSounds', cb) },
  onSkin(cb) { on('skin', cb) },
  onBubbles(cb) { on('bubbles', cb) },
  onModels(cb) { on('models', cb) },
  // 设置页「在挂件上试播」：真弹一次设置页正在编辑的台词（宿主 whale:quote-preview 推送）
  onQuotePreview(cb) { on('quotePreview', cb) },
  // uTools 深浅色变化（preload 轮询检测后本地推送，不经主窗）
  onDark(cb) { on('dark', cb) },
  // 同步读取当前深浅态：preload 的首条 dark 推送早于页面注册回调，页面启动时用这里补齐初值
  isDark() { return isDark() },

  // —— 向宿主上报 ——
  ready() { send('whale:ready') },
  refresh(manual) { send('whale:refresh', { manual: !!manual }) },
  saveConfig(patch) { send('whale:config', patch || {}) },
  // 计时状态落库（state 传 null 表示清除）；宿主 pushInit 时回推给页面恢复
  saveTimer(state) { send('whale:timer', state || null) },
  // 计时到点系统通知（页面已按「到点通知」开关判断是否调用）
  notifyTimerDone(text) { send('whale:timer-done', { text: String(text || '') }) },
  // dsh（DeepSeek Harness）控制：action = status | start | stop | restart | update | open
  dsh(payload) {
    send('whale:dsh', typeof payload === 'string' ? { action: payload } : (payload || {}))
  },
  // 拖拽开始：宿主据此冻结缩放，避免「拖一半窗口突然变大、大小描述还不变」
  dragBegin() { send('whale:drag-begin', {}) },
  dragMove(x, y) { send('whale:drag-move', { x: Number(x), y: Number(y) }) },
  dragEnd() { send('whale:drag-end', {}) },
  setIgnoreMouse(ignore) { send('whale:ignore-mouse', { ignore: !!ignore }) },
  // 菜单里的输入框要打字：窗口是 focusable:false 建的，键盘事件进不到页面，
  // 打开菜单时让宿主把焦点给挂件，关闭时交还（详见 preload/lib/ipc.js 的 whale:input-focus）
  setInputFocus(focus) { send('whale:input-focus', { focus: !!focus }) },
  // 多厂商模型：ids 省略 = 全部；force=false 时宿主按 5 分钟节流跳过（菜单打开时懒加载用）
  refreshModels(ids, force) {
    send('whale:models-refresh', { ids: Array.isArray(ids) ? ids : null, force: !!force })
  },
  // 切换挂件主显示的模型（'deepseek' 为内置）
  setMainModel(id) { send('whale:set-main-model', { id: String(id || '') }) },
  // 请求宿主唤出 uTools 主窗（设置页）
  openSettings() { send('whale:open-settings') },
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
