// test/card-fold-coverage.test.mjs
// 「每张卡都能折叠」的覆盖契约：
// ① 所有 view 的卡片都有 card-toggle 标题与 useFold 状态（合并卡在 App.vue 里单独断言）；
// ② 默认开合按使用频率定：高频卡展开、低频长卡收起（收起态靠 .card-sum 给摘要）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const app = read('src/App.vue')

const foldedViews = [
  ['AboutView', 'about', false],
  ['BackupView', 'backup', false],
  ['BubbleView', 'bubble', false],
  ['CodexView', 'codex', false],
  ['HelpView', 'help', false],
  ['LookView', 'look', true],
  ['ModelsView', 'models', false],
  ['NotifyView', 'notify', false],
  ['PrivacyView', 'privacy', false],
  ['UsageView', 'usage', true],
  ['WindowView', 'window', true],
]

test('每张 view 卡都有折叠标题与 useFold 状态', () => {
  for (const [file, key] of foldedViews) {
    const src = read(`src/views/${file}.vue`)
    assert.match(src, /class="card-toggle"/, `${file} 缺少 card-toggle 标题`)
    assert.match(src, new RegExp(`useFold\\('${key}'`), `${file} 缺少 useFold('${key}')`)
    assert.match(src, /card-sum/, `${file} 收起态没有摘要`)
  }
})

test('默认开合按频率定：高频展开、低频长卡收起', () => {
  for (const [file, key, dft] of foldedViews) {
    const src = read(`src/views/${file}.vue`)
    assert.match(src, new RegExp(`useFold\\('${key}', ${dft}\\)`), `${file} 的默认值应为 ${dft}`)
  }
})

test('合并的「专注与计时」卡也能折叠，默认展开', () => {
  assert.match(app, /useFold\('focusTimer', true\)/, 'App.vue 缺 focusTimer 折叠状态')
  assert.match(app, /class="card-toggle" @click="focusTimerFold\.open/, '合并卡标题不是折叠开关')
  assert.match(app, /focusTimerFold\.open \? '▾' : '▸'/, '合并卡缺展开箭头')
})

// 「设置页视觉」与「挂件外观」同属 LookView，但必须是两张各自命中 / 置顶的卡：
// 第一张常展开（高频），第二张默认收起（低频长卡）。
test('LookView 里的「设置页视觉」是独立卡，可单独显隐并默认收起', () => {
  const src = read('src/views/LookView.vue')
  assert.match(src, /useFold\('look', true\)/, '挂件外观应默认展开')
  assert.match(src, /useFold\('pageVisual', false\)/, '设置页视觉应默认收起')
  assert.match(src, /data-search="look"/, '缺挂件外观卡锚点')
  assert.match(src, /data-search="pageVisual"/, '缺设置页视觉卡锚点')
  assert.match(src, /cardOn\('look', 'look'\)/, '挂件外观缺独立显隐判定')
  assert.match(src, /cardOn\('look', 'pageVisual'\)/, '设置页视觉缺独立显隐判定')
  assert.match(src, /pinCls\('pageVisual'\)/, '设置页视觉缺置顶标记')
  // 搜索命中时强制展开：两卡都走 toggleCardFold + searchActive 分支，临时开合不落盘
  assert.match(src, /toggleCardFold\('pageVisual'\)/)
  assert.match(src, /toggleCardFold\('look'\)/)
  assert.match(src, /props\.searchActive \? !searchFoldClosed\./)
})

// 置顶竖条必须写在全局样式里：置顶 class 由子视图挂在卡根上，App.vue 的 scoped 样式
// 够不到子组件多根节点里的卡（Vue 只给单根组件下发父 scope id）
test('置顶竖条定义在全局样式，子视图的卡根也能用', () => {
  const css = read('src/main.css')
  assert.match(css, /\.card-pinned \{[\s\S]*?box-shadow: inset 3px 0 0 var\(--accent\);/)
  const appStyle = app.slice(app.indexOf('<style scoped>'))
  assert.ok(!/\n\.card-pinned \{/.test(appStyle), '置顶竖条不应再写在 App.vue scoped 里')
})
