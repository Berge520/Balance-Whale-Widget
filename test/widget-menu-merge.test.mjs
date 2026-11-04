// test/widget-menu-merge.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')

test('只有一个专注组，没有独立待办组', () => {
  assert.match(page, /menuGroup\('focus', '专注'\)/)
  assert.equal([...page.matchAll(/menuGroup\('focus'/g)].length, 1, '专注组只能建一个')
  assert.doesNotMatch(page, /menuGroup\('todo'/, '不应再建独立待办组')
  assert.doesNotMatch(page, /menuGroup\('timer'/, '不应再建独立计时组')
  assert.doesNotMatch(page, /groupTodo/, 'groupTodo 引用应全部清掉')
  assert.doesNotMatch(page, /groupTimer/, 'groupTimer 引用应全部清掉')
})

test('组标题与底部入口按 focusOn || todoOn 切换', () => {
  assert.match(page, /function syncFocusGroupChrome/)
  assert.match(page, /groupFocus\.setTitle\(hub \? '专注' : '计时'\)/)
  assert.match(page, /timerSettingsBtn\.textContent = hub \? '专注与待办设置' : '计时设置'/)
})

test('合并组只保留一个底部设置入口', () => {
  assert.doesNotMatch(page, /todoManageBtn/, '管理待办按钮应删除')
  assert.doesNotMatch(page, /管理待办/, '管理待办文案应删除')
  assert.match(page, /openSettings\(\(focusOn \|\| todoOn\) \? 'focus' : 'timer'\)/)
})
