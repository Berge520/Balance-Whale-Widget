/*
 * 「以管理员身份启动 dsh」的判定口径（public/preload/lib/dsh.js 的 startMode / elevateOutcome）
 *
 * 背景：dsh 的部分插件要管理员权限，所以设置页加了一个开关（dshElevated，默认关）。
 * 但 Windows 不允许给**已经在跑**的进程就地提权（令牌在 CreateProcess 时就定死了），
 * 只能 runas 拉起新实例、旧实例退出。于是判定必须钉死三件事：
 *
 *   1. 开关关闭          → 一定不提权（否则等于给所有人默认加 UAC 弹窗）
 *   2. 当前已是管理员     → 跳过 runas（对已是管理员的进程再跑一次，纯属多余；也不该重复弹 UAC）
 *   3. UAC 被点「否」     → 回落普通权限启动（不能停在「以为在提权、其实没启动」的半启动状态）
 *
 * 另有一条平台边界：非 Windows 没有 UAC / runas，一律普通启动，设置页那个开关也不显示。
 *
 * 判定的实现是纯函数（startMode / elevateOutcome），本文件只钉这条边界，
 * 不去真的拉起 UAC 弹窗 —— 提权动作在测试里不可自动化，也不该自动化。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

// ── utools 桩 ──
// configure() 的入参是完整配置对象（调用方一律走 syncConfig → readConfig()），
// 这里挂一个假的 whale:config 存储，让 readConfig() 读出我们想要的开关值，测试路径与线上一致。
const CONFIG_KEY = 'whale:config'
let stored = { dshElevated: false }
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
const { startMode, elevateOutcome, configure, snapshot, readConfig, __state: st, __buildElevateScripts } = dsh

const setElevated = (v) => { stored = { dshElevated: v }; configure(readConfig()) }

test('开关关闭：不提权（默认必须是普通启动）', () => {
  setElevated(false)
  assert.equal(st.elevated, false, '配置项要落到 state.elevated')
  assert.equal(startMode({ win: true, admin: false, want: st.elevated }), 'plain')
})

test('开关关闭 + 非管理员：仍然不提权（不能因为「没权限」就擅自提权）', () => {
  assert.equal(startMode({ win: true, admin: false, want: false }), 'plain')
})

test('已提权（宿主已是管理员）：跳过 runas，不重复弹 UAC', () => {
  setElevated(true)
  assert.equal(st.elevated, true)
  assert.equal(startMode({ win: true, admin: true, want: st.elevated }), 'plain')
})

test('开关开启 + 非管理员 + Windows：走 runas', () => {
  assert.equal(startMode({ win: true, admin: false, want: true }), 'runas')
})

test('非 Windows：一律普通启动（开关在设置页也不显示）', () => {
  assert.equal(startMode({ win: false, admin: false, want: true }), 'plain')
  assert.equal(startMode({ win: false, admin: true, want: true }), 'plain')
})

test('UAC 取消：回落普通启动，不留半启动状态', () => {
  assert.equal(elevateOutcome({ ok: false, canceled: true }), 'plain')
})

test('提权失败（非取消，例如没有 powershell / 被安全软件拦下）：同样回落普通启动', () => {
  assert.equal(elevateOutcome({ ok: false, canceled: false, why: '脚本写不出去' }), 'plain')
  assert.equal(elevateOutcome(null), 'plain', '没有结果对象也要有确定结论')
})

test('提权成功：采用提权进程', () => {
  assert.equal(elevateOutcome({ ok: true, pid: 4242, logFile: 'x.log' }), 'elevated')
})

test('快照回显：配置值 / 本次是否提权 / 等待 UAC 标记', () => {
  setElevated(true)
  st.runElevated = false
  st.elevating = false
  const s = snapshot()
  assert.equal(s.elevated, true, '设置页要能回显开关')
  assert.equal(s.runElevated, false, '开关打开≠本次已经在管理员权限下跑')
  assert.equal(s.elevating, false)
  assert.equal(typeof s.admin, 'boolean', '宿主是否管理员要能显示（仅用于提示会不会再弹 UAC）')
})

// ── 提权脚本的转义（纯函数） ──
// 提权链路是 wscript → powershell -File ps1，路径要过两层引号。转义错了不会在单测里暴露，
// 而是在用户眼前「UAC 弹出来、进程没起来」，所以这里用最难缠的路径（空格 + 中文 + 单引号）钉住。
const NASTY = {
  exe: "C:\\用户 目录\\it's\\node.exe",
  args: ["D:\\程序 目录\\it's\\lib\\bin.js", 'web', '--no-open', '--port', '3080'],
  pidFile: "C:\\临时 目录\\it's\\run.pid",
  logFile: "C:\\临时 目录\\it's\\run.log",
  ps1: "C:\\临时 目录\\it's\\run.ps1",
}

test('提权 ps1：单引号按 PowerShell 规则重复转义，参数逐条带引号', () => {
  const { ps1 } = __buildElevateScripts(NASTY)
  assert.ok(ps1.startsWith('\uFEFF'), '必须带 BOM，否则 PowerShell 5.1 按 ANSI 读中文路径会乱码')
  assert.ok(ps1.includes("'C:\\用户 目录\\it''s\\node.exe'"), 'exe 路径里的单引号要写成两个')
  assert.ok(ps1.includes("'D:\\程序 目录\\it''s\\lib\\bin.js' 'web' '--no-open' '--port' '3080'"), '每个参数单独加引号')
  assert.ok(ps1.includes('$pid | Set-Content'), '先把提权侧自己的 pid 写盘（父进程拿不到它）')
  assert.ok(ps1.includes('2>&1 | Out-File'), '输出要合并进日志文件（父进程也拿不到它的管道）')
  assert.ok(ps1.includes('exit $LASTEXITCODE'), '退出码要透传回去')
})

test('提权 vbs：Run 的整条命令按 VBS 规则把内部双引号写成两个', () => {
  const { vbs } = __buildElevateScripts(NASTY)
  assert.ok(vbs.includes('CreateObject("WScript.Shell")'))
  assert.ok(vbs.includes('sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\\临时 目录\\it\'s\\run.ps1""", 0, False)'),
    '窗口模式必须是 0（隐藏），否则提权后会闪一个控制台')
  // 结构断言：Run( 之后那一段里，双引号必须成对出现且是"翻倍"形式
  const line = vbs.split('\r\n').find((l) => l.includes('sh.Run('))
  assert.equal(line.replace(/""/g, '').split('"').length % 2, 1, 'VBS 字符串引号未闭合')
})

test('提权 ps1 能被 PowerShell 真正解析（只解析、不执行）', { skip: process.platform !== 'win32' }, () => {
  // 语法错误的 ps1 只有等用户点开 UAC 之后才会炸；这里用 [ScriptBlock]::Create 做纯语法检查。
  // ⚠️ 只 Create 不 Invoke：绝不会真的把 dsh 拉起来。
  const { ps1 } = __buildElevateScripts(NASTY)
  const file = path.join(os.tmpdir(), 'whale-parse-' + process.pid + '.ps1')
  fs.writeFileSync(file, ps1, 'utf8')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[void][ScriptBlock]::Create((Get-Content -Raw -LiteralPath ' + "'" + file + "'" + '))'], { stdio: 'ignore', timeout: 15000 })
  } finally {
    try { fs.rmSync(file, { force: true }) } catch (err) {}
  }
})
