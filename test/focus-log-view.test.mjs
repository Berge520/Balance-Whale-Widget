/*
 * 专注「明细 / 统计」层下线后的防回退契约（v1.16）。
 *
 * 背景：设置页原先有一段「专注明细」列表（按天分组、每行带模式 / 休息 / 放弃徽标，
 * 头上「N 轮 · M 分钟」取宿主天表），另外还有柱图与今日摘要。它们要求用户额外维护
 * 「设目标 → 对齐 → 看进度」的习惯，而「算不算一轮」的判定又严格（宿主 isRound 只认
 * 倒计时走完且非休息非放弃）——做了正计时却显示 0 轮，反而像没记上。故整层下线。
 *
 * 这里做契约断言（没有 Vue 测试运行器，按本仓对 .vue 的既有做法读源码）：
 * ① 明细列表的代码与类型不再被设置页消费（FocusSession 等宿主类型仍保留，可逆）；
 * ② 计时卡只能指向「还在的地方」，不能指向已删的「专注统计」；
 * ③ 挂件空态引导措辞仍只收敛一处，且不再说「番茄钟」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const view = read('src/views/FocusView.vue')
const dts = read('src/types/services.d.ts')
const timer = read('src/views/TimerView.vue')
const page = read('public/floating-page.js')

// 去掉注释后的源码：注释里允许写「为什么移除」，判断运行时行为时不能把注释算进去
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
const code = strip(view)

test('设置页：明细列表的代码整体下线', () => {
  // v1.16 统计层下线：分组、徽标、休息行口径说明都随明细列表删除。
  // 宿主 focusStatsPayload / focus.js 仍保留在 preload 里（数据不丢，日后可接回）
  assert.doesNotMatch(code, /sessionGroups|sessions|focus-log|fmtClock|MODE_LABEL|sessionTitle/, '明细列表相关代码应已移除')
})

test('设置页：不再引用专注统计的订阅与口径说明', () => {
  assert.doesNotMatch(code, /onFocusChange/, '仍在订阅专注轮次变化（本页已不显示轮次）')
  assert.match(code, /onTodoChange/, '待办订阅丢了')
  // 模板里可以出现，只查脚本段与模板正文都不许再有这两句口径
  assert.doesNotMatch(strip(view), /只记时长|倒计时走完算/, '轮次口径说明应随统计层一起移除')
})

test('FocusSession 类型仍保留（宿主侧未删，日后可接回）', () => {
  // 只断言类型声明还在：设置页暂时不消费，但 services.d.ts 是宿主契约的镜像，
  // 宿主 focus.js / focusStatsPayload 仍产出这些字段
  assert.match(dts, /export interface FocusSession \{/, 'FocusSession 类型被误删')
})

test('一轮口径不再在两处复述，计时卡指向仍在的「待办与计时」卡', () => {
  assert.doesNotMatch(timer, /会记一轮|算\s*1\s*轮|不算一轮/, '计时卡复述了一轮口径')
  // 合并成单卡后不再有互跳按钮；v1.16 起「专注统计」已不存在，指向改成合并卡本身
  assert.doesNotMatch(timer, /见上面的「专注统计」/, '计时卡还在指向已删除的专注统计分区')
  assert.match(timer, /const focusRulesHint = computed/, '计时卡指向文案没有按专注卡显隐分支')
  assert.match(timer, /\{\{ focusRulesHint \}\}/, '计时卡模板没有消费 focusRulesHint')
})

test('挂件：待办空态只有「还没有待办 + 点击添加」两句', () => {
  // v1.16 统计层下线后，空态不再需要解释「待办怎么和专注记录联动」，
  // 只留两句：灰底说明 + 蓝色引导（各自走共享 helper，别处不许手写 class）
  assert.match(page, /todoListEl\.appendChild\(menuHint\('还没有待办'\)\)/, '空态首句被改掉了')
  assert.match(page, /todoListEl\.appendChild\(menuHintAct\('点击下方输入框快速添加'\)\)/, '空态引导行被改掉了')
  assert.doesNotMatch(page, /开启计时器或番茄钟/, '「番茄钟」不是本插件的叫法，组内提示统一说计时')
})
