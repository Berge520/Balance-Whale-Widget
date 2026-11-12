import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const view = read('src/views/FocusView.vue')
const tpl = view.slice(view.indexOf('<template>'), view.lastIndexOf('</template>'))
// 去掉注释后的模板：注释里允许写「为什么移除某物」，判断运行时行为时不能把注释算进去
const tplCode = tpl.replace(/<!--[\s\S]*?-->/g, '')
const code = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
const css = view.slice(view.lastIndexOf('<style'))
const page = read('public/floating-page.js')
const block = (src, start, end) => {
  const from = src.indexOf(start)
  assert.ok(from >= 0, `找不到 ${start}`)
  const to = src.indexOf(end, from)
  assert.ok(to > from, `找不到 ${end}`)
  return src.slice(from, to)
}

test('分区顺序：今日 → 待办 → 已完成', () => {
  // 折叠分区（class 上多挂 card-sub-toggle），故允许修饰类
  const heads = [...tpl.matchAll(/<h3 class="card-sub(?=[\s"])[^>]*>([^<]*)/g)].map((m) => m[1].trim())
  assert.deepEqual(heads, ['今日', '待办清单', '已完成'])
})

const todayStart = () => tpl.search(/<h3 class="card-sub(?=[\s"])[^>]*>\s*今日/)
const todoStart = () => tpl.search(/<h3 class="card-sub(?=[\s"])[^>]*>\s*待办清单/)

test('今日块只留一个总开关，没有统计摘要与每日目标', () => {
  const today = tplCode.slice(todayStart(), todoStart())
  assert.match(today, /:checked="cfg\.todoOn"/, '今日块缺待办与计时总开关')
  // v1.16 下线：今日轮数 / 连续天数摘要、每日目标输入与进度条
  assert.doesNotMatch(today, /statsSummary|focus-goal|goalInput|goalProgress/, '统计摘要 / 每日目标应已下线')
  // 待办计划行（按 est 预估求和）v1.15 移除
  assert.doesNotMatch(today, /todoPlanText/, '待办计划行应已移除')
})

test('统计 / 记录层的代码与样式都已移除', () => {
  assert.doesNotMatch(code, /focus-bars|barMax|barH\(/, '柱图应已移除')
  assert.doesNotMatch(code, /heatHasData|heatStats|heatLevel|heatCells/, '热力图应已移除')
  assert.doesNotMatch(code, /trendText|日均|reviewText/, '趋势 / 日均 / 回顾应已移除')
  assert.doesNotMatch(code, /sessionGroups|sessions|focus-log|fmtClock|MODE_LABEL/, '专注明细应已移除')
  assert.doesNotMatch(code, /focusGoal|focus-goal|todayRoundsOf|statsSummary/, '轮数 / 目标相关代码应已移除')
  // 不再订阅专注轮次变化：本页已不显示轮次与明细，只有待办需要跟随宿主推送
  assert.doesNotMatch(code, /onFocusChange/, '仍在订阅 onFocusChange')
  assert.match(code, /onTodoChange/, '待办订阅丢了')
})

test('待办行不再挂「当前任务 / 专注中」标签', () => {
  // focusId 到点 / 暂停 / 打完卡都不会清，任何常驻标签都会像「还在专注」——
  // 状态只靠行底色 + 按钮淡化暗示，模板里不留这块
  assert.doesNotMatch(tpl, /class="todo-tag"/, '当前任务标签应已移除')
  assert.doesNotMatch(tpl, />专注中</, '专注中标签应已移除')
  assert.doesNotMatch(css, /\.todo-tag/, '无用的 .todo-tag 样式应清掉')
  assert.doesNotMatch(tplCode, /今日 \{\{ todayRoundsOf/, '今日轮数徽标应已下线')
  // 累计轮数（后续版本恢复）：宿主回填的派生值，只在 >0 时占位，不解释口径
  assert.match(tplCode, /class="todo-rounds"/, '累计轮数徽标应显示')
  assert.match(tplCode, /v-if="it\.rounds > 0"/, '没有轮数时不该占位')
  assert.doesNotMatch(tpl, /it\.est/, '模板仍引用预估 est')
  assert.doesNotMatch(view, /todoSetEst\?\./, '脚本仍调用 todoSetEst')
})

test('已完成条目：实线划掉但留在原位，不删除', () => {
  // 一条 1px 实线（不是默认细到看不见的 line-through），条目仍在 doneList 里渲染
  assert.match(css, /\.todo-item\.done \.todo-text \{[^}]*line-through/, '已完成应划掉')
  assert.match(css, /text-decoration-thickness: 1px/, '划线要显式给 1px 实线')
  assert.match(tplCode, /v-for="it in doneList"/, '已完成条目应仍渲染在清单里（不删）')
  // 挂件：到点自动勾掉当前专注项，且勾掉的那条留在原位（todoJustDone 不随回推清空）
  assert.match(page, /function autoCompleteFocusedTodo/, '缺少到点自动完成')
  const fin = block(page, 'function finishTimer', '\n  function ')
  assert.match(fin, /autoCompleteFocusedTodo\(\)/, 'finishTimer 应调用自动完成')
  const auto = block(page, 'function autoCompleteFocusedTodo', '\n  // 到点：提示音')
  assert.match(auto, /todoJustDone\[f\] = true/, '自动完成前应先记进 todoJustDone（回推后留在原位）')
  assert.doesNotMatch(auto, /todoJustDone = \{\}/, '自动完成内部不得清空痕迹')
  // 只有「重开菜单」这一处允许清空（见 toggleMenu），另两处是变量声明与 todo-start 开新一轮
  const clears = [...page.matchAll(/todoJustDone = \{\}/g)]
  assert.equal(clears.length, 3, '清空点只应有声明 / toggleMenu / startTodoTimer 三处')
})

test('已完成项独立折叠，与未完成分开渲染', () => {
  assert.match(code, /const openTodoList = computed/, '未完成列表应单独派生')
  assert.match(code, /const doneList = computed/, '已完成列表应单独派生')
  assert.doesNotMatch(code, /orderedTodo/, '混排的 orderedTodo 应已移除')
  // 已完成折叠组默认收起：勾掉只是留着对账，不该继续占今天的视线
  assert.match(code, /done: useFold\('focusDone', false\)/)
})

test('行内提醒默认收起，收起态仍有摘要', () => {
  assert.match(view, /const remindOpen = ref<Record<string, boolean>>\(\{\}\)/, '提醒应自持折叠态且默认收起')
  assert.match(tpl, /v-if="remindOpen\[it\.id\]" class="todo-remind"/, '提醒控件应受折叠控制')
  assert.match(tpl, /todo-remind-brief/, '收起态缺提醒摘要')
})

test('待办清单不再有「先开专注记录」的旧提示', () => {
  assert.doesNotMatch(tpl, /todo-focus-off/)
})

test('今日块只说开关影响，不再提轮次规则', () => {
  const today = tplCode.slice(todayStart(), todoStart())
  // 轮次规则随统计层下线：不再解释「怎么算一轮」，因为已经不显示轮数了
  assert.doesNotMatch(today, /倒计时走完算 1 轮/, '轮次规则应已随统计层移除')
  // 两个开关并成一个（v1.15）：设置页里不许再出现「专注记录」这个独立勾选框
  assert.doesNotMatch(today, /cfg\.focusOn/, '今日块还引用着已合并的 focusOn')
  // 关掉后计时与番茄循环照常工作，文案要说到
  assert.match(today, /计时设置/, '开关说明没指向计时设置')
})
