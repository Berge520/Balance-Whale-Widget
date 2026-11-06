/*
 * lib/remind-tick.js 的单测（node --test，零真实定时器）。
 *
 * 这一层的风险点全在「两路驱动同时到点」：写错不会抛错，只会让扫描双跑（CPU / 日志翻倍），
 * 或者把正常的 30s 节奏误吞一拍（提醒又变慢）。所以时钟与依赖全部注入，按毫秒断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { REMIND_TICK_DEBOUNCE_MS, createRemindTicker } = require('../public/preload/lib/remind-tick.js')

function makeDeps() {
  const calls = { due: [], log: [], err: [] }
  const deps = {
    readConfig: () => ({ quiet: false }),
    readTodo: () => ({ items: [] }),
    writeTodo: () => {},
    notify: () => ({ system: true, mail: false }),
    runDueTick: (args) => { calls.due.push(args); return [] },
    inQuietHours: (cfg) => !!(cfg && cfg.quiet),
    log: (...args) => calls.log.push(args),
    logErr: (...args) => calls.err.push(args),
  }
  return { deps, calls }
}

test('首次调用立即扫描，并把装配依赖原样交给 runDueTick', () => {
  const { deps, calls } = makeDeps()
  const tick = createRemindTicker(deps)
  const r = tick(() => {}, 'main', 1000)
  assert.equal(r.skipped, false)
  assert.equal(calls.due.length, 1)
  const arg = calls.due[0]
  assert.equal(arg.now, 1000)
  assert.deepEqual(arg.cfg, { quiet: false })
  assert.equal(arg.readTodo, deps.readTodo)
  assert.equal(arg.writeTodo, deps.writeTodo)
  assert.equal(arg.notify, deps.notify)
  assert.equal(typeof arg.sendToWidget, 'function')
  assert.equal(arg.silent, false)
})

test('两路驱动共用同一实例：距上次不足 20s 的第二拍被跳过', () => {
  const { deps, calls } = makeDeps()
  const tick = createRemindTicker(deps)
  tick(() => {}, 'main', 5000)
  const second = tick(() => {}, 'widget', 5000 + REMIND_TICK_DEBOUNCE_MS - 1)
  assert.equal(second.skipped, true)
  assert.deepEqual(second.fired, [])
  assert.equal(calls.due.length, 1, '被跳过的一拍不能再跑扫描')
})

test('正常 30s 节奏不会被误吞：达到 20s 阈值即放行', () => {
  const { deps, calls } = makeDeps()
  const tick = createRemindTicker(deps)
  tick(() => {}, 'main', 1000)
  tick(() => {}, 'widget', 31000)
  tick(() => {}, 'main', 61000)
  assert.equal(calls.due.length, 3)
})

test('时钟回拨不吞拍：系统改时间后扫描不会停摆到原时刻', () => {
  const { deps, calls } = makeDeps()
  const tick = createRemindTicker(deps)
  tick(() => {}, 'main', 30000)
  const back = tick(() => {}, 'widget', 20000)
  assert.equal(back.skipped, false)
  assert.equal(calls.due.length, 2)
})

test('有到点项才写提醒日志，日志带驱动源（真机取证用）', () => {
  const made = makeDeps()
  made.deps.runDueTick = (args) => { made.calls.due.push(args); return [{ id: 'a' }] }
  const tick = createRemindTicker(made.deps)
  tick(() => {}, 'widget', 1000)
  assert.equal(made.calls.log.length, 1)
  const [, payload] = made.calls.log[0]
  assert.deepEqual(payload, { count: 1, ids: ['a'], src: 'widget' })

  // 没有命中时不写日志：30s 一行的空拍会把日志刷爆
  const idle = makeDeps()
  createRemindTicker(idle.deps)(() => {}, 'main', 1000)
  assert.equal(idle.calls.log.length, 0)
})

test('扫描抛错时只 logErr，不向上抛，且 30s 后仍可继续', () => {
  const made = makeDeps()
  made.deps.runDueTick = () => { throw new Error('boom') }
  const tick = createRemindTicker(made.deps)
  const r = tick(() => {}, 'main', 1000)
  assert.deepEqual(r.fired, [])
  assert.equal(made.calls.err.length, 1)

  made.deps.runDueTick = (args) => { made.calls.due.push(args); return [] }
  const ok = tick(() => {}, 'main', 31000)
  assert.equal(ok.skipped, false)
})

test('免打扰折算进 silent，扫描本身照跑', () => {
  const { deps, calls } = makeDeps()
  deps.readConfig = () => ({ quiet: true })
  createRemindTicker(deps)(() => {}, 'main', 1000)
  assert.equal(calls.due[0].silent, true)
})
