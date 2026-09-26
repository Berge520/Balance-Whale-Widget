/*
 * store.js 配置读写的「键集完整性」单测（node --test，零依赖）。
 *
 * 为什么单独测这个：配置走的是**三个平行的手写键表**（defaultConfig / readConfig /
 * writeConfig）+ 一个手写的 patchConfig 分支表，四份都是逐键罗列、谁都不引用谁。
 * 漏一处的后果不是抛错，而是**静默的**：
 *   · 加进 defaultConfig 却忘了 patchConfig → 设置页保存后该键永远是默认值（用户改了没反应）
 *   · 加进 readConfig 却忘了 writeConfig → 该键写盘时被丢掉（重启后变回去）
 *   · 加进 writeConfig 却忘了 readConfig → 存了但读不回来（等同没存）
 * 历史实例：defaultConfig 补 ghAccelSrc 时正是靠人工比对才没漏。这里用机器把四份钉在一起。
 *
 * 覆盖：
 *   1. defaultConfig / readConfig（空存储）/ writeConfig 落盘 / patchConfig 回读，四处键集完全一致
 *   2. patchConfig 的逐键分支表覆盖全部配置键 —— 用 fixtures 表强制「加键必须同时加 fixture」
 *   3. patchConfig 只打补丁的键，未传的键保持现值（不是被打回默认）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createRequire } from 'node:module'

// ── utools 桩：store.js 全程用属性访问 utools.dbStorage，挂全局即可（不需要重载模块）──
const store = new Map()
globalThis.utools = {
  getPath: () => os.tmpdir(), // log.js 取临时目录
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  },
}

const require = createRequire(import.meta.url)
const S = require('../public/preload/lib/store.js')
const { K } = require('../public/preload/lib/constants.js')

const { defaultConfig, readConfig, writeConfig, patchConfig } = S

// ── 夹具的键集：空存储下 readConfig 应当落回 defaultConfig ──
function clearCfg() { store.delete(K.config) }
function keysOf(o) { return Object.keys(o).sort() }

test('四处键集一致：defaultConfig / readConfig(空存储) / writeConfig(落盘) / readConfig(回读)', () => {
  clearCfg()
  const dft = defaultConfig()
  const dftKeys = keysOf(dft)

  // 空存储：readConfig 必须给出与 defaultConfig 完全相同的键集（键不能少，也不能凭空多）
  assert.deepEqual(keysOf(readConfig()), dftKeys, 'readConfig(空存储) 与 defaultConfig 键集不一致')

  // 落盘：writeConfig 会把 updatedAt 一并写进去，这时存储里的键 = 配置键 + updatedAt
  clearCfg()
  assert.equal(writeConfig(S.patchConfig({})), true)
  const persisted = store.get(K.config)
  assert.deepEqual(
    keysOf(persisted),
    [...dftKeys, 'updatedAt'].sort(),
    'writeConfig 落盘的键集与 defaultConfig 不一致（漏写或多写）',
  )

  // 回读：readConfig 会把 updatedAt 去掉，键集回到与 defaultConfig 一致
  assert.deepEqual(keysOf(readConfig()), dftKeys, 'readConfig(有存储) 与 defaultConfig 键集不一致')
})

// ── patchConfig 逐键覆盖：每个配置键都必须有一份「能让它变」的夹具 ──
// 值和当前默认不同即可，不追求语义正确（patchConfig 会把非法值归一，只要结果不等于原值就说明这条分支生效）。
// models / mainModelId 需要成对出现（mainModelId 要指向 models 里存在的 id），见下面的 special 处理。
const PATCH_FIXTURES = {
  scale: { scale: 2 }, vol: { vol: 0.1 }, soundOn: { soundOn: false }, soundSet: { soundSet: 'custom' },
  usageMode: { usageMode: 'token' }, peakMode: { peakMode: 'liangwen' }, peakRemindOn: { peakRemindOn: false },
  bubbleOn: { bubbleOn: false }, menuBtn: { menuBtn: false }, onTop: { onTop: false },
  lowAlertOn: { lowAlertOn: false }, lowAlertAmount: { lowAlertAmount: 123 }, budgetOn: { budgetOn: true },
  budgetAmount: { budgetAmount: 55 }, dropAlertOn: { dropAlertOn: true }, dropAlertAmount: { dropAlertAmount: 66 },
  clickQueueOn: { clickQueueOn: true }, remindSec: { remindSec: 5 }, quietOn: { quietOn: true },
  quietFrom: { quietFrom: '01:02' }, quietTo: { quietTo: '03:04' }, timeBubbleOn: { timeBubbleOn: false },
  updateCheckOn: { updateCheckOn: true }, dragLock: { dragLock: true }, enterMode: { enterMode: 'widget' },
  timerNotifyOn: { timerNotifyOn: false }, timerMailOn: { timerMailOn: false }, timerPersistOn: { timerPersistOn: false },
  timerMode: { timerMode: 'down' }, timerSec: { timerSec: 300 }, timerAt: { timerAt: '06:07' },
  timerNote: { timerNote: '打个招呼' }, timerBreakMin: { timerBreakMin: 9 }, timerRemindSec: { timerRemindSec: 15 },
  timerBubblePin: { timerBubblePin: false }, timerBubbleOnly: { timerBubbleOnly: false },
  guideDone: { guideDone: true }, dshNodeDir: { dshNodeDir: 'C:\\node' }, dshKeepAlive: { dshKeepAlive: true },
  dshPort: { dshPort: 4080 },
  dshRegistry: { dshRegistry: 'https://example.com/npm' }, dshVersion: { dshVersion: '1.2.3' },
  dshReinstall: { dshReinstall: true }, dshNoOpen: { dshNoOpen: false },
  dshMarketUrl: { dshMarketUrl: 'https://example.com/cat' }, dshMarketMirror: { dshMarketMirror: false },
  dshMarketRegistry: { dshMarketRegistry: 'https://example.com/reg' }, dshMarketOfficial: { dshMarketOfficial: true },
  dshExportCred: { dshExportCred: true }, dshExportNoMod: { dshExportNoMod: false },
  avoidTaskbar: { avoidTaskbar: false }, edgeTop: { edgeTop: 11 }, edgeRight: { edgeRight: 12 },
  edgeBottom: { edgeBottom: 13 }, edgeLeft: { edgeLeft: 14 }, scrollGapOn: { scrollGapOn: true },
  scrollGapPx: { scrollGapPx: 33 }, snapMode: { snapMode: 'off' }, snapRatio: { snapRatio: 40 },
  opacity: { opacity: 66 }, passThrough: { passThrough: true }, skin: { skin: 'custom' },
  theme: { theme: 'dark' }, quotes: { quotes: { time: ['改过的报时'] } },
  alerts: { alerts: { low: '改过的低额模板' } }, quotaTotal: { quotaTotal: 88 },
  quotaReset: { quotaReset: 'never' }, tokenPrice: { tokenPrice: { on: true, cur: 'USD', rate: 7.5, hit: 1, miss: 2, out: 3 } },
  historyKeepDays: { historyKeepDays: 400 }, dshBackupKeep: { dshBackupKeep: 33 },
  menuGroups: { menuGroups: { look: true } }, menuGroupsRev: { menuGroupsRev: 7 },
  ghAccelOn: { ghAccelOn: true }, ghAccelIps: { ghAccelIps: [{ domain: 'github.com', ip: '1.2.3.4' }] },
  ghAccelRefreshedAt: { ghAccelRefreshedAt: 1700000000000 }, ghAccelSrc: { ghAccelSrc: { doh: false } },
  notifySystemOn: { notifySystemOn: false }, notifyMailOn: { notifyMailOn: true },
  mailFrom: { mailFrom: 'a@b.c' }, mailTo: { mailTo: 'd@e.f' },
  mailFromName: { mailFromName: '改过的发件名' }, mailSubjectPrefix: { mailSubjectPrefix: '[改]' },
  // models / mainModelId 必须一起给：mainModelId 指向不存在的 id 会被判失效回默认
  models: {
    models: [{ id: 'zzz', vendor: 'x', name: '测试模型', base: 'https://x.example', key: '' }],
    mainModelId: 'zzz',
  },
}

test('patchConfig 的逐键分支表覆盖全部配置键（加键必须同时加夹具）', () => {
  // mainModelId 的夹具与 models 合并成一条（mainModelId 必须指向 models 里存在的 id 才生效），
  // 所以 fixtures 里有 models 无独立的 mainModelId —— 两边都按「去掉 mainModelId」比较
  const dftKeys = keysOf(defaultConfig()).filter((k) => k !== 'mainModelId')
  const fixtureKeys = keysOf(PATCH_FIXTURES).filter((k) => k !== 'mainModelId')
  const missing = dftKeys.filter((k) => !fixtureKeys.includes(k))
  const extra = fixtureKeys.filter((k) => !dftKeys.includes(k))
  assert.deepEqual(missing, [], `这些配置键还没有 patchConfig 夹具（多半是忘了在 patchConfig 里加分支）：${missing}`)
  assert.deepEqual(extra, [], `这些夹具没有对应的配置键（键被删了但夹具没删）：${extra}`)
})

test('patchConfig 逐键生效：每个夹具都能真的改动对应配置键', () => {
  for (const key of keysOf(PATCH_FIXTURES)) {
    clearCfg()
    const before = readConfig()
    const after = patchConfig(PATCH_FIXTURES[key])
    if (key === 'models' || key === 'mainModelId') {
      assert.equal(after.mainModelId, 'zzz', '同时传 models + mainModelId 时主显示模型未生效')
      assert.equal(after.models.length, 1, 'models 未写入')
      continue
    }
    assert.notDeepEqual(after[key], before[key], `patchConfig 对 ${key} 的补丁没有生效`)
    // 只打补丁的键，其余键保持现值（不是被打回默认）
    assert.deepEqual(before[key], defaultConfig()[key], `夹具前置假设失效：${key} 的默认值变了，请同步 PATCH_FIXTURES`)
  }
})

test('patchConfig 只改传入的键，未传的键保持现值', () => {
  clearCfg()
  patchConfig({ scale: 1.6, quietOn: true, mailTo: 'x@y.z' })
  const cfg = readConfig()
  // 打过的键是新值
  assert.equal(cfg.scale, 1.6)
  assert.equal(cfg.quietOn, true)
  assert.equal(cfg.mailTo, 'x@y.z')
  // 没打过的键 = 默认值（尤其别被 patchConfig 顺手清零）
  assert.equal(cfg.opacity, defaultConfig().opacity)
  assert.equal(cfg.vol, defaultConfig().vol)
  assert.equal(cfg.timerSec, defaultConfig().timerSec)
  assert.equal(cfg.mailSubjectPrefix, defaultConfig().mailSubjectPrefix)
})

test('patchConfig 非法值不写入（保持现值），不抛错', () => {
  clearCfg()
  const before = readConfig()
  const after = patchConfig({ remindSec: 7, timerRemindSec: 3, timerAt: '99:99', timerMode: 'bogus', snapMode: 'bogus', scale: 9999 })
  assert.equal(after.remindSec, before.remindSec, 'remindSec 非法档位应保持现值')
  assert.equal(after.timerRemindSec, before.timerRemindSec, 'timerRemindSec 非法档位应保持现值')
  assert.equal(after.timerAt, before.timerAt, 'timerAt 非法格式应保持现值')
  assert.equal(after.timerMode, before.timerMode, 'timerMode 非法值应保持现值')
  assert.equal(after.snapMode, before.snapMode, 'snapMode 非法值应保持现值')
  assert.equal(after.scale, 2.5, 'scale 越界应夹到 MAX_SCALE(2.5)')
})

test('timerAt 必须是合法的 24 小时时刻（99:99 曾能一路写进配置）', () => {
  clearCfg()
  // 越界的时 / 分必须被拒（挂件把它塞进 <input type="time">，非法值会让 .value 清空、定时刻静默失效）
  for (const bad of ['99:99', '24:00', '12:60', '7:5', 'abc', '', '07:30:00']) {
    clearCfg()
    assert.equal(patchConfig({ timerAt: bad }).timerAt, '07:30', `timerAt=${JSON.stringify(bad)} 应回默认`)
  }
  // 合法值保留，且补零成两位（与 quietFrom / quietTo 同一口径）
  assert.equal(patchConfig({ timerAt: '06:07' }).timerAt, '06:07')
  assert.equal(patchConfig({ timerAt: '6:07' }).timerAt, '06:07')
  assert.equal(patchConfig({ timerAt: '23:59' }).timerAt, '23:59')
})

test('patchConfig 写失败时抛错（不让调用方以为保存成功）', () => {
  clearCfg()
  const savedSet = globalThis.utools.dbStorage.setItem
  globalThis.utools.dbStorage.setItem = () => { throw new Error('quota exceeded') }
  try {
    assert.throws(() => patchConfig({ vol: 0.5 }), /写配置失败/)
  } finally {
    globalThis.utools.dbStorage.setItem = savedSet
  }
})

test('patchConfig 传非对象当空补丁：不抛错，键集与默认一致', () => {
  clearCfg()
  for (const bad of [null, undefined, 42, 'x', []]) {
    clearCfg()
    const cfg = patchConfig(bad)
    assert.deepEqual(keysOf(cfg), keysOf(defaultConfig()))
  }
})
