/*
 * dsh 用户层 patch 的行级读写（CommonJS）—— 计划书 §6.2 E2「单个插件禁用 / 启用」。
 *
 * 职责边界：
 *   · 本模块只认**格式**（`- id: X` + `disabled: true` 这种行级写法），不认「哪些 id 可以关」——
 *     那是界面的选择，不是这里该硬编码的。
 *   · **不建快照**。「写前先备份」由调用方（settings.js）编排，因为备份是 E1 的职责，
 *     而「什么时候需要备份」是业务流程 —— 混在一起会让本模块无法被单独测试。
 *
 * ── 三条实测结论直接决定了本模块的实现（docs/spec/10-settings-history.md §10.3 第 ⑤ 段，v1.6.2 V1–V4）──
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
// 映射键：`config:` / `providers:` 这类「冒号后有内容」的行。
// 只用来判断「这一行是否打开了一个嵌套块」——零依赖下不做完整 YAML 解析，
// 判据是冒号后为空 / 只有注释 / 是块标量（`|` `>`），见 parsePatch 里的用法。
const KEY_RE = /^(\s*)([^\s:#-][^:]*?)\s*:\s*(.*)$/
// 列表项（`- foo` / `- foo:`）：YAML 允许把列表写在所属键的同一列，
// 这一条用来区分「同列的 `- ` 是负载列表」与「同列的普通键是条目的兄弟键」。
const LIST_RE = /^\s*-(?:\s|$)/

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

// disabled 的取值是不是**字面量**（true / false / yes / no / 0 / 1 …）。
// 不是字面量就是表达式（典型 `!!js 'process.env.X'`）：它的值由 dsh 在组合时求值，
// 市场**读不出也替不了**，所以写入时必须把它当「别人的决定」对待（上游 #1043）。
// ⚠️ 与 disabledValue 分开：后者回答「当前算不算禁用」，本函数回答「能不能覆盖」。
//    把两者合并会让「表达式按保守口径算禁用」被误推成「可以写字面量禁用」。
function isLiteralDisabled(raw) {
  const v = unquote(raw).toLowerCase()
  return v === '' || v === 'true' || v === 'false' || v === 'yes' || v === 'no'
    || v === 'on' || v === 'off' || v === '1' || v === '0' || v === 'null' || v === '~'
}

// ── 解析 ──
// 把 patch 文本解析成条目数组（**不改动原文本**）。
//
// 返回 [{ id, lineIndex, disabled, disabledExpr, disabledLineIndex, disabledRaw, indent, hasConfig }]
//   lineIndex        —— `- id:` 所在行（0 基）
//   disabledLineIndex—— 该条目内 disabled 行的行号；没有则 -1
//   disabledExpr     —— disabled 的取值是表达式（`!!js …`）而非字面量；写入时不能覆盖它
//   indent           —— 条目缩进（写新行时对齐用）
//   hasConfig        —— 条目下是否还有 config 等子块（界面上提示「这个条目还带配置」）
//
// 归属规则：`disabled:` 行归给**它上方最近的** `- id:` 条目（YAML 的块结构就是这个语义）。
// 所以顺序扫一遍、记住「当前条目」即可，不需要栈。
//
// ⚠️ 但「上方最近的 `- id:`」不够 —— 还必须区分**条目**与**条目的 config 负载**
//    （上游 #841 系列的真实事故）：
//      - id: a
//        config:
//          providers:
//            - id: b        ← b 是负载里的列表项，不是 patch 条目
//            disabled: true ← 也不是 a 的 disabled，是 b 自己的字段
//    早先任何 `- id:` 都开新条目、任何 `disabled:` 都归当前条目，于是界面多出假插件、
//    勾选还会改到负载里的行。这里用一个 `payloadIndent`（打开嵌套块的键的缩进）标记
//    负载区间：深于该键的行一律算负载；回到该键所在层才恢复成条目字段。
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
  // 当前条目里「打开了一个嵌套块」的键的缩进；-1 = 不在负载里。
  // 只记最外层：进了 config 之后，更深的键 / 列表项都属于它，不再更新这个值。
  let payloadIndent = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const mItem = ITEM_RE.exec(line)
    if (mItem) {
      const markerIndent = mItem[1].length
      if (cur && markerIndent > cur.indent.length) {
        // 比条目头更深 = 负载里的列表项（`config:` 下常写成 `- id: x`），不是新条目
        if (payloadIndent < 0 || markerIndent < payloadIndent) payloadIndent = markerIndent
        cur.hasConfig = true
        cur.endLineIndex = i
        continue
      }
      cur = {
        id: unquote(mItem[2]),
        lineIndex: i,
        disabled: false,
        disabledExpr: false,
        disabledLineIndex: -1,
        disabledRaw: '',
        indent: mItem[1],
        hasConfig: false,
        // 该条目**最后一行内容**的原始行号（空行 / 注释不算，它们不归任何条目）。
        // 整段删（removeItem / 启用时删多余段）要靠它定段尾：只按「下一个条目的头行」
        // 反推段尾，会在两段之间有注释 / 空行时把它们一并当成上一段的成员删掉。
        endLineIndex: i,
      }
      items.push(cur)
      payloadIndent = -1
      continue
    }
    if (!cur) continue
    if (COMMENT_RE.test(line) || !line.trim()) continue

    const ind = line.length - line.trimStart().length
    const isList = LIST_RE.test(line)
    if (payloadIndent >= 0) {
      // 「列表与键同列」是合法 YAML（`config:` 下面的 `- id:` 可以写在 config 那一列）。
      // 同列的 `- ` 仍是负载；同列的普通键（如 `disabled:`）才算回到条目自己的键层。
      if (ind < payloadIndent || (ind === payloadIndent && !isList)) payloadIndent = -1
    }
    if (payloadIndent >= 0 && ind > payloadIndent) {
      cur.hasConfig = true
      cur.endLineIndex = i
      continue
    }

    const mDis = DISABLED_RE.exec(line)
    if (mDis) {
      cur.disabled = disabledValue(mDis[2])
      cur.disabledExpr = !isLiteralDisabled(mDis[2])
      cur.disabledLineIndex = i
      cur.disabledRaw = line
      // disabled 行本身也是本段的内容行 —— 不更新段尾的话，
      // 「`- id: a` / `  disabled: x` / `- id: b`」里的 a 段尾会停在头行，
      // 整段删时只删头行、把 disabled 行留给下一条目（变成 b 的 disabled）。
      cur.endLineIndex = i
      continue
    }
    // 带 `:` 且冒号后没有值（或只有注释 / 块标量）的键会打开一个嵌套块；
    // 它下面的更深行都算负载，不能再按条目字段读
    const mKey = KEY_RE.exec(line)
    if (mKey && ind > cur.indent.length && payloadIndent < 0) {
      const rest = mKey[3].trim()
      if (rest === '' || rest.startsWith('#') || rest.charAt(0) === '|' || rest.charAt(0) === '>') payloadIndent = ind
    }
    // 条目下除 disabled 之外还有内容（config / 嵌套块 …）
    cur.hasConfig = true
    cur.endLineIndex = i
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

// ── 同 id 多段的取舍（对齐上游 dsh-market #821）──
// patch 的语义是「同 id 后出现的覆盖先出现的」，所以**文件里可能有若干条同 id 的段**：
// 用户手写重复了、或者旧版本的我们追加过好几条。早先本模块只认 `items.find(...)` 的
// 第一条 —— 于是「关掉 X」可能只改了被后面覆盖掉的那条，实际毫无效果，
// 而 dsh 对「写了但没生效」永远不报错（V2），界面只会看到一个勾不动 / 勾不灭的开关。
//
// 现在的口径：
// 落笔口径统一成一句话：**先把自己多余的纯 disabled 段全部删掉，最后只留一段，再在那一段上写值**。
//   · 启用（want=false）：所有纯 `disabled` 两行段都删（true / false 一起删 —— dsh 里
//     disabled 缺省即启用，留个 `disabled: false` 只会让用户下次看不明白）。
//   · 禁用（want=true）：保留一段（优先纯 `disabled` 段）原位改 true，其余纯段删光。
//   · **带 config 等其它字段的段绝不整段删** —— 那会把 config 挂到上一条目身上，
//     静默改坏用户配置。这种段只能改它的 `disabled` 行；此时「只剩一段」改不成，
//     就允许它作为末段留着，只要生效值对（后出现的段覆盖先出现的段）即可。
// 早先的形状是「保留第一段、删后面」，结果第一段带 config 时就成了「一段改值 + 一段保留」，
// 同 id 两段并存 —— 用户自己看文件会看糊涂，收益却一点没有。
// 注意块边界不能硬编码行首 `^` 与两空格缩进：本模块的 ITEM_RE 允许任意缩进。

// 该 id 的全部条目（保持文件顺序）
function itemsOf(parsed, id) {
  return parsed.items.filter((it) => it.id === id)
}

// 该 id 当前**实际生效**的 disabled 值：后出现的段覆盖先出现的段。
// 没有任何段时返回 false（patch 里没写 = 没禁用）。
function effectiveDisabled(parsed, id) {
  const list = itemsOf(parsed, id)
  if (!list.length) return false
  return list[list.length - 1].disabled
}

// 纯 `disabled` 两行段：能被整段安全删掉的形态（没有 config 等子块）
function isPlainBlock(it) {
  return it.disabledLineIndex === it.lineIndex + 1 && !it.hasConfig
}

// 「启用」时该段能不能整块删掉。
// 与 isPlainBlock 的区别：只要求**没带 config 等子块**，不要求 disabled 行紧跟在头行后面
// —— 段里的空行 / 注释行可以一起删（它们本来就是这段的分隔），也不会丢用户的东西。
//
// ⚠️ 判据不能写成「disabled 行紧贴头行」：真实文件常写成
// `- id: a` / 空行 / `  disabled: true`，紧贴判据会把这种段错认成「带内容的段」，
// 于是只改它的 disabled 行、整段留下来 —— 一个本该消失的段被留下了。
function droppable(it) {
  return !it.hasConfig
}

// 禁用时要留下来承载 `disabled: true` 的那一段：
//   优先第一个纯 `disabled` 段 —— 它已经有 disabled 行，原位改值即可，不必插行；
//   没有纯段就用第一段（带 config），只能改它自己的 disabled 行（或插一行）。
function pickKeeper(hits) {
  for (let i = 0; i < hits.length; i++) {
    if (isPlainBlock(hits[i])) return hits[i]
  }
  return hits[0]
}

// 删掉 lines 里给定行号的若干行（行号越高越先删，避免错位）
function dropLines(lines, rowIndexes) {
  const sorted = rowIndexes.slice().sort((a, b) => b - a)
  for (let i = 0; i < sorted.length; i++) lines.splice(sorted[i], 1)
}

// ── 写 ──
// applyToggle(text, id, disabled) → { ok, text, changed, action, blocks?, error? }
//   action: 'append'（新加条目）| 'update'（改已有条目）| 'remove'（删掉多余的段）| 'noop'
//
// changed 一律以「新旧文本是否相同」为准 —— 多段场景下 action 说不清一共动了什么，
// 而调用方（settings.js）只用 changed 决定写不写盘、用回读校验兜正确性。
function applyToggle(text, id, disabled) {
  const src = String(text == null ? '' : text)
  const target = String(id == null ? '' : id).trim()
  if (!validId(target)) return { ok: false, error: '非法的插件 id', action: 'noop' }
  const want = disabled !== false
  const parsed = parsePatch(src)
  const hits = itemsOf(parsed, target)

  if (!hits.length) {
    return { ok: true, text: appendItem(src, target, want), changed: true, action: 'append', blocks: 1 }
  }
  // 值已达标即 noop（修 B6）：早先这里多一个 `&& hit.disabledLineIndex >= 0`，
  // 于是「条目已被禁用、要设的也是禁用、但文件里没有 disabled 行」（值靠 `!!js` 表达式
  // 或 dsh 默认值生效）会掉到 insert 分支**白插一行** —— 一次实际无作用的写入，
  // 却会在文件里留下 diff、在界面上报成 changed。
  // ⚠️ 这里比的是**生效值**（最后一段），不是第一段。
  if (effectiveDisabled(parsed, target) === want) {
    return { ok: true, text: src, changed: false, action: 'noop', blocks: hits.length }
  }

  const lines = parsed.lines.slice()
  // split('\n') 对结尾换行的文本会多出一个空串元素，逐行改完后 join 会原样还原，
  // 所以这里不需要特别处理 eol —— 保持原有换行风格即可（eol 从原始文本检测，见 parsePatch）
  const eol = parsed.eol

  // 「保留段」= 要留下来承载新值的那一段（其余纯段全删）。
  // 禁用时优先挑第一段**纯 disabled 段**：删掉它就得在别处插一行，多一次落笔多一分出错机会。
  // 若一段纯段都没有（全是带 config 的），就保留第一段，只能改它自己的 disabled 行。
  // 启用时没有「保留」的概念，纯段全删即可。
  const keeper = want ? pickKeeper(hits) : null
  const rows = []
  for (let i = 0; i < hits.length; i++) {
    const it = hits[i]
    if (it === keeper) continue
    // ⚠️ `disabled: !!js …` 由 dsh 在组合时求值，市场既读不懂也不该替它决定（上游 #1043）：
    //    启用时写 false / 删段都会强行打开环境本应关掉的行（例如桌面端没有 TUI 服务时，
    //    下一次组合会把插件挂起、安装校验失败）；禁用时也保留原文，由末尾兜底段保证生效。
    //    所以表达式段既不删也不改。
    if (it.disabledExpr) continue
    if (droppable(it) && it.disabledLineIndex >= 0) {
      // 整段删：头行 → 段尾（段尾 = 最后一行属于它的内容行，空行 / 注释已跳过）
      for (let j = it.lineIndex; j <= it.endLineIndex; j++) rows.push(j)
      continue
    }
    // 带 config 的段不能整段删，只能改它自己的 disabled 行。
    // 启用时改成 false（不能只删行 —— 它本来可能没有这一行，删了就什么都不剩，语义对但看不出意图；
    // 写一行 false 让用户一眼看清「这段被显式放行了」）。
    if (it.disabledLineIndex >= 0) {
      const ind = DISABLED_RE.exec(lines[it.disabledLineIndex])[1]
      lines[it.disabledLineIndex] = ind + (want ? 'disabled: true' : 'disabled: false')
    }
  }

  let action = keeper ? 'update' : 'remove'
  if (keeper) {
    if (keeper.disabledLineIndex >= 0) {
      // 表达式行保留（同上）；只有字面量行能改成 true。
      // 若保留段是表达式且没有别的字面量段，下面的兜底会追加一段 true。
      if (!keeper.disabledExpr) {
        // 沿用该行原有的缩进，不按条目缩进重算 —— 用户可能写成 4 空格缩进而条目是 2 空格
        const ind = DISABLED_RE.exec(lines[keeper.disabledLineIndex])[1]
        lines[keeper.disabledLineIndex] = ind + 'disabled: true'
      }
    } else {
      // 保留段没有 disabled 行：插在 `- id:` 的**下一行**（紧随条目头，是 YAML 里最自然的位置）。
      // ⚠️ 不能走末尾 append：那会让条目挪到文件最末、优先级最高，以后手改文件的人看不懂
      lines.splice(keeper.lineIndex + 1, 0, keeper.indent + '  disabled: true')
      action = 'insert'
    }
  }
  if (rows.length) dropLines(lines, rows)
  let out = lines.join(eol)
  // 兜底：判据是**改完之后的生效值**，不是「有没有 config」——
  // 带 config 的段若写着 `!!js '...'`（disabledValue 恒判 true）但用户的实际取值是假，
  // 静态就核不出来，那就再追加一段 true 保证生效。
  // ⚠️ 只在「禁用」（want=true）时兜底。启用时该 id 的段可能已被全部删光，
  // 生效值自然是 false，若也走这里就会追加一段 `disabled: true` —— 刚好把用户的「启用」做成「禁用」。
  if (want && effectiveDisabled(parsePatch(out), target) !== true) out = appendItem(out, target, true)
  // 启用后若最后生效的仍是表达式段（我们没动它），不能对外报「已启用」：
  // 表达式按保守口径恒算「已禁用」，只能如实回传 expression，由调用方解释给用户。
  // （此时对文件的其他改动仍保留：清掉的是同 id 的字面量段，让表达式重新生效，不是用户的条件。）
  const expression = !want && effectiveDisabled(parsePatch(out), target) === true
  if (out === src) action = 'noop'
  return { ok: true, text: out, changed: out !== src, action: action, blocks: hits.length, expression: expression }
}

// ── 批量禁用（E3 一键隔离）──
// 把一组 id 一次改成 disabled: true，返回新文本。与 applyToggle 的区别只有「一次改多条」，
// 但**必须一次改完再 join**：循环调用 applyToggle 每轮都重解析全文、重拼全文，
// 且对「末尾追加」的条目会反复改 append 的落点，行号全部错位。
//
// 返回值多一个 `plans`：每条将改动什么（action + 行号），界面据此**在写之前**把
// 「会动哪几行」明确列出来（计划书 §5.2 的硬要求），而不是等写完了才让用户看结果。
//
// 与 applyToggle 同一口径：同 id 有多段时**全部**处理（保留一段改 true、其余纯 disabled 段删掉），
// 只改第一条会让「生效的那段」原样留着 —— 与 applyToggle 早先的坑完全一样。
// 返回值里的 `action` 是**整批**的口径（'batch' / 'noop' / 失败），每条的计划在 `plans`：
//   'update'（原地改值）| 'insert'（在条目头插一行）| 'remove'（改值 + 删掉多余的纯段）| 'append'（新条目）| 'noop'
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
  const eol = parsed.eol
  const plans = []
  const pending = []
  // hit.disabledLineIndex / hit.lineIndex 都是**原始文本**上的行号，
  // 一旦前面插过行，用它们直接索引 lines 就会指到别人身上。
  // 所以这里分两趟：第一趟只做判断、产出「要改 / 要删哪些原始行」，第二趟统一落笔。

  for (let i = 0; i < targets.length; i++) {
    const hits = itemsOf(parsed, targets[i])
    if (!hits.length) {
      // 全新条目：先攒着，等已有条目都改完再统一追加到末尾，避免追加过程中行号错位
      pending.push(targets[i])
      plans.push({ id: targets[i], action: 'append', line: 0, was: false })
      continue
    }
    plans.push(batchPlanOf(targets[i], hits))
  }

  // 第二趟：按**原始行号**建索引，最后一次重建数组。
  // ⚠️ 不能边插边删：插行会把后面的行号整体下移，再用原始行号删行就会删到隔壁条目上
  // （实测会把用户 config 子行删掉）。update 不移动行，insert / remove 都会，
  // 所以三者都只记在原始坐标上，由重建那一步统一生效。
  const replaceAt = {}
  const insertAt = {}
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i]
    if (p.at == null) continue
    if (p.indent == null) {
      // update：原位改值。沿用该行原有缩进（用户可能写成 4 空格而条目是 2 空格）
      replaceAt[p.at] = DISABLED_RE.exec(lines[p.at])[1] + 'disabled: true'
    } else {
      // insert：在 `- id:` 下一行插一行
      insertAt[p.at] = p.indent + '  disabled: true'
    }
    delete p.at
    delete p.indent
  }
  const dropAt = {}
  for (let i = 0; i < plans.length; i++) {
    if (plans[i].action !== 'remove') continue
    for (let j = 0; j < plans[i].rows.length; j++) dropAt[plans[i].rows[j]] = true
  }
  const next = []
  for (let i = 0; i < lines.length; i++) {
    if (insertAt[i] != null) next.push(insertAt[i])
    if (dropAt[i]) continue
    next.push(replaceAt[i] != null ? replaceAt[i] : lines[i])
  }
  if (insertAt[lines.length] != null) next.push(insertAt[lines.length])

  let out = next.join(eol)
  for (let i = 0; i < pending.length; i++) out = appendItem(out, pending[i], true)
  // 兜底：上面把带 config 的段也改成了 true，正常情况下生效值必为 true；
  // 万一段里是 `!!js` 之类静态判不出的写法，就追加一段保证生效（同 applyToggle）
  const repaired = []
  for (let i = 0; i < targets.length; i++) {
    if (effectiveDisabled(parsePatch(out), targets[i]) !== true) {
      out = appendItem(out, targets[i], true)
      repaired.push(targets[i])
    }
  }
  // 兜底动过的条目，在 plans 里补一条 append —— 否则界面会照着 plans 说「一条都没新增」，
  // 而文件末尾其实多了一段
  for (let i = 0; i < repaired.length; i++) {
    for (let j = 0; j < plans.length; j++) {
      if (plans[j].id === repaired[i]) plans[j].repaired = true
    }
  }

  const changed = out !== src
  return { ok: true, text: out, changed: changed, action: changed ? 'batch' : 'noop', plans: plans }
}

// 单个 id 在一键隔离里的落笔计划（不改任何东西，只算）。
// 多段时的口径与 applyToggle 一致：
//   · 生效值已是 true → noop（如实报，免得界面说「已隔离 N 条」而其中几条根本没动）
//   · 否则第一段 update / insert，后面纯 disabled 段 remove，带 config 的段 update
function batchPlanOf(id, hits) {
  if (effectiveDisabled({ items: hits }, id) === true) {
    return { id: id, action: 'noop', line: hits[0].lineIndex + 1, was: true, blocks: hits.length }
  }
  const keep = pickKeeper(hits)
  const plan = keep.disabledLineIndex >= 0
    ? { id: id, action: 'update', line: keep.disabledLineIndex + 1, was: false, at: keep.disabledLineIndex }
    : { id: id, action: 'insert', line: keep.lineIndex + 1, was: false, at: keep.lineIndex + 1, indent: keep.indent }
  const rows = []
  const extraAt = []
  for (let i = 0; i < hits.length; i++) {
    const it = hits[i]
    if (it === keep) continue
    if (droppable(it)) {
      // 与 applyToggle 同一口径：整段删（头行 → 段尾），空行 / 注释一起走
      for (let j = it.lineIndex; j <= it.endLineIndex; j++) rows.push(j)
      continue
    }
    if (it.disabledLineIndex >= 0) extraAt.push(it.disabledLineIndex)
  }
  if (rows.length) {
    // 有多余纯段要删：action 报 remove，但**保留段的落笔仍在 at 上**，
    // 所以不能把 at 丢掉 —— 落笔那趟还要按它去改 / 插行
    plan.action = 'remove'
    plan.rows = rows
  }
  if (extraAt.length) {
    // 带 config 的段不能整段删，只能把它的 disabled 行改成 true。
    // 这里只回报「还会改动其余 N 段」，不在 plans 里逐段列行号：
    // 界面要的是一行一条的清单，逐段展开反而让用户看不懂
    plan.extra = extraAt.length
  }
  plan.blocks = hits.length
  return plan
}
// 说明：applyBatchDisable 第二趟按 `at`（改值 / 插行）与 `rows`（删行）的**原始文本**行号
// 建索引，最后一次重建数组 —— 三类落笔不再互相错位。早先「从大到小 splice + 统一删行」
// 只对 update 成立（update 不移动行），一旦出现 insert，后面的 `rows` 就会整体偏一行。

// ── 删条目（卸载插件后的清理，P0-3 用）──
// 把该 id 的**所有**段整块删掉（含 config 子块）—— 与「启用」不同：那时只是不想禁用，
// 还得保住用户的 config；这里是插件已经卸掉了，留着条目只会让 dsh 每次启动打一行
// `patch: entry "X" not found`（V2：退出码 0、不报错，用户完全看不见）。
//
// 块的范围 = `- id:` 行起，到该段**最后一行内容**（`endLineIndex`，跳过空行 / 注释）为止。
// 块之间的空行、以及块自身的注释一并删掉（见下方注释）。
function removeItemBlocks(text, ids) {
  const src = String(text == null ? '' : text)
  const list = Array.isArray(ids) ? ids : []
  const parsed = parsePatch(src)
  const drop = {}
  for (let i = 0; i < list.length; i++) {
    const id = String(list[i] == null ? '' : list[i]).trim()
    if (id) drop[id] = true
  }
  const lines = parsed.lines.slice()
  const rows = []
  // 「这块到哪里结束」由 parsePatch 的 endLineIndex 定（已跳过空行 / 注释，含 disabled 行与
  // config 子块），但**不越过下一段的头行**：endLineIndex 只看「哪些行算本段内容」，
  // 若本段与下一段之间夹着注释，它会停在最后一个内容行 —— 这没问题；可一旦本段是最后一段，
  // 它也可能把后面所有内容都吞进来（缩进误判）。所以两者取小，多一层兜底。
  //
  // 早先按缩进扫（「遇到缩进不大于自己的非空非注释行就停」）有两个坑：
  //   ① 块内出现比条目头更浅的注释时提前截断，把 `disabled:` 留成孤儿行；
  //   ② 与 parsePatch 的归属口径（`disabled:` 归上方最近的 `- id:`）是两套规则，必然漂移。
  // 同 id 多段全部删（patch 语义是同 id 后覆盖前，删一半等于「删了个不生效的」，白删）
  for (let i = 0; i < parsed.items.length; i++) {
    const it = parsed.items[i]
    if (!drop[it.id]) continue
    const next = parsed.items[i + 1]
    const end = next ? Math.min(it.endLineIndex, next.lineIndex - 1) : it.endLineIndex
    for (let j = it.lineIndex; j <= end; j++) rows.push(j)
  }
  if (!rows.length) return { ok: true, text: src, changed: false, removed: 0 }
  // 块与块之间的空行是「分隔用的」，块没了它们会变成一串孤零零的连续空行。
  // 前面没有别的条目（k < 0）时它属于文件头，同样跟着走 —— 留着就是开头空一大片。
  //
  // ⚠️ 两条相邻条目都删、且中间夹着空行时，同一行会被两条各推一次（m > k 的区间会重叠：
  //    条目 a 的尾随空行 = 条目 b 的前导空行）。rows 里出现重复行号会让 splice 多删一行，
  //    所以这里用集合去重 —— 只去重、不排序，dropLines 自己会从大到小删。
  const seen = {}
  for (let j = 0; j < rows.length; j++) seen[rows[j]] = true
  for (let j = 0; j < parsed.items.length; j++) {
    const it = parsed.items[j]
    if (!drop[it.id]) continue
    let k = it.lineIndex - 1
    while (k >= 0 && !lines[k].trim()) k--
    for (let m = it.lineIndex - 1; m > k; m--) seen[m] = true
  }
  const rowsU = Object.keys(seen).map(Number)
  dropLines(lines, rowsU)
  // 删块时「前导空行」是按「上方那串空行」整段收的，最上面那条被删条目的前导空行
  // 可能属于**文件头**（原文 `\n- id: a` 这种），删完就留下一个开头的空行。
  // 收口：只把**开头**的空行清掉，不动文件中间的空行分隔。
  while (lines.length && !lines[0].trim()) lines.shift()
  // 删空后回到 `[]`（patch 的空表写法），而不是留一份没有条目的残骸。
  // 不写 `[]\n`：原文件末尾没换行时多补一个换行是无谓的 diff（原来只删行时行尾与原文一致）
  const rest = lines.join(parsed.eol)
  const out = /^\s*$/.test(rest) ? '[]' + (/[\r\n]$/.test(src) ? parsed.eol : '') : rest
  const removed = parsed.items.filter((it) => drop[it.id]).length
  return { ok: true, text: out, changed: out !== src, removed: removed }
}

module.exports = {
  parsePatch,
  applyToggle,
  applyBatchDisable,
  appendItem,
  validId,
  disabledValue,
  // P0-3 卸载清理用：把某插件在 patch 里的**所有**条目删掉（含带 config 的段，
  // 否则删了依赖包、config 段还挂在那里，dsh 每次启动都会报一条找不到的 entry）
  removeItem: removeItemBlocks,
  _unquote: unquote,
}
