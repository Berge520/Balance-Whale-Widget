// test/reminders-tick-wiring.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const services = read('public/preload/services.js')
const ipc = read('public/preload/lib/ipc.js')
const api = read('public/preload/lib/api.js')
const remindTick = read('public/preload/lib/remind-tick.js')
const floating = read('public/preload/floating.js')

test('services 起 30s 到点扫描并在退出时清理', () => {
  // 扫描本体已抽到 lib/remind-tick.js，services 只保留主窗兜底表的启停
  assert.match(services, /runRemindTick/)
  assert.match(remindTick, /runDueTick/)
  assert.match(services, /setInterval\(tick,\s*30000\)/)
  assert.match(services, /clearInterval/)
})

test('第二路驱动接在挂件窗与 ipc 上，且与主窗表共用同一份去抖', () => {
  assert.match(floating, /whale:remind-tick/)
  assert.match(floating, /setInterval\(remindTick,\s*30000\)/)
  assert.match(ipc, /whale:remind-tick/)
  assert.match(ipc, /runRemindTick\(sendWidgetCmd,\s*'widget'\)/)
  // 去抖实例在 remind-tick 模块内（services 与 ipc 同进程共享），阈值 20s = 2/3 周期：
  // 两路同时健康也最多 20s 一拍，单路正常的 30s 拍不会被吞
  assert.match(remindTick, /REMIND_TICK_DEBOUNCE_MS\s*=\s*20000/)
})

test('到点扫描只在 isKill=true 真退出时停表（isKill=false 的隐藏 / 后台驻留不停）', () => {
  // 非 kill 的 onPluginOut（隐藏 / 失焦 / 退到后台）不能再无条件停表，否则挂件还在、提醒先哑了
  const at = services.indexOf("log('[whale][lifecycle] onPluginOut'")
  assert.ok(at >= 0, '找不到 onPluginOut 处理块')
  const head = services.slice(at, services.indexOf('if (isKill) {', at))
  assert.doesNotMatch(head, /stopReminders\(\)/, '停表前面不能再有裸调用')
  assert.match(services, /if \(isKill\) \{\s*stopReminders\(\)\s*\} else if \(!remindTimer\) \{[\s\S]{0,200}?startReminders\(\)/)
})

test('whale:todo 不再接受已无生产端的 op:due（提醒只从设置页 todoSetDue 改）', () => {
  assert.doesNotMatch(ipc, /op !== 'due'/)
  assert.doesNotMatch(ipc, /op === 'due'/)
})

test('到点气泡回执只在 shown:true 时写幂等位', () => {
  assert.match(ipc, /whale:todo-due-ack/)
  assert.match(ipc, /if \(d\.shown !== true\) return/)
})

test('两套幂等位分开记账：回执写 remindedFor，并把通知位一并推进；调试回执不记账', () => {
  assert.match(ipc, /it\.remindedFor = dueAt/)
  assert.match(ipc, /it\.notifiedFor = dueAt/)
  assert.match(ipc, /if \(d\.debug === true\) return/)
  // 调试回执必须带标记，否则演练会把真实幂等位写脏
  assert.match(read('public/preload/floating.js'), /debug:\s*p\.debug === true/)
})

test('到点扫描把免打扰算进 silent（时段内只弹气泡，不弹系统通知）', () => {
  assert.match(api, /^\s*inQuietHours,\s*$/m, 'api.js 需导出 inQuietHours 供宿主扫描使用')
  assert.match(remindTick, /silent:\s*d\.inQuietHours\(cfg\)/)
})
