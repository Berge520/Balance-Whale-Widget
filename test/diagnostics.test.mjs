/*
 * diagnostics.js 的回归测试（node --test，零依赖）。
 *
 * 这里盯的是**几个不能靠肉眼发现的约定**（都是静默失效型）：
 *   1. C5 的「无法判定」必须是 warning —— 一旦被写成 error，整轮 ok 变 false，
 *      用户看到「诊断不通过」而实际只是探测没跑成（D26）。
 *   2. 单项 detect 抛错只标记该项，其余四项照常出结果（§3.2 约定 2）。
 *   3. C1 判据只用 name+version 指纹，**不碰路径字符串**（D25）——
 *      用路径比较在 Windows/macOS 会静默漏报，测试必须钉住「指纹相同即命中」
 *      而不是「路径相同才命中」。
 *   4. C5 判「是不是 dsh」看的是**命令行**（looksLikeDsh），不是进程名 —— 任何 Node
 *      程序都叫 node.exe。旧版只看名字，把占着 3080 的裸 node 探针报成「外部 dsh」。
 *
 * 另外覆盖 scanPatchLines / extractPatchIds 等纯函数的边界（D13）。
 *
 * diagnostics.js 会 require dsh.js（→ utools），所以先挂桩再 import。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── utools 桩：dsh.js 只用到 getPath / dbStorage / shellOpenExternal ──
const store = new Map()
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  },
  shellOpenExternal: () => {},
}

const require = createRequire(import.meta.url)
const diag = require('../public/preload/lib/diagnostics.js')
const { K } = require('../public/preload/lib/constants.js')

// ── 夹具：造一个假的 $DSH_HOME ──
let tmpRoot = ''
function makeHome(files = {}) {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diag-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(tmpRoot, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return tmpRoot
}
function cleanup() {
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {} tmpRoot = '' }
}
test.afterEach(() => {
  store.clear()
  cleanup()
})

// ── 纯函数：severity 三态映射（D26 的核心）──
test('severestLevel：error 压过 warn，无 finding 返回空串', () => {
  assert.equal(diag.severestLevel([{ level: 'warn' }, { level: 'error' }]), 'error')
  assert.equal(diag.severestLevel([{ level: 'warn' }, { level: 'warn' }]), 'warn')
  assert.equal(diag.severestLevel([]), '')
  assert.equal(diag.severestLevel(null), '')
})

test('severityOf / markOf：有结论无事是 ok[✓]，判不出来是 warning[!]，真异常才 critical[✗]', () => {
  const ok = { findings: [] }
  const warn = { findings: [{ level: 'warn' }] }
  const err = { findings: [{ level: 'error' }] }
  assert.equal(diag.severityOf(ok), 'ok')
  assert.equal(diag.severityOf(warn), 'warning')
  assert.equal(diag.severityOf(err), 'critical')
  assert.equal(diag.markOf(ok), '[✓]')
  assert.equal(diag.markOf(warn), '[!]')
  assert.equal(diag.markOf(err), '[✗]')
  // 抛错项一律算最严重
  assert.equal(diag.severityOf({ threw: true, findings: [] }), 'critical')
  assert.equal(diag.markOf({ threw: true, findings: [] }), '[✗]')
})

test('orderResults：critical → warning → ok，同级保持原顺序（stable）', () => {
  const a = { id: 'a', findings: [] }
  const b = { id: 'b', findings: [{ level: 'error' }] }
  const c = { id: 'c', findings: [{ level: 'warn' }] }
  const d = { id: 'd', findings: [] }
  const e = { id: 'e', findings: [{ level: 'error' }] }
  const out = diag.orderResults([a, b, c, d, e])
  assert.deepEqual(out.map((r) => r.id), ['b', 'e', 'c', 'a', 'd'])
})

// ── C5 降级不污染整轮（D26 必测）──
test('D26：端口「无法判定」只产生 warning，不得让 overallOk 变 false', () => {
  const noProbe = diag.CHECKS.find((c) => c.id === 'port-dsh')
  // portState 缺失 = 探测没跑成
  const f1 = noProbe.detect(diag.buildContext({ home: 'X', port: 3080, portState: null }))
  assert.equal(f1.ok, false)
  assert.equal(diag.severestLevel(f1.findings), 'warn')

  // 探测失败
  const f2 = noProbe.detect(diag.buildContext({ home: 'X', portState: { failed: true, reason: '探测超时' } }))
  assert.equal(diag.severestLevel(f2.findings), 'warn')
  assert.match(f2.summary, /无法判定/)

  // 拿不到进程名（典型的判不出来）→ warning
  const f3 = noProbe.detect(diag.buildContext({ home: 'X', portState: { pid: 4242, name: '' } }))
  assert.equal(diag.severestLevel(f3.findings), 'warn')

  // 把这三态塞进整轮，overallOk 必须仍为 true
  for (const f of [f1, f2, f3]) {
    const results = [{ id: 'port-dsh', threw: false, findings: f.findings }]
    assert.equal(diag.overallOk(results), true, 'C5 的 warning 不应让整轮失败')
    assert.equal(diag.summarize(results).pass, 0, '但也不算「通过」')
  }
})

test('C5：端口空闲 → ok；被非 dsh 占用 → error；外部 dsh → warn', () => {
  const c5 = diag.CHECKS.find((c) => c.id === 'port-dsh')
  // 空闲
  const idle = c5.detect(diag.buildContext({ home: 'X', portState: { pid: 0 } }))
  assert.equal(idle.ok, true)
  assert.equal(diag.severestLevel(idle.findings), '')
  // 被别的程序占着
  const other = c5.detect(diag.buildContext({ home: 'X', portState: { pid: 11, occupiedByOther: 'nginx' } }))
  assert.equal(diag.severestLevel(other.findings), 'error')
  // 外部 dsh 在跑：命令行已证明是 dsh（portDsh: true），才允许说成「外部 dsh」
  const ext = c5.detect(diag.buildContext({ home: 'X', portState: { pid: 22, externalPid: 22, name: 'node', portDsh: true } }))
  assert.equal(diag.severestLevel(ext.findings), 'warn')
  assert.equal(ext.ok, false)
})

// ⚠️⚠️ 本机实测踩坑（2026-09-22，第 ③ 段场景 ③ 发现的真 bug）：
// 旧判据只认进程名 `/^(node|dsh)(\.exe)?$/i`，而**任何 Node 程序都叫 node.exe**。
// 我起了一个裸 `node -e "net.createServer().listen(3080)"` 占住 3080，诊断报的是
// `[!] 3080 已有外部 dsh 在运行`（warning），而不是 `[✗] 被非 dsh 占用`（error）——
// 一个真占用被降级成无害提示，用户按「可改为接管这个实例」去点，必然失败。
//
// 更值得记的是：**测试和实现犯了同一个错**。下面那条既有用例原先写的是
// `{ pid: 22, externalPid: 22, name: 'node' }`，它自己也假设了「pid 存在 + 名字是 node.exe = dsh」，
// 于是四关全绿也拦不住这个 bug（本项目第二次出现「测试与实现共享同一个错误假设」，
// 上一次是 C2/C3 双双少写一层 profiles/<n>）。所以这里必须钉死三态，而不是只钉住一态。
test('C5：进程名像 dsh 但命令行证明不是 → error（裸 node 占端口不许降级成「外部 dsh」）', () => {
  const c5 = diag.CHECKS.find((c) => c.id === 'port-dsh')
  // 本机真实形状：pid 26428 是我起的探针，进程名 node.exe，命令行是 `node -e ...`（无 dsh 特征）
  const probe = c5.detect(diag.buildContext({
    home: 'X',
    portState: { pid: 26428, name: 'node', portDsh: false },
  }))
  assert.equal(probe.ok, false)
  assert.equal(diag.severestLevel(probe.findings), 'error', '确认不是 dsh 就必须报 error，不能只给 warning')
  assert.match(probe.summary, /被非 dsh 进程占用/)
  assert.match(probe.findings[0].text, /node/)
  assert.match(probe.findings[0].hint, /没有 dsh 特征/)
})

// 同样是「有 pid + 名字像 node」，但这次是**真 dsh**：不能走进上面那条 error 分支。
// 两条用例合起来才钉住「判据看的是命令行，不是名字」。
test('C5：portDsh 为 true / null 时不得走进「被非 dsh 占用」分支', () => {
  const c5 = diag.CHECKS.find((c) => c.id === 'port-dsh')
  // 真 dsh 由本插件监听（externalPid 为 0 因为不是外部进程）→ 正常
  const mine = c5.detect(diag.buildContext({
    home: 'X',
    portState: { pid: 9692, name: '', portDsh: true, selfOwned: true },
  }))
  assert.equal(mine.ok, true)
  assert.equal(diag.severestLevel(mine.findings), '')
  // 拿不到命令行（null）→ 判不出来，按 D26 报 warning，绝不能猜成 error，也不能猜成 ok
  const unknown = c5.detect(diag.buildContext({
    home: 'X',
    portState: { pid: 4242, name: 'node', portDsh: null },
  }))
  assert.equal(diag.severestLevel(unknown.findings), 'warn')
  assert.match(unknown.summary, /无法判定/)
  // 名字压根不像 dsh，但同样拿不到命令行 → 也不许报 ok（可能是别的程序占着端口）
  const stranger = c5.detect(diag.buildContext({
    home: 'X',
    portState: { pid: 77, name: 'nginx', portDsh: null },
  }))
  assert.equal(diag.severestLevel(stranger.findings), 'warn')
})

// 反向钉子：**名字本身从来不是证据**。同一个 name='node'，只因为 portDsh 不同，
// 结论必须从 [✓] 变成 [!] —— 这条用例的作用是防止有人把「名字像 dsh 就报 ok」改回来。
// ⚠️ 2026-09-22 修正：原先这条用例把 selfOwned: true 也一起传了，于是断言「selfOwned 为真
// 但命令行拿不到 → 不得报 ok」——那是在钉一个错误行为（插件自己启动的 dsh 恰恰该报 ok）。
// 要让「名字不是证据」成立，必须把 selfOwned 也去掉：只剩名字，才真的没有证据。
test('C5：name 是 node 但 portDsh 不是 true → 绝不报 ok（名字不是证据）', () => {
  const c5 = diag.CHECKS.find((c) => c.id === 'port-dsh')
  // 只有名字像 node/dsh：既非自己的进程树（selfOwned 假），也没命令行（portDsh null）
  const byName = c5.detect(diag.buildContext({
    home: 'X',
    portState: { pid: 9692, name: 'node', portDsh: null },
  }))
  assert.notEqual(byName.ok, true, '拿不到命令行、也不是自己的进程树时，名字像 node 也不足以判定正常')
  const byCmdline = c5.detect(diag.buildContext({
    home: 'X',
    portState: { pid: 9692, name: 'node', selfOwned: true, portDsh: true },
  }))
  assert.equal(byCmdline.ok, true, '命令行证明是 dsh 才报正常')
})

// ⚠️ 这条用例的 pid 必须非 0，否则先命中「端口空闲」分支。
// 本机实测：本插件启动的 dsh 是 node.exe，监听 3080，pid 9692；
// 它陪跑的那次 snapshot() 里 externalName 为空（dsh 是本插件自己的子进程，externalPid 为 0），
// 但 portDsh 为 true（命令行里能看到 @deepseek-ai\dsh\lib\bin.js）—— 那才是「是我的 dsh」的证据。
test('C5：端口由本插件的 dsh 监听（selfOwned + portDsh）→ ok，不得降级成「无法判定」', () => {
  const c5 = diag.CHECKS.find((c) => c.id === 'port-dsh')
  const self = c5.detect(diag.buildContext({ home: 'X', portState: { pid: 9692, name: '', selfOwned: true, portDsh: true } }))
  assert.equal(self.ok, true, '自己启动的 dsh 占着端口是正常态')
  assert.equal(diag.severestLevel(self.findings), '', '不应产生任何 finding')
  assert.ok(/本插件/.test(self.summary), '摘要应说明是本插件的 dsh')
  // selfOwned 不该盖过「被别人占用」的判断（前者是正常，后者是 error）
  const other = c5.detect(diag.buildContext({ home: 'X', portState: { pid: 11, occupiedByOther: 'nginx', selfOwned: true } }))
  assert.equal(diag.severestLevel(other.findings), 'error', '被非 dsh 占用仍须报 error')
  // 真正判不出来时（有 pid 但没拿到命令行）仍走「无法判定」warning
  const unknown = c5.detect(diag.buildContext({ home: 'X', portState: { pid: 4242, name: '' } }))
  assert.equal(diag.severestLevel(unknown.findings), 'warn')
})

// ⚠️ 本机实测（2026-09-22）暴露的回归：插件启动的 dsh 曾被误报成「外部进程在跑」。
// 根因在 dsh.js 侧：Windows 下 spawn 走 shell:true，插件拿到 cmd.exe 的 pid、
// 监听 3080 的是它的子进程 node.exe → externalPid() 的 `probe.pid === state.pid` 认不出，
// 于是 externalPid 非 0，C5 在「外部 dsh」分支就返回了，永远走不到本插件的 [✓]。
// 修法是父链上溯（probe.selfOwned）。这里钉住两条：
//   1. externalPid 为空 + selfOwned → 必须 [✓]（修复目标）
//   2. externalPid 非空 → 仍是 [!]（不能矫枉过正，真的外部 dsh 该照报）
test('C5：命令行拿不到但进程树证明是自己人（selfOwned）→ 仍报 ok，不得误报「外部进程」', () => {
  const c5 = diag.CHECKS.find((c) => c.id === 'port-dsh')
  // 命令行取不到（wmic 已从新版 Windows 移除 / powershell CIM 超时）→ portDsh 为 null
  const onlyTree = c5.detect(diag.buildContext({
    home: 'X',
    portState: { pid: 12488, name: 'node', selfOwned: true, portDsh: null },
  }))
  assert.equal(onlyTree.ok, true, '父链证据足够，不依赖命令行')
  assert.equal(diag.severestLevel(onlyTree.findings), '')
  assert.ok(/本插件/.test(onlyTree.summary))
  // 反例：真·外部 dsh（externalPid 非 0）即使 selfOwned 字段缺失也必须照报 [!]
  const ext = c5.detect(diag.buildContext({
    home: 'X',
    portState: { pid: 5232, name: 'node', externalPid: 5232, portDsh: true },
  }))
  assert.equal(ext.ok, false, '真外部 dsh 不能被「自己人」逻辑吞掉')
  assert.equal(diag.severestLevel(ext.findings), 'warn')
})

// ⚠️ 本机实测（2026-09-22）的**第二处**自相矛盾：状态卡「运行中 · pid 26916」，
// 诊断卡同时报「3080 空闲（无进程监听）」。
// 根因在 detectPort 的口径：pid 字段被当成「谁在监听端口」，实际填的是「外部占用者」，
// 本插件自己启的 dsh 两个来源都为空（externalPid=0、portOther=''）→ pid 置 0 →
// C5 的 `if (!ps.pid)` 判成空闲。修法是改用 snapshot().portPid（端口上到底有没有人）。
// 这条钉住：「自己人监听着」绝不能报空闲，且必须一路走到 [✓]。
test('C5：本插件自己的 dsh 在监听 → 报「由本插件监听」，绝不是「空闲」', () => {
  const c5 = diag.CHECKS.find((c) => c.id === 'port-dsh')
  const own = c5.detect(diag.buildContext({
    home: 'X',
    portState: { pid: 28216, name: 'node', selfOwned: true, portDsh: true },
  }))
  assert.equal(own.ok, true)
  assert.ok(!/空闲/.test(own.summary), '端口上有人，绝不能报空闲（本机实测的回归点）')
  assert.ok(/本插件/.test(own.summary))
  assert.ok(/28216/.test(own.summary), '要报出真正的监听 pid，而不是插件的 cmd 包装进程 pid')
  // 真·空闲（pid 0）时仍要报空闲，不能因为上面加了兜底就一律说「有人」
  const idle = c5.detect(diag.buildContext({ home: 'X', portState: { pid: 0 } }))
  assert.equal(idle.ok, true)
  assert.ok(/空闲/.test(idle.summary), 'pid 为 0 才是真空闲')
})

// ── 单项抛错隔离（§3.2 约定 2）──
test('runChecks：单项抛错只标记该项 threw，其余项照常出结果、整轮不崩', () => {
  const boom = {
    id: 'boom',
    title: '会炸的项',
    severity: 'critical',
    fixable: false,
    detect() { throw new Error('模拟炸掉') },
  }
  diag.CHECKS.push(boom)
  try {
    const ctx = diag.buildContext({ home: '', portState: { pid: 0 } })
    const results = diag.runChecks(ctx)
    const hit = results.find((r) => r.id === 'boom')
    assert.equal(hit.threw, true)
    assert.equal(hit.ok, false)
    assert.match(hit.findings[0].text, /模拟炸掉/)
    // 其余项仍然在（不因为一个抛错就整体中断）
    assert.ok(results.length > 1)
    assert.ok(results.some((r) => r.id === 'patch-syntax'))
    // 抛错算整轮失败（这是真异常，与 C5 的「判不出来」不同）
    assert.equal(diag.overallOk(results), false)
  } finally {
    diag.CHECKS.splice(diag.CHECKS.indexOf(boom), 1)
  }
})

// ── looksLikeDsh：C5 判据的纯函数底座（三态，D13 可单测）──
// 样例全部取自本机实测（2026-09-22）：
//   · 真 dsh 由 npm 全局安装 → "...\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open"
//   · 本机另外两个 node 进程 → npm-cli.js run dev / vite.js（都不含 dsh 特征）
//   · 我起的探针 → 裸 `node -e "net.createServer().listen(3080)"`
// 判据必须把这三种分开：前 true，后两种 false。
test('looksLikeDsh：真 dsh 命令行 → true；别的 node 程序 → false；空/拿不到 → null', () => {
  const dsh = require('../public/preload/lib/dsh.js')
  assert.equal(dsh.looksLikeDsh(
    '"D:\\nodejs\\node.exe" D:\\nodejs\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --no-open'), true)
  // 全局 dsh 的 .cmd / .js 包装入口
  assert.equal(dsh.looksLikeDsh('node C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\bin.js'), true)
  // 本机真实的其他 node 进程：名字同样是 node.exe，但绝不能认成 dsh
  assert.equal(dsh.looksLikeDsh('"D:\\nodejs\\node.exe" D:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run dev'), false)
  assert.equal(dsh.looksLikeDsh('"D:\\nodejs\\node.exe" e:\\Github\\Balance-Whale-Widget\\node_modules\\vite\\bin\\vite.js'), false)
  // 场景 ③ 的那个探针
  assert.equal(dsh.looksLikeDsh('node -e "require(\'net\').createServer().listen(3080)"'), false)
  // 拿不到命令行 / 空串 = 判不出来，返回 null（调用方按 D26 报「无法确认」）
  assert.equal(dsh.looksLikeDsh(''), null)
  assert.equal(dsh.looksLikeDsh('   '), null)
  assert.equal(dsh.looksLikeDsh(undefined), null)
  assert.equal(dsh.looksLikeDsh(null), null)
})

// ── isDescendantOf：进程父链上溯（C5 判「3080 是不是本插件启的那份」的底座）──
// 修的是本机实测（2026-09-22）的自相矛盾：插件 spawn 的是 cmd.exe(28260)，
// 真正监听 3080 的是它的子进程 node.exe(12488)，单比 pid 会把自己的 dsh 误报成「外部」。
// 参数是 `pid → 父pid` 邻接表，纯函数，不碰真实进程。
test('isDescendantOf：沿父链能认出「孙进程」，中间隔一层 cmd 也要认出来', () => {
  const dsh = require('../public/preload/lib/dsh.js')
  // 本机实测链：插件(100) → cmd.exe(28260) → node.exe(12488 监听 3080)
  const parents = { 12488: 28260, 28260: 100, 100: 0 }
  assert.equal(dsh.isDescendantOf(12488, 100, parents), true, '隔一层 cmd 的孙进程必须认出')
  assert.equal(dsh.isDescendantOf(28260, 100, parents), true, '直接子进程')
  assert.equal(dsh.isDescendantOf(100, 100, parents), false, '自身不算自己的后代')
  // 外人：父链上溯到头(0)也遇不到 self
  const foreign = { 999: 888, 888: 0 }
  assert.equal(dsh.isDescendantOf(999, 100, foreign), false, '别的进程树绝不能认成自己人')
  assert.equal(dsh.isDescendantOf(999, 100, parents), false, '陌生 pid 不在表里 → false')
})

test('isDescendantOf：限量与防环，坏数据不得死循环', () => {
  const dsh = require('../public/preload/lib/dsh.js')
  // 环：父 pid 被复用造成的 a→b→a，必须在 seen 处停下
  const cyc = { 1: 2, 2: 1 }
  assert.equal(dsh.isDescendantOf(1, 100, cyc), false, '环必须被 seen 拦住')
  assert.equal(dsh.isDescendantOf(1, 2, cyc), true, '环里若 self 就是父，仍应命中')
  // 深链超过限量（默认 8 层）→ 不追，返回 false（宁可报「无法判定」也不猜）
  const deep = {}
  for (let i = 1; i <= 20; i++) deep[i] = i + 1
  deep[20] = 0
  assert.equal(dsh.isDescendantOf(1, 21, deep), false, '超出上溯限量 → false')
  // 空/拿不到父（processParent 返回 0）→ 立即停
  assert.equal(dsh.isDescendantOf(5, 100, { 5: 0 }), false)
  assert.equal(dsh.isDescendantOf(0, 100, {}), false, 'from 为 0 → false')
  assert.equal(dsh.isDescendantOf(5, 0, { 5: 100 }), false, 'self 为 0（插件没启动）→ false')
})

// ── probePort 轮次号（gen）：诊断要拿到新鲜结果，不能被「正在跑的旧轮」顶掉 ──
// 修的是本机实测（2026-09-22）的自相矛盾：状态卡显示「运行中 · pid 37112」，
// 诊断卡同时报「3080 空闲」——netstat 明摆着 28216 在监听。
// 根因是 probePort 的排队复用：watchReady 每 1.2s 探一次，诊断点「强制重跑」时
// 蹭上了正在跑的那一轮，而那一轮的 netstat 是在 dsh 还没 bind 时跑的（空结果）。
// 修法：detectPort 传 force=true 另起一轮，并用 gen 保证只让最新一轮写结果/放行 waiters。
test('probePort：force 另起一轮，旧轮不得覆盖新轮结果（gen 是唯一写口）', () => {
  const dsh = require('../public/preload/lib/dsh.js')
  assert.equal(typeof dsh.probePort, 'function', 'probePort 必须导出（白盒验证 gen 行为）')
  assert.equal(typeof dsh.__probeState, 'function', '需要 __probeState 读内部 probe 供断言')
  // 不真跑 netstat（环境相关、慢），只验 gen 单调递增 + 旧轮 stale 判定
  const g0 = dsh.__probeState().gen
  const stale = dsh.__isStale(g0, g0 + 1)
  assert.equal(stale, true, 'gen 不一致 → 旧轮作废，不许写 probe')
  assert.equal(dsh.__isStale(g0 + 1, g0 + 1), false, 'gen 相同 → 最新轮，可以写')
  assert.equal(dsh.__isStale(g0, g0), false)
})

// ── C1 指纹判据（D25 必测）──
test('D25：指纹只认 name+version，路径不同也判为「同一份装了两遍」', () => {
  const a = { name: '@deepseek-ai/cordis', version: '1.2.3', dir: 'C:\\A\\node_modules\\x' }
  const b = { name: '@deepseek-ai/cordis', version: '1.2.3', dir: '/totally/different/path' }
  assert.equal(diag.sameFingerprint(a, b), true, '路径不同但指纹相同 → 命中')
  // 版本不同不算同一份
  assert.equal(diag.sameFingerprint(a, Object.assign({}, b, { version: '9.9.9' })), false)
  // 名字不同不算
  assert.equal(diag.sameFingerprint(a, Object.assign({}, b, { name: '@deepseek-ai/other' })), false)
  // 缺任一侧
  assert.equal(diag.sameFingerprint(null, b), false)
  assert.equal(diag.sameFingerprint(a, null), false)
})

test('C1：profile 未声明 @deepseek-ai 依赖时直接判无风险，不做多余遍历', () => {
  const home = makeHome({
    'profiles/web/package.json': JSON.stringify({ name: 'web', dependencies: { lodash: '^4' } }),
  })
  const c1 = diag.CHECKS.find((c) => c.id === 'duplicate-modules')
  const f = c1.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(f.ok, true)
  assert.equal(diag.severestLevel(f.findings), '')
})

test('C1：同一版本装两遍（本地 + 全局候选目录）报 error', () => {
  // 全局那份必须落在 globalModuleRoots() 认得的候选目录里，且该目录要**实际存在**。
  // 这里借 %APPDATA%\npm\node_modules —— 它是候选之一，且可以整个放进临时目录里安全造删。
  // ⚠️ 绝不能拿 path.dirname(process.execPath) 下的 node_modules 做实验：那是真实的
  // Node 安装目录，用例结尾的清理会把它整棵删掉。
  const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diag-appdata-'))
  const realAppData = process.env.APPDATA
  process.env.APPDATA = fakeAppData
  const globalPkg = path.join(fakeAppData, 'npm', 'node_modules', '@deepseek-ai', 'cordis')
  fs.mkdirSync(globalPkg, { recursive: true })
  fs.writeFileSync(path.join(globalPkg, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/cordis', version: '1.2.3' }))

  const home = makeHome({
    'profiles/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@deepseek-ai/cordis': '^1' } }),
    'profiles/web/node_modules/@deepseek-ai/cordis/package.json':
      JSON.stringify({ name: '@deepseek-ai/cordis', version: '1.2.3' }),
  })
  try {
    const c1 = diag.CHECKS.find((c) => c.id === 'duplicate-modules')
    const f = c1.detect(diag.buildContext({ home, profile: 'web' }))
    assert.equal(diag.severestLevel(f.findings), 'error')
    assert.match(f.findings[0].text, /装了两遍/)
  } finally {
    if (realAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = realAppData
    try { fs.rmSync(fakeAppData, { recursive: true, force: true }) } catch (_) {}
  }
})

test('C1：同一包但版本不同 → warn（不是路径分裂，但也别当无事）', () => {
  const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diag-appdata-'))
  const realAppData = process.env.APPDATA
  process.env.APPDATA = fakeAppData
  const globalPkg = path.join(fakeAppData, 'npm', 'node_modules', '@deepseek-ai', 'cordis')
  fs.mkdirSync(globalPkg, { recursive: true })
  fs.writeFileSync(path.join(globalPkg, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/cordis', version: '9.9.9' }))

  const home = makeHome({
    'profiles/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@deepseek-ai/cordis': '^1' } }),
    'profiles/web/node_modules/@deepseek-ai/cordis/package.json':
      JSON.stringify({ name: '@deepseek-ai/cordis', version: '1.2.3' }),
  })
  try {
    const c1 = diag.CHECKS.find((c) => c.id === 'duplicate-modules')
    const f = c1.detect(diag.buildContext({ home, profile: 'web' }))
    assert.equal(diag.severestLevel(f.findings), 'warn')
    assert.match(f.findings[0].text, /两份不同版本/)
  } finally {
    if (realAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = realAppData
    try { fs.rmSync(fakeAppData, { recursive: true, force: true }) } catch (_) {}
  }
})

test('C1：声明了但本地没装 → warn（可能起不来，但不是路径分裂）', () => {
  const home = makeHome({
    'profiles/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@deepseek-ai/cordis': '^1' } }),
  })
  const c1 = diag.CHECKS.find((c) => c.id === 'duplicate-modules')
  const f = c1.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(diag.severestLevel(f.findings), 'warn')
})

// ── C2 patch 条目缺失 ──
// ⚠️ patch 文件必须放在 profiles/<n>/ 下（真实布局）。早先测试把它放在 home 根目录，
// 与代码里少写一层 profiles/<n> 的错误路径恰好对上，于是双双通过 —— 本机实测才发现
// 真实的 profiles/web/cordis.patch.yml 从未被读到，C2/C3 恒报「未使用 patch」假通过。
//
// ⚠️⚠️ 判据三次翻车后定为「**采信 dsh 自己打印的 not found 警告行**」。
// 前两版都在「自己造已知 id 清单」上栽了（dependencies 包名 → 11 条全误报；
// 上溯 bundle 的 dsh.bundle.patch insert id → 剩 2 条误报）；第三版改成比对 dump 的
// entries 仍不对 —— 因为 dump 的 entries **不完整**：`mnemon-bundle` 的 `config:` 列表里
// 嵌套了 8 个子条目（mnemon / mnemon-source-* / mnemon-strategy-*），parseDump 只认行首
// `^- id:` 故一个都没进 entries。本机真相是「12 条 patch 里 11 条合法，只有 config-manager
// 真的不存在」，比对 entries 会报 9 条（8 假阳性 + 1 真阳性），靠巧合才没漏掉真的那个。
// 所以测试一律「喂一份含 warnings 的 dump 缓存」，钉住「dsh 说谁是 not found 才是 not found」。
// 往共享的 dbStorage 桩里塞一份转储缓存（test.afterEach 会 store.clear()，不会串到下一条）。
// 传 null 表示「没有缓存」。notFound 是 dsh 报告的 not-found id 数组（省略即「dsh 没报任何」）。
function stubDumpCache(notFound, profile) {
  if (!notFound) { store.delete(K.dshDump); return }
  const warnings = (notFound === true ? [] : notFound).map((id) => ({ id: id, line: 1 }))
  store.set(K.dshDump, {
    ok: true, at: Date.now(), profile: profile || 'web', layers: [], entries: [], warnings: warnings,
  })
}

test('C2：dsh 报 entry not found → error（采信 dsh 原话，行号从 patch 文件补）', () => {
  stubDumpCache(['config-manager'])
  const home = makeHome({
    'profiles/web/cordis.patch.yml': '- id: webserver\n  disabled: true\n- id: config-manager\n  disabled: true\n',
  })
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  const f = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(f.ok, false)
  assert.equal(diag.severestLevel(f.findings), 'error')
  assert.equal(f.findings.length, 1, 'dsh 只报了 1 个，就不能报第 2 个')
  assert.match(f.findings[0].text, /第 3 行的 id "config-manager"/, '行号要落到 patch 文件里真正那一行')
  assert.match(f.findings[0].hint, /entry "config-manager" not found/)
  // 提示口径回归：真因常是「bundle 没装 / 条目改名」，不是拼写。
  // 早先 hint 只写「请核对拼写」，实测这 8 个 mnemon-* 拼写全对却报 not found ——
  // 照着「核对拼写」改不出结果，反而容易把正确的 patch 改坏。故钉住「拼写只是可能之一」
  assert.match(f.findings[0].hint, /bundle/, '要提到「该 id 由 bundle insert、bundle 没装」这个真因')
  assert.match(f.findings[0].hint, /配置转储/, '要给出「去转储对照确认该 id 是否还在」的下一步')
})

// 这是本机真实形状、也是本版判据的核心回归：patch 12 条里 11 条合法，dsh 只报 config-manager。
// 上一版（比对 dump entries）会在这里报 9 条 —— 8 条嵌套子条目被误判。
test('C2：dsh 没报的 id 一律不出 finding（嵌套子条目不在 entries 里也不许误报）', () => {
  stubDumpCache(['config-manager'])
  const home = makeHome({
    // 这 11 条全是本机真实存在、dsh 也认得的 —— 但它们**大多不在** dump 的 entries 里
    'profiles/web/cordis.patch.yml': [
      '- id: webserver', '  config:', '    port: 3080',
      '- id: modlens', '  disabled: true',
      '- id: mnemon-bundle', '  disabled: true',
      '- id: mnemon', '  disabled: true',
      '- id: mnemon-source-runtime', '  disabled: true',
      '- id: mnemon-source-documents', '  disabled: true',
      '- id: mnemon-source-memory-spaces', '  disabled: true',
      '- id: mnemon-strategy-default-three-tier', '  disabled: true',
      '- id: mnemon-strategy-auto-capture', '  disabled: true',
      '- id: mnemon-strategy-light-context', '  disabled: true',
      '- id: mnemon-strategy-scoped', '  disabled: true',
      '- id: config-manager', '  disabled: true',
      '',
    ].join('\n'),
  })
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  const f = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(f.findings.length, 1, '12 条里只有 config-manager 是真错，必须只报它一条')
  assert.match(f.findings[0].text, /"config-manager"/)
  assert.match(f.summary, /^1 个 patch 条目对不上$/)
})

test('C2：dsh 跑过且没报 not found → 全部判 ok', () => {
  stubDumpCache(true)
  const home = makeHome({
    'profiles/web/cordis.patch.yml': '- id: webserver\n  disabled: true\n- id: mnemon-bundle\n  disabled: true\n',
  })
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  const f = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(f.ok, true)
  assert.equal(f.findings.length, 0)
  assert.match(f.summary, /dsh 全部认得/)
})

// 这是防误报的核心回归：拿不到 dsh 的结论时**绝不能**因为「我这侧查不到」就报 error。
// 改判据前的版本正是在这里把 11 条合法 patch 判成 [✗]，会诱导用户去改本来正确的配置。
test('C2：拿不到 dump 时报 warning 提示，绝不报 error（防误报回归）', () => {
  stubDumpCache(null)
  const home = makeHome({
    'profiles/web/cordis.patch.yml': '- id: config-manager\n  disabled: true\n- id: mnemon-bundle\n  disabled: true\n',
  })
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  const f = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(diag.severestLevel(f.findings), 'warn', '拿不到 dsh 的结论只能说「无法判定」，不能报 error')
  assert.match(f.summary, /无法判定/)
  assert.match(f.findings[0].hint, /配置转储/)
})

test('C2：dump 缓存的 profile 与当前 profile 不符时不拿来判定（换 profile 后不能串用）', () => {
  stubDumpCache(['config-manager'], 'cli')
  const home = makeHome({
    'profiles/web/cordis.patch.yml': '- id: config-manager\n  disabled: true\n',
  })
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  const f = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(diag.severestLevel(f.findings), 'warn', 'cli 的 dump 结论不能用来判 web 的 patch')
})

// 老版本（v1.6.2 之前）的缓存里没有 warnings 字段。此时必须按「拿不到」处理 ——
// 若把它当成空数组，就等于宣称「dsh 没报任何 not found」，会把真错也判成合法（假通过）。
test('C2：缓存里没有 warnings 字段（旧缓存）时按「拿不到」处理，不得当成「没问题」', () => {
  store.set(K.dshDump, { ok: true, at: Date.now(), profile: 'web', layers: [], entries: [] })
  const home = makeHome({
    'profiles/web/cordis.patch.yml': '- id: config-manager\n  disabled: true\n',
  })
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  const f = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(diag.severestLevel(f.findings), 'warn')
  assert.match(f.summary, /无法判定/)
})

test('C2：能读到 profiles/<n>/cordis.patch.yml（真实布局，防「少一层目录」回归）', () => {
  stubDumpCache(['config-manager'])
  const home = makeHome({
    'profiles/web/cordis.patch.yml': '- id: config-manager\n  replace: {}\n',
  })
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  const f = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.ok(!/未使用 patch/.test(f.summary), 'profile 下有 patch 文件时必须真去读，不能报「未使用 patch」')
})

test('C2：patch 只存在于 home 根目录（非真实布局）时按「无 patch」处理', () => {
  stubDumpCache(['config-manager'])
  const home = makeHome({
    'cordis.patch.yml': '- id: config-manager\n  replace: {}\n',
  })
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  const f = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.match(f.summary, /未使用 patch/, '根目录那份不是 dsh 会读的，不该拿它判 patch 条目')
})

test('C2：profile 不同则读不同的 patch 文件（profiles/<n> 这一层必须带 profile）', () => {
  stubDumpCache(['not-exist'])
  const home = makeHome({
    'profiles/web/cordis.patch.yml': '- id: not-exist\n  replace: {}\n',
  })
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  // web 下有 patch，且 dsh 报了 not-exist → 报错
  const fw = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(fw.ok, false)
  // cli 下没有 patch → 跳过，不能串到 web 那份
  const fc = c2.detect(diag.buildContext({ home, profile: 'cli' }))
  assert.match(fc.summary, /未使用 patch/)
})

test('C2：没有 patch 文件属正常状态，判 ok 且不刷 finding', () => {
  stubDumpCache(['config-manager'])
  const home = makeHome({})
  const c2 = diag.CHECKS.find((c) => c.id === 'patch-entry-missing')
  const f = c2.detect(diag.buildContext({ home, profile: 'web' }))
  assert.equal(f.ok, true)
  assert.equal(f.findings.length, 0)
})

// ── C3 / scanPatchLines ──
test('scanPatchLines：Tab 缩进 / `- id:` 空值 / `!!js` 引号未闭 / 重复 id 都能识别', () => {
  const text = [
    '- id: a',
    '\tbad: tab-indent',
    '- id:',
    '- id: "b"',
    '- id: b',
    '  js: !!js "unclosed',
  ].join('\n')
  const f = diag.scanPatchLines(text)
  const texts = f.map((x) => x.text).join(' | ')
  assert.match(texts, /Tab 缩进/)
  assert.match(texts, /没有值/)
  assert.match(texts, /重复的 id "b"/)
  assert.match(texts, /引号未闭合/)
})

test('scanPatchLines：正常的 patch 不产生 finding；空文件也不产生', () => {
  assert.deepEqual(diag.scanPatchLines('- id: a\n  replace: {}\n- id: b\n  replace: {}\n'), [])
  assert.deepEqual(diag.scanPatchLines(''), [])
  assert.deepEqual(diag.scanPatchLines('   \n\n'), [])
})

test('extractPatchIds 抽出 id 与行号，跳过注释行与带引号形式', () => {
  const ids = diag.extractPatchIds('# 注释\n- id: alpha\n- id: "beta"\nreplace: 1\n')
  assert.deepEqual(ids, [{ id: 'alpha', line: 2 }, { id: 'beta', line: 3 }])
})

// C3 的 detect 必须真去读 profiles/<n>/cordis.patch.yml。
// （原先只有 scanPatchLines 纯函数测试，路径少一层 profiles/<n> 的 bug 因此完全没被覆盖）
test('C3：能从 profiles/<n>/cordis.patch.yml 读到内容并报出行级问题', () => {
  const home = makeHome({
    'profiles/web/package.json': JSON.stringify({ name: 'web' }),
    'profiles/web/cordis.patch.yml': '- id: a\n\tbad: tab-indent\n',
  })
  const c3 = diag.CHECKS.find((c) => c.id === 'patch-syntax')
  const f = c3.detect(diag.buildContext({ home, profile: 'web' }))
  assert.ok(!/无 cordis\.patch\.yml/.test(f.summary), 'profile 下有 patch 文件时不能报「无 cordis.patch.yml（跳过）」')
  assert.equal(f.ok, false)
  assert.match(f.findings.map((x) => x.text).join(' | '), /Tab 缩进/)
})

test('C3：profile 下没有 patch 文件才跳过（根目录那份不算）', () => {
  const home = makeHome({ 'cordis.patch.yml': '- id: a\n\tbad: tab-indent\n' })
  const c3 = diag.CHECKS.find((c) => c.id === 'patch-syntax')
  const f = c3.detect(diag.buildContext({ home, profile: 'web' }))
  assert.match(f.summary, /无 cordis\.patch\.yml/, 'dsh 不读根目录那份，不该拿它做语法扫描')
})

// ── C4 settings.yaml ──
test('C4：settings.yaml 可读且结构正常 → ok；Tab 缩进 → error', () => {
  const good = makeHome({ 'settings.yaml': 'model: gpt-5\nport: 3080\n' })
  const c4 = diag.CHECKS.find((c) => c.id === 'settings-yaml')
  const okF = c4.detect(diag.buildContext({ home: good }))
  assert.equal(okF.ok, true)
  assert.match(okF.summary, /2 个顶层配置项/)

  cleanup()
  const bad = makeHome({ 'settings.yaml': 'model:\n\tgpt-5\n' })
  const badF = c4.detect(diag.buildContext({ home: bad }))
  assert.equal(diag.severestLevel(badF.findings), 'error')
})

// ── buildContext ──
test('buildContext 补齐默认值（port 默认取 DSH_PORT_DEFAULT、profile 默认 web），脏入参不抛错', () => {
  const c = diag.buildContext()
  assert.equal(c.port, 3080)
  assert.equal(c.profile, 'web')
  assert.equal(c.home, '')
  assert.equal(c.portState, null)
  const c2 = diag.buildContext({ port: 1234, profile: 'cli', home: 'H' })
  assert.equal(c2.port, 1234)
  assert.equal(c2.profile, 'cli')
  assert.equal(c2.home, 'H')
})

// 端口可配（设置页「高级选项」）后，C5 的检查项 id 不能再叫 port-3080 ——
// 它得跟着端口走，且 title 里不再写死端口号（端口号由 ctx.port 渲染进 summary/findings）
test('C5：id 为 port-dsh（不写死端口），title 不含端口号', () => {
  const c5 = diag.CHECKS.find((c) => c.id === 'port-dsh')
  assert.ok(c5, 'id 必须是 port-dsh')
  assert.ok(!/3080/.test(c5.title), 'title 不写死端口号，否则端口一改标题就骗人')
  assert.ok(!diag.CHECKS.some((c) => c.id === 'port-3080'), '旧的 port-3080 id 应已不存在')
})

// C5 的所有文案都要跟着 ctx.port 走：端口换了，摘要/明细里必须出现新端口而不是 3080
test('C5：摘要按 ctx.port 渲染（换成 4080 时不得出现 3080）', () => {
  const c5 = diag.CHECKS.find((c) => c.id === 'port-dsh')
  const idle = c5.detect(diag.buildContext({ home: 'X', port: 4080, portState: { pid: 0 } }))
  assert.match(idle.summary, /4080/)
  assert.ok(!/3080/.test(idle.summary), '端口换成 4080 后摘要里不该再出现 3080')
  const other = c5.detect(diag.buildContext({ home: 'X', port: 4080, portState: { pid: 11, occupiedByOther: 'nginx' } }))
  assert.match(other.summary, /4080/)
  assert.match(other.findings[0].text, /4080/)
  assert.ok(!/3080/.test(other.findings[0].text))
})

// ── 缓存（D6）──
test('缓存三件套：写入后可读回，清除后读不到', () => {
  assert.equal(diag.readCache(), null)
  const payload = { ok: true, at: Date.now(), cached: false, pass: 5, bad: 0, results: [], env: {} }
  diag.writeCache(payload)
  const back = diag.readCache()
  assert.equal(back.pass, 5)
  assert.equal(store.has(K.dshDiagnose), true, '键必须走 constants 的 K 表，不能手写字符串')
  diag.clearDshDiagnoseCache()
  assert.equal(diag.readCache(), null)
})

test('readCache 对残缺缓存（缺 at / 缺 results）返回 null，不会让调用方拿到半截数据', () => {
  store.set(K.dshDiagnose, { pass: 1 })
  assert.equal(diag.readCache(), null)
  store.set(K.dshDiagnose, { at: Date.now(), results: 'not-an-array' })
  assert.equal(diag.readCache(), null)
})

// ── cacheHit（设置页按钮接线曾把 force 写死成 true，导致缓存永远不生效）──
test('cacheHit：TTL 内的缓存命中，超时或 force 都不命中', () => {
  const now = 1_000_000
  const ttl = diag.DIAGNOSE_TTL_MS
  const fresh = { at: now - 1000, profile: 'web' }
  assert.equal(diag.cacheHit(fresh, ttl, now, {}), true, 'TTL 内应命中')
  assert.equal(diag.cacheHit(fresh, ttl, now, { force: false }), true, 'force:false 等同不传')
  assert.equal(diag.cacheHit(fresh, ttl, now, { force: true }), false, '「强制重跑」必须作废缓存')
  // 边界：刚好等于 TTL 视为过期（< 而非 <=）
  assert.equal(diag.cacheHit({ at: now - ttl }, ttl, now, {}), false, 'TTL 边界应算过期')
  assert.equal(diag.cacheHit({ at: now - ttl + 1 }, ttl, now, {}), true, 'TTL 内一刻应命中')
})

test('cacheHit：无缓存 / 结构不全 / at 非法都不命中，绝不因脏数据复用', () => {
  const now = 1_000_000
  const ttl = diag.DIAGNOSE_TTL_MS
  assert.equal(diag.cacheHit(null, ttl, now, {}), false)
  assert.equal(diag.cacheHit(undefined, ttl, now, {}), false)
  assert.equal(diag.cacheHit('cache', ttl, now, {}), false, '非对象一律不命中')
  assert.equal(diag.cacheHit({}, ttl, now, {}), false, '缺 at')
  assert.equal(diag.cacheHit({ at: 'soon' }, ttl, now, {}), false, 'at 非数字')
  assert.equal(diag.cacheHit({ at: 0 }, ttl, now, {}), false, 'at 为 0')
  assert.equal(diag.cacheHit({ at: NaN }, ttl, now, {}), false, 'at 为 NaN')
})

test('cacheHit：profile 变了必须作废（否则切 profile 会读到上一棵树的转储）', () => {
  const now = 1_000_000
  const ttl = 60 * 1000
  const hit = { at: now - 1000, profile: 'web' }
  assert.equal(diag.cacheHit(hit, ttl, now, { profile: 'web' }), true, '同 profile 命中')
  assert.equal(diag.cacheHit(hit, ttl, now, { profile: 'cli' }), false, '换 profile 不命中')
  // 不传 profile 时不做这项校验（诊断的缓存没有 profile 维度）
  assert.equal(diag.cacheHit(hit, ttl, now, {}), true)
  assert.equal(diag.cacheHit({ at: now - 1000 }, ttl, now, { profile: 'web' }), false, '缓存无 profile 而要求匹配时按不命中处理')
})
