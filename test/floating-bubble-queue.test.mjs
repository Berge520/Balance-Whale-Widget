// test/floating-bubble-queue.test.mjs
// 气泡页队列：按压气泡步骤 → 倒计时页（开启时，排在所有步骤页之后）。
// 队列本体在 public/floating-pages.js（纯逻辑，可直接在沙箱里跑），
// floating-page.js 只留 bubbleQueue / bubbleNext / offworkCanRender 三个装配函数 ——
// 这里把两边都真跑一遍，不是正则对文本。
//
// 口径（2026-11-09 用户确认）：倒计时不许出现在第一张气泡的任何位置 ——
// 队列里步骤页在前、倒计时页最后；第一页是自定义第一步 / 出厂默认第一页，
// 并列泡（kind:'choice'）无论抽到哪一支都算同一张步骤页。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')
const pagesSrc = fs.readFileSync(new URL('../public/floating-pages.js', import.meta.url), 'utf8')
const widgetSrc = fs.readFileSync(new URL('../public/preload/lib/widget.js', import.meta.url), 'utf8')
const widgetCfgSrc = fs.readFileSync(new URL('../public/preload/lib/widget-config.js', import.meta.url), 'utf8')

// floating-pages.js 是浏览器 IIFE（挂 window.WhalePages），用最小 window 桩加载
function loadPages() {
  const win = {}
  new Function('window', pagesSrc)(win)
  assert.ok(win.WhalePages, 'floating-pages.js 未挂 window.WhalePages')
  return win.WhalePages
}
const P = loadPages()

// 从源码里按花括号配对摘出一个具名函数（这几个函数里的字面量没有多余花括号，配对足够可靠）
function extractFn(name) {
  const start = page.indexOf('function ' + name + '(')
  assert.ok(start >= 0, '找不到函数 ' + name)
  const open = page.indexOf('{', start)
  let depth = 0
  for (let i = open; i < page.length; i += 1) {
    if (page[i] === '{') depth += 1
    else if (page[i] === '}') {
      depth -= 1
      if (depth === 0) return page.slice(start, i + 1)
    }
  }
  throw new Error(name + ' 花括号不匹配')
}

const queueSrc = extractFn('bubbleQueue')
const nextSrc = extractFn('bubbleNext')

// 队列 + 推进沙箱：真实开关组合（offworkOn / bubbleModelOn / items / dft / 试播）
function makeQueue(opts) {
  const rendered = []
  const armed = []
  const factory = new Function(
    'opts', 'rendered', 'armed', 'PAGES',
    [
      'var offworkOn = !!opts.offworkOn;',
      'var bubbleModelOn = !!opts.modelOn;',
      'var bubbleItems = opts.items || [];',
      'var bubbleDefaultItems = opts.dft || [];',
      'var bubblePreviewItems = opts.preview || null;',
      'var bubbleIdx = 0, bubbleActive = false, bubbleLastOptionIdx = -1;',
      'var bubbleDwellMs = 5, bubbleModelDwellMs = 9;',
      'function bubbleArm(ms) { armed.push(ms); }',
      'function hideBubble() { bubbleActive = false; }',
      'function swapBubbleContent(fn) { fn(); }',
      'function bubbleRenderStep(step) { rendered.push(step); }',
      queueSrc,
      nextSrc,
      'return { q: bubbleQueue, next: bubbleNext, idx: function () { return bubbleIdx; }, rendered: rendered, armed: armed };',
    ].join('\n'),
  )
  return factory(opts, rendered, armed, P)
}

const stepA = { kind: 'custom', modules: [{ type: 'text', text: 'A' }] }
const stepB = { kind: 'choice', options: [{ w: 10, item: { kind: 'custom', modules: [{ type: 'text', text: 'B' }] } }] }

test('队列只剩：步骤 + 倒计时页（开启时，排在最后）；没有常规页 / 概览页', () => {
  assert.deepEqual(makeQueue({ offworkOn: true, modelOn: true, items: [stepA, stepB] }).q(), [stepA, stepB, P.OFFWORK_PAGE])
  assert.deepEqual(makeQueue({ offworkOn: false, modelOn: true, items: [stepA, stepB] }).q(), [stepA, stepB])
  assert.deepEqual(makeQueue({ offworkOn: false, modelOn: true, items: [stepA] }).q(), [stepA])
  // 试播顶替整条队列（不含倒计时页）：设置页在验的只有自己编辑的那几步
  assert.deepEqual(makeQueue({ offworkOn: true, modelOn: true, items: [stepA, stepB], preview: [stepB] }).q(), [stepB])
  assert.equal('NORMAL_PAGE' in P, false)
  assert.equal('OVERVIEW_PAGE' in P, false)
})

test('倒计时页永远排第一张之外：第一页是步骤页，别处位置可解释', () => {
  // 三种开关组合，第一页都必须是步骤页；倒计时页只出现在末尾
  const combos = [
    { name: '只开报时 / 全关', opts: { offworkOn: false, modelOn: true, items: [stepA, stepB] } },
    { name: '只开倒计时', opts: { offworkOn: true, modelOn: true, items: [stepA, stepB] } },
    { name: '两个都开', opts: { offworkOn: true, modelOn: true, items: [stepA, stepB] } },
  ]
  for (const c of combos) {
    const q = makeQueue(c.opts).q()
    assert.equal(q[0], stepA, c.name + '：第一页应是步骤页')
    assert.notEqual(q[0], P.OFFWORK_PAGE, c.name + '：第一页不能是倒计时页')
    if (c.opts.offworkOn) assert.equal(q[q.length - 1], P.OFFWORK_PAGE, c.name + '：倒计时页应排在最后')
    else assert.equal(q.includes(P.OFFWORK_PAGE), false, c.name + '：没开就不该有倒计时页')
  }
  // 并列泡第一步：第一页仍是那张并列泡（抽到台词还是角色图都不影响位置）
  const dup = makeQueue({ offworkOn: true, modelOn: true, items: [stepB, stepA] }).q()
  assert.deepEqual(dup, [stepB, stepA, P.OFFWORK_PAGE])
  assert.equal(dup[0], stepB)
  assert.equal(P.isCustom(dup[0]), true, '并列泡也是步骤页')
  // 没有任何步骤时退化为只有倒计时页（否则整条队列为空，点气泡什么都不出）
  assert.deepEqual(makeQueue({ offworkOn: true, modelOn: true, items: [] }).q(), [P.OFFWORK_PAGE])
  assert.equal(makeQueue({ offworkOn: true, modelOn: true, items: [] }).q()[0], P.OFFWORK_PAGE)
})

test('bubble.on=false：用出厂默认队列 dft，不用用户改过的 items', () => {
  const dft = [stepA, stepB]
  assert.deepEqual(makeQueue({ offworkOn: false, modelOn: false, items: [stepB], dft }).q(), dft)
  // 倒计时页照样排在出厂默认两步之后
  assert.deepEqual(makeQueue({ offworkOn: true, modelOn: false, items: [stepB], dft }).q(), [stepA, stepB, P.OFFWORK_PAGE])
  // 宿主没下发 dft（旧版本 / 兜底）= 退回 items，至少不炸
  assert.deepEqual(makeQueue({ offworkOn: false, modelOn: false, items: [stepB] }).q(), [stepB])
  // 开关打开后回到用户编辑的那份
  assert.deepEqual(makeQueue({ offworkOn: false, modelOn: true, items: [stepB], dft }).q(), [stepB])
})

test('翻页顺序：第 1 步 → 第 2 步 → 末页返回 false（调用方收起）', () => {
  const s = makeQueue({ offworkOn: false, modelOn: false, dft: [stepA, stepB] })
  assert.equal(s.next(), true)
  assert.equal(s.idx(), 1)
  assert.deepEqual(s.rendered, [stepB])
  assert.equal(s.next(), false) // 末页：调用方 hideBubble
  assert.equal(s.idx(), 1)
  assert.deepEqual(s.armed, [9])
  // 带倒计时页：步骤先翻，最后才到倒计时页（非自定义页按 5s 口径停留）
  const s2 = makeQueue({ offworkOn: true, modelOn: false, dft: [stepA] })
  assert.equal(s2.next(), true)
  assert.equal(s2.idx(), 1)
  assert.deepEqual(s2.rendered, [P.OFFWORK_PAGE])
  assert.deepEqual(s2.armed, [5])
  assert.equal(s2.next(), false)
})

test('未开启自定义 + 默认 2 步：点一下 → 第 2 步；再点收起；重开回第 1 步', () => {
  const s = makeQueue({ offworkOn: false, modelOn: false, dft: [stepA, stepB] })
  assert.equal(s.q().length, 2) // 默认配置就是 2 步，不额外凑页
  assert.equal(s.next(), true)
  assert.equal(s.next(), false)
  // 收起时 bubbleActive 归假，下次点开 showNormalBubble 的索引复位语句把页面拉回第一页
  assert.match(page, /if \(!bubbleActive \|\| bubbleIdx >= q\.length\) \{ bubbleIdx = 0; bubbleLastOptionIdx = -1; \}/)
})

test('宿主下发 dft：只在 IPC 配置里附加，不落存储', () => {
  assert.match(widgetCfgSrc, /dft: normBubble\(null\)\.items/)
  assert.match(widgetCfgSrc, /module\.exports = function configForWidget\(\)/)
  // pushInit / pushConfig 都必须走 configForWidget，否则关掉自定义后拿不到出厂默认
  assert.match(widgetSrc, /require\('\.\/widget-config'\)/)
  assert.match(widgetSrc, /const cfg = configForWidget\(\)/)
  assert.match(widgetSrc, /sendToWidget\('whale:config', configForWidget\(\)\)/)
})

test('倒计时只在「停在倒计时页」时渲染：自定义步骤隐藏，临时接管全压过', () => {
  const canRenderSrc = extractFn('offworkCanRender')
  const factory = new Function(
    's', 'PAGES',
    [
      'var offworkOn = !!s.offworkOn;',
      'var bubbleTimerActive = !!s.timer;',
      'var bubbleRemindActive = !!s.remind;',
      'var bubblePreviewActive = !!s.preview;',
      'var bubbleRandomActive = !!s.random;',
      'var bubbleActive = !!s.active;',
      'var bubbleIdx = s.idx || 0;',
      'var bubbleItems = s.items || [];',
      'var bubbleModelOn = !!s.modelOn;',
      'var bubbleDefaultItems = s.dft || [];',
      'var bubblePreviewItems = null;',
      'var OFFWORK_PAGE = PAGES.OFFWORK_PAGE;',
      queueSrc,
      canRenderSrc,
      'return offworkCanRender();',
    ].join('\n'),
  )
  const base = { offworkOn: true, active: true, modelOn: true, items: [stepA] }
  assert.equal(factory({ ...base, idx: 0 }, P), false) // 第一页 = 步骤页：倒计时不渲染
  assert.equal(factory({ ...base, idx: 1 }, P), true) // 末页 = 倒计时页
  for (const flag of ['timer', 'remind', 'preview', 'random']) {
    assert.equal(factory({ ...base, idx: 1, [flag]: true }, P), false, flag + ' 应压过队列')
  }
})

test('临时接管者都清掉队列态（否则点击会被翻页分支截胡）', () => {
  assert.match(page, /bubbleTimerActive = true; bubbleActive = false; \/\/ 计时压过整条队列/)
  assert.match(page, /bubbleTimerActive = false; bubbleActive = false; \/\/ 提醒压过整条队列/)
  assert.match(page, /bubbleActive = false; bubbleRandomActive = true; \/\/ 临时接管/)
  // 点击链里「队列翻页」排在随机 / 计时 / 提醒之前，且只认 bubbleActive
  const flip = page.indexOf('if (bubbleActive) {')
  const takeover = page.indexOf('if (bubbleRandomActive || bubbleTimerActive) {')
  assert.ok(flip > 0 && takeover > flip, '翻页分支必须在临时接管分支之前')
  // render 的兜底顺序：计时 → 提醒 → 试播 → 队列当前页 → 随机台词
  const order = ['bubbleTimerActive && timerActive()', 'bubbleRemindActive && bubbleRemindLines',
    'bubblePreviewActive && previewSession', 'PAGES.isCustom(curPage)',
    'bubbleRandomActive && bubbleRandomLines'].map((s) => page.indexOf(s))
  assert.ok(order.every((p) => p > 0), 'render 兜底分支缺失')
  assert.deepEqual(order.slice().sort((x, y) => x - y), order, 'render 兜底分支顺序被改动')
})

test('页面里不再有概览页 / localParts 残留', () => {
  assert.doesNotMatch(page, /overviewData|overviewHasData|overviewRows|localParts|OVERVIEW_PAGE|NORMAL_PAGE/)
})

test('isCustom 只认没有 k 的自定义步骤，哨兵页不算', () => {
  assert.equal(P.isCustom(stepA), true)
  assert.equal(P.isCustom(stepB), true)
  assert.equal(P.isCustom(P.OFFWORK_PAGE), false)
  assert.equal(P.isCustom(null), false)
  assert.equal(P.isCustom(undefined), false)
})
