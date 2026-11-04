// test/timer-section-fold.test.mjs
// 计时卡降噪：低频分区（休息与番茄 / 计时气泡与状态）默认收起，标题整行可点；
// 收起时标题尾注给一行状态摘要；搜索命中时强制展开（否则「搜到了却看不到控件」）。
// 另含两处文案/命名对齐：默认时长不再写「0 时 0 分 0 秒按 25 分钟算」、显示管理条目改名「计时设置」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const timer = read('src/views/TimerView.vue')
const app = read('src/App.vue')
const display = read('src/constants/display.ts')
const tpl = timer.slice(timer.indexOf('<template>'), timer.lastIndexOf('</template>'))

test('低频分区标题可折叠：整行可点 + aria-expanded', () => {
  assert.match(tpl, /class="card-sub card-sub-toggle"/, '折叠标题应复用 .card-sub 并带 toggle 标记')
  for (const key of ['rest', 'bubble']) {
    assert.match(tpl, new RegExp(`:aria-expanded="foldOpen\\('${key}'\\)"`), `${key} 分区缺 aria-expanded`)
    assert.match(tpl, new RegExp(`@click="toggleFold\\('${key}'\\)"`), `${key} 分区标题不可点`)
  }
  assert.match(tpl, /role="button"/, '折叠标题需要按钮语义')
})

test('收起时标题尾注给状态摘要（休息/番茄、气泡三开关）', () => {
  assert.match(tpl, /restBrief/, '休息与番茄收起时没有摘要')
  assert.match(tpl, /bubbleBrief/, '计时气泡与状态收起时没有摘要')
  assert.match(timer, /const restBrief = computed/, '缺 restBrief')
  assert.match(timer, /const bubbleBrief = computed/, '缺 bubbleBrief')
})

test('搜索命中时强制展开，并接收 searchActive', () => {
  assert.match(timer, /props\.searchActive \? !searchFoldClosed\.value\[key\] : folds\.value\[key\]/, 'foldOpen 没按搜索态分支')
  assert.match(timer, /searchActive: boolean/, 'TimerView 缺 searchActive prop')
  assert.match(app, /:search-active="searchActive"/, '父卡没把 searchActive 传给 TimerView')
})

test('默认时长不再写「0 时 0 分 0 秒按 25 分钟算」，改为短提示', () => {
  assert.doesNotMatch(tpl, /0 时 0 分 0 秒按 25 分钟算/, '旧长提示应替换')
  assert.match(tpl, /填 0 按 25 分钟/, '缺短提示')
})

test('显示管理里计时条目改名「计时设置」', () => {
  assert.match(display, /timer: \{ label: '计时设置'/, 'SEARCH_INDEX.timer 的 label 未改名')
})
