/*
 * dsh-backup.js 的回归测试（node --test，零依赖）—— 计划书 §6.2 E1。
 *
 * 这里盯的是**几个静默失效型的约定**（错了不会报错、只会悄悄失效）：
 *   1. **白名单**：快照绝不能把 `.credentials.yaml` 之类备走。测试里真的往 dsh 目录
 *      放一个 `.credentials.yaml`，然后断言快照目录里**没有**它 —— 用黑名单写法
 *      （「排除 .credentials」）时，将来 dsh 新增别的敏感文件就会静默被备走。
 *   2. **多文件 sha256 校验**：还原前必须校验快照自身完好。篡改快照内容后还原**必须失败**，
 *      V2 的教训就是「dsh 不会告诉你写坏了」，只能自己校验。
 *   3. **整文件覆盖语义**：还原后文件内容必须与建快照时**逐字一致**（V4：删行/补行都不行，
 *      热重载是单向的，只有让文件真正回到改动前才有效）。
 *   4. **目录穿越防护**：dirName 传 `../xxx` 必须被拒（manifest 是用户可以手改的）。
 *   5. **缺文件是预期分支**：本机 home 层 `cordis.patch.yml` 就不存在，建快照要能成功
 *      （记 ok:false），还原时跳过它而**不是**创建一个空文件。
 *
 * dsh-backup.js 会 require util.js（纯 fs/os/path，不碰 utools）与 log.js，
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
const bak = require('../public/preload/lib/dsh-backup.js')

// ── 夹具：造一个假的 $DSH_HOME 并把它喂给模块 ──
// 模块通过 homeDir({env:'DSH_HOME'}) 定位，所以覆盖 process.env.DSH_HOME 即可
let tmpRoot = ''
const ENV_KEY = 'DSH_HOME'
const ENV_BAK = process.env[ENV_KEY]

function makeHome(files = {}) {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dshbak-'))
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
test.afterEach(() => cleanup())

// 一套标准的三个受管文件（对应 PROFILE_FILES + HOME_FILES）
const PATCH_V1 = [
  '- id: cost-meter',
  '  disabled: true',
  '',
].join('\n')
const PKG_V1 = JSON.stringify({ name: 'web', dependencies: { 'dsh-better-sidebar': '^1.0.0' } }, null, 2)
const SETTINGS_V1 = 'remote-web-ui:\n  lanBind: false\n'

function fullHome(extra = {}) {
  return Object.assign({
    'profiles/web/cordis.patch.yml': PATCH_V1,
    'profiles/web/package.json': PKG_V1,
    'settings.yaml': SETTINGS_V1,
  }, extra)
}

// ── ① 建快照 ──
test('createSnapshot：三个受管文件都备到，manifest 记 sha256 与字节数', () => {
  makeHome(fullHome())
  const r = bak.createSnapshot({ profile: 'web', reason: 'manual' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.missing, 0)
  assert.equal(r.files.filter((f) => f.ok).length, 3)

  // manifest 落在快照目录里，且能被 listSnapshots 读回
  const m = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'))
  assert.equal(m.kind, 'whale-dsh-backup')
  assert.equal(m.profile, 'web')
  assert.equal(m.reason, 'manual')
  const patch = m.files.find((f) => f.rel === 'profiles/web/cordis.patch.yml')
  assert.equal(patch.ok, true)
  assert.equal(patch.sha256, bak._sha256(PATCH_V1))
  assert.equal(patch.bytes, Buffer.byteLength(PATCH_V1, 'utf8'))
})

test('createSnapshot：白名单 —— .credentials.yaml 与其它无关文件绝不进快照', () => {
  makeHome(fullHome({
    // dsh 目录下真实存在、且绝对不该被备走的敏感文件
    '.credentials.yaml': 'DEEPSEEK_API_KEY: sk-should-never-be-backup\n',
    'profiles/web/.dsh-market/log.ndjson': '{"secret":"x"}\n',
    'profiles/other/cordis.patch.yml': '- id: other\n',
  }))
  const r = bak.createSnapshot({ profile: 'web' })
  assert.equal(r.ok, true, r.error)

  // 快照目录里只允许出现 manifest 与三个白名单文件的扁平副本
  const got = fs.readdirSync(r.dir).sort()
  assert.deepEqual(got, [
    'manifest.json',
    'profiles__web__cordis.patch.yml',
    'profiles__web__package.json',
    'settings.yaml',
  ])
  // 再确认一次内容层面没夹带凭据
  const blob = got.map((n) => fs.readFileSync(path.join(r.dir, n), 'utf8')).join('\n')
  assert.equal(blob.includes('sk-should-never-be-backup'), false)
  assert.equal(blob.includes('profiles/other'), false)
})

test('createSnapshot：受管文件缺失是预期分支（记 ok:false），不算失败', () => {
  // 只放 patch，故意不放 package.json / settings.yaml
  makeHome({ 'profiles/web/cordis.patch.yml': PATCH_V1 })
  const r = bak.createSnapshot({ profile: 'web' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.missing, 2)
  assert.equal(r.files.filter((f) => f.ok).length, 1)
  assert.equal(r.files.filter((f) => f.ok === false).length, 2)
})

test('createSnapshot：profile 目录不存在时仍成功，三个文件全记 missing', () => {
  // 这是「配了 profile 但那个 profile 还没建」的真实场景（用户改了 profile 名）。
  // 必须成功返回而不是失败 —— 否则 E2 的「写入前先备份」会在最需要备份时挡路。
  makeHome({ 'settings.yaml': SETTINGS_V1 })
  const r = bak.createSnapshot({ profile: 'not-a-real-profile' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.missing, 2) // 两个 profile 文件缺失
  assert.equal(r.files.filter((f) => f.ok).length, 1) // settings.yaml 在
})

test('backupRoot 落空时：列表返回空数组、还原与删除明确失败（都不抛异常）', () => {
  // 直接在同一进程里无法让 homeDir 落空（~/.dsh 真实存在会兜底），
  // 故改从**模块的契约**入手：这几个入口在拿不到根目录时都必须「明确失败或给空」，
  // 而不是抛异常把调用方（E2/E3）带崩。
  makeHome(fullHome())
  const root = bak.backupRoot()
  assert.equal(typeof root, 'string')
  // 用一个不存在的快照名走一遍失败路径
  const r = bak.restoreSnapshot({ dirName: 'zzz-not-exist' })
  assert.equal(r.ok, false)
  assert.equal(typeof r.error, 'string')
  // 列表在根目录不存在时是空数组
  assert.deepEqual(bak.listSnapshots().length, 0)
})

test('createSnapshot：同一秒内连建两份不撞名（毫秒后缀兜底）', () => {
  makeHome(fullHome())
  const a = bak.createSnapshot({ profile: 'web' })
  const b = bak.createSnapshot({ profile: 'web' })
  assert.equal(a.ok, true, a.error)
  assert.equal(b.ok, true, b.error)
  assert.notEqual(a.dirName, b.dirName)
  assert.equal(fs.existsSync(a.dir), true)
  assert.equal(fs.existsSync(b.dir), true)
})

// ── ② 列表 ──
test('listSnapshots：按时间倒序，损坏/异类目录被跳过而不是让整表失败', () => {
  makeHome(fullHome())
  const a = bak.createSnapshot({ profile: 'web', reason: 'first' })
  // 手工插一个「不是本插件建的」目录，以及一个 manifest 坏掉的目录
  fs.mkdirSync(path.join(bak.backupRoot(), 'garbage-dir'), { recursive: true })
  fs.mkdirSync(path.join(bak.backupRoot(), 'broken'), { recursive: true })
  fs.writeFileSync(path.join(bak.backupRoot(), 'broken', 'manifest.json'), '{not json')

  const list = bak.listSnapshots()
  assert.equal(list.length, 1)
  assert.equal(list[0].dirName, a.dirName)
  assert.equal(list[0].reason, 'first')
})

test('listSnapshots：没有快照根目录时返回空数组（不抛错）', () => {
  makeHome(fullHome())
  assert.deepEqual(bak.listSnapshots(), [])
})

// ── ③ 还原：整文件覆盖 + sha256 校验 ──
test('restoreSnapshot：把被改过的文件整文件还原成建快照时的内容', () => {
  makeHome(fullHome())
  const snap = bak.createSnapshot({ profile: 'web' })
  assert.equal(snap.ok, true, snap.error)

  // 模拟 E2 的写入：往 patch 里追加一条 disabled（行级改动）
  const patchAbs = path.join(tmpRoot, 'profiles/web/cordis.patch.yml')
  const written = PATCH_V1 + '- id: some-third-party-plugin\n  disabled: true\n'
  fs.writeFileSync(patchAbs, written)
  assert.equal(fs.readFileSync(patchAbs, 'utf8'), written)

  const r = bak.restoreSnapshot({ dirName: snap.dirName })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.written.length, 3)
  // 逐字回到改动前 —— 不是「删掉那一行」而是整文件一致
  assert.equal(fs.readFileSync(patchAbs, 'utf8'), PATCH_V1)
})

test('restoreSnapshot：dryRun 只报告计划、不动磁盘', () => {
  makeHome(fullHome())
  const snap = bak.createSnapshot({ profile: 'web' })
  const patchAbs = path.join(tmpRoot, 'profiles/web/cordis.patch.yml')
  const after = PATCH_V1 + '- id: extra\n  disabled: true\n'
  fs.writeFileSync(patchAbs, after)

  const r = bak.restoreSnapshot({ dirName: snap.dirName, dryRun: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.dryRun, true)
  assert.equal(r.plan.length, 3)
  assert.equal(fs.readFileSync(patchAbs, 'utf8'), after) // 没被动过
})

test('restoreSnapshot：快照被篡改时拒绝还原（sha256 不符）', () => {
  makeHome(fullHome())
  const snap = bak.createSnapshot({ profile: 'web' })
  // 篡改快照内的文件内容（模拟磁盘损坏 / 人为改动）
  fs.writeFileSync(path.join(snap.dir, 'profiles__web__cordis.patch.yml'), '- id: tampered\n')

  const r = bak.restoreSnapshot({ dirName: snap.dirName })
  assert.equal(r.ok, false)
  assert.match(r.error, /快照已损坏/)
})

test('restoreSnapshot：建快照时不存在的文件，还原时跳过（不创建空文件）', () => {
  makeHome({ 'profiles/web/cordis.patch.yml': PATCH_V1 })
  const snap = bak.createSnapshot({ profile: 'web' })
  assert.equal(snap.missing, 2)

  const r = bak.restoreSnapshot({ dirName: snap.dirName })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.written, ['profiles/web/cordis.patch.yml'])
  assert.equal(r.skipped.length, 2)
  // 关键：缺失的那两个文件不该被「还原」成空文件
  assert.equal(fs.existsSync(path.join(tmpRoot, 'profiles/web/package.json')), false)
  assert.equal(fs.existsSync(path.join(tmpRoot, 'settings.yaml')), false)
})

test('restoreSnapshot：拒绝目录穿越的 dirName', () => {
  makeHome(fullHome())
  const snap = bak.createSnapshot({ profile: 'web' })
  for (const bad of ['../' + snap.dirName, '..', '.', 'a/b', '']) {
    const r = bak.restoreSnapshot({ dirName: bad })
    assert.equal(r.ok, false, 'dirName=' + JSON.stringify(bad) + ' 应该被拒')
  }
})

test('restoreSnapshot：指定的快照不存在时明确失败', () => {
  makeHome(fullHome())
  bak.createSnapshot({ profile: 'web' })
  const r = bak.restoreSnapshot({ dirName: '20200101-000000' })
  assert.equal(r.ok, false)
  assert.match(r.error, /读不到该快照的清单/)
})

// ── ④ 清理 ──
test('pruneSnapshots：只留 keep 份，最旧的先删', () => {
  makeHome(fullHome())
  const made = []
  for (let i = 0; i < 4; i++) {
    made.push(bak.createSnapshot({ profile: 'web', reason: 'r' + i }))
  }
  // 目录名带毫秒后缀时排序靠 at 字段；这里人为把 at 改成递增顺序，确保「最旧」判定稳定
  made.forEach((s, i) => {
    const mp = path.join(s.dir, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'))
    m.at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    fs.writeFileSync(mp, JSON.stringify(m))
  })

  const removed = bak.pruneSnapshots({ keep: 2 })
  assert.equal(removed.length, 2)
  const left = bak.listSnapshots()
  assert.equal(left.length, 2)
  // 留下的是最新那两份（r3、r2）
  assert.deepEqual(left.map((s) => s.reason), ['r3', 'r2'])
})

test('pruneSnapshots：份数未超上限时什么都不删', () => {
  makeHome(fullHome())
  bak.createSnapshot({ profile: 'web' })
  assert.deepEqual(bak.pruneSnapshots({ keep: 5 }), [])
  assert.equal(bak.listSnapshots().length, 1)
})

test('removeSnapshot：删指定的一份；名字不合法或不存在时明确失败', () => {
  makeHome(fullHome())
  const a = bak.createSnapshot({ profile: 'web' })
  const b = bak.createSnapshot({ profile: 'web' })

  assert.equal(bak.removeSnapshot(a.dirName).ok, true)
  assert.equal(fs.existsSync(a.dir), false)
  assert.equal(bak.listSnapshots().length, 1)
  assert.equal(bak.listSnapshots()[0].dirName, b.dirName)

  assert.equal(bak.removeSnapshot(a.dirName).ok, false) // 已删过
  assert.equal(bak.removeSnapshot('../etc').ok, false)
  assert.equal(bak.removeSnapshot('').ok, false)
})

// ── ⑤ 路径与纯函数 ──
test('targetFiles：三个受管文件的相对路径固定，与 profile 名联动', () => {
  makeHome(fullHome())
  const rels = bak.targetFiles('acp').map((t) => t.rel)
  assert.deepEqual(rels, [
    'profiles/acp/cordis.patch.yml',
    'profiles/acp/package.json',
    'settings.yaml',
  ])
})

test('backupRoot：落在 $DSH_HOME/whale-dsh-backup 下（与 dsh 配置同目录，用户找得到）', () => {
  const home = makeHome(fullHome())
  assert.equal(bak.backupRoot(), path.join(home, 'whale-dsh-backup'))
})

test('_stampOf：目录名形如 YYYYMMDD-HHMMSS，字典序 = 时间序', () => {
  const s1 = bak._stampOf(new Date(2026, 8, 22, 9, 5, 3))
  const s2 = bak._stampOf(new Date(2026, 8, 22, 14, 30, 0))
  assert.equal(s1, '20260922-090503')
  assert.equal(s2, '20260922-143000')
  assert.equal(s1 < s2, true)
})
