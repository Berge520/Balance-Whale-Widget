/*
 * store.js 归一化函数的单测（node --test，零依赖）。
 *
 * normTokenPrice：设置页每次提交的整份自定义单价都会过这里，写错不抛错，
 * 只会让用户填的单价 / 汇率悄悄变成别的值 —— 甚至把美元数额当人民币记进账本。
 *
 * normQuotes：随机台词组（可增删 / 调权重）与两项固定文案都过这里，同样是不抛错的清洗 ——
 * 写错会让用户配好的台词组整组消失、或权重被悄悄改成别的值。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import store from '../public/preload/lib/store.js'
import constants from '../public/preload/lib/constants.js'

const { normTokenPrice, normQuotes } = store
const { TOKEN_PRICE_DEFAULT, TOKEN_PRICE_MAX, TOKEN_RATE_MAX } = constants

test('normTokenPrice 缺字段回落默认值，开关只认 true', () => {
  assert.deepEqual(normTokenPrice(null), TOKEN_PRICE_DEFAULT)
  assert.deepEqual(normTokenPrice(undefined), TOKEN_PRICE_DEFAULT)
  assert.deepEqual(normTokenPrice('abc'), TOKEN_PRICE_DEFAULT)
  assert.deepEqual(normTokenPrice({}), TOKEN_PRICE_DEFAULT)
  // 开关关着时其余字段照样存下来（下次打开不用重填）
  const off = normTokenPrice({ on: 'yes', cur: 'USD', rate: 7, hit: 1, miss: 2, out: 3 })
  assert.equal(off.on, false)
  assert.deepEqual([off.cur, off.rate, off.hit, off.miss, off.out], ['USD', 7, 1, 2, 3])
})

test('normTokenPrice 币种只认 USD，其余一律 CNY', () => {
  assert.equal(normTokenPrice({ cur: 'USD' }).cur, 'USD')
  assert.equal(normTokenPrice({ cur: 'usd' }).cur, 'CNY')
  assert.equal(normTokenPrice({ cur: 'JPY' }).cur, 'CNY')
})

test('normTokenPrice 截断越界值，0 是合法单价', () => {
  const hi = normTokenPrice({ rate: 99999, hit: 9e9, miss: 9e9, out: 9e9 })
  assert.equal(hi.rate, TOKEN_RATE_MAX)
  assert.equal(hi.hit, TOKEN_PRICE_MAX)
  // 负数抬回 0（不回默认值：负数更像手滑多打了个减号，0 才是「该项不收费」的合法表达）
  const lo = normTokenPrice({ rate: -1, hit: -1, miss: -1, out: -1 })
  assert.deepEqual([lo.rate, lo.hit, lo.miss, lo.out], [0, 0, 0, 0])
  assert.equal(normTokenPrice({ hit: 0 }).hit, 0)
  // 非数字回落默认值
  assert.equal(normTokenPrice({ hit: 'abc' }).hit, TOKEN_PRICE_DEFAULT.hit)
})

test('normTokenPrice 汇率保留 4 位小数', () => {
  assert.equal(normTokenPrice({ rate: 7.123456 }).rate, 7.1235)
  assert.equal(normTokenPrice({ rate: 7 }).rate, 7)
})

test('normQuotes 恢复默认：两项固定文案 + 内置六组（顺序与权重沿用整理前写死的那套）', () => {
  const q = normQuotes(null)
  assert.ok(Array.isArray(q.time) && q.time.length)
  assert.ok(Array.isArray(q.gifFail) && q.gifFail.length)
  assert.deepEqual(q.groups.map((g) => [g.kind, g.w, g.style]), [
    ['card', 45, undefined],
    ['text', 7, 'B'],
    ['text', 7, 'A'],
    ['image', 10, undefined],
    ['text', 3, 'A'],
    ['text', 1, 'B'],
  ])
  assert.ok(q.groups.filter((g) => g.kind === 'text').every((g) => g.lines.length > 0))
  // 默认值不能共用同一个数组实例（否则设置页改一次就把默认值污染了）
  assert.notEqual(normQuotes(null).groups, normQuotes(null).groups)
})

test('normQuotes 老结构就地升级：四个 key → 四组文本，card / image 补回原位', () => {
  const q = normQuotes({ hint: ['a'], chat: ['b'], dsh: ['c'], short: ['d'], time: ['报时'], gifFail: ['挂了'] })
  assert.deepEqual(q.time, ['报时'])
  assert.deepEqual(q.gifFail, ['挂了'])
  assert.deepEqual(q.groups.map((g) => g.kind), ['card', 'text', 'text', 'image', 'text', 'text'])
  assert.deepEqual(q.groups.map((g) => g.w), [45, 7, 7, 10, 3, 1])
  assert.deepEqual(
    [q.groups[1].lines, q.groups[2].lines, q.groups[4].lines, q.groups[5].lines],
    [['a'], ['b'], ['c'], ['d']],
  )
  // 老结构里没配过的组用内置文案补齐，不会升级成空组
  assert.ok(normQuotes({ chat: ['只有这一组'] }).groups[1].lines.length > 1)
})

test('normQuotes 组清洗：权重压到 1–999，kind 不认按文本，没有台词的文本组整组丢掉', () => {
  const q = normQuotes({ groups: [
    { kind: 'image', w: 0 },
    { kind: 'card', w: 99999 },
    { kind: 'nope', w: 3, lines: [' 留  '] },
    { kind: 'text', w: 5, lines: ['   ', ''] },
  ] })
  assert.deepEqual(q.groups, [
    { kind: 'image', w: 1 },
    { kind: 'card', w: 999 },
    { kind: 'text', w: 3, style: 'A', lines: ['留'] },
  ])
})

test('normQuotes 组列表为空 / 一组不剩都回内置默认（全空会让随机台词整个功能消失）', () => {
  assert.equal(normQuotes({ groups: [] }).groups.length, 6)
  assert.equal(normQuotes({ groups: [{ kind: 'text', lines: [] }] }).groups.length, 6)
  assert.equal(normQuotes({ groups: [{ kind: 'text', w: 1 }] }).groups.length, 6)
})

test('normQuotes 组数超上限截到 12 组', () => {
  const many = []
  for (let i = 0; i < 20; i++) many.push({ kind: 'image', w: 1 })
  assert.equal(normQuotes({ groups: many }).groups.length, 12)
})

test('normQuotes 只带部分键时其余沿用现值（不是回默认）', () => {
  const cur = normQuotes(null)
  cur.time = ['旧的']
  const q = normQuotes({ gifFail: ['新降级'] }, cur)
  assert.deepEqual(q.time, ['旧的'])
  assert.deepEqual(q.gifFail, ['新降级'])
  assert.deepEqual(q.groups, cur.groups)
})

test('normQuotes 文本字段清空回内置默认（不是空数组：报时 / 降级文案不能没字）', () => {
  assert.ok(normQuotes({ time: [], gifFail: ['   '] }).time.length > 1)
  assert.ok(normQuotes({ time: [], gifFail: ['   '] }).gifFail.length > 1)
})

test('normQuotes 同时带 groups 与老 key 时以 groups 为准', () => {
  assert.deepEqual(normQuotes({ groups: [{ kind: 'image', w: 2 }], hint: ['老'] }).groups, [
    { kind: 'image', w: 2 },
  ])
})
