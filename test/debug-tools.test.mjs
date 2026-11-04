// test/debug-tools.test.mjs
// 调试入口的「默认关闭 + 生产 UI 不出现 + 不污染正常 tick」三条硬约束。
// 这些入口以前只能靠拖拽 / 改 leveldb 才能验证，所以固定成可复现的按钮；
// 但绝不能变成普通用户能点到的功能，也不能把真实幂等位写脏。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const store = read('public/preload/lib/store.js')
const settings = read('public/preload/lib/settings.js')
const ipc = read('public/preload/lib/ipc.js')
const media = read('public/preload/lib/media.js')
const app = read('src/App.vue')
const display = read('src/constants/display.ts')

test('配置四处同步：default / read / write / patch 都有 debugTools，默认 false', () => {
  // focusGoal 与 debugTools 之间现在隔着下班倒计时八键，不再相邻
  assert.match(store, /focusGoal: 0,[\s\S]{0,400}debugTools: false/)
  assert.match(store, /debugTools: p\.debugTools === true/)
  assert.match(store, /debugTools: cfg\.debugTools === true/)
  assert.match(store, /if \(p\.debugTools !== undefined\) cfg\.debugTools = p\.debugTools === true/)
})

test('设置页默认配置也带 debugTools: false', () => {
  assert.match(app, /notifyMailOn: false,[\s\S]{0,20}debugTools: false/)
  assert.match(app, /cfg\.debugTools = c\.debugTools === true/)
})

test('调试入口在服务层二次校验开关（UI 关了也调不动）', () => {
  const at = settings.indexOf('debugTodoDue(id)')
  assert.ok(at >= 0, '缺少可调用的调试入口')
  assert.match(settings, /debugTodoDue\(id\)[\s\S]{0,200}readConfig\(\)\.debugTools !== true/)
  assert.match(settings, /debugInjectLegacy\(\)[\s\S]{0,200}readConfig\(\)\.debugTools !== true/)
})

test('「立即触发提醒」走真实两条通道，但回执带 debug 标记、不写幂等位', () => {
  assert.match(settings, /require\('\.\/ipc'\)\.sendWidgetCmd\('todo-due',\s*\{[^}]*debug: true/)
  assert.match(ipc, /if \(d\.debug === true\) return/)
})

test('「注入旧数据」三类现场齐全：remindedFor=0 重复提醒 / focus+timer 双置顶 / 幽灵媒体', () => {
  assert.match(settings, /remindKind: 'daily'[\s\S]{0,120}remindedFor: 0, notifiedFor: 0/)
  assert.match(settings, /patchConfig\(\{\s*pinnedCards: \['focus', 'timer'\]\s*\}\)/)
  assert.match(settings, /media\.injectGhost\(\)/)
  assert.match(media, /function injectGhost\(\)/)
  assert.match(media, /injectGhost,/)
})

test('调试入口不是卡片：不进 SEARCH_INDEX（否则会出现在管理显示内容 / 搜索）', () => {
  assert.doesNotMatch(display, /debugTools/)
  assert.match(app, /v-if="!searchActive && activeTab === 'dev'" class="card"/)
})

test('调试按钮只在开关打开后渲染（默认看不到）', () => {
  const at = app.indexOf('调试工具 <em>')
  assert.ok(at >= 0, '找不到调试工具区块')
  const block = app.slice(at, at + 900)
  assert.match(block, /v-if="cfg\.debugTools"/)
  assert.match(block, /patchCfg\(\{ debugTools:/)
})
