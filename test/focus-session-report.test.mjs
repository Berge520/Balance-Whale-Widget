/*
 * 「计时 → 专注会话」这条链路的契约测试。
 *
 * 为什么用源码契约而不是纯函数单测：这一段的正确性不在某个函数里，而在
 * 「谁在什么时机上报、上报了哪些字段、谁负责判定一轮」。早前正是这三处散落在页面里
 * （只报倒计时到点、正计时与放弃都不记账、待办轮数自己 +1），于是三本账各涨各的。
 * P1 把它们收进会话模型，这里钉住「不许再长回三本账」。
 */
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const IPC = readFileSync(new URL('../public/preload/lib/ipc.js', import.meta.url), 'utf8')
const FLOATING = readFileSync(new URL('../public/preload/floating.js', import.meta.url), 'utf8')
const PAGE = readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')

// 取一段「从这里到本层结束」的源码：处理函数与页面函数都是缩进两格的块
function blockOf(src, startRe, endMark) {
  const m = startRe.exec(src)
  if (!m) return ''
  const end = src.indexOf(endMark, m.index)
  return src.slice(m.index, end < 0 ? src.length : end)
}
const ipcBlock = blockOf(IPC, /ipcRenderer\.on\('whale:focus'/, '\n  })')
const readyBlock = blockOf(IPC, /ipcRenderer\.on\('whale:ready'/, '\n  })')

test('宿主记账只走会话：不再有 recordRound 这条独立累加', () => {
  assert.match(IPC, /const \{ appendSession, pruneFocus \} = require\('\.\/focus'\)/,
    '专注模块只留会话入口')
  assert.doesNotMatch(IPC, /recordRound/, 'recordRound（自己累加天表）必须退役')
  assert.match(ipcBlock, /appendSession\(prev/, '落库走 appendSession：明细是唯一事实源')
  assert.doesNotMatch(PAGE, /focusRound/, '页面不再用「只报分钟」的老接口')
  assert.match(FLOATING, /focusSession\(payload\)/, '桥上要有会话上报入口')
})

test('会话带上判定所需的元信息：模式 / 起止 / 休息 / 放弃', () => {
  assert.ok(ipcBlock.length > 0, 'whale:focus 处理函数应能定位')
  for (const field of ['mode', 'startAt', 'endAt', 'minutes', 'isBreak', 'abandoned']) {
    assert.match(ipcBlock, new RegExp('input\\.' + field), `${field} 必须透传给会话`)
  }
  // 归属日由「结束那一刻」决定：跨零点的轮次记在结束那天，宿主不该再传日期键
  assert.doesNotMatch(ipcBlock, /dateKey:/, '不该把宿主算的日期键塞进会话')
})

test('待办轮数改成派生缓存：不许再 rounds +1', () => {
  assert.doesNotMatch(ipcBlock, /\.rounds\s*=\s*\(/, '不能再对单条任务做累加')
  assert.match(ipcBlock, /syncTodoRounds\(\)/, '轮数由 syncTodoRounds 按明细回填')
  assert.match(ipcBlock, /if \(syncTodoRounds\(\)\) \{ pushTodo\(\); emitTodoChange\(\) \}/,
    '回填后要同时推挂件与设置页')
})

test('开机自愈：裁剪完顺手回填一次轮数（老计数器留下的偏差要能收敛）', () => {
  assert.match(readyBlock, /syncTodoRounds\(\)/, 'whale:ready 里应做一次自愈')
})

test('页面把「这一轮的投入」收敛成一个口径，到点与放弃都走它', () => {
  assert.match(PAGE, /function reportFocusSession\(/, '上报入口应带完整会话元信息')
  assert.doesNotMatch(PAGE, /function reportFocusRound\(/, '只认倒计时的老入口必须退役')
  assert.match(blockOf(PAGE, /function finishTimer\(/, '\n  }'), /reportFocusSession\(\)/,
    '到点要上报')
  // 放弃有四个入口（重置 / 切模式 / 换待办 / 快捷档），都在 requestTimerDiscard 前后汇合，
  // 所以只在汇合点记一笔 —— 每个入口各判一次迟早漏一个
  const settle = blockOf(PAGE, /function settleTimerDiscard\(/, '\n  }')
  assert.match(settle, /reportFocusSession\(\{ abandoned: timerMode !== 'up' \}\)/, '放弃按实际分钟上报，不算一轮')
  // 正计时没有预定终点：用户手动停表是正常收尾，不该在明细里显示成「放弃」；
  // 但不满 1 分钟的同样不值得记（与放弃同一门槛，避免生成 1 分钟的幽灵记录）
  assert.match(settle, /timerMode === 'up' && timerProgressMs\(\) < DISCARD_CONFIRM_MS/)
  assert.match(settle, /if \(!timerRunning && !timerPaused\) return/, '空闲/已走完不补记')
  assert.match(PAGE, /settleTimerDiscard\(\);\s*\n\s*run\(\);/, '不需确认的丢弃也要记')
  assert.match(blockOf(PAGE, /function confirmTimerDiscard\(/, '\n  }'), /settleTimerDiscard\(\)/,
    '确认后的丢弃要记')
})

test('上报幂等：一轮只记一次，重载后补弹「时间到」不会重复记账', () => {
  assert.match(PAGE, /timerReported/, '要有「本轮已记账」标记')
  assert.match(PAGE, /reported: timerReported/, '标记随计时状态落库')
  assert.match(PAGE, /timerReported = t\.reported === true/, '恢复时读回标记')
  assert.match(blockOf(PAGE, /function reportFocusSession\(/, '\n  }'), /if \(timerReported\) return/,
    '有标记就不再记')
  assert.match(PAGE, /timerReported = true/, '上报后置位')
  assert.match(PAGE, /timerReported = false; \/\/ 新一轮开始/, '起新一轮时清标记')
  // 超出宽限的过期轮：既不补「时间到」也不记账，标记置位让它静默翻页
  assert.match(blockOf(PAGE, /function restoreTimer\(t\)/, '\n  }'),
    /timerReported = true;\s*\n\s*resetTimer\(\);/)
})

test('正计时/定时不再被页面直接丢弃；休息轮只记走完的', () => {
  const reporter = blockOf(PAGE, /function reportFocusSession\(/, '\n  }')
  assert.ok(reporter.length > 0, 'reportFocusSession 应能定位')
  assert.doesNotMatch(reporter, /timerMode !== 'down'\) return/, '正计时/定时不该在页面被丢掉')
  assert.match(reporter, /timerMode !== 'at'\) return/, '只有 off 才算没有会话')
  // 明细已经带「休息」徽标（FocusView 的 sessionBadges），所以休息轮可以进日志了；
  // 但被打断的休息不算数据，只有走完的休息轮才落一行
  assert.doesNotMatch(reporter, /if \(timerIsBreak\) return/, '休息轮不该整条不报')
  assert.match(reporter, /if \(timerIsBreak && abandoned\) return/, '中途被打断的休息不该报')
  assert.match(reporter, /isBreak: timerIsBreak/, '休息标记要透传给宿主')
  assert.match(reporter, /abandoned/, '放弃标记要跟着上报')
  assert.match(reporter, /minutes: Math\.round\(ms \/ 60000\)/, '分钟按实际投入算，不再只报目标时长')
})

test('确认行一旦问出就不被秒针收掉', () => {
  const sync = blockOf(PAGE, /function syncTimerConfirm\(\)/, '\n  }')
  // 旧写法每 tick 重算「要不要显示」：进度刚过 1 分钟时问了，下一跳 discardNeedsConfirm()
  // 仍是真的，但 busy 判定一飘就把行收起 —— 秒针一跳按钮就没了，用户根本点不到
  assert.doesNotMatch(sync, /var show = !!pendingTimerDiscard && busy/, '还在按每秒状态重算显隐')
  assert.match(sync, /if \(!pendingTimerDiscard\) \{ rowTimerConfirm\.style\.display = 'none'; return; \}/,
    '显隐应以「是否已经挂起待确认」为准')
  assert.match(sync, /updateTimerConfirmText\(\)/, '挂着时文字仍要跟着实际专注时长刷新')
})
