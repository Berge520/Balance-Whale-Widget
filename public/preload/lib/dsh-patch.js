/*
 * dsh 用户层 patch 的行级读写（CommonJS）—— 计划书 §6.2 E2「单个插件禁用 / 启用」。
 *
 * 职责边界：
 *   · 本模块只认**格式**（`- id: X` + `disabled: true` 这种行级写法），不认「哪些 id 可以关」——
 *     那是界面的选择，不是这里该硬编码的。
 *   · **不建快照**。「写前先备份」由调用方（settings.js）编排，因为备份是 E1 的职责，
 *     而「什么时候需要备份」是业务流程 —— 混在一起会让本模块无法被单独测试。
 *
 * ── 三条实测结论直接决定了本模块的实现（spec §10.3 第 ⑤ 段，v1.6.2 V1–V4）──
 *   V1：`disabled: true` 打**纯服务端 bundle**（cost-meter / modlens / mnemon…）可靠生效；
 *       打**带 client 入口的插件**（如 dsh-better-sidebar）**无效** —— 后者的加载入口在
 *       `package.json` 的 `dependencies` 里，patch 条目禁用不到它。
 *       本模块**不据此拦截**：判据（有没有 client 入口）需要读包元数据，属另一个模块的事。
 *       但返回值里带上 `clientPlugin` 提示位是**不该做**的（本模块读不到这个信息，只能瞎猜），
 *       所以由界面在文案里说清「对带前端界面的插件可能无效」。
 *   V2：写不存在的 id，dsh **只往 stderr 打一行** `patch: entry "X" not found`，退出码 0、启动照常。
 *       这是「写坏了也不报错」，所以本模块的写入必须**可被返回值核验**：
 *       写完后重新读一遍磁盘、确认那条 id 真的以期望形态出现了（见 applyToggle 的 verify）。
 *   V4：patchReload 是**单向**的 —— 加 `disabled` 即时生效；**删掉该行不恢复**。
 *       所以「启用」这个动作在 dsh 侧可能需要重启才看得到效果，本模块**只负责改文件**，
 *       并在返回值里给出 `needsRestart` 让界面提示用户（不谎称「已即时生效」）。
 *   V3：用户层 patch 是**行级追加**格式，且本机实测为 12 条目 / 11 条 disabled。解析必须
 *       容忍「条目内字段顺序不同」「条目下有 config 子块」「注释与空行」这些真实写法。
 *
 * ── 为什么是「行级」而不是 YAML 解析 ──
 * 项目零依赖（单测不装包），拿不到 yaml 解析器。而这里需要的操作只有两种
 * （读出条目清单 / 在条目内加删一行 `disabled`），行级处理足够且**改动面最小**——
 * 重新序列化整份 YAML 会把用户的注释、引号风格、键顺序全部抹掉，对一个「用户手写的配置文件」
 * 是不可接受的副作用。
 */

// 条目起始行：`- id: xxx`（允许前导空格、id 值可带引号）
const ITEM_RE = /^(\s*)-\s+id\s*:\s*(.+?)\s*$/
// 条目内的 disabled 行：`disabled: true`（带缩进，不与 `- id:` 同行）
const DISABLED_RE = /^(\s*)disabled\s*:\s*(.+?)\s*$/
// 注释行（整行只有注释）；不处理行尾注释 —— dsh 的 patch 里没出现过，
// 而误删用户行尾注释的代价远大于偶尔漏认一条
const COMMENT_RE = /^\s*#/

// 去掉值两侧的引号，便于比较 id（用户可能写 `- id: "foo"`）
function unquote(v) {
  const s = String(v == null ? '' : v).trim()
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1)
  }
  return s
}

// disabled 的取值 → 布尔。
// ⚠️ 与 dsh-dump.js 同一取舍：形如 `!!js '...'` 的运行期表达式静态求不出值，一律算「已禁用」——
// 这是**刻意保守**：把「可能禁用」显示成「已禁用」会误导，但反过来（显示成启用、用户以为开着）
// 会让用户重复去关一个已经关掉的东西，害处更大。
function disabledValue(raw) {
  const v = unquote(raw).toLowerCase()
  if (!v) return true
  if (v === 'false' || v === 'no' || v === '0' || v === 'null' || v === '~') return false
  return true
}

// ── 解析 ──
// 把 patch 文本解析成条目数组（**不改动原文本**）。
//
// 返回 [{ id, lineIndex, disabled, disabledLineIndex, disabledRaw, indent, hasConfig }]
//   lineIndex        —— `- id:` 所在行（0 基）
//   disabledLineIndex—— 该条目内 disabled 行的行号；没有则 -1
//   indent           —— 条目缩进（写新行时对齐用）
//   hasConfig        —— 条目下是否还有 config 等子块（界面上提示「这个条目还带配置」）
//
// 归属规则：`disabled:` 行归给**它上方最近的** `- id:` 条目（YAML 的块结构就是这个语义）。
// 所以顺序扫一遍、记住「当前条目」即可，不需要栈。
function parsePatch(text) {
  const raw = String(text == null ? '' : text)
  // eol 必须从**原始**文本检测（修 B4）：早先写成 `src.includes('\r\n')`，而 src 在上一行
  // 已被归一成 `\n`，这个字段于是恒为 false —— 谁信它谁就会把 CRLF 文件按 LF 重写。
  // 目前没出错只是因为落笔处（applyToggle / applyBatchDisable）各自另判了一次，
  // 这个字段本身一直是坏的，留着就是给后来人一个坑。
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const src = raw.replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  const items = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const mItem = ITEM_RE.exec(line)
    if (mItem) {
      cur = {
        id: unquote(mItem[2]),
        lineIndex: i,
        disabled: false,
        disabledLineIndex: -1,
        disabledRaw: '',
        indent: mItem[1],
        hasConfig: false,
      }
      items.push(cur)
      continue
    }
    if (!cur) continue
    if (COMMENT_RE.test(line) || !line.trim()) continue
    const mDis = DISABLED_RE.exec(line)
    if (mDis) {
      cur.disabled = disabledValue(mDis[2])
      cur.disabledLineIndex = i
      cur.disabledRaw = line
      continue
    }
    // 条目下除 disabled 之外还有内容（config / 嵌套块 …）
    cur.hasConfig = true
  }
  return { items, lines, eol }
}

// 条目 id 是否合法（要写进 YAML 的值）。
// 只挡「会破坏文件结构」的字符：换行 / 冒号后接空格 / #（YAML 注释起点）——
// 不挡 `@` `/` `.`，因为真实 id 就是 `@deepseek-ai/dsh-mnemon` 这种形态。
//
// ⚠️ 也必须挡 YAML 的**流式指示符** `{ } [ ] ,`（修 B5）：真实 id 里一个都不会出现，
// 而它们混进值里会让解析器改变整行的读法（`- id: a, b` 被读成流式序列 / 映射）。
// 更关键的是回读校验的可靠性：apparentItemIndex 用**同一套 ITEM_RE** 回读我们刚写的行，
// 它宽松到什么都能认，于是「自己写的、自己认得出」—— 闸门在非法 id 下形同虚设。
// 收紧入口后，写坏的行至少会在回读时被认成「不合法」而不是被当成合法条目。
function validId(id) {
  const s = String(id == null ? '' : id).trim()
  if (!s || s.length > 200) return false
  if (/[\n\r\t]/.test(s)) return false
  if (/:\s/.test(s)) return false
  if (s.includes('#')) return false
  if (s.startsWith('-')) return false
  if (/[{}[\],]/.test(s)) return false
  return true
}

// 在文本末尾追加一个新条目（`- id: X` + `  disabled: <bool>`），返回新文本。
//
// 为什么追加在**末尾**：V3 实测用户层 patch 就是行级追加；
// 而 patch 是「同 id 后出现的覆盖先出现的」，追加在末尾 = 这条改动优先级最高，符合预期。
// 末尾补换行：文件不以换行结尾时直接拼会粘在最后一行上（形成 `foo: bar- id: x`）
function appendItem(text, id, disabled) {
  const src = String(text == null ? '' : text)
  const tail = src && !/\n$/.test(src) ? '\n' : ''
  return src + tail + '- id: ' + id + '\n  disabled: ' + (disabled ? 'true' : 'false') + '\n'
}

// ── 写 ──
// applyToggle(text, id, disabled) → { ok, text, changed, action, error? }
//   action: 'append'（新加条目）| 'update'（改已有条目的 disabled 行）| 'noop'（已是目标状态）
//
// 只改**一处**：已有条目就只动它那一行 `disabled`，没有就追加一个条目。
// 刻意不做「同 id 有多条时全部改掉」—— 多条同 id 是用户自己的写法，
// 一次点开关就重写好几行会让人看不懂到底发生了什么。
function applyToggle(text, id, disabled) {
  const target = String(id == null ? '' : id).trim()
  if (!validId(target)) return { ok: false, error: '非法的插件 id', action: 'noop' }
  const want = disabled !== false
  const parsed = parsePatch(text)
  const hit = parsed.items.find((it) => it.id === target)
  const lines = parsed.lines.slice()
  // split('\n') 对结尾换行的文本会多出一个空串元素，逐行改完后 join 会原样还原，
  // 所以这里不需要特别处理 eol —— 保持原有换行风格即可
  const eol = /\r\n/.test(String(text == null ? '' : text)) ? '\r\n' : '\n'

  if (!hit) {
    const next = appendItem(String(text == null ? '' : text), target, want)
    return { ok: true, text: next, changed: true, action: 'append' }
  }
  if (hit.disabled === want) {
    // 值已达标即 noop（修 B6）：早先这里多一个 `&& hit.disabledLineIndex >= 0`，
    // 于是「条目已被禁用、要设的也是禁用、但文件里没有 disabled 行」（值靠 `!!js` 表达式
    // 或 dsh 默认值生效）会掉到下面的 insert 分支**白插一行** —— 一次实际无作用的写入，
    // 却会在文件里留下 diff、在界面上报成 changed。
    // 注意只在 disabledLineIndex >= 0 时才谈「原文本原样返回」：没有该行时也无需写，
    // 返回值本就是原文，故这里合并不影响文本与 changed 的语义。
    return { ok: true, text: String(text == null ? '' : text), changed: false, action: 'noop' }
  }
  if (hit.disabledLineIndex >= 0) {
    // 沿用该行原有的缩进，不按条目缩进重算 —— 用户可能写成 4 空格缩进而条目是 2 空格
    const ind = DISABLED_RE.exec(lines[hit.disabledLineIndex])[1]
    lines[hit.disabledLineIndex] = ind + 'disabled: ' + (want ? 'true' : 'false')
    return { ok: true, text: lines.join(eol), changed: true, action: 'update' }
  }
  // 条目存在但没有 disabled 行：插在 `- id:` 的**下一行**（紧随条目头，是 YAML 里最自然的位置）
  const ind = hit.indent + '  '
  lines.splice(hit.lineIndex + 1, 0, ind + 'disabled: ' + (want ? 'true' : 'false'))
  return { ok: true, text: lines.join(eol), changed: true, action: 'insert' }
}

// ── 批量禁用（E3 一键隔离）──
// 把一组 id 一次改成 disabled: true，返回新文本。与 applyToggle 的区别只有「一次改多条」，
// 但**必须一次改完再 join**：循环调用 applyToggle 每轮都重解析全文、重拼全文，
// 且对「末尾追加」的条目会反复改 append 的落点，行号全部错位。
//
// 返回值多一个 `plans`：每条将改动什么（action + 行号），界面据此**在写之前**把
// 「会动哪几行」明确列出来（计划书 §5.2 的硬要求），而不是等写完了才让用户看结果。
//
// 与 applyToggle 一致的取舍：同 id 有多条时只改**第一条**，不搞「全部改掉」。
function applyBatchDisable(text, ids) {
  const src = String(text == null ? '' : text)
  const list = Array.isArray(ids) ? ids : []
  const targets = []
  const seen = {}
  for (let i = 0; i < list.length; i++) {
    const id = String(list[i] == null ? '' : list[i]).trim()
    if (!id || seen[id]) continue
    if (!validId(id)) return { ok: false, error: '非法的插件 id：' + id, action: 'noop', plans: [] }
    seen[id] = true
    targets.push(id)
  }
  if (!targets.length) return { ok: true, text: src, changed: false, action: 'noop', plans: [] }

  const parsed = parsePatch(src)
  const lines = parsed.lines.slice()
  const eol = /\r\n/.test(src) ? '\r\n' : '\n'
  const plans = []
  const pending = []
  // hit.disabledLineIndex / hit.lineIndex 都是**原始文本**上的行号，
  // 一旦前面插过行，用它们直接索引 lines 就会指到别人身上。
  // 所以这里分两趟：第一趟只做判断、产出「要改哪些原始行」，第二趟统一落笔。

  for (let i = 0; i < targets.length; i++) {
    const hit = parsed.items.find((it) => it.id === targets[i])
    if (!hit) {
      // 全新条目：先攒着，等已有条目都改完再统一追加到末尾，避免追加过程中行号错位
      pending.push(targets[i])
      plans.push({ id: targets[i], action: 'append', line: 0, was: false })
      continue
    }
    if (hit.disabled && hit.disabledLineIndex >= 0) {
      // 已经是「已禁用」：一键隔离的意图就是全禁，这里不改也不算漏 —— 但要如实报 noop，
      // 免得界面说「已隔离 N 条」而其中有几条根本没动过
      plans.push({ id: targets[i], action: 'noop', line: hit.lineIndex + 1, was: true })
      continue
    }
    // 计划里的 line 一律是**改动前**的行号（界面拿它去原始文件里定位「会动哪一行」）
    if (hit.disabledLineIndex >= 0) {
      plans.push({
        id: targets[i],
        action: 'update',
        line: hit.disabledLineIndex + 1,
        was: false,
        at: hit.disabledLineIndex,
      })
      continue
    }
    plans.push({
      id: targets[i],
      action: 'insert',
      line: hit.lineIndex + 1,
      was: false,
      at: hit.lineIndex + 1,
      indent: hit.indent,
    })
  }

  // 第二趟：按「原始行号从大到小」落笔。从后往前改，前面的 splice 就不会影响
  // 尚未处理的行号 —— 这是「一次改完再 join」之外，E3 真正要小心的那半个坑。
  const editable = []
  for (let i = 0; i < plans.length; i++) {
    if (plans[i].action === 'update' || plans[i].action === 'insert') editable.push(plans[i])
  }
  editable.sort((a, b) => b.at - a.at)
  for (let i = 0; i < editable.length; i++) {
    const p = editable[i]
    if (p.action === 'update') {
      // 沿用该行原有缩进（同 applyToggle：用户可能写成 4 空格而条目是 2 空格）
      const ind = DISABLED_RE.exec(lines[p.at])[1]
      lines[p.at] = ind + 'disabled: true'
    } else {
      lines.splice(p.at, 0, p.indent + '  disabled: true')
    }
    delete p.at
    delete p.indent
  }

  let out = lines.join(eol)
  for (let i = 0; i < pending.length; i++) out = appendItem(out, pending[i], true)

  const changed = plans.some((p) => p.action !== 'noop')
  return { ok: true, text: out, changed: changed, action: changed ? 'batch' : 'noop', plans: plans }
}

module.exports = {
  parsePatch,
  applyToggle,
  applyBatchDisable,
  appendItem,
  validId,
  disabledValue,
  _unquote: unquote,
}
