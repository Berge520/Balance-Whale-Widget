// test/copy-concise.test.mjs
// 合并卡文案契约：说明句只留「用户不知道的那一半」，不复述控件语义。
// 钉住几条最容易回潮的长句（历史上每加一个开关就往说明里补一句，越补越长）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const timer = read('src/views/TimerView.vue')
const focus = read('src/views/FocusView.vue')
const app = read('src/App.vue')

test('计时卡说明压到一句话，不再复述「哪些操作只影响那一轮」', () => {
  assert.match(timer, /这里只设<b>默认值<\/b>/, '首段说明应压成「这里只设默认值」')
  assert.doesNotMatch(timer, /想改下一次倒计时的起点/, '旧的长句还在')
  assert.doesNotMatch(timer, /点快捷档位开始的那一轮按档位分钟数倒计时/, '快捷档位的复述句还在')
})

test('开关的 em 提示不复述「开启时会怎样」', () => {
  assert.doesNotMatch(timer, /开启：计时中气泡一直显示/, '计时气泡常驻的复述提示还在')
  assert.doesNotMatch(timer, /开启：气泡只显示计时/, '只显计时的复述提示还在')
  assert.doesNotMatch(timer, /休息结束后 3 秒自动开始下一轮/, '自动衔接的复述提示还在')
})

test('专注卡不再解释轮次口径与图表怎么画', () => {
  // v1.16 专注统计层下线：页面上已不显示轮数，「什么算一轮」这句解释失去锚点，一并删除；
  // 日后要接回统计，先把轮数显示加回来，再补这句（否则读者不知道这句在说什么）
  assert.doesNotMatch(focus, /柱状图与热力图统计的是/, '图表解释句还在')
  assert.doesNotMatch(focus, /倒计时走完算 1 轮/, '轮次口径说明应随统计层一起移除')
})

test('父卡说明一行讲清主线', () => {
  // v1.16：计时拆成同卡内的独立分区后，这里只说「默认值不在这」；
  // 到点提醒已迁到「提醒与通知」卡，不再由这句话指路
  assert.match(app, /待办可直接开始计时，也可挂提醒；计时默认值在下方「计时设置」里调。/, '父卡说明没有压到一行')
})
