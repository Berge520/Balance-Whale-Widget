import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const app = read('src/App.vue')
const timer = read('src/views/TimerView.vue')
const focus = read('src/views/FocusView.vue')

test('合并卡只有一个标题，写在父卡上', () => {
  const start = app.indexOf('class="card focus-timer-card"')
  const end = app.indexOf('</section>', start)
  const block = app.slice(start, end)
  // v1.16：卡名改为「待办与计时」（专注统计层下线后卡里只剩待办与计时）
  assert.match(block, /<h2 class="card-toggle"[^>]*>[\s\S]*?待办与计时/, '父卡缺少唯一标题（折叠标题）')
  assert.match(block, /<TimerView/, '父卡缺 TimerView')
  assert.match(block, /<FocusView/, '父卡缺 FocusView')
  assert.equal((block.match(/<h2\b/g) || []).length, 1, '父卡里只能有一个 h2')
  assert.ok(block.indexOf('<FocusView') < block.indexOf('<TimerView'), '行动优先：FocusView 应在 TimerView 之前')
  // 只剩专注子卡时，折叠摘要不能还写「计时设置」；v1.16 起也不再提已下线的统计
  assert.match(block, /cardOn\('usage', 'focus'\) \? \(cardOn\('usage', 'timer'\) \? '待办清单 · 计时设置' : '待办清单'\)/, '折叠摘要没有按 timer 子卡可见性分支')
})

test('两个子块不再自带 h2 与卡片外框', () => {
  for (const [name, src, key] of [['TimerView', timer, 'timer'], ['FocusView', focus, 'focus']]) {
    const tpl = src.slice(src.indexOf('<template>'))
    assert.doesNotMatch(tpl, /<h2>/, `${name} 还留着自己的 h2`)
    assert.match(tpl, new RegExp(`<section class="card-embedded" data-search="${key}">`), `${name} 根节点应是 card-embedded 分区`)
  }
})

test('不再有卡内互跳按钮', () => {
  assert.doesNotMatch(timer, /go-card/, 'TimerView 还留着 go-card')
  assert.doesNotMatch(focus, /go-card/, 'FocusView 还留着 go-card')
  assert.doesNotMatch(app, /@go-card=/, '父卡还绑着 @go-card')
  assert.match(app, /\.card-embedded\s*\{/, '去外框规则应直接落在 .card-embedded 上')
})
