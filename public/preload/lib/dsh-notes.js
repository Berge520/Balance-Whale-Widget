/*
 * dsh 宿主「更新说明」区间聚合（CommonJS）。
 *
 * 为什么是这个形态（读之前先看这段，它决定了本模块**不做**什么）：
 *  - dsh 每次发布的 GitHub release notes **本身就是人写好的、按语义分好节的文档**
 *    （实测 0.1.7-rc.2 有「✨ 新增 / 🐛 修复 / ⚠️ 调整 / 🎨 优化」四节，中文条目完整）。
 *    所以这里**不做关键词风险判定** —— 官方把「需要注意」的放进「⚠️ 调整」节，这就是权威分档；
 *    自己再匹配「不再 / 移除 / 弃用」只会误报（「修复 XX 无法正常显示」这种否定句必踩），
 *    且识别不了时要被迫「归入未标注」，等于白做。
 *  - 同一篇 release 是**中文块 + 英文块**两份等价内容（同一件事各写一遍）。必须只取中文块，
 *    否则每条都被算两遍、条目数直接翻倍（详见 pickCn）。
 *  - 真正的增量不是标注，而是**区间**：release notes 是写给所有人的（「rc.2 相对 rc.1 改了什么」），
 *    但用户装的是 0.1.6-alpha.2、中间隔着好几个版本，rc.2 那一篇跟他没关系。
 *    他需要的是「我这版 → 最新版」这一串的累积变更。只有插件能同时知道「实装哪个版本」与「全部版本列表」，
 *    这是本模块唯一不可替代的能力。
 *  - 顺带的好处：实装 == latest 时区间为空，**一个请求都不发**（国内网络下这是最大的省法）。
 *  - 另一半省法：正文按版本号**持久缓存**（whale:dshNotes）。各源都固定吐全量（380KB 级、单次往返数百 ms 至 2.9s），
 *    而区间里真正用到的往往只有 1~3 版；缓存后第二次看同一区间是 0 请求、瞬时出结果。
 *    正文写完即不可变，所以缓存无需失效策略（见下方 CACHE_MAX_VERSIONS 段）。
 *
 * 平台与可测性约束：
 *  - 纯 Node，只用内置 fetch / AbortSignal；不 require utools，不打日志到控制台 ——
 *    必须能在**无 utools 桩**下被 node --test 加载（三平台 CI 都跑得起来）。
 *    「打开发布页」这类动作不在这里做，本模块只产出 URL，由界面层调 utools.shellOpenExternal。
 *  - 不碰 path / 平台命令 / 环境变量。版本先后**优先按发布时间**（times 由调用方从 npm time 字段传入），
 *    取不到时间才退回 dsh-market 的 cmpVer（跨平台纯字符串计算）。
 *    为什么必须按时间：dsh 官方不按 semver 递增发布 —— 实测 0.1.5-rc.3 发布于 0.1.6-alpha.2 **之后**
 *    （旧分支补发的补丁），还大量跳号（整个 0.1.4 不存在）。semver 会把后发的 0.1.5-rc.3 判成「更旧」，
 *    导致区间漏掉它、或把「比实装新」判反。times 缺失时退回 cmpVer 只为兼容老缓存，不是等价方案。
 */
const { cmpVer } = require('./dsh-market')
const { log, logErr } = require('./log')
const { K } = require('./constants')

// 「a 是否晚于 b」。有发布时间就按时间比，否则退回 semver（cmpVer）。
// times 形如 { '0.1.7-rc.2': 1758... }，由 dsh.js 从 npm 的 time 字段解析后传进来；
// 老缓存 / 上游没给时为空对象 —— 那时只能退回 cmpVer，见文件头对「为什么必须按时间」的说明。
// 只给一方有时间：视作有时间的那个更晚（另一方查不到发布时间，无从比较）。
function after(a, b, times) {
  const x = String(a || '').trim(), y = String(b || '').trim()
  if (!x || !y) return false
  const t = times && typeof times === 'object' ? times : null
  const tx = t && t[x], ty = t && t[y]
  if (tx && ty) return tx > ty
  if (tx) return true
  if (ty) return false
  return cmpVer(x, y) > 0
}

// 说明链路独立于版本链路：版本查询走 npm 子进程，这条只是附注，超时即放弃。
//
// 超时是**总预算**，不是单次：下面 SOURCES 是逐个回退的，若每源各给 7s，
// 三个源串行最坏要等 21s —— 回退本该是「救命」，反而把等待拉长成不可接受。
// 所以改成整条链路共用 10s，均摊到每源约 3.3s。留 10s 的依据：
// ungh 全量 308KB 单次往返实测 1.7–2.9s，4s 太贴边（网络稍抖就整条报失败、
// 界面只剩「获取失败」），而它只是附注，宁可多等几秒也别轻易放弃。
const TIMEOUT_MS = 10000

// ── 正文持久缓存 ──────────────────────────────────────────────
// 上游这个接口固定吐全量 380KB，实测单次往返 2.9s（国内更慢）。用户等的这几秒里，
// 真正用到的往往只是区间里那 1~3 个版本 —— 其余 20 个版本的正文纯粹是白下的。
// 而某个 tag 的 release notes 是**写完即不可变**的（官方不会回改历史版本说明），
// 所以按「版本号 → 正文」缓存下来跨会话复用是恒安全的：同一个版本第二次看应当是 0 请求。
//
// 缓存的是**上游正文**这一层，不是聚合结果：聚合随所选区间变（区间一变结论就不同），
// 存下来只会出现「版本号是新的、说明还是旧的」。正文这一层与区间无关，怎么复用都对。
//
// 存储不可用（无 utools 桩、写失败）时全部静默降级为「每次重取」——
// 这是纯优化路径，它挂掉不该让取说明本身失败。
const CACHE_MAX_VERSIONS = 40 // 最多留多少版正文：覆盖默认 60 版列表里会用到的区间，超出的按最老优先淘汰

function loadCached() {
  try {
    if (typeof utools === 'undefined' || !utools.dbStorage) return new Map()
    const c = utools.dbStorage.getItem(K.dshNotes)
    const items = c && typeof c === 'object' && c.items && typeof c.items === 'object' ? c.items : null
    if (!items) return new Map()
    const out = new Map()
    for (const v of Object.keys(items)) {
      const md = items[v]
      if (typeof md === 'string' && md) out.set(String(v), md)
    }
    return out
  } catch (err) {
    // 读失败只当没缓存（等价于首次取），不影响本次取说明
    logErr('[whale][dsh-notes] 读说明缓存失败', (err && err.message) || err)
    return new Map()
  }
}

function saveCached(map) {
  try {
    if (typeof utools === 'undefined' || !utools.dbStorage) return
    // 超出上限时按版本序淘汰最老的：旧版本正文最不可能再被看到（用户在降级场景下才会选到它们）
    let keys = Array.from(map.keys())
    if (keys.length > CACHE_MAX_VERSIONS) {
      keys.sort(cmpVer)
      for (const k of keys.slice(0, keys.length - CACHE_MAX_VERSIONS)) map.delete(k)
    }
    const items = {}
    for (const [v, md] of map) items[v] = md
    utools.dbStorage.setItem(K.dshNotes, { version: 1, at: Date.now(), items: items })
  } catch (err) {
    logErr('[whale][dsh-notes] 写说明缓存失败', (err && err.message) || err)
  }
}

// ── 数据源（多源按序回退）────────────────────────────────────
// 只有 ungh.cc 一个源时，它抖一次整条「版本说明」就全废（实测抓到过：连续 fetch failed，
// 几分钟后又恢复）—— 它是社区第三方镜像，稳定性不受控，所以必须能换源。
//
// **顺序按实测速度排**（连打 6 轮：gh-proxy 平均 271ms、gh-api 311ms、ungh 920ms）——
// 主源决定绝大多数请求的耗时，把最快的放第一，正常路径就快；慢的留给「快的挂了」时兜底。
//  1. gh-proxy 代理 github —— 主源。实测最快且稳定（6/6 成功，稳态 ~110ms）。同为第三方代理，稳定性不受控，故有下面两级兜底
//  2. api.github.com 直连 —— 备源。官方源最可信且实测也快（311ms），但**单 IP 限流 60/h**，日常用会把额度烧光
//  3. ungh.cc             —— 最后兜底。实测最慢（920ms）且抓到过连续 fetch failed，只在前两个都挂时顶上
// 两个 github 源都**必须带 per_page=100**：默认只返回 10 条，区间模式下少掉的那十几版
// 会静默变成空正文（不报错、只是条目变少）。
//
// 三源内容经逐版对比**逐字节一致**（0.1.7-rc.1 均为 19003 字符），所以回退不会出现
// 「同一版本说明内容不同」。形态差异（裸数组 vs {releases:[]}、tag vs tag_name、
// markdown vs body）由 releaseMap 统一兼容，这里不必各自适配。
const SOURCES = [
  'https://gh-proxy.com/https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100',
  'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100',
  'https://ungh.cc/repos/deepseek-ai/deepseek-harness/releases',
]

// 保留旧名（单测按 unghUrl 引用）：它不再等于**主源**，只是仓库地址的规范写法，
// 指向 ungh 那条（名字与它对应）。单测只用它断言「仓库固定」。
function unghUrl() {
  return 'https://ungh.cc/repos/deepseek-ai/deepseek-harness/releases'
}

// 章节标题里的装饰字符：emoji、箭头、变体选择符。用带 u 标志的 Unicode 属性转义逐个列举，
// 不写码点区间 —— 区间会把变体选择符 FE0F 与相邻码点当成一个「簇」，触发 no-misleading-character-class
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{2190}\u{2192}\u{2194}-\u{2199}\u{21A9}\u{21AA}\u{2B05}\u{2B06}\u{2B07}\u{2B1B}-\u{2B1C}]/gu

// 章节标题的归一键。同一个语义节在不同版本里措辞会变，必须归成同一节，
// 否则跨版本聚合并列时会冒出好几节同义标题 —— 实测官方就改过口径：
//   rc.1 用「新增功能 / 体验优化 / 问题修复 / 其他变更」，rc.2 改成「✨ 新增 / 🎨 优化 / 🐛 修复」，
//   英文块同期是「New Features / Improvements / Bug Fixes / Chores」，且 rc.1 的英文块还有「⚠️ Changes」。
// 键是「去 emoji / 去括号 / 去空白 / 小写」后的形态，所以英文键都写成连写形式（空格已被剥掉）
const ALIAS = {
  调整: '调整', changes: '调整', change: '调整',
  修复: '修复', fixes: '修复', fix: '修复', bugfixes: '修复', bugfix: '修复', 问题修复: '修复',
  新增: '新增', 新增功能: '新增', features: '新增', feature: '新增', new: '新增', newfeatures: '新增',
  优化: '优化', 体验优化: '优化', improvements: '优化', improvement: '优化', perf: '优化', performance: '优化',
  移除: '移除', removed: '移除', remove: '移除', removals: '移除',
  破坏性变更: '破坏性变更', breaking: '破坏性变更', breakingchanges: '破坏性变更',
  // 「其他变更 / Chores」归为一节；归一后原本是中文键与 chores 两节，合并成「其他」
  其他: '其他', 其他变更: '其他', chores: '其他', chore: '其他', misc: '其他', others: '其他',
}

function normTitle(t) {
  const k = String(t || '').replace(EMOJI, '').replace(/[（(].*?[)）]/g, '').replace(/[\s:：]/g, '').toLowerCase()
  return ALIAS[k] || k
}


// 章节在界面上的先后：官方已用「⚠️」标出需要注意的，把它提前 —— 让用户先看到会咬人的那节。
// 比较的是归一后的键，所以中英标题都能命中
const PRIORITY = ['调整', '移除', '破坏']
function orderPriority(list, out) {
  for (const s of list) {
    const k = normTitle(s.title)
    if (PRIORITY.some((p) => k.indexOf(p) >= 0)) out.push(s)
  }
}

// 从 markdown 里切出中文块。release 正文是「中文块 + 英文块」两段，首行是
// `[中文](#cn-xx) | [English](#en-xx)` 的目录，两块内容等价（同一条被中英各写一遍）。
// 只取中文块：既避免同一条目被中英各算一次（条目数直接翻倍），也省掉一半渲染量。
//
// ⚠️ 定位锚点必须是 `h2|h3` 两种都认、且**保留整个标题标签**。两个都是踩过的坑：
//  · 实测正文用的是 `<h3 id="cn-v0.1.7-rc.1">新增功能</h3>` 而非 h2 —— 只写 h2 会匹配不到。
//    更隐蔽的是 `<h2[^>]*` 也能匹配到 `<h3 id="cn-...">` 这行（`[^>]*` 把 `3` 一并吃掉了），
//    所以它**不报错、只是静默错位**，比完全匹配不上更难发现。
//  · 起始必须落在标题**开标签之前**，让这个 cn- 标题本身被 splitSections 当成第一个小节标题解析到。
//    早期写法从开标签**之后**起切（`m.index + m[0].length`），于是中文块首行变成
//    `新增功能</h3>` 这种孤零零的闭标签尾巴 —— 第一个小节的标题就此丢失，
//    它下面那批条目会被并进上一个（不存在的）节里，实测表现为「新增功能(48)」这类标题整节不见。
// 结束点取下一个 h2/h3 之前：中文块末尾紧接的就是英文块的首个标题。
function pickCn(md) {
  const text = String(md || '').replace(/\r\n/g, '\n')
  if (!text) return ''
  const m = /<h[23][^>]*id=["']cn-[^"']*["'][^>]*>/i.exec(text)
  // 没有双块结构（上游改了排版，或旧版 release 就是单块纯 markdown）→ 原样返回，不能炸
  if (!m) return text
  const start = m.index
  const end = /<h[23][\s>]/i.exec(text.slice(start + m[0].length))
  // m[0].length 是开标签自身的长度：切出来必须**含**这个标题标签，才留得住第一个小节
  return text.slice(start, end ? start + m[0].length + end.index : text.length)
}

// 把 h3 分节切成 { title, items[] }，只保留标题 + 条目两样东西
function splitSections(md) {
  const text = String(md || '').replace(/\r\n/g, '\n')
  const heads = []
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>|^[ \t]{0,3}###[ \t]+(.+?)[ \t]*$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    heads.push({ title: String(m[1] != null ? m[1] : m[2]).replace(/<[^>]*>/g, '').trim(), at: m.index, len: m[0].length })
  }
  const out = []
  for (let i = 0; i < heads.length; i++) {
    const body = text.slice(heads[i].at + heads[i].len, i + 1 < heads.length ? heads[i + 1].at : text.length)
    const items = []
    for (const raw of body.split('\n')) {
      const line = raw.trim()
      const li = /^[-*]\s+(.+)$/.exec(line)
      const txt = (li ? li[1] : (/^\d+[.、)]\s+/.test(line) ? line.replace(/^\d+[.、)]\s+/, '') : ''))
        .replace(/<[^>]*>/g, '').replace(/\*\*/g, '').trim()
      if (txt) items.push(txt)
    }
    if (items.length) out.push({ title: heads[i].title, items })
  }
  return out
}

// 选进区间的版本：比实装**晚**、且不晚于目标版本。**不含实装那版自己** ——
// 它已经装着跑在用户机器上，把它算进「将发生的变更」是错的。
//
// 「晚」由 after() 判定：有发布时间按时间，否则退回 semver。**不能用 semver 单独判** ——
// 官方会给旧分支补发版本号更低的补丁（0.1.5-rc.3 晚于 0.1.6-alpha.2），semver 会把它漏掉。
//
// 输出顺序：**保持 list 里的原始次序**（list 是 npm 返回的发布序），不再按 semver 重排 ——
// 按 semver 排会把后发的低版本号挪到前面，与真实发布顺序不符（区间展示是给人读的时间线）。
function rangeVersions(installed, target, list, times) {
  const seen = new Set()
  const out = []
  for (const v of Array.isArray(list) ? list : []) {
    const s = String(v || '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    if (after(s, installed, times) && !after(s, target, times)) out.push(s)
  }
  return out
}

// 单版本模式：只看**某一个版本自己**的说明，与实装版本无关。
// 用户在「更新版本」里选了一个不比自己现在这份新的版本时走这条 —— 那是「降级 / 换到那一版」，
// 他想看的是那一版写了什么，而不是「从当前版升过去会变什么」（后者恒为空，等于什么都不显示）。
// 去重理由同 rangeVersions：列表里同一版本号可能重复出现
function singleVersion(want, list) {
  const s = String(want || '').trim()
  if (!s) return []
  for (const v of Array.isArray(list) ? list : []) {
    if (String(v || '').trim() === s) return [s]
  }
  return []
}

// releases 条目 → Map(tag → markdown)。tag 形如 `dsh-v0.1.7-rc.2`；只看 `dsh-v` 前缀，
// 别把仓库里其他组件的 tag 也算成 dsh 的版本
//
// ⚠️ 入参可能是**裸数组**，也可能是 `{ releases: [...] }` 包装对象 —— ungh.cc 实际返回的是后者。
// 只认裸数组会让整个循环一次都不执行、静默产出空 Map，表现为「请求成功但条目 0 条」，
// 这是踩过的坑（界面一直显示「正在获取说明…」的真凶）。这里统一解包，两种形态都认。
function releaseMap(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.releases) ? raw.releases : [])
  const map = new Map()
  for (const i of list) {
    const tag = String((i && (i.tag || i.tag_name)) || '')
    const ver = tag.indexOf('dsh-v') === 0 ? tag.slice(5) : (i && i.version ? String(i.version) : '')
    if (!ver) continue
    const body = i.markdown != null ? i.markdown : i.body
    if (body && !map.has(ver)) map.set(ver, body)
  }
  return map
}

// 按官方分节归并区间内所有版本：多版的「✨ 新增」并成一节，条目带上是哪一版来的
// （「这条从哪个版本开始」是官方 release notes 给不了的，也是聚合的意义所在）
//
// 条目要按正文去重。官方会把同一条变更在连续几个版本里各写一遍 —— 实测 rc.1 的正文是
// 「自 v0.1.5-rc.3 以来的汇总」，天然包含 alpha.2 那几条，区间跨这两版时就会重复 5 条左右。
// 保留**最早出现**的那次（rels 由 rangeVersions 升序给出，首次遇到即最老版本），
// from 因此正好是「这条从哪个版本开始」，与它的语义一致。
function mergeSections(rels) {
  const order = []
  const byKey = new Map()
  const seen = new Set()
  for (const rel of rels) {
    for (const sec of splitSections(pickCn(rel.markdown))) {
      const k = normTitle(sec.title) || '其他'
      let hit = byKey.get(k)
      if (!hit) { hit = { title: sec.title, items: [] }; byKey.set(k, hit); order.push(hit) }
      for (const t of sec.items) {
        // 去重键带上小节：同一条文字出现在「修复」与「调整」两节时是两种语义，不该互吞
        const dedup = k + '\u0000' + t
        if (seen.has(dedup)) continue
        seen.add(dedup)
        hit.items.push({ text: t, from: rel.version })
      }
    }
  }
  const out = []
  orderPriority(order, out)
  for (const s of order) if (out.indexOf(s) < 0) out.push(s)
  return out
}

// 列表里的版本上下界。**不能认 list[0] / list[末位]** —— list 的排序是上游给的
// （npm 的 versions 实测升序、ungh 的 releases 实测降序），把顺序当不变量、上游一改序就静默取错边界。
//
// 「上界」= 版本里**最晚发布**的那个（有 times 按时间，否则退回 semver 最大值），与 rangeVersions
// 同口径 —— 不能只按 semver：0.1.5-rc.3 晚于 0.1.6-alpha.2 发布，semver 最大值会选错上界。
function boundOf(list, wantMax, times) {
  let best = ''
  for (const v of Array.isArray(list) ? list : []) {
    const s = String(v || '').trim()
    if (!s) continue
    if (!best || (wantMax ? after(s, best, times) : after(best, s, times))) best = s
  }
  return best
}

async function collect(want, list, notes, installed, times) {
  if (!want.length) return { ok: true, empty: true, versions: [], sections: [], total: 0, url: '' }
  // 先看要的那几版是不是都已经在缓存里（本趟已取的 notes ∪ 上次落盘的正文）。
  // 全命中就**一个请求都不发** —— 这是持久缓存的主要收益：区间通常只跨 1~3 个版本，
  // 第二次看同一区间时必然是全命中，从「整份下载的等待」变成瞬时。
  const store = loadCached()
  for (const [v, md] of store) if (!notes.has(v)) notes.set(v, md)
  if (!want.every((v) => notes.has(v))) {
    // 有缺的才打这一趟。取数走 SOURCES 多源回退，各源都固定吐全量、无法只取缺的那几版：
    // ungh.cc 的 releases 接口无视 perPage（实测 perPage=1/3/10/30 都返回逐字节相同的 308KB / 22 个 release）；
    // github 两个源虽认 per_page，但本文带的是 100（取全），同样是整份回来。
    // 也正因此**绝不能**按「命中缓存」与「待补」分两次 load：那是两次一模一样的请求、串行更慢。
    const raw = await load()
    const map = releaseMap(raw)
    if (map.size) {
      for (const [v, md] of map) if (!notes.has(v)) notes.set(v, md)
      // 落盘的是**全量正文**（含本次没用到的那 20 版）—— 它们下次很可能被别的区间用到，
      // 存下来才谈得上「第二次看是 0 请求」。只存新拿到的，避免把没变过的正文反复重写。
      for (const [v, md] of map) store.set(v, md)
      saveCached(store)
    }
  }
  // 按区间里的版本逐个取正文：命中的直接读缓存，没命中的只能算空（上游确实没给这版写 release 正文）
  const sectionList = mergeSections(want.map((v) => ({ version: v, markdown: notes.get(v) || '' })))
  const total = sectionList.reduce((n, s) => n + s.items.length, 0)
  const out = {
    ok: true, empty: false, versions: want, sections: sectionList, total,
    url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v' + want[want.length - 1],
  }
  // 单版本模式下 want 只有一项，且它可能就在实装位置上 —— 此时「比实装新」不成立，
  // 下方那条截断判据会把我自己算成截断，所以只在区间模式下算
  if (installed != null) {
    // 区间下界是否被版本列表截断：list 是「最近 60 个版本」，实装若比这 60 个里最老的还老，
    // 说明实装到列表下界之间那几版不在 list 里、区间是残缺的。want 非空必然 list 非空
    const lo = boundOf(want, false, times)
    out.truncated = after(installed, lo, times) ? { installed: installed, listMax: list.length } : null
  }
  return out
}

// 按 SOURCES 顺序逐个取，**拿到合法 JSON 就停**（正常路径仍只打一次请求，不增加流量）。
// 只有「HTTP 非 2xx」或「抛异常（含超时）」才算这个源失败，换下一个。
// 全部失败返回 null —— 由 collect 落成「区间非空但正文为空」的结果（不抛异常），
// **不等于 ok:false**：正文缺失与「实装/列表缺失」是两回事，前者只是拿不到附注、不影响主流程。
//
// 总预算制的实现：以 TIMEOUT_MS 为整条链路上限，每源分到「剩余预算 ÷ 剩余源数」。
// 前一个源白等掉的超时会被扣掉，所以总时长不会拖成 N×TIMEOUT_MS，而是收敛在 TIMEOUT_MS 内。
async function load() {
  const t0 = Date.now()
  let lastErr = null
  for (let i = 0; i < SOURCES.length; i++) {
    const left = TIMEOUT_MS - (Date.now() - t0)
    // 剩余预算已不够再试一次（给 1s 下限，太短等于必然超时、白打一趟）
    if (left <= 1000) break
    // 均摊：把剩余预算按「还没试过的源数」平分，保证每个源都拿得到像样的时间片
    const budget = Math.max(1000, Math.floor(left / (SOURCES.length - i)))
    try {
      const res = await fetch(SOURCES[i], { signal: AbortSignal.timeout(budget) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const raw = await res.json()
      if (i > 0) log('[whale][dsh-notes] 前面的源不可用，已改用 SOURCES[' + i + ']')
      return raw
    } catch (err) {
      lastErr = err
      // 回退属预期分支，用 log 而非 logErr：不该把「主源抖了一下」刷成错误，淹掉真问题
      log('[whale][dsh-notes] 源 #' + (i + 1) + ' 失败:', (err && err.message) || err)
    }
  }
  logErr('[whale][dsh-notes] 取 release 说明失败（所有源均不可用）', (lastErr && lastErr.message) || lastErr)
  return null
}

// 对外唯一入口。notes 是「已取到的说明」缓存（tag → markdown），跨次复用，只补区间里缺的那几个；
// 失败一律返回 ok:false **不抛异常** —— 说明拉不到不该让「查询可用版本」或更新按钮跟着一起坏掉。
//
// **两种模式**，由「所选版本 vs 实装版本」的先后自动决定，调用方不必显式传：
//  · 所选版本比实装**新**（或没装）→ 区间模式：聚合「实装 → 所选」之间的全部变更（主用例）；
//  · 所选版本**老于或等于**实装 → 单版本模式：只看所选那一版自己的说明。
//    这一档必须有，不能退回区间模式：区间是「比实装新且不超过目标」，目标 ≤ 实装时它恒为空，
//    界面只会显示「已是最新」—— 而用户明明选了一版想看它的说明（降级 / 换版前先看看），
//    什么都不给等于这个入口在降级场景下失效。
async function getNotes(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const installed = String(o.installed || '').trim()
  const target = String(o.target || '').trim()
  const list = Array.isArray(o.list) ? o.list : []
  // 版本发布时间表（版本 → 时间戳），由 dsh.js 从 npm 的 time 字段解析后传入。
  // 缺失时 after() 自动退回 semver —— 老缓存没这个字段，不能因此判崩。
  const times = o.times && typeof o.times === 'object' ? o.times : null
  // 取列表里**最晚发布的那版**当兜底上界，而不是认 list[末位]：list 的排序是上游给的（见 boundOf）
  const max = boundOf(list, true, times)
  const notes = o.notes instanceof Map ? o.notes : new Map()
  // 没装（或没查出实装版本）时走区间模式：从列表下界起把所选版本之前的都算上
  const isRange = !installed || (target && after(target, installed, times))
  if (isRange) {
    // 上界**就是所选版本**。这里曾经写成 `target && cmpVer(target, max) > 0 ? target : max` —— 意思是
    // 「所选版本比列表最大值还大才用它，否则用 max」，结果是**用户选了比 max 旧的版本时被上钳到 max**：
    // 实测选 0.1.7-rc.1（实装 0.1.7-alpha.2、max 0.1.7-rc.2）算出「区间 alpha.2 -> rc.2」132 条，
    // 与「自动/latest」完全同一份结果，用户的选择被静默吃掉 —— 表现为「选哪一版都只给 rc.2 那段」。
    // 上界只有两种合法来源：用户没指定（target 为空，如''哨兵已被 targetVersion 解析掉）→ 用 max；
    // 指定了就**认指定的那一版**，比 max 大就用它（装新于 latest 的版本）、比 max 小也用它（选中间版本）。
    const hi = target || max
    if (!installed || !hi) return { ok: false, reason: '缺少实装版本或可用版本列表' }
    if (!after(hi, installed, times)) return { ok: true, empty: true, versions: [], sections: [], total: 0, url: '' }
    const r = await collect(rangeVersions(installed, hi, list, times), list, notes, installed, times)
    log('[whale][dsh-notes] 区间', installed, '->', hi, '版本 ' + r.versions.length + ' 个，条目 ' + r.total + ' 条')
    return r
  }
  // 单版本模式：所选版本必须真在列表里，否则它的说明无从取
  const want = singleVersion(target, list)
  if (!want.length) return { ok: false, reason: '所选版本不在可用版本列表中' }
  const r = await collect(want, list, notes, null, times)
  log('[whale][dsh-notes] 单版本', target, '条目 ' + r.total + ' 条')
  return r
}

module.exports = {
  getNotes,
  // 以下仅供单测：区间切分与分节归并是本模块唯一有真实逻辑的地方，也是三平台行为必须一致的地方
  rangeVersions,
  after,
  singleVersion,
  splitSections,
  mergeSections,
  pickCn,
  normTitle,
  releaseMap,
  boundOf,
  unghUrl,
  SOURCES,
  TIMEOUT_MS,
  // 持久缓存的读写：单测要能直接验证「缓存命中 → 不发请求」与淘汰上限
  loadCached,
  saveCached,
  CACHE_MAX_VERSIONS,
}
