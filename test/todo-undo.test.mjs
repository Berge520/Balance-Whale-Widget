// test/todo-undo.test.mjs
// 待办「删除后撤回」的宿主契约 + 设置页接线（node --test，零依赖）。
//
// 为什么用真 settings.js：撤回的正确性取决于「原位放回、字段不丢、专注目标不被覆盖、
// 只保留最近一条、删除失败不顶掉上一条快照」——这些都在宿主侧，纯源码断言测不出来。
// settings.js 顶层 require 了 log.js（→ utools.getPath），先挂桩再 require（与 settings-patch-toggle 同范式）。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-todo-undo-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const mem = new Map()
globalThis.utools = {
  getPath: () => tmp,
  dbStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, v) },
    removeItem: (k) => { mem.delete(k) },
  },
  dbCryptoStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}

const require = createRequire(import.meta.url)
const settings = require('../public/preload/lib/settings.js')

const KEY = 'whale:todo'
const item = (id, extra = {}) => Object.assign({
  id, text: `待办 ${id}`, done: false, at: 1, doneAt: 0, est: 0, rounds: 0,
  tm: '', mins: 25, remindOn: false, remindKind: 'once', remindAt: 0, remindDow: 1, remindedFor: 0,
}, extra)
const seed = (items, focusId = '') => mem.set(KEY, { items, focusId })
const stored = () => mem.get(KEY)

test('撤回：原位插回、全部字段保留、原专注目标恢复', () => {
  seed([
    item('a', { est: 3, rounds: 1, tm: 'down', mins: 25, remindOn: true, remindKind: 'daily', remindAt: 540 }),
    item('b'),
    item('c'),
  ], 'a')
  const removed = settings.todoRemove('a')
  assert.equal(removed.ok, true, removed.error)
  assert.deepEqual(removed.todo.items.map((x) => x.id), ['b', 'c'])
  assert.equal(removed.todo.focusId, '', '删除专注中的条目要清空专注目标')

  const undone = settings.todoUndoRemove('a')
  assert.equal(undone.ok, true, undone.error)
  assert.deepEqual(undone.todo.items.map((x) => x.id), ['a', 'b', 'c'], '应放回原位置')
  assert.equal(undone.todo.focusId, 'a', '原专注目标应恢复')
  const back = undone.todo.items[0]
  assert.equal(back.est, 3)
  assert.equal(back.rounds, 1)
  assert.equal(back.tm, 'down')
  assert.equal(back.mins, 25)
  assert.equal(back.remindOn, true)
  assert.equal(back.remindKind, 'daily')
  assert.equal(back.remindAt, 540)

  // 快照用完即失效：同一个 id 不能再撤第二次
  assert.equal(settings.todoUndoRemove('a').ok, false)
})

test('撤而不覆盖用户后来另设的专注目标', () => {
  seed([item('a'), item('b')], 'a')
  settings.todoRemove('a')
  const focused = settings.todoFocus('b')
  assert.equal(focused.ok, true, focused.error)
  const undone = settings.todoUndoRemove('a')
  assert.equal(undone.ok, true, undone.error)
  assert.equal(undone.todo.focusId, 'b', '新选的任务不该被旧目标顶掉')
})

test('只保留最近一条：连删两条后，旧条目撤回失效', () => {
  seed([item('a'), item('b'), item('c')])
  settings.todoRemove('a')
  settings.todoRemove('b')
  assert.equal(settings.todoUndoRemove('a').ok, false, '上一条的撤回入口已过期')
  const undone = settings.todoUndoRemove('b')
  assert.equal(undone.ok, true, undone.error)
  assert.deepEqual(undone.todo.items.map((x) => x.id), ['b', 'c'])
})

test('删除失败不覆盖上一条可撤回快照', () => {
  seed([item('a'), item('b')])
  settings.todoRemove('a')
  assert.equal(settings.todoRemove('no-such-id').ok, false)
  const undone = settings.todoUndoRemove('a')
  assert.equal(undone.ok, true, undone.error)
  assert.deepEqual(undone.todo.items.map((x) => x.id), ['a', 'b'])
})

test('已完成条目撤回后仍是已完成，完成时间不丢', () => {
  seed([item('a', { done: true, doneAt: 123 })])
  settings.todoRemove('a')
  const undone = settings.todoUndoRemove('a')
  assert.equal(undone.ok, true, undone.error)
  assert.equal(undone.todo.items[0].done, true)
  assert.equal(undone.todo.items[0].doneAt, 123)
})

test('清单已满时撤回被拒，并回传当前清单', () => {
  const max = settings.todoLimits().max
  const list = Array.from({ length: max }, (_, i) => item('x' + i))
  seed(list)
  settings.todoRemove('x0')
  settings.todoAdd('占满的新任务')
  const undone = settings.todoUndoRemove('x0')
  assert.equal(undone.ok, false)
  assert.match(undone.error, /上限/)
  assert.equal(stored().items.length, max, '失败时不能悄悄超限写盘')
})

test('todoSetEst：clamp 0–99，其余字段不动', () => {
  seed([item('a', { est: 3, rounds: 1, text: '原任务' })])
  assert.equal(settings.todoSetEst('a', 5).ok, true)
  assert.equal(stored().items[0].est, 5)
  settings.todoSetEst('a', 500)
  assert.equal(stored().items[0].est, 99, '超出上限要 clamp 到 99')
  settings.todoSetEst('a', -3)
  assert.equal(stored().items[0].est, 0, '负数按 0（不设）处理')
  assert.equal(stored().items[0].rounds, 1, 'rounds 是会话派生的，改预估不能动它')
  assert.equal(stored().items[0].text, '原任务')
})

// —— 挂件拖拽排序：todoMove 的「先摘后找」语义 ——
test('todoMove：往前挪、往后挪、挪到末尾都对', () => {
  seed([item('a'), item('b'), item('c'), item('d')])
  // 往前：c 挪到 a 之前
  assert.equal(settings.todoMove('c', 'a').ok, true)
  assert.deepEqual(stored().items.map((x) => x.id), ['c', 'a', 'b', 'd'])
  // 往后：c 挪到 b 之前（目标下标原本在 c 之后，摘下后必须重新找）
  assert.equal(settings.todoMove('c', 'b').ok, true)
  assert.deepEqual(stored().items.map((x) => x.id), ['a', 'c', 'b', 'd'])
  // 移到末尾：beforeId 为空
  assert.equal(settings.todoMove('a', '').ok, true)
  assert.deepEqual(stored().items.map((x) => x.id), ['c', 'b', 'd', 'a'])
})

test('todoMove：字段一个不动，未知 id 被拒且不改写', () => {
  seed([item('a', { est: 3, rounds: 2 }), item('b')])
  assert.equal(settings.todoMove('b', 'a').ok, true)
  const moved = stored().items[0]
  assert.equal(moved.id, 'b')
  assert.equal(stored().items[1].est, 3, '排序只调顺序，不能碰条目字段')
  assert.equal(stored().items[1].rounds, 2)
  assert.equal(settings.todoMove('no-such-id', 'a').ok, false)
  assert.equal(settings.todoMove('a', 'a').ok, true, '自己挪到自己之前应是空操作而不是报错')
  assert.deepEqual(stored().items.map((x) => x.id), ['b', 'a'])
})

// —— 设置页接线：源码级断言（本仓无组件测试环境） ——
test('FocusView 已接上撤回条：删除成功才弹、可撤回、悬停暂停、卸载清定时器', () => {
  const view = fs.readFileSync(new URL('../src/views/FocusView.vue', import.meta.url), 'utf8')
  assert.match(view, /if \(r && r\.ok\) showUndo\(it\)/, '删除失败时不该弹「已删除」')
  assert.match(view, /props\.services\.todoUndoRemove\?\.\(cur\.id\)/, '撤回按钮要调宿主 todoUndoRemove')
  assert.match(view, /const UNDO_MS = 8000/, '撤回条停留时长')
  assert.match(view, /@mouseenter="pauseUndo"/, '悬停应暂停自动消失')
  assert.match(view, /stopUndoTimer\(\)\n\s+stop\(\)/, '卸载时应清撤回定时器')
  assert.match(view, /<Teleport to="body">/, '撤回条应挂 body，避免被卡片裁剪')
  assert.match(view, /@click="undoRemove"/, '撤回按钮缺少动作')
  assert.match(view, /\.todo-undo\s*\{[^}]*position:\s*fixed/, '撤回条应固定在视口底部')
})
