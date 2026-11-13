/*
 * 计时到点看门狗单测（node --test，零依赖）。
 *
 * 背景：计时活在悬浮窗页面里，挂件一藏（= destroyWidget）页面就没了，到点没人报。
 * 宿主 30s 表里的 runTimerWatch 负责补发，这里钉住四件事：
 *   1. dueTimer 只认「还在跑的 down/at、已过终点、尚未通知过」；
 *   2. 文案与页面 timerDoneText 同口径（含到点留言）；
 *   3. runTimerWatch 的三道防重复闸（页面活着不插手 / notified 标记 / 进程内记住 endAt）；
 *   4. 超过 24h（STALE_MS）的旧到点不再补发。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { dueTimer, runTimerWatch, timerDoneText } = require('../public/preload/lib/timer-watch.js')

const NOW = 1_800_000_000_000
const base = { mode: 'down', running: true, paused: false, endAt: NOW - 1000, arg: '1500', isBreak: false }

test('dueTimer：非运行态 / 正计时 / 未到点 / 已通知 都不补发', () => {
  assert.equal(dueTimer(null, {}, NOW), '')
  assert.equal(dueTimer(Object.assign({}, base, { mode: 'up' }), {}, NOW), '')
  assert.equal(dueTimer(Object.assign({}, base, { running: false }), {}, NOW), '')
  assert.equal(dueTimer(Object.assign({}, base, { paused: true }), {}, NOW), '')
  assert.equal(dueTimer(Object.assign({}, base, { endAt: NOW + 1 }), {}, NOW), '')
  assert.equal(dueTimer(Object.assign({}, base, { endAt: 0 }), {}, NOW), '')
  assert.equal(dueTimer(Object.assign({}, base, { notified: true }), {}, NOW), '')
})

test('dueTimer：倒计时 / 定时 / 休息 三种文案', () => {
  assert.equal(dueTimer(base, {}, NOW), '小鲸鱼提醒：倒计时结束（25:00）')
  assert.equal(dueTimer(Object.assign({}, base, { mode: 'at', arg: '07:30' }), {}, NOW),
    '小鲸鱼提醒：定时到点（07:30）')
  assert.equal(dueTimer(Object.assign({}, base, { isBreak: true }), {}, NOW),
    '小鲸鱼提醒：休息结束（25:00）')
})

test('dueTimer：超过 24 小时的旧到点不再补发', () => {
  const DAY = 24 * 60 * 60 * 1000
  // 差一点到 24h：仍算有效，确认上限没写反
  assert.equal(dueTimer(Object.assign({}, base, { endAt: NOW - DAY + 1000 }), {}, NOW),
    '小鲸鱼提醒：倒计时结束（25:00）')
  assert.equal(dueTimer(Object.assign({}, base, { endAt: NOW - DAY - 1000 }), {}, NOW), '')
})

test('timerDoneText：到点留言接在默认说法后面', () => {
  assert.equal(timerDoneText(base, { timerNote: '  喝水  ' }), '倒计时结束（25:00） · 喝水')
  assert.equal(timerDoneText(base, { timerNote: '   ' }), '倒计时结束（25:00）')
})

// 每个用例用互不相同的 endAt：模块内的 firedEndAt 是跨用例共享的
function makeDeps(over) {
  const calls = { notify: [], wrote: [] }
  const deps = Object.assign({
    alive: () => false,
    readConfig: () => ({}),
    readTimer: () => null,
    writeTimer: (t) => calls.wrote.push(t),
    notifyTimer: (text, cfg, ch) => calls.notify.push({ text, cfg, ch }),
    logErr: () => {},
  }, over)
  return { deps, calls }
}

test('runTimerWatch：挂件页面还在时不插手（页面自己会报）', () => {
  const { deps, calls } = makeDeps({
    alive: () => true,
    readTimer: () => Object.assign({}, base, { endAt: NOW - 5001 }),
  })
  assert.equal(runTimerWatch(deps, NOW), false)
  assert.equal(calls.notify.length, 0)
})

test('runTimerWatch：已过终点且未通知 → 补发一次并写回 notified', () => {
  const { deps, calls } = makeDeps({
    readConfig: () => ({ timerNotifyOn: true, timerMailOn: false }),
    readTimer: () => Object.assign({}, base, { endAt: NOW - 5002 }),
  })
  assert.equal(runTimerWatch(deps, NOW), true)
  assert.equal(calls.notify.length, 1)
  assert.deepEqual(calls.notify[0].ch, { system: true, mail: false })
  assert.equal(calls.wrote.length, 1)
  assert.equal(calls.wrote[0].notified, true)
  // 同一轮再 tick：写库即便失败（上面 fake 不会持久化），也不能每 30s 重发
  assert.equal(runTimerWatch(deps, NOW), false)
  assert.equal(calls.notify.length, 1)
})

test('runTimerWatch：页面已写回 notified 的轮次不再补发', () => {
  const { deps, calls } = makeDeps({
    readTimer: () => Object.assign({}, base, { endAt: NOW - 5003, notified: true }),
  })
  assert.equal(runTimerWatch(deps, NOW), false)
  assert.equal(calls.notify.length, 0)
})

test('runTimerWatch：关掉「计时保存」后不拿残留状态补发', () => {
  const { deps, calls } = makeDeps({
    readConfig: () => ({ timerPersistOn: false }),
    readTimer: () => Object.assign({}, base, { endAt: NOW - 5004 }),
  })
  assert.equal(runTimerWatch(deps, NOW), false)
  assert.equal(calls.notify.length, 0)
})
