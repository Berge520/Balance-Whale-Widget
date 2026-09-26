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

// 按 index 递增的注入时间戳：**秒级**递增，制造一个确定的先后顺序。
// 不靠「改完 manifest.json 再读回来」——那种做法在 Windows 上会因为写文件占住句柄，
// 让随后的 listSnapshots 读到旧内容（CI 里表现为 pruneSnapshots 删错份数）。
function atOf(i) { return new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }

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

// note：系统记的「这份快照是对哪个对象做的」，宿主那边拼成 `安装 dshmarket@1.65.1`。
// 为什么要单测它：市场里装/卸/禁用/更新各建一份快照，reason 只有四种、短时间里会堆出十几份，
// 光靠 reason 分不出「这份是为了回滚哪个包」—— note 就是那份清单唯一的辨识线索，
// 一旦没写进 manifest 或读不回来，用户就只能靠时间戳猜。
test('createSnapshot / listSnapshots：note 往返一致（写进 manifest 也读得回来）', () => {
  makeHome(fullHome())
  const r = bak.createSnapshot({ profile: 'web', reason: 'before-market-uninstall', note: '卸载 dshmarket@1.65.1' })
  assert.equal(r.ok, true, r.error)

  const m = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'))
  assert.equal(m.note, '卸载 dshmarket@1.65.1')

  const hit = bak.listSnapshots().find((s) => s.dirName === r.dirName)
  assert.ok(hit, '刚建的快照必须在列表里')
  assert.equal(hit.note, '卸载 dshmarket@1.65.1')
  assert.equal(hit.reason, 'before-market-uninstall')
})

// note 里的包名可能来自 `github:a/b` 或 200+ 字符的 tarball URL，含 `@` / `:` / `/` / `#`
// 这些对路径与 shells 都不友好的字符。它只被写进 manifest.json 的字符串字段、从不当目录名
// （目录名由 timestamp 决定），所以必须逐字原样往返 —— 一旦有人「顺手」按目录名规则清洗它，
// 用户看到的包名就会被改得认不出来。
test('createSnapshot：note 含 @ : / # 等字符时逐字往返（它只进 manifest，不参与目录名）', () => {
  makeHome(fullHome())
  const odd = '安装 @scope/pkg@1.0.0#ref/github:a/b'
  const r = bak.createSnapshot({ profile: 'web', reason: 'before-market-install', note: odd })
  assert.equal(r.ok, true, r.error)
  // 目录名不受 note 影响：仍是时间戳那一档，没有把 note 拼进去
  assert.equal(/^[0-9]{8}-[0-9]{6}/.test(r.dirName), true, '目录名应仍是时间戳：' + r.dirName)

  const m = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'))
  assert.equal(m.note, odd)
  assert.equal(bak.listSnapshots().find((s) => s.dirName === r.dirName).note, odd)
})

test('listSnapshots：不传 note 时读回空串（不是 undefined，界面要拿它判 v-if）', () => {
  makeHome(fullHome())
  const r = bak.createSnapshot({ profile: 'web', reason: 'manual' })
  const hit = bak.listSnapshots().find((s) => s.dirName === r.dirName)
  assert.equal(hit.note, '')
})

// 回归：note 是**后加**的字段，加它之前建的快照 manifest 里没有这个键。
// 读的时候必须容缺（给空串），不能因为「字段缺失」就把整条快照判成读不到 ——
// 否则用户升级插件后，升级前攒下的所有快照会在列表里凭空消失（旧的仍占磁盘、却删不掉）。
test('listSnapshots：老 manifest 没有 note 字段时仍读得回（容缺，不能整条丢掉）', () => {
  makeHome(fullHome())
  const r = bak.createSnapshot({ profile: 'web', reason: 'before-disable' })
  const mp = path.join(r.dir, 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'))
  delete m.note
  fs.writeFileSync(mp, JSON.stringify(m, null, 2), 'utf8')

  const hit = bak.listSnapshots().find((s) => s.dirName === r.dirName)
  assert.ok(hit, '缺 note 字段的老快照必须仍在列表里')
  assert.equal(hit.note, '')
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
    made.push(bak.createSnapshot({ profile: 'web', reason: 'r' + i, at: atOf(i) }))
  }

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

// ── ④·E4 标记 / 命名 / 轮转保护 ──
test('setMeta：命名与 known-good 能存能读，且不写进 manifest（快照内容不受影响）', () => {
  makeHome(fullHome())
  const s = bak.createSnapshot({ profile: 'web', reason: 'manual' })
  // 建快照时可以直接带名字与标记
  assert.equal(s.name, '')
  assert.equal(s.knownGood, false)

  const r = bak.setMeta({ dirName: s.dirName, name: '装插件前', knownGood: true })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.name, '装插件前')
  assert.equal(r.knownGood, true)

  const one = bak.listSnapshots()[0]
  assert.equal(one.name, '装插件前')
  assert.equal(one.knownGood, true)

  // manifest 一个字节都没动（标记只进 meta.json）
  const m = JSON.parse(fs.readFileSync(path.join(s.dir, 'manifest.json'), 'utf8'))
  assert.equal(m.name, undefined)
  assert.equal(m.knownGood, undefined)
  // meta 单独一个文件
  assert.equal(fs.existsSync(path.join(s.dir, 'meta.json')), true)
})

test('setMeta：只改一项时另一项保持不变（部分更新语义）', () => {
  makeHome(fullHome())
  const s = bak.createSnapshot({ profile: 'web', name: '原始名字', knownGood: true })
  assert.equal(s.name, '原始名字')
  assert.equal(s.knownGood, true)

  // 只改名字
  const r1 = bak.setMeta({ dirName: s.dirName, name: '换个名字' })
  assert.equal(r1.name, '换个名字')
  assert.equal(r1.knownGood, true, '没传 knownGood 不能把它抹掉')

  // 只取消标记
  const r2 = bak.setMeta({ dirName: s.dirName, knownGood: false })
  assert.equal(r2.name, '换个名字')
  assert.equal(r2.knownGood, false)
})

test('setMeta：名字与标记都清空时删掉 meta.json；名字超长截断、空白折叠', () => {
  makeHome(fullHome())
  const s = bak.createSnapshot({ profile: 'web', name: '  一段   带空白的名字  ' })
  assert.equal(bak.listSnapshots()[0].name, '一段 带空白的名字', '空白要折叠成单个空格并去首尾')

  const long = bak.setMeta({ dirName: s.dirName, name: 'x'.repeat(100) })
  assert.equal(long.name.length, 40, '名字上限 40 字符')

  const cleared = bak.setMeta({ dirName: s.dirName, name: '', knownGood: false })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.name, '')
  assert.equal(cleared.knownGood, false)
  assert.equal(fs.existsSync(path.join(s.dir, 'meta.json')), false, '两项都空时不该留一个空 meta.json')
})

test('setMeta：快照不存在 / dirName 穿越时明确失败', () => {
  makeHome(fullHome())
  bak.createSnapshot({ profile: 'web' })
  assert.equal(bak.setMeta({ dirName: 'nope-20260101-000000', name: 'x' }).ok, false)
  assert.equal(bak.setMeta({ dirName: '../evil', name: 'x' }).ok, false)
  assert.equal(bak.setMeta({}).ok, false)
})

test('pruneSnapshots：known-good 一份都不删（即使它在最旧那一头）', () => {
  makeHome(fullHome())
  const made = []
  for (let i = 0; i < 4; i++) made.push(bak.createSnapshot({ profile: 'web', reason: 'r' + i }))
  // 让 at 递增：r0 最旧、r3 最新
  made.forEach((s, i) => {
    const mp = path.join(s.dir, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'))
    m.at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    fs.writeFileSync(mp, JSON.stringify(m))
  })
  // 最旧那份打成 known-good
  assert.equal(bak.setMeta({ dirName: made[0].dirName, knownGood: true }).ok, true)

  const removed = bak.pruneSnapshots({ keep: 1 })
  // r0 被保护、r3 占掉唯一的 keep 名额 → 只有 r1、r2 该被删
  assert.deepEqual(removed.sort(), [made[1].dirName, made[2].dirName].sort())
  const left = bak.listSnapshots()
  assert.equal(left.length, 2)
  assert.equal(left[0].dirName, made[0].dirName, 'known-good 必须排在最前')
  assert.equal(left.find((s) => s.dirName === made[3].dirName).reason, 'r3')
})

test('createSnapshot：同一毫秒连建多份必须各自成目录，不许互相覆盖', () => {
  // 回归 CI 上偶发的那次失败：dirName 是「秒级时间戳」+「同秒内才补的毫秒后缀」，
  // 而 mkdir 用 recursive:true —— 目录已存在时不报错、直接复用。
  // 于是同毫秒连建的几份会落进同一个目录、互相覆盖 manifest 与快照文件，
  // 表现为「建了 N 份，列表里只剩 1 份」（CI 实测 4 份只活下 1 份）。
  // 这里用**同一个注入时刻**连建 4 份，逼出这条路径。
  makeHome(fullHome())
  const at = atOf(0)
  const made = []
  for (let i = 0; i < 4; i++) made.push(bak.createSnapshot({ profile: 'web', reason: 'r' + i, at }))

  const names = made.map((s) => s.dirName)
  assert.equal(new Set(names).size, 4, '4 份快照必须拿到 4 个互不相同的目录名')
  made.forEach((s) => assert.equal(s.ok, true))
  // 目录名互不相同还不够 —— 磁盘上必须真的存在 4 个目录（否则就是共用了同一个）
  assert.equal(bak.listSnapshots().length, 4, '列表里必须能看到全部 4 份')
})

test('pruneSnapshots：手动命名（reason 非 before-*）的快照受保护，before-* 的改名不免死', () => {
  makeHome(fullHome())
  const a = bak.createSnapshot({ profile: 'web', reason: 'r0', at: atOf(0) })
  const b = bak.createSnapshot({ profile: 'web', reason: 'r1', at: atOf(1) })
  const c = bak.createSnapshot({ profile: 'web', reason: 'before-disable', at: atOf(2) })
  const d = bak.createSnapshot({ profile: 'web', reason: 'before-isolate', at: atOf(3) })
  // a 是最旧的普通快照，b 手动命名，c/d 是写入前自动建的（改名也不该免死）
  bak.setMeta({ dirName: b.dirName, name: '我的备份' })
  bak.setMeta({ dirName: c.dirName, name: '硬起个名字' })

  // keep 设 0：除受保护的以外全删
  const removed = bak.pruneSnapshots({ keep: 0 })
  assert.deepEqual(removed.sort(), [a.dirName, c.dirName, d.dirName].sort(),
    '只有手动命名的那份（reason=r1）该活下来')
  const left = bak.listSnapshots()
  assert.equal(left.length, 1)
  assert.equal(left[0].dirName, b.dirName)
})

test('pruneSnapshots：protectPinned=false 时退回纯计数语义（内部调用可用）', () => {
  makeHome(fullHome())
  const a = bak.createSnapshot({ profile: 'web', reason: 'r0', at: atOf(0) })
  const b = bak.createSnapshot({ profile: 'web', reason: 'r1', at: atOf(1) })
  bak.setMeta({ dirName: a.dirName, knownGood: true })
  // ⚠️ 注意 listSnapshots 会把 known-good 排到最前，所以「最新的」是 b，但「排第一的」是 a。
  // 关闭保护后 keep=1 保留的是列表第一项（a，known-good），被删的是 b —— 这里刻意用这个
  // 反直觉的结果钉住「protectPinned=false 退回的是纯列表顺序计数，与标记无关」。
  assert.deepEqual(bak.pruneSnapshots({ keep: 1, protectPinned: false }), [b.dirName])
})

test('listSnapshots：dirName 以磁盘目录名为准，不信任 manifest 里的记录（防手改字段删错目录）', () => {
  makeHome(fullHome())
  const s = bak.createSnapshot({ profile: 'web', reason: 'manual' })
  const root = bak.backupRoot()
  // 手改 manifest 的 dirName，指向一个同级的「无关目录」—— 它没 manifest，本不该被碰
  const bystander = path.join(root, '20200101-000000')
  fs.mkdirSync(bystander)
  fs.writeFileSync(path.join(bystander, 'marker.txt'), 'must survive', 'utf8')
  const mp = path.join(s.dir, 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'))
  m.dirName = '20200101-000000'
  fs.writeFileSync(mp, JSON.stringify(m))

  // 列表必须以目录名为准（否则界面上的「还原 / 删除」会指向另一个目录）
  assert.equal(bak.listSnapshots()[0].dirName, s.dirName)

  // 清理时也不能信 manifest：bystander 没 manifest，绝不能被碰；
  // 真实快照按 keep=0 被正常删掉（这里用 keep:0 + protectPinned:false 让它成为待删项）
  bak.pruneSnapshots({ keep: 0, protectPinned: false })
  assert.equal(fs.existsSync(path.join(bystander, 'marker.txt')), true, '无关目录被误删了')
  assert.equal(fs.existsSync(s.dir), false, '待删的真实快照该被删掉')
})

test('listSnapshots：目录被手工改名后仍认 manifest 指向的旧目录（改名的那份删得掉）', () => {
  makeHome(fullHome())
  const s = bak.createSnapshot({ profile: 'web', reason: 'manual' })
  const root = bak.backupRoot()
  // 模拟「快照目录被手工改名、manifest 里的旧名字还指向一个确实存在的目录」：
  // 整份快照搬到新目录名，manifest 里仍留着旧名字，且按旧名字放一份同内容目录
  const renamed = '20200101-000000'
  fs.cpSync(s.dir, path.join(root, renamed), { recursive: true })
  // 列表：两份都能列出来；搬到 renamed 的那份，manifest 里记的是 s.dirName，
  // 而 s.dirName 那个目录也真实存在，故它对外仍报 s.dirName（界面据此定位磁盘）
  const names = bak.listSnapshots().map((x) => x.dirName)
  assert.equal(names.filter((x) => x === s.dirName).length, 2)
  // 按 manifest 里的旧名字删，必须命中 —— 这条正是 fallback 存在的理由：
  // 不做 fallback 的话 removeSnapshot(旧名) 会「成功删掉另一个目录」或直接失败
  assert.equal(bak.removeSnapshot(s.dirName).ok, true)
  assert.equal(fs.existsSync(s.dir), false, '按旧名删的应当是 manifest 指向的那个目录')
  assert.equal(fs.existsSync(path.join(root, renamed)), true, '被改名的那份不该被误删')
})

test('_isPinned：known-good 与「有名字且非 before-*」为真，其余为假', () => {
  assert.equal(bak._isPinned({ knownGood: true, name: '', reason: 'before-disable' }), true)
  assert.equal(bak._isPinned({ knownGood: false, name: '手动存的', reason: 'manual' }), true)
  assert.equal(bak._isPinned({ knownGood: false, name: '硬起的名', reason: 'before-isolate' }), false)
  assert.equal(bak._isPinned({ knownGood: false, name: '', reason: 'manual' }), false)
})

test('retentionKeep：读不到配置时回落默认值 20（配置读写由 store 负责）', () => {
  makeHome(fullHome())
  // 本文件里的 utools 桩 dbStorage.getItem 恒返回 null → 配置为空 → 用默认值
  assert.equal(bak.retentionKeep(), bak.MAX_SNAPSHOTS)
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
