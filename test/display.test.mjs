/*
 * 自定义显示（src/constants/display.ts）的纯函数单测（node --test）。
 *
 * 阈值为什么这么测：
 *   - sortByOrder / isCardHidden / pinnedInTab 都是 App.vue 与 DisplayManager 共用的判定，
 *     两处若各写一份必然漂移（历史上 Tab 可见性就写过三套），所以这里把口径钉死。
 *   - pinnedInTab 是「置顶区标题」与「置顶计数」的唯一来源，顺序必须等于用户点击顺序，
 *     隐藏的卡（自身被藏 / 分组被藏）必须被剔除 —— 否则标题里会冒出看不见的卡片名。
 *   - 最后一条把「SEARCH_INDEX 的组内声明序 == 模板里卡片的先后」钉死：DisplayManager 的卡片列表
 *     与搜索命中顺序都按 SEARCH_INDEX 声明序输出，漂移后弹窗里的顺序会和主界面实际顺序对不上，
 *     用户按弹窗里的位置去找卡会找错；这类错位肉眼极难发现。
 *
 * 用 Node 原生类型剥离直接 import .ts（Node 24+），不引入额外依赖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  CARD_FOLDS, CORE_CARDS, CORE_TABS, FOLD_DEFAULTS, MERGED_CARD_ROOT, SEARCH_INDEX, TABS,
  cardRootKey, isCardHidden, pinnedInTab, sortByOrder, sortCardsByOrder,
} from '../src/constants/display.ts'

// Tab 默认顺序是产品决策（高频组靠前），不是随手排的：
// 外观固定第一（冷启动落点），用量承载余额 / 模型 / 通知 / 专注，资源次之；
// 数据含凭据与备份，排在低频的窗口之前。改顺序就一起改本测试与 README / 规格。
test('Tab 默认顺序：外观 → 用量 → 资源 → 数据 → 窗口 → 帮助 → 开发者', () => {
  assert.deepEqual(TABS.map((t) => t.key), ['look', 'usage', 'assets', 'data', 'window', 'help', 'dev'])
})

test('CORE_TABS 由 CORE_CARDS 反查得出，不另抄名单', () => {
  const expect = [...new Set(CORE_CARDS.map((k) => SEARCH_INDEX[k].tab))].sort()
  assert.deepEqual([...CORE_TABS].sort(), expect)
})

test('isCardHidden：卡片自藏 / 所在分组被藏都算看不见', () => {
  assert.equal(isCardHidden([], [], 'models'), false)
  assert.equal(isCardHidden([], ['models'], 'models'), true)
  // 分组被藏：组内每张卡都算看不见
  assert.equal(isCardHidden(['usage'], [], 'notify'), true)
  assert.equal(isCardHidden(['usage'], [], 'window'), false)
  // 未知 key 不被误判
  assert.equal(isCardHidden(['usage'], ['usage'], 'no-such-card'), false)
})

test('sortByOrder：order 内按 order 排，order 外的补在后面且保持原序', () => {
  const items = ['a', 'b', 'c', 'd']
  assert.deepEqual(sortByOrder(items, ['c', 'a'], (x) => x), ['c', 'a', 'b', 'd'])
  // 空 order / 未定义 = 原样返回（默认顺序）
  assert.deepEqual(sortByOrder(items, [], (x) => x), items)
  assert.deepEqual(sortByOrder(items, undefined, (x) => x), items)
  // 不修改入参
  assert.deepEqual(items, ['a', 'b', 'c', 'd'])
})

test('pinnedInTab：只留本组、可见的置顶卡，顺序 = 用户点击顺序', () => {
  // models / notify / usage 同属 usage 组：全可见时顺序与 pinnedCards 一致
  assert.deepEqual(pinnedInTab(['models', 'notify', 'usage'], 'usage', [], []), ['models', 'notify', 'usage'])
  // 跨组卡不出现在别的组里（window 卡不会跑到 usage 组的置顶区）
  assert.deepEqual(pinnedInTab(['models', 'window'], 'usage', [], []), ['models'])
  // 卡片自己被藏 → 剔除
  assert.deepEqual(pinnedInTab(['models', 'usage'], 'usage', [], ['usage']), ['models'])
  // 分组被整体藏 → 全剔除（置顶仍保留在配置里，恢复显示后自动回到组首）
  assert.deepEqual(pinnedInTab(['models', 'usage'], 'usage', ['usage'], []), [])
  // 空 / 未定义 = 无置顶
  assert.deepEqual(pinnedInTab([], 'usage', [], []), [])
  assert.deepEqual(pinnedInTab(undefined, 'usage', [], []), [])
  // 不修改入参
  const pinned = ['models', 'usage']
  pinnedInTab(pinned, 'usage', [], ['usage'])
  assert.deepEqual(pinned, ['models', 'usage'])
})

test('pinnedInTab：合并卡按卡根去重并归一（focus / timer 只算一张）', () => {
  // 历史配置可能把合并卡存成 timer，甚至两个键都在：置顶区只能出现一次，且统一成卡根代表键
  assert.deepEqual(pinnedInTab(['timer'], 'usage', [], []), ['focus'])
  assert.deepEqual(pinnedInTab(['focus', 'timer'], 'usage', [], []), ['focus'])
  assert.deepEqual(pinnedInTab(['timer', 'models'], 'usage', [], []), ['focus', 'models'])
  // 藏掉任一同根键都等于这张合并卡被藏（不能只藏半张卡）
  assert.deepEqual(pinnedInTab(['timer'], 'usage', [], ['focus']), [])
  assert.deepEqual(pinnedInTab(['focus'], 'usage', [], ['timer']), [])
})

// 「恢复默认」把配置里的默认值删掉时，只遍历新表会漏掉被移除的键：
// 两个方向都不能少 —— 要推送回组件代码默认值（不能写 undefined），也要清掉旧缓存
test('useFold.setFoldPrefs 恢复默认：按新旧键并集处理', () => {
  const src = readFileSync(path.join(root, 'src/composables/useFold.ts'), 'utf8')
  assert.match(src, /new Set\(\[\.\.\.Object\.keys\(prev\),\s*\.\.\.Object\.keys\(next\.defaults\)\]\)/)
  assert.match(src, /it\.state\.open = has \? !!open : it\.defaultOpen/)
})

// —— 模板顺序 == SEARCH_INDEX 组内声明序 ——
// 做法：按出现顺序扫 App.vue 模板里的「卡片锚点 + 视图组件」，视图组件再展开成它内部的卡片锚点
// （资源组 4 张卡在 AssetsView 里，AccelView / AssetsView 还是 defineAsyncComponent 引入的）。
// 得到真实模板顺序后，按 Tab 分组与 SEARCH_INDEX 的声明序逐组比对。
const root = path.resolve(import.meta.dirname, '..')
const readSrc = (p) => readFileSync(path.join(root, p), 'utf8')
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
// 一次扫出「<section ... data-search="key">」与「<PascalCase 组件」
const CARD_TOKEN = /<section\b[^>]*\bdata-search="([A-Za-z0-9_]+)"[^>]*>|<([A-Z][A-Za-z0-9]*)\b/g

function templateOf(appSrc) {
  const noCode = appSrc.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  const m = noCode.match(/<template>([\s\S]*)<\/template>/)
  assert.ok(m, 'App.vue 里找不到根 <template>')
  return stripComments(m[1])
}

// 组件名 → views 下的文件名：静态 import 与 defineAsyncComponent 两种写法都要认
function viewMapOf(appSrc) {
  const map = new Map()
  for (const m of appSrc.matchAll(/import\s+(\w+)\s+from\s+'\.\/views\/(\w+)\.vue'/g)) map.set(m[1], m[2])
  for (const m of appSrc.matchAll(/const\s+(\w+)\s*=\s*defineAsyncComponent\([^;]*?import\('\.\/views\/(\w+)\.vue'\)/g)) map.set(m[1], m[2])
  return map
}

function templateCardOrder() {
  const appSrc = readSrc('src/App.vue')
  const views = viewMapOf(appSrc)
  const cards = []
  for (const m of templateOf(appSrc).matchAll(CARD_TOKEN)) {
    if (m[1]) { cards.push(m[1]); continue }
    const file = views.get(m[2])
    if (!file) continue // 纯 UI 组件（DisplayManager / SkinCropper 等），不含卡片锚点
    for (const s of stripComments(readSrc(`src/views/${file}.vue`)).matchAll(CARD_TOKEN)) {
      if (s[1]) cards.push(s[1])
    }
  }
  return cards
}

test('SEARCH_INDEX 的组内声明序 == 模板里卡片的先后（弹窗列表 / 搜索顺序与界面一致）', () => {
  const order = templateCardOrder()
  // 每张卡在模板里只出现一次，且与 SEARCH_INDEX 的键集合完全一致
  assert.equal(new Set(order).size, order.length, `模板里卡片锚点重复：${order.join(', ')}`)
  assert.deepEqual([...order].sort(), Object.keys(SEARCH_INDEX).sort(), '模板里的卡片集合与 SEARCH_INDEX 键集合不一致')
  // 逐 Tab 比对：排序只在同组内比较，所以只要求组内相对顺序一致
  const byTab = new Map()
  for (const k of order) {
    const tab = SEARCH_INDEX[k].tab
    if (!byTab.has(tab)) byTab.set(tab, [])
    byTab.get(tab).push(k)
  }
  for (const [tab, keys] of byTab) {
    const declared = Object.keys(SEARCH_INDEX).filter((k) => SEARCH_INDEX[k].tab === tab)
    assert.deepEqual(keys, declared, `${tab} 组：模板顺序与 SEARCH_INDEX 声明序不一致`)
  }
})

// —— 卡片自定义顺序 / 默认折叠 ——
test('CARD_FOLDS 覆盖全部卡片，合并卡共用同一个折叠键', () => {
  assert.deepEqual(Object.keys(CARD_FOLDS).sort(), Object.keys(SEARCH_INDEX).sort(), '每张卡都要有折叠键，否则弹窗里设不了默认展开态')
  assert.equal(CARD_FOLDS.focus, CARD_FOLDS.timer, '合并卡（专注 / 计时）必须共用一个折叠键')
  assert.equal(MERGED_CARD_ROOT.timer, 'focus')
  assert.equal(cardRootKey('timer'), 'focus', 'timer 的顺序必须归一到 focus 的卡根')
  assert.equal(cardRootKey('focus'), 'focus')
  assert.equal(cardRootKey('models'), 'models')
})

test('sortCardsByOrder：按自定义顺序排，未列出的补尾，合并卡按卡根归一', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'timer' }, { key: 'c' }]
  assert.deepEqual(sortCardsByOrder(items, ['c', 'a']).map((i) => i.key), ['c', 'a', 'b', 'timer'])
  // 只写了 timer 也能把 focus 那张卡排进去（两者同一个卡根）
  assert.deepEqual(sortCardsByOrder([{ key: 'focus' }, { key: 'a' }], ['timer']).map((i) => i.key), ['focus', 'a'])
  // 空 / 未定义 = 原样返回（默认顺序）
  assert.deepEqual(sortCardsByOrder(items, []).map((i) => i.key), ['a', 'b', 'timer', 'c'])
  assert.deepEqual(sortCardsByOrder(items, undefined).map((i) => i.key), ['a', 'b', 'timer', 'c'])
  // 不修改入参
  assert.deepEqual(items.map((i) => i.key), ['a', 'b', 'timer', 'c'])
})

// FOLD_DEFAULTS 是「管理显示内容」弹窗展示默认值的唯一来源，而真正生效的默认值在
// 各组件 useFold(key, defaultOpen) 的第二参 —— 两处各写一份必然漂移（改了一边忘了另一边，
// 弹窗写着「默认展开」、实际打开是收起的）。这里扫源码逐条比对，并顺带查出「表里有、
// 但没人用的键」这种陈旧项。
test('FOLD_DEFAULTS 与各 useFold(key, defaultOpen) 调用点逐条一致', () => {
  const srcDir = path.join(root, 'src')
  const files = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (/\.(ts|vue)$/.test(ent.name)) files.push(p)
    }
  }
  walk(srcDir)
  const actual = new Map()
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/useFold\('([^']+)',\s*(true|false)\)/g)) {
      const [, key, val] = m
      const open = val === 'true'
      if (actual.has(key)) assert.equal(actual.get(key), open, `折叠键 ${key} 在不同调用点的默认值不一致`)
      else actual.set(key, open)
    }
  }
  assert.ok(actual.size > 0, '没扫到任何 useFold 调用点，正则或目录变了')
  for (const [key, open] of actual) {
    assert.equal(FOLD_DEFAULTS[key] ?? false, open, `折叠键 ${key}：FOLD_DEFAULTS 与 useFold 第二参不一致`)
  }
  for (const key of Object.keys(FOLD_DEFAULTS)) {
    assert.ok(actual.has(key), `FOLD_DEFAULTS 里的 ${key} 没有任何 useFold 调用点，是陈旧项`)
  }
})
