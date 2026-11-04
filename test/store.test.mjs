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
import os from 'node:os'
import { createRequire } from 'node:module'
import store from '../public/preload/lib/store.js'
import constants from '../public/preload/lib/constants.js'

// ── utools 桩：账本 / 计时 / 模型状态 / 锚点走 utools.dbStorage（属性访问）。
//    默认导入只在纯函数上用到；下面这族函数虽同属一个模块，但 store.js 全程用属性访问
//    utools.dbStorage，所以挂个全局内存桩即可，不必重载模块（与 config.test.mjs 同范式）──
const db = new Map()
globalThis.utools = {
  getPath: () => os.tmpdir(), // log.js 取临时目录，避免落到真实 %TEMP%
  dbStorage: {
    getItem: (k) => (db.has(k) ? db.get(k) : null),
    setItem: (k, v) => { db.set(k, v) },
    removeItem: (k) => { db.delete(k) },
  },
}
const require = createRequire(import.meta.url)
const { K } = require('../public/preload/lib/constants.js')

const { normTokenPrice, normUiMode, normTheme, normBgMode, QUOTE_TEXT_KEYS, DRAG_LINES_DEFAULT, normLineList, defaultConfig, patchConfig } = store
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

test('normUiMode 只认 auto/light/dark/fantasy，其余（含缺省与非法）一律回 auto', () => {
  assert.equal(normUiMode('light'), 'light')
  assert.equal(normUiMode('dark'), 'dark')
  assert.equal(normUiMode('fantasy'), 'fantasy')
  assert.equal(normUiMode('auto'), 'auto')
  assert.equal(normUiMode(undefined), 'auto')
  assert.equal(normUiMode(null), 'auto')
  assert.equal(normUiMode(''), 'auto')
  // 非法值不做就近猜测：配坏了顶多回默认行为（跟 uTools），不会莫名其妙变成另一个手动档
  assert.equal(normUiMode('Light'), 'auto')
  assert.equal(normUiMode('Fantasy'), 'auto')
  assert.equal(normUiMode('system'), 'auto')
  assert.equal(normUiMode(123), 'auto')
})

test('normBgMode 只认 off/deep/aurora/video/custom，其余回 off', () => {
  assert.equal(normBgMode('off'), 'off')
  assert.equal(normBgMode('deep'), 'deep')
  assert.equal(normBgMode('aurora'), 'aurora')
  assert.equal(normBgMode('stars'), 'stars')
  assert.equal(normBgMode('mist'), 'mist')
  assert.equal(normBgMode('polar'), 'polar')
  assert.equal(normBgMode('warm'), 'warm')
  assert.equal(normBgMode('video'), 'video')
  assert.equal(normBgMode('custom'), 'custom')
  for (const bad of [undefined, null, '', 'Deep', 'light', 123]) {
    assert.equal(normBgMode(bad), 'off')
  }
})

test('启动片头默认关闭，patch 只认 true，非法值回 false', () => {
  db.delete(K.config)
  assert.equal(defaultConfig().bootIntroOn, false)
  assert.equal(patchConfig({ bootIntroOn: true }).bootIntroOn, true)
  assert.equal(patchConfig({ bootIntroOn: 'yes' }).bootIntroOn, false)
  assert.equal(patchConfig({ bootIntroOn: 1 }).bootIntroOn, false)
})

test('normTheme 只认 default/dark/sakura/fantasy，其余回 default', () => {
  assert.equal(normTheme('default'), 'default')
  assert.equal(normTheme('dark'), 'dark')
  assert.equal(normTheme('sakura'), 'sakura')
  assert.equal(normTheme('fantasy'), 'fantasy')
  for (const bad of [undefined, null, '', 'Fantasy', 'light', 123]) {
    assert.equal(normTheme(bad), 'default')
  }
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
  // 认得出的 text 落 text 键，且**保留原串**（不 trim）：设置页逐键回抛，trim 会把刚敲的
  // 尾部空格吃掉，「hello world」永远打不出空格；纯空白仍按空内容丢掉（上一行已断言）
  const m = normBubbleMod({ type: 'text', text: '  嗨  ' })
  assert.equal(m.text, '  嗨  ')
  assert.equal(m.type, 'text')
  // link：地址照旧 trim；显示文字保留原串，纯空白存空串（渲染侧回落成链接本身）
  const lk = normBubbleMod({ type: 'link', url: '  https://a.b  ', text: ' 点 我 ' })
  assert.equal(lk.url, 'https://a.b')
  assert.equal(lk.text, ' 点 我 ')
  assert.equal(normBubbleMod({ type: 'link', url: 'https://a.b', text: '   ' }).text, '')
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

// ──────────────────────────────────────────────
// 账本（recordLedgerUsage / calibrateTodayUsage / claimDailyNotice / mergeLedgerHistory / setTodayUsage）
// ──────────────────────────────────────────────
const {
  todayKey, historyKeepDays, readLedger, recordLedgerUsage, calibrateTodayUsage, claimDailyNotice,
  keyFingerprint, mergeLedgerHistory, setTodayUsage, readTimer, writeTimer, clearTimer,
  readModelState, writeModelState, dropModelState, readAnchor, writeAnchor, resetAnchorCache,
  DSB_KEEP_MIN, DSB_KEEP_MAX,
} = store

const clearLedger = () => db.delete(K.ledger)
const clearCfg = () => db.delete(K.config)

test('todayKey 是本地日期 YYYY-MM-DD 且与 Date 同步', () => {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  assert.equal(todayKey(), `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`)
})

test('historyKeepDays：直接读原始配置并夹取到 35–730，非法回默认 365', () => {
  clearCfg()
  assert.equal(historyKeepDays(), 365) // 空配置回默认
  db.set(K.config, { historyKeepDays: 10 }); assert.equal(historyKeepDays(), 35) // 下夹
  db.set(K.config, { historyKeepDays: 9999 }); assert.equal(historyKeepDays(), 730) // 上夹
  db.set(K.config, { historyKeepDays: 400 }); assert.equal(historyKeepDays(), 400)
  db.set(K.config, { historyKeepDays: 'abc' }); assert.equal(historyKeepDays(), 365)
  db.set(K.config, { historyKeepDays: 400.6 }); assert.equal(historyKeepDays(), 401) // 取整
  clearCfg()
})

test('keyFingerprint：空串回空、非空为 sha1 前 8 位且稳定可复现', () => {
  assert.equal(keyFingerprint(''), '')
  assert.equal(keyFingerprint(null), '')
  const fp = keyFingerprint('sk-abcdef0123456789')
  assert.match(fp, /^[0-9a-f]{8}$/)
  assert.equal(fp, keyFingerprint('sk-abcdef0123456789')) // 同 key 同指纹
  assert.notEqual(fp, keyFingerprint('sk-abcdef0123456790')) // 换 key 换指纹
})

test('readLedger：空存储回 freshLedger（全零基线）', () => {
  clearLedger()
  const led = readLedger()
  assert.equal(led.date, todayKey())
  assert.equal(led.lastBalance, null)
  assert.equal(led.todayUsage, 0)
  assert.deepEqual(led.history, {})
  assert.equal(led.quotaUsed, 0)
  assert.deepEqual(led.adjustLog, [])
  assert.deepEqual(led.calibrateLog, [])
  assert.equal(led.budgetNotifiedOn, '')
  assert.equal(led.lowNotifiedOn, '')
})

test('readLedger：老账本缺 quotaUsed 时用 history 之和做起点（避免「不重置」累计小于本月累计）', () => {
  clearLedger()
  db.set(K.ledger, { date: todayKey(), history: { '2026-01-01': 1.5, '2026-01-02': 2.5 }, todayUsage: 0.1 })
  const led = readLedger()
  assert.equal(led.quotaUsed, 4) // 1.5 + 2.5
})

test('recordLedgerUsage：首次采样只落基准，不计用量', () => {
  clearLedger()
  const { ledger, adjust, drop } = recordLedgerUsage(100, 'CNY', { granted: 10, toppedUp: 5, keyId: 'kA' })
  assert.equal(ledger.lastBalance, 100)
  assert.equal(ledger.todayUsage, 0)
  assert.equal(adjust, null)
  assert.equal(drop, 0)
  assert.equal(ledger.lastGranted, 10)
  assert.equal(ledger.lastToppedUp, 5)
  assert.equal(ledger.lastKeyId, 'kA')
  assert.ok(ledger.lastSampleAt) // 采样时间已写
})

test('recordLedgerUsage：余额正常下降计入 todayUsage，drop 反映本轮下降总额', () => {
  clearLedger()
  recordLedgerUsage(100, 'CNY', {})
  const { ledger, adjust, drop } = recordLedgerUsage(97.5, 'CNY', {})
  assert.equal(ledger.todayUsage, 2.5)
  assert.equal(adjust, null)
  assert.equal(drop, 2.5)
  // 继续累加
  const r2 = recordLedgerUsage(97, 'CNY', {})
  assert.equal(r2.ledger.todayUsage, 3)
  assert.equal(r2.drop, 0.5)
})

test('recordLedgerUsage：跨天归档（写 history + quotaUsed 累计 + 清零当日），当天差值与历史互不干扰', () => {
  clearCfg()
  clearLedger()
  db.set(K.config, { historyKeepDays: 35 })
  // 老账本停在 2020-01-01：当天用量 8、quotaUsed 12。跨天时先把 8 归档进 history 并并入 quotaUsed
  db.set(K.ledger, { date: '2020-01-01', todayUsage: 8, quotaUsed: 12, history: {}, lastBalance: 100, lastCurrency: 'CNY' })
  const r = recordLedgerUsage(100, 'CNY', {}) // 换天首采样：只重置基准
  assert.equal(r.ledger.date, todayKey(), '应切到今天')
  assert.equal(r.ledger.history['2020-01-01'], 8, '跨天应把前一天用量归档进 history')
  assert.equal(r.ledger.quotaUsed, 20, '跨天应把昨天用量并入「不重置」累计（12 + 8）')
  assert.equal(r.ledger.todayUsage, 0, '跨天后今日用量归零')
  // 当天再下降 3 → 只进 todayUsage，不污染历史
  const r2 = recordLedgerUsage(97, 'CNY', {})
  assert.equal(r2.ledger.todayUsage, 3)
  assert.equal(r2.ledger.history['2020-01-01'], 8)
  clearCfg()
})

test('recordLedgerUsage：换币种只重置基准，不把两边差额记成用量', () => {
  clearLedger()
  recordLedgerUsage(100, 'USD', {})
  const { ledger, adjust, drop } = recordLedgerUsage(20, 'CNY', {}) // 20 远小于 100，若不识别换币种会被误记 80
  assert.equal(ledger.todayUsage, 0)
  assert.equal(drop, 0)
  assert.equal(adjust, null)
  assert.equal(ledger.lastBalance, 20)
  assert.equal(ledger.lastCurrency, 'CNY')
})

test('recordLedgerUsage：换 Key 只重置基准，不把两边余额差记成用量', () => {
  clearLedger()
  recordLedgerUsage(100, 'CNY', { keyId: 'kA' })
  const { ledger, drop } = recordLedgerUsage(30, 'CNY', { keyId: 'kB' })
  assert.equal(ledger.todayUsage, 0)
  assert.equal(drop, 0)
  assert.equal(ledger.lastBalance, 30)
  assert.equal(ledger.lastKeyId, 'kB')
})

test('recordLedgerUsage：赠送额度整块到期/被收回 → 进 adjustLog 与 todayAdjust，不计今日用量', () => {
  clearLedger()
  // 余额 500 里含赠送 271；赠送整块消失后余额骤降到 229
  recordLedgerUsage(500, 'CNY', { granted: 271 })
  const { ledger, adjust, drop } = recordLedgerUsage(229, 'CNY', { granted: 0 })
  assert.equal(ledger.todayUsage, 0, '赠送到期不能被记成用量')
  assert.ok(adjust && adjust.why === '赠送额度到期/被收回')
  assert.equal(adjust.amount, 271)
  assert.equal(drop, 271, 'drop 仍反映本轮下降总额（宿主据此做波动通知）')
  assert.equal(ledger.todayAdjust, 271)
  assert.equal(ledger.adjustLog.length, 1)
  assert.equal(ledger.adjustLog[0].why, '赠送额度到期/被收回')
  assert.equal(ledger.lastAdjustWhy, '赠送额度到期/被收回')
})

test('recordLedgerUsage：短时间超过可信上限的大跳变 → 计入 adjust 而非用量', () => {
  clearLedger()
  recordLedgerUsage(1000, 'CNY', {})
  const { ledger, adjust } = recordLedgerUsage(900, 'CNY', {}) // 一分钟内掉 100 > limit(20)
  assert.equal(ledger.todayUsage, 0)
  assert.ok(adjust && adjust.why === '余额下降超过可信上限')
  assert.equal(adjust.amount, 100)
  assert.equal(ledger.todayAdjust, 100)
})

test('recordLedgerUsage：赠送额度只掉一部分（未整块消失）仍算正常消费', () => {
  clearLedger()
  recordLedgerUsage(500, 'CNY', { granted: 271 })
  // 只掉 3 元，赠送还剩 268（未整块消失）→ 属正常消费
  const { ledger, adjust } = recordLedgerUsage(497, 'CNY', { granted: 268 })
  assert.equal(adjust, null)
  assert.equal(ledger.todayUsage, 3)
})

test('recordLedgerUsage：余额未下降（持平或上升）不记任何差值', () => {
  clearLedger()
  recordLedgerUsage(100, 'CNY', {})
  const up = recordLedgerUsage(120, 'CNY', {}) // 充值/赠送使余额上升
  assert.equal(up.ledger.todayUsage, 0)
  assert.equal(up.drop, 0)
  assert.equal(up.ledger.lastBalance, 120)
  const same = recordLedgerUsage(120, 'CNY', {})
  assert.equal(same.ledger.todayUsage, 0)
})

test('recordLedgerUsage：写账本失败时不抛错（只 logErr 留痕）', () => {
  clearLedger()
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota') }
  try {
    assert.doesNotThrow(() => recordLedgerUsage(100, 'CNY', {}))
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
})

test('calibrateTodayUsage：非法 / 负数拒绝，等于现值不写，正常值写入并记 calibrateLog', () => {
  clearLedger()
  assert.equal(calibrateTodayUsage('abc').ok, false)
  assert.equal(calibrateTodayUsage(-1).ok, false)
  assert.match(calibrateTodayUsage(NaN).error, /不小于 0/)
  // 等于现值 → 不写、不记 log
  const r0 = calibrateTodayUsage(0)
  assert.deepEqual([r0.ok, r0.from, r0.to], [true, 0, 0])
  assert.equal(readLedger().calibrateLog.length, 0)
  // 改值 → 写入 + 记一条
  const r1 = calibrateTodayUsage(12.34567)
  assert.deepEqual([r1.ok, r1.from, r1.to], [true, 0, 12.3457]) // round4
  assert.equal(readLedger().todayUsage, 12.3457)
  assert.equal(readLedger().calibrateLog.length, 1)
  assert.equal(readLedger().calibrateLog[0].from, 0)
})

test('calibrateTodayUsage：写失败返回 ok:false 且带错误文案', () => {
  clearLedger()
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota') }
  try {
    const r = calibrateTodayUsage(5)
    assert.equal(r.ok, false)
    assert.match(r.error, /校准写入失败/)
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
})

test('claimDailyNotice：预算 / 低余额两类各自每天一次，跨天重置，kind 非法回落到 budget', () => {
  clearLedger()
  assert.equal(claimDailyNotice('budget'), true) // 首次认领
  assert.equal(claimDailyNotice('budget'), false) // 同日再调被拒
  assert.equal(claimDailyNotice('low'), true) // 另一类互不影响
  assert.equal(claimDailyNotice('low'), false)
  assert.equal(readLedger().budgetNotifiedOn, todayKey())
  assert.equal(readLedger().lowNotifiedOn, todayKey())
  // kind 非法 → 走 budget 分支（已被认领 → false）
  assert.equal(claimDailyNotice('bogus'), false)
  // 跨天：把标记改成昨天 → 可再次认领
  const led = readLedger()
  led.budgetNotifiedOn = '2000-01-01'
  db.set(K.ledger, led)
  assert.equal(claimDailyNotice('budget'), true)
})

test('mergeLedgerHistory：同日覆盖、当天天同步 todayUsage、按保留天数裁剪、返回计数', () => {
  clearCfg()
  clearLedger()
  db.set(K.config, { historyKeepDays: 35 })
  const t = todayKey()
  const r = mergeLedgerHistory([
    { date: '2020-01-01', usage: 1.5 },
    { date: '2020-01-01', usage: 2.5 }, // 同日覆盖前值
    { date: t, usage: 9 }, // 当天 → 同步 todayUsage
    { date: '2020-01-02', usage: 'abc' }, // 非法 usage 丢
    { usage: 5 }, // 无 date 丢
  ])
  assert.equal(r.imported, 3)
  assert.equal(r.ok, true)
  const led = readLedger()
  assert.equal(led.history['2020-01-01'], 2.5)
  assert.equal(led.history[t], 9)
  assert.equal(led.todayUsage, 9, '当天天必须同步进 todayUsage，否则趋势图当天柱被忽略')
  assert.equal(r.from, '2020-01-01')
})

test('mergeLedgerHistory：按保留天数裁剪，只留最近 keep 天', () => {
  clearCfg()
  clearLedger()
  db.set(K.config, { historyKeepDays: 35 }) // 最小保留期
  const entries = []
  for (let i = 0; i < 40; i++) entries.push({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, usage: i })
  const r = mergeLedgerHistory(entries)
  assert.equal(r.kept, 35, '应只保留最近 35 天')
  const keys = Object.keys(readLedger().history).sort()
  assert.equal(keys[0], '2020-01-06') // 前 5 天被裁掉
  assert.equal(keys[keys.length - 1], '2020-01-40')
  clearCfg()
})

test('mergeLedgerHistory：写失败返回 ok:false', () => {
  clearLedger()
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota') }
  try {
    assert.equal(mergeLedgerHistory([{ date: '2020-01-01', usage: 1 }]).ok, false)
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
})

test('setTodayUsage：直接覆盖当天用量、负数/非法夹到 0、返回账本', () => {
  clearLedger()
  assert.equal(setTodayUsage(7.5).todayUsage, 7.5)
  assert.equal(readLedger().todayUsage, 7.5)
  assert.equal(setTodayUsage(-3).todayUsage, 0)
  assert.equal(setTodayUsage('abc').todayUsage, 0)
})

// ──────────────────────────────────────────────
// 计时状态
// ──────────────────────────────────────────────
test('readTimer：空存储 / 非对象回默认（mode off）', () => {
  db.delete(K.timer)
  const d = readTimer()
  assert.deepEqual(d, { mode: 'off', running: false, paused: false, startAt: 0, endAt: 0, elapsed: 0, remain: 0, arg: '', isBreak: false, back: 0, cycle: 0, cycleDate: '', span: 0 })
})

test('readTimer：逐字段归一化 —— mode 白名单、布尔严格、数值钳负、arg 只认串', () => {
  db.set(K.timer, { mode: 'bogus', running: 1, paused: 'yes', startAt: 'abc', endAt: '123', elapsed: -5, remain: '9', arg: 42, isBreak: 1, back: -5, cycle: -3, cycleDate: 'not-a-date', span: -1 })
  const t = readTimer()
  assert.equal(t.mode, 'off') // 认不出回 off
  assert.equal(t.running, false) // 1 不算 true
  assert.equal(t.paused, false)
  assert.equal(t.startAt, 0) // 非数值回 0
  assert.equal(t.endAt, 123)
  assert.equal(t.elapsed, 0) // 负值钳到 0
  assert.equal(t.remain, 9)
  assert.equal(t.arg, '') // 非串回空
  assert.equal(t.isBreak, false) // 只认严格 true
  assert.equal(t.back, 0) // 负值钳到 0
  assert.equal(t.cycle, 0) // 负值钳到 0
  assert.equal(t.cycleDate, '') // 格式不对回空
  assert.equal(t.span, 0) // 负跨度钳到 0
  db.set(K.timer, { mode: 'down', isBreak: true, back: '9', cycle: 3, cycleDate: '2026-10-28', span: '7200000' })
  assert.equal(readTimer().isBreak, true)
  assert.equal(readTimer().back, 9) // 数字串可解析
  assert.equal(readTimer().cycle, 3)
  assert.equal(readTimer().cycleDate, '2026-10-28')
  assert.equal(readTimer().span, 7200000) // 数字串可解析，定时跨度保留
  // 合法 mode 保留
  db.set(K.timer, { mode: 'down' })
  assert.equal(readTimer().mode, 'down')
  db.set(K.timer, { mode: 'up' })
  assert.equal(readTimer().mode, 'up')
  db.set(K.timer, { mode: 'at' })
  assert.equal(readTimer().mode, 'at')
  db.delete(K.timer)
})

test('writeTimer：落盘成功回 true 且可回读；失败回 false 不抛', () => {
  db.delete(K.timer)
  const state = { mode: 'up', running: true, paused: false, startAt: 1000, endAt: 0, elapsed: 5, remain: 0, arg: 'x', isBreak: true, back: 1500, cycle: 2, cycleDate: '2026-10-28', span: 0 }
  assert.equal(writeTimer(state), true)
  assert.deepEqual(readTimer(), state)
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota') }
  try {
    assert.equal(writeTimer(state), false)
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
  db.delete(K.timer)
})

test('clearTimer：删除计时状态，回读到默认', () => {
  writeTimer({ mode: 'down', running: true })
  clearTimer()
  assert.equal(readTimer().mode, 'off')
  assert.doesNotThrow(() => clearTimer()) // 重复清除不抛
})

// ──────────────────────────────────────────────
// 多厂商模型的运行时状态
// ──────────────────────────────────────────────
test('readModelState：空存储 / 非对象回 {}；对象原样返回', () => {
  db.delete(K.models)
  assert.deepEqual(readModelState(), {})
  db.set(K.models, { m1: { balance: 10 } })
  assert.deepEqual(readModelState(), { m1: { balance: 10 } })
  db.set(K.models, 'nope')
  assert.deepEqual(readModelState(), {})
  db.delete(K.models)
})

test('writeModelState：落盘可回读，非对象写 {}，失败不抛', () => {
  db.delete(K.models)
  writeModelState({ m1: { at: 1 } })
  assert.deepEqual(readModelState(), { m1: { at: 1 } })
  writeModelState(null)
  assert.deepEqual(readModelState(), {})
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota') }
  try {
    assert.doesNotThrow(() => writeModelState({ m1: {} }))
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
  db.delete(K.models)
})

test('dropModelState：删除指定模型状态，不存在的 id 不写盘', () => {
  db.delete(K.models)
  writeModelState({ m1: { at: 1 }, m2: { at: 2 } })
  dropModelState('m1')
  assert.deepEqual(readModelState(), { m2: { at: 2 } })
  // 不存在 → 不动（用写次数保证没多余 setItem）
  let writes = 0
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = (k, v) => { writes++; saved(k, v) }
  try {
    dropModelState('nope')
    assert.equal(writes, 0)
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
  db.delete(K.models)
})

// ──────────────────────────────────────────────
// 窗口锚点
// ──────────────────────────────────────────────
test('readAnchor：空存储回默认锚点（右下、距离 0）', () => {
  resetAnchorCache()
  db.delete(K.win)
  assert.deepEqual(readAnchor(), { hAnchor: 'right', hDist: 0, vAnchor: 'bottom', vDist: 0 })
})

test('readAnchor：合法锚点取整并钳到非负；非法结构回落默认', () => {
  resetAnchorCache()
  db.set(K.win, { hAnchor: 'left', hDist: 12.6, vAnchor: 'top', vDist: -3 })
  const a = readAnchor()
  assert.equal(a.hAnchor, 'left')
  assert.equal(a.hDist, 13) // 四舍五入
  assert.equal(a.vAnchor, 'top')
  assert.equal(a.vDist, 0) // 负值钳到 0
  // 非法 hAnchor → 整份回落默认
  resetAnchorCache()
  db.set(K.win, { hAnchor: 'middle', hDist: 5, vAnchor: 'top', vDist: 5 })
  assert.deepEqual(readAnchor(), { hAnchor: 'right', hDist: 0, vAnchor: 'bottom', vDist: 0 })
  // 非数值 hDist → 回落
  resetAnchorCache()
  db.set(K.win, { hAnchor: 'left', hDist: 'x', vAnchor: 'top', vDist: 5 })
  assert.deepEqual(readAnchor(), { hAnchor: 'right', hDist: 0, vAnchor: 'bottom', vDist: 0 })
  db.delete(K.win)
  resetAnchorCache()
})

test('readAnchor：内存缓存 —— 命中后不再读存储，resetAnchorCache 后重新读', () => {
  resetAnchorCache()
  db.set(K.win, { hAnchor: 'left', hDist: 1, vAnchor: 'top', vDist: 2 })
  const first = readAnchor()
  // 绕过 store 直接改存储，缓存应在，不反映新值
  db.set(K.win, { hAnchor: 'right', hDist: 9, vAnchor: 'bottom', vDist: 9 })
  assert.deepEqual(readAnchor(), first, '缓存命中时不应重新读存储')
  resetAnchorCache()
  assert.equal(readAnchor().hDist, 9, '清缓存后应重新读存储')
  db.delete(K.win)
  resetAnchorCache()
})

test('writeAnchor：同时更新内存缓存与存储，成功回 true；失败回 false', () => {
  resetAnchorCache()
  db.delete(K.win)
  const a = { hAnchor: 'left', hDist: 7, vAnchor: 'top', vDist: 8 }
  assert.equal(writeAnchor(a), true)
  assert.deepEqual(readAnchor(), a) // 缓存与传入一致
  assert.deepEqual(db.get(K.win), a) // 已落盘
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota') }
  try {
    assert.equal(writeAnchor({ hAnchor: 'right', hDist: 0, vAnchor: 'bottom', vDist: 0 }), false)
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
  db.delete(K.win)
  resetAnchorCache()
})

// ──────────────────────────────────────────────
// 待办清单 / 专注统计（读写归一化）
// ──────────────────────────────────────────────
const {
  readTodo, writeTodo, clearTodo, normTodoText,
  readFocus, writeFocus, clearFocus, syncTodoRounds,
} = store
const { TODO_TEXT_MAX, TODO_MAX } = constants

test('normTodoText：折叠连续空白、trim、截到 TODO_TEXT_MAX', () => {
  assert.equal(normTodoText('  写 \n\t 周报  '), '写 周报')
  assert.equal(normTodoText(null), '')
  assert.equal(normTodoText(42), '42')
  assert.equal(normTodoText('x'.repeat(TODO_TEXT_MAX + 20)).length, TODO_TEXT_MAX)
})

test('readTodo：空存储 / 非对象回空清单（focusId 为空）', () => {
  db.delete(K.todo)
  assert.deepEqual(readTodo(), { items: [], focusId: '' })
  db.set(K.todo, 'nope')
  assert.deepEqual(readTodo(), { items: [], focusId: '' })
  db.delete(K.todo)
})

test('readTodo：无文案 / 无 id / 非对象的条目丢弃，重复 id 只留第一条', () => {
  db.set(K.todo, {
    items: [
      { id: 'a', text: '  写周报  ', at: 1000 },
      { id: 'a', text: '重复 id 应被丢', at: 2000 },
      { id: 'b', text: '   ' }, // 空文案
      { text: '缺 id' },
      null,
      { id: 'c', text: '泡咖啡' },
    ],
  })
  const s = readTodo()
  assert.equal(s.items.length, 2)
  assert.equal(s.items[0].text, '写周报')
  assert.equal(s.items[0].id, 'a')
  assert.equal(s.items[1].id, 'c')
  db.delete(K.todo)
})

test('readTodo：at 缺失回落到当前时间；done 只认 === true；doneAt 仅在已完成时保留；est/rounds 钳到 0–99；tm/mins 有默认', () => {
  const before = Date.now()
  db.set(K.todo, {
    items: [
      { id: 'a', text: '没时间戳', at: 'abc' },
      { id: 'b', text: '已完成', done: true, at: 1000, doneAt: 2000 },
      { id: 'c', text: '未完成却带 doneAt', done: 1, at: 1000, doneAt: 2000 },
      { id: 'd', text: '带预估', at: 1000, est: 5, rounds: 3, tm: 'up', mins: 30 },
      { id: 'e', text: '越界预估', at: 1000, est: -1, rounds: 999, tm: 'nope', mins: 9999 },
    ],
  })
  const s = readTodo()
  const a = s.items.find((x) => x.id === 'a')
  assert.ok(a.at >= before && a.at <= Date.now(), 'at 应回落到当前时间')
  assert.equal(a.est, 0, '缺省 est 回 0')
  assert.equal(a.rounds, 0, '缺省 rounds 回 0')
  assert.deepEqual([a.tm, a.mins], ['down', 25], '缺省计时方式按「倒计时 25 分钟」')
  const b = s.items.find((x) => x.id === 'b')
  assert.deepEqual([b.done, b.at, b.doneAt], [true, 1000, 2000])
  const c = s.items.find((x) => x.id === 'c')
  assert.deepEqual([c.done, c.doneAt], [false, 0], '1 不算完成，doneAt 归零')
  const d = s.items.find((x) => x.id === 'd')
  assert.deepEqual([d.est, d.rounds], [5, 3], '合法值保留')
  assert.deepEqual([d.tm, d.mins], ['up', 30], '合法计时参数保留')
  const e = s.items.find((x) => x.id === 'e')
  assert.deepEqual([e.est, e.rounds], [0, 99], '越界值钳到 0–99')
  assert.deepEqual([e.tm, e.mins], ['down', 600], '非法 tm 回落 down，mins 钳到 1–600')
  db.delete(K.todo)
})

test('readTodo：条数截到 TODO_MAX（顺序保持存储内顺序）', () => {
  const items = []
  for (let i = 0; i < TODO_MAX + 5; i++) items.push({ id: 'i' + i, text: 't' + i, at: 1 })
  db.set(K.todo, { items })
  const s = readTodo()
  assert.equal(s.items.length, TODO_MAX)
  assert.equal(s.items[0].id, 'i0')
  assert.equal(s.items[TODO_MAX - 1].id, 'i' + (TODO_MAX - 1))
  db.delete(K.todo)
})

test('readTodo：focusId 必须指向「未完成的现存条目」，悬空 / 已完成 / 空白一律清空', () => {
  db.set(K.todo, { items: [{ id: 'a', text: '任务', at: 1 }, { id: 'b', text: '已做', done: true, at: 1 }], focusId: 'a' })
  assert.equal(readTodo().focusId, 'a')
  db.set(K.todo, { items: [{ id: 'a', text: '任务', at: 1 }], focusId: ' nope ' })
  assert.equal(readTodo().focusId, '', '悬空指针要清空')
  db.set(K.todo, { items: [{ id: 'b', text: '已做', done: true, at: 1 }], focusId: 'b' })
  assert.equal(readTodo().focusId, '', '已完成条目不能当专注目标')
  db.set(K.todo, { items: [{ id: 'a', text: '任务', at: 1 }], focusId: '  a  ' })
  assert.equal(readTodo().focusId, 'a', 'id 两端空白应被裁掉后命中')
  db.delete(K.todo)
})

test('writeTodo：落盘成功回 true 且可回读；失败回 false 不抛', () => {
  db.delete(K.todo)
  const state = { items: [{ id: 'a', text: '任务', done: false, at: 1, doneAt: 0, est: 4, rounds: 2, tm: 'down', mins: 25, remindOn: false, remindKind: 'once', remindAt: 0, remindDow: 0, remindedFor: 0, notifiedFor: 0 }], focusId: 'a' }
  assert.equal(writeTodo(state), true)
  assert.deepEqual(readTodo(), state)
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota') }
  try {
    assert.equal(writeTodo(state), false)
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
  db.delete(K.todo)
})

test('clearTodo：删除清单，回读到空；重复清除不抛', () => {
  writeTodo({ items: [{ id: 'a', text: '任务', done: false, at: 1, doneAt: 0 }], focusId: '' })
  clearTodo()
  assert.deepEqual(readTodo(), { items: [], focusId: '' })
  assert.doesNotThrow(() => clearTodo())
})

test('readFocus：空存储 / 非对象回 v2 空壳；老日子（无明细）保留，非法键、非对象、全零天一律丢', () => {
  db.delete(K.focus)
  assert.deepEqual(readFocus(), { v: 2, days: {}, sessions: [] })
  db.set(K.focus, 'nope')
  assert.deepEqual(readFocus(), { v: 2, days: {}, sessions: [] })
  db.set(K.focus, {
    days: {
      '2026-10-26': { r: 2, m: 50 },
      '2026-10-25': { r: 0, m: 0 }, // 空壳不留
      '2026-10-24': null,
      'bad': { r: 1, m: 25 },
      '2026-10-23': { r: -3, m: 'abc' }, // 归零 → 空壳
      '2026-10-22': { r: 1.4, m: 25.6 }, // 取整
    },
  })
  const s = readFocus()
  assert.equal(s.v, 2)
  assert.deepEqual(s.days['2026-10-26'], { r: 2, m: 50 })
  assert.equal(s.days['2026-10-25'], undefined)
  assert.equal(s.days['bad'], undefined)
  assert.equal(s.days['2026-10-23'], undefined)
  assert.deepEqual(s.days['2026-10-22'], { r: 1, m: 26 })
  db.delete(K.focus)
})

test('readFocus：老形状明细无迁移升级（补 id/s/k），天表改由明细派生', () => {
  db.delete(K.focus)
  // 缺 days、只有 sessions：老数据加字段后也必须能读，且天表立刻能从明细算出来
  db.set(K.focus, { sessions: [
    { d: '2026-10-26', t: 3000, m: 25, todoId: ' b ', todoText: '  写 \n 周报  ' },
    { d: '2026-10-26', t: 1000, m: 25.6 },
    { d: 'bad', t: 2000, m: 25 }, // 非法日期
    { d: '2026-10-26', t: 0, m: 25 }, // 非法时间
    { d: '2026-10-26', t: 2000, m: 0 }, // 非法时长
    'nope',
    { d: '2026-10-26', t: 1500, m: 9999, todoText: 'x'.repeat(80) }, // 分钟夹到 1440、文案限长
  ] })
  const s = readFocus()
  assert.equal(s.sessions.length, 3)
  assert.equal(s.sessions[0].t, 1000)
  assert.equal(s.sessions[1].m, 1440)
  assert.equal(s.sessions[1].todoText, 'x'.repeat(60))
  assert.equal(s.sessions[2].todoId, 'b')
  assert.equal(s.sessions[2].todoText, '写 周报')
  for (const one of s.sessions) {
    assert.equal(one.k, 'down') // 老数据没记模式，一律按倒计时补
    assert.ok(one.id)
    assert.ok(isFinite(one.s))
  }
  // 三条都是合格轮：分钟相加、轮数相加（不能再沿用「自己累加的 days」）
  assert.deepEqual(s.days, { '2026-10-26': { r: 3, m: 26 + 1440 + 25 } })
  db.delete(K.focus)
})

test('readFocus：有明细的天不认老聚合，没有明细的老日子原样留着', () => {
  db.set(K.focus, {
    days: { '2026-10-26': { r: 9, m: 900 }, '2026-10-25': { r: 1, m: 25 } },
    sessions: [{ d: '2026-10-26', t: 5000, m: 25 }],
  })
  const s = readFocus()
  assert.deepEqual(s.days['2026-10-26'], { r: 1, m: 25 }) // 以明细为准，否则图和列表永远对不上
  assert.deepEqual(s.days['2026-10-25'], { r: 1, m: 25 }) // 只有天表的老日子没有可派生的依据
  db.delete(K.focus)
})

test('writeFocus：落盘前后都过派生，回读是 v2；失败回 false 不抛；clearFocus 后回空', () => {
  db.delete(K.focus)
  const state = {
    days: { '2026-10-26': { r: 5, m: 125 } }, // 自己累加出来的假聚合
    sessions: [{ d: '2026-10-26', t: 5000, m: 25, todoId: 'a', todoText: '周报' }],
  }
  assert.equal(writeFocus(state), true)
  const back = readFocus()
  assert.equal(back.v, 2)
  assert.deepEqual(back.days, { '2026-10-26': { r: 1, m: 25 } }) // 写盘时就被派生覆盖，漂不出第二条账
  assert.equal(back.sessions[0].todoId, 'a')
  assert.deepEqual(readFocus(), back) // 幂等：读出来的再写回去不改变内容
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota') }
  try {
    assert.equal(writeFocus(state), false)
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
  clearFocus()
  assert.deepEqual(readFocus(), { v: 2, days: {}, sessions: [] })
})

// 待办的「N 轮」从会话派生（P1：不再由挂件每完成一轮就 rounds +1）
test('syncTodoRounds：按会话明细补齐轮数（只升不降）', () => {
  db.delete(K.todo)
  db.delete(K.focus)
  db.set(K.todo, { items: [
    { id: 'a', text: '写周报', at: 1, rounds: 9 },
    { id: 'b', text: '看文档', at: 1, rounds: 0 },
  ], focusId: 'a' })
  db.set(K.focus, { days: {}, sessions: [
    { d: '2026-10-26', t: 1000, m: 25, todoId: 'a' },
    { d: '2026-10-26', t: 2000, m: 25, todoId: 'a' },
    { d: '2026-10-25', t: 3000, m: 25, todoId: 'b' },
  ] })
  assert.equal(syncTodoRounds(), true)
  const items = readTodo().items
  assert.deepEqual(items.find((x) => x.id === 'a').rounds, 9) // 明细 2 < 历史 9：保留历史
  assert.deepEqual(items.find((x) => x.id === 'b').rounds, 1) // 0 → 1：补齐
  assert.equal(readTodo().focusId, 'a') // 只回填 rounds，别把专注目标顺手抹了
})

test('syncTodoRounds：明细少于历史时不抹掉历史（v1 终身计数）', () => {
  db.delete(K.todo)
  db.delete(K.focus)
  db.set(K.todo, { items: [{ id: 'a', text: '写周报', at: 1, rounds: 9 }], focusId: '' })
  db.set(K.focus, { days: {}, sessions: [
    { d: '2026-10-26', t: 1000, m: 25, todoId: 'a' },
    { d: '2026-10-26', t: 2000, m: 25, todoId: 'a' },
  ] })
  // v1 的 rounds 是终身累计，明细只保留 90 天：以明细整值覆盖会把老用户的 9 轮清成 2 轮
  assert.equal(syncTodoRounds(), false)
  assert.equal(readTodo().items[0].rounds, 9)
  db.delete(K.todo)
  db.delete(K.focus)
})

test('syncTodoRounds：只数合格轮 —— 正计时 / 休息 / 放弃都不算一轮', () => {
  db.delete(K.todo)
  db.delete(K.focus)
  db.set(K.todo, { items: [{ id: 'a', text: '写周报', at: 1, rounds: 0 }], focusId: '' })
  db.set(K.focus, { days: {}, sessions: [
    { d: '2026-10-26', t: 1000, m: 25, todoId: 'a' },
    { d: '2026-10-26', t: 2000, m: 40, todoId: 'a', k: 'up' },
    { d: '2026-10-26', t: 3000, m: 5, todoId: 'a', b: 1 },
    { d: '2026-10-26', t: 4000, m: 12, todoId: 'a', a: 1 },
  ] })
  assert.equal(syncTodoRounds(), true)
  assert.equal(readTodo().items[0].rounds, 1)
})

test('syncTodoRounds：历史轮数不清零（明细少或没有都不动）', () => {
  db.delete(K.todo)
  db.delete(K.focus)
  db.set(K.todo, { items: [
    { id: 'a', text: '有明细', at: 1, rounds: 3 },
    { id: 'b', text: '老数据', at: 1, rounds: 7 },
  ], focusId: '' })
  db.set(K.focus, { days: {}, sessions: [{ d: '2026-10-26', t: 1000, m: 25, todoId: 'a' }] })
  assert.equal(syncTodoRounds(), false) // 1 < 3、7 无依据：都不写
  const items = readTodo().items
  assert.equal(items.find((x) => x.id === 'a').rounds, 3)
  assert.equal(items.find((x) => x.id === 'b').rounds, 7)
})

test('syncTodoRounds：本来就对得上时不写盘（回 false），脏 rounds 夹到 0–99', () => {
  db.delete(K.todo)
  db.delete(K.focus)
  db.set(K.focus, { days: {}, sessions: [] })
  db.set(K.todo, { items: [{ id: 'a', text: '空任务', at: 1, rounds: 0 }], focusId: '' })
  assert.equal(syncTodoRounds(), false)
  assert.deepEqual(readTodo().items[0].rounds, 0)
  // 100 条以上明细 → 与 normTodoItem 同口径夹到 99
  const many = []
  for (let i = 0; i < 120; i++) many.push({ d: '2026-10-26', t: 1000 + i, m: 25, todoId: 'a' })
  db.set(K.focus, { days: {}, sessions: many })
  assert.equal(syncTodoRounds(), true)
  assert.equal(readTodo().items[0].rounds, 99)
  db.delete(K.todo)
  db.delete(K.focus)
})

test('syncTodoRounds：写盘失败回 false 不抛', () => {
  db.delete(K.todo)
  db.set(K.todo, { items: [{ id: 'a', text: '写周报', at: 1, rounds: 0 }], focusId: '' })
  db.set(K.focus, { days: {}, sessions: [{ d: '2026-10-26', t: 1000, m: 25, todoId: 'a' }] })
  const saved = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota') }
  try {
    assert.equal(syncTodoRounds(), false)
  } finally {
    globalThis.utools.dbStorage.setItem = saved
  }
  db.delete(K.todo)
  db.delete(K.focus)
})

// ──────────────────────────────────────────────
// dsh 快照保留份数常量（导出值供设置页夹取，改动需同步 spec）
// ──────────────────────────────────────────────
test('DSB_KEEP 边界常量：min 1（0 会让快照建完即删），max 200', () => {
  assert.equal(DSB_KEEP_MIN, 1)
  assert.equal(DSB_KEEP_MAX, 200)
})
