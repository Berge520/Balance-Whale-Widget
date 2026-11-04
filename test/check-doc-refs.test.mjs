/*
 * scripts/check-doc-refs.mjs 的自检（node --test，零依赖）。
 *
 * 钉住的四件事：
 *   - 文档引用了代码里已不存在的符号（历史形态：`focus.recordRound`）必须拦下来；
 *   - 全部对得上时放行；
 *   - 文件名不算符号引用（`store.test.mjs` / `focus.js` 里那个点是文件名的一部分），
 *     否则门禁会被一片误报淹掉，下一个人直接就把这关关了；
 *   - 不加 --fail 时只报不拦（本地看一眼用）。
 *
 * 用 DR_ROOT 指向临时目录，里面摆一份假的 lib/focus.js 与 README，不碰工作区。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/check-doc-refs.mjs', import.meta.url))

const LIB_SRC = `
function isRound(s) { return s.k === 'down' }
function deriveDays(sessions) { return {} }
const pruneFocus = () => {}
module.exports = { isRound, deriveDays, pruneFocus, sum: 1 }
`

function fixture(docs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-refs-'))
  fs.mkdirSync(path.join(root, 'public', 'preload', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'public', 'preload', 'lib', 'focus.js'), LIB_SRC)
  fs.writeFileSync(path.join(root, 'README.md'), docs)
  return root
}

const run = (root, args = ['--fail']) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DR_ROOT: root },
  })

test('文档写了一个代码里已删除的符号时拦下来', () => {
  const root = fixture('# 专注\n\n写入路径 = `focus.recordRound` 累加当天。\n')
  const r = run(root)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /focus\.recordRound/)
})

test('符号都在模块里时放行', () => {
  const root = fixture('# 专注\n\n口径见 `focus.isRound`，天表由 `focus.deriveDays` 派生。\n')
  const r = run(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('文件名不算符号引用：store.test.mjs 与 focus.js 都不报', () => {
  const root = fixture('# 专注\n\n单测见 store.test.mjs，模块在 lib/focus.js，形状归 store.readFocus 管。\n')
  const r = run(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('不加 --fail 时只报不拦', () => {
  const root = fixture('# 专注\n\n`focus.recordRound` 已经不在了。\n')
  const r = run(root, [])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout + r.stderr, /focus\.recordRound/)
})
