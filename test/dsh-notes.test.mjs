// dsh 更新说明的「区间聚合」与分节归并。
// 这两块是本模块唯一有真实逻辑的地方，且必须三平台结果一致（纯字符串计算，无 fs / 无平台命令）。
import test from 'node:test'
import assert from 'node:assert/strict'
import notes from '../public/preload/lib/dsh-notes.js'

const { rangeVersions, splitSections, mergeSections, pickCn, normTitle, releaseMap, boundOf, unghUrl } = notes

// 实测形态的片段。注意两点（早期夹具写错过，导致 pickCn 的真 bug 被夹具掩盖）：
//  · 分块标题实测是 `<h3 id="cn-..">` 而非 `<h2 id="cn-..">` —— 写成 h2 的夹具会让
//    「只认 h2」的错误实现照样通过，真实数据下却悄悄切错位置
//  · cn- 标题**本身就是一个语义小节的标题**（如「✨ 新增」），不是独立的「中文」分隔行
const CN_BLOCK = [
  '<h3 id="cn-v0-1-7-rc-2-community">✨ 新增</h3>',
  '',
  '- 新增插件目录搜索',
  '- 支持自定义端口',
  '### 🐛 修复',
  '- 修复部分插件详情和设置页无法正常显示插件信息',
  '### ⚠️ 调整',
  '- Inspector 不再默认提供，需要单独安装',
].join('\n')

const EN_BLOCK = [
  '<h3 id="en-v0-1-7-rc-2-community">New Features</h3>',
  '- plugin catalog search',
].join('\n')

test('pickCn：只取中文块，英文块不混入（混入会让同一条被中英各算一次）', () => {
  const md = CN_BLOCK + '\n' + EN_BLOCK
  const cn = pickCn(md)
  assert.ok(cn.includes('新增插件目录搜索'))
  assert.ok(!cn.includes('plugin catalog search'))
})

// 回归：真实 release 的分块锚点挂在 `<h3>` 上，不是 `<h2>`。
// 早期实现写的是 `<h2[^>]*id=["']cn-..` —— `[^>]*` 能把 `<h3 id="cn-...">` 整行吃掉，
// 所以它**不报错、只是静默错位**：切出来的中文块从开标签之后起，首行剩个 `✨ 新增</h3>`
// 的闭标签尾巴，第一个小节的标题就此丢失（它下面那批条目被并进不存在的上一个节）。
// 这条钉子同时锁两件事：锚点认 h3，且切出的内容**含** cn- 那个标题标签本身
test('pickCn：锚点认 h3（真实形态），且中文块保留首个标题（否则首个小节整节丢失）', () => {
  const md = CN_BLOCK + '\n' + EN_BLOCK
  const cn = pickCn(md)
  assert.ok(cn.includes('id="cn-v0-1-7-rc-2-community"'), 'cn- 标题标签必须留在中文块里')
  // 首个标题能被 splitSections 解析出来 —— 这是「首个小节不丢」的直接判据
  const secs = splitSections(cn)
  assert.equal(secs[0].title, '✨ 新增')
  assert.deepEqual(secs.map((s) => s.title), ['✨ 新增', '🐛 修复', '⚠️ 调整'])
})

test('pickCn：没有双块结构时原样返回（上游改了排版也不能炸）', () => {
  assert.equal(pickCn('### 🐛 修复\n- 一条'), '### 🐛 修复\n- 一条')
  assert.equal(pickCn(''), '')
})

test('splitSections：h3 html 与 ### markdown 两种标题都能切，且丢弃非条目行', () => {
  const secs = splitSections(CN_BLOCK + '\n### 🎨 优化\n1. 列表渲染更快')
  assert.deepEqual(secs.map((s) => s.title), ['✨ 新增', '🐛 修复', '⚠️ 调整', '🎨 优化'])
  assert.equal(secs[0].items.length, 2)
  assert.equal(secs[3].items[0], '列表渲染更快')
})

test('normTitle：emoji 与括号备注不参与归并判等（否则同一个「调整」会被拆成两节）', () => {
  assert.equal(normTitle('⚠️ 调整'), normTitle('调整（重要）'))
  assert.notEqual(normTitle('✨ 新增'), normTitle('🐛 修复'))
})

test('normTitle：中英标题归成同一节 —— 中文块「调整」与英文块「Changes」是一回事', () => {
  // 实测同一份 release 的中文块写 `### ⚠️ 调整`、英文块写 `### ⚠️ Changes`；
  // 不归并就会在区间里出现两个「调整」节
  assert.equal(normTitle('⚠️ 调整'), normTitle('⚠️ Changes'))
  assert.equal(normTitle('🐛 修复'), normTitle('🐛 Bug Fixes'))
  assert.equal(normTitle('✨ 新增'), normTitle('✨ New Features'))
  assert.equal(normTitle('🎨 优化'), normTitle('🎨 Improvements'))
})

test('mergeSections：多版同名小节并成一节，条目带来源版本；调整节前置', () => {
  const secs = mergeSections([
    { version: '0.1.7-rc.2', markdown: CN_BLOCK },
    { version: '0.1.7-rc.1', markdown: '### ✨ 新增\n- 另一条新增\n### ⚠️ Changes\n- default port changed' },
  ])
  // ⚠️ 调整（含英文块 Changes）被提到最前 —— 官方已标警示符的那节该先被看到
  assert.equal(normTitle(secs[0].title), normTitle('⚠️ 调整'))
  // 且「调整」只应有一节，条目来自两个版本
  const adj = secs.filter((s) => normTitle(s.title) === normTitle('⚠️ 调整'))
  assert.equal(adj.length, 1)
  assert.deepEqual(adj[0].items.map((i) => i.from), ['0.1.7-rc.2', '0.1.7-rc.1'])
  const add = secs.find((s) => normTitle(s.title) === normTitle('✨ 新增'))
  assert.equal(add.items.length, 3)
  assert.deepEqual(add.items.map((i) => i.from), ['0.1.7-rc.2', '0.1.7-rc.2', '0.1.7-rc.1'])
})

test('mergeSections：做「修复」这类否定句不产生任何额外判定，条目原样保留', () => {
  // 故意钉住：本模块不做关键词风险判定，所以「无法正常显示」只该是一条普通修复条目
  const secs = mergeSections([{ version: '0.1.7-rc.2', markdown: CN_BLOCK }])
  const fix = secs.find((s) => normTitle(s.title) === normTitle('🐛 修复'))
  assert.equal(fix.items.length, 1)
  assert.equal(fix.items[0].text, '修复部分插件详情和设置页无法正常显示插件信息')
})

// 回归：官方改过小节措辞，同一语义节必须跨版本归并成**一节**。
// 实测 rc.1 用「新增功能/体验优化/问题修复/其他变更」，rc.2 改成「✨ 新增/🎨 优化/🐛 修复」，
// 英文块是「New Features/Improvements/Bug Fixes/Chores」。别名缺一个，界面就会并列好几节同义标题
test('mergeSections：官方换过措辞的同义小节（新增功能 vs ✨ 新增 vs New Features）并成一节', () => {
  const secs = mergeSections([
    { version: '0.1.7-rc.1', markdown: '### 新增功能\n- 甲\n### 问题修复\n- 乙\n### 体验优化\n- 丙\n### 其他变更\n- 丁\n### New Features\n- E' },
    { version: '0.1.7-rc.2', markdown: '### ✨ 新增\n- 戊\n### 🐛 修复\n- 己\n### 🎨 优化\n- 庚\n### Chores\n- 辛' },
  ])
  const add = secs.filter((s) => normTitle(s.title) === '新增')
  assert.equal(add.length, 1, '「新增功能 / ✨ 新增 / New Features」只该有一节')
  assert.equal(add[0].items.length, 3)
  const oth = secs.filter((s) => normTitle(s.title) === '其他')
  assert.equal(oth.length, 1, '「其他变更 / Chores」只该有一节')
  assert.equal(oth[0].items.length, 2)
  // 五节：调整（此例没有）+ 新增 + 优化 + 修复 + 其他，同义标题不得各自成节
  const keys = secs.map((s) => normTitle(s.title))
  assert.equal(new Set(keys).size, keys.length, '不应有归一后重复的节')
})

// 回归：官方会把同一条变更在连续几个版本里各写一遍。
// 实测 rc.1 的正文是「自 v0.1.5-rc.3 以来的汇总」，天然包含 alpha.2 那几条；
// 区间同时跨这两版时（最常见），不去重就会在清单里出现好几条一模一样的。
test('mergeSections：跨版本重复的同一变更只留一条，且 from 取最早出现的版本', () => {
  const secs = mergeSections([
    { version: '0.1.7-alpha.2', markdown: '### ✨ 新增\n- 甲\n- 乙' },
    // rc.1 是汇总版：甲、乙又写了一遍，另加丙
    { version: '0.1.7-rc.1', markdown: '### ✨ 新增\n- 甲\n- 乙\n- 丙' },
  ])
  const add = secs.find((s) => normTitle(s.title) === '新增')
  assert.equal(add.items.length, 3, '重复的甲、乙各只该留一条')
  assert.deepEqual(add.items.map((i) => i.text), ['甲', '乙', '丙'])
  // 首次遇到即最老版本 —— from 正好是「这条从哪个版本开始」
  assert.deepEqual(add.items.map((i) => i.from), ['0.1.7-alpha.2', '0.1.7-alpha.2', '0.1.7-rc.1'])
})

test('mergeSections：同一段文字出现在不同语义节时不算重复（修复与调整是两回事）', () => {
  const secs = mergeSections([
    { version: '0.1.7-rc.2', markdown: '### 🐛 修复\n- 同一句话\n### ⚠️ 调整\n- 同一句话' },
  ])
  assert.equal(secs.find((s) => normTitle(s.title) === '修复').items.length, 1)
  assert.equal(secs.find((s) => normTitle(s.title) === '调整').items.length, 1)
})

test('rangeVersions：不含实装那版自己、含 target；跨 alpha/rc 与跨预发布号都要正确', () => {
  const list = ['0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-rc.1', '0.1.7-rc.2']
  const got = rangeVersions('0.1.6-alpha.2', '0.1.7-rc.2', list)
  assert.deepEqual(got, ['0.1.7-alpha.1', '0.1.7-rc.1', '0.1.7-rc.2'])
  assert.ok(!got.includes('0.1.6-alpha.2'), '实装那版不能算进「将发生的变更」')
})

test('rangeVersions：rc.10 必须排在 rc.9 之后（退回字符串比较会判反）', () => {
  assert.deepEqual(rangeVersions('0.1.6', '0.1.7', ['0.1.7-rc.9', '0.1.7-rc.10']), ['0.1.7-rc.9', '0.1.7-rc.10'])
})

test('rangeVersions：正式版比同号预发布大 —— 实装 rc 时正式版必须进区间', () => {
  assert.deepEqual(rangeVersions('0.1.7-rc.2', '0.1.7', ['0.1.7-rc.2', '0.1.7']), ['0.1.7'])
})

test('rangeVersions：去重且容忍空串（npm 返回里可能有异常值）', () => {
  assert.deepEqual(rangeVersions('0.1.6', '0.1.7', ['0.1.7', '0.1.7', '', '   ']), ['0.1.7'])
})

// boundOf：上下界必须按**版本序**算，不能认 list[0] / list[末位]。
// npm 的 list 实测是发布顺序（升序），但补发旧分支补丁会排到更后面、ungh 的 releases 更是降序；
// 认位置就会静默取错边界，且不报任何错
test('boundOf：按版本序取上下界，与 list 的排序无关', () => {
  const asc = ['0.1.6', '0.1.7-rc.1', '0.1.7-rc.2']
  const desc = ['0.1.7-rc.2', '0.1.7-rc.1', '0.1.6']
  // 补发：0.1.5 排在最后 —— 认末位会把它当成最大版本
  const patched = ['0.1.7-rc.2', '0.1.7-rc.1', '0.1.5-rc.3']
  for (const list of [asc, desc, patched]) {
    assert.equal(boundOf(list, true), '0.1.7-rc.2', '最大版本与排序无关')
  }
  assert.equal(boundOf(patched, false), '0.1.5-rc.3', '最小版本与排序无关')
  assert.equal(boundOf([], true), '', '空列表返回空串，不返回 undefined')
  assert.equal(boundOf(undefined, false), '')
})

// 回归：ungh.cc 返回的是 `{ releases: [...] }` 而不是裸数组。
// 只认裸数组会让循环一次都不执行、静默产出空 Map —— 请求成功却「条目 0 条」，
// 界面则一直停在「正在获取说明…」，是整条链路最隐蔽的一个坑
test('releaseMap：既能吃裸数组，也能吃 ungh.cc 的 { releases: [...] } 包装', () => {
  const item = { tag: 'dsh-v0.1.7-rc.2', markdown: CN_BLOCK }
  assert.equal(releaseMap([item]).get('0.1.7-rc.2'), CN_BLOCK)
  assert.equal(releaseMap({ releases: [item] }).get('0.1.7-rc.2'), CN_BLOCK)
  assert.equal(releaseMap({ releases: [item] }).size, 1)
})

test('releaseMap：只认 dsh-v 前缀的 tag，其他组件的 tag 不算 dsh 版本', () => {
  const map = releaseMap([
    { tag: 'dsh-v0.1.7-rc.2', markdown: 'A' },
    { tag: 'cli-v9.9.9', markdown: 'B' },
    { tag: 'dsh-v0.1.7-rc.2', markdown: '重复，保留先到的' },
  ])
  assert.equal(map.size, 1)
  assert.equal(map.get('0.1.7-rc.2'), 'A')
})

test('unghUrl：仓库固定，改动这里等于换数据源', () => {
  assert.ok(unghUrl().includes('deepseek-ai/deepseek-harness'))
  // 不带分页参数：该接口无视 perPage（实测各种取值都返回同一份全量），带上只是误导
  assert.ok(!unghUrl().includes('perPage'))
})

// ── 多源回退 ──────────────────────────────────────────────────
// 只有 ungh.cc 一个源时，它抖一次整条「版本说明」就全废（实测抓到过连续 fetch failed）。
// 下面三条分别钉：首源失败要能换源、首源成功不许惊动后面的源、全挂时必须按原约定返回 ok:false。
test('多源：主源失败时自动回退到备源，结果不受影响', async () => {
  const { SOURCES } = notes
  assert.ok(SOURCES.length >= 2, '至少要有主源 + 备源，否则「回退」名存实亡')
  const realFetch = globalThis.fetch
  const tried = []
  globalThis.fetch = async (url) => {
    tried.push(url)
    if (url === SOURCES[0]) throw new Error('fetch failed') // 主源抖动
    return { ok: true, json: async () => [{ tag: 'dsh-v0.1.7-rc.2', markdown: CN_BLOCK }] }
  }
  try {
    const r = await notes.getNotes({ installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: ['0.1.7-alpha.2', '0.1.7-rc.2'] })
    assert.equal(r.ok, true, '备源可用时整条链路必须成功')
    assert.ok(r.total > 0, '回退后照样要解析出条目')
    assert.equal(tried[0], SOURCES[0], '必须按序，先试主源')
    assert.equal(tried[1], SOURCES[1], '主源失败后恰好换到下一个源')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('多源：主源成功时不触碰任何备源（正常路径只打一次请求）', async () => {
  const { SOURCES } = notes
  const realFetch = globalThis.fetch
  const tried = []
  globalThis.fetch = async (url) => {
    tried.push(url)
    return { ok: true, json: async () => [{ tag: 'dsh-v0.1.7-rc.2', markdown: CN_BLOCK }] }
  }
  try {
    const r = await notes.getNotes({ installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: ['0.1.7-alpha.2', '0.1.7-rc.2'] })
    assert.equal(r.ok, true)
    assert.deepEqual(tried, [SOURCES[0]], '主源就成功，不该再去试备源（否则白白多打网络）')
  } finally {
    globalThis.fetch = realFetch
  }
})

// HTTP 非 2xx 也算失败：ungh 抖动时实测出现过 5xx，不能只看「没抛异常」就当成功
test('多源：HTTP 非 2xx 视为该源失败，继续换源', async () => {
  const { SOURCES } = notes
  const realFetch = globalThis.fetch
  const tried = []
  globalThis.fetch = async (url) => {
    tried.push(url)
    if (url === SOURCES[0]) return { ok: false, status: 503, json: async () => ({}) }
    return { ok: true, json: async () => [{ tag: 'dsh-v0.1.7-rc.2', markdown: CN_BLOCK }] }
  }
  try {
    const r = await notes.getNotes({ installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: ['0.1.7-alpha.2', '0.1.7-rc.2'] })
    assert.equal(r.ok, true)
    assert.ok(tried.length >= 2, '503 不该被当成成功')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('多源：全部失败时逐个试遍所有源，且不抛异常（说明只是附注，不该带崩整页）', async () => {
  const { SOURCES } = notes
  const realFetch = globalThis.fetch
  const tried = []
  globalThis.fetch = async (url) => {
    tried.push(url)
    throw new Error('fetch failed')
  }
  try {
    const r = await notes.getNotes({ installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: ['0.1.7-alpha.2', '0.1.7-rc.2'] })
    assert.deepEqual(tried, SOURCES, '必须把每个源都试过才算「全失败」')
    // 区间非空但正文全取不到 → 仍回 ok:true / 0 条（正文缺失不是链路故障），关键是**没抛**
    assert.equal(r.ok, true)
    assert.equal(r.total, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

// 实装 == 所选：区间恒为空，但**不能**回 empty —— 那是单版本模式，要给这一版自己的说明
// （用户在下拉里选了当前这一版，想看它写了什么；回 empty 会让界面只显示「已是最新」，入口失效）
test('getNotes：实装 == 所选时走单版本模式，给该版自己的说明而不是空区间', async () => {
  const restore = withFetch({
    releases: [{ tag: 'dsh-v0.1.7-rc.2', markdown: '<h3 id="cn-x">修复</h3>\n- 一条修复' }],
  })
  try {
    const r = await notes.getNotes({ installed: '0.1.7-rc.2', target: '0.1.7-rc.2', list: ['0.1.7-rc.2', '0.1.7-rc.1'] })
    assert.equal(r.ok, true)
    assert.equal(r.empty, false, '单版本模式必须给出这一版的说明')
    assert.deepEqual(r.versions, ['0.1.7-rc.2'])
    assert.equal(r.total, 1)
  } finally {
    restore()
  }
})

test('getNotes：缺实装版本时不冒充，返回 ok:false 且带原因（不抛异常）', async () => {
  const r = await notes.getNotes({ installed: '', target: '0.1.7-rc.2', list: ['0.1.7-rc.2'] })
  assert.equal(r.ok, false)
  assert.ok(r.reason)
})

// 把 fetch 换成返回固定夹具，并保证还原。本文件的断言全都只关心解析/归并结果，
// 不该依赖真实网络 —— 打了真实网络的用例在 CI 上既慢又会因上游改动而红
function withFetch(json) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => json })
  return () => { globalThis.fetch = real }
}

test('getNotes：注入 notes 缓存即可离线跑通全链路（fetch 不参与）', async () => {
  const restore = withFetch({ releases: [] })
  try {
    const notesCache = new Map([['0.1.7-rc.2', CN_BLOCK]])
    const r = await notes.getNotes({
      installed: '0.1.7-rc.1',
      target: '0.1.7-rc.2',
      list: ['0.1.7-rc.1', '0.1.7-rc.2'],
      notes: notesCache,
    })
    assert.equal(r.ok, true)
    assert.deepEqual(r.versions, ['0.1.7-rc.2'])
    assert.equal(r.total, 4)
    assert.ok(r.url.endsWith('dsh-v0.1.7-rc.2'))
  } finally {
    restore()
  }
})

// 回归：区间上界与「是否被列表截断」都不能依赖 list 的排序。
// npm 的 versions 实测升序、ungh 的 releases 实测降序 —— 把「末位即最大 / 首位即最小」
// 当不变量，上游一改序就会静默取错上界（区间凭空多出或丢掉版本），且不报任何错。
test('getNotes：区间按 list 的发布顺序输出（不再按 semver 重排）', async () => {
  const restore = withFetch({ releases: [] })
  try {
    // list 是 npm 返回的**发布顺序**（升序即「先发在前」），区间必须保持这个次序 ——
    // 按 semver 重排会把后发的低版本号挪到前面，与真实时间线不符。
    // 反面用例：降序 list 下输出也应倒过来（证明次序**确实**来自 list，不是内部又排了一遍）。
    const asc = ['0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2']
    const desc = ['0.1.7-rc.2', '0.1.7-rc.1', '0.1.7-alpha.2']
    const cache = () => new Map([
      ['0.1.7-rc.2', CN_BLOCK],
      ['0.1.7-rc.1', '### 🐛 修复\n- 乙'],
    ])
    const a = await notes.getNotes({ installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: asc, notes: cache() })
    const d = await notes.getNotes({ installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: desc, notes: cache() })
    assert.deepEqual(a.versions, ['0.1.7-rc.1', '0.1.7-rc.2'])
    assert.deepEqual(d.versions, ['0.1.7-rc.2', '0.1.7-rc.1'])
    assert.deepEqual(a.versions.slice().sort(), d.versions.slice().sort()) // 覆盖的版本集合相同
    assert.equal(a.total, d.total)
    assert.equal(a.truncated, null)
    assert.equal(d.truncated, null)
  } finally {
    restore()
  }
})

// 回归：list 为空时不该读出 undefined 当上界（`list[list.length - 1]` 在空数组上是 undefined，
// 会让 cmpVer 拿到 undefined 参与比较）。此时应以 target 为上界，而不是整条链路报错
test('getNotes：list 为空时以 target 为上界，不因 undefined 出错', async () => {
  const r = await notes.getNotes({ installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: [] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.versions, [], '列表为空时没有可用版本可切区间')
})

// 回归：整条链路**只许打一次网络**。ungh.cc 无视 perPage（各种取值都返回同一份全量），
// 所以按「命中缓存 / 待补」拆两次请求是两次一模一样的往返，白白多花一倍时间
test('getNotes：无论缓存命中与否，都只发起一次取数', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true,
      json: async () => [
        { tag: 'dsh-v0.1.7-rc.2', markdown: CN_BLOCK },
        { tag: 'dsh-v0.1.7-rc.1', markdown: CN_BLOCK },
      ],
    }
  }
  try {
    // 一版在缓存里、一版不在，刻意制造「命中 + 待补」并存的局面
    const cache = new Map([['0.1.7-rc.1', CN_BLOCK]])
    const r = await notes.getNotes({
      installed: '0.1.7-alpha.2',
      target: '0.1.7-rc.2',
      list: ['0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2'],
      notes: cache,
    })
    assert.equal(calls, 1, '合并成单次请求是本条链路的性能前提，不该回到两次')
    // 两版返回的是**同一份** CN_BLOCK → 去重后只该留 4 条。
    // （早期断言写 8，那是把「跨版本重复未去重」当成了期望值，反被 bug 钉住）
    assert.equal(r.total, 4)
  } finally {
    globalThis.fetch = realFetch
  }
})

// 回归：区间只跨 1–2 个版本（落后一两个 rc，最常见的情形）且缓存全空时，
// 必须真的去取 release 正文。曾经的判据写成 `length > 1` 才 fetch，
// 恰好把这一档全挡掉 —— 区间非空却 0 条，界面表现为一直转圈「正在获取说明…」
test('getNotes：区间只有 2 个版本且缓存为空时，必须真的发起取数', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true,
      json: async () => [
        { tag: 'dsh-v0.1.7-rc.2', markdown: CN_BLOCK },
        { tag: 'dsh-v0.1.7-rc.1', markdown: CN_BLOCK },
      ],
    }
  }
  try {
    const r = await notes.getNotes({
      installed: '0.1.7-alpha.2',
      target: '0.1.7-rc.2',
      list: ['0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2'],
    })
    assert.ok(calls > 0, '缓存为空时必须发起取数，否则一条都解析不出来')
    assert.equal(r.ok, true)
    assert.equal(r.empty, false)
    assert.equal(r.versions.length, 2)
    assert.ok(r.total > 0, '取到正文后必须解析出条目')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── 按发布时间判先后（核心回归） ─────────────────────────────────
// dsh 官方**不按 semver 递增发布**：会给旧分支补发版本号更低的补丁。
// 实测（npm time 字段，2026-09-29）：0.1.5-rc.3 发布于 09-22，**晚于** 0.1.6-alpha.2 的 09-17。
// 只按 semver 判会得出「0.1.6-alpha.2 更新」——与事实相反，导致后发的补丁被当成旧版本漏掉。
test('rangeVersions：按发布时间判先后，后发的低版本号也要算进区间', () => {
  const list = ['0.1.5-rc.1', '0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.5-rc.3']
  // 发布时间：rc.3 晚于 0.1.6-alpha.2（版本号 0.1.5 < 0.1.6，semver 会判反）
  const times = {
    '0.1.5-rc.1': Date.parse('2026-09-10T03:00:00Z'),
    '0.1.5-rc.2': Date.parse('2026-09-10T15:00:00Z'),
    '0.1.6-alpha.1': Date.parse('2026-09-15T03:00:00Z'),
    '0.1.6-alpha.2': Date.parse('2026-09-17T14:00:00Z'),
    '0.1.5-rc.3': Date.parse('2026-09-22T06:00:00Z'),
  }
  // 实装 0.1.6-alpha.2 → 区间上界取最晚发布的 0.1.5-rc.3：它必须被算进来（semver 会漏）
  const got = rangeVersions('0.1.6-alpha.2', '0.1.5-rc.3', list, times)
  assert.deepEqual(got, ['0.1.5-rc.3'], '后发但版本号更低的补丁必须落在区间内')
  // 反向：以 0.1.5-rc.1 为实装，区间应含其后发布的所有版本（保持 list 发布序）
  const got2 = rangeVersions('0.1.5-rc.1', '0.1.5-rc.3', list, times)
  assert.deepEqual(got2, ['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.5-rc.3'])
})

test('rangeVersions：无 times 时退回 semver（兼容老缓存，行为与改动前一致）', () => {
  const list = ['0.1.5-rc.1', '0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.5-rc.3']
  // 无 times：cmpVer 按 semver 判，0.1.5-rc.3 < 0.1.6-alpha.2 → rc.3 不算「更新」
  const got = rangeVersions('0.1.6-alpha.2', '0.1.6-alpha.2', list, null)
  assert.deepEqual(got, [])
})

test('boundOf：上界取「最晚发布」的版本，而非 semver 最大值', () => {
  const list = ['0.1.5-rc.1', '0.1.5-rc.2', '0.1.6-alpha.2', '0.1.5-rc.3']
  const times = {
    '0.1.5-rc.1': Date.parse('2026-09-10T03:00:00Z'),
    '0.1.5-rc.2': Date.parse('2026-09-10T15:00:00Z'),
    '0.1.6-alpha.2': Date.parse('2026-09-17T14:00:00Z'),
    '0.1.5-rc.3': Date.parse('2026-09-22T06:00:00Z'),
  }
  assert.equal(boundOf(list, true, times), '0.1.5-rc.3', '最后发布的是 rc.3，哪怕版本号更低')
  assert.equal(boundOf(list, true, null), '0.1.6-alpha.2', '无 times 时退回 semver 最大值')
})

// ── 正文持久缓存 ──────────────────────────────────────────────
// 上游固定吐 380KB 全量、单次往返实测 2.9s，而区间通常只用到 1~3 版。落库后
// 「第二次看同一区间」必须是 0 请求 —— 这是这次优化的全部意义，所以直接钉请求次数。
// 正文写完即不可变（官方不回改历史 release notes），因此缓存不需要任何失效策略；
// 一旦有人给缓存加上「按时间失效」，这条用例会红，提醒他先想清楚理由。

// 造一个只认 whale:dshNotes 的内存 dbStorage 桩，并把它装到 globalThis.utools 上
function withStorage(seed) {
  const real = globalThis.utools
  const bag = new Map()
  if (seed !== undefined) bag.set('whale:dshNotes', seed)
  globalThis.utools = {
    dbStorage: {
      getItem: (k) => (bag.has(k) ? bag.get(k) : null),
      setItem: (k, v) => { bag.set(k, v) },
      removeItem: (k) => { bag.delete(k) },
    },
  }
  return {
    bag,
    stored: () => bag.get('whale:dshNotes'),
    restore: () => { if (real === undefined) delete globalThis.utools; else globalThis.utools = real },
  }
}

test('正文落库：取到后写入 whale:dshNotes（第二次看同一区间即 0 请求）', async () => {
  const store = withStorage()
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true,
      json: async () => [
        { tag: 'dsh-v0.1.7-rc.2', markdown: CN_BLOCK },
        { tag: 'dsh-v0.1.7-rc.1', markdown: '### 🐛 修复\n- 乙' },
      ],
    }
  }
  const args = { installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: ['0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2'] }
  try {
    const first = await notes.getNotes(Object.assign({}, args))
    assert.equal(calls, 1, '首次取数只打一趟')
    assert.equal(first.ok, true)
    const saved = store.stored()
    assert.ok(saved && saved.items, '取到正文后必须落库')
    assert.ok(saved.items['0.1.7-rc.2'], '落库的是上游正文（含本次没用到的那几版）')

    // 第二次：**不注入内存 notes**，只靠落库那份 —— 必须 0 请求且结果一致
    calls = 0
    const second = await notes.getNotes(Object.assign({}, args))
    assert.equal(calls, 0, '全命中缓存时必须一个请求都不发（这是本次优化的全部意义）')
    assert.equal(second.ok, true)
    assert.deepEqual(second.versions, first.versions)
    assert.equal(second.total, first.total)
  } finally {
    globalThis.fetch = realFetch
    store.restore()
  }
})

test('正文缓存：上游取不到（map 为空）时不覆盖已有缓存', async () => {
  const store = withStorage({ version: 1, at: 1, items: { '0.1.7-rc.2': CN_BLOCK } })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => [] })
  try {
    // 缺 rc.1 → 会打一趟，但上游回空 → 不能把 rc.2 那份已有正文抹掉
    await notes.getNotes({ installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: ['0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2'] })
    const saved = store.stored()
    assert.ok(saved.items['0.1.7-rc.2'], '上游空响应不该清掉原有缓存')
  } finally {
    globalThis.fetch = realFetch
    store.restore()
  }
})

test('正文缓存：超出 CACHE_MAX_VERSIONS 时按版本序淘汰最老的', () => {
  const max = notes.CACHE_MAX_VERSIONS
  const items = {}
  // 造 max+5 个版本，最老的是 0.1.0-alpha.1（必须被淘汰）
  for (let i = 0; i < max + 5; i++) items['0.1.' + i + '-alpha.1'] = 'x'
  const store = withStorage({ version: 1, at: 1, items })
  try {
    const m = notes.loadCached()
    notes.saveCached(m)
    const kept = Object.keys(store.stored().items)
    assert.equal(kept.length, max, '不得超过上限')
    assert.ok(!kept.includes('0.1.0-alpha.1'), '最老的版本该被淘汰')
    assert.ok(kept.includes('0.1.' + (max + 4) + '-alpha.1'), '最新的版本必须留下')
  } finally {
    store.restore()
  }
})

test('正文缓存：无 utools 桩时静默降级为「每次重取」，不抛不炸', async () => {
  const real = globalThis.utools
  delete globalThis.utools
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok: true, json: async () => [{ tag: 'dsh-v0.1.7-rc.2', markdown: '### 🐛 修复\n- 甲' }] }
  }
  try {
    assert.equal(notes.loadCached().size, 0, '无桩时读缓存回空 Map')
    notes.saveCached(new Map([['0.1.7-rc.2', 'x']])) // 不该抛
    const r = await notes.getNotes({ installed: '0.1.7-alpha.2', target: '0.1.7-rc.2', list: ['0.1.7-alpha.2', '0.1.7-rc.2'] })
    assert.equal(r.ok, true, '缓存不可用不影响取说明本身')
    assert.ok(calls > 0)
  } finally {
    globalThis.fetch = realFetch
    if (real !== undefined) globalThis.utools = real
  }
})
