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
// 但宿主 API 是可以被直接调的，写 500 行 patch 这种事不该发生
const MAX_BATCH = 100

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

// 选出一批**独立**的候选项，每个自带冻结的「当前状态」。
//
// 冻结的意义：界面上用户可能先看到一份清单、过一会儿才点「执行」，
// 中间 dsh 的 patch 文件可能被别的工具改过。所以真正要禁用谁，由**执行时**按 id
// 从 opts.ids 里排除，而不是沿用界面上那份快照 —— 界面上携带的状态只用于「默认勾谁」。
function selectBatch(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const cand = normalizeCandidates(o)
  // 勾选名单：缺省即全选（一键隔离的意图就是「只留我要的」）
  const wanted = Array.isArray(o.ids) ? o.ids : null
  const want = wanted ? {} : null
  if (want) {
    for (let i = 0; i < wanted.length; i++) want[String(wanted[i] == null ? '' : wanted[i]).trim()] = true
  }
  const out = []
  for (let i = 0; i < cand.ids.length; i++) {
    const id = cand.ids[i]
    if (want && !want[id]) continue
    out.push({ id: id, disabled: !!o.disabledMap[id], inPatch: !!o.patchMap[id] })
    if (out.length >= MAX_BATCH) break
  }
  return out
}

// 候选清单（给界面渲染勾选框用）：patch 文件里的条目 + dump 树里真实存在的插件条目。
//
// 顺序 = 输入顺序：调用方（settings.js）先传 patchItems 再传 pluginIds，
// 界面上就是「patch 里已有的条目 → 组装树里其余的」两段，符合「先看我已经改过什么」的直觉。
// 这里不再排序也不做二次分组 —— 排一次序就要解释「为什么 xx 排前面」，而优先级本就是输入给的。
//
// `source` 的区别是给用户看的，也是给免责文案定责用的：
//   · 'patch'  —— 这个 id 已经在用户层 patch 里，改动就是改它自己那一行（最稳）
//   · 'plugin' —— 这个 id 只在组装树里，写入等于**新增**一条 patch（V1 提醒：带 client 入口的可能无效）
function candidatesOf(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const patchItems = Array.isArray(o.patchItems) ? o.patchItems : []
  const pluginIds = Array.isArray(o.pluginIds) ? o.pluginIds : []
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
      line: Number.isFinite(it.line) ? it.line : 0,
      hasConfig: !!it.hasConfig,
      source: 'patch',
    }
  }
  for (let i = 0; i < pluginIds.length; i++) {
    const id = String(pluginIds[i] == null ? '' : pluginIds[i]).trim()
    if (!id || byId[id]) continue
    byId[id] = { id: id, disabled: false, inPatch: false, line: 0, hasConfig: false, source: 'plugin' }
  }
  // cand.ids 本身已按「patchItems 在前、pluginIds 在后」的顺序去重，这里只负责取值
  const items = []
  for (let i = 0; i < cand.ids.length; i++) {
    const it = byId[cand.ids[i]]
    if (it) items.push(it)
  }
  return items
}

module.exports = {
  MAX_BATCH,
  candidatesOf,
  selectBatch,
}
