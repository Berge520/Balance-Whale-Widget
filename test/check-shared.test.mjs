/*
 * check-shared.mjs 的**自检**（node --test，零依赖）。
 *
 * 思路同上游 ci-audit-selftest.mjs：门禁「坏了也会绿」这件事，只有反过来喂坏样本才暴露。
 * 本脚本最关键的一处防线是 **「两侧都读失败不得被判成一致」** ——
 *   marker 写错 → 两侧都抛同一条错误串 → 朴素的 `new Set(values).size === 1` 会判「一致」，
 *   门禁被绕过（脚本末尾 failed.length 分支专门拦这个）。
 * 下面就把这条、以及「不一致必红 / 一致必绿」逐条钉死。
 *
 * 样本经 CS_ROOT / CS_CHECKS 注入；真实构建不设这两个变量，走脚本内置的 CHECKS。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-shared.mjs')

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cs-selftest-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return root
}

function runScript({ root, checks }) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, CS_ROOT: root, CS_CHECKS: JSON.stringify(checks) },
    encoding: 'utf8',
  })
}

// 一条「两文件取同一 marker」的最小用例
const twoWay = (name, marker, fileA, fileB, kind = 'number') => ({
  name,
  parts: [
    { file: fileA, pick: kind, marker },
    { file: fileB, pick: kind, marker },
  ],
})

test('基线：两处同值必须全绿', () => {
  const root = makeRepo({
    'a.js': 'const WIN_PAD = 200\n',
    'b.js': 'const WIN_PAD = 200\n',
  })
  const r = runScript({ root, checks: [twoWay('窗口留白', 'const WIN_PAD', 'a.js', 'b.js')] })
  assert.equal(r.status, 0, `应通过：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /一致/)
})

test('不一致必红：两处不同值被点名', () => {
  const root = makeRepo({
    'a.js': 'const WIN_PAD = 200\n',
    'b.js': 'const WIN_PAD = 999\n',
  })
  const r = runScript({ root, checks: [twoWay('窗口留白', 'const WIN_PAD', 'a.js', 'b.js')] })
  assert.equal(r.status, 1, '不一致应退出非 0')
  assert.match(r.stderr, /不一致/)
})

test('两侧都读失败必红：marker 两边都写错时不得被判成「一致」（门禁绕过回归）', () => {
  const root = makeRepo({
    'a.js': 'const OTHER = 1\n',
    'b.js': 'const OTHER = 2\n',
  })
  // marker 在两边都不存在 → 两处都抛错误。若判等逻辑是 `new Set([err,err]).size===1`，
  // 就会被误判成一致、静默放行 —— 这正是这条用例要钉死的。
  const r = runScript({ root, checks: [twoWay('幽灵键', 'const GHOST', 'a.js', 'b.js')] })
  assert.equal(r.status, 1, '两侧都读失败必须退出非 0')
  assert.match(r.stderr, /读取失败/)
})

test('单侧读失败必红：一处有、一处没有', () => {
  const root = makeRepo({
    'a.js': 'const WIN_PAD = 200\n',
    'b.js': 'const OTHER = 1\n',
  })
  const r = runScript({ root, checks: [twoWay('窗口留白', 'const WIN_PAD', 'a.js', 'b.js')] })
  assert.equal(r.status, 1, '单侧读失败应退出非 0')
  assert.match(r.stderr, /读取失败/)
})

test('字符串 / 字面量三种 pick 都能跑通', () => {
  const root = makeRepo({
    'a.js': "const DEFAULT_SKIN = 'DSniang02'\n",
    'b.js': "const DEFAULT_SKIN = 'DSniang02'\n",
    // 字面量比对会压掉空白，故两边缩进不同也应判一致（键顺序必须相同，脚本不排序）
    'c.js': 'const PEAK_HOURS = { a: 1, b: 2 }\n',
    'd.js': 'const PEAK_HOURS = {a:1,b:2}\n',
  })
  const r = runScript({
    root,
    checks: [
      twoWay('默认形象', 'const DEFAULT_SKIN', 'a.js', 'b.js', 'string'),
      twoWay('峰谷表', 'const PEAK_HOURS =', 'c.js', 'd.js', 'literal'),
    ],
  })
  assert.equal(r.status, 0, `应通过：\n${r.stdout}${r.stderr}`)
})

test('真实仓库（不注入）跑一遍仍绿：内置 CHECKS 全一致', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `真实仓库应通过：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /全部副本一致/)
})
