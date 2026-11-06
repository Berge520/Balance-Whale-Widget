/*
 * 隐藏态「不取光标」契约单测（node --test，零依赖）。
 *
 * 背景：任务栏轮询（widget.js watchTick，250ms）为了识别「自动隐藏的任务栏此刻是否弹出」
 * 必须问 utools.getCursorScreenPoint()。但挂件不可见时（最小化 / 显示桌面 / 切虚拟桌面 /
 * 被 uTools 连带 hide）继续问没有意义：拿到的是过期坐标，还可能让挂件按错误的任务栏状态重摆。
 *
 * 可见性信号分两层：
 *   1. 原生 isVisible() / isMinimized() —— 只反映窗口自身显隐；Windows 上切虚拟桌面 /
 *      显示桌面时 isVisible() 不一定翻 false，不能单独依赖。
 *   2. 页面 document.hidden —— 子窗 preload 经 whale:widget-visibility 上报，
 *      覆盖上面那类页面级不可见。
 * 这里钉住四件事，改坏就红：
 *   - canSampleCursor 的纯函数语义（任一信号判不可见就跳过；信号缺失时不漏探测）；
 *   - setPageHidden 真的接进 nativeSamplingVisible（页面上报生效）；
 *   - watchTick 顶部真的调用了 nativeSamplingVisible（否则前面全是摆设）；
 *   - 页面侧 / IPC 侧的上报链路存在（visibilitychange + ipcRenderer.on）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-widget-cursor-vis-'))
const db = new Map()

globalThis.utools = {
  getPath: () => TMP,
  dbStorage: {
    getItem: (k) => (db.has(k) ? db.get(k) : null),
    setItem: (k, v) => { db.set(k, v) },
    removeItem: (k) => { db.delete(k) },
  },
  getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  createBrowserWindow: () => null,
  getWindowType: () => 'main',
  isDarkColors: () => false,
  showMainWindow: () => {},
  sendToParent: () => {},
}

const widget = require('../public/preload/lib/widget.js')
const { patchConfig } = require('../public/preload/lib/store.js')

// 关掉任务栏轮询：这组用例只测可见性判断，不需要 250ms 的 setInterval
patchConfig({ avoidTaskbar: false })

after(() => {
  widget.dispose()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const readSrc = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('canSampleCursor：三个信号都可见才采样', () => {
  assert.equal(widget.canSampleCursor({ visible: true, minimized: false, pageHidden: false }), true)
  assert.equal(widget.canSampleCursor({ visible: false }), false, '窗口 hide / 被连带隐藏 → 不采样')
  assert.equal(widget.canSampleCursor({ minimized: true }), false, '最小化 → 不采样（isVisible 在 Windows 上不保证翻 false）')
  assert.equal(widget.canSampleCursor({ pageHidden: true }), false, '页面级隐藏（显示桌面 / 虚拟桌面）→ 不采样')
})

test('canSampleCursor：信号缺失时按可见处理，不因 API 缺失漏探测', () => {
  assert.equal(widget.canSampleCursor({}), true)
  assert.equal(widget.canSampleCursor(null), true)
  assert.equal(widget.canSampleCursor({ visible: undefined, minimized: undefined, pageHidden: undefined }), true)
})

test('setPageHidden 接进 nativeSamplingVisible：页面上报隐藏后立即生效，恢复后立即恢复', () => {
  widget.destroyWidget()
  widget.setPageHidden(false)
  assert.equal(widget.nativeSamplingVisible(), true, '可见态应继续采样')
  widget.setPageHidden(true)
  assert.equal(widget.nativeSamplingVisible(), false, '页面上报 hidden=true 后必须停止采样')
  widget.setPageHidden(false)
  assert.equal(widget.nativeSamplingVisible(), true, '恢复可见后下一次 tick 就能采样，不能停在隐藏态')
})

test('窗口重建时清掉上一次的页面隐藏态（新页面会自己再推一次）', () => {
  widget.setPageHidden(true)
  assert.equal(widget.nativeSamplingVisible(), false)
  widget.destroyWidget()
  assert.equal(widget.nativeSamplingVisible(), true, '旧窗口的隐藏态不能带进新窗口')
})

test('watchTick 顶部用可见性守卫：隐藏时不进任务栏轮询（也就不取光标）', () => {
  const src = readSrc('public/preload/lib/widget.js')
  const at = src.indexOf('function watchTick()')
  assert.ok(at >= 0, '找不到 watchTick')
  const block = src.slice(at, at + 400)
  assert.match(block, /if \(!nativeSamplingVisible\(\)\) return/)
})

test('页面 preload：初始 + visibilitychange 都上报 document.hidden', () => {
  const src = readSrc('public/preload/floating.js')
  assert.match(src, /send\('whale:widget-visibility',\s*\{\s*hidden:\s*!!window\.document\.hidden\s*\}\)/)
  assert.match(src, /window\.document\.addEventListener\('visibilitychange', pushVisibility\)/)
  // 初始一次 + 页面生命周期兜底，且必须在 api 定义前就推（宿主越早拿到越不会在隐藏态多探一次）
  assert.match(src, /\npushVisibility\(\)/m)
  assert.match(src, /window\.addEventListener\('pageshow', pushVisibility\)/)
  assert.match(src, /window\.addEventListener\('pagehide', pushVisibility\)/)
})

test('宿主 IPC：监听 whale:widget-visibility 并落到 setPageHidden', () => {
  const src = readSrc('public/preload/lib/ipc.js')
  assert.match(src, /setPageHidden[,}]/ /* 已从 widget 解构 */)
  assert.match(src, /ipcRenderer\.on\('whale:widget-visibility'/)
  assert.match(src, /setPageHidden\(!!\(data && data\.hidden\)\)/)
})
