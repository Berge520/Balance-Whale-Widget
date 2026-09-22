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

test('candidatesOf：dump 里已经禁用的条目不能凭空标成「已禁用」', () => {
  // dump 的条目只有 disabled 状态，没有「在 patch 里写没写」这回事 ——
  // 不在 patch 里的条目状态就是「未知」，按未禁用处理（界面上默认不勾，让用户自己决定）
  const items = I.candidatesOf({ patchItems: [], pluginIds: ['foo'] })
  assert.equal(items[0].disabled, false)
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
test('selectBatch：缺省全选（一键隔离的意图是「只留我要的」）', () => {
  const batch = I.selectBatch({
    patchItems: [{ id: 'a', disabled: false }],
    pluginIds: ['b', 'c'],
    disabledMap: {},
    patchMap: {},
  })
  assert.deepEqual(batch.map((x) => x.id), ['a', 'b', 'c'])
})

test('selectBatch：候选来源只有 patchItems 与 pluginIds（不认任意 id 列表）', () => {
  const batch = I.selectBatch({
    ids: ['a', 'b'],
    disabledMap: {},
    patchMap: {},
  })
  assert.deepEqual(batch, [])
})

test('selectBatch：给了 ids 就只选这些（未命中的忽略）', () => {
  const batch = I.selectBatch({
    patchItems: [{ id: 'a' }],
    pluginIds: ['b', 'c'],
    ids: ['c', 'nope'],
    disabledMap: {},
    patchMap: {},
  })
  assert.deepEqual(batch.map((x) => x.id), ['c'])
})

test('selectBatch：冻结当前状态，界面据此默认不勾「已禁用」', () => {
  const batch = I.selectBatch({
    patchItems: [{ id: 'a', disabled: false }, { id: 'b', disabled: true }],
    ids: ['a', 'b'],
    disabledMap: { a: true, b: true },
    patchMap: { a: true, b: true },
  })
  const byId = Object.fromEntries(batch.map((x) => [x.id, x]))
  assert.equal(byId.a.disabled, true)
  assert.equal(byId.a.inPatch, true)
  assert.equal(byId.b.disabled, true)
})

test('selectBatch：超过 MAX_BATCH 就截断（防 id 列表被污染）', () => {
  const many = []
  for (let i = 0; i < I.MAX_BATCH + 25; i++) many.push('p' + i)
  const batch = I.selectBatch({ pluginIds: many, disabledMap: {}, patchMap: {} })
  assert.equal(batch.length, I.MAX_BATCH)
})
