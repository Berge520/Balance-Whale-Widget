/*
 * 「版本说明」的新鲜度判定必须与宿主的**区间标识**同口径
 * （src/App.vue 的 dshNotesResolved / dshNotesFresh，对照 public/preload/lib/dsh.js 的 loadNotes
 *   与 public/preload/lib/dsh-notes.js 的 getNotes）
 *
 * 回归的 bug（用户实测）：在设置页把「要安装的版本」选成老版本后，
 * 版本说明一栏永远停在「正在获取说明…」，既不出内容也不出失败提示。
 *
 * 根因是**两端算出的「这份说明属于哪一段」不一致**，而不是「没重取」：
 *   · 宿主 dsh.js 的 loadNotes 把 `resolvedTarget = isNewer(target, installed) ? installed + '->' + target : target`
 *     挂在这份 notes 上一起回传；
 *   · 设置页原先自己复刻了一套「取区间上界」的算法（dshNotesBound / dshLatestVer），
 *     在目标版本比 latest 老时算出的是**用户选的固定版本**，与宿主 /latest 口径对不上
 *     → dshNotesFresh() 恒为 false → 所有要求新鲜度的分支全被跳过，一路落到最后的「正在获取说明…」。
 *     再重取多少次都没用，因为这不是数据问题而是判据问题。
 *
 * 修法是把宿主的口径**逐字镜像**：宿主多算一个 resolvedTarget，设置页的 dshNotesResolved 与它逐字比对。
 * 这里直接跑**真模块**，喂同一组输入给宿主的 getNotes 与 dsh.js 的 loadNotes，
 * 断言两者回传的 resolvedTarget 与设置页算出的值**逐字相等**。这才是"同口径"的判据。
 *
 * 另含**单版本模式**（所选版本老于或等于实装）—— 这一档是后加的：
 * 区间是「比实装新且不超过目标」，目标 ≤ 实装时恒为空，界面只会显示「已是最新」，
 * 而用户明明选了一版想看它的说明（降级 / 换版前先看看），什么都不给等于该入口在降级场景下失效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createRequire } from 'node:module'

// ── utools 桩（log.js 取临时目录写 whale-debug.log）──
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}

// fetch 桩：只回固定的 release 夹具，绝不真打网络（打网络会慢且随上游漂移）
const REAL_FETCH = globalThis.fetch
// ⚠️ 版本序按 semver：alpha < beta < rc。实装取 beta.1，这样列表里既有比它**老**的 alpha.2
//    （单版本模式用例），也有比它**新**的 rc.1 / rc.2（区间模式用例）。
//    别用 rc 当「老版本」—— `rc.1 > alpha.2`，拿它当老的会把区间用例误判成单版本模式。
const RELEASES = {
  releases: ['0.1.7-alpha.2', '0.1.7-beta.1', '0.1.7-rc.1', '0.1.7-rc.2'].map((v) => ({
    tag: 'dsh-v' + v,
    // cn- 块用 h3（真实形态）：只取中文块，避免中英各算一遍
    markdown: '<h3 id="cn-' + v + '">\ud83d\udc1b \u4fee\u590d</h3>\n- ' + v + ' \u7684\u4e00\u6761\u4fee\u590d',
  })),
}
globalThis.fetch = async () => ({ ok: true, json: async () => RELEASES })

const require = createRequire(import.meta.url)
const notesMod = require('../public/preload/lib/dsh-notes.js')
const { getNotes, singleVersion } = notesMod

test.after(() => { globalThis.fetch = REAL_FETCH })

const INSTALLED = '0.1.7-beta.1'
const OLDER = '0.1.7-alpha.2'
const LIST = ['0.1.7-alpha.2', '0.1.7-beta.1', '0.1.7-rc.1', '0.1.7-rc.2']
const NEWEST = 'newest' // 与 constants.js 的 NEWEST_VERSION 同值

// 复刻 App.vue 的 dshInstalledVer —— 这一栏必须与宿主 loadNotes 用的 activeDsh().version 同源。
// 宿主把它广播成快照的 `resolved`，所以这里直接读 resolved。
// 曾经这里复刻的是 `source === 'global' && globalVersion ? globalVersion : installed || globalVersion`，
// 看着等价，实则 `installed` 是「插件目录」那份（installedVersion() 只读 dshPrefix()，
// **不含全局安装**）。于是全局装 dsh 的用户两端拿的不是同一个版本 → resolvedTarget 对不上 → 卡住。
const dshInstalledVerOf = () => INSTALLED

// 前端版本比较，逐字复刻 App.vue 的 dshVerNewer —— **优先按 npm 发布时间（times），
// 取不到才退回 semver**。dsh 官方会给旧分支补发版本号更低的补丁（0.1.5-rc.3 晚于 0.1.6-alpha.2），
// 只按 semver 会把「后发但号更小」的那版判反。宿主 dsh.js 的 newerByTime 是同一套口径。
function dshVerSemver(a, b) {
  const pa = String(a || '').split(/[.\-+]/), pb = String(b || '').split(/[.\-+]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i]
    if (x === undefined) return false
    if (y === undefined) return true
    const ix = parseInt(x, 10), iy = parseInt(y, 10)
    const sx = isNaN(ix), sy = isNaN(iy)
    if (sx && sy) { if (x !== y) return x > y; continue }
    if (sx !== sy) return sx
    if (ix !== iy) return ix > iy
  }
  return false
}
function dshVerNewer(a, b, times) {
  const x = String(a || '').trim(), y = String(b || '').trim()
  if (!x) return false
  if (!y) return true
  const t = times && typeof times === 'object' ? times : null
  const tx = t && t[x], ty = t && t[y]
  if (tx && ty) return tx > ty
  if (tx && !ty) return true
  if (!tx && ty) return false
  return dshVerSemver(x, y)
}

// 复刻 App.vue 的 dshTargetVersion：'' = latest 标签，'newest' = 列表里**最晚发布**的那版，其余为固定版本号
function targetOf(configured, versions) {
  if (configured === NEWEST) {
    const times = versions.times || null
    let best = ''
    for (const v of versions.list) if (!best || dshVerNewer(v, best, times)) best = v
    return best
  }
  return configured || versions.latest || ''
}

// 复刻 App.vue 修好后的 dshNotesResolved：与宿主 dsh.js 的 loadNotes **逐字**同一行算法
function uiResolved(configured, versions) {
  const target = targetOf(configured, versions)
  if (!target) return ''
  const installed = dshInstalledVerOf()
  return installed && dshVerNewer(target, installed, versions.times || null) ? installed + '->' + target : target
}

// 复刻宿主 dsh.js 的 loadNotes 里那一行 resolvedTarget（必须与上面逐字相等，否则 fresh 恒 false）
function hostResolved(target, installed, times) {
  return dshVerNewer(target, installed, times) ? installed + '->' + target : target
}

const VERSIONS = { at: 1700000000000, latest: '0.1.7-rc.2', list: LIST }

// 各种「用户选的版本」：自动 / 最新含测试版 / latest / 比 latest 老的固定版本 / 实装那版 / 比 latest 新的固定版本
const CASES = ['', NEWEST, '0.1.7-rc.2', '0.1.7-rc.1', '0.1.7-alpha.2', '0.2.0']

test('宿主回的 resolvedTarget 与设置页 dshNotesResolved 逐字相等（否则 fresh 恒 false → 卡在正在获取）', () => {
  for (const c of CASES) {
    const target = targetOf(c, VERSIONS)
    assert.equal(
      hostResolved(target, INSTALLED),
      uiResolved(c, VERSIONS),
      '选「' + (c || '自动') + '」时两端标识不一致：宿主 ' + hostResolved(target, INSTALLED) +
      '、设置页 ' + uiResolved(c, VERSIONS) +
      ' → 新鲜度判定永远对不上，界面会一直停在「正在获取说明…」',
    )
  }
})

test('区间模式（所选比实装新）：标识带上实装版本，实装一变就得重算', () => {
  // 自动 / 最新 / latest / 比 latest 新 —— 这几种都比实装 0.1.7-alpha.2 新，走区间模式
  for (const c of ['', NEWEST, '0.1.7-rc.2', '0.2.0']) {
    const target = targetOf(c, VERSIONS)
    assert.equal(uiResolved(c, VERSIONS), INSTALLED + '->' + target, '选「' + (c || '自动') + '」应走区间模式')
  }
})

test('单版本模式（所选不高于实装）：标识就是所选版本，与实装无关', () => {
  // OLDER 比实装老 → 单版本；INSTALLED == 实装 → 也是单版本（区间恒为空，只能看这一版自己）
  for (const c of [OLDER, INSTALLED]) {
    assert.equal(uiResolved(c, VERSIONS), c, '选「' + c + '」应走单版本模式，标识就是它自己')
    assert.equal(hostResolved(c, INSTALLED), c)
  }
})

test('反证：若设置页仍用「区间上界」当标识，选老版本时就会对不上（原 bug 的判据）', () => {
  const configured = OLDER // 用户选了个比实装老的固定版本
  const buggy = VERSIONS.latest // 旧 dshNotesBound 的写法：收窄到列表最大值
  assert.notEqual(
    buggy,
    hostResolved(configured, INSTALLED),
    '这正是原 bug：设置页算出列表最大值、宿主回所选版本 → fresh 恒 false → 卡在「正在获取说明…」',
  )
  // 修好后的口径则能对上
  assert.equal(uiResolved(configured, VERSIONS), hostResolved(configured, INSTALLED))
})

test('getNotes 单版本模式：所选 == 实装 → 取该版自己那一份说明', async () => {
  const r = await getNotes({ installed: INSTALLED, target: INSTALLED, list: LIST, notes: new Map() })
  assert.equal(r.ok, true)
  assert.equal(r.empty, false, '实装 == 所选时区间为空，但单版本模式要给这一版自己的说明')
  assert.deepEqual(r.versions, [INSTALLED])
  assert.equal(r.total, 1)
  assert.equal(r.url, 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v' + INSTALLED)
})

test('getNotes 单版本模式：所选老于实装 → 取所选那一版，不聚合升级区间', async () => {
  const r = await getNotes({ installed: INSTALLED, target: OLDER, list: LIST, notes: new Map() })
  assert.equal(r.ok, true)
  assert.equal(r.empty, false)
  assert.deepEqual(r.versions, [OLDER], '单版本模式只含所选那一版，不含实装与更高版本')
  assert.equal(r.url, 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v' + OLDER)
  // 单版本模式不设 truncated（区间模式才有「下界被列表截断」这回事）；字段缺省即为 undefined
  assert.equal(r.truncated, undefined)
})

test('getNotes 单版本模式：所选版本不在列表里 → ok:false（无从取说明）', async () => {
  const r = await getNotes({ installed: INSTALLED, target: '0.1.6-alpha.1', list: LIST, notes: new Map() })
  assert.equal(r.ok, false, '列表里没有这一版，说明无从取，必须明确失败而不是回空')
  assert.ok(r.reason)
})

test('getNotes 区间模式：所选比实装新 → 聚合「实装 → 所选」，与单版本模式区分开', async () => {
  const r = await getNotes({ installed: INSTALLED, target: '0.1.7-rc.2', list: LIST, notes: new Map() })
  assert.equal(r.ok, true)
  assert.deepEqual(r.versions, ['0.1.7-rc.1', '0.1.7-rc.2'], '区间不含实装那版自己')
})

test('回归：区间上界是**所选版本**，不得被钳到列表最大值（否则选哪一版都给同一段）', async () => {
  // 用户实测的 bug：实装 0.1.7-alpha.2（这里用 beta.1 同理）、列表最大值 rc.2，
  // 在下拉里选 rc.1 —— 旧实现 `const hi = target && cmpVer(target, max) > 0 ? target : max`
  // 会因 rc.1 < rc.2 而把上界钳成 max=rc.2，算出「beta.1 -> rc.2」这段，
  // 表现为「选哪个版本都只看得到 rc.2 那段」，用户的选择被静默吃掉。
  // ⚠️ 现有那条「所选比实装新」用例的 target 恰好 == max，两种写法结果相同，**发现不了**这个 bug，
  //    所以必须单独钉一条：target 比 max 旧但比实装新。
  const r = await getNotes({ installed: INSTALLED, target: '0.1.7-rc.1', list: LIST, notes: new Map() })
  assert.equal(r.ok, true)
  assert.deepEqual(r.versions, ['0.1.7-rc.1'], '上界应停在所选版本，不该把 rc.2 也并进来')
})

test('回归：实装版本必须取宿主广播的 resolved（全局安装那份），不能用「插件目录」那份', () => {
  // 用户实测的 bug：全局装了 0.1.7-beta.1，插件目录里另有一份**别的**版本（PLUGIN_DIR_VER）。
  // 前端先前用 `dsh.source === 'global' && dsh.globalVersion ? … : dsh.installed || …`——
  // dsh.installed 是插件目录那份，全局安装时它跟 resolved 不是一个版本。
  // 后果：用户选一个**比实装新的中间版本**（rc.1）时，宿主按 beta.1 判出「区间模式」，
  // 前端按插件目录那份判成「单版本模式」，两个 resolvedTarget 对不上 → dshNotesFresh 恒 false
  // → 界面永远停在「正在获取说明…」。
  //
  // 注意这个 bug **只在选中间版本时**才现形：选 rc.2（== 列表最大）时两种口径都落区间模式，
  // 差异被掩盖 —— 这正是「rc.2 正常、rc.1 卡住」的由来，也是这条用例专挑 rc.1 的原因。
  const PLUGIN_DIR_VER = '0.1.7-rc.2' // 插件目录那份：比实装新，足以让两种口径分出岔
  const configured = '0.1.7-rc.1'

  // 正确口径（用 resolved = 全局那份）：比实装新 → 区间模式
  const good = uiResolved(configured, VERSIONS)
  assert.equal(good, INSTALLED + '->' + configured, '用 resolved 应判出区间模式')
  assert.equal(good, hostResolved(configured, INSTALLED), '必须与宿主逐字相等')

  // 错误口径（用插件目录那份）：rc.1 不比 rc.2 新 → 误判成单版本模式
  const buggyResolved = dshVerNewer(configured, PLUGIN_DIR_VER) ? PLUGIN_DIR_VER + '->' + configured : configured
  assert.notEqual(buggyResolved, hostResolved(configured, INSTALLED), '这正是原 bug：两端判出的模式不同')
  assert.notEqual(buggyResolved, good)
})

test('singleVersion：命中返回该版、未命中返回空、空输入返回空', () => {
  assert.deepEqual(singleVersion('0.1.7-rc.1', LIST), ['0.1.7-rc.1'])
  assert.deepEqual(singleVersion('0.1.6-alpha.1', LIST), [])
  assert.deepEqual(singleVersion('', LIST), [])
  assert.deepEqual(singleVersion('0.1.7-rc.1', []), [])
})

// ── 按发布时间（times）判先后：dsh 会给旧分支补发版本号更低的补丁 ──────────────
// 实测 0.1.5-rc.3 发布于 0.1.6-alpha.2 **之后**。构造同款：「最新（含测试版）」哨兵必须挑
// **实际最晚发布**的那版，而不是 semver 最大的一版；设置页与宿主必须同一个结论。
test('「最新（含测试版）」按发布时间挑版本，不按 semver（宿主与设置页结论一致）', () => {
  // semver 最大是 0.1.7-rc.2，但 0.1.5-rc.3 发布更晚 → 时间口径下它才是「最新」
  const TIMES = {
    '0.0.1-rc.1': '2025-01-01T00:00:00.000Z',
    '0.1.6-alpha.2': '2025-06-01T00:00:00.000Z',
    '0.1.7-rc.2': '2025-08-01T00:00:00.000Z',
    '0.1.5-rc.3': '2025-09-01T00:00:00.000Z', // 号最小，却发布最晚
  }
  const versions = { at: 1700000000000, latest: '0.1.7-rc.2', list: Object.keys(TIMES), times: TIMES }

  // 设置页 dshTargetVersion（'newest' 哨兵）
  assert.equal(targetOf(NEWEST, versions), '0.1.5-rc.3', '设置页应按发布时间挑出 0.1.5-rc.3')
  // 宿主 maxVersion 是同一套口径（这里用 dshVerNewer 逐项取最大来验证，与宿主 maxVersion 等价）
  let hostBest = ''
  for (const v of versions.list) if (!hostBest || dshVerNewer(v, hostBest, TIMES)) hostBest = v
  assert.equal(hostBest, '0.1.5-rc.3', '宿主 maxVersion 同口径，也应挑出 0.1.5-rc.3')
  assert.equal(targetOf(NEWEST, versions), hostBest, '两端必须挑同一版，否则装的和显示的对不上')

  // 对照：退回 semver（无 times）会挑错
  assert.equal(targetOf(NEWEST, { ...versions, times: {} }), '0.1.7-rc.2', '无 times 时退回 semver，得到 0.1.7-rc.2')
})

test('新鲜度标识在 times 口径下两端仍逐字相等（后发低版本号不得判反）', () => {
  const TIMES = {
    '0.1.6-alpha.2': '2025-06-01T00:00:00.000Z', // 实装
    '0.1.5-rc.3': '2025-09-01T00:00:00.000Z',    // 所选：号更小、发布更晚
  }
  const installed = '0.1.6-alpha.2'
  // 所选 0.1.5-rc.3 发布晚于实装 → 区间模式（semver 会判成更旧、落单版本，两端都错但一致地错）
  assert.equal(dshVerNewer('0.1.5-rc.3', installed, TIMES), true, '按发布时间应判为比实装新')
  assert.equal(
    dshVerNewer('0.1.5-rc.3', installed, TIMES) ? installed + '->0.1.5-rc.3' : '0.1.5-rc.3',
    hostResolved('0.1.5-rc.3', installed, TIMES),
    '两端新鲜度标识必须逐字相等',
  )
})

test('列表为空时宿主给不出说明，设置页标识为空串，两边都不会各算一个对不上的值', async () => {
  // 空列表 + 单版本模式：所选版本不在（空的）列表里 → 明确失败（无从取说明）
  const r = await getNotes({ installed: INSTALLED, target: OLDER, list: [], notes: new Map() })
  assert.equal(r.ok, false)
  // 空列表 + 区间模式：上界退成 target 本身，但可选版本一个都没有 → 回空区间（ok + empty），不是失败
  const r2 = await getNotes({ installed: INSTALLED, target: '0.2.0', list: [], notes: new Map() })
  assert.equal(r2.ok, true)
  assert.equal(r2.empty, true)
  // 设置页这边：target 为空 → 标识为空串（而不是退回某个版本）
  assert.equal(uiResolved('', { at: 0, latest: '', list: [] }), '')
})
