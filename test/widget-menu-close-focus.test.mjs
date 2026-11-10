/*
 * 菜单「用按钮关闭」必须走 closeMenu 的交还链路（node --test，零依赖）。
 *
 * 真机取证（2026-10-31）：开菜单有「菜单输入焦点 借出 + 窗口样式已重申」，置顶位能安回来；
 * 但点 menuBtn 关菜单后 TOPMOST 掉成 False 且日志**没有**「交还」。根因在页面：
 * toggleMenu 的开→关分支只把 menuOpen 翻假、跳过打开块，却不调 closeMenu() ——
 * 于是 whale:input-focus(false) 不发，宿主 setFocusable(false)+ensureWindowStyles() 不跑，
 * 焦点一直借著、置顶/任务栏两位掉了没人安（顺带 resetHideBtn/cancelTimerConfirm 也被跳过）。
 *
 * 这里钉住修复后的形态：
 *  - toggleMenu 的非拖拽关闭分支必须路由到 closeMenu() 并 return；
 *  - closeMenu 必须交还焦点（setInputFocus(false)）；
 *  - 宿主 input-focus 的交还分支必须重申窗口样式（ensureWindowStyles）。
 *
 * ⚠️ 只读源码做契约断言（与 widget-zoom-guard.test.mjs 同口径），不启动浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

const page = read('public/floating-page.js')
const ipc = read('public/preload/lib/ipc.js')

function toggleMenuSource() {
  const start = page.indexOf('function toggleMenu()')
  assert.ok(start >= 0, '找不到 toggleMenu，解析规则可能已失效')
  const end = page.indexOf('function closeMenu()', start)
  assert.ok(end > start, '找不到 closeMenu 边界，解析规则可能已失效')
  return page.slice(start, end)
}

function closeMenuSource() {
  const start = page.indexOf('function closeMenu()')
  assert.ok(start >= 0, '找不到 closeMenu')
  const end = page.indexOf('window.addEventListener(\'keydown\'', start)
  assert.ok(end > start, '找不到 closeMenu 收尾，解析规则可能已失效')
  return page.slice(start, end)
}

test('toggleMenu 的开→关分支必须路由到 closeMenu（否则焦点不交还、置顶不重申）', () => {
  const body = toggleMenuSource()
  // 拖拽兜底里那句无括号的 closeMenu 不算：这里要的是「非拖拽关闭」的带 return 守卫
  assert.match(body, /if \(menuOpen\) \{\s*closeMenu\(\);\s*return;\s*\}/,
    'toggleMenu 关闭分支没走 closeMenu：setInputFocus(false) 不发，宿主不重申置顶/任务栏')
  // 不允许再用「翻假后跳过打开块」的旧形态（它正是漏掉交还的那条）
  assert.ok(!/menuOpen = !menuOpen/.test(body),
    'toggleMenu 仍用 menuOpen=!menuOpen 翻转：关闭分支会跳过 closeMenu 的交还链路')
})

test('closeMenu 必须交还输入焦点（setInputFocus(false)）', () => {
  assert.match(closeMenuSource(), /setInputFocus\(false\)/,
    'closeMenu 没交还焦点：挂件一直占着焦点，设置窗会失焦自动隐藏')
})

test('closeMenu 收尾必须统一重算菜单按钮显隐（点链接 / Esc / 再点按钮都不必各自补）', () => {
  // 菜单开着时 applyMenuBtn 恒为「显」，关菜单的各条路径漏补任何一条，
  // 按钮就会停在强显态；而窗口此刻仍可交互，没有 pointermove 就永不复位
  assert.match(closeMenuSource(), /applyMenuBtnAtLast\(\)/,
    'closeMenu 没重算按钮显隐：点菜单链接 / Esc 关菜单后按钮会残留')
})

test('applyMenuBtnAtLast 无坐标时必须隐藏，不能空操作', () => {
  const start = page.indexOf('function applyMenuBtnAtLast()')
  assert.ok(start >= 0, '找不到 applyMenuBtnAtLast')
  const end = page.indexOf('function forceShowMenuBtn()', start)
  assert.ok(end > start, '找不到 applyMenuBtnAtLast 收尾，解析规则可能已失效')
  const body = page.slice(start, end)
  // 旧实现 else applyMenuBtn(null) 是空操作：关菜单 / 配置变更后按钮停在最后一次的显示态
  assert.ok(!/else applyMenuBtn\(null\)/.test(body), '无坐标分支仍走空操作的 applyMenuBtn(null)')
  assert.match(body, /remove\('dshwv-menu-btn-visible'\)/,
    '无坐标（lastHoverPt === null）时没移除 -visible：按钮不会自动收起')
})

test('窗口级退出与宿主 force-pass 路径仍然移除按钮（回归）', () => {
  const leaveAt = page.indexOf('function onWindowPointerLeave(e)')
  assert.ok(leaveAt >= 0, '找不到 onWindowPointerLeave')
  const leaveEnd = page.indexOf('}', page.indexOf('sendIgnoreMouse(true)', leaveAt))
  const leave = page.slice(leaveAt, leaveEnd)
  assert.match(leave, /remove\('dshwv-menu-btn-visible'\)/,
    'pointerleave 兜底不再移除按钮：指针离开窗口后按钮会常亮')

  const forceAt = page.indexOf('whaleApi.onForcePass(')
  assert.ok(forceAt >= 0, '找不到 onForcePass 收尾')
  const forceEnd = page.indexOf('});', forceAt)
  const force = page.slice(forceAt, forceEnd)
  assert.match(force, /remove\('dshwv-menu-btn-visible'\)/,
    'whale:force-pass 收尾不再移除按钮：强制穿透后按钮会残留')
})

test('宿主 input-focus 交还分支必须重申窗口样式（置顶 + 任务栏）', () => {
  const start = ipc.indexOf("ipcRenderer.on('whale:input-focus'")
  assert.ok(start >= 0, '找不到 whale:input-focus 监听器')
  const end = ipc.indexOf('ipcRenderer.on(', start + 10)
  const block = end > start ? ipc.slice(start, end) : ipc.slice(start)
  assert.match(block, /ensureWindowStyles\(\)/,
    'input-focus 切换后没重申窗口样式：setFocusable 重登记会把置顶/任务栏两位冲掉')
})