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

const todoHandler = /ipcRenderer\.on\('whale:todo'[\s\S]*?\n {2}\}\)/.exec(IPC)

test('whale:todo 接受 unfocus，focus 是明确的「设为」', () => {
  assert.ok(todoHandler, 'whale:todo 处理器必须存在')
  const fn = todoHandler[0]
  // v1.17 起允许列表收敛成数组常量 TODO_OPS（8 个 op，含改名 / 删除 / 到点提醒），
  // 判定改为「列表里有 unfocus」+「处理函数走 TODO_OPS.indexOf」
  assert.match(IPC, /const TODO_OPS = \[[^\]]*'unfocus'[^\]]*\]/, 'unfocus 必须进入允许列表')
  assert.match(fn, /TODO_OPS\.indexOf\(op\) < 0/, '允许列表由 TODO_OPS 统一判定')
  assert.match(fn, /st\.focusId = id(?![^\n]*\?)/, 'focus 直接赋值，不能是三元开关')
  assert.doesNotMatch(fn, /st\.focusId === id \? '' : id/, '旧的开关语义必须删掉')
})

test('改名的编辑类操作委托 services，不在此处复制业务语义', () => {
  const fn = todoHandler[0]
  // 删除要留 undo 快照、改提醒要重置两套幂等位 —— 这些只该有 services 一份实现
  assert.match(fn, /TODO_VIA_SERVICES/, '编辑类操作要走 services 转发表')
  assert.match(IPC, /todoRename: 'rename'|rename: 'todoRename'/, '改名要映射到 services.todoRename')
  assert.match(IPC, /remove: 'todoRemove'/, '删除要映射到 services.todoRemove')
  assert.match(IPC, /due: 'todoSetDue'/, '到点提醒要映射到 services.todoSetDue')
})

test('v1.18：预估轮数与拖拽排序也走 services 转发表', () => {
  // est：写条目的 est 字段（进度点的分母）；move：只调数组顺序。
  // 两者都落在 settings.js 里，ipc 只转交 —— 别处再复制一份排序 / clamp 语义会各写各的
  const fn = todoHandler[0]
  assert.match(IPC, /est: 'todoSetEst'/, '预估轮数要映射到 services.todoSetEst')
  assert.match(IPC, /move: 'todoMove'/, '拖拽排序要映射到 services.todoMove')
  assert.match(fn, /op === 'est'[^\n]*todoSetEst\(id, data && data\.est\)/, 'est 要取 data.est 转交')
  assert.match(fn, /op === 'move'[^\n]*todoMove\(id, data && data\.beforeId\)/, 'move 要取 data.beforeId 转交')
})

test('v1.18：挂件拖拽只在手柄上开 draggable', () => {
  // 行本身可拖会吞掉勾选框 / 按钮的 click（鼠标按下即进入拖拽），
  // 且 pointer 方案在置顶浮层移出窗口后收不到 pointerup，行会卡住
  const ROW = read('public/floating-todo-edit.js')
  assert.match(ROW, /function dragHandle/, '拖拽手柄要单独成函数')
  assert.doesNotMatch(ROW, /el\.draggable = true/, '行本身不能设 draggable')
  assert.match(ROW, /o\.send\(\{ op: 'move', id: fromId, beforeId: beforeId \}\)/, '松手要发 move')
})

test('v1.18：计时结束回推单条会话（whale:focus-session）', () => {
  // 挂件菜单的「最近计时」靠这条回推插入列表头，不必为一段去拉整份历史
  assert.match(IPC, /sendToWidget\('whale:focus-session'/, '宿主落库后要回推单条会话')
  const FL = read('public/preload/floating.js')
  assert.match(FL, /focusSession: \[\]/, 'handlers 表要有 focusSession，否则 on() 静默丢弃')
  assert.match(FL, /onFocusSession\(cb\) \{ on\('focusSession', cb\) \}/)
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
  // 待办行的渲染实体 v1.17 起在 floating-todo-edit.js（行数棘轮），断言跟着搬过去
  const ROW = read('public/floating-todo-edit.js')
  assert.match(ROW, /o\.send\(\{ op: 'unfocus', id: it\.id \}\)/, '取消按钮要发 unfocus')
})
