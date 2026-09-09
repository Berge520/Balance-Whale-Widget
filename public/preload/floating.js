/*
 * 小鲸鱼余额挂件 · 悬浮窗 preload（CommonJS，不可压缩混淆）
 *
 * 悬浮窗（floating.html）与主窗宿主（services.js）之间的薄桥接层：
 *  - 接收宿主推送：whale:init / whale:balance / whale:config / whale:snapped
 *  - 向宿主上报：whale:ready / whale:refresh / whale:config
 *              / whale:drag-move / whale:drag-end / whale:ignore-mouse
 *
 * 页面侧统一通过 window.whale 调用，不直接碰 electron / utools。
 */
const electron = require('electron')
const { ipcRenderer, contextBridge } = electron

try { console.log('[whale] floating preload 已加载, typeof utools =', typeof utools, ', contextIsolated =', !!process.contextIsolated) } catch (err) {}

const handlers = { init: [], balance: [], config: [], snapped: [] }

function on(name, cb) {
  if (handlers[name] && typeof cb === 'function') handlers[name].push(cb)
}
function emit(name, data) {
  const list = handlers[name]
  if (!list) return
  for (const cb of list) {
    try { cb(data) } catch (err) {}
  }
}

ipcRenderer.on('whale:init', (event, data) => emit('init', data))
ipcRenderer.on('whale:balance', (event, data) => emit('balance', data))
ipcRenderer.on('whale:config', (event, data) => emit('config', data))
ipcRenderer.on('whale:snapped', (event, data) => emit('snapped', data))

// 悬浮窗 → 主窗。sendToParent 仅在 createBrowserWindow 创建的窗口中有效。
function send(channel) {
  const args = Array.prototype.slice.call(arguments, 1)
  try {
    if (typeof utools !== 'undefined' && typeof utools.sendToParent === 'function') {
      utools.sendToParent(channel, ...args)
    }
  } catch (err) {}
}

const api = {
  // —— 接收宿主推送（floating.html 注册回调） ——
  onInit(cb) { on('init', cb) },
  onBalance(cb) { on('balance', cb) },
  onConfig(cb) { on('config', cb) },
  onSnapped(cb) { on('snapped', cb) },

  // —— 向宿主上报 ——
  ready() { send('whale:ready') },
  refresh(manual) { send('whale:refresh', { manual: !!manual }) },
  saveConfig(patch) { send('whale:config', patch || {}) },
  dragMove(x, y) { send('whale:drag-move', { x: Number(x), y: Number(y) }) },
  dragEnd() { send('whale:drag-end', {}) },
  setIgnoreMouse(ignore) { send('whale:ignore-mouse', { ignore: !!ignore }) },

  // 标记真实桥接已加载（页面据此区分空实现）
  __bridge: true,
}

// createBrowserWindow 默认开启 contextIsolation：此时 preload 的 window 与页面隔离，
// 必须用 contextBridge 暴露；contextIsolation 关闭时直接挂 window。
try {
  if (process.contextIsolated && contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
    contextBridge.exposeInMainWorld('whale', api)
    try { console.log('[whale] 已通过 contextBridge 暴露 window.whale') } catch (err) {}
  } else {
    window.whale = api
    try { console.log('[whale] 已直接挂载 window.whale（contextIsolation 关闭）') } catch (err) {}
  }
} catch (err) {
  try { window.whale = api } catch (e) {}
  try { console.error('[whale] 暴露 window.whale 失败:', err && err.message) } catch (e) {}
}
