// test/todo-remind-store.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mem = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) } }
const storage = mem()
globalThis.utools = {
  isDev: () => true,
  getPath: () => os.tmpdir(),
  dbStorage: storage,
  dbCryptoStorage: mem(),
}

const store = require('../public/preload/lib/store.js')

test('readTodo：提醒字段归一（脏值/缺省/保留合法）', () => {
  storage.setItem('whale:todo', {
    items: [
      { id: 'a', text: '周报', done: false, at: 1, remindOn: true, remindKind: 'weekly', remindAt: 540, remindDow: 1, remindedFor: 1700000000000 },
      { id: 'b', text: '旧条目', done: false, at: 2 },
      { id: 'c', text: '脏', done: false, at: 3, remindOn: true, remindKind: 'weird', remindAt: 9999 },
    ],
    focusId: '',
  })
  const st = store.readTodo()
  const a = st.items.find((x) => x.id === 'a')
  assert.equal(a.remindKind, 'weekly')
  assert.equal(a.remindAt, 540)
  assert.equal(a.remindDow, 1)
  assert.equal(a.remindedFor, 1700000000000)
  // 老数据只有 remindedFor（当时语义 = 整轮完成）：通知位要按它回填，
  // 否则升级后第一个 tick 会把每条历史提醒都当「未通知」重发一遍
  assert.equal(a.notifiedFor, 1700000000000)
  const b = st.items.find((x) => x.id === 'b')
  assert.deepEqual([b.remindOn, b.remindKind, b.remindAt, b.remindDow, b.remindedFor, b.notifiedFor], [false, 'once', 0, 0, 0, 0])
  const c = st.items.find((x) => x.id === 'c')
  assert.equal(c.remindKind, 'once')
  assert.equal(c.remindAt, 9999)
})
