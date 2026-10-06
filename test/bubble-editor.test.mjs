/*
 * src/bubble/bubble-edit.js 单测（node --test，零依赖）。
 *
 * 这些函数是设置页「按压气泡（自定义泡泡）」编辑器的骨架：行×模块布局的压平 / 还原必须与宿主
 * store.js 的 normBubbleModules **同口径**，否则「编辑器里看着是 2 行、存下去变成 1 行」这类
 * 静默变形会一路骗过四关。同样，队列的增删改若返回原引用，Vue 变更检测会漏更新。
 *
 * 重点覆盖：
 *   - bubbleApplyRowLayout / bubbleRowsFromMods 互逆，且与宿主 normBubbleModules 的 row 键口径一致
 *   - 图片类模块独占一行并打断行合并
 *   - 队列增删改返回新数组、不越界、不超上限
 *   - 单泡 ↔ 并列泡升格 / 降级
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import store from '../public/preload/lib/store.js'
import {
  bubbleApplyRowLayout,
  bubbleRowsFromMods,
  isImgMod,
  modContentLocked,
  emptyMod,
  emptyBubble,
  emptyStep,
  isChoiceStep,
  stepItems,
  stepLabel,
  bubbleModCount,
  stepSummary,
  addStep,
  removeStep,
  moveStep,
  moveStepTo,
  pairSteps,
  replaceChoiceSide,
  splitChoiceSide,
  toChoiceStep,
  toSingleStep,
  setStepModules,
  stepModules,
  cloneBubbleItems,
  BUBBLE_MOD_TYPES,
  BUBBLE_ROW_MAX,
  BUBBLE_MOD_MAX,
  BUBBLE_ITEM_MAX,
  BUBBLE_SIZE_DFT,
  BUBBLE_LIB_MAX,
  cloneRows,
  addModule,
  removeModule,
  moveModule,
  moveRowTo,
  moveRowEnd,
  dropModule,
  moveModuleEnd,
  addToRow,
  removeRow,
  moveRow,
  setModule,
  addLibModule,
  removeLibModule,
  libModuleById,
  newLibId,
  imgIdRandom,
  imgIdOf,
} from '../src/bubble/bubble-edit.js'

const { normBubbleModules } = store

// ──────────────────────────────────────────────
// 模块类型表：必须与宿主 BUBBLE_MOD_TYPES 同集合（漂移会让编辑器造出宿主不认的 type）
// ──────────────────────────────────────────────
test('BUBBLE_MOD_TYPES 与宿主 store.js 的 type 集合完全一致', () => {
  const mine = BUBBLE_MOD_TYPES.map((m) => m.type).sort()
  const host = store.BUBBLE_MOD_TYPES.slice().sort()
  assert.deepEqual(mine, host)
  // 每项都得有 label / hint，供编辑器下拉与说明用
  for (const m of BUBBLE_MOD_TYPES) {
    assert.ok(m.label && m.label.length >= 1, `${m.type} 缺 label`)
    assert.ok(m.hint && m.hint.length >= 1, `${m.type} 缺 hint`)
  }
})

test('isImgMod / modContentLocked 判定与宿主分支一致', () => {
  assert.equal(isImgMod('image'), true)
  assert.equal(isImgMod('randimg'), true)
  assert.equal(isImgMod('text'), false)
  // 内容锁定型：正文由运行时数据决定，编辑器不给内容输入框
  for (const t of ['balance', 'bonus', 'recharge', 'today', 'time', 'quota', 'plan']) {
    assert.equal(modContentLocked(t), true, `${t} 应锁定内容`)
  }
  for (const t of ['text', 'random', 'link', 'image', 'randimg', 'peak', 'session']) {
    assert.equal(modContentLocked(t), false, `${t} 不该锁定内容`)
  }
})

// peak 模块的「两态配色」字段必须能过宿主清洗 —— 面板给了入口、渲染器靠宿主 modStyle 回色，
// 中间任一环丢字段都会变成「设了没反应」
test('peak 模块的两态配色（含底色）能过宿主 normBubbleMod', () => {
  const norm = store.normBubbleMod({
    type: 'peak', size: 8,
    peakColor: '#b91c1c', offColor: '#15803d',
    peakRgb: 'candy', offRgb: 'mint',
    peakBg: '#fee2e2', offBg: '#dcfce7', offBgRgb: 'aurora',
  })
  assert.ok(norm)
  assert.equal(norm.peakColor, '#b91c1c')
  assert.equal(norm.offColor, '#15803d')
  assert.equal(norm.peakRgb, 'candy')
  assert.equal(norm.offRgb, 'mint')
  assert.equal(norm.peakBg, '#fee2e2')
  assert.equal(norm.offBg, '#dcfce7')
  assert.equal(norm.offBgRgb, 'aurora')
  // 非法 rgb 方案被白名单挡掉（不给渲染侧塞认不出的 class）
  const bad = store.normBubbleMod({ type: 'peak', peakRgb: 'not-a-scheme' })
  assert.equal(bad.peakRgb, '')
})

// ──────────────────────────────────────────────
// 行×模块布局：压平 / 还原 互逆，且与宿主 normBubbleModules 同口径
// ──────────────────────────────────────────────
test('bubbleApplyRowLayout：单模块行不写 row 键，多模块行写 行号+1', () => {
  const rows = [
    [{ type: 'text', text: 'a' }],
    [{ type: 'text', text: 'b' }, { type: 'text', text: 'c' }],
  ]
  const flat = bubbleApplyRowLayout(rows)
  assert.equal(flat.length, 3)
  assert.equal('row' in flat[0], false) // 单模块行：无 row
  assert.equal(flat[1].row, 2) // 第 2 行（下标 1）+ 1
  assert.equal(flat[2].row, 2)
})

test('bubbleApplyRowLayout：图片类独占一行且打断行合并（同宿主 normBubbleModules）', () => {
  // 第 1 行：文本 + 图片（图片必须断开）；第 2 行：两张文本
  const rows = [
    [{ type: 'text', text: 'a' }, { type: 'image', imgId: 'x' }],
    [{ type: 'text', text: 'b' }, { type: 'text', text: 'c' }],
  ]
  const flat = bubbleApplyRowLayout(rows)
  // 第 1 行有 2 个模块 → 都带 row=1；但图片在渲染侧独占行，宿主归一化时会再拆。
  // 这里只保证压平后 row 键规则正确：多模块行 → row = 行号+1
  assert.equal(flat[0].row, 1)
  assert.equal(flat[1].row, 1)
  // 关键：压平产物喂宿主 normBubbleModules 必须幂等（不再变形）
  const normalized = normBubbleModules(flat)
  const again = normBubbleModules(normalized)
  assert.deepEqual(again, normalized, '压平产物过宿主归一化应稳定')
})

test('bubbleRowsFromMods / bubbleApplyRowLayout 互逆', () => {
  const mods = [
    { type: 'text', text: 'a' }, // 单模块行
    { type: 'text', text: 'b', row: 2 },
    { type: 'text', text: 'c', row: 2 }, // 与上一个同行
    { type: 'image', imgId: 'x' }, // 图片独占
  ]
  const rows = bubbleRowsFromMods(mods)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].length, 1)
  assert.equal(rows[1].length, 2) // 两个 row=2 归一行
  assert.equal(rows[2].length, 1) // 图片独占
  // 压平回去 —— 与宿主归一化后再压平应稳定
  const flat = bubbleApplyRowLayout(rows)
  assert.equal(flat.length, 4)
  assert.deepEqual(bubbleApplyRowLayout(bubbleRowsFromMods(flat)), bubbleApplyRowLayout(bubbleRowsFromMods(bubbleApplyRowLayout(bubbleRowsFromMods(flat)))))
})

test('bubbleApplyRowLayout：行 / 每行模块超上限时截断（ROW_MAX / MOD_MAX）', () => {
  const manyRows = []
  for (let i = 0; i < BUBBLE_ROW_MAX + 3; i++) manyRows.push([{ type: 'text', text: 'x' + i }])
  assert.equal(bubbleApplyRowLayout(manyRows).length, BUBBLE_ROW_MAX)

  const wideRow = []
  for (let i = 0; i < BUBBLE_MOD_MAX + 3; i++) wideRow.push({ type: 'text', text: 'y' + i })
  assert.equal(bubbleApplyRowLayout([wideRow]).length, BUBBLE_MOD_MAX)
})

test('bubbleRowsFromMods：非数组 / 脏项安全', () => {
  assert.deepEqual(bubbleRowsFromMods(null), [])
  assert.deepEqual(bubbleRowsFromMods([null, 'x', 42]), [])
})

// ──────────────────────────────────────────────
// 步骤 / 泡 构造
// ──────────────────────────────────────────────
test('emptyMod 造出的默认内容能过宿主 normBubbleMod（不被丢）', () => {
  const { normBubbleMod } = store
  for (const t of ['text', 'random', 'link', 'image', 'randimg', 'peak', 'session']) {
    const m = emptyMod(t)
    assert.ok(normBubbleMod(m), `${t} 的默认模块被宿主丢了`)
  }
  // 内容锁定型没内容也该保留（正文由运行时给）
  for (const t of ['balance', 'time', 'today']) {
    assert.ok(normBubbleMod(emptyMod(t)), `${t} 的默认模块被宿主丢了`)
  }
  assert.equal(emptyMod().size, BUBBLE_SIZE_DFT)
})

// ──────────────────────────────────────────────
// image 模块的 imgId 语义：'' / '0' = 随机，1..N = 指定第 N 张
// （必须与浮动页 bubbleImgSrc 同口径，否则「选第 2 张」在挂件上会变成随机）
// ──────────────────────────────────────────────
test('imgIdOf：空 / 0 / 非数字都归「随机」，正整数原样保留', () => {
  assert.equal(imgIdOf(undefined), imgIdRandom())
  assert.equal(imgIdOf(''), imgIdRandom())
  assert.equal(imgIdOf('0'), imgIdRandom())
  assert.equal(imgIdOf('abc'), imgIdRandom())
  assert.equal(imgIdOf('-3'), imgIdRandom())
  assert.equal(imgIdOf('2'), '2')
  assert.equal(imgIdOf(3), '3')
  // 小数按四舍五入取整（与浮动页 Math.round 一致）
  assert.equal(imgIdOf('2.6'), '3')
})
test('emptyMod 的 image 默认是「随机」（imgId=0），且能过宿主清洗', () => {
  const m = emptyMod('image')
  assert.equal(m.imgId, imgIdRandom())
  const norm = store.normBubbleMod(m)
  assert.ok(norm, 'image 默认模块被宿主丢了')
  // 宿主把 imgId 存成 trim 后的字符串，'0' 应原样留存（渲染侧据此走随机分支）
  assert.equal(norm.imgId, '0')
})

test('emptyBubble / emptyStep 是合法单泡（能过宿主归一化）', () => {
  const { normBubbleStep } = store
  assert.ok(normBubbleStep(emptyBubble()))
  assert.ok(normBubbleStep(emptyStep()))
  assert.equal(isChoiceStep(emptyStep()), false)
})

// ──────────────────────────────────────────────
// 队列增删改
// ──────────────────────────────────────────────
test('addStep 返回新数组、不超上限，且原数组不变', () => {
  const a = []
  const b = addStep(a)
  assert.notEqual(a, b)
  assert.equal(a.length, 0)
  assert.equal(b.length, 1)
  // 造满到上限后不再增
  let cur = []
  for (let i = 0; i < BUBBLE_ITEM_MAX + 5; i++) cur = addStep(cur)
  assert.equal(cur.length, BUBBLE_ITEM_MAX)
})

test('removeStep 越界安全、返回新数组，可删到空', () => {
  const a = [1, 2, 3]
  const b = removeStep(a, 1)
  assert.notEqual(a, b)
  assert.deepEqual(b, [1, 3])
  assert.deepEqual(removeStep(a, -1), [1, 2, 3])
  assert.deepEqual(removeStep(a, 99), [1, 2, 3])
  let cur = [1]
  cur = removeStep(cur, 0)
  assert.deepEqual(cur, []) // 允许删到空（保存时宿主回默认）
})

test('moveStep 交换相邻项、越界不动', () => {
  const a = ['a', 'b', 'c']
  assert.deepEqual(moveStep(a, 0, 1), ['b', 'a', 'c'])
  assert.deepEqual(moveStep(a, 2, -1), ['a', 'c', 'b'])
  assert.deepEqual(moveStep(a, 0, -1), ['a', 'b', 'c'])
  assert.deepEqual(moveStep(a, 2, 1), ['a', 'b', 'c'])
})

test('moveStepTo：拖拽跨步落点（before / after 按目标的新下标算）', () => {
  const a = ['a', 'b', 'c', 'd']
  // 0 → 2 之前：摘出 a 后新数组 [b,c,d]，插到 c 前
  assert.deepEqual(moveStepTo(a, 0, 2, 'before'), ['b', 'a', 'c', 'd'])
  // 0 → 2 之后
  assert.deepEqual(moveStepTo(a, 0, 2, 'after'), ['b', 'c', 'a', 'd'])
  // 往回拖：3 → 1 之前
  assert.deepEqual(moveStepTo(a, 3, 1, 'before'), ['a', 'd', 'b', 'c'])
  // 拖到自己身上不动（from === to）
  assert.deepEqual(moveStepTo(a, 1, 1, 'before'), a)
  // 越界安全
  assert.deepEqual(moveStepTo(a, -1, 2, 'before'), a)
  assert.deepEqual(moveStepTo(a, 0, 9, 'after'), a)
  // 返回新数组，不动源
  const out = moveStepTo(a, 0, 2, 'before')
  assert.notEqual(out, a)
  assert.deepEqual(a, ['a', 'b', 'c', 'd'])
})

// ──────────────────────────────────────────────
// 队列层拖拽：左右边缘并列 / 替换并列侧 / A·B 拆出（对齐上游 bubblePairDrop / bubbleSideSplitDrop）
// ──────────────────────────────────────────────
const singleStep = (t) => ({ kind: 'custom', modules: [{ type: 'text', text: t }] })
const choiceStep = (ta, tb) => ({
  kind: 'choice',
  options: [
    { w: 3, item: singleStep(ta) },
    { w: 5, item: singleStep(tb) },
  ],
})

test('pairSteps：单泡拖到单泡左/右边缘并成 A/B，落点槽位与权重 1:1', () => {
  const a = [singleStep('a'), singleStep('b'), singleStep('c')]
  // 0 拖到 2 的左边缘 = 拖入泡做 A：并列步落在目标行原槽位（from<to → to-1=1）
  const l = pairSteps(a, 0, 2, 'pairL')
  assert.equal(l.length, 2)
  assert.equal(l[1].kind, 'choice')
  assert.deepEqual(l[1].options.map((o) => o.w), [1, 1])
  assert.equal(l[1].options[0].item.modules[0].text, 'a')
  assert.equal(l[1].options[1].item.modules[0].text, 'c')
  assert.equal(l[0].modules[0].text, 'b')
  // 0 拖到 2 的右边缘 = 拖入泡做 B
  const r = pairSteps(a, 0, 2, 'pairR')
  assert.equal(r[1].options[0].item.modules[0].text, 'c')
  assert.equal(r[1].options[1].item.modules[0].text, 'a')
  // 往上拖：2 拖到 0 的左边缘 = 并列步落在槽位 0（from>to → to）
  const up = pairSteps(a, 2, 0, 'pairL')
  assert.equal(up[0].kind, 'choice')
  assert.equal(up[0].options[0].item.modules[0].text, 'c')
  assert.equal(up[0].options[1].item.modules[0].text, 'a')
  assert.equal(up[1].modules[0].text, 'b')
  // 源或目标是并列泡 → 原样返回（并列行不可再并入，上游同口径）
  const withChoice = [singleStep('a'), choiceStep('x', 'y')]
  assert.deepEqual(pairSteps(withChoice, 0, 1, 'pairL'), withChoice)
  assert.deepEqual(pairSteps(withChoice, 1, 0, 'pairR'), withChoice)
  // 拖到自己 / 非边缘 zone / 越界 → 原样
  assert.deepEqual(pairSteps(a, 1, 1, 'pairL'), a)
  assert.deepEqual(pairSteps(a, 0, 2, 'before'), a)
  assert.deepEqual(pairSteps(a, -1, 2, 'pairL'), a)
  // 不动源
  assert.equal(a.length, 3)
})

test('replaceChoiceSide：单泡替换并列泡指定侧，权重保留原侧', () => {
  const items = [singleStep('new'), choiceStep('a', 'b'), singleStep('z')]
  // 替换 A（side 0）：权重用 A 的 3，内容换 new；拖入步移除
  const ra = replaceChoiceSide(items, 0, 1, 0)
  assert.equal(ra.length, 2)
  assert.equal(ra[0].kind, 'choice')
  assert.deepEqual(ra[0].options.map((o) => o.w), [3, 5])
  assert.equal(ra[0].options[0].item.modules[0].text, 'new')
  assert.equal(ra[0].options[1].item.modules[0].text, 'b')
  // 替换 B（side 1）：权重用 B 的 5
  const rb = replaceChoiceSide(items, 0, 1, 1)
  assert.deepEqual(rb[0].options.map((o) => o.w), [3, 5])
  assert.equal(rb[0].options[1].item.modules[0].text, 'new')
  // 拖入步自己是并列泡 / 目标不是并列泡 → 原样
  assert.deepEqual(replaceChoiceSide([choiceStep('p', 'q'), choiceStep('x', 'y')], 0, 1, 0),
    [choiceStep('p', 'q'), choiceStep('x', 'y')])
  assert.deepEqual(replaceChoiceSide([singleStep('n'), singleStep('m')], 0, 1, 0),
    [singleStep('n'), singleStep('m')])
  // 不动源
  assert.equal(items.length, 3)
})

test('splitChoiceSide：A/B 拖出拆分、拖回本步调换次序、剩侧还原单泡', () => {
  // 拖到别的步之前：并列行还原为 B 单泡（占原槽位），A 拆出插入 z 之前 —— 步数 +1
  const items = [choiceStep('a', 'b'), singleStep('z')]
  const split = splitChoiceSide(items, 0, 0, 1, 'before')
  assert.equal(split.length, 3)
  assert.equal(split[0].modules[0].text, 'b') // 原行只剩 B → 还原单泡
  assert.equal(split[1].modules[0].text, 'a') // A 拆出插到 z 前
  assert.equal(split[2].modules[0].text, 'z')
  // 拖到别的步之后：A 插在 z 后面
  const after = splitChoiceSide(items, 0, 0, 1, 'after')
  assert.equal(after.length, 3)
  assert.equal(after[0].modules[0].text, 'b')
  assert.equal(after[1].modules[0].text, 'z')
  assert.equal(after[2].modules[0].text, 'a')
  // 拖回本步 = 调换 A/B 次序：剩侧还原单泡占原槽位 + 拖出侧按落点另插一步（步数 +1，z 仍在尾部）
  const flipB = splitChoiceSide(items, 0, 0, 0, 'after')
  assert.equal(flipB.length, 3)
  assert.equal(flipB[0].modules[0].text, 'b')
  assert.equal(flipB[1].modules[0].text, 'a') // A 拖到下半 → 插在剩侧 B 之后
  assert.equal(flipB[2].modules[0].text, 'z')
  const flipA = splitChoiceSide(items, 0, 1, 0, 'before')
  assert.equal(flipA.length, 3)
  assert.equal(flipA[0].modules[0].text, 'b') // B 拖到上半 → 插在剩侧 A 之前
  assert.equal(flipA[1].modules[0].text, 'a')
  assert.equal(flipA[2].modules[0].text, 'z')
  // 同侧不同落点半区结果不同：A 拖到上半 → A 仍在 B 前
  const flipKeep = splitChoiceSide(items, 0, 0, 0, 'before')
  assert.equal(flipKeep.length, 3)
  assert.equal(flipKeep[0].modules[0].text, 'a')
  assert.equal(flipKeep[1].modules[0].text, 'b')
  assert.equal(flipKeep[2].modules[0].text, 'z')
  // 源不是并列步 / zone 非纵向 / 越界 → 原样
  assert.deepEqual(splitChoiceSide([singleStep('a'), singleStep('b')], 0, 0, 1, 'before'),
    [singleStep('a'), singleStep('b')])
  assert.deepEqual(splitChoiceSide(items, 0, 0, 1, 'pairL'), items)
  assert.deepEqual(splitChoiceSide(items, 9, 0, 1, 'before'), items)
  // 不动源
  assert.equal(items.length, 2)
  assert.equal(items[0].kind, 'choice')
})

// ──────────────────────────────────────────────
// 单泡 ↔ 并列泡
// ──────────────────────────────────────────────
test('toChoiceStep 升格为 A/B 并列（默认权重 10:2），幂等', () => {
  const c = toChoiceStep(emptyBubble())
  assert.equal(isChoiceStep(c), true)
  assert.deepEqual(c.options.map((o) => o.w), [10, 2])
  // A/B 内容独立（深拷贝，改 B 不影响 A）
  c.options[1].item.modules[0].text = '改过'
  assert.notEqual(c.options[0].item.modules[0].text, '改过')
  // 已是并列泡再升格 = 原样返回
  assert.equal(toChoiceStep(c), c)
})

test('toSingleStep 降级保留 A 泡，幂等', () => {
  const c = toChoiceStep(emptyBubble())
  const s = toSingleStep(c)
  assert.equal(isChoiceStep(s), false)
  assert.ok(Array.isArray(s.modules))
  assert.equal(toSingleStep(s), s)
})

test('setStepModules / stepModules：单泡直改、并列泡按 side 选 A/B', () => {
  const single = emptyBubble()
  const set = setStepModules(single, -1, [{ type: 'text', text: '新' }])
  assert.equal(set.modules[0].text, '新')
  assert.notEqual(set, single) // 返回新对象

  const choice = toChoiceStep(emptyBubble())
  const setB = setStepModules(choice, 1, [{ type: 'text', text: 'B泡' }])
  assert.equal(stepModules(setB, 0)[0].text, '点我') // A 不动
  assert.equal(stepModules(setB, 1)[0].text, 'B泡') // B 改了
})

test('stepItems：单泡 1 项、并列 2 项', () => {
  assert.equal(stepItems(emptyBubble()).length, 1)
  assert.equal(stepItems(toChoiceStep(emptyBubble())).length, 2)
  assert.equal(stepItems(null).length, 0)
})

// 回归：设置页「加一步」的手感依赖这段回环 —— addStep 产出的新数组经 patch 送进宿主
// normBubble({items}) 后必须原样回来（步数 +1）。若哪天 normBubble 把新步吃掉（例如
// emptyBubble 的默认模块被某个新白名单滤掉 → normBubbleBubble 回 null 整步丢），
// 表现就是「加了等于没加」，纯靠点界面很难定位，故在此钉住。
test('回归：addStep 的产物能穿过宿主 normBubble 原样回来（加一步不能白加）', () => {
  const { normBubble } = store
  const cur = normBubble(null, null, undefined)
  const before = cur.items.length
  const next = normBubble({ items: addStep(cur.items) }, cur, undefined)
  assert.equal(next.items.length, before + 1)
})

test('stepLabel / stepSummary 文案稳定', () => {
  assert.equal(stepLabel(0), '第 1 次点击')
  assert.equal(stepLabel(2), '第 3 次点击')
  assert.equal(stepSummary(emptyBubble()), '1 行 1 模块')
  assert.match(stepSummary(toChoiceStep(emptyBubble())), /并列/)
})

test('bubbleModCount：空泡 0、单泡按 modules 数', () => {
  assert.equal(bubbleModCount(null), 0)
  assert.equal(bubbleModCount(emptyBubble()), 1)
})

// ──────────────────────────────────────────────
// 深拷贝
// ──────────────────────────────────────────────
test('cloneBubbleItems：深拷贝、与源脱钩、脏输入回空数组', () => {
  const src = [{ kind: 'custom', modules: [{ type: 'text', text: 'a' }] }]
  const c = cloneBubbleItems(src)
  assert.notEqual(c, src)
  c[0].modules[0].text = '改过'
  assert.equal(src[0].modules[0].text, 'a')
  assert.deepEqual(cloneBubbleItems(null), [])
  assert.deepEqual(cloneBubbleItems('x'), [])
})

// ──────────────────────────────────────────────
// 模块级操作（W2：行×模块编辑器）
// ──────────────────────────────────────────────
test('cloneRows：深拷贝二维行，改草稿不动源', () => {
  const rows = [[{ type: 'text', text: 'a' }], [{ type: 'balance' }]]
  const c = cloneRows(rows)
  assert.notEqual(c, rows)
  c[0][0].text = '改过'
  assert.equal(rows[0][0].text, 'a')
  assert.deepEqual(cloneRows(null), [])
})

test('addModule：新模块落在末尾新起一行；行数满 / 图片重复都被挡', () => {
  const r1 = addModule([], 'text')
  assert.equal(r1.ok, true)
  assert.equal(r1.rows.length, 1)
  // 图片已存在时再加图片 → 拒绝（图片独占一行，多张会挤垮版式）
  const withImg = [[{ type: 'image', imgId: 'x', imgScale: 1 }]]
  const r2 = addModule(withImg, 'image')
  assert.equal(r2.ok, false)
  // 行数到达上限 → 拒绝
  const full = Array.from({ length: BUBBLE_ROW_MAX }, (_, i) => [{ type: 'text', text: String(i) }])
  const r3 = addModule(full, 'text')
  assert.equal(r3.ok, false)
  assert.match(r3.reason, /最多/)
})

test('removeModule：删掉行内最后一格时整行消失', () => {
  const rows = [[{ type: 'text', text: 'a' }], [{ type: 'balance' }]]
  const out = removeModule(rows, 0, 0)
  assert.equal(out.length, 1)
  assert.equal(out[0][0].type, 'balance')
  // 越界安全
  assert.equal(removeModule(rows, 9, 0).length, 2)
})

test('moveModule：整行挪到目标行下标位置（目标按移除后的新数组算）', () => {
  const rows = [[{ type: 'text', text: 'a' }], [{ type: 'balance' }], [{ type: 'time' }]]
  const out = moveModule(rows, 0, 0, 2)
  assert.equal(out.length, 3)
  // 自己那行被抽走后新数组是 [balance, time]，插到下标 2（% 长度后）= 末尾
  assert.equal(out[2][0].type, 'time')
  assert.equal(out[0][0].type, 'balance')
  assert.equal(out[1][0].text, 'a')
  // 从中间（新数组残留 [text, time]）插到下标 1 → 夹在中间
  const mid2 = moveModule(rows, 1, 0, 1)
  assert.equal(mid2[0][0].text, 'a')
  assert.equal(mid2[1][0].type, 'balance')
  assert.equal(mid2[2][0].type, 'time')
  // 目标即自己那行（ri === target）时原样返回，不产生位移
  assert.deepEqual(moveModule(rows, 1, 0, 1), rows)
})

test('addToRow：行内加一格；图片不能与其他模块同行', () => {
  const rows = [[{ type: 'text', text: 'a' }]]
  const r1 = addToRow(rows, 0, 'balance')
  assert.equal(r1.ok, true)
  assert.equal(r1.rows[0].length, 2)
  const r2 = addToRow(rows, 0, 'image')
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /独占/)
  // 一行已满
  const full = [[...Array.from({ length: BUBBLE_MOD_MAX }, (_, i) => ({ type: 'text', text: String(i) }))]]
  const r3 = addToRow(full, 0, 'text')
  assert.equal(r3.ok, false)
})

test('removeRow / moveRow：删行与上下挪行，越界安全', () => {
  const rows = [[{ type: 'text', text: 'a' }], [{ type: 'balance' }]]
  assert.equal(removeRow(rows, 0).length, 1)
  assert.equal(removeRow(rows, 5).length, 2)
  const swapped = moveRow(rows, 0, 1)
  assert.equal(swapped[0][0].type, 'balance')
  assert.deepEqual(moveRow(rows, 0, -1), rows)
})

test('moveRowTo：整行拖到目标行前 / 后（目标按移除后的新数组算）', () => {
  const rows = [[{ type: 'text', text: 'a' }], [{ type: 'balance' }], [{ type: 'time' }]]
  // 0 → 2 之前：摘出 a 后新数组 [balance, time]，插到 time 前
  const before = moveRowTo(rows, 0, 2, 'before')
  assert.equal(before[0][0].type, 'balance')
  assert.equal(before[1][0].text, 'a')
  assert.equal(before[2][0].type, 'time')
  // 0 → 2 之后 = 末尾
  const after = moveRowTo(rows, 0, 2, 'after')
  assert.equal(after[0][0].type, 'balance')
  assert.equal(after[1][0].type, 'time')
  assert.equal(after[2][0].text, 'a')
  // 往回拖：2 → 0 之后
  const back = moveRowTo(rows, 2, 0, 'after')
  assert.equal(back[0][0].text, 'a')
  assert.equal(back[1][0].type, 'time')
  assert.equal(back[2][0].type, 'balance')
  // 拖到自己 / 越界：原样（值相等，且返回新数组不动源）
  assert.deepEqual(moveRowTo(rows, 1, 1, 'before'), rows)
  assert.deepEqual(moveRowTo(rows, -1, 0, 'before'), rows)
  assert.deepEqual(moveRowTo(rows, 0, 9, 'after'), rows)
  assert.notEqual(moveRowTo(rows, 0, 2, 'before'), rows)
})

test('moveRowEnd：整行挪到末尾；已在末尾或越界不动', () => {
  const rows = [[{ type: 'text', text: 'a' }], [{ type: 'balance' }], [{ type: 'time' }]]
  const out = moveRowEnd(rows, 0)
  assert.equal(out[2][0].text, 'a')
  assert.equal(out[0][0].type, 'balance')
  assert.deepEqual(moveRowEnd(rows, 2), rows) // 已在末尾
  assert.deepEqual(moveRowEnd(rows, 9), rows) // 越界
})

test('dropModule：并入行首 / 行尾、另起一行、图片降级与各类上限', () => {
  const rows = [[{ type: 'text', text: 'a' }], [{ type: 'balance' }]]
  // pairL / pairR：并入目标行首 / 行尾
  const l = dropModule(rows, 0, 0, 1, 'pairL')
  assert.equal(l.ok, true)
  assert.equal(l.rows.length, 1) // 源行被抽空后消失
  assert.equal(l.rows[0][0].text, 'a')
  assert.equal(l.rows[0][1].type, 'balance')
  const r = dropModule(rows, 0, 0, 1, 'pairR')
  assert.equal(r.rows[0][0].type, 'balance')
  assert.equal(r.rows[0][1].text, 'a')
  // before / after：另起一行插在目标行前 / 后（源行空则整行消失，不占额外行）
  const bf = dropModule(rows, 0, 0, 1, 'before')
  assert.equal(bf.rows[0][0].text, 'a')
  assert.equal(bf.rows[1][0].type, 'balance')
  const af = dropModule(rows, 0, 0, 1, 'after')
  assert.equal(af.rows[0][0].type, 'balance')
  assert.equal(af.rows[1][0].text, 'a')
  // 图片并入 → 降级为「另起一行」（图片独占行）
  const withImg = [[{ type: 'image', imgId: 'x', imgScale: 1 }], [{ type: 'balance' }]]
  const imgDrop = dropModule(withImg, 0, 0, 1, 'pairR')
  assert.equal(imgDrop.ok, true)
  assert.equal(imgDrop.rows.length, 2) // 没并进去，仍是两行
  // 目标行已满（并入路径）→ 拒绝并给出原因
  const fullTgt = [[{ type: 'text', text: 'x' }],
    Array.from({ length: BUBBLE_MOD_MAX }, (_, i) => ({ type: 'text', text: String(i) }))]
  const rFull = dropModule(fullTgt, 0, 0, 1, 'pairR')
  assert.equal(rFull.ok, false)
  assert.match(rFull.reason, /最多/)
  // 落点不存在 → 拒绝
  const bad = dropModule(rows, 9, 0, 1, 'pairR')
  assert.equal(bad.ok, false)
})

test('dropModule：另起一行受行数上限约束（源行抽空时不额外占行）', () => {
  // 建满 BUBBLE_ROW_MAX 行，每行 1 个非图片模块
  const full = Array.from({ length: BUBBLE_ROW_MAX }, (_, i) => [{ type: 'text', text: String(i) }])
  // 来源行只有 1 个模块：摘掉后整行消失，行数不增 → 允许另起一行
  const ok = dropModule(full, 0, 0, 2, 'after')
  assert.equal(ok.ok, true)
  assert.equal(ok.rows.length, BUBBLE_ROW_MAX)
  // 来源行有 2 个模块：摘一个后源行仍在，另起一行会超上限 → 拒绝
  const full2 = full.map((row, i) => (i === 0 ? [{ type: 'text', text: 'a' }, { type: 'time' }] : row))
  const no = dropModule(full2, 0, 0, 2, 'after')
  assert.equal(no.ok, false)
  assert.match(no.reason, /最多/)
})

test('moveModuleEnd：模块独立成最后一行；越界与行满不动', () => {
  const rows = [[{ type: 'text', text: 'a' }, { type: 'balance' }], [{ type: 'time' }]]
  const out = moveModuleEnd(rows, 0, 0)
  assert.equal(out.length, 3)
  assert.equal(out[0].length, 1) // 源行只剩 balance
  assert.equal(out[0][0].type, 'balance')
  assert.equal(out[2][0].text, 'a') // 末尾新行
  // 越界安全（cloneRows 会给多模块行补 row 键，故与 cloneRows(rows) 比，不与裸数组比）
  assert.deepEqual(moveModuleEnd(rows, 9, 0), cloneRows(rows))
  assert.deepEqual(moveModuleEnd(rows, 0, 9), cloneRows(rows))
  // 行数已达上限且源行不会被抽空 → 不动
  const full = Array.from({ length: BUBBLE_ROW_MAX }, (_, i) => [{ type: 'text', text: String(i) }, { type: 'time' }])
  assert.deepEqual(moveModuleEnd(full, 0, 0), cloneRows(full))
})

test('setModule：patch 覆盖字段，显式 undefined 摘键', () => {
  const rows = [[{ type: 'text', text: 'a', color: '#fff', size: 6 }]]
  const out = setModule(rows, 0, 0, { color: '#000' })
  assert.equal(out[0][0].color, '#000')
  assert.equal(out[0][0].text, 'a')
  const cleared = setModule(rows, 0, 0, { color: undefined })
  assert.equal('color' in cleared[0][0], false)
  assert.equal('color' in rows[0][0], true)
})

test('模块库：增删查，入库是深拷贝、超上限不入', () => {
  const lib = addLibModule([], { type: 'text', text: 'a' }, '我的文案')
  assert.equal(lib.length, 1)
  assert.ok(lib[0].id)
  assert.equal(lib[0].name, '我的文案')
  // 库里那份与源脱钩
  const src = { type: 'text', text: 'b' }
  const lib2 = addLibModule(lib, src, '')
  src.text = '改过'
  assert.equal(lib2[1].module.text, 'b')
  assert.equal(lib2[1].name, '模块2')
  // 查：返回深拷贝
  const got = libModuleById(lib2, lib2[0].id)
  assert.equal(got.text, 'a')
  got.text = '改过'
  assert.equal(lib2[0].module.text, 'a')
  assert.equal(libModuleById(lib2, '不存在'), null)
  // 删
  assert.equal(removeLibModule(lib2, lib2[0].id).length, 1)
  // 超上限
  const full = Array.from({ length: BUBBLE_LIB_MAX }, (_, i) => ({ id: 'i' + i, name: 'n', module: { type: 'text', text: 'x' } }))
  assert.equal(addLibModule(full, { type: 'text', text: 'y' }).length, BUBBLE_LIB_MAX)
})

test('newLibId：两次生成不重复（时间戳同秒也要靠随机后缀区分）', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newLibId()))
  assert.equal(ids.size, 200)
})
