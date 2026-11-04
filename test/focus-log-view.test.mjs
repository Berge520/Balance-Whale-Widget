/*
 * 「专注与待办」卡的明细列表必须和柱状图/热力图同源同口径。
 *
 * 背景：P1 把专注记录改成会话优先（lib/focus.js 的 v2 模型）后，明细里出现了
 * 「只记时长、不算一轮」的行（正计时、定时、中途放弃、休息）。而设置页原先是把
 * 明细条数直接当轮数（`cur.r += 1`），于是「列表 3 条 · 3 轮」和上方柱图的「1 轮」
 * 打架 —— 正是这次重构要消灭的那类「两个账本各记各的」。
 *
 * 这里做契约断言（没有 Vue 测试运行器，按本仓对 .vue 的既有做法读源码）：
 * ① 分组头的数字取宿主天表（stats.series），不在页面里再算一份口径；
 * ② 不计轮的会话行要有徽标，读者能自己解释「为什么这条不算一轮」；
 * ③ 卡片文案要按新口径描述（什么算轮、什么只记时长），不能还写「倒计时走完自动记一轮」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const view = read('src/views/FocusView.vue')
const dts = read('src/types/services.d.ts')

// 只取 sessionGroups 这一段，避免整文件的巧合匹配
const blockOf = (src, startRe, endMark) => {
  const m = startRe.exec(src)
  assert.ok(m, `找不到片段起点：${startRe}`)
  const end = src.indexOf(endMark, m.index + 1)
  assert.ok(end > m.index, `找不到片段终点：${endMark}`)
  return src.slice(m.index, end)
}
const groups = blockOf(view, /const sessionGroups = computed[^{]*\{/, '\n// 有历史统计')

test('分组头的轮数与分钟来自宿主天表，不在页面里重算一份口径', () => {
  assert.doesNotMatch(groups, /cur\.r \+= 1/, '轮数仍按「明细条数」累加：正计时/放弃/休息会被算成一轮')
  assert.doesNotMatch(groups, /cur\.m \+= s\.m/, '分钟仍在页面里自己累加：休息行会让列表比柱状图多')
  assert.match(groups, /dayAgg|seriesByDate/, '分组头没有读宿主天表（stats.series）')
})

test('不计轮的会话行有徽标：模式 / 休息 / 放弃', () => {
  assert.match(view, /class="focus-log-badge/, '明细行没有徽标元素')
  assert.match(view, /s\.b/, '没有渲染休息标记')
  assert.match(view, /s\.a/, '没有渲染放弃标记')
  assert.match(view, /s\.k/, '没有渲染计时方式标记')
  for (const label of ['休息', '放弃', '正计时', '定时']) {
    assert.ok(view.includes(label), `徽标缺少文案「${label}」`)
  }
})

test('卡片文案按会话模型口径描述，不再只说「倒计时走完记一轮」', () => {
  assert.doesNotMatch(view, /倒计时走完自动记一轮/, '开关描述还是旧口径')
  assert.doesNotMatch(view, /正计时、定时与「休息」都不计/, '正计时与定时现在计时长，这句已经不成立')
  assert.match(view, /只记时长/, '文案没说明「不算一轮但记时长」这一档')
})

// 分组头那一行的「N 轮 · M 分钟」取天表，而 deriveDays 聚合时把休息整行排除：
// 轮数和时长都不进。早先行内说明统一写「只记时长」，休息行就会和分组头对不上
// （列表里 5 分钟休息、头上却不涨），读者以为页面漏算。休息要单独一句。
test('休息行的说明写清「轮数和时长都不计入」，不与分组头口径冲突', () => {
  const title = blockOf(view, /function sessionTitle\(/, '\n}')
  assert.match(title, /s\.b/, '休息行没有单独的口径说明')
  assert.match(title, /轮数和时长都不/, '休息行要写明连时长都不进天表')
})

// 「什么算一轮」这张口径只该有一处措辞。计时卡早先也写了一句「倒计时走完…会记一轮」，
// 会话模型把正计时/定时/放弃/休息都纳进来之后，那句就变成了错的窄口径 —— 两处复述必然有一处会过期，
// 所以计时卡只负责「去哪儿看」，口径本身归专注卡。
test('一轮口径只在专注卡说一次，计时卡不复述', () => {
  const timer = read('src/views/TimerView.vue')
  const page = read('public/floating-page.js')
  assert.doesNotMatch(timer, /会记一轮|算\s*1\s*轮|不算一轮/, '计时卡复述了一轮口径：改模型时容易漏改这一处')
  // 合并成单卡后不再有互跳按钮：计时卡只需指向同卡的「专注统计」，口径本身仍只在专注卡说
  assert.match(timer, /见上面的「专注统计」/, '计时卡没有指向同卡的专注统计')
  assert.match(timer, /const focusRulesHint = computed/, '计时卡指向文案没有按专注卡显隐分支')
  assert.match(timer, /\{\{ focusRulesHint \}\}/, '计时卡模板没有消费 focusRulesHint')
  const ruleSaid = [...view.matchAll(/倒计时走完算/g)].length
  assert.equal(ruleSaid, 1, '「倒计时走完算 1 轮」在专注卡里出现多处')
  // 快捷键气泡的「还没记录」提示也复述过一次窄口径，同一句只该留一处
  assert.doesNotMatch(page, /倒计时走完即自动记一轮/, '挂件气泡复述了窄口径')
  // 挂件里两处「还没有专注记录」的引导（专注组副提示 + 快捷键气泡）用同一句，别各写各的
  const guide = [...page.matchAll(/跑一段计时就自动记上/g)].length
  assert.equal(guide, 2, `挂件空态引导措辞应收敛为同一句，实际出现 ${guide} 处`)
  assert.doesNotMatch(page, /开启计时器或番茄钟/, '「番茄钟」不是本插件的叫法，组内提示统一说计时')
})

// 空态引导同样不能只指「倒计时走完」：现在任何一段计时都会进明细，只是不一定算一轮
test('专注卡空态引导按会话模型描述，不只提倒计时', () => {
  assert.doesNotMatch(view, /计时器倒计时走完就会自动记上/, '空态还是窄口径：正计时/定时也会留明细')
})

test('FocusSession 类型带上会话模型字段', () => {
  const iface = blockOf(dts, /export interface FocusSession \{/, '\nexport interface UsageHistoryResult')
  for (const field of ['id', 's', 'k', 'b', 'a']) {
    assert.match(iface, new RegExp('\\b' + field + '\\??\\s*[:=]'), `FocusSession 缺字段 ${field}`)
  }
})
