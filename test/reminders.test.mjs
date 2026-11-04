// test/reminders.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { normRemind, latestDueMs, initialRemindedFor, scanDue, runDueTick } = require('../public/preload/lib/reminders.js')

// 2026-10-31 是周六（本地时区）。固定用本地 Date 构造，避免 UTC 偏移干扰。
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const SAT_1000 = at(2026, 10, 31, 10, 0)

test('normRemind：非法形态回退 once，分钟数 clamp', () => {
  assert.deepEqual(normRemind({ remindOn: true, remindKind: 'weird', remindAt: 1234567 }),
    { remindOn: true, remindKind: 'once', remindAt: 1234567, remindDow: 0 })
  assert.deepEqual(normRemind({ remindOn: true, remindKind: 'daily', remindAt: 5000 }),
    { remindOn: true, remindKind: 'daily', remindAt: 1439, remindDow: 0 })
  assert.deepEqual(normRemind({}),
    { remindOn: false, remindKind: 'once', remindAt: 0, remindDow: 0 })
})

test('latestDueMs once：未来为 0，已过返回该时刻', () => {
  const past = at(2026, 10, 31, 9, 0)
  const future = at(2026, 10, 31, 11, 0)
  assert.equal(latestDueMs({ remindOn: true, remindKind: 'once', remindAt: past }, SAT_1000), past)
  assert.equal(latestDueMs({ remindOn: true, remindKind: 'once', remindAt: future }, SAT_1000), 0)
})

test('latestDueMs daily：今天已过取今天，未过取昨天', () => {
  // 09:00 → 今天 09:00 已过
  assert.equal(latestDueMs({ remindOn: true, remindKind: 'daily', remindAt: 540 }, SAT_1000), at(2026, 10, 31, 9, 0))
  // 11:00 → 今天未到，取昨天 11:00
  assert.equal(latestDueMs({ remindOn: true, remindKind: 'daily', remindAt: 660 }, SAT_1000), at(2026, 10, 30, 11, 0))
})

test('latestDueMs weekdays：周六回退到周五', () => {
  assert.equal(latestDueMs({ remindOn: true, remindKind: 'weekdays', remindAt: 540 }, SAT_1000), at(2026, 10, 30, 9, 0))
})

test('latestDueMs weekly：回退到指定星期', () => {
  // remindDow=1（周一）→ 最近一次是 2026-10-26 09:00
  assert.equal(latestDueMs({ remindOn: true, remindKind: 'weekly', remindDow: 1, remindAt: 540 }, SAT_1000), at(2026, 10, 26, 9, 0))
})

test('latestDueMs：已完成 / 未开启提醒返回 0', () => {
  assert.equal(latestDueMs({ remindOn: false, remindKind: 'daily', remindAt: 540 }, SAT_1000), 0)
  assert.equal(latestDueMs({ remindOn: true, done: true, remindKind: 'daily', remindAt: 540 }, SAT_1000), 0)
})

test('latestDueMs daily：00:00 合法（remindAt=0）', () => {
  const justAfterMidnight = at(2026, 10, 31, 0, 10)
  assert.equal(latestDueMs({ remindOn: true, remindKind: 'daily', remindAt: 0 }, justAfterMidnight), at(2026, 10, 31, 0, 0))
})

test('initialRemindedFor：重复形态把已过去的那一轮记为已提醒（新建后不补弹）', () => {
  // 10:00 设 daily 09:00：今天这一轮已经过去，基线应记到今天 09:00
  assert.equal(initialRemindedFor({ remindOn: true, remindKind: 'daily', remindAt: 540 }, SAT_1000),
    at(2026, 10, 31, 9, 0))
  // 10:00 设 daily 11:00：今天还没到，基线是昨天 11:00，今天 11:00 仍会提醒
  assert.equal(initialRemindedFor({ remindOn: true, remindKind: 'daily', remindAt: 660 }, SAT_1000),
    at(2026, 10, 30, 11, 0))
  assert.equal(initialRemindedFor({ remindOn: true, remindKind: 'weekdays', remindAt: 540 }, SAT_1000),
    at(2026, 10, 30, 9, 0))
  assert.equal(initialRemindedFor({ remindOn: true, remindKind: 'weekly', remindDow: 1, remindAt: 540 }, SAT_1000),
    at(2026, 10, 26, 9, 0))
})

test('initialRemindedFor：once 型不基线化（过期的一次性提醒仍立即提醒）', () => {
  const past = at(2026, 10, 31, 9, 0)
  assert.equal(initialRemindedFor({ remindOn: true, remindKind: 'once', remindAt: past }, SAT_1000), 0)
  assert.equal(initialRemindedFor({ remindOn: false, remindKind: 'daily', remindAt: 540 }, SAT_1000), 0)
})

test('新建 daily 提醒：首个 tick 不会补触发已过去的一轮（回归）', () => {
  const item = {
    id: 'a', text: '写周报', done: false, remindOn: true, remindKind: 'daily', remindAt: 540,
    remindedFor: initialRemindedFor({ remindOn: true, remindKind: 'daily', remindAt: 540 }, SAT_1000),
  }
  assert.deepEqual(scanDue({ items: [item] }, SAT_1000), [])
  // 次日 09:00 那轮照常
  assert.equal(scanDue({ items: [item] }, at(2026, 11, 1, 9, 0)).length, 1)
})

test('scanDue：命中且两套幂等位分开去重', () => {
  const st = { items: [
    // 未提醒：两套位都空
    { id: 'a', text: '写周报', done: false, remindOn: true, remindKind: 'daily', remindAt: 540, remindedFor: 0, notifiedFor: 0 },
    // 老数据只有 remindedFor（= 整轮已完成）：通知位按它兜底，不该重发通知，也不该再弹气泡
    { id: 'b', text: '已提醒', done: false, remindOn: true, remindKind: 'daily', remindAt: 540, remindedFor: at(2026, 10, 31, 9, 0) },
    // 通知发了但气泡没露头：仍要补气泡，但不再重发通知
    { id: 'd', text: '通知已发', done: false, remindOn: true, remindKind: 'daily', remindAt: 540, remindedFor: 0, notifiedFor: at(2026, 10, 31, 9, 0) },
    { id: 'c', text: '已完成', done: true, remindOn: true, remindKind: 'daily', remindAt: 540, remindedFor: 0 },
  ] }
  const out = scanDue(st, SAT_1000)
  assert.deepEqual(out.map((x) => x.id).sort(), ['a', 'd'])
  const a = out.find((x) => x.id === 'a')
  assert.deepEqual([a.dueAt, a.needNotify, a.needBubble], [at(2026, 10, 31, 9, 0), true, true])
  const d = out.find((x) => x.id === 'd')
  assert.deepEqual([d.needNotify, d.needBubble], [false, true], '通知已发 → 不重发；气泡未展示 → 继续补')
})

test('once 型：通知已送达但气泡被拦，不会永久丢', () => {
  const due = at(2026, 10, 31, 9, 0)
  const st = { items: [{ id: 'a', text: '一次性', done: false, remindOn: true, remindKind: 'once', remindAt: due, remindedFor: 0, notifiedFor: due }] }
  const out = scanDue(st, SAT_1000)
  assert.equal(out.length, 1)
  assert.deepEqual([out[0].needNotify, out[0].needBubble], [false, true])
  // 气泡回执后两套位一起前进 → 本轮才算完成
  assert.deepEqual(scanDue({ items: [{ ...st.items[0], remindedFor: due }] }, SAT_1000), [])
})

test('runDueTick：通知送达只写 notifiedFor；气泡位等回执，下个 tick 补弹且不重发通知', () => {
  const st = { items: [{ id: 'a', text: '写周报', done: false, remindOn: true, remindKind: 'daily', remindAt: 540, remindedFor: 0 }], focusId: '' }
  const notified = []
  const pushed = []
  let written = null
  const deps = {
    now: SAT_1000,
    readTodo: () => st,
    writeTodo: (s) => { written = s; return true },
    notify: (t) => notified.push(t),
    sendToWidget: (ch, p) => pushed.push([ch, p]),
    cfg: {},
  }
  const first = runDueTick(deps)
  assert.equal(first.length, 1)
  assert.deepEqual(notified, ['待办到点：写周报'])
  assert.equal(pushed[0][0], 'todo-due')
  assert.equal(written.items[0].notifiedFor, at(2026, 10, 31, 9, 0))
  assert.equal(written.items[0].remindedFor, 0, '气泡还没回执，这条提醒不能算完成')
  // 第二次 tick：仍要补气泡，但系统通知已经发过，不能重发
  const second = runDueTick({ ...deps, readTodo: () => written })
  assert.equal(second.length, 1)
  assert.equal(notified.length, 1, '系统通知只发一次')
  assert.equal(pushed.length, 2, '气泡被拦就每个 tick 继续补')
})

test('runDueTick：silent（免打扰）只弹气泡，幂等位等页面回执才写', () => {
  const st = { items: [{ id: 'a', text: '写周报', done: false, remindOn: true, remindKind: 'daily', remindAt: 540, remindedFor: 0 }], focusId: '' }
  const notified = []
  const pushed = []
  let written = null
  const deps = {
    now: SAT_1000,
    readTodo: () => st,
    writeTodo: (s) => { written = s; return true },
    notify: (t) => notified.push(t),
    sendToWidget: (ch, p) => pushed.push([ch, p]),
    cfg: { quietOn: true, quietFrom: '09:00', quietTo: '10:00' },
    silent: true,
  }
  const due = runDueTick(deps)
  assert.equal(due.length, 1)
  assert.deepEqual(notified, [], '免打扰时段内不应弹系统通知')
  assert.equal(pushed[0][0], 'todo-due', '挂件气泡照常（与设置页「时段内只弹气泡」一致）')
  assert.equal(written, null, '气泡是否真弹出来宿主不知道，不能提前写幂等位')
  // 气泡被计时气泡拦下（页面没回执）→ 下一个 tick 仍是 due，提醒保留待投递
  assert.equal(runDueTick({ ...deps, readTodo: () => st }).length, 1)
})

test('runDueTick：系统通知真送达才写 notifiedFor；渠道全关则等回执', () => {
  const mk = () => ({ items: [{ id: 'a', text: '写周报', done: false, remindOn: true, remindKind: 'once', remindAt: SAT_1000, remindedFor: 0 }], focusId: '' })
  let written = null
  const base = {
    now: SAT_1000,
    readTodo: mk,
    writeTodo: (s) => { written = s; return true },
    sendToWidget: () => {},
    cfg: {},
  }
  const ok = runDueTick({ ...base, readTodo: mk, notify: () => ({ system: true, mail: false }) })
  assert.equal(ok.length, 1)
  assert.equal(written.items[0].notifiedFor, SAT_1000)
  assert.equal(written.items[0].remindedFor, 0, '系统通知送达不等于气泡已展示')

  written = null
  const blocked = runDueTick({ ...base, readTodo: mk, notify: () => ({ system: false, mail: false }) })
  assert.equal(blocked.length, 1)
  assert.equal(written, null, '系统通知与邮件都没成功时，只能等气泡回执')
  // once 型被拦不会永久丢：两套位都没动，下次仍是 due
  assert.equal(runDueTick({ ...base, readTodo: mk, notify: () => ({ system: false, mail: false }) }).length, 1)
})
