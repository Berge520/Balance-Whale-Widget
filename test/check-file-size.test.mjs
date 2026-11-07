/*
 * scripts/check-file-size.mjs 的自检（node --test，零依赖）。
 *
 * 体积闸门最容易退化成「永久豁免」：白名单只增不减、或文件删了条目还留着，
 * 表现都是「闸门一直绿」，没人会再去看它。所以这里把白名单三态逐条钉死：
 *   - 未登记且超限 → 必须拦；
 *   - 已登记但比基线长 → 必须拦（只缩不涨）；
 *   - 已登记但瘦到上限以内 → 必须拦（提醒删条目，避免白名单变永久豁免）；
 *   - 已登记但文件不存在 → 必须拦（改名 / 删除后的死条目）。
 * 另外钉住生成文件（search-index.gen.ts）与 dist/ / node_modules/ 的排除口径，
 * 以及「当前仓库的白名单与现状同步」——白名单过期时 npm test 当场红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFileSizes, countLines } from '../scripts/check-file-size.mjs'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
// 测试用的小水位：10 行，写起来直观
const LIMITS = { '.js': 10, '.ts': 10, '.vue': 10, '.css': 10 }

/** 造一棵临时源码树；files 形如 { 'public/a.js': 12 }（值为行数） */
function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-size-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [rel, lines] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const body = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n')
    fs.writeFileSync(abs, `${body}\n`)
  }
  return root
}

test('未超限且未登记的文件放行', (t) => {
  const root = fixture(t, { 'public/a.js': 10, 'src/b.vue': 3 })
  const { errors, checked } = checkFileSizes({ root, limits: LIMITS })
  assert.deepEqual(errors, [])
  assert.equal(checked, 2)
})

test('超过上限且未登记的文件被拦下', (t) => {
  const root = fixture(t, { 'public/a.js': 11 })
  const { errors } = checkFileSizes({ root, limits: LIMITS })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /超出上限：public\/a\.js/)
  assert.match(errors[0], /11 行 > 10 行/)
})

test('白名单内行数等于基线时放行（冻结现状）', (t) => {
  const root = fixture(t, { 'src/App.vue': 20 })
  const { errors } = checkFileSizes({ root, limits: LIMITS, allowlist: { 'src/App.vue': 20 } })
  assert.deepEqual(errors, [])
})

test('白名单内文件变长被拦下（只缩不涨）', (t) => {
  const root = fixture(t, { 'src/App.vue': 21 })
  const { errors } = checkFileSizes({ root, limits: LIMITS, allowlist: { 'src/App.vue': 20 } })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /只缩不涨/)
  assert.match(errors[0], /21 行 > 基线 20 行/)
})

test('白名单内文件瘦到上限以内时报错要求删条目', (t) => {
  const root = fixture(t, { 'src/App.vue': 10 })
  const { errors } = checkFileSizes({ root, limits: LIMITS, allowlist: { 'src/App.vue': 20 } })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /白名单失效/)
  assert.match(errors[0], /删除该条目/)
})

test('白名单条目对应的文件不存在时报错', (t) => {
  const root = fixture(t, { 'src/App.vue': 20 })
  const { errors } = checkFileSizes({
    root, limits: LIMITS, allowlist: { 'src/App.vue': 20, 'src/Gone.vue': 30 },
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /白名单条目无效：src\/Gone\.vue/)
})

test('白名单基线未超过上限属于非法配置（条目过时）', (t) => {
  const root = fixture(t, { 'src/a.ts': 8 })
  const { errors } = checkFileSizes({ root, limits: LIMITS, allowlist: { 'src/a.ts': 10 } })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /基线 10 行未超过上限 10/)
})

test('生成文件与 node_modules / dist 不纳入统计', (t) => {
  const root = fixture(t, {
    'src/search-index.gen.ts': 999,
    'src/node_modules/pkg/big.js': 999,
    'src/dist/big.css': 999,
    'src/ok.ts': 2,
  })
  const { errors, checked } = checkFileSizes({ root, limits: LIMITS })
  assert.deepEqual(errors, [])
  assert.equal(checked, 1)
})

test('行数口径对 CRLF / LF / 末尾空行一致', () => {
  assert.equal(countLines('a\nb\n'), 2)
  assert.equal(countLines('a\r\nb\r\n'), 2)
  assert.equal(countLines('a\r\nb'), 2)
  assert.equal(countLines('a\nb\n\n'), 3)
})

test('当前仓库通过棘轮闸门（白名单与现状同步）', () => {
  const allowlist = JSON.parse(
    fs.readFileSync(new URL('../scripts/file-size-allowlist.json', import.meta.url), 'utf8'),
  )
  const { errors, checked } = checkFileSizes({ root: repoRoot, allowlist })
  assert.deepEqual(errors, [])
  assert.ok(checked > 50, `只统计到 ${checked} 个源文件，扫描口径可疑`)
})
