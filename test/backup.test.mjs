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
import test, { after } from 'node:test'
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
const bubbles = require('../public/preload/lib/bubbles.js')

const { _encryptSecrets, _decryptSecrets, applyBackup, pickBackup, clearPending } = backup

// 启动即清空：bubbles 的清单是模块级缓存，跨用例残留会让「预览该为 false」的判定串味
bubbles.clearAll()

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
// 本次的备份样本目录跑完即废。不删的话每轮 npm test 在 %TEMP% 里攒一个 whale-backup-*
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })
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

test('applyBackup：专注统计恢复要连会话明细一起写回，不能只恢复按天汇总', () => {
  store.delete('whale:focus')
  stage({
    focus: {
      days: { '2026-10-26': { r: 2, m: 50 } },
      sessions: [
        { d: '2026-10-26', t: 1000, m: 25, todoId: 'a', todoText: '周报' },
        { d: '2026-10-26', t: 2000, m: 25 },
      ],
    },
  })
  const r = applyBackup({ focus: true })
  assert.deepEqual(r.applied, ['focus'])
  // 读回真实落盘结果：明细缺了，恢复后「专注记录」列表就是空的（按天柱状图还在，问题很隐蔽）。
  // 老备份只有 {d,t,m}，落盘时按 v2 补齐（会话是唯一事实源，天表由它派生）
  const back = store.get('whale:focus')
  assert.equal(back.v, 2)
  assert.equal(back.sessions.length, 2)
  assert.equal(back.sessions[0].todoText, '周报')
  assert.ok(back.sessions.every((s) => s.id && s.k === 'down'))
  assert.deepEqual(back.days, { '2026-10-26': { r: 2, m: 50 } })
  store.delete('whale:focus')
})

test('applyBackup：只带按天汇总的老备份（早期版本不记明细）也能恢复', () => {
  store.delete('whale:focus')
  stage({ focus: { days: { '2026-10-01': { r: 3, m: 75 } }, sessions: [] } })
  const r = applyBackup({ focus: true })
  assert.deepEqual(r.applied, ['focus'])
  assert.equal(store.get('whale:focus').v, 2)
  // 没有明细可派生 → 老聚合原样保留，别让恢复把历史柱状图抹平
  assert.deepEqual(store.get('whale:focus').days, { '2026-10-01': { r: 3, m: 75 } })
  store.delete('whale:focus')
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

test('applyBackup：恢复凭据必须把 SMTP（notifyMail）一并写回，不能只恢复 API Key', () => {
  // 导出时 readSecrets() 含 notifyMail，已加密进备份；若恢复时漏传，writeSecrets 会沿用现值，
  // 换机恢复后邮件密码就丢了 —— 这正是此前存在、现已修复的 bug
  const full = {
    apiKey: 'sk-new', platformToken: 'tok-new', models: { moonshot: 'sk-m' },
    notifyMail: { mailHost: 'smtp.qq.com', mailPort: 465, mailSecure: true, mailUser: 'a@qq.com', mailPass: 'auth-code' },
  }
  stage({ secretsEnc: _encryptSecrets(full, 'pw123456') })
  const r = applyBackup({ secrets: true, password: 'pw123456' })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.applied, ['secrets'])
  const saved = vault.get('whale:secrets')
  assert.equal(saved.apiKey, 'sk-new')
  assert.equal(saved.notifyMail.mailPass, 'auth-code')
  assert.equal(saved.notifyMail.mailUser, 'a@qq.com')
})

test('applyBackup：老备份无 notifyMail 时沿用现值，不清空用户已存的 SMTP 密码', () => {
  // 先放一份现值，模拟用户已有邮件配置
  vault.set('whale:secrets', {
    apiKey: 'old', platformToken: '', models: {},
    notifyMail: { mailHost: 'h', mailPort: 465, mailSecure: true, mailUser: 'u', mailPass: 'keep-me' },
  })
  // 老备份只带 apiKey / platformToken（无 models、无 notifyMail）
  stage({ secretsEnc: _encryptSecrets({ apiKey: 'sk-old', platformToken: '' }, 'pw123456') })
  const r = applyBackup({ secrets: true, password: 'pw123456' })
  assert.equal(r.ok, true, r.error)
  const saved = vault.get('whale:secrets')
  assert.equal(saved.apiKey, 'sk-old')
  assert.equal(saved.notifyMail.mailPass, 'keep-me', '老备份缺 notifyMail 时必须沿用现值')
})

test('applyBackup：节假日表按校验后写回并进 applied；脏数据记 skipped 不报错', () => {
  const good = { fetchedAt: 1700000000000, dates: ['2026-10-01', '2026-10-02'], years: ['2026'], sources: { 2026: 0 } }
  stage({ holidays: good })
  const r1 = applyBackup({ holidays: true })
  assert.equal(r1.ok, true, r1.error)
  assert.deepEqual(r1.applied, ['holidays'])
  assert.deepEqual(store.get('whale:cnHolidays').dates, ['2026-10-01', '2026-10-02'])

  // dates 不是非空数组 → 视为「这份备份没带节假日表」记 skipped，而非报错
  stage({ holidays: { dates: [] } })
  const r2 = applyBackup({ holidays: true })
  assert.deepEqual(r2.applied, [])
  assert.deepEqual(r2.skipped, ['holidays'])
  assert.deepEqual(r2.errors, [])

  // dates 有元素但全部非法（结构像、内容脏）→ restore 返回 false → 记 error（不假装恢复成功）
  stage({ holidays: { dates: ['not-a-date'] } })
  const r3 = applyBackup({ holidays: true })
  assert.deepEqual(r3.applied, [])
  assert.equal(r3.errors.length, 1)
  assert.match(r3.errors[0], /节假日表/)
})

test('applyBackup：没选备份文件就直接拒绝', () => {
  clearPending()
  const r = applyBackup({ config: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /请先选择备份文件/)
})

// ── 按压气泡的配图（whale:bubbles）：恢复是「先清后写」，语义 = 回到备份时的样子 ──
// 按压气泡的数据分散两处：文案 / 队列 / 开关在 config.bubble（跟着 config 项进出），配图在
// whale:bubbles（跟着 bubbles 项进出）。这里专测配图那条链路 —— 它是二进制，备份里以 base64
// 内嵌，恢复时最容易出「只补一半」「撞 8 张上限」这类静默缺图。

// 造一张最小的「合法」PNG 字节（内容不校验，只要非空且 <= 5MB）
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
function seedBubble(name, times) {
  for (let i = 0; i < (times || 1); i++) {
    const r = bubbles.importBuffer(name, 'png', PNG, null, 0)
    assert.equal(r.ok, true, '前置：写入气泡图应成功：' + r.error)
  }
}

test('applyBackup：气泡图「先清后写」，恢复到与备份一致（不残留旧图）', () => {
  bubbles.clearAll()
  seedBubble('old.png', 3) // 现有 3 张旧图
  const before = bubbles.exportItems()
  assert.equal(before.length, 3, '前置：应有 3 张旧图')

  // 备份里只有 1 张（base64 内嵌）
  stage({
    bubbles: [{ name: 'new.png', ext: 'png', at: 123, data: PNG.toString('base64'), thumb: '' }],
  })
  const r = applyBackup({ bubbles: true })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.applied, ['bubbles'])
  const after = bubbles.exportItems()
  assert.equal(after.length, 1, '恢复语义是「回到备份时的样子」，旧图必须被清掉')
  assert.equal(after[0].name, 'new.png')
  assert.equal(after[0].at, 123, '导入时间应沿用备份里的值')
})

test('applyBackup：气泡图备份里没有该键 → 记 skipped，不动现有图', () => {
  bubbles.clearAll()
  seedBubble('keep.png', 2)
  stage({ config: { scale: 1.5 } })
  const r = applyBackup({ bubbles: true })
  assert.deepEqual(r.applied, [])
  assert.deepEqual(r.skipped, ['bubbles'])
  assert.deepEqual(r.errors, [])
  assert.equal(bubbles.exportItems().length, 2, '备份没带配图时不该清掉现有图')
})

test('applyBackup：气泡图数据全坏 → 记 error，不假报成功', () => {
  bubbles.clearAll()
  stage({ bubbles: [{ name: 'bad.xyz', ext: 'xyz', at: 0, data: PNG.toString('base64') }] })
  const r = applyBackup({ bubbles: true })
  assert.equal(r.ok, false)
  assert.deepEqual(r.applied, [])
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /气泡图/)
})

test('applyBackup：密码错时其他已勾选项一个字节都不写，且 pending 保留可重试', () => {
  // 预检失败必须整体放弃：早先凭据分支排在最后，密码错时 config / 账本已经落盘，
  // 用户看到「恢复失败」却发现设置已经被改了一半；而且 pending 被清空，只能重新选文件
  store.delete('whale:config')
  store.delete('whale:ledger')
  const vaultBefore = vault.get('whale:secrets')
  stage({
    config: { scale: 1.75 },
    ledger: { history: { '2026-11-01': 2.5 } },
    secretsEnc: _encryptSecrets({ apiKey: 'sk-x', platformToken: '' }, 'right-pw'),
  })
  const r = applyBackup({ config: true, ledger: true, secrets: true, password: 'wrong-pw' })
  assert.equal(r.ok, false)
  assert.equal(r.precheck, true)
  assert.deepEqual(r.applied, [])
  assert.match(r.errors[0], /凭据/)
  assert.equal(store.has('whale:config'), false, '预检失败时挂件设置不该被写')
  assert.equal(store.has('whale:ledger'), false, '预检失败时账本不该被写')
  assert.deepEqual(vault.get('whale:secrets'), vaultBefore, '预检失败时凭据也不该被覆盖')

  // pending 没被消耗：改对密码再点一次就能恢复，不必重新选一遍文件
  const r2 = applyBackup({ config: true, ledger: true, secrets: true, password: 'right-pw' })
  assert.equal(r2.ok, true, r2.error)
  assert.deepEqual(r2.applied, ['config', 'ledger', 'secrets'])
  assert.equal(vault.get('whale:secrets').apiKey, 'sk-x', '第二次（密码正确）应真的写进凭据')
  store.delete('whale:config')
  store.delete('whale:ledger')
})

test('applyBackup：气泡图全坏时不清空现有图（预检拦在 clearAll 之前）', () => {
  bubbles.clearAll()
  seedBubble('keep.png', 2)
  store.delete('whale:config')
  stage({
    config: { scale: 1.5 },
    bubbles: [{ name: 'bad.xyz', ext: 'xyz', at: 0, data: PNG.toString('base64') }],
  })
  const r = applyBackup({ config: true, bubbles: true })
  assert.equal(r.ok, false)
  assert.equal(r.precheck, true)
  assert.deepEqual(r.applied, [])
  assert.equal(bubbles.exportItems().length, 2, '备份里的图全不合法时，现有图不能被清空')
  assert.equal(store.has('whale:config'), false, '预检失败时同一次勾的挂件设置也不该写')
})

test('applyBackup：气泡图部分不合法时，仍然恢复可写的那几张', () => {
  bubbles.clearAll()
  stage({
    bubbles: [
      { name: 'ok.png', ext: 'png', at: 1, data: PNG.toString('base64') },
      { name: 'bad.xyz', ext: 'xyz', at: 2, data: PNG.toString('base64') },
    ],
  })
  const r = applyBackup({ bubbles: true })
  // 可写的照常写进去，但「少一张」不能报成已恢复（见下一条用例）
  assert.equal(r.ok, true, r.error)
  assert.equal(r.errors.length, 1)
  const list = bubbles.exportItems()
  assert.equal(list.length, 1, '坏的那张跳过，好的那张照常恢复')
  assert.equal(list[0].name, 'ok.png')
})

test('pickBackup：has.bubbles 只在备份确实带图时为 true', () => {
  stage({ bubbles: [{ name: 'a.png', ext: 'png', at: 0, data: PNG.toString('base64') }] })
  assert.equal(pickBackup().has.bubbles, true, '带图 → has.bubbles = true')

  stage({ bubbles: [] })
  assert.equal(pickBackup().has.bubbles, false, '空数组 → false')

  stage({ config: { scale: 1 } })
  assert.equal(pickBackup().has.bubbles, false, '没有该键 → false')
})

// 文件选择器允许任意 *.json，误选别的应用的备份不能静默覆盖现有数据
function fromRaw(obj) {
  const p = path.join(tmpDir, 'r' + (++seq) + '.json')
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8')
  globalThis.utools.showOpenDialog = () => [p]
  return pickBackup()
}

// 预览必须与恢复同一把尺子：预览说有、恢复时却被 skip，等于让用户勾了个寂寞
test('pickBackup：has 与 applyBackup 的判据一致（勾得动就写得进）', () => {
  // 窗口位置：对象在但锚点不合法 —— 恢复侧走 validAnchor，会 skip
  const bad = fromRaw({
    kind: 'balance-whale-widget-backup',
    data: { window: { hAnchor: 'middle', hDist: 10, vAnchor: 'top', vDist: 10 } },
  })
  assert.equal(bad.has.window, false, '锚点不合法时不该让用户勾选')
  assert.deepEqual(applyBackup({ window: true }).skipped, ['window'], '对照：恢复侧确实会 skip')

  // 气泡图：数组非空但全部不合法 —— 恢复侧预检会整体放弃
  const badBubble = fromRaw({
    kind: 'balance-whale-widget-backup',
    data: { bubbles: [{ name: 'x.xyz', ext: 'xyz', data: PNG.toString('base64') }] },
  })
  assert.equal(badBubble.has.bubbles, false, '一张都写不进去时不该让用户勾选')

  // 待办与专注：恢复侧见到 items 数组 / days 对象就写（哪怕为空），预览不能比它更严，
  // 否则「备份里是空清单」会被说成「没有这一项」，用户无法主动用它清空现有清单
  const emptyList = fromRaw({ kind: 'balance-whale-widget-backup', data: { todo: { items: [] }, focus: { days: {} } } })
  assert.equal(emptyList.has.todo, true)
  assert.equal(emptyList.has.focus, true)
})

// 含加密凭据的备份：界面要据此提示「必须填密码」。原先导入侧连密码输入框都不渲染，
// 用户勾上「凭据」点恢复 → 预检整体失败，其余勾选项一项也没写
test('pickBackup：含凭据时给出 noPasswordHint，否则不给', () => {
  const withSecret = fromRaw({
    kind: 'balance-whale-widget-backup',
    data: { secretsEnc: { algo: 'aes-256-gcm', salt: 'AA==', iv: 'AA==', tag: 'AA==', data: 'AA==' } },
  })
  assert.equal(withSecret.noPasswordHint, true)
  assert.equal(fromRaw({ kind: 'balance-whale-widget-backup', data: { config: { a: 1 } } }).noPasswordHint, false)
})

// 气泡图只写进去一部分时，不能进 applied —— 界面会显示大字「已恢复」，
// 小字报错没人看。必须落到 errors，让界面改口径为「部分恢复」
test('applyBackup：气泡图部分写入记 errors，不算 applied', () => {
  bubbles.clearAll()
  const r = fromRaw({
    kind: 'balance-whale-widget-backup',
    data: { bubbles: [
      { name: 'a.png', ext: 'png', data: PNG.toString('base64') },
      { name: 'b.xyz', ext: 'xyz', data: PNG.toString('base64') },
    ] },
  })
  assert.equal(r.has.bubbles, true, '有一张能写就不该禁掉整项')
  const out = applyBackup({ bubbles: true })
  assert.equal(out.applied.indexOf('bubbles'), -1, '少一张就不是「已恢复」')
  assert.ok(out.errors.some((e) => e.indexOf('只写入了 1/2') >= 0), '要告诉用户写进去几张')
})

test('pickBackup：kind 对得上就认（早期导出没有 app 字段也算本插件的）', () => {
  const r = fromRaw({ kind: 'balance-whale-widget-backup', data: { config: { scale: 1 } } })
  assert.equal(r.ok, true)
  assert.equal(r.noMark, false, '有 kind → 来源明确，不要求二次确认')
})

test('pickBackup：kind 不符直接拒绝，不把别人的数据当备份', () => {
  const r = fromRaw({ kind: 'some-other-app-backup', data: { config: { scale: 1 } } })
  assert.equal(r.ok, false)
  assert.match(r.error, /不是本插件/)
})

test('pickBackup：app 明确是别的应用时拒绝并点名', () => {
  const r = fromRaw({ app: 'other-plugin', data: { config: { scale: 1 } } })
  assert.equal(r.ok, false)
  assert.match(r.error, /other-plugin/)
})

test('pickBackup：既无 kind 也无 app → 放行但标记 noMark，交给界面二次确认', () => {
  const r = fromRaw({ data: { config: { scale: 1 } } })
  assert.equal(r.ok, true, '来源不明的老备份不能一刀切拒掉')
  assert.equal(r.noMark, true)
})

test('pickBackup：kind 为 null 也算「没有 kind」，不能因此判成别的插件', () => {
  const r = fromRaw({ kind: null, data: { config: { scale: 1 } } })
  assert.equal(r.ok, true, '手改文件留下的 null 不该把能用的备份判死')
  assert.equal(r.noMark, true)
})

test('pickBackup：app 是空串不算「来自别的应用」，按来源不明放行', () => {
  const r = fromRaw({ app: '', data: { config: { scale: 1 } } })
  assert.equal(r.ok, true)
  assert.equal(r.noMark, true)
})

test('pickBackup：kind 对上时不再管 app（早期导出可能把 app 写错）', () => {
  const r = fromRaw({ kind: 'balance-whale-widget-backup', app: 'oops', data: { config: { scale: 1 } } })
  assert.equal(r.ok, true)
  assert.equal(r.noMark, false)
})

test('applyBackup：窗口位置写入后要回读存储核对（readAnchor 带缓存，不能拿缓存自证）', () => {
  stage({ window: { hAnchor: 'left', hDist: 10, vAnchor: 'top', vDist: 20 } })
  const r = applyBackup({ window: true })
  assert.equal(r.ok, true, r.errors && r.errors.join('；'))
  assert.deepEqual(store.get('whale:window'), { hAnchor: 'left', hDist: 10, vAnchor: 'top', vDist: 20 })
})
