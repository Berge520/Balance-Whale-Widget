// test/settings-tab-ux.test.mjs
// 设置页 Tab 交互契约（静态检查，node --test）。
//
// 为什么用「读源码 + 钉关键结构」而不是组件渲染测试：本仓库没有 jsdom / test-utils，
// 而这几条全是「有没有接上」的导航行为（回顶、快捷键、记住上次、窄窗换行），
// 渲染测试成本高、收益低；真机 / 浏览器里另做手工回归。
//
// 钉住的四件事：
//   1. 记住上次 Tab 只存 localStorage `whale:lastTab`，且只认 TABS 内的 key（脏值回外观）；
//   2. 点 Tab / 自动跳组都回页面顶部 —— 深链定位卡片走另一套，不许被这里覆盖；
//   3. 快捷键 Ctrl+1..7 / Ctrl+K / Alt+←→ 真的接上了，且输入框 / 弹层打开时让位；
//   4. 窄窗口 Tab 换行，不再用横向滚动把后几组藏起来。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')

test('记住上次 Tab：只存 localStorage，非法值 / 无值回「外观」', () => {
  assert.ok(app.includes("const LAST_TAB_KEY = 'whale:lastTab'"), '缺少 localStorage 键名')
  assert.ok(app.includes('function readLastTab()'), '缺少 readLastTab')
  assert.ok(app.includes('return TABS.some((t) => t.key === v)'), '读回时必须校验是 TABS 内的 key')
  assert.ok(app.includes("const activeTab = ref<TabKey>(readLastTab() || 'look')"), '冷启动默认应为外观')
  assert.ok(app.includes('localStorage.setItem(LAST_TAB_KEY, v)'), '切换分组后必须写回上次位置')
})

test('切 Tab 统一走 onTabClick：清搜索 + 回页面顶部', () => {
  const start = app.indexOf('function onTabClick(')
  const end = app.indexOf('// Alt+←/→', start)
  assert.ok(start > 0 && end > start, '找不到 onTabClick')
  const body = app.slice(start, end)
  assert.match(body, /clearSearch\(\)/, '点 Tab 应退出搜索态')
  assert.match(body, /activeTab\.value = key/, '点 Tab 应切到目标组')
  assert.match(body, /scrollPageTop\(\)/, '点 Tab 应回顶')

  const topStart = app.indexOf('function scrollPageTop(')
  const topEnd = app.indexOf('// 点击 / 快捷键', topStart)
  assert.ok(topStart > 0 && topEnd > topStart, '找不到 scrollPageTop')
  assert.match(app.slice(topStart, topEnd), /window\.scrollTo\(\{ top: 0/, '回顶必须滚到页面顶部')

  // 模板上的 Tab 按钮必须走统一入口（旧写法 clearSearch(); activeTab = t.key 会把回顶漏掉）
  assert.ok(app.includes('@click="onTabClick(t.key)"'), 'Tab 按钮应绑定 onTabClick')
  assert.ok(!app.includes('@click="clearSearch(); activeTab = t.key"'), 'Tab 按钮仍是旧的分散写法')

  // 显示管理隐藏当前组后的自动跳组也要回顶
  const watchStart = app.indexOf('watch(visibleTabs')
  const watchEnd = app.indexOf('const darkPollTimer', watchStart)
  assert.ok(watchStart > 0 && watchEnd > watchStart, '找不到 visibleTabs 的自动跳组 watch')
  assert.match(app.slice(watchStart, watchEnd), /scrollPageTop\(\)/, '自动跳组也要回顶')
})

test('快捷键：Ctrl+1..7 / Ctrl+K / Alt+←→，输入框与弹层内让位', () => {
  assert.ok(app.includes("window.addEventListener('keydown', onSettingsKeydown)"), '快捷键未注册')
  assert.ok(app.includes("window.removeEventListener('keydown', onSettingsKeydown)"), '快捷键未注销')

  const start = app.indexOf('function onSettingsKeydown(')
  const end = app.indexOf('// —— 配置保存回执', start)
  assert.ok(start > 0 && end > start, '找不到 onSettingsKeydown')
  const body = app.slice(start, end)
  assert.match(body, /e\.ctrlKey \|\| e\.metaKey/, '要支持 Ctrl / Cmd')
  assert.match(body, /e\.key === 'k' \|\| e\.key === 'K'/, '缺少 Ctrl+K')
  assert.match(body, /focusSearch\(\)/, 'Ctrl+K 应聚焦搜索')
  assert.match(body, /\/\^\[1-9\]\$\/\.test\(e\.key\)/, '缺少 Ctrl+数字')
  assert.match(body, /switchTabByIndex\(Number\(e\.key\)\)/, 'Ctrl+数字应直达第 N 组')
  assert.match(body, /e\.altKey && !e\.ctrlKey && !e\.metaKey/, '缺少 Alt+方向键')
  assert.match(body, /e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'/, '缺少左右方向判断')
  assert.match(body, /switchAdjacentTab\(e\.key === 'ArrowRight' \? 1 : -1\)/, 'Alt+方向应切相邻组')
  assert.match(body, /t\.tagName === 'INPUT' \|\| t\.tagName === 'TEXTAREA' \|\| t\.tagName === 'SELECT' \|\| t\.isContentEditable/, '输入框内的 Alt+方向键不应被拦截')
  assert.match(body, /anyModalOpen\(\)/, '弹层打开时应让位')

  const modalStart = app.indexOf('function anyModalOpen(')
  const modalEnd = app.indexOf('// 设置页快捷键', modalStart)
  assert.ok(modalStart > 0 && modalEnd > modalStart, '找不到 anyModalOpen')
  const modal = app.slice(modalStart, modalEnd)
  for (const cls of ['.whale-overlay', '.display-manager-overlay', '.boot-intro', '.media-preview-box']) {
    assert.ok(modal.includes(cls), `弹层守卫漏了 ${cls}`)
  }
})

test('Tab 条：窄窗换行、快捷键提示、Ctrl+K 有可聚焦的搜索框', () => {
  const start = app.indexOf('v-for="(t, i) in visibleTabs"')
  const end = app.indexOf('</nav>', start)
  assert.ok(start > 0 && end > start, '找不到 Tab 行模板')
  const tpl = app.slice(start, end)
  assert.match(tpl, /:title="`\$\{t\.label\}（快捷键 Ctrl\+\$\{i \+ 1\}）`"/, 'Tab 应有快捷键提示')
  assert.match(tpl, /aria-current=/, '当前组应带 aria-current')
  assert.ok(tpl.includes('ref="searchInputEl"'), '搜索框缺少 ref，Ctrl+K 无法聚焦')
  assert.ok(tpl.includes('title="聚焦搜索（Ctrl+K）"'), '搜索框缺少快捷键提示')

  const rowStart = app.indexOf('.tab-row {')
  const rowEnd = app.indexOf('}', rowStart)
  assert.ok(rowStart > 0 && rowEnd > rowStart, '找不到 .tab-row 样式')
  const rowCss = app.slice(rowStart, rowEnd)
  assert.match(rowCss, /flex-wrap:\s*wrap/, '窄窗口应换行，不再横向滚动藏组')
  assert.doesNotMatch(rowCss, /overflow-x/, 'Tab 行不应再横向滚动')
  assert.ok(!app.includes('.tab-row::-webkit-scrollbar'), '横向滚动的滚动条隐藏规则应一并删除')
})
