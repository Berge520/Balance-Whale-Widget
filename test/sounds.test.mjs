/*
 * sounds.js 单测（node --test，零依赖）。
 *
 * 这个模块管「自定义音效」：按压 / 释放两段音色 + 四类提醒音，外加 shared 素材池。
 * 它此前只在 assets-packs.test.mjs 里被**顺带**用过 installBuiltin / setSharedRoles 少数几个入口，
 * 真正的核心语义没人钉：
 *   - 「一段一槽位」：实播槽位每次导入整条替换（用户抱怨过「显示成『来财 等 2 段』读不通」）；
 *   - roles 归一化必须**保得住**：oneItem 是归一化写入，不带出的字段下次 writeMeta 就被抹掉 →
 *     用户勾的槽位「过一会儿自己没了」；
 *   - 文件名命名空间 / 扩展名白名单是安全边界：元信息是存储里的普通数据，可能被外部改写，
 *     不能拿它当路径直接读删（isRoleFile 就是这道闸）。
 *
 * 落盘走真实文件系统：getPath('userData') 桩指向本次测试的临时目录，dbStorage 用内存 Map，
 * 全程不碰真实用户数据，也不打真实网络（本模块没有网络）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

// ── utools 桩：内存 dbStorage + userData 指向本次测试的临时目录 ──
const store = new Map()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sounds-test-'))
globalThis.utools = {
  getPath: () => TMP,
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  },
}

const require = createRequire(import.meta.url)
const sounds = require('../public/preload/lib/sounds.js')
const constants = require('../public/preload/lib/constants.js')
const K = constants.K

const {
  importBuffer, installBuiltin, setSharedRoles, removeSound, clearAll,
  getSoundData, readMeta, readSoundBuffer, mimeOf, exportItems, dir,
  ROLES, PLAY_ROLES, ROLE_LABEL,
} = sounds

// 元信息里落盘名的唯一来源（saveOne 只回 name/ext 不回 file）
const fileOf = (role, name) => (readMeta()[role].find((x) => x.name === name) || {}).file || ''
const MB = 1024 * 1024

test('测试前置：K.sounds 是预期键名，落盘目录随 getPath 桩走', () => {
  assert.equal(K.sounds, 'whale:sounds')
  assert.equal(dir(), path.join(TMP, 'whale-sounds'))
})

// ──────────────────────────────────────────────
// 「一段一槽位」：实播槽位每次导入整条替换
// ──────────────────────────────────────────────
test('importBuffer：实播槽位「一段一槽位」，第二次导入顶掉第一段（旧文件也删）', () => {
  clearAll()
  const r1 = importBuffer('press', 'a.mp3', 'mp3', Buffer.alloc(10, 1))
  assert.equal(r1.ok, true, r1.error)
  const file1 = fileOf('press', 'a.mp3')
  assert.equal(readMeta().press.length, 1)

  const r2 = importBuffer('press', 'b.mp3', 'mp3', Buffer.alloc(12, 2))
  assert.equal(r2.ok, true, r2.error)
  const meta = readMeta()
  assert.equal(meta.press.length, 1, '实播槽位只保留一段')
  assert.equal(meta.press[0].name, 'b.mp3')
  assert.equal(fs.existsSync(path.join(dir(), file1)), false, '被顶掉的旧文件必须清掉，否则目录越攒越大')
})

test('installBuiltin（shared 素材池）走 append：装第二段不抹第一段', () => {
  clearAll()
  assert.ok(installBuiltin('s1.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  assert.ok(installBuiltin('s2.mp3', 'mp3', Buffer.alloc(8, 2)).ok)
  const shared = readMeta().shared
  assert.equal(shared.length, 2, '素材池要多段共存（若走替换语义，下载第二段就抹掉第一段）')
})

test('installBuiltin：同名段重装按名覆盖，不翻倍（素材包可重复导入）', () => {
  clearAll()
  assert.ok(installBuiltin('dup.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  const before = fileOf('shared', 'dup.mp3')
  assert.ok(installBuiltin('dup.mp3', 'mp3', Buffer.alloc(9, 2)).ok)
  const meta = readMeta().shared
  assert.equal(meta.filter((x) => x.name === 'dup.mp3').length, 1, '同名重装不该产生第二条')
  assert.equal(meta[0].file, before, '同扩展名重装复用原落盘名，不越攒越多')
})

test('installBuiltin：同名重装继承原 roles（勾选记在段自己身上）', () => {
  clearAll()
  assert.ok(installBuiltin('keep.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  const file = fileOf('shared', 'keep.mp3')
  assert.ok(setSharedRoles(file, ['press', 'low']).ok)
  // 重装同名段（素材包重下）：roles 不该被抹掉
  assert.ok(installBuiltin('keep.mp3', 'mp3', Buffer.alloc(8, 9)).ok)
  const item = readMeta().shared.find((x) => x.name === 'keep.mp3')
  assert.deepEqual(item.roles.sort(), ['low', 'press'], '重装同名段必须继承原 roles')
})

test('installBuiltin：换扩展名重装时取新落盘名，并清掉旧名', () => {
  clearAll()
  assert.ok(installBuiltin('x.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  const oldFile = fileOf('shared', 'x.mp3')
  assert.ok(installBuiltin('x.mp3', 'wav', Buffer.alloc(8, 2)).ok)
  const item = readMeta().shared.find((x) => x.name === 'x.mp3')
  assert.match(item.file, /\.wav$/, '扩展名变了要落新名')
  assert.notEqual(item.file, oldFile)
  assert.equal(fs.existsSync(path.join(dir(), oldFile)), false, '旧扩展名的残留文件要清掉')
})

// ──────────────────────────────────────────────
// 参数校验（安全边界：不能拿外部数据当路径）
// ──────────────────────────────────────────────
test('importBuffer：未知槽位 / 不支持格式 / 空或超限字节 一律拒绝', () => {
  clearAll()
  assert.equal(importBuffer('nope', 'a.mp3', 'mp3', Buffer.alloc(4)).ok, false)
  assert.equal(importBuffer('press', 'a.svg', 'svg', Buffer.alloc(4)).ok, false)
  assert.equal(importBuffer('press', 'a.mp3', 'mp3', Buffer.alloc(0)).ok, false)
  assert.equal(importBuffer('press', 'a.mp3', 'mp3', null).ok, false)
  const big = importBuffer('press', 'a.mp3', 'mp3', Buffer.alloc(5 * MB + 1))
  assert.equal(big.ok, false)
  assert.match(big.error, /过大/)
})

test('installBuiltin：格式 / 空字节 / 超限 同样被挡', () => {
  clearAll()
  assert.equal(installBuiltin('a.xyz', 'xyz', Buffer.alloc(4)).ok, false)
  assert.equal(installBuiltin('a.mp3', 'mp3', Buffer.alloc(0)).ok, false)
  assert.equal(installBuiltin('a.mp3', 'mp3', Buffer.alloc(5 * MB + 1)).ok, false)
})

// ──────────────────────────────────────────────
// nextFile 编号复用：删掉一段后编号回填
// ──────────────────────────────────────────────
test('落盘编号复用最小空位（删掉中间一段后，下一段填回该号）', () => {
  clearAll()
  // 经 shared 池造三段：<role>-1/2/3
  installBuiltin('n1.mp3', 'mp3', Buffer.alloc(4))
  installBuiltin('n2.mp3', 'mp3', Buffer.alloc(4))
  installBuiltin('n3.mp3', 'mp3', Buffer.alloc(4))
  const files = readMeta().shared.map((x) => x.file).sort()
  assert.deepEqual(files, ['shared-1.mp3', 'shared-2.mp3', 'shared-3.mp3'])

  // 删掉中间那段（shared-2），下一段应填回空位 2（而非继续往后取 4）
  assert.ok(removeSound('shared', 'shared-2.mp3').ok)
  installBuiltin('n4.mp3', 'mp3', Buffer.alloc(4))
  const after = readMeta().shared.map((x) => x.file).sort()
  assert.deepEqual(after, ['shared-1.mp3', 'shared-2.mp3', 'shared-3.mp3'])
  // nextFile 取的是目录里的最小空位，删掉 2 后新段拿到的是 2（而非 4）——
  // 这正是「编号不无限增长」的实现前提：旧文件确实被 unlink 了
  assert.equal(fs.existsSync(path.join(dir(), 'shared-4.mp3')), false)
})

// ──────────────────────────────────────────────
// isRoleFile / 归一化：白名单与命名空间是安全边界
// ──────────────────────────────────────────────
test('readMeta：文件名不在槽位命名空间内的项被丢弃（防存储被改写后当路径读删）', () => {
  clearAll()
  // 直接往存储塞一条 file 指到别处的脏项
  store.set(K.sounds, {
    press: [
      { name: 'ok', ext: 'mp3', at: 1, file: 'press.mp3' }, // 合法：老结构命名
      { name: 'evil', ext: 'mp3', at: 1, file: '../../etc/passwd' }, // 越权路径
      { name: 'other', ext: 'mp3', at: 1, file: 'release.mp3' }, // 别的槽位的文件
      { name: 'bad', ext: 'exe', at: 1, file: 'press.exe' }, // 扩展名不在白名单
      { name: 'nofile', ext: 'mp3', at: 1 }, // 老结构：无 file → 按 <role>.<ext> 推
    ],
  })
  const list = readMeta().press
  assert.equal(list.length, 2, '只该留下合法两项')
  assert.deepEqual(list.map((x) => x.name).sort(), ['nofile', 'ok'])
  // 没有 file 字段的老结构按 <role>.<ext> 推出
  assert.equal(list.find((x) => x.name === 'nofile').file, 'press.mp3')
})

test('readMeta：老结构（一槽位一对象）就地升级成数组', () => {
  clearAll()
  store.set(K.sounds, { press: { name: 'old', ext: 'wav', at: 5, file: 'press.wav' } })
  const meta = readMeta()
  assert.ok(Array.isArray(meta.press))
  assert.equal(meta.press.length, 1)
  assert.equal(meta.press[0].file, 'press.wav')
  // 每个槽位都是数组（缺省即空）
  for (const role of ROLES) assert.ok(Array.isArray(meta[role]), role + ' 应是数组')
})

test('readMeta：损坏存储 / 非对象项 不抛错，按空处理', () => {
  clearAll()
  store.set(K.sounds, 'not-an-object')
  const meta = readMeta()
  for (const role of ROLES) assert.deepEqual(meta[role], [])

  store.set(K.sounds, { press: [null, 'x', 42, { ext: 'mp3', file: 'press.mp3' }] })
  assert.equal(readMeta().press.length, 1, '只留那一条合法项')
})

// ──────────────────────────────────────────────
// roles 归一化：只留合法实播槽位、去重、不残留空字段
// ──────────────────────────────────────────────
test('readMeta：shared 段的 roles 只保留合法实播槽位并去重', () => {
  clearAll()
  store.set(K.sounds, {
    shared: [{ name: 's', ext: 'mp3', at: 1, file: 'shared-1.mp3', roles: ['press', 'nope', 'press', 'shared', 42, 'low'] }],
  })
  const item = readMeta().shared[0]
  assert.deepEqual(item.roles, ['press', 'low'], '非法名与 shared 自身被剔除、press 去重')
})

test('readMeta：roles 全非法 / 空数组 → 不带 roles 字段（归一化不残留空数组）', () => {
  clearAll()
  store.set(K.sounds, {
    shared: [
      { name: 'a', ext: 'mp3', at: 1, file: 'shared-1.mp3', roles: ['nope', 'shared'] },
      { name: 'b', ext: 'mp3', at: 1, file: 'shared-2.mp3', roles: [] },
    ],
  })
  const meta = readMeta()
  assert.equal('roles' in meta.shared[0], false)
  assert.equal('roles' in meta.shared[1], false)
})

test('归一化保得住 roles（回归：不带出的字段会在下次 writeMeta 被静默抹掉）', () => {
  clearAll()
  assert.ok(installBuiltin('keep.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  const file = fileOf('shared', 'keep.mp3')
  assert.ok(setSharedRoles(file, ['press']).ok)
  // 再导入一段别的音效（触发一次 readMeta → writeMeta 全量重写）
  assert.ok(installBuiltin('other.mp3', 'mp3', Buffer.alloc(8, 2)).ok)
  const item = readMeta().shared.find((x) => x.name === 'keep.mp3')
  assert.deepEqual(item.roles, ['press'], '别的写入不该把已勾的 roles 抹掉')
})

// ──────────────────────────────────────────────
// setSharedRoles
// ──────────────────────────────────────────────
test('setSharedRoles：空 / 非字符串文件名拒绝；不在池里拒绝', () => {
  clearAll()
  assert.equal(setSharedRoles('', ['press']).ok, false)
  assert.equal(setSharedRoles(null, ['press']).ok, false)
  const miss = setSharedRoles('不存在.mp3', ['press'])
  assert.equal(miss.ok, false)
  assert.match(miss.error, /没有这段音效/)
})

test('setSharedRoles：传空数组摘干净，不残留空 roles 字段', () => {
  clearAll()
  assert.ok(installBuiltin('r.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  const file = fileOf('shared', 'r.mp3')
  assert.ok(setSharedRoles(file, ['peak']).ok)
  assert.ok(setSharedRoles(file, []).ok)
  assert.equal('roles' in readMeta().shared[0], false)
})

test('setSharedRoles：非数组 roles 视作摘掉', () => {
  clearAll()
  assert.ok(installBuiltin('r2.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  const file = fileOf('shared', 'r2.mp3')
  assert.ok(setSharedRoles(file, ['low']).ok)
  assert.ok(setSharedRoles(file, 'press').ok)
  assert.equal('roles' in readMeta().shared[0], false)
})

// ──────────────────────────────────────────────
// getSoundData：实播槽位 = 自导入段（在前）+ 池里挂了该槽位的段（在后）
// ──────────────────────────────────────────────
test('getSoundData：自导入段排在池段之前，未挂的槽位为空', () => {
  clearAll()
  // 自己导入到 press：一段
  assert.ok(importBuffer('press', 'mine.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  // 池里一段挂到 press
  assert.ok(installBuiltin('pool.mp3', 'mp3', Buffer.alloc(8, 2)).ok)
  assert.ok(setSharedRoles(fileOf('shared', 'pool.mp3'), ['press']).ok)

  const data = getSoundData()
  assert.equal(data.press.length, 2, 'press = 自导入 1 + 池段 1')
  assert.match(data.press[0], /^data:audio\/mpeg;base64,/)
  assert.equal(data.release.length, 0, '没挂的槽位是空数组')
  for (const role of PLAY_ROLES) assert.ok(Array.isArray(data[role]), role + ' 应是数组')
})

test('getSoundData：池里没挂 roles 的段不进任何槽位', () => {
  clearAll()
  assert.ok(installBuiltin('idle.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  const data = getSoundData()
  for (const role of PLAY_ROLES) assert.equal(data[role].length, 0, role + ' 不该带上未挂的池段')
})

test('getSoundData：命中内存缓存（同一份返回，写入后失效）', () => {
  clearAll()
  assert.ok(importBuffer('press', 'm.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  const a = getSoundData()
  assert.equal(getSoundData(), a, '未变更时应复用缓存对象')
  // 再导入一段 → 缓存应失效并重算
  assert.ok(importBuffer('press', 'm2.mp3', 'mp3', Buffer.alloc(8, 2)).ok)
  const b = getSoundData()
  assert.notEqual(b, a, '导入后缓存必须失效')
  assert.equal(b.press.length, 1, '实播槽位仍是替换语义，只有最新那段')
})

test('getSoundData：文件缺失的槽位项被跳过，不抛错', () => {
  clearAll()
  assert.ok(importBuffer('low', 'gone.mp3', 'mp3', Buffer.alloc(8, 1)).ok)
  // 手动删掉落盘文件，模拟 userData 被清理
  fs.rmSync(path.join(dir(), fileOf('low', 'gone.mp3')))
  const data = getSoundData()
  assert.equal(data.low.length, 0, '文件没了就不推 data URL，挂件侧回退静音')
})

// ──────────────────────────────────────────────
// removeSound / clearAll
// ──────────────────────────────────────────────
test('removeSound：不给 file 清空整槽位；给 file 只删那一段', () => {
  clearAll()
  assert.ok(installBuiltin('a.mp3', 'mp3', Buffer.alloc(4))) // shared-1
  assert.ok(installBuiltin('b.mp3', 'mp3', Buffer.alloc(4))) // shared-2
  const fileA = fileOf('shared', 'a.mp3')
  const fileB = fileOf('shared', 'b.mp3')

  // 只删 a
  assert.ok(removeSound('shared', fileA).ok)
  let meta = readMeta()
  assert.equal(meta.shared.some((x) => x.file === fileA), false)
  assert.equal(meta.shared.some((x) => x.file === fileB), true)
  assert.equal(fs.existsSync(path.join(dir(), fileA)), false, '文件也要删')

  // 不给 file → 清空该槽位
  assert.ok(removeSound('shared').ok)
  meta = readMeta()
  assert.equal(meta.shared.length, 0)
})

test('removeSound：未知槽位拒绝', () => {
  clearAll()
  assert.equal(removeSound('nope', 'x').ok, false)
})

test('clearAll：删目录 + 清元信息，缓存失效', () => {
  clearAll()
  assert.ok(importBuffer('press', 'x.mp3', 'mp3', Buffer.alloc(4)).ok)
  assert.ok(installBuiltin('y.mp3', 'mp3', Buffer.alloc(4)).ok)
  const data1 = getSoundData()
  assert.ok(data1.press.length >= 1)

  assert.ok(clearAll().ok)
  assert.equal(store.has(K.sounds), false, '元信息键要删掉')
  assert.equal(fs.existsSync(dir()), false, '整个目录被删（含改名遗留的旧文件）')
  const data2 = getSoundData()
  assert.equal(data2.press.length, 0)
})

// ──────────────────────────────────────────────
// exportItems（素材包打包用）
// ──────────────────────────────────────────────
test('exportItems：只导实播槽位，shared 素材池不随包走（可重新下载，避免平白胖 2.7MB）', () => {
  clearAll()
  assert.ok(importBuffer('press', 'p.mp3', 'mp3', Buffer.alloc(6, 1)).ok)
  assert.ok(importBuffer('peak', 'k.wav', 'wav', Buffer.alloc(7, 2)).ok)
  assert.ok(installBuiltin('pool.mp3', 'mp3', Buffer.alloc(5, 3)).ok)

  const items = exportItems()
  const roles = items.map((x) => x.role)
  assert.deepEqual(roles.sort(), ['peak', 'press'])
  assert.ok(!roles.includes('shared'), 'shared 素材池不该出现在导出项里')
  const p = items.find((x) => x.role === 'press')
  assert.equal(p.data.length, 6)
  assert.equal(p.name, 'p.mp3')
})

test('exportItems：文件缺失的段落跳过，不因一段坏音频让整包导不出去', () => {
  clearAll()
  assert.ok(importBuffer('press', 'ok.mp3', 'mp3', Buffer.alloc(6, 1)).ok)
  assert.ok(importBuffer('release', 'gone.mp3', 'mp3', Buffer.alloc(6, 2)).ok)
  fs.rmSync(path.join(dir(), fileOf('release', 'gone.mp3')))

  const items = exportItems()
  assert.equal(items.length, 1)
  assert.equal(items[0].role, 'press')
})

// ──────────────────────────────────────────────
// 小工具：mimeOf / readSoundBuffer / 常量表
// ──────────────────────────────────────────────
test('mimeOf：已知扩展名映射，未知 / 空回 mp3', () => {
  assert.equal(mimeOf('wav'), 'audio/wav')
  assert.equal(mimeOf('MP3'), 'audio/mpeg', '大小写不敏感')
  assert.equal(mimeOf('xyz'), 'audio/mpeg')
  assert.equal(mimeOf(''), 'audio/mpeg')
  assert.equal(mimeOf(undefined), 'audio/mpeg')
})

test('readSoundBuffer：命中回 Buffer，缺失回 null（不缓存）', () => {
  clearAll()
  assert.ok(installBuiltin('buf.mp3', 'mp3', Buffer.alloc(11, 7)).ok)
  const file = fileOf('shared', 'buf.mp3')
  const buf = readSoundBuffer(file)
  assert.ok(Buffer.isBuffer(buf))
  assert.equal(buf.length, 11)
  assert.equal(readSoundBuffer('没有这个文件.mp3'), null)
})

test('常量表：ROLES 含 shared，PLAY_ROLES 是它的真子集且不含 shared', () => {
  assert.ok(ROLES.includes('shared'))
  for (const r of PLAY_ROLES) assert.ok(ROLES.includes(r), r + ' 应属于 ROLES')
  assert.ok(!PLAY_ROLES.includes('shared'), 'shared 只是素材池，不是实播槽位')
  for (const r of PLAY_ROLES) assert.ok(ROLE_LABEL[r], r + ' 应有中文标签')
})
