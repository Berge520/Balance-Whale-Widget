// test/remind-time-clear.test.mjs
// 待办提醒时间输入框清空时的语义。
//
// 重复形态（每天 / 工作日 / 每周）的 remindAt 是「当天分钟数」，0 在引擎里是**合法的 00:00**
// （见 reminders.js 的 latestDueMs）。所以清空输入框不能写 remindAt:0 —— 那等于把提醒
// 挪到半夜，而且挂件徽标同时消失，界面与行为对不上。清空应当回退原值。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const focus = fs.readFileSync(new URL('../src/views/FocusView.vue', import.meta.url), 'utf8')

test('重复形态清空时间：回退原值，不写 remindAt:0', () => {
  const at = focus.indexOf('function onRemindTime(')
  assert.ok(at >= 0, '找不到 onRemindTime')
  const body = focus.slice(at, at + 900)
  assert.match(body, /if \(!v\) \{[\s\S]{0,300}remindKind !== 'once'[\s\S]{0,200}el\.value = remindShown\(it\)/,
    '清空分支必须先区分 once：重复形态回退原值，否则 0 会被当成 00:00 半夜提醒')
})
