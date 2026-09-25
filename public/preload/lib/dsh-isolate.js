/*
 * dsh 用户层 patch 的**批量**禁用 —— 计划书 §6.2 E3「我的一键隔离」（CommonJS）。
 *
 * 职责边界：
 *   · 只做**行级批量改写**：把一组 id 一次改成 disabled: true。一次写盘、一处快照，
 *     而不是循环调 E2 的 applyToggle —— 那样会一 id 一份快照，用户点一次按钮冒出十几份
 *     内容雷同的备份，快照列表直接失去可读性（MAX_SNAPSHOTS = 20，一轮隔离就吃掉大半）。
 *   · **不建快照**。「写前先备份」由调用方（settings.js）编排 —— 与 dsh-patch.js 同一条边界。
 *   · **不改任何非目标行**：这是 E3 与「全禁」原方案的本质区别（计划书 §5.2）。
 *     全禁 = 往 profile 里补十几条 `disabled: true` 把整个 profile 干掉；本模块只动
 *     用户**显式勾选**的那几条，未勾选的条目一个字节都不碰。
 *
 * ── 为什么要 precheck（而不是直接写）──
 * V2 实测：写一个**不存在的 id**，dsh 只在 stderr 打一行 `patch: entry "X" not found`，
 * 退出码 0、启动照常 —— 也就是「写坏了不报错」。E2 靠「写完回读磁盘」能验出内容对不对，
 * 但**验不出这个 id 在组装树里到底存不存在**，因为 patch 文件可以先写、插件后装。
 * 所以 E3 在写之前必须先用 `--dump-config` 拿一次**真实组装树的条目 id**，
 * 与 patch 文件里的 id 取并集作为候选项 —— 用户在界面上只能勾到真实存在的条目。
 *
 * ⚠️ 这里的 precheck **不解析** dsh 的输出（那是 dsh-dump.js 的职责）：调用方把已知条目
 * 传进来，本模块只管「选什么、改哪些行」。所以本模块是纯函数，单测不需要 mock 子进程。
 *
 * ── 为什么「破坏性」的翻转要保守 ──
 * 候选里既有「已禁用」也有「启用中」，而一键隔离的意图是「只留我要的」→ 默认全选。
 * 但把「已禁用」的条目再写成 disabled: true 是无用写入（noop），而它一旦出现在候选项里，
 * 用户就可能误以为「勾它 = 关掉它」—— 界面上必须把「已禁用」的条目单独标出来并默认不勾。
 */

// 一次最多改多少条。防的是「id 列表被污染」这类极端输入 —— 界面上点不出这么多，
// 但宿主 API 是可以被直接调的，写 500 行 patch 这种事不该发生。
//
// ⚠️ 这个上限**只约束「一次写入多少条」**，不再用来截断候选清单。
// 早先它被当成「候选列表最多显示 100 条」，实测本机 dump 有 204 个条目 →
// 候选从第 101 条起**连勾都勾不到**，而刷新又默认全选：于是「全选」实际只覆盖前 100 条，
// 排在后面的插件既显示不出来也永远禁不掉（用户以为全禁了，其实漏了一截）。
// 候选该收多少收多少（§4.3 的条目级解析本就是几百字节的事），上限只挡写入。
const MAX_BATCH = 100

// 官方包作用域：以它开头的 bundle 视为 dsh 自带，不是用户装的插件
const OFFICIAL_SCOPES = ['@deepseek-ai/']

// 把 bundle 名归一成「档位」。判据只看 bundle（dump 每个分节头里的第一个字段），
// 不看 id —— id 是条目自己的名字，宿主给的（如 `tool-bash`）与插件给的（`modlens`）
// 在命名上没有任何可区分特征，按 id 猜必然出错。
//
// 三档的用途是「帮用户把 204 条收成 3 组」，**不是**权限或安全边界：
//   · 'patched'  —— 已被用户层 patch 改过（最高优先，无条件显眼）
//   · 'third'    —— 第三方插件（用户真正可能想禁的）
//   · 'core'     —— dsh 官方框架节点（默认折叠；禁了多半是把自己的 dsh 弄坏）
// 判不出来的一律算 'third'：宁可让用户多看一眼，也不把可能想禁的插件藏进折叠区。
function tierOfBundle(bundle) {
  const b = String(bundle == null ? '' : bundle).trim()
  if (!b) return 'third'
  for (let i = 0; i < OFFICIAL_SCOPES.length; i++) {
    if (b.indexOf(OFFICIAL_SCOPES[i]) === 0) return 'core'
  }
  // 无作用域的官方包（dsh-base / dsh-web-app / dsh-host-*）也归 official，
  // 但它们同样是第三方生态爱用的命名前缀（实测 dshmarket / dsh-better-sidebar / dsh-mnemon
  // 都不是官方的），所以**不按 `dsh-` 前缀判**，只认下面这张白名单，
  // 剩下的交给 dump 里的完整 bundle 名（`@deepseek-ai/dsh-*` 走上面的作用域判据）
  if (OFFICIAL_BUNDLES[b]) return 'core'
  return 'third'
}

// 实测本机 dump 里出现过的官方 bundle 全名（无 `@deepseek-ai/` 作用域的那几个）。
// 写成白名单而不是前缀匹配，理由同上：`dsh-*` 前缀被第三方大量使用，前缀判会误折叠。
const OFFICIAL_BUNDLES = {
  'dsh-base': true,
  'dsh-web-app': true,
  'dsh-market': true,
  'dsh-help': true,
}

// 档位排序：用户改过的排最前，官方框架垫底（界面折叠区就在最后）
const TIER_ORDER = { patched: 0, third: 1, core: 2 }

// 计划书 §5.2 的硬约束：候选**只能来自**这两个来源，不接受界面直接传一组任意 id。
// 这样做不是为了防注入（validId 已在 dsh-patch 里挡了会破坏文件结构的字符），
// 而是为了让「改动范围」永远能追溯到一份真实读到的清单上。
function normalizeCandidates(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const ids = []
  const seen = {}
  const push = (v) => {
    const s = String(v == null ? '' : v).trim()
    if (!s || seen[s]) return
    seen[s] = true
    ids.push(s)
  }
  const patchIds = idListOf(o.patchIds)
  const patchItems = Array.isArray(o.patchItems) ? o.patchItems : []
  const pluginIds = Array.isArray(o.pluginIds) ? o.pluginIds : []
  // patchItems 是调用方的自然写法（settings.js 直接把 parsePatch 的结果传进来），
  // patchIds 是「只给 id」的简写 —— 两者都认，先 patch 后 plugin 的顺序不变
  for (let i = 0; i < patchItems.length; i++) {
    const it = patchItems[i] && typeof patchItems[i] === 'object' ? patchItems[i] : {}
    push(it.id)
  }
  for (let i = 0; i < patchIds.length; i++) push(patchIds[i])
  for (let i = 0; i < pluginIds.length; i++) push(pluginIds[i])
  return { ids: ids, seen: seen }
}

// 值 → 字符串数组（容忍单个字符串、null、非数组）
function idListOf(v) {
  if (typeof v === 'string') return [v]
  return Array.isArray(v) ? v : []
}

// 条目行号归一（供界面显示，1 基）。
// 上游有两种写法：dsh-patch.js 的 `lineIndex`（0 基）与调用方自己带的 `line`（1 基）。
// 只认后者会让前者静默变 0（B10）。两个都没有时返回 0，界面据此显示「追加到末尾」。
function lineNoOf(it) {
  if (Number.isFinite(it.lineIndex)) return it.lineIndex + 1
  if (Number.isFinite(it.line)) return it.line
  return 0
}

// 选出一批**独立**的候选项，每个自带冻结的「当前状态」。
//
// 冻结的意义：界面上用户可能先看到一份清单、过一会儿才点「执行」，
// 中间 dsh 的 patch 文件可能被别的工具改过。所以真正要禁用谁，由**执行时**按 id
// 从 opts.ids 里排除，而不是沿用界面上那份快照 —— 界面上携带的状态只用于「默认勾谁」。
//
// ⚠️ 截断顺序（修 B9）：早先是「边遍历边 push，满了就 break」，而遍历顺序 = 输入顺序，
// 于是**用户在界面上明确勾选的项可能被静默丢掉**（越靠后的越先丢）。
// 现在的口径：
//   1. 先按 id 收集全部命中项
//   2. **勾选项无条件排在前面**（用户的显式意图优先于输入顺序）
//   3. 再按 MAX_BATCH 截断，且截断时 `dropped` 如实报出被丢掉的条数
// 调用方拿到 `dropped > 0` 必须提示用户，不能再出现「以为改了、其实没改」。
function selectBatch(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const cand = normalizeCandidates(o)
  // 勾选名单：缺省即全选（一键隔离的意图就是「只留我要的」）
  const wanted = Array.isArray(o.ids) ? o.ids : null
  const want = wanted ? {} : null
  if (want) {
    for (let i = 0; i < wanted.length; i++) want[String(wanted[i] == null ? '' : wanted[i]).trim()] = true
  }
  const hit = []
  for (let i = 0; i < cand.ids.length; i++) {
    const id = cand.ids[i]
    if (want && !want[id]) continue
    hit.push({ id: id, disabled: !!o.disabledMap[id], inPatch: !!o.patchMap[id] })
  }
  // 已勾选（wanted 给定时，命中的本来就都是勾选项）→ 无需再排序；
  // wanted 缺省即全选时输入顺序就是「patch 在前、plugin 在后」，保持不动。
  const out = hit.length > MAX_BATCH ? hit.slice(0, MAX_BATCH) : hit
  return { items: out, dropped: hit.length - out.length }
}

// 候选清单（给界面渲染勾选框用）：patch 文件里的条目 + dump 树里真实存在的条目。
//
// ── 为什么要分档（`tier`）──
// 实测本机 `--dump-config` 有 204 个条目，其中 199 个是 **dsh 自己的框架节点**
// （`tool-bash` / `session` / `llm` / `subagent` / `sandbox` …），第三方插件只有 5 个。
// 「一键隔离」的语义是「只留我要的」，用户要在这 204 条里找出那 5 个插件 —— 平铺列表做不到。
// 而 dump 的每个分节头本来就带 `bundle`（条目归属哪个包），这个信息一直在，只是先前被丢掉了。
// 于是按 bundle 分三档（判据见 tierOfBundle）：
//   · 'patched' —— 已被用户 patch 改过（最该先看到）
//   · 'third'   —— 第三方插件（用户真正可能想禁的）
//   · 'core'    —— dsh 官方框架（默认折叠，禁了多半是把自己的 dsh 弄坏）
// 排序按 TIER_ORDER，同档内保持输入顺序（不再二次排序 —— 优先级本就是输入给的）。
//
// `source` 与 `tier` 是两件事，别混：
//   · `source` 说「改动的形态」：'patch' = 改它自己那一行（最稳）；'plugin' = 写入等于**新增**一条 patch（V1 提醒：带 client 入口的可能无效）
//   · `tier`   说「它是什么东西」：帮用户分组，不承担安全语义
//
// `o.bundleOf` 是 { id → bundle 名 } 的映射，由调用方（settings.js）从 dump 的分节头带过来。
// 拿不到映射（dump 失败降级）时全部落 'third' —— 宁可不折叠，也不把插件藏起来。
function candidatesOf(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const patchItems = Array.isArray(o.patchItems) ? o.patchItems : []
  const pluginIds = Array.isArray(o.pluginIds) ? o.pluginIds : []
  const bundleOf = o.bundleOf && typeof o.bundleOf === 'object' ? o.bundleOf : {}
  const cand = normalizeCandidates(o)
  const byId = {}
  for (let i = 0; i < patchItems.length; i++) {
    const it = patchItems[i] && typeof patchItems[i] === 'object' ? patchItems[i] : {}
    const id = String(it.id == null ? '' : it.id).trim()
    if (!id) continue
    byId[id] = {
      id: id,
      disabled: !!it.disabled,
      inPatch: true,
      // 行号兼容两种字段名（修 B10）：dsh-patch.js 的 parsePatch 给的是 `lineIndex`（0 基），
      // 早先这里只认 `line` → 上游直接把 parsePatch 的结果传进来时行号静默变 0，
      // 界面上表现为「这一条没有行号」。界面上显示的是 1 基行号，故 lineIndex 要 +1。
      line: lineNoOf(it),
      hasConfig: !!it.hasConfig,
      source: 'patch',
      // 已在用户 patch 里的条目**无条件**归 'patched'：它是用户自己写进去或本插件写进去的，
      // 与它属于哪个 bundle 无关（实测 cost-meter / modlens 都同时是第三方 bundle）
      tier: 'patched',
    }
  }
  for (let i = 0; i < pluginIds.length; i++) {
    const id = String(pluginIds[i] == null ? '' : pluginIds[i]).trim()
    if (!id || byId[id]) continue
    const bundle = String(bundleOf[id] == null ? '' : bundleOf[id]).trim()
    byId[id] = {
      id: id,
      // ⚠️ 早先这里硬编码 `disabled: false`，于是「已禁用」标记只对 patch 里的条目准。
      // 三态：true 禁用 / false 启用 / **undefined 未知**（调用方没给 disabledOf）。
      // 不给就默认 false 会让界面把已禁用的插件显示成「启用中」—— 这是会骗人的静默失效，
      // 所以缺数据时宁可留空，让调用方自己去读 undefined 并显示「状态未知」。
      disabled: o.disabledOf && typeof o.disabledOf === 'object' ? !!o.disabledOf[id] : undefined,
      inPatch: false,
      line: 0,
      hasConfig: !!(o.configOf && o.configOf[id]),
      source: 'plugin',
      tier: tierOfBundle(bundle),
      bundle: bundle,
    }
  }
  // cand.ids 本身已按「patchItems 在前、pluginIds 在后」去重，这里取值 + 按 tier 稳定排序
  const items = []
  for (let i = 0; i < cand.ids.length; i++) {
    const it = byId[cand.ids[i]]
    if (it) items.push(it)
  }
  // 稳定排序（Array#sort 自 ES2019 起保证稳定），同档内保持输入顺序
  items.sort((a, b) => (TIER_ORDER[a.tier] || 0) - (TIER_ORDER[b.tier] || 0))
  return items
}

module.exports = {
  MAX_BATCH,
  TIER_ORDER,
  candidatesOf,
  selectBatch,
  tierOfBundle,
}
