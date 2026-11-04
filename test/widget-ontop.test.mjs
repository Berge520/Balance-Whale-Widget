/*
 * 挂件窗口「置顶」重申契约单测（node --test，零依赖）。
 *
 * 盯的是真机取证到的静默失效：Win32 GetWindowLong 读挂件窗口的 GWL_EXSTYLE，
 * 实测 WS_EX_TOPMOST=0（ex=0x08080020），而配置里 onTop=true。也就是
 * 「用户要置顶，窗口实际没置顶」，而且这位一掉就不会自己回来 ——
 * 宿主只在「创建窗口」和「配置变更」时调 applyOnTop，别的路径一次都不重申。
 *
 * 这个失效类别本仓库已经认过一遍，只是只修了一半：ensureSkipTaskbar() 的注释明确写着
 * 「运行时一旦 setFocusable(true)（菜单借焦点）或 show()/moveTop() 让 Windows 重新登记窗口
 * 样式，任务栏图标就会冒出来…故凡是『切换可聚焦性』『重新显示』的路径，都要再安一次」——
 * 同一次重新登记把 TOPMOST 也一起冲掉，却没有人管。真机那轮直接看到了带动者：
 * 指针进出鲸鱼 → 页面下发穿透切换 → setIgnoreMouseEvents 重写 GWL_EXSTYLE
 * （transparent 位随之翻转），TOPMOST 就掉在这类调用里。
 *
 * 为什么**不能**用 isAlwaysOnTop() 做「不一致才修」的守卫（这是被真机否证的弯路，别再改回去）：
 * 同一时刻 Win32 说 topmost=False，宿主却报 isAlwaysOnTop()=true —— 它返回的是 Electron 自己
 * 的缓存位，不是窗口的实时样式，守卫会被它骗成永远「跳过」。所以重申必须无条件发；
 * 防抖靠上游去重（穿透切换只在值真变时下发，show()/开菜单本身就低频）。
 *
 * 于是把口径固定成四条，改坏了测试就会红：
 *  1. 每次重申恰好发一次 setAlwaysOnTop，值取配置里的**实时值**（不是创建时快照）；
 *  2. 宿主缓存位说「已经置顶」也照发（就是上面那条真机结论）；
 *  3. 配置不置顶时发 false（反向也要能摘掉）；
 *  4. 重申不许顺带 moveTop —— 那是抢前台层序，补位用不着它。
 *
 * 环境：utools 全桩（createBrowserWindow 返回假窗口，按名字记账窗口调用），
 * 落盘走内存 dbStorage + 本次专用临时目录，不碰真实用户数据。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-widget-ontop-'))

const db = new Map()
// 假窗口「实测」到的置顶位。真机结论是宿主这个读数会撒谎（报缓存），
// 所以用例特意让它与配置一致，看代码是否还肯重申。
// visible 单独可拨：兜底显示那条路径写的是 `if (!win.isVisible()) win.show()`，
// 默认「已经看得见」会让 show 压根不发生，测不到重申。
const winState = { alwaysOnTop: true, visible: true }
let calls = []

function makeFakeWin() {
  const impl = {
    isDestroyed: () => false,
    isVisible: () => winState.visible,
    isAlwaysOnTop: () => winState.alwaysOnTop,
    getPosition: () => [100, 100],
    getSize: () => [652, 652],
    getBounds: () => ({ x: 100, y: 100, width: 652, height: 652 }),
    isMaximized: () => false,
    isFullScreen: () => false,
    isSimpleFullScreen: () => false,
    webContents: { send: () => {} },
  }
  return new Proxy({}, {
    get(t, key) {
      if (typeof key !== 'string') return undefined
      if (key in impl) return impl[key]
      return (...args) => { calls.push({ m: key, args }); return undefined }
    },
    set: () => true,
  })
}

globalThis.utools = {
  getPath: () => TMP,
  dbStorage: {
    getItem: (k) => (db.has(k) ? db.get(k) : null),
    setItem: (k, v) => { db.set(k, v) },
    removeItem: (k) => { db.delete(k) },
  },
  getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  createBrowserWindow: () => makeFakeWin(),
  getWindowType: () => 'main',
  isDarkColors: () => false,
  showMainWindow: () => {},
  sendToParent: () => {},
}

const widget = require('../public/preload/lib/widget.js')
const { readConfig, patchConfig } = require('../public/preload/lib/store.js')
const { WIDGET_AUTOSHOW_MS } = require('../public/preload/lib/constants.js')

// 任务栏轮询是 250ms 的 setInterval，测试里不需要它 —— 关掉既免得把事件循环吊住，
// 也不让 watchTick 里的位置读写干扰记账。
patchConfig({ avoidTaskbar: false })

after(() => {
  widget.dispose()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// 每条用例从「新建窗口 + 清空记账」开始，免得上一例的窗口和调用串进来
function open() {
  calls = []
  widget.destroyWidget()
  widget.ensureWidget({ focus: false })
  calls = []
}
function topmostCalls() { return calls.filter((c) => c.m === 'setAlwaysOnTop') }

test('每次重申恰好发一次 setAlwaysOnTop（宿主缓存位说「已置顶」也照发）', () => {
  patchConfig({ onTop: true })
  open()
  winState.alwaysOnTop = true // 真机取证：Win32 实测没置顶，宿主却报 true —— 守卫会被它骗死
  widget.ensureWindowStyles()
  const set = topmostCalls()
  assert.equal(set.length, 1, '无条件重申：恰好一次')
  assert.equal(set[0].args[0], true, '重申的值跟配置一致（要置顶）')
})

test('重申不许顺带 moveTop（那是抢前台层序，补位用不着）', () => {
  patchConfig({ onTop: true })
  open()
  winState.alwaysOnTop = false
  widget.ensureWindowStyles()
  assert.equal(calls.filter((c) => c.m === 'moveTop').length, 0)
})

test('配置不置顶：重申发 false，否则关不掉', () => {
  patchConfig({ onTop: false })
  open()
  winState.alwaysOnTop = true
  widget.ensureWindowStyles()
  const set = topmostCalls()
  assert.equal(set.length, 1)
  assert.equal(set[0].args[0], false)
})

test('重申取配置里的实时值，不是创建时快照', () => {
  patchConfig({ onTop: true })
  open()
  widget.ensureWindowStyles()
  assert.equal(topmostCalls()[0].args[0], true)
  patchConfig({ onTop: false })
  calls = []
  widget.ensureWindowStyles()
  assert.equal(topmostCalls()[0].args[0], false, 'applyOnTop 只挂在配置变更上，漏掉的路径靠这里按新配置兜')
  assert.equal(readConfig().onTop, false)
})

test('统一入口顺带重申 skipTaskbar（同一个失效类别，一次调用修两处）', () => {
  patchConfig({ onTop: true })
  open()
  winState.alwaysOnTop = true
  widget.ensureWindowStyles()
  assert.equal(calls.filter((c) => c.m === 'setSkipTaskbar').length, 1, '任务栏那条仍然每次都要安')
})

test('悬停穿透切换：值真变才下发，且下发后重申窗口样式', () => {
  patchConfig({ onTop: true })
  open()
  winState.alwaysOnTop = true
  calls = []
  widget.applyIgnoreMouse(true)
  assert.equal(calls.filter((c) => c.m === 'setIgnoreMouseEvents').length, 1, '穿透状态切换要真的下发到窗口')
  assert.equal(topmostCalls().length, 1, 'setIgnoreMouseEvents 会重写 GWL_EXSTYLE，紧跟着必须重申')
  calls = []
  widget.applyIgnoreMouse(true)
  assert.equal(calls.length, 0, '同一个值重复上报（鼠标在挂件上移动时是高频的）不许再碰窗口')
})

test('穿透下发的值按窗口实例失效：重建窗口后必须重新下发一次', () => {
  patchConfig({ onTop: true })
  open()
  widget.applyIgnoreMouse(true)
  calls = []
  open() // 窗口重建：新窗口默认不穿透，缓存里那个 true 不算数
  widget.applyIgnoreMouse(true)
  assert.equal(calls.filter((c) => c.m === 'setIgnoreMouseEvents').length, 1)
})

test('重申窗口样式会一起重申穿透态：值没变也要重发（forward 钩子靠它装回去）', () => {
  patchConfig({ onTop: true })
  open()
  widget.applyIgnoreMouse(true)
  calls = []
  widget.ensureWindowStyles()
  const im = calls.filter((c) => c.m === 'setIgnoreMouseEvents')
  assert.equal(im.length, 1, '缓存说「已经是 true」也必须重发 —— 真机上样式位可能还在、转发钩子已失效')
  assert.deepEqual(im[0].args, [true, { forward: true }])
})

test('改尺寸路径同样重申窗口样式（setResizable 也会重登记样式）', () => {
  patchConfig({ onTop: true })
  open()
  winState.alwaysOnTop = true
  widget.applyScaleToWindow(1.2, true)
  assert.ok(topmostCalls().length >= 1, 'setResizable(true/false) 各触发一次重登记，收尾必须把两位都安回来')
  assert.ok(calls.filter((c) => c.m === 'setSkipTaskbar').length >= 1)
})

// 创建路径：创建后立刻 win.show()，这一步同样会重登记样式。收尾若只补 skipTaskbar，
// 置顶位就会在「窗口刚出现、页面还没收到悬停」的窗口期里空着。
test('创建路径：show() 之后同样重申置顶与任务栏两位', () => {
  patchConfig({ onTop: true })
  calls = []
  widget.destroyWidget()
  widget.ensureWidget({ focus: false })
  const showAt = calls.findIndex((c) => c.m === 'show')
  const topAt = calls.map((c) => c.m).lastIndexOf('setAlwaysOnTop')
  assert.ok(showAt >= 0, '创建路径会调 show()')
  assert.ok(topAt > showAt, 'show() 之后必须重申置顶')
  assert.ok(calls.filter((c) => c.m === 'setSkipTaskbar').length >= 1, '任务栏那条仍在')
  calls = []
})

// 兜底显示：页面迟迟没就绪时，宿主在 WIDGET_AUTOSHOW_MS 后自己 win.show()。
// 这是「重登记窗口样式」的调用之一，漏了重申就会留下一个**没有任何东西会再修**的坏状态
// （下一次鼠标进出挂件才会被顺带修好），所以它和在显示路径上补的其它几处同一条口径。
// 定时器不真等 3 秒：捕获回调、手动点火，用例保持毫秒级。
test('兜底显示路径同样重申窗口样式', () => {
  patchConfig({ onTop: true })
  const real = globalThis.setTimeout
  const captured = []
  globalThis.setTimeout = function (fn, delay) {
    const h = real(function () {}, 1e6) // 只占个句柄给 clearTimeout，不真的跑
    if (h && h.unref) h.unref()
    captured.push({ fn, delay, handle: h })
    return h
  }
  let created
  try {
    widget.destroyWidget()
    created = widget.ensureWidget({ focus: false })
  } finally {
    globalThis.setTimeout = real
  }
  assert.ok(created, '窗口应已创建')
  const auto = captured.filter((t) => t.delay === WIDGET_AUTOSHOW_MS)
  assert.equal(auto.length, 1, '应排上一次兜底显示定时器')
  calls = []
  winState.visible = false // 模拟「页面始终没让它显示」
  winState.alwaysOnTop = true
  auto[0].fn()
  globalThis.clearTimeout(auto[0].handle)
  assert.ok(calls.filter((c) => c.m === 'show').length >= 1, '看不见时才 show')
  assert.ok(topmostCalls().length >= 1, 'show() 之后必须重申，否则坏状态会一直挂着')
  winState.visible = true
})
