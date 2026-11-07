/*
 * 宿主侧穿透兜底（光标在窗口外 → 强制穿透）的判据与限频单测。
 *
 * 判据本体在 public/preload/lib/util.js（纯函数叶子，零依赖：insideRect / shouldForcePass / reassertDue）；
 * 这里既直接测那三个实现，也钉住 widget.js / floating-page.js 的接线，
 * 防止「只留判据、没人调用」或「每 tick 都重登记窗口样式」这类回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const G = require('../public/preload/lib/util.js')

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const widget = read('public/preload/lib/widget.js')
const page = read('public/floating-page.js')

const B = { x: 100, y: 100, width: 200, height: 150 }

test('insideRect：左闭右开，四条边与矩形外各取一点', () => {
  assert.equal(G.insideRect({ x: 100, y: 100 }, B), true, '左上角属于矩形内')
  assert.equal(G.insideRect({ x: 299, y: 249 }, B), true, '右下角内侧仍算内')
  assert.equal(G.insideRect({ x: 300, y: 200 }, B), false, '右边恰在 x+width 上，按左闭右开算外')
  assert.equal(G.insideRect({ x: 200, y: 250 }, B), false, '下边恰在 y+height 上，算外')
  assert.equal(G.insideRect({ x: 99, y: 200 }, B), false, '左外侧')
  assert.equal(G.insideRect({ x: 200, y: 99 }, B), false, '上外侧')
})

test('insideRect：坐标缺失/非法一律按「不在内」（拿不到证据就不能宣布接管）', () => {
  assert.equal(G.insideRect(null, B), false)
  assert.equal(G.insideRect({ x: 200, y: 200 }, null), false)
  assert.equal(G.insideRect({ x: undefined, y: 200 }, B), false)
  assert.equal(G.insideRect({ x: 200, y: 200 }, { x: 0, y: 0, width: NaN, height: 1 }), false)
  assert.equal(G.insideRect({ x: Infinity, y: 200 }, B), false)
  // 指针取不到（null）时必须维持穿透，而不是把窗口改成可交互
  assert.equal(G.shouldForcePass(null, B), true)
  assert.equal(G.shouldForcePass(undefined, B), true)
})

test('shouldForcePass：只对「不在窗口矩形内」返回 true', () => {
  assert.equal(G.shouldForcePass({ x: 200, y: 200 }, B), false, '窗口内归页面判定，宿主不得插手')
  assert.equal(G.shouldForcePass({ x: 0, y: 0 }, B), true, '窗口外')
  assert.equal(G.shouldForcePass({ x: -500, y: 900 }, B), true, '副屏负坐标也算外')
})

test('reassertDue：首次放行，限频间隔内拒绝，满间隔放行', () => {
  assert.equal(G.reassertDue(10, 0, 2500), true, 'lastAt<=0 表示从没重申过：第一拍必须能重申')
  assert.equal(G.reassertDue(2600, 100, 2500), true, '恰好满间隔')
  assert.equal(G.reassertDue(2599, 100, 2500), false, '差 1ms 不放行')
  assert.equal(G.reassertDue(100, 10, 2500), false)
  assert.equal(G.reassertDue(NaN, 100, 2500), false, '时间取不到时宁可不动')
})

test('宿主：watchTick 每拍都先跑光标兜底，且不依赖「自动避让任务栏」开关', () => {
  const at = widget.indexOf('function watchTick()')
  assert.ok(at >= 0, '找不到 watchTick')
  const block = widget.slice(at, at + 500)
  assert.match(block, /cursorGuardTick\(\)/, '250ms 这一拍必须承载穿透兜底')
  assert.ok(block.indexOf('cursorGuardTick()') < block.indexOf('if (!watchTaskbarOn) return'),
    '兜底要排在避让开关判断之前，否则关掉避让就跟着停摆')
})

test('宿主：定时器启动只要求窗口活着（避让开关只决定跑不跑避让部分）', () => {
  const at = widget.indexOf('function syncTaskbarWatch()')
  assert.ok(at >= 0, '找不到 syncTaskbarWatch')
  const block = widget.slice(at, at + 900)
  assert.match(block, /const alive = winAlive\(\)/)
  assert.match(block, /const on = readConfig\(\)\.avoidTaskbar !== false/)
  assert.match(block, /watchTaskbarOn = on/)
  assert.match(block, /if \(alive && !watchTimer\)/, '定时器不能再看避让开关')
})

test('宿主：兜底只强制穿透、绝不下发「可交互」', () => {
  const at = widget.indexOf('function cursorGuardTick()')
  assert.ok(at >= 0, '找不到 cursorGuardTick')
  const block = widget.slice(at, widget.indexOf('function watchTick()'))
  assert.match(block, /utools\.getCursorScreenPoint\(\)/)
  assert.match(block, /win\.getBounds\(\)/)
  assert.match(block, /shouldForcePass\(p, b\)/)
  assert.match(block, /applyIgnoreMouse\(true\)/)
  assert.doesNotMatch(block, /applyIgnoreMouse\(false\)/, '窗口内归页面判定，宿主不能反向夺权')
  assert.match(block, /if \(dragFrozen\) return/, '拖拽中强推穿透会掐断 pointerup')
})

test('宿主：值没变时的重申受 2.5s 限频，且走统一样式重申入口', () => {
  assert.match(widget, /const CURSOR_REASSERT_MS = 2500/)
  const at = widget.indexOf('function cursorGuardTick()')
  const block = widget.slice(at, widget.indexOf('function watchTick()'))
  assert.match(block, /reassertDue\(now, cursorAssertAt, CURSOR_REASSERT_MS\)/)
  assert.match(block, /ensureWindowStyles\(\)/, '重申必须连带补回置顶/跳任务栏')
  assert.doesNotMatch(block, /setInterval/, '不能自己再加一条定时器')
})

test('宿主：强制穿透后要回告页面，避免页面去重缓存与实际值错位', () => {
  const at = widget.indexOf('function cursorGuardTick()')
  const block = widget.slice(at, widget.indexOf('function watchTick()'))
  assert.match(block, /sendToWidget\('whale:force-pass'\)/)
})

test('页面：收到 force-pass 后把去重缓存对齐到 true，并按离开收尾', () => {
  const at = page.indexOf('whaleApi.onForcePass(')
  assert.ok(at >= 0, '页面没有注册 force-pass 回调')
  const block = page.slice(at, at + 700)
  assert.match(block, /lastIgnoreSent = true/)
  assert.match(block, /passHoverActive = false/)
  assert.match(block, /if \(menuOpen\) closeMenu\(\)/)
  assert.match(block, /lastHoverPt = null/)
  assert.doesNotMatch(block, /sendIgnoreMouse\(/, '宿主已经落过 true，这里只对齐缓存，不必再发一次 IPC')
})

test('preload：桥接暴露了 onForcePass', () => {
  const bridge = read('public/preload/floating.js')
  assert.match(bridge, /onForcePass\(cb\)/)
})

test('收尾：临时排查日志一条都不能留在最终改动里', () => {
  for (const src of [page, widget, read('public/preload/lib/ipc.js'), read('public/preload/floating.js')]) {
    assert.doesNotMatch(src, /tmpLog|tmpWhy|tmpSrc|tmpSkipAt|tmpMoveN|\[whale\]\[tmp\]/)
    assert.doesNotMatch(src, /\bTMP\b/)
  }
})
