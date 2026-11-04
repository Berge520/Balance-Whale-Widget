// test/settings-pin-merge.test.mjs
// 合并卡里一个卡根挂着两个 data-search（timer / focus）：置顶与排序必须按卡根算，
// 否则「置顶计时」会把子块从合并卡里搬出去、卡内顺序被打乱。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')

test('置顶按卡根解析并去重（合并卡的两个子块只算一张卡）', () => {
  const start = app.indexOf('function syncPinned()')
  const end = app.indexOf('// 依赖变化后重排', start)
  assert.ok(start > 0 && end > start, '找不到 syncPinned 函数体')
  const body = app.slice(start, end)
  assert.match(body, /closest\('\.card'\)/, 'syncPinned 应把 data-search 节点解析到卡根')
  assert.match(body, /new Set[<(]/, 'syncPinned 应对卡根去重')
})

// 真机事故（2026-11-02）：syncPinned 用 insertBefore 搬卡根后，生产构建里切 Tab
// 会出现旧卡残留 / 重复（dev 正常）。Vue 的 v-if 分支靠注释锚点定位，搬正在渲染的
// 节点会让卸载与重挂都算错位置 —— 排序只许改 CSS order，不许碰 DOM 树。
test('置顶排序只写 CSS order，不搬 DOM（搬 v-if 节点会丢锚点）', () => {
  const start = app.indexOf('function syncPinned()')
  const end = app.indexOf('// 依赖变化后重排', start)
  assert.ok(start > 0 && end > start, '找不到 syncPinned 函数体')
  const body = app.slice(start, end)
  assert.doesNotMatch(body, /insertBefore|appendChild|insertAdjacent|replaceChild|\.remove\(\)/, 'syncPinned 不得搬动/删除 Vue 管理的节点')
  assert.match(body, /setPinOrder\(/, 'syncPinned 应通过 setPinOrder 写排序')
  const helper = app.slice(app.indexOf('function setPinOrder('), app.indexOf('// 给当前 Tab 的置顶卡根写 order'))
  assert.match(helper, /style\.setProperty\('order'/, 'setPinOrder 应只写 CSS order')
})

test('置顶排序容器已就绪：.pin-scope 与资源组外包容器都是 flex 列', () => {
  assert.match(app, /\.pin-scope\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/, '.pin-scope 必须是 flex 列容器，负 order 才生效')
  // 行内说明的 order 必须小于置顶卡基数（-1000），否则置顶卡会跑到 Tab 描述上方
  assert.match(app, /\.pin-scope > \.tab-desc\s*\{[^}]*order:\s*-(3\d{3}|[4-9]\d{3}|\d{4,})/, 'Tab 描述应排在置顶卡之前')
  assert.match(app, /\.pin-scope > \.pin-head\s*\{[^}]*order:\s*-2001/, '置顶区标题应紧贴置顶卡之前')
  const assets = fs.readFileSync(new URL('../src/views/AssetsView.vue', import.meta.url), 'utf8')
  assert.match(assets, /<div class="assets-scope">/, '资源组外包容器缺少 class')
  assert.match(assets, /\.assets-scope\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/, '资源组外包容器必须是 flex 列，卡根 order 才生效')
})

test('父卡承担置顶标记（子块不再各自挂 card-pinned）', () => {
  const start = app.indexOf('class="card focus-timer-card"')
  const block = app.slice(start, start + 600)
  assert.match(block, /'card-pinned': isPinned\('timer'\) \|\| isPinned\('focus'\)/, '父卡缺少整卡置顶标记')
  assert.doesNotMatch(block, /cardCls\('timer'\)|cardCls\('focus'\)/, '子块不应再各自挂置顶标记')
})
