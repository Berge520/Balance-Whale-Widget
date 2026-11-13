// test/offwork-render.test.mjs
// 下班倒计时在气泡里的呈现方式：只占**它自己那一页**的标题行，且这一页排在所有步骤页之后。
//
// 历史：最早倒计时会把三行整体接管（用户反馈「只能看见下班倒计时」）；随后改成气泡下缘
// 外挂一行小字（那一条带内椭圆只有约 419u 宽，固定 780u 的单行会露到形状外）。
// 之后改为首行由倒计时占位、报时置灰让位；2026-11-08 试过「两者同时开、倒计时进说明行」，
// 2026-11-09 用户收紧口径：**第一张气泡的任何位置都不许出现倒计时** —— 说明行里的倒计时
// 附加项连同 offworkHintCountdown 一并删除，倒计时页后置到步骤页之后。
// 本文件钉住：第一页首行 / 说明行都不含倒计时、倒计时页位置在步骤页之后、
// 三种开关组合下第一页都不含倒计时、末页收起与重开回第一页、临近变色仍生效。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')
const rings = fs.readFileSync(new URL('../public/floating-rings.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../public/floating-bubble.css', import.meta.url), 'utf8')
// 外圈（dshwv-ring）的样式在 floating.css，不在气泡那份
const floatingCss = fs.readFileSync(new URL('../public/floating.css', import.meta.url), 'utf8')
const lookView = fs.readFileSync(new URL('../src/views/LookView.vue', import.meta.url), 'utf8')
// 三行主体由共享渲染器创建（挂件页只是取 els 后逐轮写文案）
const renderer = fs.readFileSync(new URL('../src/bubble/bubble-render.js', import.meta.url), 'utf8')
// 队列本体是纯函数（floating-pages.js 挂 window.WhalePages），可无桩直接跑
const pagesSrc = fs.readFileSync(new URL('../public/floating-pages.js', import.meta.url), 'utf8')
function loadPages() {
  const win = {}
  new Function('window', pagesSrc)(win)
  return win.WhalePages
}
// 圈的计算是真函数，直接跑（不靠正则猜）：floating-rings.js 只挂 window.WhaleRings
function loadRings() {
  const win = {}
  new Function('window', rings)(win)
  return win.WhaleRings
}

test('倒计时不接管金额：金额与说明始终来自余额状态', () => {
  // 旧实现会写 amountEl.textContent = ov.main / labelEl.textContent = ov.label，这里不允许再出现
  assert.doesNotMatch(page, /amountEl\.textContent = ov\.main/)
  assert.doesNotMatch(page, /labelEl\.textContent = ov\.label/)
  assert.doesNotMatch(page, /hint = offworkView\.hint/)
  // render() 里金额只有一个来源：mainAmountText()
  assert.match(page, /var realAmount = mainAmountText\(\);\s*var amount = realAmount;/)
  assert.doesNotMatch(page, /var amount = ov\.main/)
  assert.match(page, /amountEl\.textContent = amount;/)
  // 三行元素仍然建好并且每轮都写：标题 / 金额 / 说明一个都不少
  assert.match(renderer, /textBox\.appendChild\(labelEl\); textBox\.appendChild\(amountEl\); textBox\.appendChild\(hintEl\);/)
  assert.match(page, /var ovHint = baseHintText !== null && offworkCanRender\(\) \? offworkState\(\) : null;\n\s*setHint\(ovHint \? fitOffworkHint\('', ovHint\) : hint\);/)
})

test('标题行归属：倒计时页由倒计时占位，其余页 报时 > 「DeepSeek 余额」（两者不再互斥）', () => {
  // 停在倒计时页（bubbleActive 指着 OFFWORK_PAGE）标题行归倒计时，否则报时开着就由它占首行；
  // 两者都关才落到余额。倒计时不抢第一页 —— 第一页是步骤页，三行整体 display:none
  assert.match(page, /if \(offworkCanRender\(\) && \(bubbleActive \|\| !timeBubbleOn\)\) \{\s*var ov = offworkState\(\);[\s\S]*?return timeBubbleOn \? timeLabel\(\) : 'DeepSeek 余额';/)
  // 换主显模型时首行仍是模型名（倒计时 / 报时只属于内置 DeepSeek）
  assert.match(page, /if \(mainModelId !== 'deepseek'\) \{[\s\S]*?return \(m \? m\.name : '模型'\) \+ suffix;/)
  // 逐秒路径每秒都会重算首行：报时按分钟缓存，同一 HH:MM 不重抽台词（否则首行秒秒乱跳）
  assert.match(page, /if \(t === timeLblAt\) return timeLbl;/)
  assert.match(page, /timeLblAt = t;\s*return \(timeLbl = pickOne\(pool\)\.split\('\{t\}'\)\.join\(t\)\);/)
})

test('第一张气泡的任何位置都不含倒计时：第一页说明行仍是「今日已用 + 附加项」，倒计时页则不显示今日已用', () => {
  // 上一轮往说明行塞的「距下班01:02:10」已整体删除，不留函数 / 常量 / 两套逻辑
  assert.doesNotMatch(page, /offworkHintCountdown/)
  assert.doesNotMatch(pagesSrc, /offworkHintCountdown/)
  assert.doesNotMatch(page, /距下班' \+ ov\.main/)
  // 判重 key 只拼附加项（倒计时页的说明行没有「今日已用」底稿），没有任何倒计时片段
  assert.match(page, /var hintText = baseHintText === null \? '' : offworkHintParts\(ov\)\.join\('，'\);/)
  // 步骤页（= 第一页）根本不渲染三行：渲染器把标题 / 金额 / 说明一起 display:none，
  // 所以无论首行文案是什么，第一页都不可能看见倒计时
  assert.match(renderer, /labelEl\.style\.display = 'none';\s*amountEl\.style\.display = 'none';\s*hintEl\.style\.display = 'none';/)
  assert.match(page, /if \(PAGES\.isCustom\(curPage\)\) \{/)
})

test('倒计时页排在所有步骤页之后：第一页始终是步骤页', () => {
  const PAGES = loadPages()
  const stepA = { kind: 'custom', modules: [{ type: 'text', text: 'A' }] }
  const stepB = { kind: 'choice', options: [{ w: 10, item: { kind: 'custom', modules: [{ type: 'text', text: 'B' }] } }] }
  // 三种开关组合（只开报时 / 只开倒计时 / 两个都开）：第一页都是步骤页
  assert.deepEqual(PAGES.queue({ offworkOn: false, items: [stepA, stepB] }), [stepA, stepB])
  assert.deepEqual(PAGES.queue({ offworkOn: true, items: [stepA, stepB] }), [stepA, stepB, PAGES.OFFWORK_PAGE])
  // 并列泡当第一步：无论抽到台词还是角色图，第一页都是它，倒计时仍排最后
  assert.deepEqual(PAGES.queue({ offworkOn: true, items: [stepB, stepA] }), [stepB, stepA, PAGES.OFFWORK_PAGE])
  // 没有步骤可排时只剩倒计时页（此时不存在「第一页是步骤页」的条件）
  assert.deepEqual(PAGES.queue({ offworkOn: true, items: [] }), [PAGES.OFFWORK_PAGE])
  // 页面侧的装配：队列与推进都只吃 WhalePages 给的结果，不自己插队
  assert.match(page, /var items = bubbleModelOn \? bubbleItems : \(bubbleDefaultItems\.length \? bubbleDefaultItems : bubbleItems\);/)
  assert.match(page, /return bubblePreviewItems \|\| PAGES\.queue\(\{ offworkOn: offworkOn, items: items \}\);/)
})

test('末页收起与重开回第一页：索引复位语句仍在', () => {
  // 倒计时页在最后：末页再点收起（hideBubble），重开时从 0 开始，第一页仍是步骤页
  assert.match(page, /if \(!bubbleActive \|\| bubbleIdx >= q\.length\) \{ bubbleIdx = 0; bubbleLastOptionIdx = -1; \}/)
  assert.match(page, /function hideBubble\(\)/)
  assert.match(page, /bubbleActive = false;/)
})

test('标题行文案：只留「标签 + 倒计时」，不带上下班区间 / 距上班（简洁高效）', () => {
  assert.match(page, /function offworkTitleText\(ov\)/)
  assert.doesNotMatch(page, /var base = String\(ov\.hint \|\| ''\)\.split\(' · '\)\[0\];/)
  assert.doesNotMatch(page, /var right = ov\.phase === 'work'/)
  // 下班 08:12:34
  assert.match(page, /return label \+ ' ' \+ ov\.main;\n/)
  // 小趣味只在标题行：最后 10 分钟换「快到点了」，已下班 / 休息日补半句口语（不弹窗、不响铃）
  assert.match(page, /var label = ov\.phase === 'work' && ov\.near === 'imminent' \? '快到点了' : ov\.label;/)
  assert.match(page, /if \(ov\.phase === 'after'\) label = '已下班 溜了溜了';/)
  assert.match(page, /if \(ov\.phase === 'off'\) label = '休息日 葛优躺中';/)
})

test('倒计时页不显示余额：只切 display 不删内容，切页 / 接管后复原', () => {
  // 统一判据：真的渲染倒计时页才藏（用户 2026-11-09）
  assert.match(page, /function offworkHidesAmount\(\) \{ return !!OFFWORK_CORE && offworkCanRender\(\); \}/)
  // 两处入口各复核一次：render() 默认分支（切页进来时）+ 逐秒的 applyOffworkView（key 里也带上，翻回来要重刷）
  assert.match(page, /amountEl\.style\.display = offworkHidesAmount\(\) \? 'none' : '';/)
  assert.match(page, /var hideAmt = offworkHidesAmount\(\);\s*var key = title \+ '\|' \+ hintText \+ '\|' \+ \(ov\.near \|\| ''\) \+ '\|' \+ \(hideAmt \? 1 : 0\);/)
  assert.match(page, /var amtDisplay = hideAmt \? 'none' : '';[^\n]*\n\s*if \(amountEl\.style\.display !== amtDisplay\) amountEl\.style\.display = amtDisplay;/)
  // 不碰 textContent：金额文本留给别的页与计时复用
  assert.doesNotMatch(page, /amountEl\.textContent = ''/)
  // 复原：接管内容与退出气泡都写回 ''
  assert.match(page, /amountEl\.style\.display = '';/)
})

test('设置页与菜单都不再因倒计时置灰报时：改成可同时勾选并说明各自显示在哪', () => {
  // 只有「按压气泡」接管内容才是真正的报时失效，倒计时不再参与置灰
  assert.match(lookView, /:disabled="bubbleModelOn"/)
  assert.doesNotMatch(lookView, /:disabled="bubbleModelOn \|\| cfg\.offworkOn === true"/)
  assert.doesNotMatch(lookView, /v-if="bubbleModelOn \|\| cfg\.offworkOn === true"/)
  assert.doesNotMatch(lookView, /倒计时优先，报时不再显示/)
  // 倒计时开着时的说明文字要讲清分工：倒计时只在最后一张独立页，第一页是步骤页
  assert.match(lookView, /<p v-else-if="cfg\.offworkOn === true" class="hint">已开启「下班倒计时」，两者可同时生效/)
  assert.doesNotMatch(lookView, /倒计时改到说明行/)
  assert.doesNotMatch(lookView, /距下班01:02:10/)
  // 右键菜单里的报时开关也不再置灰（曾经置灰是因为首行被倒计时占用）
  assert.doesNotMatch(page, /timeToggle\.disabled = offworkOn;/)
  assert.doesNotMatch(page, /下班倒计时占用气泡首行/)
})

test('说明行：最多一项附加项（周末 / 发薪 → 今日已赚），倒计时页不显示今日已用', () => {
  // 周末 / 发薪由 offwork.display 按 ' · ' 追在 hint 尾部，这里取尾段
  assert.match(page, /var list = String\(\(ov && ov\.hint\) \|\| ''\)\.split\(' · '\)\.slice\(1\);/)
  // 今日已赚只在有值时、且周末 / 发薪都没开时顶上（一行一项，用户 2026-11-09 要求简洁高效），遮蔽共用 hideAmounts
  assert.match(page, /if \(earned !== null && !list\.length\) list\.push\(hideAmounts \? '今日已赚 \*\*\*' : '今日已赚 ≈ ' \+ fmt\(earned, 'CNY'\)\);/)
  // 接在「今日已用」之后（倒计时页渲染时底稿被换成空串，只留附加项）
  assert.match(page, /baseHintText = note \? null : usedTodayText\(usedText\)/)
  assert.match(page, /var ovHint = baseHintText !== null && offworkCanRender\(\) \? offworkState\(\) : null;\n\s*setHint\(ovHint \? fitOffworkHint\('', ovHint\) : hint\);/)
  assert.doesNotMatch(page, /var ov2 = /)
  // 倒计时页不显示「今日已用」：底稿一律传空串（用户 2026-11-09 要求）
  assert.doesNotMatch(page, /fitOffworkHint\(baseHintText/)
  // 错误 / 加载中 / 别的模型 / 调整说明都不追加
  assert.match(page, /hint = modelDisplay\(\)\.hint;\s*baseHintText = null;/)
  assert.match(page, /hint = state\.message \? state\.message\.slice\(0, 14\) : '获取失败 · 点击重试';\s*baseHintText = null;/)
  assert.match(page, /hint = '加载中…';\s*baseHintText = null;/)
  assert.match(page, /baseHintText = note \? null : usedTodayText/)
})

test('说明行最多两行：超出按优先级从尾巴整项丢、留 tooltip、硬钳两行', () => {
  // 附加项用「，」分隔（间隔号太宽）；底稿为空时不留前导分隔符。现在正常最多一项，
  // 这段循环是多行 / 窄宽度的兜底，保留完整丢弃链
  // 丢弃顺序 今日已赚 → 发薪 → 周末（倒计时不在这一行）
  assert.match(page, /var full = base \+ \(parts\.length \? \(base \? '，' : ''\) \+ parts\.join\('，'\) : ''\);/)
  assert.match(page, /text = keep \? base \+ \(base \? '，' : ''\) \+ parts\.slice\(0, keep\)\.join\('，'\) : base;/)
  // 三行会把文字顶出椭圆内壁，不缩字号硬塞：按 offsetHeight 超两行就整项丢尾巴
  assert.match(page, /if \(!keep \|\| !lh \|\| hintEl\.offsetHeight <= lh \* 2 \+ 1\) break;/)
  assert.match(page, /if \(text !== full\) hintEl\.title = full;/)
  assert.match(page, /hintEl\.classList\.toggle\('dshwv-hint-clamp', text !== full\);/)
  assert.match(css, /\.dshwv-hint\.dshwv-hint-clamp \{[\s\S]*?-webkit-line-clamp: 2;[\s\S]*?overflow: hidden;/)
  // 宽度必须走 CSS 类：fitBlock 每轮都会把行内 max-width 复位，行内写法等于没写
  assert.match(css, /\.dshwv-hint\.dshwv-hint-offwork \{ max-width: calc\(var\(--dshw-u\) \* 520\); color: var\(--dshwv-text, #536ba9\); opacity: \.82; \}/)
  assert.match(page, /hintEl\.classList\.add\('dshwv-hint-offwork'\);/)
  // 上一轮截断兜底留下的内联 nowrap 会让量高恒等于一行，量之前必须清掉
  assert.match(page, /hintEl\.style\.whiteSpace = ''; \/\/ 上一轮截断兜底/)
  assert.match(page, /hintEl\.classList\.remove\('dshwv-hint-offwork', 'dshwv-hint-clamp'\);/)
})

test('说明行金额不拆行：符号与数字之间用不换行空格，量高前先转', () => {
  // 真机截图：「今日已用 ¥ 0.00」在 ¥ 后折行，数字被甩到下一行；符号后的空格改 NBSP
  assert.match(
    page,
    /function noBreakMoney\(s\) \{ return String\(s\)\.replace\(\/\(\[¥\$￥\]\)\\s\+\(\?=\\d\)\/g, '\$1\\u00A0'\); \}/,
  )
  // 常规三行（setHint）与倒计时逐秒（setHintDirect）两条写入路径都要转：
  // 后者决定 fitOffworkHint 量到的高度，转晚了会按「数字被拆开」的假行数判通过
  assert.match(page, /function setHint\(text\) \{\s*text = noBreakMoney\(text\);/)
  assert.match(page, /function setHintDirect\(text\) \{\s*text = noBreakMoney\(text\);/)
  // fmt() 的通用输出不动：复制到剪贴板的金额仍要普通空格
  assert.match(page, /return currency === 'CNY' \? '¥ ' \+ fixed : fixed \+ ' ' \+ currency;/)
})

test('旧附加行已移除：无元素、无样式，临近配色只落在倒计时页的标题行', () => {
  assert.doesNotMatch(page, /offworkLineEl/)
  assert.doesNotMatch(page, /function offworkLineText/)
  assert.doesNotMatch(css, /dshwv-offwork-line/)
  // 旧「接管主体」的样式也不能残留，否则两套形态同时存在
  assert.doesNotMatch(css, /dshwv-offwork-earned/)
  assert.doesNotMatch(css, /\.dshwv-root\.dshwv-offwork \.dshwv-amount/)
  // 最后 30 / 10 分钟的提示只染倒计时页的标题行（near 两个类只在 offworkCanRender 时存在，
  // 第一页是步骤页、不渲染三行，自然不会变色）
  assert.match(css, /\.dshwv-root\.dshwv-offwork-soon \.dshwv-label \{ color: #d9821a; \}/)
  assert.match(css, /\.dshwv-root\.dshwv-offwork-imminent \.dshwv-label \{/)
  // 上一轮为「倒计时进说明行」加的分流类必须整体消失，不能留两套染色逻辑
  assert.doesNotMatch(css, /dshwv-offwork-hint/)
  assert.doesNotMatch(page, /dshwv-offwork-hint/)
  // 进度条保留（细条不占文字高度），圈已画同一份进度时收掉细条，圈不画时细条兜底
  assert.match(css, /\.dshwv-offwork-progress \{/)
  assert.match(page, /offworkBarEl\.style\.display = offworkOwnsRing\(\) \? 'none' : '';/)
})

test('开关关闭后首行与附加项恢复：走 render 统一回填', () => {
  // offworkOn 为假恒不渲染；自定义泡泡不再参与这条判定（同队列共存）
  assert.match(page, /return !!offworkOn && !bubbleTimerActive/)
  assert.match(page, /\(!bubbleActive \|\| bubbleQueue\(\)\[bubbleIdx\] === OFFWORK_PAGE\)/)
  assert.match(
    page,
    /applyOffworkNear\(null\);\s*updateOffworkProgress\(\); \/\/ 关掉倒计时后同步隐藏进度条\s*if \(!timerRunning && !timerPaused\) setRing\(false\);[\s\S]*?render\(\);/,
  )
  assert.match(page, /labelEl\.textContent = defaultLabelText\(\);/)
})

test('鲸鱼外的进度圈：计时未跑时改画当日工时进度，计时进行/暂停时归计时', () => {
  // 同一只 svg（dshwv-ring）两用：先判归属，倒计时接管时走 updateOffworkRing 并按秒重画。
  // 外圈预览只排在两者之后（都不在画圈时才轮到它），不改变「计时 / 倒计时优先」的归属顺序
  assert.match(
    page,
    /function updateTimerRing\(\) \{\n\s*if \(ringPreviewState && !offworkOwnsRing\(\) && !timerRunning && !timerPaused\) \{ \/\/[^\n]*\n[\s\S]*?\n\s*\}\n\s*if \(offworkOwnsRing\(\)\) \{ updateOffworkRing\(\); return; \}\n\s*if \(!timerRunning && !timerPaused\) \{ setRing\(false\); return; \}/,
  )
  // 归属条件：用户没关「显示进度圈」、倒计时可渲染、且计时既没在跑也没暂停
  assert.match(
    page,
    /return offworkRing && !!OFFWORK_CORE && offworkCanRender\(\) && !timerRunning && !timerPaused;/,
  )
  // 剩余比例 = 1 − 当日工时进度；配色随剩余工时由蓝转琥珀，最后 30 分钟橙红 + 呼吸；
  // 进度算不出来就收圈；已下班（phase 'after'，进度恒 100%）也收整只圈 —— 否则填充画到 0、
  // 灰色轨道还留着，看起来就是「圈没消失」
  assert.match(page, /if \(!p \|\| p\.phase === 'after'\) \{ setRing\(false\); return; \}\s*var ov = offworkState\(\);/)
  // 剩余比例 / 圈色 / 呼吸三件事只在 rings 里算一次（workFrame），页面不再自己拼 setRing 参数
  assert.match(page, /var f = WHALE_RINGS\.workFrame\(\{ s: p, near: !!\(ov && ov\.near\) \}, ringTheme\(\)\);\s*setRing\(true, f\.color, f\.pct, f\.hot\);/)
  assert.match(page, /var p = OFFWORK_CORE\.dayProgress\(Date\.now\(\), offworkCfgObj\(\)\);/)
  // 逐秒重画挂在 applyOffworkView 上（不受文本判重影响），气泡收起时由 offworkStep 续画
  assert.match(page, /if \(offworkOwnsRing\(\)\) updateOffworkRing\(\);/)
  assert.match(page, /if \(!bubbleActive\) updateTimerRing\(\);/)
  // 计时同理：归属判定与原始量留在页面，口径与配色走 rings.timerFrame
  assert.match(page, /var f = WHALE_RINGS\.timerFrame\(\{[\s\S]*?\}, ringTheme\(\)\);\s*setRing\(true, f\.color, f\.pct, f\.hot\);/)
  // 绘制与计时进度计算在 floating-rings.js：专注蓝与三种计时的进度口径都钉在那
  assert.match(rings, /window\.WhaleRings = \{\s*setRing: setRing, setWidth: setWidth, timerColor: timerColor, timerPct: timerPct, workColor: workColor,\s*timerFrame: timerFrame, workFrame: workFrame, previewColor: previewColor, RING_WIDTHS: RING_WIDTHS,\s*PREVIEW_PCT: PREVIEW_PCT,\s*\};/)
  assert.match(rings, /if \(s\.totalSec > 0\) \{\s*pct = s\.remain \/ \(s\.totalSec \* 1000\);/)
  // 圈色阶段：过半前专注蓝、最后 30 分钟橙红；呼吸只动 stroke-opacity（svg 的 opacity 归 active 淡入）
  assert.match(rings, /if \(near\) return ringColor\(HOT_RED, theme\);\s*s = Math\.max\(0, Math\.min\(1, Number\(s\) \|\| 0\)\);\s*if \(s >= 0\.5\) return ringColor\(BLUE, theme\);/)
  assert.match(rings, /ringSvg\.classList\.toggle\('dshwv-ring-hot', hot === true\);/)
  assert.match(rings, /ringSvg\.classList\.remove\('dshwv-ring-active', 'dshwv-ring-hot'\);/)
  assert.match(floatingCss, /\.dshwv-ring\.dshwv-ring-hot \.dshwv-ring-fill \{ animation: whale-ring-hot 1\.6s ease-in-out infinite; \}/)
  assert.match(floatingCss, /@keyframes whale-ring-hot \{ 50% \{ stroke-opacity: \.45; \} \}/)
  // 计时阶段色只定义一处：专注蓝 / 短休绿 / 长休琥珀共用同一组常量
  assert.match(rings, /var BLUE = '#4a90d9', GREEN = '#2fa24c', AMBER = '#e8a317', HOT_RED = '#e0433f';/)
  assert.match(rings, /if \(!s\.isBreak\) return ringColor\(BLUE, theme\);/)
  assert.match(rings, /return ringColor\(\(s\.pomoOn && s\.longBreak\) \? AMBER : GREEN, theme\);/)
})

test('圈的算法直接跑：计时与倒计时共用一套帧口径，深色主题换亮一档、浅底压深一档、樱花 / 未至之境各有手调档', () => {
  const R = loadRings()
  const sunk = (c) => 'rgb(' + [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * 0.88)).join(',') + ')'
  // 剩余比例 = 1 − 当日工时进度；临近档同时决定橙红与呼吸，两者不能各判一次
  // 不传主题（跟随关掉）= 原色口径；浅底主题（default / sakura）见下
  assert.deepEqual(R.workFrame({ s: { pct: 25 }, near: false }, null), { pct: 0.75, color: '#4a90d9', hot: false })
  const near = R.workFrame({ s: { pct: 80 }, near: true }, null)
  assert.ok(Math.abs(near.pct - 0.2) < 1e-9, '剩余比例应为 0.2')
  assert.deepEqual({ color: near.color, hot: near.hot }, { color: '#e0433f', hot: true })
  assert.deepEqual(R.workFrame({ s: { pct: 25 }, near: false }, 'default'), { pct: 0.75, color: sunk('#4a90d9'), hot: false })
  // 过半后由蓝线性过渡到琥珀：刚过半仍是蓝，越接近下班越偏琥珀（终点 96% 已很接近琥珀的暖色），
  // 还没到临近档不会直接跳橙红
  assert.equal(R.workFrame({ s: { pct: 50 }, near: false }, 'default').color, sunk('#4a90d9'))
  const warm = R.workFrame({ s: { pct: 96 }, near: false }, 'default').color.match(/^rgb\((\d+),(\d+),(\d+)\)$/).slice(1).map(Number)
  assert.ok(warm[0] > 160 && warm[2] < 80, '接近下班时应明显偏暖：' + warm)
  assert.equal(R.workFrame({ s: { pct: 0 }, near: false }, 'default').color, sunk('#4a90d9'))
  // 计时：专注蓝 → 剩余/总量；正计时按 60 分钟循环；休息轮短休绿、长休琥珀；计时永不呼吸
  assert.deepEqual(R.timerFrame({ isBreak: false, mode: 'down', remain: 75000, totalSec: 300 }, 'default'), { pct: 0.25, color: sunk('#4a90d9'), hot: false })
  assert.equal(R.timerFrame({ isBreak: true, pomoOn: false, mode: 'down', remain: 60000, totalSec: 300 }, 'default').color, sunk('#2fa24c'))
  assert.equal(R.timerFrame({ isBreak: true, pomoOn: true, longBreak: true, mode: 'down', remain: 60000, totalSec: 300 }, 'default').color, sunk('#e8a317'))
  assert.equal(R.timerFrame({ isBreak: false, mode: 'up', running: true, elapsed: 90 * 60000, startAt: 0, now: 0 }).pct, 0.5)
  assert.equal(R.timerFrame({ isBreak: false, mode: 'at', remain: 250, atSpan: 1000 }).pct, 0.75)
  // 深色主题：固定阶段色换成更亮的一档
  assert.equal(R.timerColor({ isBreak: false }, 'dark'), '#7db4f0')
  assert.equal(R.timerFrame({ isBreak: true, pomoOn: true, longBreak: true, mode: 'down', remain: 1, totalSec: 2 }, 'dark').color, '#ffc247')
  assert.equal(R.workFrame({ s: { pct: 90 }, near: true }, 'dark').color, '#ff6b66')
  assert.equal(R.workFrame({ s: { pct: 25 }, near: false }, 'dark').color, '#7db4f0')
  // 过渡段（过半到下班）深色下也要提亮：早先 workColor 自己拼 rgb() 串、绕过 ringColor，
  // 深色主题下整段返回原色，后半段黄绿压在深底上几乎看不见。现在逐点都比浅色亮
  // 过渡段的取值是 rgb() 串、档位色是十六进制，比对前统一成数组
  const rgbOf = (c) => (c.charAt(0) === '#' ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : c.match(/^rgb\((\d+),(\d+),(\d+)\)$/).slice(1).map(Number))
  for (const s of [0.45, 0.4, 0.3, 0.2, 0.1, 0.05]) {
    const light = rgbOf(R.workColor(s, false, 'default'))
    const dark = rgbOf(R.workColor(s, false, 'dark'))
    assert.ok(dark.every((c, i) => c >= light[i]), `s=${s} 深色应不比浅色暗：${light} → ${dark}`)
    assert.ok(dark.reduce((a, b) => a + b, 0) > light.reduce((a, b) => a + b, 0), `s=${s} 深色应整体更亮`)
  }
  // 端点对齐档位色：起步接专注蓝、末尾接长休琥珀，切档不跳色
  assert.equal(R.workColor(0.5, false, 'dark'), '#7db4f0')
  assert.deepEqual(rgbOf(R.workColor(0, false, 'dark')), rgbOf('#ffc247'))
  // 浅底也压深一档（亮蓝亮橙压在浅白气泡上太抢眼）：固定阶段色比原色暗，
  // 过渡段首尾与相邻档位一致（终点 = 压暗后的琥珀，与长休琥珀同一取值）
  const sink2 = (c) => rgbOf(c).map((x) => Math.round(x * 0.88))
  assert.deepEqual(rgbOf(R.workColor(0.5, false, 'default')), sink2('#4a90d9'))
  assert.deepEqual(rgbOf(R.timerFrame({ isBreak: true, pomoOn: true, longBreak: true, mode: 'down', remain: 1, totalSec: 2 }, 'default').color), sink2('#e8a317'))
  assert.deepEqual(rgbOf(R.workColor(0, false, 'default')), sink2('#e8a317'))
  // 主题个性化：樱花 / 未至之境各有一组手调档，且与通用口径都不同（否则「个性化」名不副实）
  assert.equal(R.timerColor({ isBreak: false }, 'sakura'), '#b8567f')
  assert.equal(R.timerColor({ isBreak: false }, 'fantasy'), '#5b93ff')
  assert.notEqual(R.timerColor({ isBreak: false }, 'sakura'), R.timerColor({ isBreak: false }, 'default'))
  assert.notEqual(R.timerColor({ isBreak: false }, 'fantasy'), R.timerColor({ isBreak: false }, 'dark'))
  // 插值端点一律取各自主题的档位色：樱花两头都是手调档（#b8567f → #c8821a），
  // 未至之境蓝取品牌蓝亮版、琥珀沿用通用提亮档
  assert.deepEqual(rgbOf(R.workColor(0.5, false, 'sakura')), rgbOf('#b8567f'))
  assert.deepEqual(rgbOf(R.workColor(0, false, 'sakura')), rgbOf('#c8821a'))
  assert.equal(R.workColor(0.5, false, 'fantasy'), '#5b93ff')
  assert.deepEqual(rgbOf(R.workColor(0, false, 'fantasy')), rgbOf('#ffc247'))
  // 明暗判据挂在页面：跟随开 → 传当前气泡主题；关 → null（= 原色，早先恒浅色口径反而会压暗）
  assert.match(page, /function ringTheme\(\) \{ return ringFollowTheme \? themeId : null; \}/)
  assert.match(page, /if \(offworkOwnsRing\(\)\) \{ updateOffworkRing\(\); return; \}/)
})

test('改气泡配色的预览：圈色跟随开着时连同圈色一起亮，关着时不亮', () => {
  // 同一条 theme-preview 指令：气泡换色预览之外，跟随开着还要亮一次圈 —— 圈色本就按主题取，
  // 用户换樱花 / 未至之境时看不见圈色变化会以为「专属配色没生效」
  assert.match(
    page,
    /themePreview\.start\(data\.payload && data\.payload\.theme, data\.payload && data\.payload\.ms\);[\s\S]{0,400}?if \(ringFollowTheme\) startRingPreview\(data\.payload && data\.payload\.ms\);/,
  )
  // 画的是新主题的色：start() 内部先换 themeId，ringTheme() 随之返回新主题，圈预览取色不需要另传
  assert.match(page, /function ringTheme\(\) \{ return ringFollowTheme \? themeId : null; \}/)
  assert.match(page, /WHALE_RINGS\.previewColor\(ringTheme\(\)\)/)
})

test('进度圈可自由开关：关掉后圈只归计时，工时进度改看倒计时页里的细进度条', () => {
  const offworkCore = fs.readFileSync(new URL('../public/preload/lib/offwork.js', import.meta.url), 'utf8')
  const store = fs.readFileSync(new URL('../public/preload/lib/store.js', import.meta.url), 'utf8')
  const offworkView = fs.readFileSync(new URL('../src/views/OffworkView.vue', import.meta.url), 'utf8')
  // 默认开（老配置里没有这个键时行为不变），新旧键名都认
  assert.match(offworkCore, /ring: true,/)
  assert.match(offworkCore, /ring: pick\('ring', 'offworkRing'\) !== false,/)
  // 配置要真的落盘：默认值 / 读入 / patch 三处都得有，缺一个就会被白名单拒掉
  assert.match(store, /offworkRing: true,/)
  assert.match(store, /offworkRing: (p|cfg)\.offworkRing !== false,/)
  assert.match(store, /if \(p\.offworkRing !== undefined\) cfg\.offworkRing = p\.offworkRing !== false/)
  // 挂件页：状态变量、下发进 offworkCfgObj、收到配置后同步
  assert.match(page, /var offworkRing = OFFWORK_DEFAULTS\.ring !== false;/)
  assert.match(page, /showSec: offworkShowSec, ring: offworkRing, weekendOn: offworkWeekendOn,/)
  assert.match(page, /if \(cfg\.offworkRing !== undefined\) \{[\s\S]*?offworkRing = rg;/)
  // 关掉时不画圈，也不新造一条进度条 —— 工时进度仍看倒计时页的 .dshwv-offwork-progress
  assert.match(page, /function updateOffworkRing\(\) \{\s*\/\/[^\n]*\n\s*if \(!offworkOwnsRing\(\)\) \{ setRing\(false\); return; \}/)
  assert.doesNotMatch(page, /dshwv-offwork-bar/)
  assert.doesNotMatch(floatingCss, /dshwv-offwork-bar/)
  // 设置页有对应勾选框，文案说清关掉后怎么看进度
  assert.match(offworkView, /挂件外圈进度圈/)
  assert.match(offworkView, /@change="onCheck\('offworkRing', \$event\)"/)
})

test('外圈画法两键（粗细 / 跟随主题）：默认值不变、四处同步、样式走变量', () => {
  const store = fs.readFileSync(new URL('../public/preload/lib/store.js', import.meta.url), 'utf8')
  const lookView = fs.readFileSync(new URL('../src/views/LookView.vue', import.meta.url), 'utf8')
  const rings = fs.readFileSync(new URL('../public/floating-rings.js', import.meta.url), 'utf8')
  // 默认值与旧行为一致：标准 3.5、跟随主题开（缺键即开）；三处归一都走同一个函数
  assert.match(store, /ringWidth: 'normal', ringFollowTheme: true,/)
  assert.match(store, /function normRingWidth\(v\) \{\s*return v === 'thin' \|\| v === 'thick' \? v : 'normal'\s*\}/)
  assert.equal((store.match(/normRingWidth\((p|cfg)\.ringWidth\)/g) || []).length, 3)
  assert.match(store, /ringFollowTheme: p\.ringFollowTheme !== false,/)
  assert.match(store, /ringFollowTheme: cfg\.ringFollowTheme !== false,/)
  assert.match(store, /if \(p\.ringFollowTheme !== undefined\) cfg\.ringFollowTheme = p\.ringFollowTheme !== false/)
  // 三档换算表只在 rings 里一份，页面经 setWidth 写内联变量；CSS 缺省值仍是 3.5。
  // 相邻档必须拉得开（细档 2.5 与标准 3.5 只差 1px 肉眼看不出，现为 1.75 / 3.5 / 6）
  assert.match(rings, /var RING_WIDTHS = \{ thin: 1\.75, normal: 3\.5, thick: 6 \};/)
  assert.match(rings, /ringSvg\.style\.setProperty\('--dshw-ring-width', String\(RING_WIDTHS\[key\]\)\)/)
  assert.match(rings, /setRing: setRing, setWidth: setWidth,/)
  assert.match(floatingCss, /stroke-width: var\(--dshw-ring-width, 3\.5\)/)
  // 页面：状态变量、每秒画圈前先同步粗细、收到配置后同步
  assert.match(page, /var ringWidth = 'normal';\s*\n\s*var ringFollowTheme = true;/)
  assert.match(page, /function syncRingWidth\(\) \{ WHALE_RINGS\.setWidth\(ringSvg, ringWidth\); \}/)
  assert.match(page, /if \(cfg\.ringWidth !== undefined\) \{[\s\S]*?ringWidth = rw;/)
  assert.match(page, /if \(cfg\.ringFollowTheme !== undefined\) \{[\s\S]*?ringFollowTheme = rf;/)
  // 设置页：两个控件都归「挂件外观」卡（共用一圈，样式不归某一种用途）
  assert.match(lookView, /外圈粗细/)
  assert.match(lookView, /onRingPatch\(\{ ringWidth: /)
  assert.match(lookView, /圈色跟随气泡主题/)
  assert.match(lookView, /onRingPatch\(\{ ringFollowTheme: /)
})

test('改外圈样式后挂件临时亮一圈几秒做预览：只显示不落盘，不抢计时 / 倒计时的圈', () => {
  const ipc = fs.readFileSync(new URL('../public/preload/lib/ipc.js', import.meta.url), 'utf8')
  const settings = fs.readFileSync(new URL('../public/preload/lib/settings.js', import.meta.url), 'utf8')
  const lookView = fs.readFileSync(new URL('../src/views/LookView.vue', import.meta.url), 'utf8')
  // 设置页：改完配置后请求预览，宿主没挂（旧版设置页）就静默跳过，不影响设置本身
  assert.match(lookView, /function onRingPatch\(p: Record<string, unknown>\) \{[\s\S]*?emit\('patch', p\)[\s\S]*?window\.services\?\.ringPreview\?\.\(\{ ms: 3200 \}\)/)
  // 宿主：窗口在但不可见也算「未显示」（窗口存在 ≠ 可见），否则用户看不到还回 ok
  assert.match(settings, /ringPreview\(p\) \{ return this\.cmdPreview\(\{ cmd: 'ring-preview', ms: Math\.round\(Number\(p && p\.ms\)\) \}\) \}/)
  assert.match(settings, /cmdPreview\(p\) \{\n[\s\S]*?getWindow\(\)\.isVisible\(\)[\s\S]*?sendToWidget\('whale:cmd', \{ cmd: p\.cmd, payload: p \}\)/)
  // 页面：收到指令起预览，到时自动收起并交回归属方
  assert.match(page, /data\.cmd === 'ring-preview'[\s\S]*?startRingPreview\(data\.payload && data\.payload\.ms\)/)
  assert.match(page, /function startRingPreview\(ms\) \{[\s\S]*?setTimeout\(ringPreviewEnd, dur\)/)
  assert.match(page, /dur > 20000\) dur = 3200/)
  // 交回归属方：清预览状态后立刻重画一圈（在跑计时 / 倒计时就接着画它们，否则收起）
  assert.match(page, /function ringPreviewEnd\(\) \{[\s\S]*?ringPreviewState = null; updateTimerRing\(\);/)
  // 归属方优先：计时有跑 / 倒计时该画圈时预览不抢圈；预览底色取 rings.previewColor（与真实专注轮同源），画 3/4 圈
  assert.match(page, /if \(ringPreviewState && !offworkOwnsRing\(\) && !timerRunning && !timerPaused\) \{/)
  assert.match(page, /setRing\(true, WHALE_RINGS\.previewColor\(ringTheme\(\)\), WHALE_RINGS\.PREVIEW_PCT, false\)/)
  const rings = fs.readFileSync(new URL('../public/floating-rings.js', import.meta.url), 'utf8')
  assert.match(rings, /function previewColor\(theme\) \{ return timerColor\(\{ isBreak: false \}, theme\); \}/)
  // 预览进度 0.75（留 1/4 缺口）只在 rings 定义一处
  assert.match(rings, /var PREVIEW_PCT = 0\.75;/)
  // 预览请求走既有通用指令通道，不新开 IPC
  assert.ok(ipc.includes('whale:config'))
})

test('改气泡配色后挂件按新主题临时亮几秒：只换渲染主题不落盘，结束时回落配置值', () => {
  const settings = fs.readFileSync(new URL('../public/preload/lib/settings.js', import.meta.url), 'utf8')
  const lookView = fs.readFileSync(new URL('../src/views/LookView.vue', import.meta.url), 'utf8')
  // 设置页：先请求预览再落盘（反过来的话配置推送会立刻把主题定成新值，看不到「亮一下」）
  assert.match(lookView, /function onThemeChange\(theme: string\) \{\n\s*try \{ window\.services\?\.themePreview\?\.\(\{ theme, ms: 3200 \}\) \} catch \{ \/\*[^\n]*\*\/ \}\n\s*emit\('patch', \{ theme \}\)/)
  assert.match(lookView, /<select :value="cfg\.theme" @change="onThemeChange\(\(\$event\.target as HTMLSelectElement\)\.value\)">/)
  // 宿主：归一到 cmdPreview（与 ringPreview 同口径：探 isVisible、走 whale:cmd），失败由设置页静默忽略
  assert.match(settings, /themePreview\(p\) \{ return this\.cmdPreview\(\{ cmd: 'theme-preview', theme: String\(\(p && p\.theme\) \|\| ''\), ms: Math\.round\(Number\(p && p\.ms\)\) \}\) \}/)
  assert.match(settings, /cmdPreview\(p\) \{\n[\s\S]*?getWindow\(\)\.isVisible\(\)[\s\S]*?sendToWidget\('whale:cmd', \{ cmd: p\.cmd, payload: p \}\)/)
  // 页面：指令分发到状态机；页面只做装配（状态机在 floating-theme-preview.js）
  assert.match(page, /data\.cmd === 'theme-preview'[\s\S]*?\n\s*themePreview\.start\(data\.payload && data\.payload\.theme, data\.payload && data\.payload\.ms\);/)
  assert.match(page, /var themePreview = window\.WhaleThemePreview\(function \(\) \{ return themeId; \}, function \(id\) \{ themeId = id; \}, applyTheme,\n\s*function \(open\) \{ if \(open\) showNormalBubble\(undefined, true\); else hideBubble\(\); \}\);/)
  // 只换 CSS 变量用户根本看不见（气泡平常收着，见 bubbleOn），故预览期间必须真把气泡弹出来：
  // 绕过 bubbleOn 总闸的 force 分支只在 showNormalBubble 一处，收泡统一走 hideBubble
  assert.match(page, /function showNormalBubble\(onExpire, force\) \{\n\s*if \(!bubbleOn && !force\) return;/)
  // 气泡被谁收起（用户点击 / bubbleArm 到点 / 预览结束）都要复位预览标记，否则下次开预览会被当成「已弹着」而跳过
  assert.match(page, /bubbleShown = false;\n\s*themePreview\.shown = false;/)
  assert.match(page, /if \(typeof cfg\.theme === 'string'\) themePreview\.applyConfig\(cfg\.theme\);/)
  // 脚本引入顺序：状态机必须在 floating-page.js 之前
  const html = fs.readFileSync(new URL('../public/floating.html', import.meta.url), 'utf8')
  assert.ok(html.indexOf('./floating-theme-preview.js') > 0
    && html.indexOf('./floating-theme-preview.js') < html.indexOf('./floating-page.js'), 'floating-theme-preview.js 必须在 floating-page.js 之前引入')
  // 状态机：非法主题不动、时长缺省 3200 / 上限 20000、到时回落到配置里的主题
  const themePrev = fs.readFileSync(new URL('../public/floating-theme-preview.js', import.meta.url), 'utf8')
  assert.match(themePrev, /window\.WhaleThemePreview = function \(getTheme, setTheme, repaint, onOpen\) \{/)
  // 预览开始弹泡、到点收泡；连改几档时 shown 去重，不重复重画
  assert.match(themePrev, /open: function \(v\) \{\n\s*if \(!!v === api\.shown\) return;/)
  assert.match(themePrev, /api\.open\(true\); \/\/ 只换色用户看不见/)
  assert.match(themePrev, /repaint\(\);\n\s*api\.open\(false\);/)
  assert.match(themePrev, /var DEFAULT_MS = 3200, MAX_MS = 20000;/)
  assert.match(themePrev, /if \(!window\.BubbleRender\.THEMES\[theme\]\) return;/)
  assert.match(themePrev, /if \(!isFinite\(dur\) \|\| dur <= 0 \|\| dur > MAX_MS\) dur = DEFAULT_MS;/)
  assert.match(themePrev, /api\.state = null;\n\s*setTheme\(api\.savedTheme\);/)
  // 预览期间配置推送只更新回落目标，不打断正在放的预览
  assert.match(themePrev, /api\.savedTheme = \(theme === 'dark' \|\| theme === 'sakura' \|\| theme === 'fantasy'\) \? theme : 'default';\n\s*if \(api\.state\) return;/)
})

test('逐秒刷新：说明行直写不走淡入淡出，重排前复位字号', () => {
  // setHint 的淡入淡出每秒跑一次会一直闪；倒计时改走 setHintDirect
  assert.match(page, /function setHintDirect\(text\) \{[\s\S]*?hintEl\.textContent = text;/)
  // 倒计时页的说明行只有附加项，底稿传空串
  assert.match(page, /if \(hintText\) fitOffworkHint\('', ov\);/)
  // fitText 的缩放会累积进 dataset.k（只缩不放），逐秒重排前必须复位；
  // 量两行高度也必须在复位之后，否则会沿用收缩后的字号低估行数
  assert.match(page, /resetBubbleFont\(\);\s*(?:\/\/[^\n]*\n\s*)?if \(hintText\) fitOffworkHint\('', ov\);/)
  // 余额行紧随其后按秒复核（fitBubbleText 之前）
  assert.match(page, /if \(hintText\) fitOffworkHint\('', ov\);[\s\S]*?amountEl\.style\.display = amtDisplay;\s*fitBubbleText\(\);/)
  // key 相同不碰 DOM
  assert.match(page, /if \(!force && key === offworkLastKey\) return;/)
})

test('与临时接管互斥：自定义步骤与倒计时页同队列共存', () => {
  // 四种临时接管压过整个队列；自定义泡泡（bubbleModelOn）不在其中 —— 它只是队列里的后续页
  for (const flag of ['bubbleTimerActive', 'bubbleRemindActive', 'bubblePreviewActive', 'bubbleRandomActive']) {
    assert.match(page, new RegExp(`!${flag}`), `offworkCanRender 少了 ${flag} 的排除`)
  }
  assert.doesNotMatch(page, /return !!offworkOn && !bubbleModelOn/)
  // 切到这些内容的统一入口会收起进度条并摘掉临近配色（否则颜色会带到别人的标题行上）
  assert.match(page, /offworkBarEl\.style\.display = 'none';\s*applyOffworkNear\(null\);/)
  // 内容退出后 render() 末尾重新把标题行 / 附加项补回来，不需要用户手动开关
  assert.match(page, /applyOffworkView\(false\);\s*\}\s*\n\s*\/\/ —— 余额 ——/)
})
