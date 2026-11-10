// test/debug-tools.test.mjs
// 调试入口的「默认关闭 + 生产 UI 不出现 + 不污染正常 tick」三条硬约束。
// 这些入口以前只能靠拖拽 / 改 leveldb 才能验证，所以固定成可复现的按钮；
// 但绝不能变成普通用户能点到的功能，也不能把真实幂等位写脏。
// 实现已从 settings.js 抽到 lib/debug-tools.js（settings.js 贴着行数棘轮），断言随之改读新文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const store = read('public/preload/lib/store.js')
const settings = read('public/preload/lib/settings.js')
const debug = read('public/preload/lib/debug-tools.js')
const ipc = read('public/preload/lib/ipc.js')
const media = read('public/preload/lib/media.js')
const app = read('src/App.vue')
const dev = read('src/views/DevView.vue')
const display = read('src/constants/display.ts')

test('配置四处同步：default / read / write / patch 都有 debugTools，默认 false', () => {
  // focusGoal 与 debugTools 之间现在隔着下班倒计时九键，不再相邻
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
  // 四个入口统一走同一个开关判定，逐个核它自己那一段
  for (const fn of ['function debugTodoDue(', 'function debugInjectLegacy(', 'function debugFocusCheck(', 'function debugTimerCheck(']) {
    const i = debug.indexOf(fn)
    assert.ok(i >= 0, '缺少调试入口 ' + fn)
    assert.match(debug.slice(i, i + 200), /readConfig\(\)\.debugTools !== true/)
  }
  // settings.js 只是转交：四个方法都要挂到对外 API 上，且不得自己再写一份实现
  for (const k of ['debugTodoDue', 'debugInjectLegacy', 'debugFocusCheck', 'debugTimerCheck']) {
    assert.match(settings, new RegExp('^\\s{2}' + k + ':', 'm'))
  }
})

test('专注 / 计时自检只读：不写账本、不改配置、不动计时', () => {
  for (const fn of ['function debugFocusCheck(', 'function debugTimerCheck(']) {
    const i = debug.indexOf(fn)
    const body = debug.slice(i, debug.indexOf('\n}\n', i))
    assert.doesNotMatch(body, /writeTodo|writeFocus|patchConfig|writeTimer|clearTimer|readConfig\(\),\s*\{/)
  }
})

test('调试工具卡：专注 / 待办 / 计时 三条自检各自一行结果，注入旧数据排在最后', () => {
  // 三条自检由常量数组驱动，每行独立取自己的结果
  for (const k of ['focus', 'todo', 'timer']) {
    assert.match(dev, new RegExp("key: '" + k + "'"))
  }
  assert.match(dev, /row\(r\.key\)\.msg/)
  // 结果就地写在行内，不再有全局「调试结果」槽
  assert.doesNotMatch(app + dev, /调试结果：/)
  // 会真写入的那条沉底：「注入旧数据」所在行必须排在「演练提醒」行之后（注释里也提到它，故比模板部分）
  const tpl = dev.slice(dev.indexOf('<template>'))
  assert.ok(tpl.indexOf('注入旧数据') > tpl.indexOf('演练提醒'))
})

test('「立即触发提醒」走真实两条通道，但回执带 debug 标记、不写幂等位', () => {
  assert.match(debug, /require\('\.\/ipc'\)\.sendWidgetCmd\('todo-due',\s*\{[^}]*debug: true/)
  assert.match(ipc, /if \(d\.debug === true\) return/)
})

test('「注入旧数据」三类现场齐全：remindedFor=0 重复提醒 / focus+timer 双置顶 / 幽灵媒体', () => {
  assert.match(debug, /remindKind: 'daily'[\s\S]{0,120}remindedFor: 0, notifiedFor: 0/)
  assert.match(debug, /patchConfig\(\{\s*pinnedCards: \['focus', 'timer'\]\s*\}\)/)
  assert.match(debug, /media\.injectGhost\(\)/)
  assert.match(media, /function injectGhost\(\)/)
  assert.match(media, /injectGhost,/)
  // 注入后要把两份快照推回挂件与设置页（emit 由 settings.js 传入）
  assert.match(settings, /debugInjectLegacy: \(\) => debugTools\.debugInjectLegacy\(\(\) => \{[\s\S]{0,200}pushConfig\(\)[\s\S]{0,120}pushTodo\(\)/)
})

test('调试入口不是卡片：不进 SEARCH_INDEX（否则会出现在管理显示内容 / 搜索）', () => {
  assert.doesNotMatch(display, /debugTools/)
  // v1.18：整张卡只在 uTools 开发模式下渲染（devMode 现取 services.isDev()）；
  // 打包版连 DOM 都不建 —— 卡里有「注入旧数据」会真写库，对普通用户只有误点风险
  assert.match(app, /v-if="devMode && !searchActive && activeTab === 'dev'"/)
  assert.match(app, /const devMode = computed\(\(\) => \{[\s\S]{0,120}services\.isDev\?\.\(\)/)
  assert.match(settings, /isDev\(\) \{[\s\S]{0,120}utools\.isDev\(\)/)
  assert.doesNotMatch(app, /activeTab === 'dev'" class="card"/)
})

test('调试按钮只在开关打开后渲染（默认看不到）', () => {
  assert.match(dev, /v-if="debugOn"/)
  assert.match(app, /:debug-on="cfg\.debugTools"/)
  assert.match(app, /@toggled="patchCfg\(\{ debugTools: \$event \}\)"/)
})
