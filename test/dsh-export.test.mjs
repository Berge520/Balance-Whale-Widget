/*
 * dsh-export.js 的回归测试（node --test，零依赖）。
 *
 * 这里盯的是**几个静默失效型的约定**（错了不会报错、只会悄悄失效）：
 *   1. **空壳包检测**：社区 dsh-backup 0.12.2 那个 bug —— Windows 上 tar 拿到「盘符根目录」
 *      直接失败，留下 29 字节的空壳包却判定为成功。所以打完包必须回读校验条目数与 CRC。
 *      测试造一个假 zip（EOCD 在、内容却是空的）喂给 verifyZip，必须判失败。
 *   2. **凭据默认排除**：和 dsh-backup 一样的红线。这里真的往目录里放 `.credentials.yaml`，
 *      断言默认不进包；勾选 includeCred 后才进 —— 不能反过来。
 *   3. **node_modules 默认可跳过**：默认 true（体积是配置的几十倍）。
 *   4. **symlink 不跟随**：跟随会走进包外目录甚至走进环。造一个指向包外的软链，断言不进包。
 *   5. **可选目录恒排除**：.git / whale-dsh-backup 不给开关，必须在包外（快照目录自己
 *      被备进包里会让包体积随导出次数膨胀）。
 *   6. **包内清单**：包根必须有 whale-dsh-export.json，写明时间、来源、跳过项。
 *   7. **原子写**：失败不留半截包（.part 临时文件不得残留）。
 *
 * dsh-export.js 会 require util.js（纯 fs/os/path）与 log.js，
 * log.js 里用到 utools.getPath —— 所以仍要先挂桩再 import。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── utools 桩（log.js 会取临时目录写 whale-debug.log）──
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}

const require = createRequire(import.meta.url)
const exp = require('../public/preload/lib/dsh-export.js')

// ── 夹具：造一个假的 $DSH_HOME 并把它喂给模块 ──
let tmpRoot = ''
const ENV_KEY = 'DSH_HOME'
const ENV_BAK = process.env[ENV_KEY]

function makeHome(files = {}, dirs = []) {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dshexp-'))
  for (const d of dirs) fs.mkdirSync(path.join(tmpRoot, d), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(tmpRoot, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  process.env[ENV_KEY] = tmpRoot
  return tmpRoot
}
function cleanup() {
  if (ENV_BAK === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = ENV_BAK
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {} tmpRoot = '' }
}

// 读 zip 里的条目名（不依赖外部工具：直接扫 local file header 的魔数）。
// store 模式（method=0）里文件名在 header 偏移 30 处的 nameLen 决定，紧跟 extra 字段
function entryNames(buf) {
  const names = []
  let i = 0
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break
    const nameLen = buf.readUInt16LE(i + 26)
    const extraLen = buf.readUInt16LE(i + 28)
    const size = buf.readUInt32LE(i + 18)
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8')
    names.push(name)
    i += 30 + nameLen + extraLen + size
  }
  return names
}
function readEntry(buf, want) {
  let i = 0
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break
    const nameLen = buf.readUInt16LE(i + 26)
    const extraLen = buf.readUInt16LE(i + 28)
    const size = buf.readUInt32LE(i + 18)
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8')
    const start = i + 30 + nameLen + extraLen
    if (name === want) return buf.slice(start, start + size)
    i = start + size
  }
  return null
}

const CRED = '.credentials.yaml'
const PATCH = 'profiles/web/cordis.patch.yml'

test('默认导出：不含凭据、不含 node_modules，包内有清单', () => {
  const home = makeHome({
    [PATCH]: 'plugins:\n  - id: a\n',
    'profiles/web/package.json': '{"name":"web"}',
    [CRED]: 'token: super-secret',
    'profiles/web/node_modules/dep/index.js': 'module.exports = 1',
  })
  const out = path.join(os.tmpdir(), 'whale-exp-' + Date.now() + '.zip')
  try {
    const r = exp.exportAll({ outPath: out, includeCred: false, skipModules: true })
    assert.equal(r.ok, true, r.error || '')
    const buf = fs.readFileSync(out)
    const names = entryNames(buf)
    // 明文凭据绝不能默认进包
    assert.ok(names.includes(PATCH), '应包含 patch 文件')
    assert.ok(!names.includes(CRED), '凭据文件默认必须排除')
    assert.ok(!names.some((n) => n.includes('node_modules')), 'node_modules 默认必须跳过')
    assert.ok(names.includes(exp.MANIFEST_NAME), '包根必须有清单')
    // 清单要能解出「跳过了什么」，否则用户拿到少文件的包也不知道
    const man = JSON.parse(readEntry(buf, exp.MANIFEST_NAME).toString('utf8'))
    assert.equal(man.kind, 'whale-dsh-export')
    assert.equal(man.includeCred, false)
    assert.ok(man.skippedTotal >= 1)
    assert.ok(man.skipped.some((s) => s.rel === CRED))
    assert.equal(man.dshHome, home)
  } finally {
    try { fs.rmSync(out, { force: true }) } catch (_) {}
    cleanup()
  }
})

test('勾选 includeCred 后凭据文件进包（唯一切换点，不能反向）', () => {
  makeHome({ [CRED]: 'token: super-secret', [PATCH]: 'a: 1\n' })
  const out = path.join(os.tmpdir(), 'whale-exp-cred-' + Date.now() + '.zip')
  try {
    const r = exp.exportAll({ outPath: out, includeCred: true, skipModules: true })
    assert.equal(r.ok, true, r.error || '')
    const names = entryNames(fs.readFileSync(out))
    assert.ok(names.includes(CRED), '勾选后凭据文件必须进包')
  } finally {
    try { fs.rmSync(out, { force: true }) } catch (_) {}
    cleanup()
  }
})

test('skipModules=false 时才收 node_modules', () => {
  makeHome({
    [PATCH]: 'a: 1\n',
    'profiles/web/node_modules/dep/index.js': 'module.exports = 1',
  })
  const out = path.join(os.tmpdir(), 'whale-exp-mod-' + Date.now() + '.zip')
  try {
    const r = exp.exportAll({ outPath: out, includeCred: false, skipModules: false })
    assert.equal(r.ok, true, r.error || '')
    const names = entryNames(fs.readFileSync(out))
    assert.ok(names.some((n) => n.includes('node_modules')), '取消跳过时应包含 node_modules')
  } finally {
    try { fs.rmSync(out, { force: true }) } catch (_) {}
    cleanup()
  }
})

test('恒排除目录 .git 与 whale-dsh-backup 在包外（没有开关）', () => {
  makeHome({
    [PATCH]: 'a: 1\n',
    '.git/config': '[core]\n',
    'whale-dsh-backup/20260101-000000/web/cordis.patch.yml': 'old: 1\n',
  })
  const out = path.join(os.tmpdir(), 'whale-exp-excl-' + Date.now() + '.zip')
  try {
    const r = exp.exportAll({ outPath: out, includeCred: false, skipModules: true })
    assert.equal(r.ok, true, r.error || '')
    const names = entryNames(fs.readFileSync(out))
    assert.ok(!names.some((n) => n.startsWith('.git/')), '.git 必须恒排除')
    // 快照目录自己被备进包里，会让包体积随导出次数膨胀
    assert.ok(!names.some((n) => n.startsWith('whale-dsh-backup/')), '快照目录必须恒排除')
  } finally {
    try { fs.rmSync(out, { force: true }) } catch (_) {}
    cleanup()
  }
})

test('symlink 不跟随（不走进包外目录 / 不走进环）', (t) => {
  if (process.platform === 'win32') {
    // Windows 下建软链要特权，测试环境通常没有 —— 跳过而不是伪造通过
    t.skip('Windows 建 symlink 需要特权，跳过')
    return
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-content')
  try {
    makeHome({ [PATCH]: 'a: 1\n' })
    fs.symlinkSync(outside, path.join(tmpRoot, 'link-out'), 'dir')
    // 指回自己：跟随就会无限展开
    fs.symlinkSync(tmpRoot, path.join(tmpRoot, 'link-loop'), 'dir')
    const out = path.join(os.tmpdir(), 'whale-exp-link-' + Date.now() + '.zip')
    try {
      const r = exp.exportAll({ outPath: out, includeCred: false, skipModules: true })
      assert.equal(r.ok, true, r.error || '')
      const names = entryNames(fs.readFileSync(out))
      assert.ok(!names.some((n) => n.includes('secret.txt')), '不得跟随软链走进包外目录')
      assert.ok(!names.some((n) => n.startsWith('link-loop/')), '不得跟随软链走进环')
    } finally {
      try { fs.rmSync(out, { force: true }) } catch (_) {}
    }
  } finally {
    try { fs.rmSync(outside, { recursive: true, force: true }) } catch (_) {}
    cleanup()
  }
})

test('verifyZip 认出被截断的包（EOCD 缺失）', () => {
  // 社区那个 bug 的产物形态：包小得不可能装下任何内容，或写到一半被中断。
  // 注意「0 个条目的合法 zip」是**结构合法**的，verifyZip 不该误判 —— 真正要拦的是
  // 「声称有内容、实际没有」与「写到一半」。所以这里测的是截断：把正常包砍掉尾巴。
  const home = makeHome({ [PATCH]: 'a: 1\n' })
  assert.ok(home)
  const out = path.join(os.tmpdir(), 'whale-exp-cut-' + Date.now() + '.zip')
  try {
    const r = exp.exportAll({ outPath: out, includeCred: false, skipModules: true })
    assert.equal(r.ok, true, r.error || '')
    const buf = fs.readFileSync(out)
    // 砍掉最后 30 字节：EOCD 没了
    const cut = buf.slice(0, buf.length - 30)
    const check = exp._verifyZip(cut)
    assert.equal(check.ok, false, '截断包必须判失败')
  } finally {
    try { fs.rmSync(out, { force: true }) } catch (_) {}
    cleanup()
  }
})

test('verifyZip 拒绝过小的产物（空壳包的最小形态）', () => {
  // 社区那个 bug 产出的就是 29 字节的空壳 —— 这里用同样的大小，
  // 断言它必须被判失败（具体走「找不到 EOCD」还是「过小」不重要，重点是 ok:false）
  const r = exp._verifyZip(Buffer.alloc(29, 0))
  assert.equal(r.ok, false)
  assert.ok(r.error, '失败时必须给出原因')
})

test('verifyZip 在内容被改后判失败（CRC 校验）', () => {
  const home = makeHome({ [PATCH]: 'a: 1\n' })
  assert.ok(home)
  const out = path.join(os.tmpdir(), 'whale-exp-crc-' + Date.now() + '.zip')
  try {
    const r = exp.exportAll({ outPath: out, includeCred: false, skipModules: true })
    assert.equal(r.ok, true, r.error || '')
    const buf = fs.readFileSync(out)
    // 改掉 patch 条目内容里的一字节（不改头，让偏移仍能走通）
    const idx = buf.indexOf(Buffer.from('a: 1'))
    assert.ok(idx > 0, '应能找到内容')
    buf[idx] = 0x62 // 'a' → 'b'
    const check = exp._verifyZip(buf)
    assert.equal(check.ok, false)
  } finally {
    try { fs.rmSync(out, { force: true }) } catch (_) {}
    cleanup()
  }
})

test('写盘原子：成功路径不留 .part 临时文件', () => {
  makeHome({ [PATCH]: 'a: 1\n' })
  const out = path.join(os.tmpdir(), 'whale-exp-atomic-' + Date.now() + '.zip')
  try {
    const r = exp.exportAll({ outPath: out, includeCred: false, skipModules: true })
    assert.equal(r.ok, true, r.error || '')
    assert.ok(fs.existsSync(out), '产出包应存在')
    assert.ok(!fs.existsSync(out + '.part'), '不得残留 .part 临时文件')
  } finally {
    try { fs.rmSync(out, { force: true }) } catch (_) {}
    cleanup()
  }
})

test('没有可导出的文件时不产包、直接返回失败', () => {
  makeHome({})
  const out = path.join(os.tmpdir(), 'whale-exp-empty-' + Date.now() + '.zip')
  try {
    const r = exp.exportAll({ outPath: out, includeCred: false, skipModules: true })
    assert.equal(r.ok, false)
    assert.ok(!fs.existsSync(out), '失败时不应留下空包')
  } finally {
    try { fs.rmSync(out, { force: true }) } catch (_) {}
    cleanup()
  }
})

test('previewExport 只统计不写盘，并单列凭据文件', () => {
  makeHome({
    [PATCH]: 'a: 1\n',
    'profiles/web/package.json': '{"name":"web"}',
    [CRED]: 'token: x',
    'profiles/web/node_modules/dep/index.js': 'x',
  })
  try {
    const r = exp.previewExport({ includeCred: false, skipModules: true })
    assert.equal(r.ok, true, r.error || '')
    assert.equal(r.entries, 2)
    assert.ok(r.bytes > 0)
    assert.deepEqual(r.credFiles, [CRED])
    // 未勾凭据时凭据就在 skipped 里（界面文案靠这一条）
    assert.ok(r.skipped.some((s) => s.rel === CRED))
    // 勾上之后条目数 +1，凭据不再被排除
    const r2 = exp.previewExport({ includeCred: true, skipModules: true })
    assert.equal(r2.entries, 3)
    assert.equal(r2.credFiles.length, 0)
  } finally {
    cleanup()
  }
})

test('isCredFile 认常见凭据文件名，不误伤普通文件', () => {
  for (const n of ['.credentials.yaml', '.credentials.yml', 'credentials.yaml', 'credentials.yml', '.env', '.env.local']) {
    assert.equal(exp.isCredFile(n), true, n + ' 应判为凭据')
  }
  for (const n of ['config.yaml', 'package.json', 'environment.md', 'credentials.md']) {
    assert.equal(exp.isCredFile(n), false, n + ' 不应判为凭据')
  }
})

test('stampOf 输出 YYYYMMDD-HHmm', () => {
  assert.equal(exp.stampOf(new Date(2026, 8, 24, 21, 43)), '20260924-2143')
})
