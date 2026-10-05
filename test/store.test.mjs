/*
 * store.js 归一化函数的单测（node --test，零依赖）。
 *
 * normTokenPrice：设置页每次提交的整份自定义单价都会过这里，写错不抛错，
 * 只会让用户填的单价 / 汇率悄悄变成别的值 —— 甚至把美元数额当人民币记进账本。
 *
 * normBubble：按压气泡（含固定文案池 system）过这里，同样是不抛错的清洗 ——
 * 写错会让用户配好的气泡整条消失、或权重被悄悄改成别的值。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import store from '../public/preload/lib/store.js'
import constants from '../public/preload/lib/constants.js'

const { normTokenPrice, normUiMode, QUOTE_TEXT_KEYS, DRAG_LINES_DEFAULT, normLineList } = store
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

test('normLineList（拖拽台词）：非数组回默认、逐条 trim 截断并去非串，全空也回默认', () => {
  // 非数组 / 全是脏项 → 回默认（不能让拖拽没词）
  assert.deepEqual(normLineList(null, DRAG_LINES_DEFAULT, 10), DRAG_LINES_DEFAULT)
  assert.deepEqual(normLineList(['  ', 42, null], DRAG_LINES_DEFAULT, 10), DRAG_LINES_DEFAULT)
  assert.deepEqual(normLineList('abc', DRAG_LINES_DEFAULT, 10), DRAG_LINES_DEFAULT)
  // 合法项 trim 后保留；条数压到上限
  assert.deepEqual(normLineList([' 甲 ', '乙'], DRAG_LINES_DEFAULT, 10), ['甲', '乙'])
  assert.equal(normLineList(Array.from({ length: 30 }, (_, i) => 'x' + i), DRAG_LINES_DEFAULT, 4).length, 4)
  // 默认值是一份拷贝：改返回值不能污染模块级默认（否则下次「恢复默认」就被带歪）
  const got = normLineList(null, DRAG_LINES_DEFAULT, 10)
  got.push('污染')
  assert.equal(DRAG_LINES_DEFAULT.includes('污染'), false)
})

test('QUOTE_TEXT_KEYS：报时四池（time / timeEarly / timeMorning / timeEve）+ gifFail 都在，且都能清洗回默认', () => {
  // 四池缺一都会让对应时段报时退回默认文案 —— 顺序即悬浮页 timeLabel 的选池依据
  assert.deepEqual(QUOTE_TEXT_KEYS, ['time', 'timeEarly', 'timeMorning', 'timeEve', 'gifFail'])
  // 缺省气泡的 system 每个池都得有非空默认文案（清空回默认，不能变成空数组，否则那一时段没词）
  const sys = normBubble({}, undefined).system
  for (const k of QUOTE_TEXT_KEYS) assert.ok(Array.isArray(sys[k]) && sys[k].length, `${k} 未回默认池`)
  for (const k of ['timeEarly', 'timeMorning', 'timeEve']) {
    assert.ok(normBubble({ system: { [k]: [] } }, undefined).system[k].length > 0, `${k} 清空后没回默认`)
  }
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

// ──────────────────────────────────────────────
// 按压气泡（config.bubble，上游式独立模型）—— 归一化
// ──────────────────────────────────────────────
const { normBubble, normBubbleMod, normBubbleModules, normBubbleStep, normBubbleLib, bubbleDefaultItems,
  BUBBLE_ROW_MAX, BUBBLE_MOD_MAX, BUBBLE_ITEM_MAX, BUBBLE_CHOICE_MAX,
  BUBBLE_DWELL_DFT, BUBBLE_DWELL_MIN, BUBBLE_DWELL_MAX, BUBBLE_DRAG_LINES_DFT } = store

test('normBubble：非对象（null/undefined/串）整份恢复默认形态，出口恒为稳定七键', () => {
  for (const bad of [null, undefined, 'x', 123, []]) {
    const out = normBubble(bad, undefined)
    assert.equal(out.v, 1)
    assert.equal(out.on, false) // 缺省总开关关：关 = 挂件不弹气泡
    assert.equal(out.tapAdvance, false)
    assert.equal(out.dwell, BUBBLE_DWELL_DFT)
    assert.deepEqual(out.lib, [])
    assert.deepEqual(out.dragLines, BUBBLE_DRAG_LINES_DFT)
    // system 是报时四池 + 动图降级的固定文案池，缺省必须回默认
    assert.ok(out.system && typeof out.system === 'object')
    // items 回出厂默认：至少有个非空的点击序列，不能是空数组
    assert.ok(Array.isArray(out.items) && out.items.length > 0)
  }
})

test('normBubble：on / tapAdvance 只认 === true，缺键时沿用现值', () => {
  assert.equal(normBubble({ on: true }, undefined).on, true)
  assert.equal(normBubble({ on: 'true' }, undefined).on, false) // 字符串不算真
  assert.equal(normBubble({ on: 1 }, undefined).on, false)
  // 已开 → 补丁不带 on 时保持开
  assert.equal(normBubble({ tapAdvance: true }, undefined).tapAdvance, true)
  assert.equal(normBubble({}, { on: true, tapAdvance: true }).on, true)
  assert.equal(normBubble({}, { on: true, tapAdvance: true }).tapAdvance, true)
  assert.equal(normBubble({ on: false }, { on: true }).on, false) // 显式关覆盖现值
})

test('normBubble：dwell 越界/非数值回默认，3–60 取整保留', () => {
  assert.equal(normBubble({ dwell: 9 }, undefined).dwell, 9)
  assert.equal(normBubble({ dwell: 9.6 }, undefined).dwell, 10)
  assert.equal(normBubble({ dwell: BUBBLE_DWELL_MIN - 1 }, undefined).dwell, BUBBLE_DWELL_DFT)
  assert.equal(normBubble({ dwell: BUBBLE_DWELL_MAX + 1 }, undefined).dwell, BUBBLE_DWELL_DFT)
  assert.equal(normBubble({ dwell: 'abc' }, undefined).dwell, BUBBLE_DWELL_DFT)
})

test('normBubble：items 非数组回默认序列；数组里无效步被丢；全空也回默认（挂件点下去不能没内容）', () => {
  const fromBad = normBubble({ items: 'nope' }, undefined)
  assert.ok(fromBad.items.length > 0)
  // [null, 无模块泡, 一个有内容的] —— 前两个丢，只剩一个
  const mixed = normBubble({ items: [null, { kind: 'custom', modules: [] }, { kind: 'custom', modules: [{ type: 'text', text: 'hi' }] }] }, undefined)
  assert.equal(mixed.items.length, 1)
  assert.equal(mixed.items[0].modules[0].text, 'hi')
  // 全无效 → 回默认
  assert.ok(normBubble({ items: [null, {}, 0] }, undefined).items.length > 0)
})

test('normBubbleItems 上限截断：超长序列截到 BUBBLE_ITEM_MAX（用实现导出的常量比较，写死数字会与实现脱钩）', () => {
  const many = []
  for (let i = 0; i < BUBBLE_ITEM_MAX + 8; i++) many.push({ kind: 'custom', modules: [{ type: 'text', text: 't' + i }] })
  assert.equal(normBubble({ items: many }, undefined).items.length, BUBBLE_ITEM_MAX)
})

test('normBubbleMod：认不出的 type 丢；空 text / 空 random 丢（同 normSeg 口径）', () => {
  assert.equal(normBubbleMod({ type: 'nope', text: 'x' }), null)
  assert.equal(normBubbleMod({ type: 'text', text: '   ' }), null)
  assert.equal(normBubbleMod({ type: 'random', lines: [] }), null)
  assert.equal(normBubbleMod({ type: 'link', url: '  ' }), null)
  assert.equal(normBubbleMod(null), null)
  // 认得出的 text 落 text 键并 trim
  const m = normBubbleMod({ type: 'text', text: '  嗨  ' })
  assert.equal(m.text, '嗨')
  assert.equal(m.type, 'text')
})

test('normBubbleMod：size 压到 1–50 取整，bold/italic/ul 只认 === true，rgb 只认 18 项白名单', () => {
  const m = normBubbleMod({ type: 'text', text: 'x', size: 999, bold: 1, italic: 'yes', ul: true, rgb: 'indigo' })
  assert.equal(m.size, 50) // 上界截断
  assert.equal(m.bold, undefined) // 1 不算真
  assert.equal(m.italic, undefined)
  assert.equal(m.ul, true)
  assert.equal(m.rgb, 'indigo')
  const bad = normBubbleMod({ type: 'text', text: 'x', rgb: 'rainbow', size: -5 })
  assert.equal(bad.rgb, undefined) // 不在白名单 → 摘键（不是空串）
  assert.equal(bad.size, 1) // 下界
})

test('normBubbleMod：peak 样式白名单默认 text，peak/off 色与 rgb 都清洗', () => {
  const m = normBubbleMod({ type: 'peak', peakStyle: 'nope', peakColor: '#fff', offRgb: 'bamboo', peakRgb: 'zzz' })
  assert.equal(m.peakStyle, 'text') // 认不出回 text
  assert.equal(m.peakColor, '#fff')
  assert.equal(m.offRgb, 'bamboo')
  assert.equal(m.peakRgb, '') // 非法方案归 ''（peak 的颜色字段是**无条件赋值**，与其余字段的「非法摘键」口径不同）
  assert.equal(normBubbleMod({ type: 'peak', peakStyle: 'count' }).peakStyle, 'count')
})

test('normBubbleMod：session 模板兜底 {session}，len 压 0–40；plan 窗口白名单默认 all', () => {
  const s = normBubbleMod({ type: 'session' })
  assert.equal(s.tpl, '{session}')
  assert.equal(normBubbleMod({ type: 'session', len: 8 }).len, 8)
  assert.equal(normBubbleMod({ type: 'session', len: 999 }).len, undefined) // 越界摘键
  const p = normBubbleMod({ type: 'plan', planWin: 'nope', modelId: ' m1 ' })
  assert.equal(p.planWin, 'all')
  assert.equal(p.modelId, 'm1')
})

test('normBubbleModules：row 键重建 —— 相邻同 row 归一行（写 row=行号+1），单模块行删键', () => {
  const flat = normBubbleModules([
    { type: 'text', text: 'a', row: 2 },
    { type: 'text', text: 'b', row: 2 }, // 与上一条同 row → 同一行
    { type: 'text', text: 'c' }, // 无 row → 自成单模块行
  ])
  assert.equal(flat.length, 3)
  assert.equal(flat[0].row, 1) // 第一逻辑行 → row = 0 + 1
  assert.equal(flat[1].row, 1)
  assert.equal(flat[2].row, undefined) // 单模块行不写 row 键
})

test('normBubbleModules：图片类（image/randimg）独占一行并打断合并', () => {
  const flat = normBubbleModules([
    { type: 'text', text: 'a', row: 1 },
    { type: 'image', imgId: 'x.png', row: 1 }, // 图片强制单行，且打断上面的合并
    { type: 'text', text: 'b', row: 1 },
  ])
  assert.equal(flat[1].type, 'image')
  assert.equal(flat[1].row, undefined) // 图片行不写 row
  // 图片前后的 text 各自成单模块行（row 键都不保留）
  assert.equal(flat[0].row, undefined)
  assert.equal(flat[2].row, undefined)
})

test('normBubbleModules：行数 / 每行模块数双双截断（常量比较）', () => {
  // 每行 6 个模块、造 BUBBLE_ROW_MAX + 3 行 → 行数截到上限
  const mods = []
  for (let r = 0; r < BUBBLE_ROW_MAX + 3; r++) {
    for (let c = 0; c < BUBBLE_MOD_MAX + 2; c++) mods.push({ type: 'text', text: 'r' + r + 'c' + c, row: r + 1 })
  }
  const flat = normBubbleModules(mods)
  assert.equal(flat.length, BUBBLE_ROW_MAX * BUBBLE_MOD_MAX)
  // 同一逻辑行内最多 BUBBLE_MOD_MAX 个
  const firstRow = flat.filter((m) => m.row === 1)
  assert.equal(firstRow.length, BUBBLE_MOD_MAX)
})

test('normBubbleModules：非数组回空数组；脏 row 值（0 / 越界 / 非数）不当行键', () => {
  assert.deepEqual(normBubbleModules('x'), [])
  // row = 0 / 99 都超出 1–6，被摘成「无 row」，各成单模块行
  const flat = normBubbleModules([
    { type: 'text', text: 'a', row: 0 },
    { type: 'text', text: 'b', row: 99 },
  ])
  assert.equal(flat.length, 2)
  assert.equal(flat[0].row, undefined)
  assert.equal(flat[1].row, undefined)
})

test('normBubbleStep：并列泡只剩 1 个候选降级为单选，0 个候选丢该步', () => {
  const one = normBubbleStep({ kind: 'choice', options: [{ item: { kind: 'custom', modules: [{ type: 'text', text: 'a' }] } }] })
  assert.equal(one.kind, 'custom') // 降级成单选（item 形态）
  assert.ok(Array.isArray(one.modules))
  assert.equal(normBubbleStep({ kind: 'choice', options: [] }), null)
  assert.equal(normBubbleStep({ kind: 'choice', options: [null, {}] }), null)
  // 两个有效候选 → 保持 choice，w 2–99 才落键（=1 摘键）
  const two = normBubbleStep({ kind: 'choice', options: [
    { w: 10, item: { kind: 'custom', modules: [{ type: 'text', text: 'a' }] } },
    { w: 1, item: { kind: 'custom', modules: [{ type: 'text', text: 'b' }] } },
  ] })
  assert.equal(two.kind, 'choice')
  assert.equal(two.options.length, BUBBLE_CHOICE_MAX)
  assert.equal(two.options[0].w, 10)
  assert.equal(two.options[1].w, undefined) // =1 摘键
})

test('normBubbleLib：无效 module 丢该条；name 空则「模块N」，超长截 20；id 缺失自动补', () => {
  const lib = normBubbleLib([
    { id: 'k1', name: '好康', module: { type: 'text', text: 'x' } },
    { name: '', module: { type: 'text', text: 'y' } }, // 缺 id + 空 name
    { id: 'k2', module: { type: 'nope' } }, // 无效 module → 丢
    null,
  ])
  assert.equal(lib.length, 2)
  assert.equal(lib[0].id, 'k1')
  assert.equal(lib[0].name, '好康')
  assert.ok(lib[1].id && lib[1].id.length > 0) // 自动补 id
  assert.equal(lib[1].name, '模块2') // 「模块N」按输出序号
  assert.deepEqual(normBubbleLib('x'), [])
})

test('normBubble 幂等：一次归一的出口再喂进去不变形（patchConfig 部分更新靠它）', () => {
  const once = normBubble({ on: true, items: bubbleDefaultItems(), tapAdvance: true, dwell: 12, dragLines: ['一条'] }, undefined)
  const twice = normBubble(JSON.parse(JSON.stringify(once)), once)
  assert.deepEqual(twice, once)
})
