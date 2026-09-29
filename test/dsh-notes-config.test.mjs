/*
 * 「版本说明」的目标版本取自配置（public/preload/lib/dsh.js 的 loadNotes / targetVersion）
 *
 * 用户实测（2026-09-28）：在「更新版本」下拉里每换一个版本，展开「版本说明」都卡在
 * 「正在获取说明…」—— 换回 0.1.7-rc.2 又正常，换 0.1.7-rc.1 / 0.0.1-rc.1 都卡住。
 *
 * 根因：targetVersion() 把**固定版本整个丢掉**，只有 state.version === 'newest' 时看列表最大值，
 *   其余一律返回 state.versions.latest。于是：
 *     · 界面 dshTargetVersion 取 cfg.dshVersion（用户选的 0.1.7-rc.1 / 0.0.1-rc.1）；
 *     · 宿主 loadNotes 取 targetVersion()（恒为 latest = 0.1.7-rc.2）；
 *   两边算出的 resolvedTarget 必然不同 → dshNotesFresh() 恒 false → 永远停在「正在获取说明…」。
 *   只有恰好选到 latest 那一版（0.1.7-rc.2）才碰巧对上 —— 这正是「只有 rc.2 能取到说明」的成因。
 *   注意 installVersion() 是认固定版本的，两处口径本该一致，targetVersion() 漏了。
 *
 * 本文件钉的就是这条：配置里固定了哪一版，loadNotes 就必须按哪一版取说明。
 * 顺带钉住 loadNotes 与本模块其余对外操作一样先 syncConfig() —— 它读的 state.version
 * 只在这句之后才是配置里的新值。
 *
 * ⚠️ 别用 dshNotesResolved 那一行本身来测 —— 那行两边各自复刻、都「对」，
 *    漂的是**喂给它的输入**。所以这里测的是输入源：config 选了哪版，loadNotes 就认哪版。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── utools 桩 ──
// loadNotes 的版本号来自 readConfig()（经 syncConfig → configure），所以必须挂一个假的
// whale:config 存储让 readConfig() 读出我们要的值，测试路径才与线上一致。
// 不同于 dsh-port-change：这里还要挡住真网络 —— loadNotes 缺缓存时会 fetch ungh.cc。
const CONFIG_KEY = 'whale:config'
let stored = {}
// userData 指到一个临时目录：dsh.js 的 dshPrefix() 由此拼出 dshPkgDir()，
// 我们在 prime() 里往那儿落一份假的 dsh package.json，installedVersion() 才读得到实装版本
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-notes-'))
globalThis.utools = {
  getPath: () => USER_DATA,
  dbStorage: {
    getItem: (k) => (k === CONFIG_KEY ? stored : null),
    setItem: () => {},
    removeItem: () => {},
  },
}
test.after(() => { try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch (err) {} })

// fetch 桩：只回夹具，绝不真打网络。同时记下被调用次数，用来断言「命中缓存即 0 请求」
let fetchHits = 0
const REAL_FETCH = globalThis.fetch
globalThis.fetch = async () => {
  fetchHits++
  return { ok: true, json: async () => ({ releases: [] }) }
}
test.after(() => { globalThis.fetch = REAL_FETCH })

const require = createRequire(import.meta.url)
const dsh = require('../public/preload/lib/dsh.js')
const { loadNotes, __state: st } = dsh

const INSTALLED = '0.1.7-alpha.2'
const LIST = ['0.0.1-rc.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2']
const LATEST = '0.1.7-rc.2'

// 把内存态摆成「全局装了 INSTALLED、版本列表已查到」的样子，并让配置里的 dshVersion 就是 want。
// st.version 留空（''）是有意的：它模拟「刚重载插件、还没做过任何操作」——
// 只有 loadNotes 自己 syncConfig() 才会把它刷成配置里的值。
// 若 loadNotes 不 syncConfig、或 targetVersion 不认固定版本，就会落到 state.versions.latest，
// 即本文件要钉的那个 bug。
// 屏蔽本机真实存在的全局 dsh：globalDsh() 会扫 PATH / APPDATA / resolveNode(nodeDir) 等一堆位置，
// 开发机往往真装了 dsh（本例实测命中 D:\nodejs\npm-global），于是 installed 取到的是**本机那份**，
// 测试结果随机器而变、CI 与本地不一致。这里在 prime() 期间把这些探测入口全部摘掉，
// 让 globalDsh() 落空、退回插件目录那份假包（见下），installed 才是可控的 INSTALLED。
const HIDE_ENV = ['PATH', 'Path', 'APPDATA', 'LOCALAPPDATA', 'PREFIX']
let savedEnv = null
function hideGlobalDsh() {
  savedEnv = {}
  for (const k of HIDE_ENV) { savedEnv[k] = process.env[k]; delete process.env[k] }
}
function restoreEnv() {
  if (!savedEnv) return
  for (const k of HIDE_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  savedEnv = null
}

function prime({ configVersion, times }) {
  // nodeDir 指到一个本地不存在的占位路径：resolveNode() 找不到 node，globalPkgDirs() 就少一批候选
  stored = { dshVersion: configVersion, dshNodeDir: path.join(USER_DATA, 'no-such-node'), dshKeepAlive: false, dshNoOpen: true }
  hideGlobalDsh()
  st.version = ''
  // times 缺省为空对象：老缓存没有这个字段，此时版本先后只能退回 semver（见 dsh-notes 文件头）。
  // 传了则按发布时间判定 —— resolvedTarget 会因此与 semver 口径不同。
  st.versions = { at: 1700000000000, latest: times ? Object.keys(times).slice(-1)[0] : LATEST, list: LIST, times: times || {} }
  st.versionsLoaded = true
  st.notes = { at: 0, data: null, notes: new Map() }
  st.notesBusy = false
  st.notesDirty = false
  // 落一份「插件目录里装了 INSTALLED」的假包：屏蔽掉全局 dsh 后，installed 就由它提供
  // （loadNotes 的 installed 取自 globalDsh() || cliEntry()，后者读的就是 dshPkgDir() 下这份）。
  // 不造它的话 installed 恒为 ''，resolvedTarget 会退化成单版本形态
  // —— 那是「没装 dsh」的情形，与本文件要测的「装了 dsh 且用户选了别的版本」不符。
  const pkgDir = path.join(USER_DATA, 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'cli.js'), '')
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: INSTALLED, bin: { dsh: 'cli.js' } }))
  st.prefix = ''
  st.resolveCache = { key: '\u0000', value: null }
}

// loadNotes 返回的是快照；说明结果由 state.notes.data 落地（异步），所以断言看这里
const notesOf = () => st.notes.data
const settle = () => new Promise((r) => setImmediate(r))

test('回归：配置固定了版本时，版本说明必须按**所选那一版**取，不能退回 latest', async () => {
  // 用户选了比实装新的中间版本：区间模式，上界应停在所选版本
  prime({ configVersion: '0.1.7-rc.1' })

  loadNotes(false)
  await settle()

  const n = notesOf()
  assert.ok(n, '应已产出说明结果（哪怕上游夹具是空的，data 也该落地）')
  assert.equal(
    n.target, '0.1.7-rc.1',
    'target 必须取自**配置里的固定版本**；取到 ' + LATEST + ' 说明 targetVersion() 把固定版本丢了，'
    + '界面按所选版本算 resolvedTarget、宿主按 latest 算，两边对不上 → 卡在「正在获取说明…」',
  )
  // 实装 0.1.7-alpha.2、所选 rc.1（比实装新）→ 区间模式，键里带上实装版本
  assert.equal(n.resolvedTarget, INSTALLED + '->0.1.7-rc.1')
  assert.deepEqual(n.versions, ['0.1.7-rc.1'], '区间上界应停在所选版本，不该把 rc.2 也并进来')
})

test('回归：所选版本老于实装（单版本模式）时同样按所选那一版取', async () => {
  // 这一档最容易被「退回 latest」掩盖：latest（rc.2）比实装新，会被误判成区间模式
  prime({ configVersion: '0.0.1-rc.1' })

  loadNotes(false)
  await settle()

  const n = notesOf()
  assert.equal(n.target, '0.0.1-rc.1', '单版本模式的 target 就是所选版本，也必须取自配置')
  // 所选 rc.1 不比实装 alpha.2 新 → 单版本模式，键就是它自己、不带实装版本
  assert.equal(n.resolvedTarget, '0.0.1-rc.1')
  assert.deepEqual(n.versions, ['0.0.1-rc.1'], '单版本模式只看所选那一版')
})

test('回归：选 latest 那一版时（两种口径碰巧一致）也应正常取到', async () => {
  prime({ configVersion: LATEST })

  loadNotes(false)
  await settle()

  const n = notesOf()
  assert.equal(n.target, LATEST)
  assert.equal(n.resolvedTarget, INSTALLED + '->' + LATEST)
})

test('反向：config 没变时第二次调用命中缓存，不再打网络（syncConfig 不该破坏原有短路）', async () => {
  prime({ configVersion: '0.1.7-rc.1' })

  fetchHits = 0
  loadNotes(false)
  await settle()
  const after1 = fetchHits

  loadNotes(false)
  await settle()
  assert.equal(after1, 1, '首趟应打一次网络')
  assert.equal(fetchHits, 1, '第二趟 target/installed 都没变，应命中短路、不再打网络')
})

// 版本先后必须按**官方发布时间**，不能按 semver：dsh 官方会给旧分支补发版本号更低的补丁。
// 实测 0.1.5-rc.3 发布于 0.1.6-alpha.2 **之后**。这里构造同款场景：所选 0.0.1-rc.1 号最小、
// 却发布**晚于**实装 0.1.7-alpha.2（实装所在列表里唯一比它早发的那版）。
// 按 semver → 所选更旧 → 单版本模式；按时间 → 所选更新 → 区间模式。这条钉的就是「必须走区间」。
test('时间：所选版本号更小但发布更晚时，仍按「比实装新」走区间模式', async () => {
  const TIMES = {
    '0.1.7-alpha.2': '2025-08-01T00:00:00.000Z', // 实装：列表里发布最早的一版
    '0.0.1-rc.1': '2025-09-01T00:00:00.000Z',    // 所选：号最小，却发布最晚 —— semver 会判反
    '0.1.7-rc.1': '2025-09-02T00:00:00.000Z',
    '0.1.7-rc.2': '2025-09-03T00:00:00.000Z',    // 最晚发布 = latest（prime 按 times 末键取）
  }
  prime({ configVersion: '0.0.1-rc.1', times: TIMES })

  loadNotes(false)
  await settle()

  const n = notesOf()
  assert.ok(n, '应已产出说明结果')
  assert.equal(n.target, '0.0.1-rc.1', 'target 仍是配置里所选那一版')
  assert.equal(
    n.resolvedTarget, INSTALLED + '->0.0.1-rc.1',
    '0.0.1-rc.1 发布晚于实装 0.1.7-alpha.2，应判为「比实装新」走区间模式；'
    + '若得到单版本形态 0.0.1-rc.1，说明比较退回了 semver（号小即判旧）',
  )
  assert.deepEqual(
    n.versions, ['0.0.1-rc.1'],
    '区间（发布晚于实装、且不晚于所选）只含所选那一版：实装是列表里最早发的，所选虽号小却最晚发，中间没有别的版本；'
    + '退回 semver 会得到 INSTALLED->LATEST 的整段，条目数完全对不上',
  )
})

test.afterEach(() => {
  restoreEnv()
  st.notes = { at: 0, data: null, notes: new Map() }
  st.notesBusy = false
  st.notesDirty = false
  st.version = ''
  stored = {}
})
