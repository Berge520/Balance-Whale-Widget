// test/floating-events.test.mjs
// 挂件 preload 的事件登记表必须覆盖所有 emit/on 用到的名字。
//
// 真机故障：handlers 表漏了 todoDue，on('todoDue', cb) 被 on() 静默丢弃、
// emit('todoDue') 直接 return —— 宿主扫到了到点、也发了指令，页面却永远收不到，
// 表现为「到点气泡从不出现在挂件里」，而日志里连一条错误都没有。
// 这里做一致性校验：任何 emit('x') 的事件名都必须在 handlers 表里有数组。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../public/preload/floating.js', import.meta.url), 'utf8')

const mapMatch = src.match(/const handlers = \{([\s\S]*?)\}\n/)
assert.ok(mapMatch, '找不到 handlers 事件表')

const declared = new Set(
  mapMatch[1].split(',').map((s) => s.trim().split(':')[0]).filter(Boolean),
)
const emitted = new Set([...src.matchAll(/emit\('(\w+)'/g)].map((m) => m[1]))

test('handlers 表覆盖所有 emit 的事件名', () => {
  const missing = [...emitted].filter((n) => !declared.has(n))
  assert.deepEqual(missing, [], `handlers 表缺少：${missing.join(', ')}（on() 会静默丢弃，emit() 直接 return）`)
})

test('待办到点（todoDue）必须在表内', () => {
  assert.ok(declared.has('todoDue'), 'handlers 缺少 todoDue：到点提醒永远到不了页面')
})
