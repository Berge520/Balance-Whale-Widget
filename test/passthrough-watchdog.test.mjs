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

test('页面：看门狗在「窗口该穿透」时都探头，不按穿透开关门槛', () => {
  const at = page.indexOf('function probeCursorSoon()')
  assert.ok(at >= 0, '找不到 probeCursorSoon')
  const block = page.slice(at, at + 700)
  // 两种模式下窗口的闲置态都是穿透（启动即 sendIgnoreMouse(true)），而 passThrough 默认 false；
  // 旧写法 `!passThroughOn || …` 把默认配置下卡在 0x20 的窗口排除在救援之外
  // （真机症状：『鼠标穿透』没勾、点鲸鱼没反应）
  assert.match(block, /if \(lastIgnoreSent !== true && !btnVisible\) return;/)
  assert.doesNotMatch(block, /!passThroughOn/)
  assert.match(block, /menuOpen/)
  assert.match(block, /drag\.active/)
})

test('页面：按钮亮着但窗口可交互时也要放行探测（菜单关闭后无 pointermove 自愈）', () => {
  const at = page.indexOf('function probeCursorSoon()')
  assert.ok(at >= 0, '找不到 probeCursorSoon')
  const block = page.slice(at, at + 700)
  // 菜单动作 / Esc 关菜单后没有 pointermove 送达时，按钮停在显示态；
  // 窗口此刻 lastIgnoreSent === false，只判这一项会把最需要自愈的处境排除掉
  assert.match(block, /menuBtn\.classList\.contains\('dshwv-menu-btn-visible'\)/,
    '看门狗没看按钮是否还亮着：可交互态的按钮残留无人清理')
  assert.match(block, /lastIgnoreSent === false/)
  // 仍然是既有 2.5s 周期，不许为这条另起定时器
  assert.match(page, /setInterval\(probeCursorSoon,\s*2500\)/)
})

test('页面：闲置态在两种穿透模式下都是穿透（看门狗门槛的依据）', () => {
  // 关掉「鼠标穿透」只影响悬停接管的时机（关 = 立即接管，开 = 驻留 1.2s），
  // 不改变闲置态；故窗口样式位在两种模式下都可能带 WS_EX_TRANSPARENT
  assert.match(page, /sendIgnoreMouse\(true\); \/\/ 初始全穿透/)
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
  const block = page.slice(at, at + 1200)
  // 隐藏态没有可点的鲸鱼；问了反而可能在不可见时把 ignore=false 接管上，
  // 重新显示后先吞一次点击。重新可见的补问由 visibilitychange 负责
  assert.match(block, /if \(document\.hidden\) return;/)
  assert.match(page, /visibilitychange/)
})

test('页面：启动 350ms 的一次性探测也必须跳过隐藏态', () => {
  const at = page.indexOf('}, 350);')
  assert.ok(at >= 0, '找不到启动 350ms 的一次性光标探测')
  const block = page.slice(Math.max(0, at - 500), at)
  // 与 probeCursorSoon 同一守卫：隐藏态不探测，否则可能在不可见时接管上 ignore=false，
  // 重新显示后先吞一次点击；可见时的首次探测与 visibilitychange 补问都不能被破坏
  assert.match(block, /if \(document\.hidden\) return/)
  assert.match(block, /whaleApi\.probeCursor\(\)/)
})
