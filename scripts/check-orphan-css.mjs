/*
 * 孤儿 CSS 体检：单个 .vue 的 <style scoped> 里，每条顶层选择器引用的 class，
 * 必须能在**同一个文件的模板区**找到对应 class；找不到即为"孤儿"嫌疑 ——
 * 规则写得像模像样，但 scoped 编译成 [data-v-<本文件哈希>] 后匹配不到任何元素，纯死代码。
 *
 * 为什么会有这种死代码：卡片从 App.vue 拆进 views/*.vue 时，模板元素跟着搬走了，
 * 样式却留在原处没动。子组件内部元素只带子组件自己的哈希，App.vue 里那批规则再也匹配不上。
 * 三关（lint / typecheck / test）全绿也照样发生 —— 死 CSS 不报错，只是白占体积、误导后人。
 *
 * 判定口径（别高估这层网）：
 *   - 只查"孤儿"，不查"覆盖"：同文件里样式重复定义、后写覆盖先写，本脚本不报。
 *   - 动态 class 会漏报：:class="'tag-' + x" / :class="[a, b]" 拼出来的 class 名不在
 *     字面量里，规则会被**误判为孤儿**。所以本脚本默认只打印（--warn），不拦截构建；
 *     确认某条是误报后，进 ALLOW 白名单写明理由豁免。
 *   - 全局样式类（在 main.css 里定义、或本来就该全局生效的）不在本文件模板中出现属正常，
 *     靠 ALLOW 豁免；本脚本只审 scoped 块，main.css 不扫（它本来就是全局的）。
 *
 * 用法：node scripts/check-orphan-css.mjs          # 列出全部孤儿，始终 exit 0（体检模式）
 *       node scripts/check-orphan-css.mjs --fail   # 有孤儿则 exit 1（已挂 prebuild，见 package.json）
 * 自检：test/check-orphan-css.test.mjs 用临时样本逐项验证，经 COC_ROOT / COC_ALLOW 注入。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(
  process.env.COC_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
)
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

// 收集待体检的 .vue 文件：src 下全部（App + views + components）。
// COC_FILES：自检注入（逗号分隔相对路径），替代真实仓库的目录扫描。
const FILES = process.env.COC_FILES
  ? process.env.COC_FILES.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'src/App.vue',
      ...readdirSync(path.join(root, 'src/views')).filter((f) => f.endsWith('.vue')).map((f) => `src/views/${f}`),
      ...readdirSync(path.join(root, 'src/components')).filter((f) => f.endsWith('.vue')).map((f) => `src/components/${f}`),
    ]

// 动态 class 的类名字面量可能写在任意 .ts 里（composables 的辅助函数等），
// 故把所有 src/**/*.ts 一并纳入"活类"来源。COC_TS_FILES 供自检注入。
const TS_FILES = process.env.COC_TS_FILES
  ? process.env.COC_TS_FILES.split(',').map((s) => s.trim()).filter(Boolean)
  : (function walk(dir) {
      const out = []
      for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) out.push(...walk(rel))
        else if (e.name.endsWith('.ts')) out.push(rel)
      }
      return out
    })('src')

// —— 切分 <template> / <style scoped> 两段 ——
// 不能用 /<template[^>]*>([\s\S]*?)<\/template>/ —— 模板里常有嵌套的 <template v-if>，
// 非贪婪会停在第一个内层 </template>，只切到根标签开头一小段（踩过：App.vue 只切到 1KB）。
// 因此改为标签计数：从根 <template> 开始，<template> 开标签 +1、</template> -1，归零即根节点结束。
function rootBlock(src, tag) {
  const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'g')
  const first = openRe.exec(src)
  if (!first) return null
  const attrs = first[1] || ''
  let depth = 1
  let i = first.index + first[0].length
  const openRest = new RegExp(`<${tag}(\\s[^>]*)?>`, 'g')
  const closeAll = new RegExp(`</${tag}\\s*>`, 'g')
  while (i < src.length) {
    openRest.lastIndex = i
    closeAll.lastIndex = i
    const no = openRest.exec(src)
    const nc = closeAll.exec(src)
    if (!nc) break
    if (no && no.index < nc.index) { depth++; i = no.index + no[0].length; continue }
    if (--depth === 0) {
      return { attrs, body: src.slice(first.index + first[0].length, nc.index) }
    }
    i = nc.index + nc[0].length
  }
  return { attrs, body: src.slice(first.index + first[0].length) }
}

function sections(src) {
  // 计数前必须先剥掉 <!-- --> 注释：模板里有用注释解释「否则会多出一个无主的 </template>」
  // 这种写法的注释文本，会被计数当成真的闭合标签，让根节点提前归零
  // （踩过：App.vue 的模板被截到第 3098 行，后面 1300 多行模板全没进扫描面）。
  const clean = src.replace(/<!--[\s\S]*?-->/g, ' ')
  const t = rootBlock(clean, 'template')
  // 可能有多个 <style>；只取带 scoped 的那个（本仓库每文件至多一个 scoped 块）
  const styleRe = /<style([^>]*)>([\s\S]*?)<\/style>/g
  let style = null
  for (const m of src.matchAll(styleRe)) {
    if (/\bscoped\b/.test(m[1])) { style = m[2]; break }
  }
  return { tpl: t ? t.body : null, style }
}

// 动态 class 会把类名写在字符串字面量里（如 useDsh.ts 的
//   return l.kind === 'user' ? 'layer-user' : ... 'layer-base'
// 再由模板 :class="dshDumpLayerCls(l)" 应用）。只扫模板区会把这些活类误判成孤儿
// （踩过：.layer-base / .layer-bundle / .layer-user 差点被误删）。
// 故把「本文件 <script> 段 + 全部 src/**/*.ts」里的类名字面量也收进"活类"集合。
function scriptClasses(src) {
  const out = new Set()
  const grab = (text) => {
    for (const m of text.matchAll(/['"`]([^'"`]*)['"`]/g)) {
      for (const t of m[1].split(/\s+/)) {
        if (/^[A-Za-z_][\w-]*$/.test(t)) out.add(t)
      }
    }
  }
  const s = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (s) grab(s[1])
  for (const f of TS_FILES) grab(read(f))
  return out
}

// 拼接前缀集合（跨文件收集：字面量在模板里，但要在本文件判定时生效）
const PREFIXES = new Set()

// 从模板区收集出现的 class 名。要点：**引号必须按类型配平**，否则
//   :class="{ 'tab-on': x }"
// 这种「双引号属性值里嵌单引号字符串」的写法会被朴素正则当成 双引号…单引号 一跨配对，
// 把中间的 'tab-on' 整段吃掉（踩过：.tab-on / .danger 等被误报成孤儿）。
// 做法：先按「成对引号」切出所有引号片段，再按空白切 token；标签内其余裸标识符也一并收集。
function templateClasses(tpl) {
  const out = new Set()
  if (!tpl) return out
  const body = tpl.replace(/<!--[\s\S]*?-->/g, ' ') // 注释里提 class 不算数
  // 拼接式 class：:class="'gh-step-' + s.state" / :class="'h-' + h"
  // 字面量只有 'gh-step-'，具体类名（gh-step-ok 等）由运行时拼出，字面量扫不到。
  // 故把 'xxx-' 形态的前缀单独记下，判定时用 startsWith 匹配（见 PREFIXES）。
  for (const m of body.matchAll(/['"`]([A-Za-z_][\w-]*-)['"`]\s*\+/g)) PREFIXES.add(m[1])
  // HTML 属性值一律由同类引号包裹；逐个引号字符走，同类闭合才算一段。
  for (let i = 0; i < body.length; i++) {
    const q = body[i]
    if (q !== '"' && q !== "'") continue
    let j = i + 1
    while (j < body.length && body[j] !== q) j++
    const chunk = body.slice(i + 1, j)
    for (const t of chunk.split(/[^A-Za-z0-9_-]+/)) {
      if (/^[A-Za-z_][\w-]*$/.test(t)) out.add(t)
    }
    i = j
  }
  return out
}

// 从 scoped 样式区抽出「顶层选择器 → 引用到的 class 名」。
// 逐字符走：跳过注释、跳过 @media/@supports 这类块的外壳（其内部选择器同样按顶层处理），
// 遇到 { 之前的一段即选择器文本，遇 } 弹栈。简化做法：先压掉注释，再按 { } 分段。
function selectorClasses(style) {
  const out = []
  if (!style) return out
  const src = style.replace(/\/\*[\s\S]*?\*\//g, ' ') // 去 CSS 注释
  const decl = [] // 结果：{ selector, classes:Set }
  let buf = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      const sel = buf.trim()
      buf = ''
      // @media 外壳不产规则；其余选择器（含 @media 内部的直接选择器）逐条记入
      if (sel && !sel.startsWith('@')) decl.push(sel)
      else if (sel.startsWith('@')) decl.push(null) // @media 外壳，不产规则
      continue
    }
    if (ch === '}') {
      decl.push(null)
      buf = ''
      continue
    }
    buf += ch
  }
  for (const sel of decl) {
    if (!sel) continue
    const classes = new Set()
    for (const m of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) classes.add(m[1])
    if (classes.size) out.push({ selector: sel, classes: [...classes] })
  }
  return out
}

// COC_ALLOW：自检注入（JSON 数组），替代真实仓库白名单
const ALLOW = process.env.COC_ALLOW ? JSON.parse(process.env.COC_ALLOW) : [
  // （暂空 —— 确认误报时按 "文件:类名" 写条目并注明理由；目标是清空）
]

const failOnOrphan = process.argv.includes('--fail')

let total = 0
// 先全量收集拼接前缀：前缀字面量可能在 A 文件，而对应的 .xxx-yyy 规则在 B 文件的 style 里，
// 若边扫边判，B 先于 A 处理就会漏掉前缀（顺序依赖）。故先过一遍收集，再判定。
const parsed = FILES.map((f) => ({ f, src: read(f) }))
for (const { src } of parsed) {
  const { tpl } = sections(src)
  templateClasses(tpl)
}
for (const { f, src } of parsed) {
  const { tpl, style } = sections(src)
  if (!style) continue
  const inTpl = templateClasses(tpl)
  const inScript = scriptClasses(src)
  const orphans = []
  for (const { selector, classes } of selectorClasses(style)) {
    const dead = classes.filter(
      (c) =>
        !inTpl.has(c) &&
        !inScript.has(c) &&
        ![...PREFIXES].some((p) => c.startsWith(p)) &&
        !ALLOW.includes(`${f}:${c}`),
    )
    // 仅当该选择器的**全部** class 都找不到才算孤儿（含 .a.b 时只要有一个活着就还有作用）
    if (dead.length === classes.length) orphans.push({ selector, classes: dead })
  }
  if (orphans.length) {
    total += orphans.length
    console.log(`\n[orphan-css] ${f}：${orphans.length} 条规则在本文件模板/脚本里都找不到对应 class`)
    for (const o of orphans) console.log(`    ${o.selector}    ← .${o.classes.join(' .')}`)
  }
}

if (total) {
  console.log(`\n[orphan-css] 合计 ${total} 条孤儿规则。多为拆卡片时样式留在原处所致；`)
  console.log('  仍可能有动态 class 误报（拼名方式超出字面量扫描），确认后进 ALLOW 豁免。')
  if (failOnOrphan) process.exit(1)
} else {
  console.log('[orphan-css] 未发现孤儿规则')
}
