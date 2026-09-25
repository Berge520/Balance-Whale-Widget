/*
 * backup.js 单测（node --test，零依赖）。
 *
 * 两部分：
 *   1. 凭据加解密 _encryptSecrets / _decryptSecrets（backup.js 里已标注「供测试/排查用」）——
 *      密码设错、GCM 标签算错、旧备份读不出来，都表现为「用户以为备份好了，真要恢复时打不开」，
 *      而这件事在界面上永远不报错、只有真去恢复才发现，所以必须锁死。
 *      scrypt 参数（N/r/p）写进密文块、解密时从块里读，跨版本兼容也靠这一条。
 *   2. applyBackup 的**写入结果判定**（修 B11 的回归项）—— store.js 的 writeConfig / writeTimer /
 *      writeAnchor / mergeLedgerHistory 写失败时**不抛错**，只返回 false / ok:false，
 *      所以 applyBackup 必须逐个判返回值。早先不判，写失败也记进 applied：
 *      用户看到「恢复完成」，重启后一切照旧 —— 这是全项目唯一会丢数据的路径，用测试钉住。
 *
 * 需要 utools 桩：backup.js → store.js → log.js 都直接用 utools（dbStorage / dbCryptoStorage / getPath）。
 * 注意测试侧不能引用裸 utools（ESLint 的 test glob 只给 globals.node），统一走 globalThis.utools。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── utools 桩 ──
// store.js 各读函数都有 try/catch 兜底，且写函数都是「先 try 再返回布尔」，
// 所以桩不需要维护一份真实数据，只要 setItem 的行为可控即可。
// 这里额外提供 vault（模拟 dbCryptoStorage 的 in-memory 存储），供凭据恢复路径用。
const store = new Map()
const vault = new Map()
let failWrite = false
const mem = (m) => ({
  getItem: (k) => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => {
    if (failWrite) throw new Error('模拟 dbStorage 配额写满')
    m.set(k, v)
  },
  removeItem: (k) => { m.delete(k) },
})

globalThis.utools = {
  isDev: () => true,
  getPath: () => os.tmpdir(),
  dbStorage: mem(store),
  dbCryptoStorage: mem(vault),
}

const require = createRequire(import.meta.url)
const backup = require('../public/preload/lib/backup.js')

const { _encryptSecrets, _decryptSecrets, applyBackup, pickBackup, clearPending } = backup

// 真实形状：两项内置凭据 + 各厂商模型的密钥槽位
const secrets = {
  apiKey: 'sk-abc123XYZ_-',
  platformToken: 'Bearer eyJhbGciOi.中文测试.尾巴',
  models: { moonshot: 'sk-moon-1', zhipu: 'raw-token-2' },
}

test('加解密往返：内置凭据与各模型密钥槽位一字不差', () => {
  assert.deepEqual(_decryptSecrets(_encryptSecrets(secrets, 'hunter2!'), 'hunter2!'), secrets)
})

test('同一份明文两次加密得到不同密文（salt / iv 每次新生成）', () => {
  const a = _encryptSecrets(secrets, 'hunter2!')
  const b = _encryptSecrets(secrets, 'hunter2!')
  // salt / iv 复用会让两份备份的相同明文产生相同密文，等于泄露「两人用了同一个 Key」
  assert.notEqual(a.salt, b.salt)
  assert.notEqual(a.iv, b.iv)
  assert.notEqual(a.data, b.data)
  assert.deepEqual(_decryptSecrets(a, 'hunter2!'), _decryptSecrets(b, 'hunter2!'))
})

test('密码错一位就解不开（GCM 认证标签拦下，不会解出半个对象）', () => {
  const blob = _encryptSecrets(secrets, 'hunter2!')
  assert.throws(() => _decryptSecrets(blob, 'hunter2?'))
  assert.throws(() => _decryptSecrets(blob, ''))
})

test('密文或认证标签被改一位就解不开', () => {
  const blob = _encryptSecrets(secrets, 'hunter2!')
  const flip = (b64) => {
    const buf = Buffer.from(b64, 'base64')
    buf[0] ^= 0x01
    return buf.toString('base64')
  }
  assert.throws(() => _decryptSecrets({ ...blob, data: flip(blob.data) }, 'hunter2!'))
  assert.throws(() => _decryptSecrets({ ...blob, tag: flip(blob.tag) }, 'hunter2!'))
})

test('旧备份（明文只有 apiKey / platformToken）能解出，且不带 models 键', () => {
  // 早期版本的凭据里没有 models；applyBackup 见到 undefined 会沿用现值，
  // 所以这里必须解出「没有这个键」，而不是 null / {}（后者会把用户的模型密钥清空）
  const out = _decryptSecrets(_encryptSecrets({ apiKey: 'sk-old', platformToken: '' }, 'pw123456'), 'pw123456')
  assert.equal(out.apiKey, 'sk-old')
  assert.equal(out.platformToken, '')
  assert.equal('models' in out, false)
})

test('结构不对的密文块报「没有可用的凭据」，不外泄底层异常', () => {
  const msg = /备份里没有可用的凭据/
  assert.throws(() => _decryptSecrets(null, 'pw'), msg)
  assert.throws(() => _decryptSecrets(undefined, 'pw'), msg)
  assert.throws(() => _decryptSecrets('not-an-object', 'pw'), msg)
  assert.throws(() => _decryptSecrets({}, 'pw'), msg)
  assert.throws(() => _decryptSecrets({ salt: 'x' }, 'pw')) // 缺 data
})

// ── applyBackup：写失败必须上报失败（B11 回归项）──

// 走真实入口：pickBackup 用 utools.showOpenDialog 取路径、fs.readFileSync 读内容，
// 这里只把 showOpenDialog 指到一个临时文件，pending 就由生产代码自己装配。
// （pending 是模块私有，任何「直接造 pending」的写法都测不到真实契约。）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-backup-'))
let seq = 0
function stage(data) {
  const p = path.join(tmpDir, 'b' + (++seq) + '.json')
  fs.writeFileSync(p, JSON.stringify({
    kind: 'balance-whale-widget-backup', schema: 1, exportedAt: '2026-09-25T00:00:00.000Z', data: data,
  }), 'utf8')
  globalThis.utools.showOpenDialog = () => [p]
  const r = pickBackup()
  assert.equal(r.ok, true, '前置：备份文件应能被 pickBackup 认出：' + r.error)
  return r
}

// 逐项验证四个「吞错」写入点：config / ledger / window / timer。
// 它们各自只返回 false / ok:false，不抛错 —— 只有 applyBackup 判返回值才能发现写失败。
const CASES = [
  { key: 'config', label: '挂件设置', data: { config: { scale: 1.5 } } },
  { key: 'ledger', label: '账本', data: { ledger: { history: { '2026-09-24': 1.23 } } } },
  { key: 'window', label: '窗口位置', data: { window: { hAnchor: 'left', hDist: 10, vAnchor: 'top', vDist: 20 } } },
  { key: 'timer', label: '计时', data: { timer: { mode: 'up', running: true } } },
]

test('applyBackup：写成功时该项进 applied', () => {
  for (const c of CASES) {
    stage(c.data)
    const r = applyBackup({ [c.key]: true })
    assert.equal(r.ok, true, c.key + '：成功路径 ok 应为 true（' + r.error + '）')
    assert.deepEqual(r.applied, [c.key], c.key + '：成功路径应进 applied')
    assert.deepEqual(r.errors, [], c.key + '：成功路径不该有错误')
  }
})

test('applyBackup：写失败进 errors 而不是 applied（不能假报恢复成功）', () => {
  for (const c of CASES) {
    stage(c.data)
    failWrite = true
    let r
    try { r = applyBackup({ [c.key]: true }) } finally { failWrite = false }
    assert.equal(r.ok, false, c.key + '：写失败时 ok 必须为 false')
    assert.deepEqual(r.applied, [], c.key + '：写失败不能记进 applied')
    assert.equal(r.errors.length, 1, c.key + '：写失败必须报一条错误')
    assert.match(r.errors[0], new RegExp(c.label), c.key + '：错误文案要指出是哪一项')
    assert.match(r.error, /写入失败/, c.key + '：顶层 error 要带上失败说明')
  }
})

test('applyBackup：未勾选的项不写、备份里缺的项记 skipped', () => {
  stage({ config: { scale: 1.5 }, window: { hAnchor: 'left', hDist: 1, vAnchor: 'top', vDist: 1 } })
  // 只勾了 config：window 即使备份里有也不该动它
  const r1 = applyBackup({ config: true, window: false })
  assert.deepEqual(r1.applied, ['config'])
  assert.deepEqual(r1.skipped, [], '未勾选不算 skipped（skipped 专指「勾了但备份里没有」）')

  // 勾了 timer 但备份里没有 → skipped，且不能报错
  stage({ config: { scale: 1.5 } })
  const r2 = applyBackup({ config: true, timer: true })
  assert.deepEqual(r2.applied, ['config'])
  assert.deepEqual(r2.skipped, ['timer'])
  assert.deepEqual(r2.errors, [])
})

test('applyBackup：凭据密码错时报错且不写任何东西（AES-GCM 拦下）', () => {
  const enc = _encryptSecrets({ apiKey: 'sk-secret', platformToken: '' }, 'right-pw')
  stage({ secretsEnc: enc })
  const r = applyBackup({ secrets: true, password: 'wrong-pw' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.applied, [])
  assert.match(r.errors[0], /凭据/)
  // 恢复失败不能把已有凭据清空
  assert.equal(vault.has('whale:secrets'), false)
})

test('applyBackup：没选备份文件就直接拒绝', () => {
  clearPending()
  const r = applyBackup({ config: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /请先选择备份文件/)
})
