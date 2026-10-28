/*
 * scripts/check-zip-size.mjs 与 scripts/zip-limits.mjs 的自检（node --test，零依赖）。
 *
 * 钉住：小文件放行、超限拦下、文件不存在拦下；上限只有一份（verify-release-zip.mjs
 * 必须从 zip-limits.mjs 取，不许自己写死一个数字 —— 两处各写一份必然漂移）。
 * 超限样本用稀疏文件造（ftruncate 只改大小不占磁盘），不往临时目录里真写 8MB。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_ZIP_BYTES, MAX_ZIP_LABEL } from '../scripts/zip-limits.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/check-zip-size.mjs', import.meta.url))
const VERIFY = fileURLToPath(new URL('../scripts/verify-release-zip.mjs', import.meta.url))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-size-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const run = (file) => spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' })

const sparse = (name, bytes) => {
  const file = path.join(tmp, name)
  const fd = fs.openSync(file, 'w')
  fs.ftruncateSync(fd, bytes)
  fs.closeSync(fd)
  return file
}

test('上限是有限的正数且与文案一致', () => {
  assert.ok(Number.isFinite(MAX_ZIP_BYTES) && MAX_ZIP_BYTES > 0)
  assert.equal(MAX_ZIP_BYTES, 8 * 1024 * 1024)
  assert.equal(MAX_ZIP_LABEL, '8 MB')
})

test('小文件放行', () => {
  const r = run(sparse('small.zip', 2 * 1024 * 1024))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /✓/)
})

test('超过上限拦下', () => {
  const r = run(sparse('big.zip', MAX_ZIP_BYTES + 1))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /超过上限/)
  assert.match(r.stderr, /dist\/resources\//)
})

test('文件不存在拦下（而不是当成 0 字节放行）', () => {
  const r = run(path.join(tmp, 'nope.zip'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /读不到/)
})

test('verify-release-zip 复用同一个上限（不许写死数字）', () => {
  const src = fs.readFileSync(VERIFY, 'utf8')
  assert.match(src, /from '\.\/zip-limits\.mjs'/, 'verify-release-zip.mjs 没有从 zip-limits.mjs 取上限，两处各写一份必然漂移')
})
