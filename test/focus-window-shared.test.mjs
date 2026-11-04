/*
 * 专注统计窗口（柱图 / 明细 / 挂件「近 N 天」）只能有一个真源。
 *
 * 背景：P2 收尾核对时发现「7 天」散成五份 —— widget.js 的 FOCUS_STATS_DAYS、
 * settings.js 两个服务的 `|| 7` 兜底、FocusView 的 STAT_DAYS 与 SESSION_DAYS；
 * 「90 天」两份（constants.js 的 FOCUS_KEEP_DAYS 与 FocusView 的 HEAT_DAYS）。
 * 柱图窗口与明细窗口**必须同值**：分组头的「N 轮 · M 分钟」取柱图那份天表，
 * 明细窗口一旦比它长，多出来的天就没有分组头数字；比它短则柱图有柱、明细没行。
 * 早先是两个独立常量，改一个忘另一个就是静默错账。
 *
 * 收敛口径：真源在宿主 constants.js（FOCUS_STATS_DAYS / FOCUS_KEEP_DAYS），
 * widget.js / settings.js 一律 require、不再留字面量；设置页拿不到 preload 常量
 * （不参与 Vite 打包），只留 STAT_DAYS / HEAT_DAYS 各一份副本，由 check-shared 钉住。
 * 这里按本仓对 .vue / 脚本的既有做法读源码做契约断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const constants = read('public/preload/lib/constants.js')
const widget = read('public/preload/lib/widget.js')
const settings = read('public/preload/lib/settings.js')
const view = read('src/views/FocusView.vue')
const gate = read('scripts/check-shared.mjs')

const absent = (src, needle, msg) => assert.ok(!src.includes(needle), msg)

test('真源在 constants.js：FOCUS_STATS_DAYS 定义并导出', () => {
  assert.match(constants, /const FOCUS_STATS_DAYS = 7/, 'constants.js 没有 FOCUS_STATS_DAYS 真源')
  assert.match(constants, /exports[\s\S]*FOCUS_STATS_DAYS|FOCUS_STATS_DAYS,/, 'FOCUS_STATS_DAYS 没有导出')
})

test('widget.js 不再自带窗口字面量，改 require 真源', () => {
  absent(widget, 'const FOCUS_STATS_DAYS = 7', 'widget.js 还留着一份窗口字面量')
  assert.match(widget, /FOCUS_STATS_DAYS/, 'widget.js 没有消费 FOCUS_STATS_DAYS')
})

test('settings.js 两个服务的兜底默认走真源，不再写 || 7', () => {
  const block = settings.slice(settings.indexOf('focusStats(days)'), settings.indexOf('onTodoChange(cb)'))
  absent(block, '|| 7', 'focusStats / focusSessions 的兜底还是字面量 7')
  assert.match(block, /FOCUS_STATS_DAYS/, '兜底默认没有走 FOCUS_STATS_DAYS')
})

test('FocusView 柱图与明细共用一个窗口常量（SESSION_DAYS 已并入 STAT_DAYS）', () => {
  absent(view, 'SESSION_DAYS', '明细窗口还是独立常量：改柱图窗口会静默漏掉分组头数字')
  assert.match(view, /focusSessions\?\.\(STAT_DAYS\)/, '明细没有跟柱图用同一个窗口')
  assert.match(view, /最近 \{\{ STAT_DAYS \}\} 天/, '明细标题的天数没有跟柱图同源')
})

test('check-shared 钉住设置页两份不可避免的副本', () => {
  assert.match(gate, /name: '专注统计窗口 FOCUS_STATS_DAYS'/, '闸门没有 FOCUS_STATS_DAYS 这条')
  assert.match(gate, /name: '专注保留上限 FOCUS_KEEP_DAYS'/, '闸门没有 FOCUS_KEEP_DAYS 这条')
  // 两条都必须同时抠宿主真源与设置页副本，只比宿主自己等于没比
  const win = gate.slice(gate.indexOf("name: '专注统计窗口 FOCUS_STATS_DAYS'"))
  const winBlock = win.slice(0, win.indexOf('\n  },'))
  assert.match(winBlock, /const FOCUS_STATS_DAYS/, '窗口校验没抠宿主真源')
  assert.match(winBlock, /const STAT_DAYS/, '窗口校验没抠设置页副本')
  const keep = gate.slice(gate.indexOf("name: '专注保留上限 FOCUS_KEEP_DAYS'"))
  const keepBlock = keep.slice(0, keep.indexOf('\n  },'))
  assert.match(keepBlock, /const FOCUS_KEEP_DAYS/, '保留上限校验没抠宿主真源')
  assert.match(keepBlock, /const HEAT_DAYS/, '保留上限校验没抠设置页副本')
})