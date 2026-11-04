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

// ── ①b config 负载 vs 条目（上游 #841 系列）──
//
// `config:` 下面完全可能是「列表里的对象也带 id / disabled」——那是插件的配置内容，
// 不是 patch 条目。早先按「任何 `- id:` 都开新条目」解析，界面会多出假插件，
// 勾选还会改到负载里的行（id 撞名时禁用错插件）。
test('parsePatch：config 负载里的 - id: / disabled: 不算 patch 条目', () => {
  const { items } = P.parsePatch([
    '- id: a',
    '  config:',
    '    list:',
    '      - id: b',
    '        disabled: true',
    '- id: c',
    '  disabled: true',
  ].join('\n'))
  assert.deepEqual(items.map((i) => i.id), ['a', 'c'])
  assert.deepEqual(items.map((i) => [i.id, i.disabled]), [['a', false], ['c', true]])
  assert.equal(items[0].hasConfig, true, '负载仍算「带 config」')
})

test('parsePatch：列表与键同列（YAML 合法写法）时负载仍不被当条目', () => {
  const { items } = P.parsePatch([
    '- id: a',
    '  config:',
    '  - id: b',
    '    disabled: true',
    '- id: c',
  ].join('\n'))
  assert.deepEqual(items.map((i) => i.id), ['a', 'c'])
  assert.equal(items[0].disabled, false, '负载里的 disabled 不能算到 a 头上')
})

// ── ② disabled 取值 ──
test('parsePatch：disabledExpr 只对非字面量取值置真（表达式不能被字面量覆盖）', () => {
  const { items } = P.parsePatch([
    '- id: a',
    '  disabled: false',
    '- id: b',
    "  disabled: !!js 'process.env.DISABLE_SIDEBAR'",
    '- id: c',
    '  disabled: yes',
  ].join('\n'))
  assert.deepEqual(items.map((i) => i.disabledExpr), [false, true, false])
})

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

// ── ③b 表达式行（上游 #1043）──
//
// `disabled: !!js …` 由 dsh 在组合时求值，市场读不出也替不了。启用时写字面量 false
// 会强行打开环境本应关掉的行（随后组合把插件挂起）；所以这类行只能保留，如实回报。
test('applyToggle：启用时不覆盖 !!js 表达式，如实回报 expression', () => {
  const src = ['- id: a', '  config:', '    k: 1', "  disabled: !!js 'env.x'"].join('\n')
  const r = P.applyToggle(src, 'a', false)
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(r.action, 'noop')
  assert.equal(r.expression, true)
  assert.equal(r.text, src, '表达式必须逐字保留')
})

test('applyToggle：启用只清掉市场写入的字面量段，表达式原样留着', () => {
  const src = ['- id: a', "  disabled: !!js 'env.x'", '- id: a', '  disabled: true'].join('\n')
  const r = P.applyToggle(src, 'a', false)
  assert.equal(r.expression, true)
  assert.equal(r.changed, true)
  assert.ok(r.text.includes("disabled: !!js 'env.x'"))
  assert.equal(r.text.includes('disabled: true'), false)
  assert.equal(P.parsePatch(r.text).items.length, 1)
})

test('applyToggle：禁用时保留表达式，并保证生效值仍是 true', () => {
  const src = ['- id: a', "  disabled: !!js 'env.x'", '- id: a', '  disabled: false'].join('\n')
  const r = P.applyToggle(src, 'a', true)
  assert.equal(r.changed, true)
  assert.ok(r.text.includes("disabled: !!js 'env.x'"))
  assert.equal(r.text.includes('disabled: false'), false)
  assert.equal(P.parsePatch(r.text).items[0].disabled, true)
})

test('applyToggle：负载里的 id 不会被当成 patch 条目改写（只会在末尾新加）', () => {
  const src = [
    '- id: a',
    '  config:',
    '    list:',
    '      - id: b',
    '        disabled: false',
    '- id: c',
  ].join('\n')
  const r = P.applyToggle(src, 'b', true)
  assert.equal(r.action, 'append')
  assert.ok(r.text.endsWith('- id: b\n  disabled: true\n'))
  // 负载里那行原样保留，没被当成 b 的条目改掉
  assert.ok(r.text.includes('      - id: b\n        disabled: false'))
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

// ── ⑧ 修 B6：值已达标即 noop，不能白插一行 ──
test('applyToggle：条目已禁用且没有 disabled 行时，再设 true 是 noop（不白插一行）', () => {
  // `disabled: !!js '...'` 的条目：disabledValue 判为 true，但 disabledLineIndex 在解析里会被记为
  // 那一行 —— 这里要的是「值为 true 但没有 disabled 行」的形态：靠 dsh 默认值或省略行生效。
  // 用「条目下只有 config、靠条目级 disabled 语义」的写法模拟：人为构造 hit.disabled === want
  // 且 disabledLineIndex === -1 的场景。
  const src = '- id: a\n  config:\n    k: 1\n'
  // 先手动把 a 标成「已禁用」的等价形态：用一个能解析出 disabled:true 的文本，
  // 再去掉那一行 —— 直接构造更简单：用 applyToggle 把 a 设为 true（insert 一行），
  // 然后手工删掉那行，模拟「值是 true 但没有该行」的历史文件。
  const inserted = P.applyToggle(src, 'a', true)
  assert.equal(inserted.action, 'insert')
  const noLine = inserted.text.replace('  disabled: true\n', '')
  assert.equal(noLine, src)
  // 该文件里 a 没有 disabled 行 → parsePatch 判 disabled:false，故这里设 false 才是 noop
  const r = P.applyToggle(noLine, 'a', false)
  assert.equal(r.action, 'noop')
  assert.equal(r.changed, false)
  assert.equal(r.text, noLine)
})

// ── ⑪ 同 id 多段：对齐上游 dsh-market #821 ──
// patch 的语义是「同 id 后出现的覆盖先出现的」，所以只改第一条会让「生效的那段」原样留着，
// 界面看到一个勾不动的开关，而 dsh 对这种「写了没生效」永不报错（V2）。
test('applyToggle 多段：禁用后原地翻转，不留 true/false 两段并存', () => {
  const src = '- id: a\n  disabled: false\n- id: a\n  disabled: false\n- id: b\n'
  const r = P.applyToggle(src, 'a', true)
  assert.equal(r.changed, true)
  assert.equal(r.text, '- id: a\n  disabled: true\n- id: b\n')
  const { items } = P.parsePatch(r.text)
  assert.deepEqual(items.map((i) => [i.id, i.disabled]), [['a', true], ['b', false]])
})

test('applyToggle 多段：CRLF 文件多段改写后仍是 CRLF', () => {
  const src = '- id: b\r\n- id: a\r\n  disabled: true\r\n- id: a\r\n  disabled: false\r\n'
  const r = P.applyToggle(src, 'a', true)
  assert.equal(r.changed, true)
  // 保留段 = 第一个纯段（index 1）→ 原位改 true；第二段纯段删掉
  assert.equal(r.text, '- id: b\r\n- id: a\r\n  disabled: true\r\n')
  assert.equal(/[^\r]\n/.test(r.text), false, '不能把 CRLF 换成 LF')
})

test('applyToggle 多段：启用时删掉该 id 的所有纯 disabled 段（含 false 占位段）', () => {
  const src = '- id: a\n  disabled: true\n- id: b\n- id: a\n  disabled: true\n'
  const r = P.applyToggle(src, 'a', false)
  assert.equal(r.action, 'remove')
  assert.equal(r.text, '- id: b\n')
  assert.deepEqual(P.parsePatch(r.text).items.map((i) => i.id), ['b'])
})

test('applyToggle 多段：带 config 的段绝不被整段删（否则 config 会挂到上一条目）', () => {
  const src = '- id: a\n  disabled: true\n  config:\n    k: 1\n- id: b\n  disabled: false\n'
  const r = P.applyToggle(src, 'a', false)
  const { items } = P.parsePatch(r.text)
  assert.deepEqual(items.map((i) => i.id), ['a', 'b'])
  assert.equal(items[0].disabled, false, '启用后 disabled 行应改成 false 而不是删段')
  assert.equal(items[0].hasConfig, true, 'config 子块必须原样保留')
  assert.deepEqual(items.map((i) => i.disabled), [false, false])
})

test('applyToggle 多段：禁用时带 config 的后续段也一并改成 true（否则生效值被覆盖回 false）', () => {
  const src = '- id: a\n  disabled: false\n- id: a\n  disabled: false\n  config:\n    k: 1\n'
  const r = P.applyToggle(src, 'a', true)
  const { items } = P.parsePatch(r.text)
  assert.deepEqual(items.map((i) => i.disabled), [true, true])
  assert.equal(items[1].hasConfig, true)
})

test('applyToggle 多段：保留段选第一个纯 disabled 段，带 config 的前段不被当成保留段', () => {
  const src = '- id: a\n  config:\n    k: 1\n- id: a\n  disabled: false\n- id: b\n'
  const r = P.applyToggle(src, 'a', true)
  // 第一段带 config 但没有 disabled 行 → 不该往它头上插；第二个纯段原位改 true 即可
  assert.equal(r.text, '- id: a\n  config:\n    k: 1\n- id: a\n  disabled: true\n- id: b\n')
  const { items } = P.parsePatch(r.text)
  assert.deepEqual(items.map((i) => [i.id, i.disabled]), [['a', false], ['a', true], ['b', false]])
})

test('applyToggle 多段：生效值已达标时是 noop（即使第一段不是 true）', () => {
  const src = '- id: a\n  disabled: false\n- id: a\n  disabled: true\n'
  const r = P.applyToggle(src, 'a', true)
  assert.equal(r.action, 'noop')
  assert.equal(r.text, src)
})

test('applyToggle 多段：行尾空格 + 文件末尾无换行也能处理', () => {
  const src = '- id: a  \n  disabled: false  \n- id: a\n  disabled: false'
  const r = P.applyToggle(src, 'a', true)
  // 后段生效值为 false，所以要真的动手：第一段改成 true，后面那段纯 disabled 段删掉
  assert.notEqual(r.action, 'noop')
  assert.equal(r.changed, true)
  const { items } = P.parsePatch(r.text)
  assert.equal(items.length, 1, '重复段应被折叠成一段')
  assert.equal(items[0].disabled, true)
})

test('applyToggle 多段：全是带 config 的段时，禁用要全部改成 true（不能留下后段覆盖回 false）', () => {
  const src = '- id: a\n  disabled: false\n  config:\n    k: 1\n- id: a\n  disabled: false\n  config:\n    m: 2\n- id: b\n'
  const r = P.applyToggle(src, 'a', true)
  assert.equal(r.changed, true)
  const { items } = P.parsePatch(r.text)
  assert.deepEqual(items.filter((i) => i.id === 'a').map((i) => i.disabled), [true, true])
  // 两段 config 都原样保留
  assert.equal(r.text.includes('    k: 1'), true)
  assert.equal(r.text.includes('    m: 2'), true)
  assert.equal(r.text.includes('- id: b'), true)
})

test('applyToggle 多段：启用时全是带 config 的段 → 只把 disabled 改成 false，不删 config', () => {
  const src = '- id: a\n  disabled: true\n  config:\n    k: 1\n- id: a\n  disabled: true\n  config:\n    m: 2\n- id: b\n'
  const r = P.applyToggle(src, 'a', false)
  assert.equal(r.changed, true)
  const { items } = P.parsePatch(r.text)
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((i) => [i.id, i.disabled]), [['a', false], ['a', false], ['b', false]])
  assert.equal(r.text.includes('    k: 1'), true)
  assert.equal(r.text.includes('    m: 2'), true)
})

// ── ⑫ 删条目（卸载清理，P0-3 用）──
test('removeItem：删掉该 id 的所有段（含 config 子块），不动其它条目', () => {
  const src = [
    '- id: a',
    '  disabled: true',
    '- id: b',
    '  config:',
    '    k: 1',
    '- id: a',
    '  disabled: false',
    '  config:',
    '    m: 2',
    '',
  ].join('\n')
  const r = P.removeItem(src, ['a'])
  assert.equal(r.ok, true)
  assert.equal(r.removed, 2)
  assert.deepEqual(P.parsePatch(r.text).items.map((i) => i.id), ['b'])
  // b 的 config 还在，没被误删
  assert.equal(r.text.trimEnd(), '- id: b\n  config:\n    k: 1')
})

test('removeItem：带空行分隔的文件，删完不留孤立的连续空行', () => {
  const src = [
    '# 顶部注释',
    '',
    '- id: a',
    '  disabled: true',
    '',
    '- id: b',
    '',
  ].join('\n')
  const r = P.removeItem(src, ['a'])
  // 注释与空行留给剩下的条目，但「a 与 b 之间那串空行」随 a 一起消失
  assert.equal(r.text, '# 顶部注释\n\n- id: b\n')
  assert.deepEqual(P.parsePatch(r.text).items.map((i) => i.id), ['b'])
})

test('removeItem：多个 id 一次删，互不影响', () => {
  const src = '- id: a\n  disabled: true\n- id: b\n  disabled: true\n- id: c\n'
  const r = P.removeItem(src, ['a', 'b'])
  assert.equal(r.removed, 2)
  assert.equal(r.text, '- id: c\n')
})

test('removeItem：删空后回到 []，不带多余条目', () => {
  const r = P.removeItem('- id: a\n  disabled: true\n', ['a'])
  assert.equal(r.text, '[]\n')
  assert.deepEqual(P.parsePatch(r.text).items, [])
})

test('removeItem：id 不存在时 changed:false 且原文返回', () => {
  const src = '- id: a\n  disabled: true\n'
  const r = P.removeItem(src, ['nope'])
  assert.equal(r.changed, false)
  assert.equal(r.text, src)
})

// 同一行空行既是 a 的尾随、也是 b 的前导 —— 两条一起删时行号会重复入列，
// 不去重就会多删一行（把 c 的头行也带走）。这类错位是静默的：文件仍是合法 YAML。
test('removeItem：两条相邻且中间夹空行一起删，行号不重复导致多删', () => {
  const src = '- id: a\n\n- id: b\n\n- id: c\n  disabled: true\n'
  const r = P.removeItem(src, ['a', 'b'])
  assert.equal(r.text, '- id: c\n  disabled: true\n')
  assert.deepEqual(P.parsePatch(r.text).items.map((i) => i.id), ['c'])
})

// 块内注释缩进比条目头更浅（用户手写常见）时，按缩进判块尾会提前截断，
// 把 `disabled:` 留成孤儿行挂到上一条目身上。
test('removeItem：块内注释缩进更浅也不提前截断', () => {
  const src = '- id: a\n# 说明 a 为什么要这么配\n  config:\n    k: 1\n- id: b\n  disabled: true\n'
  const r = P.removeItem(src, ['a'])
  assert.equal(r.text, '- id: b\n  disabled: true\n')
})

// ── ⑬ 批量禁用也多段生效（E3 一键隔离）──
test('applyBatchDisable：同 id 多段时全部处理，plans 如实报改动', () => {
  const src = '- id: a\n  disabled: false\n- id: a\n  disabled: false\n- id: c\n'
  const r = P.applyBatchDisable(src, ['a', 'c'])
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  const { items } = P.parsePatch(r.text)
  // a 只剩一段且为 true；c 被插了一行 true
  assert.deepEqual(items.filter((i) => i.id === 'a').map((i) => i.disabled), [true])
  assert.deepEqual(items.filter((i) => i.id === 'c').map((i) => i.disabled), [true])
  const planA = r.plans.find((p) => p.id === 'a')
  assert.equal(planA.action, 'remove', '有多余纯段要删 → remove')
  assert.equal(planA.blocks, 2)
  assert.equal(planA.was, false)
})

test('applyBatchDisable：生效值已是 true 的多段 id 报 noop，不改文件', () => {
  const src = '- id: a\n  disabled: false\n- id: a\n  disabled: true\n'
  const r = P.applyBatchDisable(src, ['a'])
  assert.equal(r.changed, false)
  assert.equal(r.text, src)
  assert.equal(r.plans[0].action, 'noop')
})

test('applyBatchDisable：全新 id 仍追加在末尾', () => {
  const r = P.applyBatchDisable('- id: a\n  disabled: true\n', ['z'])
  assert.equal(r.text, '- id: a\n  disabled: true\n- id: z\n  disabled: true\n')
  assert.equal(r.plans[0].action, 'append')
})

// 插行会把后面的行号整体下移，若删行仍用原始行号，就会删到隔壁条目身上（用户 config 丢失）。
test('applyBatchDisable：插行与删行并存时不错位，config 不丢', () => {
  const src = '- id: a\n- id: a\n  config:\n    x: 1\n- id: a\n'
  const r = P.applyBatchDisable(src, ['a'])
  assert.equal(r.changed, true)
  assert.match(r.text, /\n {4}x: 1\n/, 'config 子行必须原样保留')
  const { items } = P.parsePatch(r.text)
  assert.equal(items.filter((i) => i.id === 'a').pop().disabled, true, '生效值必须为 true')
})

test('applyBatchDisable：插行不影响后面无关条目', () => {
  const src = '- id: a\n- id: a\n  config:\n    x: 1\n- id: a\n- id: b\n  disabled: true\n'
  const r = P.applyBatchDisable(src, ['a'])
  assert.match(r.text, /\n- id: b\n {2}disabled: true\n/, 'b 段必须保持原样')
  const { items } = P.parsePatch(r.text)
  assert.equal(items.filter((i) => i.id === 'b').length, 1)
  assert.equal(items.filter((i) => i.id === 'b')[0].disabled, true)
})

// ── ⑭ 修 B4：eol 字段必须按原始文本报告 ──
test('parsePatch：eol 按原始文本报告（CRLF 文件不能报 LF）', () => {
  assert.equal(P.parsePatch('- id: a\r\n  disabled: false\r\n').eol, '\r\n')
  assert.equal(P.parsePatch('- id: a\n  disabled: false\n').eol, '\n')
  assert.equal(P.parsePatch('').eol, '\n')
})

// ── ⑩ 修 B5：YAML 流式指示符必须拒绝 ──
test('validId：YAML 流式指示符 { } [ ] , 一律拒绝（否则回读校验形同虚设）', () => {
  for (const bad of ['a, b', '{a: b}', '[a]', 'a{b}', 'a}b']) {
    assert.equal(P.validId(bad), false, JSON.stringify(bad))
    assert.equal(P.applyToggle(REAL_PATCH, bad, true).ok, false, JSON.stringify(bad))
  }
  // 真实 id 形态不受影响（@ / 斜杠 / 点 / 连字符照旧放行）
  for (const good of ['dsh-find-plugin', '@deepseek-ai/dsh-mnemon', 'a.b/c']) {
    assert.equal(P.validId(good), true, good)
  }
})
