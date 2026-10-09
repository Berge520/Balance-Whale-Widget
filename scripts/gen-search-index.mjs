/*
 * 卡片搜索索引生成器（构建期）
 *
 * 痛点：设置页搜索原本只搜人工维护的 SEARCH_INDEX（标题 + 手工同义词），卡内功能词
 * 靠人肉枚举，漏登记就静默零命中（如搜「悬浮窗」找不到「挂件窗口」卡）。
 * 这里在构建期把每张卡的**可见文本**从模板源码里抽出来，生成 src/search-index.gen.ts，
 * 供运行时做「卡片全文」第三档匹配 —— 新加字段不用配词，索引自动跟上。
 *
 * 提取口径（为什么不是全量文本）：
 *   - 只抽 `<span class="label...">` 字段名与 `<h2>` 卡头：它们是用户会照着敲的措辞；
 *     guide/说明句、按钮文案（「清除」「导入」）噪声大、检索价值低，不进索引。
 *   - `{{ }}` 插值是运行时数据（动态清单等），静态源码里拿不到，剥掉。
 *   - HTML 注释剥掉。
 *
 * 一致性闸门（--check 模式）：索引生成物入库，但 prebuild 时用 --check 重算比对，
 * 模板改了没重新生成 → 构建失败，保证 gen 文件永不陈旧。
 *
 * 运行：node scripts/gen-search-index.mjs [--check]
 *
 * 自检：test/search-index.test.mjs 用临时样本模板验证「能提取 / 漏登记红 / 过期红」，
 * 经 GSI_APP（样本 App.vue 路径）/ GSI_OUT（产物路径）/ GSI_CHECK=1（注入 --check）三个
 * 环境变量注入。真实构建不设这些变量，走默认路径，行为不变。
 *   - GSI_APP 同时承担「样本模板 + 样本 SEARCH_INDEX 来源」，注入后不再读 views/。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 自检注入口：整体覆盖默认值（与 check-dead-settings 的 CDS_* 同思路）
const APP = process.env.GSI_APP || path.join(root, 'src/App.vue')
const OUT = process.env.GSI_OUT || path.join(root, 'src/search-index.gen.ts')
const argCheck = process.env.GSI_CHECK === '1' || process.argv.includes('--check')

const read = (p) => readFileSync(p, 'utf8')

// 与运行时 normSearch 同口径：小写 + 删所有空白
const norm = (s) => s.toLowerCase().replace(/\s+/g, '')

// 卡片文本噪声大，若整卡原文进索引，命中排序会很糊（搜「音效」几十张卡全中）。

// 真实仓库：把 src/views/ 下所有 .vue 的内容也并进来（锚点可能落在异步组件里）
function fsReadDirJoin() {
  const viewsDir = path.join(root, 'src/views')
  return readdirSync(viewsDir).filter((f) => f.endsWith('.vue')).map((f) => readFileSync(path.join(viewsDir, f), 'utf8')).join('\n')
}

// 折中：抽「有检索价值的文本」—— h2 卡头 + label 字段名（会照着敲的措辞），且剥掉
// 括号补充说明与引号（「音量（0–100%）」只需「音量」）。
function extractCardText(segment) {
  const raws = []
  const h = segment.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
  if (h) raws.push(h[1])
  // 画廊类卡片（assetsSkins / assetsSounds 等）不用 h2，卡头是 <button class="fold-title">，
  // 内部还嵌着折叠箭头 span，一并剥掉
  for (const m of segment.matchAll(/<button class="fold-title[^"]*"[^>]*>([\s\S]*?)<\/button>/g)) raws.push(m[1])
  for (const m of segment.matchAll(/<span class="label[^"]*">([\s\S]*?)<\/span>/g)) raws.push(m[1])
  return raws
    .map((s) => s
      .replace(/<span[^>]*class="fold-caret[^"]*"[^>]*>[\s\S]*?<\/span>/g, '') // 折叠箭头（▾/▸）纯装饰
      .replace(/<span[^>]*class="caret[^"]*"[^>]*>[\s\S]*?<\/span>/g, '') // 整卡折叠（.card-toggle）的箭头，同上
      // 收起态摘要（.card-sum）：纯插值的单行摘要（如「已导入 {{n}} / {{m}} 个槽位」）剥掉 ——
      // 去掉 {{}} 后只剩「已导入 / 个槽位」这种残句，纯噪声。
      // 内嵌 <template> 的条件兜底文案（「点击展开诊断」）含标签，不匹配，保留下来可搜
      .replace(/<span[^>]*class="card-sum[^"]*"[^>]*>[^<]*<\/span>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/（[^（）]*）/g, '')
      .replace(/\([^()]*\)/g, '')
      .replace(/[「」『』""'']/g, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter((s) => s.length >= 2)
}

// 按模板里的 <section ... data-search="key"> 切片，逐卡提取
function extractAll(appSrc, extraSrc, fileLabel) {
  const src = appSrc + '\n' + extraSrc
  const noComment = src.replace(/<!--[\s\S]*?-->/g, '')
  const sections = []
  for (const m of noComment.matchAll(/<section\b[^>]*data-search="([A-Za-z0-9_]+)"[^>]*>/g)) {
    sections.push({ key: m[1], start: m.index + m[0].length })
  }
  if (!sections.length) throw new Error(`${fileLabel}: 没匹配到任何 data-search 卡片锚点，解析规则可能已失效`)
  const out = {}
  for (let i = 0; i < sections.length; i++) {
    const seg = noComment.slice(sections[i].start, sections[i + 1] ? sections[i + 1].start : undefined)
    const texts = extractCardText(seg)
    if (!texts.length) throw new Error(`${fileLabel}: 卡「${sections[i].key}」没提取到任何文本，解析规则可疑`)
    out[sections[i].key] = texts
  }
  return out
}

// 生成 TS 产物（Record<key, 文本串>），与 SEARCH_INDEX 的 key 集合做一致性校验
function buildIndex() {
  const appSrc = read(APP)
  // views/ 只在真实仓库追加（异步组件 AccelView 里也有卡片锚点）；样本注入时单一文件即完整样本
  let extraSrc = ''
  if (!process.env.GSI_APP) {
    try {
      extraSrc = fsReadDirJoin()
    } catch {} // views 目录不存在时跳过
  }
  const cards = extractAll(appSrc, extraSrc, path.relative(root, APP))

  // 与 SEARCH_INDEX 对齐：从 App.vue 抠出 `const SEARCH_INDEX = {...}` 的键集合
  const block = appSrc.match(/const SEARCH_INDEX[^=]*=\s*\{([\s\S]*?)\n\}/)
  if (!block) throw new Error('App.vue 里找不到 SEARCH_INDEX 定义')
  const indexKeys = new Set()
  for (const m of block[1].matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{/gm)) indexKeys.add(m[1])
  // GSI_MIN_KEYS：样本仓库只造几个键，放宽「解析出过少键 = 解析规则失效」的护栏阈值
  // （与 check-dead-settings 的 CDS_MIN_KEYS 同思路）
  const MIN_KEYS = Number(process.env.GSI_MIN_KEYS) || 10
  if (indexKeys.size < MIN_KEYS) throw new Error(`SEARCH_INDEX 只解析出 ${indexKeys.size} 个键，解析规则可疑`)

  const cardKeys = new Set(Object.keys(cards))
  const missingInIndex = [...cardKeys].filter((k) => !indexKeys.has(k))
  const missingInCards = [...indexKeys].filter((k) => !cardKeys.has(k))
  const problems = []
  if (missingInIndex.length) problems.push(`模板有 data-search 但 SEARCH_INDEX 未登记：${missingInIndex.join(', ')}`)
  if (missingInCards.length) problems.push(`SEARCH_INDEX 登记了但模板没有对应卡片：${missingInCards.join(', ')}`)
  if (problems.length) throw new Error(problems.join('\n'))

  // 输出 Record<key, 归一化文本串>；固定 key 顺序（按 SEARCH_INDEX 声明序）减少 git 噪声
  const lines = [...indexKeys].map((k) => `  ${k}: ${JSON.stringify(norm(cards[k].join(' ')))},`)
  const banner = '// 由 scripts/gen-search-index.mjs 自动生成 —— DO NOT EDIT。\n' +
    '// 来源：App.vue + views/*.vue 模板里每张卡片（data-search 锚点）的可见文本（h2 卡头 + label 字段名），\n' +
    '// 已做归一化（小写 + 删空白）。模板改动后由 prebuild 重新生成；手改会被 --check 拦下。\n'
  return banner + 'export const CARD_TEXT: Record<string, string> = {\n' + lines.join('\n') + '\n}\n'
}

const generated = buildIndex()

if (argCheck) {
  let existing = ''
  try {
    existing = read(OUT)
  } catch {} // 首次运行还没有产物，视为不一致
  if (existing !== generated) {
    console.error('[gen-search-index] src/search-index.gen.ts 已过期（模板改了但没重新生成索引）。请运行：node scripts/gen-search-index.mjs')
    process.exit(1)
  }
  console.log('[gen-search-index] 索引与模板一致')
} else {
  writeFileSync(OUT, generated, 'utf8')
  console.log(`[gen-search-index] 已写入 ${path.relative(root, OUT)}`)
}
