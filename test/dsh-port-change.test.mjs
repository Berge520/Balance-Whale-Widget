/*
 * dsh「改配置端口」时的状态语义回归（public/preload/lib/dsh.js 的 configure / snapshot）
 *
 * 背景（2026-09-26 用户实测反馈）：
 *   dsh 在 3080 上跑得好好的（状态「运行中 · pid x（就绪用时 3.8s）」），用户**没点启动**、
 *   只是把设置页端口改成 3081，界面立刻变成「启动中…（3081 未就绪，已等待 22 秒）」。
 *
 * 根因：configure() 换端口时无条件把 state.ready 置 false，而 state.child（旧进程）还活着，
 * 于是快照出现 running=true + ready=false 这个**本来不存在**的组合，前端按「新端口在启动」渲染。
 * 修复：把「配置端口」与「进程实际监听的端口」拆成 state.port / state.runPort 两个概念，
 * 进程活着时不动 ready（它描述 runPort 上的事实），另外暴露 needsPortRestart 给界面。
 *
 * 本文件钉的就是这条边界，重点是**不许再出现误报的「启动中」组合**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createRequire } from 'node:module'

// ── utools 桩 ──
// configure() 的入参是**完整配置对象**（调用方一律走 syncConfig → readConfig()），
// 所以只喂 { dshPort } 会被当成「其余项取默认」而没有意义 —— 这里直接挂一个假的
// whale:config 存储，让 readConfig() 读出我们想要的端口，测试路径与线上一致。
const CONFIG_KEY = 'whale:config'
let stored = { dshPort: 3080 }
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: {
    getItem: (k) => (k === CONFIG_KEY ? stored : null),
    setItem: () => {},
    removeItem: () => {},
  },
}

const require = createRequire(import.meta.url)
const dsh = require('../public/preload/lib/dsh.js')
const { configure, snapshot, readConfig, __state: st, __probe: probe } = dsh

// 端口变更一律经 readConfig() 归一化后再 configure()，与 syncConfig() 同路径
const setPort = (p) => { stored = { dshPort: p }; configure(readConfig()) }
const CFG = { dshPort: 3080, dshNodeDir: '', dshKeepAlive: false, dshNoOpen: true }

// 模拟 start() 之后的内存态：有子进程、已在 runPort 上就绪
function pretendRunning({ port = 3080, version = '' } = {}) {
  st.child = { pid: 12345, on() {} }
  st.pid = 12345
  st.runPort = port
  st.port = port
  st.ready = true
  st.readyAt = Date.now()
  st.runVersion = version
}
function resetState() {
  st.child = null
  st.pid = 0
  st.ready = false
  st.readyAt = 0
  st.runPort = 0
  st.runVersion = ''
  st.extRunPort = 0
  st.extRunPid = 0
  st.extRunName = ''
}

// configure() 只改内存态，不 spawn；snapshot() 只读内存 + 已算好的 probe 结果。
// 所以整组用例可以纯内存跑，不碰真实端口。
test.afterEach(() => {
  resetState()
  stored = { dshPort: 3080 }
  configure({ ...CFG, dshPort: 3080 })
})

// ──────────────────────────────────────────────
// ① 没进程在跑：换端口 = 干净的重置
// ──────────────────────────────────────────────
test('没进程在跑时换端口：runPort 归零、不报 needsPortRestart', () => {
  setPort(3080)
  setPort(3081)
  const s = snapshot()
  assert.equal(s.port, 3081)
  assert.equal(s.runPort, 0)
  assert.equal(s.needsPortRestart, false)
})

// ──────────────────────────────────────────────
// ② 关键回归：进程在跑时只改配置端口
//    断言的核心是「不能出现 running=true + ready=false」这个误报组合
// ──────────────────────────────────────────────
test('运行中改配置端口：仍是运行中，不出现「未就绪」误报', () => {
  setPort(3080)
  pretendRunning({ port: 3080 })

  setPort(3081) // ← 用户只是改了配置，没点启动

  const s = snapshot()
  assert.equal(s.port, 3081, '配置端口应已更新')
  assert.equal(s.running, true, '旧进程还活着，仍算运行中')
  assert.equal(s.runPort, 3080, '实际监听的还是旧端口')
  assert.equal(s.ready, true, 'ready 描述 runPort 上的事实，不能被换配置抹掉')
  assert.equal(s.needsPortRestart, true, '应提示「需重启才切到新端口」')
  // 这条是本 bug 的正面判据：界面据此渲染「运行中」而不是「启动中…未就绪」
  assert.ok(!(s.running && !s.ready), '运行中 + 未就绪 = 用户看到的错误状态，不允许出现')
})

// ──────────────────────────────────────────────
// ③ 运行时又有「更新版本」又有「改端口」：两个提示都要在，互不吃掉
// ──────────────────────────────────────────────
test('端口与版本同时变更：needsRestart 与 needsPortRestart 各自独立算出', () => {
  setPort(3080)
  pretendRunning({ port: 3080, version: '0.1.7' })

  setPort(3081)
  const s = snapshot()
  // 两个字段互不干扰：改端口不该顺手抹掉 runVersion（configure 的注释写了这条理由）
  assert.equal(s.runVersion, '0.1.7')
  assert.equal(s.ready, true)
  assert.equal(s.needsPortRestart, true)
})

// ──────────────────────────────────────────────
// ④ 反向边界：端口改回原值（等于没改）不应报需重启
// ──────────────────────────────────────────────
test('端口改回同一值：不报 needsPortRestart', () => {
  setPort(3080)
  pretendRunning({ port: 3080 })

  setPort(3080)
  assert.equal(snapshot().needsPortRestart, false)
})

// ──────────────────────────────────────────────
// ⑤ 反向边界：runPort 未记（0）时不误报需重启
//    快照里 runPort 为 0 的场景（旧快照 / 刚启动尚未写入）不能被判成「端口不一致」
// ──────────────────────────────────────────────
test('runPort 为 0 时不报 needsPortRestart（避免把「尚未记录」误报成「需重启」）', () => {
  setPort(3080)
  pretendRunning({ port: 0 })

  setPort(3081)
  assert.equal(snapshot().needsPortRestart, false)
})

// ──────────────────────────────────────────────
// ⑥ 进程退出后：runPort 与 needsPortRestart 一起归零
//    （否则界面会挂着一个「需重启切端口」的提示，而其实已经没有进程了）
// ──────────────────────────────────────────────
test('进程退出后：runPort 归零，needsPortRestart 不再报', () => {
  setPort(3080)
  pretendRunning({ port: 3080 })
  setPort(3081)
  assert.equal(snapshot().needsPortRestart, true)

  // 模拟 exit 处理器的清理动作（dsh.js 里 child.on('exit') 那段）
  resetState()
  const s = snapshot()
  assert.equal(s.running, false)
  assert.equal(s.runPort, 0)
  assert.equal(s.needsPortRestart, false)
})

// ──────────────────────────────────────────────
// 外部 dsh（别的终端启动的那份）在跑时改端口，是同一类 bug 的另一半：
//   externalPid() 读的是 probe 上的探测结果，而 probe 只描述**当前配置端口**；
//   configure() 换端口必须清空 probe 重探（否则快照自相矛盾），清完 external 就没了 ——
//   用户实测（2026-09-26）：状态「外部 dsh · pid 25696（端口 3081）」改成 3080 后
//   直接变「未运行」，而 3081 上的进程还在跑，连「结束」按钮都一起被禁用了。
//   修复：把「外部进程实际占的端口」留档进 state.extRun*，快照的 external 判据含留档。
//
// 桩说明：externalPid() 依赖 probe.pid/name/cmdline（且要求进程名像 dsh、命令行能证明是 dsh），
// 这里直接把 probe 摆成「3081 上有个真 dsh」的样子，并给一个**真实存活**的 pid（用本测试进程自己），
// 好让 snapshot() 里按 pid 校验留档存活的那一步判成 alive。
// ⚠️ 不能随便编一个大 pid：留档校验用 process.kill(pid, 0) 判活，编的 pid 会得到 ESRCH（dead），
//    留档当场被清，测试就测不到「改端口后仍报 external」了。
const EXT_PID = process.pid
function pretendExternal({ port = 3081 } = {}) {
  st.port = port
  probe.pid = EXT_PID
  probe.name = 'node.exe'
  // 命令行要能通过 looksLikeDsh 的判定（含 dsh 包名），否则 externalPid() 返回 0
  probe.cmdline = 'node C:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --port ' + port
  probe.cmdlineKnown = true
  probe.selfOwned = false
}
function resetProbe() {
  probe.pid = 0
  probe.name = ''
  probe.cmdline = ''
  probe.cmdlineKnown = false
  probe.selfOwned = false
}

test('外部 dsh 运行中改配置端口：不出现「未运行」，仍报 external 并提示需重启', () => {
  setPort(3081)
  pretendExternal({ port: 3081 })
  assert.equal(snapshot().external, true, '前置：此时应认出外部 dsh')

  setPort(3080) // ← 用户只是改了配置，没点启动

  const s = snapshot()
  assert.equal(s.port, 3080, '配置端口应已更新')
  assert.equal(s.external, true, '旧端口上的外部 dsh 还在跑，不能变成「未运行」')
  assert.equal(s.externalPid, EXT_PID, '仍应报出那个进程的 pid')
  assert.equal(s.externalRunPort, 3081, '如实告知它实际停在 3081 上')
  assert.equal(s.needsPortRestart, true, '应提示「需重启才切到新端口」')
  // 本 bug 的正面判据：界面靠 external 决定状态文案与「结束/重启」按钮可用性，
  // 它一旦为 false，用户就既看不到进程、也点不动按钮
  assert.ok(s.external || s.running, '改端口不该让「在跑」这件事凭空消失')
})

test('外部 dsh 进程已退出：留档按 pid 校验后清掉，不再误报 external', () => {
  setPort(3081)
  pretendExternal({ port: 3081 })
  setPort(3080)
  assert.equal(snapshot().externalRunPort, 3081, '前置：留档应已建立')

  // 模拟外部进程自己退了（在别的终端 Ctrl+C）：probe 被清空（探的是新端口），
  // 且留档 pid 已不存在 —— 用一个几乎不可能存在的 pid 让 process.kill 得到 ESRCH
  resetProbe()
  st.extRunPid = 999999999
  const s = snapshot()
  assert.equal(s.external, false, '进程确证已死，应停止报「外部 dsh 在跑」')
  assert.equal(s.externalRunPort, 0, '留档应被同步清掉')
})
