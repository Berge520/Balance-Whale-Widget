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

test('合并组顺序固定：开始置顶，待办往下排（v1.16 起统计块已删）', () => {
  const body = block(page, 'groupFocus.body.appendChild(rowTimerQuick)', 'menuBox.appendChild(groupFocus.el)')
  const order = [...body.matchAll(/groupFocus\.body\.appendChild\(([^)]+)\)/g)].map((m) => m[1].trim())
  // v1.18：「最近计时」紧贴当前行之下（刚结束的一段挨着正在跑的一轮）
  assert.deepEqual(order, [
    'rowTimerQuick', 'rowTimer', 'rowTimerStatus', 'rowTimerHistory', 'rowTimerConfirm',
    'todoBlock', 'rowTimerDown', 'rowTimerAt', 'rowTimerPeekHint', 'rowTimerFoot',
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
  // v1.16：统计块删除后，摘要函数的下一个邻居不再是 renderFocusStats
  const body = block(page, 'function refreshMenuSummaries', 'function renderTodoMenu')
  assert.match(body, /timerSum \+= ' · ' \+ focusText/)
  assert.match(body, /todoLeft \+ ' 项'/)
  assert.match(body, /'默认 '/)
  assert.match(body, /syncFocusGroupChrome\(\)/)
})

test('专注统计块已下线：不再画今日行与元信息', () => {
  // v1.16：今日轮数 / 目标进度 / 连续天数 / 近 N 天整体删除，挂件只留待办本身
  assert.equal(page.indexOf('function renderFocusStats'), -1, 'renderFocusStats 应已删除')
  assert.equal(page.indexOf('dshwv-focus-meta'), -1, '专注统计的元信息行应已删除')
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
  // v1.18：当前行与放弃确认之间插了「最近计时」那一行，故顺序断言改为「当前行 → 最近计时 → 放弃确认」，
  // 仍然要求放弃确认在最后（它问的是「要不要放弃这一轮」，被别的行隔开就看不出是在问谁）
  assert.match(
    page,
    /groupFocus\.body\.appendChild\(rowTimerStatus\);\s*(?:\n\s*\/\/[^\n]*)*\s*\n\s*groupFocus\.body\.appendChild\(rowTimerHistory\);\s*\n\s*groupFocus\.body\.appendChild\(rowTimerConfirm\)/,
  )
  const fn = block(page, 'function syncTimerConfirm', 'function cancelTimerConfirm')
  assert.match(fn, /scrollIntoView\(\{ block: 'nearest' \}\)/)
  assert.match(fn, /var wasShown = rowTimerConfirm\.style\.display !== 'none'/)
})

test('CSS：专注相关样式里不残留统计层选择器', () => {
  // v1.16：.dshwv-focus-meta / -stats / -row / -value / -bar / -fill 三套配色随之删除，
  // 只留 .dshwv-focus-todo 的分隔虚线
  assert.match(css, /\.dshwv-focus-todo\s*\{/)
  for (const dead of ['focus-meta', 'focus-stats', 'focus-row', 'focus-value', 'focus-bar', 'focus-fill']) {
    assert.equal(css.indexOf('.dshwv-' + dead), -1, `floating.css 还留着 .dshwv-${dead}`)
  }
})
