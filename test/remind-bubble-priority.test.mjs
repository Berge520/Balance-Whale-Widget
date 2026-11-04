// test/remind-bubble-priority.test.mjs
// 被动提醒气泡（待办到点 / 峰谷 / 低余额 / 预算）的让路条件。
//
// 真机取证的失效：跑完一轮倒计时后点「知道了」收起气泡，timerFinished 仍是 true
// （只有开始 / 重置计时才清），而 showRemindBubble 用 timerActive() 判让路 ——
// timerActive() 包含 timerFinished，于是此后所有被动提醒气泡都被静默，直到下一轮开始。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')

test('让路条件单独成函数：计时中，或「时间到」动作条正显示', () => {
  const at = page.indexOf('function remindBubbleBlocked()')
  assert.ok(at >= 0, '缺少 remindBubbleBlocked()：让路条件不应散在 showRemindBubble 里')
  const body = page.slice(at, at + 600)
  assert.match(body, /timerRunning/)
  assert.match(body, /timerPaused/)
  assert.match(body, /timerFinished\s*&&\s*bubbleShown\s*&&\s*bubbleTimerActive/)
})

test('showRemindBubble 用新判据，不再用含 timerFinished 的 timerActive() 拦截', () => {
  const at = page.indexOf('function showRemindBubble(')
  assert.ok(at >= 0)
  const body = page.slice(at, at + 600)
  assert.match(body, /remindBubbleBlocked\(\)/)
  assert.ok(!/timerActive\(\)\s*&&\s*!force/.test(body),
    'timerActive() 含 timerFinished，会把已收起的到点态当成「计时中」永久压制被动提醒')
})
