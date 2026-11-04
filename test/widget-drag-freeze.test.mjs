/*
 * 宿主侧拖拽冻结回归（node --test，零依赖）。
 *
 * 盯的是「拖动时不由自主变大、大小描述却不变」的修复（v1.7.2）：拖拽会话期间
 * 任何缩放请求都不得改窗口尺寸，只记最后一个目标，drag-end 后由调用方补做。
 * applyScaleToWindow 是最终防线 —— 它兜着不经页面滚轮 handler 的路径
 * （设置页滑块 / 菜单 / whale:config 广播），删掉那个 dragFrozen 判据就会静默复发。
 *
 * 口径：
 *  1. 冻结期间 applyScaleToWindow（persist 两种）都不 setBounds / setPosition；
 *  2. 冻结期间 queueLiveScale 只记 pending，不落地；
 *  3. endDragSession 返回最后一个被冻结的目标；
 *  4. 解冻后同一个目标能真正改窗口尺寸（冻结不是丢弃）。
 *
 * 环境：utools 全桩（假窗口按名字记账），配置写内存 db + 本次专用临时目录。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-widget-drag-'))

const db = new Map()
let calls = []

function makeFakeWin() {
  const impl = {
    isDestroyed: () => false,
    isVisible: () => true,
    isAlwaysOnTop: () => true,
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
const { patchConfig } = require('../public/preload/lib/store.js')

// 任务栏轮询会干扰记账且拖慢用例，关掉
patchConfig({ avoidTaskbar: false })

after(() => {
  widget.dispose()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function open() {
  calls = []
  widget.destroyWidget()
  widget.ensureWidget({ focus: false })
  calls = []
}

const sizeCalls = () => calls.filter((c) => c.m === 'setBounds' || c.m === 'setSize' || c.m === 'setPosition')

test('冻结期间 applyScaleToWindow 两种 persist 都不动窗口', () => {
  patchConfig({ scale: 1, onTop: true })
  open()
  widget.beginDragSession()
  calls = []
  widget.applyScaleToWindow(2, true) // 设置页/广播那条路径
  widget.applyScaleToWindow(1.5, false) // 实时预览那条路径
  assert.deepEqual(sizeCalls(), [], '拖拽中改尺寸会与 setPosition 抢窗口，必须一律拒绝')
  assert.equal(widget.endDragSession(), 1.5, '冻结不是丢弃：留最后一个目标给 drag-end 补做')
})

test('冻结期间 queueLiveScale 只记 pending，不落地', () => {
  patchConfig({ scale: 1, onTop: true })
  open()
  widget.beginDragSession()
  calls = []
  widget.queueLiveScale(2.5)
  assert.deepEqual(sizeCalls(), [], '实时缩放不得在拖拽中 setBounds')
  assert.equal(widget.endDragSession(), 2.5)
})

test('解冻后同一个目标能真正改窗口尺寸（补做不落空）', () => {
  patchConfig({ scale: 1, onTop: true })
  open()
  widget.beginDragSession()
  widget.applyScaleToWindow(2, true)
  const pending = widget.endDragSession()
  assert.equal(pending, 2)
  calls = []
  widget.applyScaleToWindow(pending, true)
  assert.ok(calls.some((c) => c.m === 'setBounds'), '解冻后必须真的 setBounds，否则用户滚出来的大小不生效')
})
