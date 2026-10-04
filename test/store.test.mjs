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

const { normTokenPrice, normQuotes, normUiMode, QUOTE_GROUP_MAX, normSeg, normRow, normQuoteGroup, normQuoteSound, rowsFromV1, normRowCond, quoteCondOk, QUOTE_FONT_TIERS } = store
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

test('normQuotes 恢复默认：两项固定文案 + 内置六组迁移成 v2（顺序与权重沿用整理前写死的那套）', () => {
  const q = normQuotes(null)
  assert.ok(Array.isArray(q.time) && q.time.length)
  assert.ok(Array.isArray(q.gifFail) && q.gifFail.length)
  assert.equal(q.v, 2)
  assert.deepEqual(q.groups.map((g) => [g.kind, g.w]), [
    ['card', 45],
    ['text', 7],
    ['text', 7],
    ['text', 10],
    ['text', 3],
    ['text', 1],
  ])
  // v2 出口：旧 image 组迁移成单图段行（img=0 = 抽到时随机取一张）；text 组全是行×段
  assert.deepEqual(q.groups[3].rows, [{ segs: [{ type: 'image', img: 0, h: 96, br: undefined }] }])
  const textGroups = q.groups.filter((g) => g.kind === 'text' && g.rows.some((r) => r.segs[0].type === 'text'))
  assert.ok(textGroups.every((g) => g.rows.length > 0 && g.rows.every((r) => r.segs[0].t)))
  // 旧 style 还留在行里：B 组大字 fz11、A 组普通字号 fz7 + 行可折行
  assert.equal(q.groups[1].rows[0].segs[0].fz, 11)
  assert.equal(q.groups[2].rows[0].segs[0].fz, 7)
  assert.equal(q.groups[2].rows[0].w, 1)
  assert.equal(q.groups[1].rows[0].w, undefined)
  // 默认值不能共用同一个数组实例（否则设置页改一次就把默认值污染了）
  assert.notEqual(normQuotes(null).groups, normQuotes(null).groups)
})

test('normQuotes 老结构就地升级：四个 key → 四组文本，card / image 补回原位', () => {
  const q = normQuotes({ hint: ['a'], chat: ['b'], dsh: ['c'], short: ['d'], time: ['报时'], gifFail: ['挂了'] })
  assert.equal(q.v, 2)
  assert.deepEqual(q.time, ['报时'])
  assert.deepEqual(q.gifFail, ['挂了'])
  assert.deepEqual(q.groups.map((g) => g.kind), ['card', 'text', 'text', 'text', 'text', 'text'])
  assert.deepEqual(q.groups.map((g) => g.w), [45, 7, 7, 10, 3, 1])
  const firstText = (g) => g.rows[0].segs[0].t
  assert.deepEqual(
    [q.groups[1], q.groups[2], q.groups[4], q.groups[5]].map(firstText),
    ['a', 'b', 'c', 'd'],
  )
  // 老结构里没配过的组用内置文案补齐，不会升级成空组
  assert.ok(normQuotes({ chat: ['只有这一组'] }).groups[1].rows.length > 1)
})

test('normQuotes 组清洗：权重压到 1–999，kind 不认按文本，没有台词的文本组整组丢掉', () => {
  const q = normQuotes({ groups: [
    { kind: 'image', w: 0 },
    { kind: 'card', w: 99999 },
    { kind: 'nope', w: 3, lines: [' 留  '] },
    { kind: 'text', w: 5, lines: ['   ', ''] },
  ] })
  assert.equal(q.v, 2)
  // image 组被迁移成「单图段行」的 text 组，w 压到 1
  assert.deepEqual(q.groups, [
    { kind: 'text', w: 1, rows: [{ segs: [{ type: 'image', img: 0, h: 96, br: undefined }] }] },
    { kind: 'card', w: 999 },
    { kind: 'text', w: 3, rows: [{ segs: [{ type: 'text', t: '留', fz: 7, c: '', g: undefined, b: undefined, i: undefined, br: undefined }], w: 1 }] },
  ])
})

test('normQuotes 组列表为空 / 一组不剩都回内置默认（全空会让随机台词整个功能消失）', () => {
  assert.equal(normQuotes({ groups: [] }).groups.length, 6)
  assert.equal(normQuotes({ groups: [{ kind: 'text', lines: [] }] }).groups.length, 6)
  assert.equal(normQuotes({ groups: [{ kind: 'text', w: 1 }] }).groups.length, 6)
})

test('normQuotes 组数超上限截到上限（用实现导出的常量比较，写死数字会与实现脱钩）', () => {
  const many = []
  for (let i = 0; i < QUOTE_GROUP_MAX + 8; i++) many.push({ kind: 'image', w: 1 })
  assert.equal(normQuotes({ groups: many }).groups.length, QUOTE_GROUP_MAX)
  // 恰好等于上限时不截断（边界另一侧：off-by-one 会让用户配满的一组凭空消失）
  const exact = many.slice(0, QUOTE_GROUP_MAX)
  assert.equal(normQuotes({ groups: exact }).groups.length, QUOTE_GROUP_MAX)
})

test('normQuotes 只带部分键时其余沿用现值（不是回默认）', () => {
  const cur = normQuotes(null)
  cur.time = ['旧的']
  const q = normQuotes({ gifFail: ['新降级'] }, cur)
  assert.deepEqual(q.time, ['旧的'])
  assert.deepEqual(q.gifFail, ['新降级'])
  assert.deepEqual(q.groups, cur.groups)
})

test('normQuotes v2 现值回灌幂等：groups 读写往返一遍不再变形（patchConfig 部分更新靠它）', () => {
  const first = normQuotes({ groups: [
    { kind: 'text', w: 4, rows: [{ segs: [{ t: '富文本', fz: 9, c: '#f00' }, { type: 'model', model: 'balance' }] }] },
    { kind: 'image', w: 2 },
  ] })
  const second = normQuotes(first)
  assert.deepEqual(second, first)
  // 再灌一遍仍一致（防「第一次是巧合」）
  assert.deepEqual(normQuotes(second), first)
})

test('normQuotes 文本字段清空回内置默认（不是空数组：报时 / 降级文案不能没字）', () => {
  assert.ok(normQuotes({ time: [], gifFail: ['   '] }).time.length > 1)
  assert.ok(normQuotes({ time: [], gifFail: ['   '] }).gifFail.length > 1)
})

test('normQuotes 同时带 groups 与老 key 时以 groups 为准', () => {
  const q = normQuotes({ groups: [{ kind: 'image', w: 2 }], hint: ['老'] })
  assert.deepEqual(q.groups, [
    { kind: 'text', w: 2, rows: [{ segs: [{ type: 'image', img: 0, h: 96, br: undefined }] }] },
  ])
})

// —— v2 组/行/段清洗 ——

test('normSeg text 段：清洗字段、截长度，非法渐变丢掉只留纯色', () => {
  const s = normSeg({ t: '  你好  ', fz: 99, c: ' #abc ', g: 'not-a-gradient', b: 1, i: 1, br: 1 })
  assert.deepEqual(s, {
    type: 'text', t: '你好', fz: QUOTE_FONT_TIERS.length, c: '#abc',
    g: undefined, b: 1, i: 1, br: 1,
  })
  // 空文本整段丢；type 缺省也按 text
  assert.equal(normSeg({ t: '   ' }), null)
  assert.equal(normSeg({ t: 'x' }).type, 'text')
})

test('normSeg image / link / model 段：字段边界与整段丢弃', () => {
  // 图段：img 缺省按 0（渲染层随机取一张），h 压到 8–300
  assert.deepEqual(normSeg({ type: 'image' }), { type: 'image', img: 0, h: 96, br: undefined })
  assert.equal(normSeg({ type: 'image', img: 3, h: 999 }).h, 300)
  assert.equal(normSeg({ type: 'image', img: -5 }).img, 0)
  // 链接段：没 url 整段丢；t 空回落 url
  assert.equal(normSeg({ type: 'link', url: '   ' }), null)
  assert.deepEqual(
    normSeg({ type: 'link', url: ' https://a.b ', t: '' }),
    { type: 'link', url: 'https://a.b', t: 'https://a.b', br: undefined },
  )
  // model 段：键不认整段丢（留着会渲染出「undefined 余额」）
  assert.equal(normSeg({ type: 'model', model: 'nope' }), null)
  assert.equal(normSeg({ type: 'model', model: 'balance' }).fz, 7)
})

test('normRow 双认输入：数组 = 段列表、字符串 = 单 text 段，无有效段整行丢', () => {
  assert.deepEqual(normRow('你好'), { segs: [{ type: 'text', t: '你好', fz: 7, c: '', g: undefined, b: undefined, i: undefined, br: undefined }] })
  assert.deepEqual(normRow([{ t: 'a' }, { type: 'image' }]).segs.length, 2)
  assert.equal(normRow({ segs: [{ t: '  ' }] }), null)
  assert.equal(normRow(null), null)
  // w 只认 1；行内段数超上限截断
  assert.equal(normRow({ segs: [{ t: 'x' }], w: true }).w, undefined)
  const many = []
  for (let i = 0; i < 20; i++) many.push({ t: 'x' + i })
  assert.equal(normRow(many).segs.length, 12)
})

test('rowsFromV1 迁移映射：A = fz7 + 行可折行，B = fz11 大字不折行（与旧三行模型字号对齐）', () => {
  assert.deepEqual(rowsFromV1(['a', 'b'], 'A'), [
    { segs: [{ t: 'a', fz: 7 }], w: 1 },
    { segs: [{ t: 'b', fz: 7 }], w: 1 },
  ])
  assert.deepEqual(rowsFromV1(['a'], 'B'), [[{ t: 'a', fz: QUOTE_FONT_TIERS.length }]])
})

test('normQuoteGroup：双认输入（v2 rows 优先）、v1 image 组迁移、空文本组整组丢', () => {
  // v1 输入（lines + style + kind image）就地升级：B 组行对象已带全套段字段
  const v1 = normQuoteGroup({ kind: 'text', w: 3, style: 'B', lines: ['甲', '乙'] })
  assert.equal(v1.kind, 'text')
  assert.deepEqual(
    v1.rows.map((r) => [r.segs[0].t, r.segs[0].fz, r.w]),
    [['甲', 11, undefined], ['乙', 11, undefined]],
  )
  // v2 输入原样清洗；rows 与 lines 同时给时 rows 优先
  const v2 = normQuoteGroup({ kind: 'text', w: 3, rows: ['富'], lines: ['旧'], style: 'A' })
  assert.deepEqual(v2.rows, [{ segs: [{ type: 'text', t: '富', fz: 7, c: '', g: undefined, b: undefined, i: undefined, br: undefined }] }])
  // 行数超上限截到 30（与 normRows 上限一致）
  const big = normQuoteGroup({ kind: 'text', w: 3, rows: Array.from({ length: 40 }, (_, i) => '行' + i) })
  assert.equal(big.rows.length, 30)
  // 没有有效台词的文本组丢掉
  assert.equal(normQuoteGroup({ kind: 'text', w: 3, lines: [] }), null)
  assert.equal(normQuoteGroup({ kind: 'text', w: 3, rows: [] }), null)
})

test('normQuoteSound 清洗：非串回 undefined、trim + 限长 120、空串回 undefined', () => {
  assert.equal(normQuoteSound('来财'), '来财')
  assert.equal(normQuoteSound('  来财  '), '来财')
  assert.equal(normQuoteSound(42), undefined)
  assert.equal(normQuoteSound({}), undefined)
  assert.equal(normQuoteSound(null), undefined)
  assert.equal(normQuoteSound('   '), undefined)
  assert.equal(normQuoteSound(''), undefined)
  assert.equal(normQuoteSound('a'.repeat(130)), 'a'.repeat(120))
})

test('normQuoteGroup sound 字段：三 kind 出口都带清洗后的名字，脏值（非串）不残留', () => {
  // 合法名字随组带出
  const t = normQuoteGroup({ kind: 'text', w: 3, lines: ['甲'], sound: ' 来财 ' })
  assert.equal(t.sound, '来财')
  const c = normQuoteGroup({ kind: 'card', w: 3, sound: '金币' })
  assert.equal(c.sound, '金币')
  const img = normQuoteGroup({ kind: 'image', w: 3, sound: '泡泡' })
  assert.equal(img.sound, '泡泡')
  // 脏值清洗不出名字：出口不残留（关键在 passOwn 透传排除——sound 必须列进已知键）
  const dirty = normQuoteGroup({ kind: 'card', w: 3, sound: 42 })
  assert.equal('sound' in dirty, false)
  // 没配 sound 的组出口也不带键（保持出口形态干净）
  const plain = normQuoteGroup({ kind: 'card', w: 3 })
  assert.equal('sound' in plain, false)
})

test('normRowCond 清洗：type 白名单、balanceBelow/model 必带参、weekday 去重且拒绝全选，非法一律摘键', () => {
  assert.deepEqual(normRowCond({ type: 'peak' }), { type: 'peak' })
  assert.deepEqual(normRowCond({ type: 'valley' }), { type: 'valley' })
  assert.deepEqual(normRowCond({ type: 'balanceBelow', value: '22.4' }), { type: 'balanceBelow', value: 22 })
  // 0 / 负数阈值没有意义（余额<0 恒假），回 undefined 让行退回无条件
  assert.equal(normRowCond({ type: 'balanceBelow', value: 0 }), undefined)
  assert.deepEqual(normRowCond({ type: 'model', value: ' gpt ' }), { type: 'model', value: 'gpt' })
  assert.equal(normRowCond({ type: 'model', value: '  ' }), undefined)
  // weekday：非法值滤掉、去重；全选（恒真）与全不选（恒假）都摘键
  assert.deepEqual(normRowCond({ type: 'weekday', days: [1, '3', 1, 9] }), { type: 'weekday', days: [1, 3] })
  assert.equal(normRowCond({ type: 'weekday', days: [0, 1, 2, 3, 4, 5, 6] }), undefined)
  assert.equal(normRowCond({ type: 'weekday', days: [] }), undefined)
  // 未知类型 / 非对象输入一律 undefined（行退回无条件，不丢行）
  assert.equal(normRowCond({ type: 'weather' }), undefined)
  assert.equal(normRowCond('peak'), undefined)
  assert.equal(normRowCond(null), undefined)
})

test('quoteCondOk 求值：峰谷 / 余额阈值（null = 未知不满足）/ 主显模型 / 星期几，未知类型恒真', () => {
  const day = (n) => new Date(2026, 9, 4 + n).getDay() // 相邻两天 weekday 必不同，测试自洽不依赖日历
  assert.equal(quoteCondOk({ type: 'peak' }, { isPeak: true }), true)
  assert.equal(quoteCondOk({ type: 'peak' }, { isPeak: false }), false)
  assert.equal(quoteCondOk({ type: 'valley' }, { isPeak: false }), true)
  assert.equal(quoteCondOk({ type: 'valley' }, { isPeak: true }), false)
  // 余额未知（null / 没给）按不满足算：还没查到余额就别把「余额低」的台词抖出来吓人
  assert.equal(quoteCondOk({ type: 'balanceBelow', value: 10 }, { balance: 9.9 }), true)
  assert.equal(quoteCondOk({ type: 'balanceBelow', value: 10 }, { balance: 10 }), false)
  assert.equal(quoteCondOk({ type: 'balanceBelow', value: 10 }, { balance: null }), false)
  assert.equal(quoteCondOk({ type: 'balanceBelow', value: 10 }, {}), false)
  assert.equal(quoteCondOk({ type: 'model', value: 'gpt' }, { mainModelId: 'gpt' }), true)
  assert.equal(quoteCondOk({ type: 'model', value: 'gpt' }, { mainModelId: 'deepseek' }), false)
  const mon = day(1) // 周一
  assert.equal(quoteCondOk({ type: 'weekday', days: [mon] }, { day: mon }), true)
  assert.equal(quoteCondOk({ type: 'weekday', days: [mon] }, { day: day(2) }), false)
  assert.equal(quoteCondOk({ type: 'weekday', days: [mon] }, {}), false)
  // 无条件 / 未知类型恒真（老配置没有 cond、未来加了新类型旧页面不能把行全塌了）
  assert.equal(quoteCondOk(null, {}), true)
  assert.equal(quoteCondOk({ type: 'weather' }, {}), true)
})

test('normRow 收编 cond：合法条件透传到行上，非法条件摘键（行保留）', () => {
  const ok = normRow({ segs: [{ t: '峰时才见' }], cond: { type: 'peak' } })
  assert.deepEqual(ok.cond, { type: 'peak' })
  const bad = normRow({ segs: [{ t: '条件写错' }], cond: { type: 'weather' } })
  assert.equal(bad.cond, undefined)
  assert.equal(bad.segs.length, 1)
  // v2「只升级不删」的透传口径继续成立：其它未知字段仍原样带出（未来加 ttl / sound 零迁移）
  const keep = normRow({ segs: [{ t: 'x' }], ttl: 5 })
  assert.equal(keep.ttl, 5)
})

test('normRow 收编 d（行级停留秒数）：1–120 取整落键，边界外/非数值一律摘键，缺省不落键', () => {
  const mk = (d) => normRow({ segs: [{ t: 'x' }], d })
  assert.equal(mk(30).d, 30)
  assert.equal(mk('45').d, 45)
  assert.equal(mk(7.6).d, 8)
  assert.equal(mk(1).d, 1)
  assert.equal(mk(120).d, 120)
  // 边界外直接摘键（夹回是设置页编辑器的职责，出口清洗只认合法区间，不让脏值穿到悬浮页）
  assert.equal(mk(0).d, undefined)
  assert.equal(mk(-5).d, undefined)
  assert.equal(mk(121).d, undefined)
  assert.equal(mk(99999).d, undefined)
  // 非数值 / 脏值摘键（缺省口径：悬浮页按 BUBBLE_MS 5 秒收起）
  assert.equal(mk('abc').d, undefined)
  assert.equal(mk(NaN).d, undefined)
  assert.equal(mk(null).d, undefined)
  assert.equal(mk(undefined).d, undefined)
  // 幂等往返：清洗结果再洗一遍不变
  const once = mk(42)
  assert.equal(normRow(once).d, 42)
})

test('normUiMode 只认 light/dark，其余（含缺省与非法）一律回 auto', () => {
  assert.equal(normUiMode('light'), 'light')
  assert.equal(normUiMode('dark'), 'dark')
  assert.equal(normUiMode('auto'), 'auto')
  assert.equal(normUiMode(undefined), 'auto')
  assert.equal(normUiMode(null), 'auto')
  assert.equal(normUiMode(''), 'auto')
  // 非法值不做就近猜测：配坏了顶多回默认行为（跟 uTools），不会莫名其妙变成另一个手动档
  assert.equal(normUiMode('Light'), 'auto')
  assert.equal(normUiMode('system'), 'auto')
  assert.equal(normUiMode(123), 'auto')
})
