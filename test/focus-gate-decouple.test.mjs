import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const view = read('src/views/FocusView.vue')
const page = read('public/floating-page.js')
const block = (src, start, end) => {
  const from = src.indexOf(start)
  assert.ok(from >= 0, `找不到 ${start}`)
  const to = src.indexOf(end, from)
  assert.ok(to > from, `找不到 ${end}`)
  return src.slice(from, to)
}

test('设置页：设为专注 / 专注中不再受 focusOn 门控', () => {
  assert.doesNotMatch(view, /v-if="cfg\.focusOn && todo\.focusId/, '专注中标签仍被 focusOn 门控')
  assert.doesNotMatch(view, /<button v-if="cfg\.focusOn"[\s\S]{0,120}@click="toggleFocus/, '设为专注按钮仍被 focusOn 门控')
  assert.doesNotMatch(view, /开启上方「专注记录」后才能设为专注/, '旧提示还在')
  // 今日轮数是统计，focusOn 关时不该再挂旧数据
  assert.match(view, /v-if="cfg\.focusOn && todayRoundsOf\(it\.id\) > 0"/, '今日轮数徽标仍不受 focusOn 门控')
})

test('挂件：气泡尾注不再受 focusOn 门控', () => {
  const fn = block(page, 'function withFocusTail', '\n  }')
  assert.doesNotMatch(fn, /if \(!focusOn\) return s/, '尾注仍被 focusOn 门控')
  assert.match(fn, /todoFocusText\(\)/)
})

test('挂件：待办的开始按钮不再受 focusOn 门控', () => {
  const fn = block(page, 'function todoRow', '\n  function renderTodoMenu')
  assert.doesNotMatch(fn, /if \(!it\.done && focusOn\)/, '开始按钮仍被 focusOn 门控')
  assert.match(fn, /if \(!it\.done\) \{/, '开始按钮应只看是否完成')
})

test('挂件：到点「完成这条」不再受 focusOn 门控', () => {
  const fn = block(page, 'function updateTimerActions', '\n  function positionTimerActions')
  assert.doesNotMatch(fn, /focusOn && !timerIsBreak/, '完成这条仍被 focusOn 门控')
  assert.match(fn, /!timerIsBreak && todoFocusText\(\)/)
})
