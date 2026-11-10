/*
 * 专注统计窗口（近 N 天）只能有一个真源。
 *
 * 背景：P2 收尾核对时发现「7 天」散成多份 —— widget.js 的 FOCUS_STATS_DAYS、
 * settings.js 两个服务的 `|| 7` 兜底、FocusView 的 STAT_DAYS 等；
 * 「90 天」两份（constants.js 的 FOCUS_KEEP_DAYS 与 FocusView 的 KEEP_DAYS）。
 *
 * **v1.16 起设置页的专注统计层整体下线**：柱图、明细、今日摘要都不再渲染，
 * FocusView 里的 STAT_DAYS / KEEP_DAYS 副本随之删除，check-shared 的两条校验也一并撤掉
 * （已无跨文件副本可比）。宿主侧 constants.js 的 FOCUS_STATS_DAYS / FOCUS_KEEP_DAYS 仍留给
 * focus.js / focusStatsPayload 使用（数据不丢，日后可接回），因此仍需「真源只有一个」。
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

test('设置页不再留统计窗口副本（统计层已下线）', () => {
  const code = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
  absent(code, 'STAT_DAYS', 'FocusView 还留着 STAT_DAYS 副本')
  absent(code, 'KEEP_DAYS', 'FocusView 还留着 KEEP_DAYS 副本')
  absent(code, 'focusSessions', 'FocusView 还在拉明细')
})

test('check-shared 不再钉这两条（设置页副本已删，无跨文件一致性可比）', () => {
  absent(gate, "name: '专注统计窗口 FOCUS_STATS_DAYS'", '闸门还留着已无副本的窗口校验')
  absent(gate, "name: '专注保留上限 FOCUS_KEEP_DAYS'", '闸门还留着已无副本的保留上限校验')
})
