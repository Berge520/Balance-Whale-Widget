/*
 * settings.js 的 patch 开关回归测试（node --test，零依赖）。
 *
 * 只钉一条链路：`dshPatchToggle` 的**表达式行**（`disabled: !!js …`）。
 * 纯函数层（parsePatch / applyToggle）已在 dsh-patch.test.mjs 覆盖，但宿主层有两个
 * 容易漏掉的转述点：
 *   ① `dshPatchToggle` 先用 dryRun 探 changed；表达式行「点启用也不会变」时 changed 恰为
 *      false，若提前 return 时不带 message / expression，界面就只能说「已经是该状态」——
 *      用户完全不知道是表达式在拦。
 *   ② 真写后的回读校验若仍按 requested=false 核，会把「保留表达式」误判成写入失败。
 *
 * settings.js 顶层 require 了 log.js（→ utools.getPath），先挂桩再 require。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-patch-toggle-'))
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

process.env.DSH_HOME = tmp

globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  dbCryptoStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}

const require = createRequire(import.meta.url)
const settings = require('../public/preload/lib/settings.js')

const PROFILE = 'web'
const FILE = path.join(tmp, 'profiles', PROFILE, 'cordis.patch.yml')
function writePatch(text) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, text, 'utf8')
}
function readPatch() {
  return fs.readFileSync(FILE, 'utf8')
}

test('dshPatchToggle：启用表达式行 → 不改文件，但把原因带回界面', () => {
  const src = ['- id: a', '  config:', '    k: 1', "  disabled: !!js 'env.x'"].join('\n')
  writePatch(src)
  const r = settings.dshPatchToggle({ profile: PROFILE, id: 'a', disabled: false })
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(r.action, 'noop')
  assert.equal(r.expression, true)
  assert.ok(/!!js/.test(r.message), '必须说明是表达式决定，而不是「已经是该状态」')
  assert.equal(readPatch(), src, '表达式必须逐字保留')
})

test('dshPatchToggle：禁用时保留表达式，回读校验不误判', () => {
  const src = ['- id: a', "  disabled: !!js 'env.x'", '- id: a', '  disabled: false'].join('\n')
  writePatch(src)
  const r = settings.dshPatchToggle({ profile: PROFILE, id: 'a', disabled: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.changed, true)
  assert.equal(r.expression, false, '禁用不涉及「启用被表达式拦住」这条提示')
  const after = readPatch()
  assert.ok(after.includes("disabled: !!js 'env.x'"), '表达式要留着')
  assert.equal(after.includes('disabled: false'), false)
  // 生效值按「表达式保守算禁用」→ true
  assert.equal(settings.dshPatchList({ profile: PROFILE }).items[0].disabled, true)
})
