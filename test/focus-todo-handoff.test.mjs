// test/focus-todo-handoff.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')
const block = (src, start, end) => {
  const from = src.indexOf(start)
  assert.ok(from >= 0, `找不到 ${start}`)
  const to = src.indexOf(end, from)
  assert.ok(to > from, `找不到 ${end}`)
  return src.slice(from, to)
}

test('完成这条进入接力：先取消自动衔接、标完成、不直接收起气泡', () => {
  const fn = block(page, "timerTodoBtn.addEventListener('click'", '\n  })')
  assert.match(fn, /cancelPomoAutoNext\(\)/)
  assert.match(fn, /enterHandoff\(it\)/)
  const after = fn.slice(fn.indexOf('enterHandoff(it)'))
  assert.doesNotMatch(after, /hideBubble\(\)/, '接力路径不应直接收起气泡')
})

test('接力状态与三行气泡', () => {
  assert.match(page, /var timerHandoff = null/)
  assert.match(page, /function enterHandoff\(/)
  assert.match(page, /'任务完成'/)
  assert.match(page, /'✓ ' \+ timerHandoff\.doneText/)
  assert.match(page, /'下一条：'/)
  assert.match(page, /待办已清空/)
})

test('动作条：开始下一条 / 休息 / 知道了，隐藏再来一轮与完成这条', () => {
  const fn = block(page, 'function updateTimerActions', 'function positionTimerActions')
  assert.match(fn, /if \(timerHandoff\)/)
  assert.match(fn, /timerNextBtn\.style\.display/)
  assert.match(fn, /timerAgainBtn\.style\.display = 'none'/)
  assert.match(fn, /timerTodoBtn\.style\.display = 'none'/)
  assert.match(fn, /timerDoneBtn/)
})

test('下一条回绕、点击时重取、tm 为空只设专注', () => {
  assert.match(page, /function nextUnfinishedTodo\(/)
  assert.match(page, /function startNextTodo\(/)
  assert.match(page, /timerNextBtn\.textContent = timerHandoff\.nextMode === '' \? '设为专注' : '开始下一条'/)
  assert.match(page, /whaleApi\.todoSend\(\{ op: 'focus', id: next\.id \}\)/)
})

test('失败校验与清理：超时检查完成态，离开接力清计时器', () => {
  assert.match(page, /function scheduleHandoffVerify\(/)
  assert.match(page, /function clearTimerHandoff\(/)
  const clear = block(page, 'function clearTimerHandoff', '\n  }')
  assert.match(clear, /clearTimeout\(handoffVerifyTimer\)/)
  assert.ok([...page.matchAll(/clearTimerHandoff\(\)/g)].length >= 3, 'start / reset / hide 都要清理')
})

test('下一条按原位置向后找：已完成条留在原位置也不跳到清单首条', () => {
  const fnSrc = block(page, 'function nextUnfinishedTodo', '\n  function todoTimerLabel')
  const make = new Function('todoState', fnSrc + '\nreturn nextUnfinishedTodo')
  const items = [
    { id: 'a', done: false }, { id: 'b', done: true }, { id: 'c', done: false }, { id: 'd', done: false },
  ]
  const next = make({ items })
  assert.equal(next('b').id, 'c', '已完成条的下一条应是 c，不是回绕到 a')
  assert.equal(next('a').id, 'c')
  assert.equal(next('d').id, 'a')
  assert.equal(next('missing').id, 'a')
})

test('开始下一条按点击时重算 tm，tm 改空不会留下空动作条', () => {
  const fn = block(page, 'function startNextTodo', '\n\n  // 两位补零')
  assert.match(fn, /var mode = next\.tm === 'up' \|\| next\.tm === '' \? next\.tm : 'down'/)
  assert.match(fn, /if \(mode === ''\)/)
  assert.match(fn, /hideBubble\(\)/)
})

test('接力气泡不会被重新布防成自动收起', () => {
  const fn = block(page, 'function timerBubbleAutoMs', '\n  }')
  assert.match(fn, /if \(timerHandoff\) return 0/)
})
