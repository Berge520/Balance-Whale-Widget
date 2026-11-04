// test/passthrough-watchdog.test.mjs
// 穿透态死锁的两道兜底：页面侧光标探测看门狗 + 宿主侧重申穿透态。
//
// 真机实证：挂件窗口卡在 WS_EX_TRANSPARENT(0x20) 时页面拿不到任何鼠标事件，
// 悬停不出 ☰、点击/右键全无响应；外部清掉 0x20 立即恢复。
// 根因是恢复路径全靠 pointermove 驱动，而 probeCursor 只在启动 350ms 问过一次；
// 宿主侧 ensureWindowStyles 只重申置顶/任务栏，从不重申 setIgnoreMouseEvents（forward 钩子）。
// 这里把两条兜底钉住，防止以后被「优化」掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const page = read('public/floating-page.js')
const widget = read('public/preload/lib/widget.js')

test('页面：光标探测不是一次性 —— 有低频看门狗', () => {
  assert.match(page, /function probeCursorSoon\(\)/)
  assert.match(page, /setInterval\(probeCursorSoon,\s*\d+\)/, '缺少周期探测：卡死后再没人补 pointermove')
})

test('页面：看门狗只在穿透待命时探头，不干扰接管/菜单/拖拽', () => {
  const at = page.indexOf('function probeCursorSoon()')
  assert.ok(at >= 0, '找不到 probeCursorSoon')
  const block = page.slice(at, at + 400)
  assert.match(block, /if \(!passThroughOn \|\| passHoverActive\) return;/)
  assert.match(block, /menuOpen/)
  assert.match(block, /drag\.active/)
})

test('页面：失焦 / 获焦 / 重新可见时立刻补问一次', () => {
  assert.match(page, /addEventListener\('focus', probeCursorSoon\)/)
  assert.match(page, /addEventListener\('blur', probeCursorSoon\)/)
  assert.match(page, /visibilitychange[\s\S]{0,120}probeCursorSoon/)
})

test('宿主：重申窗口样式必须一起重申穿透态（forward 钩子）', () => {
  const at = widget.indexOf('function ensureWindowStyles()')
  assert.ok(at >= 0, '找不到 ensureWindowStyles')
  const block = widget.slice(at, at + 200)
  assert.match(block, /reassertIgnoreMouse\(\)/, 'ensureWindowStyles 漏了穿透重申：钩子被摘掉后没人装回来')
})

test('宿主：穿透下发也走统一出口（catch 写回存储缓存后要能重试）', () => {
  const at = widget.indexOf('function applyIgnoreMouse(')
  assert.ok(at >= 0, '找不到 applyIgnoreMouse')
  const block = widget.slice(at, at + 500)
  assert.match(block, /ensureWindowStyles\(\)/)
  assert.doesNotMatch(block, /setIgnoreMouseEvents\(/, '直接下发会漏掉置顶/任务栏的紧跟重申')
})

test('宿主：重申跳过旧窗口的缓存值（新窗口必须由页面重新下发）', () => {
  const at = widget.indexOf('function reassertIgnoreMouse()')
  assert.ok(at >= 0, '找不到 reassertIgnoreMouse')
  const block = widget.slice(at, at + 400)
  assert.match(block, /ignoreMouseWin !== win/)
  assert.match(block, /setIgnoreMouseEvents\(ignoreMouseVal,\s*\{\s*forward:\s*true\s*\}\)/)
})

test('页面：挂件隐藏时不发光标探测', () => {
  const at = page.indexOf('function probeCursorSoon()')
  assert.ok(at >= 0, '找不到 probeCursorSoon')
  const block = page.slice(at, at + 500)
  // 隐藏态没有可点的鲸鱼；问了反而可能在不可见时把 ignore=false 接管上，
  // 重新显示后先吞一次点击。重新可见的补问由 visibilitychange 负责
  assert.match(block, /if \(document\.hidden\) return;/)
  assert.match(page, /visibilitychange/)
})
