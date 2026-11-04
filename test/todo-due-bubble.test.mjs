// test/todo-due-bubble.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const preload = read('public/preload/floating.js')
const page = read('public/floating-page.js')

test('preload 只走 whale:cmd 转发 todo-due，并暴露 onTodoDue / todoDueAck', () => {
  // 专用通道已删除：宿主只发 whale:cmd（cmd='todo-due'），两条路径并存容易只修一处
  assert.doesNotMatch(preload, /ipcRenderer\.on\('whale:todo-due'/)
  assert.match(preload, /onTodoDue\(/)
  assert.match(preload, /todoDueAck\(/)
  assert.match(preload, /whale:todo-due-ack/)
})

test('page 注册 onTodoDue 且用非 force 提醒气泡', () => {
  assert.match(page, /onTodoDue/)
  assert.match(page, /showRemindBubble\(/)
})

test('onTodoDue 传对象行 —— 渲染器只认 {t,s,c,w}，字符串会被渲染成 undefined', () => {
  const at = page.indexOf('whaleApi.onTodoDue(function (d)')
  assert.ok(at >= 0, '找不到 onTodoDue 处理块')
  const block = page.slice(at, at + 900)
  assert.match(block, /showRemindBubble\(\[\s*\{\s*t:\s*'待办到点'/)
  assert.match(block, /t:\s*String\(d\.text\)\.slice\(0,\s*60\)/)
  assert.match(block, /s:\s*'[APC]'/)
})

test('气泡回执带 shown：被拦时 false，宿主据此不写幂等位', () => {
  const at = page.indexOf('whaleApi.onTodoDue(function (d)')
  const block = page.slice(at, at + 900)
  assert.match(block, /var shown = false/)
  assert.match(block, /todoDueAck\(\{\s*id:\s*d\.id,\s*dueAt:\s*d\.dueAt,\s*shown:\s*shown,\s*debug:\s*d\.debug === true\s*\}\)/)
})
