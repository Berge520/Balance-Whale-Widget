// test/focus-todo-hub.test.mjs
// 挂件「专注」枢纽：一个组承载今日 / 当前 / 待办 / 计时；顺序、摘要、入口都钉在这里。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../public/floating.css', import.meta.url), 'utf8')
const block = (src, start, end) => {
  const from = src.indexOf(start)
  assert.ok(from >= 0, `找不到 ${start}`)
  const to = src.indexOf(end, from)
  assert.ok(to > from, `找不到 ${end}`)
  return src.slice(from, to)
}

test('合并组顺序固定', () => {
  const body = block(page, 'groupFocus.body.appendChild(focusStatsEl)', 'menuBox.appendChild(groupFocus.el)')
  const order = [...body.matchAll(/groupFocus\.body\.appendChild\(([^)]+)\)/g)].map((m) => m[1].trim())
  assert.deepEqual(order, [
    'focusStatsEl', 'rowTimerStatus', 'rowTimerConfirm', 'todoBlock',
    'rowTimer', 'rowTimerQuick', 'rowTimerDown', 'rowTimerAt', 'rowTimerPeekHint', 'rowTimerFoot',
  ])
})

test('待办块包在 todoBlock 里，清除按钮按已完成数量显隐', () => {
  assert.match(page, /var todoBlock = document\.createElement\('div'\)/)
  assert.match(page, /todoBlock\.appendChild\(rowTodoAdd\)/)
  assert.match(page, /todoBlock\.appendChild\(todoListEl\)/)
  assert.match(page, /todoBlock\.appendChild\(rowTodoFoot\)/)
  const render = block(page, 'function renderTodoMenu', '// dsh 状态渲染')
  assert.match(render, /todoClearDoneBtn\.style\.display = doneN > 0 \? '' : 'none'/)
  assert.match(render, /清除已完成（/)
})

test('折叠摘要：进行中带任务名、空闲有清单、纯计时保留默认时长', () => {
  const body = block(page, 'function refreshMenuSummaries', 'function renderFocusStats')
  assert.match(body, /timerSum \+= ' · ' \+ focusText/)
  assert.match(body, /todoLeft \+ ' 项'/)
  assert.match(body, /'默认 '/)
  assert.match(body, /syncFocusGroupChrome\(\)/)
})

test('今日统计压成今日行 + 一行元信息', () => {
  const body = block(page, 'function renderFocusStats', 'function renderTodoMenu')
  assert.match(body, /dshwv-focus-meta/)
  assert.match(body, /近 ' \+ \(Number\(focusSummary\.days\) \|\| 7\) \+ ' 天/)
  assert.doesNotMatch(body, /groupFocus\.setTitle/, '标题改由 syncFocusGroupChrome 负责')
})

test('当前行：进行中显示任务 + 暂停/重置，空闲有专注项显示开始', () => {
  assert.match(page, /timerStatusTask/)
  assert.match(page, /timerCurrentBtn/)
  const fn = block(page, 'function updateTimerStatus', 'function syncTimerMenu')
  assert.match(fn, /var idleFocus = !busy && !timerFinished && !!focusItem/)
  assert.match(fn, /timerStatusTask\.textContent/)
  assert.match(fn, /timerCurrentBtn\.textContent = timerRunning \? '暂停' : '继续'/)
  assert.match(fn, /timerCurrentBtn\.textContent = '开始'/)
})

test('放弃确认行紧跟当前行，出现时滚动到可见', () => {
  assert.match(page, /groupFocus\.body\.appendChild\(rowTimerStatus\);\s*\n\s*groupFocus\.body\.appendChild\(rowTimerConfirm\)/)
  const fn = block(page, 'function syncTimerConfirm', 'function cancelTimerConfirm')
  assert.match(fn, /scrollIntoView\(\{ block: 'nearest' \}\)/)
  assert.match(fn, /var wasShown = rowTimerConfirm\.style\.display !== 'none'/)
})

test('CSS：专注元信息行有浅/深/幻想三套配色', () => {
  assert.match(css, /\.dshwv-focus-meta\s*\{/)
  assert.match(css, /html\.dark \.dshwv-focus-meta/)
  assert.match(css, /html\.fantasy \.dshwv-focus-meta/)
})
