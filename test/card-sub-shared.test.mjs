/*
 * 「计时 / 专注与待办」两张相邻卡与挂件菜单的**版式必须同源**（P2 界面融合）。
 *
 * 为什么盯着版式：同一款分区标题在本仓被抄了三份（App.vue 的 .sub、NotifyView 的 scoped
 * .sub、TimerView 的 scoped .timer-sub），而隔壁的「专注与待办」卡一份都没用 —— 于是
 * 计时卡能按标题跳区，专注卡是一堵墙；三份副本各自还能改出三种间距。挂件菜单同理：
 * 专注组的标签另起一套 .dshwv-focus-label（窄 18px、颜色浅一档、字号小一号），
 * 和计时 / 待办组的 .dshwv-menu-label 排在两列上，一眼就是「两个产品拼起来的」。
 *
 * 这里断言的是「同一个角色只允许一个 class」，比断言像素更稳：
 * ① 分区标题的规则只写在 main.css 的 .card-sub，各卡不许留 scoped 副本；
 * ② 专注卡要有分区标题，且顺序是「设置 → 统计 → 明细 → 待办」；
 * ③ 标题与它下面那行开关不许重名（同名会出现「待办清单 / [✓] 待办清单」的重复）；
 * ④ 挂件里标签行 / 说明行的 class 与设置页同理：menuLabel() 与 .dshwv-menu-hint 是唯一来源。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const css = read('src/main.css')
const view = read('src/views/FocusView.vue')
const timer = read('src/views/TimerView.vue')
const notify = read('src/views/NotifyView.vue')
const page = read('public/floating-page.js')
const pageCss = read('public/floating.css')

// 只取 <style> 段：模板里出现 class 名不算「留了规则副本」
const styleOf = (src) => {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src)
  return m ? m[1] : ''
}
// 模板区（<template> 到最后一个 </template>），用来数「标题实际用了几次」。
// 用 lastIndexOf：卡里有 <template v-if> 嵌套，非贪婪正则会停在第一个内层闭合标签上。
const templateOf = (src) => {
  const start = src.indexOf('<template>')
  const end = src.lastIndexOf('</template>')
  assert.ok(start >= 0 && end > start, '找不到 <template> 段')
  return src.slice(start, end)
}

test('分区标题的规则只有一份，写在 main.css 的 .card-sub', () => {
  assert.match(css, /^\.card-sub\s*\{/m, 'main.css 没有全局 .card-sub（唯一来源）')
  for (const [name, src] of [['TimerView.vue', timer], ['NotifyView.vue', notify], ['FocusView.vue', view]]) {
    const style = styleOf(src)
    assert.doesNotMatch(style, /\.(?:timer-)?sub\s*\{/, `${name} 还留了分区标题的 scoped 副本`)
  }
})

test('计时卡与专注卡的标题用同一个 class', () => {
  for (const [name, src, min] of [['计时卡', timer, 4], ['专注卡', view, 3]]) {
    // 允许在 .card-sub 后追加修饰类（如 card-sub-toggle 的折叠标题），仍算同一个共享 class
    const used = [...templateOf(src).matchAll(/class="card-sub(?=[\s"])/g)].length
    assert.ok(used >= min, `${name}的分区标题只有 ${used} 处，至少该有 ${min} 处`)
    // 卡里的 <h3> 一律走共享标题，不许再来一个私有 class
    const bareH3 = [...templateOf(src).matchAll(/<h3(?![^>]*class="card-sub(?=[\s"]))[^>]*>/g)]
    assert.equal(bareH3.length, 0, `${name}里有没挂 .card-sub 的 <h3>`)
  }
})

test('专注卡按「今日 → 待办 → 统计 → 明细」分区，顺序固定', () => {
  const tpl = templateOf(view)
  // 统计 / 明细是折叠分区，class 上多挂了 card-sub-toggle，故允许修饰类
  const heads = [...tpl.matchAll(/<h3 class="card-sub(?=[\s"])[^>]*>([^<]*)/g)].map((m) => m[1].trim())
  assert.deepEqual(heads, ['今日', '待办清单', '专注统计', '专注明细'], `专注卡分区标题不对：${heads.join(' / ')}`)
  // 明细标题自带范围（最近 N 天 · M 条），不再在列表里另起一个私有表头；
  // 折叠分区的三角紧跟在标题文字后，故 em 前允许一个 .fold-caret
  assert.match(tpl, /class="card-sub[^"]*"[^>]*>\s*专注明细<span class="fold-caret">[^<]*<\/span>\s*<em/, '专注明细的标题没并上范围行')
  assert.doesNotMatch(tpl, /focus-log-title|focus-log-head/, '明细区还留着自己的表头，和分区标题重复')
})

test('专注统计只留一行摘要（趋势并入），不再有独立回顾段', () => {
  const tpl = templateOf(view)
  assert.doesNotMatch(tpl, /reviewText|focus-review/, '独立回顾段应已删除')
  assert.doesNotMatch(view, /const reviewText = computed/, 'reviewText computed 应已删除')
  assert.doesNotMatch(styleOf(view), /\.focus-review\s*\{/, '孤儿样式 .focus-review 应已删除')
  assert.match(view, /trendText/, '摘要需要并入近 7 天趋势')
})

test('分区标题不和它下面的开关重名', () => {
  // 「待办清单」是标题，开关行说的是「挂件里显不显示」，两行同名读者会以为是两个开关
  assert.doesNotMatch(templateOf(view), /class="label">待办清单</, '开关标签与分区标题同名')
  assert.match(templateOf(view), /class="label">挂件里显示待办/, '待办开关没有改名成动作描述')
})

// floating-page.js 有 20 多万字符：断言失败时把整文件打出来会淹没输出，这里用 includes 判
const absent = (src, needle, msg) => assert.ok(!src.includes(needle), msg)

test('挂件：专注组的标签用共享的 menuLabel，不再另起一套列宽', () => {
  const start = page.indexOf('function renderFocusStats')
  const stats = page.slice(start, page.indexOf('function renderTodoMenu', start))
  assert.ok(start > 0 && stats.includes('menuLabel('), '专注统计没走共享的 menuLabel()：标签列宽/字色会和其它组跑偏')
  absent(stats, "className = 'dshwv-focus-label'", '专注组还在自己造标签元素')
  absent(pageCss, '.dshwv-focus-label {', 'floating.css 还留着 .dshwv-focus-label 副本')
  // 行的左右留白交给行自己（与 .dshwv-menu-row 同 inset），容器不再加一层缩进
  const rowRule = /\.dshwv-focus-row\s*\{[^}]*\}/.exec(pageCss)
  assert.ok(rowRule, '找不到 .dshwv-focus-row 规则')
  assert.match(rowRule[0], /padding:\s*4px 6px/, '专注行的左右留白和菜单行不同，标签会缩进一截')
  const wrapRule = /\.dshwv-focus-stats\s*\{[^}]*\}/.exec(pageCss)
  assert.ok(!wrapRule || !/padding:\s*[1-9]/.test(wrapRule[0]), '专注统计容器还在加缩进，和菜单行叠成两层')
})

test('挂件：空态说明行只有一套 class（灰底说明 + 蓝色引导）', () => {
  for (const dead of ['dshwv-focus-hint', 'dshwv-focus-subhint', 'dshwv-todo-hint', 'dshwv-todo-note']) {
    absent(page, `'${dead}'`, `页面还在用 ${dead}：同一角色两个 class`)
    absent(pageCss, `.${dead}`, `floating.css 还留着 .${dead} 副本`)
  }
  assert.match(pageCss, /\.dshwv-menu-hint-act\s*\{/, '缺共享的蓝色引导行规则 .dshwv-menu-hint-act')
  // 两个 class 各只在 helper 里出现一次，页面各处一律走 helper（和 menuLabel/menuRow 同构）
  assert.equal([...page.matchAll(/'dshwv-menu-hint'/g)].length, 1, '灰底说明行的 class 不该散在各处手写')
  assert.equal([...page.matchAll(/'dshwv-menu-hint-act'/g)].length, 1, '蓝色引导行的 class 不该散在各处手写')
  const gray = [...page.matchAll(/(?<!function )menuHint\(/g)].length
  const act = [...page.matchAll(/(?<!function )menuHintAct\(/g)].length
  assert.ok(gray >= 5, `灰底说明行至少 5 处（计时提示 + 专注空态 + 待办空态三行），实际 ${gray}`)
  assert.equal(act, 2, `蓝色引导行该 2 处（专注空态 + 待办空态），实际 ${act}`)
})
