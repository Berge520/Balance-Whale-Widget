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

test('设置页：待办行不挂常驻标签 / 开始按钮不再被总开关门控', () => {
  assert.doesNotMatch(view, /v-if="cfg\.todoOn && todo\.focusId/, '专注标签仍被总开关门控')
  // focusId 到点 / 暂停 / 打完卡都不清，任何常驻标签都会像「计时还在跑」——
  // v1.16 起彻底不挂标签，状态只靠行底色与按钮淡化暗示；到点自动打勾并把那条划掉（不删）
  assert.doesNotMatch(view, />当前任务</, '设置页不该再有「当前任务」标签')
  assert.doesNotMatch(view, />专注中</, '设置页不该再出现「专注中」标签')
  // v1.16 起待办行只留一个主操作「开始」（内含设为专注），不再有独立的「设为专注」按钮
  assert.doesNotMatch(view, /toggleFocus/, '独立的设为专注动作应已并入「开始」')
  assert.match(view, /@click="startTodo\(it\)"/, '主操作应为「开始」')
  assert.doesNotMatch(view, /v-if="cfg\.todoOn"[\s\S]{0,120}@click="startTodo/, '开始按钮仍被总开关门控')
  assert.doesNotMatch(view, /开启上方「专注记录」后才能设为专注/, '旧提示还在')
  // v1.16 专注统计层已下线：待办行不该再有「今日 N 轮」这类统计徽标
  assert.doesNotMatch(view, /todayRoundsOf/, '今日轮数徽标应随统计层一起移除')
})

test('设置页：「开始」一次调用就设专注 + 在挂件里起计时', () => {
  const fn = block(view, 'function startTodo', '\n\n// —— 每条待办自己的计时方式')
  assert.match(fn, /todoFocus\?\.\(it\.id, true\)/, '设专注与起计时应一次调用完成')
  assert.doesNotMatch(fn, /todoStartTimer/, '设置页不该自己投计时指令')
  const label = block(view, 'function startLabel', '\n}')
  assert.match(label, /tm === 'down' \|\| it\.tm === 'up'/, '只有配了计时的才叫「开始」')
  // 宿主：start=true 时才投 todo-start，且已专注的那条不再翻转成取消
  const host = read('public/preload/lib/settings.js')
  assert.match(host, /if \(start && res && res\.ok && key\)/, 'start 参数应门控计时指令')
  assert.match(host, /getWidgetCmd\(\)\('todo-start'/, '应投 todo-start 指令')
  assert.doesNotMatch(host, /st\.focusId === key \? '' : key/, '点「开始」不应再把专注翻成取消')
})

test('挂件：设置页投来的 todo-start 指令走同一条 startTodoTimer', () => {
  assert.match(page, /data\.cmd === 'todo-start'/, '缺少 todo-start 指令分支')
  const handler = block(page, "data.cmd === 'todo-start'", 'onBubblePreview')
  assert.match(handler, /startTodoTimer\(target\)/, '指令应复用菜单里的开始路径')
})

test('挂件：气泡尾注不再受总开关门控', () => {
  const fn = block(page, 'function withFocusTail', '\n  }')
  assert.doesNotMatch(fn, /if \(!todoOn\) return s/, '尾注仍被总开关门控')
  assert.match(fn, /todoFocusText\(\)/)
})

test('挂件：待办的开始按钮不再受总开关门控', () => {
  // 待办行的渲染实体 v1.17 起在 floating-todo-edit.js（行数棘轮），断言跟着搬过去
  const row = read('public/floating-todo-edit.js')
  const fn = block(row, 'function row(it, o)', '\n  window.WhaleTodoEdit')
  assert.doesNotMatch(fn, /if \(!it\.done && todoOn\)/, '开始按钮仍被总开关门控')
  assert.match(fn, /if \(!it\.done\) \{/, '开始按钮应只看是否完成')
})

test('挂件：到点「完成这条」不再受总开关门控', () => {
  const fn = block(page, 'function updateTimerActions', '\n  function positionTimerActions')
  assert.doesNotMatch(fn, /todoOn && !timerIsBreak/, '完成这条仍被总开关门控')
  assert.match(fn, /!timerIsBreak && todoFocusText\(\)/)
})
