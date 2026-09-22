/*
 * dsh-patch.js 的回归测试（node --test，零依赖）—— 计划书 §6.2 E2。
 *
 * 这里盯的是**几个静默失效型的约定**（错了不会报错、只会悄悄写坏用户配置）：
 *   1. **只动一行**：切换已有条目只改它那一行的 `disabled`，其余字节逐字不变 ——
 *      用户手写的注释、引号风格、键顺序都必须原样保留（所以不能走「YAML 解析 + 重新序列化」）。
 *   2. **条目归属**：`disabled:` 归给**上方最近的** `- id:`。这条错了会让「关 A 结果关了 B」，
 *      而文件看起来完全正常（V2：dsh 对写坏的 patch 不报错）。
 *   3. **追加在末尾**：新条目追加到文件尾（patch 是后者覆盖前者）。文件不以换行结尾时
 *      必须先补换行，否则会粘成 `foo: bar- id: x` 这种结构上就废掉的内容。
 *   4. **容忍真实写法**：本机实测的 patch 有 12 条目 / 11 条 disabled，含空行、注释、
 *      config 子块、`!!js` 表达式 —— 解析必须全都认，不能只有「最规范那一种」能跑。
 *   5. **非法 id 被拒**：换行 / `#` / `: ` / 以 `-` 开头都会破坏 YAML 结构，必须拒绝而不是硬写。
 *
 * dsh-patch.js 只 require 内置（无 fs / 无 utools），所以本文件**不挂桩**也能跑 ——
 * 这也是它能被当作纯函数测的原因。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const P = require('../public/preload/lib/dsh-patch.js')

// 本机实测的 patch 形态（D23：真实文件里的写法，不是理想化的最小样例）
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

// ── ① 解析 ──
test('parsePatch：条目、disabled 归属、行号、hasConfig 全部对上', () => {
  const { items } = P.parsePatch(REAL_PATCH)
  assert.deepEqual(items.map((i) => i.id), [
    'dsh-find-plugin', 'dsh-session-search', 'dsh-better-sidebar', 'cost-meter',
  ])
  assert.deepEqual(items.map((i) => i.disabled), [true, true, true, false])
  // 注释与空行不算进「条目内还有别的字段」
  assert.equal(items[0].hasConfig, false)
  // config 子块要认出来（界面上提示「这个条目还带配置」）
  assert.equal(items[1].hasConfig, true)
  // 行号是 0 基，交给界面时 +1
  assert.equal(items[0].lineIndex, 2)
  assert.equal(items[1].lineIndex, 5)
})

test('parsePatch：空文本 / null 不抛异常，返回空条目集', () => {
  for (const v of ['', null, undefined, '\n\n', '# 只有注释\n']) {
    const r = P.parsePatch(v)
    assert.deepEqual(r.items, [], String(v))
  }
})

test('parsePatch：`disabled:` 归给上方最近的条目（归属错了会「关 A 关了 B」）', () => {
  const { items } = P.parsePatch([
    '- id: a',
    '  disabled: true',
    '- id: b',
    '- id: c',
    '  disabled: true',
  ].join('\n'))
  assert.deepEqual(items.map((i) => [i.id, i.disabled]), [
    ['a', true], ['b', false], ['c', true],
  ])
})

// ── ② disabled 取值 ──
test('disabledValue：只有明确的假值才算「未禁用」，其余一律算已禁用', () => {
  for (const v of ['false', 'False', 'NO', '0', 'null', '~']) assert.equal(P.disabledValue(v), false, v)
  for (const v of ['true', 'True', 'yes', '1', '', '!!js \'x\'']) assert.equal(P.disabledValue(v), true, v)
})

// ── ③ 切换已有条目：只动一行 ──
test('applyToggle：切换已有条目时，除该行外逐字不变（注释 / 引号 / 键顺序全保留）', () => {
  const r = P.applyToggle(REAL_PATCH, 'cost-meter', true)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.action, 'update')
  assert.equal(r.changed, true)

  // 只多了一处差异：`disabled: false` → `disabled: true`
  const before = REAL_PATCH.split('\n')
  const after = r.text.split('\n')
  assert.equal(after.length, before.length, '行数必须不变（不该重排 / 重排缩进）')
  const diff = after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null)
  assert.deepEqual(diff, [before.indexOf('  disabled: false')])
  assert.equal(after[diff[0]], '  disabled: true')
  // 注释行原样在
  assert.equal(after[0], '# 第三方插件（放在末尾，优先级最高）')
  // 其它条目一行没变
  assert.equal(after.join('\n').includes('  config:\n    maxResults: 20'), true)
})

test('applyToggle：沿用该行原有缩进，不按条目缩进重算', () => {
  const src = '- id: a\n    disabled: false\n'
  const r = P.applyToggle(src, 'a', true)
  assert.equal(r.text, '- id: a\n    disabled: true\n')
})

test('applyToggle：已是目标状态 → changed:false 且原文本原样返回', () => {
  const r = P.applyToggle(REAL_PATCH, 'cost-meter', false)
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(r.action, 'noop')
  assert.equal(r.text, REAL_PATCH)
})

// ── ④ 新增条目 ──
test('applyToggle：条目不存在 → 末尾追加（patch 后者覆盖前者，追加=优先级最高）', () => {
  const r = P.applyToggle(REAL_PATCH, 'new-plugin', true)
  assert.equal(r.ok, true)
  assert.equal(r.action, 'append')
  assert.equal(r.text, REAL_PATCH + '- id: new-plugin\n  disabled: true\n')
  // 追加后能被自己解析回来 —— 「写出去的东西自己认得」是回读校验的前提
  const { items } = P.parsePatch(r.text)
  assert.deepEqual(items.map((i) => i.id).slice(-1), ['new-plugin'])
  assert.equal(items[items.length - 1].disabled, true)
})

test('applyToggle：文件不以换行结尾时先补换行（否则会粘成一个废条目）', () => {
  const r = P.applyToggle('- id: a\n  disabled: false', 'b', true)
  assert.equal(r.text, '- id: a\n  disabled: false\n- id: b\n  disabled: true\n')
  const { items } = P.parsePatch(r.text)
  assert.deepEqual(items.map((i) => i.id), ['a', 'b'])
})

test('applyToggle：空文件 / 空文本也能追加出合法内容', () => {
  for (const v of ['', null, undefined]) {
    const r = P.applyToggle(v, 'x', true)
    assert.equal(r.ok, true, String(v))
    assert.equal(r.text, '- id: x\n  disabled: true\n')
  }
})

test('applyToggle：已有条目但没有 disabled 行 → 插在 - id: 下一行', () => {
  const src = '- id: a\n  config:\n    k: 1\n- id: b\n'
  const r = P.applyToggle(src, 'a', true)
  assert.equal(r.action, 'insert')
  assert.equal(r.text, '- id: a\n  disabled: true\n  config:\n    k: 1\n- id: b\n')
  // 插进去的那行不能让 a 的归属跑偏（b 仍是 false）
  const { items } = P.parsePatch(r.text)
  assert.deepEqual(items.map((i) => [i.id, i.disabled]), [['a', true], ['b', false]])
})

// ── ⑤ 非法 id ──
test('validId / applyToggle：会破坏 YAML 结构的 id 一律拒绝', () => {
  for (const bad of ['', '  ', 'a\nb', 'a\rb', 'a\tb', 'a: b', 'a #c', '-a', 'x'.repeat(201)]) {
    assert.equal(P.validId(bad), false, JSON.stringify(bad))
    const r = P.applyToggle(REAL_PATCH, bad, true)
    assert.equal(r.ok, false, JSON.stringify(bad))
  }
  // 真实 id 的形态必须放行（带 @ / 斜杠 / 点 / 连字符）
  for (const good of ['dsh-find-plugin', '@deepseek-ai/dsh-mnemon', 'a.b/c']) {
    assert.equal(P.validId(good), true, good)
  }
})

// ── ⑥ 引号与 CRLF ──
test('applyToggle：id 带引号时按去引号后比较（不会重复追加同一条）', () => {
  const r = P.applyToggle('- id: "my-plugin"\n  disabled: false\n', 'my-plugin', true)
  assert.equal(r.action, 'update')
  assert.equal(r.text, '- id: "my-plugin"\n  disabled: true\n')
})

test('applyToggle：CRLF 文件改完仍是 CRLF（不能把整份文件的行尾换掉）', () => {
  const src = '- id: a\r\n  disabled: false\r\n- id: b\r\n  disabled: true\r\n'
  const r = P.applyToggle(src, 'a', true)
  assert.equal(r.text, '- id: a\r\n  disabled: true\r\n- id: b\r\n  disabled: true\r\n')
  assert.equal(r.text.split('\r\n').length, src.split('\r\n').length)
})

// ── ⑦ 幂等 ──
test('applyToggle：连做两次同一操作，第二次是 noop 且不再改动文本', () => {
  const once = P.applyToggle(REAL_PATCH, 'brand-new', true)
  const twice = P.applyToggle(once.text, 'brand-new', true)
  assert.equal(twice.action, 'noop')
  assert.equal(twice.changed, false)
  assert.equal(twice.text, once.text)
})
