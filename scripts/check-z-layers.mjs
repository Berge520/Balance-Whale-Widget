/*
 * z-index 分层体检：悬浮窗的层叠顺序只能来自 floating.css 的「窗口层段表」，
 * 不允许在别处冒出一个裸数字 —— 否则改版时谁大谁小全靠人肉翻文件，撞车是迟早的。
 *
 * 为什么只查窗口层、不查元素内层：见 floating.css `:root` 层段表的注释。
 *   - 窗口层（root/menu/actions）：同处页面根堆叠上下文，必须严格有序 → 必须走变量
 *   - 元素内层（菜单按钮 / 吸顶标题 / 气泡）：各自父级内部的局部堆叠，与窗口层无关
 *     → 保持就地字面量，但需要在 ALLOW 里**登记理由**，避免"顺手加一个"没人知道
 *
 * 判定口径（别高估这层网）：
 *   - 只扫 public/*.css；src/（Vue 设置页）用的是自己的堆叠体系，不在本表管辖内
 *   - 只认 `z-index:` 声明；`--z-whale-*` 变量的**定义处**在 :root 里，会被单独收集
 *   - 变量定义的值若重复（两个层段同值）→ 报错：层段表内部必须严格唯一
 *
 * 用法：node scripts/check-z-layers.mjs          # 列出违规，始终 exit 0（体检模式）
 *       node scripts/check-z-layers.mjs --fail   # 有违规则 exit 1（挂 prebuild）
 * 自检：test/check-z-layers.test.mjs 用临时样本逐项验证，经 CZL_ROOT / CZL_FILES / CZL_ALLOW 注入。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(
  process.env.CZL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
)

// 层段表所在的权威文件（变量的定义处只认它）
const TABLE_FILE = 'public/floating.css'

// 待扫描的 CSS：public 下全部（.css）。CZL_FILES 供自检注入（逗号分隔相对路径）。
const FILES = process.env.CZL_FILES
  ? process.env.CZL_FILES.split(',').map((s) => s.trim()).filter(Boolean)
  : readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.css')).map((f) => `public/${f}`)

// 层段变量名：必须以 --z-whale- 开头（约定）。
const LAYER_VAR_RE = /^--z-whale-/

// CZL_ALLOW：自检注入（JSON 数组）；真实仓库为下面这份登记表。
// 每条 = "文件:选择器旁的值" 形态太脆，改为「文件 + 值」二元组 + 理由，值相同即豁免。
// 目标是清空 —— 新增裸 z-index 前先想清楚它是不是真属于元素内层。
const ALLOW = process.env.CZL_ALLOW
  ? JSON.parse(process.env.CZL_ALLOW)
  : [
      { file: 'public/floating.css', value: '2', why: '.dshwv-menu-btn 菜单按钮：.dshwv-root 内部局部层叠' },
      { file: 'public/floating.css', value: '1', why: '.dshwv-group-open > .dshwv-group-head 吸顶标题：菜单面板内部局部层叠' },
      { file: 'public/floating-bubble.css', value: '1', why: '.dshwv-bubble 气泡：.dshwv-root 内部局部层叠' },
    ]

const failOnViolation = process.argv.includes('--fail')

// —— 解析一个 CSS 文件的 z-index 声明与 --z-whale-* 变量定义 ——
// 逐字符走状态机：压掉注释 → 遇 { 记选择器 → 遇 ; / } 结算一条声明 → 遇 \n 也结算（容忍缺分号）。
// 行号由字符索引换算，跨行声明的起始行取声明首个字符所在行。
function scanCssLines(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const out = { decls: [], defs: new Map() }
  const lineAt = (idx) => clean.slice(0, idx).split('\n').length
  let buf = ''
  let start = 0
  let selector = ''
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '{') { selector = buf.trim().replace(/\s+/g, ' '); buf = ''; continue }
    if (ch === '}') { selector = ''; buf = ''; continue }
    if (ch === ';' || ch === '\n') {
      const decl = buf.trim()
      buf = ''
      if (!decl) continue
      collect(decl, selector, lineAt(start), out)
      continue
    }
    if (!buf) start = i
    buf += ch
  }
  if (buf.trim()) collect(buf.trim(), selector, lineAt(start), out)
  return out
}

function collect(decl, selector, line, out) {
  const vm = decl.match(/^(--z-whale-[\w-]+)\s*:([\s\S]+)$/)
  if (vm) {
    const value = vm[2].trim()
    if (out.defs.has(vm[1])) out.defs.get(vm[1]).dup = true
    else out.defs.set(vm[1], { value, line })
    return
  }
  const zm = decl.match(/^z-index\s*:([\s\S]+)$/)
  if (zm) out.decls.push({ selector: selector || '(root)', value: zm[1].trim(), line })
}

// —— 主流程 ——
const parsed = FILES.map((f) => {
  let src = ''
  try { src = readFileSync(path.join(root, f), 'utf8') } catch { src = '' }
  return { f, ...scanCssLines(src) }
})

const table = parsed.find((p) => p.f === TABLE_FILE)
const violations = []

// 1) 层段表必须存在且至少三个层段
if (!table) {
  violations.push(`缺少层段表文件 ${TABLE_FILE}`)
} else {
  const names = [...table.defs.keys()]
  if (names.length < 3) violations.push(`${TABLE_FILE} 的层段表少于 3 段（当前 ${names.length} 段）`)
  // 2) 层段表内部值必须严格唯一（同值 = 两层平级，谁盖谁取决于文档顺序，脆）
  const seen = new Map()
  for (const [name, d] of table.defs) {
    const v = d.value
    if (!/^\d+$/.test(v)) { violations.push(`${TABLE_FILE}:${d.line} 层段 ${name} 的值不是整数：${v}`); continue }
    if (seen.has(v)) violations.push(`${TABLE_FILE}:${d.line} 层段 ${name}=${v} 与 ${seen.get(v)} 同值（层段必须严格唯一）`)
    else seen.set(v, name)
    if (d.dup) violations.push(`${TABLE_FILE} 层段 ${name} 定义重复`)
  }
}

const layerVars = table ? new Set(table.defs.keys()) : new Set()

// 3) 每个 z-index 使用处：只能是层段表变量，或已登记的裸数字
for (const { f, decls } of parsed) {
  for (const d of decls) {
    const v = d.value
    if (v.startsWith('var(')) {
      const m = v.match(/^var\(\s*(--[\w-]+)/)
      const name = m ? m[1] : ''
      if (!LAYER_VAR_RE.test(name)) {
        violations.push(`${f}:${d.line} ${d.selector} 的 z-index 用了非层段变量 ${v}`)
      } else if (!layerVars.has(name)) {
        violations.push(`${f}:${d.line} ${d.selector} 引用了未定义的层段变量 ${name}`)
      }
      continue
    }
    // 裸数字（含负值 / 0 / auto 之外的写法）
    if (ALLOW.some((a) => a.file === f && a.value === v)) continue
    violations.push(
      `${f}:${d.line} ${d.selector} 使用了裸 z-index: ${v}（应改用层段变量；确属元素内层请在 ALLOW 登记理由）`,
    )
  }
}

if (violations.length) {
  console.log(`\n[z-layers] 发现 ${violations.length} 处违规：`)
  for (const v of violations) console.log(`    ${v}`)
  console.log('\n[z-layers] 窗口层请用 floating.css 的 --z-whale-* 变量；元素内层请进 ALLOW 并写明理由。')
  if (failOnViolation) process.exit(1)
} else {
  console.log(`[z-layers] 层段表 ${layerVars.size} 段，全部 z-index 合规`)
}
