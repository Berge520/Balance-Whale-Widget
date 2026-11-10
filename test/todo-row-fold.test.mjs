// test/todo-row-fold.test.mjs
// 待办行降噪：计时 / 时长 / 提醒 / 改名收进「更多」，折叠态用一行摘要兜住非默认设置，
// 避免「收起来就看不见」。断言放在源级（本仓设置页没有组件测试环境，与 card-sub-shared 同范式）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const view = fs.readFileSync(new URL('../src/views/FocusView.vue', import.meta.url), 'utf8')
const tpl = view.slice(view.indexOf('<template>'), view.lastIndexOf('</template>'))

test('设置项收进「更多」折叠块，且块内三类控件齐全', () => {
  assert.match(tpl, /v-if="openTodo\[it\.id\]"\s+class="todo-adv"/, '高级设置块应由 openTodo 门控')
  const at = tpl.indexOf('class="todo-adv"')
  assert.ok(at > 0, '找不到 .todo-adv 块')
  const block = tpl.slice(at, tpl.indexOf('</div>', at))
  // 「预估轮数」输入框 v1.15 移除（与每日目标是两套口径），块内不再有它
  for (const label of ['计时', '提醒', '改名']) {
    assert.ok(block.includes(label), `.todo-adv 里缺「${label}」`)
  }
  assert.doesNotMatch(block, /预估/, '预估轮数应已移除')
})

test('折叠态有一行摘要：计时 / 提醒的非默认值都可见', () => {
  assert.match(tpl, /todoBrief\(it\)/, '折叠态没渲染摘要')
  assert.match(view, /function todoBrief\(/, '缺 todoBrief()')
  assert.match(view, /function remindBrief\(/, '缺 remindBrief()')
  assert.match(view, /class="todo-sum"/, '摘要没有自己的行内元素')
})

test('折叠按钮可访问，改名时自动收起', () => {
  assert.match(tpl, /:aria-expanded="!!openTodo\[it\.id\]"/, '折叠按钮缺 aria-expanded')
  const start = view.indexOf('function startEdit(')
  const body = view.slice(start, view.indexOf('\n}', start))
  assert.match(body, /openTodo\.value\[it\.id\] = false/, '进入改名时应收起高级设置块')
})
