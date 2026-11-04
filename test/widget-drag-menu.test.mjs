/*
 * 拖拽与设置菜单的互斥契约（node --test，零依赖）。
 *
 * 拖拽期间菜单应当是「不存在」的：
 *  - 菜单一旦展开会挡住鲸鱼，拖动中持续派发 pointermove，窗口被拖着走、菜单也跟着挪，
 *    既看不清又容易误点；
 *  - 右键唤菜单已在 contextmenu 里挡掉，但第二根手指点菜单按钮（触控）/ 其它调用点
 *    仍可能把菜单打开 —— 统一在 toggleMenu 入口兜底，比逐个调用点补判据可靠。
 *
 * 另一条是「拖拽开始时关掉已经打开的菜单」：按下鲸鱼既关菜单又照常开始拖拽
 * （否则得先点一下关菜单、再点一下才能拖）。这条顺序不能反 —— 先建 drag 再 closeMenu
 * 的话，closeMenu 里的焦点交还/穿透重算会插进拖拽起点。
 *
 * ⚠️ 只读源码做契约断言（与 build-gates.test.mjs 同口径），不启动浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')

// 取顶层（IIFE 内两空格缩进）函数体：从 `function name(` 到下一个两空格收尾的 `}`
function functionBody(name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\) \\{([\\s\\S]*?)\\n {2}\\}')
  const m = page.match(re)
  assert.ok(m, `找不到 ${name}()，解析规则可能已失效`)
  return m[1]
}

test('拖拽中打开菜单被统一挡掉（toggleMenu 入口守卫）', () => {
  const body = functionBody('toggleMenu')
  assert.match(body, /if \(drag && drag\.active\)/,
    'toggleMenu 没有拖拽守卫：触控第二根手指点按钮等调用点仍能在拖拽中弹出菜单')
})

test('拖拽中若菜单已经开着，守卫会把它关掉', () => {
  const body = functionBody('toggleMenu')
  const guard = body.match(/if \(drag && drag\.active\) \{([\s\S]*?)\n {4}\}/)
  assert.ok(guard, '拖拽守卫应是带分支的形式（需要在里面关掉已开的菜单）')
  assert.match(guard[1], /closeMenu\(\)/, '拖拽中菜单若开着必须收起，不能留给拖拽结束')
})

test('拖拽开始：先关菜单，再建 drag 会话', () => {
  const body = functionBody('onDocPointerDown')
  const menuAt = body.indexOf('closeMenu()')
  const dragAt = body.indexOf('drag = { active: true')
  assert.ok(menuAt >= 0, '按下鲸鱼时应关掉已打开的菜单')
  assert.ok(dragAt >= 0, '找不到拖拽会话创建点')
  assert.ok(menuAt < dragAt, '必须先 closeMenu 再建立 drag：反过来关菜单的焦点交还/穿透重算会插进拖拽起点')
})
