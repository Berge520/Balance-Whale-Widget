/*
 * 文件体积棘轮闸门：按扩展名给源文件设行数上限，存量超限文件只能缩不能涨。
 *
 * 为什么要有：项目里有多个「越改越大」的单文件（挂件页、设置页、preload 设置模块），
 * 它们不是一天长成的，也没法一次性拆完；但如果不设闸门，新改动继续往里塞，
 * 「以后拆」就永远只是口号。闸门把现状冻结成基线：已超限的文件登记进白名单，
 * 只允许变短；没登记的文件一超限就拦下。
 *
 * 白名单语义（三条都会报错，避免它变成永久豁免）：
 *   1. 白名单内的文件行数 > 记录的基线 → 报错（只能缩不能涨）；
 *   2. 白名单内的文件已经 ≤ 上限 → 报错（说明瘦身达标，条目必须删掉）；
 *   3. 白名单条目对应的文件不存在 / 不在扫描范围 → 报错（防止改名后留死条目）。
 *
 * 排除项：dist/ 与 node_modules/ 不在扫描路径内；src/search-index.gen.ts 由
 * gen-search-index.mjs 生成（改了模板就必须重生成），体积不由手写控制，排除。
 *
 * 用法：node scripts/check-file-size.mjs   # 有问题 exit 1（已挂 prebuild，见 package.json）
 * 自检：test/check-file-size.test.mjs 用临时目录构造超限 / 白名单三态，不碰真实仓库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')

export const ALLOWLIST_FILE = 'scripts/file-size-allowlist.json'
export const SCAN_DIRS = ['public', 'src']
export const EXCLUDED = new Set(['src/search-index.gen.ts'])
// 700 行 ≈ 单文件仍可通读的量级；按扩展名分开配置，后续可单独收紧某一类
export const LIMITS = { '.js': 700, '.ts': 700, '.vue': 700, '.css': 700 }
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

// 行数口径：统一按 \n 切分并丢掉末尾空行，保证 Windows（CRLF）与 CI（LF）计数一致
export function countLines(text) {
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

export function listFiles(root = ROOT, dirs = SCAN_DIRS) {
  const out = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(abs)
        continue
      }
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (!EXCLUDED.has(rel)) out.push(rel)
    }
  }
  for (const d of dirs) {
    const abs = path.join(root, d)
    if (fs.existsSync(abs)) walk(abs)
  }
  return out.sort()
}

export function checkFileSizes({ root = ROOT, allowlist = {}, limits = LIMITS, dirs = SCAN_DIRS } = {}) {
  const errors = []
  const seen = new Set()
  let checked = 0
  for (const rel of listFiles(root, dirs)) {
    const limit = limits[path.extname(rel).toLowerCase()]
    if (!limit) continue
    checked++
    const lines = countLines(fs.readFileSync(path.join(root, rel), 'utf8'))
    const base = allowlist[rel]
    if (base === undefined) {
      if (lines > limit) {
        errors.push(
          `超出上限：${rel} 现 ${lines} 行 > ${limit} 行 —— 请拆分，或登记进 ${ALLOWLIST_FILE}`,
        )
      }
      continue
    }
    seen.add(rel)
    if (!Number.isInteger(base) || base <= 0) {
      errors.push(`白名单值非法：${rel} 的基线必须是正整数（当前 ${JSON.stringify(base)}）`)
    } else if (base <= limit) {
      errors.push(`白名单值非法：${rel} 的基线 ${base} 行未超过上限 ${limit}，该条目应直接删除`)
    } else if (lines > base) {
      errors.push(
        `白名单只缩不涨：${rel} 现 ${lines} 行 > 基线 ${base} 行 —— 请拆分文件，不要上调基线`,
      )
    } else if (lines <= limit) {
      errors.push(
        `白名单失效：${rel} 现 ${lines} 行已 ≤ 上限 ${limit}，瘦身达标，请从 ${ALLOWLIST_FILE} 删除该条目`,
      )
    }
  }
  for (const rel of Object.keys(allowlist)) {
    if (!seen.has(rel)) {
      errors.push(`白名单条目无效：${rel} 不存在或不在扫描范围，请从 ${ALLOWLIST_FILE} 删除`)
    }
  }
  return { errors, checked }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const allowlistPath = path.join(ROOT, ALLOWLIST_FILE)
  let allowlist
  try {
    allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
  } catch (e) {
    console.error(`[file-size] ✗ 读不到白名单 ${ALLOWLIST_FILE}：${e.message}`)
    process.exit(1)
  }
  const { errors, checked } = checkFileSizes({ allowlist })
  if (errors.length) {
    console.error('[file-size] ✗ 文件体积棘轮闸门未通过：')
    for (const e of errors) console.error(`  - ${e}`)
    console.error('  白名单只冻结存量、不豁免增量；确实要放宽单文件上限请单独评审。')
    process.exit(1)
  }
  console.log(
    `[file-size] ✓ ${checked} 个源文件通过棘轮闸门（白名单 ${Object.keys(allowlist).length} 条）`,
  )
}
