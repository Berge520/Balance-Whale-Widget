// 按压气泡（自定义泡泡）编辑器的纯逻辑层。
//
// 从设置页抽出：这套「点击队列 + 行×模块」编辑器有自己的数据结构（步骤 / 泡 / 行 / 模块），
// 增删改查全是对 config.bubble.items 的深拷贝改写，与设置页其它卡片无关，留在 App.vue 里
// 会把它撑成第二个巨型文件（项目规则要求「尽可能不写在 App.vue」）。
//
// 为什么是 .js 而不是 .ts：本模块要能被 test/bubble-editor.test.mjs 用 `node --test` 直接
// 加载（node 不认 TS），而设置页又要 import 同一份 —— 与 src/bubble/bubble-render.js 同一
// 思路：**纯逻辑单一源**，Vue 侧只做薄封装（见 composables/useBubble.ts）。
//
// ⚠️ 本模块只做**纯逻辑**：不 import vue、不碰 services、不发请求 —— 归一化由宿主 store.js 的
// normBubble* 在保存时兜底，这里只保证编辑器内的数据自洽。
//
// 常量与宿主 store.js 对齐（**手动镜像**，check-shared.mjs 不校验前端常量，改动时需同步）：
//   ROW_MAX=6 / MOD_MAX=6 / CHOICE_MAX=2 / CHOICE_W_MAX=99 / TEXT_MAX=400 / SIZE_MIN=1 / SIZE_MAX=50
//   SIZE_DFT=6 / DWELL 3–60 / ITEM_MAX=24

export const BUBBLE_ROW_MAX = 6
export const BUBBLE_MOD_MAX = 6
export const BUBBLE_CHOICE_MAX = 2
export const BUBBLE_CHOICE_W_MAX = 99
export const BUBBLE_TEXT_MAX = 400
export const BUBBLE_SIZE_MIN = 1
export const BUBBLE_SIZE_MAX = 50
export const BUBBLE_SIZE_DFT = 6
export const BUBBLE_ITEM_MAX = 24
// 阶段 4 补齐（同样手动镜像 store.js，行号见上）
export const BUBBLE_LIB_MAX = 60
export const BUBBLE_LIB_NAME_MAX = 20
export const BUBBLE_URL_MAX = 300
export const BUBBLE_IMG_SCALE_MIN = 0.1
export const BUBBLE_IMG_SCALE_MAX = 1
export const BUBBLE_LINES_MAX = 60
export const BUBBLE_LINE_W_MAX = 99
export const BUBBLE_SESSION_LEN_MAX = 40

// 模块类型（与 store.js 的 BUBBLE_MOD_TYPES 同序同值）。label 供编辑器下拉与卡片标题用，
// hint 是「这个模块在挂件上显示什么」的一句话说明 —— 上游没有 label 表，这里为设置页补
export const BUBBLE_MOD_TYPES = [
  { type: 'text', label: '文本', hint: '固定文字' },
  { type: 'time', label: '报时', hint: '当前时间（按报时文案池取句）' },
  { type: 'balance', label: '总余额', hint: '账户总余额' },
  { type: 'bonus', label: '赠金', hint: '赠送余额' },
  { type: 'recharge', label: '充值余额', hint: '现金充值部分' },
  { type: 'today', label: '今日已用', hint: '当天消耗金额' },
  { type: 'peak', label: '峰谷时段', hint: '当前峰 / 谷状态' },
  { type: 'session', label: '对话名', hint: '当前会话名称' },
  { type: 'random', label: '随机语句', hint: '从句池随机取一句' },
  { type: 'link', label: '超链接', hint: '可点击跳转的链接' },
  { type: 'image', label: '图片', hint: '指定一张图片 / 动图' },
  { type: 'randimg', label: '随机图片', hint: '从图片池随机取一张' },
  { type: 'quota', label: '手动额度', hint: '按模型实例化的额度' },
  { type: 'plan', label: '订阅额度', hint: '订阅套餐额度' },
]

// 图片类模块独占一行并打断行合并（与宿主 normBubbleModules 同口径）
export function isImgMod(type) {
  return type === 'image' || type === 'randimg'
}

// 内容锁定：这些模块的正文由运行时数据决定，编辑器不提供内容输入框，只留模板（tpl）。
// 与 store.js normBubbleMod 的分支一致 —— text/random/link/image/randimg/peak 之外都是内置内容型
export function modContentLocked(type) {
  return ['balance', 'bonus', 'recharge', 'today', 'time', 'quota', 'plan'].indexOf(type) >= 0
}

// ──────────────────────────────────────────────
// 行×模块布局（spec §305 的 bubbleApplyRowLayout 同口径镜像）
// ──────────────────────────────────────────────
// 上游把「行」表达为模块上的 row 键（行号 + 1），单模块行与图片行不带 row 键。
// 编辑器内部用二维数组（rows[行][模块]）更好操作，落库前用本函数压平回带 row 键的 modules[]。
// 规则同宿主 normBubbleModules：图片类独占一行且打断行合并；多模块行 = 行号+1。

// 二维行 → 扁平 modules[]（写库前调用，产物喂 normBubble 即可幂等）
export function bubbleApplyRowLayout(rows) {
  const flat = []
  const list = Array.isArray(rows) ? rows : []
  for (let r = 0; r < list.length && r < BUBBLE_ROW_MAX; r++) {
    const row = Array.isArray(list[r]) ? list[r] : []
    const multi = row.length > 1
    for (let i = 0; i < row.length && i < BUBBLE_MOD_MAX; i++) {
      const m = Object.assign({}, row[i])
      if (multi) m.row = r + 1
      else delete m.row
      flat.push(m)
    }
  }
  return flat
}

// 扁平 modules[] → 二维行（读库后开编辑器时调用）。与 bubbleApplyRowLayout 互为逆运算：
// 相邻同 row 键的非图片模块归一行；图片类各自独占一行；无 row 键的单独成行。
export function bubbleRowsFromMods(mods) {
  const rows = []
  const list = Array.isArray(mods) ? mods : []
  let cur = null
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const m = Object.assign({}, raw)
    if (isImgMod(m.type)) {
      rows.push([m])
      cur = null
      continue
    }
    if (cur && cur.key !== null && cur.key === m.row) {
      cur.row.push(m)
      continue
    }
    cur = { key: m.row === undefined ? null : m.row, row: [m] }
    rows.push(cur.row)
  }
  return rows
}

// ──────────────────────────────────────────────
// 步骤 / 泡 的构造与判定
// ──────────────────────────────────────────────
// 空模块：给新模块一份能过 normBubbleMod 的默认内容（无内容的 text/random 会被宿主丢掉）
export function emptyMod(type = 'text') {
  const m = { type: type, size: BUBBLE_SIZE_DFT }
  if (type === 'text') m.text = '点我'
  if (type === 'random') m.lines = [{ t: '摸鱼一下下～' }]
  if (type === 'link') { m.url = 'https://'; m.text = '链接' }
  if (type === 'image') { m.imgId = imgIdRandom(); m.imgScale = 1 }
  if (type === 'randimg') { m.imgs = []; m.imgScale = 1 }
  if (type === 'peak') { m.peakStyle = 'text' }
  if (type === 'session') { m.tpl = '{session}' }
  return m
}

export function emptyBubble() {
  return { kind: 'custom', modules: [emptyMod('text')] }
}

// 一个「步骤」是单泡（{kind:'custom',modules}）或并列泡（{kind:'choice',options:[{w,item}]}）。
// 新建的步骤一律是单泡，用户点「加并列泡」才升格
export function emptyStep() {
  return emptyBubble()
}

export function isChoiceStep(step) {
  return !!step && step.kind === 'choice' && Array.isArray(step.options) && step.options.length > 1
}

// 取步骤里的「泡列表」：单泡 = [自己]；并列 = options 里的 item 列表（带各自的 w）
export function stepItems(step) {
  if (isChoiceStep(step)) return step.options.map((o) => o.item)
  return step ? [step] : []
}

// 步骤的展示标签：'第 N 次点击'（并列泡的 ' · A泡/B泡' 由调用方拼接）
export function stepLabel(idx) {
  return '第 ' + (idx + 1) + ' 次点击'
}

// 单泡内的模块数
export function bubbleModCount(bubble) {
  return bubble && Array.isArray(bubble.modules) ? bubble.modules.length : 0
}

// 取步骤里所有「泡」的 modules 汇总（并列泡把 A/B 的模块并起来，供列表摘要用）
export function bubbleModLists(step) {
  const out = []
  for (const it of stepItems(step)) {
    if (it && Array.isArray(it.modules)) out.push(...it.modules)
  }
  return out
}

// 步骤摘要（列表里那一行灰字）：'1 行 1 模块' / 'a/b 并列（10 : 2）'
export function stepSummary(step) {
  if (isChoiceStep(step)) {
    const ws = step.options.map((o) => (o && o.w ? o.w : 1))
    return 'a/b 并列（' + ws.join(' : ') + '）'
  }
  const rows = bubbleRowsFromMods(step && Array.isArray(step.modules) ? step.modules : [])
  return rows.length + ' 行 ' + bubbleModCount(step) + ' 模块'
}

// ──────────────────────────────────────────────
// 队列增删改（全部返回新数组，不改原引用 —— 便于 Vue 变更检测与撤销快照）
// ──────────────────────────────────────────────
export function addStep(items) {
  const out = (Array.isArray(items) ? items : []).slice()
  if (out.length >= BUBBLE_ITEM_MAX) return out
  out.push(emptyStep())
  return out
}

export function removeStep(items, idx) {
  const out = (Array.isArray(items) ? items : []).slice()
  if (idx < 0 || idx >= out.length) return out
  out.splice(idx, 1)
  // 允许删到空（宿主 normBubbleItems 的空数组会回默认；编辑器不回默认，
  // 否则用户删最后一步会「删不掉」）
  return out
}

export function moveStep(items, idx, dir) {
  const out = (Array.isArray(items) ? items : []).slice()
  const to = idx + dir
  if (idx < 0 || idx >= out.length || to < 0 || to >= out.length) return out
  const tmp = out[idx]
  out[idx] = out[to]
  out[to] = tmp
  return out
}

// 步骤排序：把 from 步拖到 to 步的前 / 后（zone = 'before' | 'after'）。与 moveStep 的「相邻交换」
// 不同，拖拽落点可能隔着好几步，故同样按目标对象的新下标插入，不能按旧下标算
export function moveStepTo(items, from, to, zone) {
  const out = (Array.isArray(items) ? items : []).slice()
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out
  const target = out[to]
  const [moved] = out.splice(from, 1)
  const t = out.indexOf(target)
  if (t < 0) { out.push(moved); return out }
  out.splice(zone === 'after' ? t + 1 : t, 0, moved)
  return out
}

// ── 队列层拖拽：左右边缘落点（对齐上游 bubbleRowZone 0.22/0.78 + bubblePairDrop / bubbleSideSplitDrop）──
// 上游口径：单泡拖到目标行左/右 22% 边缘 = 并列（左边缘 = 拖入泡做 A，右边缘 = 做 B，权重 1:1 ——
// 拖进来的是两个不同内容的泡，等概率更合理；「改成并列」按钮是复制自己，才用 10:2 让原内容为主）；
// 拖到并列泡边缘 = 替换该侧内容（破坏性，编辑器层做行内二次确认）；并列泡的 A/B 可单独拖出拆分。
// 与 moveStepTo 一样按「目标对象的新下标」插入，不能按旧下标算。

// 两个单泡并成 A/B 并列步。src 或 dst 已是并列泡时原样返回（并列行只能整步排序，不可再并入）
export function pairSteps(items, from, to, zone) {
  const out = (Array.isArray(items) ? items : []).slice()
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out
  if (zone !== 'pairL' && zone !== 'pairR') return out
  const src = out[from]
  const dst = out[to]
  if (!src || !dst || isChoiceStep(src) || isChoiceStep(dst)) return out
  const options = zone === 'pairL'
    ? [{ w: 1, item: clone(src) }, { w: 1, item: clone(dst) }]
    : [{ w: 1, item: clone(dst) }, { w: 1, item: clone(src) }]
  // 先摘下标大的再摘小的才不会错位；并列步落在目标行的原槽位（拖向下 → to-1，拖向上 → to）
  out.splice(Math.max(from, to), 1)
  out.splice(Math.min(from, to), 1)
  const insertAt = from < to ? to - 1 : to
  out.splice(Math.min(Math.max(insertAt, 0), out.length), 0, { kind: 'choice', options })
  return out
}

// 单泡替换并列泡某一侧的泡内容（权重保留原侧的），拖入步移除。
// 上游在此弹 confirm，本项目编辑器统一走行内确认条，本函数只负责确认后的落库
export function replaceChoiceSide(items, from, to, side) {
  const out = (Array.isArray(items) ? items : []).slice()
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out
  const src = out[from]
  const dst = out[to]
  if (!src || isChoiceStep(src) || !isChoiceStep(dst)) return out
  const oi = side === 1 ? 1 : 0
  if (!dst.options[oi]) return out
  const options = dst.options.map((o, k) => (k === oi ? { w: o.w, item: clone(src) } : o))
  out.splice(to, 1, { kind: 'choice', options })
  out.splice(from, 1)
  return out
}

// 把并列泡的 A/B 拖出拆成独立单泡（上游 bubbleSideSplitDrop）：
// 拖到别的行前/后 = 拆出插入；拖回本行上/下半 = 调换 A/B 次序（拆成两个单泡）；
// 剩下的另一侧自动还原为普通单泡
export function splitChoiceSide(items, from, side, to, zone) {
  const out = (Array.isArray(items) ? items : []).slice()
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out
  if (zone !== 'before' && zone !== 'after') return out
  const step = out[from]
  if (!isChoiceStep(step)) return out
  const si = side === 1 ? 1 : 0
  const opt = step.options[si]
  if (!opt) return out
  const moved = clone(opt.item)
  const rest = step.options.filter((_, k) => k !== si)
  if (from === to) {
    // 拖回本行 = 调换 A/B：剩侧占原槽位，拖出侧按落点插到它前/后
    if (!rest.length) return out
    out.splice(from, 1, clone(rest[0].item))
    out.splice(zone === 'before' ? from : from + 1, 0, moved)
    return out
  }
  const target = out[to]
  // 只剩一侧 → 该行还原为普通单泡；否则整行摘除
  if (rest.length === 1) out.splice(from, 1, clone(rest[0].item))
  else out.splice(from, 1)
  const t = out.indexOf(target)
  if (t < 0) { out.push(moved); return out }
  out.splice(zone === 'after' ? t + 1 : t, 0, moved)
  return out
}

// 单泡 → 并列泡：复制当前泡为 A、B 两个候选（权重 10:2，与出厂默认同口径）
export function toChoiceStep(step) {
  if (isChoiceStep(step)) return step
  const item = clone(step || emptyBubble())
  return {
    kind: 'choice',
    options: [
      { w: 10, item: item },
      { w: 2, item: clone(item) },
    ],
  }
}

// 并列泡 → 单泡：保留 A 泡（idx 0）。宿主也有「只剩 1 个候选降级单选」的同口径兜底
export function toSingleStep(step) {
  if (!isChoiceStep(step)) return step
  return clone(step.options[0].item)
}

// 改写某个「泡」的 modules（单泡直改；并列泡按 side 选 A/B，side<0 视为 0）
export function setStepModules(step, side, modules) {
  if (isChoiceStep(step)) {
    const next = clone(step)
    const idx = side < 0 ? 0 : side
    if (next.options[idx]) next.options[idx].item.modules = modules
    return next
  }
  const next = clone(step || emptyBubble())
  next.modules = modules
  return next
}

// 读取某个「泡」的 modules（进入单泡编辑时用）
export function stepModules(step, side) {
  if (isChoiceStep(step)) {
    const idx = side < 0 ? 0 : side
    const opt = step.options[idx]
    return opt && opt.item && Array.isArray(opt.item.modules) ? opt.item.modules : []
  }
  return step && Array.isArray(step.modules) ? step.modules : []
}

// ──────────────────────────────────────────────
// 模块级操作（W2 用）：二维行 → 扁平 modules[]，再经 setStepModules 落回步骤
// ──────────────────────────────────────────────
// 所有函数都接收「二维行」并返回「扁平 modules[]」—— 编辑器内部用行更好操作，
// 落回步骤时必须压平（否则 normBubbleModules 会按旧 row 键重新分组，行序就乱了）。
// 越界一律安全返回原数组的扁平化副本，不抛错。

// 深拷贝一整组行（读进来做草稿，避免编辑器改到 cfg 的引用）
export function cloneRows(rows) {
  return bubbleRowsFromMods(bubbleApplyRowLayout(rows)).map((r) => r.slice())
}

// 新增一个模块：默认落在末尾新起一行。返回 { rows, ok, reason }
// ok=false 的原因：图片类已存在（图片独占一行，多张会挤垮版式）/ 行数已满
export function addModule(rows, type) {
  const cur = cloneRows(rows)
  const hasImg = cur.some((r) => r.length && isImgMod(r[0].type))
  if (isImgMod(type) && hasImg) return { rows: cur, ok: false, reason: '一个泡里只能放一张图片' }
  if (cur.length >= BUBBLE_ROW_MAX) return { rows: cur, ok: false, reason: `最多 ${BUBBLE_ROW_MAX} 行` }
  cur.push([emptyMod(type)])
  return { rows: cur, ok: true }
}

export function removeModule(rows, ri, mi) {
  const cur = cloneRows(rows)
  const row = cur[ri]
  if (!row || mi < 0 || mi >= row.length) return cur
  row.splice(mi, 1)
  if (!row.length) cur.splice(ri, 1)
  return cur
}

// 把某个模块整行挪到目标行位置（拖拽排序用）；同位置 = 原样返回
export function moveModule(rows, ri, mi, target) {
  const cur = cloneRows(rows)
  const row = cur[ri]
  if (!row || mi < 0 || mi >= row.length || target < 0 || target >= cur.length || target === ri) return cur
  const [m] = row.splice(mi, 1)
  const removedRow = !row.length
  // 自己那行被抽走后，目标下标要前移一格（否则会插到目标行的下一行去）
  const at = removedRow && target > ri ? target - 1 : target
  if (removedRow) cur.splice(ri, 1)
  cur.splice(at, 0, [m])
  return cur
}

// ── 拖拽落点（对齐上游 bubblePvMoveRow / bubblePvDropBlock 的 zone 口径）──
// zone 五态：'pairL' / 'pairR' = 并入目标行首 / 行尾；'before' / 'after' = 另起一行插在目标行前 / 后。
// 'join' 是调色板 chip 的落点（等价 append），复用现成的 addToRow，不必单开函数。

// 整行排序：把 from 行挪到 to 行的前 / 后（zone = 'before' | 'after'）。
// 用「先摘出、再按目标对象的新下标插入」两步 —— 直接按旧下标算会因摘除而错位
export function moveRowTo(rows, from, to, zone) {
  const cur = cloneRows(rows)
  if (from < 0 || from >= cur.length || to < 0 || to >= cur.length || from === to) return cur
  const target = cur[to]
  const [moved] = cur.splice(from, 1)
  const t = cur.indexOf(target)
  if (t < 0) { cur.push(moved); return cur }
  cur.splice(zone === 'after' ? t + 1 : t, 0, moved)
  return cur
}

// 整行挪到末尾（拖到列表下方空白区）
export function moveRowEnd(rows, ri) {
  const cur = cloneRows(rows)
  if (ri < 0 || ri >= cur.length || ri === cur.length - 1) return cur
  cur.push(cur.splice(ri, 1)[0])
  return cur
}

// 把某模块拖到目标行的指定落点。返回 { rows, ok, reason }（失败时不落库，只回原因）
export function dropModule(rows, riFrom, miFrom, riTarget, zone) {
  const cur = cloneRows(rows)
  const rowFrom = cur[riFrom]
  const rowTgt = cur[riTarget]
  if (!rowFrom || miFrom < 0 || miFrom >= rowFrom.length || !rowTgt) {
    return { rows: cur, ok: false, reason: '落点不存在' }
  }
  const m = rowFrom[miFrom]
  // 图片永远独占一行：涉及图片的「并入」降级为「在目标行上方另起一行」（与上游同口径）
  const join = (zone === 'pairL' || zone === 'pairR') && !isImgMod(m.type) && !isImgMod(rowTgt[0].type)
  if (join && rowTgt.length >= BUBBLE_MOD_MAX) {
    return { rows: cur, ok: false, reason: `同一行最多 ${BUBBLE_MOD_MAX} 个模块，无法再并入` }
  }
  // 另起一行前先判行数上限：来源行若只有这一个模块，摘掉后它会整行消失，等于不多占一行
  const willEmptyFrom = rowFrom.length === 1
  if (!join && cur.length - (willEmptyFrom ? 1 : 0) >= BUBBLE_ROW_MAX) {
    return { rows: cur, ok: false, reason: `最多 ${BUBBLE_ROW_MAX} 行，无法另起一行` }
  }
  rowFrom.splice(miFrom, 1)
  if (!rowFrom.length) cur.splice(riFrom, 1)
  const tIdx = cur.indexOf(rowTgt)
  // 拖回自己那一行且该行被抽空（单模块行拖到自己的上 / 下沿）= 位置没变，原样返回
  if (tIdx < 0) return { rows: cloneRows(rows), ok: true }
  if (join) {
    const tgt = cur[tIdx]
    tgt.splice(zone === 'pairL' ? 0 : tgt.length, 0, m)
    return { rows: cur, ok: true }
  }
  const at = zone === 'after' ? tIdx + 1 : tIdx
  cur.splice(at, 0, [m])
  return { rows: cur, ok: true }
}

// 把某模块拖到末尾独立成行（拖到列表下方空白区）
export function moveModuleEnd(rows, ri, mi) {
  const cur = cloneRows(rows)
  const row = cur[ri]
  if (!row || mi < 0 || mi >= row.length) return cur
  if (cur.length - (row.length === 1 ? 1 : 0) >= BUBBLE_ROW_MAX) return cur
  const [m] = row.splice(mi, 1)
  if (!row.length) cur.splice(ri, 1)
  cur.push([m])
  return cur
}

// 行内加一格：同一行最多 BUBBLE_MOD_MAX 个模块；图片类不能与别的模块同行（渲染侧独占一行）
export function addToRow(rows, ri, type) {
  const cur = cloneRows(rows)
  const row = cur[ri]
  if (!row) return { rows: cur, ok: false, reason: '这一行不存在' }
  if (isImgMod(type) || row.some((m) => isImgMod(m.type))) {
    return { rows: cur, ok: false, reason: '图片必须独占一行' }
  }
  if (row.length >= BUBBLE_MOD_MAX) return { rows: cur, ok: false, reason: `一行最多 ${BUBBLE_MOD_MAX} 个模块` }
  row.push(emptyMod(type))
  return { rows: cur, ok: true }
}

// 行级：删整行 / 上下挪一行
export function removeRow(rows, ri) {
  const cur = cloneRows(rows)
  if (ri < 0 || ri >= cur.length) return cur
  cur.splice(ri, 1)
  return cur
}

export function moveRow(rows, ri, dir) {
  const cur = cloneRows(rows)
  const to = ri + dir
  if (ri < 0 || ri >= cur.length || to < 0 || to >= cur.length) return cur
  const tmp = cur[ri]
  cur[ri] = cur[to]
  cur[to] = tmp
  return cur
}

// 改写某个模块：patch 是一组字段（undefined 表示「删掉这个键」，与 store.js 的摘键口径一致）。
// 用 in 判断而不是 !== undefined，才能让调用方显式传 undefined 来摘键（如清空颜色）
export function setModule(rows, ri, mi, patch) {
  const cur = cloneRows(rows)
  const row = cur[ri]
  if (!row || mi < 0 || mi >= row.length) return cur
  const next = Object.assign({}, row[mi])
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) delete next[k]
    else next[k] = patch[k]
  }
  row[mi] = next
  return cur
}

// ──────────────────────────────────────────────
// 模块库（lib）：另存一个模块复用。id 生成规则与 store.js normBubbleLib 的补号口径一致，
// 但这里主动生成，避免依赖宿主补号（补号发生在落库时，编辑器里就得先有 id 才能引用）
// ──────────────────────────────────────────────
export function newLibId() {
  return 'bmod_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
}

// 入库存的是一个模块的深拷贝（脱钩，之后改泡里那份不会动到库）
export function addLibModule(lib, module, name) {
  const cur = Array.isArray(lib) ? lib.slice() : []
  if (cur.length >= BUBBLE_LIB_MAX) return cur
  const nm = String(name == null ? '' : name).trim().slice(0, BUBBLE_LIB_NAME_MAX) || ('模块' + (cur.length + 1))
  cur.push({ id: newLibId(), name: nm, module: clone(module) })
  return cur
}

export function removeLibModule(lib, id) {
  return (Array.isArray(lib) ? lib : []).filter((it) => it && it.id !== id)
}

// 库里取一个模块的深拷贝（塞进泡时用，避免两处引用同一对象）
export function libModuleById(lib, id) {
  const it = (Array.isArray(lib) ? lib : []).find((x) => x && x.id === id)
  return it && it.module ? clone(it.module) : null
}

// ──────────────────────────────────────────────
// 调色板 / 预设（上游 bubblePaletteModule 的适配版）
// ──────────────────────────────────────────────
// 平衡色板：深底 / 浅底各一组，覆盖「一眼看清」的强对比需求（出厂首泡就是深蓝纯色）
export const BUBBLE_PRESET_COLORS = [
  '#3b4d8f', '#1f2937', '#0f766e', '#b91c1c', '#7c3aed', '#0369a1',
  '#c2410c', '#15803d', '#be185d', '#a16207', '#e5e7eb', '#ffffff',
]
// 快速摆放的常用模块（一行一个，配 label 供按钮显示）
export const BUBBLE_QUICK_MODS = [
  { type: 'text', label: '文本' },
  { type: 'balance', label: '总余额' },
  { type: 'today', label: '今日已用' },
  { type: 'time', label: '报时' },
  { type: 'random', label: '随机语句' },
  { type: 'peak', label: '峰谷' },
  { type: 'session', label: '对话名' },
  { type: 'image', label: '图片' },
]

// ──────────────────────────────────────────────
// 模块类型专属的字段可见性（W2 属性面板按此渲染）
// ──────────────────────────────────────────────
// 哪些模块的正文由运行时数据决定（内容锁定）→ 只给模板框；text/random/link/image/randimg 给内容框
export function modNeedsTpl(type) {
  return modContentLocked(type) || type === 'peak' || type === 'session'
}
// 颜色字段：峰谷用 peakColor/offColor，其余用 color
export function modHasStyleColor(type) {
  return type !== 'peak'
}
// image 模块的 imgId 语义（与浮动页 bubbleImgSrc 一致）：'' / '0' = 随机抽一张，
// 1..N = 指定已导入气泡图里的第 N 张。面板用它做下拉，故单独抽出来免得到处写魔法值
export function imgIdRandom() {
  return '0'
}
export function imgIdOf(v) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? String(n) : imgIdRandom()
}

// 深拷贝（编辑器快照 / 试播载荷都要求与配置脱钩）
function clone(v) {
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return Array.isArray(v) ? [] : {}
  }
}

export function cloneBubbleItems(items) {
  const c = clone(Array.isArray(items) ? items : [])
  return Array.isArray(c) ? c : []
}
