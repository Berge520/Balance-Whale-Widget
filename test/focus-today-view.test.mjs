import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const view = read('src/views/FocusView.vue')
const tpl = view.slice(view.indexOf('<template>'), view.lastIndexOf('</template>'))

test('分区顺序：今日 → 待办 → 统计 → 明细', () => {
  // 统计 / 明细是折叠分区（class 上多挂 card-sub-toggle），故允许修饰类
  const heads = [...tpl.matchAll(/<h3 class="card-sub(?=[\s"])[^>]*>([^<]*)/g)].map((m) => m[1].trim())
  assert.deepEqual(heads, ['今日', '待办清单', '专注统计', '专注明细'])
})

test('今日块含摘要 + 目标 + 待办计划行，统计段不再重复摘要', () => {
  const today = tpl.slice(tpl.indexOf('<h3 class="card-sub">今日'), tpl.indexOf('<h3 class="card-sub">待办清单'))
  assert.match(today, /statsSummary/, '今日块缺统计摘要')
  assert.match(today, /focus-goal/, '每日目标没上移到今日块')
  assert.match(today, /todoPlanText/, '今日块缺待办计划行')
  // 从分区标题处截起（模板顶部的注释里也出现过「专注统计」，不能用裸 indexOf）
  const stat = tpl.slice(tpl.indexOf('专注统计<span'))
  assert.doesNotMatch(stat, /statsSummary/, '统计段还在重复摘要')
  assert.match(stat, /focus-bars/, '统计段缺柱图')
  assert.match(stat, /heatHasData/, '统计段缺热力图')
})

test('待办计划行按 est - rounds 求和，未填预估不计', () => {
  assert.match(view, /const todoPlanText = computed\(/)
  const fn = view.slice(view.indexOf('const todoPlanText = computed('), view.indexOf('const todoPlanTitle'))
  assert.match(fn, /Math\.max\(0, est - \(Number\(it\.rounds\) \|\| 0\)\)/)
  assert.match(fn, /待办 \$\{items\.length\} 条/)
  assert.match(fn, /预估剩 \$\{left\} 轮/)
})

test('待办行：有预估显示 X/Y 轮，无预估但有历史显示累计', () => {
  assert.match(tpl, /\{\{ it\.rounds \}\}\/\{\{ it\.est \}\} 轮/, '主行没显示预估进度')
  assert.match(tpl, /累计 \{\{ it\.rounds \}\} 轮/, '无预估时没显示累计')
  assert.match(tpl, /:title="'累计完成 ' \+ it\.rounds \+ ' 轮 \/ 预估 ' \+ it\.est \+ ' 轮'"/)
})

test('待办清单不再有「先开专注记录」的旧提示', () => {
  assert.doesNotMatch(tpl, /todo-focus-off/)
})

test('focusOn 关闭时今日块不显示轮次规则；开关说明写清不挡任务', () => {
  const start = tpl.indexOf('<h3 class="card-sub">今日')
  const end = tpl.indexOf('<h3 class="card-sub">待办清单')
  const today = tpl.slice(start, end)
  const rule = today.indexOf('倒计时走完算 1 轮')
  assert.ok(rule > today.indexOf('<template v-if="cfg.focusOn">'), '轮次规则应在 focusOn 分支内')
  assert.match(today, /不挡任务开始/, '开关说明没写清解耦后的边界')
})
