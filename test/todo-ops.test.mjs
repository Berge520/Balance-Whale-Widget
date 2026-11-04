/*
 * 待办轻操作的源码契约单测（node --test，零依赖）。
 *
 * 盯三类曾经会静默跑偏的行为：
 *   1. focus 是开关语义 —— startTodoTimer 里的「没专注才 focus」撞上「再点一次取消」，
 *      重复设置会把目标点没；取消必须有独立的 unfocus；
 *   2. 操作被拒（条目已被删 / 清单已满 / 写失败）时宿主直接 return，挂件按乐观状态重画后
 *      再也等不到权威快照，一直停在错误状态；
 *   3. 页面取消路径不能再发 focus 去「反选」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8')
const IPC = read('public/preload/lib/ipc.js')
const PAGE = read('public/floating-page.js')

const todoHandler = /ipcRenderer\.on\('whale:todo'[\s\S]*?\n {2}\}\)/.exec(IPC)

test('whale:todo 接受 unfocus，focus 是明确的「设为」', () => {
  assert.ok(todoHandler, 'whale:todo 处理器必须存在')
  const fn = todoHandler[0]
  assert.match(fn, /op !== 'unfocus'/, 'unfocus 必须进入允许列表')
  assert.match(fn, /st\.focusId = id(?![^\n]*\?)/, 'focus 直接赋值，不能是三元开关')
  assert.doesNotMatch(fn, /st\.focusId === id \? '' : id/, '旧的开关语义必须删掉')
})

test('unfocus 只清当前这条，别的条目已接管时不动', () => {
  const fn = todoHandler[0]
  assert.match(fn, /else if \(st\.focusId === id\) \{\s*st\.focusId = ''/, 'unfocus 要带 id 匹配')
})

test('被拒的操作也要回推权威状态（挂件不能停在乐观态）', () => {
  const fn = todoHandler[0]
  assert.match(fn, /if \(!it\) \{ resync\(\); return \}/, '条目已不存在时要重同步')
  assert.match(fn, /if \(it\.done\) \{ resync\(\); return \}/, '已完成项不能设为专注，且要重同步')
  assert.match(fn, /if \(!writeTodo\(st\)\) \{ resync\(\); return \}/, '写失败时要重同步')
  assert.match(fn, /!text \|\| st\.items\.length >= TODO_MAX\) \{ resync\(\); return \}/, '添加被拒时要重同步')
})

test('页面取消专注走 unfocus，不再靠 focus 反选', () => {
  assert.match(PAGE, /todoSend\(\{ op: 'unfocus', id: it\.id \}\)/, '取消按钮要发 unfocus')
})
