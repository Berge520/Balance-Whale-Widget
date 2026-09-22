/*
 * dsh 配置转储（dump-config）读取与解析（CommonJS）。
 *
 * 设计依据：docs/plan-dsh-diagnostics.md 阶段二（§4）。核心约束：
 *   1. **一次性 CLI 读取** —— `node <bin.js> --profile <n> --dump-config` 是短命进程，
 *      **8s 超时**（§4.3），超时按失败处理并留痕，绝不阻塞设置页。
 *   2. **只读缓存** —— 同 §3.5 的 fingerprint + memo 模式，纯派生数据、不进备份。
 *   3. **只解析到条目级** —— dump 实测本机 767 行，整篇回传前端会撑爆消息通道，
 *      这里只抽出「层 → 条目（id/name/disabled/config 行数）」的骨架（§4.3）。
 *   4. **`!!js` 原样保留不求值** —— `disabled: !!js '!ctx.get(...)'` 是运行期表达式，
 *      求值需要 cordis 上下文，静态解析做不到也不该做（§4.3）。
 *   5. **显式 `--profile <n>`** —— 不依赖 bin.js 的位置参数补全（§4.3 参数顺序踩坑）。
 *
 * 依赖 dsh.js 已导出的 decodeOut / spawnCmd / activeDsh（通用底层能力），
 * 不复制实现，避免两处漂移。本模块不 require utools。
 */
const { logErr } = require('./log')
const { K } = require('./constants')
const { decodeOut, spawnCmd, activeDsh, resolveNode } = require('./dsh')

// 短命进程，8s 足够；再长说明环境有问题，继续等只会让用户盯着转圈（§4.3）
const DUMP_TIMEOUT_MS = 8 * 1000
// 缓存 TTL（同 §3.5）：两次 spawn 最坏 16s，不加 TTL 每次展开配置卡都要等一遍
const DUMP_TTL_MS = 60 * 1000
// dump 输出上限：本机实测 767 行 / 约 30KB。给到 4MB 是防病态情况（用户装了上百个插件）
// 把内存吃光；超限按失败处理，不截断解析（截断会给出「看起来完整其实缺半截」的错误结论）
const DUMP_MAX_BYTES = 4 * 1024 * 1024
// 单条目 config 只保留行数，不保留内容（§4.3 只解析到条目级）。
// 但「改了哪些 config 字段」对 diff 有用，故保留**顶层字段名**（不保留值，值可能含密钥）
const CONFIG_KEY_MAX = 12

// 分节标题：# == <包名>[, patched by <来源>]
// 来源有两种（实测）：① 包内层 —— 另一个包名（如 @deepseek-ai/dsh-web-app、dsh-mnemon）；
// ② 用户层 —— cordis.patch.yml 的**绝对路径**（profile 用户层 / home 用户层）
const SECTION_RE = /^#\s*==\s*(.+?)\s*$/
const PATCHED_BY_RE = /^(.+?),\s*patched by\s+(.+)$/

// ──────────────────────────────────────────────
// 纯函数（供 test/dsh-dump.test.mjs 直接喂样例）
// ──────────────────────────────────────────────

// 去掉 ANSI 转义与 BOM。dsh 打印 dump 时会带颜色（FORCE_COLOR=0 也不是所有版本都认），
// 带转义的 `# ==` 会匹配不上标题正则，表现为「一个分节都解析不出来」。
// 这里就是要按字符码剥离控制字符，正是 no-control-regex 的合法例外，故局部关掉
/* eslint-disable no-control-regex */
function stripAnsi(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
}
/* eslint-enable no-control-regex */

// 解析一行分节标题 → { bundle, patchedBy, isUserLayer, label } 或 null
//
// 层的归属判据（对应 plan §4.2 D1 的五层）：
//   · patchedBy 为空            → bundle 自身（第一层）
//   · patchedBy 以路径分隔符开头 → 用户层（profile / home 的 cordis.patch.yml）
//   · 其余                      → 包内另一份 patch（中间层）
// 用「是否像绝对路径」而不是「是否以某个已知目录开头」：profile 目录可由 $DSH_HOME 改，
// 写死路径前缀在用户改过 $DSH_HOME 后会静默判错
function parseSectionHead(line) {
  const m = SECTION_RE.exec(String(line == null ? '' : line))
  if (!m) return null
  const body = m[1]
  let bundle = body
  let patchedBy = ''
  const p = PATCHED_BY_RE.exec(body)
  if (p) { bundle = p[1].trim(); patchedBy = p[2].trim() }
  // Windows 盘符（D:\…）与 POSIX 绝对路径（/home/…）都算用户层
  const isUserLayer = !!patchedBy && (/^[a-zA-Z]:[\\/]/.test(patchedBy) || /^[\\/]/.test(patchedBy))
  return {
    bundle: bundle,
    patchedBy: patchedBy,
    isUserLayer: isUserLayer,
    label: patchedBy ? bundle + ' ← ' + patchedBy : bundle,
  }
}

// 用户层文件名 → 简短来源名（C:\Users\x\.dsh\profiles\web\cordis.patch.yml → profiles/web）
// 只为界面可读，不做路径归一化（D25 的教训：跨平台路径字符串比对不可靠）
function shortSource(p) {
  const s = String(p == null ? '' : p)
  if (!s) return ''
  const parts = s.split(/[\\/]/).filter(Boolean)
  if (parts.length >= 2 && /\.(yml|yaml)$/i.test(parts[parts.length - 1])) {
    // cordis.patch.yml 本身没信息量，取它所在目录名与再上一层（profiles/web）
    const file = parts[parts.length - 1]
    const dir1 = parts[parts.length - 2] || ''
    const dir2 = parts[parts.length - 3] || ''
    if (dir2 === 'profiles') return dir2 + '/' + dir1
    return dir1 || file
  }
  return parts[parts.length - 1] || s
}

// 解析 dump 全文 → { sections: [...], entries: {...} }
//
// 每个 section：{ head, bundle, patchedBy, isUserLayer, source, ids: [...] }
// 每个 entry：{ id, name, disabled, hasConfig, configKeys, depth }
//   depth 是解析期的内部字段（`- id:` 的缩进），只用于判定字段归属与 configKeys 门槛，
//   **不随 entriesOf 回传前端**（DshDumpEntry 里没有它，前端不需要、也看不懂这个数）
// 条目级解析的好处：一个 30KB 的 dump 出来后只有几百字节，前端够用（§4.3）
function parseDump(text) {
  const lines = stripAnsi(text).split('\n')
  const sections = []
  const entries = {}
  let cur = null
  // 条目栈：按 `- id:` 的缩进深度排。栈顶是当前缩进最深的条目，
  // 于是「这一行 name/disabled/config 属于谁」由**缩进**决定，而不是「最近出现过谁」——
  // 后者会把 `providers:` 列表里兄弟元素的字段错记到上一个子条目头上。
  let stack = []
  // 条目语法：`- id: X` / `<更深缩进> name: Y` / `disabled: ...` / `config:`
  for (const line of lines) {
    const head = parseSectionHead(line)
    if (head) {
      cur = {
        bundle: head.bundle,
        patchedBy: head.patchedBy,
        isUserLayer: head.isUserLayer,
        source: head.isUserLayer ? shortSource(head.patchedBy) : head.patchedBy,
        ids: [],
      }
      sections.push(cur)
      stack = []
      continue
    }
    if (!cur) continue
    // 条目开头的 `- id: X`，**任意缩进深度都收**。
    // 早先只认行首 `^- id:`，于是 `mnemon-bundle` 的 `config:` 列表里嵌套的 8 个子条目
    // （缩进 4 空格，本机实测：mnemon / mnemon-source-* / mnemon-strategy-*）一个都没进 entries ——
    // 转储卡把它们整组漏掉（用户层显示 3 条而非 11 条），拿 entries 当「已知 id 清单」的旧 C2
    // 还因此把这 8 个**合法**条目全判成对不上（8 假阳性 + 1 真阳性，纯属巧合才没漏掉真的那个）。
    // 嵌套条目同样是 cordis 组装树里的真实节点，必须与顶层条目一视同仁地收进来。
    const idm = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(line)
    if (idm) {
      const id = idm[2]
      const depth = idm[1].length
      // 弹出比本行缩进更浅/等深的条目，剩下的栈顶就是父条目
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
      const en = { id: id, name: '', disabled: false, hasConfig: false, configKeys: [], depth: depth }
      stack.push(en)
      cur.ids.push(id)
      // 同 id 出现在多个分节是正常的（分层），用「分节序号:id」做键避免互相覆盖
      entries[sections.length - 1 + ':' + id] = en
      continue
    }
    const en0 = stack.length ? stack[stack.length - 1] : null
    if (!en0) continue
    // ⚠️ 归属必须**按本行缩进**再收一次栈，不能只靠「下一个 `- id:` 到来时 pop」：
    // 条目自身的字段比 `- id:` 深 2 格（`- id: child`(4) → `disabled:`(6)），而父条目的
    // 字段又比子条目浅（`- id: parent`(0) → `disabled:`(2)）。于是父条目的收尾字段会以
    // 「比子条目浅」的缩进出现在子条目之后 —— 只看栈顶就会把它错记到子条目头上。
    // 实测踩坑：`  disabled: false`(2) 覆盖掉子条目的 `disabled: true`(6)，且子条目
    // 后续的 `config:` 字段也再没机会被收（栈顶永远停在子条目上）。
    // 规则：本行缩进 < 条目字段缩进（depth+2）时，说明已退出该条目的字段区，逐层弹栈。
    // 用「严格小于」而不是「小于等于」：条目自己的字段就在 depth+2，等于时必须保留栈顶
    const lineInd = /^(\s*)/.exec(line)[1].length
    while (stack.length && lineInd < stack[stack.length - 1].depth + 2) stack.pop()
    const en = stack.length ? stack[stack.length - 1] : null
    if (!en) continue
    const nm = /^\s+name:\s*(.+?)\s*$/.exec(line)
    if (nm) {
      const v = nm[1].replace(/^['"]|['"]$/g, '')
      en.name = v
      // 已出现的 id/name 登记到全局表，供 diff 用「id → name」兜底显示
      if (!entries['@name:' + en.id]) entries['@name:' + en.id] = { id: en.id, name: v }
      continue
    }
    // disabled 有四种写法（实测）：`disabled: true` / `!!js '...'` / `!!js >-` 多行 / 省略
    if (/^\s+disabled:/.test(line)) {
      en.disabled = !/^\s+disabled:\s*false\s*$/.test(line)
      continue
    }
    if (/^\s+config:\s*$/.test(line)) {
      en.hasConfig = true
      continue
    }
    // config 下的顶层字段：形如 `key: value`，只留 key 名不留值。
    // ⚠️ 缩进门槛随条目深浅浮动，且**不能**写成「条目缩进 + 2」：条目自身是 `- id:`（比同级
    // 兄弟字段少 2 格），它的 `config:` 在 +2、config 的字段在 +4。本机实测：
    //   `- id: web-ui-settings`(0) → `config:`(2) → `plugin:`(4)
    //   `- id: mnemon`(4)         → `config:`(6) → `routingGuidance:`(8)
    // 更深的是嵌套对象里的字段（如 `embedding.enabled`），不进 configKeys ——
    // 否则 diff 会把内部对象的字段当成顶层配置项比对
    if (en.hasConfig) {
      const ind = /^(\s*)/.exec(line)[1].length
      const km = ind === en.depth + 4 ? /^([A-Za-z_][\w.-]*):(?:\s|$)/.exec(line.trim()) : null
      if (km && en.configKeys.length < CONFIG_KEY_MAX && en.configKeys.indexOf(km[1]) < 0) {
        en.configKeys.push(km[1])
      }
    }
  }
  return { sections: sections, entries: entries }
}

// 把分节汇总成「层」视图（D1 的五层可视化）。
// 归层规则：bundle 自身是「基线」，每个 patchedBy 是一个覆盖层，按出现顺序编号。
// 这不是还原 cordis 的真实加载顺序（那要读 cordis 源码），而是**如实呈现 dump 说了什么**
function buildLayers(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : { sections: [], entries: {} }
  const bySource = {}
  const layers = []
  let seq = 0
  for (let i = 0; i < p.sections.length; i++) {
    const s = p.sections[i]
    // 用户层按「绝对路径」聚合（同一个 cordis.patch.yml 会 patch 多个包）；
    // 包内层按「包名」聚合，否则一个包 patch 十个包就会出十层
    const key = s.isUserLayer ? 'file:' + s.patchedBy : 'pkg:' + s.patchedBy
    if (!s.patchedBy) {
      // 基线分节（没被 patch 的包）：只统计数量，不单独成层
      if (!bySource['@base']) {
        bySource['@base'] = { kind: 'base', name: 'bundle 内置', source: '', items: [], seen: {}, rawCount: 0, sectionCount: 0 }
      }
      // 去重：同一个 bundle 会在 dump 里反复以「基线分节」出现（实测 `# == @deepseek-ai/dsh-base`
      // 出现 13 次，每次都把同一批 40 个条目重列一遍）。不去重会让「条目」总数虚高成几百条，
      // 而卡片上方概览写的是**去重后**的生效条目数 —— 两个数对不上会让人以为解析漏了东西
      pushIds(bySource['@base'], s.ids)
      bySource['@base'].rawCount += s.ids.length
      bySource['@base'].sectionCount++
      continue
    }
    if (!bySource[key]) {
      bySource[key] = {
        kind: s.isUserLayer ? 'user' : 'bundle',
        name: s.isUserLayer ? s.source : s.patchedBy,
        source: s.patchedBy,
        items: [],
        seen: {},
        rawCount: 0,
        sectionCount: 0,
      }
    }
    pushIds(bySource[key], s.ids)
    bySource[key].rawCount += s.ids.length
    bySource[key].sectionCount++
  }
  for (const k of Object.keys(bySource)) {
    const v = bySource[k]
    seq++
    v.order = seq
    // items 是去重后的 id 数组；id 可以直接展示（比条目全名短得多），
    // 前端因此能拿它渲染「哪些条目被这一层动过」，而不只是一个数字
    v.itemTotal = v.items.length
    v.itemCount = v.items.length
    // 同一批条目被分节重复列出时总量会虚高，故另记 rawCount 供界面区分
    v.repeat = v.rawCount > v.items.length
    delete v.seen
    // 层卡上的条目名单独截断：一下列几十个会把卡撑得很长
    v.preview = v.items.slice(0, 40)
    layers.push(v)
  }
  return layers
}

// 收集 id 并去重（同一个分节里理论上不该重，但 dump 会重复分节）
function pushIds(layer, ids) {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    if (layer.seen[id]) continue
    layer.seen[id] = true
    layer.items.push(id)
  }
}

// 生效树 vs 默认树 diff（D2）
//
// 判据：按 `包名/id` 取「最终生效的条目定义」，两棵树各算一份哈希。
// 只要 dump 里该条目的可见属性（name/disabled/configKeys）任一不同就算「被改过」。
// ⚠️ 只看 dump 能看到的属性：config 的**值**不在 dump 里（我们只留 key 名），
// 所以「改了 config 的值但 key 没变」这种情况这里查不出来 —— 这是刻意的取舍，
// dump 里 config 值可能含密钥，不回传前端（§4.3）
function diffTrees(effective, defaults) {
  const e = indexEntries(effective)
  const d = indexEntries(defaults)
  const changed = []
  const added = []
  const removed = []
  for (const id of Object.keys(e)) {
    if (!d[id]) { added.push(pick(e[id])); continue }
    if (hashEntry(e[id]) !== hashEntry(d[id])) changed.push({ id: id, name: e[id].name, before: d[id], after: e[id] })
  }
  for (const id of Object.keys(d)) {
    if (!e[id]) removed.push(pick(d[id]))
  }
  return { changed: changed, added: added, removed: removed }
}

function pick(en) {
  return { id: en.id, name: en.name }
}

// 「最终生效的定义」：同 id 被多层 patch 时，**后出现的分节覆盖先出现的**
// （patch 按 id 整体替换，不是深度合并 —— plan §4.2 D1）
//
// ⚠️ 同时记下该条目**最终归属哪个 bundle**（分节头的第一个字段）。
// 这一条不能从 entry 自己身上拿：entry 是解析期按「分节序号:id」建的，
// 换了分节就是另一个对象，而「覆盖」恰恰意味着前面分节的 bundle 名会丢。
// 用途是 dsh-isolate 的分档（官方框架 vs 第三方插件）——见那里的注释。
function indexEntries(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : { sections: [], entries: {} }
  const out = {}
  for (let i = 0; i < p.sections.length; i++) {
    const ids = p.sections[i].ids
    for (const id of ids) {
      const en = p.entries[i + ':' + id]
      if (en) {
        // 浅拷贝后再挂 bundle，避免污染 parseDump 的原对象（diff 那边还在用它）
        out[id] = { id: en.id, name: en.name, disabled: en.disabled, hasConfig: en.hasConfig, configKeys: en.configKeys, bundle: p.sections[i].bundle }
      }
    }
  }
  return out
}

function hashEntry(en) {
  return [String(en.name || ''), en.disabled ? '1' : '0', (en.configKeys || []).join(',')].join('\u0000')
}

// dump 输出 → 精简条目数组（前端只拿这个，不拿全文）
// `bundle` 一并回传：它是「这个条目属于哪个包」的唯一权威来源，
// 界面拿它做分档（dsh-isolate），前端自己从 id 猜不出来。
function entriesOf(parsed) {
  const idx = indexEntries(parsed)
  const out = []
  for (const id of Object.keys(idx)) {
    const en = idx[id]
    out.push({ id: id, name: en.name, disabled: en.disabled, hasConfig: en.hasConfig, configKeys: en.configKeys, bundle: en.bundle || '' })
  }
  return out
}

// ──────────────────────────────────────────────
// dsh 自己的 patch 警告
// ──────────────────────────────────────────────
// dsh 在 dump 正文**之前**会往输出里打这类行（实测在 stderr）：
//   dsh: [C:\Users\Berge\.dsh\profiles\web\cordis.patch.yml] patch: entry "config-manager" not found
// 这是**唯一权威的「patch 条目对不上」判据** —— 是 dsh 解析 patch 时的真实结论。
//
// ⚠️ 为什么不自己比对「patch 的 id 是否出现在 dump 条目里」：dump 的条目清单**不完整**。
// 实测 `mnemon-bundle` 的 `config:` 列表里嵌套了 8 个子条目（`mnemon`、`mnemon-source-*`、
// `mnemon-strategy-*`），它们缩进 4 空格写在 config 内层，`parseDump` 只认行首 `^- id:`
// 故一个都没进 entries —— 拿 entries 当已知清单会把这 8 个**合法**条目全判成对不上。
// 同理 `config-manager` 不在 entries 里，但它确实是真的 not found：
// 只看 entries 得到「9 个对不上」，其中 8 个是假阳性、1 个是真的，纯属巧合对上。
// 与其维护一份永远补不全的清单，不如直接采信 dsh 说了什么。
const NOT_FOUND_RE = /patch:\s*entry\s+"([^"]+)"\s+not found/g

// 抽取 dsh 报告的所有 not-found 条目 → [{ id, line }]（line 是警告在输出里的行号，仅供排查）
function parseDshWarnings(text) {
  const out = []
  const seen = {}
  const lines = stripAnsi(text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    // 同一行可能有多条（dsh 有时会把一个文件的多个 not found 打在一起）
    NOT_FOUND_RE.lastIndex = 0
    let m = NOT_FOUND_RE.exec(lines[i])
    while (m) {
      const id = m[1]
      if (!seen[id]) {
        seen[id] = true
        out.push({ id: id, line: i + 1 })
      }
      m = NOT_FOUND_RE.exec(lines[i])
    }
  }
  return out
}

// ──────────────────────────────────────────────
// 子进程：跑一次 dump
// ──────────────────────────────────────────────
// run(args, cb)：cb(err, text)。永不抛错、永不 cb 两次。
// 超时用 kill 而不是撒手不管 —— 短命进程卡住通常是 rc 文件或网络 hang，
// 留着它会一直占着句柄
function run(args, cb, timeoutMs) {
  const act = activeDsh()
  const node = resolveNode('')
  if (!act) return cb(new Error('未找到可用的 dsh（全局或插件目录都没有安装）'), '')
  if (!node) return cb(new Error('未找到 Node.js 可执行文件'), '')
  const limit = Number.isFinite(timeoutMs) ? timeoutMs : DUMP_TIMEOUT_MS
  let child = null
  let done = false
  let out = ''
  let overflow = false
  const finish = (err, text) => {
    if (done) return
    done = true
    clearTimeout(timer)
    cb(err, text)
  }
  const timer = setTimeout(() => {
    try { if (child) child.kill() } catch (err) {}
    logErr('[whale][dsh-dump] dump 超时', args.join(' ') + '（' + limit + 'ms）')
    finish(new Error('dump 超时（' + Math.round(limit / 1000) + 's），dsh 可能卡住了'), '')
  }, limit)
  try {
    child = spawnCmd(node.node, [act.entry].concat(args), node)
  } catch (err) {
    logErr('[whale][dsh-dump] 启动失败', (err && err.message) || '')
    return finish(new Error('启动 dsh 失败：' + ((err && err.message) || err)), '')
  }
  const onData = (d) => {
    if (done) return
    if (overflow) return
    out += decodeOut(d)
    if (out.length > DUMP_MAX_BYTES) {
      overflow = true
      try { child.kill() } catch (err) {}
      logErr('[whale][dsh-dump] dump 输出超限', String(out.length) + ' 字符')
      finish(new Error('dump 输出异常大（超过 ' + Math.round(DUMP_MAX_BYTES / 1024 / 1024) + 'MB），已中止'), '')
    }
  }
  const onErr = (err) => {
    logErr('[whale][dsh-dump] 进程错误', (err && err.message) || '')
    finish(new Error('dump 进程错误：' + ((err && err.message) || err)), '')
  }
  try { child.stdout && child.stdout.on('data', onData) } catch (err) {}
  // stderr 也要收：dsh 的 `patch: entry X not found` 之类提示走 stderr，
  // 而且实测在 dump 正文之前就打印了 —— 只看 stdout 会丢掉这些线索
  try { child.stderr && child.stderr.on('data', onData) } catch (err) {}
  try { child.on('error', onErr) } catch (err) {}
  try {
    child.on('close', (code) => {
      if (done) return
      if (code !== 0 && !stripAnsi(out).trim()) {
        return finish(new Error('dsh 退出码 ' + code + '（无输出）'), '')
      }
      finish(null, out)
    })
  } catch (err) {
    logErr('[whale][dsh-dump] 订阅退出事件失败', (err && err.message) || '')
  }
}

// 读「生效树」（--dump-config）
function dumpEffective(profile, cb) { run(['--profile', String(profile || 'web'), '--dump-config'], cb) }

// 读「默认树」（--dump-default-config）
function dumpDefault(profile, cb) { run(['--profile', String(profile || 'web'), '--dump-default-config'], cb) }

// 从 run() 的错误里判断是不是「dsh 根本没装」。
// 这件事必须和「装了但 dump 失败」分开说：前者要引导用户去「dsh」卡片装一次，
// 后者才该说重试；而 UI 拿不到 stdout，判据只能落在 run 给的这条错误文案上
function isNotInstalled(err) {
  const m = String((err && err.message) || err || '')
  return m.indexOf('未找到可用的 dsh') >= 0 || m.indexOf('未找到 Node.js') >= 0
}

// ──────────────────────────────────────────────
// 编排：一次拿齐两棵树 → 解析 → 归层 → diff
// ──────────────────────────────────────────────
// 两棵树都要，所以是两次 spawn（每次 8s 上限，最坏 16s）。
// 设置页侧有 15s 兜底闸门，这里串行更简单：并行 spawn 会让 dsh 同时加载两遍
// profiles（实测会重复打印 patch 警告），也会让超时逻辑互相干扰
function collectDshDump(opts, cb) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const at = Date.now()
  dumpEffective(profile, (eErr, eText) => {
    if (eErr) {
      // 生效树是主数据源，它失败就没有可展示的东西
      logErr('[whale][dsh-dump] 读生效树失败', (eErr && eErr.message) || '')
      // 把「没装」单列成标志：设置页据此给「先装一次」的空态，而不是笼统的「读取失败」。
      // 文案本身就说明了原因，前端不必再解析错误串
      const miss = isNotInstalled(eErr)
      return cb(null, {
        ok: false,
        at: at,
        profile: profile,
        notInstalled: miss,
        error: miss
          ? '未检测到可用的 dsh。先在「dsh」卡片里启动一次（会自动下载安装），再回来点「重新读取」。'
          : ((eErr && eErr.message) || String(eErr)),
      })
    }
    const effective = parseDump(eText)
    // dsh 自己报告的 patch not-found（C2 的唯一权威判据）：在正文之前就打了，从同一份输出里抽
    const warnings = parseDshWarnings(eText)
    if (warnings.length) {
      logErr('[whale][dsh-dump] dsh 报告 patch 条目不存在', warnings.map((w) => w.id).join(', '))
    }
    const result = {
      ok: true,
      at: at,
      profile: profile,
      sections: effective.sections.length,
      layers: buildLayers(effective),
      entries: entriesOf(effective),
      warnings: warnings,
      unparsed: !effective.sections.length,
      diff: null,
      diffError: '',
    }
    // 默认树失败不影响主结果：分层可视化仍然有用，只是少了 diff（降级，同 D26 的思路）
    dumpDefault(profile, (dErr, dText) => {
      if (dErr) {
        result.diffError = (dErr && dErr.message) || String(dErr)
        logErr('[whale][dsh-dump] 读默认树失败（diff 降级）', result.diffError)
        return cb(null, result)
      }
      const defaults = parseDump(dText)
      const d = diffTrees(effective, defaults)
      result.diff = {
        changed: d.changed.slice(0, 200),
        added: d.added.slice(0, 200),
        removed: d.removed.slice(0, 200),
        changedTotal: d.changed.length,
        addedTotal: d.added.length,
        removedTotal: d.removed.length,
      }
      cb(null, result)
    })
  })
}

// 只给日志用的一行摘要（不进前端）
function summarizeDump(r) {
  if (!r) return '无结果'
  if (!r.ok) return '失败：' + (r.error || '未知')
  const d = r.diff
  const diffText = d ? '，diff 改 ' + d.changedTotal + ' 增 ' + d.addedTotal + ' 删 ' + d.removedTotal : '，diff 不可用'
  return 'profile ' + r.profile + '，' + r.sections + ' 个分节 / ' + r.entries.length + ' 个条目' + diffText
}

// ──────────────────────────────────────────────
// 缓存（同 §3.5 的 60s TTL + force）
// ──────────────────────────────────────────────
// 两次 spawn 最坏 16s，比阶段一的纯 fs 诊断贵得多，缓存收益更大。
// 与 diagnostics 各自独立缓存：用户可能只重跑其中一个
function readCache() {
  try {
    const v = utools.dbStorage.getItem(K.dshDump)
    if (v && v.at && Array.isArray(v.layers)) return v
  } catch (err) {
    // 读存储失败回默认值属预期分支
  }
  return null
}
function writeCache(v) {
  try { utools.dbStorage.setItem(K.dshDump, v) } catch (err) {
    logErr('[whale][dsh-dump] 写缓存失败', (err && err.message) || '')
  }
}
function clearDshDumpCache() {
  try { utools.dbStorage.removeItem(K.dshDump) } catch (err) {
    logErr('[whale][dsh-dump] 清缓存失败', (err && err.message) || '')
  }
}

module.exports = {
  DUMP_TIMEOUT_MS,
  DUMP_MAX_BYTES,
  DUMP_TTL_MS,
  // 纯函数（单测直接喂样例）
  stripAnsi,
  parseSectionHead,
  shortSource,
  parseDump,
  buildLayers,
  diffTrees,
  indexEntries,
  entriesOf,
  parseDshWarnings,
  summarizeDump,
  // 子进程 + 编排
  run,
  dumpEffective,
  dumpDefault,
  collectDshDump,
  isNotInstalled,
  // 缓存
  readCache,
  writeCache,
  clearDshDumpCache,
}
