/*
 * dsh-isolate.js + dsh-patch.js#applyBatchDisable 的回归测试（node --test，零依赖）
 * —— 计划书 §6.2 E3「我的一键隔离」。
 *
 * E3 与 E2 最大的不同是**一次改多行**，于是多出三类 E2 没有的静默失效：
 *   1. **行号错位**：改到一半往中间插行，会让**后面已经取好的行号**全部偏一位。
 *      界面要拿行号告诉用户「会动哪几行」（计划书 §5.2 的硬要求），行号错一位
 *      就等于指着用户没被改的那一行说「改这里」。
 *   2. **一次改完再落盘**：循环调 applyToggle 会让「末尾追加」的条目反复改落点，
 *      也会一 id 一份快照。本模块是「拼完一份文本、一次写」。
 *   3. **候选必须真实存在**：勾一个拼错的 id，V2 的静默失效会让界面报「已隔离」
 *      而实际什么都没发生 —— 所以候选只来自「读到的 patch 条目」∪「dump 到的条目」。
 *
 * dsh-isolate.js 与 dsh-patch.js 都只 require 内置（无 fs / 无 utools），
 * 所以本文件**不挂桩**也能跑 —— 这也是它们能被当作纯函数测的原因。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const P = require('../public/preload/lib/dsh-patch.js')
const I = require('../public/preload/lib/dsh-isolate.js')

// 与 dsh-patch.test.mjs 同一份本机实测形态（12 条目那种写法的缩样）
const REAL_PATCH = [
  '# 第三方插件（放在末尾，优先级最高）',
  '',
  '- id: dsh-find-plugin',
  '  disabled: true',
  '',
  '- id: dsh-session-search',
  '  disabled: true',
  '  config:',
  '    maxResults: 20',
  '',
  '- id: dsh-better-sidebar',
  '  disabled: !!js \'process.env.DISABLE_SIDEBAR\'',
  '',
  '- id: cost-meter',
  '  disabled: false',
  '',
].join('\n')

// ──────────────────────────────────────────────
// ① 批量禁用：只动该动的行
// ──────────────────────────────────────────────
test('applyBatchDisable：一次把多条改成 disabled: true，只动那几行', () => {
  const r = P.applyBatchDisable(REAL_PATCH, ['cost-meter'])
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  // 只有 cost-meter 的 disabled 行从 false 变 true：其余行逐字不变
  const want = REAL_PATCH.replace('  disabled: false', '  disabled: true')
  assert.equal(r.text, want)
  assert.deepEqual(r.plans, [{ id: 'cost-meter', action: 'update', line: 15, was: false }])
})

test('applyBatchDisable：已禁用的条目如实报 noop，不假装改过', () => {
  const r = P.applyBatchDisable(REAL_PATCH, ['dsh-find-plugin', 'cost-meter'])
  assert.equal(r.changed, true)
  const byId = Object.fromEntries(r.plans.map((p) => [p.id, p]))
  assert.equal(byId['dsh-find-plugin'].action, 'noop')
  assert.equal(byId['dsh-find-plugin'].was, true)
  assert.equal(byId['cost-meter'].action, 'update')
})

test('applyBatchDisable：全选已禁用的条目 → changed=false，文本原样', () => {
  const r = P.applyBatchDisable(REAL_PATCH, ['dsh-find-plugin', 'dsh-session-search'])
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(r.action, 'noop')
  assert.equal(r.text, REAL_PATCH)
})

test('applyBatchDisable：空 id 列表 / 全空串 → 不算改动', () => {
  assert.equal(P.applyBatchDisable(REAL_PATCH, []).changed, false)
  assert.equal(P.applyBatchDisable(REAL_PATCH, ['', '   ']).changed, false)
  assert.equal(P.applyBatchDisable('', []).text, '')
})

// ──────────────────────────────────────────────
// ② 批量禁用：新增条目（只在 dump 里有、patch 里没有的 id）
// ──────────────────────────────────────────────
test('applyBatchDisable：patch 里没有的 id → 追加到末尾，且计划里 line=0', () => {
  const r = P.applyBatchDisable(REAL_PATCH, ['brand-new-plugin'])
  assert.equal(r.changed, true)
  assert.equal(r.plans[0].action, 'append')
  assert.equal(r.plans[0].line, 0)
  assert.ok(r.text.endsWith('- id: brand-new-plugin\n  disabled: true\n'))
  // 追加不该动原有内容
  assert.ok(r.text.startsWith(REAL_PATCH))
})

test('applyBatchDisable：多条新加 → 按传入顺序依次追加，不粘行', () => {
  const r = P.applyBatchDisable(REAL_PATCH, ['aaa', 'bbb'])
  assert.ok(r.text.endsWith('- id: aaa\n  disabled: true\n- id: bbb\n  disabled: true\n'))
})

test('applyBatchDisable：文件不以换行结尾时先补换行（否则粘成一行）', () => {
  const src = '- id: foo\n  disabled: false'
  const r = P.applyBatchDisable(src, ['bar'])
  assert.ok(r.text.includes('disabled: false\n- id: bar'))
  assert.ok(!r.text.includes('false- id:'))
})

test('applyBatchDisable：空文件也能直接追加', () => {
  const r = P.applyBatchDisable('', ['foo'])
  assert.equal(r.text, '- id: foo\n  disabled: true\n')
})

// ──────────────────────────────────────────────
// ③ 批量禁用：行号不错位（E2 没有的坑）
// ──────────────────────────────────────────────
test('applyBatchDisable：往中间插行后，前面已取好的行号不受影响', () => {
  // dsh-better-sidebar 的 disabled 值是 `!!js '...'` —— 按 dsh-patch 的保守口径算「已禁用」，
  // 所以它的计划是 noop；要验「插行不影响前面的行号」得用一条真正会 insert 的条目。
  // 这里反着来：**先**给后面的 upper 插行，**再**改前面 dsh-find-plugin 的 disabled 行 ——
  // 若第二趟用原始行号去索引已经被 splice 撑大的 lines，就会改错行
  const src = [
    '- id: dsh-find-plugin',
    '  disabled: false',
    '',
    '- id: cost-meter',
    '  disabled: false',
    '',
  ].join('\n')
  const r = P.applyBatchDisable(src, ['cost-meter', 'dsh-find-plugin'])
  assert.equal(
    r.text,
    [
      '- id: dsh-find-plugin',
      '  disabled: true',
      '',
      '- id: cost-meter',
      '  disabled: true',
      '',
    ].join('\n')
  )
})

test('applyBatchDisable：upper 条目自己 insert 时，行号按改动前的位置报', () => {
  const src = [
    '- id: upper',
    '  config:',
    '    a: 1',
    '',
    '- id: lower',
    '  disabled: false',
    '',
  ].join('\n')
  // upper 没有 disabled 行 → 往它条目头下面插一行；lower 在第 6 行还没变。
  // plans.line 报的是**条目头**所在行（与 noop / 已有 disabled 行的口径一致，
  // 而不是「新行落在第几行」）—— 界面上要指给用户看的是「哪个条目会变」。
  // 真正要小心的不是这个数字，而是**从后往前落笔**：先插 upper 那一行，
  // 再用原始行号去索引 lower 的 disabled 行就会指错人（E2 单条改动没这个坑）
  const r = P.applyBatchDisable(src, ['upper', 'lower'])
  const byId = Object.fromEntries(r.plans.map((p) => [p.id, p]))
  assert.equal(byId['upper'].action, 'insert')
  assert.equal(byId['upper'].line, 1)
  assert.equal(byId['lower'].action, 'update')
  assert.equal(byId['lower'].line, 6)
  // 最终文本：upper 的 disabled 插在它自己下面的第 2 行，lower 的 false 改成 true
  assert.equal(
    r.text,
    ['- id: upper', '  disabled: true', '  config:', '    a: 1', '', '- id: lower', '  disabled: true', ''].join('\n')
  )
})

test('applyBatchDisable：同一条目被重复列入只改一次（按 id 去重）', () => {
  const r = P.applyBatchDisable(REAL_PATCH, ['cost-meter', 'cost-meter'])
  assert.equal(r.plans.length, 1)
})

test('applyBatchDisable：插行时沿用该条目自己的缩进（用户可能写 4 空格）', () => {
  const src = ['- id: foo', '    disabled: false'].join('\n')
  const r = P.applyBatchDisable(src, ['foo'])
  assert.equal(r.text, '- id: foo\n    disabled: true')
})

// ──────────────────────────────────────────────
// ④ 批量禁用：非法 id 与格式保持
// ──────────────────────────────────────────────
test('applyBatchDisable：任一 id 非法就整批拒绝，不做半截写入', () => {
  const bad = ['cost-meter', 'a\nb']
  const r = P.applyBatchDisable(REAL_PATCH, bad)
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('非法'))
  // 关键：拒绝时不能把「合法的那半」也带出去
  assert.equal(r.text, undefined)
})

test('applyBatchDisable：CRLF 文件保持 CRLF（不能把用户的换行风格洗掉）', () => {
  const src = '- id: foo\r\n  disabled: false\r\n'
  const r = P.applyBatchDisable(src, ['foo'])
  assert.ok(!/(?<!\r)\n/.test(r.text), '出现了裸 \\n，说明 CRLF 被洗掉了')
  assert.equal(r.text, '- id: foo\r\n  disabled: true\r\n')
})

test('applyBatchDisable：幂等 —— 对结果再跑一次，文本逐字不变', () => {
  const once = P.applyBatchDisable(REAL_PATCH, ['cost-meter', 'brand-new-plugin'])
  const twice = P.applyBatchDisable(once.text, ['cost-meter', 'brand-new-plugin'])
  assert.equal(twice.changed, false)
  assert.equal(twice.text, once.text)
})

test('applyBatchDisable：注释与 config 子块逐字保留', () => {
  const r = P.applyBatchDisable(REAL_PATCH, ['cost-meter'])
  assert.ok(r.text.includes('# 第三方插件（放在末尾，优先级最高）'))
  assert.ok(r.text.includes('  config:\n    maxResults: 20'))
  assert.ok(r.text.includes("disabled: !!js 'process.env.DISABLE_SIDEBAR'"))
})

// ──────────────────────────────────────────────
// ⑤ 候选清单：只来自「读到的 patch」∪「dump 到的条目」
// ──────────────────────────────────────────────
test('candidatesOf：patch 条目优先，dump 只补 patch 里没有的', () => {
  const items = I.candidatesOf({
    patchItems: [
      { id: 'cost-meter', disabled: false, line: 15, hasConfig: false },
      { id: 'dsh-find-plugin', disabled: true, line: 3, hasConfig: false },
    ],
    pluginIds: ['cost-meter', 'dsh-better-sidebar'],
  })
  assert.deepEqual(items.map((i) => i.id), ['cost-meter', 'dsh-find-plugin', 'dsh-better-sidebar'])
  // source 是给用户看的（也是 V1 免责文案的定责依据）
  assert.equal(items[0].source, 'patch')
  assert.equal(items[0].line, 15)
  assert.equal(items[2].source, 'plugin')
  assert.equal(items[2].line, 0)
  assert.equal(items[2].inPatch, false)
})

test('candidatesOf：dump 条目在没给状态时 disabled 为 undefined（未知），不凭空标成启用中', () => {
  // dump 的条目只有 disabled 状态，没有「在 patch 里写没写」这回事。
  // 调用方没传 disabledOf（组装树没读出来）时必须留 undefined：
  // 早先默认成 false，等于把未知状态谎报成「启用中」，46 条已禁用插件会被显示成开着
  const items = I.candidatesOf({ patchItems: [], pluginIds: ['foo'] })
  assert.equal(items[0].disabled, undefined)
  assert.equal(items[0].inPatch, false)
})

test('candidatesOf：去重、容忍空值', () => {
  const items = I.candidatesOf({ patchItems: [{ id: 'foo' }, { id: 'foo' }], pluginIds: ['foo', '', null] })
  assert.deepEqual(items.map((i) => i.id), ['foo'])
})

test('candidatesOf：候选顺序稳定（先 patch 后 dump，各自按输入顺序）', () => {
  const items = I.candidatesOf({ patchItems: [{ id: 'b' }, { id: 'a' }], pluginIds: ['d', 'c'] })
  assert.deepEqual(items.map((i) => i.id), ['b', 'a', 'd', 'c'])
})

// ──────────────────────────────────────────────
// ⑥ 勾选与上限
// ──────────────────────────────────────────────
// ⚠️ selectBatch 返回 `{ items, dropped }`（早先直接返回数组）。
// 改成对象是因为截断必须能**如实报出丢了几条**：早先「边遍历边 break」会把
// 用户明确勾选的项静默丢掉，调用方拿不到任何信号。
test('selectBatch：缺省全选（一键隔离的意图是「只留我要的」）', () => {
  const batch = I.selectBatch({
    patchItems: [{ id: 'a', disabled: false }],
    pluginIds: ['b', 'c'],
    disabledMap: {},
    patchMap: {},
  })
  assert.deepEqual(batch.items.map((x) => x.id), ['a', 'b', 'c'])
  assert.equal(batch.dropped, 0)
})

test('selectBatch：候选来源只有 patchItems 与 pluginIds（不认任意 id 列表）', () => {
  const batch = I.selectBatch({
    ids: ['a', 'b'],
    disabledMap: {},
    patchMap: {},
  })
  assert.deepEqual(batch.items, [])
  assert.equal(batch.dropped, 0)
})

test('selectBatch：给了 ids 就只选这些（未命中的忽略）', () => {
  const batch = I.selectBatch({
    patchItems: [{ id: 'a' }],
    pluginIds: ['b', 'c'],
    ids: ['c', 'nope'],
    disabledMap: {},
    patchMap: {},
  })
  assert.deepEqual(batch.items.map((x) => x.id), ['c'])
})

test('selectBatch：冻结当前状态，界面据此默认不勾「已禁用」', () => {
  const batch = I.selectBatch({
    patchItems: [{ id: 'a', disabled: false }, { id: 'b', disabled: true }],
    ids: ['a', 'b'],
    disabledMap: { a: true, b: true },
    patchMap: { a: true, b: true },
  })
  const byId = Object.fromEntries(batch.items.map((x) => [x.id, x]))
  assert.equal(byId.a.disabled, true)
  assert.equal(byId.a.inPatch, true)
  assert.equal(byId.b.disabled, true)
})

test('selectBatch：超过 MAX_BATCH 就截断，并如实报出 dropped（防 id 列表被污染）', () => {
  const many = []
  for (let i = 0; i < I.MAX_BATCH + 25; i++) many.push('p' + i)
  const batch = I.selectBatch({ pluginIds: many, disabledMap: {}, patchMap: {} })
  assert.equal(batch.items.length, I.MAX_BATCH)
  assert.equal(batch.dropped, 25)
})

test('selectBatch：勾选项不被截断静默丢弃（回归 B9）', () => {
  // 背景：早先是「按输入顺序边遍历边 push，满 100 就 break」→ 排在后面的勾选项被静默丢弃。
  // 现在命中项全部先收集、再统一截断，所以「勾选数 ≤ 上限」时**一条都不能少**。
  const many = []
  for (let i = 0; i < I.MAX_BATCH + 25; i++) many.push('p' + i)
  // 只勾最后 3 个（早先按输入顺序遍历，它们排在 125 条之后，必然被丢掉）
  const ids = ['p122', 'p123', 'p124']
  const batch = I.selectBatch({ pluginIds: many, ids, disabledMap: {}, patchMap: {} })
  assert.deepEqual(batch.items.map((x) => x.id), ids)
  assert.equal(batch.dropped, 0)
})

// ──────────────────────────────────────────────
// ⑦ 来源分档（官框架 vs 第三方插件）
// ──────────────────────────────────────────────
// 背景：实测本机 `--dump-config` 有 204 个条目，其中 199 个是 dsh 自己的框架节点
// （tool-bash / session / llm / subagent…），第三方插件只有 5 个。平铺展示等于
// 让用户在 204 条里找那 5 条 —— 分档就是为了把这件事收成 3 组。
test('tierOfBundle：@deepseek-ai/ 作用域与已知官方包名归 core', () => {
  assert.equal(I.tierOfBundle('@deepseek-ai/dsh-base'), 'core')
  assert.equal(I.tierOfBundle('@deepseek-ai/dsh-web-app'), 'core')
  assert.equal(I.tierOfBundle('dsh-base'), 'core')
})

test('tierOfBundle：`dsh-` 前缀不判官方（第三方大量占用这个前缀）', () => {
  // 实测这几个都不是官方的，按前缀判会把它们错误地折进「官方框架」默认折叠区
  assert.equal(I.tierOfBundle('dsh-mnemon'), 'third')
  assert.equal(I.tierOfBundle('dshmarket'), 'third')
  assert.equal(I.tierOfBundle('dsh-better-sidebar'), 'third')
  assert.equal(I.tierOfBundle('@liustack/modlens'), 'third')
})

test('tierOfBundle：判不出来一律算 third（宁可不折叠，也不把插件藏起来）', () => {
  assert.equal(I.tierOfBundle(''), 'third')
  assert.equal(I.tierOfBundle(null), 'third')
  assert.equal(I.tierOfBundle(undefined), 'third')
})

test('candidatesOf：patch 里的条目无条件归 patched（与它属于哪个 bundle 无关）', () => {
  const items = I.candidatesOf({
    patchItems: [{ id: 'cost-meter', disabled: true, line: 35 }],
    pluginIds: ['cost-meter'],
    // 即使 dump 说它属于第三方 bundle，只要已在 patch 里就是最高优先档
    bundleOf: { 'cost-meter': 'dsh-cost-meter' },
  })
  assert.equal(items[0].tier, 'patched')
  assert.equal(items[0].source, 'patch')
})

test('candidatesOf：按 bundle 分档，且 patched → third → core 排序', () => {
  const items = I.candidatesOf({
    patchItems: [{ id: 'webserver' }],
    pluginIds: ['modlens', 'tool-bash'],
    bundleOf: {
      modlens: '@liustack/modlens',
      'tool-bash': '@deepseek-ai/dsh-base',
    },
  })
  assert.deepEqual(items.map((x) => x.id), ['webserver', 'modlens', 'tool-bash'])
  assert.deepEqual(items.map((x) => x.tier), ['patched', 'third', 'core'])
})

test('candidatesOf：dump 里的 disabled / hasConfig 不再被硬编码成 false', () => {
  // 早先 plugin 分支写死 `disabled: false`，于是「已禁用」标记只对 patch 里的条目准
  const items = I.candidatesOf({
    patchItems: [],
    pluginIds: ['mnemon'],
    disabledOf: { mnemon: true },
    configOf: { mnemon: true },
  })
  assert.equal(items[0].disabled, true)
  assert.equal(items[0].hasConfig, true)
})

test('candidatesOf：候选不再截断（204 条全给，早先截到 100 导致后面勾不到）', () => {
  const many = []
  for (let i = 0; i < 204; i++) many.push('p' + i)
  const items = I.candidatesOf({ patchItems: [], pluginIds: many })
  assert.equal(items.length, 204)
})

test('candidatesOf：没给 disabledOf 时 disabled 是 undefined（未知），不得谎报为启用中', () => {
  // 回归：早先没传 disabledOf 时 `!!(o.disabledOf && o.disabledOf[id])` 恒为 false，
  // 于是 46 条已禁用的插件在界面上被显示成「启用中」—— 会骗人的静默失效。
  // 缺数据必须留 undefined，让界面能显示「状态未知」，而不是替未知状态背书
  const bare = I.candidatesOf({ patchItems: [], pluginIds: ['mnemon'], bundleOf: { mnemon: 'dsh-mnemon' } })
  assert.equal(bare[0].disabled, undefined)
  // 给了就照给的值走（true / false 都要能区分出来）
  const given = I.candidatesOf({
    patchItems: [],
    pluginIds: ['mnemon', 'other'],
    disabledOf: { mnemon: true, other: false },
  })
  assert.equal(given[0].disabled, true)
  assert.equal(given[1].disabled, false)
})
